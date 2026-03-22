import type { Run, TransitionContext, TransitionError, TransitionResult, SideEffect } from "@reload-dev/core/types";
import type { RunStatus } from "@reload-dev/core/states";
import type { Result } from "@reload-dev/core/result";
import { ok, err } from "@reload-dev/core/result";
import { canTransition } from "@reload-dev/core/states";

/**
 * Pure function: validates a state transition and computes the new Run + side effects.
 *
 * This is the heart of the engine. It takes a Run, a target status, and a context,
 * and returns the new Run state plus any side effects that need to be executed.
 *
 * NO I/O. NO database calls. NO mutation. Pure data in, data out.
 */
export function computeTransition(
  run: Readonly<Run>,
  to: RunStatus,
  context: TransitionContext,
): Result<TransitionResult, TransitionError> {
  // Guard: is this transition legal?
  if (!canTransition(run.status, to)) {
    return err({
      _tag: "InvalidTransition" as const,
      from: run.status,
      to,
    });
  }

  // Compute the new run state + side effects
  switch (to) {
    case "QUEUED": {
      const newRun: Run = {
        ...run,
        status: "QUEUED",
        version: run.version + 1,
      };
      return ok({
        run: newRun,
        effects: [
          { _tag: "EnqueueRun" as const, runId: run.id, queueId: run.queueId, priority: run.priority },
          { _tag: "EmitEvent" as const, event: { _tag: "RunQueued" as const, runId: run.id, queueId: run.queueId } },
        ],
      });
    }

    case "EXECUTING": {
      const newRun: Run = {
        ...run,
        status: "EXECUTING",
        version: run.version + 1,
        startedAt: context.now,
        workerId: context.workerId ?? run.workerId,
        dequeuedAt: context.now,
      };
      return ok({
        run: newRun,
        effects: [
          { _tag: "StartHeartbeat" as const, runId: run.id, workerId: context.workerId! },
          { _tag: "EmitEvent" as const, event: { _tag: "RunStarted" as const, runId: run.id } },
        ],
      });
    }

    case "COMPLETED": {
      const newRun: Run = {
        ...run,
        status: "COMPLETED",
        version: run.version + 1,
        output: context.output,
        completedAt: context.now,
      };
      const effects: SideEffect[] = [
        { _tag: "CancelHeartbeat" as const, runId: run.id },
        { _tag: "ReleaseConcurrency" as const, runId: run.id, queueId: run.queueId },
        { _tag: "EmitEvent" as const, event: { _tag: "RunCompleted" as const, runId: run.id, output: context.output } },
      ];
      if (run.parentRunId) {
        effects.push({ _tag: "NotifyParent" as const, parentRunId: run.parentRunId, childOutput: context.output });
      }
      return ok({ run: newRun, effects });
    }

    case "DELAYED": {
      const newRun: Run = {
        ...run,
        status: "DELAYED",
        version: run.version + 1,
        scheduledFor: context.scheduledFor ?? null,
        attemptNumber: context.nextAttempt ?? run.attemptNumber,
      };
      const effects: SideEffect[] = [
        { _tag: "CancelHeartbeat" as const, runId: run.id },
        { _tag: "ReleaseConcurrency" as const, runId: run.id, queueId: run.queueId },
        { _tag: "EmitEvent" as const, event: {
          _tag: "RunRetrying" as const,
          runId: run.id,
          attempt: newRun.attemptNumber,
          delayMs: context.scheduledFor
            ? context.scheduledFor.getTime() - context.now.getTime()
            : 0,
        }},
      ];
      return ok({ run: newRun, effects });
    }

    case "FAILED": {
      const newRun: Run = {
        ...run,
        status: "FAILED",
        version: run.version + 1,
        error: context.error,
        failureType: context.failureType ?? "TASK_ERROR",
        completedAt: context.now,
      };
      const effects: SideEffect[] = [
        { _tag: "CancelHeartbeat" as const, runId: run.id },
        { _tag: "ReleaseConcurrency" as const, runId: run.id, queueId: run.queueId },
        { _tag: "EmitEvent" as const, event: {
          _tag: "RunFailed" as const,
          runId: run.id,
          error: context.error,
          failureType: newRun.failureType!,
        }},
      ];
      return ok({ run: newRun, effects });
    }

    case "SUSPENDED": {
      const newRun: Run = {
        ...run,
        status: "SUSPENDED",
        version: run.version + 1,
      };
      return ok({
        run: newRun,
        effects: [
          { _tag: "CancelHeartbeat" as const, runId: run.id },
          { _tag: "ReleaseConcurrency" as const, runId: run.id, queueId: run.queueId },
          { _tag: "EmitEvent" as const, event: {
            _tag: "RunSuspended" as const,
            runId: run.id,
            waitpointId: context.waitpointId!,
          }},
        ],
      });
    }

    case "CANCELLED": {
      const newRun: Run = {
        ...run,
        status: "CANCELLED",
        version: run.version + 1,
        completedAt: context.now,
      };
      return ok({
        run: newRun,
        effects: [
          { _tag: "CancelHeartbeat" as const, runId: run.id },
          { _tag: "ReleaseConcurrency" as const, runId: run.id, queueId: run.queueId },
          { _tag: "EmitEvent" as const, event: { _tag: "RunCancelled" as const, runId: run.id, reason: context.reason ?? "manual" } },
        ],
      });
    }

    case "EXPIRED": {
      const newRun: Run = {
        ...run,
        status: "EXPIRED",
        version: run.version + 1,
        completedAt: context.now,
      };
      return ok({
        run: newRun,
        effects: [
          { _tag: "EmitEvent" as const, event: { _tag: "RunExpired" as const, runId: run.id } },
        ],
      });
    }

    case "PENDING": {
      // PENDING is the initial state — nothing ever transitions TO it.
      return err({ _tag: "InvalidTransition" as const, from: run.status, to });
    }

    default: {
      const _exhaustive: never = to;
      return err({ _tag: "InvalidTransition" as const, from: run.status, to: _exhaustive });
    }
  }
}
