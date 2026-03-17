import { task } from "@reload-dev/sdk/task";

interface HealthCheckPayload {
  url: string;
  expectedStatus?: number;
  timeoutMs?: number;
}

interface HealthCheckResult {
  url: string;
  status: number;
  healthy: boolean;
  latencyMs: number;
  headers: Record<string, string>;
  contentLength: number | null;
  checkedAt: string;
}

export const siteHealthCheck = task<HealthCheckPayload, HealthCheckResult>({
  id: "site-health-check",
  queue: "monitoring",
  retry: { maxAttempts: 3, minTimeout: 2000, maxTimeout: 15000, factor: 2 },
  run: async (payload) => {
    const { url, expectedStatus = 200, timeoutMs = 10000 } = payload;
    console.log(`[health-check] Pinging ${url}...`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const start = performance.now();
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
        headers: { "User-Agent": "reload-dev-health-checker/1.0" },
      });

      const latencyMs = Math.round(performance.now() - start);
      const body = await res.text();
      const healthy = res.status === expectedStatus;

      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key] = value;
      });

      console.log(
        `[health-check] ${url} → ${res.status} (${latencyMs}ms) ${healthy ? "✓ healthy" : "✗ unhealthy"}`,
      );

      return {
        url,
        status: res.status,
        healthy,
        latencyMs,
        headers,
        contentLength: body.length,
        checkedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timeout);
    }
  },
});
