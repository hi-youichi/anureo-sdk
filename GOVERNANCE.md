# Governance

## Roles and decision making

The project is currently maintained by a single maintainer
([@hi-youichi](https://github.com/hi-youichi)), who makes final calls on
protocol and API changes. Changes to the specification or to public
package APIs follow an RFC-style flow:

1. Open an issue describing the problem and the proposed contract change
   before implementation.
2. Update the [v1 JSON Schema](packages/protocol/schema/v1/ahp.schema.json),
   the English specification (`spec/ahp-v1.md`), and the Chinese reference
   translation (`spec/ahp-v1.zh.md`) together in one pull request. See
   [Changing the protocol](CONTRIBUTING.md#changing-the-protocol) for the
   corresponding generation and conformance checks.
3. The maintainer merges; the decision and its rationale are recorded in
   the commit and the specification changelog.

As the ecosystem grows, this is expected to evolve toward a multi-party
review board for protocol changes. The `@anureo/conformance` suite is
the arbiter of "implemented correctly" regardless of who reviews.

## Versioning

- **Package versions** follow SemVer. During the 0.x line, minor bumps
  may include breaking changes; every such change is marked **BREAKING**
  in [CHANGELOG.md](CHANGELOG.md).
- **Protocol major versions** are negotiated at `initialize`. Adding an
  optional field does not bump the protocol major version. The native
  lifecycle revision deliberately breaks wire compatibility with the
  0.2.0 baseline while retaining major version 1 and a single runtime
  contract. Upgrade both peers and their consumers together. The v1 schema
  requires `protocolContract: "native-lifecycle"` on initialization requests
  and results so validation can reject incompatible peers before session
  operations. Future breaking changes require an explicit version and
  compatibility decision. Undeclared capabilities remain unsupported.
  See [initialization examples](packages/protocol/README.md#usage).

## Extension registry

Vendor extensions use `x-<vendor>/<feature>` names with an independent
version and must be declared in both parties' capabilities during
`initialize`. Registration is a pull request to the table below; the
`anureo` namespace is reserved for extensions defined by this project.

| Extension | Version | Introduced | Description |
| --- | --- | --- | --- |
| `x-anureo/session-metadata@1` | 1 | 0.2.0 | `session/metadata` event and `SessionState.metadata` (title semantics: absent = no update, string = replace, null = clear; no turn lifecycle meaning) |
| `x-anureo/event-replay@1` | 1 | 0.2.0 | `x-anureo/events/read` request for replaying events from a source sequence number; repairs sequence gaps instead of presenting holes as complete history |

## Conformance

An implementation claims a capability only after passing the applicable
`@anureo/conformance` cases. Adapter tests supply the fixtures to the shared
suite, which exercises the public SDK through the adapter. For wire
adapters, use scripted backends that speak the native protocol. Full adapter
conformance also requires the native suite for overlap, active close, and
independent observation. See the [conformance guide](packages/conformance/README.md).

The implementations below refer to the published baseline. They must pass
new lifecycle scenarios before claiming conformance to the revised v1.

### Known conforming implementations

| Implementation | Adapter | Notes |
| --- | --- | --- |
| anureo backend (via `@anureo/adapter-ahp`) | native AHP over stdio/WebSocket | reference implementation |
| Codex CLI app-server (via `@anureo/adapter-codex`) | stdio JSONL | vendored schema, hash-verified |
| Claude Agent SDK (via `@anureo/adapter-claude`) | official SDK 0.3.x | includes FileSessionStore persistence |
| Agent Client Protocol agents (via `@anureo/adapter-acp`) | official `@agentclientprotocol/sdk` 1.4.0 | interop proof with the ACP ecosystem |

To list a third-party implementation, open a PR with a pointer to a CI
job that runs the conformance suite against it.

### Workspace Hermes adapter

`@anureo/adapter-hermes` implements the revised v1 native lifecycle against the
Hermes `hermes-gateway-v1` contract inspected at v0.23.1. Its scripted native
CLI/WebSocket child-process fixture passes the applicable shared conformance
cases and native overlap, close-active and observer-cancel scenarios. Supported
surfaces are text execution, queued admission, approvals/user input, resume and
exact-turn interruption. Unsupported surfaces remain capability gated.

The recorded live check covered one model turn on Hermes
`v0.23.1+2913.gbba2061`. Live multi-turn, approval, interrupt and replay
scenarios remain unverified. See the [gateway example](examples/hermes.ts)
for configuration and cleanup and the [adapter tests](packages/adapter/hermes/tests/conformance.test.ts)
for fixture coverage.
