# Phase 3: Concurrency + Fair Queuing — Deep-Dive Learning Document

**Goal**: Implement Redis-backed concurrency tracking, fair multi-queue dequeuing, and priority scheduling for reload.dev.

---

## Table of Contents

1. [Redis Sorted Sets (ZADD, ZPOPMIN, ZCARD, ZRANGEBYSCORE)](#1-redis-sorted-sets)
2. [Redis Lua Scripts — Atomic Multi-Step Operations](#2-redis-lua-scripts--atomic-multi-step-operations)
3. [TOCTOU (Time-of-Check-to-Time-of-Use) Race Conditions](#3-toctou-time-of-check-to-time-of-use-race-conditions)
4. [Fair Scheduling Algorithms](#4-fair-scheduling-algorithms)
5. [Two-Level Concurrency (Queue + Key)](#5-two-level-concurrency-queue--key)
6. [Priority Queue Design](#6-priority-queue-design)

---

## 1. Redis Sorted Sets

### What Is a Sorted Set?

A Redis sorted set is a collection of unique members (strings), each associated with a floating-point **score**. The members are always kept in sorted order by score. If two members have the same score, they are ordered lexicographically. This makes sorted sets a hybrid between a set (uniqueness) and a list (ordering), but with logarithmic-time insertion rather than the linear-time insertion of a sorted list.

**How it differs from regular sets and lists:**

| Property          | List (LPUSH/RPUSH) | Set (SADD) | Sorted Set (ZADD) |
| ----------------- | ------------------ | ---------- | ------------------ |
| Ordering          | Insertion order    | None       | By score           |
| Uniqueness        | No                 | Yes        | Yes                |
| Access by index   | O(N)               | No         | O(log N)           |
| Access by score   | No                 | No         | O(log N)           |
| Insert complexity | O(1)               | O(1)       | O(log N)           |

A list is great for simple FIFO queues but cannot sort by priority. A set guarantees uniqueness but has no ordering. A sorted set gives you both: uniqueness of members plus ordering by an arbitrary score.

### Internal Data Structure: Skip List + Hash Table Hybrid

Redis sorted sets use a **dual data structure** internally:

1. **Skip List** — Maintains elements in sorted order by score. A skip list is a probabilistic data structure built on top of a sorted linked list. Instead of just having pointers to the next node (which makes search O(N)), it has additional "express lane" pointers to nodes further ahead. Conceptually, imagine a subway system: the local train stops at every station (level 0), while express trains skip stations (levels 1, 2, 3...). To find a station, you ride the express as far as you can, then switch to local. This gives O(log N) search, insertion, and deletion on average.

2. **Hash Table** — Maps member names to their scores. This allows O(1) lookups by member name (e.g., `ZSCORE key member`).

**Why O(log N) for inserts:**
When you `ZADD`, Redis must find the correct position in the skip list to insert the new element. The skip list's multi-level structure means the search traverses O(log N) nodes on average. The hash table update is O(1). Combined: O(log N).

**Why O(1) for ZCARD:**
Redis maintains a counter of elements in the sorted set. `ZCARD` simply returns this counter without traversing the data structure.

**Why Antirez (Salvatore Sanfilippo) chose skip lists over balanced trees:**
Skip lists are simpler to implement, easier to reason about concurrently, have similar average-case performance to balanced BSTs, and are more cache-friendly for range operations. They also allow easy implementation of `ZRANGEBYSCORE` — you just walk forward from the start position.

### How ZADD Works

```
ZADD key score member [score member ...]
```

- If `member` does not exist in the sorted set, it is inserted with the given `score`.
- If `member` already exists, its **score is updated** to the new value and the element is re-positioned in the skip list. The old score is discarded.
- Returns the number of **new** elements added (not updated).

Flags modify behavior:
- `NX` — Only add new elements; never update existing scores.
- `XX` — Only update existing elements; never add new ones.
- `GT` — Only update existing elements if the new score is **greater** than the current score.
- `LT` — Only update existing elements if the new score is **less** than the current score.

**Duplicate member behavior is critical for our use case:** When a run is re-enqueued (e.g., after a failed attempt), `ZADD` with the same run ID will update the score (priority), not create a duplicate. This prevents queue pollution.

### How ZPOPMIN Works

```
ZPOPMIN key [count]
```

Atomically removes and returns the member(s) with the **lowest score**. "Atomically" means no other client can see the sorted set in a state where the element has been read but not yet removed. This is critical for task queues — without atomicity, two workers could pop the same item.

If the sorted set is empty, ZPOPMIN returns an empty array. If `count` is specified, it removes up to `count` elements.

**Why ZPOPMIN is perfect for priority queues:** The lowest score represents the highest priority (we design our scoring so that more urgent items have lower scores). ZPOPMIN gives us atomic dequeue of the most important item.

### How ZRANGEBYSCORE Works

```
ZRANGEBYSCORE key min max [LIMIT offset count]
```

Returns all members with scores between `min` and `max` (inclusive by default). Use `(` prefix for exclusive bounds: `ZRANGEBYSCORE key (1 5` returns scores > 1 and <= 5. Special values `-inf` and `+inf` represent negative and positive infinity.

**Use in reload.dev:** We can query "all runs with priority higher than X" or "all runs enqueued before timestamp Y" without removing them from the set.

### Why Sorted Sets Are Perfect for Priority Queues

1. **Score = priority**: Assign a numeric score that encodes priority. Lower score = higher priority.
2. **ZPOPMIN = dequeue**: Atomically removes the highest-priority item.
3. **ZADD = enqueue**: O(log N) insertion, automatically sorted.
4. **ZCARD = queue depth**: O(1) to check how many items are waiting.
5. **ZRANGEBYSCORE = inspection**: See what is in the queue without removing items.
6. **Deduplication for free**: Same member cannot appear twice (important for idempotent enqueue).

### The Score Formula for reload.dev

```typescript
const score = (MAX_PRIORITY - priority) * 1e13 + Date.now();
```

Let us break this down piece by piece:

**Why subtract from MAX_PRIORITY?**
If `MAX_PRIORITY = 10` and a run has `priority = 8`, the score becomes `(10 - 8) * 1e13 + timestamp = 2e13 + timestamp`. A run with `priority = 3` gets `7e13 + timestamp`. Since ZPOPMIN returns the *lowest* score first, the `priority = 8` run (score ~2e13) dequeues before the `priority = 3` run (score ~7e13). Higher priority number = lower score = dequeued first.

**Why 1e13 (10 trillion)?**
`Date.now()` returns milliseconds since epoch, currently around 1.7e12 (1.7 trillion). By multiplying the priority band by 1e13, we create **non-overlapping bands**:

| Priority | Band start       | Band end         |
| -------- | ---------------- | ---------------- |
| 10       | 0e13 + 0         | 0e13 + 9.99e12   |
| 9        | 1e13 + 0         | 1e13 + 9.99e12   |
| 8        | 2e13 + 0         | 2e13 + 9.99e12   |
| ...      | ...              | ...              |
| 0        | 10e13 + 0        | 10e13 + 9.99e12  |

Since `Date.now()` maxes out around ~1.7e12 (and will not reach 1e13 until the year 2286), priority bands **never overlap**. All priority-10 items have scores below 1e13. All priority-9 items have scores between 1e13 and 2e13. They can never interleave. Within each band, items are ordered by timestamp (FIFO).

**Why not just `priority * -1`?**
Because then all items at the same priority level would have the same score, and ZPOPMIN would return them in undefined (lexicographic) order rather than FIFO.

### Comparison to Alternative Approaches

**Redis Lists (LPUSH/BRPOP):**
Simple FIFO queues. `BRPOP` blocks until an item is available — useful for worker polling. But no priority support. No O(1) size check (actually `LLEN` is O(1)). No deduplication. Good for simple job queues, not for priority scheduling.

**Redis Streams (XADD/XREADGROUP):**
Consumer group support, message acknowledgment, replay capability. More complex than sorted sets but better for pub/sub patterns. Overkill for our priority queue — we do not need consumer groups or message replay.

**PostgreSQL SKIP LOCKED:**
```sql
SELECT * FROM tasks
WHERE status = 'pending'
ORDER BY priority DESC, created_at ASC
FOR UPDATE SKIP LOCKED
LIMIT 1;
```
Rows locked by other transactions are skipped, so each worker gets a different task. ACID guarantees prevent data loss. But: requires a database round-trip, row-level locking has overhead, and at high throughput the lock contention becomes significant. Redis sorted sets handle millions of operations per second with sub-millisecond latency. PostgreSQL SKIP LOCKED is excellent when you are already using PostgreSQL and do not want another infrastructure dependency, but Redis wins on raw throughput for dedicated queue workloads.

### Performance

Redis sorted sets can handle **millions of items** with sub-millisecond operations:

- A benchmark of 6 million entries achieved ~132k ZRANGE operations/second.
- ZADD, ZPOPMIN, and ZRANGEBYSCORE all operate in O(log N). With 1 million items, log2(1,000,000) ~ 20. That is 20 comparisons per operation — trivial for modern CPUs.
- Memory overhead is approximately 100 bytes per element (skip list node overhead), so 1 million items ~ 100MB overhead beyond the member data itself.
- Standard Redis benchmarks show 99.76% of operations completing under 1ms.

For reload.dev, even with tens of thousands of queued runs, sorted set operations will be well under 1ms.

### Resources

- [Redis Sorted Sets Documentation](https://redis.io/docs/latest/develop/data-types/sorted-sets/)
- [ZADD Command Reference](https://redis.io/docs/latest/commands/zadd/)
- [Redis Sorted Sets and Skip Lists (Medium)](https://mecha-mind.medium.com/redis-sorted-sets-and-skip-lists-4f849d188a33)
- [Redis Sorted Sets — Under the Hood](https://jothipn.github.io/2023/04/07/redis-sorted-set.html)
- [How is the Redis Sorted Set Implemented?](https://jameshfisher.com/2018/04/22/redis-sorted-set/)
- [Redis Sorted Set Source Code (t_zset.c)](https://github.com/redis/redis/blob/unstable/src/t_zset.c)
- [Redis Sorted Sets Best Practices (Dragonfly)](https://www.dragonflydb.io/guides/redis-sorted-sets-best-practices)

### Test Questions

1. You have a sorted set with 1 million members. What is the time complexity of `ZADD`? What about `ZCARD`? Why are they different?
2. If you call `ZADD myset 5.0 "task-42"` and "task-42" already exists with score 3.0, what happens? What does ZADD return?
3. Explain why the multiplier in our score formula must be larger than `Date.now()`. What would happen if we used `1e11` instead of `1e13`?
4. Two workers both call `ZPOPMIN` at the exact same time. Can they receive the same element? Why or why not?
5. Why did Antirez choose skip lists over red-black trees for Redis sorted sets? Name at least two reasons.
6. You need a queue where items can be re-prioritized after insertion. Can a Redis sorted set support this? How?
7. Compare `BRPOP` on a Redis list to `ZPOPMIN` on a sorted set. When would you prefer each?

---

## 2. Redis Lua Scripts — Atomic Multi-Step Operations

### The Fundamental Problem: Command Sequences Are Not Atomic

Individual Redis commands are atomic. When you call `ZADD`, no other client can see a half-completed state. But a **sequence** of commands is NOT atomic. Between your `SCARD` (check set size) and `SADD` (add to set), another client can execute their own commands.

Consider this pseudocode for enforcing a concurrency limit of 5:

```
count = SCARD("active_runs")     # Returns 4
if count < 5:
    SADD("active_runs", "run-99") # Add the run
```

The race condition: Two workers both execute `SCARD` and both see count = 4. Both proceed to `SADD`. Now the set has 6 members, violating the limit of 5. The **gap** between the check and the action is the vulnerability.

### What Lua Scripting Gives You

When you execute a Lua script via `EVAL`, the **entire script runs atomically** on the Redis server. Redis is single-threaded for command execution. While your Lua script is running, NO other commands from ANY client are processed. The script has exclusive access to the Redis data.

This means you can do:

```lua
local count = redis.call('SCARD', KEYS[1])
if count < tonumber(ARGV[1]) then
    redis.call('SADD', KEYS[1], ARGV[2])
    return 1  -- success
end
return 0  -- limit reached
```

There is zero gap between the `SCARD` check and the `SADD` action. No other client can sneak in between them. The TOCTOU race is eliminated entirely.

### How EVAL Works

```
EVAL script numkeys key [key ...] arg [arg ...]
```

- `script`: The Lua source code as a string.
- `numkeys`: How many of the following arguments are keys (vs. values).
- `key [key ...]`: Redis keys the script will access. Available as `KEYS[1]`, `KEYS[2]`, etc. (Lua arrays are 1-indexed.)
- `arg [arg ...]`: Non-key arguments. Available as `ARGV[1]`, `ARGV[2]`, etc.

**Why separate KEYS from ARGV?**
Redis can use the KEYS array to determine which cluster shard to route the script to. All keys must be on the same shard. This is a design requirement for Redis Cluster compatibility.

### How redis.call() Works Inside Lua

`redis.call(command, arg1, arg2, ...)` executes a Redis command from within Lua and returns the result. If the command fails, `redis.call()` raises an error that aborts the script. Alternative: `redis.pcall()` catches errors and returns them as Lua tables, allowing the script to handle failures gracefully.

Return values are automatically converted between Redis and Lua types:
- Redis integer reply becomes a Lua number.
- Redis bulk string reply becomes a Lua string.
- Redis array reply becomes a Lua table.
- Redis nil reply becomes Lua `false`.

### The EVALSHA Optimization

Every time you call `EVAL`, the full script text is sent over the network. For scripts that run thousands of times per second, this wastes bandwidth.

The solution: **EVALSHA**.

1. First, load the script: `SCRIPT LOAD "local count = redis.call(...)..."` — Redis returns a SHA1 hash of the script (e.g., `"a42059b356c875f0717db19a51f6aaa9161571a2"`).
2. Subsequently, call: `EVALSHA a42059b356c875f0717db19a51f6aaa9161571a2 numkeys key [key ...] arg [arg ...]`.
3. Redis looks up the script by hash in its script cache and executes it.
4. If the hash is not found (e.g., after a server restart), Redis returns a `NOSCRIPT` error. Your client should fall back to `EVAL` (which also caches the script).

Most Redis client libraries (like ioredis) handle this automatically: they try `EVALSHA` first, fall back to `EVAL` on `NOSCRIPT`, and cache the SHA1 locally.

### Limitations of Lua Scripts

1. **Blocking**: Lua scripts block ALL Redis operations while running. A script that takes 100ms blocks every other client for 100ms. Keep scripts short — ideally under 1ms.

2. **No external I/O**: You cannot make HTTP requests, read files, or access anything outside Redis from within a Lua script.

3. **No sleep/wait**: No `os.sleep()` or equivalent. Scripts must run to completion immediately.

4. **Deterministic execution**: Scripts should produce the same output for the same input. Redis may reject non-deterministic commands in scripts (e.g., `TIME`, `RANDOMKEY`) in certain configurations, to ensure replication safety.

5. **Memory limits**: Scripts share Redis's memory. Creating large Lua tables can cause memory issues.

6. **Script timeout**: By default, Redis will log a warning after a script runs for 5 seconds and allow `SCRIPT KILL` after that. You can configure `lua-time-limit`.

### Our Concurrency Lua Script — Line by Line

```lua
-- KEYS[1] = the sorted set key for active runs (e.g., "concurrency:queue:my-queue")
-- ARGV[1] = the concurrency limit (e.g., "5")
-- ARGV[2] = the run ID (e.g., "run-abc-123")
-- ARGV[3] = the current timestamp (e.g., "1710000000000")

-- Step 1: Check current count of active runs
local currentCount = redis.call('ZCARD', KEYS[1])

-- Step 2: Compare against the limit
if currentCount < tonumber(ARGV[1]) then
    -- Step 3: Under the limit — add this run to the active set
    -- Score is the timestamp, used for debugging/cleanup of stale entries
    redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2])
    -- Return 1 to indicate the slot was acquired
    return 1
end

-- Step 4: At or over the limit — reject
-- Return 0 to indicate no slot available
return 0
```

**Why this eliminates the TOCTOU race:**
The `ZCARD` check and the conditional `ZADD` happen in a single atomic unit. No other Redis command can execute between steps 1 and 3. Two workers calling this script simultaneously will be serialized by Redis — one will see count = 4 and succeed, the other will see count = 5 and fail.

### Comparison to Alternatives

**Redis Transactions (MULTI/EXEC):**
```
WATCH active_runs
count = SCARD active_runs
MULTI
SADD active_runs run-99
EXEC
```
`WATCH` implements optimistic locking: if `active_runs` is modified between `WATCH` and `EXEC`, the transaction is aborted. Problems:
- You cannot read values inside a `MULTI` block — all commands are queued, not executed, so you cannot do conditional logic based on intermediate results.
- Retry logic is needed when transactions fail due to WATCH conflicts.
- Under high contention, transactions may retry many times, wasting resources.

Lua scripts are strictly superior for conditional logic: you can read, decide, and write in one atomic block.

**Redis Functions (server-side stored scripts):**
Introduced in Redis 7.0, Functions are a more structured replacement for ad-hoc Lua scripts. Scripts are stored on the server with named functions, libraries, and metadata. For production systems, Functions are preferred over raw EVAL. For learning and development, EVAL is simpler.

### Resources

- [Redis Scripting with Lua Documentation](https://redis.io/docs/latest/develop/programmability/eval-intro/)
- [Fixing Race Conditions in Redis Counters with Lua (Dev.to)](https://dev.to/silentwatcher_95/fixing-race-conditions-in-redis-counters-why-lua-scripting-is-the-key-to-atomicity-and-reliability-38a4)
- [Redis Lua Script for Atomic Operations and Cache Stampede (LINE Engineering)](https://engineering.linecorp.com/en/blog/redis-lua-scripting-atomic-processing-cache/)
- [Redis: Pipelining, Transactions, and Lua Scripts](https://rafaeleyng.github.io/redis-pipelining-transactions-and-lua-scripts)
- [Atomic Redis Extensions with Lua (GitHub Gist)](https://gist.github.com/fxn/4261018)
- [Redis Transactions and Lua Scripts (Medium)](https://medium.com/jerrynotes/redis-transactions-and-lua-script-a9fcf4e1f5f2)

### Test Questions

1. Why can you not use `MULTI/EXEC` to implement "check count, then conditionally add"? What specific limitation prevents this?
2. What happens if your Lua script takes 10 seconds to execute? What impact does this have on other Redis clients?
3. Explain the difference between `redis.call()` and `redis.pcall()`. When would you use each?
4. Why does `EVAL` require you to pass keys separately from other arguments? What would break if you put key names in ARGV?
5. You deploy a new version of your Lua script. Existing `EVALSHA` calls using the old SHA1 will fail. How do most client libraries handle this?
6. Can a Lua script call `TIME` to get the current server time? Why is this potentially problematic for replication?
7. Write a Lua script that atomically increments a counter only if the counter is below a maximum value. Return the new value on success, or -1 on failure.

---

## 3. TOCTOU (Time-of-Check-to-Time-of-Use) Race Conditions

### What Is TOCTOU?

TOCTOU (Time-of-Check to Time-of-Use) is a class of race condition where a system's state is **checked** at one point in time, and then **acted upon** at a later point in time, but the state may have **changed** in between. The check becomes stale, and the action proceeds based on outdated information.

The general pattern:

```
1. CHECK: Is condition X true?              (time T1)
2. GAP:   Other processes can modify state   (time T1 to T2)
3. USE:   Act assuming condition X is true    (time T2)
```

If another process changes the condition during the gap, the action at T2 is based on a false assumption.

### Classic Examples

**File system race (the canonical TOCTOU):**
```c
if (access("/tmp/file", W_OK) == 0) {  // CHECK: Can I write to this file?
    // GAP: Attacker replaces /tmp/file with a symlink to /etc/passwd
    fd = open("/tmp/file", O_WRONLY);    // USE: Open and write to it
    write(fd, data, len);                // Writes to /etc/passwd!
}
```
The `access()` check verifies permissions on the original file. Between `access()` and `open()`, an attacker creates a symbolic link from `/tmp/file` to `/etc/passwd`. The privileged program then writes to `/etc/passwd` because it already "checked" that writing was safe.

**Database concurrency limit violation:**
```javascript
const count = await db.query("SELECT COUNT(*) FROM active_runs WHERE queue = 'q1'");
// GAP: Another worker also reads count and proceeds
if (count < limit) {
    await db.query("INSERT INTO active_runs VALUES ('run-99', 'q1')");
}
```
Two workers both read count = 4, both see it is under the limit of 5, both insert. Now there are 6 active runs.

**E-commerce overselling:**
```javascript
const stock = await getInventory(productId); // CHECK: 1 item in stock
// GAP: Another request also sees 1 in stock
if (stock > 0) {
    await createOrder(productId);             // USE: Both requests create orders
    await decrementInventory(productId);      // Stock goes to -1
}
```

### The Specific TOCTOU in Our System

In reload.dev, the concurrency limit protects downstream systems. If a queue has a concurrency limit of 5, it means the downstream API (or database, or service) can handle at most 5 concurrent requests. Exceeding the limit could cause:

- API rate limit violations and bans
- Database connection pool exhaustion
- Service degradation or cascading failures
- Incorrect results from resource contention

The TOCTOU race:

```
Worker A: ZCARD("active:queue1") -> 4      (under limit of 5)
Worker B: ZCARD("active:queue1") -> 4      (also under limit)
Worker A: ZADD("active:queue1", ..., "run-1")  -> count is now 5
Worker B: ZADD("active:queue1", ..., "run-2")  -> count is now 6 (VIOLATION!)
```

Both workers checked at the same time, both saw the same stale count, both proceeded. The limit of 5 is violated. If this protects an API rate limit, you are now making 6 concurrent requests and might get throttled or banned.

### Three Solutions

#### Solution 1: Atomic Operations (Lua Scripts)

**Eliminate the gap entirely.** The check and the action happen as one indivisible operation.

```lua
local count = redis.call('ZCARD', KEYS[1])
if count < tonumber(ARGV[1]) then
    redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
    return 1
end
return 0
```

**Pros:** Zero gap, zero contention, zero retries. The fastest and most correct solution.
**Cons:** Requires Redis. Lua scripts block all other Redis operations (but ours runs in microseconds, so this is negligible).

#### Solution 2: Pessimistic Locking

**Acquire an exclusive lock before checking.** Only one process can hold the lock at a time.

```javascript
const lock = await acquireLock("queue:q1:lock", ttl=5000);
try {
    const count = await redis.zcard("active:q1");
    if (count < limit) {
        await redis.zadd("active:q1", timestamp, runId);
    }
} finally {
    await releaseLock(lock);
}
```

**Pros:** Works with any data store, not just Redis. Easy to reason about.
**Cons:** Creates a bottleneck — only one process can check+add at a time. Lock acquisition/release adds latency. Lock expiry and failure modes are complex (what if the holder crashes?). Distributed locks (Redlock) have known theoretical issues.

#### Solution 3: Optimistic Retry

**Proceed without locking, then verify the result. Roll back if the invariant is violated.**

```javascript
await redis.zadd("active:q1", timestamp, runId);  // Add first
const count = await redis.zcard("active:q1");       // Then check
if (count > limit) {
    await redis.zrem("active:q1", runId);           // Roll back
    return false;
}
return true;
```

**Pros:** No locks, no blocking. Works well under low contention.
**Cons:** Under high contention, many adds and rollbacks waste work. There is a brief window where the count exceeds the limit (between ZADD and ZREM), which could cause issues if downstream systems are checked during that window. Not truly atomic.

### Why We Chose Atomic Lua

| Factor              | Lua Script | Pessimistic Lock | Optimistic Retry |
| ------------------- | ---------- | ---------------- | ---------------- |
| Gap between check/use | None     | None (held lock) | Brief            |
| Contention          | None       | High             | Medium           |
| Retry overhead      | None       | Lock retry       | Rollback retry   |
| Complexity          | Low        | High             | Medium           |
| Correctness         | Perfect    | Perfect          | Eventual         |
| Latency             | Lowest     | Highest          | Medium           |

The Lua script approach is the clear winner for our use case: a simple check-and-act pattern on Redis data.

### TOCTOU in Other Contexts

**Filesystem symlink attacks (CWE-367):**
A privileged program checks file permissions, then opens the file. Between check and open, an attacker replaces the file with a symlink to a sensitive file. The privileged program writes to the attacker's target. Mitigation: use `O_NOFOLLOW` flag, or open first and check permissions on the file descriptor (not the path).

**Double-spend in cryptocurrency:**
A malicious actor broadcasts two conflicting transactions simultaneously: one paying a merchant, one paying themselves. If both transactions are validated before either is confirmed, both might be accepted. The blockchain consensus mechanism (proof-of-work, proof-of-stake) is the solution — it serializes transactions into a canonical order.

**Lost updates in databases:**
Two users read the same row, both modify it, both write it back. The second write overwrites the first. Solutions: optimistic concurrency control (version numbers), pessimistic locking (`SELECT ... FOR UPDATE`), or serializable isolation level.

**Authentication bypass:**
Check if a session token is valid, then perform a privileged action. Between check and action, the token is revoked. The action proceeds with a revoked token. Solution: re-validate the token at the point of action, or use cryptographic proof that bundles the authorization with the action.

### Resources

- [CWE-367: Time-of-check Time-of-use (TOCTOU) Race Condition](https://cwe.mitre.org/data/definitions/367.html)
- [Starvation (Computer Science) — Wikipedia](https://en.wikipedia.org/wiki/Starvation_(computer_science))
- [TOCTTOU Race Conditions (CQR)](https://cqr.company/web-vulnerabilities/time-of-check-to-time-of-use-tocttou-race-conditions/)
- [CVE Details for CWE-367](https://www.cvedetails.com/cwe-details/367/Time-of-check-Time-of-use-TOCTOU-Race-Condition.html)
- [Redis Lua Scripting for Atomic Operations](https://engineering.linecorp.com/en/blog/redis-lua-scripting-atomic-processing-cache/)

### Test Questions

1. Describe the TOCTOU race in the e-commerce inventory scenario. How many items can be oversold if 100 requests arrive simultaneously for the last item?
2. Why is optimistic retry not truly atomic? Describe a scenario where the count briefly exceeds the limit.
3. In the filesystem TOCTOU attack, why does using `open()` first and then `fstat()` on the file descriptor solve the problem, while `stat()` on the path does not?
4. Explain why a Lua script eliminates the TOCTOU race. What property of Redis makes this possible?
5. A distributed system uses a Redlock (distributed lock) to prevent TOCTOU. Martin Kleppmann argued this is unsafe. What is his main objection? (Hint: process pauses and clock skew.)
6. How does the double-spend problem in Bitcoin relate to TOCTOU? What serves as the "atomic operation" in Bitcoin's solution?
7. You are implementing a rate limiter: "at most 100 requests per minute per user." Describe the TOCTOU race and how you would solve it with a Lua script.

---

## 4. Fair Scheduling Algorithms

### What Is "Fair"?

Fairness in scheduling has multiple definitions depending on context:

- **Equal opportunity**: Every queue gets an equal chance to run. If there are 5 queues, each gets 20% of execution slots. Simple but possibly wasteful — what if one queue has 1000 items and another has 0?

- **Equal outcome**: Every queue processes the same number of items per unit time. This ignores that some queues may have more demand. It can leave processing capacity idle.

- **Proportional to demand**: Queues with more items get more execution slots. This maximizes throughput but may starve low-volume queues.

- **Weighted proportionality**: Queues are assigned weights (based on customer tier, SLA, etc.). Capacity is allocated proportional to weight. A "premium" queue with weight 3 gets 3x the slots of a "free" queue with weight 1.

In practice, most systems use a combination: proportional to demand with minimum guarantees (even the lowest-priority queue gets some service).

### Round-Robin

**The simplest fair scheduling algorithm.** Cycle through queues in order, taking one item from each.

```
Queues: [A, B, C]
Cycle 1: Dequeue from A, then B, then C
Cycle 2: Dequeue from A, then B, then C
...
```

**Advantages:**
- Dead simple to implement: maintain an index, increment modulo number of queues.
- O(1) per dequeue decision.
- Every non-empty queue is guaranteed to be served.

**Problems:**
- If queue A has 1000 items and queue B has 1, they still get equal service. Queue A's items wait much longer.
- If a queue is empty, its slot is wasted (though this is easily handled by skipping empty queues).
- Does not account for item "size" — in network scheduling, a queue with large packets consumes more bandwidth per dequeue.

**When to use:** When all queues are approximately equal in importance and volume. Good starting point for learning.

### Weighted Round-Robin (WRR)

Assign static weights to queues. In each cycle, dequeue `weight` items from each queue.

```
Queue A: weight 3
Queue B: weight 1
Queue C: weight 2

Cycle: A, A, A, B, C, C, A, A, A, B, C, C, ...
```

**Advantages:**
- Simple extension of round-robin.
- Allows differentiation between queue importance.
- Deterministic: you know exactly how capacity is allocated.

**Problems:**
- Weights are static. If queue A has no items, its 3 slots per cycle are wasted.
- Bursty behavior: queue A gets 3 consecutive dequeues, which may cause micro-bursts on downstream systems.
- Does not adapt to actual demand.

### Weighted Fair Queuing (WFQ)

Originally designed for network packet scheduling by Demers, Keshav, and Shenker (1989). WFQ simulates a hypothetical **bit-by-bit round-robin** system (Generalized Processor Sharing, or GPS) and approximates it packet-by-packet.

**Core idea:** Each queue has a weight. A queue with weight 2 should get twice the bandwidth of a queue with weight 1. WFQ computes a **virtual finish time** for each packet: `finish_time = arrival_time + packet_size / weight`. Packets are served in order of their virtual finish time.

**Adapted for task queues:**
```
score = age_in_queue * capacity_weight
```

A queue with more available capacity (further from its concurrency limit) gets a higher weight. A task that has been waiting longer gets a higher age. The product gives a dynamic priority that adapts to both demand and capacity.

**Advantages:**
- Adapts dynamically to demand and capacity.
- Provably fair: each queue gets its weighted share over time.
- Handles variable-size work items.

**Problems:**
- O(log N) complexity per dequeue (maintaining sorted order of finish times).
- More complex to implement than round-robin.
- Weights must be carefully tuned.

### Deficit Round-Robin (DRR)

Proposed by Shreedhar and Varghese (1996) as a simpler, O(1) alternative to WFQ.

**How it works:**

1. Each queue has a **deficit counter** (initialized to 0) and a **quantum** (its weight).
2. Visit each non-empty queue in round-robin order.
3. Add the quantum to the queue's deficit counter.
4. Dequeue items from the queue as long as the item's "cost" is less than or equal to the deficit counter. Subtract the item's cost from the deficit.
5. If the queue is now empty, reset its deficit counter to 0.
6. Move to the next queue.

**For task queues where all items have cost 1:**
```
Queue A: quantum = 3, deficit = 0
Queue B: quantum = 1, deficit = 0

Round 1:
  Visit A: deficit = 0 + 3 = 3. Dequeue 3 items. deficit = 0.
  Visit B: deficit = 0 + 1 = 1. Dequeue 1 item. deficit = 0.

Round 2: same as round 1.
```

**Advantages:**
- O(1) per dequeue decision — no sorting needed.
- Simple enough to implement in hardware (used in network routers).
- Provably fair over time.
- Handles variable-cost items correctly.

**Problems:**
- Short-term unfairness: within a single round, queues are served in fixed order.
- Does not consider item age or urgency.

### How Trigger.dev Does It

Trigger.dev uses a **weighted scoring strategy** that considers multiple factors:

```
score = messageAge * capacityWeight * randomFactor
```

- **Message age**: How long the oldest message in the queue has been waiting. Older messages get higher scores, preventing starvation.
- **Capacity weight**: How much available concurrency the queue has (current limit minus active runs). Queues with more headroom get higher scores — they can actually use the capacity.
- **Random factor**: A small random multiplier for new queues or queues with equal scores, preventing deterministic ordering that could cause patterns of unfairness.

This is NOT simple round-robin. It dynamically adapts to queue state, preventing starvation while maximizing throughput. Queues that have been waiting longer AND have available capacity are prioritized.

Trigger.dev also supports **per-ID fairness** (Issue #2617): within a single queue, distribute work fairly across different user IDs or tenant IDs, rather than allowing one tenant's burst to monopolize the queue.

### What We Implement in Phase 3

We start with **round-robin** because it is the simplest to implement correctly. Our implementation:

```typescript
class FairDequeuer {
    private queueIndex = 0;

    async dequeueNext(queues: string[]): Promise<Run | null> {
        const nonEmpty = queues.filter(q => q.length > 0);
        if (nonEmpty.length === 0) return null;

        const queue = nonEmpty[this.queueIndex % nonEmpty.length];
        this.queueIndex = (this.queueIndex + 1) % nonEmpty.length;
        return await dequeueFromQueue(queue);
    }
}
```

**Limitations we knowingly accept (for now):**
- No priority weighting between queues.
- No adaptation to queue depth.
- No consideration of item age.
- Possible starvation if one queue produces items faster than the dequeue rate of all other queues combined.

**Path to improvement:** In a later phase, we can replace the round-robin with a weighted scoring function that considers queue depth, message age, and available concurrency — similar to Trigger.dev's approach.

### The Starvation Problem

**What is starvation?** A queue that never (or rarely) gets served, despite having items waiting. This happens when higher-priority queues continuously have items, and the scheduler always serves them first.

**Example:** Priority queue with priorities 0-10. Priority-10 items keep arriving at a rate of 100/second. Priority-0 items arrive at 1/second. If the system can process 100 items/second, all capacity goes to priority-10 items. Priority-0 items wait forever.

**Solutions:**

1. **Aging**: Gradually increase the priority of waiting items. After a task has waited 60 seconds, bump its effective priority by 1. After 120 seconds, bump by 2. Eventually, even the lowest-priority task reaches the highest priority level and gets served.

```typescript
function effectivePriority(basePriority: number, waitTimeMs: number): number {
    const agingBonus = Math.floor(waitTimeMs / 60000); // +1 per minute
    return Math.min(basePriority + agingBonus, MAX_PRIORITY);
}
```

2. **Minimum guarantees**: Reserve a percentage of capacity for each priority level. "At least 10% of capacity goes to priority-0 items, regardless of how many priority-10 items are waiting."

3. **Rate limiting per priority**: "Priority-10 can use at most 80% of capacity." This forces leftover capacity to flow to lower priorities.

4. **Weighted fair queuing**: Use weights proportional to priority, rather than strict priority ordering. Priority-10 gets 10x the weight of priority-1, but priority-1 still gets 1/11 of the capacity (not zero).

### Resources

- [Weighted Fair Queuing — Wikipedia](https://en.wikipedia.org/wiki/Weighted_fair_queueing)
- [Fair Queuing — Wikipedia](https://en.wikipedia.org/wiki/Fair_queuing)
- [Queuing and Scheduling — An Introduction to Computer Networks](https://intronetworks.cs.luc.edu/current/html/fairqueuing.html)
- [Efficient Fair Queuing using Deficit Round Robin (Shreedhar & Varghese, 1996)](https://courses.cs.duke.edu/fall24/compsci514/readings/drr.pdf)
- [Queuing Disciplines — Computer Networks: A Systems Approach](https://book.systemsapproach.org/congestion/queuing.html)
- [CFS Scheduler — Linux Kernel Documentation](https://docs.kernel.org/scheduler/sched-design-CFS.html)
- [Completely Fair Scheduler — Wikipedia](https://en.wikipedia.org/wiki/Completely_Fair_Scheduler)
- [Trigger.dev Per-ID Fairness Issue #2617](https://github.com/triggerdotdev/trigger.dev/issues/2617)
- [Trigger.dev Concurrency and Queues Docs](https://trigger.dev/docs/queue-concurrency)

### Test Questions

1. You have 3 queues: A (100 items), B (50 items), C (1 item). With simple round-robin, how many dequeue cycles until queue C is empty? Is this "fair" to queue A's items?
2. Explain Deficit Round-Robin with quantum values of A=3, B=1, C=2 and variable-cost items (some cost 1, some cost 2). Walk through 2 complete rounds.
3. The Linux CFS uses "virtual runtime" (vruntime). How is this similar to the "age" factor in Trigger.dev's scoring? How is it different?
4. You are building a multi-tenant SaaS. Free users should get 1/10th the scheduling weight of paid users. Which scheduling algorithm would you choose and why?
5. Explain why adding randomness to the queue selection score can improve fairness. What problem does it solve?
6. A priority queue with 10 levels is experiencing starvation at level 0. Design an aging algorithm that guarantees every item is served within 10 minutes, regardless of priority.
7. Compare round-robin and WFQ in terms of: time complexity per decision, implementation complexity, and adaptation to changing workloads.

---

## 5. Two-Level Concurrency (Queue + Key)

### What Is Queue-Level Concurrency?

Queue-level concurrency limits the total number of runs from a single queue that can execute simultaneously. If a queue has a concurrency limit of 10, at most 10 runs from that queue are executing at any moment. The 11th run must wait until one of the 10 finishes.

**What it protects:**
- Infrastructure resources shared by all runs in the queue (database connection pools, memory, CPU).
- Downstream services that have their own rate limits or capacity constraints.
- System stability — prevents a burst of runs from overwhelming the system.

**Example:**
```
Queue: "email-sending"
Concurrency limit: 5

Active runs: [run-1, run-2, run-3, run-4, run-5]  (5/5 — at limit)

run-6 arrives -> must wait
run-3 finishes -> slot opens
run-6 starts  -> [run-1, run-2, run-4, run-5, run-6]  (5/5)
```

### What Is Key-Level Concurrency?

Key-level concurrency limits runs that share the same **concurrency key**. The key is typically a domain identifier like a user ID, tenant ID, or external API key. Even if the queue allows 10 concurrent runs, you might want at most 1 run per user at a time.

**What it protects:**
- Per-tenant resources (a single user's API quota, a single account's database row locks).
- Data consistency (serializing writes to the same entity prevents conflicts).
- User experience (preventing one user's burst from consuming the queue's entire capacity).

**Example:**
```
Queue: "sync-user-data"
Queue concurrency limit: 10
Key concurrency limit: 1  (serialize per user)

run-1: key="user-42"  -> starts (first for user-42)
run-2: key="user-42"  -> waits  (user-42 already running)
run-3: key="user-99"  -> starts (first for user-99)
run-4: key="user-42"  -> waits  (user-42 already running)
run-1 finishes         -> run-2 starts (next for user-42)
```

Even though the queue has capacity for 10 concurrent runs, user-42's runs are serialized. Other users' runs are not affected.

### Why Two Levels?

A single concurrency level is insufficient for most real-world scenarios:

- **Queue-only concurrency** does not protect per-tenant resources. If the limit is 10 and one user submits 100 runs, that user could occupy all 10 slots, starving other users.

- **Key-only concurrency** does not protect shared infrastructure. If there are 1000 users each with a key limit of 1, up to 1000 runs could execute simultaneously, overwhelming the system.

**Two levels give you defense in depth:**
1. Queue limit protects the system as a whole.
2. Key limit protects individual tenants within the system.

### The Acquisition Order Matters

When acquiring concurrency slots, order is critical:

```
CORRECT ORDER:
1. Try to acquire QUEUE slot
2. If queue slot acquired, try to acquire KEY slot
3. If key slot fails, RELEASE the queue slot
4. Both acquired -> proceed

INCORRECT ORDER (leaks slots):
1. Try to acquire KEY slot
2. If key slot acquired, try to acquire QUEUE slot
3. If queue slot fails... the key slot is still held!
   Other runs for this key are blocked, even though nothing is executing.
```

**Why queue first, then key?**
The queue slot is the coarser-grained lock. If the queue is full, there is no point checking the key — nothing can run regardless. Acquiring the queue slot first avoids unnecessarily blocking runs for a specific key when the bottleneck is the queue.

**The release-on-failure contract:**
```typescript
async function acquireSlots(queueId: string, keyId: string): Promise<boolean> {
    const queueSlot = await acquireQueueSlot(queueId);
    if (!queueSlot) return false;  // Queue is full

    const keySlot = await acquireKeySlot(keyId);
    if (!keySlot) {
        await releaseQueueSlot(queueId);  // CRITICAL: release queue slot
        return false;
    }

    return true;  // Both slots acquired
}
```

If you forget to release the queue slot when the key slot fails, you have a **slot leak**. The queue's effective capacity decreases over time as leaked slots accumulate. Eventually, no new runs can start, even though no runs are actually executing. This is a particularly insidious bug because it manifests gradually and may not be caught in testing.

### How Trigger.dev Does It: Four Levels

Trigger.dev implements concurrency at **four levels**, each nesting inside the previous:

1. **Organization level**: Maximum concurrent runs across all environments and queues. Protects the organization's resource quota.
2. **Environment level**: Maximum concurrent runs within a single environment (dev, staging, production). Prevents dev/staging from consuming production capacity.
3. **Queue level**: Maximum concurrent runs for a specific task type. Protects downstream service capacity.
4. **Key level**: Maximum concurrent runs per concurrency key. Protects per-tenant resources.

Acquisition order: org -> env -> queue -> key. Release order: reverse (key -> queue -> env -> org). If any level fails, all previously acquired levels must be released.

**We simplify to two levels (queue + key) for learning.** The principles are identical — more levels just mean more acquire/release steps and more potential for slot leaks.

### The `releaseConcurrencyOnWaitpoint` Flag

When a run is **suspended** (waiting for external input, a timer, or another run), should it keep holding its concurrency slot?

**`releaseConcurrencyOnWaitpoint: true` (release the slot):**
- Pro: Suspended runs do not count against the limit. More runs can execute while others wait.
- Pro: Higher throughput when runs spend significant time waiting.
- Con: When the run resumes, it must re-acquire the slot. If the queue is now full, the resumed run must wait.
- Con: Resumption latency is unpredictable.

**`releaseConcurrencyOnWaitpoint: false` (hold the slot):**
- Pro: Resumption is instant — the slot is already held.
- Pro: Predictable behavior — once a run starts, it holds its slot until completion.
- Con: Suspended runs waste capacity. If 8 of 10 slots are held by suspended runs, only 2 new runs can start.
- Con: Long-running waits can starve the queue.

**The right choice depends on the workload:**
- For runs that wait briefly (sub-second): hold the slot. Re-acquisition overhead is not worth it.
- For runs that wait for minutes or hours (human approval, external webhooks): release the slot. Holding it wastes capacity.
- Trigger.dev defaults to releasing on waitpoint, which is the right default for their typical workloads (AI agent tasks that may wait for long-running operations).

### Resources

- [Trigger.dev Concurrency and Queues](https://trigger.dev/docs/queue-concurrency)
- [Trigger.dev Product — Concurrency and Queues](https://trigger.dev/product/concurrency-and-queues)
- [Trigger.dev Per-ID Fairness Issue #2617](https://github.com/triggerdotdev/trigger.dev/issues/2617)
- [Trigger.dev Environment Management (DeepWiki)](https://deepwiki.com/triggerdotdev/trigger.dev/5.6-environment-management)

### Test Questions

1. A queue has a concurrency limit of 5 and a key limit of 2. User "alice" has 10 pending runs. What is the maximum number of alice's runs that can execute simultaneously? What if there are also 10 pending runs from user "bob"?
2. You acquire a queue slot but fail to acquire the key slot. You forget to release the queue slot. Describe what happens over the next 100 failed key acquisitions.
3. Why is the acquisition order (queue first, then key) important? What goes wrong if you reverse it?
4. A run is suspended at a waitpoint with `releaseConcurrencyOnWaitpoint: true`. While suspended, the queue fills up. When the waitpoint resolves, the run cannot re-acquire its slot. What should the system do?
5. Design a test that verifies slot leaks do not occur when key acquisition fails. What would you assert?
6. Trigger.dev has 4 concurrency levels. If any level fails during acquisition, all previously acquired levels must be released. Write pseudocode for an `acquireAll` function that handles this correctly for N levels.
7. You are running 3 runs for user "alice" and the key limit is 1. Only 1 is executing, 2 are queued. The executing run finishes. Which of the 2 queued runs should start next? What ordering policy makes sense?

---

## 6. Priority Queue Design

### Why Not Just Sort by Priority?

Naive approach: assign each run a priority (0-10), store runs in a list, sort by priority. The highest-priority item is dequeued first.

**The problem:** Within the same priority level, order is undefined. If 50 runs all have priority 5, which one goes first? Without a secondary sort key, the answer depends on implementation details (hash map order, array insert position, etc.) — which means no FIFO guarantee.

FIFO within a priority level matters because:
- Users expect that "if I submit run A before run B, and they have the same priority, A should execute first."
- Without FIFO, items submitted earlier might be delayed indefinitely as newer items at the same priority are randomly selected.
- Debugging and reasoning about queue behavior becomes impossible without deterministic ordering.

### The Two-Component Score

The solution is a composite score that encodes BOTH priority AND insertion time:

```
score = priorityComponent + timestampComponent
```

The priority component determines the **band** (which priority level). The timestamp component determines the **position within the band** (FIFO order).

### The Formula: `(MAX_PRIORITY - priority) * 1e13 + Date.now()`

Let us trace through the math carefully.

**Setup:** `MAX_PRIORITY = 10`. Current time: `Date.now() = 1710000000000` (approximately March 2024).

**Run A: priority 8, submitted at T=1710000000000**
```
score = (10 - 8) * 1e13 + 1710000000000
      = 2 * 10000000000000 + 1710000000000
      = 20000000000000 + 1710000000000
      = 21710000000000
```

**Run B: priority 8, submitted at T=1710000000100 (100ms later)**
```
score = (10 - 8) * 1e13 + 1710000000100
      = 20000000000000 + 1710000000100
      = 21710000000100
```

**Run C: priority 3, submitted at T=1710000000000 (same time as A)**
```
score = (10 - 3) * 1e13 + 1710000000000
      = 7 * 10000000000000 + 1710000000000
      = 70000000000000 + 1710000000000
      = 71710000000000
```

**ZPOPMIN order (lowest score first):**
1. Run A: 21710000000000 (priority 8, submitted first)
2. Run B: 21710000000100 (priority 8, submitted second)
3. Run C: 71710000000000 (priority 3, regardless of submission time)

This gives us exactly what we want:
- Higher priority items (8) dequeue before lower priority items (3).
- Within priority 8, items dequeue in FIFO order (A before B).
- Priority 3 items NEVER dequeue before priority 8 items, no matter how long they wait.

**Why subtract from MAX_PRIORITY?**
ZPOPMIN returns the lowest score. We want higher priority numbers to dequeue first. By subtracting from MAX, priority 10 maps to band 0 (lowest scores), priority 0 maps to band 10 (highest scores). Lower band number = lower score = dequeued first.

**Why 1e13?**
The multiplier must be larger than any possible `Date.now()` value to prevent band overlap. `Date.now()` currently returns ~1.74e12. It will not exceed 1e13 until the year **2286**. Therefore, band N occupies the range `[N * 1e13, (N+1) * 1e13)`, and the timestamp component (always < 1e13) stays within the band.

If we used 1e11 instead, priority band 2 would span `[2e11, 3e11)`, but `Date.now() = 1.74e12` is far larger than 1e11. The timestamp would overflow into adjacent bands, destroying priority ordering.

**If we used 1e15?** It would work correctly (bands are even wider), but we waste score precision. Redis sorted set scores are IEEE 754 doubles, which have 53 bits of mantissa (~15.9 decimal digits of precision). At 1e15, our scores would be around 1e16, pushing against the precision limit. At 1e13, scores are around 1e14, safely within precision.

### The Starvation Risk

Strict priority ordering has a fundamental problem: **starvation**. If high-priority items are continuously submitted, low-priority items never dequeue.

**Scenario:**
- Priority 10 items arrive at 50/second.
- Priority 0 items arrive at 1/second.
- System processes 50 items/second.

All 50 processing slots go to priority 10 items. Priority 0 items accumulate in the queue forever. Their scores are always higher than any priority 10 item's score, so they never reach the front of the queue.

### Solutions to Starvation

**1. Priority Aging**

Gradually boost the effective priority of waiting items:

```typescript
function computeScore(priority: number, enqueuedAt: number): number {
    const waitTimeMs = Date.now() - enqueuedAt;
    const agingBonusSeconds = Math.floor(waitTimeMs / 1000); // +1 priority per second
    const effectivePriority = Math.min(priority + agingBonusSeconds, MAX_PRIORITY);
    return (MAX_PRIORITY - effectivePriority) * 1e13 + enqueuedAt;
}
```

After 10 seconds of waiting, a priority-0 item becomes effectively priority-10 and competes with naturally high-priority items. This guarantees a maximum wait time.

**Problem:** Requires periodic re-scoring of queue items, which is O(N) and not naturally supported by sorted sets (you would need to ZADD with updated scores periodically).

**2. Maximum Wait Time Guarantees**

Instead of continuous aging, check item age at dequeue time:

```typescript
async function dequeue(queueKey: string, maxWaitMs: number): Promise<Run | null> {
    // First, check for any items that have exceeded max wait time
    const overdue = await redis.zrangebyscore(queueKey, '-inf', Date.now() - maxWaitMs, 'LIMIT', 0, 1);
    if (overdue.length > 0) {
        // Serve the overdue item regardless of its priority
        await redis.zrem(queueKey, overdue[0]);
        return parseRun(overdue[0]);
    }

    // Otherwise, serve the highest priority item
    const [item] = await redis.zpopmin(queueKey);
    return item ? parseRun(item) : null;
}
```

This does not require re-scoring but adds a check at dequeue time.

**3. Reserved Capacity Per Priority**

Allocate a percentage of processing capacity to each priority level:

```
Priority 10: 40% of capacity
Priority 5-9: 40% of capacity
Priority 0-4: 20% of capacity
```

Even if no priority 0-4 items exist, that 20% capacity can be made available to higher priorities. But when low-priority items are waiting, they are guaranteed at least 20% of the throughput.

### How Trigger.dev Uses Priority

Trigger.dev takes a different approach to priority: **time-offset in seconds**.

A priority of 10 means "this run should dequeue before runs that are up to 10 seconds older." In other words, a priority-10 run submitted now will jump ahead of priority-0 runs that were submitted up to 10 seconds ago, but NOT runs submitted 11+ seconds ago.

This is elegant because:
- It naturally prevents starvation. A priority-10 run can only jump ahead by 10 seconds of queue time. Eventually, older items "catch up" in effective priority.
- It provides intuitive semantics: priority is a number of seconds of queue-jumping.
- No separate aging mechanism is needed — time passage naturally reduces the priority advantage.

The formula for Trigger.dev-style priority:
```
score = Date.now() - (priority * 1000)
```
A priority-10 run gets a score 10,000ms (10 seconds) in the past, making it appear older than it is. ZPOPMIN returns the "oldest" item (lowest score), so this run jumps the queue by 10 seconds.

### Resources

- [Redis Sorted Sets Documentation](https://redis.io/docs/latest/develop/data-types/sorted-sets/)
- [Starvation and Aging in Operating Systems (GeeksforGeeks)](https://www.geeksforgeeks.org/starvation-and-aging-in-operating-systems/)
- [Aging (Scheduling) — Wikipedia](https://en.wikipedia.org/wiki/Aging_(scheduling))
- [CPU Scheduling — University of Illinois at Chicago](https://www.cs.uic.edu/~jbell/CourseNotes/OperatingSystems/5_CPU_Scheduling.html)
- [CFS Scheduler — Linux Kernel Documentation](https://docs.kernel.org/scheduler/sched-design-CFS.html)
- [Trigger.dev Concurrency and Queues](https://trigger.dev/docs/queue-concurrency)

### Test Questions

1. With `MAX_PRIORITY = 10` and `multiplier = 1e13`, compute the exact scores for: (a) priority 10 at T=1710000000000, (b) priority 0 at T=1710000000000, (c) priority 10 at T=1710000001000 (1 second later). Verify the dequeue order.
2. Why do we use `1e13` and not `1e12`? What would go wrong with `1e12`? Show a specific numerical example of band overlap.
3. Explain the Trigger.dev time-offset approach to priority. How does a priority of 10 translate to a score? Why does this naturally prevent starvation?
4. IEEE 754 double-precision floats have ~15.9 digits of precision. Our scores are around 1e14. How many digits of the timestamp component are preserved? Is this sufficient for millisecond precision?
5. Design a priority aging system where every item is guaranteed to be served within 5 minutes, regardless of initial priority. What is the aging rate? Show the math.
6. You have a sorted set with 10,000 items across 10 priority levels. You need to implement the "check for overdue items, then serve highest priority" algorithm. What are the exact Redis commands? What is the total time complexity?
7. Compare the `(MAX_PRIORITY - priority) * 1e13 + timestamp` approach to the Trigger.dev `timestamp - priority * 1000` approach. What are the trade-offs? When would you prefer each?

---

## Summary: How These Concepts Fit Together in Phase 3

The six concepts in this document form a complete system:

1. **Redis Sorted Sets** are the data structure we use for both the priority queue (storing runs ordered by priority+timestamp) and the concurrency tracking sets (storing active run IDs).

2. **Lua Scripts** make our concurrency checks atomic. Without them, TOCTOU races would allow us to exceed concurrency limits.

3. **TOCTOU understanding** tells us WHY we need atomic operations. The gap between "check count" and "add run" is the vulnerability window that Lua scripts close.

4. **Fair Scheduling** determines HOW we select which queue to dequeue from when multiple queues have waiting runs. We start with round-robin and understand the path to more sophisticated algorithms.

5. **Two-Level Concurrency** gives us defense in depth: queue limits protect infrastructure, key limits protect per-tenant resources. The acquisition order and release-on-failure contract prevent slot leaks.

6. **Priority Queue Design** determines the ORDER of dequeuing within a single queue. The composite score formula ensures both priority ordering and FIFO within each priority level.

Together, these concepts let us build a task queue that is **correct** (concurrency limits are never violated), **fair** (all queues get service), and **ordered** (higher-priority items run first, with FIFO within each level).

---

## Further Reading

### Books
- *Designing Data-Intensive Applications* by Martin Kleppmann — Chapter 7 (Transactions) covers race conditions and isolation levels. Chapter 8 (Distributed Systems) covers timing and ordering.
- *Computer Networks: A Systems Approach* by Peterson & Davie — Chapter 6 covers queuing disciplines including WFQ and DRR.
- *Redis in Action* by Josiah Carlson — Chapters on sorted sets and Lua scripting.

### Papers
- Shreedhar, M. and Varghese, G. "Efficient Fair Queuing Using Deficit Round Robin." IEEE/ACM Transactions on Networking, 1996.
- Demers, A., Keshav, S., and Shenker, S. "Analysis and Simulation of a Fair Queuing Algorithm." ACM SIGCOMM, 1989.

### Online
- [Redis University](https://university.redis.com/) — Free courses on Redis data structures and Lua scripting.
- [Antirez Blog](http://antirez.com/) — Salvatore Sanfilippo's blog with deep dives on Redis internals.
- [Trigger.dev Documentation](https://trigger.dev/docs/) — Official docs on concurrency, queues, and priority.
- [Martin Kleppmann's Blog](https://martin.kleppmann.com/) — Analysis of distributed locks (Redlock) and consistency.
