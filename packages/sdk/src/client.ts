export interface TriggerOptions {
  queueId?: string;
  priority?: number;
  maxAttempts?: number;
  idempotencyKey?: string;
  concurrencyKey?: string;
  scheduledFor?: string;
  ttl?: number;
}

export interface TriggerResult {
  runId: string;
  existing?: boolean;
}

export interface RunStatus {
  id: string;
  projectId: string;
  taskId: string;
  queueId: string;
  status: string;
  payload: unknown;
  output: unknown | null;
  error: unknown | null;
  failureType: string | null;
  attemptNumber: number;
  maxAttempts: number;
  priority: number;
  version: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunEvent {
  id: string;
  runId: string;
  eventType: string;
  fromStatus: string | null;
  toStatus: string;
  workerId: string | null;
  attempt: number | null;
  reason: string | null;
  data: unknown;
  createdAt: string;
}

export class ReloadClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: { baseUrl: string; apiKey: string }) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    };
  }

  async trigger(
    taskId: string,
    payload: unknown = {},
    options?: TriggerOptions,
  ): Promise<TriggerResult> {
    const res = await fetch(`${this.baseUrl}/api/trigger`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ taskId, payload, options }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        `Failed to trigger task ${taskId}: ${res.status} ${JSON.stringify(body)}`,
      );
    }

    return res.json() as Promise<TriggerResult>;
  }

  async triggerAndWait(
    taskId: string,
    payload: unknown = {},
    options?: TriggerOptions & { timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<RunStatus> {
    const { runId } = await this.trigger(taskId, payload, options);
    const timeoutMs = options?.timeoutMs ?? 30_000;
    const pollIntervalMs = options?.pollIntervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;

    const terminalStatuses = ["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"];

    while (Date.now() < deadline) {
      const run = await this.getRun(runId);
      if (terminalStatuses.includes(run.status)) {
        return run;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Run ${runId} did not complete within ${timeoutMs}ms`);
  }

  async getRun(runId: string): Promise<RunStatus> {
    const res = await fetch(`${this.baseUrl}/api/runs/${runId}`, {
      headers: this.headers,
    });

    if (!res.ok) {
      throw new Error(`Failed to get run ${runId}: ${res.status}`);
    }

    return res.json() as Promise<RunStatus>;
  }

  async completeRun(
    runId: string,
    output: unknown = null,
  ): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/api/runs/${runId}/complete`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ output }),
    });

    if (!res.ok) {
      throw new Error(`Failed to complete run ${runId}: ${res.status}`);
    }

    return res.json() as Promise<{ ok: boolean }>;
  }

  async failRun(
    runId: string,
    error: { message: string; stack?: string },
    failureType: "TASK_ERROR" | "SYSTEM_ERROR" | "TIMEOUT" = "TASK_ERROR",
  ): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/api/runs/${runId}/fail`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ error, failureType }),
    });

    if (!res.ok) {
      throw new Error(`Failed to fail run ${runId}: ${res.status}`);
    }

    return res.json() as Promise<{ ok: boolean }>;
  }

  async cancelRun(
    runId: string,
    reason: string = "Manually cancelled",
  ): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/api/runs/${runId}/cancel`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ reason }),
    });

    if (!res.ok) {
      throw new Error(`Failed to cancel run ${runId}: ${res.status}`);
    }

    return res.json() as Promise<{ ok: boolean }>;
  }

  async getRunEvents(runId: string): Promise<{ events: RunEvent[] }> {
    const res = await fetch(`${this.baseUrl}/api/runs/${runId}/events`, {
      headers: this.headers,
    });

    if (!res.ok) {
      throw new Error(`Failed to get events for run ${runId}: ${res.status}`);
    }

    return res.json() as Promise<{ events: RunEvent[] }>;
  }

  async createQueue(
    id: string,
    concurrencyLimit: number = 10,
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/queues`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ id, concurrencyLimit }),
    });

    if (!res.ok) {
      throw new Error(`Failed to create queue ${id}: ${res.status}`);
    }
  }

  async registerTask(
    id: string,
    queueId: string = "default",
    retryConfig?: { maxAttempts?: number; minTimeout?: number; maxTimeout?: number; factor?: number },
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/tasks`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ id, queueId, retryConfig }),
    });

    if (!res.ok) {
      throw new Error(`Failed to register task ${id}: ${res.status}`);
    }
  }

  async sendHeartbeat(runId: string, workerId: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/runs/${runId}/heartbeat`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ workerId }),
    });
  }

  async registerWorker(
    workerId: string,
    taskTypes: string[],
    queueId: string = "default",
  ): Promise<void> {
    await fetch(`${this.baseUrl}/api/workers/register`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ workerId, taskTypes, queueId }),
    });
  }

  async deregisterWorker(workerId: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/workers/${workerId}/deregister`, {
      method: "POST",
      headers: this.headers,
    });
  }

  async suspendRun(
    runId: string,
    suspension: { stepIndex: number; stepKey: string; waitpointType: string; waitpointData: unknown },
  ): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/api/runs/${runId}/suspend`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(suspension),
    });
    if (!res.ok) throw new Error(`Failed to suspend run ${runId}: ${res.status}`);
    return res.json() as Promise<{ ok: boolean }>;
  }

  async resolveToken(token: string, result: unknown = null): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/api/waitpoints/${token}/complete`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ result }),
    });
    if (!res.ok) throw new Error(`Failed to resolve token ${token}: ${res.status}`);
    return res.json() as Promise<{ ok: boolean }>;
  }
}
