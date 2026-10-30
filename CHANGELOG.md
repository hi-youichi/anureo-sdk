# Changelog

All notable changes to the Anureo SDK will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [SemVer](https://semver.org/spec/v2.0.0.html). During the
0.x line, minor versions may include breaking changes; such entries are
marked **BREAKING**.

## [0.2.0] - 2026-10-30

First public npm release of the Anureo SDK under the `@anureo` scope.

- `@anureo/protocol` — Anureo Harness Protocol (AHP) v1: JSON Schema
  (`urn:anureo:ahp:v1`), generated TypeScript types, runtime validation
  (Ajv 8.20.0, draft 2020-12), version and capability negotiation.
- `@anureo/sdk` — runtime core: `createHarnessRuntime(adapter)` wraps any
  adapter behind `HarnessRuntime` / `HarnessSession`, enforcing turn and
  item lifecycle state machines, bounded event queues, interaction
  approvals, and secret redaction for events and histories.
- `@anureo/adapter-codex` — Codex CLI `app-server` adapter over stdio
  JSONL, with the native protocol schema vendored and hash-verified.
- `@anureo/adapter-claude` — adapter for the official Claude Agent SDK
  (0.3.257), including the `FileSessionStore` session persistence.
- `@anureo/adapter-acp` — adapter for standard Agent Client Protocol
  agents via the official `@agentclientprotocol/sdk` 1.4.0.
- `@anureo/adapter-ahp` — wire-level client for external harnesses that
  implement AHP themselves, over stdio or WebSocket.
- `@anureo/conformance` — shared conformance suite (lifecycle, approval,
  interrupt, history scenarios) and scripted fake backends that speak
  their real native wire protocols.

**BREAKING** (relative to the upstream internal `@cowork/harness-*` 0.1.0
packages this codebase was extracted from): package names, the `x-anureo/`
extension prefix, the `Ahp*` / `createAhpAdapter` naming, and the schema
`$id` changed; old-brand extension names are not compatible.

[0.2.0]: https://github.com/hi-youichi/anureo-sdk/releases/tag/v0.2.0
