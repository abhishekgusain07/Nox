import { ReloadClient } from "@reload-dev/sdk/client";
import type { TaskHandle } from "@reload-dev/sdk/task";
import { randomUUID } from "crypto";

const SERVER_URL = process.env.RELOAD_SERVER_URL ?? "http://localhost:3000";
const QUEUE_ID = process.env.RELOAD_QUEUE_ID ?? "default";
const POLL_INTERVAL = parseInt(process.env.RELOAD_POLL_INTERVAL ?? "1000", 10);
const WORKER_ID = process.env.RELOAD_WORKER_ID ?? `worker-${randomUUID().slice(0, 8)}`;
const HEARTBEAT_INTERVAL = parseInt(process.env.RELOAD_HEARTBEAT_INTERVAL ?? "10000", 10);
const RELOAD_API_KEY = process.env.RELOAD_API_KEY;

if (!RELOAD_API_KEY) {
  console.error("[worker] RELOAD_API_KEY environment variable is required.");
  console.error("[worker] Get a server API key from your project dashboard.");
  process.exit(1);
}

const client = new ReloadClient({ baseUrl: SERVER_URL, apiKey: RELOAD_API_KEY });

// Task registry -- maps task IDs to their run functions
const taskRegistry = new Map<string, (payload: any) => Promise<any>>();
// Track queue per task
const taskQueues = new Map<string, string>();

// Track active run count for graceful shutdown
let activeRunCount = 0;
let shouldStop = false;

/**
 * Register a task handler with the worker.
 */
export function registerTask<TPayload, TOutput>(
  taskDef: TaskHandle<TPayload, TOutput>,
): void {
  taskRegistry.set(taskDef.id, taskDef.run as (payload: any) => Promise<any>);
  taskQueues.set(taskDef.id, taskDef.queue ?? QUEUE_ID);
  console.log(`[worker] Registered task: ${taskDef.id} (queue: ${taskDef.queue ?? QUEUE_ID})`);
}

/**
 * Register tasks with the server (creates queue + task entries in DB).
 * Also registers the worker itself.
 */
async function registerTasksWithServer(): Promise<void> {
  // Collect all unique queues
  const queues = new Set<string>([QUEUE_ID]);
  for (const queueId of taskQueues.values()) {
    queues.add(queueId);
  }

  // Ensure all queues exist
  for (const queueId of queues) {
    await client.createQueue(queueId).catch(() => {
      // Queue may already exist, that's fine
    });
  }

  // Register each task with its correct queue
  for (const [taskId, taskFn] of taskRegistry) {
    const queueId = taskQueues.get(taskId) ?? QUEUE_ID;
    await client.registerTask(taskId, queueId).catch(() => {
      // Task may already exist, that's fine
    });
    console.log(`[worker] Registered task with server: ${taskId} → queue: ${queueId}`);
  }

  // Register worker with server
  const taskTypes = [...taskRegistry.keys()];
  await fetch(`${SERVER_URL}/api/workers/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RELOAD_API_KEY}` },
    body: JSON.stringify({ workerId: WORKER_ID, taskTypes, queueId: QUEUE_ID }),
  }).catch(() => {});

  console.log(`[worker] Registered as ${WORKER_ID} with ${taskTypes.length} tasks`);
}

/**
 * Execute a single run
 */
async function executeRun(run: any): Promise<void> {
  const taskId = run.task_id ?? run.taskId;
  const taskFn = taskRegistry.get(taskId);
  if (!taskFn) {
    console.error(`[worker] Unknown task: ${taskId}`);
    await client.failRun(run.id, { message: `Unknown task: ${taskId}` }, "SYSTEM_ERROR");
    return;
  }

  activeRunCount++;

  const attemptNumber = run.attempt_number ?? run.attemptNumber ?? 0;
  console.log(`[worker] Executing run ${run.id} (task: ${taskId}, attempt: ${attemptNumber})`);

  // Start heartbeat interval
  const heartbeatTimer = setInterval(async () => {
    try {
      await fetch(`${SERVER_URL}/api/runs/${run.id}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RELOAD_API_KEY}` },
        body: JSON.stringify({ workerId: WORKER_ID }),
      });
    } catch {
      // Heartbeat failure is not fatal — server will detect via deadline
    }
  }, HEARTBEAT_INTERVAL);

  try {
    const output = await taskFn(run.payload);
    await client.completeRun(run.id, output);
    console.log(`[worker] Completed run ${run.id}`);
  } catch (error: any) {
    const isTimeout = error.name === "TimeoutError" || error.message?.includes("timeout");
    const failureType = isTimeout ? "TIMEOUT" : "TASK_ERROR";

    console.error(`[worker] Failed run ${run.id} (${failureType}):`, error.message);
    await client.failRun(
      run.id,
      { message: error.message, stack: error.stack },
      failureType,
    );
  } finally {
    clearInterval(heartbeatTimer);
    activeRunCount--;
  }
}

/**
 * Main dequeue loop -- polls server for work
 */
async function dequeueLoop(): Promise<void> {
  // Collect all unique queues this worker handles
  const allQueues = [...new Set([QUEUE_ID, ...taskQueues.values()])];
  console.log(`[worker] Starting dequeue loop (queues: ${allQueues.join(", ")}, poll: ${POLL_INTERVAL}ms)`);

  while (!shouldStop) {
    let foundWork = false;

    for (const queueId of allQueues) {
      if (shouldStop) break;
      try {
        const res = await fetch(`${SERVER_URL}/api/dequeue`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RELOAD_API_KEY}` },
          body: JSON.stringify({ queueId, limit: 1 }),
        });

        if (!res.ok) {
          console.error(`[worker] Dequeue failed for ${queueId}: ${res.status}`);
          continue;
        }

        const data = await res.json() as { runs: any[] };
        const runs = data.runs ?? [];

        if (runs.length > 0) {
          foundWork = true;
          for (const run of runs) {
            await executeRun(run);
          }
        }
      } catch (err: any) {
        console.error(`[worker] Dequeue error (${queueId}):`, err.message);
      }
    }

    if (!foundWork) {
      // No work found on any queue, wait before polling again
      await sleep(POLL_INTERVAL);
    }
  }

  console.log("[worker] Dequeue loop stopped.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Graceful shutdown handler. Drains active runs, then deregisters.
 */
function setupGracefulShutdown(): void {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shouldStop = true;
    console.log(`[worker] Received ${signal}. Draining ${activeRunCount} active runs...`);

    const timeout = 30_000;
    const started = Date.now();

    while (activeRunCount > 0) {
      if (Date.now() - started > timeout) {
        console.log("[worker] Shutdown timeout. Forcing exit.");
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // Deregister from server
    try {
      await fetch(`${SERVER_URL}/api/workers/${WORKER_ID}/deregister`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${RELOAD_API_KEY}` },
      });
    } catch { /* best effort */ }

    console.log("[worker] Drained. Exiting cleanly.");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

/**
 * Start the worker. Call this after registering all tasks.
 */
export async function startWorker(): Promise<void> {
  if (taskRegistry.size === 0) {
    console.error("[worker] No tasks registered. Call registerTask() first.");
    process.exit(1);
  }

  setupGracefulShutdown();
  await registerTasksWithServer();
  await dequeueLoop();
}
