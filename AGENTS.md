# Documentation

Write only official documentation in `docs/`. Write all other documentation in `draft/docs/`.
Do not create, modify, move, or delete files under `docs/` unless explicitly requested by a human.

## Package README API guides

- Lead with what the package does and show a minimal, complete example of its common workflow. Organize the core API by task or object. Explain what each operation does and document behavior that affects how to call it, such as what an asynchronous operation waits for or which resources the caller must release.
- Group APIs by their intended callers. Give extension contracts such as adapters and plugins their own section, and explain who implements and who calls each contract. Place a method with its intended audience even if it is a member of a core class.
- Group supporting exports by purpose, such as errors, logging, process management, or diagnostics, and give their import paths. Mention internal functions only when they help explain observable behavior. If an internal entry point must be importable, identify it as internal and explain who uses it and why.
- Check the README against `package.json` and the source entry points. Every supported entry point should have a stated purpose, and every core operation should be discoverable in the README or a linked API reference. Check intended support against documented contracts and known callers. Ask a maintainer to clarify ambiguous exports before documenting them as supported APIs.

## Package README code structure

Give the package README a dedicated **Code structure** section after the API overview. Link to the main source directories and modules, and explain what each owns. Describe how the public entry points connect to the main implementation modules where that helps contributors find their way. Keep the section focused on the paths contributors need to locate code.

# Workflow

`@anureo/workflow` composes independent agent sessions and application code in ordinary TypeScript functions using `agent`, `parallel`, and `pipeline`.

See the [workflow authoring guide](docs/workflow/SKILL.md) for composition patterns, failure handling, and recovery; the [primitives reference](docs/workflow/README.md) for API contracts; and the [package guide](packages/workflow/README.md) for usage examples.

# npm releases

For each npm release, increment only the patch version by exactly one. For example, release `0.3.1` after `0.3.0`.
