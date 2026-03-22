# Better-Auth Integration Plan — Detailed Implementation Report

## Executive Summary

We need user authentication (signup/login/sessions) for the dashboard. We already have API key auth for machine-to-machine (SDK/worker). **better-auth** handles the user auth part. The two systems coexist: better-auth manages users + sessions, our existing middleware manages API keys + project scoping.

**What better-auth gives us**: Signup, login, session management, password hashing (scrypt), cookie handling, CSRF protection — all battle-tested. We don't roll our own crypto.

**What stays ours**: API key generation, validation, project scoping, Redis namespacing, PG NOTIFY filtering. None of this changes.

---

## Part 1: How Better-Auth Works (The Essentials)

### Core Architecture

better-auth uses Web Standard `Request`/`Response` objects — works natively with Hono (no adapter needed). It creates 4 database tables and handles all auth flows.

### Database Tables It Creates

| Table | Columns | Purpose |
|-------|---------|---------|
| `user` | id, name, email, emailVerified, image, createdAt, updatedAt | User accounts |
| `session` | id, userId, token, expiresAt, ipAddress, userAgent, createdAt, updatedAt | Server-side sessions |
| `account` | id, userId, accountId, providerId, password, accessToken, refreshToken, createdAt, updatedAt | Auth providers (email/password stores hashed password HERE, not in user table) |
| `verification` | id, identifier, value, expiresAt, createdAt, updatedAt | Email verification tokens, password reset tokens |

### Session Mechanism

- **Cookie-based, database-backed** — NOT JWTs
- Random session token stored in both DB (`session` table) and httpOnly cookie
- Default expiry: 7 days, auto-refreshes when `updateAge` (1 day default) elapses
- Cookie caching available (5-min signed cookie to reduce DB lookups)
- Server-side: `auth.api.getSession({ headers: req.headers })` returns user + session
- Client-side: `useSession()` React hook (reactive), `authClient.getSession()` (promise)

### Password Hashing

- Default: **scrypt** (Node.js native — no native dependencies, no compilation)
- Customizable to argon2/bcrypt via `password: { hash, verify }` config
- Passwords stored in `account` table, NOT `user` table (different from our current `users.passwordHash`)

### Hono Integration (First-Class)

```typescript
// Mount handler — handles ALL auth routes at /api/auth/*
app.on(["POST", "GET"], "/api/auth/**", (c) => {
  return auth.handler(c.req.raw);
});
```

### Next.js App Router Integration

```typescript
// app/api/auth/[...all]/route.ts
import { toNextJsHandler } from "better-auth/next-js";
export const { POST, GET } = toNextJsHandler(auth);
```

```typescript
// Client-side React hooks
import { createAuthClient } from "better-auth/react";
export const { signIn, signUp, signOut, useSession } = createAuthClient({
  baseURL: "http://localhost:3000",
});
```

### Drizzle ORM Adapter

```typescript
import { drizzleAdapter } from "better-auth/adapters/drizzle";

const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
});
```

---

## Part 2: Current State vs Target State

### What Exists Today

```
Dashboard → (Next.js rewrite, NO auth) → Server → (API key middleware) → Routes
                                                     ↑
                                          Validates Bearer token
                                          Sets projectId on context
                                          All queries scoped
```

- Dashboard sends NO auth headers (relies on localhost proxy)
- Server's auth middleware applies to ALL `/api/*` routes
- `users` table exists but is orphaned (only seed script writes to it)
- `projects` table exists but userId→project lookup is never verified
- API keys are the sole auth mechanism

### Target State

```
Dashboard → (better-auth session cookie) → Server
  │                                          │
  │  Login/Signup:                           │  /api/auth/* (better-auth handles)
  │  POST /api/auth/sign-up/email            │  No API key needed
  │  POST /api/auth/sign-in/email            │
  │                                          │
  │  Data requests:                          │  /api/* (existing API key middleware)
  │  GET /api/runs                           │  Dashboard sends Bearer token
  │  POST /api/trigger                       │  from user's project API key
  │                                          │
SDK/Worker → (API key, same as today) → Server → /api/* routes (unchanged)
```

### The Two Auth Paths Converge at `projectId`

```
Path 1 (SDK/Worker):
  Bearer rl_dev_xxx → SHA-256 → apiKeys lookup → projectId ✓

Path 2 (Dashboard):
  Session cookie → better-auth → user → projects lookup → apiKey → projectId ✓
```

Both paths end with `projectId` set on the Hono context. All existing route handlers work unchanged.

---

## Part 3: Schema Decisions

### Conflict: Our `users` Table vs Better-Auth's `user` Table

**Our table**:
```
users: id (UUID), email, name, passwordHash, createdAt
```

**Better-auth's table**:
```
user: id (string), name, email, emailVerified, image, createdAt, updatedAt
```

**Key difference**: Better-auth stores passwords in the `account` table (via `providerId: "credential"`), NOT in the `user` table. Our `users.passwordHash` column is incompatible.

### Resolution: Let better-auth manage its own tables

**Approach**: Let better-auth create its own `user`, `session`, `account`, `verification` tables (with `usePlural: true` for plural naming). Our existing `projects` table points to better-auth's `users` table instead of our old one.

**Migration**:
1. Drop our old `users` table (only has seed data)
2. Let better-auth create `users`, `sessions`, `accounts`, `verifications`
3. Update `projects.userId` FK to point to better-auth's `users.id`
4. Drop `users.passwordHash` column (passwords live in `accounts` now)

**Why this is safe**: Our `users` table is orphaned — nothing in production reads from it. The seed script created one row. We can recreate it via better-auth's signup flow.

### New Schema After Integration

```
better-auth manages:
  users          → id, name, email, emailVerified, image, createdAt, updatedAt
  sessions       → id, userId, token, expiresAt, ipAddress, userAgent, ...
  accounts       → id, userId, providerId, password (hashed), ...
  verifications  → id, identifier, value, expiresAt, ...

We manage (unchanged):
  projects       → id, userId (FK→users.id), name, slug, createdAt
  api_keys       → id, projectId (FK→projects.id), keyHash, keyType, ...
  queues         → id, projectId, ...
  tasks          → id, projectId, ...
  runs           → id, projectId, ...
  workers        → id, projectId, ...
  run_events     → id, projectId, ...
  run_steps      → id, projectId, ...
  waitpoints     → id, projectId, ...
```

---

## Part 4: Phased Implementation Plan

### Phase 3A: Server-Side Better-Auth Setup

**Goal**: better-auth handles signup/login on the server. Session cookies work. Existing API key auth is untouched.

#### Step 3A.1 — Install better-auth

```bash
cd packages/server
pnpm add better-auth
```

#### Step 3A.2 — Create auth instance

**New file**: `packages/server/src/auth.ts`

```typescript
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createDb } from "./db/index.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://reload:reload@localhost:5432/reload";
const db = createDb(DATABASE_URL);

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    usePlural: true,  // creates "users", "sessions", "accounts", "verifications"
  }),
  secret: process.env.BETTER_AUTH_SECRET,  // Required: 32+ char secret
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  emailAndPassword: {
    enabled: true,
    // scrypt is the default — Node.js native, no deps
  },
  session: {
    expiresIn: 7 * 24 * 60 * 60,  // 7 days
    updateAge: 24 * 60 * 60,       // refresh if >1 day old
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,  // 5-min cookie cache to reduce DB lookups
    },
  },
  trustedOrigins: [
    process.env.DASHBOARD_URL ?? "http://localhost:3001",
  ],
});
```

#### Step 3A.3 — Mount better-auth handler in Hono

**File**: `packages/server/src/index.ts`

```typescript
import { auth } from "./auth.js";

// better-auth routes — NO API key required (user signup/login)
app.on(["POST", "GET"], "/api/auth/**", (c) => {
  return auth.handler(c.req.raw);
});

// Existing API key auth — still applies to all other /api/* routes
app.use("/api/*", authMiddleware);
```

**Critical**: better-auth routes MUST be mounted BEFORE the API key middleware. The route order matters:
1. `/api/auth/**` → better-auth (no API key needed)
2. `/api/*` → API key middleware (everything else)

#### Step 3A.4 — Generate better-auth schema + migrate

```bash
cd packages/server
npx @better-auth/cli generate  # generates Drizzle schema additions
pnpm drizzle-kit generate       # generates SQL migration
pnpm drizzle-kit migrate        # applies to DB
```

#### Step 3A.5 — Update our schema

Modify `projects` table to FK to better-auth's `users` table (same `id` column, just different table shape).

Drop our old `users` table definition from `schema.ts` (better-auth manages it now). Keep the `projects`, `apiKeys`, and all other tables unchanged.

#### Step 3A.6 — Add user-to-project endpoints

**New file**: `packages/server/src/routes/projects.ts`

These endpoints use better-auth session (not API key):

```typescript
// POST /api/auth/projects — create project (requires session)
// GET /api/auth/projects — list user's projects (requires session)
// GET /api/auth/projects/:id — get project details (requires session)
```

These are mounted under `/api/auth/` which bypasses the API key middleware.

#### Step 3A.7 — Add "create first API key" flow

After signup, the user needs their first API key. Add an endpoint:

```
POST /api/auth/projects/:id/keys — creates API key for a project (requires session, user must own project)
```

This breaks the chicken-and-egg: user signs up → creates project → gets first API key → can now use SDK/worker.

**Deliverable**: Server handles signup/login via better-auth. Session cookies work. User can create projects and get API keys. Existing API key auth is unchanged.

---

### Phase 3B: Dashboard Client-Side Auth

**Goal**: Dashboard has login/signup pages, session management, and sends authenticated requests.

#### Step 3B.1 — Install better-auth client

```bash
cd packages/dashboard
pnpm add better-auth
```

#### Step 3B.2 — Create auth client

**New file**: `packages/dashboard/src/lib/auth-client.ts`

```typescript
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3000",
});

export const { signIn, signUp, signOut, useSession } = authClient;
```

#### Step 3B.3 — Create login + signup pages

**New file**: `packages/dashboard/src/app/(auth)/login/page.tsx`
- Email + password form
- Calls `signIn.email({ email, password })`
- On success: redirect to `/`
- On error: show message

**New file**: `packages/dashboard/src/app/(auth)/signup/page.tsx`
- Email + password + name form
- Calls `signUp.email({ name, email, password })`
- On success: redirect to onboarding or `/`

#### Step 3B.4 — Create auth-aware layout

**Modified**: `packages/dashboard/src/app/layout.tsx`
- Check session: `const { data: session } = useSession()`
- If no session → redirect to `/login`
- If session → render nav + children

#### Step 3B.5 — Create API fetch wrapper

**New file**: `packages/dashboard/src/lib/api.ts`

All dashboard API calls go through this wrapper that handles auth:

```typescript
export async function apiCall(path: string, options?: RequestInit): Promise<Response> {
  // Get the user's active project API key from session/store
  const apiKey = await getActiveProjectApiKey();

  return fetch(`${SERVER_URL}/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      ...options?.headers,
    },
  });
}
```

#### Step 3B.6 — Update all dashboard pages

Every page's `useQuery` calls change from:
```typescript
fetch("/api/runs")  // old: no auth
```
To:
```typescript
apiCall("/runs")  // new: auto-adds auth header
```

#### Step 3B.7 — Handle SSE authentication

**Problem**: `EventSource` doesn't support custom headers.

**Solution**: Use query parameter for session token on SSE endpoints:
```typescript
const source = new EventSource(`/api/stream?token=${apiKey}`);
```

Server-side: add alternative token extraction from query param for SSE routes only:
```typescript
// In stream routes, before auth:
const token = c.req.query("token") ?? c.req.header("authorization")?.slice(7);
```

#### Step 3B.8 — Project management UI

**New page**: `packages/dashboard/src/app/settings/page.tsx`
- Current project info
- API key list (create/revoke)
- Project switcher

**New component**: Project selector in nav sidebar
- Dropdown showing user's projects
- Switching updates the active project (stored in cookie/Zustand)
- All API calls use the active project's API key

**Deliverable**: Dashboard has full login/signup flow. All API calls are authenticated. Project management works.

---

### Phase 3C: Onboarding Flow

**Goal**: First-time user experience is smooth.

#### Step 3C.1 — Post-signup flow

After signup:
1. Auto-create default project ("My Project", slug: user's name)
2. Auto-generate a `server` API key for the project
3. Show onboarding page with:
   - "Your project has been created"
   - API key displayed (copy button, shown once)
   - "Install the SDK" code snippet
   - "Start the worker" command with env var
4. Redirect to dashboard

#### Step 3C.2 — Empty states

When a new user has no runs/tasks/workers, show helpful empty states:
- "No tasks yet. Deploy your first task with `npx reload-dev deploy`"
- "No runs yet. Trigger a task from the SDK or the Trigger page"
- "No workers online. Start a worker with `RELOAD_API_KEY=xxx pnpm worker`"

**Deliverable**: New users can go from signup to first task trigger in under 2 minutes.

---

## Part 5: What Changes and What Doesn't

### Files That Change

| File | Change |
|------|--------|
| `packages/server/package.json` | Add `better-auth` dependency |
| `packages/server/src/auth.ts` | **NEW** — better-auth instance |
| `packages/server/src/index.ts` | Mount better-auth handler before API key middleware |
| `packages/server/src/db/schema.ts` | Remove old `users` table (better-auth manages it), keep everything else |
| `packages/server/src/routes/projects.ts` | **NEW** — project management endpoints (session-authed) |
| `packages/server/src/routes/stream.ts` | Support query-param token for SSE auth |
| `packages/server/src/db/seed.ts` | Update to use better-auth's signup instead of direct insert |
| `packages/dashboard/package.json` | Add `better-auth` dependency |
| `packages/dashboard/src/lib/auth-client.ts` | **NEW** — auth client hooks |
| `packages/dashboard/src/lib/api.ts` | **NEW** — fetch wrapper with auth |
| `packages/dashboard/src/app/layout.tsx` | Auth-aware layout |
| `packages/dashboard/src/app/providers.tsx` | Add auth session check |
| `packages/dashboard/src/app/(auth)/login/page.tsx` | **NEW** |
| `packages/dashboard/src/app/(auth)/signup/page.tsx` | **NEW** |
| `packages/dashboard/src/app/settings/page.tsx` | **NEW** — project + key management |
| `packages/dashboard/next.config.ts` | Remove old rewrite, add CORS-aware config |
| All existing dashboard pages | Change `fetch("/api/...")` to `apiCall("/...")` |

### Files That DON'T Change

| File | Why |
|------|-----|
| `packages/server/src/middleware/auth.ts` | API key middleware stays as-is |
| `packages/server/src/routes/index.ts` | All route handlers stay as-is (projectId scoping unchanged) |
| `packages/server/src/routes/auth.ts` | API key management stays as-is |
| `packages/sdk/src/client.ts` | SDK auth stays as-is |
| `packages/worker/src/index.ts` | Worker auth stays as-is |
| `packages/engine/*` | Engine is auth-agnostic |
| `packages/core/*` | Core types unchanged |

### Database Tables

| Table | Change |
|-------|--------|
| `users` | **REPLACED** by better-auth's `users` table (different shape) |
| `sessions` | **NEW** — better-auth manages |
| `accounts` | **NEW** — better-auth manages (passwords stored here) |
| `verifications` | **NEW** — better-auth manages |
| `projects` | FK updated to point to better-auth's users.id |
| `api_keys` | No change |
| `queues`, `tasks`, `runs`, etc. | No change |

---

## Part 6: Environment Variables

Add to `.env`:
```
BETTER_AUTH_SECRET=your-32-character-secret-here-change-in-prod
BETTER_AUTH_URL=http://localhost:3000
DASHBOARD_URL=http://localhost:3001
```

Add to dashboard `.env.local`:
```
NEXT_PUBLIC_SERVER_URL=http://localhost:3000
```

---

## Part 7: Risks and Gotchas

### 1. EventSource + Auth Headers
`EventSource` API doesn't support custom headers. We handle this with query-param tokens for SSE endpoints. This is less secure (token in URL = visible in logs) but acceptable for internal dashboard use. In production, use short-lived tokens.

### 2. CORS Between Dashboard and Server
With better-auth, the dashboard (port 3001) makes direct requests to the server (port 3000) for auth endpoints. This requires CORS configuration on the server. better-auth's `trustedOrigins` config handles this.

### 3. Cookie Domain
Session cookies set by the server (port 3000) won't automatically be sent to the dashboard (port 3001) unless cookie domain is configured correctly. In local dev, both are on `localhost` so this works. In production, use a shared domain or subdomain (`api.reload.dev` + `app.reload.dev`).

### 4. Password Migration
Our seed script used SHA-256 for password hashing. better-auth uses scrypt. The seed script needs to be updated to use better-auth's signup flow instead of direct DB inserts. Existing seed data should be re-created via the new flow.

### 5. better-auth's `user.id` Format
better-auth generates string IDs (not UUIDs by default). Our `projects.userId` is a UUID column. We need to configure better-auth to use UUIDs:
```typescript
const auth = betterAuth({
  advanced: {
    generateId: () => crypto.randomUUID(),
  },
});
```

### 6. Multiple Projects Per User
When a user logs in, they may own multiple projects. The dashboard needs a "current project" concept (stored in cookie or Zustand). All API calls use the current project's API key. Switching projects changes the API key.

---

## Part 8: Implementation Order

```
Phase 3A (Server):
  3A.1 Install better-auth
  3A.2 Create auth instance (auth.ts)
  3A.3 Mount in Hono (before API key middleware)
  3A.4 Generate schema + migrate
  3A.5 Update our schema (drop old users table)
  3A.6 Add project management endpoints
  3A.7 Add first-API-key flow

Phase 3B (Dashboard — can start after 3A.3):
  3B.1 Install better-auth client
  3B.2 Create auth client hooks
  3B.3 Login + signup pages
  3B.4 Auth-aware layout
  3B.5 Fetch wrapper with auth
  3B.6 Update all pages
  3B.7 SSE authentication
  3B.8 Project management UI

Phase 3C (Onboarding — after 3B):
  3C.1 Post-signup auto-setup
  3C.2 Empty states

CORS config: Do in 3A.3 alongside Hono setup
Seed script update: Do in 3A.5 alongside schema changes
```

### Parallelizable Work

```
3A.1-3A.5 (server setup)  ──→  3A.6-3A.7 (project endpoints)
                           ──→  3B.1-3B.3 (dashboard client + pages)
                                     ↓
                               3B.4-3B.8 (dashboard wiring)
                                     ↓
                               3C.1-3C.2 (onboarding)
```

---

## Part 9: What This Unlocks

After Phase 3 is complete:
- Users can sign up, log in, create projects, generate API keys — all from the dashboard
- No more seed scripts for initial setup
- Multiple projects per user with project switching
- Dashboard is production-ready (works on any domain, not just localhost)
- The flow is: Signup → Create Project → Get API Key → Install SDK → Deploy Tasks → See in Dashboard
- API key auth for SDK/worker is completely untouched
