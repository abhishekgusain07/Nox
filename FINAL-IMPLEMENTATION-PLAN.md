# reload.dev — Final Implementation Plan
## A Trigger.dev Clone Built for Deep Learning

---

## Table of Contents

1. [Why Build This](#1-why-build-this)
2. [Tech Stack](#2-tech-stack)
3. [Monorepo Structure](#3-monorepo-structure)
4. [FP Playbook](#4-fp-playbook)
5. [Patterns from T3 Code](#5-patterns-from-t3-code)
6. [Database Schema](#6-database-schema)
7. [State Machine](#7-state-machine)
8. [How Resumption Works](#8-how-resumption-works)
9. [Phase 1: Foundation](#phase-1-foundation)
10. [Phase 2: State Machine + Retries](#phase-2-state-machine--retries)
11. [Phase 3: Concurrency + Fair Queuing](#phase-3-concurrency--fair-queuing)
12. [Phase 4: Reliability](#phase-4-reliability)
13. [Phase 5: Observability](#phase-5-observability)
14. [Phase 6: Child Tasks + Waitpoints](#phase-6-child-tasks--waitpoints)
15. [Phase 7: Scheduling + Rate Limiting](#phase-7-scheduling--rate-limiting)
16. [Phase 8: Polish](#phase-8-polish)
17. [Discrepancies with Trigger.dev](#discrepancies-with-triggerdev)

---

## 1. Why Build This

You are not building a product. You are building **understanding**.

Task queues sit at the intersection of every hard distributed systems problem: concurrency control, fault tolerance, state machines, fair scheduling, exactly-once semantics, and observability. By building one from scratch, you will internalize these concepts in a way that reading about them never achieves.

Every decision in this plan serves that goal:

- **PostgreSQL SKIP LOCKED before Redis** — because you should understand database-level queuing before adding a separate queue layer. You will feel the limitations firsthand, which makes the Redis upgrade in Phase 3 meaningful rather than cargo-culted.
- **Hand-rolled FP utilities instead of Effect-TS** — because a 10-line Result type teaches you more about algebraic data types than importing a 50k-line library.
- **Step-based replay instead of CRIU** — because implementing a replay mechanism forces you to think about determinism, side effects, and execution semantics. CRIU is a Linux kernel feature you cannot meaningfully implement.
- **Drizzle instead of Prisma** — because Drizzle is SQL-transparent. You write queries, not method chains. You see the SQL, you understand the SQL.
- **2-level concurrency instead of 4-level** — because you should nail queue-level and key-level concurrency before attempting org/env hierarchies. Depth over breadth.

The goal is not feature parity with Trigger.dev. The goal is that after building this, you can open any production queue system (Trigger.dev, BullMQ, Temporal, AWS Step Functions) and understand exactly what it is doing and why.

---

## 2. Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| **API Server** | Hono (on Node.js) | Lightweight, fast, excellent TypeScript support. Simpler than Express for an API-only server. |
| **Database** | PostgreSQL 16 | State storage, event log, AND primary queue (SKIP LOCKED) for Phases 1-2. The foundation of everything. |
| **Cache + Queue** | Redis 7 (Phase 3+) | Added in Phase 3 for concurrency tracking, sorted-set queuing, pub-sub, Lua atomics. NOT the primary queue until you have outgrown PG. |
| **ORM** | Drizzle | SQL-close. You see the actual queries. Great migration story. More transparent than Prisma. |
| **Build tool** | tsdown | Adopted from T3 Code. Fast, simple ESM builds for packages. |
| **Linting** | oxlint + oxfmt | Adopted from T3 Code. Simpler config than ESLint, much faster. |
| **Testing** | Vitest | Fast, modern, good TypeScript support. |
| **Package Manager** | pnpm | Monorepo-friendly workspaces. More mature than Bun. Use `tsx` for dev-time TypeScript execution. |
| **Worker Runtime** | Node.js child processes | Simple. No Docker dependency for development. |
| **Dashboard** | Next.js + TanStack Query v5 + Zustand | TanStack Query for server state, Zustand for client state (2-store pattern). SSE for real-time. |
| **Observability** | OpenTelemetry JS SDK | Industry standard. Traces + spans. |
| **FP approach** | Hand-rolled utilities | 10-line Result type, 10-line pipe/flow, discriminated unions, pure state transitions. No Effect-TS. |

### What We Skip and Why

| Skipped | Why |
|---------|-----|
| **Effect-TS** | Too heavy. We are learning task queues, not a functional programming framework. Hand-rolled utilities teach more. |
| **Full CQRS/Event Sourcing** | Overkill. We use an append-only `run_events` table for audit, but reads come from the `runs` table directly. |
| **Redis as primary queue (Phases 1-2)** | Starting with PG SKIP LOCKED teaches database-level queuing. Redis becomes meaningful when you hit PG's limits. |
| **Prisma** | Abstracts too much SQL. Drizzle lets you see and think in SQL. |
| **Socket.io** | HTTP polling + SSE is simpler and sufficient. Socket.io adds complexity without proportional learning value. |
| **Bun** | pnpm is more mature for monorepos. Fewer edge cases to debug. |

---

## 3. Monorepo Structure

```
reload-dev/
├── packages/
│   ├── core/                  # Zero business logic. Types, schemas, utilities.
│   │   ├── src/
│   │   │   ├── ids.ts              # Branded ID types (RunId, TaskId, QueueId)
│   │   │   ├── types.ts            # Domain types (Run, Task, Queue, etc.)
│   │   │   ├── schemas.ts          # Zod schemas for validation + contracts
│   │   │   ├── states.ts           # RunStatus enum, transition map
│   │   │   ├── events.ts           # Discriminated union event types
│   │   │   ├── errors.ts           # Discriminated union error types
│   │   │   ├── result.ts           # Hand-rolled Result<T, E> type
│   │   │   ├── pipe.ts             # Hand-rolled pipe/flow utilities
│   │   │   ├── event-bus.ts        # Typed pub/sub event bus
│   │   │   └── drainable-queue.ts  # DrainableQueue for testing
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── engine/                # The brain. Run engine, state machine, queue logic.
│   │   ├── src/
│   │   │   ├── run-engine.ts        # Main RunEngine — orchestrates everything
│   │   │   ├── state-machine.ts     # Pure state transition functions
│   │   │   ├── queue/
│   │   │   │   ├── pg-queue.ts          # PostgreSQL SKIP LOCKED queue
│   │   │   │   ├── redis-queue.ts       # Redis sorted set queue (Phase 3)
│   │   │   │   ├── fair-dequeue.ts      # Fair multi-queue dequeuing
│   │   │   │   └── concurrency.ts       # Concurrency tracking + Lua scripts
│   │   │   ├── retry/
│   │   │   │   └── retry.ts            # Backoff calculation (pure function)
│   │   │   ├── heartbeat/
│   │   │   │   └── heartbeat.ts        # Heartbeat monitor
│   │   │   ├── waitpoints/
│   │   │   │   └── waitpoints.ts       # Waitpoint resolution logic
│   │   │   └── resumption/
│   │   │       └── step-runner.ts      # Step-based replay engine
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── server/                # HTTP API + database layer
│   │   ├── src/
│   │   │   ├── index.ts             # Hono app setup
│   │   │   ├── routes/
│   │   │   │   ├── trigger.ts       # POST /api/trigger
│   │   │   │   ├── runs.ts          # GET/PATCH /api/runs
│   │   │   │   ├── queues.ts        # Queue management
│   │   │   │   ├── dequeue.ts       # POST /api/dequeue (worker pulls work)
│   │   │   │   ├── heartbeat.ts     # POST /api/runs/:id/heartbeat
│   │   │   │   ├── complete.ts      # POST /api/runs/:id/complete
│   │   │   │   ├── waitpoints.ts    # Waitpoint resolution endpoints
│   │   │   │   └── stream.ts        # SSE endpoints
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts          # API key validation
│   │   │   │   └── tracing.ts       # OpenTelemetry middleware
│   │   │   └── db/
│   │   │       ├── schema.ts        # Drizzle schema
│   │   │       ├── indexes.ts       # Explicit index definitions
│   │   │       └── migrations/      # SQL migration files
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── worker/                # Task execution runtime
│   │   ├── src/
│   │   │   ├── worker.ts            # Worker process manager
│   │   │   ├── task-runner.ts       # Loads + executes task code
│   │   │   ├── dequeue-loop.ts      # Polls server for work
│   │   │   └── shutdown.ts          # Graceful shutdown (SIGTERM)
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── sdk/                   # Client SDK
│   │   ├── src/
│   │   │   ├── client.ts           # ReloadClient — trigger tasks
│   │   │   ├── task.ts             # task() definition helper
│   │   │   └── types.ts            # Public types
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── dashboard/             # Next.js monitoring UI
│       ├── src/
│       │   ├── app/
│       │   │   ├── page.tsx              # Runs list
│       │   │   ├── runs/[id]/page.tsx    # Run detail + timeline
│       │   │   └── queues/page.tsx       # Queue management
│       │   ├── components/
│       │   │   ├── RunTimeline.tsx        # Visual state transition viewer
│       │   │   ├── StateIndicator.tsx     # Status badge
│       │   │   └── QueueStats.tsx         # Concurrency gauges
│       │   ├── stores/
│       │   │   ├── ui-store.ts           # Zustand: filters, sidebar, theme
│       │   │   └── query-keys.ts         # TanStack Query key factories
│       │   └── hooks/
│       │       └── use-run-stream.ts     # SSE hook for real-time updates
│       ├── package.json
│       └── tsconfig.json
│
├── tasks/                     # Example task definitions
│   ├── hello-world.ts
│   ├── send-email.ts
│   ├── process-data.ts
│   └── parent-child.ts
│
├── docker-compose.yml         # Postgres + Redis
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── turbo.json
├── .oxlintrc.json
└── package.json
```

### Package Dependency Graph

```
sdk ──> core
worker ──> core, sdk
engine ──> core
server ──> core, engine
dashboard ──> core (types only)
```

`core` depends on nothing. `engine` depends only on `core`. This is intentional — the engine is a pure logic layer. `server` wires the engine to HTTP and the database. `worker` is a separate process that communicates with `server` over HTTP.

---

## 4. FP Playbook

This section defines exactly which functional programming patterns to use and where. The approach is **Functional Core, Imperative Shell**: pure functions for all domain logic, imperative code at the boundaries (HTTP, database, Redis).

### 4.1 Hand-Rolled Result Type

```typescript
// packages/core/src/result.ts

type Ok<T> = { readonly _tag: "ok"; readonly value: T };
type Err<E> = { readonly _tag: "err"; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ _tag: "ok", value });
export const err = <E>(error: E): Err<E> => ({ _tag: "err", error });
export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r._tag === "ok";
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => r._tag === "err";

export const mapResult = <T, U, E>(
  r: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> => (isOk(r) ? ok(fn(r.value)) : r);

export const flatMap = <T, U, E>(
  r: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> => (isOk(r) ? fn(r.value) : r);
```

**Where to use**: Every function that can fail for domain reasons returns `Result<T, E>`. State machine transitions, validation, queue operations. NOT for I/O failures — those throw and are caught at the imperative shell.

### 4.2 Hand-Rolled Pipe/Flow

```typescript
// packages/core/src/pipe.ts

export function pipe<A, B>(a: A, ab: (a: A) => B): B;
export function pipe<A, B, C>(a: A, ab: (a: A) => B, bc: (b: B) => C): C;
export function pipe<A, B, C, D>(
  a: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D,
): D;
export function pipe(a: unknown, ...fns: Function[]): unknown {
  return fns.reduce((acc, fn) => fn(acc), a);
}

export function flow<A, B>(ab: (a: A) => B): (a: A) => B;
export function flow<A, B, C>(
  ab: (a: A) => B, bc: (b: B) => C,
): (a: A) => C;
export function flow(... fns: Function[]): Function {
  return (a: unknown) => fns.reduce((acc, fn) => fn(acc), a);
}
```

**Where to use**: Sync transforms ONLY. Chaining validation steps, composing pure functions. For async operations, use regular `async/await`.

### 4.3 Discriminated Unions

Every domain type that can be "one of several things" uses a discriminated union with a `_tag` field and exhaustive `switch`:

```typescript
// Domain events
type RunEvent =
  | { readonly _tag: "RunCreated"; readonly runId: RunId; readonly taskId: TaskId; readonly payload: unknown }
  | { readonly _tag: "RunQueued"; readonly runId: RunId; readonly queueId: QueueId }
  | { readonly _tag: "RunDequeued"; readonly runId: RunId; readonly workerId: string }
  | { readonly _tag: "RunStarted"; readonly runId: RunId }
  | { readonly _tag: "RunCompleted"; readonly runId: RunId; readonly output: unknown }
  | { readonly _tag: "RunFailed"; readonly runId: RunId; readonly error: RunError; readonly failureType: FailureType }
  | { readonly _tag: "RunRetrying"; readonly runId: RunId; readonly attempt: number; readonly delayMs: number }
  | { readonly _tag: "RunSuspended"; readonly runId: RunId; readonly waitpointId: string }
  | { readonly _tag: "RunResumed"; readonly runId: RunId }
  | { readonly _tag: "RunCancelled"; readonly runId: RunId; readonly reason: string }
  | { readonly _tag: "RunExpired"; readonly runId: RunId };

// Domain errors
type TransitionError =
  | { readonly _tag: "InvalidTransition"; readonly from: RunStatus; readonly to: RunStatus }
  | { readonly _tag: "RunNotFound"; readonly runId: RunId }
  | { readonly _tag: "VersionConflict"; readonly expected: number; readonly actual: number }
  | { readonly _tag: "QueuePaused"; readonly queueId: QueueId }
  | { readonly _tag: "ConcurrencyExceeded"; readonly queueId: QueueId; readonly limit: number };

// Failure types (not separate states — metadata on FAILED)
type FailureType = "TASK_ERROR" | "SYSTEM_ERROR" | "TIMEOUT";

// Exhaustive handler
function handleEvent(event: RunEvent): void {
  switch (event._tag) {
    case "RunCreated": /* ... */ break;
    case "RunQueued": /* ... */ break;
    case "RunDequeued": /* ... */ break;
    case "RunStarted": /* ... */ break;
    case "RunCompleted": /* ... */ break;
    case "RunFailed": /* ... */ break;
    case "RunRetrying": /* ... */ break;
    case "RunSuspended": /* ... */ break;
    case "RunResumed": /* ... */ break;
    case "RunCancelled": /* ... */ break;
    case "RunExpired": /* ... */ break;
    // TypeScript will error if you miss a case (with --strict + noUncheckedIndexedAccess)
    default: {
      const _exhaustive: never = event;
      throw new Error(`Unhandled event: ${_exhaustive}`);
    }
  }
}
```

**Where to use**: ALL domain types. Events, errors, commands, states. The `never` trick in the `default` branch ensures you update every switch when adding new variants.

### 4.4 Currying for Dependency Injection

One level only. Used to inject config/connections into pure-ish functions:

```typescript
// One level of currying for DI
const createRetryCalculator = (config: RetryConfig) =>
  (attempt: number): number => {
    const exponential = config.minTimeout * Math.pow(config.factor, attempt);
    const clamped = Math.min(exponential, config.maxTimeout);
    const jitter = clamped * (0.75 + Math.random() * 0.5);
    return Math.round(jitter);
  };

// Usage
const calculateBackoff = createRetryCalculator({
  minTimeout: 1000,
  maxTimeout: 60_000,
  factor: 2,
});
const delay = calculateBackoff(3); // 8000ms +/- jitter
```

### 4.5 Immutability

All domain types are `Readonly`. State updates use spread-based copies. Database rows use a `version` field for optimistic locking:

```typescript
// All domain types are readonly
type Run = Readonly<{
  id: RunId;
  taskId: TaskId;
  queueId: QueueId;
  status: RunStatus;
  version: number;
  payload: unknown;
  output: unknown | null;
  error: RunError | null;
  failureType: FailureType | null;
  attemptNumber: number;
  maxAttempts: number;
  // ... etc
}>;

// State updates create new objects
const completeRun = (run: Run, output: unknown): Run => ({
  ...run,
  status: "COMPLETED" as const,
  output,
  version: run.version + 1,
});
```

### 4.6 Typed Event Bus

Custom pub/sub with typed channels. No EventEmitter (which is untyped and uses string keys):

```typescript
// packages/core/src/event-bus.ts

type EventMap = {
  "run.created": RunEvent & { _tag: "RunCreated" };
  "run.queued": RunEvent & { _tag: "RunQueued" };
  "run.completed": RunEvent & { _tag: "RunCompleted" };
  "run.failed": RunEvent & { _tag: "RunFailed" };
  // ... all event types
};

type EventHandler<K extends keyof EventMap> = (event: EventMap[K]) => Promise<void>;

export function createEventBus() {
  const handlers = new Map<string, Set<Function>>();

  return {
    on<K extends keyof EventMap>(channel: K, handler: EventHandler<K>): () => void {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel)!.add(handler);
      return () => handlers.get(channel)!.delete(handler); // unsubscribe
    },

    async emit<K extends keyof EventMap>(channel: K, event: EventMap[K]): Promise<void> {
      const channelHandlers = handlers.get(channel);
      if (!channelHandlers) return;
      await Promise.all([...channelHandlers].map((h) => h(event)));
    },
  };
}
```

### 4.7 Summary Table: FP Pattern Locations

| Pattern | Where Used | NOT Used For |
|---------|-----------|--------------|
| `Result<T, E>` | State transitions, validation, queue ops | I/O (database, HTTP) — those throw |
| `pipe/flow` | Sync transforms, validation chains | Async operations — use await |
| Discriminated unions | Events, errors, commands, states | Simple data (payload, config) |
| Currying (1 level) | Dependency injection of config/connections | Deep nesting (no `f(a)(b)(c)(d)`) |
| `Readonly<T>` + spread | All domain types, all state updates | Database row objects from Drizzle (they're mutable by nature) |
| Typed event bus | Engine-internal pub/sub, cross-module communication | External HTTP webhooks |
| DrainableQueue | Testing deterministic async | Production (use real PG/Redis) |

---

## 5. Patterns from T3 Code

These patterns are adopted from Trigger.dev's codebase (referred to as "T3 Code") because they solve real problems well.

### 5.1 Branded ID Types

Prevents mixing up string IDs across different entity types at the type level:

```typescript
// packages/core/src/ids.ts
import { z } from "zod";

// Branded types via Zod
export const RunId = z.string().uuid().brand<"RunId">();
export type RunId = z.infer<typeof RunId>;

export const TaskId = z.string().min(1).brand<"TaskId">();
export type TaskId = z.infer<typeof TaskId>;

export const QueueId = z.string().min(1).brand<"QueueId">();
export type QueueId = z.infer<typeof QueueId>;

export const WorkerId = z.string().min(1).brand<"WorkerId">();
export type WorkerId = z.infer<typeof WorkerId>;

// Parse raw strings into branded IDs
export const parseRunId = (raw: string): RunId => RunId.parse(raw);

// This will NOT compile:
// function getRun(id: RunId): Run { ... }
// getRun(someTaskId); // Type error! TaskId is not RunId
```

### 5.2 Contracts Package (Shared Zod Schemas)

The `core` package exports Zod schemas that serve as contracts between server and worker. Zero business logic in `core` — just types and validation:

```typescript
// packages/core/src/schemas.ts
import { z } from "zod";
import { RunId, TaskId, QueueId } from "./ids";

export const TriggerRequestSchema = z.object({
  taskId: TaskId,
  payload: z.unknown(),
  options: z.object({
    idempotencyKey: z.string().optional(),
    concurrencyKey: z.string().optional(),
    priority: z.number().int().min(0).max(100).default(0),
    ttl: z.number().int().positive().optional(),
    scheduledFor: z.string().datetime().optional(),
    maxAttempts: z.number().int().min(1).max(100).default(3),
  }).optional(),
});

export const DequeueResponseSchema = z.object({
  runId: RunId,
  taskId: TaskId,
  payload: z.unknown(),
  attemptNumber: z.number(),
});

export const CompleteRequestSchema = z.object({
  runId: RunId,
  output: z.unknown(),
});

export const FailRequestSchema = z.object({
  runId: RunId,
  error: z.object({
    message: z.string(),
    stack: z.string().optional(),
    name: z.string().optional(),
  }),
  failureType: z.enum(["TASK_ERROR", "SYSTEM_ERROR", "TIMEOUT"]),
});
```

### 5.3 DrainableQueue for Testing

A queue that lets tests control exactly when items are processed — deterministic async:

```typescript
// packages/core/src/drainable-queue.ts

export class DrainableQueue<T> {
  private queue: T[] = [];
  private resolvers: ((value: T) => void)[] = [];

  push(item: T): void {
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver(item);
    } else {
      this.queue.push(item);
    }
  }

  pull(): Promise<T> {
    const item = this.queue.shift();
    if (item !== undefined) {
      return Promise.resolve(item);
    }
    return new Promise<T>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  drain(): T[] {
    const items = [...this.queue];
    this.queue = [];
    return items;
  }

  get length(): number {
    return this.queue.length;
  }
}

// Usage in tests:
const queue = new DrainableQueue<RunEvent>();
engine.onEvent((event) => queue.push(event));

await engine.trigger("my-task", { data: 1 });
const event = await queue.pull(); // deterministic — no timing issues
expect(event._tag).toBe("RunCreated");
```

### 5.4 Subpath Exports

Packages export specific modules, not barrel files. This keeps imports explicit and tree-shakeable:

```json
// packages/core/package.json
{
  "name": "@reload/core",
  "exports": {
    "./ids": "./dist/ids.js",
    "./types": "./dist/types.js",
    "./schemas": "./dist/schemas.js",
    "./result": "./dist/result.js",
    "./pipe": "./dist/pipe.js",
    "./event-bus": "./dist/event-bus.js",
    "./states": "./dist/states.js"
  }
}
```

```typescript
// Consumers import specific modules
import { RunId, TaskId } from "@reload/core/ids";
import { ok, err, isOk } from "@reload/core/result";
import { pipe } from "@reload/core/pipe";
import { TriggerRequestSchema } from "@reload/core/schemas";
```

### 5.5 Reactor Pattern

The engine uses a typed event bus (see Section 4.6) to decouple side effects from state transitions. When a transition happens, the pure function returns the new state + a list of side effects. The imperative shell executes the side effects and emits events:

```typescript
// Pure: returns what SHOULD happen
type SideEffect =
  | { _tag: "EnqueueRun"; runId: RunId; queueId: QueueId; priority: number }
  | { _tag: "ScheduleRetry"; runId: RunId; delayMs: number }
  | { _tag: "NotifyParent"; parentRunId: RunId; childOutput: unknown }
  | { _tag: "EmitEvent"; event: RunEvent }
  | { _tag: "CancelHeartbeat"; runId: RunId }
  | { _tag: "StartHeartbeat"; runId: RunId; workerId: WorkerId };

type TransitionResult = Result<
  { readonly run: Run; readonly effects: readonly SideEffect[] },
  TransitionError
>;

// Imperative: executes what the pure function decided
async function executeSideEffects(effects: readonly SideEffect[]): Promise<void> {
  for (const effect of effects) {
    switch (effect._tag) {
      case "EnqueueRun":
        await queue.enqueue(effect.runId, effect.queueId, effect.priority);
        break;
      case "ScheduleRetry":
        await scheduler.schedule(effect.runId, effect.delayMs);
        break;
      case "NotifyParent":
        await waitpoints.resolveChildRun(effect.parentRunId, effect.childOutput);
        break;
      case "EmitEvent":
        await eventBus.emit(effect.event._tag.replace("Run", "run.").toLowerCase(), effect.event);
        break;
      // ... etc
    }
  }
}
```

---

## 6. Database Schema

### Core Tables

```typescript
// packages/server/src/db/schema.ts
import {
  pgTable, text, timestamp, integer, jsonb,
  pgEnum, uuid, boolean, index, uniqueIndex, serial,
} from "drizzle-orm/pg-core";

// === ENUMS ===

export const runStatusEnum = pgEnum("run_status", [
  "PENDING",     // Created, not yet queued
  "QUEUED",      // In the queue, waiting for a worker
  "DELAYED",     // Waiting for a scheduled time (future run or retry backoff)
  "EXECUTING",   // Worker is running the task
  "SUSPENDED",   // Paused — waiting for child/duration/token
  "COMPLETED",   // Finished successfully (terminal)
  "FAILED",      // Failed after all retries exhausted (terminal)
  "CANCELLED",   // Manually cancelled (terminal)
  "EXPIRED",     // TTL exceeded while queued (terminal)
]);

export const failureTypeEnum = pgEnum("failure_type", [
  "TASK_ERROR",   // The task code threw an error
  "SYSTEM_ERROR", // Infrastructure failure (OOM, network, etc.)
  "TIMEOUT",      // Heartbeat or execution timeout
]);

export const waitpointTypeEnum = pgEnum("waitpoint_type", [
  "CHILD_RUN",  // Waiting for a child task to complete
  "DURATION",   // Waiting for a time duration
  "DATETIME",   // Waiting until a specific datetime
  "TOKEN",      // Waiting for external input (human-in-the-loop)
]);

// === TABLES ===

export const queues = pgTable("queues", {
  id: text("id").primaryKey(),                        // e.g. "default", "email-queue"
  concurrencyLimit: integer("concurrency_limit").default(10),
  paused: boolean("paused").default(false),
  rateLimit: jsonb("rate_limit"),                     // { limit: number, window: "second"|"minute" }
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),                        // e.g. "send-email"
  queueId: text("queue_id").notNull().references(() => queues.id),
  retryConfig: jsonb("retry_config").$type<{
    maxAttempts: number;
    minTimeout: number;
    maxTimeout: number;
    factor: number;
  }>(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const runs = pgTable("runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id),
  queueId: text("queue_id").notNull().references(() => queues.id),
  status: runStatusEnum("status").notNull().default("PENDING"),
  version: integer("version").notNull().default(1),    // Optimistic locking

  // Data
  payload: jsonb("payload"),
  output: jsonb("output"),
  error: jsonb("error"),
  failureType: failureTypeEnum("failure_type"),

  // Scheduling
  scheduledFor: timestamp("scheduled_for"),             // When to execute (for delayed/retry)
  ttl: integer("ttl"),                                  // Seconds before expiry
  priority: integer("priority").default(0),             // 0 = normal, higher = more important

  // Idempotency
  idempotencyKey: text("idempotency_key"),

  // Concurrency
  concurrencyKey: text("concurrency_key"),

  // Retry
  attemptNumber: integer("attempt_number").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),

  // Relationships
  parentRunId: uuid("parent_run_id").references(() => runs.id),

  // Worker tracking
  workerId: text("worker_id"),
  heartbeatDeadline: timestamp("heartbeat_deadline"),
  dequeuedAt: timestamp("dequeued_at"),                 // When worker received it (DEQUEUED concept)

  // Metadata
  tags: jsonb("tags").$type<string[]>(),
  metadata: jsonb("metadata"),

  // Timestamps
  createdAt: timestamp("created_at").defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
}, (table) => ({
  // Critical indexes
  statusQueueIdx: index("idx_runs_status_queue").on(table.queueId, table.status),
  scheduledForIdx: index("idx_runs_scheduled_for").on(table.scheduledFor).where(
    sql`status = 'DELAYED'`
  ),
  idempotencyIdx: uniqueIndex("idx_runs_idempotency").on(table.idempotencyKey),
  parentRunIdx: index("idx_runs_parent").on(table.parentRunId),
  heartbeatIdx: index("idx_runs_heartbeat").on(table.heartbeatDeadline).where(
    sql`status = 'EXECUTING'`
  ),
}));

// Append-only event log — every state change is recorded here
export const runEvents = pgTable("run_events", {
  id: serial("id").primaryKey(),                        // Auto-increment for ordering
  runId: uuid("run_id").notNull().references(() => runs.id),
  fromStatus: runStatusEnum("from_status"),             // null for creation
  toStatus: runStatusEnum("to_status").notNull(),
  reason: text("reason"),                               // Human-readable reason
  data: jsonb("data"),                                  // Event-specific data
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  runIdIdx: index("idx_run_events_run_id").on(table.runId),
}));

// Cached step results for resumption
export const runSteps = pgTable("run_steps", {
  id: serial("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id),
  stepIndex: integer("step_index").notNull(),           // Positional: 0, 1, 2, ...
  stepKey: text("step_key").notNull(),                  // e.g. "triggerAndWait:child-task"
  result: jsonb("result"),                              // Cached output
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  runStepIdx: uniqueIndex("idx_run_steps_run_step").on(table.runId, table.stepIndex),
}));

// Waitpoints
export const waitpoints = pgTable("waitpoints", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: waitpointTypeEnum("type").notNull(),
  runId: uuid("run_id").notNull().references(() => runs.id),
  resolved: boolean("resolved").notNull().default(false),
  resolvedAt: timestamp("resolved_at"),
  result: jsonb("result"),

  // DURATION / DATETIME
  resumeAfter: timestamp("resume_after"),

  // CHILD_RUN
  childRunId: uuid("child_run_id").references(() => runs.id),

  // TOKEN
  token: text("token"),
  expiresAt: timestamp("expires_at"),

  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  tokenIdx: uniqueIndex("idx_waitpoints_token").on(table.token),
  childRunIdx: index("idx_waitpoints_child_run").on(table.childRunId),
  resumeAfterIdx: index("idx_waitpoints_resume_after").on(table.resumeAfter).where(
    sql`resolved = false`
  ),
}));

// Worker registry
export const workers = pgTable("workers", {
  id: text("id").primaryKey(),                          // Worker-generated UUID
  taskTypes: jsonb("task_types").$type<string[]>(),     // Which tasks this worker handles
  lastHeartbeat: timestamp("last_heartbeat").defaultNow(),
  status: text("status").notNull().default("active"),   // active, draining, offline
  createdAt: timestamp("created_at").defaultNow(),
});
```

### Key Schema Decisions

1. **`version` instead of `currentSnapshotId`**: Simpler optimistic locking. Increment on every write, reject if version doesn't match.
2. **`failureType` on runs**: Not a separate state. A FAILED run can be TASK_ERROR, SYSTEM_ERROR, or TIMEOUT. This affects retry decisions.
3. **`run_events` table**: Append-only audit log. Every transition is recorded with from/to status and a reason. This replaces `execution_snapshots` from the original plan.
4. **`run_steps` table**: Positional step cache for resumption. Step 0, Step 1, Step 2, etc.
5. **`workers` table**: Workers register what task types they support. The dequeue endpoint filters by this.
6. **`dequeuedAt` on runs**: Captures the DEQUEUED concept (sent to worker but not yet executing) as a timestamp rather than a state.
7. **Composite index on `(queueId, status)`**: Critical for SKIP LOCKED dequeue performance.
8. **Partial index on `scheduledFor` WHERE status = 'DELAYED'**: Only indexes delayed runs, not all runs.

---

## 7. State Machine

### 7.1 States

| State | Terminal? | Description |
|-------|-----------|-------------|
| `PENDING` | No | Just created. Not yet in any queue. |
| `QUEUED` | No | In the queue, waiting for a worker to pick it up. |
| `DELAYED` | No | Waiting for a future time. Either initially scheduled or waiting for retry backoff. |
| `EXECUTING` | No | A worker is actively running the task code. |
| `SUSPENDED` | No | Paused. Waiting for a child task, duration, or external token. |
| `COMPLETED` | Yes | Finished successfully. |
| `FAILED` | Yes | Failed after all retry attempts exhausted. |
| `CANCELLED` | Yes | Manually cancelled by a user or the system. |
| `EXPIRED` | Yes | TTL exceeded while the run was queued. |

### 7.2 Transition Diagram

```
                         ┌──────────────────────────────────┐
                         │                                  │
                         v                                  │
  ┌─────────┐    ┌─────────┐    ┌───────────┐    ┌─────────────┐
  │ PENDING │───>│ QUEUED  │───>│ EXECUTING │───>│  COMPLETED  │
  └─────────┘    └─────────┘    └───────────┘    └─────────────┘
       │              │              │  │
       │              │              │  │         ┌─────────────┐
       │              │              │  └────────>│  SUSPENDED  │
       │              │              │            └──────┬──────┘
       │              │              │                   │
       │              │              v                   │
       │              │         ┌─────────┐             │
       │              │         │(attempt │             │
       │              │         │ < max?) │             │
       │              │         └────┬────┘             │
       │              │              │                   │
       │              │         yes  │  no               │
       │              │              │   │               │
       │              │              v   v               │
       │   ┌──────────┤    ┌─────────┐  ┌────────┐     │
       │   │          │    │ DELAYED │  │ FAILED │     │
       │   │          │    │(backoff)│  └────────┘     │
       │   │          │    └────┬────┘                  │
       │   │          │         │ (backoff expires)     │
       │   │          │         └───────────────────────┘
       │   │          │                  ↑               │
       │   │          │                  │               │
       │   │   ┌──────┘     SUSPENDED───>QUEUED──────────┘
       │   │   │             (waitpoint    (then re-
       │   │   │              resolved)     executed)
       v   v   v
  ┌───────────┐    ┌─────────┐
  │ CANCELLED │    │ EXPIRED │
  └───────────┘    └─────────┘
```

### 7.3 Transition Table (Definitive)

```
PENDING   -> QUEUED       (immediate execution)
PENDING   -> DELAYED      (future-scheduled: scheduledFor is set)
PENDING   -> CANCELLED    (cancelled before queuing)

QUEUED    -> EXECUTING    (worker dequeues and starts)
QUEUED    -> EXPIRED      (TTL exceeded while waiting)
QUEUED    -> CANCELLED    (cancelled while queued)

DELAYED   -> QUEUED       (scheduled time reached / backoff expired)
DELAYED   -> CANCELLED    (cancelled while delayed)

EXECUTING -> COMPLETED    (task finished successfully)
EXECUTING -> FAILED       (task threw + retries exhausted -- OR -- retryable failure triggers DELAYED)
EXECUTING -> SUSPENDED    (task hit a waitpoint)
EXECUTING -> CANCELLED    (cancelled during execution)

SUSPENDED -> QUEUED       (waitpoint resolved -- goes through queue again, NOT direct to EXECUTING)
SUSPENDED -> CANCELLED    (cancelled while suspended)

FAILED    -> (terminal)   (no outgoing transitions -- retries go EXECUTING -> DELAYED -> QUEUED)

COMPLETED -> (terminal)
CANCELLED -> (terminal)
EXPIRED   -> (terminal)
```

### 7.4 Key Corrections from Original Plan

1. **SUSPENDED -> QUEUED, not SUSPENDED -> EXECUTING**: When a waitpoint resolves, the run goes back through the queue. It needs a worker assigned. Going direct to EXECUTING would skip queue fairness and concurrency checks.

2. **Retry path is EXECUTING -> DELAYED -> QUEUED**: When a task fails but has retries left, it goes to DELAYED (with `scheduledFor` = now + backoff). A scheduler picks it up when the backoff expires and moves it to QUEUED. This is NOT `FAILED -> QUEUED` — FAILED is terminal.

3. **PENDING -> DELAYED for future-scheduled runs**: If you trigger a run with `scheduledFor` in the future, it goes directly to DELAYED, not QUEUED.

4. **No QUEUED -> DELAYED transition**: A run in QUEUED is ready to execute now. If it needs to wait, that happened before it entered QUEUED.

5. **`failureType` is metadata, not a state**: TASK_ERROR, SYSTEM_ERROR, and TIMEOUT are stored on the `failureType` field when the run reaches FAILED. This affects whether the system recommends retry.

### 7.5 Pure State Machine Implementation

```typescript
// packages/engine/src/state-machine.ts
import type { Run, RunStatus, TransitionError, SideEffect } from "@reload/core/types";
import type { Result } from "@reload/core/result";
import { ok, err } from "@reload/core/result";

// The transition map — defines what transitions are legal
const TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  PENDING:   ["QUEUED", "DELAYED", "CANCELLED"],
  QUEUED:    ["EXECUTING", "EXPIRED", "CANCELLED"],
  DELAYED:   ["QUEUED", "CANCELLED"],
  EXECUTING: ["COMPLETED", "FAILED", "DELAYED", "SUSPENDED", "CANCELLED"],
  SUSPENDED: ["QUEUED", "CANCELLED"],
  COMPLETED: [],
  FAILED:    [],
  CANCELLED: [],
  EXPIRED:   [],
} as const;

// Pure function: validates + computes the transition
export function computeTransition(
  run: Readonly<Run>,
  to: RunStatus,
  context: TransitionContext,
): Result<{ run: Run; effects: SideEffect[] }, TransitionError> {
  // Guard: is this transition legal?
  const allowed = TRANSITIONS[run.status];
  if (!allowed.includes(to)) {
    return err({
      _tag: "InvalidTransition",
      from: run.status,
      to,
    });
  }

  // Compute the new run state + side effects
  switch (to) {
    case "QUEUED": {
      const newRun: Run = {
        ...run,
        status: "QUEUED",
        version: run.version + 1,
      };
      return ok({
        run: newRun,
        effects: [
          { _tag: "EnqueueRun", runId: run.id, queueId: run.queueId, priority: run.priority },
          { _tag: "EmitEvent", event: { _tag: "RunQueued", runId: run.id, queueId: run.queueId } },
        ],
      });
    }

    case "EXECUTING": {
      const newRun: Run = {
        ...run,
        status: "EXECUTING",
        version: run.version + 1,
        startedAt: context.now,
        workerId: context.workerId ?? run.workerId,
        dequeuedAt: context.now,
      };
      return ok({
        run: newRun,
        effects: [
          { _tag: "StartHeartbeat", runId: run.id, workerId: context.workerId! },
          { _tag: "EmitEvent", event: { _tag: "RunStarted", runId: run.id } },
        ],
      });
    }

    case "COMPLETED": {
      const newRun: Run = {
        ...run,
        status: "COMPLETED",
        version: run.version + 1,
        output: context.output,
        completedAt: context.now,
      };
      const effects: SideEffect[] = [
        { _tag: "CancelHeartbeat", runId: run.id },
        { _tag: "ReleaseConcurrency", runId: run.id, queueId: run.queueId },
        { _tag: "EmitEvent", event: { _tag: "RunCompleted", runId: run.id, output: context.output } },
      ];
      if (run.parentRunId) {
        effects.push({ _tag: "NotifyParent", parentRunId: run.parentRunId, childOutput: context.output });
      }
      return ok({ run: newRun, effects });
    }

    case "DELAYED": {
      const newRun: Run = {
        ...run,
        status: "DELAYED",
        version: run.version + 1,
        scheduledFor: context.scheduledFor,
        attemptNumber: context.nextAttempt ?? run.attemptNumber,
      };
      const effects: SideEffect[] = [
        { _tag: "CancelHeartbeat", runId: run.id },
        { _tag: "ReleaseConcurrency", runId: run.id, queueId: run.queueId },
        { _tag: "EmitEvent", event: {
          _tag: "RunRetrying",
          runId: run.id,
          attempt: newRun.attemptNumber,
          delayMs: context.scheduledFor!.getTime() - context.now.getTime(),
        }},
      ];
      return ok({ run: newRun, effects });
    }

    case "FAILED": {
      const newRun: Run = {
        ...run,
        status: "FAILED",
        version: run.version + 1,
        error: context.error,
        failureType: context.failureType ?? "TASK_ERROR",
        completedAt: context.now,
      };
      const effects: SideEffect[] = [
        { _tag: "CancelHeartbeat", runId: run.id },
        { _tag: "ReleaseConcurrency", runId: run.id, queueId: run.queueId },
        { _tag: "EmitEvent", event: {
          _tag: "RunFailed", runId: run.id,
          error: context.error!, failureType: newRun.failureType!,
        }},
      ];
      return ok({ run: newRun, effects });
    }

    case "SUSPENDED": {
      const newRun: Run = {
        ...run,
        status: "SUSPENDED",
        version: run.version + 1,
      };
      return ok({
        run: newRun,
        effects: [
          { _tag: "CancelHeartbeat", runId: run.id },
          { _tag: "ReleaseConcurrency", runId: run.id, queueId: run.queueId },
          { _tag: "EmitEvent", event: {
            _tag: "RunSuspended", runId: run.id,
            waitpointId: context.waitpointId!,
          }},
        ],
      });
    }

    case "CANCELLED": {
      const newRun: Run = {
        ...run,
        status: "CANCELLED",
        version: run.version + 1,
        completedAt: context.now,
      };
      return ok({
        run: newRun,
        effects: [
          { _tag: "CancelHeartbeat", runId: run.id },
          { _tag: "ReleaseConcurrency", runId: run.id, queueId: run.queueId },
          { _tag: "EmitEvent", event: { _tag: "RunCancelled", runId: run.id, reason: context.reason ?? "manual" } },
        ],
      });
    }

    case "EXPIRED": {
      const newRun: Run = {
        ...run,
        status: "EXPIRED",
        version: run.version + 1,
        completedAt: context.now,
      };
      return ok({
        run: newRun,
        effects: [
          { _tag: "EmitEvent", event: { _tag: "RunExpired", runId: run.id } },
        ],
      });
    }

    default: {
      const _exhaustive: never = to;
      return err({ _tag: "InvalidTransition", from: run.status, to });
    }
  }
}
```

**Why this design matters**: The state machine is a PURE FUNCTION. It takes a run and a desired target state, and returns a Result containing the new run state plus a list of side effects. It never touches a database, never calls Redis, never makes HTTP requests. This makes it trivially testable — you just pass in runs and assert on the output.

---

## 8. How Resumption Works

### The Problem

When a task calls `triggerAndWait()` or `wait.for()`, the task function needs to pause. But Node.js cannot snapshot a running function's stack and restore it later (that would require CRIU or similar OS-level checkpointing). So we use **step-based replay**.

### The Mechanism

1. Every "suspendable" operation (triggerAndWait, wait.for, wait.forToken) is assigned a **positional step index**: step-0, step-1, step-2, etc.

2. When a suspendable operation completes, its result is **cached** in the `run_steps` table.

3. When a run is **resumed** (waitpoint resolved), the task function is **re-executed from the beginning**.

4. During replay, the step runner checks: "Has step N already been completed?" If yes, return the cached result instantly. If no, this is the new step — execute it for real (which may suspend again).

### Implementation

```typescript
// packages/engine/src/resumption/step-runner.ts

class SuspendExecution {
  constructor(
    public readonly stepIndex: number,
    public readonly stepKey: string,
    public readonly waitpointType: string,
    public readonly waitpointData: unknown,
  ) {}
}

type StepContext = {
  triggerAndWait: (taskId: string, payload: unknown) => Promise<unknown>;
  waitFor: (duration: { seconds: number }) => Promise<void>;
  waitForToken: (opts: { timeout?: string }) => Promise<unknown>;
};

async function executeWithResumption(
  run: Run,
  taskFn: (payload: unknown, ctx: StepContext) => Promise<unknown>,
): Promise<{ output: unknown } | { suspended: true }> {
  // Load previously completed steps
  const completedSteps = await db.select()
    .from(runSteps)
    .where(eq(runSteps.runId, run.id))
    .orderBy(runSteps.stepIndex);

  let currentStepIndex = 0;

  const ctx: StepContext = {
    triggerAndWait: async (taskId: string, payload: unknown) => {
      const myIndex = currentStepIndex++;
      const expectedKey = `triggerAndWait:${taskId}`;

      // Check for cached result
      const cached = completedSteps.find((s) => s.stepIndex === myIndex);
      if (cached) {
        // Non-determinism detection: the step key should match
        if (cached.stepKey !== expectedKey) {
          throw new Error(
            `Non-determinism detected at step ${myIndex}: ` +
            `expected "${cached.stepKey}", got "${expectedKey}". ` +
            `The task function must be deterministic during replay.`
          );
        }
        return cached.result; // Return cached result, skip execution
      }

      // Not cached — this is a new step. Suspend.
      throw new SuspendExecution(myIndex, expectedKey, "CHILD_RUN", { taskId, payload });
    },

    waitFor: async (duration: { seconds: number }) => {
      const myIndex = currentStepIndex++;
      const expectedKey = `wait:${duration.seconds}s`;

      const cached = completedSteps.find((s) => s.stepIndex === myIndex);
      if (cached) {
        if (cached.stepKey !== expectedKey) {
          throw new Error(`Non-determinism detected at step ${myIndex}`);
        }
        return; // Already waited
      }

      throw new SuspendExecution(myIndex, expectedKey, "DURATION", duration);
    },

    waitForToken: async (opts: { timeout?: string }) => {
      const myIndex = currentStepIndex++;
      const expectedKey = `token:${myIndex}`;

      const cached = completedSteps.find((s) => s.stepIndex === myIndex);
      if (cached) {
        return cached.result;
      }

      throw new SuspendExecution(myIndex, expectedKey, "TOKEN", opts);
    },
  };

  try {
    const output = await taskFn(run.payload, ctx);
    return { output }; // Task completed successfully
  } catch (e) {
    if (e instanceof SuspendExecution) {
      // Save the step index so we know where we are
      // Create the appropriate waitpoint
      // Transition run to SUSPENDED
      await handleSuspension(run, e);
      return { suspended: true };
    }
    throw e; // Real error — let retry logic handle it
  }
}
```

### Example: What Replay Looks Like

```typescript
// This task has two suspendable steps
export const parentTask = task({
  id: "parent-task",
  run: async (payload, ctx) => {
    // Step 0: trigger child and wait
    const childResult = await ctx.triggerAndWait("child-task", { data: "hello" });

    // Step 1: wait 10 seconds
    await ctx.waitFor({ seconds: 10 });

    // Step 2: trigger another child
    const otherResult = await ctx.triggerAndWait("other-task", { childResult });

    return { childResult, otherResult };
  },
});
```

**First execution**: Step 0 runs, hits `triggerAndWait`, throws `SuspendExecution`. Run is SUSPENDED.

**Second execution** (child completes): Step 0 returns cached result instantly. Step 1 runs, hits `waitFor`, throws `SuspendExecution`. Run is SUSPENDED again.

**Third execution** (duration expires): Step 0 returns cached. Step 1 returns cached. Step 2 runs, hits `triggerAndWait`, throws `SuspendExecution`. Run is SUSPENDED again.

**Fourth execution** (second child completes): Steps 0, 1, 2 all return cached. Task function returns final result. Run is COMPLETED.

### Mitigations

**SuspendExecution catch-swallowing**: If user code wraps a suspendable call in try/catch, it could swallow the SuspendExecution error. Mitigation: document that suspendable calls must not be caught, or use a Symbol-based sentinel that is harder to accidentally catch.

**Non-determinism**: If the task function uses `Math.random()` or `Date.now()` to decide which steps to call, replay will diverge. The step key mismatch detection catches this and throws a clear error.

---

## ⚠️ GOLDEN RULE: LEARN BEFORE YOU BUILD ⚠️

**BEFORE IMPLEMENTING ANY PHASE, YOU MUST COMPLETE THE LEARNING STEP FIRST.**

This is NOT a "write code and ship" project. This is a "understand deeply, then build to prove understanding" project. For EVERY phase:

1. **CREATE A LEARNING DOCUMENT** (`docs/phase-N-concepts.md`) that covers:
   - Every concept used in that phase, explained in depth (not surface-level)
   - WHY each concept exists — what problem does it solve?
   - HOW it works under the hood — not just the API, but the internals
   - Real-world resources: blog posts, papers, source code to read
   - Questions to test your understanding before you start coding
   - How Trigger.dev / other production systems use this concept

2. **READ AND UNDERSTAND** the learning document fully. Ask questions. Discuss concepts. Make sure you can explain each concept to someone else.

3. **ONLY THEN** start implementing the phase.

The learning document is NOT optional. It IS the point. The code is just proof that you understood.

---

## Phase 1: Foundation
### Goal: Trigger -> Queue (PG SKIP LOCKED) -> Execute -> Complete

### Concepts to Learn First
- PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED` — how database-level queuing works
- Hono framework — routing, middleware, context
- Drizzle ORM — schema definition, migrations, queries
- pnpm workspaces + Turborepo — monorepo setup
- Branded types with Zod — type-level safety for IDs

### What to Build

**1.1 — Monorepo skeleton**

Set up the full monorepo structure. All packages exist but most are empty stubs. Get builds working with tsdown and turborepo. Get linting working with oxlint.

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
  - "tasks"
```

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16
    ports: ["5432:5432"]
    environment:
      POSTGRES_DB: reload
      POSTGRES_PASSWORD: reload
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
```

No Redis yet. Phase 1 is Postgres-only.

**1.2 — Core package: Result type, branded IDs, schemas**

Build the hand-rolled utilities from Section 4. This is the foundation everything else imports.

**1.3 — Database schema (tables: queues, tasks, runs)**

Only these three tables for Phase 1. No run_events, no run_steps, no waitpoints. Run the first migration.

**1.4 — PG SKIP LOCKED queue**

This is the critical learning piece of Phase 1. Instead of Redis, you use Postgres itself as the queue:

```typescript
// packages/engine/src/queue/pg-queue.ts
import { eq, and, asc, sql } from "drizzle-orm";

export function createPgQueue(db: DrizzleDB) {
  return {
    // Enqueue: just set the run status to QUEUED
    // The run IS the queue entry — no separate queue table needed
    async enqueue(runId: string): Promise<void> {
      await db.update(runs)
        .set({ status: "QUEUED" })
        .where(eq(runs.id, runId));
    },

    // Dequeue: SELECT FOR UPDATE SKIP LOCKED
    // This is the magic — it atomically claims a row, skipping locked ones
    async dequeue(queueId: string, limit: number = 1): Promise<Run[]> {
      const result = await db.execute(sql`
        UPDATE runs
        SET status = 'EXECUTING',
            started_at = NOW(),
            version = version + 1
        WHERE id IN (
          SELECT id FROM runs
          WHERE queue_id = ${queueId}
            AND status = 'QUEUED'
            AND (scheduled_for IS NULL OR scheduled_for <= NOW())
          ORDER BY
            priority DESC,
            created_at ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `);
      return result.rows as Run[];
    },
  };
}
```

**Why SKIP LOCKED**: When multiple workers try to dequeue simultaneously, `FOR UPDATE` locks the selected rows. `SKIP LOCKED` tells other workers to skip already-locked rows instead of waiting. This gives you concurrent dequeuing from a single Postgres table with no external dependencies.

**Why this teaches you something**: You will feel the limitations of PG-as-queue as load grows (polling overhead, connection pressure, index bloat on the status column). When you add Redis in Phase 3, you will understand exactly WHY it is better for this specific use case.

**1.5 — Hono API server**

Three endpoints:

```typescript
// POST /api/trigger
app.post("/api/trigger", async (c) => {
  const body = TriggerRequestSchema.parse(await c.req.json());

  // Idempotency check
  if (body.options?.idempotencyKey) {
    const existing = await db.select().from(runs)
      .where(eq(runs.idempotencyKey, body.options.idempotencyKey))
      .limit(1);
    if (existing.length > 0) {
      return c.json({ runId: existing[0].id, existing: true });
    }
  }

  // Create run
  const [run] = await db.insert(runs).values({
    taskId: body.taskId,
    queueId: body.options?.queueId ?? "default",
    status: body.options?.scheduledFor ? "DELAYED" : "PENDING",
    payload: body.payload,
    priority: body.options?.priority ?? 0,
    maxAttempts: body.options?.maxAttempts ?? 3,
    idempotencyKey: body.options?.idempotencyKey,
    concurrencyKey: body.options?.concurrencyKey,
    scheduledFor: body.options?.scheduledFor ? new Date(body.options.scheduledFor) : null,
    ttl: body.options?.ttl,
  }).returning();

  // If not delayed, queue immediately
  if (run.status === "PENDING") {
    await pgQueue.enqueue(run.id);
  }

  return c.json({ runId: run.id });
});

// POST /api/dequeue (worker calls this)
app.post("/api/dequeue", async (c) => {
  const { queueId, limit } = await c.req.json();
  const runs = await pgQueue.dequeue(queueId, limit);
  return c.json({ runs });
});

// POST /api/runs/:id/complete
app.post("/api/runs/:id/complete", async (c) => {
  const { output } = await c.req.json();
  await db.update(runs).set({
    status: "COMPLETED",
    output,
    completedAt: new Date(),
    version: sql`version + 1`,
  }).where(eq(runs.id, c.req.param("id")));
  return c.json({ ok: true });
});
```

**1.6 — Basic worker with dequeue loop**

```typescript
// packages/worker/src/dequeue-loop.ts

async function startDequeueLoop(config: { serverUrl: string; queueId: string; pollInterval: number }) {
  const { serverUrl, queueId, pollInterval } = config;

  while (true) {
    try {
      const response = await fetch(`${serverUrl}/api/dequeue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queueId, limit: 1 }),
      });
      const { runs } = await response.json();

      for (const run of runs) {
        await executeRun(run);
      }
    } catch (err) {
      console.error("Dequeue error:", err);
    }

    // If no work, wait before polling again
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}

async function executeRun(run: Run): Promise<void> {
  const taskFn = taskRegistry.get(run.taskId);
  if (!taskFn) {
    await reportFailure(run.id, new Error(`Unknown task: ${run.taskId}`), "SYSTEM_ERROR");
    return;
  }

  try {
    const output = await taskFn(run.payload);
    await fetch(`${config.serverUrl}/api/runs/${run.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output }),
    });
  } catch (error) {
    await reportFailure(run.id, error, "TASK_ERROR");
  }
}
```

**1.7 — SDK: task() helper and client**

```typescript
// packages/sdk/src/task.ts
type TaskDefinition<TPayload, TOutput> = {
  id: string;
  queue?: string;
  retry?: { maxAttempts?: number; minTimeout?: number; maxTimeout?: number; factor?: number };
  run: (payload: TPayload) => Promise<TOutput>;
};

export function task<TPayload, TOutput>(
  def: TaskDefinition<TPayload, TOutput>,
): TaskDefinition<TPayload, TOutput> {
  return def; // For now, just returns the definition. Registration happens at worker startup.
}

// packages/sdk/src/client.ts
export class ReloadClient {
  constructor(private baseUrl: string, private apiKey?: string) {}

  async trigger(taskId: string, payload: unknown, options?: TriggerOptions): Promise<{ runId: string }> {
    const res = await fetch(`${this.baseUrl}/api/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, payload, options }),
    });
    return res.json();
  }

  async getRun(runId: string): Promise<Run> {
    const res = await fetch(`${this.baseUrl}/api/runs/${runId}`);
    return res.json();
  }
}
```

### Phase 1 Deliverable

You can trigger a task via HTTP, it gets queued in PostgreSQL (SKIP LOCKED), a worker polls and picks it up, executes it, and reports completion. You can query run status. The monorepo builds, lints, and has type-safe branded IDs throughout.

### Phase 1 Tests

```typescript
// Basic flow test
test("trigger -> dequeue -> complete", async () => {
  const { runId } = await client.trigger("hello-world", { name: "test" });
  const run1 = await client.getRun(runId);
  expect(run1.status).toBe("QUEUED");

  const [dequeued] = await pgQueue.dequeue("default", 1);
  expect(dequeued.id).toBe(runId);
  expect(dequeued.status).toBe("EXECUTING");

  await client.complete(runId, { greeting: "Hello, test!" });
  const run2 = await client.getRun(runId);
  expect(run2.status).toBe("COMPLETED");
  expect(run2.output).toEqual({ greeting: "Hello, test!" });
});
```

---

## Phase 2: State Machine + Retries
### Goal: Proper lifecycle, automatic retries, idempotency, event log

### Concepts to Learn First
- Finite state machines: states, transitions, guards, side effects
- Exponential backoff with jitter: why jitter prevents thundering herd
- Optimistic locking basics: version fields, CAS (compare-and-swap)
- Append-only event logs: audit trail for every state change

### What to Build

**2.1 — Pure state machine (from Section 7.5)**

Implement the `computeTransition` function. Write exhaustive tests for every valid transition and every invalid transition:

```typescript
test("PENDING -> QUEUED produces EnqueueRun effect", () => {
  const run = makeRun({ status: "PENDING" });
  const result = computeTransition(run, "QUEUED", { now: new Date() });

  assert(isOk(result));
  expect(result.value.run.status).toBe("QUEUED");
  expect(result.value.effects).toContainEqual(
    expect.objectContaining({ _tag: "EnqueueRun" }),
  );
});

test("COMPLETED -> QUEUED is rejected", () => {
  const run = makeRun({ status: "COMPLETED" });
  const result = computeTransition(run, "QUEUED", { now: new Date() });

  assert(isErr(result));
  expect(result.error._tag).toBe("InvalidTransition");
});
```

**2.2 — Run engine (imperative shell wrapping the pure state machine)**

```typescript
// packages/engine/src/run-engine.ts

export function createRunEngine(deps: {
  db: DrizzleDB;
  queue: Queue;
  eventBus: EventBus;
}) {
  const { db, queue, eventBus } = deps;

  return {
    async transition(
      runId: string,
      to: RunStatus,
      context: TransitionContext,
    ): Promise<Result<Run, TransitionError>> {
      // 1. Load current run
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run) return err({ _tag: "RunNotFound", runId: runId as RunId });

      // 2. Compute transition (pure)
      const result = computeTransition(run, to, context);
      if (isErr(result)) return result;

      // 3. Optimistic locking: write with version check
      const updated = await db.update(runs)
        .set({ ...result.value.run })
        .where(and(
          eq(runs.id, runId),
          eq(runs.version, run.version), // CAS: only if version hasn't changed
        ))
        .returning();

      if (updated.length === 0) {
        return err({
          _tag: "VersionConflict",
          expected: run.version,
          actual: -1, // Unknown — someone else changed it
        });
      }

      // 4. Record event (append-only log)
      await db.insert(runEvents).values({
        runId,
        fromStatus: run.status,
        toStatus: to,
        reason: context.reason,
        data: context,
      });

      // 5. Execute side effects (imperative)
      await executeSideEffects(result.value.effects, deps);

      return ok(updated[0]);
    },
  };
}
```

**2.3 — Add run_events table**

Run the migration to add the `run_events` table. Every call to `engine.transition()` now records an event.

**2.4 — Retry with backoff**

```typescript
// packages/engine/src/retry/retry.ts

// Pure function: given an attempt number and config, compute the delay
export function computeBackoffMs(
  attempt: number,
  config: RetryConfig,
): number {
  const { minTimeout, maxTimeout, factor } = config;
  const exponential = minTimeout * Math.pow(factor, attempt);
  const clamped = Math.min(exponential, maxTimeout);
  // Jitter: +-25%
  const jitter = clamped * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

// Determine if a failure should be retried
export function shouldRetry(
  run: Run,
  failureType: FailureType,
): boolean {
  // SYSTEM_ERROR and TIMEOUT are always retryable
  // TASK_ERROR is retryable if attempts remain
  if (failureType === "TASK_ERROR" && run.attemptNumber >= run.maxAttempts) {
    return false;
  }
  return true;
}

// In the run engine: when a task execution fails
async function handleExecutionFailure(
  engine: RunEngine,
  runId: string,
  error: unknown,
  failureType: FailureType,
): Promise<void> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));

  if (shouldRetry(run, failureType)) {
    const delayMs = computeBackoffMs(run.attemptNumber, run.retryConfig ?? DEFAULT_RETRY_CONFIG);
    const scheduledFor = new Date(Date.now() + delayMs);

    // EXECUTING -> DELAYED (with backoff)
    await engine.transition(runId, "DELAYED", {
      now: new Date(),
      scheduledFor,
      nextAttempt: run.attemptNumber + 1,
      reason: `Retry attempt ${run.attemptNumber + 1} after ${delayMs}ms`,
    });
  } else {
    // EXECUTING -> FAILED (terminal)
    await engine.transition(runId, "FAILED", {
      now: new Date(),
      error: serializeError(error),
      failureType,
      reason: `Failed after ${run.attemptNumber} attempts`,
    });
  }
}
```

**2.5 — Delayed run scheduler**

A background loop that promotes DELAYED runs to QUEUED when their `scheduledFor` time has passed:

```typescript
async function runDelayedScheduler(db: DrizzleDB, engine: RunEngine): Promise<void> {
  while (true) {
    const now = new Date();
    const readyRuns = await db.select().from(runs)
      .where(and(
        eq(runs.status, "DELAYED"),
        lte(runs.scheduledFor, now),
      ))
      .limit(100);

    for (const run of readyRuns) {
      await engine.transition(run.id, "QUEUED", {
        now,
        reason: "Scheduled time reached",
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 1000)); // Poll every second
  }
}
```

**2.6 — Idempotency via unique constraint**

The idempotency key has a unique index. The trigger endpoint checks it before creating a run. If a duplicate key is provided, the existing run is returned.

### Phase 2 Deliverable

Runs go through a validated state machine. Every transition is recorded in the event log. Failed tasks retry with exponential backoff + jitter, going through DELAYED before re-entering QUEUED. Idempotency keys prevent duplicate runs. Version-based optimistic locking prevents race conditions on state updates.

---

## Phase 3: Concurrency + Fair Queuing
### Goal: Redis for concurrency tracking, fair multi-queue dequeuing, priority

### Concepts to Learn First
- Redis sorted sets: ZADD, ZPOPMIN, ZRANGEBYSCORE
- Redis Lua scripts: atomic multi-step operations
- TOCTOU (Time-of-check-to-time-of-use) races: why check-then-act is dangerous
- Fair scheduling algorithms: round-robin, weighted scoring

### What to Build

**3.1 — Add Redis to docker-compose**

```yaml
# docker-compose.yml — add Redis
services:
  postgres:
    # ... same as before
  redis:
    image: redis:7
    ports: ["6379:6379"]
```

**3.2 — Redis concurrency tracking with Lua atomics**

The core race condition: two workers check concurrency (count=9, limit=10), both see a slot, both proceed, and now you have 11 concurrent runs. Fix: use a Lua script for atomic check-and-add.

```typescript
// packages/engine/src/queue/concurrency.ts

const ACQUIRE_CONCURRENCY_SCRIPT = `
  local key = KEYS[1]
  local limit = tonumber(ARGV[1])
  local runId = ARGV[2]
  local now = tonumber(ARGV[3])

  -- Check current count
  local count = redis.call('ZCARD', key)
  if count >= limit then
    return 0  -- At capacity
  end

  -- Add run to the sorted set (score = timestamp for cleanup)
  redis.call('ZADD', key, now, runId)
  return 1  -- Acquired
`;

export function createConcurrencyTracker(redis: Redis) {
  return {
    async acquire(queueId: string, runId: string, limit: number): Promise<boolean> {
      const result = await redis.eval(
        ACQUIRE_CONCURRENCY_SCRIPT,
        1,                                    // number of KEYS
        `concurrency:${queueId}`,             // KEYS[1]
        limit.toString(),                     // ARGV[1]
        runId,                                // ARGV[2]
        Date.now().toString(),                // ARGV[3]
      );
      return result === 1;
    },

    async release(queueId: string, runId: string): Promise<void> {
      await redis.zrem(`concurrency:${queueId}`, runId);
    },

    async currentCount(queueId: string): Promise<number> {
      return redis.zcard(`concurrency:${queueId}`);
    },
  };
}
```

**Why Lua**: Redis executes Lua scripts atomically. The ZCARD + ZADD happen as one operation with no gap for another worker to sneak in. This eliminates the TOCTOU race.

**3.3 — Concurrency keys (per-user limits)**

Same pattern, but with a more specific Redis key:

```typescript
async acquire(queueId: string, concurrencyKey: string | null, runId: string): Promise<boolean> {
  // Queue-level concurrency
  const queueOk = await this.acquireSlot(`concurrency:queue:${queueId}`, queueLimit, runId);
  if (!queueOk) return false;

  // Key-level concurrency (if specified)
  if (concurrencyKey) {
    const keyOk = await this.acquireSlot(
      `concurrency:key:${queueId}:${concurrencyKey}`,
      keyLimit,
      runId,
    );
    if (!keyOk) {
      // Release queue-level slot since we can't proceed
      await this.release(`concurrency:queue:${queueId}`, runId);
      return false;
    }
  }

  return true;
}
```

**3.4 — Redis sorted set queue with priority**

```typescript
// packages/engine/src/queue/redis-queue.ts

const MAX_PRIORITY = 100;

export function createRedisQueue(redis: Redis) {
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
      // ZPOPMIN: atomically remove and return the lowest-scored items
      const results: string[] = [];
      for (let i = 0; i < limit; i++) {
        const item = await redis.zpopmin(`queue:${queueId}`);
        if (!item || item.length === 0) break;
        results.push(item[0]); // item is [member, score]
      }
      return results;
    },
  };
}
```

**Why this score formula**: A priority-10 task gets score `(100-10)*1e13 + timestamp = 90*1e13 + 1710000000000`. A priority-0 task gets `100*1e13 + timestamp`. Since 90 < 100, the priority-10 task always dequeues first. The `1e13` multiplier ensures even the oldest priority-0 task has a higher score than the newest priority-1 task.

**3.5 — Fair dequeuing across queues**

Start with round-robin. Upgrade to weighted scoring later.

```typescript
// packages/engine/src/queue/fair-dequeue.ts

export async function fairDequeue(
  redis: Redis,
  concurrency: ConcurrencyTracker,
  maxRuns: number,
): Promise<DequeuedRun[]> {
  const activeQueues = await redis.smembers("active-queues");
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
      const queue = await getQueue(queueId);
      if (queue.paused) { skippedQueues.add(queueId); continue; }

      // Try to acquire a concurrency slot
      const runIds = await redisQueue.dequeue(queueId, 1);
      if (runIds.length === 0) { skippedQueues.add(queueId); continue; }

      const runId = runIds[0];
      const acquired = await concurrency.acquire(queueId, null, runId);
      if (!acquired) {
        // Queue is at capacity — put the run back
        // NOTE: This re-enqueue changes the timestamp component of the score.
        // Acceptable for Phase 3. Phase 4 can use a "peek + conditional pop" pattern.
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
```

### Phase 3 Deliverable

Redis handles concurrency tracking with atomic Lua scripts (no TOCTOU). Multiple named queues with independent concurrency limits. Fair round-robin dequeuing across queues. Priority scoring with clean band separation. Two-level concurrency (queue + key).

---

## Phase 4: Reliability
### Goal: Optimistic locking, heartbeat monitoring, graceful shutdown, worker registration

### Concepts to Learn First
- Optimistic concurrency control: version-based CAS in PostgreSQL
- Heartbeat patterns: how to detect dead workers without centralized coordination
- Graceful shutdown: SIGTERM handling, connection draining
- Worker registration: how workers advertise their capabilities

### What to Build

**4.1 — Optimistic locking (already wired in Phase 2)**

The version field on runs is already being checked in `engine.transition()`. Phase 4 hardens this with explicit test cases for race conditions:

```typescript
test("concurrent transitions: one wins, one gets VersionConflict", async () => {
  const run = await createRun("test-task");
  await engine.transition(run.id, "QUEUED", { now: new Date() });

  // Simulate two workers trying to claim the same run
  const [result1, result2] = await Promise.all([
    engine.transition(run.id, "EXECUTING", { now: new Date(), workerId: "w1" }),
    engine.transition(run.id, "EXECUTING", { now: new Date(), workerId: "w2" }),
  ]);

  // Exactly one should succeed, the other should get VersionConflict
  const successes = [result1, result2].filter(isOk);
  const conflicts = [result1, result2].filter(isErr);
  expect(successes).toHaveLength(1);
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0].error._tag).toBe("VersionConflict");
});
```

**4.2 — Heartbeat monitoring**

Workers send heartbeats while executing. The server monitors for missed heartbeats.

```typescript
// Worker side: send heartbeat every 10 seconds while executing
async function executeWithHeartbeat(run: Run, taskFn: Function): Promise<unknown> {
  const heartbeatInterval = setInterval(async () => {
    await fetch(`${serverUrl}/api/runs/${run.id}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerId }),
    });
  }, 10_000);

  try {
    return await taskFn(run.payload);
  } finally {
    clearInterval(heartbeatInterval);
  }
}

// Server side: heartbeat endpoint extends the deadline
app.post("/api/runs/:id/heartbeat", async (c) => {
  const runId = c.req.param("id");
  const { workerId } = await c.req.json();

  await db.update(runs)
    .set({
      heartbeatDeadline: new Date(Date.now() + 30_000), // 30s from now
      workerId,
    })
    .where(and(
      eq(runs.id, runId),
      eq(runs.status, "EXECUTING"),
    ));

  return c.json({ ok: true });
});

// Server side: monitor checks every 15 seconds
async function heartbeatMonitor(engine: RunEngine): Promise<void> {
  while (true) {
    const staleRuns = await db.select().from(runs)
      .where(and(
        eq(runs.status, "EXECUTING"),
        lt(runs.heartbeatDeadline, new Date()),
        isNotNull(runs.heartbeatDeadline),
      ));

    for (const run of staleRuns) {
      console.log(`Run ${run.id} missed heartbeat deadline. Marking as failed.`);
      await handleExecutionFailure(engine, run.id, new Error("Heartbeat timeout"), "TIMEOUT");
    }

    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
}
```

**4.3 — Graceful shutdown**

```typescript
// packages/worker/src/shutdown.ts

export function setupGracefulShutdown(worker: Worker): void {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}. Draining current work...`);

    // Stop accepting new work
    worker.stopDequeuing();

    // Wait for in-progress tasks to finish (with timeout)
    const timeout = 30_000; // 30 seconds
    const started = Date.now();

    while (worker.activeRunCount > 0) {
      if (Date.now() - started > timeout) {
        console.log("Shutdown timeout reached. Forcing exit.");
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    console.log("All tasks drained. Exiting cleanly.");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
```

**4.4 — Worker registration**

Workers register with the server on startup, advertising which task types they handle:

```typescript
// Worker startup
async function registerWorker(serverUrl: string, workerId: string, taskTypes: string[]): Promise<void> {
  await fetch(`${serverUrl}/api/workers/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workerId, taskTypes }),
  });
}

// Server: dequeue only assigns tasks that a worker can handle
app.post("/api/dequeue", async (c) => {
  const { workerId, queueId, limit } = await c.req.json();

  // Look up what this worker supports
  const [worker] = await db.select().from(workers).where(eq(workers.id, workerId));
  if (!worker) return c.json({ error: "Worker not registered" }, 403);

  // Dequeue only matching task types
  const result = await db.execute(sql`
    UPDATE runs
    SET status = 'EXECUTING',
        worker_id = ${workerId},
        started_at = NOW(),
        dequeued_at = NOW(),
        heartbeat_deadline = NOW() + interval '30 seconds',
        version = version + 1
    WHERE id IN (
      SELECT r.id FROM runs r
      WHERE r.queue_id = ${queueId}
        AND r.status = 'QUEUED'
        AND r.task_id = ANY(${worker.taskTypes})
        AND (r.scheduled_for IS NULL OR r.scheduled_for <= NOW())
      ORDER BY r.priority DESC, r.created_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);

  return c.json({ runs: result.rows });
});
```

**4.5 — TTL expiry checker**

```typescript
async function checkExpiredRuns(engine: RunEngine): Promise<void> {
  while (true) {
    const now = new Date();
    const expired = await db.select().from(runs)
      .where(and(
        eq(runs.status, "QUEUED"),
        isNotNull(runs.ttl),
        lt(sql`created_at + ttl * interval '1 second'`, now),
      ));

    for (const run of expired) {
      await engine.transition(run.id, "EXPIRED", { now, reason: "TTL exceeded" });
    }

    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}
```

### Phase 4 Deliverable

Race conditions are caught by optimistic locking. Dead workers are detected by heartbeat monitoring and their runs are retried. Workers shut down gracefully, draining in-progress work. Workers register their capabilities and only receive matching tasks. Queued runs expire when their TTL is exceeded.

---

## Phase 5: Observability
### Goal: See everything — real-time dashboard, event log, OpenTelemetry

### Concepts to Learn First
- Server-Sent Events (SSE): one-way streaming from server to browser
- OpenTelemetry: traces, spans, context propagation, exporters
- TanStack Query v5: server state caching, invalidation, optimistic updates
- Zustand: lightweight client-side state management

### What to Build

**5.1 — SSE for real-time updates**

```typescript
// packages/server/src/routes/stream.ts
import { streamSSE } from "hono/streaming";

app.get("/api/runs/:id/stream", async (c) => {
  const runId = c.req.param("id");

  return streamSSE(c, async (stream) => {
    // Send current state immediately
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    await stream.writeSSE({ data: JSON.stringify(run), event: "state" });

    // Subscribe to changes via PostgreSQL LISTEN/NOTIFY
    const pgClient = await pool.connect();
    await pgClient.query("LISTEN run_updates");

    pgClient.on("notification", async (msg) => {
      if (!msg.payload) return;
      const data = JSON.parse(msg.payload);
      if (data.runId === runId) {
        await stream.writeSSE({ data: msg.payload, event: "update" });
      }
    });

    // Emit NOTIFY in the transition function
    // (add to run engine: after recording event, NOTIFY)
    stream.onAbort(() => {
      pgClient.query("UNLISTEN run_updates");
      pgClient.release();
    });
  });
});

// In run-engine, after recording run_events:
await db.execute(sql`NOTIFY run_updates, ${JSON.stringify({
  runId,
  fromStatus: run.status,
  toStatus: to,
  timestamp: new Date().toISOString(),
})}`);
```

**5.2 — OpenTelemetry instrumentation**

```typescript
// packages/server/src/tracing.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { trace, SpanStatusCode } from "@opentelemetry/api";

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({ url: "http://localhost:4318/v1/traces" }),
  serviceName: "reload-server",
});
sdk.start();

const tracer = trace.getTracer("reload-engine");

// Wrap run execution with a span
async function instrumentedExecute(run: Run, taskFn: Function): Promise<unknown> {
  return tracer.startActiveSpan(`task.execute:${run.taskId}`, async (span) => {
    span.setAttribute("run.id", run.id);
    span.setAttribute("run.taskId", run.taskId);
    span.setAttribute("run.attempt", run.attemptNumber);
    span.setAttribute("run.queueId", run.queueId);

    try {
      const result = await taskFn(run.payload);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  });
}
```

**5.3 — Dashboard**

Key pages and their data sources:

**Runs list page**: TanStack Query fetches paginated runs. Filters by status, queue, task type. SSE updates the list in real-time.

```typescript
// packages/dashboard/src/hooks/use-runs.ts
import { useQuery } from "@tanstack/react-query";

export function useRuns(filters: RunFilters) {
  return useQuery({
    queryKey: ["runs", filters],
    queryFn: () => fetch(`/api/runs?${new URLSearchParams(filters)}`).then((r) => r.json()),
    refetchInterval: 5000, // Fallback polling
  });
}
```

**Run detail page**: Shows timeline of all events, current state, payload/output, retry history.

```typescript
// packages/dashboard/src/hooks/use-run-stream.ts
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useRunStream(runId: string) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const eventSource = new EventSource(`/api/runs/${runId}/stream`);

    eventSource.addEventListener("update", (event) => {
      const data = JSON.parse(event.data);
      // Invalidate the run query to trigger a refetch
      queryClient.invalidateQueries({ queryKey: ["run", runId] });
    });

    return () => eventSource.close();
  }, [runId, queryClient]);
}
```

**Zustand store** (2-store pattern: TanStack Query for server state, Zustand for UI state):

```typescript
// packages/dashboard/src/stores/ui-store.ts
import { create } from "zustand";

type UIStore = {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  statusFilter: RunStatus | "ALL";
  setStatusFilter: (status: RunStatus | "ALL") => void;
};

export const useUIStore = create<UIStore>((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  statusFilter: "ALL",
  setStatusFilter: (statusFilter) => set({ statusFilter }),
}));
```

### Phase 5 Deliverable

Real-time dashboard shows run status changes as they happen via SSE. Full event timeline for any run. OpenTelemetry traces for all task executions. Queue stats page with concurrency gauges.

---

## Phase 6: Child Tasks + Waitpoints
### Goal: triggerAndWait, duration waits, token waits, step-based resumption

### Concepts to Learn First
- DAG execution: directed acyclic graphs of tasks
- Step-based replay: the resumption mechanism from Section 8
- Fan-out / fan-in: triggering many children and waiting for all

### What to Build

**6.1 — Add run_steps and waitpoints tables**

Run the migration to add these tables.

**6.2 — Step runner (from Section 8)**

Implement the `executeWithResumption` function with positional step counters and non-determinism detection.

**6.3 — triggerAndWait**

When a task calls `ctx.triggerAndWait("child-task", payload)`:
1. Step runner checks for cached result (replay case)
2. If not cached: throws `SuspendExecution`
3. Engine creates child run + waitpoint (type=CHILD_RUN)
4. Engine transitions parent to SUSPENDED
5. Child run goes through normal lifecycle
6. When child completes, waitpoint resolver finds the parent
7. Caches the step result in `run_steps`
8. Transitions parent SUSPENDED -> QUEUED
9. Worker picks up parent, step runner replays, cached step returns instantly
10. Execution continues to the next step

**6.4 — Waitpoint resolution**

```typescript
// packages/engine/src/waitpoints/waitpoints.ts

export function createWaitpointResolver(deps: { db: DrizzleDB; engine: RunEngine }) {
  return {
    // Called when a child run completes
    async resolveChildRun(childRunId: string, output: unknown): Promise<void> {
      const [wp] = await deps.db.select().from(waitpoints)
        .where(and(
          eq(waitpoints.childRunId, childRunId),
          eq(waitpoints.resolved, false),
        ));

      if (!wp) return; // No parent waiting

      // Mark waitpoint resolved
      await deps.db.update(waitpoints).set({
        resolved: true,
        resolvedAt: new Date(),
        result: output,
      }).where(eq(waitpoints.id, wp.id));

      // Cache the step result
      const [parentRun] = await deps.db.select().from(runs).where(eq(runs.id, wp.runId));
      const stepCount = await deps.db.select({ count: sql`count(*)` })
        .from(runSteps)
        .where(eq(runSteps.runId, wp.runId));

      await deps.db.insert(runSteps).values({
        runId: wp.runId,
        stepIndex: Number(stepCount[0].count),
        stepKey: `triggerAndWait:${parentRun.taskId}`, // Approximation; real key comes from context
        result: output,
      });

      // Resume parent: SUSPENDED -> QUEUED
      await deps.engine.transition(wp.runId, "QUEUED", {
        now: new Date(),
        reason: `Child run ${childRunId} completed`,
      });
    },

    // Called by duration scheduler
    async resolveDurationWait(waitpointId: string): Promise<void> {
      const [wp] = await deps.db.select().from(waitpoints).where(eq(waitpoints.id, waitpointId));
      if (!wp || wp.resolved) return;

      await deps.db.update(waitpoints).set({ resolved: true, resolvedAt: new Date() })
        .where(eq(waitpoints.id, waitpointId));

      await deps.db.insert(runSteps).values({
        runId: wp.runId,
        stepIndex: await getNextStepIndex(wp.runId),
        stepKey: `wait:duration`,
        result: null,
      });

      await deps.engine.transition(wp.runId, "QUEUED", {
        now: new Date(),
        reason: "Duration wait elapsed",
      });
    },

    // Called via HTTP endpoint
    async resolveToken(token: string, result: unknown): Promise<void> {
      const [wp] = await deps.db.select().from(waitpoints)
        .where(and(eq(waitpoints.token, token), eq(waitpoints.resolved, false)));
      if (!wp) throw new Error("Invalid or already resolved token");

      await deps.db.update(waitpoints).set({ resolved: true, resolvedAt: new Date(), result })
        .where(eq(waitpoints.id, wp.id));

      await deps.db.insert(runSteps).values({
        runId: wp.runId,
        stepIndex: await getNextStepIndex(wp.runId),
        stepKey: `token:${wp.id}`,
        result,
      });

      await deps.engine.transition(wp.runId, "QUEUED", {
        now: new Date(),
        reason: `Token ${token} resolved`,
      });
    },
  };
}
```

**6.5 — Duration wait scheduler**

```typescript
async function durationWaitScheduler(resolver: WaitpointResolver): Promise<void> {
  while (true) {
    const readyWaitpoints = await db.select().from(waitpoints)
      .where(and(
        eq(waitpoints.type, "DURATION"),
        eq(waitpoints.resolved, false),
        lte(waitpoints.resumeAfter, new Date()),
      ))
      .limit(100);

    for (const wp of readyWaitpoints) {
      await resolver.resolveDurationWait(wp.id);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
```

**6.6 — Batch triggerAndWait (fan-out / fan-in)**

```typescript
// In the step context:
batchTriggerAndWait: async (tasks: { taskId: string; payload: unknown }[]) => {
  const myIndex = currentStepIndex++;
  const expectedKey = `batch:${tasks.map(t => t.taskId).join(",")}`;

  const cached = completedSteps.find((s) => s.stepIndex === myIndex);
  if (cached) {
    if (cached.stepKey !== expectedKey) throw new Error("Non-determinism detected");
    return cached.result;
  }

  // Create all child runs and a single "batch waitpoint" that requires ALL children
  throw new SuspendExecution(myIndex, expectedKey, "BATCH", tasks);
},
```

### Phase 6 Deliverable

Tasks can trigger child tasks and wait for results. Duration waits pause and resume efficiently. External tokens enable human-in-the-loop workflows. Step-based replay handles resumption deterministically with non-determinism detection. Batch triggerAndWait supports fan-out/fan-in patterns.

---

## Phase 7: Scheduling + Rate Limiting
### Goal: Cron scheduling, token bucket rate limiting, error categorization, dead letter queue

### Concepts to Learn First
- Cron expressions: how cron scheduling works, parsing cron syntax
- Token bucket algorithm: smooth rate limiting (not just concurrency)
- Dead letter queues: where failed messages go for later inspection

### What to Build

**7.1 — Cron scheduling**

```typescript
// New table for cron schedules
export const cronSchedules = pgTable("cron_schedules", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id),
  schedule: text("schedule").notNull(),        // "*/5 * * * *"
  payload: jsonb("payload"),
  enabled: boolean("enabled").default(true),
  lastRunAt: timestamp("last_run_at"),
  nextRunAt: timestamp("next_run_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Cron scheduler loop
import { parseExpression } from "cron-parser";

async function cronScheduler(db: DrizzleDB, engine: RunEngine): Promise<void> {
  while (true) {
    const now = new Date();
    const dueSchedules = await db.select().from(cronSchedules)
      .where(and(
        eq(cronSchedules.enabled, true),
        lte(cronSchedules.nextRunAt, now),
      ));

    for (const schedule of dueSchedules) {
      // Trigger the task
      await engine.trigger(schedule.taskId, schedule.payload, {
        idempotencyKey: `cron:${schedule.id}:${schedule.nextRunAt.toISOString()}`,
      });

      // Calculate next run time
      const interval = parseExpression(schedule.schedule, { currentDate: now });
      const nextRun = interval.next().toDate();

      await db.update(cronSchedules).set({
        lastRunAt: now,
        nextRunAt: nextRun,
      }).where(eq(cronSchedules.id, schedule.id));
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
```

**7.2 — Token bucket rate limiting**

Rate limiting is separate from concurrency. Concurrency limits how many run simultaneously; rate limiting limits how many START per time window.

```typescript
// Redis-based token bucket
const RATE_LIMIT_SCRIPT = `
  local key = KEYS[1]
  local limit = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])  -- seconds
  local now = tonumber(ARGV[3])

  -- Remove expired entries
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)

  -- Check current count
  local count = redis.call('ZCARD', key)
  if count >= limit then
    return 0  -- Rate limited
  end

  -- Add this request
  redis.call('ZADD', key, now, now .. ':' .. math.random(1000000))
  redis.call('EXPIRE', key, window)
  return 1  -- Allowed
`;

export function createRateLimiter(redis: Redis) {
  return {
    async tryAcquire(queueId: string, limit: number, windowSeconds: number): Promise<boolean> {
      const result = await redis.eval(
        RATE_LIMIT_SCRIPT,
        1,
        `ratelimit:${queueId}`,
        limit.toString(),
        windowSeconds.toString(),
        (Date.now() / 1000).toString(),
      );
      return result === 1;
    },
  };
}
```

**7.3 — Error categorization**

```typescript
// Classify errors as retryable or non-retryable
export function categorizeError(error: unknown): { failureType: FailureType; retryable: boolean } {
  if (error instanceof Error) {
    // Network/timeout errors are system errors — always retry
    if (error.name === "TimeoutError" || error.message.includes("ECONNREFUSED")) {
      return { failureType: "SYSTEM_ERROR", retryable: true };
    }

    // Known non-retryable errors
    if (error.message.includes("INVALID_INPUT") || error.name === "ValidationError") {
      return { failureType: "TASK_ERROR", retryable: false };
    }
  }

  // Default: task error, retryable
  return { failureType: "TASK_ERROR", retryable: true };
}
```

**7.4 — Dead letter queue**

Not a separate table — a filtered view of FAILED runs with a replay endpoint:

```typescript
// GET /api/dead-letter?queue=email-queue
app.get("/api/dead-letter", async (c) => {
  const queueId = c.req.query("queue");
  const failed = await db.select().from(runs)
    .where(and(
      eq(runs.status, "FAILED"),
      queueId ? eq(runs.queueId, queueId) : undefined,
    ))
    .orderBy(desc(runs.completedAt))
    .limit(100);

  return c.json({ runs: failed });
});

// POST /api/dead-letter/:id/replay — retry a failed run
app.post("/api/dead-letter/:id/replay", async (c) => {
  const runId = c.req.param("id");
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));

  if (run.status !== "FAILED") {
    return c.json({ error: "Run is not in FAILED state" }, 400);
  }

  // Create a new run with the same parameters
  const [newRun] = await db.insert(runs).values({
    taskId: run.taskId,
    queueId: run.queueId,
    payload: run.payload,
    priority: run.priority,
    maxAttempts: run.maxAttempts,
    concurrencyKey: run.concurrencyKey,
    metadata: { ...run.metadata, replayedFrom: run.id },
  }).returning();

  await engine.transition(newRun.id, "QUEUED", { now: new Date(), reason: "Replayed from dead letter" });

  return c.json({ runId: newRun.id });
});
```

### Phase 7 Deliverable

Cron scheduling triggers tasks on recurring schedules with idempotency. Token bucket rate limiting controls throughput independent of concurrency. Error categorization distinguishes retryable from non-retryable failures. Dead letter queue provides visibility into failed runs with one-click replay.

---

## Phase 8: Polish
### Goal: CLI tool, production hardening, distributed workers

### What to Build

**8.1 — CLI tool**

```bash
# Basic CLI for managing reload.dev
reload trigger send-email --payload '{"to":"user@example.com"}'
reload runs list --status FAILED --queue email-queue
reload runs inspect <run-id>          # Show full event timeline
reload queues list                     # Show all queues with stats
reload queues pause email-queue        # Pause a queue
reload workers list                    # Show connected workers
reload dead-letter list               # Show failed runs
reload dead-letter replay <run-id>    # Replay a failed run
```

**8.2 — Production hardening**

- Connection pooling (PG pool, Redis pool)
- Request rate limiting on API endpoints
- Structured logging (pino)
- Health check endpoint (`GET /health`)
- Prometheus metrics endpoint (`GET /metrics`)
- Configuration via environment variables (validated with Zod)

**8.3 — Distributed workers via HTTP**

Workers can run on different machines. They communicate with the server purely over HTTP:

```
Worker                          Server
  │                                │
  ├── POST /api/workers/register ─>│  (startup: register task types)
  │                                │
  ├── POST /api/dequeue ──────────>│  (poll for work)
  │<── { runs: [...] } ───────────┤
  │                                │
  │    (executing task...)         │
  ├── POST /api/runs/:id/heartbeat>│  (every 10s while executing)
  │                                │
  ├── POST /api/runs/:id/complete ─>│  (task succeeded)
  │     OR                         │
  ├── POST /api/runs/:id/fail ────>│  (task failed)
  │                                │
```

This is simpler than Socket.io and works across any network boundary. The trade-off is latency (polling interval) vs. simplicity.

### Phase 8 Deliverable

CLI tool for common operations. Production-ready configuration and logging. Workers can run on separate machines communicating over HTTP. Health checks and metrics for monitoring.

---

## Discrepancies with Trigger.dev

This section documents where reload.dev intentionally diverges from Trigger.dev and why.

| Area | Trigger.dev | reload.dev | Why We Diverge |
|------|------------|------------|----------------|
| **ORM** | Prisma | Drizzle | Drizzle is SQL-transparent. You see the queries. Better for learning. |
| **Web framework** | Remix + Express | Hono | Simpler for an API-only server. No SSR complexity. |
| **Worker communication** | Socket.io (prod), HTTP (dev) | HTTP only | Simpler. HTTP polling + SSE is sufficient for learning. Socket.io adds complexity. |
| **Checkpointing** | CRIU (v3) — Linux kernel process snapshots | Step-based replay (v2 approach) | CRIU requires Linux containers. Step-based replay is implementable and teaches execution semantics. |
| **States** | 13+ states including WAITING_FOR_DEPLOY, REBOOTING, FROZEN | 9 states + metadata fields | Intentional simplification. Our states cover the core lifecycle. Extra states are product concerns. |
| **Concurrency levels** | 4 levels: org, env, queue, key | 2 levels: queue, key | Depth over breadth. Nail 2 levels before attempting org/env hierarchies. |
| **Redis usage** | 5+ Redis instances (queue, concurrency, locks, pub-sub, cache) | 1 Redis instance (Phase 3+) | Simplification. One instance with namespaced keys teaches the same patterns. |
| **Queue as primary** | Redis from the start | PostgreSQL SKIP LOCKED (Phase 1-2), then Redis (Phase 3) | Starting with PG teaches database queuing. Redis upgrade is earned understanding, not cargo-culting. |
| **FP approach** | Effect-TS throughout | Hand-rolled Result, pipe, discriminated unions | Effect-TS is too heavy for a learning project. Hand-rolled teaches more about the underlying patterns. |
| **Build system** | Turbo + tsup | Turbo + tsdown | tsdown is the successor to tsup from the same ecosystem. Slightly more modern. |
| **Linting** | ESLint + custom rules | oxlint + oxfmt | Faster, simpler config. Adopted from T3 Code. |
| **Dashboard state** | Various | TanStack Query v5 + Zustand (2-store) | Clean separation: server state in TQ, UI state in Zustand. No 3rd store needed. |
| **Distributed locks** | Redlock across multiple Redis | Version-based optimistic locking in PG | Simpler. Optimistic locking with version field handles our concurrency needs without a lock service. |
| **Event sourcing** | Snapshots + logs | Append-only run_events table | Not full event sourcing (no event replay to rebuild state). Just an audit log. Good enough for learning. |

### What We Explicitly Choose NOT to Build

1. **Multi-tenancy / org hierarchy**: Single-tenant. No orgs, projects, or environments. These are product features, not distributed systems concepts.
2. **Docker container isolation**: Workers run as Node.js child processes. Docker adds ops complexity without teaching queue internals.
3. **CRIU checkpointing**: Requires Linux containers and kernel-level integration. Step-based replay teaches the same concepts at a higher level.
4. **Multiple Redis instances**: One instance with namespaced keys. The patterns are identical; the operational complexity is not worth it for learning.
5. **OAuth / team management**: Simple API key auth. Authentication is not what we are learning.
6. **Deployment / CI/CD integration**: No deploy hooks or GitHub integration. This is infrastructure learning, not DevOps.

---

## Quick Reference: What to Build When

| Phase | What | Key Learning |
|-------|------|-------------|
| **1** | PG SKIP LOCKED queue, trigger/execute/complete, branded IDs, Result type | Database-level queuing, monorepo setup, FP foundations |
| **2** | Pure state machine, retries with backoff, idempotency, event log | State machines, exponential backoff, optimistic locking |
| **3** | Redis concurrency (Lua), fair dequeuing, priority scoring | TOCTOU races, atomic operations, fair scheduling |
| **4** | Heartbeat monitoring, graceful shutdown, worker registration | Failure detection, graceful degradation, service discovery |
| **5** | SSE dashboard, OpenTelemetry, event timeline | Real-time systems, observability, distributed tracing |
| **6** | triggerAndWait, step-based replay, duration/token waits, batch ops | DAG execution, deterministic replay, fan-out/fan-in |
| **7** | Cron scheduler, token bucket rate limiting, dead letter queue | Scheduling, rate limiting vs concurrency, failure management |
| **8** | CLI, production hardening, distributed workers | Operational concerns, HTTP-based distributed systems |

---

*This plan is the definitive guide for building reload.dev. Every decision is documented with rationale. Every phase builds on the previous. The goal is not to ship a product — it is to deeply understand how distributed task queues work by building one from scratch.*
