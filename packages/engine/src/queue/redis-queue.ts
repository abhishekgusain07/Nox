import type Redis from "ioredis";

const MAX_PRIORITY = 100;

export interface RedisQueue {
  enqueue(runId: string, queueId: string, priority?: number): Promise<void>;
  dequeue(queueId: string, limit?: number): Promise<string[]>;
  remove(queueId: string, runId: string): Promise<void>;
  depth(queueId: string): Promise<number>;
  getActiveQueues(): Promise<string[]>;
}

export function createRedisQueue(redis: Redis): RedisQueue {
  return {
    async enqueue(runId: string, queueId: string, priority: number = 0): Promise<void> {
      // Score formula: lower score = dequeued first
      // (MAX_PRIORITY - priority) puts high-priority items first
      // * 1e13 ensures priority bands don't overlap with timestamps
      // + Date.now() gives FIFO within the same priority band
      const score = (MAX_PRIORITY - priority) * 1e13 + Date.now();
      await redis.zadd(`queue:${queueId}`, score, runId);
      await redis.sadd("active-queues", queueId);
    },

    async dequeue(queueId: string, limit: number = 1): Promise<string[]> {
      const results: string[] = [];
      for (let i = 0; i < limit; i++) {
        // ZPOPMIN: atomically remove and return the lowest-scored item
        const item = await redis.zpopmin(`queue:${queueId}`);
        if (!item || item.length === 0) break;
        results.push(item[0]!); // item is [member, score]
      }
      return results;
    },

    async remove(queueId: string, runId: string): Promise<void> {
      await redis.zrem(`queue:${queueId}`, runId);
    },

    async depth(queueId: string): Promise<number> {
      return redis.zcard(`queue:${queueId}`);
    },

    async getActiveQueues(): Promise<string[]> {
      return redis.smembers("active-queues");
    },
  };
}
