import type { Context, Next } from "hono";

export function securityHeaders() {
  return async function (c: Context, next: Next) {
    await next();

    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("X-XSS-Protection", "0");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

    if (process.env.NODE_ENV === "production") {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  };
}

/** Reject payloads over maxBytes */
export function maxPayloadSize(maxBytes: number) {
  return async function (c: Context, next: Next) {
    const contentLength = c.req.header("content-length");
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      return c.json({ error: `Payload too large. Maximum size: ${Math.round(maxBytes / 1024 / 1024)}MB` }, 413);
    }
    await next();
  };
}

/** Add request ID for tracing */
export function requestId() {
  return async function (c: Context, next: Next) {
    const id = c.req.header("x-request-id") ?? crypto.randomUUID();
    c.set("requestId", id);
    c.header("X-Request-Id", id);
    await next();
  };
}
