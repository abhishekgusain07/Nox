# NOX

An open-source, self-hostable background task queue platform for TypeScript. Define tasks as code, trigger them via API or dashboard, and let the engine handle retries, concurrency, scheduling, and real-time observability.

Think [Trigger.dev](https://trigger.dev) — but fully open source, MIT licensed, and yours to deploy.

## Features

- **Type-safe task definitions** — Define tasks with full TypeScript types for payload and output
- **Automatic retries** — Exponential backoff with jitter, configurable per task
- **Concurrency control** — Redis-backed per-queue concurrency limits with Lua atomics
- **Real-time dashboard** — Watch runs execute, inspect payloads/outputs, trigger tasks manually
- **Waitpoints & suspension** — `triggerAndWait`, `waitFor` (duration), external tokens, batch waits
- **Deployment pipeline** — CLI bundles tasks with esbuild, uploads to server, managed workers hot-reload
- **PostgreSQL as a queue** — `SKIP LOCKED` for contention-free dequeuing across workers
- **SSE live updates** — Dashboard updates in real-time via Postgres NOTIFY + SSE
- **Heartbeat monitoring** — Detect crashed workers and auto-retry stale runs
- **TTL expiration** — Runs stuck in queue past their TTL are automatically expired
- **Audit logging** — Track who triggered what, when
- **Multi-project isolation** — All data scoped by `projectId`, zero cross-project leakage

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **API Server** | [Hono](https://hono.dev) (lightweight, runs on Node.js) |
| **Dashboard** | [Next.js 15](https://nextjs.org) + React 19, TailwindCSS 4, Zustand, TanStack Query |
| **Database** | PostgreSQL 16 via [Drizzle ORM](https://orm.drizzle.team) |
| **Cache & Queues** | Redis 7 via [ioredis](https://github.com/redis/ioredis) |
| **Auth** | [better-auth](https://www.better-auth.com) (sessions + API keys) |
| **CLI** | [Commander](https://github.com/tj/commander.js) + [esbuild](https://esbuild.github.io) |
| **Validation** | [Zod](https://zod.dev) |
| **Monorepo** | pnpm workspaces + [Turborepo](https://turbo.build) |
| **Language** | TypeScript (strict, ESM throughout) |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Dashboard (:3001)                          │
│         Next.js + TanStack Query + Zustand                  │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP
┌────────────────────────▼────────────────────────────────────┐
│                     Server (:3000)                           │
│                  Hono API + SSE                              │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌────────┐  ┌──────────────┐  │
│  │  Auth    │  │ API Key  │  │ Engine │  │  Schedulers   │  │
│  │(sessions)│  │  Auth    │  │ (state │  │  & Monitors   │  │
│  │          │  │ (Bearer) │  │ machine│  │               │  │
│  └──────────┘  └──────────┘  └────────┘  └──────────────┘  │
│                                                              │
│  ┌──────────────────┐    ┌──────────────────┐               │
│  │   PostgreSQL 16  │    │     Redis 7      │               │
│  │  (state, queue,  │    │  (concurrency,   │               │
│  │   auth, deploy)  │    │   sorted sets)   │               │
│  └──────────────────┘    └──────────────────┘               │
└─────────────────────────────────────────────────────────────┘
                         ▲ HTTP (polling)
┌────────────────────────┴────────────────────────────────────┐
│                      Worker                                  │
│  Static (dev): import tasks at compile time                  │
│  Managed (prod): fetch bundle, dynamic import, hot-reload    │
└─────────────────────────────────────────────────────────────┘
```

Tasks flow through a state machine:

```
PENDING → QUEUED → EXECUTING → COMPLETED
                      │
                      ├→ SUSPENDED → QUEUED (waitpoint resolved)
                      ├→ DELAYED → QUEUED (retry backoff)
                      ├→ FAILED (retries exhausted)
                      └→ CANCELLED
```

For a deep dive, see [`docs/architecture-deep-dive.md`](docs/architecture-deep-dive.md).

## Project Structure

```
reload-dev/
├── packages/
│   ├── core/           # Shared types, Zod schemas, Result<T,E>, branded IDs
│   ├── engine/         # State machine, run engine, retry, waitpoints, schedulers
│   ├── server/         # Hono API server, auth, routes, DB schema (Drizzle)
│   ├── dashboard/      # Next.js 15 web UI
│   ├── sdk/            # Client SDK — task(), ReloadClient, config
│   ├── worker/         # Worker runtime — static & managed modes
│   └── cli/            # CLI tool — init, deploy, dev, whoami
├── tasks/              # Example task definitions (webhook, scraper, etc.)
├── scripts/            # start-all.sh, stop-all.sh
├── docker-compose.yml  # PostgreSQL 16 + Redis 7
├── turbo.json          # Turborepo pipeline config
└── reload.config.ts    # SDK config (project name, task dirs)
```

## Getting Started

### Prerequisites

- **Node.js** >= 18
- **pnpm** >= 9 (`corepack enable && corepack prepare pnpm@9.15.0 --activate`)
- **Docker** (for PostgreSQL and Redis)

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/reload-dev.git
cd reload-dev
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
# Database
DATABASE_URL=postgresql://reload:reload@localhost:5432/reload
REDIS_URL=redis://localhost:6379

# Auth (generate a random secret for production)
BETTER_AUTH_SECRET=change-me-to-a-random-32-char-string
BETTER_AUTH_URL=http://localhost:3000
DASHBOARD_URL=http://localhost:3001

# Dashboard
NEXT_PUBLIC_SERVER_URL=http://localhost:3000

# Worker (get this from the dashboard after creating a project)
RELOAD_API_KEY=rl_dev_your-key-from-seed-or-dashboard
```

You also need to copy env files to the packages that need them:

```bash
# Server
cp .env packages/server/.env

# Dashboard
echo "NEXT_PUBLIC_SERVER_URL=http://localhost:3000" > packages/dashboard/.env.local

# Worker / Tasks
echo "RELOAD_API_KEY=rl_dev_your-key" > tasks/.env
```

### 3. One-command setup

This starts Docker (Postgres + Redis), pushes the DB schema, and seeds initial data:

```bash
pnpm setup
```

### 4. Start everything

```bash
pnpm start
```

This runs `scripts/start-all.sh` which:
1. Starts PostgreSQL 16 and Redis 7 via Docker Compose
2. Runs `drizzle-kit push` to sync the database schema
3. Starts the API server on **:3000**
4. Starts the worker (task runner)
5. Starts the dashboard on **:3001**

Press `Ctrl+C` to stop all services.

### 5. Open the dashboard

Go to [http://localhost:3001](http://localhost:3001), sign up, create a project, and you'll get an API key. Use that key to configure your worker and SDK client.

## Development

Run each service individually in watch mode:

```bash
# Terminal 1 — Infrastructure
pnpm infra

# Terminal 2 — Server (auto-restarts on change)
pnpm server

# Terminal 3 — Worker
pnpm worker

# Terminal 4 — Dashboard
pnpm dashboard
```

Other commands:

```bash
pnpm build          # Build all packages
pnpm typecheck      # Type-check all packages
pnpm test           # Run tests (vitest)
pnpm db:push        # Push schema changes to database
pnpm db:generate    # Generate Drizzle migrations
pnpm db:seed        # Seed database with sample data
pnpm infra:stop     # Stop Docker containers
pnpm infra:reset    # Wipe volumes and restart Docker
```

## Defining Tasks

Create a task in the `tasks/` directory:

```typescript
// tasks/my-task.ts
import { task } from "@reload-dev/sdk/task";

interface MyPayload {
  url: string;
}

interface MyResult {
  status: number;
}

export const myTask = task<MyPayload, MyResult>({
  id: "my-task",
  queue: "processing",
  retry: { maxAttempts: 5, minTimeout: 1000, maxTimeout: 60000, factor: 3 },
  run: async (payload) => {
    const res = await fetch(payload.url);
    return { status: res.status };
  },
});
```

Export it from `tasks/index.ts`:

```typescript
export { myTask } from "./my-task.js";
```

## Triggering Tasks

### From code (SDK client)

```typescript
import { ReloadClient } from "@reload-dev/sdk/client";

const client = new ReloadClient({
  baseUrl: "http://localhost:3000",
  apiKey: "rl_dev_...",
});

// Fire and forget
const { runId } = await client.trigger("my-task", { url: "https://example.com" });

// Wait for result
const run = await client.triggerAndWait("my-task", { url: "https://example.com" }, {
  timeoutMs: 30000,
});
console.log(run.output); // { status: 200 }
```

### From the dashboard

Click **+ Trigger** in the sidebar, select a task, paste a JSON payload, and hit run.

### Via API

```bash
curl -X POST http://localhost:3000/api/trigger \
  -H "Authorization: Bearer rl_dev_..." \
  -H "Content-Type: application/json" \
  -d '{"taskId": "my-task", "payload": {"url": "https://example.com"}}'
```

## Deploying Tasks (Production)

The CLI bundles your tasks with esbuild and uploads them to the server. Managed workers automatically download and hot-reload new deployments.

```bash
# Install the CLI
pnpm add -g @reload-dev/cli

# Deploy
npx reload-dev deploy
```

What happens:
1. Reads `reload.config.ts` for project config and task directories
2. Bundles `tasks/index.ts` with esbuild into a single JS file
3. Computes a SHA-256 hash as the version identifier
4. Uploads the bundle to the server
5. Activates the deployment — managed workers pick it up on next poll

## Self-Hosting

### With Docker Compose (development)

The included `docker-compose.yml` runs PostgreSQL and Redis. The server, worker, and dashboard run on the host:

```bash
pnpm setup && pnpm start
```

### Production deployment

For production, you'll want to:

1. **Run PostgreSQL and Redis** as managed services (e.g., AWS RDS, ElastiCache) or your own Docker/Kubernetes setup
2. **Build the packages**:
   ```bash
   pnpm build
   ```
3. **Run the server**:
   ```bash
   node packages/server/dist/index.js
   ```
4. **Run the dashboard**:
   ```bash
   cd packages/dashboard && npx next start --port 3001
   ```
5. **Run managed workers**:
   ```bash
   node packages/worker/dist/index.js
   ```
6. **Set environment variables** on each service (see `.env.example`)
7. **Generate a strong `BETTER_AUTH_SECRET`** — at least 32 random characters
8. **Use a reverse proxy** (nginx, Caddy) for TLS and routing

### Environment Variables Reference

| Variable | Required | Used By | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | Server | PostgreSQL connection string |
| `REDIS_URL` | Yes | Server | Redis connection string |
| `BETTER_AUTH_SECRET` | Yes | Server | Secret for session signing (min 32 chars) |
| `BETTER_AUTH_URL` | Yes | Server | Server's public URL |
| `DASHBOARD_URL` | Yes | Server | Dashboard's public URL (for CORS) |
| `PORT` | No | Server | Server port (default: 3000) |
| `NEXT_PUBLIC_SERVER_URL` | Yes | Dashboard | Server URL for API calls |
| `RELOAD_API_KEY` | Yes | Worker | API key for worker auth (`rl_dev_...` or `rl_prod_...`) |

## API Overview

The server exposes a REST API authenticated via API keys (`Bearer rl_dev_...`) or session cookies (dashboard).

| Area | Endpoints |
|------|-----------|
| **Auth** | `POST /api/auth/sign-up/email`, `POST /api/auth/sign-in/email`, `GET /api/auth/get-session` |
| **Projects** | `GET/POST /api/me/projects`, `GET/POST/DELETE /api/me/projects/:id/keys` |
| **Runs** | `POST /api/trigger`, `GET /api/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/complete`, `POST /api/runs/:id/fail`, `POST /api/runs/:id/cancel` |
| **Queues** | `GET/POST /api/queues` |
| **Tasks** | `GET/POST /api/tasks` |
| **Workers** | `POST /api/workers/register`, `POST /api/dequeue` |
| **Deployments** | `POST /api/deployments`, `POST /api/deployments/:id/activate`, `GET /api/deployments/:id/bundle` |
| **SSE Streams** | `GET /api/stream`, `GET /api/runs/:id/stream`, `GET /api/queues/:id/stream` |

Full endpoint reference in [`docs/architecture-deep-dive.md`](docs/architecture-deep-dive.md#21-api-endpoint-reference).

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes
4. Run `pnpm typecheck && pnpm test` to verify
5. Submit a pull request

## License

[MIT](LICENSE) — use it however you want.
