# Phase 6: Child Tasks + Waitpoints -- Deep-Dive Concepts

**Goal:** Hierarchical task execution with parent-child relationships, suspension/resumption via waitpoints, and fan-out/fan-in batch operations.

Phase 6 is where reload.dev transforms from a flat task queue into a full workflow engine. Until now, every run was independent -- triggered, executed, done. Phase 6 introduces the ability for a running task to *pause itself*, spawn child tasks, wait for external signals, and resume exactly where it left off. This requires solving one of the hardest problems in server-side JavaScript: resuming a function mid-execution after the process has moved on to other work. This document covers the six core concepts you need to understand before writing a single line of Phase 6 code.

---

## 1. Step-Based Replay (Resumption Without CRIU)

### The Problem: Node.js Cannot Snapshot a Running Function

When a task calls `triggerAndWait(childTask)`, the parent function needs to *pause* -- stop executing, free its resources, let the worker handle other tasks -- and later *resume* from exactly where it left off, with the child's result available. In a language with first-class continuations (like Scheme) or green threads (like Go), this would be straightforward. In JavaScript, it is fundamentally impossible to freeze a function's execution state and restore it later.

Here is why. When a JavaScript function is executing, its state consists of:

1. **The call stack** -- every function frame above and below the current one, including local variables, the instruction pointer within each function, and closure references.
2. **The heap** -- all objects referenced by those stack frames, including closures, Promises, and external resources like database connections and file handles.
3. **The event loop state** -- pending timers, microtask queue, I/O callbacks.
4. **Native bindings** -- C++ addon state, TLS connections, file descriptors.

V8 (Node.js's JavaScript engine) does not expose any API to serialize the call stack. You cannot call `JSON.stringify(currentCallStack())`. There is no `vm.snapshot()` that captures the execution context of a single async function. The closest thing V8 offers is startup snapshots (used to speed up Node.js boot), but these capture the *entire* isolate state before any user code runs -- they are useless for capturing a function mid-flight.

### How CRIU Solves This (And Why We Can't Use It)

CRIU (Checkpoint/Restore In Userspace) is a Linux kernel feature that solves this problem at the operating system level. It works like this:

1. **Freeze**: CRIU sends `SIGSTOP` to every thread in a process, halting execution.
2. **Dump**: It reads the process's entire state from `/proc/<pid>/` -- memory maps (`/proc/pid/maps`), register values, file descriptors, socket state, signal handlers, pending timers, and more. It serializes all of this to a set of image files on disk.
3. **Restore**: On the same or a different machine, CRIU creates a new process, maps the dumped memory pages back into the correct virtual addresses, restores register values (including the instruction pointer), re-opens file descriptors, and resumes execution. The restored process has no idea it was ever frozen.

This is what Trigger.dev v3 uses in production. When a task needs to wait, CRIU checkpoints the entire container, stores the checkpoint in S3-compatible storage, and restores it when the wait condition is satisfied. The task function literally continues from the exact machine instruction where it was paused.

The catch: CRIU only works on Linux. It requires root-level access or specific capabilities (`CAP_SYS_PTRACE`, `CAP_SYS_ADMIN`). It operates on entire processes, not individual functions. Each checkpoint is tens or hundreds of megabytes. And it requires a container orchestration layer (Trigger.dev uses a custom Kubernetes-based system) to manage checkpoint storage and restoration. For reload.dev -- a learning project designed to run on any machine with Node.js and PostgreSQL -- CRIU is not an option.

### Our Approach: Re-Execute and Replay

Instead of freezing the function, we replay it. The core insight is: **if we record the result of every "step" (any operation with side effects), we can re-execute the function from the beginning and return cached results for steps that already completed.** The function races through its previously-completed work in microseconds, then continues normally from the first uncompleted step.

Here is the mental model. Consider this task function:

```typescript
export const processOrder = task({
  id: "process-order",
  run: async (payload) => {
    // Step 0: Validate the order
    const validation = await step.run("validate", async () => {
      return validateOrder(payload.orderId);
    });

    // Step 1: Charge payment
    const charge = await step.run("charge", async () => {
      return chargePayment(validation.customerId, payload.amount);
    });

    // Step 2: Send confirmation (triggers child task and waits)
    const email = await step.triggerAndWait("send-email", {
      to: validation.email,
      subject: "Order confirmed",
      chargeId: charge.id,
    });

    return { validation, charge, email };
  },
});
```

The first time this runs:
1. Step 0 ("validate") executes. Result is cached in `run_steps` with `stepIndex=0`.
2. Step 1 ("charge") executes. Result is cached with `stepIndex=1`.
3. Step 2 ("send-email") triggers a child task. The parent cannot continue until the child completes. The step is recorded with `stepIndex=2`, status `WAITING`. The function **suspends**.

When the child completes and the parent is resumed, the worker dequeues the parent run and calls the `run` function again *from the beginning*:

1. Step 0 ("validate") -- the framework checks `run_steps`, finds a cached result for `stepIndex=0`. Returns the cached result immediately *without executing the callback*. Takes microseconds.
2. Step 1 ("charge") -- same thing. Cached result returned. The `chargePayment` function is never called again. The customer is not double-charged.
3. Step 2 ("send-email") -- the framework finds a completed result (the child's output). Returns it. The function continues past the await.
4. The function returns its final result.

### Positional Step Counters

Steps are identified by their *position* in the execution order, not by their string keys alone. The framework maintains a counter that increments each time a step is encountered:

```
First execution:
  step.run("validate", ...) → counter = 0, key = "validate" → EXECUTE
  step.run("charge", ...)   → counter = 1, key = "charge"   → EXECUTE
  step.triggerAndWait(...)   → counter = 2, key = "send-email" → SUSPEND

Replay after child completes:
  step.run("validate", ...) → counter = 0, key = "validate" → cached result for stepIndex=0
  step.run("charge", ...)   → counter = 1, key = "charge"   → cached result for stepIndex=1
  step.triggerAndWait(...)   → counter = 2, key = "send-email" → cached result for stepIndex=2
  → function completes
```

The `stepKey` is stored alongside the `stepIndex` for **non-determinism detection**. On replay, when the framework encounters step index 0, it checks: "the cached step at index 0 has key `validate` -- does the current step also have key `validate`?" If yes, proceed. If not, something has changed between executions, and the replay is invalid.

### The SuspendExecution Sentinel

When a step needs to suspend the function (e.g., waiting for a child task), the framework cannot simply `return` -- the function has code after the `await` that expects a result. Instead, the framework **throws a special sentinel error**:

```typescript
class SuspendExecution extends Error {
  constructor(public readonly waitpointId: string) {
    super("SUSPEND");
  }
}

// Inside step.triggerAndWait:
async triggerAndWait(taskId, payload) {
  const stepIndex = this.counter++;
  const cached = this.getCachedStep(stepIndex);
  if (cached) return cached.result;

  // No cached result -- this step needs to wait
  const childRun = await triggerChildTask(taskId, payload);
  await createWaitpoint(this.runId, childRun.id);
  await saveStep(this.runId, stepIndex, "send-email", { status: "WAITING" });
  await updateRunStatus(this.runId, "SUSPENDED");

  throw new SuspendExecution(childRun.id);
}
```

This pattern is directly analogous to **React Suspense**. In React, when a component needs data that is not yet available, the data-fetching library throws a Promise. React catches it, renders a fallback, and re-renders the component when the Promise resolves. In our system, when a step needs a result that is not yet available, the framework throws `SuspendExecution`. The worker catches it, marks the run as suspended, and moves on to other work. When the waitpoint resolves, the run is re-queued and the function is re-executed (replayed).

The worker's execution loop looks like:

```typescript
try {
  const result = await taskFunction(payload);
  await markRunCompleted(runId, result);
} catch (err) {
  if (err instanceof SuspendExecution) {
    // Expected -- the run is waiting for something
    // Status already set to SUSPENDED inside the step handler
    return;
  }
  // Actual error -- mark as failed
  await markRunFailed(runId, err);
}
```

### Non-Determinism Detection

The replay approach has a critical fragility: **the function must execute the same steps in the same order on every replay.** If anything causes the step sequence to change between executions, the cached results will be returned for the wrong steps, causing data corruption or crashes.

The `stepKey` comparison catches this. If the function is replayed and step index 1 was "charge" on the original execution but is now "validate" (perhaps because a conditional branch changed), the framework detects the mismatch and throws a `NonDeterminismError` instead of silently returning wrong data.

#### What Breaks Replay

The following patterns are **incompatible** with step-based replay:

1. **`Math.random()` in control flow**: If a random value determines which steps execute, the step sequence will differ on replay.
   ```typescript
   // BROKEN: different steps on each execution
   if (Math.random() > 0.5) {
     await step.run("pathA", () => doA());
   } else {
     await step.run("pathB", () => doB());
   }
   ```

2. **`Date.now()` in control flow**: Time-dependent branching changes between executions.
   ```typescript
   // BROKEN: might take different branch on replay (hours later)
   if (Date.now() > someDeadline) {
     await step.run("expired", () => handleExpiry());
   }
   ```

3. **Conditional steps based on external state**: If a database value changes between the original execution and the replay, different steps may execute.
   ```typescript
   // BROKEN: featureEnabled might change between executions
   const featureEnabled = await db.getSetting("new-feature");
   if (featureEnabled) {
     await step.run("newFeature", () => doNewThing());
   }
   ```

4. **Dynamic step counts**: Iterating over an array whose length can change.
   ```typescript
   // BROKEN if items.length changes between executions
   for (const item of items) {
     await step.run(`process-${item.id}`, () => processItem(item));
   }
   ```

The safe pattern is: **all control flow that determines which steps execute must depend only on the function's input payload or on the results of previous steps** (which are cached and replayed identically).

### The Catch-Swallowing Problem

There is a subtle but serious bug that can occur with the `SuspendExecution` sentinel. If user code wraps a step call in a try/catch, it can accidentally swallow the suspension:

```typescript
run: async (payload) => {
  try {
    // Step 0
    const result = await step.run("risky-step", async () => {
      return riskyOperation();
    });

    // Step 1 -- this step needs to suspend
    const child = await step.triggerAndWait("child-task", { data: result });
  } catch (err) {
    // BUG: This catches SuspendExecution too!
    console.log("Something failed:", err.message); // "SUSPEND"
    // The function continues instead of suspending
    // All subsequent steps execute with wrong/missing data
  }
}
```

The solution is to always re-throw `SuspendExecution`:

```typescript
} catch (err) {
  if (err instanceof SuspendExecution) throw err;
  console.log("Something failed:", err.message);
}
```

The framework can also help by making `SuspendExecution` extend a special base class that is not an `Error`, but this has its own trade-offs (stack traces, debugger behavior). Trigger.dev's SDK documentation explicitly warns users about this pattern.

### How Other Systems Handle This

**Trigger.dev v2 (io.runTask with cache keys)**: Before CRIU, Trigger.dev v2 used an approach nearly identical to our replay system. Tasks used `io.runTask("cache-key", fn)` to wrap side-effectful operations. The cache key was a string chosen by the developer. On replay, the framework matched by cache key rather than positional index. This was more flexible (steps could be reordered without breaking) but also more error-prone (duplicate keys, forgotten wrappers). Every side effect *had* to be wrapped in `io.runTask`; any unwrapped code (a bare `fetch()`, a direct database query) would execute again on replay, potentially causing double-writes.

**Trigger.dev v3 (real CRIU)**: The current production version uses CRIU checkpointing. The function does not replay at all -- it freezes and restores at the OS level. This eliminates all non-determinism concerns, catch-swallowing bugs, and the need to wrap steps. Any JavaScript code works, including `Math.random()`, `Date.now()`, and conditional branches. The cost is infrastructure complexity: Linux-only, container-based, significant storage for checkpoints, and cold-start latency when restoring.

**Temporal (deterministic workflow replay with command-based histories)**: Temporal takes the replay approach to its logical extreme. Workflow functions must be *fully deterministic*. Every side effect goes through an "activity" (Temporal's equivalent of a step). The workflow's execution history is stored as a sequence of *events* (commands and their results). On replay, Temporal feeds the cached results back to the workflow function in order. Non-determinism is detected by comparing the replayed command sequence against the stored history. Temporal enforces this rigorously -- the workflow sandbox prevents access to `Date.now()`, `Math.random()`, network I/O, and file system access within workflow code. Activities (which *can* have side effects) run in separate workers.

### Resources

- [Trigger.dev v3 Docs: How Resumability Works](https://trigger.dev/docs/runs/resumability)
- [Trigger.dev Blog: How We Built Resumability](https://trigger.dev/blog/how-we-built-resumability)
- [CRIU: Main Page](https://criu.org/Main_Page)
- [CRIU: Checkpoint/Restore](https://criu.org/Checkpoint/Restore)
- [Temporal: How Workflows Execute](https://docs.temporal.io/workflows#how-workflows-execute)
- [Temporal: Deterministic Constraints](https://docs.temporal.io/workflows#deterministic-constraints)
- [Temporal: Workflow Replay](https://docs.temporal.io/encyclopedia/detecting-non-determinism)
- [React Suspense: Conceptual Model](https://react.dev/reference/react/Suspense)
- [Trigger.dev v2 io.runTask Documentation (archived)](https://trigger.dev/docs/v2/sdk/io/runtask)

### Test Questions

1. **Why can't Node.js simply serialize a running function's state to disk and restore it later?**
   A running JavaScript function's state includes the V8 call stack (instruction pointers, local variables, closure references), heap objects, event loop state (pending timers, microtask queue), and native bindings (TLS connections, file descriptors). V8 does not expose any API to serialize the call stack of an individual function. The engine's startup snapshot mechanism captures the entire isolate state *before* user code runs, not mid-execution. Without OS-level intervention (like CRIU), there is no way to capture and restore the execution context of a single async function within a larger Node.js process.

2. **What happens if a user wraps a `step.triggerAndWait()` call in a try/catch without re-throwing `SuspendExecution`?**
   The `SuspendExecution` sentinel is caught by the user's catch block instead of propagating to the worker's execution loop. The function continues executing past the suspension point with no result from the child task. Subsequent steps may execute with undefined or wrong data, potentially causing data corruption, double-charges, or other side effects. The run never enters the `SUSPENDED` state from the worker's perspective, and the child's eventual completion will resolve a waitpoint for a run that has already moved past it.

3. **Why does Temporal prohibit `Date.now()` and `Math.random()` inside workflow functions?**
   Temporal replays workflow functions from the beginning on every resumption, feeding cached results for completed activities. If the workflow's control flow depends on non-deterministic values like the current time or random numbers, the step sequence may differ on replay, causing the cached results to be returned for the wrong activities. Temporal enforces this by running workflow code in a sandboxed environment that intercepts these calls and provides deterministic replacements (e.g., `workflow.now()` returns the time recorded during the original execution).

4. **How does step-based replay prevent a payment from being charged twice?**
   The payment charge is wrapped in a step (e.g., `step.run("charge", () => chargePayment(...))`). On the first execution, the step executes the callback, records the result (including the charge ID) in the `run_steps` table, and returns it. On replay, when the framework encounters the same step index, it returns the cached result from `run_steps` *without executing the callback*. The `chargePayment` function is never called again. The idempotency is guaranteed by the step cache, not by the payment provider.

5. **What is the key difference between Trigger.dev v2's cache-key approach and positional step counters?**
   Trigger.dev v2 matched steps by developer-chosen string keys (`io.runTask("my-key", fn)`), allowing steps to be reordered without breaking replay. Positional counters match by execution order (step index 0, 1, 2...), which is simpler but more fragile -- any change in step order breaks replay. The cache-key approach was more flexible but introduced new failure modes: duplicate keys caused ambiguity, and developers had to manually ensure uniqueness. Positional counters are deterministic by construction (if the code is deterministic) and require no manual key management.

6. **How does CRIU differ from a VM snapshot?**
   A VM snapshot captures an entire virtual machine -- OS kernel, all processes, all memory, all disk state. CRIU operates at the process level within a running Linux kernel. It checkpoints a single process (or process tree) by reading its state from `/proc`, including memory maps, registers, file descriptors, and signal handlers. The checkpoint files are much smaller (megabytes vs gigabytes), the restore is much faster (milliseconds vs seconds), and multiple checkpoints can coexist on the same host. CRIU does not require a hypervisor or virtual machine -- it works on bare metal or inside containers.

---

## 2. Waitpoints -- The Universal Suspension Primitive

### What Is a Waitpoint?

A waitpoint is a database-backed condition that must be satisfied before a suspended run can resume. It is the single abstraction through which *all* suspension flows in reload.dev. Whether a task is waiting for a child task to complete, sleeping for 30 seconds, waiting for a human to approve something, or waiting for a batch of 50 tasks to finish, the mechanism is always the same: create a waitpoint, suspend the run, resolve the waitpoint when the condition is met, resume the run.

This universality is the key design insight. Without it, you would need separate suspension mechanisms for each use case: a timer-based system for delays, a parent-child linking system for child tasks, a webhook system for external events, and a counter system for batches. Each would have its own state machine, its own resumption logic, its own edge cases. With waitpoints, there is one state machine, one resumption path, one set of edge cases to handle.

### Waitpoint Types

Waitpoints come in four types, each representing a different kind of condition:

**CHILD_RUN** -- The run is waiting for a specific child task to complete. Created when a parent calls `triggerAndWait(childTask, payload)`. Resolved when the child run reaches a terminal state (`COMPLETED` or `FAILED`). The child's output (or error) is stored as the waitpoint's result.

**DURATION** -- The run is waiting for a time period to elapse. Created when a task calls `wait.for({ seconds: 30 })` or `wait.until(specificDate)`. The waitpoint stores a `resumeAfter` timestamp. A background scheduler polls for duration waitpoints whose `resumeAfter` has passed and resolves them.

**TOKEN** -- The run is waiting for an external system or human to provide a signal. Created when a task calls `wait.forToken()`. The system generates a unique, unguessable token string and exposes it via an API endpoint. Any external system can POST to that endpoint with the token and a payload to resolve the waitpoint. This is the foundation of human-in-the-loop workflows.

**BATCH** -- The run is waiting for a collection of child tasks to *all* complete. Created when a parent calls `batchTriggerAndWait([...tasks])`. The waitpoint tracks `batchTotal` (how many children were spawned) and `batchResolved` (how many have completed so far). When `batchResolved >= batchTotal`, the waitpoint resolves with all children's outputs collected into an array.

### Waitpoint Lifecycle

Every waitpoint follows the same three-state lifecycle:

```
CREATED → PENDING → RESOLVED
```

**CREATED**: The waitpoint row exists in the database but is not yet actively blocking a run. This state is brief -- it exists between the INSERT and the moment the run is suspended.

**PENDING**: The waitpoint is actively blocking one or more runs. The associated runs are in `SUSPENDED` status. The waitpoint is waiting for its condition to be met.

**RESOLVED**: The condition has been met. The waitpoint's `result` column contains the output data. All runs blocked on this waitpoint are eligible for resumption.

The state transitions are:

```
create_waitpoint()           → CREATED
suspend_run(runId, wpId)     → PENDING  (run status → SUSPENDED)
resolve_waitpoint(wpId, data)→ RESOLVED (run status → QUEUED)
```

### Resolution Flow

When a waitpoint is resolved, the following sequence occurs:

1. The waitpoint's `status` is updated to `RESOLVED` and its `result` column is populated with the resolution data.
2. The system looks up all runs that are blocked on this waitpoint (via the many-to-many join table `run_waitpoints`).
3. For each blocked run, it checks whether *all* of that run's waitpoints are now resolved. (A run could theoretically be waiting on multiple waitpoints.)
4. If all waitpoints are resolved, the run's status is changed from `SUSPENDED` to `QUEUED`, making it eligible for a worker to pick up.
5. The step result is cached in `run_steps` so that when the function replays, the step that triggered the suspension returns the resolved data.

This resolution is performed inside a database transaction to prevent race conditions. Without a transaction, two waitpoints resolving simultaneously for the same run could both check "are all waitpoints resolved?" at the same time, both see one remaining, and neither transition the run to `QUEUED`.

### Token Waitpoints: Human-in-the-Loop

Token waitpoints deserve special attention because they enable an entirely new category of workflows: those that require human decisions.

Consider an expense approval workflow:

```typescript
export const expenseApproval = task({
  id: "expense-approval",
  run: async (payload) => {
    // Step 0: Create the expense record
    const expense = await step.run("create-expense", async () => {
      return db.expenses.create({
        amount: payload.amount,
        description: payload.description,
        submittedBy: payload.userId,
      });
    });

    // Step 1: Wait for manager approval
    const approval = await step.waitForToken("manager-approval", {
      // Metadata sent to the token creation -- used to build the approval UI
      expenseId: expense.id,
      approverEmail: payload.managerEmail,
    });

    // Step 2: Process based on decision
    if (approval.decision === "approved") {
      await step.run("process-payment", async () => {
        return processReimbursement(expense.id, payload.amount);
      });
    } else {
      await step.run("notify-rejection", async () => {
        return sendRejectionEmail(payload.userId, approval.reason);
      });
    }

    return { expense, approval };
  },
});
```

When `step.waitForToken` executes:

1. A unique token is generated (e.g., a UUID v4 or a cryptographically random string).
2. A WAITPOINT row is created with `type=TOKEN`, `token=<generated string>`, and optionally a `tokenExpiresAt` timestamp.
3. The token is returned to the caller (or emitted as an event) so it can be embedded in an email link, a Slack message, or a dashboard button.
4. The run suspends via `SuspendExecution`.
5. Hours or days later, the manager clicks "Approve" in their email, which sends a POST request to the reload.dev API:
   ```
   POST /api/waitpoints/tokens/<token>/resolve
   Body: { "decision": "approved" }
   ```
6. The API resolves the waitpoint with the provided payload. The run is re-queued. On replay, step 1 returns `{ decision: "approved" }` from the cache, and the function proceeds to process the payment.

Token expiry is handled by the duration scheduler. If a token waitpoint has a `tokenExpiresAt` that has passed without resolution, the scheduler resolves it with a timeout result (or fails it, depending on configuration).

### How Trigger.dev Models Waitpoints

In Trigger.dev's production system, the relationship between runs and waitpoints is **many-to-many**. A single run can be blocked on multiple waitpoints (e.g., waiting for both a child task AND a timer). A single waitpoint can block multiple runs (e.g., a shared resource lock). This is modeled with a join table:

```
runs ←→ run_waitpoints ←→ waitpoints
```

The `run_waitpoints` table contains:
- `runId` -- the run that is blocked
- `waitpointId` -- the waitpoint it is waiting on
- `createdAt` -- when the association was created

When any waitpoint resolves, the system must check: "For each run blocked on this waitpoint, are *all* of that run's waitpoints resolved?" Only if the answer is yes does the run get re-queued.

In our implementation, we simplify this slightly -- a run typically waits on a single waitpoint at a time (one child, one timer, or one batch). But the many-to-many model is important to understand because it enables advanced patterns like "wait for the first of N events" or "wait for both a timer AND a child."

### Resources

- [Trigger.dev Docs: Wait](https://trigger.dev/docs/wait)
- [Trigger.dev Docs: Wait for Token](https://trigger.dev/docs/wait-for-token)
- [Trigger.dev Docs: Wait for Event](https://trigger.dev/docs/wait-for-event)
- [Trigger.dev Docs: Resumability](https://trigger.dev/docs/runs/resumability)
- [Temporal Docs: Signals](https://docs.temporal.io/workflows#signal) (analogous to token waitpoints)
- [Temporal Docs: Timers](https://docs.temporal.io/workflows#timer)
- [AWS Step Functions: Wait State](https://docs.aws.amazon.com/step-functions/latest/dg/amazon-states-language-wait-state.html)

### Test Questions

1. **Why is it important that waitpoint resolution and run status update happen in a single database transaction?**
   Without a transaction, a race condition can occur: two waitpoints for the same run resolve simultaneously. Both check "are all this run's waitpoints resolved?" Both see the *other* waitpoint still pending (because neither has committed yet). Neither transitions the run to `QUEUED`. The run remains `SUSPENDED` forever, even though all its waitpoints are resolved. A transaction with appropriate locking ensures that only one resolution process evaluates the run's readiness at a time, and the run is correctly re-queued exactly once.

2. **How do token waitpoints enable human-in-the-loop workflows?**
   When a task needs a human decision, it calls `step.waitForToken()`, which generates a unique token, creates a TOKEN waitpoint, and suspends the run. The token is embedded in a communication channel the human uses -- an email link, a Slack button, a dashboard approval button. When the human acts, their action triggers a POST request to the reload.dev API with the token and their decision payload. The API resolves the waitpoint, caches the human's response as the step result, and re-queues the run. On replay, the step returns the human's decision from cache, and the function continues with the approval or rejection logic.

3. **What happens if a token waitpoint expires before being resolved?**
   A background scheduler periodically checks for TOKEN waitpoints with a `tokenExpiresAt` timestamp that has passed. When it finds one, it resolves the waitpoint with a timeout/expiry result (or marks it as failed, depending on the configured behavior). The parent run is re-queued and, on replay, receives the timeout result from the step. The task function can then handle the timeout -- e.g., sending a reminder, escalating to a different approver, or canceling the workflow.

4. **Why use a single "waitpoint" abstraction for children, timers, tokens, and batches instead of separate mechanisms?**
   A unified abstraction means one state machine, one resolution path, one set of database operations, and one resumption flow. Every new suspension use case (external webhooks, resource locks, rate limiting) only needs to define how its waitpoint is *created* and *resolved* -- the suspension, caching, and resumption logic is shared. This reduces code duplication, minimizes the surface area for bugs, and makes the system easier to reason about. Without it, each suspension type would need its own suspension mechanism, its own interaction with `run_steps`, and its own edge-case handling.

5. **In a many-to-many model, how does the system decide when to resume a run that is blocked on multiple waitpoints?**
   When any waitpoint resolves, the system queries the join table for all runs blocked on that waitpoint. For each such run, it then queries all waitpoints associated with that run and checks whether every one has status `RESOLVED`. Only if all of a run's waitpoints are resolved does the system transition the run from `SUSPENDED` to `QUEUED`. This "all-must-be-resolved" check is performed inside a transaction with a `SELECT ... FOR UPDATE` on the run row to prevent concurrent resolution processes from double-queuing the same run.

---

## 3. DAG Execution

### What Is a DAG?

A Directed Acyclic Graph (DAG) is a graph structure where edges have direction and there are no cycles -- you cannot follow the edges from any node and arrive back at the same node. In the context of task execution, nodes are tasks and edges represent dependencies: "task B depends on task A" means A must complete before B starts.

DAGs are the natural way to model workflows. A data pipeline might look like:

```
  [Extract A]   [Extract B]
       \             /
        \           /
       [Transform]
           |
        [Load]
```

Extract A and Extract B can run in parallel (they share no dependency). Transform depends on both extracts completing. Load depends on Transform. This is a DAG with four nodes.

### Parent-Child Relationships in reload.dev

In reload.dev, DAG relationships are established through `parentRunId`. When a parent task triggers a child:

```typescript
const result = await step.triggerAndWait("child-task", payload);
```

The system creates a new run with `parentRunId` pointing to the parent's run ID. This creates a tree structure (which is a special case of a DAG):

```
Parent Run (run_001)
├── Child Run A (run_002, parentRunId=run_001)
├── Child Run B (run_003, parentRunId=run_001)
│   ├── Grandchild Run (run_004, parentRunId=run_003)
│   └── Grandchild Run (run_005, parentRunId=run_003)
└── Child Run C (run_006, parentRunId=run_001)
```

Each parent-child edge also creates a CHILD_RUN waitpoint. The parent is suspended until the waitpoint resolves. The child runs independently -- it is queued, dequeued by a worker, executed, and completed just like any top-level run. When the child completes, its output resolves the waitpoint, and the parent resumes.

### Fan-Out: Triggering N Children

Fan-out is the pattern of spawning multiple children from a single parent:

```typescript
export const processAllOrders = task({
  id: "process-all-orders",
  run: async (payload) => {
    const orders = await step.run("fetch-orders", async () => {
      return db.orders.findMany({ where: { status: "pending" } });
    });

    // Fan-out: process each order in parallel
    const results = await step.batchTriggerAndWait(
      orders.map((order) => ({
        taskId: "process-order",
        payload: { orderId: order.id },
      }))
    );

    return { processed: results.length };
  },
});
```

The parent triggers N children and suspends. All N children are queued independently and can execute in parallel across multiple workers. This is where the task queue architecture pays dividends -- 10 workers can process 10 children simultaneously.

### Fan-In: Barrier Synchronization

Fan-in is the inverse: the parent waits for *all* children to complete before continuing. This is also called a **barrier** or **join**. The BATCH waitpoint handles this: it tracks `batchTotal` and `batchResolved`, and only resolves when all children have reported their results.

The barrier is implicit in `batchTriggerAndWait` -- the parent does not manually track which children have completed. The waitpoint handles it. When the last child completes, the batch waitpoint resolves with all outputs, and the parent resumes with the complete array of results.

Fan-in is where failure handling becomes complex. What happens if one child out of 50 fails?

### Child Failure Strategies

When a child task fails, the parent must decide what to do. There are several strategies:

**Fail parent immediately**: As soon as any child fails, the parent is failed too. This is the simplest and most conservative approach. The batch waitpoint is resolved with an error, and the remaining children may continue running (they are already queued) but their results are discarded.

```typescript
// Strict mode: any failure fails the whole batch
const results = await step.batchTriggerAndWait(tasks, {
  onChildFailure: "fail-parent",
});
```

**Wait for all, then fail**: Let all children run to completion (or failure). Only after every child has reached a terminal state does the parent evaluate the results. If any failed, the parent can decide what to do. This is useful when the children's side effects (emails sent, records created) are valuable even if some fail.

```typescript
// Lenient mode: wait for all, handle failures in parent code
const results = await step.batchTriggerAndWait(tasks, {
  onChildFailure: "wait-for-rest",
});
const failures = results.filter((r) => r.status === "failed");
if (failures.length > 0) {
  await step.run("handle-failures", () => alertOps(failures));
}
```

**Retry child**: The child's own retry configuration applies first (if the child is configured with `maxRetries: 3`, it will retry itself before reporting failure to the parent). The parent can also implement retry logic by catching the failure and re-triggering the child.

### Depth Limits and Recursion

DAGs must be acyclic. If task A triggers task B which triggers task A, you have infinite recursion. The system guards against this with:

1. **Depth tracking**: Each run tracks its depth in the tree (`depth = parent.depth + 1`). If depth exceeds a configured maximum (e.g., 10), the trigger is rejected.
2. **Cycle detection**: Before creating a child run, the system can walk up the `parentRunId` chain to verify that the new child's task ID does not appear as an ancestor. This is O(depth) and practical for shallow trees.

### How Other Systems Handle DAGs

**Temporal** models DAGs through workflow composition. A parent workflow calls `workflow.executeChildWorkflow(...)` to spawn children. Child workflows run in their own execution context with their own event history. The parent can await a single child (sequential dependency) or use `Promise.all()` to fan out and fan in. Temporal supports cancellation propagation: if a parent workflow is cancelled, its children are automatically cancelled too.

**Apache Airflow** models DAGs declaratively. You define tasks and their dependencies in Python:
```python
task_a >> task_b >> task_c  # Sequential
task_a >> [task_b, task_c]  # Fan-out
[task_b, task_c] >> task_d  # Fan-in
```
Airflow's scheduler resolves the DAG structure and executes tasks in topological order, running parallel branches concurrently. Each task is an isolated execution (no shared memory), and dependencies are satisfied by checking the upstream tasks' states in the metadata database.

**AWS Step Functions** models DAGs as state machines in JSON (Amazon States Language). The `Parallel` state type creates parallel branches, and a `Map` state iterates over an array, spawning parallel executions. Step Functions handles fan-in automatically -- a Parallel state waits for all branches to complete before transitioning to the next state. Failure in any branch can be caught with `Catch` blocks.

### Resources

- [Trigger.dev Docs: Triggering Child Tasks](https://trigger.dev/docs/triggering)
- [Trigger.dev Docs: Batch Triggering](https://trigger.dev/docs/triggering#batch-triggering)
- [Temporal Docs: Child Workflows](https://docs.temporal.io/encyclopedia/child-workflows)
- [Apache Airflow Docs: DAGs](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dags.html)
- [AWS Step Functions: Parallel State](https://docs.aws.amazon.com/step-functions/latest/dg/amazon-states-language-parallel-state.html)
- [Wikipedia: Directed Acyclic Graph](https://en.wikipedia.org/wiki/Directed_acyclic_graph)
- [Wikipedia: Barrier (computer science)](https://en.wikipedia.org/wiki/Barrier_(computer_science))

### Test Questions

1. **Why must the task dependency graph be acyclic?**
   A cycle in the dependency graph means task A waits for task B, which waits for task C, which waits for task A. None of the tasks can ever complete because each is waiting for another in the cycle. This is a deadlock. The system would consume resources (database rows, waitpoints) without making progress. By enforcing that the graph is acyclic (via depth limits and/or cycle detection), we guarantee that the graph has a topological ordering -- there is always at least one task that has no unsatisfied dependencies and can make progress.

2. **What is the difference between fan-out and fan-in?**
   Fan-out is one parent spawning multiple children that execute in parallel. It multiplies parallelism -- 50 orders can be processed simultaneously by 50 workers. Fan-in is the inverse: the parent waits for all children to complete (a barrier/join) and collects their results. Fan-out is the `batchTriggerAndWait` call; fan-in is the implicit barrier that blocks the parent until the batch waitpoint's `batchResolved` counter reaches `batchTotal`.

3. **If a parent task triggers 10 children and child #3 fails, what are the trade-offs between "fail-parent" and "wait-for-rest"?**
   "Fail-parent" is fast -- the parent fails immediately, no resources are wasted on the remaining 7 children. But if children have side effects (sent emails, charged payments), those effects from children 1-2 have already occurred and cannot be undone. "Wait-for-rest" is thorough -- it lets all children finish, giving you a complete picture of which succeeded and which failed. The parent can then make an informed decision (retry failures, compensate, alert). The trade-off is latency and resource usage: waiting for all 10 children to finish takes longer, but provides more information for error handling.

4. **How does Airflow's DAG model differ from reload.dev's parent-child model?**
   Airflow defines the entire DAG structure *upfront* in Python code -- all tasks and their dependencies are known before any task executes. The scheduler resolves the topological order and runs tasks accordingly. In reload.dev, the DAG is *dynamic*: a parent task decides at runtime which children to spawn, based on data fetched in earlier steps. A reload.dev parent could fetch a list from a database and fan out to a variable number of children. Airflow requires the DAG structure to be fixed at parse time (though dynamic DAGs are now supported with caveats).

5. **Why does Temporal propagate cancellation from parent to child workflows?**
   Without cancellation propagation, killing a parent workflow would leave orphaned child workflows running indefinitely. These orphans consume resources, may have side effects, and their results are never consumed. Cancellation propagation ensures that when a parent is cancelled (due to user action, timeout, or error), all downstream work is also cancelled. This is the same principle as structured concurrency in languages like Kotlin and Swift -- the lifetime of a child is bounded by the lifetime of its parent.

---

## 4. The `run_steps` Table

### Why a Separate Table, Not JSONB?

The obvious approach to storing step results is a JSONB column on the `runs` table:

```sql
ALTER TABLE runs ADD COLUMN steps JSONB DEFAULT '[]';
```

Each step's result would be appended to the array:
```json
[
  { "index": 0, "key": "validate", "result": { "valid": true, "customerId": "cus_123" } },
  { "index": 1, "key": "charge",   "result": { "chargeId": "ch_456", "amount": 2999 } }
]
```

This is simple, and for small numbers of steps it works fine. But it falls apart as complexity grows:

**Concurrency**: Appending to a JSONB array requires a read-modify-write cycle. Two concurrent writes (e.g., the system updating step 5 while a monitoring query reads the steps) require row-level locking on the entire run. With a separate table, each step is its own row -- concurrent writes to different steps do not conflict.

**Query performance**: Finding "all runs where step 3 failed" requires scanning the JSONB array in every row: `WHERE steps->3->>'status' = 'FAILED'`. With a separate table, this is a simple indexed query: `WHERE stepIndex = 3 AND status = 'FAILED'`.

**Row size**: PostgreSQL stores rows on 8KB pages. A run with 50 steps, each with substantial result data, could easily exceed this, triggering TOAST (The Oversized-Attribute Storage Technique). TOASTed values are stored out-of-line, adding I/O overhead to every read. A separate table keeps each row small.

**Partial loading**: During replay, the framework loads all cached steps at the start of execution. With JSONB, it loads everything at once (fine). With a separate table, it can also load everything at once, but it can also load incrementally or skip steps that are not needed.

**Schema clarity**: Each step has a clear, typed schema. Migrations are straightforward ALTER TABLE operations. With JSONB, you are responsible for your own schema validation, migration, and documentation.

### Schema

```sql
CREATE TABLE run_steps (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_index  INTEGER NOT NULL,
  step_key    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'COMPLETED',  -- COMPLETED, WAITING, FAILED
  result      JSONB,
  error       JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(run_id, step_index)
);

CREATE INDEX idx_run_steps_run_id ON run_steps(run_id);
```

Key design decisions:

- **`run_id` + `step_index` is unique**: A run cannot have two steps with the same index. This prevents duplicate step insertion on concurrent replays.
- **`step_key` is informational**: It is used for non-determinism detection and debugging, not for lookups. The canonical identifier is `step_index`.
- **`result` is JSONB**: Step results can be any serializable value -- objects, arrays, strings, numbers, null.
- **`error` is separate from `result`**: A failed step has an `error` (the serialized exception) but no `result`. A completed step has a `result` but no `error`. Keeping them separate avoids ambiguity.
- **CASCADE delete**: If a run is deleted, all its steps are deleted too. No orphaned step data.

### Loading Order Matters

When the framework prepares to replay a function, it loads all cached steps for the run:

```sql
SELECT step_index, step_key, status, result, error
FROM run_steps
WHERE run_id = $1
ORDER BY step_index ASC;
```

The `ORDER BY step_index ASC` is critical. The framework builds an in-memory array indexed by step position. When the function executes and the framework's counter hits step N, it looks up index N in the array. If the array is out of order, the wrong result is returned for the wrong step.

In practice, the framework typically loads all steps into a `Map<number, StepResult>` keyed by `step_index`:

```typescript
const cachedSteps = new Map<number, StepResult>();
const rows = await db.query(
  "SELECT step_index, step_key, status, result FROM run_steps WHERE run_id = $1 ORDER BY step_index",
  [runId]
);
for (const row of rows) {
  cachedSteps.set(row.step_index, {
    key: row.step_key,
    status: row.status,
    result: row.result,
  });
}
```

### Non-Determinism Detection via stepKey

On replay, when the framework encounters step index N with key "charge", it checks the cached step at index N. If the cached key is also "charge", replay proceeds. If the cached key is "validate" (because the code was modified between executions, or a conditional branch changed), the framework throws:

```typescript
if (cached.key !== currentKey) {
  throw new NonDeterminismError(
    `Step ${stepIndex}: expected key "${cached.key}" but got "${currentKey}". ` +
    `The function's step sequence has changed between executions. ` +
    `This usually means non-deterministic control flow (Math.random, Date.now, ` +
    `external state) is affecting which steps execute.`
  );
}
```

This error is not retryable -- the run is marked as `FAILED` with a non-determinism error. The developer must fix the non-deterministic control flow and re-trigger the run.

### Resources

- [PostgreSQL Docs: JSONB Types](https://www.postgresql.org/docs/current/datatype-json.html)
- [PostgreSQL Docs: TOAST](https://www.postgresql.org/docs/current/storage-toast.html)
- [Trigger.dev Source: Task Run Execution Machine](https://github.com/triggerdotdev/trigger.dev/tree/main/packages/core/src/v3)
- [Temporal Docs: Event History](https://docs.temporal.io/workflows#event-history) (analogous to run_steps)

### Test Questions

1. **Why is the `step_key` stored alongside `step_index` even though lookups use `step_index`?**
   The `step_key` serves two purposes. First, it enables non-determinism detection: on replay, the framework compares the current step's key with the cached step's key at the same index. A mismatch indicates that the function's step sequence has changed, which would cause wrong results to be returned. Second, it aids debugging -- when viewing a run's step history, human-readable keys like "charge" or "send-email" are far more informative than bare index numbers.

2. **What would go wrong if `run_steps` rows were loaded without `ORDER BY step_index`?**
   The framework builds an in-memory array or map from the loaded rows, indexed by step position. Without ordering, rows could be loaded in insertion order, which might differ from step order if steps were inserted out of sequence (e.g., due to concurrent operations or retries). The framework's positional counter would then retrieve the wrong cached result for each step. In practice, using a `Map<number, StepResult>` keyed by `step_index` makes the load order irrelevant for correctness, but the `ORDER BY` ensures predictable behavior and simplifies debugging.

3. **Why is `UNIQUE(run_id, step_index)` important for correctness?**
   Without this constraint, a bug or race condition could insert two rows for the same run and step index. On replay, the framework would find two cached results for step N and not know which to use. The unique constraint guarantees that each step position has exactly one result, enforced at the database level. Any duplicate insertion attempt (e.g., from a retry that re-executes a step before checking the cache) receives a constraint violation error, which the framework can catch and handle by reading the existing result.

---

## 5. The `waitpoints` Table

### Schema

```sql
CREATE TABLE waitpoints (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT NOT NULL,  -- 'CHILD_RUN', 'DURATION', 'TOKEN', 'BATCH'
  status          TEXT NOT NULL DEFAULT 'CREATED',  -- 'CREATED', 'PENDING', 'RESOLVED'
  result          JSONB,

  -- CHILD_RUN specific
  child_run_id    UUID REFERENCES runs(id),

  -- DURATION specific
  resume_after    TIMESTAMPTZ,

  -- TOKEN specific
  token           TEXT UNIQUE,
  token_expires_at TIMESTAMPTZ,

  -- BATCH specific
  batch_total     INTEGER,
  batch_resolved  INTEGER DEFAULT 0,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,

  CONSTRAINT valid_type CHECK (type IN ('CHILD_RUN', 'DURATION', 'TOKEN', 'BATCH'))
);

CREATE INDEX idx_waitpoints_child_run_id ON waitpoints(child_run_id) WHERE child_run_id IS NOT NULL;
CREATE INDEX idx_waitpoints_token ON waitpoints(token) WHERE token IS NOT NULL;
CREATE INDEX idx_waitpoints_duration ON waitpoints(resume_after) WHERE type = 'DURATION' AND status = 'PENDING';

-- Many-to-many: which runs are blocked on which waitpoints
CREATE TABLE run_waitpoints (
  run_id       UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  waitpoint_id UUID NOT NULL REFERENCES waitpoints(id) ON DELETE CASCADE,
  PRIMARY KEY (run_id, waitpoint_id)
);
```

This is a **single-table polymorphic design**. All four waitpoint types share the same table, with type-specific columns that are NULL for irrelevant types. A CHILD_RUN waitpoint has `child_run_id` set but `token`, `resume_after`, `batch_total` are NULL. A DURATION waitpoint has `resume_after` set but `child_run_id`, `token` are NULL.

The alternative -- separate tables for each type (`child_run_waitpoints`, `duration_waitpoints`, `token_waitpoints`, `batch_waitpoints`) -- would be more normalized but would complicate the resolution flow. The `run_waitpoints` join table would need to reference four different tables, and the "are all waitpoints resolved?" check would need to query all four. The polymorphic design keeps things simple: one table, one query, one resolution path.

### How Each Type Is Created and Resolved

#### CHILD_RUN

**Created when**: A parent task calls `step.triggerAndWait("child-task", payload)`.

**Creation flow**:
1. A new run is created for the child task with `parentRunId = <parent run ID>`.
2. A waitpoint is created: `type='CHILD_RUN'`, `child_run_id=<child run ID>`, `status='CREATED'`.
3. A `run_waitpoints` row links the parent run to the waitpoint.
4. The parent run's step is saved with `status='WAITING'`.
5. The parent run's status is set to `SUSPENDED`.
6. The waitpoint's status is set to `PENDING`.

**Resolution**: When the child run completes (status changes to `COMPLETED` or `FAILED`), the system finds the CHILD_RUN waitpoint for that `child_run_id` and resolves it:
```sql
UPDATE waitpoints
SET status = 'RESOLVED',
    result = $childOutput,
    resolved_at = now()
WHERE child_run_id = $childRunId AND status = 'PENDING';
```

#### DURATION

**Created when**: A task calls `wait.for({ seconds: 30 })` or `wait.until(new Date("2025-01-01"))`.

**Creation flow**:
1. A waitpoint is created: `type='DURATION'`, `resume_after=now() + interval`, `status='PENDING'`.
2. A `run_waitpoints` row links the run to the waitpoint.
3. The run's step is saved and the run is suspended.

**Resolution**: A background scheduler (a cron job or polling loop) periodically queries for due duration waitpoints:
```sql
SELECT id FROM waitpoints
WHERE type = 'DURATION'
  AND status = 'PENDING'
  AND resume_after <= now()
LIMIT 100
FOR UPDATE SKIP LOCKED;
```

For each found waitpoint, it resolves it with a null result (there is no "output" from waiting -- the passage of time is the only event). The `SKIP LOCKED` ensures that multiple scheduler instances do not conflict.

The polling interval determines the granularity of duration waits. If the scheduler polls every 1 second, a `wait.for({ seconds: 5 })` will actually resume somewhere between 5 and 6 seconds. For most workflow use cases, this precision is sufficient.

#### TOKEN

**Created when**: A task calls `step.waitForToken("approval", { metadata })`.

**Creation flow**:
1. A cryptographically random token is generated (e.g., `crypto.randomUUID()`).
2. A waitpoint is created: `type='TOKEN'`, `token=<generated>`, optionally `token_expires_at=<expiry time>`, `status='PENDING'`.
3. A `run_waitpoints` row links the run to the waitpoint.
4. The token is returned or emitted so it can be sent to the external party.
5. The run suspends.

**Resolution**: An external system calls the resolve API:
```
POST /api/waitpoints/tokens/:token/resolve
Body: { "data": { "approved": true } }
```

The API handler:
```sql
UPDATE waitpoints
SET status = 'RESOLVED',
    result = $body,
    resolved_at = now()
WHERE token = $token AND status = 'PENDING';
```

If the token does not exist or is already resolved, the API returns a 404 or 409. The `UNIQUE` constraint on `token` ensures no collisions.

**Token expiry**: The duration scheduler also handles expired tokens. When polling, it includes:
```sql
SELECT id FROM waitpoints
WHERE type = 'TOKEN'
  AND status = 'PENDING'
  AND token_expires_at IS NOT NULL
  AND token_expires_at <= now();
```

Expired tokens are resolved with a timeout result: `{ "expired": true }`. The parent task can then handle the expiry in its step logic.

#### BATCH

**Created when**: A parent task calls `step.batchTriggerAndWait([...tasks])`.

**Creation flow**:
1. N child runs are created.
2. A single BATCH waitpoint is created: `type='BATCH'`, `batch_total=N`, `batch_resolved=0`, `status='PENDING'`.
3. N CHILD_RUN waitpoints are also created (one per child), each linked to the same batch.
4. A `run_waitpoints` row links the parent run to the BATCH waitpoint.
5. The parent suspends.

**Resolution**: Each time a child completes, its CHILD_RUN waitpoint resolves, and the batch counter is incremented:
```sql
UPDATE waitpoints
SET batch_resolved = batch_resolved + 1
WHERE id = $batchWaitpointId AND type = 'BATCH';
```

After incrementing, the system checks:
```sql
SELECT batch_resolved >= batch_total AS all_done
FROM waitpoints
WHERE id = $batchWaitpointId;
```

When `all_done` is true, the BATCH waitpoint is resolved with the collected outputs of all children:
```sql
UPDATE waitpoints
SET status = 'RESOLVED',
    result = $allChildOutputs,
    resolved_at = now()
WHERE id = $batchWaitpointId;
```

The batch increment and check must be atomic (within a single transaction, using `FOR UPDATE` on the batch row) to prevent race conditions where two children complete simultaneously, both increment to N, and both attempt to resolve the batch.

### Resources

- [Trigger.dev Docs: Wait](https://trigger.dev/docs/wait)
- [Trigger.dev Docs: Wait for Token](https://trigger.dev/docs/wait-for-token)
- [PostgreSQL Docs: Partial Indexes](https://www.postgresql.org/docs/current/indexes-partial.html)
- [PostgreSQL Docs: CHECK Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS)
- [Martin Fowler: Single Table Inheritance](https://martinfowler.com/eaaCatalog/singleTableInheritance.html)

### Test Questions

1. **Why use a single polymorphic `waitpoints` table instead of separate tables for each type?**
   The core resolution flow -- "check if all waitpoints for a run are resolved, then resume the run" -- requires querying all waitpoints associated with a run regardless of type. With separate tables, this requires querying four tables and unioning the results. With a single polymorphic table, it is one query against one table joined with `run_waitpoints`. The trade-off is NULL columns for type-specific fields, but this is a minor cost for the simplification of the resolution logic, the join table design, and the overall code paths.

2. **Why does the duration scheduler use `FOR UPDATE SKIP LOCKED` when polling for due waitpoints?**
   In a multi-instance deployment, multiple scheduler processes may poll simultaneously. Without `SKIP LOCKED`, two schedulers could select the same due waitpoint, both resolve it, and both attempt to resume the parent run -- potentially double-queuing it. `FOR UPDATE SKIP LOCKED` ensures that each waitpoint is claimed by exactly one scheduler instance. If another scheduler has already locked the row, it is silently skipped. This is the same pattern used for dequeuing task runs from the `runs` table.

3. **What happens if an external system tries to resolve a token that has already been resolved?**
   The `UPDATE ... WHERE status = 'PENDING'` clause ensures that only pending tokens can be resolved. If the token is already resolved (status = `'RESOLVED'`), the UPDATE affects zero rows. The API detects this (`rowCount === 0`) and returns an appropriate error response (e.g., 409 Conflict or 404 Not Found). The waitpoint's result remains unchanged -- the first resolution wins. This provides idempotency protection against duplicate POST requests from the external system.

---

## 6. Batch Operations (Fan-Out/Fan-In)

### The Full Picture

Batch operations are the synthesis of everything in this phase: child tasks, waitpoints, step replay, and the DAG model. A single `batchTriggerAndWait` call orchestrates the creation of multiple child runs, the establishment of waitpoints, the suspension and eventual resumption of the parent, and the collection of all results into a single array.

### How `batchTriggerAndWait` Works End-to-End

Let's trace through a complete batch operation. A parent task wants to process 5 items in parallel:

```typescript
export const batchProcessor = task({
  id: "batch-processor",
  run: async (payload) => {
    const items = await step.run("fetch-items", async () => {
      return db.items.findMany({ where: { batchId: payload.batchId } });
    });

    // Fan-out: process all items in parallel, wait for all to complete
    const results = await step.batchTriggerAndWait(
      items.map((item) => ({
        taskId: "process-item",
        payload: { itemId: item.id },
      }))
    );

    // Fan-in complete: all results available
    const summary = await step.run("summarize", async () => {
      const successful = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      return { total: items.length, successful: successful.length, failed: failed.length };
    });

    return summary;
  },
});
```

When `step.batchTriggerAndWait` executes for the first time:

**Phase 1: Creation (all within a single transaction)**

1. The framework increments its step counter (say this is step index 1, after "fetch-items" at index 0).
2. Five child runs are created in the `runs` table, each with `parentRunId` pointing to the parent and `status = 'QUEUED'`.
3. One BATCH waitpoint is created: `type='BATCH'`, `batch_total=5`, `batch_resolved=0`, `status='PENDING'`.
4. Five CHILD_RUN waitpoints are created, one per child, each linked to the batch waitpoint.
5. A `run_waitpoints` row links the parent run to the BATCH waitpoint.
6. The step is saved in `run_steps`: `stepIndex=1`, `stepKey="batch-process-item"`, `status='WAITING'`.
7. The parent run's status is updated to `SUSPENDED`.
8. `SuspendExecution` is thrown, interrupting the function.

**Phase 2: Parallel Execution**

The five child runs are now in the `runs` table with `status = 'QUEUED'`. Workers dequeue them using `SELECT ... FOR UPDATE SKIP LOCKED` -- up to 5 workers can process them simultaneously. Each child executes independently:

```typescript
export const processItem = task({
  id: "process-item",
  run: async (payload) => {
    const item = await db.items.findUnique({ where: { id: payload.itemId } });
    const processed = await expensiveComputation(item);
    await db.items.update({ where: { id: item.id }, data: { processed: true } });
    return { itemId: item.id, result: processed };
  },
});
```

**Phase 3: Child Completion and Counter Increment**

As each child completes, the completion handler:

1. Marks the child run as `COMPLETED` with its output.
2. Finds the CHILD_RUN waitpoint for this child and resolves it.
3. Increments the BATCH waitpoint's `batch_resolved` counter:
   ```sql
   UPDATE waitpoints
   SET batch_resolved = batch_resolved + 1
   WHERE id = $batchWaitpointId
   RETURNING batch_resolved, batch_total;
   ```
4. Checks if `batch_resolved >= batch_total`. If not, the batch is still pending -- do nothing more.

This happens 5 times. Children 1 through 4 each increment the counter but find it still less than 5. Child 5 (the last to complete, in whatever order) increments to 5, which equals `batch_total`.

**Phase 4: Batch Resolution**

When the last child completes and `batch_resolved >= batch_total`:

1. All five children's outputs are collected (queried from the `runs` table or from the individual CHILD_RUN waitpoint results).
2. The BATCH waitpoint is resolved with the collected outputs as an array:
   ```json
   [
     { "itemId": "item_1", "result": "..." },
     { "itemId": "item_2", "result": "..." },
     { "itemId": "item_3", "result": "..." },
     { "itemId": "item_4", "result": "..." },
     { "itemId": "item_5", "result": "..." }
   ]
   ```
3. The parent run's step result is cached in `run_steps`: `stepIndex=1`, `result=<the array above>`.
4. The parent run's status is changed from `SUSPENDED` to `QUEUED`.

**Phase 5: Parent Replay**

A worker dequeues the parent run. The `run` function executes from the beginning:

1. Step 0 ("fetch-items") -- cached result returned from `run_steps`. The database query is not executed again.
2. Step 1 ("batch-process-item") -- cached result returned: the array of 5 child outputs. No children are triggered again. The `batchTriggerAndWait` call returns immediately with the collected results.
3. Step 2 ("summarize") -- this is new, so it executes normally.
4. The function returns.

### Atomicity of the Batch Counter

The `batch_resolved` increment is the most concurrency-sensitive operation in the system. Consider what happens without proper locking:

1. Child A and Child B complete at the same microsecond.
2. Both read `batch_resolved = 3`.
3. Both write `batch_resolved = 4`.
4. The counter is now 4, but two children completed, so it should be 5.
5. The batch never resolves. The parent is stuck forever.

The fix is atomic increment:

```sql
UPDATE waitpoints
SET batch_resolved = batch_resolved + 1
WHERE id = $batchWaitpointId
RETURNING batch_resolved, batch_total;
```

PostgreSQL guarantees that `UPDATE` acquires a row-level lock. Two concurrent UPDATEs on the same row are serialized -- one waits for the other to commit. The `batch_resolved = batch_resolved + 1` reads the current value *at the time the lock is acquired*, not at the time the transaction started. This ensures the increment is correct even under high concurrency.

The `RETURNING` clause lets the application check `batch_resolved >= batch_total` in the same statement, avoiding a separate query and the race condition that a separate read-then-check would introduce.

### Partial Failure Handling

When a child in a batch fails, the system has several options:

**Option 1: Fail the batch immediately**
The first child failure resolves the BATCH waitpoint with an error. The parent resumes and receives an error result for the batch step. Other children may still be running -- their results are discarded when they complete.

**Option 2: Record failure, continue counting**
The failed child still increments `batch_resolved`. Its "result" in the collected outputs is an error marker:
```json
{
  "itemId": "item_3",
  "ok": false,
  "error": { "message": "Connection timeout", "code": "ETIMEOUT" }
}
```
The parent receives the full array with both successes and failures, and can handle them in application logic.

**Option 3: Retry the child, do not increment**
If the child's retry configuration has not been exhausted, the child is retried. Only after all retries are exhausted does the child's result (success or final failure) increment the batch counter. This is typically the default behavior: the child's own retry logic runs first, and only the final outcome counts toward the batch.

In practice, Option 2 (continue counting, surface failures to the parent) combined with Option 3 (exhaust retries first) is the most common and most flexible configuration. The parent code receives all results and can make application-specific decisions about how to handle partial failure.

### Trigger.dev's 500-Item Limit

Trigger.dev enforces a maximum of 500 items per `batchTriggerAndWait` call. This limit exists for several reasons:

**Database transaction size**: Creating 500 child runs, 500 CHILD_RUN waitpoints, and 1 BATCH waitpoint in a single transaction involves 1,001+ INSERTs. This is a large transaction that holds locks for a non-trivial duration. Beyond 500, the transaction duration and lock contention become problematic.

**Memory**: The parent must hold all 500 results in memory when the batch resolves. Each result might be kilobytes of JSON. 500 results at 10KB each is 5MB -- manageable. 50,000 results would be 500MB.

**Queue pressure**: Enqueuing 500 tasks at once creates a burst that the worker pool must absorb. The queue system handles this well (workers dequeue independently), but monitoring and backpressure systems need to account for sudden spikes.

**Checkpoint size**: In Trigger.dev's CRIU-based system, the checkpoint must store the parent's memory state, including all 500 results. Larger batches mean larger checkpoints, slower freeze/restore, and more S3 storage.

For reload.dev, we may choose a different limit (or no limit initially), but understanding *why* the limit exists helps you make informed decisions. If you need to process 10,000 items, the recommended pattern is to batch them into groups of 500 and nest the batches:

```typescript
// Process 10,000 items in chunks of 500
const chunks = chunkArray(items, 500);
for (const chunk of chunks) {
  await step.batchTriggerAndWait(
    chunk.map((item) => ({ taskId: "process-item", payload: item }))
  );
}
```

Each chunk triggers, processes, and collects before the next chunk begins. The parent suspends and resumes for each chunk, keeping memory usage bounded.

### Ordering of Results

An important detail: the results array returned by `batchTriggerAndWait` must match the *input* order, not the *completion* order. If the parent triggers children for items [A, B, C, D, E] and they complete in order [C, A, E, B, D], the results array must still be `[resultA, resultB, resultC, resultD, resultE]`. This is achieved by storing the original index alongside each child run and sorting the results before returning.

Without this guarantee, the parent code could not correlate results to inputs by position:

```typescript
const results = await step.batchTriggerAndWait(
  items.map((item) => ({ taskId: "process-item", payload: item }))
);

// This only works if results[i] corresponds to items[i]
items.forEach((item, i) => {
  console.log(`${item.name}: ${results[i].status}`);
});
```

### Resources

- [Trigger.dev Docs: Batch Triggering](https://trigger.dev/docs/triggering#batch-triggering)
- [Trigger.dev Docs: batchTriggerAndWait](https://trigger.dev/docs/management/runs/batch-trigger)
- [PostgreSQL Docs: UPDATE RETURNING](https://www.postgresql.org/docs/current/dml-returning.html)
- [PostgreSQL Docs: Row-Level Locking](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)
- [AWS Step Functions: Map State (Parallel Iteration)](https://docs.aws.amazon.com/step-functions/latest/dg/amazon-states-language-map-state.html)
- [Temporal Docs: Child Workflow Execution](https://docs.temporal.io/encyclopedia/child-workflows)

### Test Questions

1. **Why must the `batch_resolved` increment use an atomic `UPDATE ... SET batch_resolved = batch_resolved + 1` rather than reading the value, incrementing in application code, and writing it back?**
   A read-increment-write cycle has a classic TOCTOU (time-of-check-to-time-of-use) race condition. Two children completing simultaneously both read `batch_resolved = 3`, both compute `3 + 1 = 4`, and both write `4`. The counter ends up at 4 instead of 5, and the batch never resolves because `batch_resolved` never reaches `batch_total`. PostgreSQL's `UPDATE` acquires a row-level lock, serializing concurrent updates. The `batch_resolved + 1` expression reads the value *while holding the lock*, guaranteeing correctness. The `RETURNING` clause avoids a second query to check the new value.

2. **Why does Trigger.dev impose a 500-item limit on batch operations?**
   The limit controls four scaling concerns: (1) database transaction size -- creating 500+ rows in a single transaction holds locks for too long and increases the risk of lock contention and transaction timeouts; (2) memory usage -- the parent must hold all results in memory when the batch resolves, and unbounded batch sizes could exhaust available RAM; (3) queue pressure -- enqueuing thousands of tasks at once creates a burst that may overwhelm workers and monitoring systems; (4) checkpoint size -- in Trigger.dev's CRIU-based system, larger batch results mean larger process checkpoints and more storage. The 500-item limit is a pragmatic balance between parallelism and system stability.

3. **Why must the results array preserve the input order rather than the completion order?**
   Parent code typically correlates results to inputs by position: `results[i]` corresponds to `inputs[i]`. If results were returned in completion order (which is non-deterministic and depends on worker availability, task duration, and network latency), the parent could not reliably match results to inputs without including an identifier in every payload and result. Preserving input order makes the API intuitive and predictable -- the same inputs always produce the same result ordering, regardless of which children finish first. This is implemented by storing each child's original index and sorting the collected outputs before returning them to the parent.

---

## Summary

Phase 6 adds three fundamental capabilities to reload.dev:

1. **Suspension and resumption** via step-based replay, where functions are re-executed from the beginning with cached results for completed steps. This avoids the need for OS-level process checkpointing (CRIU) while maintaining correctness for deterministic functions.

2. **Waitpoints** as the universal primitive for all forms of suspension -- child tasks, duration waits, external tokens, and batches. A single state machine and resolution path handles all use cases.

3. **DAG execution** through parent-child relationships, fan-out via batch triggering, and fan-in via barrier synchronization with atomic counters.

These capabilities transform reload.dev from a flat task queue into a workflow engine capable of expressing complex, multi-step, long-running business processes with human-in-the-loop decision points and parallel processing.
