import { eq, and, sql } from "drizzle-orm";
import type { RunEngine } from "../run-engine.js";

export interface WaitpointResolverDeps {
  db: any;
  schema: any;
  engine: RunEngine;
}

export function createWaitpointResolver(deps: WaitpointResolverDeps) {
  const { db, schema, engine } = deps;

  async function getNextStepIndex(runId: string): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.runSteps)
      .where(eq(schema.runSteps.runId, runId));
    const row = result[0] as { count: number } | undefined;
    return row?.count ?? 0;
  }

  return {
    /**
     * Called when a child run completes — resolves the parent's waitpoint.
     */
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
      if (!wp) return; // No parent waiting for this child

      // Mark waitpoint resolved
      await db
        .update(schema.waitpoints)
        .set({
          resolved: true,
          resolvedAt: new Date(),
          result: output,
        })
        .where(eq(schema.waitpoints.id, wp.id));

      // Cache the step result in run_steps
      const stepIndex: number =
        typeof wp.stepIndex === "number"
          ? wp.stepIndex
          : await getNextStepIndex(wp.runId as string);

      await db.insert(schema.runSteps).values({
        runId: wp.runId,
        stepIndex,
        stepKey: (wp.stepKey as string | null) ?? "triggerAndWait:child",
        result: output,
      });

      // Resume parent: SUSPENDED -> QUEUED
      await engine.transition(wp.runId as string, "QUEUED", {
        now: new Date(),
        reason: `Child run ${childRunId} completed`,
      });
    },

    /**
     * Called by the duration wait scheduler when resumeAfter time has passed.
     */
    async resolveDurationWait(waitpointId: string): Promise<void> {
      const wpRows = await db
        .select()
        .from(schema.waitpoints)
        .where(eq(schema.waitpoints.id, waitpointId));

      const wp = wpRows[0];
      if (!wp || wp.resolved) return;

      await db
        .update(schema.waitpoints)
        .set({
          resolved: true,
          resolvedAt: new Date(),
        })
        .where(eq(schema.waitpoints.id, waitpointId));

      // Cache step result (null for duration waits)
      const stepIndex: number =
        typeof wp.stepIndex === "number"
          ? wp.stepIndex
          : await getNextStepIndex(wp.runId as string);

      await db.insert(schema.runSteps).values({
        runId: wp.runId,
        stepIndex,
        stepKey: (wp.stepKey as string | null) ?? "wait:duration",
        result: null,
      });

      // Resume parent: SUSPENDED -> QUEUED
      await engine.transition(wp.runId as string, "QUEUED", {
        now: new Date(),
        reason: "Duration wait elapsed",
      });
    },

    /**
     * Called via HTTP endpoint — external system provides a result.
     */
    async resolveToken(token: string, result: unknown): Promise<void> {
      const wpRows = await db
        .select()
        .from(schema.waitpoints)
        .where(
          and(
            eq(schema.waitpoints.token, token),
            eq(schema.waitpoints.resolved, false),
          ),
        );

      const wp = wpRows[0];
      if (!wp) throw new Error("Invalid or already resolved token");

      // Check expiry
      if (wp.expiresAt && new Date() > (wp.expiresAt as Date)) {
        throw new Error("Token has expired");
      }

      await db
        .update(schema.waitpoints)
        .set({
          resolved: true,
          resolvedAt: new Date(),
          result,
        })
        .where(eq(schema.waitpoints.id, wp.id));

      // Cache step result
      const stepIndex: number =
        typeof wp.stepIndex === "number"
          ? wp.stepIndex
          : await getNextStepIndex(wp.runId as string);

      await db.insert(schema.runSteps).values({
        runId: wp.runId,
        stepIndex,
        stepKey: (wp.stepKey as string | null) ?? `token:${token}`,
        result,
      });

      // Resume parent: SUSPENDED -> QUEUED
      await engine.transition(wp.runId as string, "QUEUED", {
        now: new Date(),
        reason: `Token ${token} resolved`,
      });
    },

    /**
     * Resolve a batch waitpoint — called when a child in a batch completes.
     */
    async resolveBatchChild(
      childRunId: string,
      output: unknown,
    ): Promise<void> {
      // Find unresolved BATCH waitpoints
      const wpRows = await db
        .select()
        .from(schema.waitpoints)
        .where(
          and(
            eq(schema.waitpoints.type, "BATCH"),
            eq(schema.waitpoints.resolved, false),
          ),
        );

      for (const wp of wpRows) {
        // Check if the child's parentRunId matches the waitpoint's runId
        const childRows = await db
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.id, childRunId))
          .limit(1);

        const childRun = childRows[0];
        if (!childRun || childRun.parentRunId !== wp.runId) continue;

        // Increment batch resolved count
        const updated = await db
          .update(schema.waitpoints)
          .set({
            batchResolved: sql`batch_resolved + 1`,
          })
          .where(eq(schema.waitpoints.id, wp.id))
          .returning();

        const updatedWp = updated[0];
        if (!updatedWp) continue;

        // Check if all children in the batch are done
        const batchResolved = updatedWp.batchResolved as number;
        const batchTotal = (updatedWp.batchTotal as number | null) ?? 0;

        if (batchResolved >= batchTotal) {
          // All children done — collect results
          const childResultRows = await db
            .select({ id: schema.runs.id, output: schema.runs.output })
            .from(schema.runs)
            .where(eq(schema.runs.parentRunId, wp.runId as string));

          const results = childResultRows.map(
            (r: { id: string; output: unknown }) => r.output,
          );

          await db
            .update(schema.waitpoints)
            .set({
              resolved: true,
              resolvedAt: new Date(),
              result: results,
            })
            .where(eq(schema.waitpoints.id, wp.id));

          // Cache step result
          const stepIndex: number =
            typeof wp.stepIndex === "number"
              ? wp.stepIndex
              : await getNextStepIndex(wp.runId as string);

          await db.insert(schema.runSteps).values({
            runId: wp.runId,
            stepIndex,
            stepKey: (wp.stepKey as string | null) ?? "batch",
            result: results,
          });

          // Resume parent
          await engine.transition(wp.runId as string, "QUEUED", {
            now: new Date(),
            reason: `Batch complete (${batchTotal} children)`,
          });
        }

        break; // Found the matching waitpoint
      }
    },
  };
}

export type WaitpointResolver = ReturnType<typeof createWaitpointResolver>;
