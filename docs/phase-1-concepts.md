# Phase 1: Core Concepts Deep Dive

This document covers everything you need to understand before writing a single line of code for reload.dev. Read it thoroughly. The goal is not to memorize APIs but to build a mental model of *why* each piece exists and *how* it behaves under pressure.

---

## 1. PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED` — Database-Level Queuing

### What is it?

`SKIP LOCKED` is a clause added to `SELECT ... FOR UPDATE` in PostgreSQL 9.5 (2016). When a query encounters a row that is already locked by another transaction, instead of waiting (the default) or raising an error (`NOWAIT`), it silently skips that row and moves to the next candidate. Combined with `FOR UPDATE`, `LIMIT`, and `ORDER BY`, it turns a regular PostgreSQL table into a concurrent work queue.

### What problem does it solve?

The fundamental challenge in a task queue is **dequeuing**: multiple workers need to pull the next available task without any two workers pulling the same one. There are three naive approaches, and they all fail:

1. **Plain SELECT then UPDATE** -- Two workers SELECT the same row, both see `status = 'pending'`, both UPDATE it to `running`. One worker's work is wasted; the task may execute twice.
2. **SELECT FOR UPDATE (no SKIP LOCKED)** -- The first worker locks the row. The second worker *blocks*, waiting for the lock to release. Workers form a convoy -- serialized, not parallel. Your 10-worker pool behaves like 1 worker.
3. **SELECT FOR UPDATE NOWAIT** -- The second worker gets an error immediately instead of waiting. Better than blocking, but the worker now has to catch the error, retry, and hope a different row is available. Noisy and wasteful.

`SKIP LOCKED` solves this cleanly: the second worker does not wait, does not error -- it just gets a *different* row. Workers operate in true parallel without coordination overhead.

### How does it work under the hood?

#### PostgreSQL Row-Level Locking

PostgreSQL has four row-level lock modes, from strongest to weakest:

| Lock Mode | Acquired By | Conflicts With |
|---|---|---|
| **FOR UPDATE** | `DELETE`, `UPDATE` on key columns, explicit `SELECT FOR UPDATE` | All other row locks |
| **FOR NO KEY UPDATE** | `UPDATE` on non-key columns, explicit `SELECT FOR NO KEY UPDATE` | FOR UPDATE, FOR NO KEY UPDATE, FOR SHARE |
| **FOR SHARE** | Explicit `SELECT FOR SHARE` | FOR UPDATE, FOR NO KEY UPDATE |
| **FOR KEY SHARE** | Foreign key checks | FOR UPDATE only |

For a task queue, `FOR UPDATE` is the correct choice. You want exclusive access -- no other transaction should read, modify, or delete the row while you are processing it.

Internally, PostgreSQL does **not** store row-level locks in a separate lock table. Instead, it writes the locking transaction's XID (transaction ID) into the row's tuple header on the heap page. This means locking a row is a *disk write* (to the heap page and WAL). When another transaction encounters a locked row:

- **Default behavior**: it enters a wait queue using a "heavyweight lock" in shared memory, sleeping until the locking transaction commits or aborts.
- **NOWAIT**: it immediately raises `ERROR: could not obtain lock on row`.
- **SKIP LOCKED**: it silently pretends the row does not exist and continues scanning.

The `SKIP LOCKED` clause only affects row-level locks. The `ROW SHARE` table-level lock (required by any `SELECT ... FOR UPDATE`) is still acquired normally -- this is a lightweight lock that does not block other readers or writers at the table level.

#### The Transaction Lifecycle for Queue Dequeuing

```
BEGIN;
  -- Step 1: Claim a task. Lock it. Skip any already-locked rows.
  SELECT id, payload FROM tasks
    WHERE status = 'pending'
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

  -- Step 2: Mark it as running (so it won't match the WHERE clause for future SELECTs).
  UPDATE tasks SET status = 'running', started_at = now() WHERE id = $1;

  -- Step 3: Process the task in application code...
  -- (This happens outside the SQL, in your worker code.)

  -- Step 4: Mark complete.
  UPDATE tasks SET status = 'completed', completed_at = now() WHERE id = $1;
COMMIT;
```

If the worker crashes at any point between `BEGIN` and `COMMIT`, PostgreSQL automatically aborts the transaction. The lock is released. The row reverts to its pre-transaction state (`status = 'pending'`). The task becomes visible to other workers again. This is automatic and requires zero application code.

#### The CTE Pattern (Single-Statement Dequeue)

The two-step SELECT-then-UPDATE pattern above requires two round-trips to the database within one transaction. A more efficient approach fuses them into a single statement using a CTE:

```sql
WITH next_task AS (
  SELECT id FROM tasks
  WHERE status = 'pending'
  ORDER BY created_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE tasks
SET status = 'running',
    started_at = now(),
    worker_id = $1
FROM next_task
WHERE tasks.id = next_task.id
RETURNING tasks.*;
```

This executes as a single statement. The SELECT and UPDATE happen in one database round-trip. The `RETURNING` clause gives you the full row back so you know what you claimed. This is the pattern used by production systems like Graphile Worker, PgBoss, and Solid Queue.

An alternative form uses a subquery in the `WHERE IN` clause:

```sql
UPDATE tasks
SET status = 'running', started_at = now()
WHERE id IN (
  SELECT id FROM tasks
  WHERE status = 'pending'
  ORDER BY created_at
  LIMIT 10
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

This variant supports batch dequeuing -- claiming 10 tasks at once.

#### At-Least-Once vs At-Most-Once

The semantics depend on *when* you update the status:

- **At-most-once**: Update status to `completed` *before* doing the work. If the worker crashes after the UPDATE but before finishing the work, the task is marked done but never actually processed. No retry. Work is lost.
- **At-least-once**: Do the work *first*, then update status. If the worker crashes after doing the work but before the COMMIT, the transaction rolls back, the task returns to `pending`, and another worker will re-process it. The task executes twice (or more).

Most production systems choose **at-least-once** with idempotent task handlers. It is easier to make a task safe to run twice than to guarantee exactly-once in a distributed system.

#### Performance Characteristics and Ceilings

- **Index requirement**: You need a composite index on `(status, created_at)` -- or whatever columns your `WHERE` and `ORDER BY` use. Without it, PostgreSQL does a sequential scan, locking (and skipping) rows one by one across the entire table.
- **Lock contention**: With many workers polling simultaneously, each `SELECT FOR UPDATE SKIP LOCKED` must scan past all already-locked rows. If 100 workers each hold a lock, worker 101 must examine and skip 100 rows before finding an available one. The index helps, but the skip overhead grows linearly.
- **Connection pressure**: Each polling worker holds a database connection during its transaction. With 50 workers polling every 100ms, you have 50 persistent connections. PostgreSQL connection limits (default: 100) become a bottleneck. Connection poolers like PgBouncer help, but note that PgBouncer in transaction mode breaks `LISTEN/NOTIFY` and prepared statements.
- **WAL growth**: Every `FOR UPDATE` writes to the heap page and generates WAL entries. High-throughput queues with thousands of claims per second produce significant WAL volume, affecting replication lag and disk I/O.
- **Practical ceiling**: PostgreSQL-backed queues handle tens of thousands of jobs per minute comfortably. At hundreds of thousands of jobs per second, you will hit connection limits, WAL pressure, and vacuum overhead. At that scale, consider a dedicated message broker.

#### Comparison to Alternatives Within PostgreSQL

| Approach | Mechanism | Trade-off |
|---|---|---|
| **`SKIP LOCKED`** | Row-level lock, skip contended rows | Best for queue workloads. Simple. Proven. |
| **Advisory locks (`pg_advisory_lock`)** | Application-level locks keyed by bigint | Session-level locks survive transaction boundaries -- a crashed worker can hold a lock until the connection times out. More complex lifecycle management. |
| **`LISTEN/NOTIFY`** | Pub/sub notification channel | Useful for *waking up* workers when new work arrives (avoiding unnecessary polls). But NOTIFY does not distribute work -- all listeners receive the same notification, causing a thundering herd. Must be combined with SKIP LOCKED for actual dequeuing. |
| **Logical replication / CDC** | Stream WAL changes to consumers | Overkill for a task queue. Complex setup. Better suited for data synchronization between systems. |

### Why this choice over alternatives?

**vs Redis BRPOP (BullMQ, Sidekiq)**: Redis queues are fast -- BullMQ peaks at ~27K jobs/sec vs ~4.4K for PostgreSQL-based Oban at 100 concurrency. But Redis adds operational complexity: a separate data store to back up, monitor, and keep consistent with your application database. If a task is enqueued in Redis but the triggering database transaction rolls back, you have a phantom task. With PostgreSQL, enqueueing and the business transaction share the same ACID transaction. For reload.dev in Phase 1, using the same database for tasks and application data eliminates an entire category of consistency bugs.

**vs Amazon SQS**: SQS is a managed service with infinite scalability. But it introduces network latency per dequeue (50-100ms), costs money per API call, does not support transactional enqueue with your database, and removes your ability to query the queue with SQL (e.g., "show me all failed tasks for user X"). For a self-hosted queue where you want full visibility and control, PostgreSQL is superior.

**vs Simple SELECT + UPDATE (no locking)**: Race conditions. Two workers claim the same task. You will see duplicate executions in production within minutes of deployment.

### How do production systems use this?

- **Graphile Worker** (Node.js): Uses a CTE with `FOR UPDATE SKIP LOCKED` in a PostgreSQL function to claim jobs. Combines with `LISTEN/NOTIFY` so workers wake up immediately when new jobs are inserted, reducing poll latency.
- **Oban** (Elixir): Queries for `available` jobs filtered by queue name, ordered by priority and scheduled time, with `FOR UPDATE SKIP LOCKED`. Claims and status update happen in a single transaction.
- **Solid Queue** (Ruby on Rails): Rails' default job backend since Rails 8. Uses `SKIP LOCKED` for its `ClaimedExecution` mechanism.
- **PgBoss** (Node.js): Uses `SKIP LOCKED` with batch claiming and exponential backoff polling.
- **Trigger.dev**: Uses Graphile Worker for internal PostgreSQL-based task processing alongside Redis for high-throughput task queues.

### Resources

- [PostgreSQL Official Docs: Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html) -- The authoritative reference for all lock modes.
- [The Unreasonable Effectiveness of SKIP LOCKED](https://www.inferable.ai/blog/posts/postgres-skip-locked) -- Excellent walkthrough from naive approach to production CTE pattern.
- [PostgreSQL FOR UPDATE SKIP LOCKED: The One-Liner Job Queue](https://www.dbpro.app/blog/postgresql-skip-locked) -- Concise introduction with performance tips.
- [Solid Queue & Understanding UPDATE SKIP LOCKED](https://www.bigbinary.com/blog/solid-queue) -- How Rails' Solid Queue implements the pattern.
- [Oban Source Code: basic_engine.ex](https://github.com/oban-bg/oban/blob/f4f75a2e9af5e400e36d718fc4b6c4b822ab05d7/lib/oban/queue/basic_engine.ex) -- Real production SKIP LOCKED queries in Elixir.
- [Graphile Worker Source Code](https://github.com/graphile/worker) -- Node.js PostgreSQL job queue with SKIP LOCKED.
- [CYBERTEC: Row Locks in PostgreSQL](https://www.cybertec-postgresql.com/en/row-locks-in-postgresql/) -- Deep dive into PostgreSQL lock internals.
- [Postgres Locks: A Deep Dive (Hussein Nasser)](https://medium.com/@hnasr/postgres-locks-a-deep-dive-9fc158a5641c) -- Internals of how PostgreSQL implements locking.
- [Neon Guides: Queue System using SKIP LOCKED](https://neon.com/guides/queue-system) -- Practical tutorial with full code.
- [Implementing a Postgres Job Queue (Amine Diro)](https://aminediro.com/posts/pg_job_queue/) -- Building a job queue from scratch with SKIP LOCKED.

### Questions to test understanding

1. What happens if two workers execute `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` at the exact same instant? Will they get the same row?
2. Worker A claims a task with `FOR UPDATE SKIP LOCKED`, then the worker process is killed by the OS (SIGKILL). What happens to the locked row? When does it become available again?
3. Why is the CTE pattern (`WITH next AS (SELECT ... FOR UPDATE SKIP LOCKED) UPDATE ... FROM next`) better than a separate SELECT followed by a separate UPDATE in the same transaction?
4. You have 1,000 pending tasks and 50 workers polling simultaneously. The 50th worker must skip 49 locked rows. What index makes this efficient? What happens without that index?
5. Explain the difference between `FOR UPDATE` and `FOR NO KEY UPDATE`. When would you choose one over the other for a task queue?
6. Why does `SKIP LOCKED` provide an "inconsistent view" of the data? Why is that acceptable for a queue but not for a bank transfer?
7. If you enqueue a task inside a business logic transaction that later rolls back, what happens to the task? How does this compare to enqueuing to Redis inside the same code path?
8. What is the practical throughput ceiling for a PostgreSQL-backed queue, and what are the bottlenecks that cause it?
9. Why can't `LISTEN/NOTIFY` alone replace `SKIP LOCKED` for distributing work?
10. Your queue table has 10 million completed rows and 5 pending rows. How does this affect dequeue performance? What should you do about it?

---

## 2. The Polling Dequeue Pattern — How Workers Pull Work

### What is it?

The polling dequeue pattern is a **pull-based** architecture where workers repeatedly query the database for available tasks at a regular interval. The worker loop looks like: poll, claim a task (or get nothing), process, repeat.

### What problem does it solve?

Workers need to know when there is work to do. There are two fundamental approaches:

- **Push-based**: The server sends work to workers (via WebSockets, callbacks, pub/sub). The server must track which workers are alive, available, and not overloaded. This is complex state management.
- **Pull-based (polling)**: Workers ask for work when they are ready. No central coordinator needed. Workers self-regulate -- a slow worker just polls less frequently. A crashed worker just stops polling; no cleanup needed.

For a database-backed queue, polling is natural: the database is the source of truth, and workers query it directly.

### How does it work under the hood?

#### The Basic Poll Loop

```typescript
while (running) {
  const task = await dequeue();  // SELECT ... FOR UPDATE SKIP LOCKED
  if (task) {
    await process(task);
    await markComplete(task.id);
  } else {
    await sleep(pollInterval);
  }
}
```

The critical nuance is: **when no work is found, sleep before polling again**. Without the sleep, an idle worker hammers the database with thousands of empty queries per second.

#### Adaptive Polling

A fixed poll interval is wasteful. When the queue is full, you want to poll immediately after finishing a task. When the queue is empty, you want to slow down to reduce database load.

```typescript
let interval = BASE_INTERVAL;  // e.g., 100ms

while (running) {
  const task = await dequeue();
  if (task) {
    interval = BASE_INTERVAL;   // Reset: there might be more work
    await process(task);
    await markComplete(task.id);
  } else {
    interval = Math.min(interval * 2, MAX_INTERVAL);  // Back off: 100 -> 200 -> 400 -> ... -> 5000ms
    await sleep(interval);
  }
}
```

This is exponential backoff with a cap. Graphile Worker and Solid Queue both use variants of this pattern.

#### The Thundering Herd Problem

If 50 workers all poll at the same 1-second interval and they all started at the same time, they will all hit the database simultaneously every second. This creates a spike of 50 concurrent queries followed by 950ms of silence.

Solutions:
- **Jitter**: Add a random delay to each poll. Instead of sleeping exactly 1000ms, sleep `1000 + random(0, 200)ms`. Workers naturally spread out over time.
- **SKIP LOCKED**: Even if 50 workers query simultaneously, each gets a different row (or nothing). There is no wasted work. The database handles the concurrency at the row-lock level.
- **Staggered startup**: Start workers with a random initial delay so they do not synchronize.

Solid Queue adds 100ms of jitter by default. The combination of jitter + SKIP LOCKED makes thundering herd a non-issue for moderate worker counts (< 100).

#### Long Polling vs Short Polling vs Blocking Pop

| Approach | Mechanism | Latency | DB Load |
|---|---|---|---|
| **Short polling** | Query every N ms | Up to N ms | Higher (many empty queries when idle) |
| **Long polling** | Hold the connection open until work arrives or timeout | Near-zero when work exists | Lower (fewer queries), but holds connections |
| **Blocking pop (BRPOP)** | Redis-specific: block on a list until an element arrives | Near-zero | Minimal (connection is idle while waiting) |

PostgreSQL does not natively support blocking pop on a table. You can approximate it with `LISTEN/NOTIFY` + `SKIP LOCKED`: the worker sleeps until a notification arrives, then dequeues. This gives near-zero latency without constant polling, but adds complexity (managing LISTEN connections, handling missed notifications).

For Phase 1, short polling with adaptive backoff is the right choice. It is simple, debuggable, and the latency (100-500ms) is acceptable for a task queue.

#### Connection Pooling Considerations

Each polling worker needs a database connection during its poll-and-process cycle. Key considerations:

- **Transaction duration**: Keep transactions short. Claim the task, update its status, commit. Then process it. Do not hold a transaction open for the entire processing duration -- this holds a connection *and* a row lock for too long.
- **Pool size**: Your connection pool should have at least as many connections as you have concurrent workers. With `pg` in Node.js, set `max` to your worker count.
- **PgBouncer**: If you need more workers than PostgreSQL's `max_connections`, put PgBouncer in front. Use transaction-level pooling. Be aware that `LISTEN/NOTIFY` does not work through PgBouncer in transaction mode.

### Why this choice over alternatives?

**vs Push-based (WebSocket/callback)**: Push requires a coordinator that knows about all workers, tracks their health, and load-balances work. That coordinator is a single point of failure and complex to build. Polling requires no coordinator -- each worker independently pulls from the shared database.

**vs Event-driven (LISTEN/NOTIFY only)**: LISTEN/NOTIFY wakes all workers when a single task is added. 49 out of 50 workers wake up for nothing. This is the thundering herd problem. LISTEN/NOTIFY is useful *on top of* polling (to reduce idle polling), but it cannot replace polling for work distribution.

### Resources

- [Scaling Slack's Job Queue](https://slack.engineering/scaling-slacks-job-queue/) -- How Slack evolved their queue from simple polling to a sophisticated multi-tier system.
- [db-queue (Java)](https://github.com/yoomoney/db-queue) -- A well-documented database queue library with configurable polling strategies.
- [Solid Queue Source Code](https://github.com/rails/solid_queue) -- Rails' production job queue with adaptive polling and jitter.
- [Why a Database is Not Always the Right Tool for a Queue](https://www.cloudamqp.com/blog/why-is-a-database-not-the-right-tool-for-a-queue-based-system.html) -- Honest assessment of when database queues break down.

### Questions to test understanding

1. Why does a polling worker sleep when no work is found, instead of immediately polling again?
2. Describe the adaptive polling strategy: what happens to the interval when work is found vs not found?
3. You have 100 workers with a 500ms poll interval and the queue processes 10 tasks/sec. How many empty polls per second hit the database? How would jitter help?
4. Why is it important to commit the transaction (releasing the row lock) *before* processing the task payload, if task processing takes minutes?
5. A worker claims a task, commits the status change to `running`, then crashes before completing. How do you detect and recover this "stuck" task?

---

## 3. Hono Framework — Routing, Middleware, Context

### What is it?

Hono is a lightweight web framework built on the Web Standards API (the `Request`/`Response` model from the Fetch specification). It runs on any JavaScript runtime: Node.js, Deno, Bun, Cloudflare Workers, AWS Lambda. Its router is extremely fast -- benchmarks show ~400K ops/sec on Cloudflare Workers, and it consistently outperforms Express and competes with Fastify in Node.js benchmarks.

### What problem does it solve?

reload.dev needs an HTTP API layer to accept task enqueue requests, serve a dashboard, and expose health/status endpoints. The framework must be lightweight (this is infrastructure, not a full web app), type-safe (TypeScript-first), and fast (API endpoints on the critical path of task submission).

### How does it work under the hood?

**Routing**: Hono uses a trie-based router (RegExpRouter or SmartRouter) that compiles route patterns into optimized regular expressions at startup. Route matching is O(1) against the compiled pattern, not O(n) against a list of routes. This is why it benchmarks so well.

**Middleware**: Hono's middleware follows the onion model (like Koa). Each middleware calls `await next()` to pass control to the next middleware, then can act on the response afterward. The key difference from Express: middleware and handlers use the Fetch API `Request` and `Response` objects, not Node.js-specific `req`/`res`.

**Context (`c`)**: Every handler receives a `Context` object that wraps the request and provides helpers:
- `c.req` -- the incoming request with parsed parameters, query strings, headers
- `c.json()` -- return a JSON response
- `c.text()` -- return a text response
- `c.set()` / `c.get()` -- typed key-value storage scoped to the request lifecycle (for passing data between middleware and handlers)

**Type safety**: Hono infers route parameter types from the path pattern. If your route is `/tasks/:id`, the handler knows `c.req.param('id')` is a string. With the RPC mode and `hc` client, you get end-to-end type safety from route definition to client call.

### Why this choice over alternatives?

**vs Express**: Express is 14 years old and does not support TypeScript natively. Its callback-based middleware predates async/await. Performance is 2-3x slower than Hono in benchmarks. Express is tied to Node.js; Hono runs everywhere.

**vs Fastify**: Fastify is fast and has a good plugin system, but it is Node.js-specific. Its schema validation uses JSON Schema, not TypeScript types. Hono's TypeScript integration is tighter and its multi-runtime support means you can deploy the same code to Cloudflare Workers or Bun without changes.

**vs tRPC**: tRPC is excellent for client-server type safety but is not a general web framework. It does not handle raw HTTP routes, static files, or arbitrary middleware well. Hono can serve as the HTTP layer underneath tRPC if needed.

### How do production systems use this?

Hono is used in production at Cloudflare (internal tooling), by Deno Deploy as a recommended framework, and by a growing number of TypeScript API servers that need to deploy across multiple runtimes. For reload.dev, Hono serves as the thin HTTP layer that receives task submissions and exposes queue status.

### Resources

- [Hono Documentation](https://hono.dev/docs/) -- Official docs, well-written.
- [Hono GitHub Repository](https://github.com/honojs/hono) -- Source code; the router implementation is educational.
- [Hono Benchmarks](https://hono.dev/docs/concepts/benchmarks) -- Performance comparisons.
- [Hono vs Fastify (Better Stack)](https://betterstack.com/community/guides/scaling-nodejs/hono-vs-fastify/) -- Detailed comparison with code examples.
- [Comparing Hono, Express, and Fastify (Red Sky Digital)](https://redskydigital.com/us/comparing-hono-express-and-fastify-lightweight-frameworks-today/) -- Practical comparison.

### Questions to test understanding

1. What is the Web Standards API (Fetch API) and why does building on it make Hono runtime-agnostic?
2. How does Hono's middleware execution model differ from Express's?
3. What does `c.set('key', value)` do, and how is it typed?
4. Why would you choose Hono over Fastify for a project that only runs on Node.js?
5. How does Hono's router achieve higher throughput than Express's router?

---

## 4. Drizzle ORM — Schema Definition, Migrations, Queries

### What is it?

Drizzle is a TypeScript ORM that maps closely to SQL. Unlike Prisma, which invents its own query language, Drizzle's API mirrors SQL syntax. If you know SQL, you know Drizzle. It has two core components: **Drizzle ORM** (the query builder and runtime) and **Drizzle Kit** (the CLI for generating and running migrations).

### What problem does it solve?

reload.dev needs to define a database schema (tasks table, queues table, etc.), generate migrations, and execute queries. The ORM must:
- Let us write the `FOR UPDATE SKIP LOCKED` query (many ORMs do not expose lock clauses)
- Generate correct TypeScript types from the schema (so `task.status` is `'pending' | 'running' | 'completed'`, not `string`)
- Produce SQL we can inspect and understand (not a black box)

### How does it work under the hood?

**Schema definition**: You define tables in TypeScript using `pgTable`:

```typescript
import { pgTable, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';

export const taskStatus = pgEnum('task_status', ['pending', 'running', 'completed', 'failed']);

export const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  status: taskStatus('status').notNull().default('pending'),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
});
```

This schema is the single source of truth. From it, Drizzle infers:
- `typeof tasks.$inferSelect` -- the TypeScript type for a row read from the database
- `typeof tasks.$inferInsert` -- the TypeScript type for an INSERT (with optional fields for defaults)

**Migrations**: `drizzle-kit generate` reads your schema files and compares them to the previous migration state. It produces a `.sql` migration file with the exact DDL statements. You can inspect, edit, and version-control these files. `drizzle-kit migrate` applies pending migrations to the database.

**Queries**: Drizzle has two query APIs:

1. **SQL-like API** (recommended for queues):
```typescript
const result = await db.select()
  .from(tasks)
  .where(eq(tasks.status, 'pending'))
  .orderBy(tasks.createdAt)
  .limit(1)
  .for('update', { skipLocked: true });
```

2. **Relational API** (for nested/joined data):
```typescript
const result = await db.query.tasks.findFirst({
  where: eq(tasks.status, 'pending'),
  with: { queue: true },
});
```

The SQL-like API generates SQL that is nearly identical to what you would write by hand. You can call `.toSQL()` on any query to see the generated SQL before executing it.

**Raw SQL escape hatch**: For the CTE dequeue pattern, you can use `db.execute(sql\`...\`)` with Drizzle's tagged template literal, which provides parameterized queries with SQL injection protection.

### Why this choice over alternatives?

**vs Prisma**: Prisma uses a custom schema language (`.prisma` files), requires a code generation step (`prisma generate`), and its query API abstracts away SQL too aggressively. Critically, Prisma does not natively support `FOR UPDATE SKIP LOCKED` -- you must use `$queryRaw` for lock clauses, losing all type safety. Drizzle supports `.for('update', { skipLocked: true })` as a first-class API. Drizzle's bundle size (~7.4KB) is a fraction of Prisma's runtime.

**vs Knex**: Knex is a mature query builder but has weak TypeScript support. Types are bolted on rather than inferred from schemas. Knex also requires separate tools for migration generation -- it does not derive migrations from a schema definition.

**vs Raw SQL (pg driver)**: Raw SQL gives full control but zero type safety. You get `any` types back from queries, and schema changes silently break queries at runtime instead of compile time.

### How do production systems use this?

Drizzle is used in production by T3 Stack projects, Turso (the LibSQL company), and a growing number of TypeScript backends. Its ability to generate clean SQL makes it suitable for performance-critical paths like queue dequeuing, where you need to know exactly what query is hitting the database.

### Resources

- [Drizzle ORM Documentation: Schema Declaration](https://orm.drizzle.team/docs/sql-schema-declaration) -- Defining tables, columns, and constraints.
- [Drizzle ORM: PostgreSQL Column Types](https://orm.drizzle.team/docs/column-types/pg) -- All supported column types.
- [Drizzle ORM: Select Queries](https://orm.drizzle.team/docs/select) -- Query API reference.
- [Drizzle vs Prisma (Better Stack)](https://betterstack.com/community/guides/scaling-nodejs/drizzle-vs-prisma/) -- Detailed comparison.
- [Drizzle vs Prisma 2026 (Bytebase)](https://www.bytebase.com/blog/drizzle-vs-prisma/) -- Practical comparison with migration workflows.
- [Drizzle ORM GitHub](https://github.com/drizzle-team/drizzle-orm) -- Source code and examples.

### Questions to test understanding

1. How does `tasks.$inferSelect` differ from `tasks.$inferInsert`? Why are both needed?
2. Write the Drizzle query for `SELECT * FROM tasks WHERE status = 'pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`.
3. What SQL does `drizzle-kit generate` produce when you add a new column with a default value to an existing table?
4. Why is Drizzle a better fit than Prisma for a project that needs `FOR UPDATE SKIP LOCKED`?
5. What does `.toSQL()` return, and when would you use it?

---

## 5. pnpm Workspaces + Turborepo — Monorepo Setup

### What is it?

**pnpm workspaces** allow multiple packages to coexist in a single repository, sharing dependencies efficiently through pnpm's content-addressable store and hard links. **Turborepo** is a build orchestrator that understands the dependency graph between workspace packages, caches build outputs, and runs tasks in parallel where possible.

### What problem does it solve?

reload.dev is not a single package. It has multiple concerns that should be separate packages:
- `@reload/core` -- schema definitions, types, queue logic
- `@reload/worker` -- the polling worker runtime
- `@reload/api` -- the HTTP API (Hono)
- `@reload/dashboard` -- the web UI (later phases)

Without a monorepo, each package is a separate repository with its own CI, versioning, and release cycle. Cross-package changes require coordinated PRs across repos. With a monorepo, a single commit can change the schema, update the worker, and fix the API -- and CI verifies everything works together.

### How does it work under the hood?

#### pnpm Workspaces

The monorepo root contains a `pnpm-workspace.yaml`:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

This tells pnpm that every directory matching these globs is a workspace package. When package `@reload/worker` declares `"@reload/core": "workspace:*"` as a dependency, pnpm resolves it to the local package via a symlink, not an npm registry download.

**The `workspace:*` protocol**: This is a special version specifier that tells pnpm "resolve this to whatever version the local package has." During development, it creates a symlink. During `pnpm publish`, it is replaced with the actual version number (e.g., `"@reload/core": "^1.2.3"`). The `workspace:^` and `workspace:~` variants control whether the replacement uses caret or tilde ranges.

**Subpath exports**: Each package's `package.json` can define `exports` to control what consumers can import:

```json
{
  "name": "@reload/core",
  "exports": {
    ".": "./src/index.ts",
    "./schema": "./src/schema.ts",
    "./types": "./src/types.ts"
  }
}
```

Consumers import `@reload/core/schema` and get exactly that module, not the entire package. This enforces clean boundaries between modules.

#### Turborepo

Turborepo reads your workspace structure and the `turbo.json` configuration:

```json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "persistent": true
    },
    "test": {
      "dependsOn": ["build"]
    }
  }
}
```

`"dependsOn": ["^build"]` means "before building this package, build all of its workspace dependencies first." Turborepo constructs a directed acyclic graph (DAG) of tasks, executes leaves in parallel, and caches outputs based on a hash of inputs (source files, environment variables, dependency versions).

**Caching**: If nothing changed in `@reload/core` since the last build, `turbo run build` replays the cached output in milliseconds. On a CI server, you can use remote caching to share build artifacts across machines.

**Parallel execution**: Independent packages build simultaneously. If `@reload/worker` and `@reload/api` both depend on `@reload/core`, Turborepo builds `core` first, then builds `worker` and `api` in parallel.

### Why this choice over alternatives?

**vs Nx**: Nx is more opinionated and heavier. It includes code generators, project graph visualization, and plugin systems. Turborepo is simpler -- it does task orchestration and caching, nothing more. For a project of reload.dev's size, Turborepo's simplicity is an advantage.

**vs Lerna**: Lerna was the original JavaScript monorepo tool, primarily for versioning and publishing. Its task running was slow and did not have caching. Lerna is now maintained by Nx, but Turborepo's caching and parallel execution are superior for development workflows.

**vs npm/yarn workspaces**: npm and yarn support workspaces natively, but pnpm's content-addressable store uses significantly less disk space (hard links instead of copies) and is stricter about phantom dependencies -- if a package does not declare a dependency, it cannot import it, even if another package in the workspace installed it. This strictness catches real bugs.

### Resources

- [pnpm Workspaces Documentation](https://pnpm.io/workspaces) -- Official reference.
- [Turborepo: Structuring a Repository](https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository) -- Official guide to monorepo layout.
- [How Nhost Configured pnpm and Turborepo](https://nhost.io/blog/how-we-configured-pnpm-and-turborepo-for-our-monorepo) -- Real-world setup walkthrough.
- [Complete Monorepo Guide: pnpm + Workspace + Changesets](https://jsdev.space/complete-monorepo-guide/) -- End-to-end tutorial.
- [Setting Up a Scalable Monorepo with Turborepo and pnpm (DEV Community)](https://dev.to/hexshift/setting-up-a-scalable-monorepo-with-turborepo-and-pnpm-4doh) -- Step-by-step with examples.

### Questions to test understanding

1. What does `"workspace:*"` resolve to at install time vs at publish time?
2. Package A depends on Package B (`workspace:*`). You change a file in Package B. What does `turbo run build` do?
3. What is a phantom dependency, and how does pnpm's strict mode prevent it?
4. Why use subpath exports in `package.json` instead of just exporting everything from the package root?
5. You add a new package `@reload/shared`. What files do you need to create/modify for it to be recognized by pnpm workspaces and Turborepo?

---

## 6. Branded Types with Zod — Type-Level Safety for IDs

### What is it?

A branded type is a TypeScript pattern that makes structurally identical types nominally distinct. In plain terms: `TaskId` and `QueueId` are both strings at runtime, but TypeScript treats them as incompatible types at compile time. You cannot pass a `TaskId` where a `QueueId` is expected. Zod's `.brand()` method combines this compile-time branding with runtime validation.

### What problem does it solve?

A task queue has many string IDs: task IDs, queue IDs, worker IDs, run IDs. They are all `string` at the TypeScript level. Without branding:

```typescript
function getTask(taskId: string): Task { ... }
function getQueue(queueId: string): Queue { ... }

const queueId = 'queue_abc123';
getTask(queueId);  // No error! But completely wrong.
```

This is a category of bug that causes silent data corruption -- you query the tasks table with a queue ID, get no results (or worse, get wrong results if IDs collide), and spend hours debugging.

### How does it work under the hood?

#### The Phantom Brand Pattern

TypeScript uses structural typing: two types are compatible if they have the same shape. To make two `string` types incompatible, you intersect `string` with a phantom property that exists only in the type system:

```typescript
type TaskId = string & { readonly __brand: 'TaskId' };
type QueueId = string & { readonly __brand: 'QueueId' };

// At runtime, these are just strings. The __brand property does not exist.
// At compile time, they are incompatible types.

function getTask(id: TaskId): Task { ... }

const queueId = 'queue_abc' as QueueId;
getTask(queueId);  // Compile error: QueueId is not assignable to TaskId
```

The `__brand` property is never assigned at runtime. It is a phantom type -- it exists only in TypeScript's type checker. The `as TaskId` cast is the "trust boundary" where you assert that a plain string is actually a valid TaskId.

#### Zod's `.brand()` Method

Zod improves on the raw pattern by combining runtime validation with branding:

```typescript
import { z } from 'zod';

const TaskId = z.string()
  .min(1)
  .startsWith('task_')
  .brand<'TaskId'>();

type TaskId = z.infer<typeof TaskId>;  // string & { __brand: 'TaskId' }

// Runtime validation + branding in one step:
const id = TaskId.parse('task_abc123');  // Returns a TaskId (branded string)
TaskId.parse('queue_abc123');            // Throws ZodError: does not start with 'task_'
TaskId.parse('');                        // Throws ZodError: too short
```

**At compile time**: `TaskId` is `string & { __brand: 'TaskId' }`. It is incompatible with `QueueId` or plain `string`.

**At runtime**: `TaskId.parse()` validates the format (prefix, length, etc.) and returns the branded type. If validation fails, it throws an error.

#### The Pattern: Validate at Boundaries, Trust Internally

The key architectural insight: you only need to validate and brand at the system boundaries -- where external input enters your system (API endpoints, database reads, config files). Inside your system, you pass `TaskId` around and the type system guarantees it was validated.

```typescript
// Boundary: API endpoint
app.post('/tasks', async (c) => {
  const body = CreateTaskSchema.parse(await c.req.json());  // Validates and brands
  await enqueueTask(body.queueId, body.payload);  // queueId is QueueId, not string
});

// Internal: no validation needed, type system enforces correctness
async function enqueueTask(queueId: QueueId, payload: unknown): Promise<TaskId> {
  // If someone passes a TaskId here, TypeScript catches it at compile time
}
```

### Why this choice over alternatives?

**vs Plain string types**: No compile-time protection. ID mixups are silent bugs that reach production.

**vs Wrapper objects (class TaskId { constructor(public value: string) {} })**: Adds runtime overhead (object allocation), requires `.value` access everywhere, does not serialize cleanly to JSON, and is cumbersome in database queries.

**vs Template literal types (`type TaskId = \`task_\${string}\``)**: Provides some compile-time checking but no runtime validation. Does not catch `'task_'` (empty suffix) or other format violations.

**vs Zod `.brand()`**: Gives you both compile-time branding and runtime validation in a single, composable schema definition. Since reload.dev already uses Zod for request validation, adding `.brand()` is zero additional dependencies.

### How do production systems use this?

Branded types are used in:
- **Stripe's API client**: Internal IDs like `cus_...`, `sub_...`, `pi_...` are branded at the type level.
- **Effect-TS**: Uses branded types extensively throughout its ecosystem.
- **tRPC + Zod patterns**: Validate and brand at the router boundary, trust internally.

### Resources

- [Stop Treating All IDs as Strings: Branded Types with Zod (Kumar Jyotirmay)](https://medium.com/@jmytwenty8/stop-treating-all-ids-as-strings-a-guide-to-branded-types-with-zod-beddabd9a065) -- Practical guide to the exact pattern we use.
- [Branded Types & Zod: The Senior Engineer's Secret (Gerardo Perrucci)](https://www.gperrucci.com/blog/typescript/branded-types-zod-senior-engineer-secret-safety) -- Why branded types matter in real systems.
- [Branded Types in TypeScript: Techniques (DEV Community / Saleor)](https://dev.to/saleor/branded-types-in-typescript-techniques-340f) -- Survey of all techniques: intersection, unique symbol, Zod.
- [Type Branding with Zod (Steve Kinney)](https://stevekinney.com/courses/full-stack-typescript/type-branding-with-zod) -- Video course excerpt on the topic.
- [Implementing the Newtype Pattern with Zod (DEV Community)](https://dev.to/tumf/implementing-the-newtype-pattern-with-zod-enhancing-type-safety-in-typescript-5c62) -- The functional programming perspective.
- [Zod GitHub: .brand() Documentation](https://github.com/colinhacks/zod) -- Official source.

### Questions to test understanding

1. What is the difference between structural typing and nominal typing? Which does TypeScript use by default, and how do branded types change that?
2. Does the `__brand` property exist at runtime? What would `JSON.stringify(taskId)` produce?
3. Where in the system should you call `TaskId.parse()`? Where should you *not* need to call it?
4. You have a function `deleteTask(id: TaskId)`. A colleague passes `'task_abc' as TaskId` (a raw cast) without validation. What is the risk, and how would you prevent it in a code review?
5. Why is Zod `.brand()` better than a plain `as TaskId` cast for system boundaries?
6. If you read a task ID from the database, is it already branded? What do you need to do?
7. Can you use branded types with Drizzle ORM's `$inferSelect`? How would you bridge the gap between Drizzle's inferred types and your branded types?

---

## Bringing It All Together

These six concepts are not independent. They form a coherent architecture:

1. **pnpm + Turborepo** structure the codebase into packages with clean boundaries.
2. **Drizzle ORM** defines the schema (tasks, queues) and generates migrations.
3. **Branded types with Zod** ensure that IDs are validated at system boundaries and type-safe internally.
4. **Hono** provides the HTTP API layer where tasks are enqueued (and where Zod validation + branding happens).
5. **PostgreSQL SKIP LOCKED** is the engine that makes concurrent task dequeuing correct and efficient.
6. **The polling pattern** is how workers pull tasks from the database using SKIP LOCKED, with adaptive backoff to balance latency and database load.

The data flow for a single task:

```
Client -> Hono API (validate with Zod, brand IDs)
  -> Drizzle INSERT into tasks table
  -> COMMIT

Worker poll loop:
  -> Drizzle SELECT ... FOR UPDATE SKIP LOCKED
  -> Claim task, COMMIT
  -> Process task
  -> Drizzle UPDATE status = 'completed', COMMIT
```

Every concept in this document exists to make one part of that flow correct, fast, and maintainable. Understand each piece deeply, and the implementation will follow naturally.
