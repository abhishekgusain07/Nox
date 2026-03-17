import { Hono } from "hono";
import { eq, and, desc, sql } from "drizzle-orm";
import { TriggerRequestSchema, DequeueRequestSchema, CompleteRunSchema, FailRunSchema } from "@reload-dev/core/schemas";
import { shouldRetry, computeBackoffMs, DEFAULT_RETRY_CONFIG, fairDequeue } from "@reload-dev/engine";
import type { RedisQueue } from "@reload-dev/engine";
import type { ConcurrencyTracker } from "@reload-dev/engine";
import type { WaitpointResolver } from "@reload-dev/engine";
import { schema } from "../db/index.js";
import type { Database } from "../db/index.js";
import type { PgQueue } from "../queue/pg-queue.js";
import type { RunEngine } from "@reload-dev/engine";
import type { RetryConfig } from "@reload-dev/core/types";
import type { InferInsertModel } from "drizzle-orm";
import crypto from "node:crypto";

type WaitpointInsert = InferInsertModel<typeof schema.waitpoints>;

function parseTimeout(timeout: string): number {
  const match = timeout.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 60_000; // Default 1 minute
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  switch (unit) {
    case "s": return value * 1000;
    case "m": return value * 60_000;
    case "h": return value * 3_600_000;
    case "d": return value * 86_400_000;
    default: return 60_000;
  }
}

export function createRoutes(
  db: Database,
  pgQueue: PgQueue,
  engine: RunEngine,
  deps?: { redisQueue?: RedisQueue; concurrency?: ConcurrencyTracker; waitpointResolver?: WaitpointResolver },
) {
  const api = new Hono();

  // POST /api/trigger — trigger a new run
  api.post("/trigger", async (c) => {
    const parseResult = TriggerRequestSchema.safeParse(await c.req.json());
    if (!parseResult.success) {
      return c.json({ error: parseResult.error.format() }, 400);
    }
    const body = parseResult.data;

    // Validate task exists
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, body.taskId)).limit(1);
    if (!task) {
      return c.json({ error: `Task not found: ${body.taskId}` }, 404);
    }

    // Idempotency check
    if (body.options?.idempotencyKey) {
      const [existing] = await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.idempotencyKey, body.options.idempotencyKey))
        .limit(1);
      if (existing) {
        return c.json({ runId: existing.id, existing: true });
      }
    }

    const queueId = body.options?.queueId ?? task.queueId;
    const isDelayed = body.options?.scheduledFor != null;

    // Create run
    const insertResult = await db
      .insert(schema.runs)
      .values({
        taskId: body.taskId,
        queueId,
        status: isDelayed ? "DELAYED" : "PENDING",
        payload: body.payload ?? {},
        priority: body.options?.priority ?? 0,
        maxAttempts: body.options?.maxAttempts ?? 3,
        idempotencyKey: body.options?.idempotencyKey ?? null,
        concurrencyKey: body.options?.concurrencyKey ?? null,
        scheduledFor: body.options?.scheduledFor ? new Date(body.options.scheduledFor) : null,
        ttl: body.options?.ttl ?? null,
        parentRunId: body.options?.parentRunId ?? null,
      })
      .returning();

    const run = insertResult[0];
    if (!run) {
      return c.json({ error: "Failed to create run" }, 500);
    }

    // If not delayed, enqueue immediately
    if (!isDelayed) {
      await pgQueue.enqueue(run.id);
    }

    return c.json({ runId: run.id }, 201);
  });

  // POST /api/dequeue — worker pulls work
  api.post("/dequeue", async (c) => {
    const parseResult = DequeueRequestSchema.safeParse(await c.req.json());
    if (!parseResult.success) {
      return c.json({ error: parseResult.error.format() }, 400);
    }
    const { queueId, limit } = parseResult.data;

    const dequeued = await pgQueue.dequeue(queueId, limit);
    return c.json({ runs: dequeued });
  });

  // POST /api/dequeue/fair — fair dequeue across multiple queues
  api.post("/dequeue/fair", async (c) => {
    if (!deps?.redisQueue || !deps?.concurrency) {
      return c.json({ error: "Fair dequeue requires Redis queue and concurrency tracker" }, 503);
    }

    const body = await c.req.json();
    const limit = body.limit ?? 1;

    const dequeued = await fairDequeue({
      redisQueue: deps.redisQueue,
      concurrency: deps.concurrency,
      getQueueLimit: async (queueId: string) => {
        const [queue] = await db.select().from(schema.queues).where(eq(schema.queues.id, queueId)).limit(1);
        return queue?.concurrencyLimit ?? 10;
      },
      isQueuePaused: async (queueId: string) => {
        const [queue] = await db.select().from(schema.queues).where(eq(schema.queues.id, queueId)).limit(1);
        return queue?.paused ?? false;
      },
    }, limit);

    // For each dequeued run, transition to EXECUTING in PG
    const runs = [];
    for (const { runId, queueId } of dequeued) {
      const result = await engine.transition(runId, "EXECUTING", {
        now: new Date(),
        reason: "Dequeued by fair scheduler",
      });
      if (result.ok) {
        runs.push(result.value);
      }
    }

    return c.json({ runs });
  });

  // GET /api/runs — list runs with filters
  api.get("/runs", async (c) => {
    const status = c.req.query("status");
    const queueId = c.req.query("queueId");
    const taskId = c.req.query("taskId");
    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    const offset = parseInt(c.req.query("offset") ?? "0", 10);

    const conditions = [];
    if (status) conditions.push(eq(schema.runs.status, status as typeof schema.runs.status.enumValues[number]));
    if (queueId) conditions.push(eq(schema.runs.queueId, queueId));
    if (taskId) conditions.push(eq(schema.runs.taskId, taskId));

    let query = db
      .select()
      .from(schema.runs)
      .orderBy(desc(schema.runs.createdAt))
      .limit(limit)
      .offset(offset);

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    const runs = await query;
    return c.json({ runs, limit, offset });
  });

  // GET /api/queues — list all queues with stats
  api.get("/queues", async (c) => {
    const allQueues = await db.select().from(schema.queues);

    // Get run counts per queue per status
    const stats = await db.execute(sql`
      SELECT queue_id, status, COUNT(*) as count
      FROM runs
      GROUP BY queue_id, status
    `);

    return c.json({ queues: allQueues, stats });
  });

  // GET /api/runs/:id — get run status
  api.get("/runs/:id", async (c) => {
    const runId = c.req.param("id");
    const [run] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .limit(1);

    if (!run) {
      return c.json({ error: `Run not found: ${runId}` }, 404);
    }

    return c.json(run);
  });

  // POST /api/runs/:id/complete — mark run as completed (via engine transition)
  api.post("/runs/:id/complete", async (c) => {
    const runId = c.req.param("id");
    const parseResult = CompleteRunSchema.safeParse(await c.req.json());
    if (!parseResult.success) {
      return c.json({ error: parseResult.error.format() }, 400);
    }

    const output = parseResult.data.output;

    const result = await engine.transition(runId, "COMPLETED", {
      now: new Date(),
      output,
    });

    if (!result.ok) {
      if (result.error._tag === "RunNotFound") return c.json({ error: `Run not found: ${runId}` }, 404);
      if (result.error._tag === "InvalidTransition") return c.json({ error: `Cannot complete run in ${result.error.from} state` }, 409);
      if (result.error._tag === "VersionConflict") return c.json({ error: "Version conflict — retry" }, 409);
      return c.json({ error: result.error }, 500);
    }

    // Check if this run is a child that a parent is waiting for
    if (deps?.waitpointResolver) {
      await deps.waitpointResolver.resolveChildRun(runId, output).catch((err: any) => {
        console.error(`[waitpoint] Failed to resolve child run ${runId}:`, err.message);
      });
      // Also check batch waitpoints
      await deps.waitpointResolver.resolveBatchChild(runId, output).catch((err: any) => {
        console.error(`[waitpoint] Failed to resolve batch child ${runId}:`, err.message);
      });
    }

    return c.json({ ok: true, run: result.value });
  });

  // POST /api/runs/:id/fail — mark run as failed (with retry logic)
  api.post("/runs/:id/fail", async (c) => {
    const runId = c.req.param("id");
    const parseResult = FailRunSchema.safeParse(await c.req.json());
    if (!parseResult.success) {
      return c.json({ error: parseResult.error.format() }, 400);
    }

    const { error: parsedError, failureType } = parseResult.data;

    // Load the current run to check retry eligibility
    const [run] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .limit(1);

    if (!run) {
      return c.json({ error: `Run not found: ${runId}` }, 404);
    }

    // Look up the task to get its retry config
    const [task] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, run.taskId))
      .limit(1);

    // Determine retry config: from task definition, or fall back to defaults
    const retryConfig: RetryConfig = (task?.retryConfig as RetryConfig | null) ?? DEFAULT_RETRY_CONFIG;

    if (shouldRetry(run.attemptNumber, run.maxAttempts, failureType)) {
      // EXECUTING -> DELAYED (with backoff)
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

      if (!result.ok) {
        if (result.error._tag === "RunNotFound") return c.json({ error: `Run not found: ${runId}` }, 404);
        if (result.error._tag === "InvalidTransition") return c.json({ error: `Cannot delay run in ${result.error.from} state` }, 409);
        if (result.error._tag === "VersionConflict") return c.json({ error: "Version conflict — retry" }, 409);
        return c.json({ error: result.error }, 500);
      }

      return c.json({ ok: true, retrying: true, run: result.value });
    } else {
      // EXECUTING -> FAILED (terminal)
      const result = await engine.transition(runId, "FAILED", {
        now: new Date(),
        error: parsedError,
        failureType,
        reason: `Failed after ${run.attemptNumber} attempts`,
      });

      if (!result.ok) {
        if (result.error._tag === "RunNotFound") return c.json({ error: `Run not found: ${runId}` }, 404);
        if (result.error._tag === "InvalidTransition") return c.json({ error: `Cannot fail run in ${result.error.from} state` }, 409);
        if (result.error._tag === "VersionConflict") return c.json({ error: "Version conflict — retry" }, 409);
        return c.json({ error: result.error }, 500);
      }

      return c.json({ ok: true, retrying: false, run: result.value });
    }
  });

  // POST /api/runs/:id/cancel — cancel a run
  api.post("/runs/:id/cancel", async (c) => {
    const runId = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));

    const result = await engine.transition(runId, "CANCELLED", {
      now: new Date(),
      reason: (body as Record<string, unknown>).reason as string ?? "Manually cancelled",
    });

    if (!result.ok) {
      if (result.error._tag === "RunNotFound") return c.json({ error: "Run not found" }, 404);
      if (result.error._tag === "InvalidTransition") return c.json({ error: `Cannot cancel run in ${result.error.from} state` }, 409);
      if (result.error._tag === "VersionConflict") return c.json({ error: "Version conflict — retry" }, 409);
      return c.json({ error: result.error }, 500);
    }

    return c.json({ ok: true });
  });

  // GET /api/runs/:id/events — event log for a run
  api.get("/runs/:id/events", async (c) => {
    const runId = c.req.param("id");
    const events = await db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId))
      .orderBy(schema.runEvents.createdAt);

    return c.json({ events });
  });

  // Seed endpoints for development

  // POST /api/queues — create a queue
  api.post("/queues", async (c) => {
    const body = await c.req.json();
    const [queue] = await db
      .insert(schema.queues)
      .values({
        id: body.id,
        concurrencyLimit: body.concurrencyLimit ?? 10,
      })
      .onConflictDoNothing()
      .returning();

    return c.json({ queue: queue ?? { id: body.id } }, 201);
  });

  // GET /api/tasks — list all registered tasks
  api.get("/tasks", async (c) => {
    const allTasks = await db.select().from(schema.tasks);
    return c.json({ tasks: allTasks });
  });

  // POST /api/tasks — register a task
  api.post("/tasks", async (c) => {
    const body = await c.req.json();
    const [task] = await db
      .insert(schema.tasks)
      .values({
        id: body.id,
        queueId: body.queueId ?? "default",
        retryConfig: body.retryConfig ?? null,
      })
      .onConflictDoNothing()
      .returning();

    return c.json({ task: task ?? { id: body.id } }, 201);
  });

  // POST /api/runs/:id/heartbeat — worker extends heartbeat deadline
  api.post("/runs/:id/heartbeat", async (c) => {
    const runId = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const workerId = (body as Record<string, unknown>).workerId as string | undefined ?? null;

    const updated = await db.update(schema.runs)
      .set({
        heartbeatDeadline: new Date(Date.now() + 30_000), // 30s from now
        ...(workerId ? { workerId } : {}),
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

  // POST /api/workers/register — worker registers with server
  api.post("/workers/register", async (c) => {
    const body = await c.req.json();
    const { workerId, taskTypes, queueId, concurrency } = body as {
      workerId?: string;
      taskTypes?: string[];
      queueId?: string;
      concurrency?: number;
    };

    if (!workerId || !taskTypes || !Array.isArray(taskTypes)) {
      return c.json({ error: "workerId and taskTypes[] required" }, 400);
    }

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

  // POST /api/workers/:id/heartbeat — worker liveness
  api.post("/workers/:id/heartbeat", async (c) => {
    const workerId = c.req.param("id");

    await db.update(schema.workers)
      .set({ lastHeartbeat: new Date(), status: "online" })
      .where(eq(schema.workers.id, workerId));

    return c.json({ ok: true });
  });

  // POST /api/workers/:id/deregister — worker going offline
  api.post("/workers/:id/deregister", async (c) => {
    const workerId = c.req.param("id");

    await db.update(schema.workers)
      .set({ status: "offline" })
      .where(eq(schema.workers.id, workerId));

    return c.json({ ok: true });
  });

  // GET /api/workers — list registered workers
  api.get("/workers", async (c) => {
    const allWorkers = await db.select().from(schema.workers);
    return c.json({ workers: allWorkers });
  });

  // POST /api/waitpoints/:token/complete — resolve a token waitpoint (human-in-the-loop)
  api.post("/waitpoints/:token/complete", async (c) => {
    const token = c.req.param("token");
    const body = await c.req.json().catch(() => ({}));

    if (!deps?.waitpointResolver) {
      return c.json({ error: "Waitpoint resolver not configured" }, 503);
    }

    try {
      await deps.waitpointResolver.resolveToken(token, (body as Record<string, unknown>).result ?? null);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  // GET /api/runs/:id/steps — view cached steps for a run
  api.get("/runs/:id/steps", async (c) => {
    const runId = c.req.param("id");
    const steps = await db.select()
      .from(schema.runSteps)
      .where(eq(schema.runSteps.runId, runId))
      .orderBy(schema.runSteps.stepIndex);
    return c.json({ steps });
  });

  // GET /api/runs/:id/waitpoints — view waitpoints for a run
  api.get("/runs/:id/waitpoints", async (c) => {
    const runId = c.req.param("id");
    const wps = await db.select()
      .from(schema.waitpoints)
      .where(eq(schema.waitpoints.runId, runId))
      .orderBy(schema.waitpoints.createdAt);
    return c.json({ waitpoints: wps });
  });

  // POST /api/runs/:id/suspend — worker reports suspension
  api.post("/runs/:id/suspend", async (c) => {
    const runId = c.req.param("id");
    const body = await c.req.json() as {
      stepIndex: number;
      stepKey: string;
      waitpointType: string;
      waitpointData: unknown;
    };

    // 1. Transition to SUSPENDED
    const result = await engine.transition(runId, "SUSPENDED", {
      now: new Date(),
      reason: `Suspended at step ${body.stepIndex} (${body.waitpointType})`,
    });

    if (!result.ok) {
      if (result.error._tag === "RunNotFound") return c.json({ error: `Run not found: ${runId}` }, 404);
      if (result.error._tag === "InvalidTransition") return c.json({ error: `Cannot suspend run in ${result.error.from} state` }, 409);
      if (result.error._tag === "VersionConflict") return c.json({ error: "Version conflict — retry" }, 409);
      return c.json({ error: result.error }, 500);
    }

    // 2. Create the waitpoint
    const waitpointValues: WaitpointInsert = {
      type: body.waitpointType,
      runId,
      stepIndex: body.stepIndex,
      stepKey: body.stepKey,
    };

    if (body.waitpointType === "CHILD_RUN") {
      // Create the child run first
      const childData = body.waitpointData as { taskId: string; payload: unknown };

      // Look up the task to get its queue
      const taskRows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, childData.taskId)).limit(1);
      const task = taskRows[0];
      if (!task) return c.json({ error: `Child task not found: ${childData.taskId}` }, 404);

      const childInsert = await db.insert(schema.runs).values({
        taskId: childData.taskId,
        queueId: task.queueId,
        status: "PENDING" as const,
        payload: childData.payload ?? {},
        parentRunId: runId,
        priority: 0,
        maxAttempts: 3,
      }).returning();

      const childRun = childInsert[0];
      if (!childRun) return c.json({ error: "Failed to create child run" }, 500);

      waitpointValues.childRunId = childRun.id;

      // Enqueue the child
      await pgQueue.enqueue(childRun.id);
    } else if (body.waitpointType === "DURATION") {
      const duration = body.waitpointData as { seconds: number };
      waitpointValues.resumeAfter = new Date(Date.now() + duration.seconds * 1000);
    } else if (body.waitpointType === "TOKEN") {
      const tokenId = `tok-${crypto.randomUUID().slice(0, 12)}`;
      waitpointValues.token = tokenId;
      if ((body.waitpointData as Record<string, unknown>)?.timeout) {
        const timeoutMs = parseTimeout((body.waitpointData as Record<string, unknown>).timeout as string);
        waitpointValues.expiresAt = new Date(Date.now() + timeoutMs);
      }
    } else if (body.waitpointType === "BATCH") {
      const tasks = body.waitpointData as Array<{ taskId: string; payload: unknown }>;
      waitpointValues.batchTotal = tasks.length;
      waitpointValues.batchResolved = 0;

      // Create all child runs
      for (const childData of tasks) {
        const taskRows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, childData.taskId)).limit(1);
        const task = taskRows[0];
        if (!task) continue;

        const childInsert = await db.insert(schema.runs).values({
          taskId: childData.taskId,
          queueId: task.queueId,
          status: "PENDING" as const,
          payload: childData.payload ?? {},
          parentRunId: runId,
          priority: 0,
          maxAttempts: 3,
        }).returning();

        const childRun = childInsert[0];
        if (childRun) await pgQueue.enqueue(childRun.id);
      }
    }

    await db.insert(schema.waitpoints).values(waitpointValues);

    return c.json({ ok: true, waitpointType: body.waitpointType });
  });

  return api;
}
