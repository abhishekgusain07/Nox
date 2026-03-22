# reload.dev -- Gaps, Stubs, and Required Fixes

## Summary

**5 critical gaps**, **6 important gaps**, **4 nice-to-haves** found across the reload.dev codebase.

The most severe issue is that the worker (`packages/worker/src/index.ts`) calls task functions directly without the step runner, making the entire Phase 6 resumption mechanism (triggerAndWait, waitFor, waitForToken, batchTriggerAndWait) completely inoperative. Several side effects in the run engine are console.log stubs. The Redis fair-dequeue path is fully implemented but never called by the worker. No test files exist anywhere in the project source.

---

## Critical Gaps (Breaks Core Functionality)

### GAP-1: Worker Never Uses Step Runner

**Problem**: The worker in `packages/worker/src/index.ts` line 90 calls `taskFn(run.payload)` directly. It never uses `executeWithResumption()` from the step runner. This means:

- Tasks cannot use `ctx.triggerAndWait()`, `ctx.waitFor()`, `ctx.waitForToken()`, or `ctx.batchTriggerAndWait()`
- The entire Phase 6 resumption mechanism is disconnected from the worker
- `SuspendExecution` is never caught by the worker
- Completed steps are never loaded for replay on resumption

**Root cause**: Two disconnects:

1. The `task()` SDK function signature only accepts `payload` -- it has no `StepContext` parameter:

```typescript
// packages/sdk/src/task.ts lines 8-13
export interface TaskConfig<TPayload = unknown, TOutput = unknown> {
  id: string;
  queue?: string;
  retry?: RetryConfig;
  run: (payload: TPayload) => Promise<TOutput>;  // <-- no ctx parameter
}
```

2. The worker calls the task function without wrapping it:

```typescript
// packages/worker/src/index.ts lines 89-92
try {
    const output = await taskFn(run.payload);
    await client.completeRun(run.id, output);
    console.log(`[worker] Completed run ${run.id}`);
```

Meanwhile, the step runner (`packages/engine/src/resumption/step-runner.ts`) is fully implemented and exported from the engine package, but never imported or used by the worker:

```typescript
// packages/engine/src/resumption/step-runner.ts lines 24-28
export async function executeWithResumption(
  run: { id: string; payload: unknown },
  taskFn: (payload: unknown, ctx: StepContext) => Promise<unknown>,
  completedSteps: CompletedStep[],
): Promise<{ output: unknown } | { suspended: true; suspension: SuspendExecution }> {
```

**Fix required**:

1. Update `TaskConfig.run` signature to optionally accept a `StepContext`:
   ```typescript
   run: (payload: TPayload, ctx?: StepContext) => Promise<TOutput>;
   ```

2. Worker must import `executeWithResumption` and `SuspendExecution` from `@reload-dev/engine`

3. Worker must load cached steps from `GET /api/runs/:id/steps` before executing (endpoint already exists at `packages/server/src/routes/index.ts` lines 486-493)

4. Worker must wrap `taskFn` in `executeWithResumption`:
   ```typescript
   const stepsRes = await fetch(`${SERVER_URL}/api/runs/${run.id}/steps`);
   const { steps } = await stepsRes.json();
   const result = await executeWithResumption(run, taskFn, steps);
   ```

5. If result is `{ suspended: true }`, worker calls `client.suspendRun()` with the suspension data (method already exists on `ReloadClient` at `packages/sdk/src/client.ts` lines 201-212)

6. If result is `{ output }`, worker calls `client.completeRun()`

**Files to change**: `packages/sdk/src/task.ts`, `packages/worker/src/index.ts`

---

### GAP-2: NotifyParent Side Effect is Stubbed

**Problem**: `packages/engine/src/run-engine.ts` lines 206-208:

```typescript
case "NotifyParent":
  // Phase 6 will implement parent notification
  console.log(`[parent] Notify ${effect.parentRunId}`);
  break;
```

When a child run completes, the state machine correctly emits a `NotifyParent` side effect (see `packages/engine/src/state-machine.ts` lines 77-79):

```typescript
if (run.parentRunId) {
  effects.push({ _tag: "NotifyParent" as const, parentRunId: run.parentRunId, childOutput: context.output });
}
```

But the engine's executor just logs it. The parent is never notified through this path.

**Mitigation**: The server's complete handler (`packages/server/src/routes/index.ts` lines 229-238) already calls `waitpointResolver.resolveChildRun()` and `waitpointResolver.resolveBatchChild()` directly. So parent notification IS happening -- but through the route handler, not the engine's side effect system. This creates a subtle inconsistency: if a run is completed through any path other than the HTTP endpoint (e.g., a future internal completion), the parent would NOT be notified.

**Fix required**: Either:
- Wire the `NotifyParent` effect to call `waitpointResolver.resolveChildRun()` (requires adding `waitpointResolver` to `RunEngineDeps`), OR
- Remove the `NotifyParent` side effect from the state machine since resolution happens in the route handler

**Files to change**: `packages/engine/src/run-engine.ts`, optionally `packages/core/src/types.ts` and `packages/engine/src/state-machine.ts`

---

### GAP-3: EmitEvent Side Effect is Stubbed

**Problem**: `packages/engine/src/run-engine.ts` lines 187-189:

```typescript
case "EmitEvent":
  // For now, just log. Phase 5 will add SSE/event bus.
  console.log(`[event] ${effect.event._tag}`, effect.event);
  break;
```

Every state transition in the state machine emits an `EmitEvent` side effect (RunQueued, RunStarted, RunCompleted, RunFailed, RunRetrying, RunSuspended, RunCancelled, RunExpired). None of these are delivered to any subscriber.

Phase 5 added SSE via PG NOTIFY (which IS wired at `packages/engine/src/run-engine.ts` lines 128-140), but the EmitEvent side effect itself still just logs. There is no in-process event bus for future reactors (retry reactor, notification reactor, metrics).

**Impact**: Medium. PG NOTIFY handles SSE to the dashboard. But there is no typed in-process pub/sub for composing internal behavior.

**Fix required**:
1. Create `packages/core/src/event-bus.ts` with a typed event bus
2. Accept an optional `eventBus` in `RunEngineDeps`
3. `EmitEvent` side effect publishes to the event bus

**Files to change**: `packages/core/src/event-bus.ts` (new), `packages/engine/src/run-engine.ts`

---

### GAP-4: StartHeartbeat / CancelHeartbeat Side Effects are Stubbed

**Problem**: `packages/engine/src/run-engine.ts` lines 191-196:

```typescript
case "StartHeartbeat":
  // Phase 4 will implement heartbeat
  console.log(`[heartbeat] Start for run ${effect.runId}`);
  break;
case "CancelHeartbeat":
  console.log(`[heartbeat] Cancel for run ${effect.runId}`);
  break;
```

These do nothing. The state machine emits `StartHeartbeat` on every EXECUTING transition (`packages/engine/src/state-machine.ts` line 58) and `CancelHeartbeat` on every COMPLETED, FAILED, DELAYED, SUSPENDED, and CANCELLED transition. All are no-ops.

**Actual heartbeat mechanism**: The heartbeat works through a different path entirely:
- The worker manages its own heartbeat timer via `setInterval` (`packages/worker/src/index.ts` lines 77-87)
- The server receives heartbeats at `POST /api/runs/:id/heartbeat` and extends the deadline (`packages/server/src/routes/index.ts` lines 382-403)
- The heartbeat monitor polls for expired deadlines (`packages/engine/src/heartbeat/heartbeat.ts`)
- The heartbeat deadline IS set in the DB when transitioning to EXECUTING (`packages/engine/src/run-engine.ts` lines 83-85)

These side effects are vestigial -- they would be used in a push-based model where the server tells the worker to start/stop heartbeating. In the current pull-based model, the worker manages its own heartbeat timer.

**Fix required**: Remove `StartHeartbeat` and `CancelHeartbeat` from the `SideEffect` type and the state machine, since heartbeating is worker-initiated. Or document them as intentionally no-op.

**Files to change**: `packages/core/src/types.ts` (SideEffect union), `packages/engine/src/state-machine.ts`, `packages/engine/src/run-engine.ts`

---

### GAP-5: PG Dequeue Sets heartbeatDeadline to NULL

**Problem**: The PG dequeue query in `packages/server/src/queue/pg-queue.ts` lines 19-39 transitions runs to EXECUTING but does not set `heartbeat_deadline`:

```typescript
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
```

Note that `heartbeat_deadline` is not set here. The run-engine's `transition()` method DOES set it (line 83-85), but the PG dequeue bypasses the engine entirely -- it transitions via raw SQL. This means runs dequeued through the PG path have no heartbeat deadline, so the heartbeat monitor will never detect them as stale.

**Fix required**: Either:
- Add `heartbeat_deadline = NOW() + interval '30 seconds'` to the PG dequeue UPDATE, OR
- Route PG dequeue through the engine's `transition()` method (preferred -- ensures all side effects fire)

**Files to change**: `packages/server/src/queue/pg-queue.ts`

---

## Important Gaps (Degrades Reliability/Correctness)

### GAP-6: Heartbeat Monitor Uses DEFAULT_RETRY_CONFIG Instead of Task's Config

**Problem**: `packages/engine/src/heartbeat/heartbeat.ts` line 39:

```typescript
const retryConfig = DEFAULT_RETRY_CONFIG; // TODO: look up task's retry config
```

When a run's heartbeat expires, the retry backoff uses the default config (`maxAttempts: 3, minTimeout: 1000, maxTimeout: 60000, factor: 2`) regardless of what the task specifies. A task configured with `{ minTimeout: 30000, maxTimeout: 300000, factor: 3 }` would still get the default 1s/60s/2x backoff when the heartbeat monitor handles its failure.

The server's fail handler (`packages/server/src/routes/index.ts` lines 264-272) correctly looks up the task's retry config. The heartbeat monitor does not.

**Fix required**: Join `runs.taskId` to `tasks.id` to get `tasks.retryConfig` for the backoff calculation:

```typescript
const [task] = await db.select().from(schema.tasks)
  .where(eq(schema.tasks.id, run.taskId)).limit(1);
const retryConfig = (task?.retryConfig as RetryConfig | null) ?? DEFAULT_RETRY_CONFIG;
```

**Files to change**: `packages/engine/src/heartbeat/heartbeat.ts`

---

### GAP-7: Worker Dequeues from PG Only, Never from Redis/Fair Queue

**Problem**: `packages/worker/src/index.ts` lines 117-121:

```typescript
const res = await fetch(`${SERVER_URL}/api/dequeue`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ queueId: QUEUE_ID, limit: 1 }),
});
```

The worker always calls `POST /api/dequeue` which uses the PG SKIP LOCKED queue (`packages/server/src/queue/pg-queue.ts`). It never calls `POST /api/dequeue/fair` which uses the Redis fair dequeue (`packages/engine/src/queue/fair-dequeue.ts`). This means:

- Redis concurrency tracking (`packages/engine/src/queue/concurrency.ts`) is bypassed
- Fair round-robin across queues is unused
- Priority scoring via Redis sorted sets is unused
- The entire fair dequeue implementation (`packages/engine/src/queue/fair-dequeue.ts`) has no caller in production

The fair dequeue endpoint exists and is fully implemented (`packages/server/src/routes/index.ts` lines 112-147), but nothing calls it.

**Fix required**: Worker should call `/api/dequeue/fair` instead of `/api/dequeue`, or the `/api/dequeue` endpoint should internally use fair dequeue when Redis is available.

**Files to change**: `packages/worker/src/index.ts` or `packages/server/src/routes/index.ts`

---

### GAP-8: PG Dequeue Doesn't Filter by Worker's TaskTypes

**Problem**: The PG dequeue query in `packages/server/src/queue/pg-queue.ts` filters only by `queue_id` and `status`. It does not filter by the worker's registered `taskTypes`. A worker registered for task `"send-email"` could receive a `"process-data"` run if both are in the same queue.

The worker registers its taskTypes with the server (`packages/worker/src/index.ts` lines 49-54):

```typescript
const taskTypes = [...taskRegistry.keys()];
await fetch(`${SERVER_URL}/api/workers/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ workerId: WORKER_ID, taskTypes, queueId: QUEUE_ID }),
}).catch(() => {});
```

But the dequeue endpoint (`packages/server/src/routes/index.ts` lines 101-110) does not accept a `workerId` and does not look up the worker's taskTypes.

The worker does handle this case at runtime (`packages/worker/src/index.ts` lines 63-68):
```typescript
const taskFn = taskRegistry.get(taskId);
if (!taskFn) {
  console.error(`[worker] Unknown task: ${taskId}`);
  await client.failRun(run.id, { message: `Unknown task: ${taskId}` }, "SYSTEM_ERROR");
  return;
}
```

But this is wasteful -- the run is dequeued, transition to EXECUTING, then immediately failed and retried, wasting an attempt.

**Fix required**: The dequeue endpoint should accept `taskTypes[]` or `workerId`, and add `AND task_id = ANY(taskTypes)` to the SKIP LOCKED query.

**Files to change**: `packages/server/src/queue/pg-queue.ts`, `packages/server/src/routes/index.ts`

---

### GAP-9: ReleaseConcurrency Side Effect Missing concurrencyKey Field

**Problem**: The `ReleaseConcurrency` side effect type in `packages/core/src/types.ts` line 49:

```typescript
| { readonly _tag: "ReleaseConcurrency"; readonly runId: string; readonly queueId: string }
```

The type only has `runId` and `queueId`. No `concurrencyKey`. The actual release call needs it:

```typescript
// packages/engine/src/run-engine.ts lines 200-201
if (concurrency) {
  await concurrency.releaseAll(effect.queueId, run.concurrencyKey ?? null, effect.runId);
}
```

This currently works because the `run` object is passed alongside the effect in `executeSideEffect(effect, run)`. But if the side effect were ever serialized, replayed, or executed independently (e.g., in a reactor or outbox pattern), it would be missing the `concurrencyKey`.

**Fix required**: Add `concurrencyKey: string | null` to the `ReleaseConcurrency` side effect type. Set it in the state machine from the run's `concurrencyKey`.

**Files to change**: `packages/core/src/types.ts`, `packages/engine/src/state-machine.ts`, `packages/engine/src/run-engine.ts`

---

### GAP-10: No Event Bus (Typed PubSub)

**Problem**: The plan called for a typed event bus (`packages/core/src/event-bus.ts`) and a `DrainableQueue` for testing. Neither exists. Confirmed by searching for `EventBus` and `DrainableQueue` across the codebase -- zero results. The `EmitEvent` side effect has no subscriber. Future reactors (retry reactor, notification reactor, metrics) have no foundation.

**Fix required**: Create the typed event bus and DrainableQueue:
- `packages/core/src/event-bus.ts` (typed pub/sub with `on(eventTag, handler)`, `emit(event)`, `removeAll()`)
- `packages/core/src/drainable-queue.ts` (for deterministic test assertions)

**Files to change**: `packages/core/src/event-bus.ts` (new), `packages/core/src/drainable-queue.ts` (new)

---

### GAP-11: Trigger Route Doesn't Enqueue to Redis

**Problem**: The `POST /api/trigger` route (`packages/server/src/routes/index.ts` lines 92-95):

```typescript
// If not delayed, enqueue immediately
if (!isDelayed) {
  await pgQueue.enqueue(run.id);
}
```

This only calls `pgQueue.enqueue()` which sets status to QUEUED in PG. It does NOT also enqueue to the Redis sorted set. The only Redis enqueue happens through the engine's `EnqueueRun` side effect (`packages/engine/src/run-engine.ts` lines 180-185), but the trigger route bypasses the engine for the initial enqueue.

This means:
- Runs triggered via the API are only in the PG queue, not Redis
- The fair dequeue (which reads from Redis) will never see directly-triggered runs
- The Redis queue and PG queue become inconsistent

**Fix required**: Either:
- Route the initial enqueue through the engine: trigger -> engine.transition(runId, "QUEUED", ...) -> EnqueueRun effect -> Redis, OR
- Explicitly enqueue to Redis in the trigger route when `deps.redisQueue` is available

**Files to change**: `packages/server/src/routes/index.ts`

---

## Nice-to-Have Gaps

### GAP-12: Dashboard Doesn't Show Steps or Waitpoints

**Problem**: The run detail page (`packages/dashboard/src/app/runs/[id]/page.tsx`) shows status, task, queue, attempt number, payload, output, error, and the event timeline. But it does not display:
- Run steps (the `GET /api/runs/:id/steps` endpoint exists)
- Waitpoints (the `GET /api/runs/:id/waitpoints` endpoint exists)
- Suspension status details
- Child runs spawned by this run

The endpoints are already implemented in the server (`packages/server/src/routes/index.ts` lines 486-503), but the dashboard never fetches or renders this data.

**Files to change**: `packages/dashboard/src/app/runs/[id]/page.tsx`

---

### GAP-13: No Integration Tests

**Problem**: Zero test files exist in the project source. Confirmed by glob search for `*.test.ts` and `*.spec.ts` across `packages/**/src/` -- no results. The plan specified Vitest tests for:
- State machine transitions (pure function, easy to test)
- Retry logic (pure function, easy to test)
- Backoff computation (pure function, easy to test)
- Full trigger -> dequeue -> complete flow (integration test)
- Heartbeat monitor recovery
- Waitpoint resolution and resumption

**Files to create**: `packages/engine/src/__tests__/state-machine.test.ts`, `packages/engine/src/__tests__/retry.test.ts`, etc.

---

### GAP-14: Phase 7-8 Features Not Implemented

The following planned features have no implementation:
- **Cron scheduling** (Phase 7) -- no cron table, no cron parser, no scheduler
- **Token bucket rate limiting** (Phase 7) -- no rate limiter beyond concurrency limits
- **Dead letter queue endpoint** (Phase 7) -- no DLQ mechanism for permanently failed runs
- **Error categorization middleware** (Phase 7) -- no classification of errors into retriable/non-retriable categories beyond the basic `FailureType` enum
- **CLI tool** (Phase 8) -- no CLI for triggering runs, inspecting queues, etc.

---

### GAP-15: Worker Doesn't Pass workerId in Dequeue Request

**Problem**: The worker polls `/api/dequeue` but doesn't pass its `workerId` in the request body:

```typescript
// packages/worker/src/index.ts lines 117-121
const res = await fetch(`${SERVER_URL}/api/dequeue`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ queueId: QUEUE_ID, limit: 1 }),
});
```

The dequeue endpoint also doesn't accept or use a `workerId` parameter. This means:
- The server cannot associate the dequeued run with a specific worker during the dequeue step
- The `workerId` only gets set later when the worker sends its first heartbeat
- There is a window between dequeue and first heartbeat where the run's `workerId` is null

The PG dequeue SQL (`packages/server/src/queue/pg-queue.ts` lines 20-38) also doesn't set `worker_id` in the UPDATE.

**Fix required**: Pass `workerId` in the dequeue request body, accept it in the endpoint, and set `worker_id` in the SKIP LOCKED UPDATE.

**Files to change**: `packages/worker/src/index.ts`, `packages/server/src/routes/index.ts`, `packages/server/src/queue/pg-queue.ts`

---

### GAP-16: Fair Dequeue Does Not Enforce Per-Key Concurrency

**Problem**: The `fairDequeue` function in `packages/engine/src/queue/fair-dequeue.ts` line 55 only calls `concurrency.acquire(queueId, runId, limit)` for queue-level concurrency. It never calls `concurrency.acquireWithKey()` for per-`concurrencyKey` limits. However, `releaseAll()` in the engine DOES release both queue-level and per-key slots. This creates an asymmetry: key-level slots are released but never acquired.

**Impact**: If a task specifies a `concurrencyKey` (e.g., `{ concurrencyKey: userId }` to limit per-user concurrent processing), that limit is never enforced. All runs will be allowed through as long as queue-level concurrency permits.

**Fix required**: In `fairDequeue`, after acquiring the queue-level slot, look up the run's `concurrencyKey` from PG and call `concurrency.acquireWithKey()` if present. If it fails, release the queue-level slot and re-enqueue.

**Files to change**: `packages/engine/src/queue/fair-dequeue.ts`, `packages/server/src/routes/index.ts`

---

### GAP-17: Child Run Creation in Suspend Route Records No Events

**Problem**: The `/api/runs/:id/suspend` endpoint creates child runs via raw `db.insert(schema.runs)` and then calls `pgQueue.enqueue()`. This bypasses the engine entirely, so:
- No `run_events` entry for the child's PENDING creation
- No `run_events` entry for the child's PENDING→QUEUED transition
- No PG NOTIFY (SSE clients miss the child creation)
- Child never enters Redis queue

**Fix required**: Route child run creation through the engine: create with PENDING, then `engine.transition(childId, "QUEUED", ...)` to get proper events, NOTIFY, and Redis enqueue.

**Files to change**: `packages/server/src/routes/index.ts`

---

### GAP-18: Architectural Root Cause — PG Queue Operates Independently from Engine

**Root cause analysis**: The majority of critical issues (GAP-5, GAP-11, GAP-17, missing events, missing NOTIFY, missing Redis enqueue) stem from a single architectural gap: **the PG queue (`pg-queue.ts`) performs raw SQL state changes that bypass the engine's `transition()` function**.

The engine's `transition()` is the single point that:
- Validates state transitions via the pure state machine
- Records `run_events` (append-only audit log)
- Fires PG NOTIFY for SSE
- Emits side effects (heartbeat, concurrency, Redis enqueue, parent notification)

But `pgQueue.enqueue()` and `pgQueue.dequeue()` do raw `UPDATE runs SET status = ...` bypassing all of this.

**The fix**: Make `pgQueue.dequeue()` only SELECT candidate rows (with FOR UPDATE SKIP LOCKED), then call `engine.transition()` for each. Make `pgQueue.enqueue()` delegate to `engine.transition(runId, "QUEUED", ...)`. This single architectural fix resolves GAP-5, GAP-11, GAP-17, and most missing-events issues.

---

## Fix Priority Matrix

| Gap | Priority | Effort | Impact |
|-----|----------|--------|--------|
| GAP-1 (Worker does not use Step Runner) | CRITICAL | High | Entire Phase 6 is disconnected |
| GAP-2 (NotifyParent stub) | LOW | Low | Already handled in route handler |
| GAP-3 (EmitEvent stub) | IMPORTANT | Medium | No event bus for reactors |
| GAP-4 (Heartbeat side effects are no-ops) | LOW | Low | Remove or document as no-op |
| GAP-5 (PG dequeue skips heartbeatDeadline) | CRITICAL | Low | Stale runs undetectable |
| GAP-6 (Heartbeat retryConfig hardcoded) | IMPORTANT | Low | Wrong retry delays |
| GAP-7 (Worker uses PG not Redis dequeue) | IMPORTANT | Low | Redis queue unused |
| GAP-8 (TaskType filtering missing in dequeue) | IMPORTANT | Medium | Wrong tasks assigned to workers |
| GAP-9 (ConcurrencyKey missing from side effect) | LOW | Low | Works via run object for now |
| GAP-10 (No event bus) | IMPORTANT | Medium | No reactor foundation |
| GAP-11 (Trigger skips Redis enqueue) | IMPORTANT | Low | Redis queue inconsistent |
| GAP-12 (Dashboard missing steps/waitpoints) | NICE | Low | UI gap only |
| GAP-13 (No tests) | IMPORTANT | High | No regression safety |
| GAP-14 (Phase 7-8 features) | DEFERRED | High | Future phases |
| GAP-15 (Worker ID missing in dequeue) | LOW | Low | Missing tracking window |
| GAP-16 (Per-key concurrency not enforced) | IMPORTANT | Medium | concurrencyKey feature broken |
| GAP-17 (Child run creation bypasses engine) | IMPORTANT | Medium | No events/NOTIFY for child runs |
| GAP-18 (PG queue bypasses engine — root cause) | CRITICAL | Medium | Root cause of GAP-5, 11, 17 |

---

## Recommended Fix Order

### Phase A: Make Phase 6 work end-to-end (1-2 days)
1. **GAP-1** (Worker uses Step Runner) -- most critical, unlocks all Phase 6 features
2. **GAP-5** (PG dequeue sets heartbeatDeadline) -- quick fix, prevents stale runs

### Phase B: Make Redis queue path work end-to-end (0.5 day)
3. **GAP-7 + GAP-11** (Worker calls fair dequeue; trigger enqueues to Redis) -- makes Phase 3 actually work
4. **GAP-8** (TaskType filtering) -- correctness for multi-task deployments

### Phase C: Correctness fixes (0.5 day)
5. **GAP-6** (Heartbeat retryConfig lookup) -- easy win, one SQL join
6. **GAP-15** (Worker ID in dequeue) -- small fix, better observability

### Phase D: Architecture improvements (1 day)
7. **GAP-3 + GAP-10** (Event bus) -- foundation for reactors and metrics
8. **GAP-4 + GAP-9** (Clean up side effect types) -- code quality

### Phase E: Low priority cleanup (0.5 day)
9. **GAP-2** (NotifyParent) -- either wire it or remove it
10. **GAP-12** (Dashboard steps/waitpoints) -- UI improvement

### Phase F: Testing (1-2 days)
11. **GAP-13** (Integration tests) -- should run in parallel with other phases

### Deferred
12. **GAP-14** (Phase 7-8) -- future work

---

## Appendix: File Reference

| File | Description |
|------|-------------|
| `packages/engine/src/run-engine.ts` | Run engine with `executeSideEffect` (lines 178-211) |
| `packages/engine/src/state-machine.ts` | Pure state machine computing transitions + side effects |
| `packages/engine/src/resumption/step-runner.ts` | `executeWithResumption()` and `SuspendExecution` -- fully implemented, never called |
| `packages/engine/src/heartbeat/heartbeat.ts` | Heartbeat monitor with TODO on line 39 |
| `packages/engine/src/queue/redis-queue.ts` | Redis sorted set queue -- fully implemented |
| `packages/engine/src/queue/fair-dequeue.ts` | Fair round-robin dequeue -- fully implemented, never called by worker |
| `packages/engine/src/queue/concurrency.ts` | Redis concurrency tracker with Lua atomics -- fully implemented |
| `packages/engine/src/waitpoints/waitpoints.ts` | Waitpoint resolver -- fully implemented, used by server routes |
| `packages/server/src/routes/index.ts` | All HTTP endpoints including dequeue, complete, fail, suspend |
| `packages/server/src/queue/pg-queue.ts` | PG SKIP LOCKED queue -- missing heartbeat deadline, no taskType filter |
| `packages/worker/src/index.ts` | Worker polling loop -- bypasses step runner and Redis queue |
| `packages/sdk/src/task.ts` | Task definition -- `run` signature missing `StepContext` parameter |
| `packages/sdk/src/client.ts` | SDK client -- has `suspendRun()` method (lines 201-212) but worker never calls it |
| `packages/core/src/types.ts` | Core types including `SideEffect` union and `Run` interface |
| `packages/core/src/states.ts` | State machine transitions table |
| `packages/dashboard/src/app/runs/[id]/page.tsx` | Run detail page -- no steps/waitpoints UI |
