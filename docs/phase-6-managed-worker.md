# Phase 6: Managed Worker — Dynamic Task Loading

## What Changed

Phase 6 adds a managed worker that loads task code dynamically from deployed bundles instead of static imports. This enables zero-downtime deployments.

## New Files

- `packages/worker/src/managed.ts` — Managed worker with dynamic bundle loading

## How It Works

```
1. Managed worker starts
2. Fetches GET /api/deployments/active → gets deployment info
3. Downloads bundle via GET /api/deployments/:id/bundle
4. Verifies SHA-256 hash matches
5. Saves to /tmp/reload/deployments/<hash>/bundle.js
6. Dynamic import(bundle.js) → extracts all task exports
7. Registers tasks + worker with server
8. Starts dequeue loop (same as regular worker)
9. Every 10s, checks for new deployments
10. If new version detected: download → load → re-register → continue
```

## Deployment Version Pinning

When a run is created (`POST /api/trigger`), the server looks up the active deployment and records its ID on the run:
- `runs.deployment_id` — FK to deployments table (nullable)
- Runs created before any deployment have null deployment_id

## Hot Reload

The managed worker checks for new deployments every 10s (configurable via `RELOAD_DEPLOYMENT_CHECK_INTERVAL`):
- If a new version is detected, it downloads the new bundle
- Clears the task registry and loads new tasks
- Re-registers with the server
- In-flight runs continue with the old code (they're already executing)
- New runs use the new code

## Usage

### Regular worker (static imports — for development):
```typescript
import { registerTask, startWorker } from "@reload-dev/worker";
import { myTask } from "./tasks/my-task.js";
registerTask(myTask);
startWorker();
```

### Managed worker (dynamic loading — for production):
```typescript
import { startManagedWorker } from "@reload-dev/worker";
startManagedWorker();
```

### Environment Variables (managed worker)

| Variable | Default | Description |
|----------|---------|-------------|
| RELOAD_API_KEY | required | Server API key |
| RELOAD_SERVER_URL | http://localhost:3000 | Server URL |
| RELOAD_DEPLOYMENT_CHECK_INTERVAL | 10000 | How often to check for new deployments (ms) |
| RELOAD_BUNDLES_DIR | /tmp/reload/deployments | Where to cache downloaded bundles |

## New Server Endpoint

- `GET /api/deployments/:id/status` — Shows deployment info + worker counts (total, online, active)

## Schema Change

Added `deployment_id UUID REFERENCES deployments(id)` to the `runs` table (nullable).

## What's Next (Phase 7)

Phase 7 adds rate limiting, audit logging, and production hardening.
