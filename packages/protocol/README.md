# @anureo/protocol

AHP v1 is being revised in place. The revised contract is provided through the
root entry `@anureo/protocol`, the schema subpath `@anureo/protocol/schema`, and
the schema file `schema/v1/ahp.schema.json`. There will be one maintained
lifecycle contract.

The workspace schema and generated types now use the revised contract; local
adapter and packaging validation have passed. The revised wire semantics differ
from those of the published 0.2.0 release. See the
[design](../../docs/native-harness-lifecycle.md) and the
[v1 amendment](../../spec/ahp-v1.md#native-lifecycle-amendment).

The Anureo Harness Protocol (AHP) v1 contract: a JSON Schema, generated TypeScript types, runtime validation, and version/capability negotiation helpers shared by every other Anureo SDK package.

The schema at `schema/v1/ahp.schema.json` is the single source of truth. TypeScript types, the method table, and runtime validators are generated from it — nothing is typed by hand. Validation runs on Ajv 8.20.0 with JSON Schema draft 2020-12.

> Part of the [Anureo SDK workspace](../../README.md). Install with `npm install @anureo/protocol`.

## Exports

| Export | Purpose |
|---|---|
| `ahpSchema` | The raw AHP v1 JSON Schema (also via `@anureo/protocol/schema`) |
| `AHP_PROTOCOL_VERSION` | The protocol major version implemented here (`1`) |
| `AHP_PROTOCOL_CONTRACT` | Required initialization discriminator (`native-lifecycle`) |
| `validateDefinition` / `assertDefinition` | Validate any named `$defs` entry from the schema |
| `validateRequest` / `assertRequest` | Validate request params for a given AHP method |
| `validateResult` / `assertResult` | Validate the result for a given AHP method |
| `validateEvent` / `assertEvent` | Validate a full `AhpEvent` (notification payload) |
| `isAhpMethod` | Type-guard for known method names |
| `negotiateVersion` | Pick the highest mutually supported protocol major version |
| `supportsCapability` | Capability lookup; missing values and empty lists are unsupported |
| `supportsExtension` | Check a negotiated `x-<vendor>/<feature>` extension |
| `validateInteractionResponse` / `assertInteractionResponse` | Validate an interaction answer against its request (options, required questions, embedded JSON Schema) |
| `validateJsonSchema` | Validate caller-supplied values against an arbitrary JSON Schema with the same engine |
| `publicEvent` / `publicInteraction` / `publicValue` | Detached public projections that redact secret-marked and authentication fields |
| `itemIdentity` | Canonical `(sessionId, turnId, itemId)` identity key |
| `ProtocolValidationError` | Validation failure with `instancePath`/`keyword`/`message` issues only |

Generated domain types (`AhpMethod`, `AhpRequestMap`, `AhpResultMap`, `Capabilities`, `Item`, `AhpEvent`, and the rest) are re-exported from the root entry point.

## Usage

```typescript
import {
  AHP_PROTOCOL_CONTRACT, assertRequest, negotiateVersion,
  supportsExtension, type Capabilities,
} from '@anureo/protocol'

const protocolVersion = negotiateVersion([1], [1])
assertRequest('initialize', {
  protocolVersions: [protocolVersion],
  protocolContract: AHP_PROTOCOL_CONTRACT,
  clientInfo: { name: 'example-host', version: '0.3.0' },
})

const capabilities: Capabilities = {
  input: { delivery: ['native'], steer: { target: 'turn', atomicMatch: true } },
}
const supportsSteer = capabilities.input?.steer?.atomicMatch === true
const supportsReplay = supportsExtension(capabilities, 'x-anureo/event-replay', '1')

assertRequest('input/submit', {
  requestId: 'submit-1', sessionId: 's1', submissionId: 'input-1',
  delivery: 'native', input: [{ type: 'text', text: 'Inspect the workspace' }],
})
```

Initialization results also require `protocolContract: "native-lifecycle"`.
A missing or mismatched discriminator is rejected before business dispatch,
even when both peers negotiate major 1.

Submission identity does not allocate an execution. The `submission/bound` event
reports the association between a submission (`submissionId`) and an execution
(`turnId`). The SDK keeps the submission identity internal.
The expression `await session.submit()` returns a Turn directly.

## Privacy projections

`publicEvent`, `publicInteraction`, and `publicValue` return a detached copy suitable for public histories: `privatePayload` is removed entirely (replaced by `privatePayloadAvailable`), sensitive keys such as `password`, `token`, `apiKey`, `authorization`, `headers`, and `env` are replaced with `[redacted]`, secret-marked answer values are redacted, and authorization URLs lose their query and fragment. The original object is never modified in place.

## Development

```sh
cd packages/protocol
bun run generate        # regenerate src/generated/types.ts from the schema
bun run generate:check  # fail if generated files are stale
bun run typecheck
bun test tests
```

The generator rejects unsupported type vocabulary rather than emitting `any`. Schema drift is checked in CI via `bun run generate:check` at the workspace root.

## Documentation

- [AHP v1 protocol](../../spec/ahp-v1.md) — the authoritative protocol contract (English; a Chinese reference translation is available)
- [Architecture](../../docs/architecture.md) — how protocol, core, and adapters relate
