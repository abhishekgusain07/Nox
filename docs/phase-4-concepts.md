# Phase 4: Reliability — Deep-Dive Learning Document

**Goal**: Implement heartbeat monitoring for dead worker detection, graceful shutdown handling, worker registration, TTL-based run expiry, and harden optimistic locking through rigorous testing. Phase 4 is where reload.dev transitions from "works when everything goes right" to "recovers when things go wrong."

---

## Table of Contents

1. [Heartbeat Patterns for Dead Worker Detection](#1-heartbeat-patterns-for-dead-worker-detection)
2. [Graceful Shutdown (SIGTERM Handling)](#2-graceful-shutdown-sigterm-handling)
3. [Worker Registration Protocol](#3-worker-registration-protocol)
4. [TTL (Time-to-Live) Expiry](#4-ttl-time-to-live-expiry)
5. [Optimistic Locking Hardening](#5-optimistic-locking-hardening)

---

## 1. Heartbeat Patterns for Dead Worker Detection

### The Problem

Consider this scenario: Worker A dequeues a run, transitions it to `EXECUTING`, and begins processing. Thirty seconds later, Worker A is killed by the kernel's OOM killer because it exceeded its memory limit. The process is gone — no exception was thrown, no cleanup code ran, no status update was written to the database. The run sits in `EXECUTING` forever. No retry is triggered. The user sees "running" in their dashboard for hours. Their workflow is silently broken.

This is not a hypothetical edge case. In production environments, workers die from:

- **Out-of-memory kills (OOM)**: The Linux kernel's OOM killer sends SIGKILL (uncatchable) to the process consuming too much memory. The process is terminated instantly with no opportunity for cleanup.
- **Segmentation faults**: A bug in native code (C/C++ addon, Node.js buffer overflow) causes the process to crash with SIGSEGV.
- **Network partitions**: The worker is alive and working, but the network between the worker and the server is down. From the server's perspective, the worker might as well be dead.
- **Hardware failures**: Disk failures, power outages, hypervisor crashes. The machine simply stops existing.
- **Kubernetes evictions**: A node runs low on resources and the kubelet evicts pods without waiting for graceful shutdown.

In all of these cases, the worker cannot report its own death. The system needs an external mechanism to detect that the worker is no longer functioning and take corrective action. That mechanism is the heartbeat.

### What Is a Heartbeat?

A heartbeat is a periodic "I'm alive" signal sent from a monitored component to a monitoring component. The concept is borrowed directly from medicine: the presence of a heartbeat indicates life; its absence indicates death (or at least, the need for intervention).

In our system, the heartbeat works like this:

1. A worker begins executing a run.
2. While executing, the worker periodically sends a heartbeat to the server: "I am still working on run X."
3. The server receives the heartbeat and extends a deadline: "I expect the next heartbeat by time T."
4. If the deadline passes without a heartbeat, the server concludes the worker is dead (or at least unreachable) and takes corrective action — marking the run as failed with a `TIMED_OUT` failure type, which feeds into the retry logic.

The heartbeat is not a request for work or a status update. It is a pure liveness signal. Its only semantic content is: "I exist, and I am still processing this specific run."

### The Heartbeat Flow in Detail

```
Worker                                    Server
  |                                         |
  |--- dequeue run R, transition to EXEC -->|
  |                                         | (sets heartbeatDeadline = now + 30s)
  |                                         |
  |  ... 10 seconds pass, worker working ...|
  |                                         |
  |------- heartbeat(runId=R) ------------>|
  |                                         | (sets heartbeatDeadline = now + 30s)
  |                                         |
  |  ... 10 seconds pass, worker working ...|
  |                                         |
  |------- heartbeat(runId=R) ------------>|
  |                                         | (sets heartbeatDeadline = now + 30s)
  |                                         |
  |  ... worker crashes (OOM kill) .........|
  |  X                                      |
  |                                         | ... 30 seconds pass, no heartbeat ...
  |                                         |
  |                                         | (heartbeat monitor fires)
  |                                         | SELECT * FROM runs
  |                                         |   WHERE status = 'EXECUTING'
  |                                         |   AND heartbeatDeadline < NOW()
  |                                         |
  |                                         | (transitions run R to FAILED,
  |                                         |  failureType = 'TIMED_OUT',
  |                                         |  triggering retry logic)
```

### Design Decision: Interval vs. Timeout

In our system, the heartbeat interval is 10 seconds and the heartbeat timeout is 30 seconds. The timeout is intentionally 3x the interval. This is not arbitrary — it is a deliberate engineering tradeoff.

**Why must the timeout be strictly greater than the interval?**

If the timeout equaled the interval (both 10 seconds), a single delayed heartbeat would cause a false positive. Network latency, garbage collection pauses, CPU scheduling delays, and load spikes can all delay a heartbeat by a few seconds. A healthy worker would be falsely declared dead.

**Why 3x specifically?**

With a 3x ratio, the worker has three opportunities to deliver a heartbeat before the deadline expires. Even if two consecutive heartbeats are delayed or lost, the worker still has one more chance. This provides robust protection against:

- **Network jitter**: Transient delays in packet delivery (common in cloud environments where network is virtualized).
- **GC pauses**: Node.js's garbage collector can pause execution for tens to hundreds of milliseconds. In pathological cases with large heaps, Stop-the-World pauses can reach seconds.
- **CPU contention**: On a busy host, the worker's heartbeat timer might not fire precisely on schedule. The OS scheduler may delay it by several seconds.
- **Load balancer buffering**: If heartbeats go through an HTTP load balancer, the load balancer might buffer or batch requests.

The tradeoff: a higher ratio means longer detection time. With a 30-second timeout, a truly dead worker is not detected for up to 30 seconds. For most task queue workloads, this is acceptable — the run will be retried shortly after. For latency-critical systems, you might reduce the ratio, accepting more false positives.

**Industry comparisons:**

| System | Heartbeat Interval | Timeout | Ratio |
|--------|-------------------|---------|-------|
| reload.dev | 10s | 30s | 3x |
| Trigger.dev | 30s | 5 minutes | 10x |
| etcd (Raft) | 100ms | 1000ms | 10x |
| ZooKeeper | tickTime (2s) | sessionTimeout (min 4s) | 2-10x |
| Cassandra (phi) | Adaptive | Adaptive | N/A |
| Kubernetes liveness | `periodSeconds` | `failureThreshold * period` | configurable |

### The `heartbeatDeadline` Column: Deadline vs. Last-Seen

A critical implementation detail: on the `runs` table, we store `heartbeatDeadline` (a future timestamp), not `lastHeartbeatAt` (a past timestamp). This might seem like a minor distinction, but it has significant consequences.

**If we stored `lastHeartbeatAt`:**

```sql
-- To find dead runs:
SELECT * FROM runs
WHERE status = 'EXECUTING'
  AND lastHeartbeatAt < NOW() - INTERVAL '30 seconds';
```

This query requires the database to compute `NOW() - INTERVAL '30 seconds'` and compare it against every row. More importantly, the timeout (30 seconds) is now a magic constant baked into the query. If you want different timeouts for different run types (CPU-intensive tasks might need longer), you need to join against a configuration table or add per-row timeout columns, making the query more complex.

**If we store `heartbeatDeadline`:**

```sql
-- To find dead runs:
SELECT * FROM runs
WHERE status = 'EXECUTING'
  AND heartbeatDeadline < NOW();
```

The query is simpler. The deadline already encodes the timeout. Different runs can have different deadlines with zero query changes. When a heartbeat arrives, the server computes `heartbeatDeadline = NOW() + timeoutForThisRunType` and writes it. The monitoring query does not need to know what the timeout is — it only asks "has the deadline passed?"

This pattern is used extensively in distributed systems. Consul's TTL health checks store an absolute expiration time. Kubernetes stores `lastTransitionTime` on conditions, but liveness probes are evaluated as deadline checks by the kubelet. The deadline approach is simply more flexible and query-friendly.

### The Stale Heartbeat Problem

Consider this race condition:

1. Run R is `EXECUTING` on Worker A.
2. Worker A is slow — the heartbeat deadline passes.
3. The heartbeat monitor transitions run R to `FAILED` (triggering retry).
4. The retry logic creates a new attempt, and the run transitions back to `QUEUED`.
5. Worker B dequeues the run and transitions it to `EXECUTING`.
6. Now, Worker A (which was slow but not dead) finally sends a heartbeat for run R.

If the server blindly accepts this heartbeat and resets the deadline, it has corrupted the state. Run R is now executing on Worker B, but its heartbeat deadline was just refreshed by Worker A. If Worker B then crashes, the heartbeat monitor will not detect it for 30 more seconds (the deadline Worker A set).

**The fix**: Before accepting a heartbeat, check the current status and version of the run. In Trigger.dev's architecture, heartbeats are tied to a specific **snapshot** — if the run has moved to a new snapshot (because it was failed and retried), the heartbeat for the old snapshot is silently discarded. In our system, we can implement this by:

```sql
UPDATE runs
SET heartbeatDeadline = NOW() + INTERVAL '30 seconds'
WHERE id = $1
  AND status = 'EXECUTING'
  AND version = $expectedVersion;
```

If the run is no longer `EXECUTING` (because it was failed by the heartbeat monitor), this UPDATE matches zero rows. The stale heartbeat is harmlessly ignored.

### How the Heartbeat Monitor Works

The heartbeat monitor is a background process (running on the server, not on workers) that periodically scans for expired deadlines:

```typescript
// Pseudocode for the heartbeat monitor
async function checkHeartbeats() {
  const expiredRuns = await db.query(`
    SELECT id, version FROM runs
    WHERE status = 'EXECUTING'
      AND heartbeatDeadline < NOW()
  `);

  for (const run of expiredRuns) {
    try {
      await transitionRun(run.id, {
        from: 'EXECUTING',
        to: 'FAILED',
        expectedVersion: run.version,
        failureType: 'TIMED_OUT',
        error: 'Worker heartbeat deadline exceeded',
      });
      // The transition increments the version and triggers retry logic
    } catch (e) {
      if (e instanceof VersionConflictError) {
        // The run was already transitioned by something else — safe to skip
        continue;
      }
      throw e;
    }
  }
}

// Run every 10 seconds
setInterval(checkHeartbeats, 10_000);
```

Note the use of optimistic locking (`expectedVersion`) in the transition. This is essential because the heartbeat monitor and the worker might race: the worker might complete the run at the exact moment the monitor tries to fail it. The optimistic lock ensures exactly one of them wins.

### Comparison to Other Failure Detection Mechanisms

**TCP Keepalive**: TCP has a built-in keepalive mechanism. After a period of inactivity (default: 2 hours on Linux), the TCP stack sends a probe. If no ACK is received after several probes, the connection is declared dead. TCP keepalive operates at the connection level, not the application level. A process could have a live TCP connection but be deadlocked (unable to do work). Application-level heartbeats detect both network failure AND application hang.

**Kubernetes Liveness Probes**: Kubernetes sends periodic HTTP requests (or TCP connections, or exec commands) to a pod. If `failureThreshold` consecutive probes fail, the kubelet kills the pod and restarts it. This is a pull-based model (the kubelet polls the pod), while our heartbeat is a push-based model (the worker reports to the server). Liveness probes detect "is the process alive?" while our heartbeats detect "is the process making progress on this specific run?"

**ZooKeeper Ephemeral Nodes**: When a client connects to ZooKeeper, it can create ephemeral nodes — znodes that exist only as long as the client's session is active. If the client's session expires (no heartbeat within the session timeout), ZooKeeper automatically deletes all ephemeral nodes created by that session and notifies watchers. This is elegant because it ties liveness to data: when the worker dies, its registration data disappears automatically. The downside is the dependency on ZooKeeper as external infrastructure.

**Consul TTL Health Checks**: In Consul's TTL model, the application must actively call a `/agent/check/pass/:checkId` endpoint within a specified TTL. If the TTL expires without a pass, the service is marked critical. This is semantically identical to our heartbeat model — the application pushes a liveness signal, and the server marks it dead if the signal stops.

**Phi Accrual Failure Detector**: Used by Apache Cassandra and Akka clusters. Instead of a binary "alive/dead" determination based on a fixed timeout, the phi accrual detector outputs a continuous suspicion level (phi) based on the statistical distribution of inter-arrival times. A phi of 1 means a 10% chance the node is down; phi of 8 means 99.9999% chance. The application sets a phi threshold and the detector adapts to actual network conditions. This is more sophisticated than fixed timeouts but more complex to implement. For a task queue, fixed timeouts are typically sufficient.

### Resources

- [Heartbeat Pattern — Martin Fowler](https://martinfowler.com/articles/patterns-of-distributed-systems/heartbeat.html) — Canonical description of the heartbeat pattern from "Patterns of Distributed Systems."
- [Heartbeats in Distributed Systems — Arpit Bhayani](https://arpitbhayani.me/blogs/heartbeats-in-distributed-systems/) — Practical walkthrough with code examples.
- [HeartBeats: How Distributed Systems Stay Alive — AlgoMaster](https://blog.algomaster.io/p/heartbeats-in-distributed-systems) — Good overview of push vs pull models and industry examples.
- [Phi Accrual Failure Detection — Arpit Bhayani](https://arpitbhayani.me/blogs/phi-accrual/) — Deep dive into the adaptive failure detector used by Cassandra.
- [Detecting Node Failures — Edward Huang](https://edward-huang.com/distributed-system/2022/03/17/how-to-detect-a-dead-node-in-a-distributed-system/) — Covers the spectrum from naive timeouts to phi accrual.
- [Building a New Liveness and Heartbeat Mechanism — Kestra](https://kestra.io/blogs/2024-04-22-liveness-heartbeat) — Real-world implementation story from a workflow orchestration system.
- [ZooKeeper Programmer's Guide — Ephemeral Nodes](https://zookeeper.apache.org/doc/r3.4.13/zookeeperProgrammers.html) — How ZooKeeper uses session heartbeats for ephemeral node lifecycle.

### Test-Your-Understanding Questions

1. **Why is the heartbeat timeout longer than the heartbeat interval?** If they were equal, a single delayed heartbeat (caused by network jitter, GC pause, or CPU contention) would cause a false positive, declaring a healthy worker dead. The 3x ratio gives the worker three chances to deliver a heartbeat before the deadline expires, tolerating up to two consecutive missed/delayed heartbeats.

2. **What happens if the network between worker and server has a 15-second partition?** With a 10-second interval and 30-second timeout: the worker sends heartbeats at T=0s (delivered), T=10s (lost due to partition), T=20s (lost). At T=15s the partition heals. The heartbeat at T=20s might arrive during or after healing. The deadline was set to T+30s at the last successful heartbeat (T=0s), so the deadline is T=30s. The heartbeat at T=20s arrives before T=30s, so the deadline is refreshed. The run survives. If the partition lasted 25+ seconds, the T=20s heartbeat would still arrive before the T=30s deadline, but the T=30s heartbeat (sent at T=30s, arriving at T=30s+) might not. With a bit of margin, the run would survive. A partition longer than 30 seconds would cause the run to be marked failed and retried.

3. **Why check run status before accepting a heartbeat?** To prevent the stale heartbeat problem. If a run was already failed by the heartbeat monitor and retried (now executing on a different worker), a late heartbeat from the original worker would incorrectly extend the deadline, masking a crash of the new worker. Checking status (and version) ensures only heartbeats from the current execution are accepted.

4. **How does this differ from a TCP keepalive?** TCP keepalive operates at the transport layer and only detects that the TCP connection is alive — the remote process could be deadlocked, stuck in an infinite loop, or otherwise unable to do useful work. Application-level heartbeats detect that the worker process is alive AND actively making progress on a specific run. Additionally, TCP keepalive defaults are far too long (2 hours on Linux) for task queue use cases.

5. **What if the heartbeat monitor itself crashes?** If the heartbeat monitor process dies, no one is checking for expired deadlines. Dead worker runs accumulate in EXECUTING state. This is why the heartbeat monitor should be: (a) a simple, well-tested loop that is unlikely to crash, (b) monitored by the process supervisor (systemd, Kubernetes) and automatically restarted, and (c) potentially run on multiple server instances (the optimistic locking on transitions makes this safe — multiple monitors can scan concurrently without double-transitioning).

6. **Should heartbeat failure always trigger a retry?** Not necessarily. If the run has already exhausted its maximum retry count, the heartbeat failure should transition it to a terminal `FAILED` state without retry. Also, some failure types might warrant immediate failure without retry (e.g., if the task definition explicitly sets `maxRetries: 0`). The heartbeat monitor sets `failureType = 'TIMED_OUT'`, and the retry logic makes the policy decision.

7. **Why use a deadline timestamp instead of a "last seen" timestamp?** A deadline (`heartbeatDeadline = NOW() + 30s`) is pre-computed at write time, making the read query trivially simple (`WHERE heartbeatDeadline < NOW()`). A "last seen" timestamp (`lastHeartbeatAt`) requires the query to compute the deadline at read time (`WHERE lastHeartbeatAt < NOW() - INTERVAL '30 seconds'`), coupling the query to the timeout configuration. Deadlines also allow per-run timeout customization without changing the query.

---

## 2. Graceful Shutdown (SIGTERM Handling)

### Unix Signals: A Brief Primer

Unix signals are asynchronous notifications sent to a process to inform it of events. They are software interrupts — when a signal is delivered, the process's normal flow of execution is interrupted and the signal handler runs. There are 31 standard signals defined by POSIX. For shutdown purposes, three matter:

**SIGINT (signal 2)**: Sent when the user presses Ctrl+C in a terminal. It means "the user wants you to stop." By convention, it is the interactive interrupt signal. Processes can catch it, handle it (e.g., ask "are you sure?"), or ignore it. In a task queue worker, SIGINT and SIGTERM are typically handled identically.

**SIGTERM (signal 15)**: The standard "please terminate gracefully" signal. It is the default signal sent by `kill <pid>` (without the `-9` flag), by `docker stop`, and by Kubernetes when evicting a pod. The expectation is that the process will receive this signal, perform cleanup (finish in-progress work, close connections, flush buffers), and then exit with code 0. Processes can catch SIGTERM, handle it, or ignore it — but ignoring it is antisocial because the sender will eventually escalate to SIGKILL.

**SIGKILL (signal 9)**: The "terminate immediately and unconditionally" signal. It **cannot** be caught, handled, blocked, or ignored. When the kernel delivers SIGKILL, the process is terminated instantly. No cleanup code runs. No finalizers fire. No open files are flushed. The process simply ceases to exist. This is why you cannot catch SIGKILL: the signal is handled entirely by the kernel, never delivered to userspace code. The process never gets a chance to run `process.on('SIGKILL', ...)` because the kernel kills it before delivering the signal to the process's signal handler. This is by design — SIGKILL exists as an absolute last resort for processes that refuse to die.

**Why can't you catch SIGKILL?** The operating system kernel, not the process, handles SIGKILL. When a SIGKILL is sent, the kernel's scheduler simply marks the process as dead and reclaims its resources. The signal is never dispatched to the process's signal handling infrastructure. This ensures that even a completely frozen, malicious, or buggy process can be terminated. If SIGKILL were catchable, a malicious process could simply ignore it, and there would be no way to forcibly stop a process.

### Why SIGTERM Matters for Task Queue Workers

In production, workers do not run forever on a developer's laptop. They run in containers orchestrated by Kubernetes, Docker Compose, or similar systems. When these systems need to stop a worker (for a deployment, scaling event, node drain, or resource reclaim), they follow a standard protocol:

1. **Kubernetes sends SIGTERM** to the main process in the container.
2. **A grace period countdown begins** (`terminationGracePeriodSeconds`, default 30 seconds).
3. If the process exits within the grace period, the pod is marked as terminated.
4. **If the process is still running after the grace period, Kubernetes sends SIGKILL.** The process is killed immediately with no further chance for cleanup.

Without a SIGTERM handler, your Node.js worker will receive SIGTERM and... do nothing. Node.js's default SIGTERM behavior is to terminate the process, but it does so immediately without waiting for in-progress work. This means:

- A run that was 90% complete is abandoned. Its status remains `EXECUTING` in the database until the heartbeat monitor detects it (up to 30 seconds later), and the work is retried from scratch.
- Database connections are dropped without proper cleanup, potentially leaving prepared statements or transactions in a half-finished state.
- Redis connections are severed, possibly leaving Lua script state inconsistent.

### The Graceful Shutdown Pattern

Graceful shutdown follows a strict sequence. The order matters and is not negotiable:

**Step 1: Stop accepting new work.**

The moment SIGTERM arrives, the worker must stop pulling new runs from the queue. If the worker is in a dequeue polling loop, it sets a flag (`isShuttingDown = true`) and the next iteration of the loop checks this flag and breaks.

Why stop accepting work first? Because any new work accepted now might not finish before the grace period expires, resulting in even more abandoned runs.

```typescript
let isShuttingDown = false;

process.on('SIGTERM', () => {
  console.log('SIGTERM received, initiating graceful shutdown');
  isShuttingDown = true;
  beginShutdown();
});
```

**Step 2: Wait for in-progress work to finish.**

The worker tracks all currently executing runs. It waits for them to complete (or fail). This is the core value of graceful shutdown — allowing work to finish rather than abandoning it.

```typescript
async function beginShutdown() {
  // Wait for all in-progress runs to complete
  if (activeRuns.size > 0) {
    console.log(`Waiting for ${activeRuns.size} active runs to complete...`);
    await Promise.all([...activeRuns.values()]);
  }
  await cleanupAndExit();
}
```

**Step 3: Clean up connections.**

After all work is complete, close external connections in dependency order (most dependent first, least dependent last):

1. **HTTP server** — call `server.close()` to stop accepting new connections and wait for in-flight requests to complete.
2. **Message bus / Redis pub-sub** — unsubscribe and disconnect.
3. **Redis data connections** — flush any pending commands, then `redis.quit()`.
4. **Database pool** — drain the pool (`pool.end()`), waiting for any active queries to finish.

The order matters because higher-level resources (HTTP handlers) depend on lower-level resources (database connections). If you close the database first, an in-flight HTTP request will get a "connection pool ended" error.

**Step 4: Exit the process.**

```typescript
async function cleanupAndExit() {
  await httpServer.close();
  await redis.quit();
  await db.end();
  console.log('Graceful shutdown complete');
  process.exit(0);
}
```

### The Drain Timeout

What if in-progress work does not finish? A task might be stuck in an infinite loop, waiting on a network call to a server that is also shutting down, or simply executing a very long computation. You cannot wait forever — the Kubernetes SIGKILL is coming.

The drain timeout is a self-imposed deadline: "If work is not done within N seconds of SIGTERM, force-exit anyway."

```typescript
const DRAIN_TIMEOUT_MS = 25_000; // 25 seconds

process.on('SIGTERM', () => {
  isShuttingDown = true;

  // Force exit after drain timeout, even if work is still running
  const forceExitTimer = setTimeout(() => {
    console.error('Drain timeout exceeded, forcing exit');
    process.exit(1);
  }, DRAIN_TIMEOUT_MS);

  // Ensure the timer doesn't keep the event loop alive if we finish early
  forceExitTimer.unref();

  beginShutdown();
});
```

### The Relationship Between Shutdown Timeout and Heartbeat Timeout

This is a subtle but critical coordination point. Consider the timeline:

```
T=0:    SIGTERM arrives. Worker stops accepting work.
T=0-25: Worker drains in-progress runs. Sends heartbeats.
T=25:   Drain timeout. Worker force-exits if work is still running.
T=30:   Kubernetes SIGKILL (terminationGracePeriodSeconds=30).
```

The drain timeout (25s) must be **less than** the Kubernetes termination grace period (30s) so the worker can exit cleanly before SIGKILL arrives. The 5-second gap accounts for cleanup time (closing connections).

But the drain timeout must also be considered alongside the heartbeat timeout (30s). If the worker shuts down gracefully within the drain timeout and properly completes all runs, the heartbeat monitor never fires. But if the worker is killed by SIGKILL (because the drain timeout was not enough), the heartbeat monitor will detect the stalled run within 30 seconds and trigger a retry.

The key invariant: **drain timeout < Kubernetes grace period < heartbeat timeout is NOT required, but drain timeout < Kubernetes grace period IS required.** The heartbeat timeout is a safety net for when graceful shutdown fails.

### How Kubernetes Handles Pod Termination

The full Kubernetes pod termination sequence is:

1. **API server marks pod as "Terminating"**: The pod is removed from service endpoints. Load balancers stop sending traffic.
2. **preStop hook executes** (if defined): This is a command or HTTP call that runs before SIGTERM. Common uses: deregister from service discovery, drain connections.
3. **SIGTERM is sent** to the main process (PID 1) of each container.
4. **terminationGracePeriodSeconds countdown starts** (default 30 seconds, configurable).
5. **If the process exits**: Done. The container is terminated.
6. **If the process is still running after the grace period**: **SIGKILL** is sent. The process is killed unconditionally.

A common mistake: setting `terminationGracePeriodSeconds` too low for workloads that have long-running tasks. If your tasks can take up to 5 minutes, you need a 5-minute grace period — or, better yet, a mechanism (like heartbeats) to handle the case where the task cannot finish within the grace period.

### How Trigger.dev Handles Worker Shutdown

Trigger.dev workers connect to the server via Socket.io. When a worker initiates shutdown:

1. The worker sends a "shutting down" message to the server.
2. The server stops assigning new work to this worker.
3. The worker waits for in-progress runs to finish.
4. The worker disconnects from Socket.io.
5. If the worker disconnects abruptly (crash, SIGKILL), the Socket.io server detects the disconnect and the heartbeat-based snapshot mechanism handles the abandoned runs.

### Node.js Specifics

```typescript
// Handle both SIGTERM and SIGINT identically
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`Received ${signal}`);
    gracefulShutdown();
  });
}

// SIGKILL cannot be handled — this listener will NEVER fire:
// process.on('SIGKILL', () => { ... }); // Useless. Don't write this.
```

Important Node.js behavior: if you register a `SIGTERM` handler, Node.js will NOT automatically exit when SIGTERM is received. The default behavior (exit) is replaced by your handler. You must explicitly call `process.exit()` when your cleanup is done.

Also note: `process.exit()` fires the `'exit'` event synchronously. You cannot do async work in an `'exit'` handler. All async cleanup must happen in the SIGTERM handler, before calling `process.exit()`.

### Resources

- [Kubernetes Best Practices: Terminating with Grace — Google Cloud Blog](https://cloud.google.com/blog/products/containers-kubernetes/kubernetes-best-practices-terminating-with-grace) — Definitive guide to how Kubernetes terminates pods.
- [Graceful Shutdown with Node.js and Kubernetes — RisingStack](https://blog.risingstack.com/graceful-shutdown-node-js-kubernetes/) — Practical Node.js implementation with code examples.
- [Express.js Health Checks and Graceful Shutdown](https://expressjs.com/en/advanced/healthcheck-graceful-shutdown.html) — Express-specific guidance from the official docs.
- [SIGKILL vs SIGTERM: A Developer's Guide — SUSE](https://www.suse.com/c/observability-sigkill-vs-sigterm-a-developers-guide-to-process-termination/) — Clear explanation of signal mechanics.
- [Linux Signals: Understanding SIGINT, SIGTERM, and SIGKILL — Baeldung](https://www.baeldung.com/linux/sigint-and-other-termination-signals) — Deep dive into the POSIX signal system.
- [Kubernetes Pod Graceful Shutdown — DevOpsCube](https://devopscube.com/kubernetes-pod-graceful-shutdown/) — Covers preStop hooks, SIGTERM, and the full pod lifecycle.

### Test-Your-Understanding Questions

1. **Why can't you catch SIGKILL?** SIGKILL is handled entirely by the kernel. When the kernel's scheduler processes a SIGKILL for a process, it marks the process as dead and reclaims its resources without ever delivering the signal to the process's signal handler. This is a deliberate security and reliability guarantee: no process, no matter how buggy or malicious, can prevent itself from being killed. If SIGKILL were catchable, a rogue process could simply ignore it, and the only recourse would be rebooting the machine.

2. **What happens if your shutdown handler takes longer than Kubernetes' terminationGracePeriodSeconds?** Kubernetes sends SIGKILL. The process is killed immediately. Any in-progress work is abandoned. Database connections are severed without cleanup. The heartbeat monitor will eventually detect the abandoned runs and retry them. This is why the drain timeout should be strictly less than `terminationGracePeriodSeconds` — to ensure you have time to close connections cleanly before SIGKILL arrives.

3. **Why stop accepting new work BEFORE waiting for current work?** Because accepting new work during shutdown creates a paradox: you start a new task that might not finish before the grace period expires, creating more abandoned work. The purpose of graceful shutdown is to drain existing work, not accumulate new work. Think of it as closing the front door before mopping the floor — you do not want new foot traffic while you are cleaning up.

4. **What's the correct order for closing connections (DB, Redis, HTTP)?** HTTP server first (stop accepting new requests, finish in-flight requests), then Redis (used by application logic), then database (the lowest-level dependency). Close in reverse dependency order: higher-level components that depend on lower-level ones close first, ensuring that no component tries to use an already-closed dependency. If you close the database first, any in-flight HTTP request that tries to query the database will get an error.

5. **How does graceful shutdown interact with heartbeat monitoring?** During graceful shutdown, the worker is still sending heartbeats for its in-progress runs (the work is still happening). The heartbeat monitor sees valid heartbeats and does not intervene. If the worker finishes all work and exits cleanly, the heartbeat monitor has nothing to do. If the worker is SIGKILL'd before completing (grace period exceeded), the heartbeats stop, and the heartbeat monitor detects the stalled runs within its timeout window and triggers retries.

6. **What if you have multiple in-progress runs with different expected completion times?** The drain timeout applies to all of them collectively. If Run A finishes in 5 seconds but Run B needs 40 seconds, and the drain timeout is 25 seconds, Run A will complete gracefully but Run B will be abandoned when the drain timeout fires. Run B will be detected by the heartbeat monitor and retried. To avoid this, either increase the drain timeout (and `terminationGracePeriodSeconds`) or limit the maximum execution time of individual tasks.

---

## 3. Worker Registration Protocol

### Why Register?

In a single-worker system, there is no registration. The worker connects to the database, dequeues work, and executes it. But in a production system with multiple workers, the server needs to answer several questions:

- **Which workers exist right now?** For monitoring, debugging, and capacity planning.
- **What task types can each worker execute?** Not all workers are identical. A worker might have specific dependencies installed (e.g., a machine learning model, a headless browser, or access to a specific API). Only workers with the right capabilities should receive matching tasks.
- **How much capacity does each worker have?** A worker running on a 2-core machine with 512MB RAM should not receive the same number of concurrent tasks as a worker running on a 32-core machine with 64GB RAM.
- **Is each worker healthy?** A worker that registered 10 minutes ago but has not sent a heartbeat in 5 minutes is probably dead.

Without registration, the server is blind. It pushes (or allows dequeue of) work to any connected entity, with no knowledge of capabilities or capacity. This leads to task assignment failures, wasted resources, and mysterious errors when a worker receives a task type it cannot handle.

### The Registration Flow

```
Worker starts
    |
    v
POST /api/workers/register
  Body: {
    workerId: "worker-abc-123",
    taskTypes: ["send-email", "generate-pdf"],
    maxConcurrency: 5,
    version: "1.2.0"
  }
    |
    v
Server records worker in database:
  INSERT INTO workers (id, task_types, max_concurrency, status, registered_at, last_heartbeat_at)
  VALUES ('worker-abc-123', '{"send-email","generate-pdf"}', 5, 'ONLINE', NOW(), NOW())
    |
    v
Server responds: { registered: true }
    |
    v
Worker starts dequeue polling loop
    |
    v
Worker sends periodic heartbeats (same as run heartbeats, but for the worker itself)
```

### Registration Data

The registration payload includes:

- **workerId**: A unique identifier for this worker instance. Typically a UUID or a combination of hostname + PID. Must be unique across all workers.
- **taskTypes**: An array of task type identifiers this worker can execute. When the server dequeues work, it filters: `WHERE task_id = ANY(worker.taskTypes)`. A worker that supports `["send-email"]` will never receive a `generate-pdf` task.
- **maxConcurrency**: How many runs this worker can execute simultaneously. The server will not assign more than this number of concurrent runs to this worker.
- **version**: The version of the worker code. Useful for rolling deployments where old and new versions coexist temporarily.

### Deregistration

When a worker shuts down gracefully (SIGTERM handler), it should deregister:

```
Worker receives SIGTERM
    |
    v
Worker drains in-progress work
    |
    v
POST /api/workers/deregister
  Body: { workerId: "worker-abc-123" }
    |
    v
Server marks worker as OFFLINE:
  UPDATE workers SET status = 'OFFLINE', deregistered_at = NOW()
  WHERE id = 'worker-abc-123'
    |
    v
Worker exits
```

Deregistration tells the server: "I am going away intentionally. Do not assign me more work. Do not wait for me."

### Heartbeat-Based Implicit Deregistration

What if the worker crashes without deregistering? (This is the common case — OOM kills, SIGKILL, hardware failure.) The same heartbeat pattern used for run liveness detection applies to worker liveness:

- The worker sends periodic heartbeats to the server (separate from run heartbeats).
- The server maintains a `lastHeartbeatAt` or `heartbeatDeadline` for each worker.
- If the deadline passes, the server marks the worker as `OFFLINE`.
- Any runs assigned to that worker are handled by the run-level heartbeat monitor (they will be failed and retried independently).

This two-level heartbeat design (worker-level and run-level) provides defense in depth:
- **Worker heartbeat** tells you "this worker process is alive."
- **Run heartbeat** tells you "this specific run is being actively worked on."

A worker could be alive (sending worker heartbeats) but have a stuck run (not sending run heartbeats for that specific run). The run-level heartbeat catches this case.

### Task Type Filtering in Dequeue

When a registered worker polls for work, the dequeue query incorporates the worker's capabilities:

```sql
WITH next_run AS (
  SELECT id FROM runs
  WHERE status = 'QUEUED'
    AND task_id = ANY($1)  -- $1 = worker's registered task types
  ORDER BY priority DESC, created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE runs
SET status = 'EXECUTING',
    worker_id = $2,       -- $2 = worker's ID
    version = version + 1,
    started_at = NOW(),
    heartbeatDeadline = NOW() + INTERVAL '30 seconds'
FROM next_run
WHERE runs.id = next_run.id
RETURNING runs.*;
```

The `AND task_id = ANY($1)` clause is the key filter. Without it, a worker that only supports `send-email` might dequeue a `generate-pdf` run, fail to execute it, and waste a retry attempt.

### How Trigger.dev Handles Worker Registration

Trigger.dev uses a Socket.io-based connection model:

1. **Worker connects** to the server via Socket.io (persistent WebSocket connection).
2. **Worker sends registration message** with environment info, supported task types, and metadata.
3. **Server records the connection** and associates it with the deployment environment.
4. **Work assignment is pull-based**: The worker asks the queue for runs, rather than the server pushing runs to workers. This is a critical architectural choice — pull-based models give workers control over their own backpressure.
5. **Disconnect detection** is handled by Socket.io's built-in ping/pong mechanism, augmented by application-level heartbeats tied to snapshots.

### Comparison to Service Discovery Systems

**Kubernetes Service Discovery**: In Kubernetes, pods register implicitly by existing. The kubelet registers the pod's IP with the cluster DNS (kube-dns or CoreDNS). Services select pods via label selectors. Health is determined by readiness probes. This is an infrastructure-level registration — the application does not explicitly register itself. Our worker registration is application-level because we need application-specific metadata (task types, concurrency) that Kubernetes does not know about.

**Consul Service Registration**: Consul provides explicit service registration via API calls or configuration files. Services include health checks (HTTP, TCP, TTL, or script). Consul maintains a catalog of healthy services and provides DNS or HTTP-based service discovery. Consul's model is closest to ours: explicit registration with health checks. The difference is that Consul is a general-purpose service discovery system, while our registration is specific to task routing.

**etcd Leases**: etcd provides leases — time-limited grants that can be attached to keys. The client must periodically renew the lease; if it expires, attached keys are deleted. This is functionally equivalent to ZooKeeper's ephemeral nodes. A worker can write its registration data to etcd with a lease, and if the worker dies, the lease expires and the registration data is automatically cleaned up.

### Resources

- [Distributed Task Queue — GeeksforGeeks](https://www.geeksforgeeks.org/system-design/distributed-task-queue-distributed-systems/) — Overview of task queue architecture including worker management.
- [Task Queues — Temporal Documentation](https://docs.temporal.io/task-queue) — How Temporal handles task routing and worker matching.
- [Define Health Checks — Consul](https://developer.hashicorp.com/consul/docs/register/health-check/vm) — TTL-based health checks for service registration.
- [ZooKeeper Programmer's Guide](https://zookeeper.apache.org/doc/r3.4.13/zookeeperProgrammers.html) — Ephemeral nodes and session management for worker liveness.
- [Trigger.dev Run Engine 2.0](https://trigger.dev/launchweek/0/run-engine-2-alpha) — Architecture of Trigger.dev's pull-based worker model.

### Test-Your-Understanding Questions

1. **What happens if a worker registers but never starts dequeuing?** The worker appears in the workers table as `ONLINE` but never picks up any work. The runs sit in the queue for other workers to process. The server does not push work to workers — workers pull it. So a registered-but-idle worker has no direct impact on queue processing except reducing apparent capacity. The worker-level heartbeat will eventually mark it as `OFFLINE` if it stops sending heartbeats entirely (e.g., it hung during initialization).

2. **Why store worker capabilities in the database vs. in-memory?** Storing in the database provides durability: if the server restarts, worker registrations survive. It also supports multi-server deployments where multiple server instances need to see the same worker registry. In-memory storage is faster but lost on restart and not shared across server instances. A hybrid approach works too: store in the database for durability, cache in memory for fast dequeue filtering.

3. **What if two workers support different subsets of task types?** This is the normal case. Worker A supports `["send-email", "send-sms"]` and Worker B supports `["generate-pdf", "resize-image"]`. When Worker A dequeues, the query filters for `send-email` and `send-sms` runs. When Worker B dequeues, it filters for `generate-pdf` and `resize-image`. A `generate-pdf` run will only be assigned to Worker B, even if Worker A is idle. This enables heterogeneous worker pools where different workers have different dependencies installed.

4. **How does worker registration interact with fair dequeuing?** Fair dequeuing (from Phase 3) distributes work across queues/tenants fairly. Worker registration adds another dimension: task type filtering. The dequeue query must satisfy both constraints — fair round-robin across queues AND matching the worker's task types. This means a worker might skip a queue's turn if that queue only has task types the worker does not support. The fair dequeue algorithm must account for this by continuing to the next queue rather than blocking.

5. **What if a worker registers with task types that no runs use?** The worker will poll for work and always get zero results. It is effectively idle. This is not an error — it might be intentional (worker deployed in advance, waiting for a new task type to be triggered). The server does not reject registrations based on known task types.

6. **How do rolling deployments interact with worker registration?** During a rolling deployment, old-version workers and new-version workers coexist. If the new version supports new task types, old workers will not dequeue those tasks (they are not in their `taskTypes` list). If task type semantics changed between versions, the `version` field in the registration allows the server to route tasks to the correct version. This is a form of blue-green deployment at the task level.

---

## 4. TTL (Time-to-Live) Expiry

### What Is TTL?

TTL (Time-to-Live) is a maximum duration that a run can remain in the `QUEUED` state before being automatically expired. It is a staleness guarantee: if a task cannot be processed within its TTL window, the system discards it rather than executing it late.

### Why TTL?

Not all tasks are worth executing after a delay. Consider these examples:

- **Send a verification email**: If the user requested a verification email and the system is backed up, sending it 2 hours later is confusing and potentially insecure (the verification code might have expired server-side already).
- **Real-time notification**: A "your ride is arriving" push notification sent 30 minutes late is worse than useless — it is actively misleading.
- **Market data processing**: Processing a stock price update from an hour ago with the assumption that it is current could lead to bad trades.
- **Rate-limited API calls**: An API call scheduled during an off-peak window is pointless if it executes during peak hours when the rate limit is already exhausted.

In all these cases, the task creator knows: "If this hasn't executed within N seconds/minutes, don't bother." TTL encodes this knowledge in the run itself.

### How TTL Works

When a run is created with a TTL, the system records the TTL duration alongside the run:

```sql
INSERT INTO runs (id, task_id, payload, status, ttl, created_at)
VALUES ('run-123', 'send-verification-email', '{"userId": 42}', 'QUEUED', 300, NOW());
-- ttl = 300 seconds (5 minutes)
```

A background process periodically scans for expired runs:

```sql
-- The TTL checker query
UPDATE runs
SET status = 'EXPIRED',
    version = version + 1,
    expired_at = NOW()
WHERE status = 'QUEUED'
  AND ttl IS NOT NULL
  AND created_at + (ttl * INTERVAL '1 second') < NOW()
RETURNING id;
```

`EXPIRED` is a terminal state. The run will not be retried, will not be dequeued, and will not be re-enqueued. It is done. The task creator can check the run's status and see that it expired without execution.

### The TTL Checker as a Background Loop

```typescript
async function checkTTLExpiry() {
  const expiredRuns = await db.query(`
    SELECT id, version FROM runs
    WHERE status = 'QUEUED'
      AND ttl IS NOT NULL
      AND created_at + (ttl * INTERVAL '1 second') < NOW()
  `);

  for (const run of expiredRuns) {
    try {
      await transitionRun(run.id, {
        from: 'QUEUED',
        to: 'EXPIRED',
        expectedVersion: run.version,
      });
    } catch (e) {
      if (e instanceof VersionConflictError) {
        // Run was dequeued between our SELECT and UPDATE — this is fine
        continue;
      }
      throw e;
    }
  }
}

// Run every 30 seconds
setInterval(checkTTLExpiry, 30_000);
```

### The Dequeue Race: TTL Checker vs. Worker

This is a critical edge case. Consider the timeline:

```
T=0:     Run R created with TTL=300 (5 minutes). Status: QUEUED.
T=299.9: TTL checker SELECTs run R (it is 0.1 seconds from expiry).
T=300.0: Worker dequeues run R, transitions to EXECUTING (version 1 → 2).
T=300.1: TTL checker tries to transition run R from QUEUED to EXPIRED with version=1.
```

What happens? The TTL checker's UPDATE includes `AND version = 1`. But the run is now version 2 (and status `EXECUTING`). The UPDATE matches zero rows. The TTL checker gets a `VersionConflictError` and moves on. The run executes normally.

This is optimistic locking doing exactly what it was designed for. The TTL checker and the worker raced, and the optimistic lock ensured only one of them won. No data corruption. No double-state.

The reverse can also happen: the TTL checker wins and expires the run, and then the worker tries to dequeue it. The worker's dequeue query has `WHERE status = 'QUEUED'`, so the expired run (now status `EXPIRED`) is invisible. The worker simply gets a different run.

### TTL vs. Execution Timeout

Do not confuse TTL with execution timeout. They address different problems:

| Property | TTL | Execution Timeout (Heartbeat) |
|----------|-----|-------------------------------|
| Applies to state | `QUEUED` (waiting for execution) | `EXECUTING` (during execution) |
| Measures | Time in queue | Time since last heartbeat |
| Terminal state | `EXPIRED` | `FAILED` (with retry) |
| Purpose | Discard stale work | Detect dead workers |
| Retryable? | No (task is irrelevant) | Yes (task is still relevant, worker died) |

A run can have both a TTL and heartbeat monitoring. The TTL protects against queue delays; the heartbeat protects against worker crashes.

### TTL and Retries

An important design question: if a run fails and is retried, does the TTL apply to the retry? There are two reasonable approaches:

**Option A: TTL counts from original creation time.** The first attempt was created at T=0 with TTL=300. It fails at T=200 and is retried. The retry is enqueued at T=200. The TTL check compares `created_at` (T=0) + TTL (300s) against NOW. At T=301, the retry is expired even though it has only been in the queue for 101 seconds. This is strict: the task creator said "this task is worthless after 5 minutes," and 5 minutes have passed since the original request.

**Option B: TTL resets on retry.** Each retry attempt gets a fresh TTL window. The original run was created at T=0. The retry is created at T=200 with a new `created_at` of T=200. It has a full 300 seconds (until T=500) to be dequeued. This is lenient: each attempt gets a fair chance.

In our system, we use Option A (TTL from original creation time) by default. The rationale: TTL represents the business constraint ("this verification email is useless after 5 minutes"), not a fairness constraint. The user's intent is not "give the system 5 minutes per attempt" but "give the system 5 minutes total." However, the task definition can override this behavior if lenient TTL is desired.

### Comparison to Other TTL Systems

**Redis TTL (`EXPIRE`, `TTL`)**: Redis supports key-level TTL. After the TTL expires, the key is automatically deleted. Redis uses two strategies for expiration: lazy expiration (check TTL on access and delete if expired) and active expiration (a background process randomly samples keys and deletes expired ones). Our TTL checker is analogous to Redis's active expiration — a periodic background scan.

**Kafka Message Retention**: Kafka does not have per-message TTL. Instead, it has topic-level retention policies (e.g., retain messages for 7 days). Consumers are expected to keep up with the stream; if they fall behind, messages are deleted by the retention policy, not by TTL. This is a different model — retention is about storage management, not message relevance.

**SQS Visibility Timeout**: Amazon SQS has a visibility timeout: when a consumer receives a message, it becomes invisible to other consumers for the timeout duration. If the consumer does not delete the message (confirm processing) within the timeout, the message becomes visible again. This is closer to our heartbeat concept than our TTL concept. SQS also has a message retention period (default 4 days, max 14 days) which is analogous to TTL.

**RabbitMQ Message TTL**: RabbitMQ supports both per-queue TTL and per-message TTL via the `expiration` property. When a message's TTL expires, it is either dead-lettered (moved to a dead letter exchange) or silently dropped. Dead-lettering is analogous to our `EXPIRED` terminal state — the message is not processed but its fate is recorded.

### Resources

- [Time-to-Live and Expiration — RabbitMQ](https://www.rabbitmq.com/docs/ttl) — Official RabbitMQ documentation on message and queue TTL.
- [Message Expiration Pattern Explained — Tributary Data (Medium)](https://medium.com/event-driven-utopia/message-expiration-pattern-explained-fdaf2c10d2de) — Pattern-level explanation of message expiration in event-driven systems.
- [Azure Service Bus Message Expiration and TTL](https://learn.microsoft.com/en-us/azure/service-bus-messaging/message-expiration) — How Azure handles message TTL and dead-lettering.
- [Redis EXPIRE Documentation](https://redis.io/docs/latest/commands/expire/) — How Redis implements key-level TTL with lazy and active expiration.
- [TTL and Dead Message Queue — Solace](https://tutorials.solace.dev/jcsmp/ttl-and-dmq/) — Tutorial on TTL with dead message queue handling.

### Test-Your-Understanding Questions

1. **Should TTL count from creation time or from when it entered QUEUED?** In most cases, creation time. The run is created and immediately enters `QUEUED`, so there is no difference. But if there is a delay between creation and queuing (e.g., a scheduled run), the question becomes whether TTL measures "time since the user requested this" or "time since it became eligible for execution." The answer depends on the business semantics. For a verification email, TTL should count from when the user clicked "send" (creation), not from when the email entered the queue (which could be delayed by scheduling).

2. **What if a task is important but the queue is backed up?** TTL does not care about importance. If the queue is backed up and the TTL expires, the run is expired. The solution is either: (a) increase the TTL for important tasks, (b) give important tasks higher priority so they are dequeued before the backlog, (c) add more workers to reduce queue depth, or (d) do not set a TTL on tasks that must eventually execute regardless of delay.

3. **How does TTL interact with retries?** This depends on the design choice (Option A vs Option B above). With Option A (TTL from original creation), retries inherit the original deadline. A task with TTL=300 that first fails at T=200 has only 100 seconds left for the retry. With Option B (TTL resets), each retry gets a fresh 300-second window. Our system defaults to Option A because TTL represents a business constraint on the overall operation, not per-attempt fairness.

4. **What happens if the TTL checker process is slow or crashes?** If the TTL checker crashes, expired runs accumulate in the QUEUED state. They could be dequeued and executed even though their TTL has passed, because the dequeue query does not check TTL (only the background checker does). Fix: add a TTL check to the dequeue query as a defense-in-depth measure: `AND (ttl IS NULL OR created_at + (ttl * INTERVAL '1 second') > NOW())`. This way, even if the background checker is down, workers will not pick up expired runs.

5. **Can a run be expired after it starts executing?** No. TTL only applies to the `QUEUED` state. Once a run is `EXECUTING`, it is protected by heartbeat monitoring, not TTL. The TTL checker query has `WHERE status = 'QUEUED'` — it ignores executing runs. This is intentional: once work has started, abandoning it wastes the work already done. The heartbeat mechanism handles the "executing too long" case differently (it fails and retries the run rather than expiring it).

6. **Why is EXPIRED a terminal state with no retry?** Because TTL represents a business decision that the task is no longer relevant. Retrying an expired verification email 30 minutes later is worse than not sending it at all. If the caller wants the task re-attempted, they should trigger a new run with a fresh TTL. Automatic retry of expired runs would undermine the purpose of TTL.

---

## 5. Optimistic Locking Hardening

### Recap: What Is Optimistic Locking?

Optimistic locking was implemented in Phase 2. The core idea: every run has a `version` column (integer, starting at 1). Every state transition includes the expected version in the WHERE clause:

```sql
UPDATE runs
SET status = 'EXECUTING',
    version = version + 1
WHERE id = $1
  AND status = 'QUEUED'
  AND version = $expectedVersion;
```

If the version does not match (because another process already transitioned the run), the UPDATE matches zero rows. The caller detects this and raises a `VersionConflictError`. No data is corrupted. No run is in two states simultaneously. This is the database equivalent of a CAS (Compare-and-Swap) operation.

### Why Phase 4 Focuses on Testing

The optimistic locking implementation is straightforward — it is a WHERE clause and a row count check. What is hard is proving that it works under concurrent load. Race conditions are, by nature, timing-dependent. A bug might manifest once in 10,000 attempts, only on a particular hardware/OS combination, only under load.

Phase 4 is about writing tests that deliberately create the exact concurrent scenarios that optimistic locking is designed to prevent, and verifying that the locking holds.

### The Race Conditions We Must Test

**Race 1: Two workers dequeue the same run simultaneously.**

Two workers poll the dequeue endpoint at the exact same time. Both read the same run (status: QUEUED, version: 1). Both attempt to transition it to EXECUTING.

Without optimistic locking: both succeed. The run is now "executing" on two workers. Both do the work. The task executes twice. Side effects (sending an email, charging a credit card) happen twice.

With optimistic locking: one worker's UPDATE hits first (version 1 matches, transitions to EXECUTING, increments version to 2). The other worker's UPDATE finds version 2, not version 1. It matches zero rows. It receives a `VersionConflictError`. It retries the dequeue and gets a different run. The task executes exactly once.

Note: with `SELECT ... FOR UPDATE SKIP LOCKED`, this race is already prevented at the dequeue level (the second worker skips the locked row). But optimistic locking provides a second layer of defense in case the dequeue and transition are not perfectly atomic.

**Race 2: Worker completes while heartbeat monitor fails the run.**

The worker finishes the task and tries to transition the run from EXECUTING to COMPLETED. Simultaneously, the heartbeat monitor detects an expired deadline and tries to transition the same run from EXECUTING to FAILED.

Without optimistic locking: both transitions succeed. The run's final status depends on which UPDATE executes last — the "last writer wins" problem. If the heartbeat monitor's update executes second, the run is FAILED even though the work completed successfully. The run is retried unnecessarily, executing the task twice.

With optimistic locking: one transition wins (say the worker completes it — version 2 -> 3, status COMPLETED). The heartbeat monitor's transition fails (expected version 2, actual version 3). It gets `VersionConflictError`, logs it, and moves on. The run stays COMPLETED. Correct.

**Race 3: TTL checker expires while worker dequeues.**

The TTL checker tries to move a run from QUEUED to EXPIRED. A worker simultaneously tries to move it from QUEUED to EXECUTING. Both read version 1.

Without optimistic locking: both succeed. The run is simultaneously EXPIRED and EXECUTING. Chaos.

With optimistic locking: one wins. If the worker wins, the run executes (its TTL technically passed, but it was dequeued just in time — a reasonable outcome). If the TTL checker wins, the run is expired and the worker gets a `VersionConflictError` on the transition (and retries dequeue to get a different run).

**Race 4: Retry logic creates a new attempt while the previous attempt is still completing.**

This is more subtle. The heartbeat monitor fails a run. The retry logic immediately re-enqueues it. A new worker dequeues it and starts executing. Then the original worker (which was slow, not dead) tries to mark the run as completed.

Without optimistic locking: the original worker's UPDATE overwrites the EXECUTING status with COMPLETED. The new worker is now executing a run that the database says is completed. The new worker's eventual completion UPDATE will fail because the run is already COMPLETED (depending on the WHERE clause).

With optimistic locking: the original worker holds version N-1. The run has since been failed (version N), re-enqueued (version N+1), and dequeued by the new worker (version N+2). The original worker's UPDATE with `AND version = N-1` matches zero rows. Its completion is rejected. The new worker proceeds. Correct.

### The Test Pattern: Forcing Concurrency

The challenge with testing race conditions is that you need actual concurrent operations, not sequential ones pretending to be concurrent. The standard pattern in JavaScript/TypeScript:

```typescript
test('two simultaneous transitions: one succeeds, one gets VersionConflict', async () => {
  // Setup: create a run in QUEUED state, version 1
  const run = await createRun({ status: 'QUEUED', version: 1 });

  // Execute: two transitions simultaneously
  const results = await Promise.allSettled([
    transitionRun(run.id, {
      from: 'QUEUED',
      to: 'EXECUTING',
      expectedVersion: 1,
    }),
    transitionRun(run.id, {
      from: 'QUEUED',
      to: 'EXECUTING',
      expectedVersion: 1,
    }),
  ]);

  // Assert: exactly one succeeded, exactly one failed
  const successes = results.filter(r => r.status === 'fulfilled');
  const failures = results.filter(r => r.status === 'rejected');

  expect(successes).toHaveLength(1);
  expect(failures).toHaveLength(1);
  expect(failures[0].reason).toBeInstanceOf(VersionConflictError);

  // Assert: the run is in EXECUTING state with version 2
  const updatedRun = await getRun(run.id);
  expect(updatedRun.status).toBe('EXECUTING');
  expect(updatedRun.version).toBe(2);
});
```

`Promise.allSettled` is critical here (not `Promise.all`). `Promise.all` rejects as soon as any promise rejects, losing the other result. `Promise.allSettled` waits for all promises to settle and returns the outcome of each.

Why this works: `Promise.allSettled` kicks off both transitions concurrently. Because they are both async database operations, they interleave at the I/O level. One will hit the database first and succeed; the other will hit the database with a stale version and fail.

### When VersionConflict Is Expected vs. Unexpected

Not all VersionConflictErrors are bugs. The system is designed to produce them in certain scenarios:

**Expected (normal operation):**
- Two workers race to dequeue the same run — one gets `VersionConflict`, retries, gets a different run. This is the normal contention path.
- Heartbeat monitor races with worker completion — one gets `VersionConflict`, which is fine because the other one did the right thing.
- TTL checker races with dequeue — one gets `VersionConflict`, fine.

**Unexpected (bug indicator):**
- A worker tries to complete a run and gets `VersionConflict` every time — this suggests the run's version is being modified by something else between the worker reading the version and writing the completion. Could indicate a bug in heartbeat reset logic.
- The same worker gets `VersionConflict` on dequeue repeatedly — something is modifying runs that the worker just locked with `FOR UPDATE SKIP LOCKED`. This should not happen.
- A run transitions from COMPLETED to anything — this is a state machine violation regardless of version, and suggests a logic bug in the transition function.

The test suite should verify both categories: expected `VersionConflict` in race scenarios (test passes if the error occurs) and unexpected `VersionConflict` in non-race scenarios (test fails if the error occurs).

### The "Double Execution" Prevention Guarantee

The ultimate guarantee optimistic locking provides: **a run will never be concurrently executed by two workers.** Even in the worst-case scenario — two workers somehow both receive the same run ID (bypassing `SKIP LOCKED` due to a bug, or receiving it from a cache) — only one can transition it from QUEUED to EXECUTING. The other will fail the version check. One execution. One result. Zero duplicates.

This guarantee is what makes it safe for tasks to have side effects (sending emails, charging credit cards, writing to external APIs). Without this guarantee, every task would need to be idempotent — able to be safely executed multiple times. With this guarantee, idempotency is still a best practice, but not a hard requirement for correctness.

### Testing Strategy

The Phase 4 test suite for optimistic locking should include:

1. **Basic CAS test**: Single transition succeeds, version increments.
2. **Concurrent dequeue test**: Two workers, one run, `Promise.allSettled` — verify exactly one succeeds.
3. **Concurrent completion/failure test**: Worker completion races with heartbeat failure — verify exactly one succeeds and the final state is consistent.
4. **TTL expiry race test**: TTL checker races with dequeue — verify exactly one wins.
5. **Stale heartbeat test**: Heartbeat for an old version is rejected.
6. **Sequential transition test**: QUEUED -> EXECUTING -> COMPLETED works when versions are tracked correctly.
7. **Invalid transition test**: COMPLETED -> EXECUTING is rejected regardless of version (state machine violation).
8. **High concurrency stress test**: 10+ concurrent transitions against the same run — verify exactly one succeeds.

### Resources

- [Optimistic Locking — Milan Jovanovic](https://www.milanjovanovic.tech/blog/solving-race-conditions-with-ef-core-optimistic-locking) — Practical guide to solving race conditions with version-based locking.
- [Compare and Swap — Jenkov](https://jenkov.com/tutorials/java-concurrency/compare-and-swap.html) — Foundational CAS concepts from hardware to application level.
- [Database Locking to Solve Race Conditions — CoderBased](https://www.coderbased.com/p/database-locking) — Overview of pessimistic vs. optimistic locking for race condition prevention.
- [Compare and Swap in Redis — Oliver Nguyen](https://olivernguyen.io/w/redis.cas/) — How to implement CAS semantics in Redis (relevant to our Redis queue).
- [Optimistic Locking vs Pessimistic Locking — Medium](https://medium.com/@abhirup.acharya009/managing-concurrent-access-optimistic-locking-vs-pessimistic-locking-0f6a64294db7) — Side-by-side comparison of the two approaches.

### Test-Your-Understanding Questions

1. **Why is testing race conditions hard?** Race conditions are non-deterministic. They depend on exact timing of interleaved operations, which is influenced by CPU scheduling, I/O latency, and operating system behavior. A test that runs transitions sequentially will never trigger a race. You must use `Promise.allSettled` (or equivalent) to create actual concurrency. Even then, the race might not trigger on every test run — you may need to run the test in a loop to catch intermittent failures.

2. **Why use `Promise.allSettled` instead of `Promise.all`?** `Promise.all` short-circuits on the first rejection. If the `VersionConflictError` happens first, `Promise.all` rejects immediately and you lose the result of the successful transition. `Promise.allSettled` waits for all promises to settle (fulfilled or rejected) and returns an array of results, allowing you to assert on both outcomes.

3. **When is VersionConflict expected vs. unexpected?** Expected: concurrent dequeue races, heartbeat monitor vs. worker completion races, TTL checker vs. dequeue races. These are normal contention patterns. Unexpected: a worker gets VersionConflict on every dequeue attempt, or a run transitions from a terminal state (COMPLETED, FAILED, EXPIRED) to any other state. These indicate bugs.

4. **How does optimistic locking prevent "double execution"?** Two workers cannot both transition the same run from QUEUED to EXECUTING because the UPDATE includes `AND version = $expected`. The first UPDATE succeeds and increments the version. The second UPDATE finds a different version and matches zero rows. Only one worker gets the run. Only one execution happens.

5. **What is the difference between optimistic locking and `SELECT FOR UPDATE SKIP LOCKED`?** `SKIP LOCKED` prevents two transactions from even seeing the same row — it operates at the database lock level during the SELECT. Optimistic locking operates at the UPDATE level — it allows both readers to see the row but ensures only one writer succeeds. They are complementary: `SKIP LOCKED` is the first line of defense (prevent the race from starting), and optimistic locking is the second line of defense (resolve the race if it starts anyway). Using both provides defense in depth.

6. **Can optimistic locking cause livelock?** In theory, yes. If two processes repeatedly read, try to write, conflict, retry, and conflict again, neither makes progress. In practice, this is extremely rare for task queues because: (a) there are many runs in the queue, so a conflicted worker can just pick a different run, (b) the time between read and write is very short (a single SQL statement), reducing the window for conflict, and (c) natural timing differences between workers prevent perfect synchronization. If livelock were a concern, you could add random backoff to retry logic.

---

## Summary: How Phase 4 Components Interact

The five components of Phase 4 form an integrated reliability layer:

```
                    ┌─────────────────────┐
                    │   Worker Starts     │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Worker Registration │ (register task types, capacity)
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Dequeue Loop       │ (filtered by registered task types)
                    │  (with SKIP LOCKED  │
                    │   + optimistic lock) │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
    ┌─────────▼─────────┐     │     ┌──────────▼──────────┐
    │  TTL Checker       │     │     │  Run Executes       │
    │  (expires stale    │     │     │  (worker sends      │
    │   QUEUED runs)     │     │     │   heartbeats)       │
    └────────────────────┘     │     └──────────┬──────────┘
                               │                │
                    ┌──────────▼──────────┐     │
                    │ Heartbeat Monitor   │◄────┘
                    │ (detects dead       │  (checks deadlines)
                    │  workers, triggers  │
                    │  retry via          │
                    │  optimistic lock)   │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  SIGTERM Received   │
                    │  (graceful shutdown)│
                    │  1. Stop dequeuing  │
                    │  2. Drain work      │
                    │  3. Deregister      │
                    │  4. Close conns     │
                    │  5. Exit            │
                    └─────────────────────┘
```

- **Worker Registration** ensures only capable workers receive matching tasks.
- **TTL Expiry** prevents stale queued runs from being executed after they are no longer relevant.
- **Heartbeat Monitoring** detects crashed workers and recovers stuck runs.
- **Graceful Shutdown** minimizes abandoned work during planned termination.
- **Optimistic Locking** is the glue that prevents race conditions between all of these concurrent processes — the heartbeat monitor, the TTL checker, the worker, and the dequeue logic can all operate concurrently without corrupting state.

Together, they answer the fundamental question of Phase 4: **What happens when things go wrong?** Workers crash, networks partition, queues back up, deployments roll out — and the system recovers automatically, correctly, without duplicate execution or lost work.
