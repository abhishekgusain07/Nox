export interface RetryConfig {
  maxAttempts?: number;
  minTimeout?: number;
  maxTimeout?: number;
  factor?: number;
}

export interface TaskConfig<TPayload = unknown, TOutput = unknown> {
  id: string;
  queue?: string;
  retry?: RetryConfig;
  run: (payload: TPayload) => Promise<TOutput>;
}

export interface TaskHandle<TPayload = unknown, TOutput = unknown> {
  id: string;
  queue?: string;
  retry?: RetryConfig;
  run: (payload: TPayload) => Promise<TOutput>;
}

/**
 * Define a task. This returns the task definition which is used by the worker
 * to register task handlers and by the SDK to trigger tasks.
 */
export function task<TPayload = unknown, TOutput = unknown>(
  config: TaskConfig<TPayload, TOutput>,
): TaskHandle<TPayload, TOutput> {
  return {
    id: config.id,
    queue: config.queue,
    retry: config.retry,
    run: config.run,
  };
}
