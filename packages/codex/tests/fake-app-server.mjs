import readline from 'node:readline'
import { appendFileSync } from 'node:fs'
const mode = process.env.FAKE_SCENARIO ?? 'normal'
const threadId = 'native-thread'
let currentTurnId = 'native-turn-1'
let counter = 0
let allowedHistory = ['native-turn-1','native-turn-2']
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const notify = (method, params) => send({ method, params: { threadId, ...params } })
const emitFinalAnswerAndCompleteCurrentTurn = () => {
  notify('item/completed', { turnId: currentTurnId, item: { id: 'message', type: 'agentMessage', text: 'authoritative final', phase: 'final_answer' } })
  notify('turn/completed', { turn: { id: currentTurnId, status: 'completed', items: [] } })
}

function createServerRequestForScenario(scenario) {
  switch (scenario) {
    case 'fileapproval':
      return {
        method: 'item/fileChange/requestApproval',
        params: { itemId: 'tool', reason: 'file write' },
      }
    case 'approval':
      return {
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'tool', command: 'echo test', availableDecisions: ['accept','decline'] },
      }
    case 'policy':
      return {
        method: 'item/commandExecution/requestApproval',
        params: {
          itemId: 'tool',
          command: 'echo test',
          availableDecisions: [{ acceptWithExecpolicyAmendment: { rule: 'trust' } }],
        },
      }
    case 'permission':
      return {
        method: 'item/permissions/requestApproval',
        params: { itemId: 'tool', permissions: { network: { enabled: true } } },
      }
    case 'questions':
      return {
        method: 'item/tool/requestUserInput',
        params: {
          itemId: 'tool',
          questions: [{ id: 'q', header: 'Pick', question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }],
        },
      }
    case 'elicitation':
      return {
        method: 'mcpServer/elicitation/request',
        params: { mode: 'url', url: 'https://auth.test/authorize?private=secret', message: 'Sign in', serverName: 'mcp' },
      }
    case 'dynamic':
      return {
        method: 'item/tool/call',
        params: { itemId: 'tool', tool: 'example', arguments: {} },
      }
    case 'unknown-request':
      return { method: 'future/approval', params: {} }
  }
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  let msg
  try { msg = JSON.parse(line) } catch { process.exit(2) }
  if (process.env.FAKE_LOG_FILE) appendFileSync(process.env.FAKE_LOG_FILE, line + '\n')
  const reply = result => send({ id: msg.id, result })
  if (!msg.method) { if (msg.id === 'server-request' || msg.id === 901) emitFinalAnswerAndCompleteCurrentTurn(); continue }
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
      if(mode==='hold'&&msg.method==='turn/start'&&counter>0){send({id:msg.id,error:{code:-32602,message:'Native busy'}});break}
      currentTurnId = msg.method === 'review/start' ? 'native-review' : `native-turn-${++counter}`
      notify('turn/started', { turn: { id: currentTurnId, status: 'inProgress', items: [] } })
      reply({ turn: { id: currentTurnId, status: 'inProgress', items: [] } })
      if (mode === 'titles') {
        send({ method: 'thread/name/updated', params: { threadId: 'unrelated', threadName: 'Wrong title' } })
        notify('thread/name/updated', { threadName: 'Native title' })
        notify('thread/name/updated', { threadName: 'Native title' })
        emitFinalAnswerAndCompleteCurrentTurn()
        notify('thread/name/updated', {})
        break
      }
      if (mode === 'auth-expired') { notify('turn/completed', { turn: { id: currentTurnId, status: 'failed', error: { codexErrorInfo: 'unauthorized', message: 'PRIVATE_PROVIDER_DIAGNOSTIC https://auth.test/?token=private' } } }); break }
      if (mode === 'workflow-schema') {
        const schema = msg.params.outputSchema
        notify('item/completed', { turnId: currentTurnId, item: { id: 'message', type: 'agentMessage', text: JSON.stringify({ answer: schema?.properties?.answer?.const ?? 42 }), phase: 'final_answer' } })
        notify('turn/completed', { turn: { id: currentTurnId, status: 'completed', items: [] } })
        break
      }
      if (mode === 'disconnect') { setTimeout(() => process.exit(0), 10); break }
      if (mode === 'backpressure') { setTimeout(() => process.stdout.write(JSON.stringify({ method: 'future/big', params: { text: 'x'.repeat(100000) } }) + '\n'), 10); break }
      if (mode === 'timing') {
        const startedAtMs = Date.parse('2026-10-28T01:00:03Z') + (counter - 1) * 60000
        notify('item/started', { turnId: currentTurnId, startedAtMs, item: { id: 'message', type: 'agentMessage', text: '', phase: 'final_answer' } })
        notify('item/agentMessage/delta', { turnId: currentTurnId, itemId: 'message', delta: 'Partial answer' })
        notify('item/started', { turnId: currentTurnId, startedAtMs: startedAtMs + 1000, item: { id: 'message', type: 'agentMessage', text: 'Repeated start', phase: 'final_answer' } })
        break
      }
      if (mode === 'file-change') {
        const changes = [{ path: '/workspace/old.ts', kind: { type: 'update', move_path: '/workspace/new.ts' }, diff: '@@ -56,3 +56,3 @@\n context\n-old\n+new\n end\n' }]
        notify('item/fileChange/outputDelta', { turnId: currentTurnId, itemId: 'edit', delta: 'Applying patch…\n' })
        notify('item/started', { turnId: currentTurnId, item: { id: 'edit', type: 'fileChange', status: 'inProgress', changes } })
        notify('item/completed', { turnId: currentTurnId, item: { id: 'edit', type: 'fileChange', status: 'completed', changes } })
        emitFinalAnswerAndCompleteCurrentTurn(); break
      }
      if (mode === 'unknown-item') notify('item/completed', { turnId: currentTurnId, item: { id: 'future', type: 'brandNew', safe: 'kept' } })
      if (mode === 'error-notice') { notify('error', { turnId: currentTurnId, message: 'Native subsystem failed' }); emitFinalAnswerAndCompleteCurrentTurn(); break }
      if (mode === 'hold' || mode === 'timeout-revert' || mode === 'missing-optional') break
      if (['approval','fileapproval','permission','questions','elicitation','dynamic','policy','unknown-request'].includes(mode)) {
        const req = createServerRequestForScenario(mode)
        send({ id: mode === 'permission' ? 901 : 'server-request', ...req, params: { threadId, turnId: currentTurnId, ...req.params } }); break
      }
      notify('item/started', { turnId: currentTurnId, item: { id: 'message', type: 'agentMessage', text: '', phase: 'commentary' } })
      const notificationLine = JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId, turnId: currentTurnId, itemId: 'message', delta: 'hello 日本語' } }) + '\n'
      const notificationBytes = Buffer.from(notificationLine)
      // Split inside 本's UTF-8 bytes, after its second byte.
      const splitOffset = notificationBytes.length - 8
      process.stdout.write(notificationBytes.subarray(0, splitOffset))
      process.stdout.write(notificationBytes.subarray(splitOffset))
      notify('item/completed', { turnId: currentTurnId, item: { id: 'reason', type: 'reasoning', summary: ['summary'], content: ['allowed content'] } })
      notify('item/completed', { turnId: currentTurnId, item: { id: 'shell', type: 'commandExecution', command: 'echo test', status: 'completed', aggregatedOutput: 'test', durationMs: 2 } })
      notify('item/completed', { turnId: currentTurnId, item: { id: 'collab', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child-a','child-b'], agentsStates: { 'child-a': { status: 'completed' }, 'child-b': { status: 'running' } }, status: 'completed' } })
      notify('hook/started', { turnId: currentTurnId, hook: { id: 'hook-a', name: 'PreToolUse' } })
      notify('hook/completed', { turnId: currentTurnId, hook: { id: 'hook-a', name: 'PreToolUse', output: {} } })
      notify('turn/plan/updated', { turnId: currentTurnId, plan: [{ step: 'One', status: 'inProgress' }] })
      notify('turn/plan/updated', { turnId: currentTurnId, plan: [{ step: 'One', status: 'completed' }] })
      notify('thread/tokenUsage/updated', { turnId: currentTurnId, tokenUsage: { last: { inputTokens: 5, outputTokens: 7, totalTokens: 12 }, total: { inputTokens: 20, outputTokens: 30, totalTokens: 50 }, modelContextWindow: 1000 } })
      notify('future/newNotification', { turnId: currentTurnId, safe: 'retained', token: 'never-public', url: 'https://example.test/path?secret=never-public' })
      emitFinalAnswerAndCompleteCurrentTurn(); break
    }
    case 'turn/steer': reply({ turnId: mode === 'steer-mismatch' ? 'native-unrelated' : msg.params.expectedTurnId }); if (mode === 'timing') emitFinalAnswerAndCompleteCurrentTurn(); break
    case 'turn/interrupt': reply({}); notify('turn/completed', { turn: { id: currentTurnId, status: 'interrupted', items: [] } }); break
    case 'thread/settings/update':
      if (mode === 'missing-optional') send({ id: msg.id, error: { code: -32601, message: 'No method' } }); else reply({}); break
    case 'thread/revert':
      if (mode === 'timeout-revert') break
      if (mode === 'missing-optional') send({ id: msg.id, error: { code: -32601, message: 'No method' } }); else { allowedHistory = []; reply({ thread: { id: threadId } }) }; break
    case 'thread/rollback': allowedHistory = []; reply({ thread: { id: threadId } }); break
    case 'thread/read': reply({ thread: { id: threadId, status: { type: mode === 'not-loaded' ? 'notLoaded' : mode === 'still-active' ? 'active' : 'idle' }, turns: allowedHistory.map((id, i) => ({ id, status: 'completed', items: [{ id: 'reused', type: 'agentMessage', text: `history ${i}` }] })) } }); break
    case 'thread/turns/list': if (mode === 'turns-paged' && !msg.params.cursor) reply({ data: [{ id: 'native-turn-1', status: 'completed', items: [] }], nextCursor: 'page-two' }); else reply({ data: ['native-turn-1','native-turn-2'].map(id => ({ id, status: 'completed', items: [] })), nextCursor: null }); break
    case 'thread/items/list': {
      if (mode === 'no-history') {
        send({ id: msg.id, error: { code: -32601, message: 'No optional native history method' } })
        break
      }
      if (!allowedHistory.length) {
        reply({ data: [], nextCursor: null })
        break
      }
      const isSecondPage = Boolean(msg.params.cursor)
      const historyTurnId = isSecondPage ? allowedHistory[1] : allowedHistory[0]
      const timingFields = mode === 'timing' ? {
        startedAtMs: Date.parse(isSecondPage ? '2026-10-28T01:01:03Z' : '2026-10-28T01:00:03Z'),
        completedAtMs: Date.parse('2026-10-28T01:02:00Z'),
      } : {}
      const nextCursor = isSecondPage || allowedHistory.length < 2 ? null : 'page-two'
      reply({
        data: [{
          turnId: historyTurnId,
          ...timingFields,
          item: { id: 'reused', type: 'agentMessage', text: isSecondPage ? 'two' : 'one' },
        }],
        nextCursor,
      })
      break
    }
    case 'thread/goal/set': reply({ goal: { objective: msg.params.objective ?? 'goal', status: 'active' } }); break
    case 'thread/goal/clear': reply({ cleared: true }); break
    case 'thread/compact/start': reply({}); if (mode === 'compact-hang') break; notify('turn/started', { turn: { id: 'compact-turn', status: 'inProgress', items: [] } }); setTimeout(() => {notify('thread/compacted', { turnId: 'compact-turn' });notify('turn/completed',{turn:{id:'compact-turn',status:'completed'}})}, 10); break
    case 'thread/unsubscribe': reply({ status: 'unsubscribed' }); break
    default: send({ id: msg.id, error: { code: -32601, message: 'Method missing' } })
  }
}
