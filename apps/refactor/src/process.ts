// Runs child processes for adapters and checks; it must not own repository or validation policy.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** Execute a file with Node's execFile options and resolve buffered stdout/stderr.
 * Snapshot/graph adapters, checks and fixtures own cwd, timeouts, buffer limits and cancellation;
 * this shared primitive adds no defaults, retries or error translation. Launches a child process
 * whose effects belong to the supplied executable; rejects with Node's process errors and captured
 * output. Shell interpretation occurs only when explicitly requested via options or executable. */
export const exec = promisify(execFile)
