import { z } from "zod";
import type { Context, Next } from "hono";

// ─── URL Parameter Schemas ────────────────────────────────────────

export const UuidParam = z.string().uuid("Invalid ID format — expected UUID");
export const StringParam = z.string().min(1, "Parameter cannot be empty").max(255);

// ─── Query Parameter Schemas ──────────────────────────────────────

export const ListRunsQuery = z.object({
  status: z.enum([
    "PENDING", "QUEUED", "DELAYED", "EXECUTING", "SUSPENDED",
    "COMPLETED", "FAILED", "CANCELLED", "EXPIRED",
  ]).optional(),
  queueId: z.string().min(1).max(255).optional(),
  taskId: z.string().min(1).max(255).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const ListEventsQuery = z.object({
  taskId: z.string().min(1).max(255).optional(),
  eventType: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// ─── Validation Middleware Factory ─────────────────────────────────

/** Validate a URL parameter (e.g., :id) as UUID */
export function validateUuidParam(paramName: string) {
  return async function (c: Context, next: Next) {
    const value = c.req.param(paramName);
    const result = UuidParam.safeParse(value);
    if (!result.success) {
      return c.json({
        error: `Invalid ${paramName}: ${result.error.issues[0]?.message ?? "expected UUID"}`,
      }, 400);
    }
    await next();
  };
}

/** Validate query parameters with a Zod schema */
export function validateQuery<T extends z.ZodType>(querySchema: T) {
  return async function (c: Context, next: Next) {
    const raw: Record<string, string | undefined> = {};
    const url = new URL(c.req.url);
    for (const [key, value] of url.searchParams.entries()) {
      raw[key] = value;
    }

    const result = querySchema.safeParse(raw);
    if (!result.success) {
      return c.json({
        error: "Invalid query parameters",
        details: result.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      }, 400);
    }

    // Store parsed/coerced values so route handler can use them
    c.set("validatedQuery", result.data);
    await next();
  };
}
