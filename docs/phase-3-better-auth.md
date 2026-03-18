# Phase 3: Better-Auth Integration — User Authentication

## What Changed

Phase 3 adds user authentication (signup, login, sessions) via the better-auth library. Users can now create accounts, manage projects, and generate API keys — all from the dashboard.

## Architecture: Two Auth Systems

The system now has two authentication layers that coexist:

| Layer | Mechanism | Who Uses It | What It Protects |
|-------|-----------|-------------|-----------------|
| **User Auth** (better-auth) | Session cookies | Dashboard users | `/api/auth/**` routes |
| **API Key Auth** (existing) | Bearer tokens | SDK, Worker, CLI | `/api/*` routes (everything else) |

Both systems converge at `projectId`: session auth resolves user → project, API key auth resolves key → project. All route handlers receive `projectId` regardless of which auth path was used.

## New Files

### Server
- `packages/server/src/auth.ts` — better-auth instance configuration
- `packages/server/src/routes/projects.ts` — Session-authenticated project + API key management

### Dashboard
- `packages/dashboard/src/lib/auth-client.ts` — better-auth React client (signIn, signUp, useSession)
- `packages/dashboard/src/lib/api.ts` — Fetch wrapper that auto-adds API key headers
- `packages/dashboard/src/lib/project-store.ts` — Zustand store for current project + API key
- `packages/dashboard/src/app/auth-layout.tsx` — Auth-aware layout (redirects to login if unauthenticated)
- `packages/dashboard/src/app/login/page.tsx` — Login page
- `packages/dashboard/src/app/signup/page.tsx` — Signup page
- `packages/dashboard/src/app/onboarding/page.tsx` — First-time project creation + API key display
- `packages/dashboard/src/app/settings/page.tsx` — Project settings + API key management

## Modified Files

### Server
- `packages/server/src/index.ts` — Mounts better-auth handler, CORS middleware, project routes
- `packages/server/src/db/schema.ts` — Replaced old `users` table with better-auth schema (users, sessions, accounts, verifications)
- `packages/server/src/db/seed.ts` — Updated for new schema (creates user + account entry)

### Dashboard
- `packages/dashboard/src/app/layout.tsx` — Uses auth-aware layout component
- `packages/dashboard/src/app/providers.tsx` — Hydrates API key from Zustand store
- `packages/dashboard/next.config.ts` — Uses env var for server URL

## Database Schema Changes

### Replaced: `users` table
Old: `id (UUID), email, name, passwordHash, createdAt`
New: `id (TEXT), name, email, emailVerified, image, createdAt, updatedAt` (better-auth managed)

### New: `sessions` table
`id, userId, token, expiresAt, ipAddress, userAgent, createdAt, updatedAt`

### New: `accounts` table
`id, userId, accountId, providerId, password (hashed), accessToken, refreshToken, createdAt, updatedAt`

### New: `verifications` table
`id, identifier, value, expiresAt, createdAt, updatedAt`

### Modified: `projects.userId`
Changed from `uuid` to `text` type to match better-auth's user ID format.

## User Flow

```
1. User visits dashboard → auth-layout checks session → redirects to /login
2. User signs up at /signup → better-auth creates user + account + session
3. User redirected to /onboarding → creates first project → gets API key (shown once)
4. User saves API key → Zustand store persists it → all API calls auto-include it
5. Dashboard loads → nav shows project name + user email
6. API calls go through fetch wrapper → adds Authorization: Bearer <key> header
7. Server validates API key → scopes all queries by projectId
```

## Route Mounting Order (Critical)

```typescript
app.get("/health", ...);                    // No auth
app.on(["POST","GET"], "/api/auth/**", ...) // better-auth (signup/login/session)
app.route("/api/auth", projectRoutes);      // Session-authenticated project management
app.use("/api/*", authMiddleware);          // API key validation for everything else
app.route("/api", authRoutes);              // API key management (requires API key)
app.route("/api", routes);                  // All data routes (requires API key)
app.route("/api", streamRoutes);            // SSE streams (requires API key)
```

## Environment Variables

```
BETTER_AUTH_SECRET=your-32-char-secret-change-in-production
BETTER_AUTH_URL=http://localhost:3000
DASHBOARD_URL=http://localhost:3001
NEXT_PUBLIC_SERVER_URL=http://localhost:3000
```

## How to Apply

```bash
# 1. Push the updated schema
pnpm db:push

# 2. Seed default user + project + API key
pnpm db:seed

# 3. Set env vars
export BETTER_AUTH_SECRET="dev-secret-change-in-production-min-32-chars"

# 4. Start server
pnpm server

# 5. Start dashboard
pnpm dashboard

# 6. Visit http://localhost:3001/signup to create your account
```

## What's Next (Phase 4)

Phase 4 prepares packages for npm publication (`@reload-dev/sdk`, `@reload-dev/worker`).
