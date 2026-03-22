import { sql } from "drizzle-orm";
import type { RunEngine } from "../run-engine.js";

export interface TtlCheckerDeps {
  db: any;
  schema: any;
  engine: RunEngine;
  pollIntervalMs?: number;
}

export function createTtlChecker(deps: TtlCheckerDeps) {
  const { db, schema, engine, pollIntervalMs = 5_000 } = deps;
  let running = false;

  async function tick(): Promise<number> {
    const now = new Date();

    // Find QUEUED runs whose TTL has expired
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

  async function start(): Promise<void> {
    running = true;
    console.log(`[ttl] TTL checker started (poll: ${pollIntervalMs}ms)`);
    while (running) {
      try {
        const count = await tick();
        if (count > 0) {
          console.log(`[ttl] Expired ${count} runs`);
        }
      } catch (err: any) {
        console.error("[ttl] Checker error:", err.message);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  function stop(): void {
    running = false;
  }

  return { start, stop, tick };
}
