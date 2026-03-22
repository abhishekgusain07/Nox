# Phase 2: Authentication Middleware

## What Changed

Phase 2 adds API key authentication to every API endpoint. Every request must include a valid Bearer token. The token identifies which project the request belongs to, and all data queries are scoped by projectId.

## New Files

### `packages/server/src/middleware/auth.ts`
The auth middleware that validates API keys. Exported functions:
- `createAuthMiddleware(db)` — returns Hono middleware that validates Bearer tokens
- `requireServerKey()` — returns middleware that rejects non-server keys (for worker endpoints)
- `getAuthContext(c)` — type-safe helper to extract projectId, apiKeyId, keyType from context

### `packages/server/src/routes/auth.ts`
API key management endpoints:
- `POST /api/keys` — generate new API key (returns raw key ONCE)
- `GET /api/keys` — list keys for current project (prefix only, never raw)
- `DELETE /api/keys/:keyId` — revoke a key

## How Authentication Works

```
Client sends: Authorization: Bearer rl_dev_abc123...
                                       │
Server middleware:                      ▼
  1. Extract token from header ─── "rl_dev_abc123..."
  2. SHA-256 hash the token ────── "9f86d081..."
  3. Look up hash in api_keys ──── Found! projectId="proj-uuid"
  4. Check expiry ─────────────── Not expired
  5. Set context: projectId, keyType, apiKeyId
  6. Continue to route handler
```

## Key Types

| Type | Prefix | Permissions | Used By |
|------|--------|-------------|---------|
| `client` | `rl_dev_` / `rl_prod_` | Trigger tasks, read runs/events | SDK |
| `server` | `rl_dev_` / `rl_prod_` | All client permissions + dequeue, complete/fail runs | Worker |

## Project Scoping

Every query now includes `WHERE project_id = $projectId`:

- `GET /api/runs` — only returns runs for the authenticated project
- `GET /api/tasks` — only returns tasks for the authenticated project
- `GET /api/queues` — only returns queues for the authenticated project
- `GET /api/workers` — only returns workers for the authenticated project
- `GET /api/events` — only returns events for the authenticated project
- `POST /api/trigger` — validates task belongs to the authenticated project
- `POST /api/dequeue` — only dequeues from the authenticated project's queues
- SSE streams — filter NOTIFY payloads by projectId (prevents cross-project leakage)

## SDK Changes

- `ReloadClient` constructor now REQUIRES `apiKey` (no longer optional)
- Added `triggerAndWait()` method — polls until run completes or fails
- Added `RunEvent` interface (replaces `any[]` in getRunEvents)
- Added `projectId` to `RunStatus` interface

## Worker Changes

- `RELOAD_API_KEY` environment variable is now REQUIRED
- Worker exits with error if key is not set
- All HTTP requests (dequeue, heartbeat, register, deregister) include Authorization header

## SSE Stream Security

PG NOTIFY payloads now include `projectId`. All three SSE endpoints filter by projectId from the authenticated context:
- `/api/stream` — global feed, filtered by project
- `/api/runs/:id/stream` — single run, filtered by project
- `/api/queues/:id/stream` — queue feed, filtered by project

## How to Test

```bash
# 1. Push schema and seed (if not already done)
pnpm db:push && pnpm db:seed

# 2. Copy the API key from seed output

# 3. Test authenticated request
curl -H "Authorization: Bearer rl_dev_YOUR_KEY" http://localhost:3000/api/tasks

# 4. Test unauthenticated request (should return 401)
curl http://localhost:3000/api/tasks

# 5. Start worker with API key
RELOAD_API_KEY=rl_dev_YOUR_KEY pnpm worker

# 6. Generate a new API key
curl -X POST -H "Authorization: Bearer rl_dev_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "My New Key", "keyType": "client", "environment": "dev"}' \
  http://localhost:3000/api/keys
```

## What's Next (Phase 3)

Phase 3 adds dashboard authentication (user signup/login, project management UI, API key generation from the dashboard).
