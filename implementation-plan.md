# MiniQueue: Implementation Plan
## Building a Distributed Task Queue from Scratch

---

## Tech Stack (Final)

| Layer | Tech | Why |
|-------|------|-----|
| API Server | **Hono** (on Node.js) | Lightweight, fast, great TypeScript support, familiar if you know Express |
| Database | **PostgreSQL** | State storage, event log, SKIP LOCKED queuing as fallback |
| Queue + Cache | **Redis** | Primary run queue, concurrency tracking, distributed locks |
| ORM | **Drizzle** | Type-safe, SQL-close, great migration story |
| Worker Runtime | **Node.js child processes** | Start simple, upgrade to Docker containers later |
| Dashboard | **Next.js** (React) | You already know it |
| Observability | **OpenTelemetry JS SDK** | Industry standard, traces + spans + logs |
| Testing | **Vitest** | Fast, modern |
| Package Manager | **pnpm** | Monorepo-friendly with workspaces |

---

## Project Structure (Monorepo)

```
miniqueue/
├── packages/
│   ├── core/              # Shared types, schemas, constants
│   │   ├── src/
│   │   │   ├── types.ts           # Run, Task, Queue, Snapshot types
│   │   │   ├── states.ts          # State machine definition
│   │   │   ├── schemas.ts         # Zod schemas for validation
│   │   │   └── constants.ts       # Status enums, defaults
│   │   └── package.json
│   │
│   ├── engine/            # The brain — Run Engine
│   │   ├── src/
│   │   │   ├── run-engine.ts      # Main RunEngine class
│   │   │   ├── state-machine.ts   # State transition logic
│   │   │   ├── queue/
│   │   │   │   ├── redis-queue.ts     # Redis-based run queue
│   │   │   │   ├── fair-dequeue.ts    # Fair multi-tenant dequeuing
│   │   │   │   └── concurrency.ts     # Token bucket concurrency control
│   │   │   ├── locking/
│   │   │   │   └── distributed-lock.ts # Redlock implementation
│   │   │   ├── snapshots/
│   │   │   │   └── snapshot-manager.ts # Append-only snapshot logic
│   │   │   ├── retry/
│   │   │   │   └── retry-strategy.ts  # Exponential backoff + jitter
│   │   │   ├── heartbeat/
│   │   │   │   └── heartbeat-monitor.ts
│   │   │   └── waitpoints/
│   │   │       └── waitpoint-manager.ts
│   │   └── package.json
│   │
│   ├── server/            # HTTP API
│   │   ├── src/
│   │   │   ├── index.ts           # Hono app setup
│   │   │   ├── routes/
│   │   │   │   ├── trigger.ts     # POST /trigger — trigger a task
│   │   │   │   ├── runs.ts        # GET/PATCH runs
│   │   │   │   ├── queues.ts      # Queue management
│   │   │   │   └── webhooks.ts    # External event callbacks
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts        # API key validation
│   │   │   │   └── tracing.ts     # OpenTelemetry middleware
│   │   │   └── db/
│   │   │       ├── schema.ts      # Drizzle schema definitions
│   │   │       └── migrations/    # SQL migrations
│   │   └── package.json
│   │
│   ├── worker/            # Task execution runtime
│   │   ├── src/
│   │   │   ├── worker-pool.ts     # Manages child processes
│   │   │   ├── worker-process.ts  # Individual worker logic
│   │   │   ├── task-runner.ts     # Loads + executes task code
│   │   │   └── dequeue-loop.ts    # Polls queue for work
│   │   └── package.json
│   │
│   ├── sdk/               # Client SDK for triggering tasks
│   │   ├── src/
│   │   │   ├── client.ts          # MiniQueue client
│   │   │   ├── task.ts            # task() definition helper
│   │   │   └── types.ts           # Public types
│   │   └── package.json
│   │
│   └── dashboard/         # Next.js monitoring UI
│       ├── src/
│       │   ├── app/
│       │   │   ├── page.tsx           # Runs list
│       │   │   ├── runs/[id]/page.tsx # Run detail + trace view
│       │   │   └── queues/page.tsx    # Queue management
│       │   └── components/
│       │       ├── RunTimeline.tsx     # Visual trace viewer
│       │       ├── StateIndicator.tsx  # Run status badge
│       │       └── QueueStats.tsx      # Concurrency gauges
│       └── package.json
│
├── tasks/                 # Example task definitions (for testing)
│   ├── hello-world.ts
│   ├── send-email.ts
│   └── process-data.ts
│
├── docker-compose.yml     # Postgres + Redis for local dev
├── pnpm-workspace.yaml
├── tsconfig.json
└── turbo.json             # Turborepo for build orchestration
```

---

## Database Schema (PostgreSQL via Drizzle)

```typescript
// packages/server/src/db/schema.ts

import { pgTable, text, timestamp, integer, jsonb, pgEnum, uuid, boolean } from 'drizzle-orm/pg-core';

// === ENUMS ===
export const runStatusEnum = pgEnum('run_status', [
  'PENDING',      // Just triggered, not yet queued
  'QUEUED',       // In the run queue, waiting for a worker
  'DELAYED',      // Waiting for a scheduled time
  'EXECUTING',    // Worker is running the task
  'SUSPENDED',    // Paused (waiting for child task / wait / external event)
  'COMPLETED',    // Finished successfully
  'FAILED',       // Failed after all retries exhausted
  'CANCELLED',    // Manually cancelled
  'EXPIRED',      // TTL exceeded while queued
]);

// === TABLES ===

// Task definitions (registered when workers connect)
export const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),                    // e.g. "send-email"
  queueId: text('queue_id').references(() => queues.id),
  retryConfig: jsonb('retry_config'),             // { maxAttempts, backoff, factor }
  createdAt: timestamp('created_at').defaultNow(),
});

// Named queues with concurrency limits
export const queues = pgTable('queues', {
  id: text('id').primaryKey(),                    // e.g. "default", "email-queue"
  concurrencyLimit: integer('concurrency_limit').default(10),
  paused: boolean('paused').default(false),
  createdAt: timestamp('created_at').defaultNow(),
});

// Individual task runs
export const runs = pgTable('runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id),
  queueId: text('queue_id').notNull().references(() => queues.id),
  status: runStatusEnum('status').notNull().default('PENDING'),
  payload: jsonb('payload'),                       // Input data
  output: jsonb('output'),                         // Result data
  error: jsonb('error'),                           // Error info if failed
  
  // Scheduling
  scheduledFor: timestamp('scheduled_for'),         // For delayed runs
  ttl: integer('ttl'),                             // Seconds before expiry
  priority: integer('priority').default(0),         // Time offset in seconds
  
  // Idempotency
  idempotencyKey: text('idempotency_key').unique(),
  
  // Concurrency
  concurrencyKey: text('concurrency_key'),          // Per-tenant concurrency
  
  // Retry tracking
  attemptNumber: integer('attempt_number').default(0),
  maxAttempts: integer('max_attempts').default(3),
  
  // Parent-child relationships
  parentRunId: uuid('parent_run_id').references(() => runs.id),
  
  // Version locking
  version: text('version'),
  
  // Metadata
  tags: jsonb('tags').$type<string[]>(),
  metadata: jsonb('metadata'),
  
  // Timestamps
  createdAt: timestamp('created_at').defaultNow(),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  
  // Snapshot tracking
  currentSnapshotId: uuid('current_snapshot_id'),
});

// Append-only execution snapshots
export const executionSnapshots = pgTable('execution_snapshots', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: uuid('run_id').notNull().references(() => runs.id),
  status: runStatusEnum('status').notNull(),
  workerId: text('worker_id'),
  heartbeatDeadline: timestamp('heartbeat_deadline'),
  data: jsonb('data'),                             // Any extra state info
  createdAt: timestamp('created_at').defaultNow(),
});

// Waitpoints — things that can block runs
export const waitpoints = pgTable('waitpoints', {
  id: uuid('id').defaultRandom().primaryKey(),
  type: text('type').notNull(),                    // 'DURATION' | 'CHILD_RUN' | 'TOKEN' | 'DATETIME'
  runId: uuid('run_id').notNull().references(() => runs.id),
  resolved: boolean('resolved').default(false),
  resolvedAt: timestamp('resolved_at'),
  result: jsonb('result'),                         // Data returned when resolved
  
  // For DURATION waits
  resumeAfter: timestamp('resume_after'),
  
  // For CHILD_RUN waits  
  childRunId: uuid('child_run_id').references(() => runs.id),
  
  // For TOKEN waits (human-in-the-loop)
  token: text('token').unique(),
  expiresAt: timestamp('expires_at'),
  
  createdAt: timestamp('created_at').defaultNow(),
});
```

---

## Phase 1: Foundation (Week 1-2)
### Goal: Trigger → Queue → Execute → Complete

### Concepts to learn first:
- PostgreSQL basics: tables, indexes, transactions
- Redis basics: strings, lists, sorted sets, pub/sub
- Hono framework: routing, middleware, context

### What to build:

**1.1 — Set up the monorepo + infrastructure**

```bash
# docker-compose.yml
services:
  postgres:
    image: postgres:16
    ports: ["5432:5432"]
    environment:
      POSTGRES_DB: miniqueue
      POSTGRES_PASSWORD: miniqueue
  redis:
    image: redis:7
    ports: ["6379:6379"]
```

- Initialize pnpm workspace with all packages
- Set up Drizzle with the schema above (start with just `tasks`, `queues`, `runs` tables)
- Run migrations

**1.2 — Build the API server (packages/server)**

Three endpoints to start:

```
POST /api/trigger
  Body: { taskId: "send-email", payload: { to: "user@..." } }
  Response: { runId: "uuid-..." }
  Logic: 
    1. Validate taskId exists
    2. Check idempotency key (if provided)
    3. Insert run into `runs` table with status=PENDING
    4. Push run ID onto Redis queue (LPUSH)
    5. Update status to QUEUED
    6. Return run ID

GET /api/runs/:id
  Response: Full run object with current status

POST /api/runs/:id/heartbeat
  Body: { workerId: "worker-1" }
  Logic: Update heartbeat timestamp
```

**1.3 — Build the worker (packages/worker)**

```typescript
// Simplified dequeue loop
async function dequeueLoop() {
  while (true) {
    // BRPOP blocks until something is in the queue (up to 5s)
    const runId = await redis.brpop('miniqueue:runs', 5);
    
    if (!runId) continue; // Nothing in queue, try again
    
    // Load the run from Postgres
    const run = await db.select().from(runs).where(eq(runs.id, runId));
    
    // Update status to EXECUTING
    await db.update(runs).set({ 
      status: 'EXECUTING', 
      startedAt: new Date() 
    }).where(eq(runs.id, runId));
    
    // Load the task function and execute it
    try {
      const taskFn = taskRegistry[run.taskId];
      const result = await taskFn(run.payload);
      
      await db.update(runs).set({ 
        status: 'COMPLETED', 
        output: result,
        completedAt: new Date() 
      }).where(eq(runs.id, runId));
    } catch (error) {
      await db.update(runs).set({ 
        status: 'FAILED', 
        error: { message: error.message, stack: error.stack }
      }).where(eq(runs.id, runId));
    }
  }
}
```

**1.4 — Build the SDK (packages/sdk)**

```typescript
// User-facing API
import { task } from '@miniqueue/sdk';

export const sendEmail = task({
  id: 'send-email',
  run: async (payload: { to: string; subject: string }) => {
    // ... actual email logic
    return { sent: true };
  },
});

// Triggering from your app
import { client } from '@miniqueue/sdk';
const handle = await client.trigger('send-email', { to: 'user@...' });
```

### Phase 1 deliverable:
You can trigger a task via HTTP, it gets queued in Redis, a worker picks it up, executes it, and the status updates in Postgres. You can query the status via the API.

---

## Phase 2: State Machine + Retries (Week 3-4)
### Goal: Runs have proper lifecycle, survive failures, retry automatically

### Concepts to learn first:
- Finite state machines: states, transitions, guards
- Retry strategies: exponential backoff, jitter, max attempts
- Idempotency: what it means, how to implement with unique keys

### What to build:

**2.1 — State machine (packages/engine/src/state-machine.ts)**

```typescript
// Define valid transitions
const TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  PENDING:    ['QUEUED', 'CANCELLED'],
  QUEUED:     ['EXECUTING', 'EXPIRED', 'CANCELLED', 'DELAYED'],
  DELAYED:    ['QUEUED', 'CANCELLED'],
  EXECUTING:  ['COMPLETED', 'FAILED', 'SUSPENDED', 'CANCELLED'],
  SUSPENDED:  ['EXECUTING', 'CANCELLED'],  // Resume = back to EXECUTING
  COMPLETED:  [],  // Terminal
  FAILED:     ['QUEUED'],  // Retry = back to QUEUED
  CANCELLED:  [],  // Terminal
  EXPIRED:    [],  // Terminal
};

function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

async function transition(runId: string, to: RunStatus, data?: any) {
  const run = await getRun(runId);
  if (!canTransition(run.status, to)) {
    throw new Error(`Invalid transition: ${run.status} → ${to}`);
  }
  // Update run + create snapshot (in a transaction)
  await db.transaction(async (tx) => {
    await tx.update(runs).set({ status: to, ...data });
    await tx.insert(executionSnapshots).values({
      runId, status: to, data
    });
  });
}
```

**2.2 — Retry logic (packages/engine/src/retry/retry-strategy.ts)**

```typescript
function calculateBackoff(attempt: number, config: RetryConfig): number {
  const { minTimeout, maxTimeout, factor } = config;
  // Exponential backoff: minTimeout * (factor ^ attempt)
  const exponential = minTimeout * Math.pow(factor, attempt);
  // Clamp to maxTimeout
  const clamped = Math.min(exponential, maxTimeout);
  // Add jitter (±25%) to prevent thundering herd
  const jitter = clamped * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

// In the worker, when a task fails:
async function handleFailure(runId: string, error: Error) {
  const run = await getRun(runId);
  
  if (run.attemptNumber < run.maxAttempts) {
    const backoff = calculateBackoff(run.attemptNumber, run.retryConfig);
    const retryAt = new Date(Date.now() + backoff);
    
    await transition(runId, 'QUEUED', {
      attemptNumber: run.attemptNumber + 1,
      scheduledFor: retryAt,  // Don't execute until this time
    });
    // Schedule re-queue after backoff
    await scheduleRequeue(runId, backoff);
  } else {
    await transition(runId, 'FAILED', { error });
  }
}
```

**2.3 — Idempotency**

Before creating a run, check if one already exists with the same key:

```typescript
async function triggerTask(taskId, payload, options) {
  if (options.idempotencyKey) {
    const existing = await db.select().from(runs)
      .where(eq(runs.idempotencyKey, options.idempotencyKey))
      .limit(1);
    
    if (existing.length > 0) {
      return existing[0]; // Return existing run, don't create duplicate
    }
  }
  // ... create new run
}
```

### Phase 2 deliverable:
Runs go through a proper state machine. Failed tasks retry with exponential backoff. Idempotency keys prevent duplicates. Every state change is recorded as a snapshot.

---

## Phase 3: Concurrency Control + Fair Queuing (Week 5-6)
### Goal: Multiple queues, per-tenant fairness, concurrency limits

### Concepts to learn first:
- Token bucket algorithm: how rate limiting works
- Fair scheduling: round-robin, weighted fair queuing
- Redis sorted sets: ZADD, ZPOPMIN for priority queues

### What to build:

**3.1 — Named queues with concurrency limits**

Instead of one big Redis list, each queue gets its own sorted set (score = timestamp + priority offset):

```typescript
// Enqueue with priority
async function enqueue(runId: string, queueId: string, priority: number = 0) {
  const score = Date.now() - (priority * 1000); // Lower score = dequeued first
  await redis.zadd(`queue:${queueId}`, score, runId);
  // Also track which queues have items
  await redis.sadd('active-queues', queueId);
}
```

**3.2 — Concurrency tracking in Redis**

```typescript
// Before executing a run, check concurrency
async function acquireConcurrencySlot(queueId: string, runId: string): boolean {
  const queue = await getQueue(queueId);
  const currentCount = await redis.scard(`concurrency:${queueId}`);
  
  if (currentCount >= queue.concurrencyLimit) {
    return false; // Queue is at capacity
  }
  
  // Add this run to the active set
  await redis.sadd(`concurrency:${queueId}`, runId);
  return true;
}

// When a run completes/fails, release the slot
async function releaseConcurrencySlot(queueId: string, runId: string) {
  await redis.srem(`concurrency:${queueId}`, runId);
}
```

**3.3 — Fair dequeuing across tenants**

Round-robin across all active queues:

```typescript
async function fairDequeue(maxRuns: number): string[] {
  const activeQueues = await redis.smembers('active-queues');
  const dequeued: string[] = [];
  
  // Round-robin: take one from each queue until we have enough
  let round = 0;
  while (dequeued.length < maxRuns && round < 10) {
    for (const queueId of activeQueues) {
      if (dequeued.length >= maxRuns) break;
      
      // Check concurrency limit
      if (!await hasConcurrencySlot(queueId)) continue;
      
      // Pop the highest-priority item (lowest score)
      const item = await redis.zpopmin(`queue:${queueId}`);
      if (item) {
        dequeued.push(item);
        await acquireConcurrencySlot(queueId, item);
      }
    }
    round++;
  }
  
  return dequeued;
}
```

**3.4 — Concurrency keys (per-user limits)**

When a concurrency key is provided, create a virtual sub-queue:

```typescript
// trigger({ concurrencyKey: userId })
// This ensures each user can only have N concurrent runs
const concurrencyTrackingKey = `concurrency:${queueId}:${concurrencyKey}`;
```

### Phase 3 deliverable:
Multiple named queues with independent concurrency limits. Fair round-robin dequeuing. Per-tenant concurrency keys. Priority scheduling with time-offset.

---

## Phase 4: Distributed Locking + Snapshots (Week 7-8)
### Goal: Safe concurrent operations, full execution history

### Concepts to learn first:
- Redlock algorithm: distributed locking across Redis instances
- Optimistic concurrency control: version checking before writes
- Append-only event logs: why immutability matters

### What to build:

**4.1 — Distributed locking**

```typescript
// packages/engine/src/locking/distributed-lock.ts
import Redlock from 'redlock';

const redlock = new Redlock([redisClient], {
  retryCount: 10,
  retryDelay: 200,     // ms between retries
  retryJitter: 200,    // random jitter
});

async function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const lock = await redlock.acquire([`lock:run:${runId}`], 5000);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

// Usage: every state-changing operation on a run goes through this
await withRunLock(runId, async () => {
  // Check snapshot is still current
  // Perform the transition
  // Create new snapshot
});
```

**4.2 — Snapshot validation (stale operation rejection)**

```typescript
async function safeTransition(runId: string, expectedSnapshotId: string, to: RunStatus) {
  await withRunLock(runId, async () => {
    const run = await getRun(runId);
    
    // Reject if snapshot is stale (another operation already changed the state)
    if (run.currentSnapshotId !== expectedSnapshotId) {
      console.log(`Stale snapshot for run ${runId}, ignoring operation`);
      return; // Silently ignore — this is expected in distributed systems
    }
    
    // Create new snapshot
    const snapshot = await db.insert(executionSnapshots).values({
      runId, status: to
    }).returning();
    
    // Update run with new state and snapshot reference
    await db.update(runs).set({
      status: to,
      currentSnapshotId: snapshot[0].id,
    });
  });
}
```

**4.3 — Heartbeat monitoring**

```typescript
// Workers send heartbeats every 10 seconds
// The monitor checks for missing heartbeats every 30 seconds

async function checkHeartbeats() {
  const staleRuns = await db.select().from(executionSnapshots)
    .where(
      and(
        eq(executionSnapshots.status, 'EXECUTING'),
        lt(executionSnapshots.heartbeatDeadline, new Date()),
      )
    );
  
  for (const snapshot of staleRuns) {
    // Check if this is still the current snapshot
    const run = await getRun(snapshot.runId);
    if (run.currentSnapshotId !== snapshot.id) continue; // Run moved on
    
    // Run is stuck — mark as failed and trigger retry
    await safeTransition(run.id, snapshot.id, 'FAILED');
    await handleFailure(run.id, new Error('Worker heartbeat timeout'));
  }
}

// Run every 30 seconds
setInterval(checkHeartbeats, 30_000);
```

**4.4 — TTL expiry for queued runs**

```typescript
async function checkExpiredRuns() {
  const now = new Date();
  const expiredRuns = await db.select().from(runs)
    .where(
      and(
        eq(runs.status, 'QUEUED'),
        isNotNull(runs.ttl),
        lt(
          sql`${runs.createdAt} + ${runs.ttl} * interval '1 second'`,
          now
        ),
      )
    );
  
  for (const run of expiredRuns) {
    await transition(run.id, 'EXPIRED');
    // Remove from Redis queue
    await redis.zrem(`queue:${run.queueId}`, run.id);
  }
}
```

### Phase 4 deliverable:
Every operation on a run goes through a distributed lock. Stale operations are rejected via snapshot IDs. Full append-only history of every run. Heartbeat monitoring detects stuck workers. TTL expiry for queued runs.

---

## Phase 5: Observability Dashboard (Week 9-10)
### Goal: See everything in real-time

### Concepts to learn first:
- OpenTelemetry: traces, spans, context propagation
- PostgreSQL LISTEN/NOTIFY: real-time event notifications
- Server-Sent Events (SSE): streaming updates to frontend

### What to build:

**5.1 — OpenTelemetry instrumentation**

```typescript
// packages/engine/src/tracing.ts
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('miniqueue-engine');

async function executeRun(run: Run) {
  return tracer.startActiveSpan(`run:${run.taskId}`, async (span) => {
    span.setAttribute('run.id', run.id);
    span.setAttribute('run.taskId', run.taskId);
    span.setAttribute('run.attempt', run.attemptNumber);
    
    try {
      const result = await taskFn(run.payload);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}
```

**5.2 — Real-time updates with PostgreSQL LISTEN/NOTIFY**

```typescript
// Server side: notify on state changes
async function transition(runId, to, data) {
  // ... update DB ...
  await db.execute(sql`NOTIFY run_updates, ${JSON.stringify({ runId, status: to })}`);
}

// API endpoint: SSE stream
app.get('/api/runs/:id/stream', async (c) => {
  // Set up SSE
  return c.streamSSE(async (stream) => {
    const pgListener = await createPgListener();
    await pgListener.listen('run_updates', (payload) => {
      const data = JSON.parse(payload);
      if (data.runId === c.req.param('id')) {
        stream.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    });
  });
});
```

**5.3 — Dashboard (packages/dashboard)**

Key pages:
- **Runs list**: Filterable table showing all runs with status badges, timing, queue
- **Run detail**: Full trace view showing every span, state transitions timeline, logs, payload/output
- **Queues page**: Shows each queue with current/max concurrency, paused state, queue depth
- **Live updates**: SSE subscription for real-time status changes

### Phase 5 deliverable:
Every operation generates OpenTelemetry traces. Dashboard shows run status in real-time. You can see the full timeline of any run including retries and state transitions.

---

## Phase 6: Child Tasks + Waitpoints (Week 11-12)
### Goal: Tasks can trigger other tasks and wait for results

### Concepts to learn first:
- DAG execution: directed acyclic graphs of dependent tasks
- Event-driven architecture: how "waitpoints" unblock execution
- The waitpoint primitive: one concept that powers waits, child tasks, and human-in-the-loop

### What to build:

**6.1 — triggerAndWait()**

```typescript
// Inside a task's run function:
export const parentTask = task({
  id: 'parent-task',
  run: async (payload, ctx) => {
    // This triggers child and SUSPENDS the parent
    const result = await ctx.triggerAndWait('child-task', { data: 'hello' });
    // Parent resumes here when child completes
    return { childResult: result };
  },
});
```

Under the hood:
```typescript
async function triggerAndWait(parentRunId, childTaskId, childPayload) {
  // 1. Create the child run
  const childRun = await createRun(childTaskId, childPayload, { 
    parentRunId 
  });
  
  // 2. Create a waitpoint that blocks the parent
  const waitpoint = await db.insert(waitpoints).values({
    type: 'CHILD_RUN',
    runId: parentRunId,
    childRunId: childRun.id,
  });
  
  // 3. Suspend the parent
  await transition(parentRunId, 'SUSPENDED');
  
  // 4. Save parent's state (what step it's on, what it's waiting for)
  // This is the "poor man's checkpoint" — logical state, not process memory
  await saveExecutionState(parentRunId, {
    waitpointId: waitpoint.id,
    resumeStep: 'after-child-task',
  });
  
  // 5. Queue the child
  await enqueue(childRun.id, childRun.queueId);
}
```

**6.2 — Waitpoint resolution**

When a child run completes, resolve its parent's waitpoint:

```typescript
// Called when any run completes
async function onRunComplete(runId: string, output: any) {
  // Check if any waitpoints reference this run
  const waiting = await db.select().from(waitpoints)
    .where(
      and(
        eq(waitpoints.childRunId, runId),
        eq(waitpoints.resolved, false),
      )
    );
  
  for (const wp of waiting) {
    // Resolve the waitpoint
    await db.update(waitpoints).set({
      resolved: true,
      resolvedAt: new Date(),
      result: output,
    });
    
    // Resume the parent run
    await transition(wp.runId, 'EXECUTING');
    await enqueue(wp.runId, /* queue */);
    // When the parent resumes, it loads the waitpoint result and continues
  }
}
```

**6.3 — Duration waits**

```typescript
// wait.for({ seconds: 30 })
async function waitFor(runId: string, duration: { seconds: number }) {
  const resumeAt = new Date(Date.now() + duration.seconds * 1000);
  
  await db.insert(waitpoints).values({
    type: 'DURATION',
    runId,
    resumeAfter: resumeAt,
  });
  
  await transition(runId, 'SUSPENDED');
  
  // A scheduler checks for elapsed duration waitpoints every second
  // When resumeAfter <= now, it resolves the waitpoint and re-queues the run
}
```

**6.4 — Token waits (human-in-the-loop)**

```typescript
// In task: const token = await ctx.waitForToken({ timeout: '1h' });
// External: POST /api/waitpoints/:token/complete { result: "approved" }

app.post('/api/waitpoints/:token/complete', async (c) => {
  const { token } = c.req.param();
  const body = await c.req.json();
  
  const wp = await db.select().from(waitpoints)
    .where(eq(waitpoints.token, token));
  
  if (!wp || wp.resolved) return c.json({ error: 'Invalid token' }, 404);
  
  await db.update(waitpoints).set({
    resolved: true,
    result: body.result,
  });
  
  // Resume the run
  await transition(wp.runId, 'EXECUTING');
  await enqueue(wp.runId, /* queue */);
  
  return c.json({ ok: true });
});
```

### Phase 6 deliverable:
Tasks can trigger child tasks and wait for results. Duration waits pause execution efficiently. External tokens enable human-in-the-loop workflows. When a wait resolves, the parent automatically resumes.

---

## How Resumption Works (Without CRIU)

Since you're not using CRIU, you need a different approach to "resume from where you left off." The pattern is **step-based execution with cached results**:

```typescript
// The task runner wraps your run function
async function executeWithResumption(run: Run, taskFn: Function) {
  // Load any previously completed steps from Postgres
  const completedSteps = await loadCompletedSteps(run.id);
  
  // Create a context that intercepts waitpoint calls
  const ctx = {
    triggerAndWait: async (taskId, payload) => {
      const stepKey = `triggerAndWait:${taskId}:${JSON.stringify(payload)}`;
      
      // If this step was already completed (from a previous execution), return cached result
      if (completedSteps[stepKey]) {
        return completedSteps[stepKey].result;
      }
      
      // Otherwise, actually create child task and suspend
      // This throws a special "SuspendExecution" error that stops the function
      throw new SuspendExecution(stepKey, taskId, payload);
    },
    
    waitFor: async (duration) => {
      const stepKey = `wait:${JSON.stringify(duration)}`;
      if (completedSteps[stepKey]) return; // Already waited
      throw new SuspendExecution(stepKey, 'DURATION', duration);
    },
  };
  
  try {
    const result = await taskFn(run.payload, ctx);
    return result;
  } catch (e) {
    if (e instanceof SuspendExecution) {
      // Handle suspension — create waitpoint, save state
      await handleSuspension(run, e);
      return; // Don't mark as completed
    }
    throw e; // Real error — let retry logic handle it
  }
}
```

This is exactly how Trigger.dev v2 worked before they added CRIU. The function gets replayed from the beginning, but completed steps return instantly from cache. The user's code doesn't know it was replayed — it just sees `await ctx.triggerAndWait()` resolve immediately with the cached result.

---

## What You'll Have at the End

A working distributed task queue that:

1. Accepts task triggers via HTTP API
2. Queues them in Redis with fair multi-tenant scheduling
3. Workers pull work with concurrency limits enforced
4. Runs go through a proper state machine with every transition recorded
5. Failed tasks retry with exponential backoff + jitter
6. Idempotency keys prevent duplicate runs
7. Distributed locks prevent race conditions
8. Heartbeat monitoring detects stuck workers
9. Tasks can trigger child tasks and wait for results
10. Duration waits and external tokens enable pause/resume
11. OpenTelemetry traces give full observability
12. A dashboard shows everything in real-time

This is a system you can show anyone and they'll understand immediately that you know distributed systems deeply — not because you called the right APIs, but because you built the infrastructure itself.