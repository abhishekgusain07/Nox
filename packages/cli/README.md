# @reload-dev/cli

Command-line tool for [reload.dev](https://reload.dev) — initialize, develop, and deploy your tasks.

## Installation

```bash
npm install -g @reload-dev/cli
# or use npx
npx @reload-dev/cli deploy
```

## Commands

### `reload-dev init`

Scaffolds a new reload.dev project:
- `reload.config.ts` — project configuration
- `tasks/index.ts` — barrel file for task exports
- `tasks/example.ts` — example task definition
- `.env` — environment variable placeholders

### `reload-dev deploy`

Bundles your tasks with esbuild and deploys them to the server.

```bash
reload-dev deploy                    # Uses reload.config.ts
reload-dev deploy --config my.config.ts  # Custom config path
reload-dev deploy --dry-run          # Bundle without uploading
```

**What it does:**
1. Reads `reload.config.ts` to find your task directory
2. Bundles `tasks/index.ts` with esbuild (follows all imports)
3. Extracts task metadata from the bundle (id, queue, retry config)
4. Uploads bundle + manifest to the server
5. Activates the deployment (registers tasks, supersedes previous version)

### `reload-dev dev`

Starts a local worker with file watching (no bundling — uses tsx directly).

```bash
reload-dev dev
```

### `reload-dev whoami`

Verifies your API key and shows the current project info.

```bash
reload-dev whoami
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RELOAD_API_KEY` | Yes | Your project's server API key |
| `RELOAD_SERVER_URL` | No | Server URL (default: http://localhost:3000) |

## Config File

```typescript
// reload.config.ts
import { defineConfig } from "@reload-dev/sdk/config";

export default defineConfig({
  project: "my-project",
  dirs: ["./tasks"],
  retries: {
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
    },
  },
});
```

## License

MIT
