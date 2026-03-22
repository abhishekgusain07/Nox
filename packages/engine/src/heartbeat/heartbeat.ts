import { eq, and, lt, isNotNull } from "drizzle-orm";
import { shouldRetry, computeBackoffMs, DEFAULT_RETRY_CONFIG } from "../retry/retry.js";
import type { RunEngine } from "../run-engine.js";
import type { FailureType } from "@reload-dev/core/states";

export interface HeartbeatMonitorDeps {
  db: any;
  schema: any;
  engine: RunEngine;
  pollIntervalMs?: number;
}

export function createHeartbeatMonitor(deps: HeartbeatMonitorDeps) {
  const { db, schema, engine, pollIntervalMs = 15_000 } = deps;
  let running = false;

  async function tick(): Promise<number> {
    const now = new Date();

    // Find runs that have missed their heartbeat deadline
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
      console.log(`[heartbeat] Run ${run.id} missed deadline. Handling failure.`);

      // Check if this run should retry
      const failureType: FailureType = "TIMEOUT";
      const canRetry = shouldRetry(run.attemptNumber, run.maxAttempts, failureType);

      if (canRetry) {
        const retryConfig = DEFAULT_RETRY_CONFIG; // TODO: look up task's retry config
        const delayMs = computeBackoffMs(run.attemptNumber, retryConfig);
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

  async function start(): Promise<void> {
    running = true;
    console.log(`[heartbeat] Monitor started (poll: ${pollIntervalMs}ms)`);
    while (running) {
      try {
        const recovered = await tick();
        if (recovered > 0) {
          console.log(`[heartbeat] Recovered ${recovered} stale runs`);
        }
      } catch (err: any) {
        console.error("[heartbeat] Monitor error:", err.message);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  function stop(): void {
    running = false;
  }

  return { start, stop, tick };
}
