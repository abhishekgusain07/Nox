# Building a Trigger.dev-like Task Queue System
## Patterns & Architecture Extracted from T3 Code

> Staff-engineer-level analysis: what to adopt, what to adapt, and how to implement each pattern for a long-running task queue platform.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Monorepo Structure](#2-monorepo-structure)
3. [Toolchain & Build System](#3-toolchain--build-system)
4. [Effect-TS: The Programming Model](#4-effect-ts-the-programming-model)
5. [Event Sourcing & CQRS](#5-event-sourcing--cqrs)
6. [Contracts Package: Type Safety Across Boundaries](#6-contracts-package-type-safety-across-boundaries)
7. [Service Architecture & Dependency Injection](#7-service-architecture--dependency-injection)
8. [Real-Time Communication (WebSocket)](#8-real-time-communication-websocket)
9. [Persistence Layer](#9-persistence-layer)
10. [Reactor Pattern: Decoupled Side Effects](#10-reactor-pattern-decoupled-side-effects)
11. [Process Management & Worker Orchestration](#11-process-management--worker-orchestration)
12. [Testing Strategy](#12-testing-strategy)
13. [Frontend Patterns](#13-frontend-patterns)
14. [Concrete Task Queue Architecture](#14-concrete-task-queue-architecture)
15. [Implementation Roadmap](#15-implementation-roadmap)

---

## 1. Executive Summary

T3 Code is an event-sourced, Effect-TS-powered monorepo with production-grade patterns that map remarkably well to a task queue system. The core insight: **both systems manage long-running, stateful workflows with real-time observability**.

### What T3 Code Does vs What Your Task Queue Does

| T3 Code | Task Queue (Trigger.dev-like) |
|---------|-------------------------------|
| Manages AI coding sessions | Manages long-running background jobs |
| Tracks turn lifecycle (start/stream/complete) | Tracks task lifecycle (enqueue/run/complete/fail) |
| Checkpoint-based undo | Retry-based recovery |
| Real-time streaming of AI responses | Real-time streaming of task progress |
| Provider adapter (Codex child process) | Worker adapter (task execution process) |
| Approval requests (pause/resume) | Manual intervention (pause/resume/cancel) |
| Event sourcing for full audit trail | Event sourcing for task history & debugging |

### Patterns Worth Adopting (High Value)

| Pattern | Value for Task Queue | Effort |
|---------|---------------------|--------|
| Event sourcing + CQRS | Full task audit trail, replay, debugging | High |
| Effect-TS service DI | Type-safe, testable service composition | High |
| Branded ID types | Prevent TaskId/QueueId/WorkerId mixups | Low |
| Contracts package | Shared types across API/worker/dashboard | Low |
| DrainableWorker | Deterministic testing of async workers | Medium |
| Reactor pattern | Decoupled side effects (notifications, metrics) | Medium |
| Monorepo structure | Unified codebase, shared types | Low |
| WebSocket push bus | Real-time task progress to dashboard | Medium |
| Schema validation at boundaries | Runtime safety for API inputs | Low |

### Patterns to Adapt (Different Context)

| T3 Code Pattern | Adaptation for Task Queue |
|-----------------|--------------------------|
| Single SQLite database | PostgreSQL for multi-node (or SQLite for single-node) |
| In-memory read model | Redis-backed read model for horizontal scaling |
| Child process per session | Worker pool with job distribution |
| Git checkpoints | Task state snapshots for retry |
| Terminal PTY management | Worker process stdout/stderr capture |

---

## 2. Monorepo Structure

### T3 Code Structure (Reference)

```
t3code/
  apps/
    server/     # Node.js backend
    web/        # React dashboard
    desktop/    # Electron wrapper
    marketing/  # Landing page
  packages/
    contracts/  # Shared type definitions (zero runtime)
    shared/     # Shared runtime utilities
  scripts/      # Dev tooling
```

### Recommended Task Queue Structure

```
taskqueue/
  apps/
    api/              # HTTP + WebSocket API server
    worker/           # Task execution worker process
    dashboard/        # React web dashboard
    cli/              # CLI tool for managing tasks
  packages/
    contracts/        # Shared schemas: task definitions, events, API protocol
    shared/           # Shared runtime: retry logic, serialization, logging
    queue-core/       # Core queue logic: scheduling, priority, rate limiting
  scripts/            # Dev runner, migrations, seed data
```

### Root package.json Pattern

```jsonc
{
  "name": "@taskqueue/monorepo",
  "private": true,
  "workspaces": ["apps/*", "packages/*", "scripts"],
  "packageManager": "bun@1.3.9",
  "catalog": {
    // Pin shared dependency versions here
    "effect": "^3.x.x",
    "@effect/platform-node": "^0.x.x",
    "@effect/sql-sqlite-bun": "^0.x.x",  // or @effect/sql-pg
    "@effect/vitest": "^0.x.x",
    "typescript": "^5.7.3",
    "vitest": "^4.0.0",
    "tsdown": "^0.20.3"
  },
  "devDependencies": {
    "oxfmt": "^0.40.0",
    "oxlint": "^1.55.0",
    "turbo": "^2.3.3",
    "vitest": "catalog:"
  },
  "scripts": {
    "dev": "bun run scripts/dev-runner.ts dev",
    "build": "turbo run build",
    "typecheck": "turbo run typecheck",
    "lint": "oxlint --deny-warnings --import-plugin -c .oxlintrc.json .",
    "test": "vitest run",
    "fmt": "oxfmt --write ."
  }
}
```

### Key Decisions from T3 Code

1. **Bun as package manager** -- Fast installs, native TypeScript execution, workspace catalog support
2. **Turborepo for orchestration** -- Task dependency graph, caching, parallel builds
3. **oxlint + oxfmt** -- Rust-based, 10-100x faster than ESLint/Prettier
4. **Catalog for version pinning** -- Single source of truth for shared dependency versions
5. **workspace:\* protocol** -- All internal packages reference each other via workspace protocol

### turbo.json

```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "globalEnv": ["TASKQUEUE_*", "DATABASE_URL", "REDIS_URL"],
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "dependsOn": ["@taskqueue/contracts#build"],
      "cache": false,
      "persistent": true
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "outputs": [],
      "cache": false
    },
    "test": {
      "dependsOn": ["^build"],
      "cache": false
    }
  }
}
```

### TypeScript Base Config

```jsonc
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,     // Catches array[i] without null check
    "exactOptionalPropertyTypes": true,    // Distinguishes undefined from missing
    "noImplicitOverride": true,
    "useDefineForClassFields": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  }
}
```

---

## 3. Toolchain & Build System

### Build Tools by Package Type

| Package | Build Tool | Format | Why |
|---------|-----------|--------|-----|
| `apps/api` | tsdown | ESM + CJS | Server bundle with shebang for CLI |
| `apps/worker` | tsdown | ESM | Worker process bundle |
| `apps/dashboard` | Vite 8 | SPA | React + Tailwind + React Compiler |
| `apps/cli` | tsdown | ESM | CLI bundle with shebang |
| `packages/contracts` | tsdown | ESM + CJS + DTS | Library consumed everywhere |
| `packages/shared` | None (source) | Source TS | Consumed directly via subpath exports |

### tsdown Config (API Server Example)

```typescript
// apps/api/tsdown.config.ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: (id) => id.startsWith("@taskqueue/"),  // Bundle internal packages
  banner: { js: "#!/usr/bin/env node\n" },
});
```

### Subpath Exports (Shared Package)

```jsonc
// packages/shared/package.json
{
  "name": "@taskqueue/shared",
  "exports": {
    "./retry": { "types": "./src/retry.ts", "import": "./src/retry.ts" },
    "./logging": { "types": "./src/logging.ts", "import": "./src/logging.ts" },
    "./serialization": { "types": "./src/serialization.ts", "import": "./src/serialization.ts" },
    "./DrainableWorker": { "types": "./src/DrainableWorker.ts", "import": "./src/DrainableWorker.ts" },
    "./Net": { "types": "./src/Net.ts", "import": "./src/Net.ts" }
  }
}
```

**Why subpath exports over barrel index:**
- Tree-shaking friendly
- Explicit dependency declarations
- Faster builds (no need to parse entire package)
- Clearer import paths: `import { retry } from "@taskqueue/shared/retry"`

---

## 4. Effect-TS: The Programming Model

### Why Effect-TS for a Task Queue

A task queue system has the same complexity drivers as T3 Code:
- **Concurrent workflows** -- Multiple tasks running simultaneously
- **Resource management** -- Database connections, worker processes, network sockets
- **Typed errors** -- Distinguish timeout vs failure vs cancellation
- **Dependency injection** -- Swap implementations for testing
- **Structured concurrency** -- Parent task cancels child tasks

### Core Patterns to Adopt

#### 4.1 Service Definition

Every major subsystem is defined as a service with a typed interface:

```typescript
// packages/queue-core/src/Services/TaskScheduler.ts
import { Effect, ServiceMap, Stream } from "effect";
import type { TaskId, QueueId } from "@taskqueue/contracts";

export interface TaskSchedulerShape {
  readonly enqueue: (input: EnqueueInput) => Effect.Effect<TaskId, TaskSchedulerError>;
  readonly cancel: (taskId: TaskId) => Effect.Effect<void, TaskNotFoundError>;
  readonly retry: (taskId: TaskId) => Effect.Effect<TaskId, TaskSchedulerError>;
  readonly getStatus: (taskId: TaskId) => Effect.Effect<TaskStatus, TaskNotFoundError>;
  readonly streamUpdates: Stream.Stream<TaskStatusEvent>;
}

export class TaskScheduler extends ServiceMap.Service<TaskScheduler, TaskSchedulerShape>()(
  "taskqueue/Services/TaskScheduler",
) {}
```

#### 4.2 Effect.gen for Sequential Logic

```typescript
// Implementation of a service method
const enqueue: TaskSchedulerShape["enqueue"] = (input) =>
  Effect.gen(function* () {
    // 1. Validate input against schema
    const validated = yield* Schema.decodeUnknownEffect(EnqueueInput)(input);

    // 2. Check queue exists and has capacity
    const queue = yield* queueRegistry.getQueue(validated.queueId);
    if (queue.isPaused) {
      return yield* Effect.fail(new QueuePausedError({ queueId: validated.queueId }));
    }

    // 3. Dispatch command through event sourcing engine
    const { sequence } = yield* engine.dispatch({
      type: "task.enqueue",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      taskId: TaskId.makeUnsafe(crypto.randomUUID()),
      queueId: validated.queueId,
      payload: validated.payload,
      priority: validated.priority ?? "normal",
      maxRetries: validated.maxRetries ?? 3,
      createdAt: new Date().toISOString(),
    });

    return validated.taskId;
  });
```

#### 4.3 Typed Errors

```typescript
// apps/api/src/task/Errors.ts
import { Schema } from "effect";

export class TaskNotFoundError extends Schema.TaggedErrorClass<TaskNotFoundError>()(
  "TaskNotFoundError",
  {
    taskId: Schema.String,
  },
) {
  override get message() {
    return `Task not found: ${this.taskId}`;
  }
}

export class TaskSchedulerError extends Schema.TaggedErrorClass<TaskSchedulerError>()(
  "TaskSchedulerError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message() {
    return `Task scheduler error in ${this.operation}: ${this.detail}`;
  }
}

export class QueuePausedError extends Schema.TaggedErrorClass<QueuePausedError>()(
  "QueuePausedError",
  {
    queueId: Schema.String,
  },
) {}

// Error union -- flows through the type system
export type TaskDispatchError =
  | TaskNotFoundError
  | TaskSchedulerError
  | QueuePausedError
  | TaskCommandInvariantError;
```

#### 4.4 Layer Composition (Dependency Graph)

```typescript
// apps/api/src/serverLayers.ts
import { Layer } from "effect";

export function makeServerLayers() {
  // Persistence layer
  const persistenceLayer = SqlitePersistenceLive; // or PostgresPersistenceLive

  // Core engine (event sourcing)
  const engineLayer = TaskEngineServiceLive.pipe(
    Layer.provide(TaskProjectionPipelineLive),
    Layer.provide(TaskEventStoreLive),
    Layer.provide(TaskCommandReceiptRepositoryLive),
  );

  // Reactors (side effects)
  const workerReactorLayer = WorkerDispatchReactorLive.pipe(
    Layer.provideMerge(engineLayer),
  );

  const notificationReactorLayer = NotificationReactorLive.pipe(
    Layer.provideMerge(engineLayer),
  );

  const metricsReactorLayer = MetricsReactorLive.pipe(
    Layer.provideMerge(engineLayer),
  );

  // Compose everything
  return Layer.mergeAll(
    engineLayer,
    workerReactorLayer,
    notificationReactorLayer,
    metricsReactorLayer,
    TaskSchedulerLive,
  ).pipe(
    Layer.provideMerge(persistenceLayer),
    Layer.provideMerge(ServerConfigLayer),
  );
}
```

#### 4.5 Concurrent Primitives

| Primitive | T3 Code Usage | Task Queue Usage |
|-----------|---------------|------------------|
| `PubSub.unbounded()` | Broadcast domain events to reactors | Broadcast task status updates to dashboard clients |
| `Queue.unbounded()` | Serialize command dispatch | Task execution queue, retry queue |
| `Ref.make()` | Track connected clients, push sequence | Track active workers, queue depths |
| `Deferred.make()` | Command result synchronization | Task completion signals |
| `Stream.fromPubSub()` | Subscribe to event streams | Stream task progress to WebSocket clients |

#### 4.6 DrainableWorker (Critical for Testing)

```typescript
// packages/shared/src/DrainableWorker.ts
// Copied directly from T3 Code -- this pattern is universal

export interface DrainableWorker<A> {
  readonly enqueue: (item: A) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;  // Resolves when queue empty AND current item done
}

// Usage in tests:
it("processes task and updates status", () =>
  Effect.gen(function* () {
    const harness = yield* makeTaskQueueHarness();

    yield* harness.dispatch({ type: "task.enqueue", taskId: "task-1", ... });
    yield* harness.drain();  // Deterministic: wait for all async work

    const status = yield* harness.getTaskStatus("task-1");
    assert.equal(status, "queued");
  })
);
```

---

## 5. Event Sourcing & CQRS

This is the architectural heart. T3 Code's event sourcing maps directly to task queue needs.

### 5.1 The Pattern

```
Command (user action: enqueue, cancel, retry)
    |
    v
Decider (pure function: command + readModel -> events[])
    |
    v
Event Store (append-only, auto-increment sequence)
    |
    v
Projector (pure function: event -> read model mutation)
    |
    v
Read Model (in-memory: queues[], tasks[], workers[])
    |
    v
PubSub (hot stream to WebSocket clients + reactors)
```

### 5.2 Task Queue Commands

```typescript
// packages/contracts/src/taskCommands.ts
export const TaskCommand = Schema.Union([
  // Client commands
  TaskEnqueueCommand,           // Submit new task
  TaskCancelCommand,            // Cancel running/queued task
  TaskRetryCommand,             // Retry failed task
  TaskPauseQueueCommand,        // Pause a queue
  TaskResumeQueueCommand,       // Resume a queue
  QueueCreateCommand,           // Create new queue
  QueueDeleteCommand,           // Delete queue

  // Internal commands (from worker reactor)
  TaskStartedCommand,           // Worker picked up task
  TaskProgressCommand,          // Worker reports progress
  TaskCompletedCommand,         // Worker finished successfully
  TaskFailedCommand,            // Worker reported failure
  TaskHeartbeatCommand,         // Worker liveness signal
  TaskTimeoutCommand,           // System detected timeout
]);
```

### 5.3 Task Queue Events

```typescript
// packages/contracts/src/taskEvents.ts
export const TaskEvent = Schema.Union([
  // Task lifecycle
  Schema.Struct({ ...EventBase, type: Schema.Literal("task.enqueued"), payload: TaskEnqueuedPayload }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("task.started"), payload: TaskStartedPayload }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("task.progress"), payload: TaskProgressPayload }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("task.completed"), payload: TaskCompletedPayload }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("task.failed"), payload: TaskFailedPayload }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("task.cancelled"), payload: TaskCancelledPayload }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("task.retried"), payload: TaskRetriedPayload }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("task.timed-out"), payload: TaskTimedOutPayload }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("task.heartbeat"), payload: TaskHeartbeatPayload }),

  // Queue lifecycle
  Schema.Struct({ ...EventBase, type: Schema.Literal("queue.created"), payload: QueueCreatedPayload }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("queue.paused"), payload: QueuePausedPayload }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("queue.resumed"), payload: QueueResumedPayload }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("queue.deleted"), payload: QueueDeletedPayload }),
]);
```

### 5.4 Decider (Pure Business Logic)

```typescript
// apps/api/src/task/decider.ts
export const decideTaskCommand = Effect.fn("decideTaskCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: TaskCommand;
  readonly readModel: TaskReadModel;
}) {
  switch (command.type) {
    case "task.enqueue": {
      yield* requireQueue({ readModel, queueId: command.queueId });
      yield* requireQueueNotPaused({ readModel, queueId: command.queueId });

      return withEventBase(command, {
        type: "task.enqueued",
        aggregateKind: "task",
        aggregateId: command.taskId,
        payload: {
          taskId: command.taskId,
          queueId: command.queueId,
          taskType: command.taskType,
          payload: command.payload,
          priority: command.priority,
          maxRetries: command.maxRetries,
          scheduledAt: command.scheduledAt ?? command.createdAt,
          createdAt: command.createdAt,
        },
      });
    }

    case "task.cancel": {
      const task = yield* requireTask({ readModel, taskId: command.taskId });
      if (task.status === "completed" || task.status === "cancelled") {
        return yield* Effect.fail(
          new TaskCommandInvariantError({
            commandType: command.type,
            detail: `Cannot cancel task in status: ${task.status}`,
          }),
        );
      }

      return withEventBase(command, {
        type: "task.cancelled",
        aggregateKind: "task",
        aggregateId: command.taskId,
        payload: {
          taskId: command.taskId,
          reason: command.reason ?? "User cancelled",
          cancelledAt: command.createdAt,
        },
      });
    }

    case "task.retry": {
      const task = yield* requireTask({ readModel, taskId: command.taskId });
      if (task.status !== "failed" && task.status !== "timed-out") {
        return yield* Effect.fail(
          new TaskCommandInvariantError({
            commandType: command.type,
            detail: `Cannot retry task in status: ${task.status}`,
          }),
        );
      }
      if (task.attemptCount >= task.maxRetries) {
        return yield* Effect.fail(
          new TaskCommandInvariantError({
            commandType: command.type,
            detail: `Max retries (${task.maxRetries}) exceeded`,
          }),
        );
      }

      return withEventBase(command, {
        type: "task.retried",
        aggregateKind: "task",
        aggregateId: command.taskId,
        payload: {
          taskId: command.taskId,
          attemptNumber: task.attemptCount + 1,
          retriedAt: command.createdAt,
        },
      });
    }

    // ... other command handlers
  }
});
```

### 5.5 Projector (State Transitions)

```typescript
// apps/api/src/task/projector.ts
export function projectTaskEvent(
  model: TaskReadModel,
  event: TaskEvent,
): TaskReadModel {
  const nextBase = { ...model, snapshotSequence: event.sequence, updatedAt: event.occurredAt };

  switch (event.type) {
    case "task.enqueued":
      return {
        ...nextBase,
        tasks: [
          ...nextBase.tasks,
          {
            id: event.payload.taskId,
            queueId: event.payload.queueId,
            taskType: event.payload.taskType,
            payload: event.payload.payload,
            status: "queued",
            priority: event.payload.priority,
            attemptCount: 0,
            maxRetries: event.payload.maxRetries,
            progress: null,
            result: null,
            error: null,
            workerId: null,
            scheduledAt: event.payload.scheduledAt,
            startedAt: null,
            completedAt: null,
            createdAt: event.payload.createdAt,
            updatedAt: event.occurredAt,
          },
        ],
      };

    case "task.started":
      return {
        ...nextBase,
        tasks: updateTask(nextBase.tasks, event.payload.taskId, {
          status: "running",
          workerId: event.payload.workerId,
          attemptCount: (task) => task.attemptCount + 1,
          startedAt: event.payload.startedAt,
          updatedAt: event.occurredAt,
        }),
      };

    case "task.progress":
      return {
        ...nextBase,
        tasks: updateTask(nextBase.tasks, event.payload.taskId, {
          progress: event.payload.progress,  // { percent: 45, message: "Processing row 450/1000" }
          updatedAt: event.occurredAt,
        }),
      };

    case "task.completed":
      return {
        ...nextBase,
        tasks: updateTask(nextBase.tasks, event.payload.taskId, {
          status: "completed",
          result: event.payload.result,
          completedAt: event.payload.completedAt,
          updatedAt: event.occurredAt,
        }),
      };

    case "task.failed":
      return {
        ...nextBase,
        tasks: updateTask(nextBase.tasks, event.payload.taskId, {
          status: "failed",
          error: event.payload.error,
          updatedAt: event.occurredAt,
        }),
      };

    case "task.retried":
      return {
        ...nextBase,
        tasks: updateTask(nextBase.tasks, event.payload.taskId, {
          status: "queued",  // Back to queue
          progress: null,
          error: null,
          workerId: null,
          updatedAt: event.occurredAt,
        }),
      };

    // ... other event projections
  }
}
```

### 5.6 Idempotency via Command Receipts

Directly adopted from T3 Code:

```typescript
// Check before processing
const existing = yield* receiptRepo.getByCommandId({ commandId: command.commandId });
if (Option.isSome(existing)) {
  if (existing.value.status === "accepted") {
    // Return cached result -- safe to retry
    return yield* Deferred.succeed(envelope.result, { sequence: existing.value.resultSequence });
  }
  // Previously rejected -- fail again consistently
  return yield* Deferred.fail(envelope.result, new PreviouslyRejectedError(...));
}
```

**Why this matters for task queues:** Network failures between client and API can cause duplicate enqueue requests. Command receipts guarantee exactly-once semantics.

---

## 6. Contracts Package: Type Safety Across Boundaries

### 6.1 Branded ID Types

```typescript
// packages/contracts/src/baseSchemas.ts
import { Schema } from "effect";

const TrimmedNonEmptyString = Schema.Trim.check(Schema.isNonEmpty());

const makeEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

// Each ID type is distinct at compile time
export const TaskId = makeEntityId("TaskId");
export type TaskId = typeof TaskId.Type;

export const QueueId = makeEntityId("QueueId");
export type QueueId = typeof QueueId.Type;

export const WorkerId = makeEntityId("WorkerId");
export type WorkerId = typeof WorkerId.Type;

export const CommandId = makeEntityId("CommandId");
export type CommandId = typeof CommandId.Type;

export const EventId = makeEntityId("EventId");
export type EventId = typeof EventId.Type;

export const RunId = makeEntityId("RunId");
export type RunId = typeof RunId.Type;

// Usage: TaskId and QueueId are DIFFERENT types
// function getTask(taskId: TaskId): ...
// getTask(someQueueId)  // Compile error!
```

### 6.2 API Protocol Schemas

```typescript
// packages/contracts/src/api.ts
// HTTP API schemas (or WebSocket if real-time needed)

export const API_METHODS = {
  // Task operations
  taskEnqueue: "task.enqueue",
  taskCancel: "task.cancel",
  taskRetry: "task.retry",
  taskGet: "task.get",
  taskList: "task.list",

  // Queue operations
  queueCreate: "queue.create",
  queuePause: "queue.pause",
  queueResume: "queue.resume",
  queueList: "queue.list",
  queueStats: "queue.stats",

  // Worker operations
  workerRegister: "worker.register",
  workerHeartbeat: "worker.heartbeat",
  workerDeregister: "worker.deregister",
} as const;

// Discriminated union for WebSocket requests
const tagRequestBody = <Tag extends string, Fields extends Schema.Struct.Fields>(
  tag: Tag,
  schema: Schema.Struct<Fields>,
) => schema.mapFields(Struct.assign({ _tag: Schema.tag(tag) }), { unsafePreserveChecks: true });

export const ApiRequestBody = Schema.Union([
  tagRequestBody(API_METHODS.taskEnqueue, TaskEnqueueInput),
  tagRequestBody(API_METHODS.taskCancel, TaskCancelInput),
  tagRequestBody(API_METHODS.taskList, TaskListInput),
  tagRequestBody(API_METHODS.queueCreate, QueueCreateInput),
  // ...
]);
```

### 6.3 Push Channels (Real-Time Updates)

```typescript
// packages/contracts/src/push.ts
export const PUSH_CHANNELS = {
  taskEvent: "task.event",
  queueStats: "queue.stats",
  workerStatus: "worker.status",
} as const;

export interface PushPayloadByChannel {
  readonly [PUSH_CHANNELS.taskEvent]: TaskEvent;
  readonly [PUSH_CHANNELS.queueStats]: QueueStatsPayload;
  readonly [PUSH_CHANNELS.workerStatus]: WorkerStatusPayload;
}

export type PushChannel = keyof PushPayloadByChannel;
export type PushData<C extends PushChannel> = PushPayloadByChannel[C];
```

### 6.4 Zero Runtime in Contracts

The contracts package contains **only schemas and types** -- no business logic. This ensures:
- Types are the single source of truth
- Same schemas validate at runtime AND provide compile-time types
- No circular dependency risk between apps
- Package stays tiny (just type definitions)

---

## 7. Service Architecture & Dependency Injection

### Service Map

```
TaskScheduler       -- Enqueue, cancel, retry tasks
TaskEngine          -- Event sourcing engine (decider + projector + store)
WorkerRegistry      -- Track registered workers
WorkerDispatcher    -- Assign tasks to workers
QueueRegistry       -- Manage queues
NotificationService -- Send webhooks/emails on task events
MetricsService      -- Track queue depths, latencies, error rates
PushBus             -- WebSocket broadcast to dashboard
```

### Implementation Pattern

```typescript
// apps/api/src/worker/Services/WorkerRegistry.ts
export interface WorkerRegistryShape {
  readonly register: (input: WorkerRegisterInput) => Effect.Effect<WorkerId, WorkerRegistryError>;
  readonly heartbeat: (workerId: WorkerId) => Effect.Effect<void, WorkerNotFoundError>;
  readonly deregister: (workerId: WorkerId) => Effect.Effect<void, WorkerNotFoundError>;
  readonly getAvailable: (queueId: QueueId) => Effect.Effect<ReadonlyArray<Worker>>;
  readonly streamStatus: Stream.Stream<WorkerStatusEvent>;
}

export class WorkerRegistry extends ServiceMap.Service<WorkerRegistry, WorkerRegistryShape>()(
  "taskqueue/Services/WorkerRegistry",
) {}

// Layer (implementation)
export const WorkerRegistryLive = Layer.effect(
  WorkerRegistry,
  Effect.gen(function* () {
    const workers = yield* Ref.make(new Map<WorkerId, Worker>());
    const statusPubSub = yield* PubSub.unbounded<WorkerStatusEvent>();

    // Timeout detection: fork a fiber that checks heartbeats
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          yield* Effect.sleep("30 seconds");
          const currentWorkers = yield* Ref.get(workers);
          const now = Date.now();
          for (const [id, worker] of currentWorkers) {
            if (now - worker.lastHeartbeat > 60_000) {
              yield* Ref.update(workers, (m) => { m.delete(id); return new Map(m); });
              yield* PubSub.publish(statusPubSub, { type: "worker.timed-out", workerId: id });
            }
          }
        }),
      ),
    );

    return {
      register: (input) => Effect.gen(function* () { /* ... */ }),
      heartbeat: (workerId) => Effect.gen(function* () { /* ... */ }),
      deregister: (workerId) => Effect.gen(function* () { /* ... */ }),
      getAvailable: (queueId) => Effect.gen(function* () { /* ... */ }),
      get streamStatus() { return Stream.fromPubSub(statusPubSub); },
    } satisfies WorkerRegistryShape;
  }),
);
```

### Layer Composition at Startup

```typescript
// apps/api/src/index.ts
const RuntimeLayer = Layer.empty.pipe(
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(makeServerLayers()),
  Layer.provideMerge(NodeServices.layer),
);

// Start server
Effect.gen(function* () {
  const server = yield* createServer();
  yield* server.start();
  yield* Effect.never;  // Run forever
}).pipe(
  Effect.scoped,
  Effect.provide(RuntimeLayer),
  NodeRuntime.runMain,
);
```

---

## 8. Real-Time Communication (WebSocket)

### Server Push Bus

Directly adapted from T3 Code's push bus pattern:

```typescript
// apps/api/src/pushBus.ts
export const makePushBus = (clients: Ref.Ref<Set<WebSocket>>) =>
  Effect.gen(function* () {
    const nextSequence = yield* Ref.make(0);
    const queue = yield* Queue.unbounded<PushJob>();
    const encodePush = Schema.encodeUnknownEffect(Schema.fromJsonString(WsPush));

    const send = Effect.fnUntraced(function* (job: PushJob) {
      const sequence = yield* Ref.updateAndGet(nextSequence, (n) => n + 1);
      const push = { type: "push", sequence, channel: job.channel, data: job.data };
      const recipients = job.target === "all"
        ? yield* Ref.get(clients)
        : new Set([job.target]);

      return yield* encodePush(push).pipe(
        Effect.map((message) => {
          for (const client of recipients) {
            if (client.readyState === client.OPEN) client.send(message);
          }
        }),
      );
    });

    yield* Effect.forkScoped(Effect.forever(Queue.take(queue).pipe(Effect.flatMap(send))));

    return {
      publishAll: <C extends PushChannel>(channel: C, data: PushData<C>) =>
        Queue.offer(queue, { target: "all", channel, data }).pipe(Effect.asVoid),
      publishClient: <C extends PushChannel>(ws: WebSocket, channel: C, data: PushData<C>) =>
        Queue.offer(queue, { target: ws, channel, data }).pipe(Effect.asVoid),
    };
  });
```

### Client Transport

```typescript
// apps/dashboard/src/wsTransport.ts
// Adapted from T3 Code's WsTransport

export class WsTransport {
  private reconnectDelays = [500, 1_000, 2_000, 4_000, 8_000];
  private pending = new Map<string, { resolve, reject, timeout }>();
  private listeners = new Map<string, Set<Function>>();
  private latestPushByChannel = new Map<string, unknown>();

  // Request/response with 60s timeout
  async request<T>(method: string, params?: unknown): Promise<T> { /* ... */ }

  // Subscribe to push channels with replay support
  subscribe<C extends PushChannel>(
    channel: C,
    listener: (data: PushData<C>) => void,
    options?: { replayLatest?: boolean },
  ): () => void { /* ... */ }
}
```

---

## 9. Persistence Layer

### SQLite (Single-Node) or PostgreSQL (Multi-Node)

T3 Code uses SQLite with WAL mode. For a task queue:
- **Single-node / dev:** SQLite with WAL (zero config, embedded)
- **Production / multi-node:** PostgreSQL with the same schema pattern

### Event Store Schema

```sql
CREATE TABLE task_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  aggregate_kind TEXT NOT NULL,          -- "task" | "queue" | "worker"
  stream_id TEXT NOT NULL,              -- taskId | queueId | workerId
  stream_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  command_id TEXT,
  causation_event_id TEXT,
  correlation_id TEXT,
  actor_kind TEXT NOT NULL,             -- "client" | "server" | "worker"
  payload_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_task_events_stream_version
  ON task_events(aggregate_kind, stream_id, stream_version);
CREATE INDEX idx_task_events_stream_sequence
  ON task_events(aggregate_kind, stream_id, sequence);
CREATE INDEX idx_task_events_command_id ON task_events(command_id);

-- Command receipts for idempotency
CREATE TABLE task_command_receipts (
  command_id TEXT PRIMARY KEY,
  aggregate_kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  accepted_at TEXT,
  result_sequence INTEGER NOT NULL,
  status TEXT NOT NULL,                 -- "accepted" | "rejected"
  error TEXT
);

-- Materialized projections for queries
CREATE TABLE task_projections (
  task_id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  worker_id TEXT,
  scheduled_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_task_projections_status ON task_projections(status);
CREATE INDEX idx_task_projections_queue ON task_projections(queue_id, status);
CREATE INDEX idx_task_projections_scheduled ON task_projections(scheduled_at)
  WHERE status = 'queued';
```

### Migration Pattern

From T3 Code -- numbered migration files with idempotent checks:

```typescript
// apps/api/src/persistence/Migrations/001_TaskEvents.ts
export const migration001 = (sql: SqlClient) =>
  sql`
    CREATE TABLE IF NOT EXISTS task_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      -- ...
    );
  `;
```

---

## 10. Reactor Pattern: Decoupled Side Effects

Reactors subscribe to domain events and produce side effects without coupling to the core engine.

### Task Queue Reactors

```
Domain Events (PubSub)
  |
  +--> WorkerDispatchReactor
  |      Listens: task.enqueued, task.retried
  |      Action: Assign task to available worker
  |
  +--> RetryReactor
  |      Listens: task.failed, task.timed-out
  |      Action: Schedule retry with backoff
  |
  +--> NotificationReactor
  |      Listens: task.completed, task.failed (final)
  |      Action: Send webhook, email, Slack notification
  |
  +--> MetricsReactor
  |      Listens: all events
  |      Action: Update Prometheus counters, histograms
  |
  +--> DeadLetterReactor
         Listens: task.failed (maxRetries exceeded)
         Action: Move to dead letter queue
```

### Example: WorkerDispatchReactor

```typescript
// apps/api/src/task/Layers/WorkerDispatchReactor.ts
const make = Effect.gen(function* () {
  const engine = yield* TaskEngineService;
  const workerRegistry = yield* WorkerRegistry;

  const processEvent = (event: TaskEvent) =>
    Effect.gen(function* () {
      if (event.type !== "task.enqueued" && event.type !== "task.retried") return;

      const workers = yield* workerRegistry.getAvailable(event.payload.queueId);
      if (workers.length === 0) return; // Will be picked up when worker becomes available

      const worker = selectWorker(workers, event.payload.priority);

      yield* engine.dispatch({
        type: "task.started",
        commandId: CommandId.makeUnsafe(`server:dispatch:${event.eventId}`),
        taskId: event.payload.taskId,
        workerId: worker.id,
        startedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });

      // Actually send work to worker process
      yield* worker.send({
        type: "execute",
        taskId: event.payload.taskId,
        taskType: event.payload.taskType,
        payload: event.payload.payload,
      });
    });

  const worker = yield* makeDrainableWorker(processEvent);

  yield* Effect.forkScoped(
    Stream.runForEach(engine.streamDomainEvents, (event) =>
      worker.enqueue(event),
    ),
  );

  return { drain: worker.drain };
});

export const WorkerDispatchReactorLive = Layer.scoped(
  WorkerDispatchReactor,
  make,
);
```

### Example: RetryReactor with Exponential Backoff

```typescript
const processEvent = (event: TaskEvent) =>
  Effect.gen(function* () {
    if (event.type !== "task.failed" && event.type !== "task.timed-out") return;

    const readModel = yield* engine.getReadModel();
    const task = readModel.tasks.find((t) => t.id === event.payload.taskId);
    if (!task) return;

    if (task.attemptCount >= task.maxRetries) {
      // Dead letter -- handled by DeadLetterReactor
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s...
    const delay = Math.min(1000 * Math.pow(2, task.attemptCount), 60_000);
    yield* Effect.sleep(`${delay} millis`);

    yield* engine.dispatch({
      type: "task.retry",
      commandId: CommandId.makeUnsafe(`server:retry:${event.eventId}`),
      taskId: task.id,
      createdAt: new Date().toISOString(),
    });
  });
```

---

## 11. Process Management & Worker Orchestration

### Adapted from T3 Code's CodexAppServerManager

T3 Code manages a Codex child process via JSON-RPC over stdio. Your task queue workers follow the same pattern:

```typescript
// apps/api/src/worker/WorkerProcessManager.ts
interface WorkerConnection {
  workerId: WorkerId;
  process: ChildProcess | WebSocket;  // Local process or remote worker
  pending: Map<string, PendingRequest>;
  nextRequestId: number;
}

// JSON-RPC protocol over stdio (local) or WebSocket (remote)
const sendToWorker = (conn: WorkerConnection, task: TaskExecution) =>
  Effect.gen(function* () {
    const id = String(conn.nextRequestId++);
    const request = { jsonrpc: "2.0", id, method: "task.execute", params: task };

    return yield* Effect.async<TaskResult, TaskExecutionError>((resume) => {
      const timeout = setTimeout(() => {
        conn.pending.delete(id);
        resume(Effect.fail(new TaskExecutionError({ detail: "Worker timeout" })));
      }, task.timeout ?? 300_000);

      conn.pending.set(id, {
        resolve: (result) => { clearTimeout(timeout); resume(Effect.succeed(result)); },
        reject: (error) => { clearTimeout(timeout); resume(Effect.fail(error)); },
        timeout,
      });

      conn.process.send(JSON.stringify(request));
    });
  });
```

### Worker Process (Separate App)

```typescript
// apps/worker/src/index.ts
// The worker process that executes tasks

import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  const request = JSON.parse(line);

  if (request.method === "task.execute") {
    try {
      // Report progress
      const sendProgress = (progress: TaskProgress) => {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          method: "task.progress",
          params: { taskId: request.params.taskId, progress },
        }) + "\n");
      };

      // Execute the task
      const result = await executeTask(request.params, { sendProgress });

      // Send result
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result,
      }) + "\n");
    } catch (error) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -1, message: error.message },
      }) + "\n");
    }
  }
});
```

---

## 12. Testing Strategy

### Directly Adopted from T3 Code

#### Integration Test Harness

```typescript
// apps/api/src/task/__tests__/harness.ts
export async function makeTaskQueueHarness() {
  const engineLayer = TaskEngineServiceLive.pipe(
    Layer.provide(TaskProjectionPipelineLive),
    Layer.provide(TaskEventStoreLive),
    Layer.provide(TaskCommandReceiptRepositoryLive),
    Layer.provide(SqlitePersistenceMemory),  // In-memory SQLite!
    Layer.provideMerge(ServerConfig.layerTest("/tmp/test", "/tmp/test/state")),
  );

  const runtime = ManagedRuntime.make(engineLayer);
  const engine = await runtime.runPromise(Effect.service(TaskEngineService));

  return {
    dispatch: (command: TaskCommand) => runtime.runPromise(engine.dispatch(command)),
    getReadModel: () => runtime.runPromise(engine.getReadModel()),
    drain: () => runtime.runPromise(engine.drain()),
    dispose: () => runtime.dispose(),
  };
}
```

#### Effect-Native Test Pattern

```typescript
// apps/api/src/task/__tests__/taskLifecycle.test.ts
import { it, assert } from "@effect/vitest";

describe("Task Lifecycle", () => {
  it.effect("enqueue -> start -> complete", () =>
    Effect.gen(function* () {
      const harness = yield* makeTaskQueueHarness();

      // Enqueue
      yield* harness.dispatch({
        type: "task.enqueue",
        commandId: CommandId.makeUnsafe("cmd-1"),
        taskId: TaskId.makeUnsafe("task-1"),
        queueId: QueueId.makeUnsafe("queue-1"),
        taskType: "email.send",
        payload: { to: "user@example.com", subject: "Hello" },
        priority: "normal",
        maxRetries: 3,
        createdAt: new Date().toISOString(),
      });
      yield* harness.drain();

      let model = yield* harness.getReadModel();
      assert.equal(model.tasks[0].status, "queued");

      // Start
      yield* harness.dispatch({
        type: "task.started",
        commandId: CommandId.makeUnsafe("cmd-2"),
        taskId: TaskId.makeUnsafe("task-1"),
        workerId: WorkerId.makeUnsafe("worker-1"),
        startedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
      yield* harness.drain();

      model = yield* harness.getReadModel();
      assert.equal(model.tasks[0].status, "running");

      // Complete
      yield* harness.dispatch({
        type: "task.completed",
        commandId: CommandId.makeUnsafe("cmd-3"),
        taskId: TaskId.makeUnsafe("task-1"),
        result: { messageId: "msg-123" },
        completedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
      yield* harness.drain();

      model = yield* harness.getReadModel();
      assert.equal(model.tasks[0].status, "completed");
      assert.deepEqual(model.tasks[0].result, { messageId: "msg-123" });
    }),
  );

  it.effect("retry with backoff on failure", () =>
    Effect.gen(function* () {
      const harness = yield* makeTaskQueueHarness();
      // ... test retry logic deterministically with drain()
    }),
  );

  it.effect("idempotent command dispatch", () =>
    Effect.gen(function* () {
      const harness = yield* makeTaskQueueHarness();

      const command = {
        type: "task.enqueue" as const,
        commandId: CommandId.makeUnsafe("cmd-1"),
        // ...
      };

      const result1 = yield* harness.dispatch(command);
      const result2 = yield* harness.dispatch(command);  // Same commandId

      assert.equal(result1.sequence, result2.sequence);  // Same result!
    }),
  );
});
```

#### Key Testing Principles from T3 Code

1. **In-memory SQLite** -- `":memory:"` for test isolation, no cleanup needed
2. **DrainableWorker.drain()** -- Deterministic async: no `setTimeout`, no flaky tests
3. **Layer substitution** -- Swap real services for mocks at the layer level
4. **Pure decider/projector** -- Test business logic without IO
5. **Effect.gen in tests** -- Same compositional style as production code

---

## 13. Frontend Patterns

### Dashboard State Management

Adopt T3 Code's three-store pattern:

```
1. Main Zustand Store     -- Queues, tasks (synced from server read model)
2. Filter/View Store      -- Dashboard filters, view preferences
3. Task Detail Store      -- Per-task detail view state
```

### Server Sync Pattern

```typescript
// apps/dashboard/src/store.ts
export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      queues: [],
      tasks: [],
      tasksHydrated: false,

      syncServerReadModel: (readModel: TaskReadModel) => {
        set((state) => ({
          queues: mergeQueues(state.queues, readModel.queues),
          tasks: mergeTasks(state.tasks, readModel.tasks),
          tasksHydrated: true,
        }));
      },
    }),
    {
      name: "taskqueue:state:v1",
      storage: debouncedLocalStorage(500),
      partialize: (state) => ({
        // Only persist UI preferences, not server data
        expandedQueueIds: state.expandedQueueIds,
        queueOrderIds: state.queueOrderIds,
      }),
    },
  ),
);
```

### React Query for Server Data

```typescript
// apps/dashboard/src/lib/taskReactQuery.ts
export const taskQueryKeys = {
  all: ["tasks"] as const,
  list: (queueId: string, status?: string) => ["tasks", "list", queueId, status] as const,
  detail: (taskId: string) => ["tasks", "detail", taskId] as const,
};

export function taskListQueryOptions(queueId: string, status?: string) {
  return queryOptions({
    queryKey: taskQueryKeys.list(queueId, status),
    queryFn: () => api.task.list({ queueId, status }),
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: "always",
  });
}
```

### Pure Derived State

From T3 Code's `session-logic.ts` pattern:

```typescript
// apps/dashboard/src/task-logic.ts
export function deriveTaskPhase(task: Task): TaskPhase {
  if (task.status === "queued") return "waiting";
  if (task.status === "running") return "active";
  if (task.status === "completed") return "done";
  if (task.status === "failed" && task.attemptCount < task.maxRetries) return "retrying";
  if (task.status === "failed") return "dead";
  if (task.status === "cancelled") return "cancelled";
  return "unknown";
}

export function deriveQueueHealth(queue: Queue, tasks: Task[]): QueueHealth {
  const queueTasks = tasks.filter((t) => t.queueId === queue.id);
  const failed = queueTasks.filter((t) => t.status === "failed").length;
  const total = queueTasks.length;
  if (total === 0) return "idle";
  if (failed / total > 0.5) return "critical";
  if (failed / total > 0.1) return "degraded";
  return "healthy";
}
```

---

## 14. Concrete Task Queue Architecture

### Full System Diagram

```
                          Dashboard (React SPA)
                               |
                          WebSocket + HTTP
                               |
                    +----------+-----------+
                    |    API Server        |
                    |  (Effect-TS Node)    |
                    |                      |
                    |  +----------------+  |
                    |  | Task Engine    |  |    Event Store
                    |  | (Decider +    |--+--> (SQLite/PG)
                    |  |  Projector)   |  |
                    |  +-------+--------+  |
                    |          |           |
                    |     PubSub          |
                    |    /   |   \        |
                    |   v    v    v       |
                    | Worker Retry Notif  |
                    | React  React React  |
                    +---+----+-----------+
                        |    |
                   JSON-RPC  Schedule
                   over      delayed
                   stdio/WS  retry
                        |
              +---------+---------+
              |   Worker Pool     |
              |  (apps/worker)    |
              |                   |
              |  [Worker 1]       |
              |  [Worker 2]       |
              |  [Worker N]       |
              +-------------------+
```

### Read Model Structure

```typescript
interface TaskReadModel {
  snapshotSequence: number;
  updatedAt: string;

  queues: Array<{
    id: QueueId;
    name: string;
    concurrency: number;
    rateLimit: { maxPerSecond: number } | null;
    isPaused: boolean;
    createdAt: string;
    updatedAt: string;
  }>;

  tasks: Array<{
    id: TaskId;
    queueId: QueueId;
    taskType: string;
    status: "queued" | "running" | "completed" | "failed" | "cancelled" | "timed-out";
    priority: "low" | "normal" | "high" | "critical";
    payload: unknown;
    result: unknown | null;
    error: { message: string; stack?: string } | null;
    progress: { percent: number; message: string } | null;
    workerId: WorkerId | null;
    attemptCount: number;
    maxRetries: number;
    scheduledAt: string;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;

  workers: Array<{
    id: WorkerId;
    name: string;
    status: "idle" | "busy" | "offline";
    currentTaskId: TaskId | null;
    lastHeartbeat: string;
    registeredAt: string;
  }>;
}
```

---

## 15. Implementation Roadmap

### Phase 1: Foundation (Week 1-2)

- [ ] Set up monorepo with Bun + Turborepo + oxlint/oxfmt
- [ ] Create `packages/contracts` with branded IDs, task event/command schemas
- [ ] Create `packages/shared` with DrainableWorker, logging, schema helpers
- [ ] Set up TypeScript base config with strict mode
- [ ] Set up CI (format, lint, typecheck, test)

### Phase 2: Core Engine (Week 3-4)

- [ ] Implement event store (SQLite with WAL mode)
- [ ] Implement decider (pure command -> event logic)
- [ ] Implement projector (pure event -> read model logic)
- [ ] Implement TaskEngine (queue + serialized dispatch + PubSub)
- [ ] Implement command receipts for idempotency
- [ ] Write integration tests with in-memory SQLite

### Phase 3: API Server (Week 5-6)

- [ ] HTTP + WebSocket server with Effect
- [ ] Request routing with discriminated union pattern
- [ ] Push bus for real-time task updates
- [ ] Schema validation at all boundaries
- [ ] Server readiness signals

### Phase 4: Worker System (Week 7-8)

- [ ] Worker process (apps/worker) with JSON-RPC protocol
- [ ] WorkerDispatchReactor (assign tasks to workers)
- [ ] RetryReactor (exponential backoff)
- [ ] Worker heartbeat and timeout detection
- [ ] Progress reporting (streaming updates)

### Phase 5: Dashboard (Week 9-10)

- [ ] React + Vite + TanStack Router + Zustand
- [ ] WebSocket transport with reconnection
- [ ] Queue list with health indicators
- [ ] Task list with real-time status updates
- [ ] Task detail view with event timeline

### Phase 6: Production Hardening (Week 11-12)

- [ ] NotificationReactor (webhooks)
- [ ] MetricsReactor (Prometheus)
- [ ] Dead letter queue handling
- [ ] Rate limiting per queue
- [ ] Priority scheduling
- [ ] CLI tool for task management

---

## Appendix: File Reference from T3 Code

These are the key files to study for each pattern:

| Pattern | T3 Code File |
|---------|-------------|
| Monorepo config | `package.json`, `turbo.json`, `tsconfig.base.json` |
| Branded IDs | `packages/contracts/src/baseSchemas.ts` |
| Event schemas | `packages/contracts/src/orchestration.ts` |
| WebSocket protocol | `packages/contracts/src/ws.ts` |
| NativeApi interface | `packages/contracts/src/ipc.ts` |
| Subpath exports | `packages/shared/package.json` |
| DrainableWorker | `packages/shared/src/DrainableWorker.ts` |
| Schema JSON helpers | `packages/shared/src/schemaJson.ts` |
| Decider | `apps/server/src/orchestration/decider.ts` |
| Projector | `apps/server/src/orchestration/projector.ts` |
| Engine | `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` |
| Layer composition | `apps/server/src/serverLayers.ts` |
| Service definition | `apps/server/src/provider/Services/ProviderService.ts` |
| Error patterns | `apps/server/src/provider/Errors.ts` |
| WebSocket server | `apps/server/src/wsServer.ts` |
| Push bus | `apps/server/src/wsServer/pushBus.ts` |
| Readiness signals | `apps/server/src/wsServer/readiness.ts` |
| Event store | `apps/server/src/persistence/Layers/OrchestrationEventStore.ts` |
| SQLite persistence | `apps/server/src/persistence/Layers/Sqlite.ts` |
| Migrations | `apps/server/src/persistence/Migrations/` |
| Reactor example | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` |
| Ingestion reactor | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` |
| Checkpoint reactor | `apps/server/src/orchestration/Layers/CheckpointReactor.ts` |
| Process management | `apps/server/src/codexAppServerManager.ts` |
| Server config | `apps/server/src/config.ts` |
| CLI startup | `apps/server/src/main.ts` |
| Zustand store | `apps/web/src/store.ts` |
| Session logic | `apps/web/src/session-logic.ts` |
| WS transport | `apps/web/src/wsTransport.ts` |
| React Query | `apps/web/src/lib/serverReactQuery.ts` |
| Dev runner | `scripts/dev-runner.ts` |
| Test harness | `apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts` |
| Vite config | `apps/web/vite.config.ts` |
