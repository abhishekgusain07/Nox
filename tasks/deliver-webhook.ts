import { task } from "@reload-dev/sdk/task";
import { createHmac, randomUUID } from "node:crypto";

interface WebhookPayload {
  targetUrl: string;
  event: string;
  data: Record<string, unknown>;
  secret?: string;
}

interface WebhookResult {
  delivered: boolean;
  statusCode: number;
  deliveryId: string;
  latencyMs: number;
  responseBody: string;
  deliveredAt: string;
}

export const deliverWebhook = task<WebhookPayload, WebhookResult>({
  id: "deliver-webhook",
  queue: "webhooks",
  retry: { maxAttempts: 5, minTimeout: 1000, maxTimeout: 60000, factor: 3 },
  run: async (payload) => {
    const { targetUrl, event, data, secret = "whsec_default" } = payload;
    const deliveryId = randomUUID();
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const body = JSON.stringify({
      id: deliveryId,
      event,
      data,
      timestamp: Number(timestamp),
    });

    // HMAC-SHA256 signature (same pattern as Stripe/GitHub webhooks)
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${body}`)
      .digest("hex");

    console.log(`[webhook] Delivering ${event} to ${targetUrl} (${deliveryId})`);

    const start = performance.now();
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Id": deliveryId,
        "X-Webhook-Timestamp": timestamp,
        "X-Webhook-Signature": `sha256=${signature}`,
        "User-Agent": "reload-dev-webhooks/1.0",
      },
      body,
      signal: AbortSignal.timeout(15000),
    });

    const latencyMs = Math.round(performance.now() - start);
    const responseBody = await res.text();
    const delivered = res.status >= 200 && res.status < 300;

    console.log(
      `[webhook] ${deliveryId} → ${res.status} (${latencyMs}ms) ${delivered ? "✓ delivered" : "✗ failed"}`,
    );

    if (!delivered) {
      throw new Error(
        `Webhook delivery failed: ${res.status} ${res.statusText} — ${responseBody.slice(0, 200)}`,
      );
    }

    return {
      delivered,
      statusCode: res.status,
      deliveryId,
      latencyMs,
      responseBody: responseBody.slice(0, 500),
      deliveredAt: new Date().toISOString(),
    };
  },
});
