# Getting Started with reload.dev

This guide walks you through setting up reload.dev from scratch — signup to first task execution.

## Prerequisites

- Node.js 20+
- A running reload.dev server (local or hosted)

## Step 1: Sign up

Visit your reload.dev dashboard (default: http://localhost:3001) and create an account.

## Step 2: Create a project

After signup, you'll be guided through creating your first project. Save the API key that's displayed — you won't see it again.

## Step 3: Install the SDK

```bash
npm install @reload-dev/sdk @reload-dev/worker
```

## Step 4: Define a task

Create a task file:

```typescript
// tasks/hello-world.ts
import { task } from "@reload-dev/sdk/task";

export const helloWorld = task({
  id: "hello-world",
  run: async (payload: { name: string }) => {
    console.log(`Hello, ${payload.name}!`);
    return { greeting: `Hello, ${payload.name}!` };
  },
});
```

## Step 5: Create the worker entry point

```typescript
// tasks/run-worker.ts
import { registerTask, startWorker } from "@reload-dev/worker";
import { helloWorld } from "./hello-world.js";

registerTask(helloWorld);

startWorker().catch((err) => {
  console.error("Worker failed:", err);
  process.exit(1);
});
```

## Step 6: Set your API key

```bash
export RELOAD_API_KEY="rl_dev_your-key-from-step-2"
```

## Step 7: Start the worker

```bash
npx tsx tasks/run-worker.ts
```

You should see:
```
[worker] Registered task: hello-world (queue: default)
[worker] Registered as worker-abc123 with 1 tasks
[worker] Starting dequeue loop (queues: default, poll: 1000ms)
```

## Step 8: Trigger a task

From your application code:

```typescript
import { ReloadClient } from "@reload-dev/sdk/client";

const client = new ReloadClient({
  baseUrl: "http://localhost:3000",
  apiKey: process.env.RELOAD_API_KEY!,
});

const { runId } = await client.trigger("hello-world", { name: "World" });
console.log(`Triggered run: ${runId}`);

// Wait for completion
const run = await client.triggerAndWait("hello-world", { name: "World" });
console.log(run.output); // { greeting: "Hello, World!" }
```

Or use the dashboard: go to the **Trigger** page, select "hello-world", enter `{"name": "World"}`, and click Trigger.

## Step 9: View in dashboard

Open the dashboard and go to:
- **Runs** — see your task execution with status, timing, and output
- **Events** — see the state transition timeline (PENDING → QUEUED → EXECUTING → COMPLETED)
- **Tasks** — see registered tasks with their queue and retry config

## Next Steps

- Add more tasks with different queues and retry configs
- Use `scheduledFor` to delay task execution
- Use `idempotencyKey` to prevent duplicate runs
- Use `concurrencyKey` to limit parallel execution per entity
- Check the [SDK README](../packages/sdk/README.md) for the full API reference
