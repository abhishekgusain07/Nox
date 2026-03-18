# @reload-dev/engine

The core engine for [reload.dev](https://reload.dev) — state machine, queue logic, retry, heartbeat monitoring, and waitpoint resolution.

This package is used by `@reload-dev/server`. You typically don't need to install it directly unless building a custom server.

## What It Contains

- **State Machine**: Pure `computeTransition()` function — validates and computes state changes
- **Run Engine**: Imperative shell that wraps the state machine with DB operations
- **PG Queue**: PostgreSQL SKIP LOCKED dequeue
- **Redis Queue**: Sorted-set queue with priority scoring
- **Concurrency Tracker**: Redis Lua-based atomic slot management
- **Fair Dequeue**: Round-robin across multiple queues
- **Retry Logic**: Exponential backoff with jitter
- **Heartbeat Monitor**: Detects stale EXECUTING runs
- **TTL Checker**: Expires old QUEUED runs
- **Waitpoint Resolver**: Handles child runs, durations, tokens, batches
- **Step Runner**: Re-entrant task execution with step caching

## License

MIT
