/** Implements scenario-driven native stdio responses for adapter, catalog and conformance tests; it must not execute tools or access real accounts. */
import readline from 'node:readline'
import { appendFileSync } from 'node:fs'
const mode = process.env.FAKE_SCENARIO ?? 'normal'
// A fixture process owns one thread; turn identity and visible history must survive sequential requests.
const threadId = 'native-thread'
let currentTurnId = 'native-turn-1'
let counter = 0
let allowedHistory = ['native-turn-1','native-turn-2']
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
  if (mode === 'subagent-denial' && msg.method === 'turn/start') {
    send({ id: msg.id, error: { code: -32600, message: 'direct app-server input is not allowed for multi-agent v2 sub-agents' } })
    return
  }
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
    case 'native-hooks': {
      const setup = { turnId: null, run: { id: 'session-hook', eventName: 'SessionStart', status: 'completed', entries: [] } }
      notify('hook/completed', setup)
      const run = { id: 'turn-hook', eventName: 'PreToolUse', status: 'running', entries: [] }
      notify('hook/started', { turnId: currentTurnId, run })
      notify('hook/completed', { turnId: currentTurnId, run: { ...run, status: 'blocked', durationMs: 5, entries: [{ kind: 'feedback', text: 'denied' }] } })
      emitFinalAnswerAndCompleteCurrentTurn()
      return
    }
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
    case 'subagent-discovery': {
      // Real wire shape carries only the thread object; a defensive variant repeats the child id at
      // the top level, and the parent's own started notification must stay silent.
      send({ method: 'thread/started', params: { thread: { id: 'child-1', parentThreadId: threadId, agentNickname: 'Scout', agentRole: 'researcher', forkedFromId: threadId } } })
      send({ method: 'thread/started', params: { threadId: 'child-2', thread: { id: 'child-2', parentThreadId: threadId, agentNickname: 'Mapper' } } })
      send({ method: 'thread/started', params: { thread: { id: threadId } } })
      // Foreign-thread item evidence must keep dropping through the thread-scope filter.
      send({ method: 'item/started', params: { threadId: 'child-9', turnId: 'foreign-turn', item: { id: 'foreign', type: 'agentMessage', text: 'foreign' } } })
      notify('item/started', { turnId: currentTurnId, item: { id: 'act-1', type: 'subAgentActivity', kind: 'started', agentThreadId: 'child-1', agentPath: '/root/scout', model: 'gpt-test', reasoningEffort: 'low' } })
      // The completed activity lands after its spawning turn completed and must keep that attribution.
      notify('turn/completed', { turn: { id: currentTurnId, status: 'completed', items: [] } })
      notify('item/completed', { turnId: currentTurnId, item: { id: 'act-1', type: 'subAgentActivity', kind: 'completed', agentThreadId: 'child-1', agentPath: '/root/scout' } })
      return
    }
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
  /** Oversized replay: two ~160KiB command outputs plus a small message, served in one native page so adapters must cap items and budget public pages themselves. */
  if (mode === 'oversized-history') {
    if (msg.params.cursor) { sendResult(msg, { data: [], nextCursor: null }); return }
    sendResult(msg, { data: [
      { turnId: 'native-turn-1', item: { id: 'big-one', type: 'commandExecution', status: 'completed', command: 'one', aggregatedOutput: 'x'.repeat(160 * 1024) } },
      { turnId: 'native-turn-1', item: { id: 'big-two', type: 'commandExecution', status: 'completed', command: 'two', aggregatedOutput: 'y'.repeat(160 * 1024) } },
      { turnId: 'native-turn-1', item: { id: 'small', type: 'agentMessage', text: 'done' } },
    ], nextCursor: null })
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
      if (mode === 'model-hang') break
      if (mode === 'model-loop') {
        sendResult(msg, { data: [{ id: 'test-model', displayName: 'Test model' }], nextCursor: 'loop' })
        break
      }
      sendResult(msg, { data: [
        { id: 'test-model', displayName: 'Test model', description: 'Native task description', inputModalities: ['text', 'image'] },
        { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', isDefault: true, hidden: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }, { reasoningEffort: 'ultra', description: 'Deepest' }], serviceTiers: [{ id: 'standard' }, { id: 'priority' }] },
        ...(msg.params?.includeHidden ? [{ id: 'gpt-reserve', displayName: 'GPT-Reserve', hidden: true }] : []),
      ], nextCursor: null })
      break
    case 'initialize':
      sendResult(msg, { userAgent: 'codex/0.164.0' })
      break
    case 'thread/start': case 'thread/resume': case 'thread/fork':
      if (mode === 'open-fail' && msg.method === 'thread/start') {
        send({ id: msg.id, error: { code: -32000, message: 'thread start failed' } })
        break
      }
      if (msg.method === 'thread/fork') allowedHistory = msg.params.beforeTurnId ? [] : [msg.params.lastTurnId]
      sendResult(msg, { thread: {
        id: threadId,
        ...(mode === 'titles' ? { name: 'Restored title' } : {}),
        ...(mode === 'subagent-owned' ? { parentThreadId: 'root-thread', agentNickname: 'Scout', agentRole: 'researcher', canAcceptDirectInput: false } : {}),
      } })
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
    case 'thread/list':
      if (mode === 'no-threads') {
        send({ id: msg.id, error: { code: -32601, message: 'No optional native thread method' } })
        break
      }
      if (mode === 'threads-badentry') {
        sendResult(msg, { data: [{ id: 'ok', status: { type: 'idle' } }, { nope: true }], nextCursor: null })
        break
      }
      if (mode === 'threads-relations') {
        if (msg.params?.parentThreadId) sendResult(msg, { data: [{ id: 'child-1', parentThreadId: msg.params.parentThreadId, status: { type: 'notLoaded' } }], nextCursor: null })
        else if (msg.params?.ancestorThreadId) sendResult(msg, { data: [
          { id: 'child-1', parentThreadId: msg.params.ancestorThreadId, status: { type: 'notLoaded' } },
          { id: 'grand-child', parentThreadId: 'child-1', status: { type: 'notLoaded' } },
        ], nextCursor: 'page-two' })
        else sendResult(msg, { data: [{ id: 'native-thread', status: { type: 'idle' }, name: 'Main', preview: 'working' }], nextCursor: null })
        break
      }
      if (mode === 'subagent-discovery') {
        // The page lacks locally observed nickname/role evidence so the adapter must enrich it.
        sendResult(msg, { data: [
          { id: 'child-1', parentThreadId: threadId, status: { type: 'notLoaded' } },
          { id: 'child-2', parentThreadId: threadId, status: { type: 'notLoaded' }, agentRole: 'native-role' },
        ], nextCursor: null })
        break
      }
      sendResult(msg, { data: [
        { id: 'native-thread', status: { type: 'idle' }, name: 'Main', preview: 'working' },
        { id: 'child-1', parentThreadId: 'native-thread', agentNickname: 'Scout', agentRole: 'researcher', status: { type: 'notLoaded' } },
        { id: 'child-2', parentThreadId: 'native-thread', status: { type: 'notLoaded' } },
      ], nextCursor: null })
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
