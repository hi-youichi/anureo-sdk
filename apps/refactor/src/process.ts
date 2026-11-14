// Runs child processes for adapters and checks; it must not own repository or validation policy.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** Await a child executable's completion and resolve buffered stdout/stderr using Node's execFile contract.
 * runChecks records process failures before rejecting; exportRepositoryGraph propagates them through
 * loadGraph's awaited temporary-file cleanup. Callers supply cwd, timeouts, buffer limits and
 * cancellation as needed; omitted options retain Node's defaults. Adds no retries or error translation.
 * The executable owns its effects; launch, nonzero exit, timeout, buffer and cancellation failures reject
 * with Node's process errors and captured output. Shell interpretation requires an explicit shell
 * option or executable. */
export const exec = promisify(execFile)
