import type Redis from "ioredis";

const MAX_PRIORITY = 100;

export interface RedisQueue {
  enqueue(runId: string, queueId: string, priority?: number): Promise<void>;
  dequeue(queueId: string, limit?: number): Promise<string[]>;
  remove(queueId: string, runId: string): Promise<void>;
  depth(queueId: string): Promise<number>;
  getActiveQueues(): Promise<string[]>;
}

export function createRedisQueue(redis: Redis, projectId: string = ""): RedisQueue {
  // Namespace all keys by projectId to isolate multi-tenant data
  const prefix = projectId ? `${projectId}:` : "";

  return {
    async enqueue(runId: string, queueId: string, priority: number = 0): Promise<void> {
      const score = (MAX_PRIORITY - priority) * 1e13 + Date.now();
      await redis.zadd(`${prefix}queue:${queueId}`, score, runId);
      await redis.sadd(`${prefix}active-queues`, queueId);
    },

    async dequeue(queueId: string, limit: number = 1): Promise<string[]> {
      const results: string[] = [];
      for (let i = 0; i < limit; i++) {
        const item = await redis.zpopmin(`${prefix}queue:${queueId}`);
        if (!item || item.length === 0) break;
        results.push(item[0]!);
      }
      return results;
    },

    async remove(queueId: string, runId: string): Promise<void> {
      await redis.zrem(`${prefix}queue:${queueId}`, runId);
    },

    async depth(queueId: string): Promise<number> {
      return redis.zcard(`${prefix}queue:${queueId}`);
    },

    async getActiveQueues(): Promise<string[]> {
      return redis.smembers(`${prefix}active-queues`);
    },
  };
}
