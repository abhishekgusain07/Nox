# Phase 4: npm Publication Readiness

## What Changed

Phase 4 prepares all publishable packages for npm with proper metadata, documentation, and the `defineConfig()` helper for Phase 5.

## Package Publication Status

| Package | Version | Publishable | README | LICENSE | exports → dist/ |
|---------|---------|-------------|--------|---------|-----------------|
| @reload-dev/core | 0.1.0 | Yes | Yes | MIT | 6 subpaths |
| @reload-dev/engine | 0.1.0 | Yes | Yes | MIT | 1 barrel |
| @reload-dev/sdk | 0.1.0 | Yes | Yes | MIT | 4 subpaths (., ./task, ./client, ./config) |
| @reload-dev/worker | 0.1.0 | Yes | Yes | MIT | 1 barrel |
| @reload-dev/server | 0.0.1 | No (private) | No | MIT | N/A |

## New Files

- `LICENSE` (root) — MIT license
- `packages/core/README.md` — Internal package docs
- `packages/engine/README.md` — Engine internals docs
- `packages/sdk/README.md` — User-facing SDK docs with API reference
- `packages/worker/README.md` — Worker setup and env vars docs
- `packages/sdk/src/config.ts` — `defineConfig()` helper for Phase 5 CLI
- `docs/getting-started.md` — End-to-end guide from signup to first task

## SDK New Export: `defineConfig()`

Users will create `reload.config.ts` in Phase 5:

```typescript
import { defineConfig } from "@reload-dev/sdk/config";

export default defineConfig({
  project: "proj_abc123",
  dirs: ["./tasks"],
  retries: {
    default: { maxAttempts: 3, factor: 2 },
  },
});
```

## How to Publish (when ready)

```bash
# 1. Build all packages
pnpm build

# 2. Publish in dependency order
cd packages/core && npm publish --access=public
cd packages/engine && npm publish --access=public
cd packages/sdk && npm publish --access=public
cd packages/worker && npm publish --access=public
```

## How to Test (dry run)

```bash
cd packages/sdk && npm pack --dry-run
```

This shows exactly what files would be included in the npm package.

## What's Next (Phase 5)

Phase 5 creates the `@reload-dev/cli` package with `reload-dev init`, `reload-dev dev`, and `reload-dev deploy` commands.
