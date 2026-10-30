import { validateRequest } from '@anureo/protocol'
import { createHarnessRuntime } from '@anureo/sdk'
import { createScriptedConformanceFactory, runConformance } from '@anureo/conformance'
import { fileURLToPath } from 'node:url'
if (!validateRequest('turn/start', { requestId: 'start', sessionId: 's', turnId: 't', input: [{ type: 'text', text: 'standalone' }] })) throw new Error('Schema failed')
const report = await runConformance(createScriptedConformanceFactory(), { scenarios: ['lifecycle','approval','interrupt','history'] })
if (!report.passed) throw new Error(JSON.stringify(report))
const adapters = process.argv.slice(2)
const loaders = { codex: () => import('@anureo/adapter-codex'), claude: () => import('@anureo/adapter-claude'), acp: () => import('@anureo/adapter-acp'), ahp: () => import('@anureo/adapter-ahp') }
for (const name of adapters) {
  const module = await loaders[name]()
  if (typeof module['create' + name[0].toUpperCase() + name.slice(1) + 'Adapter'] !== 'function') throw new Error('Missing adapter export ' + name)
}
const nativeExamples = []
async function exercise(name, create, executable, text, interrupt) {
  const runtime = createHarnessRuntime(create({ command: process.execPath, args: [fileURLToPath(new URL(executable, import.meta.url))] }))
  let timeout
  try {
    await runtime.initialize({ protocolVersions: [1], clientInfo: { name: 'clean-install-example', version: '1.0.0' }, clientCapabilities: { interactions: ['approval','userInput','elicitation','dynamicTool'] } })
    const session = await runtime.openSession({ requestId: 'open', mode: 'new', cwd: process.cwd(), binding: { sessionId: 'example-' + name, adapterId: name, runtimeConfigId: 'clean' } })
    let sawApproval = false
    const observing = (async () => {
      for await (const event of session.events()) {
        if (event.type === 'interaction/requested') {
          sawApproval = true
          if (event.payload.kind !== 'approval') throw new Error('Unexpected interaction')
          const option = event.payload.options.find(option => option.semantic === 'deny') ?? event.payload.options.find(option => option.id === 'deny')
          if (!option) throw new Error('No non-authorizing option')
          await session.respond({ requestId: 'respond', sessionId: session.binding.sessionId, interactionId: event.payload.interactionId, response: { kind: 'approval', optionId: option.id } })
        }
        if (event.type === 'turn/completed') return event.payload
      }
      throw new Error('No terminal event')
    })()
    void observing.catch(() => {})
    await session.startTurn({ requestId: 'start', sessionId: session.binding.sessionId, turnId: 'example-turn', input: [{ type: 'text', text }] })
    if (interrupt) await session.interrupt({ requestId: 'interrupt', sessionId: session.binding.sessionId, turnId: 'example-turn' })
    const terminal = await Promise.race([observing, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Standalone example timed out')), 5000) })])
    if (terminal.status !== (interrupt ? 'interrupted' : 'completed')) throw new Error('Wrong terminal status: ' + terminal.status)
    if (text === '/approval' && !sawApproval) throw new Error('Approval not exercised')
    await session.close()
    return { adapter: name, input: text, status: terminal.status, approval: sawApproval }
  } finally { clearTimeout(timeout); await runtime.dispose() }
}
if (adapters.includes('acp')) {
  const { createAcpAdapter } = await import('@anureo/adapter-acp')
  for (const text of ['hello','/approval','/wait']) nativeExamples.push(await exercise('acp', createAcpAdapter, './acp-agent.mjs', text, text === '/wait'))
}
if (adapters.includes('ahp')) {
  const { createAhpAdapter } = await import('@anureo/adapter-ahp')
  for (const text of ['hello','/approval','/wait']) nativeExamples.push(await exercise('ahp', createAhpAdapter, './ahp-reference.mjs', text, text === '/wait'))
}
console.log(JSON.stringify({ status: 'passed', schema: true, conformance: report.cases, adapters, nativeExamples }))
