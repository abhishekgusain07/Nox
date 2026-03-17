import { z } from "zod";

// Branded ID types using Zod for compile-time AND runtime safety
export const RunId = z.string().uuid().brand<"RunId">();
export type RunId = z.infer<typeof RunId>;

export const TaskId = z.string().min(1).max(255).brand<"TaskId">();
export type TaskId = z.infer<typeof TaskId>;

export const QueueId = z.string().min(1).max(255).brand<"QueueId">();
export type QueueId = z.infer<typeof QueueId>;

export const WorkerId = z.string().min(1).brand<"WorkerId">();
export type WorkerId = z.infer<typeof WorkerId>;

export const IdempotencyKey = z.string().min(1).max(512).brand<"IdempotencyKey">();
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;

export const ConcurrencyKey = z.string().min(1).max(255).brand<"ConcurrencyKey">();
export type ConcurrencyKey = z.infer<typeof ConcurrencyKey>;
