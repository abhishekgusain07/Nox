import { pgTable, text, timestamp, integer, jsonb, pgEnum, uuid, boolean, index, uniqueIndex, serial } from "drizzle-orm/pg-core";

export const runStatusEnum = pgEnum("run_status", [
  "PENDING",
  "QUEUED",
  "DELAYED",
  "EXECUTING",
  "SUSPENDED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
]);

export const failureTypeEnum = pgEnum("failure_type", [
  "TASK_ERROR",
  "SYSTEM_ERROR",
  "TIMEOUT",
]);

export const queues = pgTable("queues", {
  id: text("id").primaryKey(),
  concurrencyLimit: integer("concurrency_limit").default(10).notNull(),
  paused: boolean("paused").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  queueId: text("queue_id").references(() => queues.id).notNull(),
  retryConfig: jsonb("retry_config"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const runs = pgTable("runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id),
  queueId: text("queue_id").notNull().references(() => queues.id),
  status: runStatusEnum("status").notNull().default("PENDING"),
  payload: jsonb("payload"),
  output: jsonb("output"),
  error: jsonb("error"),
  failureType: failureTypeEnum("failure_type"),

  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  ttl: integer("ttl"),
  priority: integer("priority").default(0).notNull(),

  idempotencyKey: text("idempotency_key"),
  concurrencyKey: text("concurrency_key"),

  attemptNumber: integer("attempt_number").default(0).notNull(),
  maxAttempts: integer("max_attempts").default(3).notNull(),

  parentRunId: uuid("parent_run_id"),

  workerId: text("worker_id"),
  heartbeatDeadline: timestamp("heartbeat_deadline", { withTimezone: true }),

  version: integer("version").default(1).notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  dequeuedAt: timestamp("dequeued_at", { withTimezone: true }),
}, (table) => ({
  queueStatusIdx: index("idx_runs_queue_status").on(table.queueId, table.status),
  scheduledForIdx: index("idx_runs_scheduled_for").on(table.scheduledFor),
  idempotencyKeyIdx: uniqueIndex("idx_runs_idempotency_key").on(table.idempotencyKey),
  statusIdx: index("idx_runs_status").on(table.status),
  heartbeatDeadlineIdx: index("idx_runs_heartbeat_deadline").on(table.heartbeatDeadline),
}));

export const workers = pgTable("workers", {
  id: text("id").primaryKey(), // worker-generated unique ID
  taskTypes: jsonb("task_types").$type<string[]>().notNull(), // which tasks this worker handles
  queueId: text("queue_id").references(() => queues.id),
  concurrency: integer("concurrency").default(5).notNull(), // how many runs this worker can handle
  status: text("status").notNull().default("online"), // online | offline
  lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }).defaultNow().notNull(),
  registeredAt: timestamp("registered_at", { withTimezone: true }).defaultNow().notNull(),
});

// Append-only event log — every state transition is recorded
export const runEvents = pgTable("run_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id),
  eventType: text("event_type").notNull(), // e.g., 'run.queued', 'run.started', 'run.completed'
  fromStatus: runStatusEnum("from_status"),
  toStatus: runStatusEnum("to_status").notNull(),
  workerId: text("worker_id"),
  attempt: integer("attempt"),
  reason: text("reason"),
  data: jsonb("data"), // Event-specific payload (error details, output, etc.)
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  runIdIdx: index("idx_run_events_run_id").on(table.runId),
  eventTypeIdx: index("idx_run_events_event_type").on(table.eventType),
  createdAtIdx: index("idx_run_events_created_at").on(table.createdAt),
}));

// Cached step results for resumption (step-based replay)
export const runSteps = pgTable("run_steps", {
  id: serial("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id),
  stepIndex: integer("step_index").notNull(),
  stepKey: text("step_key").notNull(), // e.g., "triggerAndWait:child-task" for non-determinism detection
  result: jsonb("result"), // Cached output from this step
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  runStepIdx: index("idx_run_steps_run_id").on(table.runId),
  runStepUniqueIdx: uniqueIndex("idx_run_steps_unique").on(table.runId, table.stepIndex),
}));

// Waitpoints — conditions that block runs until resolved
export const waitpoints = pgTable("waitpoints", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: text("type").notNull(), // 'CHILD_RUN' | 'DURATION' | 'TOKEN' | 'DATETIME' | 'BATCH'
  runId: uuid("run_id").notNull().references(() => runs.id),
  resolved: boolean("resolved").default(false).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  result: jsonb("result"),

  // For DURATION waits
  resumeAfter: timestamp("resume_after", { withTimezone: true }),

  // For CHILD_RUN waits
  childRunId: uuid("child_run_id").references(() => runs.id),

  // For TOKEN waits (human-in-the-loop)
  token: text("token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),

  // For BATCH waits
  batchTotal: integer("batch_total"),
  batchResolved: integer("batch_resolved").default(0),

  // Step info (which step in the parent this waitpoint corresponds to)
  stepIndex: integer("step_index"),
  stepKey: text("step_key"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  runIdIdx: index("idx_waitpoints_run_id").on(table.runId),
  childRunIdx: index("idx_waitpoints_child_run_id").on(table.childRunId),
  tokenIdx: uniqueIndex("idx_waitpoints_token").on(table.token),
  typeResolvedIdx: index("idx_waitpoints_type_resolved").on(table.type, table.resolved),
}));
