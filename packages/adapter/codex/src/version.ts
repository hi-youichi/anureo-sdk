/** Reads and normalizes the version used for adapter negotiation. */
import { HarnessSdkError } from '@anureo/sdk'
import { spawnHarnessProcess, type HarnessProcess } from '@anureo/sdk/process'
import type { CodexAdapterOptions } from './options'

/**
 * Read the version that CodexNativeAdapter.initialize uses to advertise capabilities. A nonempty
 * override bypasses launch. Otherwise, bound the stdout and exit wait after launch by timeoutMs
 * (default 30,000 ms). Oversized output rejects with PROTOCOL_ERROR. Deadline expiry and nonzero
 * exit reject with HARNESS_UNAVAILABLE. Launch and stream failures propagate. Await cleanup even
 * on failure, with cleanup rejection taking precedence over the read outcome.
 */
export async function probeVersion(options: CodexAdapterOptions): Promise<string> {
  if (options.version) return versionNumber(options.version)
  const process = await (options.processFactory ?? spawnHarnessProcess)({
    command: options.command, args: ['--version'], cwd: options.cwd, env: options.env,
  })
  try {
    return await Promise.race([
      readVersionOutput(process),
      new Promise<string>((_, reject) => {
        const timeout = setTimeout(() => reject(new HarnessSdkError('HARNESS_UNAVAILABLE', 'Codex version probe timed out')), options.timeoutMs ?? 30_000)
        timeout.unref?.()
      }),
    ])
  } finally {
    await process.dispose()
  }
}

/** Extract major.minor.patch from an override or the trimmed CLI output, dropping an attached prerelease or build suffix. Preserve unmatched text for profile selection. */
function versionNumber(value: string): string {
  return /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$|[-+])/.exec(value)?.[1] ?? value
}

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
