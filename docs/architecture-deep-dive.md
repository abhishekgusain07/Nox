# reload.dev — Architecture Deep Dive
## From Concept to Code: How Every Piece Works

---

## Table of Contents

1. [The Big Picture](#1-the-big-picture)
2. [Full Lifecycle of a Run](#2-full-lifecycle-of-a-run)
3. [How the Stack Starts](#3-how-the-stack-starts)
4. [Package Dependency Graph](#4-package-dependency-graph)
5. [The State Machine — The Brain](#5-the-state-machine--the-brain)
6. [The Run Engine — Imperative Shell Around the Pure Core](#6-the-run-engine--imperative-shell-around-the-pure-core)
7. [PostgreSQL as a Queue — SKIP LOCKED](#7-postgresql-as-a-queue--skip-locked)
8. [Redis Queue & Concurrency — Phase 3](#8-redis-queue--concurrency--phase-3)
9. [The Worker — A Polling Process](#9-the-worker--a-polling-process)
10. [Retry & Backoff](#10-retry--backoff)
11. [Heartbeat Monitoring — Detecting Dead Workers](#11-heartbeat-monitoring--detecting-dead-workers)
12. [Background Schedulers](#12-background-schedulers)
13. [Waitpoints & Suspension — Pausing Runs](#13-waitpoints--suspension--pausing-runs)
14. [Step-Based Resumption — Replay Without Snapshots](#14-step-based-resumption--replay-without-snapshots)
15. [SSE Real-Time Updates — PG NOTIFY to Browser](#15-sse-real-time-updates--pg-notify-to-browser)
16. [The Dashboard — How the UI Fetches and Displays](#16-the-dashboard--how-the-ui-fetches-and-displays)
17. [The SDK — Client & Task Definition](#17-the-sdk--client--task-definition)
18. [Database Schema — Every Table Explained](#18-database-schema--every-table-explained)
19. [FP Patterns in Practice](#19-fp-patterns-in-practice)
20. [API Endpoint Reference](#20-api-endpoint-reference)
21. [Example Tasks — What They Do](#21-example-tasks--what-they-do)

---

## 1. The Big Picture

reload.dev is a local task queue system (similar to Trigger.dev) with 6 packages:

```
┌─────────────────────────────────────────────────────────────┐
│                        Dashboard (:3001)                     │
│              Next.js + TanStack Query + SSE                  │
│          rewrites /api/* → http://localhost:3000/api/*        │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTP (proxied)
┌────────────────────────────▼────────────────────────────────┐
│                        Server (:3000)                        │
│                  Hono HTTP API + SSE streams                 │
│  ┌──────────┐  ┌─────────┐  ┌──────────┐  ┌─────────────┐  │
│  │ PG Queue │  │  Engine  │  │  Redis   │  │  Background  │  │
│  │(SKIP     │  │(state    │  │(sorted   │  │  Schedulers  │  │
│  │ LOCKED)  │  │ machine) │  │ sets +   │  │  & Monitors  │  │
│  │          │  │          │  │  Lua)    │  │              │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘  │
│       │             │             │               │           │
│       └─────────────┼─────────────┘               │           │
│                     │                             │           │
│              ┌──────▼──────┐              ┌───────▼────────┐  │
│              │ PostgreSQL  │              │     Redis      │  │
│              │   (state,   │              │  (concurrency, │  │
│              │   events,   │              │   sorted-set   │  │
│              │   queue)    │              │   queue)       │  │
│              └─────────────┘              └────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                             ▲ HTTP (polling)
┌────────────────────────────┴────────────────────────────────┐
│                         Worker                               │
│              Polls /api/dequeue, executes tasks              │
│              Sends heartbeats, reports results               │
│                                                              │
│  ┌──────────────┐  ┌───────────┐  ┌──────────────────────┐  │
│  │ Task Registry │  │  Dequeue  │  │  Graceful Shutdown   │  │
│  │ (in-memory)   │  │  Loop     │  │  (SIGTERM drain)     │  │
│  └──────────────┘  └───────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Key insight**: The worker and server are **separate processes** communicating over HTTP. The worker doesn't import the engine or touch the database directly. It's a dumb executor that polls for work, runs task functions, and reports back.

---

## 2. Full Lifecycle of a Run

This is the end-to-end flow of what happens when you trigger a task:

```
User clicks "Trigger" in Dashboard (or calls SDK)
        │
        ▼
POST /api/trigger { taskId: "deliver-webhook", payload: {...} }
        │
        ▼
Server validates task exists in DB (tasks table)
Server checks idempotency key (if provided)
Server INSERTs into runs table (status: PENDING)
Server calls pgQueue.enqueue(runId) → UPDATE runs SET status='QUEUED'
        │
        ▼
Run is now QUEUED in PostgreSQL
        │
        ▼
Worker's dequeueLoop() polls POST /api/dequeue { queueId: "webhooks", limit: 1 }
        │
        ▼
Server executes SKIP LOCKED query:
  SELECT id FROM runs WHERE queue_id='webhooks' AND status='QUEUED'
  ORDER BY priority DESC, created_at ASC LIMIT 1
  FOR UPDATE SKIP LOCKED
  → Atomically transitions to EXECUTING + sets started_at
        │
        ▼
Worker receives the run object { id, task_id, payload, ... }
Worker looks up "deliver-webhook" in its taskRegistry
Worker starts heartbeat timer (POST /api/runs/:id/heartbeat every 10s)
Worker calls taskFn(payload) — the actual deliver-webhook code runs
        │
        ├─── Task succeeds ───▶ Worker calls POST /api/runs/:id/complete { output }
        │                              │
        │                              ▼
        │                       Engine calls computeTransition(run, "COMPLETED", { output })
        │                       PURE function returns: newRun + effects [CancelHeartbeat,
        │                                              ReleaseConcurrency, EmitEvent, NotifyParent]
        │                       Engine writes to DB with version check (optimistic locking)
        │                       Engine records event in run_events table
        │                       Engine sends PG NOTIFY 'run_updates' (for SSE)
        │                       Engine executes side effects
        │                              │
        │                              ▼
        │                       Dashboard receives SSE "update" event
        │                       React Query invalidates cache → refetches → UI updates
        │
        └─── Task fails ───▶ Worker calls POST /api/runs/:id/fail { error, failureType }
                                   │
                                   ▼
                            Server checks shouldRetry(attemptNumber, maxAttempts, failureType)
                                   │
                         ┌─── yes ─┤─── no ──┐
                         ▼                    ▼
                  computeBackoffMs()     Engine transitions to FAILED (terminal)
                  Engine transitions     Event recorded, NOTIFY sent
                  to DELAYED with
                  scheduledFor = now + backoff
                         │
                         ▼
                  Delayed Scheduler (polling every 1s) picks it up
                  when scheduledFor <= now
                  Transitions DELAYED → QUEUED
                         │
                         ▼
                  Worker picks it up again (attempt #2)
                  Cycle repeats...
```

### File locations for this flow:

| Step | File | Lines |
|------|------|-------|
| POST /api/trigger | `packages/server/src/routes/index.ts` | 41-98 |
| pgQueue.enqueue() | `packages/server/src/queue/pg-queue.ts` | 10-15 |
| pgQueue.dequeue() (SKIP LOCKED) | `packages/server/src/queue/pg-queue.ts` | 17-40 |
| Worker dequeue loop | `packages/worker/src/index.ts` | 124-167 |
| Worker executeRun() | `packages/worker/src/index.ts` | 74-119 |
| POST /api/runs/:id/complete | `packages/server/src/routes/index.ts` | 208-241 |
| POST /api/runs/:id/fail | `packages/server/src/routes/index.ts` | 244-314 |
| engine.transition() | `packages/engine/src/run-engine.ts` | 21-176 |
| computeTransition() (PURE) | `packages/engine/src/state-machine.ts` | entire file |
| shouldRetry() | `packages/engine/src/retry/retry.ts` | shouldRetry function |
| computeBackoffMs() | `packages/engine/src/retry/retry.ts` | computeBackoffMs function |
| Delayed scheduler | `packages/engine/src/scheduler.ts` | entire file |
| PG NOTIFY for SSE | `packages/engine/src/run-engine.ts` | 128-140 |
| SSE stream endpoint | `packages/server/src/routes/stream.ts` | 57-76 |

---

## 3. How the Stack Starts

When you run `pnpm start` (or `bash scripts/start-all.sh`):

```
scripts/start-all.sh
│
├── 1. docker compose up -d
│       → PostgreSQL 16 on :5432 (user: reload, pass: reload, db: reload)
│       → Redis 7 on :6379
│
├── 2. sleep 3 (wait for DB to be ready)
│
├── 3. pnpm db:push
│       → drizzle-kit push (creates/updates all tables from schema.ts)
│
├── 4. Server (background): cd packages/server && npx tsx src/index.ts
│       └── packages/server/src/index.ts:
│           ├── createDb(DATABASE_URL)          → Postgres connection pool
│           ├── createPgQueue(db)               → PG SKIP LOCKED queue
│           ├── new Redis(REDIS_URL)            → Redis connection
│           ├── createRedisQueue(redis)         → Redis sorted-set queue
│           ├── createConcurrencyTracker(redis) → Lua-based concurrency slots
│           ├── createRunEngine({...})          → State machine + side effects
│           ├── createWaitpointResolver({...})  → Resolves paused runs
│           ├── createDurationScheduler({...})  → Polls 1s: SUSPENDED→QUEUED
│           ├── createDelayedScheduler({...})   → Polls 1s: DELAYED→QUEUED
│           ├── createHeartbeatMonitor({...})   → Polls 15s: stale EXECUTING→FAILED
│           ├── createTtlChecker({...})         → Polls 5s: QUEUED→EXPIRED
│           ├── Hono app + logger middleware
│           ├── Mount API routes at /api
│           ├── Mount SSE stream routes at /api
│           └── serve() on port 3000
│
├── 5. Worker (background): cd tasks && npx tsx run-worker.ts
│       └── tasks/run-worker.ts:
│           ├── registerTask(siteHealthCheck)   → queue: "monitoring"
│           ├── registerTask(deliverWebhook)    → queue: "webhooks"
│           ├── registerTask(scrapeMetadata)    → queue: "scraping"
│           ├── registerTask(generateReport)    → queue: "default"
│           ├── registerTask(processImage)      → queue: "media"
│           └── startWorker()
│               ├── setupGracefulShutdown()     → SIGTERM/SIGINT handlers
│               ├── registerTasksWithServer()
│               │   ├── POST /api/queues for each unique queue
│               │   ├── POST /api/tasks for each task (with queue + retryConfig)
│               │   └── POST /api/workers/register (workerId, taskTypes)
│               └── dequeueLoop()              → infinite polling loop
│
└── 6. Dashboard (background): cd packages/dashboard && npx next dev --port 3001
        └── Next.js dev server
            └── Rewrites /api/* → http://localhost:3000/api/*
```

**Individual commands:**
- `pnpm infra` — just Docker (Postgres + Redis)
- `pnpm server` — just the server
- `pnpm worker` — just the worker
- `pnpm dashboard` — just the dashboard

---

## 4. Package Dependency Graph

```
                 ┌────────────┐
                 │    core     │  Zero business logic.
                 │  (types,    │  Types, schemas, Result<T,E>,
                 │   schemas,  │  branded IDs, state definitions.
                 │   result)   │
                 └──────┬──────┘
                        │ imports types
            ┌───────────┼───────────────┐
            ▼           ▼               ▼
     ┌────────────┐  ┌────────────┐  ┌────────────┐
     │   engine   │  │    sdk     │  │  dashboard  │
     │ (state     │  │ (client,   │  │ (Next.js,   │
     │  machine,  │  │  task()    │  │  React      │
     │  retry,    │  │  helper)   │  │  Query)     │
     │  queue,    │  │            │  │             │
     │  heartbeat,│  │            │  │             │
     │  waitpoints│  │            │  │             │
     └──────┬─────┘  └─────┬──────┘  └─────────────┘
            │               │
            ▼               ▼
     ┌────────────┐  ┌────────────┐
     │   server   │  │   worker   │
     │ (Hono API, │  │ (dequeue   │
     │  DB, PG    │  │  loop,     │
     │  queue,    │  │  execute,  │
     │  SSE)      │  │  heartbeat)│
     └────────────┘  └────────────┘
            │               │
   imports engine      imports sdk
   imports core       imports core
```

**Critical rule**: `core` depends on nothing. `engine` depends only on `core`. The engine is a **pure logic layer** — it never touches HTTP or knows about Hono. `server` wires the engine to HTTP and the database. `worker` is a separate process that communicates with `server` over HTTP.

---

## 5. The State Machine — The Brain

### 5.1 States

| State | Terminal? | Description |
|-------|-----------|-------------|
| `PENDING` | No | Just created. Not yet in any queue. |
| `QUEUED` | No | In the queue, waiting for a worker. |
| `DELAYED` | No | Waiting for a future time (scheduled run or retry backoff). |
| `EXECUTING` | No | A worker is running the task code. |
| `SUSPENDED` | No | Paused — waiting for child task, duration, or external token. |
| `COMPLETED` | Yes | Finished successfully. |
| `FAILED` | Yes | Failed after all retries exhausted. |
| `CANCELLED` | Yes | Manually cancelled. |
| `EXPIRED` | Yes | TTL exceeded while queued. |

### 5.2 Transition Map

```
FROM          →  ALLOWED TARGETS
─────────────────────────────────────────────────
PENDING       →  QUEUED, DELAYED, CANCELLED
QUEUED        →  EXECUTING, EXPIRED, CANCELLED
DELAYED       →  QUEUED, CANCELLED
EXECUTING     →  COMPLETED, FAILED, DELAYED, SUSPENDED, CANCELLED
SUSPENDED     →  QUEUED, CANCELLED
COMPLETED     →  (terminal — no transitions out)
FAILED        →  (terminal)
CANCELLED     →  (terminal)
EXPIRED       →  (terminal)
```

**File**: `packages/engine/src/state-machine.ts`

```typescript
const TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  PENDING:   ["QUEUED", "DELAYED", "CANCELLED"],
  QUEUED:    ["EXECUTING", "EXPIRED", "CANCELLED"],
  DELAYED:   ["QUEUED", "CANCELLED"],
  EXECUTING: ["COMPLETED", "FAILED", "DELAYED", "SUSPENDED", "CANCELLED"],
  SUSPENDED: ["QUEUED", "CANCELLED"],
  COMPLETED: [],
  FAILED:    [],
  CANCELLED: [],
  EXPIRED:   [],
};
```

### 5.3 How computeTransition() Works

This is the PURE heart of the system. No I/O, no database, no side effects. Input → output.

```typescript
// packages/engine/src/state-machine.ts

export function computeTransition(
  run: Readonly<Run>,
  to: RunStatus,
  context: TransitionContext,
): Result<{ run: Run; effects: SideEffect[] }, TransitionError> {

  // 1. VALIDATE: Is this transition allowed?
  if (!canTransition(run.status, to)) {
    return err({ _tag: "InvalidTransition", from: run.status, to });
  }

  // 2. COMPUTE: Create new run state + list of side effects
  switch (to) {
    case "QUEUED":
      return ok({
        run: { ...run, status: "QUEUED" },
        effects: [
          { _tag: "EnqueueRun", runId: run.id, queueId: run.queueId, priority: run.priority },
          { _tag: "EmitEvent", event: { _tag: "RunQueued", runId: run.id, queueId: run.queueId } },
        ],
      });

    case "EXECUTING":
      return ok({
        run: { ...run, status: "EXECUTING", startedAt: context.now, dequeuedAt: context.now },
        effects: [
          { _tag: "StartHeartbeat", runId: run.id, workerId: context.workerId! },
          { _tag: "EmitEvent", event: { _tag: "RunStarted", runId: run.id } },
        ],
      });

    case "COMPLETED":
      return ok({
        run: { ...run, status: "COMPLETED", output: context.output, completedAt: context.now },
        effects: [
          { _tag: "CancelHeartbeat", runId: run.id },
          { _tag: "ReleaseConcurrency", runId: run.id, queueId: run.queueId },
          { _tag: "EmitEvent", event: { _tag: "RunCompleted", runId: run.id, output: context.output } },
          // If this run has a parent, notify it
          ...(run.parentRunId ? [{ _tag: "NotifyParent" as const, parentRunId: run.parentRunId, childOutput: context.output }] : []),
        ],
      });

    case "DELAYED":
      return ok({
        run: { ...run, status: "DELAYED", scheduledFor: context.scheduledFor,
               attemptNumber: context.nextAttempt ?? run.attemptNumber },
        effects: [
          { _tag: "CancelHeartbeat", runId: run.id },
          { _tag: "ReleaseConcurrency", runId: run.id, queueId: run.queueId },
          { _tag: "EmitEvent", event: { _tag: "RunRetrying", runId: run.id,
                   attempt: context.nextAttempt ?? run.attemptNumber,
                   delayMs: context.scheduledFor!.getTime() - context.now.getTime() } },
        ],
      });

    case "FAILED":
      // ... similar pattern: newRun + [CancelHeartbeat, ReleaseConcurrency, EmitEvent]

    case "SUSPENDED":
      // ... similar pattern: newRun + [CancelHeartbeat, ReleaseConcurrency, EmitEvent]

    case "CANCELLED":
      // ... similar pattern

    case "EXPIRED":
      // ... similar pattern
  }
}
```

**The key design principle**: Side effects are described as data (discriminated unions), not executed. The pure function says "these things SHOULD happen" — the impure engine DOES them.

### 5.4 Side Effect Types

```typescript
// packages/core/src/types.ts

export type SideEffect =
  | { _tag: "EnqueueRun"; runId: string; queueId: string; priority: number }
  | { _tag: "EmitEvent"; event: RunEvent }
  | { _tag: "StartHeartbeat"; runId: string; workerId: string }
  | { _tag: "CancelHeartbeat"; runId: string }
  | { _tag: "ReleaseConcurrency"; runId: string; queueId: string }
  | { _tag: "NotifyParent"; parentRunId: string; childOutput: unknown };
```

Each side effect is a tagged union. The engine's `executeSideEffect()` switches on `_tag` to decide what to do.

---

## 6. The Run Engine — Imperative Shell Around the Pure Core

The engine wraps the pure state machine with I/O: database reads/writes, PG NOTIFY, side effect execution.

**File**: `packages/engine/src/run-engine.ts`

```typescript
async function transition(
  runId: string,
  to: RunStatus,
  context: TransitionContext,
): Promise<Result<Run, TransitionError>> {

  // ── STEP 1: Load current run from DB ──
  const rows = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  const currentRun = rows[0];
  if (!currentRun) return err({ _tag: "RunNotFound", runId });

  // Normalize DB row → Run type (camelCase, nulls, etc.)
  const run: Run = { id: currentRun.id, taskId: currentRun.taskId, ... };

  // ── STEP 2: Call PURE state machine ──
  const result = computeTransition(run, to, context);
  if (!result.ok) return result;

  const { run: newRun, effects } = result.value;

  // ── STEP 3: Write with optimistic locking (version check) ──
  const updated = await db.update(schema.runs)
    .set({
      status: newRun.status,
      output: newRun.output,
      error: newRun.error,
      // ... all fields
      version: sql`version + 1`,
    })
    .where(and(
      eq(schema.runs.id, runId),
      eq(schema.runs.version, run.version),  // CAS: only if version unchanged
    ))
    .returning();

  if (updated.length === 0) {
    return err({ _tag: "VersionConflict", expected: run.version, actual: -1 });
  }

  // ── STEP 4: Record event in append-only log ──
  await db.insert(schema.runEvents).values({
    runId,
    eventType: `run.${to.toLowerCase()}`,
    fromStatus: run.status,
    toStatus: to,
    reason: context.reason ?? null,
    attempt: newRun.attemptNumber,
    data: { ...(context.error ? { error: context.error } : {}), ... },
  });

  // ── STEP 5: NOTIFY for SSE ──
  await db.execute(sql`NOTIFY run_updates, ${JSON.stringify({
    runId, fromStatus: run.status, toStatus: to,
    queueId: run.queueId, taskId: run.taskId,
    timestamp: new Date().toISOString(),
  })}`);

  // ── STEP 6: Execute side effects ──
  for (const effect of effects) {
    await executeSideEffect(effect, run);
  }

  return ok(returnedRun);
}
```

### Optimistic Locking Explained

The `version` field prevents race conditions. If two workers try to transition the same run:

```
Worker A reads run (version=1)
Worker B reads run (version=1)
Worker A writes: WHERE version=1 → succeeds, version becomes 2
Worker B writes: WHERE version=1 → 0 rows updated (version is now 2) → VersionConflict
```

Only one transition wins. The loser gets a clear error.

---

## 7. PostgreSQL as a Queue — SKIP LOCKED

**File**: `packages/server/src/queue/pg-queue.ts`

### Enqueue

```typescript
async enqueue(runId: string): Promise<void> {
  await db.execute(sql`
    UPDATE runs SET status = 'QUEUED', version = version + 1
    WHERE id = ${runId}
  `);
}
```

The run IS the queue entry. No separate queue table. Status transitions from PENDING → QUEUED.

### Dequeue (the magic)

```sql
UPDATE runs
SET status = 'EXECUTING',
    started_at = NOW(),
    dequeued_at = NOW(),
    version = version + 1
WHERE id IN (
  SELECT id FROM runs
  WHERE queue_id = ${queueId}
    AND status = 'QUEUED'
    AND (scheduled_for IS NULL OR scheduled_for <= NOW())
  ORDER BY
    priority DESC,       -- highest priority first
    created_at ASC       -- FIFO within same priority
  LIMIT ${limit}
  FOR UPDATE SKIP LOCKED -- KEY: skip rows locked by other workers
)
RETURNING *
```

**How `FOR UPDATE SKIP LOCKED` works:**

1. The inner SELECT finds QUEUED runs for this queue
2. `FOR UPDATE` acquires an exclusive row lock
3. `SKIP LOCKED` means: if another transaction already locked a row, **skip it** instead of waiting
4. The outer UPDATE atomically transitions the selected rows to EXECUTING
5. `RETURNING *` sends the full run data back to the worker

**Why this works for concurrent dequeue**: Multiple workers calling dequeue simultaneously will each get different rows. No contention, no waiting, no duplicate processing.

**Why this has limitations**: Under high load, the polling + UPDATE pattern puts pressure on PostgreSQL. The status column index grows. This is why Redis is added in Phase 3.

---

## 8. Redis Queue & Concurrency — Phase 3

### Redis Sorted-Set Queue

**File**: `packages/engine/src/queue/redis-queue.ts`

```typescript
async enqueue(runId: string, queueId: string, priority: number = 0): Promise<void> {
  // Score formula: lower score = dequeued first
  const score = (MAX_PRIORITY - priority) * 1e13 + Date.now();
  await redis.zadd(`queue:${queueId}`, score, runId);
}

async dequeue(queueId: string, limit: number = 1): Promise<string[]> {
  // ZPOPMIN atomically removes and returns lowest-scored item
  const item = await redis.zpopmin(`queue:${queueId}`);
  return item ? [item[0]] : [];
}
```

**Score formula explained**:
- Priority 10: score = `(100-10) * 1e13 + timestamp = 90_0000000000000 + 1710000000000`
- Priority 0: score = `(100-0) * 1e13 + timestamp = 100_0000000000000 + 1710000000000`
- Since 90 < 100 at the 1e13 level, priority-10 tasks ALWAYS dequeue before priority-0 tasks
- Within the same priority band, the `+ Date.now()` ensures FIFO ordering

### Concurrency Tracking with Lua

**File**: `packages/engine/src/queue/concurrency.ts`

```lua
-- Atomic check-and-add (no TOCTOU race)
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local runId = ARGV[2]
local now = tonumber(ARGV[3])

local count = redis.call('ZCARD', key)
if count >= limit then
  return 0  -- At capacity, reject
end

redis.call('ZADD', key, now, runId)
return 1  -- Slot acquired
```

**Why Lua**: Redis executes Lua scripts atomically. The ZCARD check and ZADD happen as ONE operation. No gap for another worker to sneak in between check and add. This eliminates the Time-of-Check-to-Time-of-Use (TOCTOU) race.

**Two levels of concurrency**:
1. **Queue-level**: `concurrency:queue:{queueId}` — e.g., max 10 concurrent runs in the "webhooks" queue
2. **Key-level**: `concurrency:key:{queueId}:{concurrencyKey}` — e.g., max 1 concurrent run per user

### Fair Dequeue Across Queues

**File**: `packages/engine/src/queue/fair-dequeue.ts`

Round-robin through active queues, taking one run from each:

```
Pass 1: queue "monitoring" → dequeue 1 run
         queue "webhooks"  → dequeue 1 run
         queue "scraping"  → at capacity, skip
         queue "media"     → dequeue 1 run
Pass 2: queue "monitoring" → dequeue 1 run
         queue "webhooks"  → empty, skip
         ...
```

For each queue: check paused → pop from Redis → try acquire concurrency → if full, put back + mark paused for this round.

---

## 9. The Worker — A Polling Process

**File**: `packages/worker/src/index.ts`

The worker is a long-lived Node.js process that:
1. Registers tasks with the server
2. Polls for work in an infinite loop
3. Executes task functions
4. Reports results back

### Task Registration

```typescript
// In-memory registries
const taskRegistry = new Map<string, (payload: any) => Promise<any>>();
const taskQueues = new Map<string, string>();

export function registerTask<TPayload, TOutput>(taskDef: TaskHandle<TPayload, TOutput>): void {
  taskRegistry.set(taskDef.id, taskDef.run);
  taskQueues.set(taskDef.id, taskDef.queue ?? QUEUE_ID);
}
```

On startup, `registerTasksWithServer()`:
1. Collects all unique queues from tasks
2. POST /api/queues for each (idempotent, creates if missing)
3. POST /api/tasks for each (upserts with queue + retryConfig)
4. POST /api/workers/register (advertises worker capabilities)

### Dequeue Loop

```typescript
async function dequeueLoop(): Promise<void> {
  const allQueues = [...new Set([QUEUE_ID, ...taskQueues.values()])];

  while (!shouldStop) {
    let foundWork = false;

    for (const queueId of allQueues) {
      const res = await fetch(`${SERVER_URL}/api/dequeue`, {
        method: "POST",
        body: JSON.stringify({ queueId, limit: 1 }),
      });
      const data = await res.json();

      if (data.runs.length > 0) {
        foundWork = true;
        for (const run of data.runs) {
          await executeRun(run);  // blocks until this run completes
        }
      }
    }

    if (!foundWork) {
      await sleep(POLL_INTERVAL);  // default 1000ms
    }
  }
}
```

**Important**: The worker polls each queue sequentially. If "monitoring" has work, it processes it before checking "webhooks". Within each queue, it processes one run at a time (limit: 1). Multiple runs execute concurrently only because the loop continues to the next queue while a run is still executing... **wait, no** — `await executeRun(run)` blocks. So runs are sequential.

### Task Execution with Heartbeat

```typescript
async function executeRun(run: any): Promise<void> {
  const taskFn = taskRegistry.get(run.task_id ?? run.taskId);
  activeRunCount++;

  // Start heartbeat: POST /api/runs/:id/heartbeat every 10s
  const heartbeatTimer = setInterval(async () => {
    await fetch(`${SERVER_URL}/api/runs/${run.id}/heartbeat`, {
      method: "POST",
      body: JSON.stringify({ workerId: WORKER_ID }),
    });
  }, HEARTBEAT_INTERVAL);

  try {
    const output = await taskFn(run.payload);       // ← ACTUAL TASK EXECUTION
    await client.completeRun(run.id, output);       // report success
  } catch (error) {
    const failureType = error.name === "TimeoutError" ? "TIMEOUT" : "TASK_ERROR";
    await client.failRun(run.id, { message: error.message, stack: error.stack }, failureType);
  } finally {
    clearInterval(heartbeatTimer);
    activeRunCount--;
  }
}
```

### Graceful Shutdown

```typescript
function setupGracefulShutdown(): void {
  const shutdown = async (signal: string) => {
    shouldStop = true;  // dequeue loop exits

    // Wait up to 30s for in-flight runs to complete
    const timeout = 30_000;
    while (activeRunCount > 0 && Date.now() - started < timeout) {
      await sleep(500);
    }

    // Deregister from server
    await fetch(`${SERVER_URL}/api/workers/${WORKER_ID}/deregister`, { method: "POST" });
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
```

---

## 10. Retry & Backoff

**File**: `packages/engine/src/retry/retry.ts`

### Backoff Calculation (Pure Function)

```typescript
export function computeBackoffMs(attempt: number, config: RetryConfig): number {
  const exponential = config.minTimeout * Math.pow(config.factor, attempt);
  const clamped = Math.min(exponential, config.maxTimeout);
  const jitter = clamped * (0.75 + Math.random() * 0.5);  // ±25% jitter
  return Math.round(jitter);
}
```

**Example with default config** (min=1000, max=60000, factor=2):
| Attempt | Exponential | Clamped | With Jitter (range) |
|---------|------------|---------|---------------------|
| 0 | 1000ms | 1000ms | 750-1250ms |
| 1 | 2000ms | 2000ms | 1500-2500ms |
| 2 | 4000ms | 4000ms | 3000-5000ms |
| 3 | 8000ms | 8000ms | 6000-10000ms |
| 4 | 16000ms | 16000ms | 12000-20000ms |
| 5 | 32000ms | 32000ms | 24000-40000ms |
| 6 | 64000ms | 60000ms | 45000-75000ms |

**Why jitter**: Without jitter, if 100 tasks fail at the same time, they all retry at the exact same moment, causing a "thundering herd" that overloads the system again. Jitter spreads retries across a time window.

### Should Retry Decision

```typescript
export function shouldRetry(
  attemptNumber: number,
  maxAttempts: number,
  failureType: string,
): boolean {
  if (failureType === "SYSTEM_ERROR" || failureType === "TIMEOUT") {
    return attemptNumber < maxAttempts + 2;  // Extra mercy for infra failures
  }
  return attemptNumber < maxAttempts;
}
```

SYSTEM_ERROR and TIMEOUT get 2 extra attempts beyond maxAttempts because the task code itself isn't at fault.

### Retry Flow in the Server

**File**: `packages/server/src/routes/index.ts` (lines 244-314)

```
POST /api/runs/:id/fail
  │
  ├── Load run from DB
  ├── Load task's retryConfig from DB
  ├── shouldRetry(attemptNumber, maxAttempts, failureType)?
  │
  ├─── YES: computeBackoffMs(attemptNumber, retryConfig)
  │         scheduledFor = now + backoffMs
  │         engine.transition(runId, "DELAYED", { scheduledFor, nextAttempt: attempt+1 })
  │         Response: { ok: true, retrying: true }
  │
  └─── NO:  engine.transition(runId, "FAILED", { error, failureType })
            Response: { ok: true, retrying: false }
```

---

## 11. Heartbeat Monitoring — Detecting Dead Workers

**File**: `packages/engine/src/heartbeat/heartbeat.ts`

### How It Works

1. When a run transitions to EXECUTING, the engine sets `heartbeatDeadline = now + 30s`
2. The worker sends heartbeats every 10s via POST /api/runs/:id/heartbeat
3. Each heartbeat extends the deadline by 30s
4. The heartbeat monitor polls every 15s looking for EXECUTING runs where `heartbeatDeadline < now`
5. Stale runs are either retried (→ DELAYED) or failed (→ FAILED)

```
Timeline:
  0s    Run starts EXECUTING. heartbeatDeadline = t+30s
  10s   Worker heartbeat. heartbeatDeadline = t+40s
  20s   Worker heartbeat. heartbeatDeadline = t+50s
  25s   Worker DIES (crash, OOM, network partition)
  30s   No heartbeat. Deadline still t+50s.
  40s   No heartbeat. Deadline still t+50s.
  50s   heartbeatDeadline < now. Monitor detects stale run.
        → shouldRetry? YES → transition to DELAYED (backoff)
        → shouldRetry? NO  → transition to FAILED
```

### Heartbeat Deadline Set in Engine

```typescript
// packages/engine/src/run-engine.ts (line 83-85)
heartbeatDeadline: to === "EXECUTING"
  ? new Date(context.now.getTime() + 30_000)  // 30s from now
  : newRun.heartbeatDeadline,
```

### Heartbeat Extension in Server

```typescript
// POST /api/runs/:id/heartbeat (packages/server/src/routes/index.ts lines 394-415)
await db.update(schema.runs)
  .set({
    heartbeatDeadline: new Date(Date.now() + 30_000),  // extend by 30s
    ...(workerId ? { workerId } : {}),
  })
  .where(and(
    eq(schema.runs.id, runId),
    eq(schema.runs.status, "EXECUTING"),  // only if still executing
  ));
```

---

## 12. Background Schedulers

The server starts 4 independent polling loops:

### Delayed Scheduler (polls every 1s)

Promotes DELAYED → QUEUED when `scheduledFor <= now`.

```
Delayed runs in DB:
  run-abc: status=DELAYED, scheduledFor=2024-01-01T12:00:05Z
  run-xyz: status=DELAYED, scheduledFor=2024-01-01T12:00:10Z

At 12:00:06: Scheduler finds run-abc, transitions DELAYED → QUEUED.
At 12:00:11: Scheduler finds run-xyz, transitions DELAYED → QUEUED.
```

**Use cases**: Retry backoff (failed task waits N seconds), future-scheduled runs (trigger with scheduledFor).

### Duration Scheduler (polls every 1s)

Resolves DURATION waitpoints when `resumeAfter <= now`.

```
Waitpoint in DB:
  type=DURATION, runId=run-parent, resumeAfter=2024-01-01T12:01:00Z, resolved=false

At 12:01:01: Scheduler calls waitpointResolver.resolveDurationWait()
  → marks waitpoint resolved
  → caches step result in run_steps
  → transitions parent SUSPENDED → QUEUED
```

### Heartbeat Monitor (polls every 15s)

See Section 11 above.

### TTL Checker (polls every 5s)

Expires QUEUED runs whose TTL has been exceeded.

```
Run in DB:
  status=QUEUED, createdAt=12:00:00, ttl=60 (seconds)

At 12:01:05: TTL checker finds run, transitions QUEUED → EXPIRED.
```

---

## 13. Waitpoints & Suspension — Pausing Runs

A run can SUSPEND at a "waitpoint" — a condition that must be satisfied before it can continue.

### Waitpoint Types

| Type | Trigger | Resolution |
|------|---------|------------|
| `CHILD_RUN` | `ctx.triggerAndWait(taskId, payload)` | Child run completes |
| `DURATION` | `ctx.waitFor({ seconds: 60 })` | Timer elapses |
| `TOKEN` | `ctx.waitForToken({ timeout: "5m" })` | External HTTP call: POST /api/waitpoints/:token/complete |
| `BATCH` | Multiple child tasks | All children complete |

### Suspension Flow

```
Task code:
  const result = await ctx.triggerAndWait("child-task", { data: "hello" });
       │
       ▼
StepContext.triggerAndWait():
  Check if result is cached in run_steps → NO (first time)
  throw new SuspendExecution(stepIndex, "triggerAndWait:child-task", "CHILD_RUN", {...})
       │
       ▼
Worker catches SuspendExecution
Worker calls POST /api/runs/:id/suspend {
  stepIndex: 0,
  stepKey: "triggerAndWait:child-task",
  waitpointType: "CHILD_RUN",
  waitpointData: { taskId: "child-task", payload: { data: "hello" } }
}
       │
       ▼
Server:
  1. engine.transition(parentRunId, "SUSPENDED", { reason: "Suspended at step 0" })
  2. Create child run (INSERT into runs, status PENDING → enqueue → QUEUED)
  3. Create waitpoint record { type: "CHILD_RUN", runId: parentId, childRunId: childId }
       │
       ▼
Child run gets dequeued, executed, completed
       │
       ▼
POST /api/runs/:childId/complete { output }
  → engine.transition(childId, "COMPLETED", { output })
  → waitpointResolver.resolveChildRun(childId, output)
    → Find waitpoint by childRunId
    → Mark resolved=true, result=output
    → Cache step result in run_steps (stepIndex=0, result=output)
    → engine.transition(parentId, "QUEUED", { reason: "child resolved" })
       │
       ▼
Parent run gets dequeued again, worker re-executes task function
Step 0: triggerAndWait("child-task") → finds cached result → returns instantly
Step 1: (next line of code) → executes for real
```

### Waitpoint Resolution

**File**: `packages/engine/src/waitpoints/waitpoints.ts`

```typescript
// resolveChildRun: called when a child run completes
async resolveChildRun(childRunId: string, output: unknown): Promise<void> {
  // Find unresolved waitpoint for this child
  const [wp] = await db.select().from(schema.waitpoints)
    .where(and(
      eq(schema.waitpoints.childRunId, childRunId),
      eq(schema.waitpoints.resolved, false),
    ));
  if (!wp) return;

  // Mark resolved
  await db.update(schema.waitpoints).set({
    resolved: true, resolvedAt: new Date(), result: output,
  }).where(eq(schema.waitpoints.id, wp.id));

  // Cache step result for replay
  await db.insert(schema.runSteps).values({
    runId: wp.runId, stepIndex: wp.stepIndex!, stepKey: wp.stepKey!, result: output,
  }).onConflictDoNothing();

  // Resume parent: SUSPENDED → QUEUED
  await engine.transition(wp.runId, "QUEUED", {
    now: new Date(), reason: `Child run ${childRunId} completed`,
  });
}
```

---

## 14. Step-Based Resumption — Replay Without Snapshots

**File**: `packages/engine/src/resumption/step-runner.ts`

### The Problem

When a task calls `triggerAndWait()`, it needs to PAUSE. But Node.js can't snapshot a running function's stack. So we use **step-based replay**: re-run the entire function, but return cached results for already-completed steps.

### How It Works

```typescript
async function executeWithResumption(run, taskFn): Promise<{ output } | { suspended: true }> {
  // Load previously cached step results
  const completedSteps = await db.select().from(runSteps)
    .where(eq(runSteps.runId, run.id))
    .orderBy(runSteps.stepIndex);

  let currentStepIndex = 0;

  const ctx: StepContext = {
    triggerAndWait: async (taskId, payload) => {
      const myIndex = currentStepIndex++;

      // Is this step already cached?
      const cached = completedSteps.find(s => s.stepIndex === myIndex);
      if (cached) {
        // Non-determinism check: was this the same call last time?
        if (cached.stepKey !== `triggerAndWait:${taskId}`) {
          throw new Error("Non-determinism detected!");
        }
        return cached.result;  // Return cached result instantly
      }

      // Not cached — this is a new step. SUSPEND.
      throw new SuspendExecution(myIndex, `triggerAndWait:${taskId}`, "CHILD_RUN", { taskId, payload });
    },

    waitFor: async (duration) => { /* similar pattern */ },
    waitForToken: async (opts) => { /* similar pattern */ },
  };

  try {
    const output = await taskFn(run.payload, ctx);
    return { output };  // Task completed!
  } catch (e) {
    if (e instanceof SuspendExecution) {
      return { suspended: true };  // Task paused at a waitpoint
    }
    throw e;  // Real error
  }
}
```

### Replay Example

```typescript
// Task with 3 suspendable steps:
export const parentTask = task({
  id: "parent-task",
  run: async (payload, ctx) => {
    const a = await ctx.triggerAndWait("child-a", { x: 1 });   // Step 0
    await ctx.waitFor({ seconds: 60 });                         // Step 1
    const b = await ctx.triggerAndWait("child-b", { a });       // Step 2
    return { a, b };
  },
});
```

```
Execution 1: Step 0 → no cache → SuspendExecution → SUSPENDED (waiting for child-a)
Execution 2: Step 0 → CACHED ✓ → Step 1 → no cache → SuspendExecution → SUSPENDED (waiting 60s)
Execution 3: Step 0 → CACHED ✓ → Step 1 → CACHED ✓ → Step 2 → no cache → SuspendExecution → SUSPENDED
Execution 4: Step 0 → CACHED ✓ → Step 1 → CACHED ✓ → Step 2 → CACHED ✓ → return { a, b } → COMPLETED
```

### Non-Determinism Detection

If the task function uses `Math.random()` or conditional logic to decide which steps to call, the replay will diverge. The step key mismatch catches this:

```
Execution 1: Step 0 = "triggerAndWait:child-a" → cached with key "triggerAndWait:child-a"
Execution 2: Step 0 = "triggerAndWait:child-b" → key mismatch! → throws Error
```

---

## 15. SSE Real-Time Updates — PG NOTIFY to Browser

### The Chain

```
Engine transition → PG NOTIFY 'run_updates' → SSE stream → Browser EventSource → React Query invalidate
```

### Step 1: Engine sends NOTIFY

```typescript
// packages/engine/src/run-engine.ts (lines 128-140)
await db.execute(sql`NOTIFY run_updates, ${JSON.stringify({
  runId,
  fromStatus: run.status,
  toStatus: to,
  queueId: run.queueId,
  taskId: run.taskId,
  timestamp: new Date().toISOString(),
})}`);
```

### Step 2: SSE endpoint listens with LISTEN

```typescript
// packages/server/src/routes/stream.ts
api.get("/stream", async (c) => {
  return streamSSE(c, async (stream) => {
    // Dedicated Postgres connection (not pooled) for LISTEN
    const listener = postgres(connectionString, { max: 1 });

    await listener.listen("run_updates", (payload: string) => {
      stream.writeSSE({ data: payload, event: "update" }).catch(() => {});
    });

    // Keep alive until client disconnects
    await new Promise<void>((resolve) => {
      stream.onAbort(() => resolve());
    });

    await listener.end();
  });
});
```

**Why a dedicated connection**: PostgreSQL LISTEN requires a persistent connection that stays subscribed. Pooled connections get returned to the pool and lose the subscription.

### Step 3: Dashboard subscribes

```typescript
// packages/dashboard/src/app/page.tsx
useEffect(() => {
  const source = new EventSource("/api/stream");
  source.addEventListener("update", () => {
    queryClient.invalidateQueries({ queryKey: ["runs"] });
  });
  return () => source.close();
}, [queryClient]);
```

The browser's `EventSource` auto-reconnects if the connection drops.

---

## 16. The Dashboard — How the UI Fetches and Displays

### API Proxy

```typescript
// packages/dashboard/next.config.ts
async rewrites() {
  return [{
    source: "/api/:path*",
    destination: "http://localhost:3000/api/:path*",
  }];
}
```

All `/api/*` calls from the browser go through Next.js to the server on port 3000. No CORS issues.

### Data Layer: TanStack React Query

```typescript
// packages/dashboard/src/app/providers.tsx
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,      // data considered fresh for 5s
      refetchInterval: 10_000, // refetch every 10s as fallback
    },
  },
});
```

Each page uses `useQuery` to fetch data and SSE to invalidate on real-time updates.

### Pages

| Page | Route | Data Source | Real-time |
|------|-------|------------|-----------|
| Runs | `/` | `GET /api/runs` | SSE `/api/stream` |
| Run Detail | `/runs/[id]` | `GET /api/runs/:id` + `GET /api/runs/:id/events` | SSE `/api/runs/:id/stream` |
| Trigger | `/trigger` | `GET /api/tasks` (dropdown) | — |
| Tasks | `/tasks` | `GET /api/tasks` | — |
| Events | `/events` | `GET /api/events` | SSE `/api/stream` |
| Queues | `/queues` | `GET /api/queues` | — |
| Workers | `/workers` | `GET /api/workers` | — |

---

## 17. The SDK — Client & Task Definition

### task() Helper

**File**: `packages/sdk/src/task.ts`

```typescript
export function task<TPayload, TOutput>(config: TaskConfig<TPayload, TOutput>): TaskHandle<TPayload, TOutput> {
  return { id: config.id, queue: config.queue, retry: config.retry, run: config.run };
}
```

Pure passthrough for type safety. Usage:

```typescript
export const deliverWebhook = task<WebhookPayload, WebhookResult>({
  id: "deliver-webhook",
  queue: "webhooks",
  retry: { maxAttempts: 5, minTimeout: 1000, maxTimeout: 60000, factor: 3 },
  run: async (payload) => {
    // ... actual webhook delivery logic
  },
});
```

### ReloadClient

**File**: `packages/sdk/src/client.ts`

Full HTTP client wrapping all server endpoints:

```typescript
const client = new ReloadClient({ baseUrl: "http://localhost:3000" });

// Trigger a task
const { runId } = await client.trigger("deliver-webhook", { targetUrl: "...", event: "user.signup", data: {...} });

// Check status
const run = await client.getRun(runId);

// Complete/fail (used by worker)
await client.completeRun(runId, output);
await client.failRun(runId, { message: "..." }, "TASK_ERROR");

// Queue/task management (used by worker on startup)
await client.createQueue("webhooks", 10);
await client.registerTask("deliver-webhook", "webhooks", { maxAttempts: 5 });
```

---

## 18. Database Schema — Every Table Explained

### `queues` — Named queues with concurrency limits

```
┌────────────────────┬──────────┬────────────┐
│ Column             │ Type     │ Notes      │
├────────────────────┼──────────┼────────────┤
│ id (PK)            │ text     │ "webhooks" │
│ concurrency_limit  │ int      │ default 10 │
│ paused             │ bool     │ default false │
│ created_at         │ timestamp│ auto       │
└────────────────────┴──────────┴────────────┘
```

### `tasks` — Registered task types

```
┌────────────────────┬──────────┬──────────────────────────┐
│ Column             │ Type     │ Notes                    │
├────────────────────┼──────────┼──────────────────────────┤
│ id (PK)            │ text     │ "deliver-webhook"        │
│ queue_id (FK)      │ text     │ → queues.id              │
│ retry_config       │ jsonb    │ {maxAttempts, factor...} │
│ created_at         │ timestamp│ auto                     │
└────────────────────┴──────────┴──────────────────────────┘
```

### `runs` — Every task execution

```
┌────────────────────┬──────────┬──────────────────────────────────────┐
│ Column             │ Type     │ Notes                                │
├────────────────────┼──────────┼──────────────────────────────────────┤
│ id (PK)            │ uuid     │ auto-generated                       │
│ task_id (FK)       │ text     │ → tasks.id                           │
│ queue_id (FK)      │ text     │ → queues.id                          │
│ status             │ enum     │ PENDING/QUEUED/DELAYED/EXECUTING/... │
│ payload            │ jsonb    │ input data                           │
│ output             │ jsonb    │ result (on COMPLETED)                │
│ error              │ jsonb    │ error details (on FAILED)            │
│ failure_type       │ enum     │ TASK_ERROR/SYSTEM_ERROR/TIMEOUT      │
│ scheduled_for      │ timestamp│ when to execute (DELAYED)            │
│ ttl                │ int      │ seconds before EXPIRED               │
│ priority           │ int      │ 0=normal, higher=first               │
│ idempotency_key    │ text     │ prevents duplicate runs              │
│ concurrency_key    │ text     │ per-user/per-entity limits           │
│ attempt_number     │ int      │ which retry attempt                  │
│ max_attempts       │ int      │ retry limit                          │
│ parent_run_id      │ uuid     │ parent run (for child tasks)         │
│ worker_id          │ text     │ which worker is executing            │
│ heartbeat_deadline │ timestamp│ worker must heartbeat before this    │
│ version            │ int      │ optimistic locking counter           │
│ created_at         │ timestamp│ when created                         │
│ started_at         │ timestamp│ when execution began                 │
│ completed_at       │ timestamp│ when finished (any terminal state)   │
│ dequeued_at        │ timestamp│ when worker received it              │
└────────────────────┴──────────┴──────────────────────────────────────┘

Indexes:
  idx_runs_queue_status (queue_id, status)         — dequeue performance
  idx_runs_scheduled_for (scheduled_for)           — delayed scheduler
  idx_runs_idempotency_key (UNIQUE)                — idempotency
  idx_runs_status (status)                         — filtering
  idx_runs_heartbeat_deadline (heartbeat_deadline)  — heartbeat monitor
```

### `run_events` — Append-only audit log

Every state transition is recorded. Never deleted, never updated.

```
┌────────────────┬──────────┬──────────────────────────┐
│ Column         │ Type     │ Notes                    │
├────────────────┼──────────┼──────────────────────────┤
│ id (PK)        │ uuid     │ auto                     │
│ run_id (FK)    │ uuid     │ → runs.id                │
│ event_type     │ text     │ "run.queued", "run.failed" │
│ from_status    │ enum     │ previous state           │
│ to_status      │ enum     │ new state                │
│ worker_id      │ text     │ which worker (if any)    │
│ attempt        │ int      │ attempt number           │
│ reason         │ text     │ human-readable reason    │
│ data           │ jsonb    │ error details, output    │
│ created_at     │ timestamp│ when this happened       │
└────────────────┴──────────┴──────────────────────────┘
```

### `run_steps` — Cached step results for replay

```
┌────────────────┬──────────┬──────────────────────────┐
│ Column         │ Type     │ Notes                    │
├────────────────┼──────────┼──────────────────────────┤
│ id (PK)        │ serial   │ auto-increment           │
│ run_id (FK)    │ uuid     │ → runs.id                │
│ step_index     │ int      │ 0, 1, 2, ...             │
│ step_key       │ text     │ "triggerAndWait:child-a"  │
│ result         │ jsonb    │ cached output            │
│ created_at     │ timestamp│ auto                     │
└────────────────┴──────────┴──────────────────────────┘
UNIQUE(run_id, step_index)
```

### `waitpoints` — Conditions blocking suspended runs

```
┌────────────────┬──────────┬──────────────────────────┐
│ Column         │ Type     │ Notes                    │
├────────────────┼──────────┼──────────────────────────┤
│ id (PK)        │ uuid     │ auto                     │
│ type           │ text     │ CHILD_RUN/DURATION/TOKEN/BATCH │
│ run_id (FK)    │ uuid     │ the suspended run        │
│ resolved       │ bool     │ has this been satisfied? │
│ resolved_at    │ timestamp│ when resolved            │
│ result         │ jsonb    │ resolved value           │
│ resume_after   │ timestamp│ for DURATION waits       │
│ child_run_id   │ uuid     │ for CHILD_RUN waits      │
│ token          │ text     │ for TOKEN waits (unique)  │
│ expires_at     │ timestamp│ token expiry             │
│ batch_total    │ int      │ for BATCH waits          │
│ batch_resolved │ int      │ count of resolved children │
│ step_index     │ int      │ which step in the parent │
│ step_key       │ text     │ determinism key          │
│ created_at     │ timestamp│ auto                     │
└────────────────┴──────────┴──────────────────────────┘
```

### `workers` — Registered worker processes

```
┌────────────────┬──────────┬──────────────────────────┐
│ Column         │ Type     │ Notes                    │
├────────────────┼──────────┼──────────────────────────┤
│ id (PK)        │ text     │ worker-generated UUID    │
│ task_types     │ jsonb[]  │ ["deliver-webhook", ...] │
│ queue_id       │ text     │ primary queue            │
│ concurrency    │ int      │ how many runs at once    │
│ status         │ text     │ "online" / "offline"     │
│ last_heartbeat │ timestamp│ liveness signal          │
│ registered_at  │ timestamp│ when worker joined       │
└────────────────┴──────────┴──────────────────────────┘
```

---

## 19. FP Patterns in Practice

### Result<T, E> — Error handling without exceptions

**File**: `packages/core/src/result.ts`

```typescript
type Ok<T>  = { readonly ok: true;  readonly value: T };
type Err<E> = { readonly ok: false; readonly error: E };
type Result<T, E> = Ok<T> | Err<E>;

const ok  = <T>(value: T): Ok<T>  => ({ ok: true, value });
const err = <E>(error: E): Err<E> => ({ ok: false, error });
```

**Where used**: `computeTransition()` returns `Result<TransitionResult, TransitionError>`. The engine checks `result.ok` before proceeding. No try/catch needed for domain errors.

### Discriminated Unions — Type-safe pattern matching

Every domain type uses a `_tag` field:

```typescript
// Side effects
type SideEffect =
  | { _tag: "EnqueueRun"; ... }
  | { _tag: "EmitEvent"; ... }
  | { _tag: "CancelHeartbeat"; ... }

// Events
type RunEvent =
  | { _tag: "RunQueued"; ... }
  | { _tag: "RunCompleted"; ... }
  | { _tag: "RunFailed"; ... }

// Errors
type TransitionError =
  | { _tag: "InvalidTransition"; from: string; to: string }
  | { _tag: "RunNotFound"; runId: string }
  | { _tag: "VersionConflict"; expected: number; actual: number }
```

The `switch` on `_tag` gives exhaustive checking. TypeScript errors if you miss a case.

### Functional Core, Imperative Shell

```
┌─────────────────────────────────┐
│       PURE (no I/O)             │
│  computeTransition()            │
│  computeBackoffMs()             │
│  shouldRetry()                  │
│  canTransition()                │
│  isTerminal()                   │
│                                 │
│  Input → Output                 │
│  No database, no Redis,         │
│  no HTTP, no side effects       │
└────────────────┬────────────────┘
                 │ called by
┌────────────────▼────────────────┐
│       IMPURE (I/O)              │
│  engine.transition()            │
│  executeSideEffect()            │
│  Hono route handlers            │
│  Worker dequeue loop            │
│  Scheduler polling loops        │
│                                 │
│  Reads DB, writes DB,           │
│  sends HTTP, calls Redis        │
└─────────────────────────────────┘
```

### Immutability

All domain types use `readonly`:

```typescript
export interface Run {
  readonly id: string;
  readonly status: RunStatus;
  readonly version: number;
  // ...
}
```

State updates create new objects via spread:

```typescript
const newRun: Run = { ...run, status: "COMPLETED", output: context.output };
```

---

## 20. API Endpoint Reference

### Run Management

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/trigger` | Create new run |
| GET | `/api/runs` | List runs (filterable) |
| GET | `/api/runs/:id` | Get run detail |
| POST | `/api/runs/:id/complete` | Mark completed |
| POST | `/api/runs/:id/fail` | Mark failed (with retry logic) |
| POST | `/api/runs/:id/cancel` | Cancel run |
| POST | `/api/runs/:id/heartbeat` | Extend heartbeat deadline |
| POST | `/api/runs/:id/suspend` | Suspend at waitpoint |
| GET | `/api/runs/:id/events` | Event timeline for run |
| GET | `/api/runs/:id/steps` | Cached step results |
| GET | `/api/runs/:id/waitpoints` | Blocking waitpoints |

### Queue & Task Management

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/queues` | List queues + stats |
| POST | `/api/queues` | Create queue |
| GET | `/api/tasks` | List registered tasks |
| POST | `/api/tasks` | Register task (auto-creates queue) |

### Worker Management

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/dequeue` | Worker pulls work (PG SKIP LOCKED) |
| POST | `/api/dequeue/fair` | Fair dequeue (Redis-based) |
| POST | `/api/workers/register` | Worker registers |
| POST | `/api/workers/:id/heartbeat` | Worker liveness |
| POST | `/api/workers/:id/deregister` | Worker going offline |
| GET | `/api/workers` | List workers |

### Events & Streaming

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/events` | Global event feed (paginated) |
| GET | `/api/stream` | SSE: all run updates |
| GET | `/api/runs/:id/stream` | SSE: single run updates |
| GET | `/api/queues/:id/stream` | SSE: queue updates |

### Waitpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/waitpoints/:token/complete` | Resolve human-in-the-loop token |

---

## 21. Example Tasks — What They Do

### site-health-check (queue: "monitoring")

HTTP GET to a URL, checks status code, measures latency, returns health report.
Retry: 3 attempts, 2s→4s→8s backoff.

### deliver-webhook (queue: "webhooks")

POST webhook to target URL with HMAC-SHA256 signature (Stripe/GitHub pattern). Includes `X-Webhook-Id`, `X-Webhook-Timestamp`, `X-Webhook-Signature` headers. 15s timeout.
Retry: 5 attempts, 1s→3s→9s→27s→60s backoff (factor 3).

### scrape-metadata (queue: "scraping")

Fetches HTML, extracts title, description, Open Graph tags, favicon, link/image counts, word count. 20s timeout.
Retry: 2 attempts, 3s→6s backoff.

### generate-report (queue: "default")

Generates pseudo-random dataset using seeded PRNG, applies filters, computes statistics (mean, median, stdDev, percentiles), builds distribution histogram. Simulates CPU-bound work with sleep proportional to dataset size.
Retry: default.

### process-image (queue: "media")

Downloads image, detects dimensions from binary headers (PNG/JPEG/GIF), runs operations: thumbnail (block-average), grayscale (byte histogram), blur (sliding window), hash (MD5+SHA1), metadata (entropy calculation). 30s timeout.
Retry: 2 attempts, 2s→4s backoff.
