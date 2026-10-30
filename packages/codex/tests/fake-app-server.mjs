import readline from 'node:readline'
import { appendFileSync } from 'node:fs'
const mode = process.env.FAKE_SCENARIO ?? 'normal'
const threadId = 'native-thread'
let turnId = 'native-turn-1'
let counter = 0
let allowedHistory = ['native-turn-1','native-turn-2']
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const notify = (method, params) => send({ method, params: { threadId, ...params } })
const done = () => {
  notify('item/completed', { turnId, item: { id: 'message', type: 'agentMessage', text: 'authoritative final', phase: 'final_answer' } })
  notify('turn/completed', { turn: { id: turnId, status: 'completed', items: [] } })
}
for await (const line of readline.createInterface({ input: process.stdin })) {
  let msg
  try { msg = JSON.parse(line) } catch { process.exit(2) }
  if (process.env.FAKE_LOG_FILE) appendFileSync(process.env.FAKE_LOG_FILE, line + '\n')
  const reply = result => send({ id: msg.id, result })
  if (!msg.method) { if (msg.id === 'server-request' || msg.id === 901) done(); continue }
  if (msg.method === 'initialized') continue
  switch (msg.method) {
    case 'account/read': if (mode === 'auth-timeout') break; if (mode === 'auth-unavailable') send({ id: msg.id, error: { code: -32601, message: 'No account method' } }); else if (mode === 'auth-not-required') reply({account:null,requiresOpenaiAuth:false}); else if (mode === 'auth-malformed') reply({}); else reply(mode === 'auth-required' ? { account: null, requiresOpenaiAuth: true } : { account: { type: 'apiKey' }, requiresOpenaiAuth: true }); break
    case 'model/list':
      if (mode === 'model-hang') break
      if (mode === 'model-loop') { reply({ data: [{ id: 'test-model', displayName: 'Test model' }], nextCursor: 'loop' }); break }
      reply({ data: [
      { id: 'test-model', displayName: 'Test model' },
      { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', isDefault: true, hidden: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }, { reasoningEffort: 'ultra', description: 'Deepest' }], serviceTiers: [{ id: 'standard' }, { id: 'priority' }] },
      ...(msg.params?.includeHidden ? [{ id: 'gpt-reserve', displayName: 'GPT-Reserve', hidden: true }] : []),
    ], nextCursor: null }); break
    case 'initialize': reply({ userAgent: 'codex/0.164.0' }); break
    case 'thread/start': case 'thread/resume': case 'thread/fork':
      if (mode === 'open-fail' && msg.method === 'thread/start') { send({ id: msg.id, error: { code: -32000, message: 'thread start failed' } }); break }
      if (msg.method === 'thread/fork') allowedHistory = msg.params.beforeTurnId ? [] : [msg.params.lastTurnId]
      reply({ thread: { id: threadId, ...(mode === 'titles' ? { name: 'Restored title' } : {}) } }); break
    case 'turn/start': case 'review/start': {
      turnId = msg.method === 'review/start' ? 'native-review' : `native-turn-${++counter}`
      notify('turn/started', { turn: { id: turnId, status: 'inProgress', items: [] } })
      reply({ turn: { id: turnId, status: 'inProgress', items: [] } })
      if (mode === 'titles') {
        send({ method: 'thread/name/updated', params: { threadId: 'unrelated', threadName: 'Wrong title' } })
        notify('thread/name/updated', { threadName: 'Native title' })
        notify('thread/name/updated', { threadName: 'Native title' })
        done()
        notify('thread/name/updated', {})
        break
      }
      if (mode === 'auth-expired') { notify('turn/completed', { turn: { id: turnId, status: 'failed', error: { codexErrorInfo: 'unauthorized', message: 'PRIVATE_PROVIDER_DIAGNOSTIC https://auth.test/?token=private' } } }); break }
      if (mode === 'disconnect') { setTimeout(() => process.exit(0), 10); break }
      if (mode === 'backpressure') { setTimeout(() => process.stdout.write(JSON.stringify({ method: 'future/big', params: { text: 'x'.repeat(100000) } }) + '\n'), 10); break }
      if (mode === 'timing') {
        const startedAtMs = Date.parse('2026-10-28T01:00:03Z') + (counter - 1) * 60000
        notify('item/started', { turnId, startedAtMs, item: { id: 'message', type: 'agentMessage', text: '', phase: 'final_answer' } })
        notify('item/agentMessage/delta', { turnId, itemId: 'message', delta: 'Partial answer' })
        notify('item/started', { turnId, startedAtMs: startedAtMs + 1000, item: { id: 'message', type: 'agentMessage', text: 'Repeated start', phase: 'final_answer' } })
        break
      }
      if (mode === 'file-change') {
        const changes = [{ path: '/workspace/old.ts', kind: { type: 'update', move_path: '/workspace/new.ts' }, diff: '@@ -56,3 +56,3 @@\n context\n-old\n+new\n end\n' }]
        notify('item/fileChange/outputDelta', { turnId, itemId: 'edit', delta: 'Applying patch…\n' })
        notify('item/started', { turnId, item: { id: 'edit', type: 'fileChange', status: 'inProgress', changes } })
        notify('item/completed', { turnId, item: { id: 'edit', type: 'fileChange', status: 'completed', changes } })
        done(); break
      }
      if (mode === 'unknown-item') notify('item/completed', { turnId, item: { id: 'future', type: 'brandNew', safe: 'kept' } })
      if (mode === 'error-notice') { notify('error', { turnId, message: 'Native subsystem failed' }); done(); break }
      if (mode === 'hold' || mode === 'timeout-revert' || mode === 'missing-optional') break
      if (['approval','fileapproval','permission','questions','elicitation','dynamic','policy','unknown-request'].includes(mode)) {
        const req = mode === 'fileapproval' ? { method: 'item/fileChange/requestApproval', params: { itemId: 'tool', reason: 'file write' } }
          : mode === 'approval' ? { method: 'item/commandExecution/requestApproval', params: { itemId: 'tool', command: 'echo test', availableDecisions: ['accept','decline'] } }
          : mode === 'policy' ? { method: 'item/commandExecution/requestApproval', params: { itemId: 'tool', command: 'echo test', availableDecisions: [{ acceptWithExecpolicyAmendment: { rule: 'trust' } }] } }
          : mode === 'permission' ? { method: 'item/permissions/requestApproval', params: { itemId: 'tool', permissions: { network: { enabled: true } } } }
          : mode === 'questions' ? { method: 'item/tool/requestUserInput', params: { itemId: 'tool', questions: [{ id: 'q', header: 'Pick', question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }] } }
          : mode === 'elicitation' ? { method: 'mcpServer/elicitation/request', params: { mode: 'url', url: 'https://auth.test/authorize?private=secret', message: 'Sign in', serverName: 'mcp' } }
          : mode === 'dynamic' ? { method: 'item/tool/call', params: { itemId: 'tool', tool: 'example', arguments: {} } }
          : { method: 'future/approval', params: {} }
        send({ id: mode === 'permission' ? 901 : 'server-request', ...req, params: { threadId, turnId, ...req.params } }); break
      }
      notify('item/started', { turnId, item: { id: 'message', type: 'agentMessage', text: '', phase: 'commentary' } })
      const utf = JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'message', delta: 'hello 日本語' } }) + '\n'
      const data = Buffer.from(utf); process.stdout.write(data.subarray(0, data.length - 8)); process.stdout.write(data.subarray(data.length - 8))
      notify('item/completed', { turnId, item: { id: 'reason', type: 'reasoning', summary: ['summary'], content: ['allowed content'] } })
      notify('item/completed', { turnId, item: { id: 'shell', type: 'commandExecution', command: 'echo test', status: 'completed', aggregatedOutput: 'test', durationMs: 2 } })
      notify('item/completed', { turnId, item: { id: 'collab', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child-a','child-b'], agentsStates: { 'child-a': { status: 'completed' }, 'child-b': { status: 'running' } }, status: 'completed' } })
      notify('hook/started', { turnId, hook: { id: 'hook-a', name: 'PreToolUse' } })
      notify('hook/completed', { turnId, hook: { id: 'hook-a', name: 'PreToolUse', output: {} } })
      notify('turn/plan/updated', { turnId, plan: [{ step: 'One', status: 'inProgress' }] })
      notify('turn/plan/updated', { turnId, plan: [{ step: 'One', status: 'completed' }] })
      notify('thread/tokenUsage/updated', { turnId, tokenUsage: { last: { inputTokens: 5, outputTokens: 7, totalTokens: 12 }, total: { inputTokens: 20, outputTokens: 30, totalTokens: 50 }, modelContextWindow: 1000 } })
      notify('future/newNotification', { turnId, safe: 'retained', token: 'never-public', url: 'https://example.test/path?secret=never-public' })
      done(); break
    }
    case 'turn/steer': reply({ turnId: mode === 'steer-mismatch' ? 'native-unrelated' : msg.params.expectedTurnId }); if (mode === 'timing') done(); break
    case 'turn/interrupt': reply({}); notify('turn/completed', { turn: { id: turnId, status: 'interrupted', items: [] } }); break
    case 'thread/settings/update':
      if (mode === 'missing-optional') send({ id: msg.id, error: { code: -32601, message: 'No method' } }); else reply({}); break
    case 'thread/revert':
      if (mode === 'timeout-revert') break
      if (mode === 'missing-optional') send({ id: msg.id, error: { code: -32601, message: 'No method' } }); else { allowedHistory = []; reply({ thread: { id: threadId } }) }; break
    case 'thread/rollback': allowedHistory = []; reply({ thread: { id: threadId } }); break
    case 'thread/read': reply({ thread: { id: threadId, status: { type: mode === 'not-loaded' ? 'notLoaded' : mode === 'still-active' ? 'active' : 'idle' }, turns: allowedHistory.map((id, i) => ({ id, status: 'completed', items: [{ id: 'reused', type: 'agentMessage', text: `history ${i}` }] })) } }); break
    case 'thread/turns/list': if (mode === 'turns-paged' && !msg.params.cursor) reply({ data: [{ id: 'native-turn-1', status: 'completed', items: [] }], nextCursor: 'page-two' }); else reply({ data: ['native-turn-1','native-turn-2'].map(id => ({ id, status: 'completed', items: [] })), nextCursor: null }); break
    case 'thread/items/list': if (mode === 'no-history') { send({ id: msg.id, error: { code: -32601, message: 'No optional native history method' } }); break }; if (!allowedHistory.length) { reply({ data: [], nextCursor: null }); break }; reply({ data: [{ turnId: msg.params.cursor ? allowedHistory[1] : allowedHistory[0], ...(mode === 'timing' ? { startedAtMs: Date.parse(msg.params.cursor ? '2026-10-28T01:01:03Z' : '2026-10-28T01:00:03Z'), completedAtMs: Date.parse('2026-10-28T01:02:00Z') } : {}), item: { id: 'reused', type: 'agentMessage', text: msg.params.cursor ? 'two' : 'one' } }], nextCursor: msg.params.cursor || allowedHistory.length < 2 ? null : 'page-two' }); break
    case 'thread/goal/set': reply({ goal: { objective: msg.params.objective ?? 'goal', status: 'active' } }); break
    case 'thread/goal/clear': reply({ cleared: true }); break
    case 'thread/compact/start': reply({}); if (mode === 'compact-hang') break; notify('turn/started', { turn: { id: 'compact-turn', status: 'inProgress', items: [] } }); setTimeout(() => notify('thread/compacted', { turnId: 'compact-turn' }), 10); break
    case 'thread/unsubscribe': reply({ status: 'unsubscribed' }); break
    default: send({ id: msg.id, error: { code: -32601, message: 'Method missing' } })
  }
}
