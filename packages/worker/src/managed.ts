import { ReloadClient } from "@reload-dev/sdk/client";
import type { TaskHandle } from "@reload-dev/sdk/task";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SERVER_URL = process.env.RELOAD_SERVER_URL ?? "http://localhost:3000";
const QUEUE_ID = process.env.RELOAD_QUEUE_ID ?? "default";
const POLL_INTERVAL = parseInt(process.env.RELOAD_POLL_INTERVAL ?? "1000", 10);
const WORKER_ID = process.env.RELOAD_WORKER_ID ?? `managed-${randomUUID().slice(0, 8)}`;
const HEARTBEAT_INTERVAL = parseInt(process.env.RELOAD_HEARTBEAT_INTERVAL ?? "10000", 10);
const DEPLOYMENT_CHECK_INTERVAL = parseInt(process.env.RELOAD_DEPLOYMENT_CHECK_INTERVAL ?? "10000", 10);
const BUNDLES_DIR = resolve(process.env.RELOAD_BUNDLES_DIR ?? "/tmp/reload/deployments");

const RELOAD_API_KEY = process.env.RELOAD_API_KEY;
if (!RELOAD_API_KEY) {
  console.error("[managed-worker] RELOAD_API_KEY environment variable is required.");
  process.exit(1);
}

const client = new ReloadClient({ baseUrl: SERVER_URL, apiKey: RELOAD_API_KEY });

// Task registry
const taskRegistry = new Map<string, (payload: unknown) => Promise<unknown>>();
const taskQueues = new Map<string, string>();

// Current deployment tracking
let currentDeploymentVersion: string | null = null;
let activeRunCount = 0;
let shouldStop = false;

interface DeploymentInfo {
  id: string;
  version: string;
  bundleHash: string;
  manifest: {
    tasks: Array<{
      id: string;
      queue?: string;
      retry?: Record<string, unknown>;
      exportName: string;
    }>;
  };
}

interface RunPayload {
  id: string;
  task_id?: string;
  taskId?: string;
  payload: unknown;
  attempt_number?: number;
  attemptNumber?: number;
}

async function fetchActiveDeployment(): Promise<DeploymentInfo | null> {
  try {
    const res = await fetch(`${SERVER_URL}/api/deployments/active`, {
      headers: { "Authorization": `Bearer ${RELOAD_API_KEY}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.error(`[managed-worker] Failed to fetch active deployment: ${res.status}`);
      return null;
    }
    return await res.json() as DeploymentInfo;
  } catch (err) {
    console.error("[managed-worker] Error fetching deployment:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function downloadBundle(deployment: DeploymentInfo): Promise<string> {
  const bundleDir = resolve(BUNDLES_DIR, deployment.bundleHash);
  const bundlePath = resolve(bundleDir, "bundle.js");

  // Check if already downloaded
  if (existsSync(bundlePath)) {
    // Verify hash
    const content = readFileSync(bundlePath);
    const hash = createHash("sha256").update(new Uint8Array(content)).digest("hex");
    if (hash === deployment.bundleHash || hash.startsWith(deployment.bundleHash)) {
      console.log(`[managed-worker] Bundle already cached: ${deployment.bundleHash}`);
      return bundlePath;
    }
  }

  console.log(`[managed-worker] Downloading bundle ${deployment.bundleHash}...`);
  const res = await fetch(`${SERVER_URL}/api/deployments/${deployment.id}/bundle`, {
    headers: { "Authorization": `Bearer ${RELOAD_API_KEY}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to download bundle: ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  // Verify hash
  const hash = createHash("sha256").update(new Uint8Array(buffer)).digest("hex");
  const expectedFull = deployment.bundleHash;
  if (!hash.startsWith(expectedFull) && hash !== expectedFull) {
    console.warn(`[managed-worker] Bundle hash mismatch (got ${hash.slice(0, 16)}, expected ${expectedFull.slice(0, 16)}). Loading anyway.`);
  }

  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(bundlePath, new Uint8Array(buffer));
  console.log(`[managed-worker] Bundle saved to ${bundlePath}`);

  return bundlePath;
}

async function loadTasksFromBundle(bundlePath: string, deployment: DeploymentInfo): Promise<void> {
  // Clear existing registrations
  taskRegistry.clear();
  taskQueues.clear();

  // Dynamic import with cache-busting query param
  const fileUrl = pathToFileURL(bundlePath).href + `?v=${Date.now()}`;
  const mod = await import(fileUrl) as Record<string, unknown>;

  for (const [exportName, value] of Object.entries(mod)) {
    if (
      value !== null &&
      typeof value === "object" &&
      "id" in value &&
      "run" in value &&
      typeof (value as Record<string, unknown>).id === "string" &&
      typeof (value as Record<string, unknown>).run === "function"
    ) {
      const taskDef = value as TaskHandle<unknown, unknown>;
      taskRegistry.set(taskDef.id, taskDef.run as (payload: unknown) => Promise<unknown>);
      taskQueues.set(taskDef.id, taskDef.queue ?? QUEUE_ID);
      console.log(`[managed-worker] Loaded task: ${taskDef.id} (export: ${exportName}, queue: ${taskDef.queue ?? QUEUE_ID})`);
    }
  }

  if (taskRegistry.size === 0) {
    console.error("[managed-worker] No tasks found in bundle!");
    return;
  }

  console.log(`[managed-worker] Loaded ${taskRegistry.size} task(s) from deployment ${deployment.version}`);
  currentDeploymentVersion = deployment.version;
}

async function registerWithServer(): Promise<void> {
  const taskTypes = [...taskRegistry.keys()];
  try {
    await fetch(`${SERVER_URL}/api/workers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RELOAD_API_KEY}` },
      body: JSON.stringify({ workerId: WORKER_ID, taskTypes, queueId: QUEUE_ID }),
    });
    console.log(`[managed-worker] Registered as ${WORKER_ID} with ${taskTypes.length} tasks`);
  } catch {
    console.error("[managed-worker] Failed to register with server");
  }
}

async function checkForNewDeployment(): Promise<void> {
  const deployment = await fetchActiveDeployment();
  if (!deployment) return;

  if (deployment.version === currentDeploymentVersion) return;

  console.log(`[managed-worker] New deployment detected: ${deployment.version} (current: ${currentDeploymentVersion ?? "none"})`);

  try {
    const bundlePath = await downloadBundle(deployment);
    await loadTasksFromBundle(bundlePath, deployment);
    await registerWithServer();
  } catch (err) {
    console.error("[managed-worker] Failed to load new deployment:", err instanceof Error ? err.message : String(err));
  }
}

async function executeRun(run: RunPayload): Promise<void> {
  const taskId = run.task_id ?? run.taskId;
  if (!taskId) {
    console.error("[managed-worker] Run missing taskId");
    return;
  }

  const taskFn = taskRegistry.get(taskId);
  if (!taskFn) {
    console.error(`[managed-worker] Unknown task: ${taskId}`);
    await client.failRun(run.id, { message: `Unknown task: ${taskId}` }, "SYSTEM_ERROR");
    return;
  }

  activeRunCount++;
  const attemptNumber = run.attempt_number ?? run.attemptNumber ?? 0;
  console.log(`[managed-worker] Executing run ${run.id} (task: ${taskId}, attempt: ${attemptNumber})`);

  const heartbeatTimer = setInterval(async () => {
    try {
      await fetch(`${SERVER_URL}/api/runs/${run.id}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RELOAD_API_KEY}` },
        body: JSON.stringify({ workerId: WORKER_ID }),
      });
    } catch {
      // Heartbeat failure is not fatal
    }
  }, HEARTBEAT_INTERVAL);

  try {
    const output = await taskFn(run.payload);
    await client.completeRun(run.id, output);
    console.log(`[managed-worker] Completed run ${run.id}`);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    const isTimeout = err.name === "TimeoutError" || err.message?.includes("timeout");
    const failureType = isTimeout ? "TIMEOUT" as const : "TASK_ERROR" as const;

    console.error(`[managed-worker] Failed run ${run.id} (${failureType}):`, err.message);
    await client.failRun(run.id, { message: err.message, stack: err.stack }, failureType);
  } finally {
    clearInterval(heartbeatTimer);
    activeRunCount--;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dequeueLoop(): Promise<void> {
  while (!shouldStop) {
    const allQueues = [...new Set([QUEUE_ID, ...taskQueues.values()])];
    let foundWork = false;

    for (const queueId of allQueues) {
      if (shouldStop) break;
      try {
        const res = await fetch(`${SERVER_URL}/api/dequeue`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RELOAD_API_KEY}` },
          body: JSON.stringify({ queueId, limit: 1 }),
        });

        if (!res.ok) continue;

        const data = await res.json() as { runs: RunPayload[] };
        const runs = data.runs ?? [];

        if (runs.length > 0) {
          foundWork = true;
          for (const run of runs) {
            await executeRun(run);
          }
        }
      } catch (err) {
        console.error(`[managed-worker] Dequeue error (${queueId}):`, err instanceof Error ? err.message : String(err));
      }
    }

    if (!foundWork) {
      await sleep(POLL_INTERVAL);
    }
  }
}

function setupGracefulShutdown(): void {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shouldStop = true;
    console.log(`[managed-worker] Received ${signal}. Draining ${activeRunCount} active runs...`);

    const timeout = 30_000;
    const started = Date.now();
    while (activeRunCount > 0) {
      if (Date.now() - started > timeout) {
        console.log("[managed-worker] Shutdown timeout. Forcing exit.");
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    try {
      await fetch(`${SERVER_URL}/api/workers/${WORKER_ID}/deregister`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${RELOAD_API_KEY}` },
      });
    } catch { /* best effort */ }

    console.log("[managed-worker] Drained. Exiting cleanly.");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

export async function startManagedWorker(): Promise<void> {
  setupGracefulShutdown();

  // Initial deployment load
  console.log("[managed-worker] Fetching active deployment...");
  const deployment = await fetchActiveDeployment();

  if (!deployment) {
    console.error("[managed-worker] No active deployment found. Deploy first: npx reload-dev deploy");
    process.exit(1);
  }

  const bundlePath = await downloadBundle(deployment);
  await loadTasksFromBundle(bundlePath, deployment);
  await registerWithServer();

  // Start deployment check loop (runs alongside dequeue loop)
  const deploymentChecker = setInterval(() => {
    checkForNewDeployment().catch((err) => {
      console.error("[managed-worker] Deployment check error:", err instanceof Error ? err.message : String(err));
    });
  }, DEPLOYMENT_CHECK_INTERVAL);

  console.log(`[managed-worker] Starting dequeue loop (poll: ${POLL_INTERVAL}ms, deploy-check: ${DEPLOYMENT_CHECK_INTERVAL}ms)`);
  await dequeueLoop();

  clearInterval(deploymentChecker);
}
