# Concepts You Need to Learn Before Building

Read this document FIRST. Each concept here is something you'll use directly in the implementation. Understanding them deeply will make the build phase straightforward instead of frustrating.

---

## Table of Contents

1. [API Key Authentication — How SaaS APIs Authenticate Clients](#1-api-key-authentication)
2. [Cryptographic Hashing for Secrets — Why You Never Store Raw Keys](#2-cryptographic-hashing-for-secrets)
3. [Multi-Tenancy — Isolating Data in a Shared Database](#3-multi-tenancy)
4. [Middleware Chains — Request Pipelines in HTTP Servers](#4-middleware-chains)
5. [Row-Level Security Patterns — Scoping Every Query](#5-row-level-security-patterns)
6. [Database Migrations — Evolving a Live Schema](#6-database-migrations)
7. [Config File + Entry Point Pattern — How Trigger.dev Does It](#7-config-file--entry-point-pattern-how-triggerdev-does-it)
8. [JavaScript Bundling — How esbuild Works](#8-javascript-bundling)
9. [Dynamic Code Loading — import() at Runtime](#9-dynamic-code-loading)
10. [Content-Addressable Storage — Storing Bundles by Hash](#10-content-addressable-storage)
11. [Blue-Green Deployments — Zero-Downtime Rollouts](#11-blue-green-deployments)
12. [CLI Design — Building Developer Tools](#12-cli-design)
13. [Unified Token Auth — One Auth System for Everything](#13-unified-token-auth--one-auth-system-for-everything)
14. [CORS — Cross-Origin Resource Sharing](#14-cors)
15. [Rate Limiting — Protecting Your API](#15-rate-limiting)
16. [Namespace Isolation in Redis — Multi-Tenant Key Design](#16-namespace-isolation-in-redis)
17. [Input Validation at Every Layer — URL Params, Query Params, Bodies](#17-input-validation-at-every-layer)
18. [Polling Patterns — triggerAndWait() and Long-Running Operations](#18-polling-patterns)

---

## 1. API Key Authentication

**What it is**: A secret string that identifies a client and grants access to an API. Used by Stripe (`sk_live_...`), Trigger.dev (`tr_dev_...`), OpenAI (`sk-...`), etc.

**How it works in practice**:
```
Client sends:  Authorization: Bearer rl_live_abc123def456...
Server does:   hash("rl_live_abc123def456...") → "sha256:9f86d0..."
               SELECT * FROM api_keys WHERE key_hash = "sha256:9f86d0..."
               → Found! projectId = "proj_xyz", permissions = [...]
               Attach projectId to request context
               Continue to route handler
```

**Key anatomy** (how Trigger.dev and Stripe do it):
```
tr_dev_1234567890abcdef
│   │   └── random secret (20+ chars)
│   └── environment (dev/live/test)
└── prefix (identifies the service)
```

The prefix lets you identify a leaked key (in git commits, logs). The environment part separates dev from production. The random part is the actual secret.

**Why prefixes matter**: If someone pastes `tr_dev_...` in a GitHub repo, automated scanners can identify it as a Trigger.dev key and notify both the user and Trigger.dev. Without a prefix, it's just a random string.

**Key generation**:
```typescript
import { randomBytes } from "node:crypto";

function generateApiKey(environment: "dev" | "live"): { raw: string; hash: string; prefix: string } {
  const secret = randomBytes(24).toString("base64url"); // 32 chars, URL-safe
  const raw = `rl_${environment}_${secret}`;
  const hash = sha256(raw);
  const prefix = raw.slice(0, 12); // "rl_dev_abc12" — safe to display
  return { raw, hash, prefix };
}
```

**Critical rule**: The raw key is shown ONCE at creation, then never again. The server stores only the hash. This is exactly how GitHub personal access tokens work.

**Resources to read**:
- [Stripe API Authentication docs](https://stripe.com/docs/api/authentication)
- [How Trigger.dev handles API keys](https://trigger.dev/docs/apikeys)
- [OWASP API Security — Authentication](https://owasp.org/API-Security/editions/2023/en/0xa2-broken-authentication/)

---

## 2. Cryptographic Hashing for Secrets

**What it is**: A one-way function that converts input to a fixed-size string. Given the hash, you cannot recover the input.

**Why you need it**: You store API key *hashes* in your database, not raw keys. If your database leaks, attackers get hashes — not usable keys.

**SHA-256 vs bcrypt vs argon2**:
| Algorithm | Speed | Use For |
|-----------|-------|---------|
| SHA-256 | Fast | API keys (high-entropy random strings) |
| bcrypt | Slow (intentionally) | Passwords (low-entropy human-chosen strings) |
| argon2 | Slowest | Passwords (modern, memory-hard) |

API keys are randomly generated (high entropy), so SHA-256 is fine — brute-forcing a 32-byte random string is infeasible regardless of hash speed. Passwords need slow hashing because humans pick predictable ones.

```typescript
import { createHash } from "node:crypto";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// For passwords (if you add user login):
import { hash, verify } from "@node-rs/argon2";

const passwordHash = await hash(plaintext);
const isValid = await verify(passwordHash, plaintext);
```

**Resources**:
- [Node.js crypto module docs](https://nodejs.org/api/crypto.html)
- [Why SHA-256 is fine for API keys but not passwords](https://security.stackexchange.com/questions/151257/what-kind-of-hashing-to-use-for-storing-rest-api-tokens-in-the-database)

---

## 3. Multi-Tenancy

**What it is**: Multiple customers (tenants) sharing the same application and database, with data isolation between them.

**Three approaches**:

| Approach | How | Pros | Cons |
|----------|-----|------|------|
| **Separate databases** | Each tenant gets their own DB | Perfect isolation | Expensive, hard to manage |
| **Separate schemas** | Same DB, different PostgreSQL schemas | Good isolation | Complex migrations |
| **Shared tables + tenant column** | Same tables, `project_id` on every row | Simple, scalable | Must never forget the WHERE clause |

**We use approach 3** (shared tables + project_id column). This is what most SaaS products do (Stripe, Trigger.dev, Linear, etc.).

**The golden rule**: Every query that reads or writes data MUST include `WHERE project_id = $projectId`. If you forget this in even one query, you have a data leak.

**How to enforce it** — the middleware pattern:
```typescript
// 1. Auth middleware extracts projectId from API key
// 2. projectId is injected into request context
// 3. Every route handler reads projectId from context
// 4. Every DB query includes projectId filter

// Example:
api.get("/runs", async (c) => {
  const projectId = c.get("projectId"); // from auth middleware
  const runs = await db.select().from(schema.runs)
    .where(eq(schema.runs.projectId, projectId)); // ALWAYS filter
  return c.json({ runs });
});
```

**Data model hierarchy**:
```
User (person)
  └── Organization (team/company)
       └── Project (one API key scope)
            ├── Queues
            ├── Tasks
            ├── Runs
            ├── Workers
            ├── Deployments
            └── API Keys
```

**Resources**:
- [Multi-Tenant Data Architecture (Microsoft)](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/storage-data)
- [How Stripe isolates customer data](https://stripe.com/blog/service-mesh-for-data-isolation)

---

## 4. Middleware Chains

**What it is**: A pipeline of functions that process an HTTP request before it reaches the route handler. Each middleware can inspect, modify, reject, or pass the request to the next middleware.

**How Hono middleware works**:
```typescript
// Middleware signature: (context, next) => Response | void
async function authMiddleware(c: Context, next: Next) {
  const header = c.req.header("authorization");
  if (!header) return c.json({ error: "Unauthorized" }, 401);

  const apiKey = await validateKey(header);
  if (!apiKey) return c.json({ error: "Invalid key" }, 401);

  c.set("projectId", apiKey.projectId); // inject into context
  await next(); // continue to next middleware or route handler
}

// Apply to all /api routes:
api.use("*", authMiddleware);

// Or apply to specific routes:
api.use("/trigger", authMiddleware);
```

**Middleware execution order**:
```
Request → Logger → Auth → Rate Limiter → Route Handler → Response
                    ↑
              can short-circuit here (return 401)
```

**Resources**:
- [Hono Middleware docs](https://hono.dev/docs/guides/middleware)
- [Express middleware concept (same principle)](https://expressjs.com/en/guide/using-middleware.html)

---

## 5. Row-Level Security Patterns

**What it is**: Ensuring every database query is automatically scoped to the current tenant. There are two approaches:

**Approach A — Application-level filtering** (what we'll use):
```typescript
// Every query manually includes projectId
const runs = await db.select().from(runs)
  .where(and(
    eq(runs.projectId, projectId),  // ALWAYS present
    eq(runs.status, "QUEUED"),
  ));
```

**Approach B — PostgreSQL Row-Level Security (RLS)**:
```sql
-- Database enforces filtering automatically
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON runs
  USING (project_id = current_setting('app.project_id'));

-- Before each query:
SET app.project_id = 'proj_abc123';
SELECT * FROM runs WHERE status = 'QUEUED';
-- PostgreSQL automatically adds: AND project_id = 'proj_abc123'
```

We use Approach A because it's simpler with Drizzle ORM, more explicit, and doesn't require PostgreSQL-specific features. But understanding RLS is valuable — it's what Supabase uses.

**Resources**:
- [PostgreSQL RLS docs](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [Supabase RLS guide](https://supabase.com/docs/guides/database/postgres/row-level-security)

---

## 6. Database Migrations

**What it is**: Version-controlled changes to your database schema. Instead of `drizzle-kit push` (which directly modifies the DB), migrations generate SQL files that can be reviewed, tested, and applied in order.

**Why you need them now**: Adding `project_id` to every table is a schema change that must be coordinated — you can't just push and hope.

**Drizzle migration workflow**:
```bash
# 1. Change schema.ts (add projectId column)
# 2. Generate migration SQL:
pnpm drizzle-kit generate

# Creates: drizzle/0001_add_project_id.sql
# Contains:
#   ALTER TABLE runs ADD COLUMN project_id UUID;
#   CREATE INDEX idx_runs_project ON runs(project_id);

# 3. Review the SQL file manually
# 4. Apply:
pnpm drizzle-kit migrate
```

**Migration safety rules**:
- Never drop a column in the same migration that adds its replacement
- Add new columns as nullable first, backfill data, then add NOT NULL
- Always add indexes for new foreign key columns
- Test migrations on a copy of production data

**Resources**:
- [Drizzle Migrations docs](https://orm.drizzle.team/docs/migrations)
- [Safe database migrations at scale (Stripe)](https://stripe.com/blog/online-migrations)

---

## 7. Config File + Entry Point Pattern (How Trigger.dev Does It)

**What it is**: Instead of magically scanning code for task definitions (AST parsing — fragile and complex), the user explicitly declares:
1. A **config file** (`reload.config.ts`) — project settings, task directory, defaults
2. A **barrel/entry point file** (`tasks/index.ts`) — re-exports every task to deploy

The CLI reads the config, bundles the entry point with esbuild, and dynamic-imports the bundle to extract task metadata. No AST parsing needed.

**Why this is better than AST scanning**:
- **Explicit over magic** — what the user exports is what gets deployed. No surprise inclusions.
- **No fragile parsing** — AST scanning breaks on conditional exports, complex paths, decorators, etc.
- **Bundler-friendly** — esbuild needs one entry point and follows all imports automatically
- **Battle-tested** — this is the exact pattern Trigger.dev, Remix, and Vite use

**How Trigger.dev does it**:
```typescript
// trigger.config.ts — user creates this in their project root
import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_abc123",
  dirs: ["./app/trigger"],        // where the entry point lives
  retries: { default: { maxAttempts: 3 } },
});

// app/trigger/index.ts — barrel entry point, user re-exports all tasks
export { imageGenerationJob } from "./jobs/image-generation.job";
export { webhookDeliveryJob } from "./jobs/webhook-delivery.job";
export { reportGeneratorJob } from "./jobs/report-generator.job";
```

**How our version will work**:
```typescript
// reload.config.ts
import { defineConfig } from "@reload-dev/sdk/config";

export default defineConfig({
  project: "proj_abc123",
  dirs: ["./tasks"],
  retries: { default: { maxAttempts: 3, factor: 2 } },
});

// tasks/index.ts — barrel entry point
export { deliverWebhook } from "./deliver-webhook";
export { processImage } from "./process-image";
export { siteHealthCheck } from "./site-health-check";
```

**The deploy flow (no AST parsing needed)**:
```
1. CLI reads reload.config.ts → finds dirs: ["./tasks"]
2. CLI finds entry point: tasks/index.ts (barrel file)
3. esbuild bundles tasks/index.ts → .reload/dist/bundle.js
   (follows all re-exports, inlines everything except @reload-dev/sdk)
4. CLI dynamic-imports the bundle to extract metadata:
   const mod = await import(".reload/dist/bundle.js");
   for (const [name, value] of Object.entries(mod)) {
     if (value.id && value.run) manifest.push({ id: value.id, queue: value.queue });
   }
5. CLI uploads bundle + manifest to server
```

**Key insight**: Step 4 is the metadata extraction. By importing the bundled JS and inspecting exports, you get all task metadata (id, queue, retry) without any AST parsing. The `task()` helper returns a plain object — you just read its fields.

**The `defineConfig()` pattern** — a function that returns its argument unchanged. Its only purpose is TypeScript intellisense (autocomplete in your IDE). Used by Vite, Trigger.dev, Nuxt, Astro:
```typescript
export function defineConfig(config: ReloadConfig): ReloadConfig {
  return config; // that's it — the value is type safety, not runtime behavior
}
```

**Resources**:
- [Trigger.dev config file docs](https://trigger.dev/docs/config/config-file)
- [Vite defineConfig pattern](https://vitejs.dev/config/)
- [TypeScript barrel files (index.ts re-exports)](https://basarat.gitbook.io/typescript/main-1/barrel)

---

## 8. JavaScript Bundling

**What it is**: Taking multiple source files with imports/exports and combining them into a single self-contained file that can run independently.

**Why you need it**: When a user runs `reload deploy`, their task files (which may import helpers, use node_modules, etc.) need to be packaged into a single artifact that the server-hosted worker can execute.

**esbuild** (what we'll use — it's the fastest bundler):
```typescript
import * as esbuild from "esbuild";

const result = await esbuild.build({
  entryPoints: ["tasks/index.ts"],     // single barrel entry point
  bundle: true,
  outdir: "dist",
  format: "esm",
  platform: "node",
  target: "node20",
  external: ["@reload-dev/sdk"],  // Don't bundle the SDK — it's a peer dependency
  sourcemap: true,
  metafile: true,  // Outputs metadata about the bundle (size, imports, etc.)
});

// result.metafile tells you exactly what was included
```

**Key concepts**:
- **entry points**: The files esbuild starts from
- **bundle: true**: Follow all imports and include them
- **external**: Don't bundle these — the runtime must provide them
- **platform: "node"**: Use Node.js module resolution (allows `node:crypto`, etc.)
- **format: "esm"**: Output ES modules (import/export)
- **metafile**: Metadata about what was bundled (useful for manifest generation)

**Resources**:
- [esbuild Getting Started](https://esbuild.github.io/getting-started/)
- [esbuild API reference](https://esbuild.github.io/api/)
- [How Vercel bundles serverless functions](https://vercel.com/docs/functions/serverless-functions/runtimes/node-js) — similar concept

---

## 9. Dynamic Code Loading

**What it is**: Loading and executing JavaScript code at runtime, rather than at compile time via static imports.

**Why you need it**: The managed worker needs to load task code from a bundle that was uploaded after the worker started. It can't use static `import` because the code didn't exist when the worker was compiled.

**Approach 1 — Dynamic import() from file path**:
```typescript
// Worker downloads bundle to disk, then imports it
const mod = await import("/tmp/bundles/deployment-v3/tasks.js");
const taskFn = mod.deliverWebhook; // Access exported task
```

**Approach 2 — Dynamic import() from data URL** (no disk needed):
```typescript
const code = await fetch(bundleUrl).then(r => r.text());
const blob = new Blob([code], { type: "text/javascript" });
const url = URL.createObjectURL(blob);
const mod = await import(url);
```

**Approach 3 — Node.js vm module** (sandboxed):
```typescript
import { createContext, runInContext } from "node:vm";

const code = await fetch(bundleUrl).then(r => r.text());
const context = createContext({ console, fetch, crypto });
const result = runInContext(code, context);
```

**We'll use Approach 1** (dynamic import from downloaded file). It's the simplest, gives full Node.js access, and works with source maps.

**Security consideration**: You're executing code uploaded by users. In our case, the user's own API key scopes the deployment — they can only hurt their own project. But you should still validate bundle hashes to prevent tampering.

**Resources**:
- [MDN: Dynamic import()](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import)
- [Node.js vm module docs](https://nodejs.org/api/vm.html)

---

## 10. Content-Addressable Storage

**What it is**: Storing files by their content hash instead of a name. Two files with identical content always produce the same hash (and therefore the same storage key). Changing even one byte produces a completely different hash.

**Why you need it**: Bundle versioning. Instead of version numbers (v1, v2, v3), you use the SHA-256 hash of the bundle content. This guarantees:
- Identical code = identical hash (deduplication)
- Any change = different hash (no stale cache)
- Hash can verify integrity (tampering detection)

```typescript
import { createHash } from "node:crypto";

function hashBundle(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

// Store: bundles/sha256:abc123.../bundle.js
// Lookup: GET /api/bundles/sha256:abc123...
```

**Where you'll use it**: The `deployments` table stores `bundle_hash`. When a worker downloads a bundle, it verifies the hash matches before loading it.

**Resources**:
- [Content-addressable storage (Wikipedia)](https://en.wikipedia.org/wiki/Content-addressable_storage)
- [How Docker uses content-addressable storage for layers](https://docs.docker.com/storage/storagedriver/)

---

## 11. Blue-Green Deployments

**What it is**: Running two versions of your code simultaneously (the "blue" current version and the "green" new version), then switching traffic from blue to green atomically.

**Why you need it**: When a user deploys new task code, existing runs may be mid-execution or suspended. You can't just swap the code — in-flight runs need to finish with the version they started on.

**How it works for task queues**:
```
Deployment v1 (ACTIVE)    →  Worker A running tasks from v1
Deployment v2 (STAGED)    →  No workers yet

User runs: reload deploy  →  v2 uploaded, marked STAGED
                          →  Server marks v2 as ACTIVE
                          →  Server marks v1 as DRAINING
                          →  New runs use v2
                          →  In-flight v1 runs finish naturally
                          →  When all v1 runs complete, v1 is RETIRED
```

**Suspended run problem**: If a run was suspended on v1, and v2 changes the task code, resumption might break (different step order). Solutions:
1. **Simple**: Don't allow deploy while runs are suspended (block deployment)
2. **Better**: Pin each run to its deployment version, load that version on resume
3. **Best**: Version-lock the step results and validate on resume

We'll use option 2 — each run records which `deployment_id` it was created with.

**Resources**:
- [Blue-green deployments (Martin Fowler)](https://martinfowler.com/bliki/BlueGreenDeployment.html)
- [How Vercel handles function deployments](https://vercel.com/docs/deployments/overview)

---

## 12. CLI Design

**What it is**: Building a command-line tool that developers install and use (`npx reload-dev deploy`).

**Key library: Commander.js** (or alternatives like `citty`, `cac`):
```typescript
#!/usr/bin/env node
import { Command } from "commander";

const program = new Command()
  .name("reload-dev")
  .description("reload.dev CLI")
  .version("0.1.0");

program
  .command("deploy")
  .description("Bundle and deploy tasks to reload.dev")
  .option("--dir <path>", "tasks directory", "./tasks")
  .option("--env <environment>", "target environment", "dev")
  .action(async (options) => {
    // 1. Scan for tasks
    // 2. Bundle with esbuild
    // 3. Upload to server
  });

program
  .command("init")
  .description("Initialize a reload.dev project")
  .action(async () => {
    // Create config file, install dependencies
  });

program.parse();
```

**Config file** (like `trigger.config.ts`):
```typescript
// reload.config.ts
export default {
  project: "my-project",
  dirs: ["./tasks"],
  retries: { default: { maxAttempts: 3 } },
};
```

**npm bin field** — how CLIs become commands:
```json
{
  "name": "@reload-dev/cli",
  "bin": {
    "reload-dev": "./dist/cli.js"
  }
}
```

After `npm install -g @reload-dev/cli`, the user can run `reload-dev deploy`.

**Resources**:
- [Commander.js docs](https://github.com/tj/commander.js)
- [How to build a CLI with Node.js (tutorial)](https://blog.logrocket.com/building-typescript-cli-node-js-commander/)
- [Trigger.dev CLI source (reference)](https://github.com/triggerdotdev/trigger.dev/tree/main/packages/cli-v3)

---

## 13. Unified Token Auth — One Auth System for Everything

**What it is**: Instead of maintaining separate auth systems for the dashboard (sessions) and the API (API keys), use ONE token format everywhere. The dashboard stores the token in an httpOnly cookie. The CLI reads it from an env var. The SDK passes it in the constructor. The server has one middleware.

**Why NOT separate session + API key auth**:
- Two auth systems = double the security surface area
- The dashboard needs to "proxy" by looking up API keys from sessions — awkward coupling
- Trigger.dev, Stripe, and Inngest all use a single token format for everything

**How it works**:
```
Dashboard (browser):
  1. User logs in with email + password
  2. Server generates API key (same format as SDK keys)
  3. Server sets httpOnly cookie: Set-Cookie: rl_token=rl_dev_abc123; HttpOnly; Secure; SameSite=Strict
  4. Browser sends cookie automatically on every request
  5. Next.js API route reads cookie, forwards as: Authorization: Bearer rl_dev_abc123
  6. API server validates token with same middleware as SDK/CLI

CLI:
  1. User sets RELOAD_API_KEY=rl_dev_abc123 in .env
  2. CLI reads env var, sends: Authorization: Bearer rl_dev_abc123
  3. Same middleware validates it

SDK:
  1. new ReloadClient({ apiKey: "rl_dev_abc123" })
  2. Sends: Authorization: Bearer rl_dev_abc123
  3. Same middleware validates it
```

**One middleware handles everything**:
```typescript
async function authMiddleware(c: Context, next: Next) {
  const token = c.req.header("authorization")?.slice(7); // Bearer <token>
  if (!token) return c.json({ error: "Unauthorized" }, 401);

  const hash = sha256(token);
  const [key] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash));
  if (!key) return c.json({ error: "Invalid key" }, 401);

  c.set("projectId", key.projectId);
  c.set("keyType", key.keyType); // 'client' or 'server'
  await next();
}
```

**Key types** (per-route permissions):
- `client` keys: Can trigger tasks, read runs/events. For SDK and dashboard users.
- `server` keys: Can also dequeue, complete/fail runs, manage deployments. For workers.

**Why httpOnly cookies are secure**: JavaScript cannot read httpOnly cookies. Even if your dashboard has an XSS vulnerability, the attacker can't steal the token. The browser sends it automatically — no localStorage, no manual header management.

**Library**: Use [better-auth](https://www.better-auth.com/) for signup/login flows. It handles password hashing, email verification, etc. Then generate your own API keys on login.

**Resources**:
- [better-auth docs](https://www.better-auth.com/)
- [OWASP: httpOnly cookies](https://owasp.org/www-community/HttpOnly)
- [Stripe API Authentication](https://stripe.com/docs/api/authentication) — single-token pattern

---

## 14. CORS

**What it is**: Cross-Origin Resource Sharing — a browser security mechanism that controls which websites can make requests to your API.

**Why you need it**: Currently the dashboard proxies through Next.js rewrites (`/api/*` → `localhost:3000`). In production, the dashboard and API might be on different domains. Without CORS headers, the browser blocks the request.

```typescript
import { cors } from "hono/cors";

app.use("*", cors({
  origin: ["https://dashboard.reload.dev", "http://localhost:3001"],
  allowMethods: ["GET", "POST", "PUT", "DELETE"],
  allowHeaders: ["Content-Type", "Authorization"],
  credentials: true, // allow cookies
}));
```

**Resources**:
- [MDN CORS guide](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS)
- [Hono CORS middleware](https://hono.dev/docs/middleware/builtin/cors)

---

## 15. Rate Limiting

**What it is**: Limiting how many requests a client can make in a time window. Prevents abuse, DoS attacks, and runaway scripts.

**Algorithms**:
| Algorithm | How | Pros | Cons |
|-----------|-----|------|------|
| **Fixed window** | Count requests per minute | Simple | Burst at window boundary |
| **Sliding window** | Weighted count across two windows | Smooth | More complex |
| **Token bucket** | Tokens refill at fixed rate | Handles bursts | State management |

**Redis-based rate limiting** (what we'll use):
```typescript
async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const windowKey = `ratelimit:${key}:${Math.floor(now / windowMs)}`;

  const count = await redis.incr(windowKey);
  if (count === 1) {
    await redis.pexpire(windowKey, windowMs);
  }

  return count <= limit;
}
```

**Resources**:
- [Rate limiting strategies (Stripe)](https://stripe.com/blog/rate-limiters)
- [Redis rate limiting patterns](https://redis.io/glossary/rate-limiting/)

---

## 16. Namespace Isolation in Redis

**What it is**: Prefixing all Redis keys with a tenant identifier to prevent data collision in a shared Redis instance.

**Current problem**:
```
queue:default              ← shared across ALL projects
concurrency:webhooks       ← shared across ALL projects
active-queues              ← global set
```

**After namespacing**:
```
proj_abc:queue:default     ← project abc's default queue
proj_xyz:queue:default     ← project xyz's default queue (different key!)
proj_abc:concurrency:webhooks
proj_abc:active-queues
```

**Implementation**: Pass `projectId` through the entire queue/concurrency stack:
```typescript
function createRedisQueue(redis: Redis, projectId: string) {
  return {
    async enqueue(runId: string, queueId: string, priority: number) {
      const key = `${projectId}:queue:${queueId}`;
      await redis.zadd(key, score, runId);
      await redis.sadd(`${projectId}:active-queues`, queueId);
    },
  };
}
```

**Resources**:
- [Redis key naming conventions](https://redis.io/docs/latest/develop/use/keyspace/)
- [Multi-tenant Redis patterns](https://redis.io/blog/5-key-takeaways-for-developing-with-redis/)

---

## 17. Input Validation at Every Layer

**What it is**: Validating not just request bodies, but also URL parameters (`:id`, `:token`) and query parameters (`?status=`, `?limit=`). Every piece of user input that reaches your code should be validated before use.

**Why you need it**: Our codebase validates request bodies with Zod (good), but URL params are passed raw to the database. A malformed UUID in `/api/runs/not-a-uuid` will reach PostgreSQL and cause a cryptic error instead of a clean 400 response.

**The three layers**:

```typescript
// 1. URL params — validate format
const RunIdParam = z.object({
  id: z.string().uuid("Invalid run ID format"),
});

api.get("/runs/:id", async (c) => {
  const result = RunIdParam.safeParse({ id: c.req.param("id") });
  if (!result.success) return c.json({ error: "Invalid run ID" }, 400);
  // now result.data.id is a validated UUID
});

// 2. Query params — validate types and ranges
const ListRunsQuery = z.object({
  status: z.enum(["PENDING", "QUEUED", "EXECUTING", "COMPLETED", "FAILED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

api.get("/runs", async (c) => {
  const result = ListRunsQuery.safeParse({
    status: c.req.query("status"),
    limit: c.req.query("limit"),
    offset: c.req.query("offset"),
  });
  if (!result.success) return c.json({ error: result.error.format() }, 400);
});

// 3. Request bodies — already doing this with Zod schemas (good)
const TriggerRequestSchema = z.object({
  taskId: z.string().min(1),
  payload: z.unknown(),
});
```

**Why `z.coerce.number()`**: Query params arrive as strings (`"50"`). `z.coerce.number()` converts the string to a number and then validates it. Without coercion, `z.number()` would reject all query params because they're strings.

**Max payload size**: Also validate that POST bodies aren't unreasonably large. Add a middleware that checks `Content-Length`:
```typescript
app.use("*", async (c, next) => {
  const size = parseInt(c.req.header("content-length") ?? "0");
  if (size > 10 * 1024 * 1024) return c.json({ error: "Payload too large" }, 413);
  await next();
});
```

**Resources**:
- [Zod coercion docs](https://zod.dev/?id=coercion-for-primitives)
- [OWASP Input Validation Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)

---

## 18. Polling Patterns — triggerAndWait() and Long-Running Operations

**What it is**: When you trigger a task and need to wait for the result, you poll the server repeatedly until the run reaches a terminal state (COMPLETED, FAILED, etc.).

**Why you need it**: The most common pattern after `client.trigger()` is waiting for the result. Without a `triggerAndWait()` helper, every user writes the same manual polling loop. BullMQ, Trigger.dev, and Temporal all provide this.

**The pattern**:
```typescript
async triggerAndWait(taskId: string, payload: unknown, options?: {
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<RunStatus> {
  // 1. Trigger the task
  const { runId } = await this.trigger(taskId, payload);

  // 2. Poll until terminal state
  const deadline = Date.now() + (options?.timeoutMs ?? 30_000);
  const interval = options?.pollIntervalMs ?? 500;

  while (Date.now() < deadline) {
    const run = await this.getRun(runId);

    // Terminal states — return immediately
    if (["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(run.status)) {
      return run;
    }

    // Not done yet — wait before next poll
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error(`Run ${runId} timed out after ${options?.timeoutMs ?? 30_000}ms`);
}
```

**Key design choices**:
- **Timeout**: Default 30 seconds. Users can override for long-running tasks.
- **Poll interval**: Default 500ms. Not too aggressive (server load), not too slow (user waiting).
- **Terminal states**: COMPLETED, FAILED, CANCELLED, EXPIRED — any of these means "done, stop polling."
- **Error on timeout**: Throw rather than return partial result. The run is still executing — the client just stopped waiting.

**Future improvement — SSE instead of polling**:
```typescript
// Instead of polling, subscribe to the run's SSE stream:
const source = new EventSource(`/api/runs/${runId}/stream`);
source.addEventListener("update", (e) => {
  const data = JSON.parse(e.data);
  if (data.toStatus === "COMPLETED") {
    resolve(data);
    source.close();
  }
});
```

SSE is more efficient (no repeated HTTP requests), but polling is simpler and works everywhere (including server-side Node.js where EventSource isn't built-in).

**Resources**:
- [Polling vs SSE vs WebSockets (comparison)](https://ably.com/blog/websockets-vs-long-polling)
- [Trigger.dev triggerAndWait docs](https://trigger.dev/docs/triggering)
