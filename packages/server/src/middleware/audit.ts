import type { Context } from "hono";
import type { Database } from "../db/index.js";
import { schema } from "../db/index.js";

export interface AuditEntry {
  projectId: string;
  apiKeyId?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
}

export function createAuditLogger(db: Database) {
  return {
    async log(entry: AuditEntry): Promise<void> {
      try {
        await db.insert(schema.auditLogs).values({
          projectId: entry.projectId,
          apiKeyId: entry.apiKeyId ?? null,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          details: entry.details ?? null,
          ipAddress: entry.ipAddress ?? null,
        });
      } catch {
        // Audit logging should never break the main flow
        console.error("[audit] Failed to log:", entry.action, entry.resourceType, entry.resourceId);
      }
    },

    /** Helper to extract IP from Hono context */
    getIp(c: Context): string {
      const forwarded = c.req.header("x-forwarded-for");
      return forwarded?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "unknown";
    },
  };
}

export type AuditLogger = ReturnType<typeof createAuditLogger>;
