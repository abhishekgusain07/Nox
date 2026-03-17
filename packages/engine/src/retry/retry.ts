import type { RetryConfig } from "@reload-dev/core/types";
import type { FailureType } from "@reload-dev/core/states";

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  minTimeout: 1000,
  maxTimeout: 60000,
  factor: 2,
};

/**
 * Pure function: compute backoff delay in milliseconds for a given attempt.
 *
 * Uses exponential backoff with +-25% jitter to prevent thundering herd.
 */
export function computeBackoffMs(attempt: number, config: RetryConfig): number {
  const exponential = config.minTimeout * Math.pow(config.factor, attempt);
  const clamped = Math.min(exponential, config.maxTimeout);
  // Jitter: +/-25% to prevent thundering herd
  const jitter = clamped * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

/**
 * Pure function: should this failure be retried?
 *
 * SYSTEM_ERROR and TIMEOUT get extra retry attempts since they are not the user's fault.
 * TASK_ERROR retries up to maxAttempts.
 */
export function shouldRetry(
  attemptNumber: number,
  maxAttempts: number,
  failureType: FailureType,
): boolean {
  // SYSTEM_ERROR and TIMEOUT always retry (not the user's fault)
  if (failureType === "SYSTEM_ERROR" || failureType === "TIMEOUT") {
    return attemptNumber < maxAttempts + 2; // extra attempts for system errors
  }
  // TASK_ERROR retries up to maxAttempts
  return attemptNumber < maxAttempts;
}
