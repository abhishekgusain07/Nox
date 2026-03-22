import { z } from "zod";

export const TriggerRequestSchema = z.object({
  taskId: z.string().min(1),
  payload: z.unknown().optional().default({}),
  options: z
    .object({
      queueId: z.string().min(1).optional(),
      priority: z.number().int().min(0).max(100).optional(),
      maxAttempts: z.number().int().min(1).max(100).optional(),
      idempotencyKey: z.string().min(1).max(512).optional(),
      concurrencyKey: z.string().min(1).max(255).optional(),
      scheduledFor: z.string().datetime().optional(),
      ttl: z.number().int().positive().optional(),
      parentRunId: z.string().uuid().optional(),
    })
    .optional(),
});

export type TriggerRequest = z.infer<typeof TriggerRequestSchema>;

export const DequeueRequestSchema = z.object({
  queueId: z.string().min(1).default("default"),
  limit: z.number().int().min(1).max(10).default(1),
});

export type DequeueRequest = z.infer<typeof DequeueRequestSchema>;

export const CompleteRunSchema = z.object({
  output: z.unknown().optional().default(null),
});

export type CompleteRunRequest = z.infer<typeof CompleteRunSchema>;

export const FailRunSchema = z.object({
  error: z.object({
    message: z.string(),
    stack: z.string().optional(),
  }),
  failureType: z.enum(["TASK_ERROR", "SYSTEM_ERROR", "TIMEOUT"]).default("TASK_ERROR"),
});

export type FailRunRequest = z.infer<typeof FailRunSchema>;

export const GetRunParamsSchema = z.object({
  id: z.string().uuid(),
});
