import { readFile, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chooseOutput, outside, progress, repoPath, withClient } from './cli-shared'
import { ReviewContext } from './context'
import { fixMain } from './fix-cli'
import { createGate, discoverPackages } from './io'
import { readDesignConfig } from './project'
import { createDesignPlan, reviewDesign } from './review'
import { dimensionSchema } from './schema'

const help = `Usage: anureo-review [project] [options]
       anureo-review fix [project] --report <report.json> [options]

Review code design, contracts, state, collaboration and readability.
The project defaults to the current directory and must be a Git worktree.

Options:
  --dimension <angle-id>      Select a planner-produced angle; repeatable, default: all discovered angles
  --scope <path>              Review a file or directory inside the project; repeatable
  --config <json>             Project groups, flows and contracts
  --output <directory>        New or empty artifact directory
                             Default: <project>/.anureo/reviews/<run>
  --format markdown|json      Report written to stdout (default: markdown)
  --model <model>             Backend model; defaults to ANUREO_REVIEW_MODEL
  --concurrency <1..16>       Shared concurrency limit (default: 4)
  --resume <directory>        Revalidate and reuse an earlier review
  --backend-config-digest <id>  Stable backend configuration fingerprint for result reuse
  --context-rounds <0..4>     Additional reads per planning/analysis/verification (default: 2)
  --context-files <1..50>     Files per additional read (default: 10)
  --planning-corrections <0..4>  Corrections of returned planner proposals (default: 2)
  --response-corrections <0..4>  Corrections per analysis/verification/summary response (default: 2)
  --max-input-bytes <bytes>   Input budget per model call (default: 256000)
  --max-output-bytes <bytes>  SDK result budget (default: 1048576)
  --dry-run                  Print inventory and planning budgets; modules/angles remain unknown
  --version                  Print the package version
  --help                     Show this help

The CLI requires Bun >=1.4.2 and an authenticated Codex CLI on PATH.
CODEX_BIN can select the Codex executable. Progress and artifact paths go to stderr.
Config, output and resume paths are relative to the launching directory.
Scope paths are relative to the project. Review never edits source files. The explicit fix subcommand applies eligible local suggestions.
Use anureo-review fix --help for repair options.
`

/** CLI-only entry; internal modules do not constitute a supported library API. */
export async function main(args: string[]): Promise<void> {
  if (args[0] === 'fix') return fixMain(args.slice(1))
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    dimension: { type: 'string', multiple: true },
    scope: { type: 'string', multiple: true },
    config: { type: 'string' }, output: { type: 'string' }, format: { type: 'string', default: 'markdown' },
    model: { type: 'string' }, concurrency: { type: 'string', default: '4' }, resume: { type: 'string' },
    'backend-config-digest': { type: 'string' },
    'context-rounds': { type: 'string', default: '2' }, 'context-files': { type: 'string', default: '10' },
    'planning-corrections': { type: 'string', default: '2' },
    'response-corrections': { type: 'string', default: '2' },
    'max-input-bytes': { type: 'string', default: '256000' }, 'max-output-bytes': { type: 'string', default: '1048576' },
    'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', default: false }, version: { type: 'boolean', default: false },
  } })
  if (values.help) { process.stdout.write(help); return }
  if (values.version) {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    console.log(manifest.version); return
  }
  if (positionals.length > 1) throw new Error('Provide one project directory')
  if (!['markdown', 'json'].includes(values.format!)) throw new Error('format must be markdown or json')
  const cwd = await realpath(resolve(positionals[0] ?? process.cwd()))
  const concurrency = Number(values.concurrency)
  createGate(concurrency)
  const maxOutputBytes = Number(values['max-output-bytes'])
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024) throw new Error('max-output-bytes must be an integer >= 1024')
  const config = values.config ? await readDesignConfig(resolve(values.config)) : undefined
  const { outputDir, outputExclusions } = await chooseOutput(cwd, values.output, 'reviews')
  const resumeFrom = values.resume ? await realpath(resolve(values.resume)) : undefined
  if (resumeFrom) {
    const old = relative(cwd, resumeFrom)
    if (!outside(old)) outputExclusions.push(repoPath(old))
  }
  const packages = await discoverPackages(cwd, config?.groups, outputExclusions)
  const files = packages.flatMap(pkg => pkg.files)
  if (!files.length) throw new Error('No Git-visible project files found')
  const scope = values.scope ? [...new Set(values.scope.flatMap(input => {
    const path = relative(cwd, resolve(cwd, input))
    if (outside(path)) throw new Error(`Scope is outside the project: ${input}`)
    const canonical = repoPath(path)
    const matches = files.filter(file => !canonical || file === canonical || file.startsWith(`${canonical}/`))
    if (!matches.length) throw new Error(`No Git-visible files in scope: ${input}`)
    return matches
  }))].sort() : undefined
  const options = {
    scope, dimensions: values.dimension?.map(value => dimensionSchema.parse(value)), flows: config?.flows, contracts: config?.contracts, outputExclusions,
    contextRounds: Number(values['context-rounds']), contextFiles: Number(values['context-files']), maxInputBytes: Number(values['max-input-bytes']),
    planningCorrections: Number(values['planning-corrections']),
    responseCorrections: Number(values['response-corrections']),
  }
  const context = await ReviewContext.create(cwd, packages, [], outputExclusions)
  for (const path of config?.contracts ?? []) await context.acquire(path)
  const plan = createDesignPlan(context, options)
  if (values['dry-run']) {
    console.log(JSON.stringify({ ...plan, cwd, outputDir, concurrency }, null, 2)); return
  }
  const model = values.model ?? process.env.ANUREO_REVIEW_MODEL
  const backendConfigDigest = values['backend-config-digest'] ?? process.env.ANUREO_REVIEW_BACKEND_CONFIG_DIGEST
  if (backendConfigDigest !== undefined && !backendConfigDigest.trim()) throw new Error('backend-config-digest must not be empty')
  if (resumeFrom && !backendConfigDigest) progress('Backend configuration fingerprint omitted; prior results will be revalidated but not automatically reused.')
  console.error(`Artifacts: ${outputDir}`)
  await withClient(cwd, maxOutputBytes, false, async (client, shouldStop) => {
    const report = await reviewDesign({ ...options, client, cwd, packages, outputDir, concurrency, resumeFrom, model,
      backendConfigDigest, repeatable: true, shouldStop, progress })
    process.stdout.write(values.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : await readFile(join(outputDir, 'report.md'), 'utf8'))
    if (!shouldStop() && !report.complete) process.exitCode = 1
  })
}
