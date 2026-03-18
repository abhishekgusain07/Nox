# Roadmap: From Local Tool to Publishable Platform

## Current State (audit summary)

- All 6 packages work for single-tenant local development
- Zero authentication — all 40+ API endpoints are open
- Zero multi-tenancy — no project/org scoping on any table
- Zero deployment infrastructure — tasks are statically imported
- SDK has `apiKey` param but server ignores it
- No CLI tool, no bundle system, no versioning
- Packages are `"private": true`, exports point to `.ts` files (not publishable)

## Target State

Users can `npm install @reload-dev/sdk`, define tasks, run `npx reload-dev deploy`, and manage everything from a multi-project dashboard with API key authentication.

---

## Audit-Driven Design Decisions (read before phases)

These decisions were identified by auditing the original plan against how Trigger.dev, Stripe, and Inngest actually work. Each one represents a better way of doing things with reasoning.

### Decision 1: Skip the Organization layer — Use User → Project directly

**Original plan**: User → Organization → Project (3 tables, org membership, roles)
**Better**: User → Project (2 tables, simpler queries)

**Why**: The org layer adds `organizations`, `org_members`, and role management to EVERY query path. For a learning project (and even most MVPs), you don't need team collaboration. If you add it later, it's a straightforward migration: create `organizations` table, add `org_id` to `projects`, backfill.

**Impact**: Removes ~3 tables and simplifies every route handler's auth check from "user → org membership → project" to just "user → project".

### Decision 2: Unified token auth — Don't split dashboard sessions from API keys

**Original plan**: Dashboard uses session auth (cookies + sessions table), API uses API key auth (separate system), dashboard proxies to API with stored API key.
**Better**: Single token system for everything. API keys ARE the auth tokens. Dashboard stores the user's key in an httpOnly cookie.

**Why**: Maintaining two auth systems (sessions + API keys) doubles the security surface area and creates a coupling layer (dashboard must look up API key from session). Trigger.dev, Stripe, and Inngest all use the same token format for dashboard and API.

**How it works**:
- User signs up → gets a personal API key (stored as httpOnly cookie in browser)
- Dashboard sends requests with `Authorization: Bearer <key>` (from cookie)
- CLI sends same header from env var
- SDK sends same header from constructor
- Server has ONE middleware that validates ANY bearer token

**Impact**: Removes `sessions` table. One auth middleware instead of two. Simpler dashboard — no session lookup before API calls.

### Decision 3: Add `environment` column to API keys

**Original plan**: API keys are per-project only.
**Better**: Each key belongs to an environment (dev/staging/prod).

**Why**: Users need separate keys for local development vs production. Trigger.dev does this. The key prefix already encodes environment (`rl_dev_...` vs `rl_live_...`), so this is just making the schema match the key format.

**Schema**: Add `environment TEXT DEFAULT 'dev'` to `api_keys`. One-line change, big DX win.

### Decision 4: Add `keyType` column — Separate client keys from server keys

**Original plan**: All API keys have the same permissions.
**Better**: Two key types: `client` (for SDK — can only trigger and read) and `server` (for workers — can dequeue, complete, fail, manage deployments).

**Why**: If a `client` key leaks in frontend code, the attacker can trigger tasks but NOT dequeue and execute them, access deployment bundles, or complete runs for other users. Trigger.dev has this separation.

**Implementation**: Add `key_type TEXT DEFAULT 'client'` to `api_keys`. Auth middleware checks `keyType` against the route's required permission level.

### Decision 5: Fix PG NOTIFY data leakage for multi-tenant SSE

**The bug**: The engine sends `NOTIFY run_updates, {...}` and ALL connected SSE listeners receive EVERY project's updates. In multi-tenant, this leaks data across projects.

**The fix**: Add `projectId` to the NOTIFY payload. SSE stream handlers filter by `projectId` from the authenticated request context. This MUST be done in Phase 2 alongside auth middleware — not deferred to Phase 7.

### Decision 6: `reload-dev dev` should bypass bundling — use tsx directly

**Original plan**: Mentions `reload-dev dev` but doesn't detail it.
**Better**: Local dev mode skips the entire bundling pipeline. It uses `tsx` to run tasks directly from TypeScript source, with file watching for hot reload.

**Why**: Bundling on every code change is slow and unnecessary for local development. Trigger.dev's `trigger dev` does the same — it watches task files and hot-reloads without bundling. `reload-dev deploy` is the only command that bundles.

### Decision 7: Add `triggerAndWait()` to SDK

**Original plan**: SDK only has `trigger()` which returns immediately.
**Better**: Add `triggerAndWait()` that polls until the run completes or fails.

**Why**: The most common pattern after triggering is waiting for the result. Without this, every user writes the same polling loop manually. BullMQ and Trigger.dev both provide this.

### Decision 8: URL parameter validation on ALL endpoints

**The gap**: Request bodies are validated with Zod, but URL params (`:id`, `:token`) and query params (`?status=`, `?limit=`) are passed raw to the database.

**The fix**: Add Zod schemas for URL params (UUID validation) and query params (enum validation, integer parsing). This catches malformed requests early and provides clear error messages. Do this in Phase 2 alongside auth.

---

## Phase 0: Fix Package Build Pipeline
**Goal**: All packages compile to `dist/`, exports point to compiled JS + declarations.

**Concepts**: None new — just build tooling.

### 0.1 — Add build scripts to all packages

Every package needs a `tsc` build that produces `dist/` with `.js` + `.d.ts` files.

**Files to change**:
- `packages/core/package.json` — add `"build": "tsc"`, `"main"`, `"types"`, `"files"`, point exports to `dist/`
- `packages/engine/package.json` — same
- `packages/sdk/package.json` — same
- `packages/worker/package.json` — change from `tsdown` to `tsc`
- Each package's `tsconfig.json` — ensure `outDir: "dist"`, `declaration: true`

### 0.2 — Verify turbo build pipeline

Run `pnpm build` and confirm all packages produce `dist/` in dependency order: `core → engine → sdk → worker → server`.

### 0.3 — Test that the system still works with compiled output

Run `pnpm start` using compiled JS instead of `tsx`. Fix any import path issues.

**Deliverable**: `pnpm build` succeeds. All packages have `dist/` with `.js` + `.d.ts`. System works end-to-end from compiled output.

---

## Phase 1: Database Schema for Multi-Tenancy
**Goal**: Add users, projects, API keys tables. Add `projectId` to all existing tables.

**Concepts used**: [Multi-Tenancy](#3-multi-tenancy), [Database Migrations](#6-database-migrations), [Cryptographic Hashing](#2-cryptographic-hashing-for-secrets)

### 1.1 — Switch from `drizzle-kit push` to migrations

Currently using `push` which directly modifies the DB. Switch to `generate` + `migrate` workflow so schema changes are versioned SQL files.

**Files**:
- `packages/server/drizzle.config.ts` — configure migrations directory
- `package.json` — update `db:push` → `db:migrate`

### 1.2 — Add new tables to schema

**File**: `packages/server/src/db/schema.ts`

New tables (simplified — no org layer per Decision 1):
```
users         — id, email, name, passwordHash, createdAt
projects      — id, userId (FK→users), name, slug, createdAt
api_keys      — id, projectId (FK→projects), name, keyHash, keyPrefix,
                keyType ('client'|'server'), environment ('dev'|'prod'),
                expiresAt, lastUsedAt, createdAt
```

Note: `keyType` per Decision 4, `environment` per Decision 3.

### 1.3 — Add `projectId` to all existing tables

Add `project_id UUID NOT NULL REFERENCES projects(id)` to:
- `queues`
- `tasks`
- `runs`
- `workers`
- `run_events`
- `run_steps`
- `waitpoints`

Add composite indexes: `(project_id, queue_id, status)` on runs, `(project_id)` on all tables.

### 1.4 — Migration strategy for existing data

Since this is pre-production:
1. Generate migration that adds columns as **nullable** (no FK yet)
2. Create a default user + project for existing data
3. Backfill `project_id` on all rows (**chunk UPDATEs in batches of 10k** to avoid table locks on large tables)
4. Add the FK constraint
5. Alter columns to NOT NULL

**Deliverable**: Schema has full multi-tenant structure. Migration files are version-controlled. Existing data is migrated to a default project.

---

## Phase 2: Authentication Middleware
**Goal**: All API endpoints require a valid API key. ProjectId is extracted from the key and injected into request context.

**Concepts used**: [API Key Authentication](#1-api-key-authentication), [Middleware Chains](#4-middleware-chains), [Row-Level Security Patterns](#5-row-level-security-patterns)

### 2.1 — API key generation endpoints

**File**: `packages/server/src/routes/auth.ts` (new)

Endpoints (these are dashboard-facing, protected by session auth later):
- `POST /api/projects/:id/keys` — generate new API key, return raw key ONCE
- `GET /api/projects/:id/keys` — list keys (prefix only, never raw)
- `DELETE /api/projects/:id/keys/:keyId` — revoke key

Key format: `rl_dev_<base64url-random-24-bytes>` or `rl_live_<...>`

Store SHA-256 hash + prefix in `api_keys` table.

### 2.2 — Auth middleware

**File**: `packages/server/src/middleware/auth.ts` (new)

```typescript
export async function apiKeyAuth(c: Context, next: Next) {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Missing API key" }, 401);
  }

  const keyRaw = header.slice(7);
  const keyHash = sha256(keyRaw);

  const [apiKey] = await db.select().from(schema.apiKeys)
    .where(eq(schema.apiKeys.keyHash, keyHash)).limit(1);

  if (!apiKey) return c.json({ error: "Invalid API key" }, 401);
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    return c.json({ error: "Expired API key" }, 401);
  }

  // Update last used
  await db.update(schema.apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiKeys.id, apiKey.id));

  c.set("projectId", apiKey.projectId);
  c.set("apiKeyId", apiKey.id);
  await next();
}
```

### 2.3 — Apply middleware to all API routes

**File**: `packages/server/src/routes/index.ts`

Add `api.use("*", apiKeyAuth)` at the top of `createRoutes()`. The health endpoint stays outside the auth boundary.

### 2.4 — Scope every query by projectId

Go through every route handler and add `projectId` filtering:
- `POST /api/trigger` — validate task belongs to project, set projectId on new run
- `POST /api/dequeue` — only dequeue runs from project's queues
- `GET /api/runs` — filter by projectId
- `GET /api/events` — filter by projectId
- `GET /api/tasks` — filter by projectId
- `GET /api/queues` — filter by projectId
- `GET /api/workers` — filter by projectId
- All SSE streams — filter NOTIFY payloads by projectId

### 2.5 — Update SDK client

**File**: `packages/sdk/src/client.ts`

Make `apiKey` required (not optional):
```typescript
constructor(config: { baseUrl: string; apiKey: string })
```

Add `triggerAndWait()` convenience method (per Decision 7):
```typescript
async triggerAndWait(taskId: string, payload: unknown, options?: TriggerOptions & {
  timeoutMs?: number; pollIntervalMs?: number;
}): Promise<RunStatus> {
  const { runId } = await this.trigger(taskId, payload, options);
  const deadline = Date.now() + (options?.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    const run = await this.getRun(runId);
    if (["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(run.status)) return run;
    await new Promise(r => setTimeout(r, options?.pollIntervalMs ?? 500));
  }
  throw new Error(`Run ${runId} did not complete within timeout`);
}
```

### 2.6 — Update worker to use API key

**File**: `packages/worker/src/index.ts`

Add `RELOAD_API_KEY` environment variable. **Exit with error if not set** (per security audit — currently worker silently runs without auth):
```typescript
const RELOAD_API_KEY = process.env.RELOAD_API_KEY;
if (!RELOAD_API_KEY) {
  console.error("[worker] RELOAD_API_KEY is required. Get one from the dashboard.");
  process.exit(1);
}
```

### 2.7 — Namespace Redis keys by projectId

**Files**: `packages/engine/src/queue/redis-queue.ts`, `concurrency.ts`, `fair-dequeue.ts`

All Redis keys get project prefix: `${projectId}:queue:${queueId}`, `${projectId}:active-queues`, etc.

### 2.8 — Fix PG NOTIFY data leakage (per Decision 5)

**File**: `packages/engine/src/run-engine.ts`

Add `projectId` to NOTIFY payload so SSE handlers can filter by project:
```typescript
await db.execute(sql`NOTIFY run_updates, ${JSON.stringify({
  projectId: run.projectId,  // ADD THIS — prevents cross-project leakage
  runId, fromStatus, toStatus, queueId, taskId, timestamp,
})}`);
```

**File**: `packages/server/src/routes/stream.ts`

Filter SSE payloads by `projectId` from the authenticated request context.

### 2.9 — URL and query parameter validation (per Decision 8)

**File**: `packages/server/src/routes/index.ts`

Add Zod schemas for ALL URL params and query params:
```typescript
// URL params — validate UUIDs
const RunIdParam = z.object({ id: z.string().uuid() });

// Query params — validate enums and ranges
const ListRunsQuery = z.object({
  status: z.enum(["PENDING","QUEUED","DELAYED","EXECUTING","SUSPENDED","COMPLETED","FAILED","CANCELLED","EXPIRED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
```

Apply to all 14 parameterized endpoints (`:id`, `:token`).

**Deliverable**: All API endpoints require valid API key. All data queries are scoped by projectId. Redis keys are namespaced. NOTIFY is project-scoped. All params validated. SDK requires API key and has `triggerAndWait()`.

---

## Phase 3: Dashboard Authentication & Project Management
**Goal**: Users can sign up, create organizations and projects, generate API keys, and view project-scoped data.

**Concepts used**: [Session-Based Auth](#13-session-based-auth-vs-token-based-auth), [CORS](#14-cors)

### 3.1 — Dashboard auth pages

New pages:
- `/login` — email + password form
- `/signup` — create account form
- `/onboarding` — create first org + project

### 3.2 — Auth approach (unified tokens — per Decision 2)

Use [better-auth](https://www.better-auth.com/) for user signup/login. On login, generate a personal API key and store it as an httpOnly cookie. This key is the SAME format as project API keys — the server's auth middleware handles both.

No separate `sessions` table needed. The httpOnly cookie IS the bearer token.

### 3.3 — Dashboard API routes (Next.js server-side proxy)

The dashboard must NOT use Next.js rewrites for authenticated requests. Instead, add Next.js API routes that:
1. Read the auth cookie from the request
2. Forward to the backend API server with `Authorization: Bearer <key>`
3. Return the response to the browser

This prevents exposing the API server directly to browsers and ensures auth is validated server-side:
```typescript
// app/api/[...proxy]/route.ts
export async function GET(req: Request) {
  const cookie = req.headers.get("cookie");
  const apiKey = extractKeyFromCookie(cookie);
  if (!apiKey) return new Response("Unauthorized", { status: 401 });

  const backendRes = await fetch(`http://localhost:3000/api${new URL(req.url).pathname}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return backendRes;
}
```

### 3.4 — Project management UI

New dashboard pages:
- `/projects` — list user's projects
- `/projects/new` — create project form
- `/projects/[id]/settings` — project settings, API keys
- `/projects/[id]/keys` — generate/revoke API keys (show raw key once)

### 3.5 — Project switcher in nav

The sidebar gets a project dropdown at the top. All data views (runs, tasks, queues, etc.) are filtered by the selected project.

### 3.6 — CORS configuration

**File**: `packages/server/src/index.ts`

Add Hono CORS middleware with allowed origins (dashboard URL).

**Deliverable**: Users can sign up, create projects, generate API keys. Dashboard shows project-scoped data. API has CORS headers.

---

## Phase 4: Publish SDK & Worker to npm
**Goal**: `npm install @reload-dev/sdk` works. Users can define and trigger tasks from their own projects.

**Concepts used**: npm publishing, semver, peer dependencies.

### 4.1 — Prepare packages for publication

For `@reload-dev/core`, `@reload-dev/sdk`, `@reload-dev/worker`:
- Set `"private": false`
- Set `"main"`, `"types"`, `"files"`, `"exports"` pointing to `dist/`
- Add `"publishConfig": { "access": "public" }`
- Add `README.md` with usage examples
- Add `LICENSE` (MIT)
- Add `"peerDependencies"` where appropriate (sdk depends on core)

### 4.2 — Create a user-facing getting-started flow

Document the workflow:
```bash
npm install @reload-dev/sdk
```

```typescript
// tasks/my-task.ts
import { task } from "@reload-dev/sdk/task";

export const myTask = task({
  id: "my-task",
  run: async (payload) => {
    // your code here
    return { result: "done" };
  },
});
```

```typescript
// trigger from your app
import { ReloadClient } from "@reload-dev/sdk/client";

const client = new ReloadClient({
  baseUrl: "https://api.reload.dev",
  apiKey: process.env.RELOAD_API_KEY!,
});

await client.trigger("my-task", { some: "data" });
```

### 4.3 — Publish to npm

```bash
pnpm build
cd packages/core && npm publish --access=public
cd packages/sdk && npm publish --access=public
cd packages/worker && npm publish --access=public
```

### 4.4 — Test installation from npm

Create a fresh project, `npm install @reload-dev/sdk`, define a task, trigger it against the running server. Verify end-to-end.

**Deliverable**: Packages published on npm. Users can install and use the SDK from their own projects.

---

## Phase 5: CLI & Task Bundling (Config File + Entry Point Pattern)
**Goal**: `npx @reload-dev/cli deploy` reads a config file, bundles the user's task entry point with esbuild, and uploads to the server.

**Concepts used**: [JavaScript Bundling](#8-javascript-bundling), [CLI Design](#12-cli-design), [Content-Addressable Storage](#10-content-addressable-storage)

**Design decision — Config + Entry Point (Trigger.dev pattern)**:

Instead of scanning directories with AST parsing (fragile, complex), we adopt Trigger.dev's pattern:

1. User creates `reload.config.ts` — declares project ID, entry point dir, defaults
2. User creates a barrel file (e.g., `tasks/index.ts`) — re-exports all tasks explicitly
3. CLI bundles that single entry point — esbuild follows all imports automatically
4. CLI imports the bundle to extract task metadata — no AST parsing needed

**Why this is better than AST scanning**:
- The user explicitly controls which tasks are deployed via re-exports
- esbuild only needs one entry point and follows imports — no glob scanning
- No fragile AST parsing that breaks on unusual code patterns
- TypeScript ensures all exports are valid TaskHandle types
- Same pattern that Trigger.dev, Vercel, and Remix use

### 5.1 — Create CLI package

**New package**: `packages/cli/`

```json
{
  "name": "@reload-dev/cli",
  "bin": { "reload-dev": "./dist/cli.js" },
  "dependencies": {
    "commander": "^12.0.0",
    "esbuild": "^0.20.0"
  }
}
```

Commands:
- `reload-dev init` — scaffold `reload.config.ts` + `tasks/index.ts`
- `reload-dev dev` — start local worker with file watching
- `reload-dev deploy` — bundle entry point + upload to server
- `reload-dev whoami` — show current project from API key

### 5.2 — Config file: `reload.config.ts`

The SDK exports a `defineConfig()` helper for type safety (like Trigger.dev's):

```typescript
// packages/sdk/src/config.ts (new export from SDK)
export interface ReloadConfig {
  project: string;                // project slug or ID from dashboard
  dirs: string[];                 // directories containing task files (default: ["./tasks"])
  runtime?: "node";               // runtime target (node only for now)
  logLevel?: "debug" | "info" | "warn" | "error";
  retries?: {                     // default retry config for all tasks
    enabledInDev?: boolean;
    default?: {
      maxAttempts?: number;
      factor?: number;
      minTimeoutInMs?: number;
      maxTimeoutInMs?: number;
    };
  };
}

export function defineConfig(config: ReloadConfig): ReloadConfig {
  return config;
}
```

**User creates**:
```typescript
// reload.config.ts (in user's project root)
import { defineConfig } from "@reload-dev/sdk/config";

export default defineConfig({
  project: "proj_abc123",
  dirs: ["./tasks"],
  runtime: "node",
  logLevel: "info",
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
    },
  },
});
```

### 5.3 — Entry point barrel file: `tasks/index.ts`

The user creates a barrel file that re-exports every task they want deployed. This is the **single source of truth** for what gets bundled.

```typescript
// tasks/index.ts (user creates this)
// This is the entry point that reload-dev bundles and deploys.
// Only exported tasks will be deployed.

export { deliverWebhook } from "./deliver-webhook";
export { processImage } from "./process-image";
export { siteHealthCheck } from "./site-health-check";
export { scrapeMetadata } from "./scrape-metadata";
export { generateReport } from "./generate-report";
```

**Why explicit re-exports**: The user controls exactly which tasks are deployed. No magic file scanning. If a task isn't exported here, it doesn't get deployed. This is the same pattern Trigger.dev uses with their `trigger/index.ts` file.

### 5.4 — CLI `deploy` command flow

```
$ npx reload-dev deploy

Step 1: Read reload.config.ts
  → project: "proj_abc123"
  → dirs: ["./tasks"]
  → Find entry point: tasks/index.ts (barrel file in first dir)

Step 2: Bundle with esbuild
  → Entry: tasks/index.ts
  → esbuild bundles it + all re-exported files into single bundle.js
  → Output: .reload/dist/bundle.js

Step 3: Extract task metadata (no AST parsing!)
  → Dynamic import(".reload/dist/bundle.js")
  → Iterate module exports: for (const [name, value] of Object.entries(mod))
  → Filter: objects with { id, run } shape are TaskHandles
  → Build manifest: [{ id, queue, retry, exportName }]

Step 4: Upload to server
  → POST /api/deployments (authenticated with API key from env)
  → Body: { manifest, bundle (base64 or multipart) }
  → Server stores bundle + records deployment

Step 5: Activate
  → POST /api/deployments/:id/activate
  → Server marks as active, upserts tasks table
  → Workers pick up new deployment on next poll
```

### 5.5 — esbuild configuration

```typescript
import * as esbuild from "esbuild";

const result = await esbuild.build({
  entryPoints: ["tasks/index.ts"],    // single entry point (the barrel)
  bundle: true,                        // follow all imports
  outfile: ".reload/dist/bundle.js",   // single output file
  format: "esm",                       // ES modules
  platform: "node",                    // Node.js built-ins available
  target: "node20",                    // target runtime
  external: ["@reload-dev/sdk"],       // don't bundle the SDK (peer dep on worker)
  sourcemap: true,                     // debugging deployed code
  metafile: true,                      // metadata about what was bundled
  minify: false,                       // keep readable for debugging
});

// Hash the output for content-addressable versioning
const bundleContent = await fs.readFile(".reload/dist/bundle.js");
const bundleHash = createHash("sha256").update(bundleContent).digest("hex").slice(0, 16);
```

### 5.6 — `reload-dev init` scaffolding

```
$ npx reload-dev init

Creates:
  reload.config.ts         ← config file with project ID placeholder
  tasks/index.ts           ← empty barrel file with example comment
  tasks/example.ts         ← example task definition
  .env                     ← RELOAD_API_KEY= placeholder
```

### 5.7 — Server deployment endpoints

**File**: `packages/server/src/routes/deployments.ts` (new)

```typescript
// POST /api/deployments — upload a new deployment
// Request: multipart with manifest JSON + bundle file
// Response: { deploymentId, version, status: "STAGED" }

// GET /api/deployments — list deployments for project
// Response: { deployments: [{ id, version, status, createdAt }] }

// GET /api/deployments/active — get currently active deployment
// Response: { id, version, bundleUrl, manifest, activatedAt }

// POST /api/deployments/:id/activate — activate a staged deployment
// Response: { ok, activatedAt }
// Side effect: upserts tasks table from manifest, deactivates previous

// GET /api/deployments/:id/bundle — download the bundle file
// Response: raw JS file (for workers to download)
```

### 5.8 — Deployments schema

**New table**: `deployments`
```
id             UUID PK
project_id     UUID FK→projects (scoped by auth)
version        TEXT (content hash of bundle, e.g., "a1b2c3d4")
bundle_hash    TEXT (full SHA-256 for verification)
bundle_path    TEXT (filesystem path to stored bundle)
manifest       JSONB (task metadata: [{id, queue, retry, exportName}])
status         TEXT (STAGED | ACTIVE | SUPERSEDED | FAILED)
created_at     TIMESTAMP
activated_at   TIMESTAMP (when it became active)
created_by     UUID FK→users (who deployed)
```

### 5.9 — Server bundle storage

Bundles stored on filesystem initially (production can use S3):
```
data/bundles/<projectId>/<bundleHash>/bundle.js
data/bundles/<projectId>/<bundleHash>/bundle.js.map
```

Served via `GET /api/deployments/:id/bundle` (authenticated, project-scoped).

**Deliverable**: Users create `reload.config.ts` + `tasks/index.ts`, run `npx reload-dev deploy`, and their task code is bundled and uploaded to the server with version tracking. Same DX as Trigger.dev.

---

## Phase 6: Managed Worker — Dynamic Task Loading
**Goal**: A server-hosted worker loads task code from the active deployment instead of static imports.

**Concepts used**: [Dynamic Code Loading](#9-dynamic-code-loading), [Blue-Green Deployments](#11-blue-green-deployments)

### 6.1 — Worker fetches active deployment on startup

Instead of importing tasks statically, the managed worker:
1. Calls `GET /api/deployments/active` (authenticated with project API key)
2. Downloads the bundle from `bundleUrl`
3. Verifies the SHA-256 hash matches `bundleHash`
4. Saves to disk: `/tmp/reload/deployments/<hash>/bundle.js`

### 6.2 — Dynamic import of bundle

```typescript
const mod = await import(bundlePath);

// Extract all task exports
for (const [name, value] of Object.entries(mod)) {
  if (value && typeof value === "object" && "id" in value && "run" in value) {
    registerTask(value as TaskHandle);
  }
}
```

### 6.3 — Deployment version pinning on runs

When a run is created (`POST /api/trigger`), record the current active `deploymentId` on the run. When the worker executes or resumes a run, it loads the deployment version that the run was created with — not necessarily the latest.

**Schema change**: `runs.deployment_id UUID REFERENCES deployments(id)`

### 6.4 — Hot reload on new deployment

The managed worker periodically checks for new active deployments (or receives a push via SSE/webhook). When a new deployment is activated:
1. Download new bundle
2. Clear task registry
3. Load new tasks
4. Re-register with server
5. Continue dequeue loop (new runs use new code, in-flight runs finish with old code)

### 6.5 — Deployment status tracking

Track how many workers have loaded the new deployment:
- `GET /api/deployments/:id/status` → `{ workers: 3, loaded: 2, pending: 1 }`

**Deliverable**: Workers load task code dynamically from server-stored bundles. Runs are pinned to deployment versions. New deployments roll out without downtime.

---

## Phase 7: Rate Limiting & Production Hardening
**Goal**: API is protected from abuse. System is ready for real users.

**Concepts used**: [Rate Limiting](#15-rate-limiting), [Namespace Isolation in Redis](#16-namespace-isolation-in-redis)

### 7.1 — Rate limiting middleware

Redis-based sliding window rate limiter:
- Per API key: 100 req/min for triggers, 1000 req/min for reads
- Per IP: 20 req/min for unauthenticated endpoints (login, signup)

### 7.2 — Request validation hardening

- Validate all query parameters (not just body)
- Add max payload size limits
- Sanitize error messages (don't leak internal details)

### 7.3 — Audit logging

New table: `audit_logs` (projectId, userId, action, resourceType, resourceId, timestamp)

Log: API key creation/revocation, deployment activation, manual run cancellation.

### 7.4 — Worker security

- Workers must authenticate with project API key
- Workers can only dequeue from their project's queues
- Bundle downloads require valid API key

### 7.5 — HTTPS & security headers

- Enforce HTTPS in production
- Add security headers (Hono `secureHeaders` middleware)
- Set cookie flags: HttpOnly, Secure, SameSite

**Deliverable**: API is rate-limited. All actions are audited. Workers are authenticated. System is production-hardened.

---

## Phase Summary

| Phase | What | Key Learning | Depends On |
|-------|------|-------------|------------|
| 0 | Build pipeline | TypeScript compilation, npm package structure | — |
| 1 | Multi-tenant schema | Database migrations, data modeling | Phase 0 |
| 2 | Auth middleware | API key auth, hashing, row-level security | Phase 1 |
| 3 | Dashboard auth | Sessions, CORS, project management UI | Phase 2 |
| 4 | Publish to npm | Package publishing, semver, peer deps | Phase 0 |
| 5 | CLI & bundling | Config + entry point pattern, esbuild, CLI design | Phase 2, 4 |
| 6 | Managed worker | Dynamic import, blue-green deploys | Phase 5 |
| 7 | Production hardening | Rate limiting, audit logging, security | Phase 2 |

**Phases 0-2 are sequential** (each depends on the previous).
**Phases 3, 4 can run in parallel** after Phase 2.
**Phases 5, 6 are sequential** (deploy before managed worker).
**Phase 7 can start after Phase 2** and continue alongside other phases.

```
Phase 0 → Phase 1 → Phase 2 ──┬── Phase 3 (dashboard auth)
                               ├── Phase 4 (publish npm) → Phase 5 (CLI) → Phase 6 (managed worker)
                               └── Phase 7 (hardening, ongoing)
```

---

## What NOT to Build (Keep it Simple)

- **No Docker/Kubernetes for workers** — local processes are fine for learning
- **No S3 for bundle storage** — filesystem is fine initially
- **No OAuth/SSO** — email+password is enough
- **No billing/usage tracking** — out of scope
- **No multi-region** — single server is fine
- **No CRIU or V8 snapshots** — step-based replay is sufficient
- **No WebSockets** — SSE is simpler and sufficient
- **No GraphQL** — REST is simpler and you already have it
