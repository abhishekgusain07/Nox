import { sql } from "drizzle-orm";
import type { Database } from "../db/index.js";

export interface PgQueue {
  enqueue(runId: string): Promise<void>;
  dequeue(queueId: string, limit?: number, projectId?: string): Promise<any[]>;
}

export function createPgQueue(db: Database): PgQueue {
  return {
    async enqueue(runId: string): Promise<void> {
      await db.execute(sql`
        UPDATE runs
        SET status = 'QUEUED', version = version + 1
        WHERE id = ${runId}
      `);
    },

    async dequeue(queueId: string, limit: number = 1, projectId?: string): Promise<any[]> {
      const projectFilter = projectId
        ? sql`AND project_id = ${projectId}`
        : sql``;

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
            ${projectFilter}
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
