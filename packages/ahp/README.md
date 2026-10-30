# @anureo/adapter-ahp

Adapter connecting the Anureo SDK to **external harnesses that speak AHP themselves** — over stdio or WebSocket. Use the anureo SDK to connect any harness, including one built on anureo: this package is the wire-level client for third-party ACP-style hosts that implement the same protocol the SDK is built on.

> Part of the [Anureo SDK workspace](../../README.md). Install with `npm install @anureo/adapter-ahp`.

## Usage

```typescript
import { createHarnessRuntime } from '@anureo/sdk'
import { createAhpAdapter, createWebSocketTransport } from '@anureo/adapter-ahp'

// Over stdio:
const stdioRuntime = createHarnessRuntime(createAhpAdapter({
  command: 'my-harness',           // spawned; speaks nd-JSON AHP on stdio
  args: ['serve'],
}))

// Over WebSocket (loopback-only by default):
const wsRuntime = createHarnessRuntime(createAhpAdapter({
  url: 'ws://127.0.0.1:9210',
  connect: url => createWebSocketTransport(url),
}))

// Or inject any transport you already own:
const customRuntime = createHarnessRuntime(createAhpAdapter({
  transport: () => Promise.resolve(myTransport),
}))
```

A minimal, dependency-free reference harness lives in [examples/reference.ts](examples/reference.ts); it implements the AHP wire contract on top of the SDK itself and can serve as the template for third-party harnesses.

## Behavior the adapter enforces

- **Version handshake.** `initialize` negotiates the AHP major version; every request and result is validated against the protocol schema before use.
- **Sequence integrity.** Events carry `(sessionId, streamId, seq)`. A gap in the sequence is repaired only when the harness negotiated `x-anureo/event-replay@1` (via `x-anureo/events/read`); otherwise the stream fails with `SOURCE_SEQUENCE_GAP` instead of presenting a hole as complete history.
- **Session metadata.** Delivered through the negotiated `x-anureo/session-metadata@1` extension; the adapter always requests it and ignores duplicated metadata from other channels.
- **Interactions.** `interaction/requested` is answered through the session's `respond()`/`cancelInteraction()`; the adapter forwards the answer over the wire and surfaces remote resolutions (`interaction/resolved`) without double-answering.
- **Unknown notifications.** Native notifications outside the AHP event set are converted to safe `notice` events with the raw (redacted) payload attached — a future-proofing harness cannot crash the host.
- **Connection loss.** A closed transport fails every open session sink and rejects pending responses with `outcomeUnknown`-carrying errors; no session continues silently on a dead wire.

## Exports

| Entry | Contents |
|---|---|
| `@anureo/adapter-ahp` | `createAhpAdapter`, `AhpAdapterOptions`, `AhpAdapter`, `AhpWire`, `AhpTransport`, `createStdioTransport`, `createWebSocketTransport` |
| `@anureo/adapter-ahp` (wire) | `AhpWire` — the JSON-RPC 2.0 client with per-request timeouts, frame-size limits (`maxFrameBytes`, default 8 MiB), pending-request limits (`maxPending`, default 256), and notification backlog bounds (`maxNotifications`, default 2048) |

`createWebSocketTransport` deliberately restricts addresses: `ws:` is only accepted for loopback hosts (`127.0.0.1`, `localhost`, `[::1]`), credentials, query strings, and fragments in URLs are rejected, and the socket's buffered amount is bounded — remote or authenticated transports must bring their own factory via `options.connect`.

## Development

```sh
cd packages/ahp
bun run typecheck
bun test tests
```

The workspace's `bun run verify:pack` runs real stdio conversations against the reference harness, covering text turns, rejected approvals, and interrupts.

## Documentation

- [AHP v1 protocol](../../spec/ahp-v1.md) — the wire contract (currently in Chinese)
- [Architecture](../../docs/architecture.md)
