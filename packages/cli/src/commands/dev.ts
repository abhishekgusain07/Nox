import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { loadConfig, getApiKey } from "../utils/config.js";

export async function devCommand(options: { config: string }): Promise<void> {
  const apiKey = getApiKey();
  const config = await loadConfig(options.config);

  const entryDir = resolve(process.cwd(), config.dirs[0] ?? "./tasks");

  // Look for a run-worker.ts in the tasks dir
  const workerEntry = resolve(entryDir, "run-worker.ts");
  if (!existsSync(workerEntry)) {
    console.error(`Error: Worker entry not found: ${workerEntry}`);
    console.error("Create tasks/run-worker.ts that imports and registers your tasks.");
    process.exit(1);
  }

  console.log(`Starting dev worker from ${workerEntry}...`);
  console.log("Watching for file changes (tsx watch mode).\n");

  // Use tsx watch to run the worker with hot reload — no bundling
  const child = spawn("npx", ["tsx", "watch", workerEntry], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      RELOAD_API_KEY: apiKey,
    },
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}
