// Adapts CLI input/output and owns the run lifecycle; it must not interpret harness policy or event payloads.
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { runTurn, BACKEND_HARNESSES, SANDBOX_VALUES, supportsSandbox, type RunOptions, type Sandbox, type OutputMode } from './run'

const VERSION = '0.2.0'

/** Usage printed by runCli; kept in one place so help and validation stay aligned. */
const help = `Usage: anureo [options] [prompt]     # prompt omitted or "-" reads stdin

Run one agent turn and print the unified AHP event stream (JSONL) to stdout.

Options:
  --harness <name>       Required: ${BACKEND_HARNESSES.join(' | ')} | swarm | swarm:<name>
                        swarm defaults to swarm:codex; use a native name after the colon
                        swarm loads fixed bees from user and project .anureo/bees/
  --command <exe>        Backend executable override; required for acp and swarm:acp
  --args <json>          Extra harness args as a JSON array, e.g. '["agent.mjs"]'
  -C, --cd <dir>         Working directory for the session (default: cwd)
  --model <name>         Model override, passed through to the harness
  --resume <sessionId>   Resume a session from an earlier run (binding.sessionId)
  --sandbox <mode>       read-only | workspace | full (codex or claude backend)
  --schema <file>        JSON Schema file constraining the final message
  --output <mode>        stream (default) | result (one final JSON object)
  --review-profile       Fork completed fixed bees to propose profile improvements (swarm)
  --review-feedback <text>  Enable profile review and include user feedback
  --workflow <id>        Run a registered .anureo/workflows/ file as a host turn; prompt becomes its JSON args (swarm)
  --resume-workflow <runId>  Resume an interrupted workflow run from its journal (swarm)
  --verbose              CLI diagnostics on stderr (default: silent)
  -h, -V                 Show help / version

Exit codes: 0 completed or interrupted, 2 failed or startup error.
stdout is always pure JSONL (stream) or one JSON object (result).
`

/** Overrides for runCli callers; omitted fields use process stdio and cwd. */
export interface CliDependencies {
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  /** Base directory for relative --cd paths; defaults to process.cwd(). */
  cwd?: string
  /** Override the user directory for profile discovery. Defaults to the OS home directory. */
  homeDirectory?: string
  /** Prompt override for tests; when omitted, stdin is read per the prompt rules. */
  prompt?: string
}

/** Parse and validate input, then run one turn; returns the process exit code. */
export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const out = dependencies.stdout ?? ((text: string) => process.stdout.write(text))
  const err = dependencies.stderr ?? ((text: string) => process.stderr.write(text))
  let parsed: ReturnType<typeof parseInput>
  try {
    parsed = parseInput(args)
  } catch (cause) {
    err(`anureo: ${(cause as Error).message}\n`)
    return 2
  }
  if (parsed.kind === 'help') { out(help); return 0 }
  if (parsed.kind === 'version') { out(`${VERSION}\n`); return 0 }

  let prompt = dependencies.prompt ?? parsed.prompt
  if (parsed.workflow !== undefined || parsed.resumeWorkflow !== undefined) {
    let argsText = '{}'
    if (prompt?.trim()) {
      try {
        const candidate: unknown = JSON.parse(prompt)
        if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('not an object')
        argsText = prompt
      } catch {
        err('anureo: with --workflow, the prompt or stdin must be a JSON args object\n')
        return 2
      }
    }
    prompt = parsed.workflow !== undefined
      ? `/workflow run ${parsed.workflow} ${argsText}`
      : `/workflow resume ${parsed.resumeWorkflow!} ${argsText}`
  }
  if (!prompt || prompt === '-') prompt = await readStdin()
  if (!prompt?.trim()) { err('anureo: a prompt argument or piped stdin is required\n'); return 2 }

  let outputSchema: unknown
  if (parsed.schemaPath) {
    try {
      outputSchema = JSON.parse(readFileSync(parsed.schemaPath, 'utf8'))
    } catch (cause) {
      err(`anureo: cannot read --schema: ${(cause as Error).message}\n`)
      return 2
    }
  }

  return runTurn({
    harness: parsed.harness,
    command: parsed.command,
    harnessArgs: parsed.harnessArgs,
    cwd: resolve(dependencies.cwd ?? process.cwd(), parsed.cd ?? '.'),
    homeDirectory: dependencies.homeDirectory,
    model: parsed.model,
    resume: parsed.resume,
    sandbox: parsed.sandbox,
    outputSchema,
    output: parsed.output,
    reviewProfile: parsed.reviewProfile,
    reviewFeedback: parsed.reviewFeedback,
    verbose: parsed.verbose,
    prompt: prompt as string,
  }, { out, err })
}

/** Validated parse outcome; help/version bypass run-only validation. */
type Parsed =
  | { kind: 'help' } | { kind: 'version' }
  | { kind: 'run'; harness: RunOptions['harness']; command?: string; harnessArgs?: string[]; cd?: string; model?: string; resume?: string; sandbox?: Sandbox; schemaPath?: string; output: OutputMode; reviewProfile: boolean; reviewFeedback?: string; verbose: boolean; workflow?: string; resumeWorkflow?: string; prompt?: string }

function parseInput(args: string[]): Parsed {
  const { values, positionals } = parseArgs({
    args, strict: true, allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'V' },
      harness: { type: 'string' },
      command: { type: 'string' },
      args: { type: 'string' },
      cd: { type: 'string', short: 'C' },
      model: { type: 'string' },
      resume: { type: 'string' },
      sandbox: { type: 'string' },
      schema: { type: 'string' },
      output: { type: 'string' },
      workflow: { type: 'string' },
      'resume-workflow': { type: 'string' },
      'review-profile': { type: 'boolean' },
      'review-feedback': { type: 'string' },
      verbose: { type: 'boolean' },
    },
  })
  if (values.help) return { kind: 'help' }
  if (values.version) return { kind: 'version' }
  if (positionals.length > 1) throw new Error('expected at most one prompt argument')
  const name = values.harness
  if (!name) {
    throw new Error(`--harness is required: one of ${BACKEND_HARNESSES.join(' | ')} | swarm | swarm:<name>`)
  }
  const isSwarm = name === 'swarm' || name.startsWith('swarm:')
  const backendName = name === 'swarm' ? 'codex' : isSwarm ? name.slice('swarm:'.length) : name
  const backend = BACKEND_HARNESSES.find(candidate => candidate === backendName)
  if (!backend) {
    throw new Error(`unknown harness "${name}"; backend names: ${BACKEND_HARNESSES.join(' | ')}`)
  }
  const harness: RunOptions['harness'] = isSwarm ? { name: 'swarm', backend } : { name: backend }
  const reviewFeedback = values['review-feedback']
  const reviewProfile = values['review-profile'] === true || reviewFeedback !== undefined
  if (reviewProfile && !isSwarm) throw new Error('profile review requires a swarm harness')
  const workflow = values.workflow
  const resumeWorkflow = values['resume-workflow']
  if ((workflow !== undefined || resumeWorkflow !== undefined) && !isSwarm) throw new Error('--workflow requires a swarm harness')
  if (workflow !== undefined && resumeWorkflow !== undefined) throw new Error('use either --workflow or --resume-workflow, not both')
  const workflowArgs = positionals[0]
  if (workflow !== undefined && workflowArgs !== undefined) {
    try {
      const parsed = JSON.parse(workflowArgs)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    } catch { throw new Error('with --workflow, the prompt argument must be a JSON args object') }
  }
  if (resumeWorkflow !== undefined && !/^[^\s]+$/.test(resumeWorkflow)) throw new Error('--resume-workflow must be a runId')
  if (backend === 'acp' && !values.command) throw new Error(`--command is required with --harness ${name}`)
  let harnessArgs: string[] | undefined
  if (values.args !== undefined) {
    try {
      harnessArgs = JSON.parse(values.args)
    } catch { throw new Error('--args must be a JSON array of strings') }
    if (!Array.isArray(harnessArgs) || harnessArgs.some(value => typeof value !== 'string')) throw new Error('--args must be a JSON array of strings')
  }
  let sandbox: Sandbox | undefined
  if (values.sandbox !== undefined) {
    if (!(SANDBOX_VALUES as readonly string[]).includes(values.sandbox)) {
      throw new Error(`--sandbox must be one of ${SANDBOX_VALUES.join(' | ')}`)
    }
    if (!supportsSandbox(backend)) {
      throw new Error(`--sandbox is not defined for harness "${name}" (codex/claude backends only)`)
    }
    sandbox = values.sandbox as Sandbox
  }
  let output: OutputMode = 'stream'
  if (values.output !== undefined) {
    if (values.output !== 'stream' && values.output !== 'result') throw new Error('--output must be "stream" or "result"')
    output = values.output
  }
  return {
    kind: 'run', harness, command: values.command, harnessArgs, cd: values.cd, model: values.model,
    resume: values.resume, sandbox, schemaPath: values.schema, output, reviewProfile, reviewFeedback,
    verbose: values.verbose ?? false, ...(workflow !== undefined ? { workflow } : {}), ...(resumeWorkflow !== undefined ? { resumeWorkflow } : {}),
    prompt: workflow === undefined && resumeWorkflow === undefined ? positionals[0] : undefined,
  }
}

/** Read piped stdin to completion; returns '' when stdin is a TTY. */
function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('')
  return new Promise((resolveRead, rejectRead) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => { text += chunk })
    process.stdin.on('end', () => resolveRead(text))
    process.stdin.on('error', rejectRead)
  })
}
