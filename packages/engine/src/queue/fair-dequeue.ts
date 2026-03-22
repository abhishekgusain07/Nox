import type { RedisQueue } from "./redis-queue.js";
import type { ConcurrencyTracker } from "./concurrency.js";

export interface DequeuedRun {
  runId: string;
  queueId: string;
}

export interface FairDequeueDeps {
  redisQueue: RedisQueue;
  concurrency: ConcurrencyTracker;
  getQueueLimit: (queueId: string) => Promise<number>;
  isQueuePaused: (queueId: string) => Promise<boolean>;
}

export async function fairDequeue(
  deps: FairDequeueDeps,
  maxRuns: number,
): Promise<DequeuedRun[]> {
  const { redisQueue, concurrency, getQueueLimit, isQueuePaused } = deps;

  const activeQueues = await redisQueue.getActiveQueues();
  if (activeQueues.length === 0) return [];

  const dequeued: DequeuedRun[] = [];
  const skippedQueues = new Set<string>();

  // Round-robin: cycle through queues, taking one from each
  let passes = 0;
  while (dequeued.length < maxRuns && passes < 5) {
    let madeProgress = false;

    for (const queueId of activeQueues) {
      if (dequeued.length >= maxRuns) break;
      if (skippedQueues.has(queueId)) continue;

      // Check if queue is paused
      const paused = await isQueuePaused(queueId);
      if (paused) {
        skippedQueues.add(queueId);
        continue;
      }

      // Try to pop from the queue
      const runIds = await redisQueue.dequeue(queueId, 1);
      if (runIds.length === 0) {
        skippedQueues.add(queueId);
        continue;
      }

      const runId = runIds[0]!;

      // Try to acquire a concurrency slot
      const limit = await getQueueLimit(queueId);
      const acquired = await concurrency.acquire(queueId, runId, limit);
      if (!acquired) {
        // Queue is at capacity — put the run back
        await redisQueue.enqueue(runId, queueId, 0);
        skippedQueues.add(queueId);
        continue;
      }

      dequeued.push({ runId, queueId });
      madeProgress = true;
    }

    if (!madeProgress) break;
    passes++;
  }

  return dequeued;
}
