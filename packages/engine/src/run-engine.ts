import { eq, and, sql } from "drizzle-orm";
import { computeTransition } from "./state-machine.js";
import { ok, err, isErr } from "@reload-dev/core/result";
import type { Result } from "@reload-dev/core/result";
import type { RunStatus } from "@reload-dev/core/states";
import type { Run, TransitionContext, TransitionError, SideEffect, RunEvent } from "@reload-dev/core/types";
import type { RedisQueue } from "./queue/redis-queue.js";
import type { ConcurrencyTracker } from "./queue/concurrency.js";

export interface RunEngineDeps {
  db: any; // Drizzle database instance
  schema: any; // Schema module (runs, runEvents, etc.)
  pgQueue: { enqueue(runId: string): Promise<void> };
  redisQueue?: RedisQueue;
  concurrency?: ConcurrencyTracker;
}

export function createRunEngine(deps: RunEngineDeps) {
  const { db, schema, pgQueue, redisQueue, concurrency } = deps;

  async function transition(
    runId: string,
    to: RunStatus,
    context: TransitionContext,
  ): Promise<Result<Run, TransitionError>> {
    // 1. Load current run
    const rows = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
    const currentRun = rows[0];
    if (!currentRun) {
      return err({ _tag: "RunNotFound" as const, runId });
    }

    // Normalize DB row to Run type
    const run: Run = {
      id: currentRun.id,
      taskId: currentRun.taskId,
      queueId: currentRun.queueId,
      status: currentRun.status as RunStatus,
      payload: currentRun.payload,
      output: currentRun.output ?? null,
      error: currentRun.error ?? null,
      failureType: currentRun.failureType ?? null,
      scheduledFor: currentRun.scheduledFor ?? null,
      ttl: currentRun.ttl ?? null,
      priority: currentRun.priority,
      idempotencyKey: currentRun.idempotencyKey ?? null,
      concurrencyKey: currentRun.concurrencyKey ?? null,
      attemptNumber: currentRun.attemptNumber,
      maxAttempts: currentRun.maxAttempts,
      parentRunId: currentRun.parentRunId ?? null,
      version: currentRun.version,
      createdAt: currentRun.createdAt,
      startedAt: currentRun.startedAt ?? null,
      completedAt: currentRun.completedAt ?? null,
      dequeuedAt: currentRun.dequeuedAt ?? null,
      workerId: currentRun.workerId ?? null,
      heartbeatDeadline: currentRun.heartbeatDeadline ?? null,
    };

    // 2. Compute transition (PURE -- no I/O)
    const result = computeTransition(run, to, context);
    if (!result.ok) return result;

    const { run: newRun, effects } = result.value;

    // 3. Write with optimistic locking (version check)
    const updated = await db
      .update(schema.runs)
      .set({
        status: newRun.status,
        output: newRun.output,
        error: newRun.error,
        failureType: newRun.failureType,
        scheduledFor: newRun.scheduledFor,
        attemptNumber: newRun.attemptNumber,
        startedAt: newRun.startedAt,
        completedAt: newRun.completedAt,
        dequeuedAt: newRun.dequeuedAt,
        workerId: newRun.workerId,
        heartbeatDeadline: to === "EXECUTING"
          ? new Date(context.now.getTime() + 30_000)  // 30s heartbeat deadline
          : newRun.heartbeatDeadline,
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

    // 4. Record event in append-only log
    if (schema.runEvents) {
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
          ...(context.failureType
            ? { failureType: context.failureType }
            : {}),
          ...(context.workerId ? { workerId: context.workerId } : {}),
          ...(context.scheduledFor
            ? { scheduledFor: context.scheduledFor.toISOString() }
            : {}),
        },
      });
    }

    // 4b. Notify listeners (for SSE)
    try {
      await db.execute(sql`NOTIFY run_updates, ${JSON.stringify({
        runId,
        fromStatus: run.status,
        toStatus: to,
        queueId: run.queueId,
        taskId: run.taskId,
        timestamp: new Date().toISOString(),
      })}`);
    } catch {
      // NOTIFY failure is not critical — SSE clients will miss this update
      // They can recover via polling
    }

    // 5. Execute side effects
    for (const effect of effects) {
      await executeSideEffect(effect, run);
    }

    // Normalize the returned DB row back to a Run
    const updatedRow = updated[0];
    const returnedRun: Run = {
      id: updatedRow.id,
      taskId: updatedRow.taskId,
      queueId: updatedRow.queueId,
      status: updatedRow.status as RunStatus,
      payload: updatedRow.payload,
      output: updatedRow.output ?? null,
      error: updatedRow.error ?? null,
      failureType: updatedRow.failureType ?? null,
      scheduledFor: updatedRow.scheduledFor ?? null,
      ttl: updatedRow.ttl ?? null,
      priority: updatedRow.priority,
      idempotencyKey: updatedRow.idempotencyKey ?? null,
      concurrencyKey: updatedRow.concurrencyKey ?? null,
      attemptNumber: updatedRow.attemptNumber,
      maxAttempts: updatedRow.maxAttempts,
      parentRunId: updatedRow.parentRunId ?? null,
      version: updatedRow.version,
      createdAt: updatedRow.createdAt,
      startedAt: updatedRow.startedAt ?? null,
      completedAt: updatedRow.completedAt ?? null,
      dequeuedAt: updatedRow.dequeuedAt ?? null,
      workerId: updatedRow.workerId ?? null,
      heartbeatDeadline: updatedRow.heartbeatDeadline ?? null,
    };

    return ok(returnedRun);
  }

  async function executeSideEffect(effect: SideEffect, run: Run): Promise<void> {
    switch (effect._tag) {
      case "EnqueueRun":
        await pgQueue.enqueue(effect.runId);
        // Phase 3: also enqueue to Redis queue if available
        if (redisQueue) {
          await redisQueue.enqueue(effect.runId, effect.queueId, effect.priority);
        }
        break;
      case "EmitEvent":
        // For now, just log. Phase 5 will add SSE/event bus.
        console.log(`[event] ${effect.event._tag}`, effect.event);
        break;
      case "StartHeartbeat":
        // Phase 4 will implement heartbeat
        console.log(`[heartbeat] Start for run ${effect.runId}`);
        break;
      case "CancelHeartbeat":
        console.log(`[heartbeat] Cancel for run ${effect.runId}`);
        break;
      case "ReleaseConcurrency":
        // Phase 3: release concurrency slots via Redis tracker
        if (concurrency) {
          await concurrency.releaseAll(effect.queueId, run.concurrencyKey ?? null, effect.runId);
        } else {
          console.log(`[concurrency] Release for run ${effect.runId}`);
        }
        break;
      case "NotifyParent":
        // Phase 6 will implement parent notification
        console.log(`[parent] Notify ${effect.parentRunId}`);
        break;
    }
  }

  return { transition };
}

export type RunEngine = ReturnType<typeof createRunEngine>;
