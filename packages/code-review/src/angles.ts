export interface ReviewAngle {
  id: string
  title: string
  instructions: string
}

export const correctnessAngle: ReviewAngle = {
  id: 'correctness',
  title: 'Correctness',
  instructions: `Goal: find concrete incorrect behavior, broken contracts, reachable
edge cases, races, and resource lifecycle failures.

Investigation:
Trace an actual entry point through its callers, dependencies, state mutations,
outputs, and tests. Inspect the dependency implementation or declared contract
when behavior depends on return values, cancellation, error propagation, or replay.
Compare equivalent paths across commands, backends, and library versus CLI entry
points. Follow failure paths as carefully as successful execution.

Checks:
- State and concurrency: inspect mutations before and after each await, admission
  and dispatch ordering, shared stop flags, partial effects, deterministic output
  where required, and cleanup after failure or cancellation. A sibling's failure
  must not be mistaken for this task's execution outcome.
- Error propagation: trace null results, rejected tasks, empty catches, and broad
  fallback handlers. Check that causes survive aggregation, systemic failures stop
  unsafe or futile dispatch, and programming errors are not treated as correctable
  user or model input. Trace error codes, retryability, fatality, and outcome
  certainty through wrappers, persisted records, reports, and consumers; retaining
  a message alone may discard information needed for a correct decision.
  Check existing retry and partial-success contracts.
- Trust boundaries: follow external data through parsing, authorization, and
  rendering. Type assertions and prompt instructions do not enforce a contract.
  Check actual read/write scope controls, context-sensitive output encoding, and
  whether validators establish their advertised guarantees. An incomplete index
  cannot prove a real symbol absent; a substring match alone may not establish an
  exact source location. Check consistent path and LF/CRLF handling end to end.
  Compare granted tools and readable/writable resources with the task's needs and
  stated restrictions. Check whether claimed restrictions are enforceable and
  violations observable; audit records do not replace access control.
- Completion and reporting: follow required fields, coverage gaps, skipped work,
  and errors into summaries, status, exit codes, and user-visible reports. Check
  for information discarded while success is still claimed. Separate host facts,
  model assertions, confirmed effects, and unknown execution outcomes.
- Capacity and time: inspect the entire encoded input, auxiliary metadata, final
  aggregation, subprocess buffers, and fallback payloads against actual limits.
  Check known constraints before expensive dispatch. Distinguish an operation or
  observation timeout from a deadline that actually bounds external execution.
- Recovery and side effects: trace both writers and restart readers. Check cache
  misses versus corruption, stale dependencies, repeatability, and attribution of
  observed changes. Inspect whether generated artifacts can enter normal source
  discovery or version control under the tool's default behavior.

Findings:
Explain the reachable preconditions, causal code path, actual versus expected
behavior, violated invariant, and impact. A complete static trace is sufficient;
do not claim a reproduction, incident, or measured cost that was not observed.
Do not report style preferences, unsupported risks, or feature requests. Return
no findings when the inspected paths support no correctness defect.`,
}

export const codeQualityAngle: ReviewAngle = {
  id: 'code-quality',
  title: 'Code Quality',
  instructions: `Goal: find concrete obstacles to understanding and safely changing
the implementation. Demonstrated reading or editing costs are valid findings even
without a runtime bug; use the maintenance task as the triggering scenario.

Investigation:
Read complete functions, relevant callers, sibling implementations, tests, and
public usage documentation. Choose a task such as changing a default, understanding
a failure, adding a result state, or locating a reported artifact. Follow the
actual reading path and identify what must be remembered or edited together.

Checks:
- Expression: dense multi-statement lines, unnamed compound conditions, positional
  booleans, deep nesting, and large closures that obscure distinct steps or failure
  decisions. Explain the hidden meaning, not just a line count.
- Intent and terminology: inconsistent names for the same concept, one name for
  different concepts, outdated public wording, misleading optional access, and
  missing explanations of invariants, status transitions, compatibility choices,
  timeout relationships, preconditions, return semantics, or thrown errors.
- Rules and constants: compare path checks, defaults, budget formulas, version
  markers, error classification, and serialization helpers across all relevant
  entry points. Identify shared semantics, actual divergence, and the places a
  change must update. Check unexplained magic values and repeated normalization.
- Local data flow: hidden mutation inside map/filter callbacks, successive field
  overwrites, non-null assertions whose justification is distant, and public
  inferred types that force consumers to inspect an implementation. Explain the
  specific reasoning burden rather than banning a language construct.
- Redundancy: repeated validation of already established facts, unused fields or
  exports, write-only data, constant placeholders, no-op catches/rethrows, and
  repeated conversion of immutable schemas. Search production, generated, public,
  and compatibility uses before declaring code dead; test-only use is a clue.
- Test feedback: inspect whether pure rules can only be exercised through a full
  process, fixtures omit relevant failure/state combinations, message assertions
  couple tests to wording, or real sleeps make ordering assumptions. Identify the
  behavior a missing or weak assertion would fail to distinguish; do not infer a
  production bug merely from missing coverage.
- Automated safeguards: when concrete recurring formatting, complexity, import,
  or unused-code problems are demonstrated, inspect whether maintained local and
  CI checks detect them. Explain the recurrence and prevention gap before proposing
  a guardrail; an absent tool or a preferred tool choice alone is not a defect.
- Validation feedback: inspect whether independent input or response issues can
  be reported together instead of consuming one correction round per issue. Check
  field locations, actual versus expected values, and useful repair guidance.
  Respect checks that depend on earlier parsing or must stop for safety.
- User-facing clarity and engineering claims: compare help, defaults, dry-run
  estimates, scripts, package exports, runtime declarations, and emitted artifacts
  with their implementations. Check actionable errors, failure-time artifact
  locations, consistent naming/language, and reports organized for decisions rather
  than raw internal records. Passing on one runtime does not prove full support.
- Published usability: follow the declared package entry points, executable paths,
  included files, and documentation from a consumer's installed-package context.
  Check that necessary usage guidance and referenced resources are shipped or
  discoverable, rather than available only in the repository. Judge build scripts
  against the declared source or compiled distribution strategy; do not require
  transpilation or a particular documentation filename without a consumer need.

Findings:
Explain the maintenance task, exact obstacle and affected locations, resulting
cost, and smallest behavior-preserving improvement. Describe how the proposed
change reduces tracing, edit locations, or ambiguity. Share code only when its
semantics and reasons to change match; similar syntax alone is insufficient.
Missing comments, formatting tools, JSDoc, or a preferred style are not standalone
defects. Do not prescribe abstractions just to shorten code or tests that mirror
implementation. Focus on local clarity and consistency; structural ownership
changes belong to design, and concrete behavior failures belong to correctness.
Return no findings when the actual maintenance tasks are already clear.`,
}

export const designAngle: ReviewAngle = {
  id: 'design',
  title: 'Design',
  instructions: `Goal: find structural problems in responsibility, contract, state,
and dependency ownership. Concrete maintenance or change-propagation costs are
valid findings without a runtime bug. Use a supported change scenario rather than
an invented future requirement.

Investigation:
Map a real operation from entry point through application coordination, domain
decisions, state/effects, external adapters, persistence, and result consumers.
Identify participants, authoritative rules, and state owners before recommending
boundaries. Inspect callers and sibling flows across modules as context; do not
infer missing collaboration from a directory listing or an incomplete index.

Checks:
- Responsibilities and dependencies: look for orchestration, model interaction,
  validation, domain decisions, I/O, prompts, and rendering changing for unrelated
  reasons inside one owner. Check misplaced shared helpers, infrastructure that
  knows presentation policy, configuration/dependencies/control callbacks mixed
  together, and CLI-specific restrictions embedded in general library primitives.
  Distinguish source dependency direction from the runtime call direction.
- Contracts and domain rules: trace each producer to its consumers. Check parallel
  schema/type definitions, copied upstream policies, and domain invariants spread
  across validators, aggregators, and repair code. Identify who should own the
  rule, its versioning, and the consumer-specific subset or projection.
- State and lifecycle: check representable contradictory states, redundant fields
  encoding the same fact, bag objects accumulating unrelated lifecycle data, and
  shared closures acting as an implicit stateful object. Distinguish immutable
  configuration/plans from mutable progress, task outcomes, and global control.
- Failure policy: distinguish expected branches, correctable responses, programming
  errors, local failures, systemic failures, and unknown outcomes. Check whether
  failure scope matches its cause, partial work survives, and concurrent results
  carry their own causes instead of relying on side-channel variables. Follow
  structured error metadata across layer boundaries and persisted projections;
  identify the consumer that needs codes, retryability, fatality, or outcome
  certainty. Check whether correction protocols collect independent validation
  issues and preserve actionable diagnostics within their correction budget.
- Trust and normalization: establish the owner of boundary parsing, permissions,
  evidence validation, output encoding, and text/path normalization. Check redundant
  defensive validation without a trusted representation or a clear guarantee.
  Preserve necessary integrity and freshness checks when data crosses a new
  boundary or can change; do not simply remove all repeated checks.
  Compare necessary capabilities with granted tools and resource access. Identify
  who enforces restrictions and who records violations or verifies claimed checks;
  least privilege, enforcement, and auditability are separate responsibilities.
- Persistence and identity: follow both writes and actual restart loads. Separate
  authoritative records from reports and diagnostic projections. Check duplicate
  full payloads, ambiguous copies, competing locks/fingerprints, and whether cache
  keys identify immutable content or incidental reads. Account for repeated reads
  and resumes, not only one successful execution.
- Recovery: distinguish cache miss, missing material, integrity mismatch, stale
  dependencies, and uncertain side effects. Check whether defaults match the
  operation's repeatability and whether one stale item unnecessarily invalidates
  unrelated work. Explain when re-execution is safe rather than prescribing it.
  Trace which source, configuration, prompt, schema, model, and backend changes
  invalidate saved results under the declared reuse contract. Distinguish storage
  format versions from behavior revisions, and identify the coverage of each
  fingerprint. Check both accidental stale reuse and unnecessary invalidation;
  do not reject intentionally compatible reuse solely because a version changed.
- Capacity and resources: account separately for primary input, auxiliary indexes,
  encoding overhead, retries, stored copies, and final aggregation. Check that
  scope limits expensive preparation, fixed-size calls have a feasible batching
  strategy, and degradation paths themselves fit the limits. Identify the actual
  growth variable and bottleneck; do not invent thresholds or measured costs.
  Check ownership of execution deadlines, cancellation, and resource release.
- Protocols and observability: trace every required field to a consumer, including
  gaps and partial results. Check completion semantics and whether progress shows
  work remaining rather than an incidental queue. For model protocols, inspect
  remaining budgets, predictable dependency context, actionable correction
  feedback, short references, and unnecessary nested encoding. Keep deterministic
  identity resolution and verification with the host where appropriate.
- Testability: inspect whether pure decisions can be tested without infrastructure
  and whether external services, environment, clocks, and identifiers are explicit
  and controllable where needed. Connect a boundary change to a concrete test or
  maintenance scenario; dependency injection is not an end in itself.

Findings:
Name the current owners and collaboration, the affected consumer or supported
change scenario, the invariant or propagation cost, and a focused alternative.
Compare local simplification with introducing a new boundary, including added
indirection, compatibility, and the guarantee that must be preserved.
Do not infer defects from missing classes, interfaces, patterns, layers, or folder
names. Preserve sound existing designs; do not fill a quota or demand broad rewrites.
Keep expression issues in code quality and runtime defects in correctness. Report
a related structural cause here only when it warrants a distinct design change.
Return no findings when there is no supported structural improvement.`,
}

export const defaultAngles: readonly ReviewAngle[] = [correctnessAngle, codeQualityAngle, designAngle]
