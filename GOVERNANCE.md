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
   translation (`spec/ahp-v1.zh.md`). The current lifecycle revision updates
   v1 in place; do not retain a second runtime contract for the pre-revision
   semantics.
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
  optional field does not bump the protocol major version. The maintainer's
  current decision is a deliberate breaking revision **within AHP v1**, not
  a new negotiated major. Both peers and consumers must upgrade together;
  initialization must reject mismatched required lifecycle guarantees rather
  than silently interpreting old messages under new semantics. Initialization requests and results require
  `protocolContract: "native-lifecycle"` in the revised schema. See the
  [lifecycle decision](docs/native-harness-lifecycle.md#8-单一-v1-的兼容边界).
  Undeclared capabilities remain unsupported. Future breaking changes require
  an explicit version/compatibility decision; this exception does not imply
  wire compatibility with the published 0.2.0 baseline.

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
speak their real native wire protocols — not mocks of the SDK.

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
