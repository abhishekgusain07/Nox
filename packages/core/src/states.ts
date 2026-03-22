export const RUN_STATUSES = [
  "PENDING",
  "QUEUED",
  "DELAYED",
  "EXECUTING",
  "SUSPENDED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_STATUSES: readonly RunStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
] as const;

export const FAILURE_TYPES = ["TASK_ERROR", "SYSTEM_ERROR", "TIMEOUT"] as const;
export type FailureType = (typeof FAILURE_TYPES)[number];

// Valid state transitions
export const TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  PENDING:   ["QUEUED", "DELAYED", "CANCELLED"],
  QUEUED:    ["EXECUTING", "EXPIRED", "CANCELLED"],
  DELAYED:   ["QUEUED", "CANCELLED"],
  EXECUTING: ["COMPLETED", "FAILED", "DELAYED", "SUSPENDED", "CANCELLED"],
  SUSPENDED: ["QUEUED", "CANCELLED"],
  COMPLETED: [],
  FAILED:    [],  // Terminal — retries go through EXECUTING -> DELAYED -> QUEUED
  CANCELLED: [],
  EXPIRED:   [],
} as const;

export const isTerminal = (status: RunStatus): boolean =>
  TERMINAL_STATUSES.includes(status);

export const canTransition = (from: RunStatus, to: RunStatus): boolean =>
  (TRANSITIONS[from] as readonly string[]).includes(to);
