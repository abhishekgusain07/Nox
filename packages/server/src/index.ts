import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import Redis from "ioredis";
import { createDb, schema } from "./db/index.js";
import { createPgQueue } from "./queue/pg-queue.js";
import {
  createRunEngine,
  createDelayedScheduler,
  createRedisQueue,
  createConcurrencyTracker,
  createHeartbeatMonitor,
  createTtlChecker,
  createWaitpointResolver,
  createDurationScheduler,
} from "@reload-dev/engine";
import { createRoutes } from "./routes/index.js";
import { createStreamRoutes } from "./routes/stream.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createAuthRoutes } from "./routes/auth.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://reload:reload@localhost:5432/reload";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const PORT = parseInt(process.env.PORT ?? "3000", 10);

const db = createDb(DATABASE_URL);
const pgQueue = createPgQueue(db);

// Redis setup (Phase 3)
const redis = new Redis(REDIS_URL);
const redisQueue = createRedisQueue(redis);
const concurrency = createConcurrencyTracker(redis);

const engine = createRunEngine({ db, schema, pgQueue, redisQueue, concurrency });

// Waitpoint resolver (resolves child runs, tokens, durations)
const waitpointResolver = createWaitpointResolver({ db, schema, engine });

// Start duration wait scheduler (promotes SUSPENDED -> QUEUED when resumeAfter elapses)
const durationScheduler = createDurationScheduler({
  db, schema, resolver: waitpointResolver, pollIntervalMs: 1000,
});
durationScheduler.start().catch(console.error);

// Start delayed run scheduler (promotes DELAYED -> QUEUED when backoff expires)
const scheduler = createDelayedScheduler({ db, schema, engine, pollIntervalMs: 1000 });
scheduler.start().catch(console.error);

// Start heartbeat monitor (checks every 15s for stale EXECUTING runs)
const heartbeatMonitor = createHeartbeatMonitor({ db, schema, engine, pollIntervalMs: 15_000 });
heartbeatMonitor.start().catch(console.error);

// Start TTL checker (checks every 5s for expired QUEUED runs)
const ttlChecker = createTtlChecker({ db, schema, engine, pollIntervalMs: 5_000 });
ttlChecker.start().catch(console.error);

const app = new Hono();
app.use("*", logger());

// Auth middleware — validates API key on all /api/* routes
const authMiddleware = createAuthMiddleware(db);

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Auth middleware on all /api/* routes (except health check which is at /health)
app.use("/api/*", authMiddleware);

// Mount auth routes (key management)
const authRoutes = createAuthRoutes(db);
app.route("/api", authRoutes);

// Mount API routes
const routes = createRoutes(db, pgQueue, engine, { redisQueue, concurrency, waitpointResolver });
app.route("/api", routes);

// Mount SSE streaming routes
const streamRoutes = createStreamRoutes(db, DATABASE_URL);
app.route("/api", streamRoutes);

console.log(`reload.dev server starting on port ${PORT}`);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`reload.dev server running at http://localhost:${info.port}`);
});

export { app };
