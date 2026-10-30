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

## Redaction and secret handling (design guarantees)

Secret safety is a core protocol guarantee, not an afterthought. The
following invariants hold across `@anureo/protocol` and `@anureo/sdk`
and are enforced by tests:

- **`privatePayload` is memory-only.** It is never written to disk.
  `publicEvent`/`publicInteraction` produce an immutable public
  projection: the entire `privatePayload` is removed (replaced by
  `privatePayloadAvailable`), and the original object is never modified
  in place.
- **Sensitive keys are redacted in public projections.** Keys such as
  `password`, `token`, `apiKey`, `authorization`, `headers`, and `env`
  are replaced with `[redacted]`; secret-marked answer values are
  redacted.
- **Authorization URLs are stripped.** Query and fragment never appear
  in public text; the full address is only available through the host's
  private authorization read.
- **Logs carry no parameter values.** Only validation paths and error
  keywords are retained.
- **Failure never implies authorization.** Unknown requests return
  method-not-found (never default-approve); timeouts, disconnects, and
  turn termination never auto-approve an interaction; `outcomeUnknown`
  errors never auto-retry.

If you believe any of these invariants can be violated, that is a
security report, not a regular bug — please use the private channel
above.
