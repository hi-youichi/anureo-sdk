import { createInterface } from 'node:readline/promises'
import { createClient, type Session } from '@anureo/sdk'
import { createDshAcpAdapter } from '@anureo/adapter-acp'

// Real-backend example: talk to DeepSeek Harness (DSH) through its built-in ACP profile.
// Requires dsh >= 0.2.2 on PATH (override with ANUREO_DSH_BIN) and Node.js >= 24.9 to run
// the dsh process itself; credentials are read from $DSH_HOME (defaults to ~/.dsh).
// Override the profile with ANUREO_DSH_PROFILE, the model with ANUREO_DSH_MODEL, and the
// prompt with ANUREO_DSH_PROMPT. The ANUREO_ prefix avoids DSH's own DSH_* variables,
// which a host such as the DSH desktop app already sets in its environment.
//
// DSH advertises the standard ACP v1 baseline only — no fork/steer/revert/history, no
// `permissionMode` — so this example sticks to what the backend actually provides: one
// session, streamed answer text, per-call tool approval, and diagnostic notices.

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
     * Registered with createClient, this handler is invoked by Session.startInteractionHandler
     * after interaction/requested is published for an ACP permission request.
     * Return the advertised allow-once option only for "y"; deny other answers and
     * noninteractive requests. Missing choices or terminal failures reject the handler,
     * which makes the SDK cancel the actionable interaction. The script owns the terminal;
     * SDK cancellation does not stop a pending question in this handler.
     */
    approval: async (request) => {
      const allow = request.options.find((option) => option.semantic === 'allowOnce') ?? request.options.find((option) => option.id === 'allow-once')
      const deny = request.options.find((option) => option.semantic === 'deny') ?? request.options.find((option) => option.id === 'reject-once')
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
  const configured = Object.fromEntries((session.capabilities.config?.options ?? []).map((option) => [option.id, option.value]))
  console.log(`[session] model=${formatConfigValue(session.snapshot.model ?? configured.model)} reasoning_effort=${formatConfigValue(configured.reasoning_effort)}`)

  // Subscribe before submitting: session events are live and are not replayed.
  const eventConsumptionTask = streamAnswer(session)
  // Event consumption may fail before submit returns, so observe rejection now.
  // The later await on the original task still propagates its error.
  void eventConsumptionTask.catch(() => {})

  const turn = await session.submit({ input: process.env.ANUREO_DSH_PROMPT ?? 'In one sentence: what are you, and what can you do?' })
  const hasWrittenAnswerText = await eventConsumptionTask
  const result = await turn.result()
  if (!hasWrittenAnswerText) process.stdout.write(result.text)
  process.stdout.write(`\n[turn] ${result.status}\n`)

  // A terminal event can carry a failed or interrupted outcome; inspect the result status.
  if (result.status !== 'completed') {
    process.exitCode = 1
    process.stderr.write(`[turn] stopped without success (${result.status}${result.status === 'failed' ? `: ${result.error.message}` : ''})\n`)
  }
  await session.close()
} finally {
  // The terminal belongs to this script; client disposal releases SDK-owned sessions and transport.
  terminal.close()
  await client.dispose()
}

/**
 * Format model/configuration values for the session log above: arrays and JSON-encoded
 * arrays become slash-separated names, undefined becomes "default", and other values
 * retain their string form. Malformed JSON is displayed as supplied rather than rejected.
 */
function formatConfigValue(value: unknown): string {
  const join = (entries: unknown[]) => entries.map(String).join('/')
  if (Array.isArray(value)) return join(value)
  if (typeof value === 'string' && value.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed)) return join(parsed)
    } catch { /* not a JSON tuple; show it as-is */ }
  }
  return value === undefined ? 'default' : String(value)
}

/**
 * Subscribe before the DSH run submits input and print agent-message deltas and tool
 * titles to stdout, with notices on stderr. Resolve at any turn/completed event with
 * whether answer text was printed, so the caller can fall back to Turn.result().text;
 * reject read failures or premature stream end. The loop releases its subscription;
 * the caller checks the terminal result status and owns session/client cleanup.
 */
async function streamAnswer(session: Session): Promise<boolean> {
  const answerItemIds = new Set<string>()
  let hasWrittenAnswerText = false
  for await (const event of session.events()) {
    if (event.type === 'item/started') {
      if (event.payload.item.type === 'agentMessage') answerItemIds.add(event.payload.item.id)
      if (event.payload.item.type === 'toolCall') process.stdout.write(`\n[tool] ${event.payload.item.title}\n`)
    }
    if (event.type === 'item/delta' && event.payload.kind === 'text' && event.payload.text && answerItemIds.has(event.payload.itemId)) {
      process.stdout.write(event.payload.text)
      hasWrittenAnswerText = true
    }
    if (event.type === 'notice') {
      process.stderr.write(`[${event.payload.severity}] ${event.payload.code}: ${event.payload.message}\n`)
    }
    if (event.type === 'turn/completed') return hasWrittenAnswerText
  }
  throw new Error('Event stream ended without a terminal event')
}
