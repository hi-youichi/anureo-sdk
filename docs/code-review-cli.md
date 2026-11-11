# Code review CLI

`@anureo/code-review` provides the `anureo-review` command. A planner first identifies modules and review angles; independent
agents then review each module/angle pair across a Git worktree, using the existing Anureo SDK and workflow
primitives with an authenticated local Codex CLI.

The package requires **Bun 1.4.2 or later**, Git and the Codex CLI. It follows this
repository's source-first package layout; its executable is TypeScript with a Bun
shebang. It does not provide a supported JavaScript library interface.

## Run from this checkout

Install workspace dependencies, then use the root script:

```sh
bun install
bun run review . --dry-run
bun run review ../another-project --scope src --output ./review-report
bun run review ../another-project --dimension D12 --output ./readability-report
```

The workspace also registers `node_modules/.bin/anureo-review`. The executable can
be invoked directly with Bun, including from an unrelated working directory:

```sh
bun /absolute/path/to/anureo-sdk/packages/code-review/bin/anureo-review.ts /path/to/project --dry-run
```

This workspace package has not been published as part of this change. The target
project does not need an Anureo dependency or a particular language ecosystem.

## Arguments

```text
anureo-review [project] [options]
```

The project defaults to the current directory. It must be a Git worktree or a
directory inside one. File discovery includes tracked files and untracked files
that Git does not ignore. It does not expand into Git submodules or dependencies.

| Option | Behavior |
| --- | --- |
| `--dimension <angle-id>` | Filter angles returned by the planner; repeat to combine. Default: every discovered angle. D1–D12 remain reference IDs; project-specific IDs are allowed. |
| `--scope <path>` | Select a file or directory relative to the project; repeat to combine scopes. Without it, select the whole inventory. |
| `--config <json>` | Read project groups, flows and contracts from a JSON file. |
| `--output <directory>` | Save artifacts in a new or empty directory. Default: `<project>/.anureo/reviews/<run>`. |
| `--format markdown\|json` | Select the report written to stdout. Default: Markdown. Both report files remain in the artifact directory. |
| `--model <model>` | Override the model; otherwise use `ANUREO_REVIEW_MODEL`, then the backend default. |
| `--concurrency <1..16>` | Shared limit across model calls. Default: 4. |
| `--resume <directory>` | Revalidate and reuse compatible completed tasks from a prior review. Use a separate output directory. |
| `--context-rounds <0..4>` | Additional reads per planning, analysis or verification. Default: 2. |
| `--context-files <1..50>` | File limit per additional read. Default: 10. |
| `--planning-corrections <0..4>` | Additional calls to correct returned planner proposals that fail host validation. Default: 2. Set 0 to fail immediately. Separate from context reads. |
| `--max-input-bytes <bytes>` | Input budget per model call, at least 1024. Default: 256000. |
| `--max-output-bytes <bytes>` | SDK result budget, at least 1024. Default: 1048576. |
| `--dry-run` | Print inventory and planning budgets without a backend or artifacts. Modules, concrete angles and worker counts remain unknown. |
| `--help`, `--version` | Print usage or the package version without starting a backend. |

Project, config, output and resume arguments resolve from the launching directory.
Scope arguments resolve from the target project. `CODEX_BIN` selects a different
Codex executable. Progress and the artifact path go to stderr; stdout contains
only the selected report, dry-run plan, help or version.

Scope and context options apply to the planner and workers. `--dimension` filters
the angle catalog after planning; an absent ID fails planning instead of silently
omitting work. A worker may inspect another module as context and reject a
proposal that harms another angle, but its primary findings belong to its assigned
module and angle. The former file/flow/package/project levels and readability/all
modes are removed. Resume replans first, then reuses workers only when the current
module/angle plan, inputs, contracts and schema remain compatible.

```sh
bun run review ../another-project --format json --output ./review-report > report.json
bun run review ../another-project --resume ./review-report --output ./review-report-next
```

## Project configuration

All configuration paths are canonical, repository-relative paths. The fields are
optional except `version`:

```json
{
  "version": 1,
  "groups": [{"path": "queries", "name": "reporting-queries"}],
  "contracts": ["specifications/report-contract.adoc"],
  "flows": [{
    "id": "report",
    "purpose": "Read orders and deliver the report",
    "paths": ["service/report.py", "queries/report.sql"],
    "symbols": []
  }]
}
```

Groups add directory ownership boundaries alongside recognized manifest markers.
Unmarked files remain in the root group. A group does not establish dependency
or runtime semantics. Contracts seed every selected task as read-only context,
without increasing primary coverage. Changes to the contract set or its content
invalidate cached task inputs.

Configured flows and directory groups are hints for the planner, including
cross-language collaboration. They do not create worker tasks or override the
planner's source-backed responsibility boundaries. Contracts seed planning and
analysis without increasing primary file coverage.

The optional `writeGroups` field is used only by the explicit `fix` command. Each
entry is an array of related file paths that must share one sequential write group.
Paths may appear in only one group. Without a configured group, findings for the
same file run sequentially and unrelated files may proceed concurrently.

## Review behavior and limits

The first model task reads source and returns modules, responsibility boundaries,
source ownership and an angle catalog. The existing twelve concerns—responsibility,
abstraction, contracts, dependencies, state, concurrency, recovery, resources,
extensibility, performance, observability and readability—are references. The
planner may adapt them or add project-specific concerns; it must account for each
reference as included, adapted or inapplicable, with reasons. Angles are review
questions, not predefined findings.

The host checks exact selected-file coverage, unique ownership, actual source
availability, module evidence and angle IDs before dispatch. Each selected text
file has one primary module; contextual reads may cross boundaries. Only explicit
non-text metadata may be excluded. Missing or unread input is a planning gap.
Planning can request bounded additional source through the same host protocol.
For a schema-valid response that fails host validation, the host collects the
planning and citation errors and returns them with the previous proposal and the
same supplied snapshots. Corrections have their own budget and every replacement
is fully revalidated; invalid evidence is never accepted or silently rewritten.
Additional source reads spend the context budget instead. An explicit incomplete
response, a failed invocation, an unknown outcome or a cleanup failure does not
enter the correction loop. Every call, including correction input with its previous
proposal, remains subject to the input/output byte budgets; overflow fails explicitly.
If the full initial source set does not fit the input budget, the planner receives
catalog/navigation and entry contracts with an explicit unread-file list; nothing
is silently truncated or treated as read.

For M modules and A selected angles the host creates exactly M × A analysis tasks.
Each task has one module and one angle; all calls share the concurrency gate.
Workers receive their module's complete primary sources and contracts and can
request relevant context. Findings use one evidence/verification schema. Candidate
verification uses a fresh session with the same module/angle ownership. A final
summary consolidates verified candidates across pairs without creating new facts.
The three worker-schema probes run after planning and before worker fan-out.

`agent()` creates a fresh native session per call. Bounded context continuation is
an additional call carrying the previous result and snapshots under the same
logical task assignment; call counts are recorded separately from worker counts.
The planner uses at most `1 + context-rounds + planning-corrections` calls.
For N module/angle pairs, the full upper bound is
`4 + (1 + context-rounds) * (1 + 2 * N) + planning-corrections`, including
three worker-schema probes and one summary. Counts remain unknown before planning.
Planning failure prevents worker dispatch. Failed pairs remain coverage gaps;
zero findings can still be a completed review.

Analysis records actual participants, collaboration, state and effects,
invariants and uncertainties. Collaboration forms are open; no fixed pattern
catalog or expected-answer dataset is loaded.

JS/TS has compiler-based navigation. Other text sources, including unknown DSLs,
remain available in full with literal search and exact line/hash evidence. Empty
symbol or call indexes mean unindexed, not absent. Necessary unknown language or
runtime semantics remain explicit gaps. Binary files, submodules and symlinks are
recorded as metadata or unavailable input; source symlinks are never followed.

Review artifacts include `plan.json`, `planning/`, `index.json`, snapshots, call records,
per-task analysis and verification, summaries, `report.json` and `report.md`. Report format version 2 records planner output,
reference-angle decisions and module/angle task ownership. Version 1 reports are
not compatible with the new resume/repair path.
`plan.planning` separates the latest proposed plan, validation errors and attempt
history from the accepted module/angle catalog. Each `planning/<call-id>.json`
retains the complete proposal, its source snapshot IDs and validation result;
`acceptedCallId` identifies the accepted response. Failed planning leaves coverage
unestablished and displays the unaccepted proposal for diagnosis.

During active calls, stderr emits a heartbeat every 15 seconds with finished,
running and queued call counts and elapsed time for each running stage.
`calls/<call-id>.timing.json` records queue, start and end timestamps, monotonic
duration and completed/failed outcome. Duration covers invocation and response
persistence, not a provider-only measurement. A completed invocation may still
produce a proposal rejected by host validation. These records do not infer token
usage, costs or remote cancellation.
The default review/fix artifact roots, legacy review roots and the current output directory
are excluded from discovery and contextual reads. For repeated custom output
locations, use an ignored artifact parent to keep earlier runs outside the target
inventory. The output directory cannot be the project or an ancestor of it.

Review does not execute target code, run tests or apply changes. Model tasks are
instructed to analyze the supplied sources without commands or tools. Coverage
and evidence checks do not establish that the model's design conclusions are
correct. Real-model quality acceptance remains unfinished.

Exit status is `0` for a complete review, `1` for an error or coverage gap, and
`130` for a handled interrupt. Findings and pending risks do not themselves make
the exit status nonzero. An interrupt stops queued calls and releases observation
resources; it does not prove that a remote operation was cancelled.

## Apply readability suggestions

`fix` is a separate, explicit source-editing command. It reads the unified
`report.json` and selects fresh, independently accepted findings classified as
`readability` with the `local_refactor` decision, owned by a completed module
containing exactly one primary file and supported by unambiguous target evidence. Duplicate aliases, stale or
unverified candidates, structural/behavior changes and findings owned by multi-file
modules remain in `skipped` with reasons. This is a local repair selection, not an
automatic implementation of every design finding.

```sh
bun run review ../another-project --dimension D12 --output ./readability-report
bun run review fix ../another-project --report ./readability-report/report.json --dry-run
bun run review fix ../another-project --report ./readability-report/report.json --output ./repair-report
```

The report path resolves from the launching directory and must be supplied;
there is no built-in historical report path. The report must belong to the selected project.
Legacy readability Markdown and display-only Markdown reports are not repair inputs. The command supports `--config`,
`--output`, `--concurrency`, `--model`, `--format`, `--max-output-bytes`, `--dry-run`
and `--help`. Its default artifact root is `<project>/.anureo/fixes/<run>`.

Related source and generated files can be grouped in project configuration:

```json
{
  "version": 1,
  "writeGroups": [["schema/contract.json", "tools/generate.ts", "generated/types.ts"]]
}
```

The host validates regular in-project targets and rejects symlink targets or
parents before starting model work. It records drift from report hashes, then
requires the model to recheck current source and contracts. The host compares
owned-file hashes with reported `changed` / `already_satisfied` / `deferred`
outcomes. A failed task stops later tasks in that write group; uncertain execution
or cleanup stops new model work across groups. Ownership instructions do not
constitute a filesystem sandbox for the model's tools.

The repair host does not run tests, generation or project commands. Model
instructions also prohibit them; changes that require generation or a larger
write scope are deferred. Completion means the suggestions were handled with
recorded static checks, not that tests passed or that the resulting program is
proven correct. `--dry-run` reads the report and eligible target hashes and prints the
plan, including skipped reasons; it starts no backend and edits no source. Repair artifacts include the plan,
per-finding records, results and JSON/Markdown reports.

The workspace aliases `bun run review:readability` and `bun run fix:readability`
call the same review engine with `--dimension D12` and the fix subcommand. The old executables and
their test files have moved out of `examples/` into `packages/code-review`.
