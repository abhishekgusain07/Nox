import type { Context, Next } from "hono";
import type Redis from "ioredis";

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyFn: (c: Context) => string;
  message?: string;
}

export function createRateLimiter(redis: Redis, config: RateLimitConfig) {
  return async function rateLimitMiddleware(c: Context, next: Next) {
    const key = config.keyFn(c);
    const redisKey = `ratelimit:${key}`;

    try {
      const now = Date.now();
      const windowStart = now - config.windowMs;

      // Use Redis pipeline for atomic operations
      const pipeline = redis.pipeline();
      // Remove expired entries
      pipeline.zremrangebyscore(redisKey, 0, windowStart);
      // Count current entries in window
      pipeline.zcard(redisKey);
      // Add current request
      pipeline.zadd(redisKey, now, `${now}:${Math.random().toString(36).slice(2, 8)}`);
      // Set TTL so the key auto-expires
      pipeline.pexpire(redisKey, config.windowMs);

      const results = await pipeline.exec();

      // results[1] is the ZCARD result: [error, count]
      const countResult = results?.[1];
      const currentCount = (countResult && !countResult[0]) ? (countResult[1] as number) : 0;

      // Set rate limit headers
      const remaining = Math.max(0, config.maxRequests - currentCount - 1);
      const resetAt = Math.ceil((now + config.windowMs) / 1000);
      c.header("X-RateLimit-Limit", config.maxRequests.toString());
      c.header("X-RateLimit-Remaining", remaining.toString());
      c.header("X-RateLimit-Reset", resetAt.toString());

      if (currentCount >= config.maxRequests) {
        c.header("Retry-After", Math.ceil(config.windowMs / 1000).toString());
        return c.json({
          error: config.message ?? "Rate limit exceeded",
          retryAfter: Math.ceil(config.windowMs / 1000),
        }, 429);
      }
    } catch {
      // Redis is down — allow the request (fail open)
      // Better to serve than to block everyone
    }

    await next();
  };
}

/** Rate limit by API key ID — for authenticated endpoints */
export function rateLimitByApiKey(redis: Redis, maxRequests: number, windowMs: number = 60_000) {
  return createRateLimiter(redis, {
    windowMs,
    maxRequests,
    keyFn: (c) => `apikey:${c.get("apiKeyId") as string ?? "unknown"}`,
    message: "Too many requests. Please slow down.",
  });
}

/** Rate limit by IP — for unauthenticated endpoints (login, signup) */
export function rateLimitByIp(redis: Redis, maxRequests: number, windowMs: number = 60_000) {
  return createRateLimiter(redis, {
    windowMs,
    maxRequests,
    keyFn: (c) => {
      const forwarded = c.req.header("x-forwarded-for");
      const ip = forwarded?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "unknown";
      return `ip:${ip}`;
    },
    message: "Too many requests from this IP. Please try again later.",
  });
}
