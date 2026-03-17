# Phase 2 Deep Dive: State Machine + Retries

> **Scope**: This document covers the six foundational concepts behind Phase 2 of reload.dev -- the state machine that governs a run's lifecycle and the retry/scheduling machinery that keeps it reliable under failure.

---

## Table of Contents

1. [Finite State Machines](#1-finite-state-machines)
2. [Exponential Backoff with Jitter](#2-exponential-backoff-with-jitter)
3. [Optimistic Locking (CAS)](#3-optimistic-locking-cas)
4. [Append-Only Event Logs](#4-append-only-event-logs)
5. [Functional Core, Imperative Shell](#5-functional-core-imperative-shell)
6. [Delayed Run Scheduling](#6-delayed-run-scheduling)

---

## 1. Finite State Machines

### What It Is

A **Finite State Machine** (FSM) is a mathematical model of computation consisting of:

- A finite set of **states** (S)
- A finite set of **events** (or inputs) (E)
- A **transition function** (T: S x E -> S) that maps a current state and an event to a next state
- An **initial state** (s0)
- A set of **terminal states** (F) -- states from which no further transitions are possible

Formally: an FSM is a 5-tuple (S, E, T, s0, F). At any moment, the machine is in exactly one state. When an event occurs, the transition function determines the next state. If no transition is defined for the current (state, event) pair, the event is rejected.

### What Problem It Solves

Without a state machine, task lifecycle management devolves into scattered `if/else` chains across the codebase. Each new state or transition requires touching dozens of locations. Bugs arise from impossible transitions -- e.g., a task that has already completed being retried, or a cancelled task emitting a success event. FSMs make impossible states impossible by explicitly enumerating every legal transition and rejecting everything else.

State machines reduce complexity by breaking down complex workflows into manageable and distinct steps, improve testability since each state and transition can be tested independently, and provide an auditable history of state transitions for a clear audit trail of the resource's lifecycle.

### How It Works Under the Hood

#### Guards

A **guard** is a boolean predicate attached to a transition. The transition only fires if the guard evaluates to true. For example, transitioning from `QUEUED` to `EXECUTING` might require a guard that checks whether a worker is available. Transitioning from `EXECUTING` to `DELAYED` might check `currentAttempts < maxAttempts`. Guards keep transition logic declarative -- the state machine definition itself encodes business rules without requiring separate states for every possible condition.

Without guards, you would need explicit states like `FAILED_ATTEMPT_1_RETRYABLE`, `FAILED_ATTEMPT_2_RETRYABLE`, etc. Guards allow you to keep a small state set and encode conditional logic as predicates on metadata.

#### Side Effects as Return Values

In a well-designed FSM, the transition function does not perform side effects directly. Instead, it returns a description of what side effects should occur. For example, transitioning from `EXECUTING` to `WAITING_FOR_RETRY` might return `{ sideEffect: "scheduleRetry", delay: 5000 }`. The calling code (the "imperative shell" -- see Section 5) is responsible for executing these side effects. This separation makes the state machine trivially testable: feed in (state, event), assert on the returned (newState, sideEffects) pair.

#### Terminal States

Terminal (or final/accepting) states are states from which no outgoing transitions exist. Once a run enters `COMPLETED`, `FAILED`, `CANCELED`, or `EXPIRED`, it stays there permanently. Terminal states are critical for resource cleanup -- once a run reaches a terminal state, its worker slot can be released, its timeout timer cancelled, and its final status recorded.

If terminal states could transition out, you would lose all guarantees: a COMPLETED run could suddenly become EXECUTING again, violating the invariant that completed work is done. The permanence of terminal states is what makes the rest of the system safe.

#### The State Explosion Problem

The state explosion problem occurs when the number of states grows combinatorially. If a task has 4 statuses and 3 retry modes and 2 priority levels, a naive approach would need 4 x 3 x 2 = 24 states. As the [Statecharts documentation](https://statecharts.dev/state-machine-state-explosion.html) explains: "beyond very simple examples, state machines often end up with a large number of states, a lot of them with identical transitions."

Solutions include:
- **Hierarchical state machines (statecharts)**: Group related states into parent states that share transitions.
- **Parallel/orthogonal states**: Model independent concerns in separate, concurrent state machines.
- **Extended state (metadata)**: Keep the number of FSM states small and use separate data fields for orthogonal dimensions.

Trigger.dev handles this by keeping the run status as the FSM state while tracking retry count, attempt number, failure type, and other metadata as separate fields. The state machine has ~13 states; the metadata captures everything else. Guards inspect metadata to decide transitions.

### How Trigger.dev Models 13+ States

Trigger.dev defines the following run statuses, each representing a distinct phase in the run lifecycle. From their [documentation](https://trigger.dev/docs/runs):

```
PENDING_VERSION  -- Task code not yet deployed; run waits for deployment
DELAYED          -- Run scheduled for future execution (via delay option)
QUEUED           -- Ready to execute; waiting for a worker to pick it up
DEQUEUED         -- Pulled from queue, about to be dispatched to a worker
EXECUTING        -- Worker is actively running the task code
WAITING          -- Task called a blocking operation (e.g., triggerAndWait)
COMPLETED        -- Task function returned successfully
FAILED           -- Task threw an error and exhausted all retries
CANCELED         -- Run was explicitly cancelled by user or system
TIMED_OUT        -- Run exceeded its maxDuration
CRASHED          -- Worker process died unexpectedly (OOM, segfault)
SYSTEM_FAILURE   -- Platform-level failure (infra issue, not user code)
EXPIRED          -- Run was not started before its TTL elapsed
```

Notice CRASHED vs. FAILED vs. SYSTEM_FAILURE -- these are separate terminal states rather than a single FAILED state with metadata. Trigger.dev chose state explosion here deliberately because each terminal state has different operational semantics (CRASHED might trigger infrastructure alerts; FAILED is a user code problem; SYSTEM_FAILURE indicates a platform bug).

#### Transition Diagram

```
                          deploy
  PENDING_VERSION ──────────────────> QUEUED
                                        |
  DELAYED ──── schedule fires ──────> QUEUED
                                        |
                                     dequeue
                                        |
                                        v
                                     DEQUEUED
                                        |
                                    dispatch
                                        |
                                        v
                               ┌── EXECUTING ──┐
                               |       |       |
                          wait |   success  error (retries left)
                               |       |       |
                               v       v       v
                           WAITING  COMPLETED  QUEUED (re-enqueue)
                               |
                           resume
                               |
                               v
                           EXECUTING

  Any non-terminal state ──> CANCELED  (user cancellation)
  Any non-terminal state ──> TIMED_OUT (maxDuration exceeded)
  Any non-terminal state ──> CRASHED   (worker death)
  Any non-terminal state ──> SYSTEM_FAILURE (platform error)
  QUEUED (TTL elapsed)   ──> EXPIRED
  EXECUTING (no retries) ──> FAILED
```

### Alternatives

- **Ad-hoc if/else chains**: Simpler for trivial workflows but unmaintainable at scale. Invariants are enforced nowhere and violated everywhere.
- **Workflow engines** (Temporal, AWS Step Functions): More powerful but heavier; they manage the entire execution environment, not just state transitions. Temporal models workflow execution as an event history rather than an explicit FSM.
- **Actor model** (Erlang/Akka): Each task is an actor with its own state; useful for massive concurrency but adds distributed systems complexity.
- **Statecharts** (XState): Hierarchical and parallel state machines with history states, nested machines, and visual tooling. Great for complex UIs but can be over-engineered for backend task queues.

### How Production Systems Use It

Temporal models workflow execution as a state machine with states like `RUNNING`, `COMPLETED`, `FAILED`, `CANCELED`, `TERMINATED`, and `TIMED_OUT`. AWS Step Functions use Amazon States Language to define FSMs with `Task`, `Choice`, `Wait`, `Parallel`, `Succeed`, and `Fail` states. Kubernetes models Pod lifecycle as a state machine: `Pending -> Running -> Succeeded/Failed`. The TCP protocol (RFC 793) defines 11 states including CLOSED, LISTEN, SYN_SENT, ESTABLISHED, FIN_WAIT, and TIME_WAIT -- one of the most famous FSMs in computing. Every TCP implementation across every operating system implements this exact machine. That is the power of a formally defined state machine -- it is a specification, not just an implementation detail.

### Resources

- [XState Documentation -- State Machines and Statecharts](https://statemachine.guide/)
- [Temporal: Beyond State Machines](https://temporal.io/blog/temporal-replaces-state-machines-for-distributed-applications)
- [Modelling Workflows with FSMs in .NET](https://www.lloydatkinson.net/posts/2022/modelling-workflows-with-finite-state-machines-in-dotnet/)
- [Richard Clayton -- Use State Machines!](https://rclayton.silvrback.com/use-state-machines)
- [Trigger.dev Runs Documentation](https://trigger.dev/docs/runs)
- [Statecharts -- State Machine State Explosion](https://statecharts.dev/state-machine-state-explosion.html)

### Test Questions

1. What are the five components of the formal FSM definition, and what role does each play?
2. A run is in `COMPLETED` state and receives a `retry` event. What should happen and why?
3. Explain the state explosion problem. If a system has N boolean flags that are independent of the main state, how many total states would a flat FSM need? How do hierarchical state machines (statecharts) solve this?
4. Why should the transition function return side effects as data rather than executing them directly? What testing benefit does this provide?
5. In the Trigger.dev model, what is the difference between `CRASHED` and `SYSTEM_FAILURE`? Why are both needed rather than a single FAILED state with a `failureType` metadata field?
6. A guard on the `QUEUED -> EXECUTING` transition checks for worker availability. If the guard returns false, what happens to the run? Does it change state?

---

## 2. Exponential Backoff with Jitter

### What It Is

Exponential backoff is a retry strategy where the delay between successive retries grows exponentially: 1s, 2s, 4s, 8s, 16s, etc. **Jitter** adds randomness to this delay to prevent multiple clients from retrying in lockstep. Together, they form the standard retry strategy for distributed systems.

The base formula for exponential backoff is:

```
delay = min(maxDelay, baseDelay * 2^attempt)
```

### What Problem It Solves

#### The Thundering Herd Problem

Imagine 1,000 clients all fail at the same time because a database goes down briefly. Without jitter, all 1,000 clients retry after exactly 1 second, hammering the newly-recovered database and potentially bringing it down again. Then they all retry after exactly 2 seconds, causing the same spike. This is the **thundering herd** -- correlated retries create load spikes that are as bad as or worse than the original failure.

As the canonical [AWS Architecture Blog post](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) explains: when failures are caused by overload or contention, backing off alone does not help as much as expected because of correlation -- if all failed calls back off to the same time, they cause contention or overload again when retried. Without jitter, there are clusters of calls; instead of reducing the number of clients competing in every round, you just shift when the cluster occurs.

Linear backoff (1s, 2s, 3s, 4s...) does not solve this because the delays are still deterministic and therefore correlated across clients. Exponential backoff reduces frequency but does not break correlation. Only jitter -- randomization -- breaks the correlation and spreads retries into an approximately uniform distribution over time.

### How It Works Under the Hood

#### Linear vs. Exponential Backoff

| Strategy | Delay Sequence (base=1s) | Total wait after 5 retries |
|---|---|---|
| Constant | 1, 1, 1, 1, 1 | 5s |
| Linear | 1, 2, 3, 4, 5 | 15s |
| Exponential | 1, 2, 4, 8, 16 | 31s |

Exponential backoff gives the failing system progressively more time to recover with each retry. But it does nothing about correlation between clients. Every client that failed at the same time will compute the exact same delay sequence, creating synchronized retry waves.

#### Three Jitter Strategies

The canonical [AWS Architecture Blog post](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) defines three strategies, each with different tradeoffs:

**1. Full Jitter**
```
sleep = random_between(0, min(cap, base * 2^attempt))
```
The delay is uniformly random between 0 and the exponential backoff value. This provides maximum spread -- retries are distributed evenly across the entire window. However, it occasionally produces very short delays (near zero), meaning some retries happen almost immediately, providing less protection for the failing service.

AWS's simulations show that full jitter produces the fewest total calls and completes work fastest in high-contention scenarios. It is mathematically optimal for aggregate throughput.

**2. Equal Jitter**
```
temp = min(cap, base * 2^attempt)
sleep = temp/2 + random_between(0, temp/2)
```
Keeps at least half the backoff delay and randomizes the other half. This guarantees a minimum wait while still spreading retries. It avoids the "retry almost immediately" problem of full jitter while still providing good de-correlation. The tradeoff is slightly more total work compared to full jitter.

**3. Decorrelated Jitter**
```
sleep = min(cap, random_between(base, sleep_prev * 3))
```
Each retry's delay depends on the *previous* delay rather than the attempt number. This creates longer delays on average and has a "self-correcting" property: if one retry happens quickly, the next one tends to wait longer (because `sleep_prev` is small, so `sleep_prev * 3` is still moderate, but the random range starts from `base`). If a retry waits a long time, the next one has a wider range. The [AWS Builders' Library](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) recommends this approach for most use cases.

#### Error Categorization: Retryable vs. Non-Retryable

Not all errors should be retried. Retrying a non-retryable error wastes resources, delays failure reporting to the user, and can cause harmful side effects (e.g., sending the same invalid request 10 times):

| Error Type | Retryable? | Examples |
|---|---|---|
| Network timeout | Yes | ETIMEDOUT, ECONNRESET, ECONNREFUSED |
| Server error (5xx) | Yes | 500 Internal Server Error, 502 Bad Gateway, 503 Service Unavailable |
| Rate limited (429) | Yes | Too Many Requests (respect Retry-After header) |
| Client error (4xx) | No | 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found |
| Validation error | No | "Field 'email' is required", schema validation failure |
| Business logic error | No | "Insufficient funds", "User already exists" |
| Infrastructure crash | Yes | Worker OOM, segfault -- the user's code never got a fair chance |

In reload.dev, we distinguish between `SYSTEM_ERROR` (always retryable -- the infrastructure failed, not the user's code) and `TASK_ERROR` (retryable only if the user configured retries for their task). This distinction drives the guard in the state machine: `FAIL` event with `SYSTEM_ERROR` always transitions to DELAYED (if retries remain), while `FAIL` with a non-retryable `TASK_ERROR` goes straight to FAILED.

#### The reload.dev Formula

In reload.dev, the jitter formula used is:

```typescript
const clamped = Math.min(maxDelay, baseDelay * Math.pow(2, attempt));
const jittered = clamped * (0.75 + Math.random() * 0.5);
```

This is a variation of "equal jitter" that keeps the delay between 75% and 125% of the computed exponential value. The range is intentionally narrow -- it breaks correlation between clients while keeping delays predictable enough for operators to reason about.

Worked example with `baseDelay=1000ms`, `maxDelay=60000ms`:

| Attempt | Clamped (ms) | Min delay (x0.75) | Max delay (x1.25) |
|---|---|---|---|
| 0 | 1000 | 750 | 1250 |
| 1 | 2000 | 1500 | 2500 |
| 2 | 4000 | 3000 | 5000 |
| 3 | 8000 | 6000 | 10000 |
| 4 | 16000 | 12000 | 20000 |
| 5 | 32000 | 24000 | 40000 |
| 6 | 60000 (capped) | 45000 | 75000 |

The minimum multiplier of 0.75 ensures that the delay is always at least 75% of the clamped value. Zero-delay retries are impossible with this formula, unlike full jitter.

### Alternatives

- **Constant backoff**: Simple but causes thundering herds. Only appropriate for single-client scenarios.
- **Linear backoff**: Better than constant but still too deterministic. Does not break correlation.
- **Retry budgets**: Instead of per-request retries, allocate a budget (e.g., "retry at most 10% of total requests"). Used by gRPC and Envoy proxy. Prevents retries from becoming the source of overload. See the [Google SRE book](https://sre.google/sre-book/handling-overload/).
- **Circuit breaker**: Stop retrying entirely when the failure rate exceeds a threshold. Complements backoff rather than replacing it. The classic reference is Michael Nygard's "Release It!"
- **Token bucket**: Rate-limit retries across all clients using a shared token bucket. Useful when you want global retry rate control.

### How Production Systems Use It

AWS SDKs use exponential backoff with full jitter by default, with configurable base delay and max retries. Most AWS SDKs now support exponential backoff and jitter as part of their retry behavior in standard or adaptive modes. Google Cloud client libraries use a similar approach with configurable initial delay, multiplier, and maximum delay. Stripe's API client uses exponential backoff with jitter and categorizes errors into retryable and non-retryable. Redis Sentinel uses exponential backoff when attempting failover. Kafka producers use backoff with jitter when retrying failed sends.

### Resources

- [Exponential Backoff and Jitter -- AWS Architecture Blog](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) -- The canonical reference with three jitter strategies and simulations.
- [Timeouts, Retries, and Backoff with Jitter -- AWS Builders' Library](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) -- A deeper companion piece from Amazon.
- [Marc Brooker -- Jitter: Making Things Better With Randomness](https://brooker.co.za/blog/2015/03/21/backoff.html) -- Mathematical analysis of jitter strategies.
- [Google SRE Book -- Handling Overload](https://sre.google/sre-book/handling-overload/) -- Retry budgets and preventing cascading failures.
- [Google Cloud -- Retry Strategy](https://cloud.google.com/storage/docs/retry-strategy)

### Test Questions

1. Why does exponential backoff alone (without jitter) fail to solve the thundering herd problem? Draw a timeline showing 100 clients retrying with pure exponential backoff vs. exponential backoff with full jitter.
2. Compute the delay range for `baseDelay=500ms`, `attempt=4`, `maxDelay=30000ms` using the formula `clamped * (0.75 + Math.random() * 0.5)`. Show your work.
3. Compare full jitter and equal jitter. In what scenario would full jitter's occasional near-zero delays be problematic? When would equal jitter's guaranteed minimum delay be wasteful?
4. A client receives a `400 Bad Request` response. Should it retry? Why or why not? What about a `503 Service Unavailable`?
5. Explain how decorrelated jitter is "self-correcting." What happens after a very short delay? What happens after a very long delay?
6. If 500 clients all start retrying with full jitter (cap=60s, base=1s), describe the approximate distribution of retry times for attempt 5. How does this compare to the distribution without jitter?

---

## 3. Optimistic Locking (CAS)

### What It Is

**Optimistic locking** is a concurrency control strategy where you read data, do your work, and then verify at write time that nobody else modified the data in the meantime. If someone did, your write fails and you must retry. The core mechanism is **Compare-and-Swap (CAS)**: the update only succeeds if the current value matches what you expect.

In databases, this is typically implemented with a **version column**:

```sql
-- Read
SELECT id, status, version FROM runs WHERE id = 'run_123';
-- Returns: status='QUEUED', version=5

-- Update (only succeeds if version is still 5)
UPDATE runs
SET status = 'EXECUTING', version = 6
WHERE id = 'run_123' AND version = 5;

-- Check affected rows: if 0, someone else modified the row
```

### What Problem It Solves

#### The Lost Update Problem

Two workers both read a run's status as `QUEUED`. Both decide to transition it to `EXECUTING`. Without any concurrency control:

1. Worker A reads: `status=QUEUED, version=5`
2. Worker B reads: `status=QUEUED, version=5`
3. Worker A writes: `status=EXECUTING` -- succeeds
4. Worker B writes: `status=EXECUTING` -- also succeeds, overwriting Worker A's legitimate claim

Now two workers think they own the same run. One of them will do wasted work, and if both write results, data corruption follows. This is the **lost update** problem -- Worker A's update is silently lost because Worker B's update overwrites it without knowing it happened. As [Vlad Mihalcea explains](https://vladmihalcea.com/a-beginners-guide-to-database-locking-and-the-lost-update-phenomena/): "an update is lost when a user overrides the current database state without realizing that someone else changed it between the moment of data loading and the moment the update occurs."

### How It Works Under the Hood

#### Pessimistic vs. Optimistic Locking

| Aspect | Pessimistic | Optimistic |
|---|---|---|
| Lock acquisition | Before reading | None (verify at write time) |
| Blocking | Yes -- other transactions wait | No -- conflicting writes fail |
| Throughput under low contention | Lower (lock overhead) | Higher (no lock overhead) |
| Throughput under high contention | Stable (serialized) | Degrades (many retries) |
| Deadlock risk | Yes | No |
| Implementation | `SELECT ... FOR UPDATE` | `UPDATE ... WHERE version = N` |
| Best for | Short-lived, high-contention operations | Long-lived, low-contention operations |

**Pessimistic locking** acquires a lock when reading, preventing anyone else from modifying the row until the transaction commits. It is safe but serializes access, and the lock is held for the entire duration between read and write. If computation takes 100ms, the row is locked for 100ms. Under high concurrency, workers form a convoy waiting for locks.

**Optimistic locking** assumes conflicts are rare. It reads without locking, does its work, and checks at write time. If a conflict is detected (version mismatch), the operation fails and the caller must retry. This is faster when conflicts are rare but requires the caller to handle failures gracefully.

#### Compare-and-Swap (CAS)

CAS is the fundamental primitive behind optimistic locking. It is an atomic operation that:

1. Reads the current value at a memory location (or database row).
2. Compares it to an expected value.
3. If they match, writes a new value atomically.
4. If they do not match, reports failure.

At the CPU level, CAS is a single instruction (`CMPXCHG` on x86). In databases, it is implemented as a conditional `UPDATE` with a `WHERE` clause that checks the version. PostgreSQL's MVCC (Multi-Version Concurrency Control) ensures this is atomic -- the `UPDATE` either modifies the row or not, with no partial state.

The critical property is **atomicity**: the compare and the swap happen as a single, indivisible operation. There is no window between "check the version" and "write the new value" where another transaction could slip in. This is what makes it safe for concurrency control.

#### The ABA Problem

The ABA problem is a subtle failure mode of CAS. It occurs when:

1. Thread 1 reads value `A`.
2. Thread 2 changes the value from `A` to `B`, then back to `A`.
3. Thread 1 performs CAS, sees `A`, and succeeds -- even though the value was modified (and potentially had meaningful side effects) in the meantime.

In database terms: if you use the `status` field alone for CAS (`WHERE status = 'QUEUED'`), a run could go `QUEUED -> EXECUTING -> QUEUED` (re-enqueued after a retry), and a stale reader might think it never left `QUEUED`. It would process the run as if it were freshly queued, missing the fact that an entire attempt already happened.

The standard solution is a **monotonically increasing version number** -- it goes from 5 to 6 to 7, never back to 5. Even if the status returns to `QUEUED`, the version is now 7, not 5, so stale CAS operations fail correctly. This is why we use `WHERE version = N` rather than `WHERE status = 'QUEUED'`.

Other solutions to the ABA problem exist in lock-free programming: tagged/stamped pointers (Java's `AtomicStampedReference`), hazard pointers for safe memory reclamation, and garbage collection (which prevents address reuse). For database applications, version numbers are the standard and simplest approach.

#### Interaction with FOR UPDATE SKIP LOCKED

In a job queue, optimistic and pessimistic locking can work together, each solving a different problem:

1. **`FOR UPDATE SKIP LOCKED`** (pessimistic) is used to dequeue -- a worker grabs the next available row, and other workers skip locked rows rather than waiting. This prevents two workers from grabbing the same job. As explained by [Inferable's blog post on SKIP LOCKED](https://www.inferable.ai/blog/posts/postgres-skip-locked): "When a query with SKIP LOCKED tries to acquire a lock on a row that is already locked by another transaction, it doesn't wait. Instead, it simply skips that row."

2. **Version-based CAS** (optimistic) is used for state transitions after dequeuing -- once a worker has a run, it uses version checks to ensure its state transition is valid. This catches race conditions where a run might be cancelled while a worker is processing it.

```sql
-- Step 1: Pessimistic dequeue (high contention -- many workers competing)
BEGIN;
SELECT id, version FROM runs
WHERE status = 'QUEUED'
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT 1;

-- Step 2: Optimistic state transition (low contention -- one worker per run)
UPDATE runs
SET status = 'EXECUTING', version = version + 1
WHERE id = $1 AND version = $2;
COMMIT;
```

This combination gives the best of both worlds: `SKIP LOCKED` provides non-blocking queue distribution (workers never wait for each other), while version checks provide safe state transitions (no lost updates even if external events -- like cancellation -- arrive during processing).

### Alternatives

- **Pessimistic locking** (`SELECT FOR UPDATE`): Simpler mental model but blocks other transactions. Risk of deadlocks when locking multiple rows.
- **Serializable isolation level**: The database prevents all anomalies automatically, but at a significant performance cost. Every transaction must be serializable with respect to all others.
- **Advisory locks** (`pg_advisory_lock`): Application-level locks in PostgreSQL. Useful for coarse-grained coordination (e.g., "only one scheduler instance runs at a time") but not suitable for row-level concurrency.
- **Distributed locks** (Redis/Redlock, ZooKeeper): For multi-node coordination. Higher complexity, more failure modes (lock expiry, network partitions), and the challenges described in Martin Kleppmann's ["How to do distributed locking"](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html).

### How Production Systems Use It

Hibernate/JPA uses a `@Version` annotation to automatically add version checking to all updates. DynamoDB uses conditional writes (`ConditionExpression`) as its primary concurrency control mechanism -- there is no pessimistic locking in DynamoDB at all. Kubernetes uses `resourceVersion` on every object -- updates fail if the `resourceVersion` has changed since you last read, and you must re-fetch and retry. CockroachDB and Spanner use optimistic concurrency control at the transaction level for serializable isolation. Stripe uses idempotency keys combined with optimistic locking for payment processing.

### Resources

- [Vlad Mihalcea -- Database Locking and Lost Update Phenomena](https://vladmihalcea.com/a-beginners-guide-to-database-locking-and-the-lost-update-phenomena/)
- [Optimistic Concurrency Control -- Wikipedia](https://en.wikipedia.org/wiki/Optimistic_concurrency_control)
- [The ABA Problem in Concurrency -- Baeldung](https://www.baeldung.com/cs/aba-concurrency)
- [Optimistic Locking in JPA -- Baeldung](https://www.baeldung.com/jpa-optimistic-locking)
- [PostgreSQL FOR UPDATE SKIP LOCKED -- The Unreasonable Effectiveness](https://www.inferable.ai/blog/posts/postgres-skip-locked)
- [Optimistic vs Pessimistic Locking -- binaryigor](https://binaryigor.com/optimistic-vs-pessimistic-locking.html)

### Test Questions

1. Two workers read a run with `version=5` and both attempt `UPDATE ... WHERE version = 5`. What happens to each worker's update? How many rows are affected by each statement?
2. Explain the ABA problem using a concrete example with run statuses. Why does using the `status` column alone for CAS not prevent it? How does a monotonically increasing version number fix it?
3. When would you choose pessimistic locking over optimistic locking? Give two specific scenarios where pessimistic is clearly better.
4. In the combined `FOR UPDATE SKIP LOCKED` + version CAS approach, what does each mechanism protect against? Could you use just one of them? What would you lose?
5. A system uses optimistic locking but never retries on version conflict. What user-visible behavior results?
6. Kubernetes rejects your object update with "the object has been modified; please apply your changes to the latest version." Which concurrency control pattern is this, and what should your code do next?

---

## 4. Append-Only Event Logs

### What It Is

An **append-only event log** is an ordered, immutable sequence of records where new entries are always added to the end and existing entries are never modified or deleted. Each event captures a discrete fact about something that happened: a state transition, a user action, an external signal. Think of it like a traditional accountant's ledger where you can add new lines, but you can never erase or change what has already been written.

In the context of a task execution engine, every state transition produces an event record:

```typescript
{
  id:         "evt_abc123",
  runId:      "run_xyz789",
  fromStatus: "QUEUED",
  toStatus:   "EXECUTING",
  reason:     "worker_claimed",
  data:       { workerId: "wk_42", attemptNumber: 3 },
  timestamp:  "2026-03-15T14:30:00.000Z"
}
```

### What Problem It Solves

With mutable state, you only know what a run's status is *right now*. You cannot answer:

- "How long was this run queued before being picked up?"
- "Was this run ever cancelled and then re-queued?"
- "Which worker originally failed on this run?"
- "How many times was this run retried before succeeding?"
- "Did this run spend more time waiting in the queue or executing?"

These questions require history, and mutable `UPDATE` statements destroy history by design. When you `UPDATE runs SET status = 'FAILED'`, the fact that the run was ever in EXECUTING state is gone from the `runs` table.

Append-only event logs preserve the complete trajectory of every run. When something goes wrong in production, you do not have to guess -- you can replay the exact sequence of events that led to the current state.

### How It Works Under the Hood

#### What to Record Per Event

Every event should capture enough context to be self-contained and queryable:

| Field | Purpose | Example |
|---|---|---|
| `id` | Unique identifier for the event itself | `evt_abc123` |
| `runId` | Which run this event belongs to | `run_xyz789` |
| `fromStatus` | The state before the transition | `QUEUED` |
| `toStatus` | The state after the transition | `EXECUTING` |
| `reason` | Why the transition happened (machine-readable enum) | `worker_claimed` |
| `data` | Arbitrary JSON payload with contextual details | `{ workerId: "wk_42" }` |
| `timestamp` | When the transition occurred (server clock) | `2026-03-15T14:30:00Z` |
| `actorId` | Who/what caused the transition (user, worker, system) | `user_123` or `scheduler` |

The `reason` field is critical for distinguishing between transitions that look the same structurally but have different causes. A transition to `FAILED` might have reason `error_max_retries_exhausted`, `error_non_retryable`, or `error_timeout` -- each implies different corrective action. Without `reason`, a query for "all failed runs" would conflate very different failure modes.

Recording both `fromStatus` and `toStatus` makes queries self-contained. To answer "how long did this run spend in QUEUED state?", you find the event where `toStatus = 'QUEUED'` and the next event where `fromStatus = 'QUEUED'`, then compute the time difference. If you only stored `toStatus`, you would need to look at the previous event to infer the `from` state -- more complex queries, more edge cases at boundaries.

#### The Fold/Reduce Operation

The current state of a run can always be derived by folding (reducing) its event log:

```typescript
function currentState(events: RunEvent[]): RunStatus {
  return events.reduce((state, event) => event.toStatus, "PENDING");
}
```

More complex derivations can compute metrics from the event stream:

```typescript
function timeInQueue(events: RunEvent[]): number {
  const queued = events.find(e => e.toStatus === "QUEUED");
  const dequeued = events.find(e => e.fromStatus === "QUEUED");
  if (!queued || !dequeued) return 0;
  return dequeued.timestamp - queued.timestamp;
}

function totalExecutionTime(events: RunEvent[]): number {
  // A run might execute multiple times (retries), so sum all EXECUTING durations
  let total = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i].toStatus === "EXECUTING") {
      const exitEvent = events.find(
        (e, j) => j > i && e.fromStatus === "EXECUTING"
      );
      if (exitEvent) {
        total += exitEvent.timestamp - events[i].timestamp;
      }
    }
  }
  return total;
}

function retryCount(events: RunEvent[]): number {
  return events.filter(e => e.reason === "retry_scheduled").length;
}
```

This fold operation is the bridge between the event log and any view you need: current status, duration metrics, retry count, audit history. The event log is raw data; the fold transforms it into whatever shape you require.

#### Difference from Event Sourcing

Append-only event logs and event sourcing are related but distinct patterns. Understanding the difference is important because they have very different complexity profiles:

| Aspect | Append-Only Event Log | Event Sourcing |
|---|---|---|
| Source of truth | The mutable state (database row) | The event log itself |
| Events are | Side output of state changes | The primary persistence mechanism |
| State reconstruction | Optional (for debugging/auditing) | Required (current state is derived from events) |
| Can you query current state directly? | Yes -- `SELECT status FROM runs` | No -- must replay events or maintain projections |
| Complexity | Low -- just INSERT after each UPDATE | High -- projections, snapshots, versioning, eventual consistency |
| Can delete events? | In theory yes (you lose history) | No -- events ARE your data; deleting them destroys state |

As [Kurrent (EventStoreDB) explains](https://www.kurrent.io/blog/event-sourcing-audit): "Event sourcing captures every change as a discrete event at a granular level," while "audit logs typically record high-level activities or transactions and tend to only record the end result or significant state changes."

In reload.dev, we use an append-only event log as a **secondary record**, not as the primary source of truth. The `runs` table is still the authoritative source for current state. The event log is written alongside each state transition for observability, debugging, and compliance. This gives us 80% of event sourcing's benefits (full audit trail, replay capability, metrics derivation) without the complexity overhead (projections, snapshots, eventual consistency).

### Practical Uses

**Debugging**: "Run xyz failed. Show me its entire lifecycle." Query the event log for `runId = 'xyz'` ordered by timestamp. You see every transition, every retry attempt, every delay, every cancellation -- the complete story. As [Datadog's audit logging guide](https://www.datadoghq.com/knowledge-center/audit-logging/) notes, audit logs "act like breadcrumbs and allow teams to follow the exact steps leading to an issue."

**Metrics**: "What is the p95 queue wait time this hour?" Compute `dequeued.timestamp - queued.timestamp` for all runs whose `queued` event occurred in the last hour. No need for separate metrics instrumentation -- the event log IS the instrumentation.

**Compliance**: "Prove that no run was executed without authorization." The event log provides a tamper-evident (append-only) record of every state change, including who triggered it and when. Immutable audit trails are increasingly required by regulations like SOX, HIPAA, and GDPR.

**Anomaly Detection**: "Alert when a run has been in EXECUTING state for more than 10 minutes." A background process scans for runs whose last event is `toStatus=EXECUTING` with a timestamp older than 10 minutes.

**Replay and Recovery**: If you discover a bug in your metrics calculation, you can re-derive all metrics from the event log. The raw events are immutable facts; the derived views can be rebuilt.

### Alternatives

- **Mutable audit columns** (`updated_at`, `updated_by`): Only captures the most recent change, not the full history. Cheapest to implement but loses all intermediate states.
- **Database triggers**: Can automatically log changes to an audit table on every UPDATE. Harder to test, deploy, and reason about. Trigger logic is invisible in application code.
- **Change Data Capture (CDC)**: Tools like Debezium capture every row change from the database's write-ahead log. Powerful and application-transparent, but infrastructure-heavy and not domain-aware.
- **Full event sourcing**: Events are the source of truth. More powerful (enables temporal queries, event replay, CQRS) but significantly more complex. Requires projections, snapshots, and careful event schema evolution.
- **Application Performance Monitoring (APM)**: Tools like Datadog and Honeycomb capture traces and spans. Complementary but not a substitute for domain-specific event logs -- APM captures "what happened at the infrastructure level" while event logs capture "what happened at the business logic level."

### How Production Systems Use It

Stripe records every state change for payments, charges, and refunds as events, exposed through the Events API. GitHub records every action on a repository (push, PR, issue, etc.) as events, available through the Events API and the enterprise audit log. AWS CloudTrail is an append-only log of every API call made in an AWS account, used for security analysis and compliance auditing. Kafka's core abstraction is an append-only commit log -- topics are partitioned logs of records. PostgreSQL's Write-Ahead Log (WAL) is itself an append-only log used for crash recovery and replication.

### Resources

- [Event Sourcing vs Audit Log -- Kurrent](https://www.kurrent.io/blog/event-sourcing-audit)
- [Event Sourcing Pattern -- Microsoft Azure Architecture](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)
- [Jay Kreps -- The Log: What every software engineer should know about real-time data](https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying)
- [Immutable Audit Trails: A Complete Guide -- HubiFi](https://www.hubifi.com/blog/immutable-audit-log-basics)
- [Audit Logging -- Datadog Knowledge Center](https://www.datadoghq.com/knowledge-center/audit-logging/)

### Test Questions

1. A run transitions `QUEUED -> EXECUTING -> WAITING -> EXECUTING -> COMPLETED`. Write out the four event log entries (fromStatus, toStatus, reason) that would be recorded.
2. Explain how you would compute the total time a run spent in `EXECUTING` state (across multiple attempts) using only the event log. Write the algorithm in pseudocode.
3. What is the key difference between an append-only event log and full event sourcing? When would you choose one over the other?
4. A developer proposes deleting old event log entries to save storage. What capabilities would be lost? What would you recommend instead?
5. How would you implement "undo" for a cancelled run using the event log? What new event would you append, and what side effects would you trigger?
6. Your event log shows a run went `QUEUED -> EXECUTING -> QUEUED -> EXECUTING -> COMPLETED`. What does the first `EXECUTING -> QUEUED` transition tell you about what happened? What would you expect the `reason` field to contain?

---

## 5. Functional Core, Imperative Shell

### What It Is

**Functional Core, Imperative Shell** is an architectural pattern, popularized by Gary Bernhardt in his 2012 talk ["Boundaries"](https://www.destroyallsoftware.com/talks/boundaries), that separates code into two layers:

- **Functional Core**: Pure functions that take inputs and return outputs. No side effects, no I/O, no database calls, no network requests. Given the same inputs, they always return the same outputs. The core *decides*.
- **Imperative Shell**: The thin outer layer that performs I/O, calls databases, sends messages, and invokes the functional core to make decisions. The shell *acts*.

The core returns descriptions of side effects as data. The shell interprets and executes those descriptions. The [Google Testing Blog](https://testing.googleblog.com/2025/10/simplify-your-code-functional-core.html) describes this as separating "pure, testable business logic, which is free of side effects" from the layer that "handles all external interactions -- database calls, network requests, email sending."

### What Problem It Solves

Testing code that mixes business logic with side effects is painful. You need database fixtures, mocked HTTP clients, fake timers, and complex setup/teardown. Tests are slow, brittle, and hard to understand. When business logic is interleaved with `await db.update(...)` and `await queue.send(...)`, you cannot test the logic without also dealing with the infrastructure.

Consider a function that handles execution failure:

```typescript
// BAD: Business logic and I/O are interleaved
async function handleExecutionFailure(runId: string, error: Error) {
  const run = await db.getRun(runId);                    // I/O
  if (error.retryable && run.retryCount < run.maxRetries) {  // logic
    const delay = calculateBackoff(run.retryCount);      // logic
    await db.updateRun(runId, { status: "QUEUED" });     // I/O
    await retryQueue.enqueue(runId, delay);               // I/O
    await eventLog.insert({ from: "EXECUTING", to: "QUEUED" }); // I/O
  } else {                                                // logic
    await db.updateRun(runId, { status: "FAILED" });     // I/O
    await webhook.notify(runId, "FAILED");                // I/O
    await eventLog.insert({ from: "EXECUTING", to: "FAILED" }); // I/O
  }
}
```

To test this function, you need mocks for `db`, `retryQueue`, `eventLog`, and `webhook`. Every test requires setting up these mocks. If you add a new side effect, every test breaks. The test setup is longer than the assertions.

By isolating the business logic into pure functions, you can test it with simple unit tests: pass in data, assert on the return value. No mocks, no fixtures, no setup.

### How It Works Under the Hood

#### The State Machine as Functional Core

In reload.dev, the state machine is the functional core. The transition function is pure:

```typescript
// PURE FUNCTION -- the functional core
function handleExecutionFailure(
  run: { status: RunStatus; retryCount: number; maxRetries: number },
  error: { type: ErrorType; message: string }
): TransitionResult {
  // Non-retryable errors go straight to FAILED
  if (error.type === "NON_RETRYABLE") {
    return {
      newStatus: "FAILED",
      sideEffects: [
        { type: "recordEvent", from: run.status, to: "FAILED", reason: "non_retryable_error" },
        { type: "releaseWorker" },
        { type: "notifyWebhook", payload: { status: "FAILED", error: error.message } }
      ]
    };
  }

  // Retryable errors with remaining retries: re-enqueue with backoff
  if (run.retryCount < run.maxRetries) {
    const delay = calculateBackoff(run.retryCount);
    return {
      newStatus: "QUEUED",
      sideEffects: [
        { type: "recordEvent", from: run.status, to: "QUEUED", reason: "retry_scheduled" },
        { type: "scheduleRetry", delay },
        { type: "incrementRetryCount" },
        { type: "releaseWorker" }
      ]
    };
  }

  // Retryable errors with no retries left: fail permanently
  return {
    newStatus: "FAILED",
    sideEffects: [
      { type: "recordEvent", from: run.status, to: "FAILED", reason: "max_retries_exhausted" },
      { type: "releaseWorker" },
      { type: "notifyWebhook", payload: { status: "FAILED", error: error.message } }
    ]
  };
}
```

This function has **zero dependencies**. It does not import a database client, a queue library, or an HTTP client. It takes plain data in and returns plain data out. Testing it requires nothing more than:

```typescript
test("non-retryable error goes to FAILED regardless of retry count", () => {
  const run = { status: "EXECUTING", retryCount: 0, maxRetries: 5 };
  const error = { type: "NON_RETRYABLE", message: "Invalid input" };

  const result = handleExecutionFailure(run, error);

  expect(result.newStatus).toBe("FAILED");
  expect(result.sideEffects).toContainEqual(
    expect.objectContaining({ type: "releaseWorker" })
  );
});

test("retryable error with retries left goes to QUEUED", () => {
  const run = { status: "EXECUTING", retryCount: 2, maxRetries: 5 };
  const error = { type: "RETRYABLE", message: "Connection timeout" };

  const result = handleExecutionFailure(run, error);

  expect(result.newStatus).toBe("QUEUED");
  expect(result.sideEffects).toContainEqual(
    expect.objectContaining({ type: "scheduleRetry" })
  );
});

test("retryable error with no retries left goes to FAILED", () => {
  const run = { status: "EXECUTING", retryCount: 5, maxRetries: 5 };
  const error = { type: "RETRYABLE", message: "Connection timeout" };

  const result = handleExecutionFailure(run, error);

  expect(result.newStatus).toBe("FAILED");
  expect(result.sideEffects).toContainEqual(
    expect.objectContaining({ reason: "max_retries_exhausted" })
  );
});
```

No mocks. No database. No setup. No teardown. Each test runs in milliseconds. The test is fast, deterministic, and obvious.

#### The Engine as Imperative Shell

The imperative shell takes the transition result and executes the side effects:

```typescript
// IMPERATIVE SHELL -- the engine
async function executeTransition(runId: string, result: TransitionResult) {
  await db.transaction(async (tx) => {
    // Optimistic locking update
    const updated = await tx.runs.update({
      where: { id: runId, version: currentVersion },
      data: { status: result.newStatus, version: { increment: 1 } }
    });

    if (updated.count === 0) {
      throw new OptimisticLockError("Version conflict");
    }

    // Execute each side effect
    for (const effect of result.sideEffects) {
      switch (effect.type) {
        case "recordEvent":
          await tx.runEvents.create({ data: { runId, ...effect } });
          break;
        case "releaseWorker":
          await workerPool.release(runId);
          break;
        case "scheduleRetry":
          await retryQueue.enqueue(runId, effect.delay);
          break;
        case "notifyWebhook":
          await webhookService.send(runId, effect.payload);
          break;
      }
    }
  });
}
```

The shell is straightforward imperative code. It has almost no branching (just a switch on effect types). It is the only code that touches the database, the queue, and the network. It needs integration tests, but there are few paths to cover because the shell's job is mechanical execution, not decision-making.

#### Why This Matters for Testing

| Layer | Test Type | Speed | Dependencies | Coverage Target |
|---|---|---|---|---|
| Functional Core | Unit tests | Milliseconds | None | Every branch, every edge case, every guard |
| Imperative Shell | Integration tests | Seconds | Database, queue, HTTP | Happy path + error handling |
| Full System | End-to-end tests | Minutes | Everything | Critical user journeys only |

The testing pyramid is properly shaped: most tests are fast, dependency-free unit tests of the core logic. A small number of integration tests verify the shell wires things up correctly. A handful of E2E tests confirm the system works end-to-end.

Compare this to the "interleaved" approach where every test needs mocks: you end up with hundreds of slow, brittle tests that test mock wiring rather than business logic. When a mock's API changes, dozens of tests break even though the business logic has not changed.

#### Concrete Flow: handleExecutionFailure End-to-End

Here is the complete flow showing how the functional core and imperative shell interact:

1. Worker reports failure for `run_123` with error `{ type: "RETRYABLE", message: "timeout" }`.
2. Shell reads run from database: `{ id: "run_123", status: "EXECUTING", retryCount: 2, maxRetries: 5, version: 7 }`.
3. Shell calls pure function: `handleExecutionFailure(run, error)`.
4. Core returns: `{ newStatus: "QUEUED", sideEffects: [recordEvent, scheduleRetry, incrementRetryCount, releaseWorker] }`.
5. Shell executes `UPDATE runs SET status='QUEUED', retry_count=3, version=8 WHERE id='run_123' AND version=7`.
6. If CAS succeeds: shell executes each side effect in order.
7. If CAS fails (version conflict): someone else already transitioned this run. Shell logs and returns.

Steps 1-2 and 5-7 are the imperative shell. Step 3-4 is the functional core. The boundary between them is crystal clear.

### Alternatives

- **Mocking everything**: Test the mixed code by replacing dependencies with mocks. Works but is fragile -- mocks can drift from real implementations, and mock setup obscures the test's intent. "Mocks tell you what you want to hear," not what will actually happen.
- **Ports and Adapters (Hexagonal Architecture)**: Similar separation but uses interfaces/abstractions rather than pure functions. More idiomatic in OOP languages (Java, C#). The "ports" are interfaces for external dependencies; "adapters" are implementations. Testing swaps adapters for fakes.
- **Effect systems** (ZIO, fp-ts Effect): Language-level support for describing effects as values. More powerful and type-safe but requires buy-in to an effect system and a functional programming paradigm.
- **Command pattern**: Business logic returns command objects. Similar to returning side effects as data, but typically used at a coarser granularity (one command per operation rather than a list of fine-grained effects).

### How Production Systems Use It

Redux follows this pattern exactly: reducers are pure functions (functional core) that take `(state, action)` and return `newState`. Middleware and `store.dispatch` handle side effects (imperative shell). Elm's architecture (The Elm Architecture) has `update` functions that return `(model, Cmd msg)` -- the model is the new state and `Cmd msg` describes side effects to execute. React's `useReducer` hook mirrors this pattern at the component level. Temporal's workflow definitions are deterministic (functional core) while activities perform I/O (imperative shell). Even `git` follows this pattern: the object model (blobs, trees, commits) is a pure data structure, while the CLI commands are the imperative shell that reads/writes files and network.

### Resources

- [Gary Bernhardt -- Functional Core, Imperative Shell (screencast)](https://www.destroyallsoftware.com/screencasts/catalog/functional-core-imperative-shell)
- [Gary Bernhardt -- Boundaries (talk)](https://www.destroyallsoftware.com/talks/boundaries)
- [Google Testing Blog -- Simplify Your Code: Functional Core, Imperative Shell](https://testing.googleblog.com/2025/10/simplify-your-code-functional-core.html)
- [Functional Programming Patterns: Functional Core, Imperative Shell -- Javier Casas](https://www.javiercasas.com/articles/functional-programming-patterns-functional-core-imperative-shell/)
- [Mark Seemann -- Impureim Sandwich](https://blog.ploeh.dk/2020/03/02/impureim-sandwich/)
- [Functional Core, Imperative Shell -- GitHub Knowledge Base](https://github.com/kbilsted/Functional-core-imperative-shell/blob/master/README.md)

### Test Questions

1. You have a function `processPayment(order, paymentMethod)` that validates the order, charges the card via Stripe, and updates the database. How would you refactor it using Functional Core, Imperative Shell? What does the core return? What does the shell do?
2. Why does returning side effects as data make the functional core easier to test than injecting dependencies via constructor/DI? What advantage does it have over mocking?
3. In the `handleExecutionFailure` example, what would happen if the function called `await db.update(...)` directly instead of returning `{ type: "recordEvent", ... }`? List three specific testing consequences.
4. The imperative shell has a bug: it forgets to call `releaseWorker`. Would a unit test of the functional core catch this? Why or why not? What kind of test would catch it?
5. Compare Functional Core/Imperative Shell with Hexagonal Architecture (Ports and Adapters). What do they share? How do they differ? When would you prefer one over the other?
6. Redux's `reducer` returns new state but not side effects. Redux Saga and Redux Thunk handle side effects separately. How does this map to the FC/IS pattern? What is Redux's "functional core" and what is its "imperative shell"?

---

## 6. Delayed Run Scheduling

### What It Is

Delayed run scheduling allows users to trigger a task that should not execute immediately but at a specified future time. The run is created with status `DELAYED` and a `delayUntil` timestamp. A background scheduler periodically polls for `DELAYED` runs whose `delayUntil` has passed and transitions them to `QUEUED`.

```typescript
// User triggers a delayed run
await myTask.trigger({ payload: "data" }, { delay: "1h" });

// The run is created as:
// { status: "DELAYED", delayUntil: "2026-03-15T15:30:00Z", version: 1 }
```

### What Problem It Solves

Many real-world workflows require delayed execution:

- Sending a follow-up email 24 hours after sign-up.
- Retrying a failed webhook after 30 seconds with exponential backoff.
- Scheduling a report for 6 AM tomorrow.
- Expiring an abandoned shopping cart after 2 hours.
- Waiting for an external system to propagate changes before checking status.

Without a built-in delay mechanism, developers must set up external cron jobs, use third-party schedulers, or build ad-hoc `setTimeout`-based solutions that do not survive process restarts.

Delayed scheduling integrates directly with the state machine, meaning delayed runs benefit from all the same machinery: retries, event logging, cancellation, TTL expiry. A delayed run is just a run in the `DELAYED` state -- the same state machine that handles `QUEUED -> EXECUTING -> COMPLETED` also handles `DELAYED -> QUEUED`.

### How It Works Under the Hood

#### The Background Scheduler

The scheduler is a polling loop that runs on a timer (e.g., every 5 seconds):

```typescript
async function pollDelayedRuns() {
  const now = new Date();

  // Find DELAYED runs whose time has come
  const runs = await db.runs.findMany({
    where: {
      status: "DELAYED",
      delayUntil: { lte: now }
    },
    take: 100, // Process in batches to avoid overwhelming the system
    orderBy: { delayUntil: "asc" } // Oldest first (fairness)
  });

  for (const run of runs) {
    await transitionToQueued(run);
  }
}

// Poll every 5 seconds
setInterval(pollDelayedRuns, 5000);
```

The polling interval creates a tradeoff: shorter intervals mean runs are picked up faster (lower latency) but increase database load with more frequent queries. Longer intervals reduce load but add latency. A 5-second interval means a delayed run might execute up to 5 seconds after its scheduled time -- acceptable for most use cases.

The worst-case additional latency equals the polling interval. The average additional latency is half the polling interval (assuming uniform distribution of `delayUntil` timestamps within any given polling window). For a 5-second interval: worst case is 5s late, average is 2.5s late.

#### Race Conditions with Multiple Instances

In production, multiple instances of the scheduler may be running simultaneously (for high availability or as part of a multi-node deployment). This creates a race condition:

1. Instance A polls and finds run `run_123` with `delayUntil` in the past.
2. Instance B polls and finds the same run `run_123`.
3. Both instances attempt to transition it to `QUEUED`.
4. Without protection, the run gets enqueued twice, leading to duplicate execution.

This is the **double-transition problem** -- the same run is processed by multiple scheduler instances because they all see it in the same state during their polling window. The consequences range from wasted work (the run executes twice but is idempotent) to data corruption (the run is not idempotent and processes the same payment twice).

#### How Version-Based Locking Prevents Double-Transition

The solution combines the optimistic locking pattern from Section 3 with the state machine from Section 1:

```typescript
async function transitionToQueued(run: Run) {
  const result = await db.runs.updateMany({
    where: {
      id: run.id,
      status: "DELAYED",       // Must still be DELAYED (state machine guard)
      version: run.version      // Must not have been modified (CAS)
    },
    data: {
      status: "QUEUED",
      version: { increment: 1 }
    }
  });

  if (result.count === 0) {
    // Another instance already transitioned this run, or it was
    // cancelled/expired in the meantime. This is expected and safe to ignore.
    return;
  }

  // Only the winning instance reaches here -- exactly-once transition
  await db.runEvents.create({
    data: {
      runId: run.id,
      fromStatus: "DELAYED",
      toStatus: "QUEUED",
      reason: "delay_elapsed"
    }
  });
}
```

When two instances race to transition the same run:

1. Instance A: `UPDATE ... WHERE id = 'run_123' AND status = 'DELAYED' AND version = 3` -- succeeds, version becomes 4. `result.count === 1`.
2. Instance B: `UPDATE ... WHERE id = 'run_123' AND status = 'DELAYED' AND version = 3` -- fails because version is now 4, not 3. `result.count === 0`.
3. Instance B detects the failure (`count === 0`) and moves on. No duplicate processing.

This is exactly the CAS pattern applied to the scheduling domain. The version column acts as a concurrency guard, ensuring exactly-once state transitions even with multiple competing schedulers. Note that checking `status = 'DELAYED'` alone would be sufficient to prevent a run from being queued twice (since the first successful update changes the status to `QUEUED`), but the version check provides defense-in-depth against the ABA problem (a run that goes `DELAYED -> QUEUED -> ... -> DELAYED` again should not be confused with the original DELAYED instance).

#### Alternative: FOR UPDATE SKIP LOCKED

An alternative approach uses pessimistic locking to distribute work across scheduler instances:

```sql
BEGIN;
SELECT id FROM runs
WHERE status = 'DELAYED' AND delay_until <= NOW()
ORDER BY delay_until
FOR UPDATE SKIP LOCKED
LIMIT 100;

UPDATE runs SET status = 'QUEUED', version = version + 1
WHERE id = ANY($1);
COMMIT;
```

With `SKIP LOCKED`, each scheduler instance grabs a different batch of delayed runs. Locked rows are invisible to other instances, so there is no contention at all -- each instance processes a disjoint set of runs. This is simpler than version-based CAS but requires the scheduler to operate within a transaction, which holds locks for the duration of the batch processing.

In practice, both approaches work well:

| Approach | Pros | Cons |
|---|---|---|
| Version-based CAS | Works outside transactions, ORM-friendly, no lock holding | Multiple instances may read same rows (wasted queries) |
| FOR UPDATE SKIP LOCKED | No wasted work, efficient batch processing | Requires explicit transactions, holds locks during processing |

For small to medium workloads, version-based CAS is simpler and sufficient. For high-volume systems with many delayed runs, `FOR UPDATE SKIP LOCKED` is more efficient because it eliminates redundant reads.

#### Handling Edge Cases

**Scheduler downtime**: If the scheduler has been down for 2 hours and restarts, the query `WHERE delay_until <= NOW()` picks up all overdue runs. Runs scheduled for 2 hours ago will be queued immediately on restart. No runs are lost -- they are just late.

**Cancelled delayed runs**: If a user cancels a delayed run, its status changes from `DELAYED` to `CANCELED`. The scheduler's query `WHERE status = 'DELAYED'` will not find it. If the cancellation happens between the scheduler's read and write, the CAS will fail because the status is no longer `DELAYED`. Either way, the cancelled run is never queued.

**Clock skew**: If server clocks are not synchronized, different scheduler instances may disagree on whether `delay_until <= NOW()` is true. This is usually tolerable -- the worst case is a run being queued a few seconds early or late. For precision-critical scheduling, use a centralized time source.

### Alternatives

- **Database-level scheduling** (`pg_cron`): PostgreSQL extension for scheduling SQL commands. Limited to SQL and harder to integrate with application logic. Good for maintenance tasks, not application workflows.
- **External schedulers** (cron, AWS EventBridge Scheduler): Offload scheduling to external systems. More moving parts but handles high volumes and provides monitoring out of the box.
- **Message queue delayed delivery** (SQS delay, RabbitMQ TTL/dead-letter): Send the message now, but the broker holds it for the specified delay. Simpler but decouples the delay from the state machine -- the delayed message is not visible as a run in `DELAYED` state.
- **Timer-based in-memory scheduling** (`setTimeout`, `node-cron`): Does not survive process restarts. Only suitable for development or single-instance deployments.
- **Sorted sets in Redis** (ZRANGEBYSCORE with timestamp as score): Fast polling via sorted set queries. Used by BullMQ and Sidekiq for delayed jobs. Very efficient but adds a Redis dependency.

### How Production Systems Use It

BullMQ stores delayed jobs in a Redis sorted set with the execution timestamp as the score. A timer polls for jobs whose score is less than the current timestamp. This is extremely fast (O(log N) insertion, O(log N) query) but requires Redis. Sidekiq uses the same Redis sorted set approach. AWS SQS supports message delays up to 15 minutes natively via delay queues. Temporal uses a "timer" activity that durably schedules a workflow continuation -- timers survive process restarts because they are recorded in the event history. Celery uses either Redis sorted sets or database polling for its `apply_async(eta=...)` feature.

### Resources

- [PostgreSQL SKIP LOCKED -- The Unreasonable Effectiveness](https://www.inferable.ai/blog/posts/postgres-skip-locked)
- [BullMQ -- How Delayed Jobs Work](https://docs.bullmq.io/guide/jobs/delayed)
- [Neon -- Queue System Using SKIP LOCKED](https://neon.com/guides/queue-system)
- [Solid Queue and Understanding SKIP LOCKED -- BigBinary](https://www.bigbinary.com/blog/solid-queue)
- [AWS SQS Delay Queues Documentation](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-delay-queues.html)

### Test Questions

1. The scheduler polls every 10 seconds and a run has `delayUntil` of 14:30:00.003. What is the worst-case actual execution time? What is the average additional latency introduced by polling?
2. Three scheduler instances all poll at the same moment and find the same 50 delayed runs. Using version-based CAS, how many total `UPDATE` statements will succeed across all three instances? How many will fail? Is any work duplicated?
3. Compare version-based CAS and `FOR UPDATE SKIP LOCKED` for the delayed scheduling use case. When would you prefer each approach?
4. A run is created with `DELAYED` status and `delayUntil` set to 1 hour from now. 30 minutes later, the user cancels it. What should the scheduler do when it polls and does not find this run in `DELAYED` status? What if the cancellation happens between the scheduler's SELECT and UPDATE?
5. Why is `setTimeout` insufficient for delayed scheduling in a production system? List at least three failure modes.
6. A delayed run has `delayUntil` in the past but the scheduler has been down for 2 hours. When the scheduler restarts, what happens? How does the query `WHERE delay_until <= NOW()` handle this? Are any runs lost?

---

## Synthesis: How the Six Concepts Interconnect

These six concepts are not independent -- they form a cohesive system where each concept addresses a specific dimension of the problem:

```
                     ┌─────────────────────────────┐
                     │   Functional Core (Sec 5)   │
                     │  Pure transition function    │
                     │  Returns newState + effects  │
                     └──────────────┬──────────────┘
                                    │
                    decides what     │  returns data
                    should happen    │  (no I/O)
                                    │
                     ┌──────────────▼──────────────┐
                     │  Imperative Shell (Sec 5)   │
                     │  Executes side effects      │
                     │  Writes to DB with CAS      │
                     └──────────────┬──────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
    ┌─────────▼────────┐  ┌────────▼────────┐  ┌────────▼────────┐
    │  State Machine   │  │  Optimistic     │  │  Event Log      │
    │  (Sec 1)         │  │  Locking (Sec 3)│  │  (Sec 4)        │
    │  Legal states &  │  │  CAS prevents   │  │  Records every  │
    │  transitions     │  │  lost updates   │  │  transition     │
    └──────────────────┘  └─────────────────┘  └─────────────────┘
              │
    ┌─────────▼────────────────────────────────┐
    │  On failure: Backoff + Jitter (Sec 2)    │
    │  Computes retry delay, prevents herds    │
    │                                          │
    │  Creates DELAYED run with delayUntil     │
    └─────────────────────┬────────────────────┘
                          │
    ┌─────────────────────▼────────────────────┐
    │  Delayed Scheduler (Sec 6)               │
    │  Polls for overdue DELAYED runs          │
    │  Transitions to QUEUED using CAS         │
    │  Prevents double-transition              │
    └──────────────────────────────────────────┘
```

A single retry flow touches all six concepts:

1. A worker reports that `run_123` failed with a retryable error.
2. The **imperative shell** reads the run from the database.
3. It calls the **functional core** (pure transition function), which consults the **state machine** to validate `EXECUTING -> QUEUED` and uses **exponential backoff with jitter** to compute the retry delay.
4. The core returns `{ newStatus: "DELAYED", sideEffects: [...] }` as data.
5. The shell writes to the database using **optimistic locking** (CAS) to prevent lost updates.
6. The shell inserts an entry into the **append-only event log** recording the transition.
7. The **delayed scheduler** later polls and finds this run, transitioning it from `DELAYED` to `QUEUED` using CAS to prevent double-processing.
8. The run re-enters the queue and a worker picks it up for another attempt.

Understanding each concept individually is necessary. Understanding how they compose is what makes you effective at building and debugging the system.
