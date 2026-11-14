// Caller configuration and shared preflight policy for the library and CLI.
import type { Client } from '@anureo/sdk'
import { defaultAngles, type ReviewAngle } from './angles'
import type { ReviewProgress } from './progress'

/** Internal default shared by library preflight and CLI flag parsing for review and fix capacity. */
export const DEFAULT_REVIEW_CONCURRENCY = 8

/** Configure reviewCode with an initialized client. Keep the client available until the call
 * resolves or rejects and await its disposal when finished using it. */
export interface ReviewOptions {
  /** Initialized client used to open the run's analysis, review and optional fix sessions. */
  client: Client
  /** Existing source directory, resolved from the process working directory and canonicalized. */
  cwd: string
  /** Model override for all agent sessions. Omission uses the harness's default model selection. */
  model?: string
  /** Additional instructions for analysis, review and final verification. An empty string is omitted. */
  focus?: string
  /** Angles in result order; defaults to correctness, code quality and design. Requires a nonempty
   * list with unique nonblank IDs (at most 256 UTF-8 bytes) and nonblank titles/instructions. Copied at preflight. */
  angles?: readonly ReviewAngle[]
  /** Select exact IDs from the analyzed plan. Omission selects all modules before maxModules is
   * applied. A supplied list must contain at least one ID, with unique nonblank IDs of at most
   * 256 UTF-8 bytes. An unknown ID rejects the run after analysis, even if maxModules is set. */
  moduleIds?: readonly string[]
  /** Positive safe integer limiting selected modules in plan order; omission leaves them unlimited. */
  maxModules?: number
  /** Queue fixes in review-completion order and apply validated edits to the original work tree.
   * If any fix changes files, the selected scope is reviewed again after the fix queue settles.
   * Defaults to false. Fix mode requires a usable Git work tree and gives each agent a separate
   * temporary checkout. Applied edits remain if a later step fails. */
  fix?: boolean
  /** Harness-specific session permission mode for fix edits and checks; omission uses the session default. */
  fixPermissionMode?: string
  /** Shared maximum for simultaneous review, fix and verification agents. Must be a positive safe
   * integer and defaults to 8. Module analysis runs first. */
  concurrency?: number
  /** Durable run storage, retained after completion. Defaults to <canonical cwd>/.anureo/workflows;
   * an explicit relative path resolves from the process working directory. */
  workflowDirectory?: string
  /** Synchronously observe lifecycle events. Return values are ignored, so asynchronous work is not
   * awaited. Synchronous exceptions are collected in the returned report's progressErrors. */
  onProgress?: (event: ReviewProgress) => void
}

/** Validate limits, IDs and angles, throwing synchronously on invalid input. prepareReview uses
 * the returned defaults and copied selections for dispatch and durable run input. Module existence
 * is checked after analysis produces the plan. */
export function validateReviewOptions(options: ReviewOptions) {
  const fixRequested = options.fix ?? false
  const concurrency = options.concurrency ?? DEFAULT_REVIEW_CONCURRENCY
  validatePositiveInteger(concurrency, 'concurrency')
  const maxModules = options.maxModules
  if (maxModules !== undefined) validatePositiveInteger(maxModules, 'maxModules')
  const moduleIds = options.moduleIds ? [...options.moduleIds] : undefined
  validateModuleIds(moduleIds, 'moduleIds must contain unique nonempty module ids')
  if (moduleIds) validateIdByteLength(moduleIds, 'moduleIds must be at most 256 bytes each (workflow step-key limit)')
  const angles = copyReviewAngles(options.angles ?? defaultAngles)
  return { fixRequested, concurrency, maxModules, moduleIds, angles }
}

/** Internal guard for validateReviewOptions and CLI parseCommand; throws for nonpositive or unsafe
 * integers, using the supplied option/flag label in the diagnostic. */
export function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`)
}

/** Internal selection guard for validateReviewOptions and CLI parseCommand. Allows omission;
 * throws for empty lists, blank IDs or exact duplicates using the caller's diagnostic. Whitespace
 * is significant for matching IDs. */
export function validateModuleIds(ids: readonly string[] | undefined, message: string): void {
  if (ids && (ids.length === 0 || ids.some(id => !id.trim()) || hasDuplicateIds(ids))) {
    throw new Error(message)
  }
}

/** Share exact-ID uniqueness checks across library selections and CLI flags without normalization. */
export function hasDuplicateIds(ids: readonly string[]): boolean {
  return new Set(ids).size !== ids.length
}

/** Snapshot angle records in caller order for validateReviewOptions before execution can yield.
 * Throw for blank prompts, empty selections, duplicate or blank IDs, or IDs over the byte limit. */
function copyReviewAngles(input: readonly ReviewAngle[]): ReviewAngle[] {
  const angles = input.map(angle => ({ ...angle }))
  const ids = angles.map(angle => angle.id)
  if (angles.length === 0 || angles.some(angle => !angle.id.trim() || !angle.title.trim() || !angle.instructions.trim())
    || hasDuplicateIds(ids)) {
    throw new Error('Review angles must have unique nonempty ids and nonempty titles and instructions')
  }
  validateIdByteLength(ids, 'Review angle ids must be at most 256 bytes (workflow step-key limit)')
  return angles
}

/** Enforce the review API's 256-byte UTF-8 ID cap for module and angle selections, throwing with
 * the caller's diagnostic. */
function validateIdByteLength(ids: readonly string[], message: string): void {
  if (ids.some(id => Buffer.byteLength(id) > 256)) throw new Error(message)
}
