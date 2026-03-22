# Redis Deep Dive — How reload.dev Uses Redis

> Every Redis key, command, data structure, Lua script, and architectural decision explained.

---

## Table of Contents

1. [Connection & Bootstrap](#1-connection--bootstrap)
2. [The Three Redis Subsystems](#2-the-three-redis-subsystems)
3. [Subsystem 1 — Priority Queue](#3-subsystem-1--priority-queue)
4. [Subsystem 2 — Concurrency Tracker](#4-subsystem-2--concurrency-tracker)
5. [Subsystem 3 — Rate Limiter](#5-subsystem-3--rate-limiter)
6. [Fair Dequeue Orchestration](#6-fair-dequeue-orchestration)
7. [Run Engine Integration](#7-run-engine-integration)
8. [Multi-Tenancy & Key Namespacing](#8-multi-tenancy--key-namespacing)
9. [Complete Key Reference](#9-complete-key-reference)
10. [Complete Command Inventory](#10-complete-command-inventory)
11. [What Redis Does NOT Do Here](#11-what-redis-does-not-do-here)
12. [Architectural Decisions & Trade-offs](#12-architectural-decisions--trade-offs)
13. [Potential Concerns & Future Work](#13-potential-concerns--future-work)

---

## 1. Connection & Bootstrap

**File:** `packages/server/src/index.ts` (lines 30, 39)

```typescript
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const redis = new Redis(REDIS_URL);
```

A single `ioredis` instance is created at server startup. This one connection is shared across all three subsystems:

| Consumer | What it does with `redis` |
|---|---|
| `createRedisQueue(redis, projectId)` | Priority queue for pending runs |
| `createConcurrencyTracker(redis, projectId)` | Concurrency slot management |
| `rateLimitByIp(redis)` / `rateLimitByApiKey(redis)` | Request rate limiting |

**Dependencies:**
- `ioredis ^5.4.0` in `packages/server`
- `ioredis ^5.10.0` in `packages/engine`

There is no connection pooling, no Redis Cluster/Sentinel, and no explicit error handlers on the connection object. If Redis goes down, each subsystem handles it differently (see individual sections).

---

## 2. The Three Redis Subsystems

Redis serves exactly **three purposes** in reload.dev. Each is independent and could be swapped out separately:

```
┌─────────────────────────────────────────────────────┐
│                   Redis Instance                     │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Priority     │  │ Concurrency  │  │ Rate       │ │
│  │ Queue        │  │ Tracker      │  │ Limiter    │ │
│  │              │  │              │  │            │ │
│  │ ZSET + SET   │  │ ZSET + Lua   │  │ ZSET +     │ │
│  │              │  │              │  │ Pipeline   │ │
│  └──────────────┘  └──────────────┘  └────────────┘ │
│                                                      │
│  All keys namespaced by projectId for multi-tenancy  │
└─────────────────────────────────────────────────────┘
```

All three use **Sorted Sets (ZSETs)** as their primary data structure, but for very different reasons.

---

## 3. Subsystem 1 — Priority Queue

**File:** `packages/engine/src/queue/redis-queue.ts`

### Purpose

Redis acts as a **fast, in-memory priority queue** for run scheduling. It sits alongside a PostgreSQL queue (`pg-queue.ts`) — runs are enqueued into *both*, and Redis is used for the hot path (dequeue) while Postgres is the durable source of truth.

### Data Structures

| Key Pattern | Redis Type | Contents |
|---|---|---|
| `{prefix}queue:{queueId}` | Sorted Set (ZSET) | Members = runId, Scores = priority+timestamp |
| `{prefix}active-queues` | Set (SET) | All queueIds that currently have pending work |

### The Score Formula

```typescript
const MAX_PRIORITY = 100;
const score = (MAX_PRIORITY - priority) * 1e13 + Date.now();
```

This is the key insight. The score encodes **two things** in a single number:

- **High bits (priority):** `(100 - priority) * 10_000_000_000_000` — lower priority value = higher position in queue. A run with priority `90` gets score `10 * 1e13 = 100_000_000_000_000`, while priority `0` gets `100 * 1e13 = 1_000_000_000_000_000`.
- **Low bits (timestamp):** `Date.now()` adds ~1.7e12 (current epoch ms). Since `1e13` is ~10x larger than the current timestamp, the priority portion always dominates.

**Result:** ZPOPMIN pops the lowest score first → highest priority runs are dequeued first. Within the same priority, earlier-submitted runs are dequeued first (FIFO within priority tier).

**Example scores:**
```
Priority 90, submitted at 1710800000000 → score =  100_000_000_000_000 + 1_710_800_000_000 =  101_710_800_000_000
Priority 50, submitted at 1710800000000 → score =  500_000_000_000_000 + 1_710_800_000_000 =  501_710_800_000_000
Priority  0, submitted at 1710800000000 → score = 1000_000_000_000_000 + 1_710_800_000_000 = 1001_710_800_000_000
```

ZPOPMIN returns lowest first → priority 90 is dequeued before priority 50.

### Operations In Detail

**enqueue(runId, queueId, priority = 0):**
```typescript
await redis.zadd(`${prefix}queue:${queueId}`, score, runId);
await redis.sadd(`${prefix}active-queues`, queueId);
```
Two commands, not atomic. The SADD is idempotent — if the queue is already in the active set, this is a no-op. If the server crashes between ZADD and SADD, the run is in the queue but the queue won't be discovered by `getActiveQueues()` until the next enqueue to that queue.

**dequeue(queueId, limit = 1):**
```typescript
const results: string[] = [];
for (let i = 0; i < limit; i++) {
  const item = await redis.zpopmin(`${prefix}queue:${queueId}`);
  if (!item || item.length === 0) break;
  results.push(item[0]!);
}
return results;
```
Loops `ZPOPMIN` one at a time. Each `ZPOPMIN` is atomic by itself (Redis is single-threaded), but the loop is **not** atomic across iterations. If two workers call `dequeue(q, 5)` concurrently, they interleave fine — each `ZPOPMIN` is guaranteed to pop a unique item. The non-atomicity only matters if you need "all or nothing" batching.

**remove(queueId, runId):**
```typescript
await redis.zrem(`${prefix}queue:${queueId}`, runId);
```
Used when cancelling a run that's still queued. `ZREM` on a non-existent member is a no-op.

**depth(queueId):**
```typescript
return redis.zcard(`${prefix}queue:${queueId}`);
```
O(1) operation — Redis caches the count.

**getActiveQueues():**
```typescript
return redis.smembers(`${prefix}active-queues`);
```
Returns all queue IDs that have ever had work enqueued. Note: queues are never removed from this set even when empty. The fair dequeue algorithm handles empty queues gracefully (ZPOPMIN returns nothing).

---

## 4. Subsystem 2 — Concurrency Tracker

**File:** `packages/engine/src/queue/concurrency.ts`

### Purpose

Limits how many runs execute simultaneously — per queue (global limit) and per concurrency key (per-user/per-entity limit). This prevents a single queue or tenant from monopolizing worker capacity.

### The Race Condition Problem

Without Lua, you'd write:

```typescript
// DANGEROUS — TOCTOU race
const count = await redis.zcard(key);  // Step 1: check
if (count < limit) {
  await redis.zadd(key, now, runId);   // Step 2: add
}
```

Between step 1 and step 2, another worker could also pass the check, causing both to exceed the limit. This is a classic **Time-of-Check-Time-of-Use (TOCTOU)** race.

### The Lua Solution

```lua
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
```

Lua scripts execute **atomically** in Redis — the entire script runs without any other command interleaving. This eliminates the race: check + add happen as one indivisible operation.

**Arguments:**
- `KEYS[1]` — the concurrency tracking key
- `ARGV[1]` — the concurrency limit
- `ARGV[2]` — the runId (ZSET member)
- `ARGV[3]` — current timestamp (ZSET score, used for debugging/monitoring — you can `ZRANGEBYSCORE` to see how long slots have been held)

**Return:** `1` (slot acquired) or `0` (at capacity)

### Data Structures

| Key Pattern | Redis Type | Contents |
|---|---|---|
| `{prefix}concurrency:queue:{queueId}` | Sorted Set | Members = runId, Scores = timestamp of acquisition |
| `{prefix}concurrency:key:{queueId}:{concurrencyKey}` | Sorted Set | Same structure, scoped to a concurrency key |

### Two Levels of Concurrency

**Queue-level** (`acquire`): "This queue can have at most N runs executing globally."
```typescript
async acquire(queueId, runId, limit) {
  return acquireSlot(`${prefix}concurrency:queue:${queueId}`, limit, runId);
}
```

**Key-level** (`acquireWithKey`): "Within this queue, a given concurrency key (e.g., a userId) can have at most M runs executing."
```typescript
async acquireWithKey(queueId, concurrencyKey, runId, keyLimit) {
  return acquireSlot(
    `${prefix}concurrency:key:${queueId}:${concurrencyKey}`,
    keyLimit,
    runId,
  );
}
```

### Release Operations

**release / releaseWithKey:** Single `ZREM` call to remove the runId from the tracking set.

**releaseAll:** Removes from *both* queue-level and key-level sets in one call:
```typescript
async releaseAll(queueId, concurrencyKey, runId) {
  await redis.zrem(`${prefix}concurrency:queue:${queueId}`, runId);
  if (concurrencyKey) {
    await redis.zrem(`${prefix}concurrency:key:${queueId}:${concurrencyKey}`, runId);
  }
}
```

This is called by the run engine when a `ReleaseConcurrency` side effect fires (run completes, fails, or is cancelled).

### Monitoring

```typescript
async currentCount(queueId) {
  return redis.zcard(`${prefix}concurrency:queue:${queueId}`);
}

async currentKeyCount(queueId, concurrencyKey) {
  return redis.zcard(`${prefix}concurrency:key:${queueId}:${concurrencyKey}`);
}
```

---

## 5. Subsystem 3 — Rate Limiter

**File:** `packages/server/src/middleware/rate-limit.ts`

### Purpose

Protect the server from abuse. Two independent rate limits:

| Middleware | Applied To | Key | Limit | Window |
|---|---|---|---|---|
| `rateLimitByIp` | `/api/auth/*` | `ratelimit:ip:{ip}` | 20 requests | 60 seconds |
| `rateLimitByApiKey` | `/api/*` (after auth) | `ratelimit:apikey:{keyId}` | 200 requests | 60 seconds |

### The Sliding Window Algorithm

This is a **sliding window** implementation using sorted sets, more accurate than fixed-window counters:

```typescript
const now = Date.now();
const windowStart = now - config.windowMs;

const pipeline = redis.pipeline();
pipeline.zremrangebyscore(redisKey, 0, windowStart);  // 1. Evict expired
pipeline.zcard(redisKey);                             // 2. Count remaining
pipeline.zadd(redisKey, now, `${now}:${uuid}`);       // 3. Record this request
pipeline.pexpire(redisKey, config.windowMs);           // 4. Auto-cleanup TTL
const results = await pipeline.exec();
```

Step by step:

1. **ZREMRANGEBYSCORE** — removes all entries with scores (timestamps) older than `now - windowMs`. This "slides" the window forward.
2. **ZCARD** — counts how many requests remain in the window *after* eviction.
3. **ZADD** — adds the current request. Member = `${timestamp}:${uuid}` to ensure uniqueness even for same-millisecond requests. Score = timestamp.
4. **PEXPIRE** — sets a millisecond-precision TTL so the entire key is cleaned up if no requests come in for an entire window duration. This prevents orphaned keys from accumulating.

All four commands run in a single **pipeline** — they're sent to Redis as one batch, reducing network round trips from 4 to 1. However, a pipeline is **not a transaction** (no atomicity guarantee between commands), but for rate limiting this is fine because:
- Worst case: a small window where count is slightly off
- The window auto-corrects on the next request

### Fail-Open Design

```typescript
try {
  // ... pipeline logic ...
} catch {
  return next(); // Fail open — allow request if Redis is down
}
```

If Redis is unreachable, the rate limiter **does not block requests**. This is a deliberate choice: availability > strict rate enforcement. The server stays up even if Redis crashes.

### IP Extraction

```typescript
function getIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? c.req.header("x-real-ip")
    ?? "unknown";
}
```

Handles reverse proxies by checking `x-forwarded-for` first (takes the leftmost IP if chained), then `x-real-ip`, then falls back to `"unknown"`.

---

## 6. Fair Dequeue Orchestration

**File:** `packages/engine/src/queue/fair-dequeue.ts`

This file doesn't call Redis directly but orchestrates the queue and concurrency subsystems:

```
fairDequeue() algorithm:
│
├─ 1. redisQueue.getActiveQueues()        ← SMEMBERS
│
├─ 2. For each queue (round-robin, up to 5 passes):
│   │
│   ├─ 3. Check if queue is paused       ← PostgreSQL query
│   │
│   ├─ 4. redisQueue.dequeue(queueId, 1) ← ZPOPMIN
│   │
│   ├─ 5. concurrency.acquire(...)        ← EVAL (Lua script)
│   │   │
│   │   ├─ If acquired → add to results
│   │   │
│   │   └─ If at capacity → re-enqueue
│   │       redisQueue.enqueue(runId, queueId, priority) ← ZADD + SADD
│   │
│   └─ Continue to next queue
│
└─ Return dequeued runIds
```

The round-robin approach ensures fairness: no single queue can starve others. The algorithm cycles through all active queues, taking one run at a time from each, until it has enough runs or exhausts all queues.

---

## 7. Run Engine Integration

**File:** `packages/engine/src/run-engine.ts`

The run engine uses a **functional core / imperative shell** pattern. The pure state machine (`computeTransition()`) returns side effects as data. The engine then executes those effects, and two of them touch Redis:

### EnqueueRun Effect

```typescript
case "EnqueueRun":
  await pgQueue.enqueue(effect.runId);
  if (redisQueue) {
    await redisQueue.enqueue(effect.runId, effect.queueId, effect.priority);
  }
  break;
```

Dual-write: the run is enqueued into both PostgreSQL (durable) and Redis (fast). Redis is optional — the `if (redisQueue)` guard means the system works without Redis, just slower (PG-only dequeue via `SELECT FOR UPDATE SKIP LOCKED`).

### ReleaseConcurrency Effect

```typescript
case "ReleaseConcurrency":
  if (concurrency) {
    await concurrency.releaseAll(
      effect.queueId,
      run.concurrencyKey ?? null,
      effect.runId,
    );
  }
  break;
```

When a run reaches a terminal state (COMPLETED, FAILED, CANCELLED, CRASHED), the state machine emits a `ReleaseConcurrency` effect. The engine calls `releaseAll()` to free both the queue-level and key-level concurrency slots.

### Server Route: POST /api/dequeue/fair

```typescript
// packages/server/src/routes/index.ts
app.post("/api/dequeue/fair", async (c) => {
  if (!redisQueue || !concurrency) {
    return c.json({ error: "Redis queue not configured" }, 503);
  }
  const { limit } = await c.req.json();
  const runIds = await fairDequeue(
    { redisQueue, concurrency, db, projectId },
    limit,
  );
  // ... transition each to EXECUTING ...
});
```

---

## 8. Multi-Tenancy & Key Namespacing

Every Redis subsystem (queue + concurrency) takes an optional `projectId` parameter:

```typescript
export function createRedisQueue(redis: Redis, projectId: string = ""): RedisQueue {
  const prefix = projectId ? `${projectId}:` : "";
  // All keys: `${prefix}queue:${queueId}`, `${prefix}active-queues`
}

export function createConcurrencyTracker(redis: Redis, projectId: string = ""): ConcurrencyTracker {
  const prefix = projectId ? `${projectId}:` : "";
  // All keys: `${prefix}concurrency:queue:${queueId}`, etc.
}
```

**With projectId `proj_abc123`:**
```
proj_abc123:queue:my-queue
proj_abc123:active-queues
proj_abc123:concurrency:queue:my-queue
proj_abc123:concurrency:key:my-queue:user-42
```

**Without projectId (backward compatible):**
```
queue:my-queue
active-queues
concurrency:queue:my-queue
```

Rate limiter keys are **not** namespaced by project — they're global because rate limiting applies per-IP or per-API-key, not per-project.

---

## 9. Complete Key Reference

| Key Pattern | Type | Subsystem | TTL | Contents |
|---|---|---|---|---|
| `{prefix}queue:{queueId}` | ZSET | Priority Queue | None | runIds scored by priority+timestamp |
| `{prefix}active-queues` | SET | Priority Queue | None | All queueIds with pending work |
| `{prefix}concurrency:queue:{queueId}` | ZSET | Concurrency | None | runIds scored by acquisition timestamp |
| `{prefix}concurrency:key:{queueId}:{key}` | ZSET | Concurrency | None | runIds scored by acquisition timestamp |
| `ratelimit:ip:{ip}` | ZSET | Rate Limiter | 60s (PEXPIRE) | `{timestamp}:{uuid}` entries |
| `ratelimit:apikey:{keyId}` | ZSET | Rate Limiter | 60s (PEXPIRE) | `{timestamp}:{uuid}` entries |

**Note:** Only rate limiter keys have TTLs. Queue and concurrency keys persist indefinitely — they grow and shrink as runs are enqueued/completed.

---

## 10. Complete Command Inventory

### Sorted Set Commands
| Command | Where Used | Purpose |
|---|---|---|
| `ZADD` | Queue enqueue, Rate limiter, Concurrency acquire (via Lua) | Add member with score |
| `ZPOPMIN` | Queue dequeue | Pop lowest-scored member (highest priority) |
| `ZREM` | Queue remove, Concurrency release | Remove specific member |
| `ZCARD` | Queue depth, Concurrency count, Concurrency acquire (via Lua) | Count members |
| `ZREMRANGEBYSCORE` | Rate limiter | Evict entries outside sliding window |

### Set Commands
| Command | Where Used | Purpose |
|---|---|---|
| `SADD` | Queue enqueue | Track active queue |
| `SMEMBERS` | Queue getActiveQueues | List all active queues |

### Key Commands
| Command | Where Used | Purpose |
|---|---|---|
| `PEXPIRE` | Rate limiter | Auto-cleanup stale rate limit keys |

### Scripting & Batching
| Command | Where Used | Purpose |
|---|---|---|
| `EVAL` | Concurrency acquire | Atomic check-and-add via Lua script |
| `PIPELINE` + `EXEC` | Rate limiter | Batch 4 commands into 1 round trip |

### Commands NOT Used
| Command Family | Why Not |
|---|---|
| `GET/SET/MGET/MSET` | No simple key-value storage needed |
| `HSET/HGET` | No hash maps needed |
| `PUBLISH/SUBSCRIBE` | Using PostgreSQL LISTEN/NOTIFY for SSE instead |
| `XADD/XREAD` | Sorted sets chosen over streams for priority support |
| `LPUSH/RPOP` | Lists don't support priority ordering |
| `MULTI/EXEC` (transactions) | Lua scripts used instead for atomicity |
| `WATCH` | Optimistic locking done in PostgreSQL, not Redis |

---

## 11. What Redis Does NOT Do Here

It's worth noting what Redis is **not** used for:

| Concern | Where It Lives Instead |
|---|---|
| **Durable run storage** | PostgreSQL (`runs` table) |
| **Run state machine** | PostgreSQL (optimistic locking with version field) |
| **Primary queue** | PostgreSQL (`SELECT FOR UPDATE SKIP LOCKED`) |
| **Real-time events (SSE)** | PostgreSQL (`LISTEN/NOTIFY`) |
| **Sessions** | PostgreSQL (better-auth session table) |
| **Authentication** | PostgreSQL (API keys, users) |
| **Bundle/deployment storage** | PostgreSQL (bytea column) |
| **Audit logs** | PostgreSQL (`audit_logs` table) |

Redis is purely a **performance layer** and a **coordination primitive**. If Redis goes down:
- Rate limiting fails open (requests still served)
- Fair dequeue returns 503 (workers fall back to PG-based dequeue)
- Concurrency limits are unenforced until Redis returns
- All state is reconstructable from PostgreSQL

---

## 12. Architectural Decisions & Trade-offs

### Why Sorted Sets for Everything?

All three subsystems use ZSETs despite having different needs:

| Subsystem | Why ZSET? |
|---|---|
| **Queue** | Score encodes priority + timestamp → natural ordering for `ZPOPMIN` |
| **Concurrency** | Score = timestamp → `ZCARD` gives count, members give "who holds a slot" |
| **Rate Limiter** | Score = timestamp → `ZREMRANGEBYSCORE` evicts old entries by time range |

Alternatives considered and why they're worse:
- **Lists (LPUSH/RPOP)**: No priority support, can't remove by value efficiently
- **Streams (XADD/XREAD)**: Better for log-style consumption, worse for priority ordering
- **Simple counters (INCR)**: Can't do sliding windows, can't track which runs hold slots

### Why Lua Over MULTI/EXEC?

Redis transactions (`MULTI/EXEC`) don't support conditional logic — you can't read a value and decide whether to write based on it. Lua scripts can. The concurrency tracker needs "if count < limit then add" which requires reading and conditionally writing, making Lua the only option.

### Why Pipeline (Not Transaction) for Rate Limiting?

The rate limiter's 4 commands don't need strict atomicity. Even if another request's commands interleave:
- Extra entries get cleaned up next request (ZREMRANGEBYSCORE)
- The PEXPIRE refreshes correctly regardless of order
- Worst case: one extra request squeaks through on a boundary — acceptable for rate limiting

### Why Dual-Write (PG + Redis)?

```
Trigger run → enqueue to PG (durable) + Redis (fast)
Dequeue    → Redis preferred (ZPOPMIN), PG fallback (SKIP LOCKED)
```

- **Redis**: Sub-millisecond dequeue, priority ordering, concurrency checking
- **PostgreSQL**: Durable, survives Redis failure, source of truth for recovery
- The dual-write means Redis can be treated as disposable — flush it and everything rebuilds from PG state

### Why Not Redis Pub/Sub for SSE?

PostgreSQL `LISTEN/NOTIFY` was chosen over Redis `PUBLISH/SUBSCRIBE` because:
1. Run state changes are already committed to PostgreSQL — emitting NOTIFY in the same transaction guarantees the listener sees consistent data
2. One fewer failure mode (no Redis dependency for real-time features)
3. PG NOTIFY payloads can be trusted to reflect committed state

---

## 13. Potential Concerns & Future Work

### No Cleanup for Queue/Concurrency Keys

Rate limiter keys auto-expire via `PEXPIRE`. Queue and concurrency keys **never expire**:
- `active-queues` SET grows monotonically (queues are added but never removed)
- Concurrency ZSET entries are only removed by explicit `ZREM` calls

**Risk:** If `releaseAll()` is never called (server crash between run start and completion), concurrency slots leak. A crashed run holds its slot forever.

**Mitigation (future):** Add a periodic janitor that compares concurrency ZSET members against actual run states in PostgreSQL, removing entries for runs that are already terminal.

### Non-Atomic Multi-Item Dequeue

`dequeue(queueId, limit)` loops `ZPOPMIN` calls. With a single scheduler this is fine. With multiple schedulers, two could pop the same queue concurrently — each pop is atomic, but the batch isn't.

**Mitigation (future):** Replace the loop with a Lua script that does N `ZPOPMIN`s atomically.

### Single Redis Instance

No clustering, no sentinel, no replicas. Single point of failure for the performance layer.

**Mitigation (future):** Either Redis Sentinel for HA, or Redis Cluster for horizontal scaling. The key namespacing pattern is already cluster-friendly (hash tags could be added).

### No Backpressure from Redis to Server

If Redis is slow (high memory, swapping), the server doesn't adapt. It keeps sending commands and waiting.

**Mitigation (future):** Add timeouts on Redis commands, circuit breaker pattern.

### Rate Limiter Not Distributed-Safe

Each server instance runs its own rate limit check. With multiple server instances behind a load balancer, the limit is per-instance, not global (since they share the same Redis, it actually IS global — but if a request fails over to a different Redis, limits reset).

---

*This document reflects the state of the codebase as of the latest implementation. All file paths and line numbers reference the current source.*
