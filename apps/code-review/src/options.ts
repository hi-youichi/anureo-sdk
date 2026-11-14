// Caller configuration and shared preflight policy for the library and CLI.
import type { Client } from '@anureo/sdk'
import { defaultAngles, type ReviewAngle } from './angles'
import type { ReviewProgress } from './progress'

/** Internal default shared by library preflight and CLI flag parsing for review and fix capacity. */
export const DEFAULT_REVIEW_CONCURRENCY = 8

/** Configure reviewCode with a borrowed initialized client. The caller disposes the client after
 * completion; reviewCode owns per-agent sessions, durable workflow records and temporary worktrees. */
export interface ReviewOptions {
  /** Initialized client borrowed for the run; await completion or rejection before disposing it. */
  client: Client
  /** Existing source directory, resolved from the process working directory and canonicalized. */
  cwd: string
  /** Model override for analysis, reviews and fixes; omission leaves selection to the client. */
  model?: string
  /** Additional instructions appended to module analysis and review/verification prompts. */
  focus?: string
  /** Angles in result order; defaults to correctness, code quality and design. Requires a nonempty
   * list with unique nonblank IDs (at most 256 UTF-8 bytes) and nonblank titles/instructions. Copied at preflight. */
  angles?: readonly ReviewAngle[]
  /** Review only these exact IDs from the analyzed plan; omission selects all. Supplied lists must
   * be nonempty and contain unique nonblank IDs of at most 256 UTF-8 bytes. Unknown IDs reject after analysis. */
  moduleIds?: readonly string[]
  /** Positive safe integer limiting selected modules in plan order; omission leaves them unlimited. */
  maxModules?: number
  /** Fix each module's findings as soon as its review completes, then re-review
   * the selected scope if any fix was applied, after all fixes settle. Defaults to false.
   * Requires a usable Git work tree. Each agent receives a separate temporary checkout.
   * Validated fixes are applied to the original work tree and remain if a later step fails. */
  fix?: boolean
  /** Harness-specific session permission mode for fix edits and checks; omission uses the session default. */
  fixPermissionMode?: string
  /** Positive safe integer limiting simultaneous review and fix agents across modules; defaults to 8. */
  concurrency?: number
  /** Durable run storage, retained after completion. Defaults to <canonical cwd>/.anureo/workflows;
   * an explicit relative path resolves from the process working directory. */
  workflowDirectory?: string
  /** Synchronously observe lifecycle events. Return values are ignored, so asynchronous work is not
   * awaited. Synchronous exceptions are collected in the returned report's progressErrors. */
  onProgress?: (event: ReviewProgress) => void
}

/** Internal preflight used by prepareReview before resolving paths or opening sessions.
 * Throws synchronously for invalid limits, IDs or angles; returns defaults and copied selections.
 * Module existence is checked against the plan after analysis. */
export function validateReviewOptions(options: ReviewOptions) {
  const fixRequested = options.fix ?? false
  const concurrency = options.concurrency ?? DEFAULT_REVIEW_CONCURRENCY
  validatePositiveInteger(concurrency, 'concurrency')
  const maxModules = options.maxModules
  if (maxModules !== undefined) validatePositiveInteger(maxModules, 'maxModules')
  const moduleIds = options.moduleIds ? [...options.moduleIds] : undefined
  validateModuleIds(moduleIds, 'moduleIds must contain unique nonempty module ids')
  if (moduleIds) validateWorkflowStepIds(moduleIds, 'moduleIds must be at most 256 bytes each (workflow step-key limit)')
  const angles = copyReviewAngles(options.angles ?? defaultAngles)
  return { fixRequested, concurrency, maxModules, moduleIds, angles }
}

/** Internal guard for validateReviewOptions and CLI parseCommand; throws for nonpositive or unsafe
 * integers, using the supplied option/flag label in the diagnostic. */
export function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`)
}

/** Internal selection guard for validateReviewOptions and CLI parseCommand. Allows omission;
 * throws for empty lists, blank IDs or exact duplicates using the caller's diagnostic. Does not trim IDs. */
export function validateModuleIds(ids: readonly string[] | undefined, message: string): void {
  if (ids && (ids.length === 0 || ids.some(id => !id.trim()) || hasDuplicateIds(ids))) {
    throw new Error(message)
  }
}

/** Share exact-ID uniqueness checks across library selections and CLI flags without normalization. */
export function hasDuplicateIds(ids: readonly string[]): boolean {
  return new Set(ids).size !== ids.length
}

/** Copy angle records in caller order, rejecting unusable prompts or ambiguous workflow identities. */
function copyReviewAngles(input: readonly ReviewAngle[]): ReviewAngle[] {
  const angles = input.map(angle => ({ ...angle }))
  if (angles.length === 0 || angles.some(angle => !angle.id.trim() || !angle.title.trim() || !angle.instructions.trim())
    || hasDuplicateIds(angles.map(angle => angle.id))) {
    throw new Error('Review angles must have unique nonempty ids and nonempty titles and instructions')
  }
  validateWorkflowStepIds(angles.map(angle => angle.id), 'Review angle ids must be at most 256 bytes (workflow step-key limit)')
  return angles
}

/** Enforce the review API's 256-byte UTF-8 ID cap before dispatch, retaining the caller's diagnostic. */
function validateWorkflowStepIds(ids: readonly string[], message: string): void {
  if (ids.some(id => Buffer.byteLength(id) > 256)) throw new Error(message)
}
