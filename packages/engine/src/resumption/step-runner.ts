// SuspendExecution sentinel -- thrown to interrupt task execution
export class SuspendExecution {
  constructor(
    public readonly stepIndex: number,
    public readonly stepKey: string,
    public readonly waitpointType: string,
    public readonly waitpointData: unknown,
  ) {}
}

export type StepContext = {
  triggerAndWait: (taskId: string, payload: unknown) => Promise<unknown>;
  waitFor: (duration: { seconds: number }) => Promise<void>;
  waitForToken: (opts: { timeout?: string }) => Promise<unknown>;
  batchTriggerAndWait: (tasks: Array<{ taskId: string; payload: unknown }>) => Promise<unknown[]>;
};

export interface CompletedStep {
  stepIndex: number;
  stepKey: string;
  result: unknown;
}

export async function executeWithResumption(
  run: { id: string; payload: unknown },
  taskFn: (payload: unknown, ctx: StepContext) => Promise<unknown>,
  completedSteps: CompletedStep[],
): Promise<{ output: unknown } | { suspended: true; suspension: SuspendExecution }> {
  let currentStepIndex = 0;

  const ctx: StepContext = {
    triggerAndWait: async (taskId: string, payload: unknown) => {
      const myIndex = currentStepIndex++;
      const expectedKey = `triggerAndWait:${taskId}`;

      const cached = completedSteps.find((s) => s.stepIndex === myIndex);
      if (cached) {
        if (cached.stepKey !== expectedKey) {
          throw new Error(
            `Non-determinism detected at step ${myIndex}: ` +
            `expected "${cached.stepKey}", got "${expectedKey}". ` +
            `The task function must be deterministic during replay.`
          );
        }
        return cached.result;
      }

      throw new SuspendExecution(myIndex, expectedKey, "CHILD_RUN", { taskId, payload });
    },

    waitFor: async (duration: { seconds: number }) => {
      const myIndex = currentStepIndex++;
      const expectedKey = `wait:${duration.seconds}s`;

      const cached = completedSteps.find((s) => s.stepIndex === myIndex);
      if (cached) {
        if (cached.stepKey !== expectedKey) {
          throw new Error(`Non-determinism detected at step ${myIndex}`);
        }
        return;
      }

      throw new SuspendExecution(myIndex, expectedKey, "DURATION", duration);
    },

    waitForToken: async (opts: { timeout?: string }) => {
      const myIndex = currentStepIndex++;
      const expectedKey = `token:${myIndex}`;

      const cached = completedSteps.find((s) => s.stepIndex === myIndex);
      if (cached) {
        return cached.result;
      }

      throw new SuspendExecution(myIndex, expectedKey, "TOKEN", opts);
    },

    batchTriggerAndWait: async (tasks: Array<{ taskId: string; payload: unknown }>) => {
      const myIndex = currentStepIndex++;
      const expectedKey = `batch:${tasks.map((t) => t.taskId).join(",")}`;

      const cached = completedSteps.find((s) => s.stepIndex === myIndex);
      if (cached) {
        if (cached.stepKey !== expectedKey) {
          throw new Error(`Non-determinism detected at step ${myIndex}`);
        }
        return cached.result as unknown[];
      }

      throw new SuspendExecution(myIndex, expectedKey, "BATCH", tasks);
    },
  };

  try {
    const output = await taskFn(run.payload, ctx);
    return { output };
  } catch (e) {
    if (e instanceof SuspendExecution) {
      return { suspended: true, suspension: e };
    }
    throw e; // Real error -- let retry logic handle it
  }
}
