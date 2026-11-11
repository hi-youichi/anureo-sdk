# Proposal

## Why

The SDK ships adapters for Claude, Codex and ACP agents, but not for the Pi coding agent. Pi exposes a TypeScript SDK (`createAgentSession`) that supports sessions, steering, abort, forking and compaction, so it can be brought behind the AHP session model without a protocol bridge.

## What Changes

- Add a new workspace package `@anureo/adapter-pi` exposing `createPiAdapter`.
- The adapter embeds Pi in-process through its TypeScript SDK; all Pi imports are isolated behind an injectable session-host seam so a subprocess/RPC host can be added later without changing behavior.
- Map AHP submit / steer / interrupt / fork / history / compact / model and thinking-level configuration onto Pi; do not advertise capabilities Pi cannot honor (revert, goal, review).
- Enforce `read-only` and `agent-full-access` permission modes through tool allowlists, since Pi has no approval gate.
- Wire the package into the workspace (root dependencies, README adapter list, CHANGELOG, CI) and run the shared conformance suites against a fake host.

## Capabilities

### New Capabilities

- `pi-adapter`: Behavior of the Pi harness adapter as seen through the AHP session model — session lifecycle, turn completion, steering/interrupt, fork/history/compact, configuration, permissions, capability advertisement and failure handling.

### Modified Capabilities

(none — no existing specs under `openspec/specs/`)

## Impact

- New package `packages/pi`; root `package.json`, `README.md`, `CHANGELOG.md`, CI workflow.
- New dependency on `@earendil-works/pi-coding-agent` (peer dependency, pinned verified range).
- Security: Pi runs inside the host process with the host's credentials and filesystem rights; this is documented, not mitigated by isolation.
- Out of scope: subprocess/RPC host, revert/goal/review, approval-style permission mode.
