import type { RunId, TaskId, QueueId, WorkerId, IdempotencyKey, ConcurrencyKey } from "./ids.js";
import type { RunStatus, FailureType } from "./states.js";

export interface Run {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly queueId: string;
  readonly status: RunStatus;
  readonly payload: unknown;
  readonly output: unknown | null;
  readonly error: unknown | null;
  readonly failureType: FailureType | null;
  readonly scheduledFor: Date | null;
  readonly ttl: number | null;
  readonly priority: number;
  readonly idempotencyKey: string | null;
  readonly concurrencyKey: string | null;
  readonly attemptNumber: number;
  readonly maxAttempts: number;
  readonly parentRunId: string | null;
  readonly workerId?: string | null;
  readonly heartbeatDeadline?: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly dequeuedAt: Date | null;
}

// ─── State Machine Types ───────────────────────────────────────────────────

export interface TransitionContext {
  readonly now: Date;
  readonly reason?: string;
  readonly output?: unknown;
  readonly error?: unknown;
  readonly failureType?: FailureType;
  readonly scheduledFor?: Date;
  readonly nextAttempt?: number;
  readonly workerId?: string;
  readonly waitpointId?: string;
}

export type SideEffect =
  | { readonly _tag: "EnqueueRun"; readonly runId: string; readonly queueId: string; readonly priority: number }
  | { readonly _tag: "EmitEvent"; readonly event: RunEvent }
  | { readonly _tag: "StartHeartbeat"; readonly runId: string; readonly workerId: string }
  | { readonly _tag: "CancelHeartbeat"; readonly runId: string }
  | { readonly _tag: "ReleaseConcurrency"; readonly runId: string; readonly queueId: string }
  | { readonly _tag: "NotifyParent"; readonly parentRunId: string; readonly childOutput: unknown };

export type RunEvent =
  | { readonly _tag: "RunQueued"; readonly runId: string; readonly queueId: string }
  | { readonly _tag: "RunStarted"; readonly runId: string }
  | { readonly _tag: "RunCompleted"; readonly runId: string; readonly output: unknown }
  | { readonly _tag: "RunFailed"; readonly runId: string; readonly error: unknown; readonly failureType: string }
  | { readonly _tag: "RunRetrying"; readonly runId: string; readonly attempt: number; readonly delayMs: number }
  | { readonly _tag: "RunSuspended"; readonly runId: string; readonly waitpointId: string }
  | { readonly _tag: "RunCancelled"; readonly runId: string; readonly reason: string }
  | { readonly _tag: "RunExpired"; readonly runId: string };

export type TransitionError =
  | { readonly _tag: "InvalidTransition"; readonly from: string; readonly to: string }
  | { readonly _tag: "RunNotFound"; readonly runId: string }
  | { readonly _tag: "VersionConflict"; readonly expected: number; readonly actual: number };

export interface TransitionResult {
  readonly run: Run;
  readonly effects: readonly SideEffect[];
}

export interface TaskDefinition {
  readonly id: string;
  readonly projectId: string;
  readonly queueId: string;
  readonly retryConfig: RetryConfig | null;
  readonly createdAt: Date;
}

export interface Queue {
  readonly id: string;
  readonly projectId: string;
  readonly concurrencyLimit: number;
  readonly paused: boolean;
  readonly createdAt: Date;
}

export interface Worker {
  readonly id: string;
  readonly projectId: string;
  readonly taskTypes: string[];
  readonly queueId: string | null;
  readonly concurrency: number;
  readonly status: "online" | "offline";
  readonly lastHeartbeat: Date;
  readonly registeredAt: Date;
}

export interface RetryConfig {
  readonly maxAttempts: number;
  readonly minTimeout: number;
  readonly maxTimeout: number;
  readonly factor: number;
}

export type WaitpointType = "CHILD_RUN" | "DURATION" | "TOKEN" | "DATETIME" | "BATCH";
