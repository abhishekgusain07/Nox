# Phase 5: CLI & Task Bundling

## What Changed

Phase 5 adds the `@reload-dev/cli` package with commands for initializing, developing, and deploying tasks. It also adds the server-side deployment infrastructure.

## New Package: `@reload-dev/cli`

Commands:
- `reload-dev init` — scaffold config + tasks
- `reload-dev deploy` — bundle with esbuild + upload to server
- `reload-dev dev` — local worker with tsx watch (no bundling)
- `reload-dev whoami` — verify API key

## Deploy Flow

```
reload-dev deploy
  1. Load reload.config.ts (via esbuild transpile)
  2. Bundle tasks/index.ts → .reload/dist/bundle.js (esbuild)
  3. Import bundle → extract task metadata (id, queue, retry)
  4. POST /api/deployments (upload bundle + manifest)
  5. POST /api/deployments/:id/activate (activate + register tasks)
```

## New Server Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | /api/deployments | Upload new deployment |
| GET | /api/deployments | List deployments |
| GET | /api/deployments/active | Get active deployment |
| POST | /api/deployments/:id/activate | Activate a deployment |
| GET | /api/deployments/:id/bundle | Download bundle file |

## New Database Table: `deployments`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| project_id | UUID | FK->projects |
| version | TEXT | Content hash |
| bundle_hash | TEXT | Full SHA-256 |
| bundle_path | TEXT | Filesystem path |
| manifest | JSONB | Task metadata |
| status | ENUM | STAGED/ACTIVE/SUPERSEDED/FAILED |
| created_at | TIMESTAMP | |
| activated_at | TIMESTAMP | |

## Bundle Storage

Stored on filesystem: `data/bundles/<projectId>/<bundleHash>/bundle.js`

## What's Next (Phase 6)

Phase 6 adds dynamic task loading — workers download and execute bundles from the server instead of using static imports.
