# @anureo/host

Persist agent sessions, observe their events, and expose scoped access through a
local API or a WebSocket endpoint. The application supplies runtime clients,
authenticated actors, workspace resolution, and an authorization policy.

```ts
import { createHarnessHost } from '@anureo/host'
import { HarnessStore } from '@anureo/host/sqlite'

const actor = { userId: 'owner' }
const host = createHarnessHost({
  store: new HarnessStore('./sessions.sqlite'),
  runtimes: [],
  resolveWorkspace: scopeId => scopeId === 'workspace' ? process.cwd() : undefined,
  authorize: (candidate, scopeId) =>
    candidate.userId === actor.userId && scopeId === 'workspace',
})
try {
  console.log(await host.sessions.list({ actor }, { scopeId: 'workspace' }))
} finally {
  await host.close()
}
```

Register runtime descriptors whose `create` callback returns an initialized SDK
Client to execute model turns. Empty runtime registration still permits reading
stored sessions. Scope IDs are application-defined workspace identities; the
Host enforces the injected authorization policy for each operation.

## Storage and lifecycle

`@anureo/host/sqlite` selects Bun SQLite under Bun and Node SQLite under Node.
Use a separate database per Host instance; concurrent writers are rejected.
`HostStorage` is the storage port for an application-owned implementation.
Await `host.close()` to release runtime observations, subscriptions, and storage.
Closing an observation does not by itself prove that a shared native execution
has stopped; interruption and recovery use the runtime's declared capabilities.

## WebSocket access

`createScopedHostDispatcher(host)` adapts the Host to the scope-based JSON-RPC
contract. Pass it to `createHostWebSocket` to embed the transport in an existing
server, or `listenHostWebSocket` from `@anureo/host/ws` for a standalone listener.
The application authenticates each connection; authentication does not replace
the Host's per-scope authorization policy. Close the listener before the Host.
`@anureo/host/protocol` exports the scoped protocol types and codecs.

## Compatibility

`HarnessHost` and `@anureo/host/compat` retain the existing project-based Hx
integration surface. New applications should use `createHarnessHost` and the
scoped dispatcher. Projection and UI presentation remain application-owned.

## Code structure

- `src/host.ts`, `src/scoped-host.ts`: lifecycle, execution, and scoped APIs.
- `src/store.ts`, `src/sqlite-bun.ts`, `src/sqlite-node.ts`: durable storage.
- `src/catalog.ts`, `src/queue.ts`: model discovery and queued work.
- `src/ws.ts`, `src/ws-connection.ts`, `src/ws-listener.ts`: transports.
- `src/protocol.ts`, `schema/`, `scripts/generate.ts`: wire types and validation.
