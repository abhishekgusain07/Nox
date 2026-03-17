import type Redis from "ioredis";

// Lua script: atomically check count + add if under limit
// This eliminates the TOCTOU race between ZCARD and ZADD
const ACQUIRE_SCRIPT = `
  local key = KEYS[1]
  local limit = tonumber(ARGV[1])
  local runId = ARGV[2]
  local now = tonumber(ARGV[3])

  local count = redis.call('ZCARD', key)
  if count >= limit then
    return 0
  end

  redis.call('ZADD', key, now, runId)
  return 1
`;

export interface ConcurrencyTracker {
  acquire(queueId: string, runId: string, limit: number): Promise<boolean>;
  acquireWithKey(queueId: string, concurrencyKey: string, runId: string, keyLimit: number): Promise<boolean>;
  release(queueId: string, runId: string): Promise<void>;
  releaseWithKey(queueId: string, concurrencyKey: string, runId: string): Promise<void>;
  releaseAll(queueId: string, concurrencyKey: string | null, runId: string): Promise<void>;
  currentCount(queueId: string): Promise<number>;
  currentKeyCount(queueId: string, concurrencyKey: string): Promise<number>;
}

export function createConcurrencyTracker(redis: Redis): ConcurrencyTracker {
  async function acquireSlot(key: string, limit: number, runId: string): Promise<boolean> {
    const result = await redis.eval(
      ACQUIRE_SCRIPT,
      1,
      key,
      limit.toString(),
      runId,
      Date.now().toString(),
    );
    return result === 1;
  }

  return {
    async acquire(queueId: string, runId: string, limit: number): Promise<boolean> {
      return acquireSlot(`concurrency:queue:${queueId}`, limit, runId);
    },

    async acquireWithKey(
      queueId: string,
      concurrencyKey: string,
      runId: string,
      keyLimit: number,
    ): Promise<boolean> {
      return acquireSlot(
        `concurrency:key:${queueId}:${concurrencyKey}`,
        keyLimit,
        runId,
      );
    },

    async release(queueId: string, runId: string): Promise<void> {
      await redis.zrem(`concurrency:queue:${queueId}`, runId);
    },

    async releaseWithKey(queueId: string, concurrencyKey: string, runId: string): Promise<void> {
      await redis.zrem(`concurrency:key:${queueId}:${concurrencyKey}`, runId);
    },

    async releaseAll(queueId: string, concurrencyKey: string | null, runId: string): Promise<void> {
      await redis.zrem(`concurrency:queue:${queueId}`, runId);
      if (concurrencyKey) {
        await redis.zrem(`concurrency:key:${queueId}:${concurrencyKey}`, runId);
      }
    },

    async currentCount(queueId: string): Promise<number> {
      return redis.zcard(`concurrency:queue:${queueId}`);
    },

    async currentKeyCount(queueId: string, concurrencyKey: string): Promise<number> {
      return redis.zcard(`concurrency:key:${queueId}:${concurrencyKey}`);
    },
  };
}
