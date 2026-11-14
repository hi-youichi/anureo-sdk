---
name: openspec-update-change
description: Update an OpenSpec change by revising its existing planning artifacts and keeping them coherent with one another. Use when the user wants to revise a change's plan, fold new decisions into it, or reconcile its artifacts after an edit. Also use when the user says "openspec update change" or "opsx update". If the user means the openspec update CLI command, which refreshes generated files, run that command instead. Never edits code.
allowed-tools: Bash(openspec:*)
license: MIT
compatibility: Requires openspec CLI.
metadata:
  author: openspec
  version: "1.0"
  generatedBy: "1.14.3"
---

Revise a change's existing planning artifacts and keep them coherent. Never edit code.

Read [.claude/skills/openspec-authoring-setup.md](../openspec-authoring-setup.md) from the project root for store selection and the project check.

**Input**: Optionally specify a change name. If omitted, check if it can be inferred from conversation context. If vague or ambiguous you MUST prompt for available changes.

This workflow revises existing planning artifacts. Its only new-file case is a confirmed addition to a glob artifact that already has at least one output file.

**Steps**

1. **Select the change**

   If a name is provided, use it. Otherwise:
   - Infer from conversation context if the user mentioned a change
   - Auto-select if only one active change exists
   - If ambiguous, run `openspec list --json` to get available changes sorted by most recently modified, and ask the user to select one

   When prompting, present the top 3-4 most recently modified changes as options, showing:
   - Change name
   - Status (e.g., "0/5 tasks", "complete", "no tasks")
   - How recently it was modified (from `lastModified` field)

   Mark the most recently modified change as "(Recommended)" since it's likely what the user wants to update.

   Always announce: "Using change: <name>" and how to override (e.g., `/opsx:update <other>`).

2. **Get the change's artifacts**
   ```bash
   openspec status --change "<name>" --json
   ```
   Parse the JSON to understand current state. The response includes:
   - `schemaName`: The workflow schema being used (e.g., "spec-driven")
   - `artifacts`: Array of artifacts with their status ("done", "skipped", "ready", "blocked")
   - `isPlanningComplete`: Boolean indicating if all planning artifacts are complete. Older CLI versions expose the same value as `isComplete`.
   - `planningHome`, `changeRoot`, `artifactPaths`, and `actionContext`: path and scope context. Use these instead of assuming repo-local paths.

   Use the active schema's artifact IDs and edit the concrete files listed in `artifactPaths.<id>.existingOutputPaths`. This list is already glob-expanded. For a new file within a partly populated glob artifact, follow step 4 to select the concrete path.

3. **Understand the request**
   - If the user asked for a specific revision ("the design now uses X"), that is the starting edit.
   - If they only said "update" / "make this coherent", treat it as a coherence review: read the existing artifacts and check them against each other for contradictions, gaps, and duplication.
   - If the request changes the change's intent, ask for a distinct unused change name and recommend `openspec new change "<new-change-name>"`.

4. **Read and reconcile**
   - Read the artifact(s) the request touches and the change's other existing artifacts.
   - Draft the requested edit in the conversation, not in files. Work out exactly what it changes; step 5 owns every write. Then check every other existing artifact against the drafted edit - in ANY direction: an edit to a later artifact may require revising an earlier one, not only the other way around. Build order is a useful reading order, not a constraint on which artifacts may be revised.
   - Note everything that is now inconsistent, missing, or contradictory.
   - Propose revisions to existing files. Defer artifacts with empty `existingOutputPaths` and status `ready` or `blocked` to step 6. Leave `skipped` artifacts untouched and exclude them from the deferred list.
   - A glob artifact is marked `done` once one file matches, so the continue workflow will no longer pick it up. If reconciliation identifies a missing file for a glob artifact with non-empty `existingOutputPaths`, prepare it as described below and include it in the proposed revisions.
   - If the change is already coherent, say so and propose no revisions.

   **Prepare a new file for a partially populated glob**

   - Run `openspec instructions "<artifact-id>" --change "<name>" --json`. If it reports `skipped: true`, omit the file. Read current dependency files from disk. If a required non-skipped dependency is missing, stop and ask the user to restore it first.
   - Choose an unused concrete path that matches `artifactPaths.<id>.outputPath`. Verify it remains inside `changeRoot` after resolving symlinked parent directories. The glob `resolvedOutputPath` is a pattern.
   - Draft using `instruction` and `template`. Apply `context` and `rules` as constraints and keep them out of the draft.

5. **Confirm and apply, one artifact at a time**
   - Show each proposed revision and why, including the requested edit and any new file. Write only confirmed revisions. Leave rejected revisions unapplied.
   - Complete the linked project check before the first write. For a substantial rewrite, get that artifact's rules and template with `openspec instructions "<artifact-id>" --change "<name>" --json` before writing.
   - For an approved new file, refresh status and instructions immediately before creation. Verify the artifact is still in scope, unskipped, and partially populated. Repeat the concrete-path checks from step 4.
   - Create the new file with an operation that fails if the target already exists. If `instruction` delegates creation, invoke the skill or command only if it can preserve the approved path and these checks. If any check fails, delegation cannot meet the constraints, or the approved draft no longer applies, stop and reconcile with the user. Keep any existing content and the approved target path intact.

6. **Point to the next step (guidance only - NEVER act on it)**
   - Artifacts with empty `existingOutputPaths` and status `ready` or `blocked` -> run `openspec status --change "<name>" --json` for the next artifact and point the user to `openspec instructions "<artifact-id>" --change "<name>" --json` for how to create it.
   - If the revised plan implies code changes, suggest `/opsx:apply` and stop after planning.
   - If you revised an already implemented change (tasks checked off or already applied), explain that code may no longer match the plan and suggest `/opsx:apply` to carry the delta into code.
   - Everything done and implemented -> suggest `/opsx:archive`.

**Output**

After each invocation, show:
- Which artifacts were revised (and which proposed revisions were rejected)
- Any file created under a glob artifact that was already partially populated
- Anything deferred because it does not exist yet (artifacts with no files and status `ready` or `blocked`, never `skipped` artifacts)
- Where the change stands and the recommended next command
