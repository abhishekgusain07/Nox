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
import { cors } from "hono/cors";
import { createAuth } from "./auth.js";
import { createProjectRoutes } from "./routes/projects.js";
import { createDeploymentRoutes } from "./routes/deployments.js";
import { rateLimitByIp, rateLimitByApiKey } from "./middleware/rate-limit.js";
import { securityHeaders, maxPayloadSize, requestId } from "./middleware/security.js";
import { createAuditLogger } from "./middleware/audit.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://reload:reload@localhost:5432/reload";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const PORT = parseInt(process.env.PORT ?? "3000", 10);

const db = createDb(DATABASE_URL);
const auditLog = createAuditLogger(db);
const auth = createAuth(db);
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
app.use("*", cors({
  origin: process.env.DASHBOARD_URL ?? "http://localhost:3001",
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}));

// Security headers on all responses
app.use("*", securityHeaders());

// Request ID for tracing
app.use("*", requestId());

// Max payload size (10MB)
app.use("/api/*", maxPayloadSize(10 * 1024 * 1024));

// Rate limit unauthenticated endpoints (login, signup)
app.use("/api/auth/*", rateLimitByIp(redis, 20, 60_000));

// Auth middleware — validates API key on all /api/* routes
const authMiddleware = createAuthMiddleware(db);

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Project management routes — session auth (no API key needed)
const projectRoutes = createProjectRoutes(db, auth);
app.route("/api/me", projectRoutes);

// better-auth handles user signup/login/sessions — NO API key required
// Must be AFTER project routes so /api/me/* isn't swallowed
app.all("/api/auth/*", (c) => {
  return auth.handler(c.req.raw);
});

// API key middleware on all other /api/* routes
app.use("/api/*", authMiddleware);

// Rate limit authenticated endpoints by API key
app.use("/api/*", rateLimitByApiKey(redis, 200, 60_000));

// Mount API key management routes (requires API key)
const authRoutes = createAuthRoutes(db);
app.route("/api", authRoutes);

// Mount deployment routes (requires API key)
const deploymentRoutes = createDeploymentRoutes(db);
app.route("/api", deploymentRoutes);

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

export { app, auth, auditLog };
