import { createCodexAdapter } from '@anureo/adapter-codex'
import { createSwarmAdapter } from '@anureo/adapter-swarm'
import { createClient } from '@anureo/sdk'

const backend = await createClient({
  adapter: createCodexAdapter({ command: process.env.CODEX_BIN ?? 'codex' }),
  identity: { adapterId: 'codex', runtimeConfigId: 'local' },
})

try {
  const swarm = await createClient({
    adapter: createSwarmAdapter({ backend }),
    identity: { adapterId: 'swarm', runtimeConfigId: 'local' },
  })
  try {
    const session = await swarm.sessions.create({ cwd: process.cwd(), permissionMode: 'read-only', config: { model_reasoning_effort: 'low' } })
    const steps = [
      { input: 'Work directly. In one sentence, describe what Array.prototype.map does.', team: false },
      { input: 'Use a team with exactly two members for independent read-only work. One checks whether calling map mutates the array, and the other checks what map does with sparse array holes. Report both findings and the two distinct cases.', team: true },
      { input: 'Work directly. From your last summary, give one JavaScript example of the sparse array case.', team: false },
    ]
    for (const step of steps) {
      const turn = await session.submit({ input: step.input })
      const result = await turn.result({ timeoutMs: null })
      if (result.status !== 'completed') throw new Error(result.error?.message ?? result.status)
      const memberCount = result.items.filter(item => item.type === 'subagent' && item.state === 'completed').length
      if (memberCount !== (step.team ? 2 : 0) || !result.text.trim()) {
        throw new Error(`Unexpected swarm result with ${memberCount} completed members: ${result.text}`)
      }
      console.log(`[${memberCount ? 'team' : 'direct'}] ${result.text}`)
    }
    await session.close()
  } finally {
    await swarm.dispose()
  }
} finally {
  await backend.dispose()
}
