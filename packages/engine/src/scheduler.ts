import { eq, and, lte } from "drizzle-orm";
import type { RunEngine } from "./run-engine.js";

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
      // If version conflict, another scheduler instance already promoted it -- fine
      if (result.ok) promoted++;
    }
    return promoted;
  }

  async function start(): Promise<void> {
    running = true;
    console.log(
      `[scheduler] Started delayed run scheduler (poll: ${pollIntervalMs}ms)`,
    );
    while (running) {
      try {
        const promoted = await tick();
        if (promoted > 0) {
          console.log(
            `[scheduler] Promoted ${promoted} delayed runs to QUEUED`,
          );
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
