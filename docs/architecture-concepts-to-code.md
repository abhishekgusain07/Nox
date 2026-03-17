# reload.dev Architecture: Concepts to Code

A complete mapping of every distributed systems concept in the reload.dev codebase to its actual implementation. Every code snippet below is copied from real source files, not pseudocode.

---

## 1. Branded Types for Entity Safety

### Pattern: Compile-Time ID Confusion Prevention

**What it is**: Zod schemas with TypeScript brand types that make string IDs for different entities (runs, tasks, queues) incompatible at the type level, even though they are all strings at runtime.

**The problem it solves**: In a distributed task queue, you pass IDs between dozens of functions. A `runId` and a `taskId` are both strings. Without branded types, nothing stops you from accidentally passing a task ID where a run ID is expected. The bug silently propagates until it hits the database and returns no rows, or worse, returns the wrong row.

**Where it lives in our code**: `packages/core/src/ids.ts`

**How the code works**:

```typescript
// packages/core/src/ids.ts
import { z } from "zod";

export const RunId = z.string().uuid().brand<"RunId">();
export type RunId = z.infer<typeof RunId>;

export const TaskId = z.string().min(1).max(255).brand<"TaskId">();
export type TaskId = z.infer<typeof TaskId>;

export const QueueId = z.string().min(1).max(255).brand<"QueueId">();
export type QueueId = z.infer<typeof QueueId>;

export const WorkerId = z.string().min(1).brand<"WorkerId">();
export type WorkerId = z.infer<typeof WorkerId>;

export const IdempotencyKey = z.string().min(1).max(512).brand<"IdempotencyKey">();
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;

export const ConcurrencyKey = z.string().min(1).max(255).brand<"ConcurrencyKey">();
export type ConcurrencyKey = z.infer<typeof ConcurrencyKey>;
```

Each line does two things simultaneously. The `z.string().uuid()` part creates a Zod validator that checks at runtime whether the string is a valid UUID (for `RunId`) or a non-empty string within a length range (for `TaskId`, `QueueId`). The `.brand<"RunId">()` part adds a phantom type -- a compile-time marker that TypeScript tracks but JavaScript ignores. The result is that `RunId` and `TaskId` are both `string` at runtime, but TypeScript treats them as distinct, incompatible types.

The dual `export` pattern (`export const RunId` and `export type RunId`) puts both the runtime validator and the TypeScript type into the same namespace. Consumers import `RunId` and get both: the Zod schema for parsing (`RunId.parse(rawString)`) and the type for annotations (`function getRun(id: RunId)`).

**The data flow**: A raw string enters the system (from an HTTP request, a database row, or a UUID generator). It passes through `RunId.parse(raw)`, which validates it at runtime (is it a valid UUID?) and brands it at compile time (it is now typed as `RunId`, not `string`). From that point forward, TypeScript enforces that this value can only be used where a `RunId` is expected.

**How it could be improved**: Production systems like Trigger.dev add prefix-based IDs (e.g., `run_abc123`, `task_xyz789`) so you can tell the entity type from the string itself, even in log files or database queries. The current implementation uses raw UUIDs for runs, which are opaque. Adding prefixes would give you both compile-time safety (brands) and runtime visibility (prefixes).

---

## 2. Discriminated Unions for Domain Modeling

### Pattern: Exhaustive Type-Safe Domain Modeling

**What it is**: TypeScript union types where each variant has a literal tag field (`_tag` or `tag`), enabling exhaustive `switch` statements that the compiler enforces.

**The problem it solves**: Domain events, errors, and side effects in a task queue have many variants -- a run can be queued, started, completed, failed, retried, suspended, cancelled, or expired. If you model these as a generic object with optional fields, every consumer has to guess which fields are present. Discriminated unions make the variants explicit and force every handler to cover all cases.

**Where it lives in our code**:
- `packages/core/src/types.ts` -- `SideEffect`, `RunEvent`, `TransitionError`
- `packages/core/src/states.ts` -- `RunStatus`, `FailureType`
- `packages/core/src/errors.ts` -- `DomainError`

**How the code works**:

The `SideEffect` type from `types.ts` represents actions the state machine needs the imperative shell to execute:

```typescript
// packages/core/src/types.ts
export type SideEffect =
  | { readonly _tag: "EnqueueRun"; readonly runId: string; readonly queueId: string; readonly priority: number }
  | { readonly _tag: "EmitEvent"; readonly event: RunEvent }
  | { readonly _tag: "StartHeartbeat"; readonly runId: string; readonly workerId: string }
  | { readonly _tag: "CancelHeartbeat"; readonly runId: string }
  | { readonly _tag: "ReleaseConcurrency"; readonly runId: string; readonly queueId: string }
  | { readonly _tag: "NotifyParent"; readonly parentRunId: string; readonly childOutput: unknown };
```

Each variant carries exactly the data it needs and nothing more. An `EnqueueRun` effect needs a `runId`, `queueId`, and `priority`. A `CancelHeartbeat` needs only a `runId`. The `_tag` field is a string literal type, so TypeScript narrows the full union down to one specific variant inside a `switch` case.

The `RunEvent` union captures every observable thing that happens to a run:

```typescript
export type RunEvent =
  | { readonly _tag: "RunQueued"; readonly runId: string; readonly queueId: string }
  | { readonly _tag: "RunStarted"; readonly runId: string }
  | { readonly _tag: "RunCompleted"; readonly runId: string; readonly output: unknown }
  | { readonly _tag: "RunFailed"; readonly runId: string; readonly error: unknown; readonly failureType: string }
  | { readonly _tag: "RunRetrying"; readonly runId: string; readonly attempt: number; readonly delayMs: number }
  | { readonly _tag: "RunSuspended"; readonly runId: string; readonly waitpointId: string }
  | { readonly _tag: "RunCancelled"; readonly runId: string; readonly reason: string }
  | { readonly _tag: "RunExpired"; readonly runId: string };
```

The `DomainError` type in `errors.ts` uses `tag` instead of `_tag` (a minor inconsistency) but follows the same pattern:

```typescript
// packages/core/src/errors.ts
export type DomainError =
  | { readonly tag: "TaskNotFound"; readonly taskId: string }
  | { readonly tag: "QueueNotFound"; readonly queueId: string }
  | { readonly tag: "RunNotFound"; readonly runId: string }
  | { readonly tag: "QueuePaused"; readonly queueId: string }
  | { readonly tag: "InvalidTransition"; readonly from: string; readonly to: string }
  | { readonly tag: "DuplicateIdempotencyKey"; readonly key: string }
  | { readonly tag: "StaleVersion"; readonly runId: string; readonly expected: number; readonly actual: number }
  | { readonly tag: "ValidationError"; readonly message: string };
```

It also provides factory functions for ergonomic construction:

```typescript
export const domainError = {
  taskNotFound: (taskId: string): DomainError => ({ tag: "TaskNotFound", taskId }),
  runNotFound: (runId: string): DomainError => ({ tag: "RunNotFound", runId }),
  staleVersion: (runId: string, expected: number, actual: number): DomainError =>
    ({ tag: "StaleVersion", runId, expected, actual }),
  // ...
};
```

The exhaustive switch pattern appears in `state-machine.ts` (line 186):

```typescript
default: {
  const _exhaustive: never = to;
  return err({ _tag: "InvalidTransition" as const, from: run.status, to: _exhaustive });
}
```

If you add a new `RunStatus` but forget to add a `case` for it, TypeScript will error on the `const _exhaustive: never = to` line because the new status will not be assignable to `never`.

**How it could be improved**: The inconsistency between `_tag` (in `types.ts`) and `tag` (in `errors.ts`) should be unified. Production systems also typically define a centralized `match` function that takes a union and a record of handlers, making the exhaustive pattern even more ergonomic: `match(event, { RunQueued: (e) => ..., RunStarted: (e) => ... })`.

---

## 3. Hand-Rolled Result Type

### Pattern: Typed Error Handling Without Exceptions

**What it is**: A simple algebraic data type `Result<T, E>` that represents either a successful value `T` or an error `E`, replacing `try/catch` for domain logic.

**The problem it solves**: In JavaScript/TypeScript, `throw` and `catch` are untyped. A function signature `getUser(id: string): User` tells you nothing about what errors it can throw. The `Result` type makes errors part of the return type, forcing callers to handle them explicitly.

**Where it lives in our code**: `packages/core/src/result.ts`

**How the code works**:

```typescript
// packages/core/src/result.ts
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(result: Result<T, E>): result is { ok: true; value: T } =>
  result.ok;

export const isErr = <T, E>(result: Result<T, E>): result is { ok: false; error: E } =>
  !result.ok;

export const mapResult = <T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> => (result.ok ? ok(fn(result.value)) : result);

export const flatMapResult = <T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> => (result.ok ? fn(result.value) : result);
```

The `ok()` and `err()` constructors use `never` in their return types for maximum inference. When you write `ok(42)`, TypeScript infers `Result<number, never>`. When you write `err({ _tag: "NotFound" })`, TypeScript infers `Result<never, { _tag: "NotFound" }>`. The `never` disappears when combined in a union, giving you clean composite types.

`mapResult` transforms the success value without touching errors -- it is the functor map. `flatMapResult` allows chaining operations that themselves return `Result` -- it is the monadic bind.

The design choice to use `ok: boolean` as the discriminant instead of `_tag: "ok" | "err"` is pragmatic: `if (result.ok)` reads naturally and TypeScript narrows the type correctly via the `is` type guard.

**The data flow**: The state machine's `computeTransition` returns `Result<TransitionResult, TransitionError>`. The run engine checks `if (!result.ok) return result;` and short-circuits on errors. On success, it destructures `const { run: newRun, effects } = result.value;` and proceeds. Callers in the HTTP routes then pattern-match on the error variants:

```typescript
// packages/server/src/routes/index.ts
if (!result.ok) {
  if (result.error._tag === "RunNotFound") return c.json({ error: `Run not found: ${runId}` }, 404);
  if (result.error._tag === "InvalidTransition") return c.json({ error: `Cannot complete run in ${result.error.from} state` }, 409);
  if (result.error._tag === "VersionConflict") return c.json({ error: "Version conflict -- retry" }, 409);
  return c.json({ error: result.error }, 500);
}
```

**How it could be improved**: The current `Result` type lacks `tryCatch` (wrapping throwing functions), `fromNullable` (converting null-returning functions), and `traverse` (applying Result-returning functions to arrays). These are common in production FP libraries like fp-ts or Effect. For this codebase's scale, the 23-line implementation is sufficient.

---

## 4. PostgreSQL as Queue (SKIP LOCKED)

### Pattern: Database-as-Queue with Row-Level Locking

**What it is**: Using PostgreSQL's `FOR UPDATE SKIP LOCKED` clause to turn the `runs` table into an atomic work queue where workers can safely claim items without coordination.

**The problem it solves**: In a naive approach, two workers could `SELECT` the same run, both think they "got" it, and both execute it -- violating exactly-once semantics. `SKIP LOCKED` makes rows that are already being processed invisible to other transactions, turning the database into a lock-free queue.

**Where it lives in our code**:
- Schema: `packages/server/src/db/schema.ts` (the `runs` table)
- Queue logic: `packages/server/src/queue/pg-queue.ts`

**How the code works**:

The `runs` table serves triple duty: it is the primary data store, the state machine record, and the queue itself. The relevant columns for queuing:

```typescript
// packages/server/src/db/schema.ts
export const runs = pgTable("runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id),
  queueId: text("queue_id").notNull().references(() => queues.id),
  status: runStatusEnum("status").notNull().default("PENDING"),
  priority: integer("priority").default(0).notNull(),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  version: integer("version").default(1).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  dequeuedAt: timestamp("dequeued_at", { withTimezone: true }),
  // ...
}, (table) => ({
  queueStatusIdx: index("idx_runs_queue_status").on(table.queueId, table.status),
  // ...
}));
```

The composite index `(queueId, status)` is critical -- it makes the dequeue query fast because PostgreSQL can use the index to find QUEUED runs in a specific queue without scanning the entire table.

The dequeue operation is a single atomic SQL statement:

```typescript
// packages/server/src/queue/pg-queue.ts
export function createPgQueue(db: Database): PgQueue {
  return {
    async enqueue(runId: string): Promise<void> {
      await db.execute(sql`
        UPDATE runs
        SET status = 'QUEUED', version = version + 1
        WHERE id = ${runId}
      `);
    },

    async dequeue(queueId: string, limit: number = 1): Promise<any[]> {
      const result = await db.execute(sql`
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
            priority DESC,
            created_at ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `);
      return result;
    },
  };
}
```

The dequeue query is a nested `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`. Here is what happens step by step:

1. The inner `SELECT` finds runs where `queue_id` matches, `status` is `QUEUED`, and the `scheduled_for` time (if any) has passed.
2. `ORDER BY priority DESC, created_at ASC` ensures high-priority runs go first, and within the same priority, the oldest run goes first (FIFO).
3. `FOR UPDATE` places a row-level lock on the selected rows. No other transaction can modify them.
4. `SKIP LOCKED` is the key: if a row is already locked by another transaction (another worker dequeuing at the same time), it is silently skipped instead of blocking. The worker sees only unlocked rows.
5. The outer `UPDATE` atomically changes the status to `EXECUTING`, sets timestamps, and increments the version.
6. `RETURNING *` sends the full row back to the caller.

**What happens on crash**: If the worker crashes mid-transaction before committing, PostgreSQL automatically rolls back. The row locks are released, the status stays `QUEUED`, and the run becomes visible to other workers on the next dequeue. This gives you crash-safe exactly-once delivery with zero external coordination.

**The data flow**: A client calls `POST /api/trigger`, which creates a run with `PENDING` status, then calls `pgQueue.enqueue(run.id)` which UPDATEs the status to `QUEUED`. A worker calls `POST /api/dequeue`, which calls `pgQueue.dequeue(queueId, limit)` which atomically finds and claims runs.

**How it could be improved**: PG SKIP LOCKED creates contention at scale -- every dequeue touches the same table and the same index. When you have thousands of runs per second, the queue becomes the bottleneck. This is why Phase 3 adds Redis sorted sets as the primary queue. Production systems like Trigger.dev use Redis for the hot path (enqueue/dequeue) and PostgreSQL only for durable state storage. The current PG queue is also missing visibility timeout -- if a worker crashes after the transaction commits but before completing the run, the run is stuck in `EXECUTING` forever. The heartbeat monitor (Concept 12) addresses this.

---

## 5. The State Machine (Functional Core)

### Pattern: Pure State Transitions with Side Effects as Data

**What it is**: A pure function that takes a run, a target status, and context, and returns either a new run state plus a list of side effects, or a typed error. No I/O, no database, no mutation.

**The problem it solves**: State transitions in a task queue are complex -- completing a child run triggers parent notification, failing a run with retries left triggers backoff calculation, and every transition must record events and manage concurrency. If these actions are mixed with I/O (database writes, Redis calls), the logic becomes untestable and the error handling becomes a tangled mess. Separating pure computation from I/O execution makes the state machine trivially testable.

**Where it lives in our code**:
- Transition map: `packages/core/src/states.ts`
- Pure transition function: `packages/engine/src/state-machine.ts`

**How the code works**:

The transition map defines which state transitions are legal:

```typescript
// packages/core/src/states.ts
export const TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  PENDING:   ["QUEUED", "DELAYED", "CANCELLED"],
  QUEUED:    ["EXECUTING", "EXPIRED", "CANCELLED"],
  DELAYED:   ["QUEUED", "CANCELLED"],
  EXECUTING: ["COMPLETED", "FAILED", "DELAYED", "SUSPENDED", "CANCELLED"],
  SUSPENDED: ["QUEUED", "CANCELLED"],
  COMPLETED: [],
  FAILED:    [],
  CANCELLED: [],
  EXPIRED:   [],
} as const;

export const canTransition = (from: RunStatus, to: RunStatus): boolean =>
  (TRANSITIONS[from] as readonly string[]).includes(to);
```

Terminal states (`COMPLETED`, `FAILED`, `CANCELLED`, `EXPIRED`) have empty arrays -- nothing can leave them. The `EXECUTING` state has the most outgoing edges -- it can complete, fail, be delayed for retry, be suspended for a waitpoint, or be cancelled.

The `computeTransition` function in `state-machine.ts` is the core of the entire engine:

```typescript
// packages/engine/src/state-machine.ts
export function computeTransition(
  run: Readonly<Run>,
  to: RunStatus,
  context: TransitionContext,
): Result<TransitionResult, TransitionError> {
  if (!canTransition(run.status, to)) {
    return err({
      _tag: "InvalidTransition" as const,
      from: run.status,
      to,
    });
  }

  switch (to) {
    // ... each case computes new run state + side effects
  }
}
```

Walk through a specific transition -- `EXECUTING -> DELAYED` (retry with backoff):

```typescript
case "DELAYED": {
  const newRun: Run = {
    ...run,
    status: "DELAYED",
    version: run.version + 1,
    scheduledFor: context.scheduledFor ?? null,
    attemptNumber: context.nextAttempt ?? run.attemptNumber,
  };
  const effects: SideEffect[] = [
    { _tag: "CancelHeartbeat" as const, runId: run.id },
    { _tag: "ReleaseConcurrency" as const, runId: run.id, queueId: run.queueId },
    { _tag: "EmitEvent" as const, event: {
      _tag: "RunRetrying" as const,
      runId: run.id,
      attempt: newRun.attemptNumber,
      delayMs: context.scheduledFor
        ? context.scheduledFor.getTime() - context.now.getTime()
        : 0,
    }},
  ];
  return ok({ run: newRun, effects });
}
```

When a run fails but has retries remaining, the engine transitions it to `DELAYED`. The pure function:
1. Creates a new run object via spread (immutable update) with status `DELAYED`, incremented version, the `scheduledFor` backoff time, and the incremented `attemptNumber`.
2. Emits three side effects: cancel the heartbeat (the worker is no longer executing), release the concurrency slot (so other runs can use it), and emit a `RunRetrying` event with the delay.
3. Returns these as pure data. The caller decides when and how to execute them.

The key insight: `CancelHeartbeat` and `ReleaseConcurrency` are not function calls -- they are data structures. The state machine says "this needs to happen" without doing it.

**How it could be improved**: The current implementation uses a large `switch` statement. Production state machines often use a table-driven approach where each transition is an entry in a configuration object, making it easier to add new transitions without modifying a monolithic function. The state machine could also validate invariants more strictly -- for example, transitioning to `EXECUTING` without a `workerId` in the context should be an error, but currently it silently falls through to `run.workerId`.

---

## 6. The Run Engine (Imperative Shell)

### Pattern: Orchestrating Pure Logic with I/O

**What it is**: The `createRunEngine` function wraps the pure state machine with database reads, optimistic locking writes, event recording, PG NOTIFY, and side effect execution. It is the imperative shell that coordinates the functional core.

**The problem it solves**: The state machine computes what should happen, but something has to actually do it -- read the current run from the database, write the new state back, record the transition event, notify SSE listeners, and execute side effects like enqueuing runs or releasing concurrency slots.

**Where it lives in our code**: `packages/engine/src/run-engine.ts`

**How the code works**:

The engine follows a strict 5-step protocol for every transition:

```typescript
// packages/engine/src/run-engine.ts
export function createRunEngine(deps: RunEngineDeps) {
  const { db, schema, pgQueue, redisQueue, concurrency } = deps;

  async function transition(
    runId: string,
    to: RunStatus,
    context: TransitionContext,
  ): Promise<Result<Run, TransitionError>> {
```

**Step 1 -- Load current run from database**:

```typescript
    const rows = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
    const currentRun = rows[0];
    if (!currentRun) {
      return err({ _tag: "RunNotFound" as const, runId });
    }
```

**Step 2 -- Compute transition (pure, no I/O)**:

```typescript
    const result = computeTransition(run, to, context);
    if (!result.ok) return result;
    const { run: newRun, effects } = result.value;
```

**Step 3 -- Write with optimistic locking (CAS)**:

```typescript
    const updated = await db
      .update(schema.runs)
      .set({
        status: newRun.status,
        output: newRun.output,
        error: newRun.error,
        // ...all fields...
        version: sql`version + 1`,
      })
      .where(
        and(
          eq(schema.runs.id, runId),
          eq(schema.runs.version, run.version), // CAS: only if version unchanged
        ),
      )
      .returning();

    if (updated.length === 0) {
      return err({
        _tag: "VersionConflict" as const,
        expected: run.version,
        actual: -1,
      });
    }
```

The `WHERE version = $expected` clause is a Compare-And-Swap (CAS) operation. If another process modified the run between our read (Step 1) and our write (Step 3), the version will have changed and the `UPDATE` will match zero rows. This prevents lost updates without pessimistic locks.

**Step 4 -- Record event in append-only log + PG NOTIFY**:

```typescript
    await db.insert(schema.runEvents).values({
      runId,
      eventType: `run.${to.toLowerCase()}`,
      fromStatus: run.status,
      toStatus: to,
      reason: context.reason ?? null,
      attempt: newRun.attemptNumber,
      data: {
        ...(context.error ? { error: context.error } : {}),
        ...(context.output !== undefined ? { output: context.output } : {}),
        ...(context.failureType ? { failureType: context.failureType } : {}),
        ...(context.workerId ? { workerId: context.workerId } : {}),
        ...(context.scheduledFor ? { scheduledFor: context.scheduledFor.toISOString() } : {}),
      },
    });

    // Notify SSE listeners
    await db.execute(sql`NOTIFY run_updates, ${JSON.stringify({
      runId,
      fromStatus: run.status,
      toStatus: to,
      queueId: run.queueId,
      taskId: run.taskId,
      timestamp: new Date().toISOString(),
    })}`);
```

**Step 5 -- Execute side effects**:

```typescript
    for (const effect of effects) {
      await executeSideEffect(effect, run);
    }
```

The `executeSideEffect` function dispatches on the `_tag` discriminant:

```typescript
  async function executeSideEffect(effect: SideEffect, run: Run): Promise<void> {
    switch (effect._tag) {
      case "EnqueueRun":
        await pgQueue.enqueue(effect.runId);
        if (redisQueue) {
          await redisQueue.enqueue(effect.runId, effect.queueId, effect.priority);
        }
        break;
      case "ReleaseConcurrency":
        if (concurrency) {
          await concurrency.releaseAll(effect.queueId, run.concurrencyKey ?? null, effect.runId);
        }
        break;
      // ... other cases
    }
  }
```

**How it could be improved**: Steps 3 and 4 should be in a database transaction. Currently, if the event insert fails after the status update succeeds, you have an inconsistent state: the run changed status but the event was not recorded. Production systems wrap read-compute-write-record in a single transaction. The side effect execution in Step 5 also lacks error handling -- if enqueuing to Redis fails, the run's status is already updated to QUEUED in PostgreSQL, but the Redis queue does not contain it.

---

## 7. Exponential Backoff with Jitter

### Pattern: Preventing Thundering Herd on Retries

**What it is**: A pure function that computes how long to wait before retrying a failed task, using exponential growth clamped to a maximum and randomized by +-25% jitter.

**The problem it solves**: When a service goes down and hundreds of tasks fail simultaneously, they should not all retry at the exact same moment -- that would overwhelm the service again (thundering herd). Exponential backoff spaces retries further apart with each attempt. Jitter randomizes the exact timing so retries are spread over a window rather than spiking at one instant.

**Where it lives in our code**: `packages/engine/src/retry/retry.ts`

**How the code works**:

```typescript
// packages/engine/src/retry/retry.ts
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  minTimeout: 1000,    // 1 second
  maxTimeout: 60000,   // 60 seconds
  factor: 2,           // doubling
};

export function computeBackoffMs(attempt: number, config: RetryConfig): number {
  const exponential = config.minTimeout * Math.pow(config.factor, attempt);
  const clamped = Math.min(exponential, config.maxTimeout);
  const jitter = clamped * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}
```

For the default config, the progression is:
- Attempt 0: `1000 * 2^0 = 1000ms`, with jitter: 750-1250ms
- Attempt 1: `1000 * 2^1 = 2000ms`, with jitter: 1500-2500ms
- Attempt 2: `1000 * 2^2 = 4000ms`, with jitter: 3000-5000ms
- Attempt 3: `1000 * 2^3 = 8000ms`, with jitter: 6000-10000ms
- Attempt 10: `min(1000 * 2^10, 60000) = 60000ms`, with jitter: 45000-75000ms

The `shouldRetry` function determines whether a failure is worth retrying:

```typescript
export function shouldRetry(
  attemptNumber: number,
  maxAttempts: number,
  failureType: FailureType,
): boolean {
  if (failureType === "SYSTEM_ERROR" || failureType === "TIMEOUT") {
    return attemptNumber < maxAttempts + 2; // extra attempts for system errors
  }
  return attemptNumber < maxAttempts;
}
```

`SYSTEM_ERROR` and `TIMEOUT` get two extra attempts beyond the configured `maxAttempts`. The rationale: these failures are not the user's code's fault -- they are infrastructure problems (OOM, network partition, worker crash). The system gives them a longer leash.

**The data flow**: When a worker reports a failure via `POST /api/runs/:id/fail`, the route handler calls `shouldRetry()`. If true, it computes the backoff with `computeBackoffMs()`, creates a `scheduledFor` timestamp, and transitions the run to `DELAYED` via the engine. The delayed scheduler (Concept 8) later promotes it back to `QUEUED`.

**How it could be improved**: The jitter uses `Math.random()`, which makes the function impure (not deterministic). For testing, a seedable PRNG or jitter passed as a parameter would be better. Production systems also implement "decorrelated jitter" (AWS-style), where the jitter range depends on the previous delay rather than the current one, which distributes retries more evenly.

---

## 8. The Delayed Run Scheduler

### Pattern: Time-Based State Promotion via Polling

**What it is**: A background process that periodically checks for runs in the `DELAYED` state whose `scheduledFor` time has passed, and promotes them to `QUEUED`.

**The problem it solves**: When a run is delayed (either for retry backoff or a future-scheduled execution), something needs to "wake it up" at the right time. The scheduler is that alarm clock.

**Where it lives in our code**: `packages/engine/src/scheduler.ts`

**How the code works**:

```typescript
// packages/engine/src/scheduler.ts
export function createDelayedScheduler(deps: {
  db: any;
  schema: any;
  engine: RunEngine;
  pollIntervalMs?: number;
}) {
  const { db, schema, engine, pollIntervalMs = 1000 } = deps;
  let running = false;

  async function tick(): Promise<number> {
    const now = new Date();
    const readyRuns = await db
      .select()
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.status, "DELAYED"),
          lte(schema.runs.scheduledFor, now),
        ),
      )
      .limit(100);

    let promoted = 0;
    for (const run of readyRuns) {
      const result = await engine.transition(run.id, "QUEUED", {
        now,
        reason: "Scheduled time reached",
      });
      if (result.ok) promoted++;
    }
    return promoted;
  }

  async function start(): Promise<void> {
    running = true;
    while (running) {
      try {
        const promoted = await tick();
        if (promoted > 0) {
          console.log(`[scheduler] Promoted ${promoted} delayed runs to QUEUED`);
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[scheduler] Error:", message);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  function stop(): void {
    running = false;
  }

  return { start, stop, tick };
}
```

The `tick()` function queries for `DELAYED` runs where `scheduledFor <= NOW()`, limited to 100 at a time to prevent overloading. For each one, it calls `engine.transition(run.id, "QUEUED", ...)`.

The CAS-based version check in the engine prevents double promotion: if two scheduler instances (in a multi-server deployment) both find the same delayed run, only the first one to write will succeed. The second will get a `VersionConflict` error, which is silently ignored (`if (result.ok) promoted++`).

The polling interval defaults to 1 second. This means a delayed run might wait up to 1 second longer than its `scheduledFor` time before being promoted. This is acceptable for retry backoff (where the delay is seconds to minutes) but might be too coarse for sub-second scheduling.

**How it could be improved**: Polling is inherently wasteful -- the scheduler checks every second even when there are no delayed runs. Production systems use PostgreSQL's `pg_notify` on a trigger that fires when a DELAYED run is inserted, or Redis sorted sets with blocking pop, or a dedicated timer wheel data structure. The `.limit(100)` also creates a potential issue where more than 100 runs become ready at the same instant and the scheduler falls behind.

---

## 9. Redis Sorted Set Queue with Priority

### Pattern: O(log N) Priority Queue with Atomic Dequeue

**What it is**: A Redis sorted set (ZSET) where the score encodes both priority and FIFO ordering, with `ZPOPMIN` for atomic dequeue.

**The problem it solves**: PostgreSQL's `SKIP LOCKED` works but creates lock contention at scale. Redis sorted sets provide O(log N) insertion and O(log N) dequeue with no lock contention because Redis is single-threaded (all operations are serialized).

**Where it lives in our code**: `packages/engine/src/queue/redis-queue.ts`

**How the code works**:

```typescript
// packages/engine/src/queue/redis-queue.ts
const MAX_PRIORITY = 100;

export function createRedisQueue(redis: Redis): RedisQueue {
  return {
    async enqueue(runId: string, queueId: string, priority: number = 0): Promise<void> {
      const score = (MAX_PRIORITY - priority) * 1e13 + Date.now();
      await redis.zadd(`queue:${queueId}`, score, runId);
      await redis.sadd("active-queues", queueId);
    },

    async dequeue(queueId: string, limit: number = 1): Promise<string[]> {
      const results: string[] = [];
      for (let i = 0; i < limit; i++) {
        const item = await redis.zpopmin(`queue:${queueId}`);
        if (!item || item.length === 0) break;
        results.push(item[0]!);
      }
      return results;
    },
    // ...
  };
}
```

The score formula is `(MAX_PRIORITY - priority) * 1e13 + Date.now()`.

Here is why it works. Redis sorted sets are ordered by score ascending, and `ZPOPMIN` returns the lowest score. We want high-priority items dequeued first, so we invert the priority: `MAX_PRIORITY - priority` makes priority 100 have score component 0 (lowest, dequeued first) and priority 0 have score component 100 (highest, dequeued last).

The `* 1e13` creates non-overlapping priority bands. `Date.now()` returns a number like `1710000000000` (13 digits). By multiplying the priority component by `1e13`, we ensure that priority 99's band (score range `1e13` to `2e13 - 1`) never overlaps with priority 100's band (score range `0` to `1e13 - 1`). Within each priority band, `+ Date.now()` gives FIFO ordering -- earlier timestamps get dequeued first.

`ZPOPMIN` is atomic -- it removes and returns the lowest-scored member in a single operation. There is no gap between "read" and "remove" where another consumer could steal the item.

The `active-queues` set tracks which queue IDs have items, used by the fair dequeue algorithm (Concept 11) to know which queues to cycle through.

**How it could be improved**: The current `dequeue` uses a loop calling `ZPOPMIN` once per iteration. This creates N round trips for `limit = N`. A Lua script could atomically pop N items in a single call. Also, `ZPOPMIN` does not have a "re-enqueue on failure" mechanism -- if the worker crashes after dequeuing but before completing, the item is lost from Redis. The system relies on the PostgreSQL state (the run stays in QUEUED status in PG) and the scheduler/heartbeat to recover, but this creates a window of potential duplicate processing.

---

## 10. Atomic Concurrency Control (Lua Scripts)

### Pattern: TOCTOU-Safe Resource Limiting with Redis Lua

**What it is**: A Redis Lua script that atomically checks the current concurrency count and increments it only if under the limit, preventing the Time-of-Check-Time-of-Use (TOCTOU) race condition.

**The problem it solves**: If you check concurrency (`ZCARD`) and then acquire a slot (`ZADD`) in two separate commands, another worker could acquire a slot between your check and your add, exceeding the limit. Lua scripts execute atomically in Redis -- no other commands can run between the ZCARD and the ZADD.

**Where it lives in our code**: `packages/engine/src/queue/concurrency.ts`

**How the code works**:

```typescript
// packages/engine/src/queue/concurrency.ts
const ACQUIRE_SCRIPT = `
  local key = KEYS[1]
  local limit = tonumber(ARGV[1])
  local runId = ARGV[2]
  local now = tonumber(ARGV[3])

  local count = redis.call('ZCARD', key)
  if count >= limit then
    return 0
  end

  redis.call('ZADD', key, now, runId)
  return 1
`;
```

Line by line:
1. `local key = KEYS[1]` -- the Redis key for this concurrency tracker, e.g., `concurrency:queue:default`.
2. `local limit = tonumber(ARGV[1])` -- the maximum concurrent runs allowed (e.g., 10).
3. `local runId = ARGV[2]` -- the ID of the run trying to acquire a slot.
4. `local now = tonumber(ARGV[3])` -- current timestamp, used as the score in the sorted set.
5. `redis.call('ZCARD', key)` -- count the current number of active slots (members in the ZSET).
6. `if count >= limit then return 0` -- reject if at capacity. Returns 0 to the caller.
7. `redis.call('ZADD', key, now, runId)` -- add the run to the ZSET with the current timestamp as score.
8. `return 1` -- success. The slot was acquired.

Because this is a Lua script, steps 5-7 execute atomically. No other Redis client can interleave commands between the ZCARD and the ZADD.

The tracker supports two levels of concurrency:

```typescript
export function createConcurrencyTracker(redis: Redis): ConcurrencyTracker {
  return {
    async acquire(queueId: string, runId: string, limit: number): Promise<boolean> {
      return acquireSlot(`concurrency:queue:${queueId}`, limit, runId);
    },

    async acquireWithKey(
      queueId: string, concurrencyKey: string, runId: string, keyLimit: number,
    ): Promise<boolean> {
      return acquireSlot(`concurrency:key:${queueId}:${concurrencyKey}`, keyLimit, runId);
    },

    async releaseAll(queueId: string, concurrencyKey: string | null, runId: string): Promise<void> {
      await redis.zrem(`concurrency:queue:${queueId}`, runId);
      if (concurrencyKey) {
        await redis.zrem(`concurrency:key:${queueId}:${concurrencyKey}`, runId);
      }
    },
    // ...
  };
}
```

**Queue-level concurrency** (`concurrency:queue:{queueId}`) limits how many runs from a queue can execute simultaneously. **Key-level concurrency** (`concurrency:key:{queueId}:{concurrencyKey}`) limits how many runs with the same concurrency key can execute simultaneously. For example, you might allow 10 concurrent email-sending tasks overall, but only 1 per recipient (to avoid sending duplicate emails).

Using sorted sets (not just sets) enables timestamp-based cleanup: if a worker dies without releasing its slot, the timestamp score lets you find and remove stale entries.

**How it could be improved**: The two-level concurrency check is not atomic across levels -- a run could acquire the queue-level slot but fail the key-level check, leaving a dangling queue-level slot. Production systems like Trigger.dev use a single Lua script that checks all concurrency levels atomically and rolls back if any level fails. The current implementation also lacks a TTL on concurrency slots -- if a worker crashes and the heartbeat monitor does not release the slot, it stays occupied forever.

---

## 11. Fair Dequeuing (Round-Robin)

### Pattern: Preventing Queue Starvation via Round-Robin

**What it is**: A dequeue algorithm that cycles through all active queues, taking one item from each in round-robin fashion, so no single busy queue can starve others.

**The problem it solves**: If you simply dequeue from the first queue with items, a queue with 10,000 pending items will monopolize the worker while other queues with 1 item each never get served. Fair dequeuing guarantees that every queue gets a turn.

**Where it lives in our code**: `packages/engine/src/queue/fair-dequeue.ts`

**How the code works**:

```typescript
// packages/engine/src/queue/fair-dequeue.ts
export async function fairDequeue(
  deps: FairDequeueDeps,
  maxRuns: number,
): Promise<DequeuedRun[]> {
  const { redisQueue, concurrency, getQueueLimit, isQueuePaused } = deps;

  const activeQueues = await redisQueue.getActiveQueues();
  if (activeQueues.length === 0) return [];

  const dequeued: DequeuedRun[] = [];
  const skippedQueues = new Set<string>();

  let passes = 0;
  while (dequeued.length < maxRuns && passes < 5) {
    let madeProgress = false;

    for (const queueId of activeQueues) {
      if (dequeued.length >= maxRuns) break;
      if (skippedQueues.has(queueId)) continue;

      const paused = await isQueuePaused(queueId);
      if (paused) {
        skippedQueues.add(queueId);
        continue;
      }

      const runIds = await redisQueue.dequeue(queueId, 1);
      if (runIds.length === 0) {
        skippedQueues.add(queueId);
        continue;
      }

      const runId = runIds[0]!;

      const limit = await getQueueLimit(queueId);
      const acquired = await concurrency.acquire(queueId, runId, limit);
      if (!acquired) {
        await redisQueue.enqueue(runId, queueId, 0);
        skippedQueues.add(queueId);
        continue;
      }

      dequeued.push({ runId, queueId });
      madeProgress = true;
    }

    if (!madeProgress) break;
    passes++;
  }

  return dequeued;
}
```

The algorithm:
1. Get all active queues from Redis (the `active-queues` set).
2. Iterate through queues in order, taking one run from each.
3. Skip paused queues and queues that are empty or at concurrency capacity.
4. When a queue is at capacity: the run was already popped from Redis, so re-enqueue it with `redisQueue.enqueue(runId, queueId, 0)`. Mark the queue as skipped so we do not try it again this cycle.
5. Repeat for up to 5 passes. Multiple passes allow a queue to contribute more than one run if other queues are exhausted.
6. Stop when `maxRuns` items are dequeued or no more progress can be made.

**How it could be improved**: The round-robin approach treats all queues equally. Production systems implement weighted fair queuing where queues can have different weights (e.g., "premium" queues get 3x the throughput of "free" queues). The re-enqueue on concurrency failure (`redisQueue.enqueue(runId, queueId, 0)`) uses priority 0, which may change the run's position in the queue. It should preserve the original priority.

---

## 12. Heartbeat Monitoring (Dead Worker Detection)

### Pattern: Lease-Based Failure Detection

**What it is**: A system where executing runs have a deadline timestamp that the worker must periodically extend. If the deadline passes without extension, the run is assumed dead and recovered.

**The problem it solves**: When a worker crashes mid-execution, the run is stuck in `EXECUTING` forever -- no one will complete or fail it. Heartbeats implement a lease: "I am alive and working on this run. If you do not hear from me in 30 seconds, assume I am dead."

**Where it lives in our code**:
- Heartbeat deadline field: `packages/server/src/db/schema.ts` (on the `runs` table)
- Worker sends heartbeats: `packages/worker/src/index.ts`
- Server extends deadline: `packages/server/src/routes/index.ts`
- Monitor detects stale runs: `packages/engine/src/heartbeat/heartbeat.ts`

**How the code works**:

When a run transitions to `EXECUTING`, the engine sets the heartbeat deadline to 30 seconds from now:

```typescript
// packages/engine/src/run-engine.ts (inside Step 3)
heartbeatDeadline: to === "EXECUTING"
  ? new Date(context.now.getTime() + 30_000)
  : newRun.heartbeatDeadline,
```

The worker sends heartbeats every 10 seconds during execution:

```typescript
// packages/worker/src/index.ts
const heartbeatTimer = setInterval(async () => {
  try {
    await fetch(`${SERVER_URL}/api/runs/${run.id}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerId: WORKER_ID }),
    });
  } catch {
    // Heartbeat failure is not fatal
  }
}, HEARTBEAT_INTERVAL); // 10 seconds
```

The server endpoint extends the deadline by another 30 seconds:

```typescript
// packages/server/src/routes/index.ts
api.post("/runs/:id/heartbeat", async (c) => {
  const runId = c.req.param("id");
  const updated = await db.update(schema.runs)
    .set({
      heartbeatDeadline: new Date(Date.now() + 30_000),
    })
    .where(and(
      eq(schema.runs.id, runId),
      eq(schema.runs.status, "EXECUTING"),
    ))
    .returning();

  if (updated.length === 0) {
    return c.json({ ok: false, error: "Run not found or not executing" }, 404);
  }
  return c.json({ ok: true });
});
```

The heartbeat monitor polls every 15 seconds for stale runs:

```typescript
// packages/engine/src/heartbeat/heartbeat.ts
async function tick(): Promise<number> {
  const now = new Date();
  const staleRuns = await db.select()
    .from(schema.runs)
    .where(and(
      eq(schema.runs.status, "EXECUTING"),
      isNotNull(schema.runs.heartbeatDeadline),
      lt(schema.runs.heartbeatDeadline, now),
    ))
    .limit(50);

  let recovered = 0;
  for (const run of staleRuns) {
    const failureType: FailureType = "TIMEOUT";
    const canRetry = shouldRetry(run.attemptNumber, run.maxAttempts, failureType);

    if (canRetry) {
      const delayMs = computeBackoffMs(run.attemptNumber, DEFAULT_RETRY_CONFIG);
      const scheduledFor = new Date(Date.now() + delayMs);
      const result = await engine.transition(run.id, "DELAYED", {
        now,
        scheduledFor,
        nextAttempt: run.attemptNumber + 1,
        error: { message: "Worker heartbeat timeout" },
        failureType,
        reason: `Heartbeat timeout. Retry attempt ${run.attemptNumber + 1} after ${delayMs}ms`,
      });
      if (result.ok) recovered++;
    } else {
      await engine.transition(run.id, "FAILED", {
        now,
        error: { message: "Worker heartbeat timeout" },
        failureType,
        reason: `Heartbeat timeout. Max attempts (${run.maxAttempts}) exhausted.`,
      });
      recovered++;
    }
  }
  return recovered;
}
```

The timing budget: heartbeats every 10s, deadline is 30s from last heartbeat, monitor checks every 15s. A worker can miss up to 2 heartbeats (20s) before the deadline passes. The monitor will detect the stale run within 15s after the deadline, so worst case a dead worker's run is recovered within ~45 seconds.

**How it could be improved**: The 10s/30s/15s intervals are hardcoded. They should be configurable per task or queue. The heartbeat endpoint does not validate that the `workerId` sending the heartbeat matches the worker that dequeued the run -- any worker could extend any run's heartbeat. Production systems use a heartbeat token issued at dequeue time.

---

## 13. TTL Expiry

### Pattern: Automatic Cleanup of Stale Queued Runs

**What it is**: A background process that expires runs that have been sitting in the `QUEUED` state longer than their TTL (time-to-live) allows.

**The problem it solves**: If a user triggers a run that must be processed within 60 seconds (e.g., a real-time notification), and it sits in the queue for 5 minutes because all workers are busy, executing it is pointless. The TTL ensures stale runs are expired rather than executed after their window has passed.

**Where it lives in our code**: `packages/engine/src/ttl/ttl-checker.ts`

**How the code works**:

```typescript
// packages/engine/src/ttl/ttl-checker.ts
async function tick(): Promise<number> {
  const now = new Date();

  const expired = await db.execute(sql`
    SELECT * FROM runs
    WHERE status = 'QUEUED'
      AND ttl IS NOT NULL
      AND created_at + ttl * interval '1 second' < ${now}
    LIMIT 50
  `);

  let expiredCount = 0;
  const rows = expired.rows ?? expired;
  for (const run of rows) {
    const result = await engine.transition(run.id, "EXPIRED", {
      now,
      reason: `TTL of ${run.ttl}s exceeded`,
    });
    if (result.ok) expiredCount++;
  }

  return expiredCount;
}
```

The SQL `created_at + ttl * interval '1 second' < NOW()` uses PostgreSQL's interval arithmetic. If a run was created at 12:00:00 with a TTL of 60 seconds, it expires at 12:01:00. Any time after that, the condition is true.

The TTL checker runs every 5 seconds (configurable) and processes up to 50 expired runs per tick. The transition `QUEUED -> EXPIRED` is validated by the state machine (it is in the `TRANSITIONS` map) and recorded in the event log.

**How it could be improved**: The TTL check only applies to `QUEUED` runs. A run that has been `EXECUTING` for longer than expected is not covered by TTL -- that is the heartbeat monitor's job. Production systems might also want TTL on `DELAYED` runs (e.g., a retry that would fire after the TTL window has passed).

---

## 14. Graceful Shutdown

### Pattern: Drain-Then-Exit Worker Lifecycle

**What it is**: Signal handlers (SIGTERM/SIGINT) that stop accepting new work, wait for active runs to complete, deregister the worker, and exit cleanly.

**The problem it solves**: During deployments, workers are restarted. If a worker is killed mid-execution, the run is orphaned in `EXECUTING` state until the heartbeat monitor recovers it. Graceful shutdown lets active runs finish before the worker exits, avoiding unnecessary retries.

**Where it lives in our code**: `packages/worker/src/index.ts`

**How the code works**:

```typescript
// packages/worker/src/index.ts
let activeRunCount = 0;
let shouldStop = false;

function setupGracefulShutdown(): void {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shouldStop = true;
    console.log(`[worker] Received ${signal}. Draining ${activeRunCount} active runs...`);

    const timeout = 30_000;
    const started = Date.now();

    while (activeRunCount > 0) {
      if (Date.now() - started > timeout) {
        console.log("[worker] Shutdown timeout. Forcing exit.");
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // Deregister from server
    try {
      await fetch(`${SERVER_URL}/api/workers/${WORKER_ID}/deregister`, { method: "POST" });
    } catch { /* best effort */ }

    console.log("[worker] Drained. Exiting cleanly.");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
```

The sequence:
1. Signal received (SIGTERM from Kubernetes, SIGINT from Ctrl+C).
2. Set `shouldStop = true`. The dequeue loop checks this flag and stops pulling new work.
3. Poll `activeRunCount` every 500ms. Each running task decrements this when it finishes.
4. If all runs complete within 30 seconds, deregister the worker with the server and exit 0.
5. If the 30-second timeout is exceeded, force-exit with code 1. The orphaned runs will be recovered by the heartbeat monitor.

The `activeRunCount` is tracked in the `executeRun` function:

```typescript
async function executeRun(run: any): Promise<void> {
  activeRunCount++;
  // ... execute the task ...
  finally {
    clearInterval(heartbeatTimer);
    activeRunCount--;
  }
}
```

The dequeue loop respects the flag:

```typescript
async function dequeueLoop(): Promise<void> {
  while (!shouldStop) {
    // ... poll for work ...
  }
  console.log("[worker] Dequeue loop stopped.");
}
```

**How it could be improved**: The 30-second timeout is hardcoded. Long-running tasks (e.g., video processing) might need minutes to drain. This should be configurable via environment variable or task-level configuration. The deregister call is fire-and-forget -- if it fails, the server still thinks the worker is online. A server-side timeout that marks workers offline after missing N heartbeats would be more robust.

---

## 15. Worker Registration

### Pattern: Server-Side Worker Discovery

**What it is**: Workers register themselves with the server on startup, reporting which task types they handle, and deregister on shutdown. The server tracks worker status.

**The problem it solves**: The server needs to know which workers are available and what they can handle. Without registration, the server has no visibility into the worker fleet -- it cannot show worker status in the dashboard or route tasks to appropriate workers.

**Where it lives in our code**:
- Schema: `packages/server/src/db/schema.ts` (`workers` table)
- Registration: `packages/server/src/routes/index.ts`
- Worker startup: `packages/worker/src/index.ts`

**How the code works**:

The `workers` table:

```typescript
// packages/server/src/db/schema.ts
export const workers = pgTable("workers", {
  id: text("id").primaryKey(),
  taskTypes: jsonb("task_types").$type<string[]>().notNull(),
  queueId: text("queue_id").references(() => queues.id),
  concurrency: integer("concurrency").default(5).notNull(),
  status: text("status").notNull().default("online"),
  lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }).defaultNow().notNull(),
  registeredAt: timestamp("registered_at", { withTimezone: true }).defaultNow().notNull(),
});
```

The worker generates a unique ID on startup and registers with the server:

```typescript
// packages/worker/src/index.ts
const WORKER_ID = process.env.RELOAD_WORKER_ID ?? `worker-${randomUUID().slice(0, 8)}`;

async function registerTasksWithServer(): Promise<void> {
  await client.createQueue(QUEUE_ID).catch(() => {});
  for (const taskId of taskRegistry.keys()) {
    await client.registerTask(taskId, QUEUE_ID).catch(() => {});
  }
  const taskTypes = [...taskRegistry.keys()];
  await fetch(`${SERVER_URL}/api/workers/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workerId: WORKER_ID, taskTypes, queueId: QUEUE_ID }),
  }).catch(() => {});
}
```

The server's registration endpoint uses `onConflictDoUpdate` to handle re-registration (worker restart):

```typescript
// packages/server/src/routes/index.ts
api.post("/workers/register", async (c) => {
  await db.insert(schema.workers)
    .values({
      id: workerId,
      taskTypes,
      queueId: queueId ?? "default",
      concurrency: concurrency ?? 5,
      status: "online",
      lastHeartbeat: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.workers.id,
      set: {
        taskTypes,
        status: "online",
        lastHeartbeat: new Date(),
      },
    });
  return c.json({ ok: true, workerId });
});
```

**How it could be improved**: Currently the worker registration is informational only -- it does not affect task routing. The dequeue endpoint does not filter by worker capabilities. In a production system, the server would only assign a run to a worker that has the matching task type registered. The worker heartbeat is also separate from the run heartbeat -- they serve different purposes but could be combined.

---

## 16. SSE (Server-Sent Events) with PG LISTEN/NOTIFY

### Pattern: Real-Time Push via Database Change Notifications

**What it is**: PostgreSQL's `LISTEN/NOTIFY` mechanism piped through Server-Sent Events (SSE) to push state changes to the dashboard in real time.

**The problem it solves**: The dashboard needs to show run status changes as they happen, without polling. PG `NOTIFY` is triggered after every state transition, and SSE is a simple, one-way streaming protocol that works natively with browsers.

**Where it lives in our code**:
- NOTIFY: `packages/engine/src/run-engine.ts` (Step 4b)
- LISTEN + SSE: `packages/server/src/routes/stream.ts`

**How the code works**:

After every state transition, the run engine sends a PG NOTIFY:

```typescript
// packages/engine/src/run-engine.ts
await db.execute(sql`NOTIFY run_updates, ${JSON.stringify({
  runId,
  fromStatus: run.status,
  toStatus: to,
  queueId: run.queueId,
  taskId: run.taskId,
  timestamp: new Date().toISOString(),
})}`);
```

The SSE routes create a dedicated PostgreSQL connection (cannot use pooled connections for LISTEN) and subscribe to the `run_updates` channel:

```typescript
// packages/server/src/routes/stream.ts
api.get("/runs/:id/stream", async (c) => {
  const runId = c.req.param("id");

  return streamSSE(c, async (stream) => {
    const listener = postgres(connectionString, { max: 1 });

    try {
      // Send current state immediately
      await stream.writeSSE({
        data: JSON.stringify({ type: "snapshot", runId }),
        event: "state",
        id: "0",
      });

      // Subscribe to updates
      await listener.listen("run_updates", (payload: string) => {
        try {
          const data = JSON.parse(payload) as { runId?: string; timestamp?: string };
          if (data.runId === runId) {
            stream.writeSSE({
              data: payload,
              event: "update",
              id: data.timestamp,
            }).catch(() => {});
          }
        } catch {}
      });

      // Keep alive until client disconnects
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
    } finally {
      await listener.end();
    }
  });
});
```

There are three SSE endpoints:
1. `/api/runs/:id/stream` -- stream updates for a specific run (filtered by `runId`).
2. `/api/stream` -- stream all updates (global dashboard feed).
3. `/api/queues/:id/stream` -- stream updates for a specific queue (filtered by `queueId`).

Each SSE connection creates its own PostgreSQL connection for LISTEN. This is necessary because PG's LISTEN/NOTIFY is connection-scoped -- you cannot share a pooled connection. The connection is cleaned up when the client disconnects (`stream.onAbort`).

**How it could be improved**: Each SSE client creates a dedicated PG connection, which does not scale. With 100 dashboard tabs open, that is 100 PG connections just for LISTEN. Production systems use a single LISTEN connection that fans out to all SSE clients via an in-memory pub/sub, or use Redis pub/sub instead of PG NOTIFY. The `NOTIFY` payload is also limited to 8000 bytes in PostgreSQL, which means large payloads must be truncated or the SSE client must fetch the full data via a separate REST call.

---

## 17. Step-Based Replay (Resumption)

### Pattern: Deterministic Replay via Cached Step Results

**What it is**: When a suspended run is resumed, the task function is re-executed from the beginning, but previously completed steps return their cached results instead of re-executing. The function runs until it hits the next uncached step, which triggers a new suspension.

**The problem it solves**: Long-running tasks that need to wait for external events (child tasks, durations, human approval) cannot keep a process alive for hours or days. Step-based replay lets you "checkpoint" at each step, suspend the process, and resume later by replaying the cached checkpoints and continuing from where you left off.

**Where it lives in our code**: `packages/engine/src/resumption/step-runner.ts`

**How the code works**:

The `SuspendExecution` class is a sentinel -- it is thrown to interrupt the task function:

```typescript
// packages/engine/src/resumption/step-runner.ts
export class SuspendExecution {
  constructor(
    public readonly stepIndex: number,
    public readonly stepKey: string,
    public readonly waitpointType: string,
    public readonly waitpointData: unknown,
  ) {}
}
```

The `executeWithResumption` function provides a `StepContext` to the task function. Each context method (like `triggerAndWait`) checks for a cached result before executing:

```typescript
export async function executeWithResumption(
  run: { id: string; payload: unknown },
  taskFn: (payload: unknown, ctx: StepContext) => Promise<unknown>,
  completedSteps: CompletedStep[],
): Promise<{ output: unknown } | { suspended: true; suspension: SuspendExecution }> {
  let currentStepIndex = 0;

  const ctx: StepContext = {
    triggerAndWait: async (taskId: string, payload: unknown) => {
      const myIndex = currentStepIndex++;
      const expectedKey = `triggerAndWait:${taskId}`;

      const cached = completedSteps.find((s) => s.stepIndex === myIndex);
      if (cached) {
        if (cached.stepKey !== expectedKey) {
          throw new Error(
            `Non-determinism detected at step ${myIndex}: ` +
            `expected "${cached.stepKey}", got "${expectedKey}". ` +
            `The task function must be deterministic during replay.`
          );
        }
        return cached.result;
      }

      throw new SuspendExecution(myIndex, expectedKey, "CHILD_RUN", { taskId, payload });
    },

    waitFor: async (duration: { seconds: number }) => {
      const myIndex = currentStepIndex++;
      const expectedKey = `wait:${duration.seconds}s`;

      const cached = completedSteps.find((s) => s.stepIndex === myIndex);
      if (cached) {
        if (cached.stepKey !== expectedKey) {
          throw new Error(`Non-determinism detected at step ${myIndex}`);
        }
        return;
      }

      throw new SuspendExecution(myIndex, expectedKey, "DURATION", duration);
    },
    // ... waitForToken, batchTriggerAndWait follow the same pattern
  };

  try {
    const output = await taskFn(run.payload, ctx);
    return { output };
  } catch (e) {
    if (e instanceof SuspendExecution) {
      return { suspended: true, suspension: e };
    }
    throw e;
  }
}
```

The non-determinism detection is critical: when replaying, if step 0 was previously `triggerAndWait:send-email` but is now `triggerAndWait:process-data`, the task function's control flow has changed between executions. This is a bug in the task code, and the error message tells the developer exactly what happened.

**Concrete example**: Consider a task that sends an email, waits 60 seconds, then sends a follow-up:

```
Step 0: ctx.triggerAndWait("send-email", { to: "user@example.com" })
Step 1: ctx.waitFor({ seconds: 60 })
Step 2: ctx.triggerAndWait("send-followup", { to: "user@example.com" })
```

First execution: Step 0 has no cache, throws `SuspendExecution`. Run is suspended, child "send-email" run is created.

After send-email completes: Step 0 result is cached. Task replays: step 0 returns cached result instantly. Step 1 has no cache, throws `SuspendExecution`. Duration waitpoint created.

After 60 seconds: Steps 0 and 1 are cached. Task replays: step 0 cached, step 1 cached. Step 2 has no cache, throws `SuspendExecution`. Child "send-followup" run is created.

After send-followup completes: All steps cached. Task replays: step 0 cached, step 1 cached, step 2 cached. `taskFn` returns normally. Run is completed.

**How it could be improved**: Re-executing the entire function from the beginning on every resume is wasteful for tasks with many steps. Production systems like Temporal use a more sophisticated replay mechanism that skips non-step code entirely. The current implementation also requires strict determinism -- the same `if/else` branches must be taken on every replay. Any use of `Math.random()`, `Date.now()`, or non-deterministic API calls outside of step methods will cause unpredictable behavior.

---

## 18. Waitpoints (Suspension Primitive)

### Pattern: Typed Suspension Conditions with Multi-Path Resolution

**What it is**: A database-backed record that represents a condition a suspended run is waiting for. When the condition is met, the waitpoint is resolved, the step result is cached, and the parent run is re-queued.

**The problem it solves**: A task might need to wait for a child task to finish, a timer to elapse, an external system to provide data, or a batch of children to all complete. Waitpoints unify these four patterns into a single abstraction.

**Where it lives in our code**:
- Schema: `packages/server/src/db/schema.ts` (`waitpoints` table)
- Resolution logic: `packages/engine/src/waitpoints/waitpoints.ts`
- Duration scheduling: `packages/engine/src/waitpoints/duration-scheduler.ts`

**How the code works**:

The `waitpoints` table stores all four types of wait conditions:

```typescript
// packages/server/src/db/schema.ts
export const waitpoints = pgTable("waitpoints", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: text("type").notNull(),         // 'CHILD_RUN' | 'DURATION' | 'TOKEN' | 'DATETIME' | 'BATCH'
  runId: uuid("run_id").notNull().references(() => runs.id),
  resolved: boolean("resolved").default(false).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  result: jsonb("result"),

  resumeAfter: timestamp("resume_after", { withTimezone: true }),  // DURATION
  childRunId: uuid("child_run_id").references(() => runs.id),      // CHILD_RUN
  token: text("token"),                                             // TOKEN
  expiresAt: timestamp("expires_at", { withTimezone: true }),       // TOKEN expiry
  batchTotal: integer("batch_total"),                               // BATCH
  batchResolved: integer("batch_resolved").default(0),              // BATCH progress

  stepIndex: integer("step_index"),                                 // Which step in the parent
  stepKey: text("step_key"),                                        // For non-determinism detection
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

The `createWaitpointResolver` provides four resolution methods. Here is `resolveChildRun` -- the most illustrative:

```typescript
// packages/engine/src/waitpoints/waitpoints.ts
async resolveChildRun(childRunId: string, output: unknown): Promise<void> {
  // Find unresolved waitpoint for this child
  const waitpointRows = await db
    .select()
    .from(schema.waitpoints)
    .where(
      and(
        eq(schema.waitpoints.childRunId, childRunId),
        eq(schema.waitpoints.resolved, false),
      ),
    )
    .limit(1);

  const wp = waitpointRows[0];
  if (!wp) return;

  // Mark waitpoint resolved
  await db
    .update(schema.waitpoints)
    .set({ resolved: true, resolvedAt: new Date(), result: output })
    .where(eq(schema.waitpoints.id, wp.id));

  // Cache the step result in run_steps
  await db.insert(schema.runSteps).values({
    runId: wp.runId,
    stepIndex: wp.stepIndex,
    stepKey: wp.stepKey ?? "triggerAndWait:child",
    result: output,
  });

  // Resume parent: SUSPENDED -> QUEUED
  await engine.transition(wp.runId as string, "QUEUED", {
    now: new Date(),
    reason: `Child run ${childRunId} completed`,
  });
}
```

The flow for a child run waitpoint:
1. Child run completes -> `POST /api/runs/:id/complete` is called.
2. Route handler calls `waitpointResolver.resolveChildRun(runId, output)`.
3. Resolver finds the unresolved waitpoint linked to this child run.
4. Marks the waitpoint as resolved, stores the child's output.
5. Caches the step result in `run_steps` so the replay mechanism can find it.
6. Transitions the parent from `SUSPENDED -> QUEUED` via the engine.
7. Parent is picked up by a worker, replayed, step returns cached result, execution continues.

For batch waitpoints, the flow is more complex -- each child completion increments `batchResolved`, and only when `batchResolved >= batchTotal` does the parent resume:

```typescript
async resolveBatchChild(childRunId: string, output: unknown): Promise<void> {
  // ... find matching BATCH waitpoint ...

  const updated = await db
    .update(schema.waitpoints)
    .set({ batchResolved: sql`batch_resolved + 1` })
    .where(eq(schema.waitpoints.id, wp.id))
    .returning();

  const batchResolved = updatedWp.batchResolved as number;
  const batchTotal = (updatedWp.batchTotal as number | null) ?? 0;

  if (batchResolved >= batchTotal) {
    // Collect all child outputs
    const childResultRows = await db
      .select({ id: schema.runs.id, output: schema.runs.output })
      .from(schema.runs)
      .where(eq(schema.runs.parentRunId, wp.runId as string));

    const results = childResultRows.map((r) => r.output);

    // Resolve waitpoint and resume parent
    // ...
  }
}
```

The `createDurationScheduler` handles DURATION waitpoints similarly to the delayed run scheduler:

```typescript
// packages/engine/src/waitpoints/duration-scheduler.ts
async function tick(): Promise<number> {
  const readyWaitpoints = await db
    .select()
    .from(schema.waitpoints)
    .where(
      and(
        eq(schema.waitpoints.type, "DURATION"),
        eq(schema.waitpoints.resolved, false),
        lte(schema.waitpoints.resumeAfter, now),
      ),
    )
    .limit(100);

  for (const wp of readyWaitpoints) {
    await resolver.resolveDurationWait(wp.id as string);
  }
}
```

**How it could be improved**: The waitpoint resolution is not idempotent -- if `resolveChildRun` is called twice (due to a crash after updating the waitpoint but before transitioning the parent), it will insert a duplicate `run_steps` row. The `run_steps` unique index on `(runId, stepIndex)` will catch this, but the error is not gracefully handled. Production systems use transactional resolution that marks the waitpoint, caches the step, and transitions the parent all in one database transaction.

---

## 19. The Append-Only Event Log

### Pattern: Immutable Audit Trail of State Transitions

**What it is**: Every state transition is recorded as a row in the `run_events` table, creating a complete, append-only history of what happened to each run and why.

**The problem it solves**: When debugging why a run failed on attempt 5, you need to see every transition: when it was queued, when it started, what error it threw, how long the backoff was, when it was re-queued. The event log captures this timeline.

**Where it lives in our code**:
- Schema: `packages/server/src/db/schema.ts` (`runEvents` table)
- Event recording: `packages/engine/src/run-engine.ts` (Step 4)

**How the code works**:

The `runEvents` table:

```typescript
// packages/server/src/db/schema.ts
export const runEvents = pgTable("run_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id),
  eventType: text("event_type").notNull(),
  fromStatus: runStatusEnum("from_status"),
  toStatus: runStatusEnum("to_status").notNull(),
  workerId: text("worker_id"),
  attempt: integer("attempt"),
  reason: text("reason"),
  data: jsonb("data"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  runIdIdx: index("idx_run_events_run_id").on(table.runId),
  eventTypeIdx: index("idx_run_events_event_type").on(table.eventType),
  createdAtIdx: index("idx_run_events_created_at").on(table.createdAt),
}));
```

Events are recorded in the run engine after the status update succeeds:

```typescript
// packages/engine/src/run-engine.ts
await db.insert(schema.runEvents).values({
  runId,
  eventType: `run.${to.toLowerCase()}`,
  fromStatus: run.status,
  toStatus: to,
  reason: context.reason ?? null,
  attempt: newRun.attemptNumber,
  data: {
    ...(context.error ? { error: context.error } : {}),
    ...(context.output !== undefined ? { output: context.output } : {}),
    ...(context.failureType ? { failureType: context.failureType } : {}),
    ...(context.workerId ? { workerId: context.workerId } : {}),
    ...(context.scheduledFor ? { scheduledFor: context.scheduledFor.toISOString() } : {}),
  },
});
```

The `eventType` follows a `run.{status}` convention: `run.queued`, `run.executing`, `run.completed`, `run.delayed`, etc. The `data` field is a JSONB column that stores event-specific details -- error messages for failures, output for completions, scheduledFor timestamps for delays.

The events are queryable via the REST API:

```typescript
// packages/server/src/routes/index.ts
api.get("/runs/:id/events", async (c) => {
  const runId = c.req.param("id");
  const events = await db
    .select()
    .from(schema.runEvents)
    .where(eq(schema.runEvents.runId, runId))
    .orderBy(schema.runEvents.createdAt);
  return c.json({ events });
});
```

**How it could be improved**: The event log is currently append-only with no retention policy. Over time, it will grow unbounded. Production systems implement TTL-based cleanup (delete events older than 30 days) or tiered storage (move old events to cold storage). The `data` field also stores error stacks as JSONB, which can be large and should be truncated or stored separately.

---

## 20. The Full Data Flow (End to End)

### Happy Path: Trigger to Completion

**Step 1: Client triggers a task**

The SDK calls `POST /api/trigger`:

```typescript
// packages/sdk/src/client.ts
async trigger(taskId: string, payload: unknown = {}, options?: TriggerOptions): Promise<TriggerResult> {
  const res = await fetch(`${this.baseUrl}/api/trigger`, {
    method: "POST",
    headers: this.headers,
    body: JSON.stringify({ taskId, payload, options }),
  });
  return res.json() as Promise<TriggerResult>;
}
```

**Step 2: Server creates the run**

The `/api/trigger` route validates the request via Zod, checks that the task exists, handles idempotency, and inserts a run with `PENDING` status:

```typescript
// packages/server/src/routes/index.ts
const insertResult = await db
  .insert(schema.runs)
  .values({
    taskId: body.taskId,
    queueId,
    status: isDelayed ? "DELAYED" : "PENDING",
    payload: body.payload ?? {},
    priority: body.options?.priority ?? 0,
    maxAttempts: body.options?.maxAttempts ?? 3,
    // ...
  })
  .returning();
```

**Step 3: Run is enqueued (PENDING -> QUEUED)**

Immediately after creation, `pgQueue.enqueue(run.id)` UPDATEs the status to `QUEUED` and increments the version.

**Step 4: Worker polls for work**

The worker's dequeue loop calls `POST /api/dequeue`:

```typescript
// packages/worker/src/index.ts
const res = await fetch(`${SERVER_URL}/api/dequeue`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ queueId: QUEUE_ID, limit: 1 }),
});
```

**Step 5: SKIP LOCKED claims the run (QUEUED -> EXECUTING)**

The PG queue's `dequeue` method atomically selects and updates the run using `FOR UPDATE SKIP LOCKED`, changing its status to `EXECUTING`.

**Step 6: Worker executes the task and sends heartbeats**

```typescript
// packages/worker/src/index.ts
const heartbeatTimer = setInterval(async () => {
  await fetch(`${SERVER_URL}/api/runs/${run.id}/heartbeat`, { method: "POST", ... });
}, HEARTBEAT_INTERVAL);

try {
  const output = await taskFn(run.payload);
  await client.completeRun(run.id, output);
} catch (error) {
  await client.failRun(run.id, { message: error.message, stack: error.stack }, failureType);
} finally {
  clearInterval(heartbeatTimer);
  activeRunCount--;
}
```

**Step 7: Task completes -> POST /api/runs/:id/complete**

**Step 8: Engine transitions EXECUTING -> COMPLETED**

The engine runs the 5-step protocol: load run, compute transition (pure), write with CAS, record event, execute side effects (cancel heartbeat, release concurrency, emit event, notify parent if child).

**Step 9: Event recorded, NOTIFY sent, SSE pushed**

The event log records `run.completed` with the output. PG NOTIFY pushes the change to any SSE listeners. The dashboard updates in real time.

### Retry Flow: Failure with Backoff

**Step 1: Task throws an error**

The worker catches the exception and calls `POST /api/runs/:id/fail` with the error details and failure type.

**Step 2: shouldRetry() checks**

```typescript
// packages/server/src/routes/index.ts
if (shouldRetry(run.attemptNumber, run.maxAttempts, failureType)) {
  const delayMs = computeBackoffMs(run.attemptNumber, retryConfig);
  const scheduledFor = new Date(Date.now() + delayMs);

  const result = await engine.transition(runId, "DELAYED", {
    now: new Date(),
    scheduledFor,
    nextAttempt: run.attemptNumber + 1,
    error: parsedError,
    failureType,
    reason: `Retry attempt ${run.attemptNumber + 1} after ${delayMs}ms`,
  });
}
```

**Step 3: Engine transitions EXECUTING -> DELAYED**

The state machine creates a new run object with status `DELAYED`, `scheduledFor` set to `now + backoff`, and `attemptNumber` incremented. Side effects cancel the heartbeat and release the concurrency slot.

**Step 4: Scheduler promotes DELAYED -> QUEUED**

The delayed scheduler's `tick()` finds the run when `scheduledFor <= NOW()` and transitions it to `QUEUED` via the engine.

**Step 5: Worker picks up the run again (attempt 2)**

The run is dequeued by a worker (possibly a different one). The `attemptNumber` is now 1, and the task function is re-executed.

### Child Task Flow: triggerAndWait

**Step 1: Parent task calls ctx.triggerAndWait("child-task", payload)**

Inside `executeWithResumption`, step 0 has no cached result. A `SuspendExecution` is thrown with `stepIndex: 0`, `stepKey: "triggerAndWait:child-task"`, `waitpointType: "CHILD_RUN"`.

**Step 2: Worker catches SuspendExecution**

The worker would call `POST /api/runs/:parentId/suspend` with the suspension details.

**Step 3: Server creates child run and waitpoint**

The `/api/runs/:id/suspend` route:
1. Transitions the parent to `SUSPENDED` via the engine.
2. Creates the child run with `parentRunId` pointing to the parent.
3. Creates a `CHILD_RUN` waitpoint linking the child to the parent, with the `stepIndex` and `stepKey`.
4. Enqueues the child run.

```typescript
// packages/server/src/routes/index.ts
const childInsert = await db.insert(schema.runs).values({
  taskId: childData.taskId,
  queueId: task.queueId,
  status: "PENDING" as const,
  payload: childData.payload ?? {},
  parentRunId: runId,
  // ...
}).returning();

waitpointValues.childRunId = childRun.id;
await pgQueue.enqueue(childRun.id);
```

**Step 4: Parent transitions EXECUTING -> SUSPENDED**

The engine cancels the parent's heartbeat, releases its concurrency slot, and records the suspension event.

**Step 5: Child executes normally**

A worker picks up the child run, executes it, and calls `POST /api/runs/:childId/complete`.

**Step 6: resolveChildRun is called**

The complete route calls `waitpointResolver.resolveChildRun(childRunId, output)`, which:
- Marks the waitpoint as resolved with the child's output.
- Caches the step result: `{ runId: parentId, stepIndex: 0, stepKey: "triggerAndWait:child-task", result: output }`.
- Transitions the parent from `SUSPENDED -> QUEUED`.

**Step 7: Parent replays**

A worker picks up the parent, loads the cached steps from `run_steps`, and calls `executeWithResumption`. Step 0 (`triggerAndWait`) finds its cached result and returns it immediately. The task function continues to step 1, which either completes or triggers another suspension.

---

## 21. How It Could Be Improved

### PostgreSQL Queue

- **Migrate fully to Redis as primary queue**: The PG SKIP LOCKED queue creates index contention under high load. Move the hot dequeue path entirely to Redis sorted sets, keeping PG only for durable state storage.
- **Add visibility timeout**: When a run is dequeued, set a timeout. If the worker does not acknowledge within the timeout, the run becomes visible again. Currently relies on heartbeat timeout, which has a longer detection window.
- **Batch dequeue with advisory locks**: Use PG advisory locks instead of `FOR UPDATE SKIP LOCKED` for less contention at high concurrency.

### State Machine

- **Table-driven transitions**: Replace the large `switch` statement with a configuration table where each transition specifies its target state, required context fields, and side effect generators. This makes adding new transitions declarative rather than procedural.
- **Transition middleware/hooks**: Allow task definitions to attach pre-transition and post-transition hooks (e.g., validate output schema before COMPLETED, send webhook after FAILED).

### Worker Architecture

- **Distributed workers with Socket.io**: Replace HTTP polling with persistent WebSocket connections. The server pushes work to connected workers rather than workers pulling. This reduces latency from 1-second poll intervals to sub-millisecond.
- **Worker process isolation**: Execute each task in a child process or Worker thread to prevent a crashing task from taking down the entire worker process.

### Resumption

- **CRIU-style checkpointing**: Instead of re-executing the function from scratch and replaying cached steps, checkpoint the actual V8 heap and restore it on resume. This eliminates the determinism requirement entirely. Would require custom Node.js builds or switching to Deno.
- **Persistent function stacks**: Similar to what Temporal does -- persist the call stack rather than replaying. Requires a custom runtime or compiler plugin.
- **Incremental replay**: Instead of replaying all N cached steps on the (N+1)th resume, store the execution state at the last suspension point and resume from there. This trades storage for execution time.

### Fair Queuing

- **Weighted fair queuing**: Assign weights to queues so premium queues get proportionally more throughput. Round-robin treats all queues equally regardless of their importance.
- **Deficit round-robin**: Track how much each queue has been under-served and compensate on subsequent rounds. This handles variable-size items better than simple round-robin.

### Redis Architecture

- **Multiple specialized Redis instances**: Use separate Redis instances for queuing, concurrency tracking, caching, and pub/sub. This isolates failure domains -- a Redis OOM in the caching layer does not affect the queue.
- **Redis Cluster for horizontal scaling**: The current single-Redis architecture is a single point of failure. Redis Cluster provides sharding and replication.

### Missing Features

- **Rate limiting**: Add a token bucket or sliding window rate limiter per queue. This prevents a burst of runs from overwhelming downstream services. The `queues` table already has a `rateLimit` field planned but not implemented.
- **Cron scheduling**: Add a cron parser and scheduler that creates runs on a schedule. The delayed scheduler already handles future-scheduled runs -- a cron scheduler would just create them periodically.
- **Authentication**: Add API key middleware. The SDK client already accepts an `apiKey` in its constructor and sends it as a Bearer token, but the server does not validate it.
- **Metrics and observability**: Add OpenTelemetry instrumentation with traces spanning from trigger to completion. Export metrics (queue depth, run duration, failure rate) to Prometheus. The tech stack includes OpenTelemetry but it is not yet integrated.
- **Idempotent side effect execution**: If a side effect (like enqueuing to Redis) fails after the PG status update succeeds, the system is inconsistent. Wrap all side effects in a transactional outbox pattern to guarantee at-least-once execution.
- **Dead letter queue**: When a run exhausts all retries and reaches FAILED, it disappears into the event log. A dead letter queue would collect these failures for manual inspection and replay.
- **Multi-tenancy**: Add org/env scoping so multiple users can share the same infrastructure without interfering with each other. This requires 4-level concurrency (org -> env -> queue -> key) instead of the current 2-level (queue -> key).

---

## Summary: How the Pieces Fit Together

The architecture follows the **Functional Core, Imperative Shell** pattern at every level:

1. **Core package** (`packages/core`): Zero I/O. Branded types, discriminated unions, Result type, state transition map, validation schemas. Pure data definitions.

2. **Engine package** (`packages/engine`): The state machine is a pure function (`computeTransition`). The run engine wraps it with database reads, CAS writes, event recording, and side effect execution. Background processes (scheduler, heartbeat monitor, TTL checker, duration scheduler) are polling loops that call the engine.

3. **Server package** (`packages/server`): HTTP routes that parse requests, call the engine, and return responses. SSE routes that bridge PG NOTIFY to browser EventSource. The Drizzle schema defines the PostgreSQL tables.

4. **Worker package** (`packages/worker`): A polling loop that dequeues runs, executes tasks, sends heartbeats, and reports completions/failures. Graceful shutdown drains active runs.

5. **SDK package** (`packages/sdk`): A thin HTTP client that wraps `fetch` calls to the server API. Task definition helpers.

Every concept in this document -- from branded types to fair dequeuing to step-based replay -- serves the same goal: reliable, observable, controllable execution of background tasks in a distributed system.
