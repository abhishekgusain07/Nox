# @reload-dev/worker

Task execution runtime for [reload.dev](https://reload.dev) — polls for work, executes tasks, reports results.

## Installation

```bash
npm install @reload-dev/worker @reload-dev/sdk
```

## Usage

Create a worker entry point that registers your tasks and starts the polling loop:

```typescript
// run-worker.ts
import { registerTask, startWorker } from "@reload-dev/worker";
import { sendEmail } from "./tasks/send-email.js";
import { processImage } from "./tasks/process-image.js";

// Register all task handlers
registerTask(sendEmail);
registerTask(processImage);

// Start the worker (begins polling for work)
startWorker().catch((err) => {
  console.error("Worker failed:", err);
  process.exit(1);
});
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RELOAD_API_KEY` | Yes | — | Server API key (type: `server`) |
| `RELOAD_SERVER_URL` | No | `http://localhost:3000` | Server URL |
| `RELOAD_QUEUE_ID` | No | `default` | Default queue to poll |
| `RELOAD_POLL_INTERVAL` | No | `1000` | Poll interval in ms |
| `RELOAD_WORKER_ID` | No | Auto-generated | Unique worker identifier |
| `RELOAD_HEARTBEAT_INTERVAL` | No | `10000` | Heartbeat interval in ms |

## How It Works

1. **Startup**: Registers all tasks with the server, creates queues if needed
2. **Polling**: Continuously polls `POST /api/dequeue` for each queue
3. **Execution**: Runs the task handler function with the payload
4. **Heartbeat**: Sends heartbeats every 10s during execution
5. **Completion**: Reports success (`POST /api/runs/:id/complete`) or failure (`POST /api/runs/:id/fail`)
6. **Retry**: Server handles retry logic — failed tasks are re-queued with exponential backoff
7. **Shutdown**: On SIGTERM/SIGINT, drains active runs (up to 30s) then deregisters

## License

MIT
