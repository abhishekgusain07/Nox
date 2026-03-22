import { eq, and, lte } from "drizzle-orm";
import type { WaitpointResolver } from "./waitpoints.js";

export interface DurationSchedulerDeps {
  db: any;
  schema: any;
  resolver: WaitpointResolver;
  pollIntervalMs?: number;
}

export function createDurationScheduler(deps: DurationSchedulerDeps) {
  const { db, schema, resolver, pollIntervalMs = 1000 } = deps;
  let running = false;

  async function tick(): Promise<number> {
    const now = new Date();

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

    let resolved = 0;
    for (const wp of readyWaitpoints) {
      try {
        await resolver.resolveDurationWait(wp.id as string);
        resolved++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[duration-scheduler] Failed to resolve waitpoint ${wp.id}:`,
          message,
        );
      }
    }

    return resolved;
  }

  async function start(): Promise<void> {
    running = true;
    console.log(
      `[duration-scheduler] Started (poll: ${pollIntervalMs}ms)`,
    );
    while (running) {
      try {
        const resolved = await tick();
        if (resolved > 0) {
          console.log(
            `[duration-scheduler] Resolved ${resolved} duration waitpoints`,
          );
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[duration-scheduler] Error:", message);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  function stop(): void {
    running = false;
  }

  return { start, stop, tick };
}
