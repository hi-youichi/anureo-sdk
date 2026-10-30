# Contributing

Thanks for your interest in the Anureo SDK.

## Development setup

- Node.js 22+
- Bun 1.4.2+

```sh
bun install --frozen-lockfile
```

## Validation

Before every push, CI runs the following — run them locally first:

```sh
bun run check:boundaries   # package independence + publishable metadata
bun run generate:check     # generated types match the JSON Schema
bun run protocol:check     # schema fixtures
bun run typecheck          # strict NodeNext, all packages
bun run typecheck:tooling  # build tooling
bun test --timeout 15000 packages scripts/harness-sdk
bun run example            # standalone example
bun run verify:pack        # full pack + clean-install + dual-runtime verification
```

CI validates Windows, macOS, and Linux; a pull request is mergeable only
when all three pass.

## Adding an adapter

1. Create `packages/<name>` with a manifest that follows the publishable
   metadata shape (`description`, `license`, `repository`,
   `publishConfig.access: "public"`, no `private`). The boundary checker
   enforces this.
2. Implement the harness adapter contract and register it in the
   workspace, pack script, and boundary allow-list.
3. Conformance is mandatory: your adapter must pass the
   lifecycle/approval/interrupt/history scenarios in
   `@anureo/conformance`, driven by a **scripted fake backend that
   speaks the native wire protocol as a real child process** (see
   `packages/conformance/scripts/` for examples). Mocking the SDK itself
   proves nothing.
4. Update the conformance table in
   [GOVERNANCE.md](GOVERNANCE.md) if you add a new capability surface.

## Changing the protocol

Protocol changes are never code-only. A change must update, in the same
pull request:

1. `packages/protocol/schema/v1/ahp.schema.json` (the normative source),
2. the generated types (`bun run generate` inside `packages/protocol`),
3. `spec/ahp-v1.md` (English, authoritative) **and**
   `spec/ahp-v1.zh.md` (Chinese reference translation),
4. the affected conformance scenarios.

See [GOVERNANCE.md](GOVERNANCE.md) for versioning and extension rules.

## Commits and pull requests

- Commits: short imperative subject line in English; body when the
  change is non-obvious.
- Pull requests describe what changed and why, and reference the issue
  when one exists.
- Keep changes focused; unrelated refactors go in their own PR.

## Licenses

By contributing, you agree that your contributions are licensed under
[Apache-2.0](LICENSE) (code) and, for specification text,
[CC-BY-4.0](spec/LICENSE). No CLA is required.
