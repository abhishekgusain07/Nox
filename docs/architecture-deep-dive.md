# reload.dev — Architecture Deep Dive
## From Concept to Code: How Every Piece Works (Post-Phase 7)

---

## Table of Contents

1. [The Big Picture](#1-the-big-picture)
2. [Full Lifecycle of a Run](#2-full-lifecycle-of-a-run)
3. [How the Stack Starts](#3-how-the-stack-starts)
4. [Package Dependency Graph](#4-package-dependency-graph)
5. [Authentication — Two Systems, One projectId](#5-authentication--two-systems-one-projectid)
6. [The State Machine — The Brain](#6-the-state-machine--the-brain)
7. [The Run Engine — Imperative Shell Around the Pure Core](#7-the-run-engine--imperative-shell-around-the-pure-core)
8. [PostgreSQL as a Queue — SKIP LOCKED](#8-postgresql-as-a-queue--skip-locked)
9. [Redis Queue & Concurrency](#9-redis-queue--concurrency)
10. [The Worker — Static and Managed Modes](#10-the-worker--static-and-managed-modes)
11. [Retry & Backoff](#11-retry--backoff)
12. [Heartbeat Monitoring](#12-heartbeat-monitoring)
13. [Background Schedulers](#13-background-schedulers)
14. [Waitpoints & Suspension](#14-waitpoints--suspension)
15. [Deployments & Bundling — The CLI Pipeline](#15-deployments--bundling--the-cli-pipeline)
16. [SSE Real-Time Updates](#16-sse-real-time-updates)
17. [The Dashboard — Auth, Projects, and Data Flow](#17-the-dashboard--auth-projects-and-data-flow)
18. [The SDK — Client & Task Definition](#18-the-sdk--client--task-definition)
19. [Middleware Stack — Request Pipeline](#19-middleware-stack--request-pipeline)
20. [Database Schema — Every Table](#20-database-schema--every-table)
21. [API Endpoint Reference](#21-api-endpoint-reference)
22. [FP Patterns in Practice](#22-fp-patterns-in-practice)

---

## 1. The Big Picture

reload.dev is a task queue platform (similar to Trigger.dev) with 7 packages in a pnpm + Turbo monorepo:

```
┌──────────────────────────────────────────────────────────────────┐
│                     Dashboard (:3001)                              │
│       Next.js + TanStack Query + better-auth + Zustand            │
│   Login/Signup → Create Project → Get API Key → View Runs         │
└───────────────────────────┬──────────────────────────────────────┘
                            │ HTTP (rewrite proxy + CORS)
┌───────────────────────────▼──────────────────────────────────────┐
│                        Server (:3000)                              │
│                    Hono HTTP API + SSE                             │
│                                                                    │
│  Middleware Stack:                                                 │
│  Logger → CORS → Security Headers → Request ID → Payload Limit   │
│  → Rate Limit (IP) → better-auth → Rate Limit (API Key) → Auth  │
│                                                                    │
│  ┌────────────┐ ┌──────────┐ ┌─────────┐ ┌──────────────────┐   │
│  │ better-auth│ │ API Key  │ │  Engine  │ │   Background     │   │
│  │ (sessions, │ │ Auth     │ │ (state   │ │   Schedulers     │   │
│  │  signup,   │ │ (Bearer  │ │  machine)│ │   & Monitors     │   │
│  │  login)    │ │  tokens) │ │          │ │                  │   │
│  └────────────┘ └──────────┘ └──────────┘ └──────────────────┘   │
│                                                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  ┌────────────┐   │
│  │ PG Queue │  │  Redis   │  │ Deployments  │  │  Audit Log │   │
│  │(SKIP     │  │(sorted   │  │ (bundles,    │  │ (tracking) │   │
│  │ LOCKED)  │  │ sets +   │  │  versions)   │  │            │   │
│  │          │  │  Lua)    │  │              │  │            │   │
│  └────┬─────┘  └────┬─────┘  └──────┬───────┘  └────────────┘   │
│       └──────────────┼───────────────┘                            │
│                      │                                             │
│       ┌──────────────▼──────────────┐  ┌─────────────────────┐   │
│       │      PostgreSQL 16          │  │      Redis 7        │   │
│       │  (state, events, queue,     │  │  (concurrency,      │   │
│       │   users, projects, keys,    │  │   sorted-set queue, │   │
│       │   deployments, audit)       │  │   rate limits)      │   │
│       └─────────────────────────────┘  └─────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
                            ▲ HTTP (polling)
┌───────────────────────────┴──────────────────────────────────────┐
│                         Worker                                     │
│                                                                    │
│  Two modes:                                                        │
│  ┌─────────────────────────┐  ┌───────────────────────────────┐  │
│  │ Static Worker (dev)     │  │ Managed Worker (production)   │  │
│  │ registerTask() +        │  │ startManagedWorker()          │  │
│  │ startWorker()           │  │ Fetches bundle from server    │  │
│  │ Tasks imported at       │  │ Dynamic import() at runtime   │  │
│  │ compile time            │  │ Hot reloads on new deploy     │  │
│  └─────────────────────────┘  └───────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                         CLI                                        │
│  reload-dev init     → scaffold config + tasks                    │
│  reload-dev deploy   → esbuild bundle → upload → activate         │
│  reload-dev dev      → tsx watch (no bundling)                    │
│  reload-dev whoami   → verify API key                             │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. Full Lifecycle of a Run

```
User clicks "Trigger" in Dashboard (or calls SDK client.trigger())
        │
        ▼
POST /api/trigger { taskId: "deliver-webhook", payload: {...} }
  │  Middleware: Logger → CORS → Security → RequestID → PayloadSize
  │  → RateLimit(IP) → Auth(API Key) → RateLimit(APIKey)
  │
  ▼
Server validates:
  1. API key → projectId extracted
  2. Task exists AND belongs to this project
  3. Idempotency key not duplicate
  4. Look up active deployment → pin deploymentId on run
  5. INSERT into runs (status: PENDING, projectId, deploymentId)
  6. pgQueue.enqueue(runId) → UPDATE runs SET status='QUEUED'
        │
        ▼
Worker dequeue loop: POST /api/dequeue { queueId, limit: 1 }
  → PG SKIP LOCKED query:
    SELECT id FROM runs
    WHERE queue_id=$1 AND status='QUEUED' AND project_id=$2
    ORDER BY priority DESC, created_at ASC
    LIMIT 1 FOR UPDATE SKIP LOCKED
  → Atomically transitions to EXECUTING
        │
        ▼
Worker executes taskFn(payload)
  → Heartbeat every 10s: POST /api/runs/:id/heartbeat
        │
        ├── Success → POST /api/runs/:id/complete { output }
        │     → engine.transition(COMPLETED)
        │     → PG NOTIFY run_updates { projectId, runId, ... }
        │     → Dashboard SSE receives update, React Query refetches
        │
        └── Failure → POST /api/runs/:id/fail { error, failureType }
              → shouldRetry(attempt, maxAttempts, failureType)?
              │
              ├── YES: computeBackoffMs() → transition to DELAYED
              │         Delayed scheduler promotes to QUEUED after backoff
              │
              └── NO:  transition to FAILED (terminal)
```

---

## 3. How the Stack Starts

```bash
pnpm start  # runs scripts/start-all.sh
```

```
1. docker compose up -d
   → PostgreSQL 16 on :5432
   → Redis 7 on :6379

2. sleep 3 (wait for DB)

3. pnpm db:push (drizzle-kit push)
   → Syncs schema.ts → PostgreSQL (17 tables + 5 enums)

4. Server starts (packages/server, port 3000):
   ├── createDb() → Postgres connection pool
   ├── createAuth() → better-auth instance
   ├── createPgQueue() → SKIP LOCKED queue
   ├── new Redis() → ioredis connection
   ├── createRedisQueue() → sorted-set queue
   ├── createConcurrencyTracker() → Lua atomics
   ├── createRunEngine() → state machine + side effects
   ├── createWaitpointResolver()
   ├── createAuditLogger()
   ├── 4 background schedulers start:
   │   ├── Duration scheduler (1s) — SUSPENDED → QUEUED
   │   ├── Delayed scheduler (1s) — DELAYED → QUEUED
   │   ├── Heartbeat monitor (15s) — stale EXECUTING → FAILED
   │   └── TTL checker (5s) — expired QUEUED → EXPIRED
   ├── Middleware stack wired (9 layers)
   └── Routes mounted (5 route groups)

5. Worker starts (tasks/, requires RELOAD_API_KEY):
   ├── registerTask() for each task definition
   ├── registerTasksWithServer() → POST /api/queues + /api/tasks + /api/workers/register
   └── dequeueLoop() → polls each queue every 1s

6. Dashboard starts (packages/dashboard, port 3001):
   └── Next.js dev server, rewrites /api/* → localhost:3000
```

---

## 4. Package Dependency Graph

```
                    ┌────────────┐
                    │    core     │  Types, schemas, Result<T,E>,
                    │             │  branded IDs, state definitions
                    └──────┬──────┘
                           │
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
     ┌────────────┐  ┌────────────┐  ┌────────────┐
     │   engine   │  │    sdk     │  │  dashboard  │
     │ (state     │  │ (client,   │  │ (Next.js)   │
     │  machine,  │  │  task(),   │  │             │
     │  queues,   │  │  config)   │  │             │
     │  retry)    │  │            │  │             │
     └──────┬─────┘  └─────┬──────┘  └─────────────┘
            │               │
            ▼               ▼
     ┌────────────┐  ┌────────────┐  ┌────────────┐
     │   server   │  │   worker   │  │    cli      │
     │ (Hono,     │  │ (dequeue,  │  │ (deploy,    │
     │  DB, auth, │  │  execute,  │  │  init,      │
     │  deploy)   │  │  managed)  │  │  esbuild)   │
     └────────────┘  └────────────┘  └────────────┘
```

---

## 5. Authentication — Two Systems, One projectId

Two auth systems coexist. Both resolve to a `projectId` that scopes all data queries.

```
┌─────────────────────────────────────────────────────────────┐
│ Path 1: Session Auth (Dashboard users)                       │
│                                                              │
│ Browser → better-auth cookie → auth.api.getSession()        │
│   → user.id → db.projects WHERE userId = user.id            │
│   → projectId                                                │
│                                                              │
│ Routes: /api/auth/* (signup/login), /api/me/* (projects)    │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Path 2: API Key Auth (SDK, Worker, CLI)                      │
│                                                              │
│ Bearer rl_dev_xxx → SHA-256 hash → apiKeys lookup            │
│   → apiKey.projectId → projectId                             │
│                                                              │
│ Routes: all /api/* except /api/auth and /api/me              │
└─────────────────────────────────────────────────────────────┘

Both paths → projectId set on Hono context
           → ALL queries filter by projectId
           → Zero cross-project data leakage
```

**Key types**: `client` (SDK — trigger + read only) vs `server` (Worker — can dequeue + complete)
**Key format**: `rl_{environment}_{random}` — e.g., `rl_dev_abc123...` or `rl_prod_xyz789...`

---

## 6. The State Machine — The Brain

```
PENDING → QUEUED → EXECUTING → COMPLETED ✓
  │         │         │  │
  │         │         │  └→ SUSPENDED → QUEUED (waitpoint resolved)
  │         │         │
  │         │         ├→ DELAYED (retry backoff) → QUEUED
  │         │         │
  │         │         ├→ FAILED ✗ (retries exhausted)
  │         │         └→ CANCELLED ✗
  │         │
  │         ├→ EXPIRED ✗ (TTL exceeded)
  │         └→ CANCELLED ✗
  │
  ├→ DELAYED (future scheduled) → QUEUED
  └→ CANCELLED ✗
```

**Implementation**: `computeTransition(run, targetStatus, context)` — a **pure function** that returns `Result<{ run, effects }, TransitionError>`. Zero I/O, zero database calls. Just computes what should happen.

**Side effects are data** — the pure function returns tagged unions describing what the engine should do:
```typescript
type SideEffect =
  | { _tag: "EnqueueRun"; runId; queueId; priority }
  | { _tag: "EmitEvent"; event: RunEvent }
  | { _tag: "StartHeartbeat"; runId; workerId }
  | { _tag: "CancelHeartbeat"; runId }
  | { _tag: "ReleaseConcurrency"; runId; queueId }
  | { _tag: "NotifyParent"; parentRunId; childOutput }
```

---

## 7. The Run Engine — Imperative Shell Around the Pure Core

```typescript
async function transition(runId, to, context): Promise<Result<Run, TransitionError>> {
  // 1. Load run from DB
  // 2. computeTransition() — PURE
  // 3. Write with optimistic locking: WHERE version = expected
  // 4. Record event in run_events (append-only)
  // 5. PG NOTIFY run_updates { projectId, runId, fromStatus, toStatus }
  // 6. Execute side effects (enqueue, release concurrency, etc.)
}
```

**Optimistic locking**: Each run has a `version` integer. Updates use `WHERE version = N`. If another process changed the run, 0 rows updated → `VersionConflict` error.

---

## 8. PostgreSQL as a Queue — SKIP LOCKED

```sql
UPDATE runs
SET status = 'EXECUTING', started_at = NOW(), version = version + 1
WHERE id IN (
  SELECT id FROM runs
  WHERE queue_id = $1 AND status = 'QUEUED' AND project_id = $2
  ORDER BY priority DESC, created_at ASC
  LIMIT $3
  FOR UPDATE SKIP LOCKED  -- Skip rows locked by other workers
)
RETURNING *
```

Multiple workers calling dequeue simultaneously get **different rows**. No contention, no waiting, no duplicates.

---

## 9. Redis Queue & Concurrency

**Sorted-set queue** with priority scoring:
```
Score = (100 - priority) * 1e13 + Date.now()
```
Priority 10 always dequeues before priority 0. FIFO within same priority.

**Concurrency tracking** via Lua script (atomic check-and-add):
```lua
local count = redis.call('ZCARD', key)
if count >= limit then return 0 end
redis.call('ZADD', key, now, runId)
return 1
```

**Namespace isolation**: All keys prefixed with `projectId:` — e.g., `proj_abc:queue:webhooks`, `proj_abc:concurrency:queue:webhooks`.

---

## 10. The Worker — Static and Managed Modes

### Static Worker (local dev)
```typescript
import { registerTask, startWorker } from "@reload-dev/worker";
registerTask(myTask);  // in-memory Map
startWorker();         // poll → execute → report
```

### Managed Worker (production)
```typescript
import { startManagedWorker } from "@reload-dev/worker";
startManagedWorker();
// 1. GET /api/deployments/active → deployment info
// 2. GET /api/deployments/:id/bundle → download JS
// 3. Verify SHA-256 hash
// 4. import(bundlePath) → extract task exports
// 5. Register tasks, start dequeue loop
// 6. Every 10s: check for new deployment → hot reload
```

---

## 11. Retry & Backoff

```typescript
function computeBackoffMs(attempt, config): number {
  const exponential = config.minTimeout * config.factor ** attempt;
  const clamped = Math.min(exponential, config.maxTimeout);
  return Math.round(clamped * (0.75 + Math.random() * 0.5)); // ±25% jitter
}
```

| Attempt | Default Backoff |
|---------|----------------|
| 0 | ~750-1250ms |
| 1 | ~1500-2500ms |
| 2 | ~3000-5000ms |
| 3 | ~6000-10000ms |

SYSTEM_ERROR and TIMEOUT get 2 extra retries beyond maxAttempts.

---

## 12. Heartbeat Monitoring

```
Worker executes task:
  t=0s    EXECUTING. heartbeatDeadline = now + 30s
  t=10s   Heartbeat → deadline = now + 30s
  t=20s   Heartbeat → deadline = now + 30s
  t=25s   Worker DIES
  t=50s   deadline < now → Monitor detects stale run
          → shouldRetry? → DELAYED or FAILED
```

---

## 13. Background Schedulers

| Scheduler | Poll | What It Does |
|-----------|------|-------------|
| Delayed | 1s | DELAYED → QUEUED when scheduledFor ≤ now |
| Duration | 1s | Resolve DURATION waitpoints when resumeAfter ≤ now |
| Heartbeat | 15s | Detect stale EXECUTING runs (missed heartbeat) |
| TTL | 5s | QUEUED → EXPIRED when TTL exceeded |

---

## 14. Waitpoints & Suspension

A run can SUSPEND at 4 types of waitpoints:

| Type | Trigger | Resolution |
|------|---------|------------|
| CHILD_RUN | `ctx.triggerAndWait(taskId)` | Child run completes |
| DURATION | `ctx.waitFor({ seconds: 60 })` | Timer elapses |
| TOKEN | `ctx.waitForToken()` | External HTTP: POST /api/waitpoints/:token/complete |
| BATCH | Multiple children | All children complete |

Step-based replay: tasks re-execute from the beginning, but cached steps return instantly.

---

## 15. Deployments & Bundling — The CLI Pipeline

```
$ npx reload-dev deploy

1. Read reload.config.ts → project, dirs
2. Bundle tasks/index.ts with esbuild → .reload/dist/bundle.js
   (follows all imports, externals: @reload-dev/sdk)
3. SHA-256 hash → version identifier (16 chars)
4. Dynamic import bundle → extract task metadata
5. POST /api/deployments { version, bundleHash, manifest, bundle(base64) }
   → Server stores to data/bundles/<projectId>/<hash>/bundle.js
   → Creates deployment record (status: STAGED)
6. POST /api/deployments/:id/activate
   → Supersedes previous ACTIVE deployment
   → Upserts tasks from manifest
   → Workers detect new version on next poll
```

**Version pinning**: Each run records `deploymentId` at creation time. Managed workers can load specific versions for resumption.

---

## 16. SSE Real-Time Updates

```
Engine transition
  → db.execute(sql`NOTIFY run_updates, ${JSON.stringify({
      projectId, runId, fromStatus, toStatus, queueId, taskId, timestamp
    })}`)
  → Postgres NOTIFY channel

SSE endpoint (dedicated listener connection per stream):
  → listener.listen("run_updates", (payload) => {
      if (data.projectId === authenticatedProjectId) {
        stream.writeSSE({ data: payload, event: "update" })
      }
    })
  → Browser EventSource receives event
  → React Query invalidates cache → UI updates
```

Three SSE endpoints: `/api/stream` (all runs), `/api/runs/:id/stream`, `/api/queues/:id/stream`. All filter by projectId.

---

## 17. The Dashboard — Auth, Projects, and Data Flow

```
┌─ AuthLayout checks ──────────────────────────────────────────┐
│                                                                │
│  Is path public? (/login, /signup, /onboarding)               │
│    YES → Render page without nav                               │
│    NO  → Check useSession() (better-auth)                      │
│           No session? → redirect /login                        │
│           No project in Zustand store? → redirect /onboarding  │
│           Has both? → Render sidebar nav + page content        │
│                                                                │
│  Sidebar nav (Link components — no full page reload):          │
│    Runs | + Trigger | Tasks | Events | Queues | Workers       │
│    Settings (bottom) | User email                              │
└────────────────────────────────────────────────────────────────┘
```

**Data flow**: Zustand store persists `currentProject` + `currentApiKey`. The `api.ts` fetch wrapper reads the API key and adds `Authorization: Bearer <key>` to all requests.

---

## 18. The SDK — Client & Task Definition

```typescript
// Define tasks
const myTask = task({
  id: "my-task",
  queue: "processing",
  retry: { maxAttempts: 5, factor: 3 },
  run: async (payload: { url: string }) => {
    const result = await fetch(payload.url);
    return { status: result.status };
  },
});

// Trigger tasks
const client = new ReloadClient({ baseUrl: "...", apiKey: "rl_dev_..." });
const { runId } = await client.trigger("my-task", { url: "https://example.com" });

// Wait for result
const run = await client.triggerAndWait("my-task", { url: "..." }, { timeoutMs: 30000 });
// run.status === "COMPLETED", run.output === { status: 200 }
```

---

## 19. Middleware Stack — Request Pipeline

```
Request arrives
  │
  ├─ Logger (Hono built-in)
  ├─ CORS (origin: dashboard URL, credentials: true)
  ├─ Security Headers (X-Content-Type-Options, X-Frame-Options, etc.)
  ├─ Request ID (X-Request-Id: UUID)
  ├─ Max Payload Size (10MB limit on /api/*)
  │
  ├─ [/api/auth/*] Rate Limit by IP (20 req/min)
  │    └─ better-auth handler (signup/login/session)
  │
  ├─ [/api/me/*] Session auth (no API key)
  │    └─ Project management routes
  │
  ├─ [/api/*] API Key Auth Middleware
  │    ├─ Extract Bearer token
  │    ├─ SHA-256 hash → lookup in api_keys
  │    ├─ Check expiry
  │    ├─ Set context: projectId, apiKeyId, keyType
  │    └─ Fire-and-forget: update lastUsedAt
  │
  ├─ [/api/*] Rate Limit by API Key (200 req/min)
  │
  └─ Route Handler (scoped by projectId)
```

---

## 20. Database Schema — Every Table

### Auth & Access (better-auth managed)
```
users          → id(text PK), name, email(unique), emailVerified, image
sessions       → id(text PK), userId(FK), token(unique), expiresAt
accounts       → id(text PK), userId(FK), providerId, password(hashed)
verifications  → id(text PK), identifier, value, expiresAt
```

### Projects & Keys
```
projects       → id(uuid PK), userId(FK→users), name, slug, unique(userId,slug)
api_keys       → id(uuid PK), projectId(FK), keyHash(unique), keyPrefix,
                  keyType(client|server), environment(dev|staging|prod),
                  expiresAt, lastUsedAt
```

### Task Execution
```
queues         → id(text PK), projectId(FK), concurrencyLimit, paused
tasks          → id(text PK), projectId(FK), queueId(FK), retryConfig(jsonb)
runs           → id(uuid PK), projectId(FK), taskId(FK), queueId(FK),
                  status(enum), deploymentId(FK), version(optimistic lock),
                  payload, output, error, failureType, scheduledFor, ttl,
                  priority, idempotencyKey, concurrencyKey, attemptNumber,
                  maxAttempts, parentRunId, workerId, heartbeatDeadline
workers        → id(text PK), projectId(FK), taskTypes(jsonb[]), queueId(FK),
                  concurrency, status(online|offline), lastHeartbeat
```

### Deployments
```
deployments    → id(uuid PK), projectId(FK), version, bundleHash, bundlePath,
                  manifest(jsonb), status(STAGED|ACTIVE|SUPERSEDED|FAILED),
                  activatedAt, createdBy
```

### Event Log & Resumption
```
run_events     → id(uuid PK), projectId(FK), runId(FK), eventType,
                  fromStatus, toStatus, workerId, attempt, reason, data(jsonb)
run_steps      → id(serial PK), projectId(FK), runId(FK), stepIndex,
                  stepKey, result(jsonb)  [unique: runId+stepIndex]
waitpoints     → id(uuid PK), projectId(FK), runId(FK), type, resolved,
                  resumeAfter, childRunId, token, expiresAt,
                  batchTotal, batchResolved, stepIndex, stepKey
```

### Audit
```
audit_logs     → id(uuid PK), projectId(FK), apiKeyId, action,
                  resourceType, resourceId, details(jsonb), ipAddress
```

---

## 21. API Endpoint Reference

### Unauthenticated (better-auth)
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | /api/auth/sign-up/email | Create account |
| POST | /api/auth/sign-in/email | Login |
| GET | /api/auth/get-session | Check session |

### Session Auth (project management)
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /api/me/projects | List user's projects |
| POST | /api/me/projects | Create project (auto-generates API key) |
| GET | /api/me/projects/:id | Get project |
| GET | /api/me/projects/:id/keys | List API keys |
| POST | /api/me/projects/:id/keys | Generate API key |
| DELETE | /api/me/projects/:id/keys/:keyId | Revoke key |
| GET | /api/me/me | Current user info |

### API Key Auth (SDK, Worker, CLI)
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | /api/trigger | Create run |
| POST | /api/dequeue | Worker pulls work (SKIP LOCKED) |
| POST | /api/dequeue/fair | Fair multi-queue dequeue |
| GET | /api/runs | List runs (filterable) |
| GET | /api/runs/:id | Get run detail |
| POST | /api/runs/:id/complete | Mark completed |
| POST | /api/runs/:id/fail | Mark failed (with retry) |
| POST | /api/runs/:id/cancel | Cancel run |
| POST | /api/runs/:id/heartbeat | Extend heartbeat |
| POST | /api/runs/:id/suspend | Suspend at waitpoint |
| GET | /api/runs/:id/events | Run event timeline |
| GET | /api/runs/:id/steps | Cached steps |
| GET | /api/runs/:id/waitpoints | Blocking waitpoints |
| GET | /api/events | Global event feed |
| POST | /api/queues | Create queue |
| GET | /api/queues | List queues + stats |
| GET | /api/tasks | List tasks |
| POST | /api/tasks | Register task |
| POST | /api/workers/register | Register worker |
| POST | /api/workers/:id/heartbeat | Worker liveness |
| POST | /api/workers/:id/deregister | Worker offline |
| GET | /api/workers | List workers |
| POST | /api/waitpoints/:token/complete | Resolve token |
| POST | /api/keys | Generate API key |
| GET | /api/keys | List keys (prefix only) |
| DELETE | /api/keys/:keyId | Revoke key |
| POST | /api/deployments | Upload deployment |
| GET | /api/deployments | List deployments |
| GET | /api/deployments/active | Active deployment |
| POST | /api/deployments/:id/activate | Activate deployment |
| GET | /api/deployments/:id/bundle | Download bundle |
| GET | /api/deployments/:id/status | Rollout status |
| GET | /api/stream | SSE: all updates |
| GET | /api/runs/:id/stream | SSE: run updates |
| GET | /api/queues/:id/stream | SSE: queue updates |

---

## 22. FP Patterns in Practice

### Result<T, E>
```typescript
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
```
Used in: state machine transitions, engine operations. I/O errors throw; domain errors return Result.

### Discriminated Unions
Every domain type uses `_tag` for exhaustive pattern matching:
```typescript
switch (effect._tag) {
  case "EnqueueRun": ...
  case "EmitEvent": ...
  case "CancelHeartbeat": ...
  // TypeScript errors if you miss a case
}
```

### Functional Core, Imperative Shell
```
PURE (no I/O):                    IMPURE (I/O):
  computeTransition()               engine.transition()
  computeBackoffMs()                executeSideEffect()
  shouldRetry()                     Route handlers
  canTransition()                   Schedulers
```

### Immutability
All domain types are `readonly`. State updates create new objects via spread.
