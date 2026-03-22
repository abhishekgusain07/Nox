# Phase 5: Observability -- Deep-Dive Concepts

**Goal:** Real-time dashboard, event log visualization, OpenTelemetry tracing, and SSE streaming.

Phase 5 turns the task-queue engine built in earlier phases into a system you can actually *see*. Every run trigger, every state transition, every retry and failure becomes visible through a live dashboard powered by Server-Sent Events, structured traces via OpenTelemetry, and a React frontend backed by TanStack Query and Zustand. This document covers the core concepts you need to understand before writing a single line of Phase 5 code.

---

## 1. Server-Sent Events (SSE)

### What Is SSE?

Server-Sent Events is an HTTP-based protocol that allows a server to push data to a client over a single, long-lived HTTP connection. Unlike WebSockets, communication is **one-way**: the server sends events to the client, and the client cannot send data back over the same connection. SSE is defined in the HTML Living Standard and is supported natively by every modern browser through the `EventSource` API.

The key insight is that SSE is just regular HTTP. There is no upgrade handshake, no new protocol, no special port. A client makes a normal GET request; the server responds with `Content-Type: text/event-stream` and keeps the connection open, writing events as they become available.

### How It Works Under the Hood

When the browser creates an `EventSource`, the following happens:

1. The browser sends a standard HTTP GET request to the specified URL.
2. The server responds with these headers:
   ```
   Content-Type: text/event-stream
   Cache-Control: no-cache
   Connection: keep-alive
   Transfer-Encoding: chunked
   ```
3. The server holds the connection open. Instead of sending a complete response body and closing, it writes data incrementally in a specific text format.
4. The TCP connection remains alive. The server writes new data whenever events occur. Each event is terminated by a blank line (`\n\n`).
5. If the connection drops, the browser automatically reconnects (typically after 3 seconds, configurable via the `retry` field).

Because SSE rides on standard HTTP, it works through proxies, load balancers, and CDNs without special configuration (though you may need to disable response buffering in some proxies like Nginx with `X-Accel-Buffering: no`).

### The SSE Message Format

Every SSE message is plain text. The server writes lines prefixed with specific field names, and each message is terminated by two newlines:

```
event: statusChange
data: {"runId": "run_abc123", "status": "completed"}
id: 42
retry: 5000

```

The four fields are:

| Field    | Purpose                                                                                             |
|----------|-----------------------------------------------------------------------------------------------------|
| `data:`  | The payload. Can span multiple lines (each prefixed with `data:`). This is the only required field. |
| `event:` | A named event type. Without it, the browser fires `message`. With it, you listen for that name.     |
| `id:`    | An event ID. The browser stores this and sends it as `Last-Event-ID` on reconnection.               |
| `retry:` | Tells the browser how many milliseconds to wait before reconnecting after a disconnect.             |

A simple unnamed event looks like:

```
data: hello world

```

A multi-line data event:

```
data: first line
data: second line

```

The browser concatenates these with newlines: `"first line\nsecond line"`.

### The EventSource Browser API

The browser provides `EventSource` as a built-in constructor:

```javascript
const source = new EventSource('/api/events');

// Listen for unnamed events (no `event:` field)
source.addEventListener('message', (e) => {
  console.log(e.data);
});

// Listen for named events
source.addEventListener('statusChange', (e) => {
  const payload = JSON.parse(e.data);
  console.log(payload.runId, payload.status);
});

// Connection opened
source.addEventListener('open', () => {
  console.log('Connected');
});

// Error (network issue, server closed connection)
source.addEventListener('error', (e) => {
  if (source.readyState === EventSource.CONNECTING) {
    console.log('Reconnecting...');
  }
});

// Clean up
source.close();
```

Key behaviors of `EventSource`:

- **Auto-reconnection**: If the connection drops, the browser automatically reconnects. It sends the last received `id` as the `Last-Event-ID` header, allowing the server to replay missed events.
- **readyState**: `CONNECTING` (0), `OPEN` (1), `CLOSED` (2). After calling `.close()`, the state is `CLOSED` and no reconnection occurs.
- **Cross-origin**: Supported via the `withCredentials` option: `new EventSource(url, { withCredentials: true })`.

### SSE vs WebSocket

| Aspect                | SSE                                             | WebSocket                                    |
|-----------------------|-------------------------------------------------|----------------------------------------------|
| Direction             | Server to client only                           | Bidirectional                                |
| Protocol              | HTTP (no upgrade)                               | Starts as HTTP, upgrades to `ws://`          |
| Reconnection          | Automatic (built into browser API)              | Manual (you write reconnection logic)        |
| Data format           | Text only (UTF-8)                               | Text or binary                               |
| Browser support       | All modern browsers                             | All modern browsers                          |
| Complexity            | Simple -- just HTTP                             | More complex -- connection upgrade, framing  |
| Proxy/firewall        | Works through all HTTP infrastructure           | May be blocked by corporate proxies          |
| HTTP/2 multiplexing   | Yes -- multiple SSE streams share one TCP conn  | No -- each WebSocket is a separate TCP conn  |
| Max connections (H1)  | 6 per domain per browser                        | No browser-imposed limit                     |
| Use case              | Dashboards, notifications, live feeds           | Chat, gaming, collaborative editing          |

**The rule of thumb**: if the client does not need to send data over the persistent connection, SSE is almost always the better choice. It is simpler to implement, works natively with HTTP infrastructure, and auto-reconnects. For reload.dev's dashboard, where we only need to push run status updates from server to client, SSE is ideal.

### SSE vs Long Polling

Long polling creates a new HTTP request for every update: the client sends a request, the server holds it until data is available, responds, and the client immediately sends another request. This creates overhead from repeated connection setup, header transmission, and TCP handshake.

SSE uses a **single persistent connection**. The server writes to it whenever events occur. No repeated handshakes, no redundant headers, no wasted roundtrips. For a dashboard showing hundreds of events per minute, SSE is dramatically more efficient than long polling.

### How Hono Supports SSE

Hono provides a `streamSSE()` helper that handles all the low-level details:

```typescript
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

const app = new Hono();

app.get('/events', async (c) => {
  return streamSSE(c, async (stream) => {
    // Write an event
    await stream.writeSSE({
      event: 'statusChange',
      data: JSON.stringify({ runId: 'run_abc', status: 'completed' }),
      id: '42',
    });

    // Wait before next event
    await stream.sleep(1000);

    // Write another event
    await stream.writeSSE({
      data: 'heartbeat',
    });
  });
});
```

The `streamSSE` helper automatically sets the correct response headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Transfer-Encoding: chunked`, `Connection: keep-alive`). The stream is automatically closed after the callback completes, but in practice you will keep the callback alive with a loop that listens for database notifications or other event sources.

### How PostgreSQL LISTEN/NOTIFY Powers SSE

The real-time pipeline in reload.dev works as follows:

1. A task run changes state (e.g., `QUEUED` -> `EXECUTING`). The application inserts a row into `run_events` and calls `NOTIFY run_updates, '{"runId":"run_abc","status":"EXECUTING"}'`.
2. A dedicated PostgreSQL connection (not from the pool) is `LISTEN`ing on the `run_updates` channel.
3. When the notification arrives, the listener forwards it to all active SSE streams that are interested in that run.
4. The SSE stream writes the event to the HTTP response. The browser's `EventSource` receives it and fires the corresponding event handler.

This creates a fully reactive pipeline: database change -> PG notification -> SSE event -> browser update, with no polling at any layer.

### Connection Management

Several things can cause an SSE connection to close:

- **Client disconnects**: The browser tab is closed, the user navigates away, or `source.close()` is called. The server detects a broken pipe when it tries to write and should clean up the stream.
- **Network drops**: The TCP connection is lost. The browser automatically reconnects after the `retry` interval (default ~3 seconds). The server should handle the new connection, potentially replaying missed events using `Last-Event-ID`.
- **Server restart**: All connections are dropped. Every connected `EventSource` will attempt to reconnect. The server must be stateless enough (or replay from the event log) to handle this gracefully.

On the server side, you should track active connections (e.g., in a `Map` or `Set`) and remove them when the client disconnects. In Hono, you can detect disconnection by checking when the stream's writable side closes or by listening for the request's `AbortSignal`.

### Scalability

Each SSE connection is a persistent HTTP connection, which means:

- Each connection consumes a **file descriptor** on the server. The default limit on most Linux systems is 1024, but this can be raised to 65,536 or higher with `ulimit -n`.
- Each connection consumes **memory** for the HTTP response buffer and any application state.
- A single Node.js server can typically handle **10,000 to 50,000** concurrent SSE connections, depending on event frequency and payload size.
- Under HTTP/2, multiple SSE streams can share a single TCP connection, dramatically reducing resource usage per client.

To scale beyond a single server, you need a **fan-out mechanism**: each server instance subscribes to the same event source (e.g., Redis Pub/Sub or PostgreSQL LISTEN/NOTIFY) and forwards events to its own set of SSE clients. A load balancer distributes clients across server instances.

### Resources

- [MDN: EventSource API](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)
- [MDN: Using Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- [MDN: Server-Sent Events Overview](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [Hono Streaming Helper Documentation](https://hono.dev/docs/helpers/streaming)
- [HTML Living Standard: Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [SSE vs WebSockets: Key Differences (Ably)](https://ably.com/blog/websockets-vs-sse)
- [Server-Sent Events: A Practical Guide](https://tigerabrodi.blog/server-sent-events-a-practical-guide-for-the-real-world)
- [Hono with Server Sent Events (Yanael.io)](https://yanael.io/articles/hono-sse/)

### Test Questions

1. **Why does SSE auto-reconnect but WebSocket doesn't?**
   SSE auto-reconnection is built into the browser's `EventSource` specification. The HTML standard mandates that when an SSE connection drops, the browser must automatically attempt to reconnect after the `retry` interval. WebSocket, by contrast, uses a separate protocol (`ws://`) with its own specification, which does not include automatic reconnection -- the rationale being that bidirectional connections have more complex state that applications need to manage themselves.

2. **What happens if the server process restarts while SSE connections are open?**
   All active SSE connections are immediately dropped. Every connected `EventSource` in the browser transitions to `CONNECTING` state and begins reconnecting. On reconnection, the browser sends the `Last-Event-ID` header containing the ID of the last event it received. The server can use this to replay missed events from the event log (the `run_events` table). If the server does not support replay, the client simply starts receiving events from the current point forward.

3. **How does LISTEN/NOTIFY work across multiple PostgreSQL connections?**
   `NOTIFY` sends a message to **all** connections that have executed `LISTEN` on that channel, regardless of which connection sent the `NOTIFY`. This means multiple server instances can each maintain their own `LISTEN` connection to the same PostgreSQL database and all receive the same notifications. The notifications are broadcast by the PostgreSQL server process, not peer-to-peer.

4. **Why is SSE better than polling every 1 second?**
   Polling creates a new HTTP request every second -- a full TCP roundtrip, headers, connection overhead -- regardless of whether new data exists. SSE maintains a single persistent connection. Events arrive instantly when they occur (sub-millisecond latency from server write to client receive), no redundant requests are made during quiet periods, and server load is dramatically lower since there are no wasted request/response cycles.

5. **What is the maximum number of SSE connections a single Node.js server can handle?**
   The theoretical limit is the operating system's file descriptor limit (which can be raised to hundreds of thousands). In practice, a single Node.js server can handle 10,000-50,000 concurrent SSE connections. The bottleneck is usually memory (each connection holds buffers), event frequency (high-throughput events consume CPU for serialization and writing), and the single-threaded event loop. Under HTTP/2, many SSE streams can multiplex over a single TCP connection, raising the effective limit.

6. **How would you scale SSE across multiple server instances?**
   Use a shared event bus. Each server instance subscribes to the same source of events (e.g., PostgreSQL LISTEN/NOTIFY, Redis Pub/Sub, or NATS). When a notification arrives, each server writes the event to its own set of SSE clients. A load balancer (e.g., Nginx, HAProxy, or a cloud LB with sticky sessions or random distribution) distributes clients across instances. Because SSE clients auto-reconnect, a client that loses its server can reconnect to any available instance.

7. **What is the browser limit on SSE connections, and how does HTTP/2 change it?**
   Under HTTP/1.1, browsers limit the number of concurrent connections to the same domain to approximately 6. Each SSE stream uses one of these connections, so opening multiple tabs with SSE can exhaust the limit quickly. Under HTTP/2, streams are multiplexed over a single TCP connection, and the limit rises to 100 concurrent streams by default (negotiable between client and server). This makes HTTP/2 strongly preferred for SSE-heavy applications.

---

## 2. PostgreSQL LISTEN/NOTIFY

### What Is It?

PostgreSQL has a built-in publish/subscribe mechanism that requires no external message broker. Any connection can send a notification on a named channel with `NOTIFY`, and any connection that has subscribed with `LISTEN` will receive it. The messages are delivered in-memory by the PostgreSQL server process -- they are not persisted, not queued, and not replayed.

This is surprisingly powerful for real-time applications. Instead of polling the database every second to check for new rows or status changes, your application subscribes to a channel and receives instant notifications when changes occur.

### How NOTIFY Works

```sql
NOTIFY run_updates, '{"runId": "run_abc123", "status": "EXECUTING"}';
```

This sends a notification to **every** connection currently listening on the `run_updates` channel. The second argument is the payload -- an arbitrary string up to **8,000 bytes**. If no one is listening, the notification is silently discarded.

You can also use the `pg_notify()` function, which is more convenient when the channel name or payload is dynamic:

```sql
SELECT pg_notify('run_updates', '{"runId": "run_abc123", "status": "EXECUTING"}');
```

### How LISTEN Works

```sql
LISTEN run_updates;
```

This registers the current connection to receive notifications on the `run_updates` channel. The subscription persists for the lifetime of the connection (or until `UNLISTEN` is called). You can listen on multiple channels simultaneously.

In Node.js with the `pg` library:

```typescript
import { Client } from 'pg';

const client = new Client({ connectionString: DATABASE_URL });
await client.connect();
await client.query('LISTEN run_updates');

client.on('notification', (msg) => {
  console.log('Channel:', msg.channel);
  console.log('Payload:', msg.payload);
  const data = JSON.parse(msg.payload!);
  // Forward to SSE streams...
});
```

### Transaction Semantics

A critical detail: **NOTIFY is delivered only after the transaction commits.** If you call `NOTIFY` inside a transaction and then the transaction is rolled back, the notification is never sent. This is exactly the right behavior -- you do not want to notify clients about a state change that was subsequently undone.

This also means that by the time a listener receives a notification, the corresponding database change is guaranteed to be visible. The listener can safely query the database for the latest state and will see the committed data.

```sql
BEGIN;
  UPDATE runs SET status = 'COMPLETED' WHERE id = 'run_abc123';
  INSERT INTO run_events (run_id, type, payload) VALUES ('run_abc123', 'STATUS_CHANGE', '...');
  NOTIFY run_updates, '{"runId": "run_abc123", "status": "COMPLETED"}';
COMMIT;  -- notification delivered HERE, after commit
```

### The Payload Size Limit

The payload is limited to **8,000 bytes** (the maximum length of a PostgreSQL `text` value in a notification). This means you should keep payloads small -- typically just an identifier and a type:

```json
{"runId": "run_abc123", "event": "STATUS_CHANGE"}
```

The listener then queries the database for full details if needed. Do **not** try to send entire run payloads or large JSON blobs through NOTIFY.

### The Dedicated Connection Requirement

`LISTEN` requires a **persistent, dedicated connection** that stays open and idle, waiting for notifications. This is incompatible with connection pooling (e.g., `pg.Pool`), because pooled connections are returned to the pool after each query and may be reassigned to a different client. If the connection is returned, the `LISTEN` subscription is effectively lost.

The solution is to create a separate `pg.Client` instance specifically for listening:

```typescript
// Pool for regular queries
const pool = new Pool({ connectionString: DATABASE_URL });

// Dedicated client for LISTEN (never pooled)
const listenerClient = new Client({ connectionString: DATABASE_URL });
await listenerClient.connect();
await listenerClient.query('LISTEN run_updates');
```

This listener client sits idle most of the time, consuming one connection slot but enabling real-time notifications for the entire application.

### Using Database Triggers for Automatic NOTIFY

Instead of manually calling `NOTIFY` in your application code, you can attach a trigger to the `run_events` table:

```sql
CREATE OR REPLACE FUNCTION notify_run_event()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('run_updates', json_build_object(
    'runId', NEW.run_id,
    'eventType', NEW.type,
    'eventId', NEW.id
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER run_event_notify
  AFTER INSERT ON run_events
  FOR EACH ROW EXECUTE FUNCTION notify_run_event();
```

This guarantees that every event insertion triggers a notification, regardless of which code path performed the insert. The trigger fires after the row is inserted, and the notification is delivered after the enclosing transaction commits.

### Comparison to External Message Brokers

| Aspect               | PG LISTEN/NOTIFY              | Redis Pub/Sub                 | NATS / RabbitMQ / Kafka       |
|-----------------------|-------------------------------|-------------------------------|-------------------------------|
| Setup                 | None (built into PG)          | Requires Redis server         | Requires dedicated broker     |
| Persistence           | None (fire-and-forget)        | None (fire-and-forget)        | Kafka: persistent log         |
| Payload limit         | 8,000 bytes                   | 512 MB (practical: small)     | Varies (MB range)             |
| Delivery guarantee    | At-most-once                  | At-most-once                  | At-least-once (configurable)  |
| Throughput            | Moderate (thousands/sec)      | High (100K+/sec)              | Very high (millions/sec)      |
| Multi-instance fan-out| Yes (all listeners receive)   | Yes (all subscribers receive) | Yes (consumer groups, topics) |
| Complexity            | Zero additional infrastructure | One more service              | Significant infra             |

For a system like reload.dev, where the volume of events is moderate (hundreds to low thousands per second), PostgreSQL LISTEN/NOTIFY is a pragmatic choice. It eliminates an external dependency, is transactionally consistent with the database, and is simple to operate. If you outgrow it, Redis Pub/Sub is a natural next step.

### Resources

- [PostgreSQL Documentation: NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)
- [PostgreSQL Documentation: LISTEN](https://www.postgresql.org/docs/current/sql-listen.html)
- [Neon Guide: Using LISTEN and NOTIFY for Pub/Sub](https://neon.com/guides/pub-sub-listen-notify)
- [Building Real-Time Log Streaming with PostgreSQL LISTEN/NOTIFY (DEV Community)](https://dev.to/polliog/building-real-time-log-streaming-with-postgresql-listennotify-4cbj)
- [How to Use Listen/Notify for Real-Time Updates in PostgreSQL](https://oneuptime.com/blog/post/2026-01-25-use-listen-notify-real-time-postgresql/view)

### Test Questions

1. **Why does NOTIFY wait until transaction commit to deliver?**
   Because the notification represents a state change. If the transaction is rolled back, the state change never happened, and notifying listeners about a non-existent change would cause inconsistency. By waiting until commit, PostgreSQL guarantees that when a listener receives a notification, the corresponding data change is durable and visible. This is the same principle behind write-ahead logging -- effects are not visible until committed.

2. **What happens to NOTIFY messages if no one is LISTENing?**
   They are silently discarded. PostgreSQL does not buffer or persist notifications. LISTEN/NOTIFY is a fire-and-forget mechanism -- if no connections are subscribed to a channel when a NOTIFY fires, the message is lost forever. This is by design: it keeps the mechanism lightweight and avoids unbounded memory growth.

3. **Why can't you LISTEN on a pooled connection?**
   Connection pools return connections to a shared pool after each query. When a connection is returned, it may be assigned to a different client or reset entirely. The `LISTEN` subscription is tied to a specific connection -- if that connection is reassigned, the subscription is effectively abandoned. Even worse, some pool managers (like PgBouncer in transaction mode) multiplex multiple clients onto a single server connection, making per-connection subscriptions impossible. You must use a dedicated, long-lived `pg.Client` for listening.

4. **How would you handle the 8,000-byte payload limit for large events?**
   Keep the notification payload minimal -- just an identifier and event type (e.g., `{"runId": "run_abc", "type": "STATUS_CHANGE"}`). The listener uses this identifier to query the full event data from the database. This is a standard pattern: the notification is a "poke" that says "something changed," and the listener fetches the details on demand. This also avoids serialization overhead in the notification path.

5. **What happens if the listener connection drops?**
   Any notifications sent while the listener is disconnected are lost. The listener must reconnect, re-issue `LISTEN`, and then reconcile by querying the database for any events it might have missed. This is why the event log table (`run_events`) is essential -- it serves as the durable record, and LISTEN/NOTIFY is merely the real-time notification layer on top.

6. **Can NOTIFY create back-pressure or slow down writers?**
   In normal operation, NOTIFY is extremely fast (microseconds) and does not slow down the writing transaction. However, if there are many listeners and the notification queue fills up (PostgreSQL has an internal queue for pending notifications), the NOTIFY call can block. In practice, this is extremely rare unless you have thousands of notifications per second with many listeners. The queue size is controlled by the `async` shared memory configuration and is generous by default.

---

## 3. OpenTelemetry (Traces, Spans, Context Propagation)

### What Is OpenTelemetry?

OpenTelemetry (OTel) is a **vendor-neutral** observability framework that provides APIs, SDKs, and tools for collecting **traces**, **metrics**, and **logs** from your applications. It is a CNCF (Cloud Native Computing Foundation) project and has become the de facto standard for application instrumentation.

The core idea: instrument your code once with OpenTelemetry, and export the data to any backend -- Jaeger, Zipkin, Datadog, Honeycomb, Grafana Tempo, AWS X-Ray, or any OTLP-compatible endpoint. You are never locked into a vendor.

### What Is a Trace?

A **trace** represents the entire journey of a single request or operation through your system. In reload.dev, a trace might cover the full lifecycle of a task run:

```
trigger API call -> queue insertion -> worker dequeue -> task execution -> completion callback
```

A trace has a globally unique **trace ID** (a 128-bit random value, represented as a 32-character hex string). Every operation that is part of this journey shares the same trace ID, which is how observability tools group related operations together.

### What Is a Span?

A **span** is a single unit of work within a trace. It has:

- **Name**: a human-readable description (e.g., `"trigger.run"`, `"worker.execute"`, `"db.query"`)
- **Start time** and **end time** (or duration)
- **Span ID**: a unique identifier for this span (64-bit, 16-character hex)
- **Parent span ID**: the ID of the span that caused this span (or none for the root span)
- **Attributes**: key-value metadata (`run.id = "run_abc"`, `run.taskId = "send-email"`, `run.attempt = 2`)
- **Events**: timestamped annotations within the span (e.g., "retry scheduled", "error caught")
- **Status**: `OK`, `ERROR`, or `UNSET`
- **Links**: references to other spans (useful for batch operations)

### Parent-Child Spans

Spans form a tree. The root span has no parent. Each subsequent operation creates a child span:

```
[trigger.run]                              (root span, 250ms)
  [queue.enqueue]                          (child, 5ms)
  [worker.dequeue]                         (child, 2ms)
  [task.execute]                           (child, 200ms)
    [db.query SELECT]                      (grandchild, 10ms)
    [http.request POST /webhook]           (grandchild, 150ms)
  [run.complete]                           (child, 3ms)
```

This tree structure lets you see exactly where time is spent. If a task run is slow, you can drill down into the trace and identify the bottleneck -- was it the database query? The webhook call? The queue wait time?

### Context Propagation

The most subtle and powerful concept in distributed tracing is **context propagation**: how does the trace ID and parent span ID flow from one service to another across a network boundary?

When Service A makes an HTTP request to Service B, the OpenTelemetry SDK automatically injects the trace context into HTTP headers using the **W3C Trace Context** standard:

```
traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
tracestate: reload=t:run_abc
```

The `traceparent` header contains:
- Version (`00`)
- Trace ID (32 hex chars)
- Parent span ID (16 hex chars)
- Trace flags (sampling)

When Service B receives the request, its OpenTelemetry SDK extracts the trace context from the headers and creates a new span that is a child of the span from Service A. This links the two services into a single trace.

For task queues, context propagation requires extra care. When a task is enqueued, the trace context must be serialized into the queue message metadata. When a worker dequeues the task, it deserializes the context and creates a child span. This is not automatic -- you need to explicitly propagate context through whatever transport you use (database row, Redis message, etc.):

```typescript
import { context, propagation, trace } from '@opentelemetry/api';

// When enqueueing: serialize current context
const carrier: Record<string, string> = {};
propagation.inject(context.active(), carrier);
// Store `carrier` alongside the task in the database

// When dequeuing: restore context
const extractedContext = propagation.extract(context.active(), carrier);
context.with(extractedContext, () => {
  const span = tracer.startSpan('task.execute');
  // This span is now a child of the original trigger span
});
```

### Span Attributes

Attributes are key-value pairs attached to a span that provide context:

```typescript
span.setAttribute('run.id', 'run_abc123');
span.setAttribute('run.taskId', 'send-email');
span.setAttribute('run.attempt', 2);
span.setAttribute('run.queue', 'default');
span.setAttribute('worker.id', 'worker_xyz');
```

OpenTelemetry defines **semantic conventions** for common attribute names (e.g., `http.method`, `db.system`, `messaging.operation`) to ensure consistency across different instrumentations.

### Span Events

Events are timestamped annotations within a span -- useful for recording significant moments without creating a separate child span:

```typescript
span.addEvent('retry_scheduled', {
  'retry.attempt': 3,
  'retry.delay_ms': 5000,
  'retry.reason': 'HTTP 503 from webhook',
});

span.addEvent('exception', {
  'exception.type': 'TimeoutError',
  'exception.message': 'Task execution exceeded 30s timeout',
});
```

### Span Status

A span's status indicates the outcome:

- **`UNSET`**: the default. The span completed, but the instrumentation did not explicitly set a status. Backends may infer success.
- **`OK`**: explicitly marked as successful.
- **`ERROR`**: the operation failed. Typically accompanied by an error event with exception details.

```typescript
span.setStatus({ code: SpanStatusCode.ERROR, message: 'Task timed out' });
```

### Exporters

Exporters determine where trace data is sent:

- **Console exporter**: prints spans to stdout (development only)
- **OTLP exporter**: sends spans to any OTLP-compatible endpoint (Jaeger, Grafana Tempo, Datadog, Honeycomb)
- **Jaeger exporter**: sends spans directly to Jaeger
- **Zipkin exporter**: sends spans to Zipkin

For reload.dev, the recommended setup is Jaeger for local development (via Docker) and an OTLP endpoint for production:

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: 'http://localhost:4318/v1/traces', // Jaeger OTLP endpoint
  }),
  instrumentations: [getNodeAutoInstrumentations()],
  serviceName: 'reload-api',
});

sdk.start();
```

### Auto-Instrumentation

The `@opentelemetry/auto-instrumentations-node` package automatically instruments common libraries:

- **HTTP/Express/Hono**: creates spans for incoming and outgoing HTTP requests
- **PostgreSQL (`pg`)**: creates spans for database queries with SQL as the span name
- **Redis (`ioredis`)**: creates spans for Redis commands
- **DNS, Net, FS**: lower-level Node.js operations

This means you get traces for database queries, HTTP calls, and other I/O without writing any instrumentation code. You add manual spans only for business logic that is not covered by auto-instrumentation (e.g., "task.execute", "run.stateTransition").

### How It Applies to Task Queues

In reload.dev, a single task run trace should span the entire lifecycle:

1. **trigger span**: API receives trigger request, validates payload, creates run
2. **queue.enqueue span**: run is inserted into the queue
3. **queue.wait span** (optional): time spent waiting in the queue
4. **worker.dequeue span**: worker picks up the run
5. **task.execute span**: the task function runs (may contain child spans for DB queries, HTTP calls)
6. **run.complete span**: status is updated to COMPLETED or FAILED

If the task retries 3 times, each attempt creates its own `task.execute` span under the same trace. You can see all attempts in the trace viewer and compare their durations, errors, and attributes.

### Comparison to Other APM Tools

| Aspect              | OpenTelemetry                    | Datadog APM           | New Relic             | AWS X-Ray             |
|---------------------|----------------------------------|-----------------------|-----------------------|-----------------------|
| Vendor lock-in      | None (open standard)             | Datadog only          | New Relic only        | AWS only              |
| Instrumentation     | Community + auto-instrumentation | Proprietary agent     | Proprietary agent     | AWS SDK               |
| Data export         | Any OTLP backend                 | Datadog backend       | New Relic backend     | X-Ray backend         |
| Cost                | Free (you host the backend)      | Per-host pricing      | Per-GB pricing        | Per-trace pricing     |
| Ecosystem           | Huge (CNCF)                      | Large                 | Large                 | AWS-specific          |

### Resources

- [OpenTelemetry: Getting Started with Node.js](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/)
- [OpenTelemetry: Traces Concepts](https://opentelemetry.io/docs/concepts/signals/traces/)
- [OpenTelemetry: Context Propagation](https://opentelemetry.io/docs/concepts/context-propagation/)
- [OpenTelemetry: JavaScript Propagation](https://opentelemetry.io/docs/languages/js/propagation/)
- [OpenTelemetry JavaScript SDK (GitHub)](https://github.com/open-telemetry/opentelemetry-js)
- [OpenTelemetry SDK for Node.js (npm)](https://www.npmjs.com/package/@opentelemetry/sdk-node)
- [Jaeger: Getting Started](https://www.jaegertracing.io/docs/1.76/getting-started/)
- [Jaeger: Introduction](https://www.jaegertracing.io/docs/2.16/)
- [OpenTelemetry Context Propagation Explained (Better Stack)](https://betterstack.com/community/guides/observability/otel-context-propagation/)

### Test Questions

1. **How does trace context survive across an HTTP request from worker to server?**
   The OpenTelemetry SDK automatically injects the `traceparent` and `tracestate` headers into outgoing HTTP requests. When the server receives the request, its SDK extracts the trace context from these headers and creates a new span that is a child of the caller's span. Both spans share the same trace ID, linking them into a single trace. The W3C Trace Context standard defines the header format to ensure interoperability across languages and vendors.

2. **If a task retries 3 times, how many spans are created?**
   At minimum, 3 `task.execute` spans (one per attempt), plus any child spans within each execution (database queries, HTTP calls, etc.). All retry spans share the same trace ID and are children of the same parent span (e.g., `worker.process`). Each retry span has attributes indicating the attempt number. The trace viewer shows all three attempts side by side, making it easy to see why early attempts failed.

3. **What is the performance overhead of OpenTelemetry instrumentation?**
   Typical overhead is 1-5% of CPU and negligible memory for most applications. The SDK is designed for production use: spans are created in memory, batched, and exported asynchronously. Sampling can reduce overhead further -- you can export only 10% of traces in high-throughput systems while still capturing enough data for debugging. The auto-instrumentation is especially efficient because it hooks into existing library code without adding extra I/O.

4. **Why is context propagation necessary for a task queue?**
   Without context propagation, the trace would break at the queue boundary. The trigger API would have one trace, and the worker execution would start a completely separate trace. There would be no way to correlate them in a trace viewer. By serializing the trace context into the queue message (e.g., as a JSON field in the database row) and extracting it on the worker side, you create a continuous trace from trigger through execution.

5. **What is the difference between a span attribute and a span event?**
   Attributes are static key-value metadata that describe the span (e.g., `run.id`, `http.status_code`). They are set once or updated during the span's lifetime. Events are timestamped annotations -- they record *when* something happened within the span. An event might be "error caught at 150ms" or "retry scheduled at 200ms." Attributes describe *what* the span is; events describe *what happened during* the span.

6. **What happens to traces if the OTLP exporter endpoint is down?**
   The OpenTelemetry SDK buffers spans in memory and retries export. If the endpoint remains unreachable, the buffer eventually fills up and older spans are dropped. The application continues to function normally -- trace collection is designed to fail gracefully without affecting application behavior. You can configure the buffer size, export timeout, and retry policy.

---

## 4. TanStack Query v5 (React Query)

### What Problem Does It Solve?

TanStack Query (formerly React Query) manages **server state** -- data that lives on the server and is fetched, cached, synchronized, and updated by the frontend. It solves problems that are notoriously tedious to handle manually:

- **Caching**: store fetched data so it is not re-fetched on every render
- **Background refetching**: automatically refresh stale data when a component mounts or the window regains focus
- **Deduplication**: if 5 components request the same data, only 1 network request is made
- **Optimistic updates**: update the UI immediately, then reconcile with the server response
- **Pagination and infinite scroll**: built-in support
- **Error and loading states**: first-class handling

Without TanStack Query, you typically use `useEffect` + `useState` to fetch data, which leads to boilerplate, race conditions, no caching, and no background refresh.

### The Query Key

Every query is identified by a **query key** -- a serializable array that uniquely describes the data:

```typescript
// List of runs
useQuery({ queryKey: ['runs'], queryFn: fetchRuns });

// A specific run
useQuery({ queryKey: ['runs', runId], queryFn: () => fetchRun(runId) });

// Runs with filters
useQuery({ queryKey: ['runs', { status: 'failed', queue: 'default' }], queryFn: () => fetchRuns(filters) });
```

Query keys are used for:
- **Cache lookup**: if the key matches, cached data is returned
- **Invalidation**: `queryClient.invalidateQueries({ queryKey: ['runs'] })` invalidates all queries whose key starts with `['runs']` (including `['runs', runId]`)
- **Deduplication**: multiple components using the same key share a single fetch

### staleTime vs gcTime

These two settings control the caching lifecycle:

**`staleTime`** (default: `0`): How long fetched data is considered "fresh." While data is fresh, TanStack Query serves it from cache without refetching, even if the component remounts or the window regains focus.

- `staleTime: 0` -- data is stale immediately (always refetch in background)
- `staleTime: 30_000` -- data is fresh for 30 seconds (no refetch within that window)
- `staleTime: Infinity` -- data is never stale (only refetch on manual invalidation)

**`gcTime`** (default: `300_000` / 5 minutes): How long **inactive** query data stays in cache before being garbage collected. "Inactive" means no component is currently using the query.

- When you navigate away from a page, its queries become inactive
- The data stays in cache for `gcTime` milliseconds
- If you navigate back within that window, the cached data is shown instantly (while a background refetch may occur if the data is stale)

The rule: `gcTime` should always be >= `staleTime`. It makes no sense to garbage collect data that is still considered fresh.

### refetchInterval

For near-real-time data, TanStack Query supports automatic polling:

```typescript
useQuery({
  queryKey: ['runs'],
  queryFn: fetchRuns,
  refetchInterval: 5000, // refetch every 5 seconds
});
```

This is the simplest approach to keeping data fresh, but it has tradeoffs:
- Creates regular network requests even when nothing has changed
- Minimum latency equals the polling interval (you will not see updates faster than every 5 seconds)
- Wastes bandwidth on quiet periods

For reload.dev's dashboard, a better approach is to use SSE for real-time notifications combined with manual invalidation (see below).

### queryClient.invalidateQueries

The most powerful integration point with SSE. When an SSE event arrives indicating a run has changed, you invalidate the relevant queries:

```typescript
const queryClient = useQueryClient();

useEffect(() => {
  const source = new EventSource('/api/events');

  source.addEventListener('runUpdate', (e) => {
    const { runId } = JSON.parse(e.data);

    // Invalidate the specific run
    queryClient.invalidateQueries({ queryKey: ['runs', runId] });

    // Also invalidate the runs list
    queryClient.invalidateQueries({ queryKey: ['runs'] });
  });

  return () => source.close();
}, [queryClient]);
```

When `invalidateQueries` is called:
1. All matching queries are marked as stale
2. If any matching query is currently rendered (has active observers), it is immediately refetched in the background
3. The component re-renders with the new data when the refetch completes

This gives you the best of both worlds: instant notification via SSE, automatic data refresh via TanStack Query, and zero manual state management.

### Mutations

Mutations handle write operations (POST, PUT, DELETE):

```typescript
const triggerRun = useMutation({
  mutationFn: (payload: TriggerPayload) =>
    fetch('/api/trigger', { method: 'POST', body: JSON.stringify(payload) }),
  onSuccess: () => {
    // After triggering, invalidate the runs list to show the new run
    queryClient.invalidateQueries({ queryKey: ['runs'] });
  },
});

// Usage
triggerRun.mutate({ taskId: 'send-email', payload: { to: 'user@example.com' } });
```

Mutations provide `isLoading`, `isError`, `isSuccess` states, automatic retry, and callbacks for optimistic updates.

### The 2-Store Pattern

A clean architecture for React state:

| Concern        | Tool            | Examples                                       |
|----------------|-----------------|------------------------------------------------|
| Server state   | TanStack Query  | Runs, queues, workers, event logs              |
| UI state       | Zustand         | Sidebar open/closed, filters, theme, sort order|

Do not put server data in Zustand. TanStack Query handles caching, staleness, refetching, and deduplication. Zustand is for client-only state that has nothing to do with the server.

### Comparison to Alternatives

| Aspect              | TanStack Query          | SWR                    | Apollo Client          | RTK Query               |
|---------------------|-------------------------|------------------------|------------------------|-------------------------|
| Protocol            | Any (fetch, axios, etc) | Any                    | GraphQL only           | Any                     |
| Cache invalidation  | Explicit + automatic    | Explicit + automatic   | Normalized cache       | Tag-based               |
| DevTools            | Excellent               | Basic                  | Excellent              | Redux DevTools          |
| Bundle size         | ~12 KB                  | ~4 KB                  | ~33 KB                 | Included with RTK       |
| Mutations           | First-class             | Basic                  | First-class            | First-class             |
| Ecosystem           | Huge                    | Large                  | GraphQL ecosystem      | Redux ecosystem         |

### Resources

- [TanStack Query v5: Overview](https://tanstack.com/query/v5/docs/framework/react/overview)
- [TanStack Query v5: Quick Start](https://tanstack.com/query/v5/docs/framework/react/quick-start)
- [TanStack Query v5: Important Defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults)
- [TanStack Query v5: Query Invalidation](https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation)
- [TanStack Query v5: Caching Examples](https://tanstack.com/query/latest/docs/framework/react/guides/caching)
- [Practical React Query (TkDodo's Blog)](https://tkdodo.eu/blog/practical-react-query)
- [Thinking in React Query (TkDodo's Blog)](https://tkdodo.eu/blog/thinking-in-react-query)
- [gcTime in TanStack Query Explained](https://tigerabrodi.blog/gctime-in-tanstack-query-explained)
- [TanStack Query GitHub Repository](https://github.com/TanStack/query)

### Test Questions

1. **Why separate server state (TanStack Query) from UI state (Zustand)?**
   Server state and UI state have fundamentally different lifecycles. Server state has a source of truth on the server -- it can become stale, needs refetching, requires error handling, and benefits from caching and deduplication. UI state (sidebar position, filter selections) has its source of truth in the browser and never needs fetching or cache invalidation. Mixing them into a single store means you lose TanStack Query's automatic staleness management, background refetching, and request deduplication. Each tool is optimized for its domain.

2. **When should you use refetchInterval vs SSE for updates?**
   Use `refetchInterval` when updates are infrequent (once per minute) or when implementing SSE is not worth the complexity. Use SSE when you need sub-second latency, when updates are frequent, or when you need to minimize wasted network requests. For reload.dev's dashboard, SSE + `invalidateQueries` is superior: updates arrive instantly, and no requests are wasted polling during quiet periods. You might still use `refetchInterval` as a fallback in case the SSE connection drops and reconnection is delayed.

3. **What happens when invalidateQueries is called while a query is already fetching?**
   TanStack Query handles this gracefully. If a query is already fetching, the invalidation marks it as stale. When the in-flight fetch completes, TanStack Query checks if the query is still marked as stale. If it is (because the invalidation happened after the fetch started, meaning the fetched data might already be outdated), it triggers another refetch. This ensures the UI always shows the latest data, even in race-condition scenarios.

4. **How does query key matching work for invalidation?**
   `invalidateQueries({ queryKey: ['runs'] })` invalidates all queries whose key starts with `['runs']`. This includes `['runs']`, `['runs', 'run_abc']`, `['runs', { status: 'failed' }]`, etc. The matching is prefix-based. To invalidate only an exact key, use `{ queryKey: ['runs'], exact: true }`. This hierarchical matching is why query key structure matters -- organize keys from general to specific.

5. **What is the difference between staleTime: 0 and staleTime: Infinity?**
   With `staleTime: 0` (the default), data is considered stale immediately after fetching. TanStack Query will refetch in the background on component mount, window focus, network reconnection, etc. The cached data is shown instantly, but a refetch fires every time. With `staleTime: Infinity`, data is never considered stale automatically. It will only be refetched when you explicitly call `invalidateQueries` or `refetch()`. This is appropriate for data that changes only in response to known events (like SSE notifications).

6. **How does TanStack Query deduplicate concurrent requests?**
   If two components mount simultaneously and both call `useQuery({ queryKey: ['runs'] })`, TanStack Query fires only **one** network request. Both components subscribe to the same query observer and receive the same data when it arrives. This deduplication is based on the query key -- identical keys share a single fetch, regardless of how many components are observing.

---

## 5. Zustand for UI State

### What Is Zustand?

Zustand (German for "state") is a minimal state management library for React. It provides a simple `create()` function that returns a React hook. No providers, no context wrappers, no reducers, no action types, no boilerplate. It is approximately 1 KB gzipped.

### When to Use It

Zustand is for **client-only state** that does not come from the server:

- Sidebar open/closed
- Active tab or panel
- Filter selections (status filter, queue filter, date range)
- Sort order and column visibility
- Theme (light/dark)
- Expanded/collapsed sections in a tree view
- Modal open state and which entity is being edited

### The create() API

```typescript
import { create } from 'zustand';

interface DashboardState {
  // State
  sidebarOpen: boolean;
  statusFilter: string[];
  sortBy: 'createdAt' | 'updatedAt';
  sortOrder: 'asc' | 'desc';

  // Actions
  toggleSidebar: () => void;
  setStatusFilter: (statuses: string[]) => void;
  setSortBy: (field: 'createdAt' | 'updatedAt') => void;
  toggleSortOrder: () => void;
}

const useDashboardStore = create<DashboardState>((set) => ({
  // Initial state
  sidebarOpen: true,
  statusFilter: [],
  sortBy: 'createdAt',
  sortOrder: 'desc',

  // Actions
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setStatusFilter: (statuses) => set({ statusFilter: statuses }),
  setSortBy: (field) => set({ sortBy: field }),
  toggleSortOrder: () =>
    set((state) => ({ sortOrder: state.sortOrder === 'asc' ? 'desc' : 'asc' })),
}));
```

Usage in a component:

```typescript
function Sidebar() {
  const sidebarOpen = useDashboardStore((s) => s.sidebarOpen);
  const toggleSidebar = useDashboardStore((s) => s.toggleSidebar);

  if (!sidebarOpen) return null;
  return <nav>...</nav>;
}
```

### Why NOT to Put Server Data in Zustand

It is tempting to fetch data and store it in Zustand. Do not do this. TanStack Query provides:

- **Automatic refetching** when data becomes stale
- **Cache invalidation** tied to server events
- **Loading and error states** per query
- **Request deduplication** across components
- **Background updates** without loading spinners
- **Garbage collection** of unused data

If you put server data in Zustand, you must implement all of these behaviors manually. You will inevitably end up with stale data, race conditions, and loading state bugs.

### Selectors

Zustand re-renders a component only when the **selected** slice of state changes:

```typescript
// GOOD: only re-renders when sidebarOpen changes
const sidebarOpen = useDashboardStore((s) => s.sidebarOpen);

// BAD: re-renders on ANY state change (destructuring the entire store)
const { sidebarOpen } = useDashboardStore();
```

Always use selectors to pick the specific values your component needs. This prevents unnecessary re-renders when unrelated state changes.

For computed values or multi-field selections, use `useShallow` to prevent re-renders when the output is structurally equal:

```typescript
import { useShallow } from 'zustand/react/shallow';

const { sortBy, sortOrder } = useDashboardStore(
  useShallow((s) => ({ sortBy: s.sortBy, sortOrder: s.sortOrder }))
);
```

### Persistence

Zustand provides a `persist` middleware for saving state to `localStorage`:

```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const useDashboardStore = create<DashboardState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      statusFilter: [],
      // ... actions
    }),
    {
      name: 'dashboard-preferences', // localStorage key
      partialize: (state) => ({
        sidebarOpen: state.sidebarOpen,
        sortBy: state.sortBy,
        sortOrder: state.sortOrder,
        // Don't persist transient state like statusFilter
      }),
    }
  )
);
```

This is useful for user preferences (theme, sidebar state, sort order) that should survive page refreshes and browser restarts.

### Resources

- [Zustand Official Documentation](https://zustand.docs.pmnd.rs/)
- [Zustand GitHub Repository](https://github.com/pmndrs/zustand)
- [Zustand Website](https://zustand-demo.pmnd.rs/)
- [Introducing Zustand (Frontend Masters Blog)](https://frontendmasters.com/blog/introducing-zustand/)
- [Zustand Documentation (zustand.site)](https://zustand.site/en/docs)

### Test Questions

1. **Why is Zustand simpler than Redux?**
   Redux requires action types (constants or enums), action creators, reducers, a store configuration, and often middleware (thunks, sagas). Zustand replaces all of this with a single `create()` call that defines state and actions together. No provider component is needed. No dispatch function. No connect/mapStateToProps. The entire store is a hook that components call directly.

2. **What happens if you select the entire store instead of a slice?**
   The component re-renders on every state change, regardless of whether the specific values it uses have changed. For example, if a component reads `sidebarOpen` but selects the entire store, it will re-render when `statusFilter` changes, `sortBy` changes, or any other state updates. This defeats Zustand's granular subscription model and can cause performance issues in components that render frequently.

3. **How does Zustand's persist middleware handle state shape changes between app versions?**
   If you add or remove fields from your store between deployments, the persisted state in localStorage may not match the new shape. Zustand's `persist` middleware provides a `version` option and a `migrate` function for handling this. You increment the version number and provide a migration function that transforms old state into the new shape. Without migration, new fields get their default values and removed fields are ignored.

4. **Can Zustand state be accessed outside of React components?**
   Yes. The store created by `create()` has a `getState()` method and a `subscribe()` method that work outside React. This is useful for accessing state in utility functions, API clients, or event handlers that are not React components. For example: `useDashboardStore.getState().statusFilter` returns the current filter value without needing a React hook.

5. **How would you structure multiple Zustand stores in a large application?**
   Create separate stores for separate concerns: `useDashboardStore` for dashboard UI state, `usePreferencesStore` for user preferences, `useFilterStore` for filter state. Each store is independent and can be persisted separately. Avoid a single monolithic store -- it defeats the purpose of granular subscriptions and makes the code harder to reason about. Components import only the stores they need.

---

## 6. Dashboard Architecture

### The Data Flow

The full reactive pipeline from database to rendered pixel:

```
Database INSERT/UPDATE
  -> PostgreSQL NOTIFY ('run_updates', '{"runId":"run_abc"}')
  -> PG LISTEN client receives notification
  -> Server writes to SSE stream: event: runUpdate\ndata: {"runId":"run_abc"}\n\n
  -> Browser EventSource receives event
  -> Event handler calls queryClient.invalidateQueries(['runs', 'run_abc'])
  -> TanStack Query refetches the updated data from the API
  -> React component re-renders with new data
```

This flow has several desirable properties:

1. **No polling**: updates arrive in real-time, only when something changes
2. **No manual state management**: TanStack Query handles caching and refetching
3. **Consistent data**: the refetch always queries the API, which always reads the latest committed data from the database
4. **Resilient**: if the SSE connection drops, EventSource auto-reconnects; TanStack Query still has cached data; the user sees stale data at worst, never an empty page

### Page Structure

The reload.dev dashboard consists of several views:

**Runs List Page**
A filterable, sortable table showing all task runs. Each row displays: run ID, task name, status (with color-coded badge), created time, duration, queue, and attempt count. Filters (stored in Zustand) let you narrow by status, task, queue, and date range. The data is fetched by TanStack Query and refreshed via SSE events.

**Run Detail Page**
Shows a single run with:
- **Header**: run ID, task name, current status, timestamps
- **Timeline**: a vertical list of events from the `run_events` table, rendered chronologically. Each event shows its type (CREATED, QUEUED, EXECUTING, COMPLETED, FAILED, RETRYING), timestamp, and any relevant metadata
- **Payload/Output**: expandable JSON viewers showing the trigger payload and the task output
- **Trace link**: a link to the Jaeger UI showing the full distributed trace for this run

The timeline is built by mapping event types to visual components:

```typescript
const EVENT_STYLES: Record<string, { color: string; icon: string }> = {
  CREATED:   { color: 'blue',   icon: 'plus'    },
  QUEUED:    { color: 'yellow', icon: 'clock'   },
  EXECUTING: { color: 'orange', icon: 'play'    },
  COMPLETED: { color: 'green',  icon: 'check'   },
  FAILED:    { color: 'red',    icon: 'x'       },
  RETRYING:  { color: 'purple', icon: 'refresh' },
};
```

**Queues Page**
Shows each queue with its concurrency configuration and current utilization. A gauge or progress bar shows `active / maxConcurrency` for each queue. This data updates in real-time via SSE as runs start and complete.

**Workers Page**
Shows connected workers, their status (idle, busy, draining), and which runs they are currently executing. Workers send heartbeats, and the dashboard shows their last heartbeat time and connection status.

### Proxying API Requests in Next.js Development

During development, the Next.js frontend (port 3000) needs to reach the Hono API server (port 3001). Instead of hardcoding URLs or dealing with CORS, use Next.js rewrites:

```javascript
// next.config.js
module.exports = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:3001/api/:path*',
      },
    ];
  },
};
```

This proxies all `/api/*` requests from the frontend to the backend. The browser sees same-origin requests (no CORS issues), and the rewrite is transparent to application code. In production, both services typically sit behind the same reverse proxy or the API is deployed at the same origin.

For SSE connections specifically, ensure the proxy does not buffer the response. Nginx, for example, requires `proxy_buffering off;` or `X-Accel-Buffering: no` for SSE to work correctly.

### Displaying a Run Timeline from the Event Log

The `run_events` table stores every state transition as a row. To render a timeline:

1. Fetch events for a run: `GET /api/runs/:id/events` (backed by `SELECT * FROM run_events WHERE run_id = $1 ORDER BY created_at ASC`)
2. Map each event to a timeline entry with an icon, color, timestamp, and description
3. Calculate durations between events (e.g., time in queue = EXECUTING timestamp - QUEUED timestamp)
4. Highlight the current state (the last event)

```typescript
function RunTimeline({ runId }: { runId: string }) {
  const { data: events } = useQuery({
    queryKey: ['runs', runId, 'events'],
    queryFn: () => fetchRunEvents(runId),
  });

  return (
    <ol className="timeline">
      {events?.map((event, i) => {
        const style = EVENT_STYLES[event.type];
        const duration = i > 0
          ? formatDuration(event.createdAt - events[i - 1].createdAt)
          : null;

        return (
          <li key={event.id} className={`timeline-item ${style.color}`}>
            <span className="timeline-icon">{style.icon}</span>
            <span className="timeline-label">{event.type}</span>
            <span className="timeline-time">{formatTime(event.createdAt)}</span>
            {duration && <span className="timeline-duration">{duration}</span>}
          </li>
        );
      })}
    </ol>
  );
}
```

When an SSE event arrives for this run, `invalidateQueries(['runs', runId, 'events'])` causes the event list to refetch, and the new event appears in the timeline instantly.

### Resources

- [Next.js: Rewrites (App Router)](https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites)
- [Next.js: Proxy](https://nextjs.org/docs/app/getting-started/proxy)
- [TanStack Query: Query Invalidation](https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation)

### Test Questions

1. **Why does the SSE event trigger an invalidateQueries call instead of directly updating the cache?**
   The SSE notification payload is intentionally minimal (just a run ID and event type) to stay within PostgreSQL's 8,000-byte NOTIFY limit and to keep the notification path fast. The full data (run details, events, payload, output) is fetched by TanStack Query's refetch mechanism, which hits the API endpoint. This keeps the data flow unidirectional and consistent: the API is always the single source of truth. Direct cache updates would require the SSE payload to contain the complete, correctly-shaped data, which is fragile and duplicates logic.

2. **What happens if the user opens the dashboard after the server has been running for an hour?**
   TanStack Query fetches the current state via normal API calls. The user sees all existing runs, queues, and workers immediately. SSE then takes over for real-time updates going forward. There is no need to replay an hour of events -- the initial fetch gives the complete current state, and SSE provides incremental updates from that point on.

3. **How would you handle displaying 10,000 runs in the runs list without performance issues?**
   Use server-side pagination. The API returns runs in pages (e.g., 50 per page) with cursor-based pagination. TanStack Query's `useInfiniteQuery` supports this pattern natively. On the frontend, use virtualization (e.g., TanStack Virtual or `react-window`) to render only the visible rows. SSE events invalidate specific run queries, not the entire paginated list, to avoid refetching all pages.

4. **Why use Next.js rewrites instead of setting CORS headers on the API?**
   Rewrites proxy the request through the Next.js server, so the browser sees a same-origin request. This avoids CORS entirely -- no preflight OPTIONS requests, no Access-Control-Allow-Origin headers, no credentials configuration. It is simpler to configure, performs better (no extra preflight roundtrip), and avoids a class of bugs related to CORS misconfiguration. In production, both services typically share an origin anyway.

5. **How would you test the full SSE-to-render pipeline?**
   At the integration level: trigger a run via the API, verify that the SSE stream emits the expected events, and verify that the TanStack Query cache is invalidated and the component re-renders with the new data. At the unit level: mock the EventSource to emit synthetic events, verify that `invalidateQueries` is called with the correct keys, and verify that the timeline component renders the expected event entries. Use `@testing-library/react` with a `QueryClientProvider` for the TanStack Query integration.

6. **What is the role of the event log table in the dashboard architecture?**
   The `run_events` table serves three purposes: (1) it is the durable, queryable record of everything that has happened -- the API reads from it to serve the dashboard; (2) it is the source of NOTIFY events that power real-time updates; (3) it enables replay and reconciliation -- if a client disconnects and reconnects, it can fetch the full event history from the table rather than relying on the notification stream, which is fire-and-forget.

---

## Summary

Phase 5 ties together several complementary technologies into a cohesive observability layer:

| Component              | Role                                        | Why This Choice                                   |
|------------------------|---------------------------------------------|---------------------------------------------------|
| SSE                    | Push run updates to browser in real-time    | Simpler than WebSocket, HTTP-native, auto-reconnect |
| PostgreSQL LISTEN/NOTIFY | Notify SSE server of database changes     | Zero external dependencies, transactionally consistent |
| OpenTelemetry          | Distributed tracing across trigger/queue/worker | Vendor-neutral, auto-instrumentation, CNCF standard |
| TanStack Query         | Cache and synchronize server data in React  | Best-in-class caching, invalidation, deduplication |
| Zustand                | Manage client-only UI state                 | Minimal boilerplate, granular subscriptions        |

The architecture follows a clear separation of concerns: PostgreSQL owns the data, LISTEN/NOTIFY provides the change signal, SSE delivers it to the browser, TanStack Query manages the cache, and Zustand handles purely presentational state. Each layer does one thing well, and replacing any single layer (e.g., swapping SSE for WebSocket, or LISTEN/NOTIFY for Redis Pub/Sub) does not require changes to the others.
