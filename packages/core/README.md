# @reload-dev/core

Shared types, schemas, and utilities for the [reload.dev](https://reload.dev) task queue platform.

This package is used internally by `@reload-dev/sdk`, `@reload-dev/engine`, and `@reload-dev/worker`. You typically don't need to install it directly.

## Exports

```typescript
// Type-safe branded IDs
import { RunId, TaskId, QueueId } from "@reload-dev/core/ids";

// Domain types
import type { Run, TaskDefinition, Queue, Worker, RetryConfig } from "@reload-dev/core/types";

// State machine
import { TRANSITIONS, isTerminal, canTransition } from "@reload-dev/core/states";
import type { RunStatus } from "@reload-dev/core/states";

// Validation schemas
import { TriggerRequestSchema, DequeueRequestSchema } from "@reload-dev/core/schemas";

// Result type (functional error handling)
import { ok, err, isOk, isErr } from "@reload-dev/core/result";
import type { Result } from "@reload-dev/core/result";

// Error types
import type { DomainError } from "@reload-dev/core/errors";
```

## License

MIT
