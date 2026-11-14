/** Implements scenario-driven native stdio responses for adapter, catalog and conformance tests; it must not execute tools or access real accounts. */
import readline from 'node:readline'
import { appendFileSync } from 'node:fs'
const mode = process.env.FAKE_SCENARIO ?? 'normal'
// A fixture process owns one thread; turn identity and visible history must survive sequential requests.
const threadId = 'native-thread'
let currentTurnId = 'native-turn-1'
let counter = 0
let allowedHistory = ['native-turn-1','native-turn-2']
/** For fixture emitters, serialize a supplied frame to stdout in call order and return its backpressure boolean without waiting for drain. Serialization errors throw; stream failures remain process errors. */
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
/** For scenario handlers, write a method/params notification scoped to this fixture thread without awaiting interaction answers. Supplied params retain override precedence; stdout/serialization failures propagate. */
const notify = (method, params) => send({ method, params: { threadId, ...params } })
/** For scenario emission and interaction replies, write final output then completion for the current process-owned turn. This ordering makes the authoritative item visible before the terminal event; stream errors propagate. */
const emitFinalAnswerAndCompleteCurrentTurn = () => {
  notify('item/completed', { turnId: currentTurnId, item: { id: 'message', type: 'agentMessage', text: 'authoritative final', phase: 'final_answer' } })
  notify('turn/completed', { turn: { id: currentTurnId, status: 'completed', items: [] } })
}

/** For emitTurnScenario, return the interactive method/params for a supported scenario, or undefined for a non-interactive one. No I/O; keeping membership here prevents dispatch and payload definitions from drifting apart. */
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

/** For request handlers, write a result correlated to the supplied input message. No state changes beyond stdout; stream/serialization errors propagate and callers control notification ordering. */
function sendResult(msg, result) {
  send({ id: msg.id, result })
}

/** For turn/start and review/start, reject a busy held turn or allocate the next turn, notify before acknowledging, then emit its scenario. Mutates process-owned turn identity/counter; write failures propagate. */
function startTurn(msg) {
  if (mode === 'hold' && msg.method === 'turn/start' && counter > 0) {
    send({ id: msg.id, error: { code: -32602, message: 'Native busy' } })
    return
  }
  currentTurnId = msg.method === 'review/start' ? 'native-review' : `native-turn-${++counter}`
  // Clients must tolerate a native start notification arriving before the RPC result.
  notify('turn/started', { turn: { id: currentTurnId, status: 'inProgress', items: [] } })
  sendResult(msg, { turn: { id: currentTurnId, status: 'inProgress', items: [] } })
  emitTurnScenario(msg)
}

/** For startTurn, emit the configured scenario after its start acknowledgement. Some modes intentionally stay pending or schedule a delayed exit/oversized frame; interactions complete only when handleMessage receives their response. Writes can throw. */
function emitTurnScenario(msg) {
  switch (mode) {
    case 'titles':
      send({ method: 'thread/name/updated', params: { threadId: 'unrelated', threadName: 'Wrong title' } })
      notify('thread/name/updated', { threadName: 'Native title' })
      notify('thread/name/updated', { threadName: 'Native title' })
      emitFinalAnswerAndCompleteCurrentTurn()
      notify('thread/name/updated', {})
      return
    case 'auth-expired':
      notify('turn/completed', { turn: { id: currentTurnId, status: 'failed', error: { codexErrorInfo: 'unauthorized', message: 'PRIVATE_PROVIDER_DIAGNOSTIC https://auth.test/?token=private' } } })
      return
    case 'workflow-schema': {
      const schema = msg.params.outputSchema
      notify('item/completed', { turnId: currentTurnId, item: { id: 'message', type: 'agentMessage', text: JSON.stringify({ answer: schema?.properties?.answer?.const ?? 42 }), phase: 'final_answer' } })
      notify('turn/completed', { turn: { id: currentTurnId, status: 'completed', items: [] } })
      return
    }
    case 'disconnect':
      setTimeout(() => process.exit(0), 10)
      return
    case 'backpressure':
      setTimeout(() => process.stdout.write(JSON.stringify({ method: 'future/big', params: { text: 'x'.repeat(100000) } }) + '\n'), 10)
      return
    case 'timing': {
      const startedAtMs = Date.parse('2026-10-28T01:00:03Z') + (counter - 1) * 60000
      notify('item/started', { turnId: currentTurnId, startedAtMs, item: { id: 'message', type: 'agentMessage', text: '', phase: 'final_answer' } })
      notify('item/agentMessage/delta', { turnId: currentTurnId, itemId: 'message', delta: 'Partial answer' })
      notify('item/started', { turnId: currentTurnId, startedAtMs: startedAtMs + 1000, item: { id: 'message', type: 'agentMessage', text: 'Repeated start', phase: 'final_answer' } })
      return
    }
    case 'file-change': {
      const changes = [{ path: '/workspace/old.ts', kind: { type: 'update', move_path: '/workspace/new.ts' }, diff: '@@ -56,3 +56,3 @@\n context\n-old\n+new\n end\n' }]
      notify('item/fileChange/outputDelta', { turnId: currentTurnId, itemId: 'edit', delta: 'Applying patch…\n' })
      notify('item/started', { turnId: currentTurnId, item: { id: 'edit', type: 'fileChange', status: 'inProgress', changes } })
      notify('item/completed', { turnId: currentTurnId, item: { id: 'edit', type: 'fileChange', status: 'completed', changes } })
      emitFinalAnswerAndCompleteCurrentTurn()
      return
    }
    case 'unknown-item':
      notify('item/completed', { turnId: currentTurnId, item: { id: 'future', type: 'brandNew', safe: 'kept' } })
      break
    case 'error-notice':
      notify('error', { turnId: currentTurnId, message: 'Native subsystem failed' })
      emitFinalAnswerAndCompleteCurrentTurn()
      return
    case 'hold': case 'timeout-revert': case 'missing-optional':
      return
  }
  const request = createServerRequestForScenario(mode)
  if (request) {
    send({ id: mode === 'permission' ? 901 : 'server-request', ...request, params: { threadId, turnId: currentTurnId, ...request.params } })
    return
  }
  emitDefaultTurnTranscript()
}

/** For non-interactive scenarios, write the ordered normal transcript through authoritative completion. Own the split UTF-8 buffers locally so fixture framing changes cannot affect other scenarios; stdout errors propagate. */
function emitDefaultTurnTranscript() {
  notify('item/started', { turnId: currentTurnId, item: { id: 'message', type: 'agentMessage', text: '', phase: 'commentary' } })
  const notificationLine = JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId, turnId: currentTurnId, itemId: 'message', delta: 'hello 日本語' } }) + '\n'
  const notificationBytes = Buffer.from(notificationLine)
  // Split inside 本's UTF-8 bytes to exercise decoding across writes, rather than splitting only at frame boundaries.
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
  emitFinalAnswerAndCompleteCurrentTurn()
}

/** For account/read, write the configured read-only account response, or leave timeout mode pending. No real authentication occurs; write failures propagate to the fixture process. */
function sendAccountStatus(msg) {
  switch (mode) {
    case 'auth-timeout': return
    case 'auth-unavailable':
      send({ id: msg.id, error: { code: -32601, message: 'No account method' } })
      return
    case 'auth-not-required':
      sendResult(msg, { account: null, requiresOpenaiAuth: false })
      return
    case 'auth-malformed':
      sendResult(msg, {})
      return
    default:
      sendResult(msg, mode === 'auth-required' ? { account: null, requiresOpenaiAuth: true } : { account: { type: 'apiKey' }, requiresOpenaiAuth: true })
  }
}

/** For thread/items/list, page the process's currently visible history, retaining reused item IDs and optional native timestamps. No history mutation; unsupported mode emits an RPC error and stdout failures propagate. */
function sendHistoryItems(msg) {
  if (mode === 'no-history') {
    send({ id: msg.id, error: { code: -32601, message: 'No optional native history method' } })
    return
  }
  if (!allowedHistory.length) {
    sendResult(msg, { data: [], nextCursor: null })
    return
  }
  const isSecondPage = Boolean(msg.params.cursor)
  const historyTurnId = isSecondPage ? allowedHistory[1] : allowedHistory[0]
  const timingFields = mode === 'timing' ? {
    startedAtMs: Date.parse(isSecondPage ? '2026-10-28T01:01:03Z' : '2026-10-28T01:00:03Z'),
    completedAtMs: Date.parse('2026-10-28T01:02:00Z'),
  } : {}
  const nextCursor = isSecondPage || allowedHistory.length < 2 ? null : 'page-two'
  sendResult(msg, {
    data: [{
      turnId: historyTurnId,
      ...timingFields,
      item: { id: 'reused', type: 'agentMessage', text: isSecondPage ? 'two' : 'one' },
    }],
    nextCursor,
  })
}

/** For model/list, emit hidden entries only when requested, or deliberately stall/repeat the cursor for discovery failure tests. No model state is retained; writes can throw. */
function sendModels(msg) {
  if (mode === 'model-hang') return
  if (mode === 'model-loop') {
    sendResult(msg, { data: [{ id: 'test-model', displayName: 'Test model' }], nextCursor: 'loop' })
    return
  }
  sendResult(msg, { data: [
    { id: 'test-model', displayName: 'Test model' },
    { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', isDefault: true, hidden: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }, { reasoningEffort: 'ultra', description: 'Deepest' }], serviceTiers: [{ id: 'standard' }, { id: 'priority' }] },
    ...(msg.params?.includeHidden ? [{ id: 'gpt-reserve', displayName: 'GPT-Reserve', hidden: true }] : []),
  ], nextCursor: null })
}

/** For native thread start/resume/fork, reject the configured start failure before mutation, otherwise update fork-visible history and reply with identity/title. State changes precede the write and write failures escape. */
function openThread(msg) {
  if (mode === 'open-fail' && msg.method === 'thread/start') {
    send({ id: msg.id, error: { code: -32000, message: 'thread start failed' } })
    return
  }
  if (msg.method === 'thread/fork') allowedHistory = msg.params.beforeTurnId ? [] : [msg.params.lastTurnId]
  sendResult(msg, { thread: { id: threadId, ...(mode === 'titles' ? { name: 'Restored title' } : {}) } })
}

/** Dispatch one parsed input synchronously, mutating this fixture's thread/turn history and writing ordered responses. Interaction answers complete the current turn, initialized is ignored, and unknown methods get fixture errors. Handler/write failures escape to the process. */
function handleMessage(msg) {
  if (!msg.method) {
    if (msg.id === 'server-request' || msg.id === 901) emitFinalAnswerAndCompleteCurrentTurn()
    return
  }
  if (msg.method === 'initialized') return
  switch (msg.method) {
    case 'account/read':
      sendAccountStatus(msg)
      break
    case 'model/list':
      sendModels(msg)
      break
    case 'initialize':
      sendResult(msg, { userAgent: 'codex/0.164.0' })
      break
    case 'thread/start': case 'thread/resume': case 'thread/fork':
      openThread(msg)
      break
    case 'turn/start': case 'review/start':
      startTurn(msg)
      break
    case 'turn/steer':
      sendResult(msg, { turnId: mode === 'steer-mismatch' ? 'native-unrelated' : msg.params.expectedTurnId })
      if (mode === 'timing') emitFinalAnswerAndCompleteCurrentTurn()
      break
    case 'turn/interrupt':
      sendResult(msg, {})
      notify('turn/completed', { turn: { id: currentTurnId, status: 'interrupted', items: [] } })
      break
    case 'thread/settings/update':
      if (mode === 'missing-optional') send({ id: msg.id, error: { code: -32601, message: 'No method' } })
      else sendResult(msg, {})
      break
    case 'thread/revert':
      if (mode === 'timeout-revert') break
      if (mode === 'missing-optional') send({ id: msg.id, error: { code: -32601, message: 'No method' } })
      else {
        allowedHistory = []
        sendResult(msg, { thread: { id: threadId } })
      }
      break
    case 'thread/rollback':
      allowedHistory = []
      sendResult(msg, { thread: { id: threadId } })
      break
    case 'thread/read':
      sendResult(msg, { thread: { id: threadId, status: { type: mode === 'not-loaded' ? 'notLoaded' : mode === 'still-active' ? 'active' : 'idle' }, turns: allowedHistory.map((id, i) => ({ id, status: 'completed', items: [{ id: 'reused', type: 'agentMessage', text: `history ${i}` }] })) } })
      break
    case 'thread/turns/list':
      if (mode === 'turns-paged' && !msg.params.cursor) sendResult(msg, { data: [{ id: 'native-turn-1', status: 'completed', items: [] }], nextCursor: 'page-two' })
      else sendResult(msg, { data: ['native-turn-1','native-turn-2'].map(id => ({ id, status: 'completed', items: [] })), nextCursor: null })
      break
    case 'thread/items/list':
      sendHistoryItems(msg)
      break
    case 'thread/goal/set':
      sendResult(msg, { goal: { objective: msg.params.objective ?? 'goal', status: 'active' } })
      break
    case 'thread/goal/clear':
      sendResult(msg, { cleared: true })
      break
    case 'thread/compact/start':
      sendResult(msg, {})
      if (mode === 'compact-hang') break
      notify('turn/started', { turn: { id: 'compact-turn', status: 'inProgress', items: [] } })
      /** Timer callback publishes compaction before completion without changing currentTurnId; the delay forces callers to await events after acknowledgement. Stdout failures escape to the process. */
      setTimeout(() => {
        notify('thread/compacted', { turnId: 'compact-turn' })
        notify('turn/completed', { turn: { id: 'compact-turn', status: 'completed' } })
      }, 10)
      break
    case 'thread/unsubscribe':
      sendResult(msg, { status: 'unsubscribed' })
      break
    default:
      send({ id: msg.id, error: { code: -32601, message: 'Method missing' } })
  }
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  let msg
  try { msg = JSON.parse(line) } catch { process.exit(2) }
  // Record input before dispatch so assertions see requests even when their scenario deliberately never replies.
  if (process.env.FAKE_LOG_FILE) appendFileSync(process.env.FAKE_LOG_FILE, line + '\n')
  handleMessage(msg)
}
