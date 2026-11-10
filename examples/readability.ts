import path from 'node:path'
import type { EventEmitter } from 'node:events'
import { createClient } from '@anureo/sdk'
import { createCodexAdapter } from '@anureo/adapter-codex'
import { analyzeReadability, createSdkReadabilityAgent, writeReport, type PackageSelection } from '@anureo/readability'

function selection(value: string): PackageSelection {
  const separator = value.lastIndexOf('=')
  const packagePath = separator < 0 ? value : value.slice(0, separator)
  const agents = separator < 0 ? 1 : Number(value.slice(separator + 1))
  if (!packagePath || !Number.isSafeInteger(agents) || agents < 1) throw new Error(`Expected package/path=positive-agent-count: ${value}`)
  return { path: packagePath, agents }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === '--help') {
    console.log('Usage: bun run example:readability [repository-root] [package/path=agents ...]')
    console.log('Example: bun run example:readability . packages/core=3 packages/codex=2')
    console.log('Requires a configured Codex executable. Writes artifacts/readability/rules.{json,md} under the repository root.')
    return
  }
  const root = path.resolve(args[0] ?? '.')
  const packages = args.length > 1 ? args.slice(1).map(selection) : undefined
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error('Readability analysis cancelled'))
  const signals: EventEmitter = process
  signals.once('SIGINT', cancel)
  try {
    const agent = createSdkReadabilityAgent({
      createClient: context => createClient({
        adapter: createCodexAdapter({ command: 'codex' }),
        identity: { adapterId: 'codex', runtimeConfigId: 'readability' },
      }, { signal: context.signal }),
      session: { permissionMode: 'read-only' },
    })
    const report = await analyzeReadability({ root, packages, agent, concurrency: 4,
      signal: controller.signal,
      onProgress: event => console.error(`[${event.phase}] ${event.taskId}: ${event.state}`),
    })
    const directory = path.join(root, 'artifacts/readability')
    await writeReport(report, directory)
    console.log(JSON.stringify({ directory, complete: report.complete, rules: report.rules.length,
      reviewedFiles: report.coverage.reviewedFiles.length, failures: report.failures.length }, null, 2))
    if (!report.complete) process.exitCode = 1
  } finally {
    signals.off('SIGINT', cancel)
  }
}

main().catch(cause => {
  console.error(cause)
  process.exitCode = 1
})
