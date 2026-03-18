import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import postgres from "postgres";
import type { Database } from "../db/index.js";
import { getAuthContext } from "../middleware/auth.js";

export function createStreamRoutes(db: Database, connectionString: string) {
  const api = new Hono();

  // SSE stream for a specific run
  api.get("/runs/:id/stream", async (c) => {
    const runId = c.req.param("id");
    const { projectId } = getAuthContext(c);

    return streamSSE(c, async (stream) => {
      // Create a dedicated connection for LISTEN (can't use pooled connections)
      const listener = postgres(connectionString, { max: 1 });

      try {
        // Send current state immediately
        await stream.writeSSE({
          data: JSON.stringify({ type: "snapshot", runId }),
          event: "state",
          id: "0",
        });

        // Subscribe to run updates
        await listener.listen("run_updates", (payload: string) => {
          try {
            const data = JSON.parse(payload) as { projectId?: string; runId?: string; timestamp?: string };
            if (data.projectId === projectId && data.runId === runId) {
              stream.writeSSE({
                data: payload,
                event: "update",
                id: data.timestamp,
              }).catch(() => {
                // Stream closed
              });
            }
          } catch {
            // Invalid JSON payload
          }
        });

        // Keep connection alive until client disconnects
        // The stream will be aborted when the client disconnects
        await new Promise<void>((resolve) => {
          stream.onAbort(() => {
            resolve();
          });
        });
      } finally {
        await listener.end();
      }
    });
  });

  // SSE stream for all runs (dashboard global feed)
  api.get("/stream", async (c) => {
    const { projectId } = getAuthContext(c);

    return streamSSE(c, async (stream) => {
      const listener = postgres(connectionString, { max: 1 });

      try {
        await listener.listen("run_updates", (payload: string) => {
          try {
            const data = JSON.parse(payload) as { projectId?: string };
            if (data.projectId === projectId) {
              stream.writeSSE({
                data: payload,
                event: "update",
              }).catch(() => {});
            }
          } catch {}
        });

        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve());
        });
      } finally {
        await listener.end();
      }
    });
  });

  // SSE stream for a specific queue
  api.get("/queues/:id/stream", async (c) => {
    const queueId = c.req.param("id");
    const { projectId } = getAuthContext(c);

    return streamSSE(c, async (stream) => {
      const listener = postgres(connectionString, { max: 1 });

      try {
        await listener.listen("run_updates", (payload: string) => {
          try {
            const data = JSON.parse(payload) as { projectId?: string; queueId?: string };
            if (data.projectId === projectId && data.queueId === queueId) {
              stream.writeSSE({
                data: payload,
                event: "update",
              }).catch(() => {});
            }
          } catch {}
        });

        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve());
        });
      } finally {
        await listener.end();
      }
    });
  });

  return api;
}
