# @reload-dev/sdk

TypeScript SDK for [reload.dev](https://reload.dev) — define tasks, trigger runs, and manage your task queue.

## Installation

```bash
npm install @reload-dev/sdk
```

## Quick Start

### 1. Define a task

```typescript
import { task } from "@reload-dev/sdk/task";

export const sendEmail = task({
  id: "send-email",
  queue: "emails",
  retry: { maxAttempts: 3, factor: 2, minTimeout: 1000, maxTimeout: 30000 },
  run: async (payload: { to: string; subject: string; body: string }) => {
    // Your email sending logic here
    console.log(`Sending email to ${payload.to}`);
    return { sent: true, to: payload.to };
  },
});
```

### 2. Trigger a task

```typescript
import { ReloadClient } from "@reload-dev/sdk/client";

const client = new ReloadClient({
  baseUrl: process.env.RELOAD_SERVER_URL ?? "http://localhost:3000",
  apiKey: process.env.RELOAD_API_KEY!,
});

// Fire and forget
const { runId } = await client.trigger("send-email", {
  to: "user@example.com",
  subject: "Welcome!",
  body: "Thanks for signing up.",
});

// Or wait for the result
const run = await client.triggerAndWait("send-email", {
  to: "user@example.com",
  subject: "Welcome!",
  body: "Thanks for signing up.",
}, { timeoutMs: 30000 });

console.log(run.status); // "COMPLETED" or "FAILED"
console.log(run.output); // { sent: true, to: "user@example.com" }
```

### 3. Check run status

```typescript
const run = await client.getRun(runId);
console.log(run.status);  // PENDING | QUEUED | EXECUTING | COMPLETED | FAILED | ...
console.log(run.output);  // Task return value (when COMPLETED)
console.log(run.error);   // Error details (when FAILED)
```

## API Reference

### `task(config)`

Define a task that can be registered with a worker and triggered via the SDK.

```typescript
task({
  id: string;           // Unique task identifier
  queue?: string;       // Queue name (default: "default")
  retry?: {
    maxAttempts?: number;   // Max retry attempts (default: 3)
    minTimeout?: number;    // Initial backoff in ms (default: 1000)
    maxTimeout?: number;    // Max backoff in ms (default: 60000)
    factor?: number;        // Backoff multiplier (default: 2)
  };
  run: (payload) => Promise<output>;  // Task handler function
})
```

### `ReloadClient`

```typescript
const client = new ReloadClient({ baseUrl: string, apiKey: string });

// Trigger a task (returns immediately)
await client.trigger(taskId, payload?, options?)

// Trigger and wait for completion (polls until done)
await client.triggerAndWait(taskId, payload?, options?)

// Get run status
await client.getRun(runId)

// Cancel a run
await client.cancelRun(runId, reason?)

// Get run events
await client.getRunEvents(runId)
```

### Trigger Options

```typescript
await client.trigger("my-task", payload, {
  priority: 10,           // Higher = processed first (0-100)
  maxAttempts: 5,         // Override default retry count
  idempotencyKey: "abc",  // Prevent duplicate runs
  concurrencyKey: "user-123", // Limit concurrent runs per key
  scheduledFor: "2024-01-01T12:00:00Z", // Delay execution
  queueId: "custom-queue", // Override task's default queue
});
```

## License

MIT
