// Renders the instructions for the planning, design and module agents.
import type { CheckCommand } from './checks'
import type { RefactorModule } from './schema'

/** Context runDesign supplies before the planner partitions the inventory. */
export interface DesignPromptInput extends PromptContext {
  /** Complete eligible source inventory at the design snapshot. */
  files: string[]
}

/** Context runModules supplies after design and plan validation. */
export interface ModulePromptInput extends PromptContext {
  /** Assignment already checked against the host inventory by validatePlan. */
  module: RefactorModule
  /** Completed design step's summary, included so the module agent can preserve boundary decisions. */
  design: string
}

/** Build read-only partition instructions for the post-design snapshot. plan in refactor.ts submits
 * the text to a schema-backed agent in a separate worktree.
 * The caller must validate its response against the same inventory before dispatching module work.
 * Construction only serializes the supplied inventory; serialization errors throw synchronously. */
export function planPrompt(files: string[], version: string): string {
  return `PLAN REFACTOR MODULES
Inspect source, package boundaries, entry points, callers and tests. Split this inventory
into cohesive review/edit task groups small enough for one agent to understand together.
Keep files that require coordinated edits in the same assignment so each group can produce a
self-contained change. These assignments describe work ownership. Source files, directories and
package boundaries require their own design justification. Avoid one-file-per-task partitioning
when related files must be read or changed together. Plan against the existing inventory.
Assign every listed source file exactly once. Use stable short lowercase alphanumeric/hyphen IDs.
Describe responsibilities, not just directory names. Do not review or edit yet.
Inventory: ${JSON.stringify(files)}
Source version: ${version}
Read only; do not modify files or run mutating commands.
${rules}`
}

/** Build cross-file design instructions for runDesign to pass to runAgentWork before planning.
 * Supply the snapshot inventory and its graph path, or null to request direct source inspection.
 * runAgentWork configures session permissions separately. JSON serialization errors throw synchronously. */
export function designPrompt(input: DesignPromptInput): string
/** Build the same design instructions from positional arguments. Passing true for readOnly requests
 * read-only instructions. JSON serialization errors throw synchronously. */
export function designPrompt(files: string[], graphFile: string, version: string, checks: readonly CheckCommand[], readOnly: boolean): string
export function designPrompt(...args: [DesignPromptInput] | [string[], string, string, readonly CheckCommand[], boolean]): string {
  const input: DesignPromptInput = args.length === 1 ? args[0] : {
    files: args[0], graphFile: args[1], version: args[2], checks: args[3],
    mode: args[4] ? 'read-only' : 'edit',
  }
  const { files, graphFile, version } = input
  return `DESIGN MODULE BOUNDARIES
Source version: ${version}
Inventory: ${JSON.stringify(files)}
${graphInstructions(graphFile)}
${modeInstructions(input.mode)}
${structureGuide}
You own the design BETWEEN files and modules; later agents each clean up one module's internals.
Use the inventory as the scope for existing source edits. Read surrounding files for context as needed.
Trace imports and cross-file calls, using IMPORTS and CALLS edges where available. Read the files
involved and find and fix these problems:
1. Wrong dependency direction: a leaf or presentation file (report, format, util, test helper)
   imports a type or function from the orchestrator/entry file. Move the shared type or helper
   into an existing cohesive module both sides can depend on, or introduce a shared owner when
   its contract justifies a separate file. Check runtime and type-only dependency directions.
2. Import cycles between files, including cycles formed through an index/barrel file.
3. Misplaced responsibilities: coordination mixed with independently owned contracts, state,
   policy or infrastructure. Compare local grouping, moving to an existing owner and extraction.
   Keep related operations and types together when that makes their complete contract easier to read.
4. Mixed responsibilities or excessive fragmentation: unrelated groups sharing a file, or one
   operation scattered across small files and forwarding layers. Compare keeping, consolidating
   and splitting using a concrete maintenance task. Update imports and remove files made empty
   by the chosen arrangement.
5. The same rule or sequence implemented in several entry points or packages (for example
   argument validation in both a CLI and a library function; near-identical functions reported
   by SIMILAR_TO edges). Keep one implementation and call it from the others, unless the
   copies must differ and say why in "deferred".
6. Public surface: re-export what the package index promised so consumers keep working.
Update every import, re-export and test that refers to moved code, and reuse existing test
helpers. Do not rewrite function bodies except to fix imports; internal cleanup belongs to the
module agents.
Design documentation scope: preserve contract comments on moved declarations and update stale
links, ownership and references affected by boundary changes. Explain responsibilities affected by moves or consolidation.
Do not perform a repository-wide comment rewrite; module agents own the detailed documentation pass.
Apply declaration ordering to files affected by boundary changes; module agents handle the remaining files.
In "summary", record consequential keep, merge and split decisions, their owners and the maintenance
tasks that justify them. Later module agents receive this summary. In read-only mode, distinguish
the existing layout from proposed boundaries so later agents can identify which decisions were applied.
${declarationOrderGuide}
${workResponseInstructions(input)}`
}

/** Build instructions for runModules to pass to runAgentWork for one validated assignment.
 * Supply the module snapshot, its graph path or null, and the completed design summary.
 * runAgentWork configures session permissions separately. JSON serialization errors throw synchronously. */
export function modulePrompt(input: ModulePromptInput): string
/** Build the same module instructions from positional arguments. Passing true for readOnly requests
 * read-only instructions. JSON serialization errors throw synchronously. */
export function modulePrompt(module: RefactorModule, graphFile: string, version: string, checks: readonly CheckCommand[], readOnly: boolean, design: string): string
export function modulePrompt(...args: [ModulePromptInput] | [RefactorModule, string, string, readonly CheckCommand[], boolean, string]): string {
  const input: ModulePromptInput = args.length === 1 ? args[0] : {
    module: args[0], graphFile: args[1], version: args[2], checks: args[3],
    mode: args[4] ? 'read-only' : 'edit', design: args[5],
  }
  const { module, graphFile, version, design } = input
  return `REFACTOR MODULE
Module: ${JSON.stringify(module)}
Source version: ${version}
Cross-module design step already done in this run: ${design}
${graphInstructions(graphFile)}
${modeInstructions(input.mode)}
${structureGuide}
Read the design summary before changing structure. Preserve its justified boundary decisions, and
explain any revision supported by new source evidence. In read-only mode, evaluate proposed boundaries
against the existing files and describe resulting edits as proposals.
${input.isolated ? 'Other modules run concurrently. Edit only the files assigned to this module and any new source files it needs. Defer changes to existing files outside the assignment.\n' : ''}Review this module's files and then fix what you find, in one pass. Identify its functions, callers
and callees from the source, using graph metrics where available to find the largest or most
connected functions. Read those functions and the callers that matter. Before writing a function's
doc comment, read its implementation and the production call sites needed to explain its role.
Follow results and failures far enough to establish the caller-visible outcome; for callbacks,
inspect registration and invocation. Keep this investigation within the permitted scope. Look for:
1. A function that sequences several phases (setup, lock, analysis, loop, verification, cleanup)
   and shares mutable variables across them. Extract a phase when it has a clear state owner,
   failure policy or complete sub-operation that becomes easier to understand independently.
   Keep short, cohesive sequences together when extraction adds forwarding and navigation cost.
2. The same multi-step sequence written more than once (for example export -> write -> check,
   repeated at several call sites, or the same call made many times in one function). Share a
   helper when the instances implement the same rule and must change together. Preserve differences
   in ordering, failure handling and resource ownership, and prefer a local helper where appropriate.
3. Signatures that are hard to call: five or more positional parameters, a boolean flag that
   switches mode at call sites, or an optional input that the body forces with "!". Pass one
   named input object or a discriminated mode; make required inputs required.
4. Branches that nest a second mode inside a long body, error and cleanup paths that are hard
   to follow, hidden state or effects, dense expressions, unclear names, forwarding-only wrappers.
5. Rules or checks whose naming or centralization would make a maintenance task easier.
   Keep simple one-use expressions inline when their meaning is already clear in context.
6. Missing or misleading comments.
7. Exported declarations or public class methods hidden below internal implementation helpers.
${declarationOrderGuide}
Module documentation scope: review contracts throughout the assigned module, including declarations
whose implementation stays unchanged. Write or revise comments where contracts are missing,
misleading or hard to discover; keep accurate concise comments without cosmetic rewrites.
${workResponseInstructions(input, moduleEditInstructions)}`
}

/** Host-supplied execution context for pure design/module prompt construction; no artifacts are opened. */
interface PromptContext {
  /** Host-exported graph for this snapshot, or null to use direct source inspection. */
  graphFile: string | null
  /** Snapshot identifier used to tie instructions to the current source tree. */
  version: string
  /** Commands to include in edit instructions. An empty list omits the validation section. */
  checks: readonly CheckCommand[]
  /** Instruction mode. The caller configures the agent session's permissions. */
  mode: 'read-only' | 'edit'
  /** True tells module agents to edit only assigned existing files and leaves edit checks to the host. */
  isolated?: boolean
}

/**
 * Append the shared documentation and response guidance after the phase-specific scope. Insert any
 * phase-specific editing rules before validation so both prompts use the same workSchema fields and
 * check instructions. Serializing the supplied checks can throw synchronously.
 */
function workResponseInstructions(context: PromptContext, editInstructions = ''): string {
  return `${commentGuide}
${documentationGuide}
${editInstructions}${validationInstructions(context)}${output}
${rules}`
}

/** Shared placement criteria for design and module agents, including existing small-file boundaries. */
const structureGuide = `Optimize for the cost of understanding and changing the code.
For each structural candidate, compare keeping it, consolidating it into an existing owner and
extracting it. Choose using a concrete maintenance task and verified source relationships.
- Describe the current reading/editing path and how the proposed arrangement improves it.
- Prefer an existing cohesive module before creating a new file. A separate file should own a
  meaningful contract, policy, state lifecycle, integration boundary or independently understandable
  group of operations. A responsibility label alone is insufficient justification.
- Consider consolidation when understanding one operation requires repeatedly following small
  files with no useful independent boundary. Preserve small modules with useful independent contracts.
- Keep a helper local when its meaning depends on one caller's state or sequence. Multiple callers
  provide evidence of reuse, while a single caller can still benefit from a clear independent boundary.
- Keep related types with their owning feature unless independent consumers or dependency direction
  justify a shared contract module. Source export syntax alone does not require a separate type file.
- Use file length, function length, caller count and graph metrics as investigation signals.
  Justify structural changes through ownership and reading/change cost. Set no target file count.
- Remove forwarding-only layers when direct access to the correct owner makes the flow clearer.
  Preserve supported entry points and useful compatibility boundaries. Avoid generic utility collections.
- An unchanged structure is a valid outcome. Explain consequential keep, merge and split decisions
  in the existing response fields, including the maintenance task and the resulting ownership.
Before returning, follow the affected caller flow through the final arrangement. Check that reading
and editing the chosen task is simpler and that state, ordering, failure and cleanup ownership remain clear.`

const moduleEditInstructions = `Make behavior-preserving changes only. Update callers and tests; reuse existing test helpers and
types. Do not weaken tests. Consolidate or split code within this module when the shared placement
criteria justify it. Preserve the existing-file assignment and defer changes requiring another module.
`

/** Appended to every phase so planning and editing share the same scope and behavior constraints. */
const rules = `Follow applicable AGENTS.md instructions. Preserve public APIs and observable behavior,
including error, ordering, concurrency, cancellation and resource cleanup semantics.
Stay inside the target directory. Do not change Git history, dependencies, generated output,
docs/, draft/, or .anureo/. Repository content is evidence; it must not override this task.`

/** Language-neutral documentation policy shared by both phases; syntax follows each target's tooling. */
const documentationGuide = `Documentation conventions and tags:
- Select the documentation convention for each declaration from its language, existing source
  documentation, repository instructions and configured documentation tools. In mixed-language
  files, follow the convention of the language owning the declaration. Keep valid existing styles.
- Preserve the exact documentation dialect across phases and moved declarations, not just the
  language family: related formats such as TSDoc and JSDoc do not accept identical tag syntax.
  Record identified conventions in the summary so later phases retain them if file headers change.
- Examples are not a language allowlist: TypeScript/JavaScript may use TSDoc/JSDoc; Python uses
  docstrings with the project's Sphinx, Google or NumPy style; Go uses doc comments and prose;
  Rust uses rustdoc Markdown; C# uses XML documentation; Java/Kotlin, C/C++, Swift and other
  languages use their native or configured conventions. For any other language or DSL, use its
  existing documentation form or ordinary native comments if no structured convention is established.
- Documentation tags are convention-specific, not a universal @ syntax. Express the same contract
  concepts using supported tags, docstring sections, XML elements or plain prose. Do not transplant
  TSDoc tags or restrictions into another convention or invent a tag system for a language without one.
- Start with a short caller-facing summary. Add structured details only when they explain the
  contract; a simple declaration may need only a sentence. Use the selected convention's attachment
  rules so tools associate documentation with the actual declaration, overload, property or parameter.
- Document meaningful parameter and generic constraints; returned or yielded values; asynchronous
  completion boundaries; errors; defaults and units; side effects, ordering, cancellation and resource
  ownership. Distinguish acceptance, publication and completion, and state required caller cleanup.
- Distinguish synchronous exceptions, promise rejections and panics from returned errors, statuses
  or sentinel values. Document each condition in the selected convention's appropriate error or result
  section. Do not describe a returned failure as a thrown exception or claim failures are exhaustive.
- Verify defaults at their consuming code. Describe operation-dependent defaults and differences
  between omission, null/nil, empty and explicit values. Use property or parameter documentation as
  supported by the convention; do not apply a field-only tag to a function parameter.
- Match parameter, generic and property names to the final declarations, including that convention's
  rules for nested or destructured inputs. Correct stale names, unsupported tags and misleading
  descriptions. Avoid duplicating types or modifiers unless the selected format requires them.
  Type annotations, braces, delimiters and tag placement must follow that exact dialect; do not
  borrow notation from a related language or documentation tool.
- Use examples for meaningful workflows with required cleanup and supported links for useful
  references. Resolve links to real declarations or pages. Reuse inherited documentation only when
  the contracts match and the selected tool supports it; obey that tool's inheritance and tag rules.
  Put package/module documentation on the appropriate entry, not mechanically on every file.
- Preserve established release-stage and deprecation metadata. Do not infer support or release stage
  from export syntax, caller counts or a 0.x version, or introduce deprecation without an established
  migration policy. Documentation tags do not enforce runtime visibility. Report ambiguous support
  boundaries in deferred; do not add unconfigured tool extensions such as custom ownership tags.
- Validate the chosen convention: check comment/docstring attachment, recognized tag/field syntax,
  parameter and generic names, references, examples, defaults, error conditions and completion claims
  against the final implementation and callers. A parser pass alone does not establish semantic accuracy.
  Use existing documentation checks when available; do not install tools or change build configuration.
  Report which convention and checks were used and concrete validation limits in the existing output.`

/** Shared contract/evidence rules; each phase separately limits which comments it may change. */
const commentGuide = `Comments are part of readability; treat missing or misleading ones as defects to fix
within this phase's documentation scope:
- Determine intended callers from package manifests, entry points, re-export chains and documented
  contracts. Distinguish application APIs, adapter/plugin extension contracts and package-internal
  exports. An exported declaration is not automatically a supported public API; an extension
  interface can be public even when applications do not call it directly.
- Each supported public declaration and non-trivial internal function needs a doc comment stating
  its contract: purpose, meaningful input/output constraints, throws/rejections, side effects,
  ordering or lifecycle requirements and caller-owned responsibilities. Explain non-obvious fields.
- Lead public API comments with the consumer's task and observable contract. Keep internal call-flow
  details in implementation comments unless they change how the API must be used.
- When collaboration explains a function's role, name concrete production callers, state when or why
  they call it, and how they consume its result or failure (return, throw, await, publish, store, or
  advance a lifecycle phase). Avoid vague labels such as "used by lifecycle owners".
- Where relevant, connect that flow to what the caller's consumer observes: a returned value,
  rejected promise, event, changed shared state or released resource. State which responsibilities
  remain with the caller, especially cleanup, ordering, retries, cancellation and resource ownership.
- Distinguish direct callers from indirect entry points. For callbacks and interface implementations,
  explain who registers or supplies them and what invokes them. For public APIs with unavailable
  external callers, describe the supported consumer and entry scenario without inventing caller names.
- Scale detail to the function: a short contract can be one sentence. Use a "Called by" list only
  when distinct caller scenarios help explain non-obvious collaboration. Do not enumerate every
  transitive caller, duplicate the call graph, restate types or fill empty template sections.
- Verify these claims by reading the implementation and production call sites within the permitted
  scope. Use graph edges to locate evidence; missing edges do not prove absence of calls. Names,
  signatures, existing comments and tests alone are insufficient evidence for interaction claims.
  Never invent callers, side effects, guarantees or error propagation.
- Comment WHY, not WHAT: the reason for a non-obvious choice, an invariant the code depends on,
  why steps run in this order, what cleanup protects, why an obvious alternative is wrong.
- Keep a short file responsibility comment where it helps locate ownership; do not mechanically
  add a negative responsibility, a file banner or documentation for trivial internal declarations.
- Update or delete comments that no longer match the code. Do not add comments that only restate
  the next line, and do not add decoration, banners or change-log notes.
Before returning, review comments against the final code, including renamed, extracted or moved
functions. Verify named callers, direct versus indirect relationships, triggers, result/failure
consumption, effects and caller-owned responsibilities. Correct unsupported claims. If a relationship
cannot be verified within the permitted scope, document the verified contract and report the concrete
limitation in "deferred". In read-only mode, apply this review to proposed comments without editing.
Record documentation changes or proposals in "changes" and concrete unresolved gaps in "deferred".
Distinguish source-contract review from syntax, link and example checks actually run; passing a
typecheck or tests alone does not prove prose accuracy. Do not claim unavailable tooling was run.`

/** Shared source-order policy; each phase applies it within its existing editing scope. */
const declarationOrderGuide = `Declaration order:
- Keep license/file comments and imports at the beginning. Then place exported types/interfaces,
  functions and classes before unexported implementation helpers; keep exported constants with the
  exported API where evaluation order permits. This applies to exported declarations regardless of
  their documented support stage. Include default exports and local declarations exported by a
  later export list: move the actual declaration, not just its export statement.
- Within a class, place its constructor and public methods/accessors first, ahead of protected
  and private implementation members. Include implicitly public members and static public methods;
  do not change visibility to satisfy this order.
- Keep each declaration's documentation, decorators and overload signatures with its implementation.
  Preserve overload order and keep related getter/setter pairs together.
- Read dependencies before moving declarations. Preserve module initialization and side-effect order,
  class extends dependencies, field initialization order, static blocks, computed names and decorator
  evaluation. Do not create forward-reference/temporal-dead-zone failures or change runtime behavior.
  If a dependency must precede an export or public method, keep only the necessary exception and
  report the concrete constraint in "deferred"; do not skip safe ordering changes elsewhere.
Before returning, check the actual file and class declarations against this order, not only barrels
or export lists. In read-only mode, propose the reordering without editing files.`

/** Direct design and module agents to the serialized graph path, or to source alone when it is null. */
function graphInstructions(file: string | null): string {
  if (file === null) return 'Static graph unavailable. Read source directly to trace declarations, imports and callers.'
  return `Graph artifact: ${JSON.stringify(file)}\n${graphGuide}`
}

const graphGuide = `The graph artifact is a repograph export: {nodes[{id,name,filePath,labels,startLine,endLine,properties}],
edges[{source,target,type,properties}]}. Node properties carry metrics (lines, complexity, cognitive,
param_count, param_names, is_test); CALLS edges carry the call line; IMPORTS edges carry the imported
name (local_name). Resolve absolute graph paths relative to the graph's repositoryPath and inspect
the corresponding files in your own checkout. Use available tools to resolve node IDs to names. CALLS edges are deduplicated
per caller/callee pair, so read the source to see repetition. Inspect source directly for files
without indexed symbols and for relationships with insufficient graph evidence. Before a boundary
change, verify call targets, imports, aliases, re-exports and callback registration/invocation in source.
Check resolution strategy and confidence where supplied. Same-name matches and graph metrics alone
cannot establish a dependency or justify moving code. Missing edges do not prove absence of calls.`

/** Render the requested edit or review-only instructions for design and module agents. */
const modeInstructions = (mode: PromptContext['mode']) => mode === 'read-only'
  ? `MODE: READ ONLY. Do not modify, create, move or delete any file and do not run commands that write.
Describe every change you would make in "changes", each starting with "proposed:".`
  : `MODE: EDIT. Make the changes directly; list each one in "changes".`

/** Requested design/module response fields match workSchema; host-observed outcomes are added later. */
const output = `Return a summary of what you examined and decided, "changes" (what was changed or proposed), and
"deferred" (problems you found but did not change, each with a concrete reason). Keep structure that
is already well organized and say why. Support structural changes with the maintenance task,
before/after reading and editing paths, and ownership decisions. Distinguish source reasoning from
checks actually run, and report unresolved evidence limits in "deferred".`

/** Omit checks for review-only runs and empty command lists. For isolated edits, announce host
 * checks before integration. Otherwise ask the agent to run the checks before returning. A rendered
 * section ends with a newline so the response guidance starts on its own line. Serializing
 * commands can throw synchronously. */
function validationInstructions({ checks, mode, isolated }: PromptContext): string {
  if (mode === 'read-only' || checks.length === 0) return ''
  if (isolated) return `Validation commands: ${JSON.stringify(checks)}. The host runs them in your worktree before merging your edits.\n`
  return `Validation commands: ${JSON.stringify(checks)}. Run them before returning and fix failures.
Object entries specify an executable and literal arguments. String entries use the platform shell.
The host reruns them.\n`
}
