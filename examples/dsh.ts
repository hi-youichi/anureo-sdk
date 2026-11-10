import { createInterface } from 'node:readline/promises'
import { createClient } from '@anureo/sdk'
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
    // DSH offers exactly two permission options, allow_once and reject_once, for every
    // tool call. A host has to answer each request; otherwise the turn waits until the
    // interaction expires. Auto-approval would also work, but this example asks a human.
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
  // DSH builds advertise the model either as a `provider/model` string or as a JSON
  // tuple such as `["deepseek-official","deepseek-v4-flash"]`; show both readably.
  const readable = (value: unknown): string => {
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
  console.log(`[session] model=${readable(session.snapshot.model ?? configured.model)} reasoning_effort=${readable(configured.reasoning_effort)}`)

  // Consume events before submitting input so the bounded queue never fills up.
  // Only agent messages are the answer; reasoning chunks stream as their own items
  // and stay out of stdout so the demo output is the reply alone.
  const answerItems = new Set<string>()
  let streamed = false
  const stream = (async () => {
    for await (const event of session.events()) {
      if (event.type === 'item/started') {
        if (event.payload.item.type === 'agentMessage') answerItems.add(event.payload.item.id)
        if (event.payload.item.type === 'toolCall') process.stdout.write(`\n[tool] ${event.payload.item.title}\n`)
      }
      if (event.type === 'item/delta' && event.payload.kind === 'text' && event.payload.text && answerItems.has(event.payload.itemId)) {
        process.stdout.write(event.payload.text); streamed = true
      }
      if (event.type === 'notice') {
        process.stderr.write(`[${event.payload.severity}] ${event.payload.code}: ${event.payload.message}\n`)
      }
      if (event.type === 'turn/completed') return event.payload
    }
    throw new Error('Event stream ended without a terminal event')
  })()
  void stream.catch(() => {})

  const turn = await session.submit({ input: process.env.ANUREO_DSH_PROMPT ?? 'In one sentence: what are you, and what can you do?' })
  await stream
  const result = await turn.result()
  if (!streamed) process.stdout.write(result.text)
  process.stdout.write(`\n[turn] ${result.status}\n`)

  // DSH may report an error as `end_turn`; trust the AHP terminal status, not the stream end.
  if (result.status !== 'completed') {
    process.exitCode = 1
    process.stderr.write(`[turn] stopped without success (${result.status}${result.status === 'failed' ? `: ${result.error.message}` : ''})\n`)
  }
  await session.close()
} finally {
  terminal.close()
  await client.dispose()
}
