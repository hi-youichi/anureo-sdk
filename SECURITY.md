# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately via
[GitHub Security Advisories](https://github.com/hi-youichi/anureo-sdk/security/advisories/new)
("Report a vulnerability"). Do not open public issues for security
reports.

- **Acknowledgement:** within 5 days.
- **Fix policy:** fixes ship in a patch release of the affected 0.x line
  whenever possible; the advisory is published together with the fix.
- **Scope:** this repository — the protocol schema, the runtime core,
  adapters, and the conformance suite. Vulnerabilities in third-party
  dependencies should be reported upstream; we will bump the pinned
  dependency once an upstream fix exists.
- There is no bug bounty program; reports are voluntary.

## Supported versions

The latest published 0.x minor line of each package is supported.
Security fixes target that line only.

## Redaction and secret handling

- **Public interaction requests omit `privatePayload`.** The protocol's
  `publicEvent`, `publicInteraction`, and `publicValue` helpers copy JSON
  without modifying the input and replace `privatePayload` with
  `privatePayloadAvailable: true`. When an adapter registers an interaction
  through `requestInteraction`, the SDK uses `publicInteraction` before
  publishing `interaction/requested`. It retains the native request in
  memory for settlement and passes a copy to the configured host handler.
  Hosts must keep that copy private.
- **Public projections filter sensitive fields.** The protocol helpers
  replace values under keys such as `password`, `token`, `apiKey`,
  `authorization`, `headers`, and `env` with `[redacted]`. They redact
  fields such as `answer` and `value` in objects marked `secret: true`
  and strip queries and fragments from HTTP(S) URLs in projected strings.
  If a native interaction supplies a full authorization URL in
  `privatePayload`, the host handler can use it from its private request
  copy. Callers must keep secrets out of arbitrary text sent to public
  outputs.
- **The SDK registers marked answers before native delivery.** It uses
  them to redact supported public event, history, and output fields. The
  in-memory registry can notify a host-provided `onMarkedSecret` hook.
  Hosts own any storage that hook uses.
- **Validation diagnostics omit rejected parameter values.** Protocol
  validation issues retain the instance path, keyword, and message. SDK
  structured-output schema diagnostics retain the path and keyword.
- **Failure never grants approval.** Unsupported requests are rejected.
  Interaction expiry and session teardown cancel pending requests without
  sending an approval. The SDK does not automatically retry native
  requests when their outcome is unknown. Hosts that retry must reconcile
  an unknown outcome first to avoid duplicating work.

Report suspected violations through the private channel above.
