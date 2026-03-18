# Phase 1: Multi-Tenancy Database Schema

## What Changed

Phase 1 adds the foundation for multi-tenancy: user accounts, projects, API keys, and project-scoping on all existing tables.

## New Tables

### `users`
Stores user accounts for dashboard login.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | Primary key, auto-generated |
| email | TEXT | Unique, used for login |
| name | TEXT | Display name (optional) |
| password_hash | TEXT | SHA-256 hash of password |
| created_at | TIMESTAMP | Auto-set |

### `projects`
Each user can have multiple projects. All data (runs, tasks, queues, workers) is scoped to a project.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | Primary key, auto-generated |
| user_id | UUID | FK → users.id (cascade delete) |
| name | TEXT | Display name |
| slug | TEXT | URL-friendly identifier |
| created_at | TIMESTAMP | Auto-set |

Unique constraint: `(user_id, slug)` — slugs are unique per user.

### `api_keys`
Authentication tokens for API access. Each key is scoped to a project and has a type + environment.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | Primary key, auto-generated |
| project_id | UUID | FK → projects.id (cascade delete) |
| name | TEXT | Human label (e.g., "Production Key") |
| key_hash | TEXT | SHA-256 hash of the raw key (UNIQUE) |
| key_prefix | TEXT | First 12 chars of key (safe to display) |
| key_type | TEXT | `client` or `server` |
| environment | TEXT | `dev`, `staging`, or `prod` |
| last_used_at | TIMESTAMP | Updated on each API call |
| expires_at | TIMESTAMP | Optional expiry |
| created_at | TIMESTAMP | Auto-set |

**Key types:**
- `client` — For SDK users. Can trigger tasks and read data.
- `server` — For workers. Can also dequeue, complete/fail runs, manage deployments.

**Key format:** `rl_{environment}_{random}` — e.g., `rl_dev_abc123def456...`

## Modified Tables

All 7 existing tables received a `project_id UUID NOT NULL` column with a foreign key to `projects.id`:

- `queues` — project-scoped queue definitions
- `tasks` — project-scoped task registrations
- `runs` — project-scoped run executions
- `workers` — project-scoped worker registrations
- `run_events` — project-scoped event log
- `run_steps` — project-scoped step cache
- `waitpoints` — project-scoped waitpoints

New indexes added for multi-tenant query performance:
- `(project_id)` on all 7 tables
- `(project_id, queue_id, status)` on runs (replaces old queue_status index)
- `(project_id, status)` on runs
- `(project_id, created_at)` on run_events

## Core Type Changes

The `Run`, `TaskDefinition`, `Queue`, and `Worker` interfaces in `@reload-dev/core/types` now include `readonly projectId: string`.

## Engine Changes

The run engine now:
- Includes `projectId` when normalizing DB rows to Run objects
- Includes `projectId` in PG NOTIFY payloads (for SSE filtering in Phase 2)
- Includes `projectId` when inserting run events

## Seed Script

`pnpm db:seed` creates:
1. A default admin user (`admin@reload.dev`)
2. A default project ("Default Project", slug: "default")
3. A default API key (printed once — save it)
4. Backfills `project_id` on all existing rows

## How to Apply

```bash
# 1. Push the new schema to the database
pnpm db:push

# 2. Run the seed script to create default user/project and backfill
pnpm db:seed

# 3. Save the API key that's printed — you'll need it for Phase 2
```

## What's Next (Phase 2)

Phase 2 will add the auth middleware that validates API keys on every request and scopes all queries by `projectId`. Until then, the API remains open — but the schema is ready.
