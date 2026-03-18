# Phase 7: Rate Limiting & Production Hardening

## What Changed

Phase 7 adds rate limiting, audit logging, security headers, request validation, and payload size limits.

## New Middleware

### Rate Limiting (`middleware/rate-limit.ts`)
Redis-based sliding window rate limiter using sorted sets.

| Scope | Limit | Window | Applied To |
|-------|-------|--------|------------|
| Per IP | 20 req/min | 60s | `/api/auth/*` (login, signup) |
| Per API Key | 200 req/min | 60s | All `/api/*` routes |

Response headers on every request:
- `X-RateLimit-Limit` — max requests allowed
- `X-RateLimit-Remaining` — requests left in window
- `X-RateLimit-Reset` — when the window resets (Unix timestamp)

On limit exceeded: `429 Too Many Requests` with `Retry-After` header.

Falls back to allowing requests if Redis is unavailable (fail-open).

### Security Headers (`middleware/security.ts`)
Applied to all responses:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 0` (modern browsers handle this)
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `Strict-Transport-Security` (production only)

### Max Payload Size
Rejects POST bodies over 10MB with `413 Payload Too Large`.

### Request ID
Every request gets an `X-Request-Id` header for tracing. If the client sends one, it's preserved.

### Input Validation (`middleware/validate.ts`)
Zod schemas for URL params and query params:
- `UuidParam` — validates `:id` parameters as UUIDs
- `ListRunsQuery` — validates status enum, limit (1-100), offset
- `ListEventsQuery` — validates taskId, eventType, limit, offset
- `validateUuidParam(name)` — middleware factory for UUID params
- `validateQuery(schema)` — middleware factory for query params

## Audit Logging (`middleware/audit.ts`)

### New Table: `audit_logs`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| project_id | UUID | FK→projects |
| api_key_id | UUID | Nullable (null for session-authed actions) |
| action | TEXT | e.g., "key.created", "deployment.activated" |
| resource_type | TEXT | e.g., "api_key", "deployment", "run" |
| resource_id | TEXT | ID of the affected resource |
| details | JSONB | Additional context |
| ip_address | TEXT | Client IP |
| created_at | TIMESTAMP | |

### Usage
```typescript
await auditLog.log({
  projectId,
  apiKeyId,
  action: "deployment.activated",
  resourceType: "deployment",
  resourceId: deploymentId,
  details: { version: "abc123" },
  ipAddress: auditLog.getIp(c),
});
```

## Middleware Stack Order

```
Request
  → Logger
  → CORS
  → Security Headers
  → Request ID
  → Max Payload Size (10MB)
  → Rate Limit by IP (unauthenticated routes)
  → better-auth / project routes
  → API Key Auth
  → Rate Limit by API Key (authenticated routes)
  → Route Handler
Response
```

## What's Complete

All 8 phases of the roadmap are now implemented:
- Phase 0: Build pipeline
- Phase 1: Multi-tenant schema
- Phase 2: Auth middleware
- Phase 3: Dashboard auth (better-auth)
- Phase 4: npm publication readiness
- Phase 5: CLI & task bundling
- Phase 6: Managed worker
- Phase 7: Production hardening
