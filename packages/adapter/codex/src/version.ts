/** Probes the configured Codex binary version and releases its process; it must not select capabilities. */
import { HarnessSdkError } from '@anureo/sdk'
import { spawnHarnessProcess, type HarnessProcess } from '@anureo/sdk/process'
import type { CodexAdapterOptions } from './options'

/**
 * For adapter initialization, normalize a nonempty version override without I/O, otherwise launch
 * --version and bound stdout/exit waiting by timeoutMs (30 seconds by default), after launch resolves.
 * Reject oversized output with PROTOCOL_ERROR, timeout/nonzero exit with HARNESS_UNAVAILABLE, and
 * propagate launch, stream and disposal errors. Always await disposal of a successfully created process.
 */
export async function probeVersion(options: CodexAdapterOptions): Promise<string> {
  if (options.version) return versionNumber(options.version)
  const process = await (options.processFactory ?? spawnHarnessProcess)({ command: options.command, args: ['--version'], cwd: options.cwd, env: options.env })
  try {
    return await Promise.race([
      readVersionOutput(process),
      new Promise<string>((_, reject) => {
        const timeout = setTimeout(() => reject(new HarnessSdkError('HARNESS_UNAVAILABLE', 'Codex version probe timed out')), options.timeoutMs ?? 30_000)
        timeout.unref?.()
      }),
    ])
  } finally {
    // Await even on timeout so callers never receive a result before process cleanup settles.
    await process.dispose()
  }
}

/** For override and stdout normalization, return the first standalone semantic version or the original text so unknown formats retain profile fallback behavior. No I/O or validation errors. */
const versionNumber = (value: string) => /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$|[-+])/.exec(value)?.[1] ?? value

/**
 * For probeVersion, consume stdout and return its normalized version after a successful exit.
 * Reject decoded output over 4096 UTF-16 code units with PROTOCOL_ERROR and nonzero exit with
 * HARNESS_UNAVAILABLE; stream/exit errors propagate. The caller owns timeout and process disposal.
 */
async function readVersionOutput(process: HarnessProcess): Promise<string> {
  const decoder = new TextDecoder()
  let output = ''
  for await (const chunk of process.stdout) {
    output += decoder.decode(chunk, { stream: true })
    if (output.length > 4096) throw new HarnessSdkError('PROTOCOL_ERROR')
  }
  // Drain stdout first: the exit promise may settle while version bytes are still buffered.
  const exit = await process.exited
  if (exit.code !== 0) throw new HarnessSdkError('HARNESS_UNAVAILABLE')
  return versionNumber(output.trim())
}
