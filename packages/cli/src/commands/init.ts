import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export async function initCommand(): Promise<void> {
  const cwd = process.cwd();

  // Create reload.config.ts
  const configPath = resolve(cwd, "reload.config.ts");
  if (existsSync(configPath)) {
    console.log("reload.config.ts already exists, skipping.");
  } else {
    writeFileSync(configPath, `import { defineConfig } from "@reload-dev/sdk/config";

export default defineConfig({
  project: "your-project-slug",
  dirs: ["./tasks"],
  retries: {
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
    },
  },
});
`);
    console.log("Created reload.config.ts");
  }

  // Create tasks directory
  const tasksDir = resolve(cwd, "tasks");
  if (!existsSync(tasksDir)) {
    mkdirSync(tasksDir, { recursive: true });
  }

  // Create tasks/index.ts barrel
  const indexPath = resolve(tasksDir, "index.ts");
  if (existsSync(indexPath)) {
    console.log("tasks/index.ts already exists, skipping.");
  } else {
    writeFileSync(indexPath, `// This is the entry point that reload-dev bundles and deploys.
// Export every task you want deployed:
//
// export { myTask } from "./my-task";

export { example } from "./example";
`);
    console.log("Created tasks/index.ts");
  }

  // Create tasks/example.ts
  const examplePath = resolve(tasksDir, "example.ts");
  if (existsSync(examplePath)) {
    console.log("tasks/example.ts already exists, skipping.");
  } else {
    writeFileSync(examplePath, `import { task } from "@reload-dev/sdk/task";

export const example = task({
  id: "example",
  run: async (payload: { message: string }) => {
    console.log(\`[example] \${payload.message}\`);
    return { received: payload.message, processedAt: new Date().toISOString() };
  },
});
`);
    console.log("Created tasks/example.ts");
  }

  // Create .env placeholder
  const envPath = resolve(cwd, ".env");
  if (!existsSync(envPath)) {
    writeFileSync(envPath, `RELOAD_API_KEY=
RELOAD_SERVER_URL=http://localhost:3000
`);
    console.log("Created .env (set your RELOAD_API_KEY)");
  }

  console.log("\nDone! Next steps:");
  console.log("  1. Set your RELOAD_API_KEY in .env");
  console.log("  2. Edit tasks/example.ts or add new tasks");
  console.log("  3. Export new tasks from tasks/index.ts");
  console.log("  4. Run: npx reload-dev deploy");
}
