import { createInterface } from 'node:readline/promises'
import { createClient, type Session } from '@anureo/sdk'
import { createDshAcpAdapter } from '@anureo/adapter-acp'

// Stream one reply from DeepSeek Harness (DSH) over ACP and answer tool approvals.
// Requires dsh >= 0.2.2 on PATH (override with ANUREO_DSH_BIN) and Node.js >= 24.9 to run
// the dsh process itself; credentials are read from $DSH_HOME (defaults to ~/.dsh).
// Override the profile with ANUREO_DSH_PROFILE, the model with ANUREO_DSH_MODEL, and the
// prompt with ANUREO_DSH_PROMPT. The ANUREO_ prefix avoids DSH's own DSH_* variables,
// which a host such as the DSH desktop app already sets in its environment.

const terminal = createInterface({ input: process.stdin, output: process.stdout })

const client = await createClient({
  adapter: createDshAcpAdapter({
    command: process.env.ANUREO_DSH_BIN ?? 'dsh',
    cwd: process.cwd(),
    ...(process.env.ANUREO_DSH_PROFILE ? { profile: process.env.ANUREO_DSH_PROFILE } : {}),
  }),
  identity: { adapterId: 'dsh-acp', runtimeConfigId: 'local' },
  interactions: {
    /**
     * Answer an ACP permission request with the advertised allow-once option for "y"
     * on a TTY, or with the advertised deny option otherwise. Require both choices
     * before prompting, matching the option's semantic first and then its fallback ID.
     * createClient registers this handler, and Session invokes it after publishing
     * interaction/requested. The SDK delivers the selected option to ACP or cancels
     * a still-actionable request if either choice is missing or the terminal question
     * rejects. The script owns the terminal and closes it in the session cleanup block
     * after successful client initialization. A pending question ignores the SDK's abort signal.
     */
    approval: async (request) => {
      const allow = request.options.find((option) => option.semantic === 'allowOnce')
        ?? request.options.find((option) => option.id === 'allow-once')
      const deny = request.options.find((option) => option.semantic === 'deny')
        ?? request.options.find((option) => option.id === 'reject-once')
      if (!allow || !deny) throw new Error('DSH did not offer a decidable approval option')
      process.stdout.write(`\n[approval] ${request.title ?? 'tool call'}\n`)
      for (const option of request.options) process.stdout.write(`  ${option.id}: ${option.label}\n`)
      if (!process.stdin.isTTY) {
        process.stdout.write(`  no terminal attached; choosing ${deny.id}\n`)
        return { kind: 'approval', optionId: deny.id }
      }
      const answer = (await terminal.question('Allow once? [y/N] ')).trim().toLowerCase()
      return { kind: 'approval', optionId: answer === 'y' ? allow.id : deny.id }
    },
  },
})

try {
  const session = await client.sessions.create({
    cwd: process.cwd(),
    ...(process.env.ANUREO_DSH_MODEL ? { model: process.env.ANUREO_DSH_MODEL } : {}),
  })
  logSessionConfiguration(session)

  // Subscribe before submitting: session events are live and are not replayed.
  const eventConsumptionTask = streamAnswer(session)
  // Event consumption may fail before submit returns, so observe rejection now.
  // Awaiting the original task after submit succeeds still propagates its error.
  void eventConsumptionTask.catch(() => {})

  const turn = await session.submit({ input: process.env.ANUREO_DSH_PROMPT ?? 'In one sentence: what are you, and what can you do?' })
  const hasWrittenAnswerText = await eventConsumptionTask
  const result = await turn.result()
  if (!hasWrittenAnswerText) process.stdout.write(result.text)
  process.stdout.write(`\n[turn] ${result.status}\n`)

  // A terminal event can carry a failed or interrupted outcome; inspect the result status.
  if (result.status !== 'completed') {
    process.exitCode = 1
    const errorDetails = result.status === 'failed' ? `: ${result.error.message}` : ''
    process.stderr.write(`[turn] stopped without success (${result.status}${errorDetails})\n`)
  }
  await session.close()
} finally {
  // The terminal belongs to this script; client disposal releases SDK-owned sessions and transport.
  terminal.close()
  await client.dispose()
}

/**
 * Print the model and reasoning effort once the DSH example has opened its session.
 * Prefer the model reported in the session snapshot, with the advertised configuration
 * value as a fallback. The example logs this before submitting the turn.
 */
function logSessionConfiguration(session: Session): void {
  const options = session.capabilities.config?.options ?? []
  const configured = Object.fromEntries(options.map((option) => [option.id, option.value]))
  const model = formatConfigValue(session.snapshot.model ?? configured.model)
  const reasoningEffort = formatConfigValue(configured.reasoning_effort)
  console.log(`[session] model=${model} reasoning_effort=${reasoningEffort}`)
}

/**
 * Render a value for logSessionConfiguration. Join arrays and strings beginning with
 * "[" that parse as arrays with slashes. Render undefined as "default" and use
 * String for other values, including malformed JSON strings.
 */
function formatConfigValue(value: unknown): string {
  const join = (entries: unknown[]) => entries.map(String).join('/')
  if (Array.isArray(value)) return join(value)
  if (typeof value === 'string' && value.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed)) return join(parsed)
    } catch { /* Display the original value if decoding fails. */ }
  }
  return value === undefined ? 'default' : String(value)
}

/**
 * Subscribe to the DSH session before submitting its single turn. Print agent-message
 * deltas and tool titles to stdout and notices to stderr. Return at the first
 * turn/completed event with whether answer text was printed. The example awaits this
 * before reading Turn.result(), falls back to its text if needed, and checks its status.
 * The loop releases its subscription and rejects on read failure or premature stream end.
 * The example still owns session and client cleanup.
 */
async function streamAnswer(session: Session): Promise<boolean> {
  const answerItemIds = new Set<string>()
  let hasWrittenAnswerText = false
  for await (const event of session.events()) {
    switch (event.type) {
      case 'item/started': {
        const { item } = event.payload
        if (item.type === 'agentMessage') answerItemIds.add(item.id)
        if (item.type === 'toolCall') process.stdout.write(`\n[tool] ${item.title}\n`)
        break
      }
      case 'item/delta': {
        const delta = event.payload
        if (delta.kind === 'text' && delta.text && answerItemIds.has(delta.itemId)) {
          process.stdout.write(delta.text)
          hasWrittenAnswerText = true
        }
        break
      }
      case 'notice': {
        const { severity, code, message } = event.payload
        process.stderr.write(`[${severity}] ${code}: ${message}\n`)
        break
      }
      case 'turn/completed':
        return hasWrittenAnswerText
    }
  }
  throw new Error('Event stream ended without a terminal event')
}
