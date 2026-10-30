# Governance

## Roles and decision making

The project is currently maintained by a single maintainer
([@hi-youichi](https://github.com/hi-youichi)), who makes final calls on
protocol and API changes. Changes to the specification or to public
package APIs follow an RFC-style flow:

1. Open an issue describing the problem and the proposed contract change
   before implementation.
2. Changes land as pull requests updating **all three artifacts
   together**: the JSON Schema (`packages/protocol/schema/v1/`), the
   English specification (`spec/ahp-v1.md`), and the Chinese reference
   translation (`spec/ahp-v1.zh.md`).
3. The maintainer merges; the decision and its rationale are recorded in
   the commit and the specification changelog.

As the ecosystem grows, this is expected to evolve toward a multi-party
review board for protocol changes. The `@anureo/conformance` suite is
the arbiter of "implemented correctly" regardless of who reviews.

## Versioning

Two version axes exist and must not be conflated:

- **Package versions** follow SemVer. During the 0.x line, minor bumps
  may include breaking changes; every such change is marked **BREAKING**
  in [CHANGELOG.md](CHANGELOG.md).
- **Protocol major versions** are negotiated at `initialize`. Adding an
  optional field does not bump the protocol major version; any breaking
  semantic change must. Capabilities not declared in the handshake are
  not supported — implementations must not guess from provider names.

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

An implementation claims a capability only after passing
`@anureo/conformance` for that capability surface (lifecycle, approval,
interrupt, history). The conformance suite spawns scripted backends that
speak their real native wire protocols — not mocks of the SDK — and
`bun run verify:pack` repeats the flows against clean npm installs of
the built packages.

### Known conforming implementations

| Implementation | Adapter | Notes |
| --- | --- | --- |
| anureo backend (via `@anureo/adapter-ahp`) | native AHP over stdio/WebSocket | reference implementation |
| Codex CLI app-server (via `@anureo/adapter-codex`) | stdio JSONL | vendored schema, hash-verified |
| Claude Agent SDK (via `@anureo/adapter-claude`) | official SDK 0.3.x | includes FileSessionStore persistence |
| Agent Client Protocol agents (via `@anureo/adapter-acp`) | official `@agentclientprotocol/sdk` 1.4.0 | interop proof with the ACP ecosystem |

To list a third-party implementation, open a PR with a pointer to a CI
job that runs the conformance suite against it.
