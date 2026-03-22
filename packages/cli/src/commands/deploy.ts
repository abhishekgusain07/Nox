import { resolve } from "node:path";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { loadConfig, getApiKey, getServerUrl } from "../utils/config.js";

interface TaskManifestEntry {
  id: string;
  queue: string | undefined;
  retry: Record<string, unknown> | undefined;
  exportName: string;
}

interface DeploymentResponse {
  deploymentId: string;
  version: string;
  status: string;
}

export async function deployCommand(options: { config: string; dryRun?: boolean }): Promise<void> {
  const apiKey = getApiKey();
  const serverUrl = getServerUrl();

  console.log("Loading config...");
  const config = await loadConfig(options.config);
  console.log(`  Project: ${config.project}`);
  console.log(`  Dirs: ${config.dirs.join(", ")}`);

  // Find entry point
  const entryDir = resolve(process.cwd(), config.dirs[0] ?? "./tasks");
  const entryPoint = resolve(entryDir, "index.ts");
  if (!existsSync(entryPoint)) {
    console.error(`Error: Entry point not found: ${entryPoint}`);
    console.error("Create tasks/index.ts with your task exports.");
    process.exit(1);
  }

  // Bundle with esbuild
  console.log("Bundling tasks...");
  const outDir = resolve(process.cwd(), ".reload", "dist");
  mkdirSync(outDir, { recursive: true });
  const outfile = resolve(outDir, "bundle.js");

  // Bundle everything into a self-contained file.
  // The SDK (task(), config types) is inlined — it's just identity functions.
  // This way the bundle can be loaded from anywhere (e.g. /tmp) without needing
  // a node_modules directory.
  const buildResult = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    outfile,
    format: "esm",
    platform: "node",
    target: "node20",
    sourcemap: true,
    metafile: true,
    minify: false,
  });

  if (buildResult.errors.length > 0) {
    console.error("Build failed:");
    for (const err of buildResult.errors) {
      console.error(`  ${err.text}`);
    }
    process.exit(1);
  }

  // Read bundle and compute hash
  const bundleContent = readFileSync(outfile);
  const bundleHash = createHash("sha256").update(bundleContent).digest("hex").slice(0, 16);
  const bundleSizeKb = (bundleContent.length / 1024).toFixed(1);
  console.log(`  Bundle: ${bundleSizeKb} KB (hash: ${bundleHash})`);

  // Extract task metadata by importing the bundle
  console.log("Extracting task metadata...");
  const mod = await import(pathToFileURL(outfile).href + `?v=${Date.now()}`);
  const tasks: TaskManifestEntry[] = [];

  for (const [exportName, value] of Object.entries(mod)) {
    if (
      value !== null &&
      typeof value === "object" &&
      "id" in value &&
      "run" in value &&
      typeof (value as Record<string, unknown>).id === "string" &&
      typeof (value as Record<string, unknown>).run === "function"
    ) {
      const taskDef = value as { id: string; queue?: string; retry?: Record<string, unknown> };
      tasks.push({
        id: taskDef.id,
        queue: taskDef.queue,
        retry: taskDef.retry,
        exportName,
      });
      console.log(`  Task: ${taskDef.id} (export: ${exportName}, queue: ${taskDef.queue ?? "default"})`);
    }
  }

  if (tasks.length === 0) {
    console.error("Error: No tasks found in bundle. Make sure tasks/index.ts exports task() definitions.");
    process.exit(1);
  }

  console.log(`  Found ${tasks.length} task(s)`);

  if (options.dryRun) {
    console.log("\nDry run — skipping upload.");
    return;
  }

  // Upload to server
  console.log("Uploading deployment...");
  const bundleBase64 = bundleContent.toString("base64");

  const res = await fetch(`${serverUrl}/api/deployments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      version: bundleHash,
      bundleHash: createHash("sha256").update(bundleContent).digest("hex"),
      manifest: { tasks },
      bundle: bundleBase64,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Error: Upload failed (${res.status}): ${body}`);
    process.exit(1);
  }

  const deployment = await res.json() as DeploymentResponse;
  console.log(`  Deployment: ${deployment.deploymentId} (version: ${deployment.version})`);

  // Activate
  console.log("Activating deployment...");
  const activateRes = await fetch(`${serverUrl}/api/deployments/${deployment.deploymentId}/activate`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
    },
  });

  if (!activateRes.ok) {
    const body = await activateRes.text();
    console.error(`Error: Activation failed (${activateRes.status}): ${body}`);
    process.exit(1);
  }

  console.log("\nDeployed successfully!");
  console.log(`  ${tasks.length} task(s) deployed`);
  console.log(`  Version: ${bundleHash}`);
}
