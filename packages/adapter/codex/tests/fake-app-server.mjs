/** Simulates the native stdio server for Codex adapter, catalog, conformance and workflow tests. */
import readline from 'node:readline'
import { appendFileSync } from 'node:fs'
const mode = process.env.FAKE_SCENARIO ?? 'normal'
// A fixture process owns one thread; turn identity and visible history must survive sequential requests.
const threadId = 'native-thread'
let currentTurnId = 'native-turn-1'
let currentGoal = null
let counter = 0
let allowedHistory = ['native-turn-1','native-turn-2']
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
/** Queue a notification with the fixture's thread ID as the default. Scenario params can override it to test thread filtering. */
const notify = (method, params) => send({ method, params: { threadId, ...params } })
/** Publish final text before completing the current turn so the adapter receives the authoritative item first. Omitted text uses the fixture's default answer. */
function emitFinalAnswerAndCompleteCurrentTurn(text = 'authoritative final') {
  notify('item/completed', { turnId: currentTurnId, item: { id: 'message', type: 'agentMessage', text, phase: 'final_answer' } })
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

/** Reject a fixture RPC with its original ID and the scenario's native code and message. Queues stdout without waiting for drain. */
function sendRpcError(msg, code, message) {
  send({ id: msg.id, error: { code, message } })
}

/** For turn/start and review/start, reject a busy held turn or allocate the next turn, notify before acknowledging, then emit its scenario. Mutates process-owned turn identity/counter; write failures propagate. */
function startTurn(msg) {
  if (mode === 'subagent-denial' && msg.method === 'turn/start') {
    send({ id: msg.id, error: { code: -32600, message: 'direct app-server input is not allowed for multi-agent v2 sub-agents' } })
    return
  }
  if (mode === 'hold' && msg.method === 'turn/start' && counter > 0) {
    sendRpcError(msg, -32602, 'Native busy')
    return
  }
  currentTurnId = msg.method === 'review/start' ? 'native-review' : `native-turn-${++counter}`
  // Clients must tolerate a native start notification arriving before the RPC result.
  notify('turn/started', { turn: { id: currentTurnId, status: 'inProgress', items: [] } })
  sendResult(msg, { turn: { id: currentTurnId, status: 'inProgress', items: [] } })
  emitTurnScenario(msg)
}

/** Emit the scenario after startTurn acknowledges the RPC. Some modes leave the turn pending or schedule exit or an oversized frame. Interactive scenarios wait for handleMessage to receive the response. */
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

    case 'native-hooks': {
      const setup = { turnId: null, run: { id: 'session-hook', eventName: 'SessionStart', status: 'completed', entries: [] } }
      notify('hook/completed', setup)
      const run = { id: 'turn-hook', eventName: 'PreToolUse', status: 'running', entries: [] }
      notify('hook/started', { turnId: currentTurnId, run })
      notify('hook/completed', { turnId: currentTurnId, run: { ...run, status: 'blocked', durationMs: 5, entries: [{ kind: 'feedback', text: 'denied' }] } })
      emitFinalAnswerAndCompleteCurrentTurn()
      return
    }
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
      emitFinalAnswerAndCompleteCurrentTurn(JSON.stringify({ answer: schema?.properties?.answer?.const ?? 42 }))
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
    case 'file-change':
    case 'file-change-late-events': {
      const changes = [{ path: '/workspace/old.ts', kind: { type: 'update', move_path: '/workspace/new.ts' }, diff: '@@ -56,3 +56,3 @@\n context\n-old\n+new\n end\n' }]
      notify('item/fileChange/outputDelta', { turnId: currentTurnId, itemId: 'edit', delta: 'Applying patch…\n' })
      notify('item/started', { turnId: currentTurnId, item: { id: 'edit', type: 'fileChange', status: 'inProgress', changes } })
      notify('item/completed', { turnId: currentTurnId, item: { id: 'edit', type: 'fileChange', status: 'completed', changes } })
      if (mode === 'file-change-late-events') {
        notify('item/fileChange/outputDelta', { turnId: currentTurnId, itemId: 'edit', delta: 'Late output' })
        notify('item/started', { turnId: currentTurnId, item: { id: 'edit', type: 'fileChange', status: 'inProgress', changes: [] } })
        notify('item/completed', { turnId: currentTurnId, item: { id: 'edit', type: 'fileChange', status: 'completed', changes: [] } })
      }
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
  // Split inside 本's UTF-8 bytes to exercise decoding across writes.
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
      sendRpcError(msg, -32601, 'No account method')
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
    sendRpcError(msg, -32601, 'No optional native history method')
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

/** For model/list, emit hidden entries only when requested, or deliberately stall/repeat the cursor for discovery failure tests. No model state is retained; writes can throw. */
function sendModels(msg) {
  if (mode === 'model-hang') return
  if (mode === 'model-loop') {
    sendResult(msg, { data: [{ id: 'test-model', displayName: 'Test model' }], nextCursor: 'loop' })
    return
  }
  sendResult(msg, { data: [
    { id: 'test-model', displayName: 'Test model', description: 'Native task description', inputModalities: ['text', 'image'] },
    { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', isDefault: true, hidden: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }, { reasoningEffort: 'ultra', description: 'Deepest' }], serviceTiers: [{ id: 'standard' }, { id: 'priority' }] },
    ...(msg.params?.includeHidden ? [{ id: 'gpt-reserve', displayName: 'GPT-Reserve', hidden: true }] : []),
  ], nextCursor: null })
}

/** For native thread start/resume/fork, reject the configured start failure before mutation, otherwise update fork-visible history and reply with identity/title. State changes precede the write and write failures escape. */
function openThread(msg) {
  if (mode === 'open-fail' && msg.method === 'thread/start') {
    sendRpcError(msg, -32000, 'thread start failed')
    return
  }
  if (msg.method === 'thread/fork') allowedHistory = msg.params.beforeTurnId ? [] : [msg.params.lastTurnId]
  sendResult(msg, { thread: {
    id: threadId,
    ...(mode === 'titles' ? { name: 'Restored title' } : {}),
    ...(mode === 'subagent-owned' ? { parentThreadId: 'root-thread', agentNickname: 'Scout', agentRole: 'researcher', canAcceptDirectInput: false } : {}),
  } })
}

/** For revert and rollback, clear visible history before acknowledging so later thread reads see the change. A write failure leaves the history cleared. */
function clearThreadHistory(msg) {
  allowedHistory = []
  sendResult(msg, { thread: { id: threadId } })
}

/** Simulate revert timing out or being unavailable without changing visible history. Otherwise apply the same history change as rollback. */
function revertThread(msg) {
  if (mode === 'timeout-revert') return
  if (mode === 'missing-optional') {
    sendRpcError(msg, -32601, 'No method')
    return
  }
  clearThreadHistory(msg)
}

/** Reply to thread/read with the scenario's status and current visible turns. Reuse item IDs across turns to exercise adapter history scoping. */
function sendThreadSnapshot(msg) {
  let type = 'idle'
  if (mode === 'not-loaded') type = 'notLoaded'
  else if (mode === 'still-active') type = 'active'
  const turns = allowedHistory.map((id, i) => ({
    id,
    status: 'completed',
    items: [{ id: 'reused', type: 'agentMessage', text: `history ${i}` }],
  }))
  sendResult(msg, { thread: { id: threadId, status: { type }, turns } })
}

/** Send a scripted thread/turns/list page. In turns-paged mode, the initial query advertises a cursor for the adapter to follow. Pages are independent of visible history. */
function sendTurnPage(msg) {
  if (mode === 'turns-paged' && !msg.params.cursor) {
    sendResult(msg, { data: [{ id: 'native-turn-1', status: 'completed', items: [] }], nextCursor: 'page-two' })
    return
  }
  const data = ['native-turn-1', 'native-turn-2'].map(id => ({ id, status: 'completed', items: [] }))
  sendResult(msg, { data, nextCursor: null })
}

/** Acknowledge compact/start before publishing maintenance events. The timer keeps acknowledgement and terminal evidence separate, and compact-hang leaves only the acknowledgement. */
function startCompaction(msg) {
  sendResult(msg, {})
  if (mode === 'compact-hang') return
  notify('turn/started', { turn: { id: 'compact-turn', status: 'inProgress', items: [] } })
  setTimeout(() => {
    notify('thread/compacted', { turnId: 'compact-turn' })
    notify('turn/completed', { turn: { id: 'compact-turn', status: 'completed' } })
  }, 10)
}

/** Dispatch one parsed input from stdin. A reply with a fixture interaction ID completes the current turn. The initialized notification needs no reply, and unknown methods get an RPC error. Synchronous handler failures escape to the process. */
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
      if (mode === 'missing-optional') sendRpcError(msg, -32601, 'No method')
      else sendResult(msg, {})
      break
    case 'thread/revert':
      revertThread(msg)
      break
    case 'thread/rollback':
      clearThreadHistory(msg)
      break
    case 'thread/read':
      sendThreadSnapshot(msg)
      break
    case 'thread/turns/list':
      sendTurnPage(msg)
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
      // threads-page answers relation-filtered queries from the tree fixture and keeps the default page for unfiltered ones.
      if (mode === 'threads-relations' || (mode === 'threads-page' && (msg.params?.parentThreadId || msg.params?.ancestorThreadId))) {
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
    case 'thread/goal/get':
      sendResult(msg, { goal: currentGoal })
      break
    case 'thread/goal/set': {
      currentGoal = { objective: msg.params.objective ?? currentGoal?.objective ?? 'goal', status: msg.params.status ?? 'active' }
      const result = currentGoal
      if (mode === 'goal-completes-before-reply') {
        currentGoal = { ...currentGoal, status: 'complete', tokensUsed: 42 }
        notify('thread/goal/updated', { goal: currentGoal, turnId: 'goal-turn' })
      }
      sendResult(msg, { goal: result })
      break
    }
    case 'thread/goal/clear':
      currentGoal = null
      sendResult(msg, { cleared: true })
      break
    case 'thread/compact/start':
      startCompaction(msg)
      break
    case 'thread/unsubscribe':
      sendResult(msg, { status: 'unsubscribed' })
      break
    default:
      sendRpcError(msg, -32601, 'Method missing')
  }
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  let msg
  try { msg = JSON.parse(line) } catch { process.exit(2) }
  // Record input before dispatch so assertions see requests even when their scenario deliberately never replies.
  if (process.env.FAKE_LOG_FILE) appendFileSync(process.env.FAKE_LOG_FILE, line + '\n')
  handleMessage(msg)
}
