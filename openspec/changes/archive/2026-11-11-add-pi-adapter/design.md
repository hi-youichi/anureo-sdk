# Design

## Context

See proposal.md. Existing adapters (`packages/codex`, `packages/claude`, `packages/acp`) implement `HarnessAdapter`/`BackendSession` from `@anureo/sdk` and are validated by `@anureo/conformance`. Codex is the structural model: version profiles, injectable transport factory, catalog session.

## Goals / Non-Goals

**Goals**
- In-process Pi adapter satisfying `specs/pi-adapter/spec.md`.
- One isolated seam for all Pi imports so SDK churn and a future RPC host are cheap.

**Non-Goals**
- Process isolation, RPC host (documented as follow-up).
- Revert, goal, review, approval-style permissions.

## Decisions

1. **In-process SDK over RPC subprocess.** Typed API, no framing/backpressure code, tool allowlists give a permission story. Alternatives: `pi --mode rpc` (isolated but needs a JSONL client and fake binary), `pi -p --mode json` (undocumented events, no steer/abort), Pi's lower-level libraries (reimplements the agent).
2. **`PiSessionHost` interface** (`prompt, steer, followUp, abort, waitForIdle, subscribe, setModel, setThinkingLevel, listModels, messages, fork, switchSession, newSession, dispose`). Only `src/host.ts` imports Pi. `createPiAdapter({ createHost })` mirrors Codex's `processFactory`; tests inject a scripted fake host.
3. **Single subscription owner.** `events.ts` owns `subscribe()` per session, rebinds after fork/switch (Pi requires it) and tears down on close. Turn completion keys on the settled event, never on run end or `prompt()` resolution.
4. **Permissions via tools.** `read-only` = read-type tools only; `agent-full-access` = Pi defaults. No approval (`agent`) mode is advertised.
5. **Version profile.** `resolvePiProfile(version)` selects capabilities; unknown versions get the baseline. Verified versions are pinned with recorded event transcripts (provenance file).
6. **Dependency.** `@earendil-works/pi-coding-agent` as a peer dependency with a pinned verified range; the package name is confirmed at install time (older docs use `@mariozechner/...`).

## Risks / Trade-offs

- Pi crash/leak/hang affects the host → dispose-on-close, timeouts, documented trust boundary.
- SDK internals change → imports confined to `host.ts`, profile gating, pinned transcripts.
- Rebind after runtime swap is error-prone → dedicated listener-leak and post-fork event tests.
- Steer returns `"handled"` for extension-consumed input → map explicitly and test it.
- Extension UI interactions: the SDK exposes them only through `bindExtensions` with a UI context, which this adapter does not bind → no interactions capability is advertised (decided, not deferred).
- Turn identity: Pi has no turn ids, so a turn is one run (agent start → settled). History and fork boundaries use the first user entry of the run, recorded live and otherwise inferred from entry order.
- Real model behaviour is not covered by tests: the suite uses a scripted host. Offline smoke and the session-file probe run against the real SDK; recording real event transcripts needs credentials.

## Migration Plan

Additive package; no migration. Rollback = remove the package and root wiring.

## Open Questions

- Exact payloads of real model runs: pin them with task 1.3 once credentials are available; mapping was written against the SDK's published types.
