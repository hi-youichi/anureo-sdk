import { randomUUID } from 'node:crypto'

// Shared executable: CLI invocations obtain one-use tickets; --server owns deterministic gateway state.
const scenario = process.env.FAKE_HERMES_SCENARIO ?? 'lifecycle'
const wire = 'hermes-gateway-v1'
if (!process.argv.includes('--server')) {
  if (process.env.FAKE_HERMES_HANG) { await new Promise(() => setInterval(() => {}, 1000)); process.exit(0) }
  if (process.env.FAKE_HERMES_LEGACY) { console.error('usage: hermes gateway {run,start,stop,status}'); process.exit(2) }
  if (process.env.FAKE_HERMES_BAD_STDOUT) { console.log('not a credential: this is invalid JSON'); process.exit(0) }
  if (process.env.FAKE_HERMES_STDERR) console.error(process.env.FAKE_HERMES_STDERR)
  const result = await fetch(process.env.FAKE_HERMES_URL + '/attach', { method: 'POST', body: JSON.stringify({ args: process.argv.slice(2) }) })
  console.log(await result.text())
  process.exit(0)
}

const responder = process.env.FAKE_HERMES_RESPONSE_MODULE ? await import(process.env.FAKE_HERMES_RESPONSE_MODULE) : null
const createParams = []
let epoch = 1, instance = 'owner-1', creates = 0, attaches = 0, interrupts = 0, disconnects = 0
const tickets = new Set(), sessions = new Map(), createIds = new Map(), methods = [], inputs = [], responses = [], attachArgs = []
const origins = [], upgrades = [], connections = new Set()
const send = (socket, frame) => { if (socket.readyState === 1) socket.send(JSON.stringify(frame)) }
const reply = (socket, id, result) => send(socket, { jsonrpc: '2.0', id, result })
const refuse = (socket, id, reason) => send(socket, { jsonrpc: '2.0', id, error: { code: 4001, message: reason, data: { reason } } })
/** Expose durable admission evidence without implying that queued input has an execution generation. */
const admission = value => ({ admission_id: value.id, ref: { profile_id: 'fake-profile', session_id: value.session.id }, sequence: value.sequence,
  status: value.status, outcome: value.outcome ?? null, authority_epoch: value.epoch ?? epoch, execution_generation: value.generation ?? null })
/** Append replay evidence before sending it to all viewers; an explicit null row produces session-only state. */
function publish(session, type, payload = {}, row = session.active) {
  const event = { type, session_id: session.id, payload, replay_epoch: session.replay, seq: ++session.seq,
    ...(row ? { authority_epoch: row.epoch ?? epoch, ...(row.generation !== undefined ? { execution_generation: row.generation } : {}), admission_id: row.id } : {}) }
  session.events.push(event)
  for (const socket of session.viewers) send(socket, { jsonrpc: '2.0', method: 'event', params: event })
  return event
}
/** Include native input identity so reconnect can associate accepted submissions whose ACK was lost. */
const pending = session => [...(session.active ? [session.active] : []), ...session.queue].map(row => ({ ...admission(row), input_id: row.inputId, text: row.text }))
/** Publish queue changes without attaching them to the active execution. */
const info = session => publish(session, 'session.info', { pending: pending(session), authority_epoch: epoch, execution_generation: session.generation, revision: session.generation, running: !!session.active }, null)
/** Capture attachment state at the current event watermark; the adapter must reconcile later live frames. */
const snapshot = (session, socket) => ({ session_id: session.id, stored_session_id: session.id, messages: [], messages_omitted: true,
  message_count: 0, running: !!session.active, authority_epoch: epoch, replay_epoch: session.replay, last_sequence: session.seq,
  subscription_id: socket.data.subscription, revision: session.generation, execution_generation: session.generation,
  pending: pending(session), prompts: [...session.prompts.values()], open_requests: [...session.requests.values()], info: { profile_id: 'fake-profile', title: 'Native title', model: 'fake-model' } })
/** Capture interrupt acknowledgement identity before finish can advance the FIFO to another generation. */
const handle = session => ({ ref: { profile_id: 'fake-profile', session_id: session.id }, instance_id: instance, authority_epoch: epoch,
  revision: session.generation, execution_generation: session.generation, execution_state: session.active ? 'running' : 'idle' })
/** Store terminal receipt evidence, publish completion and then claim the next FIFO row; repeated completion is ignored. */
function finish(row, status = 'complete', answer = 'authoritative final') {
  if (row.status === 'terminal') return
  const session = row.session
  row.status = 'terminal'; row.outcome = status === 'complete' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed'
  row.result = { final_response: answer, completed: status === 'complete', ...(status === 'error' ? { failed: true } : {}), ...(status === 'interrupted' ? { interrupted: true } : {}) }
  publish(session, 'message.complete', { text: answer, status, outcome: status === 'interrupted' ? 'cancelled' : row.outcome,
    usage: { input: 100, output: 20, total: 120 }, persisted_turn: { submission_id: row.inputId, row_ids: [session.seq], complete: true } }, row)
  session.active = null; session.prompts.clear(); session.requests.clear(); info(session)
  if (session.queue.length) start(session.queue.shift())
}
/** Lose observation without stopping execution, allowing replay/recovery scenarios to finish independently. */
function disconnect(session) {
  disconnects++
  for (const socket of session.viewers) socket.close()
}
/** Select deterministic progress/failure behavior for a claimed row; start schedules this after admission unless immediate is requested. */
function progress(row) {
  const s = row.session
  if (scenario === 'mcp') {
    void structuredOutput(row).catch(() => finish(row, 'error', 'MCP failed'))
    return
  }
  if (scenario === 'global-events') for (const socket of s.viewers) {
    send(socket, { jsonrpc: '2.0', method: 'event', params: { type: 'sessions.changed', session_id: '', payload: {} } })
  }
  publish(s, 'message.delta', { text: 'provisional ', segment: 0, offset: 0 })
  if (scenario === 'delta-replay') {
    publish(s, 'message.delta', { text: 'provisional ', segment: 0, offset: 0 })
    publish(s, 'message.delta', { text: 'visional continued', segment: 0, offset: 3 })
    finish(row); return
  }
  if (scenario === 'delta-gap') {
    publish(s, 'message.delta', { text: 'missing prefix', segment: 0, offset: 20 })
    publish(s, 'message.delta', { text: 'ignored after gap', segment: 0, offset: 12 })
    finish(row); return
  }
  if (scenario === 'delta-conflict') {
    publish(s, 'message.delta', { text: 'conflicting prefix', segment: 0, offset: 0 }); return
  }
  if (scenario === 'reconnect' || scenario === 'gap' || scenario === 'ack-lost' || scenario === 'unknown') {
    if (!row.disconnected) {
      row.disconnected = true; disconnect(s)
      if (scenario === 'unknown') {
        epoch++; instance = 'owner-2'; s.replay = 'replay-2'; s.seq = 0; s.events = []; row.status = 'unknown'
      } else setTimeout(() => finish(row), 10)
      return
    }
  }
  if (scenario === 'disconnect') { disconnect(s); return }
  if (scenario === 'backpressure') { publish(s, 'message.delta', { text: 'x'.repeat(8192) }); return }
  if (scenario === 'approval' || scenario === 'approval-reconnect') {
    const prompt = { kind: 'approval', prompt_id: 'approval-1', execution_generation: row.generation, choices: ['once', 'deny', 'session', 'always'], command: 'echo safe', timeout_s: 30 }
    s.prompts.set(prompt.prompt_id, prompt); publish(s, 'approval.request', prompt)
    if (scenario === 'approval-reconnect') disconnect(s)
    return
  }
  if (scenario === 'userInput' || scenario === 'clarify-cancel') {
    const prompt = { kind: 'clarify', prompt_id: 'clarify-1', execution_generation: row.generation, question: 'Choose?', choices: ['yes', 'no'] }
    s.prompts.set(prompt.prompt_id, prompt); publish(s, 'clarify.request', prompt); return
  }
  if (['batch', 'batch-reconnect', 'secret', 'secret-response-lost', 'unsupported-request'].includes(scenario)) {
    const method = scenario.startsWith('batch') ? 'clarify' : scenario.startsWith('secret') ? 'secret' : 'desktop.act'
    const params = { session_id: s.id, ...(method === 'clarify' ? { questions: [{ qid: 'q1', question: 'First?', choices: ['yes', 'no'] }, { qid: 'q2', question: 'Second?' }] }
      : { env_var: 'FAKE_VALUE', prompt: 'Enter the fake secret' }) }
    const request = { id: 'srq-1', method, params }; s.requests.set(request.id, request)
    for (const socket of s.viewers) send(socket, { jsonrpc: '2.0', ...request })
    if (scenario === 'batch-reconnect') disconnect(s)
    return
  }
  if (['hold', 'overlap', 'interrupt', 'close-active', 'observer-cancel', 'queued-cancel'].includes(scenario)) return
  if (responder) { finish(row, 'complete', responder.respond(row.text)); return }
  publish(s, 'reasoning.delta', { text: 'brief reasoning' })
  publish(s, 'tool.start', { tool_id: 'tool-1', name: 'future_unknown_tool', args: { query: 'safe' } })
  publish(s, 'tool.complete', { tool_id: 'tool-1', name: 'future_unknown_tool', result: { value: 42 } })
  publish(s, 'message.interim', { text: 'provisional ', already_streamed: true, segment: 0 })
  publish(s, 'message.delta', { text: 'not the final snapshot', segment: 1, offset: 0 })
  finish(row, scenario === 'failed' ? 'error' : 'complete')
}
/** Exercise the session's actual HTTP MCP bridge before terminal publication; progress maps any failure to a native failed turn. */
async function structuredOutput(row) {
  const server = row.session.mcpServers?.find(server => server.name === 'anureo_output')
  if (!server) throw new Error('missing MCP config')
  const outputId = row.text.match(/outputId: (anureo_output_[a-f0-9]{48})/)?.[1]
  /** Send one MCP request and surface transport/protocol failures to structuredOutput's terminal policy. */
  const rpc = async (id, method, params) => {
    const response = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...Object.fromEntries(server.headers.map(header => [header.name, header.value])) }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
    if (!response.ok) throw new Error('MCP HTTP failure')
    const message = await response.json()
    if (message.error) throw new Error('MCP protocol failure')
    return message.result
  }
  await rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake-hermes', version: '1' } })
  const tools = await rpc(2, 'tools/list', {})
  if (tools.tools[0]?.name !== 'submit_result') throw new Error('missing tool')
  const result = await rpc(3, 'tools/call', { name: 'submit_result', arguments: { outputId, value: { sum: 42 } } })
  if (result.isError) throw new Error('submission failed')
  finish(row, 'complete', 'MCP accepted')
}
/** Claim an execution generation before publishing progress; queued rows get no generation until this call. */
function start(row) {
  const s = row.session; s.active = row; row.status = 'started'; row.epoch = epoch; row.generation = ++s.generation
  publish(s, 'message.start', {}, row); info(s)
  if (scenario === 'immediate') progress(row)
  else setTimeout(() => progress(row), 10)
}
const NO_REPLY = Symbol()
/** Dispatch native RPCs, retaining mutation evidence even in scenarios that deliberately withhold the reply. */
async function request(socket, method, params) {
  methods.push(method)
  if (method === 'runtime.describe' && scenario === 'describe-hang') return NO_REPLY
  if (method === 'runtime.describe') return { instance_id: instance, profile_id: 'fake-profile', authority_epoch: epoch,
    capabilities: scenario === 'old-contract' ? [] : ['durable-admission-v1', 'event-replay-v1', 'local-cli-create-v1', ...(scenario === 'mcp' ? ['acp-session-mcp-v1'] : [])],
    session_create: { sources: ['tool', ...(scenario === 'mcp' ? ['acp'] : [])], parameters: ['request_id', 'source', 'cwd', 'model', 'client', ...(scenario === 'mcp' ? ['editor'] : []), ...(scenario === 'no-toolsets' ? [] : ['toolsets'])] } }
  if (method === 'session.create') {
    createParams.push(params)
    if ((params.source !== 'tool' && !(scenario === 'mcp' && params.source === 'acp' && params.editor?.edit_approval_policy === 'ask')) || !params.cwd || !params.request_id) throw 'invalid_params'
    let session = createIds.get(params.request_id)
    if (!session) {
      session = { id: `session-${++creates}`, seq: 0, replay: 'replay-1', generation: 0, queue: [], active: null, events: [], rows: new Map(), viewers: new Set(), prompts: new Map(), requests: new Map() }
      sessions.set(session.id, session); createIds.set(params.request_id, session)
      session.mcpServers = params.editor?.mcp_servers
    }
    session.viewers.add(socket); socket.data.session = session; return snapshot(session, socket)
  }
  const session = sessions.get(params.session_id)
  if (!session) throw 'not_found'
  if (method === 'session.resume') {
    session.viewers.add(socket); socket.data.session = session
    if (socket.data.replay) for (const event of session.events.filter(e => e.seq > socket.data.replay.sequence)) send(socket, { jsonrpc: '2.0', method: 'event', params: event })
    return snapshot(session, socket)
  }
  if (method === 'session.events.since') {
    const gap = scenario === 'gap' || params.replay_epoch !== session.replay
    const events = gap ? [] : session.events.filter(e => e.seq > params.last_sequence)
    socket.data.replay = { sequence: events.at(-1)?.seq ?? params.last_sequence }
    return { events, latest_seq: session.seq, last_sequence: session.seq, epoch: session.replay, replay_epoch: session.replay, truncated: gap, snapshot_required: gap, count: events.length, open_requests: [...session.requests.values()] }
  }
  if (method === 'session.detach') { session.viewers.delete(socket); return { session_id: session.id, subscription_id: params.subscription_id, detached: true } }
  if (method === 'prompt.submit') {
    const existing = [...session.rows.values()].find(row => row.inputId === params.submission_id)
    if (existing) { if (existing.text !== params.text) throw 'admission_conflict'; return admission(existing) }
    inputs.push({ inputId: params.submission_id, text: params.text })
    const row = { id: randomUUID(), session, inputId: params.submission_id, text: params.text, sequence: inputs.length, status: 'queued' }
    session.rows.set(row.id, row)
    if (session.active) { session.queue.push(row); info(session) } else start(row)
    if (scenario === 'ack-lost') return NO_REPLY
    return admission(row)
  }
  if (method === 'prompt.receipt') {
    const row = session.rows.get(params.admission_id)
    if (!row) throw 'not_found'
    return { ...admission(row), ...(params.include_result && row.result ? { result: row.result, usage: {} } : {}) }
  }
  if (method === 'session.interrupt') {
    if (session.generation !== params.execution_generation) throw 'stale_generation'
    interrupts++; const response = handle(session)
    if (session.active) finish(session.active, 'interrupted', '')
    return response
  }
  if (method === 'approval.respond' || method === 'clarify.respond') {
    const prompt = session.prompts.get(params.prompt_id)
    if (!prompt) return { status: 'already_resolved', prompt_id: params.prompt_id }
    if (params.execution_generation !== prompt.execution_generation) throw 'stale_generation'
    if (method === 'approval.respond' && !prompt.choices.includes(params.choice)) throw 'invalid_params'
    responses.push({ method, params }); session.prompts.delete(params.prompt_id)
    publish(session, prompt.kind + '.settled', { prompt_id: params.prompt_id, execution_generation: prompt.execution_generation })
    finish(session.active)
    return { status: 'resolved', prompt_id: params.prompt_id }
  }
  throw 'unsupported_control'
}
const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
  /** Serve ticket attachment, authenticated upgrades and fixture inspection/control without mutating SDK observations directly. */
  async fetch(req, server) {
    const path = new URL(req.url).pathname
    if (path === '/attach') {
      const payload = await req.json(); attachArgs.push(payload.args); attaches++
      const ticket = randomUUID(); tickets.add(ticket)
      const value = { state: 'ready', endpoint: { profile_id: 'fake-profile', instance_id: instance, code_sha: 'fake-code' }, client_code_sha: scenario === 'code-mismatch' ? 'different' : 'fake-code',
        url: `ws://127.0.0.1:${server.port}/api/ws`, protocol: wire, protocols: [wire, `hermes-gateway-ticket.${ticket}`], ticket }
      return Response.json(value)
    }
    if (path === '/api/ws') {
      origins.push(req.headers.get('origin'))
      const protocols = (req.headers.get('sec-websocket-protocol') ?? '').split(',').map(v => v.trim())
      const ticket = protocols.find(p => p.startsWith('hermes-gateway-ticket.'))?.slice('hermes-gateway-ticket.'.length)
      upgrades.push({ first: protocols[0], count: protocols.length, hasTicket: !!ticket, valid: tickets.has(ticket) })
      if (req.headers.has('origin') || !protocols.includes(wire) || !tickets.delete(ticket)) return new Response('refused', { status: 403 })
      // Bun negotiates the first offered protocol; supplying it again duplicates the header on older Bun.
      if (server.upgrade(req, { data: { subscription: randomUUID() } })) return
    }
    if (path === '/state') return Response.json({ creates, attaches, interrupts, disconnects, createParams, methods, inputs, responses, attachArgs, origins, upgrades, connections: connections.size,
      active: [...sessions.values()].filter(s => !!s.active).length, viewers: [...sessions.values()].reduce((n, s) => n + s.viewers.size, 0) })
    if (path === '/control') {
      const { action } = await req.json()
      for (const session of sessions.values()) control(session, action)
      return Response.json({ ok: true })
    }
    return new Response('missing', { status: 404 })
  },
  websocket: {
    open(socket) { connections.add(socket) },
    /** Invoke RPC dispatch or consume a client response; publish native settlement before terminal evidence to exercise ACK races. */
    async message(socket, raw) {
      const frame = JSON.parse(String(raw))
      if (frame.method) {
        try {
          const result = await request(socket, frame.method, frame.params ?? {})
          if (result !== NO_REPLY) reply(socket, frame.id, result)
        } catch (cause) { refuse(socket, frame.id, typeof cause === 'string' ? cause : 'invalid_params') }
      } else {
        responses.push(frame)
        const session = socket.data.session
        if (scenario === 'secret-response-lost') { disconnect(session); return }
        session.requests.delete(frame.id)
        publish(session, 'request.cancel', { id: frame.id, method: scenario.startsWith('batch') ? 'clarify' : 'secret', reason: 'resolved' })
        finish(session.active, 'complete', scenario === 'secret' ? `Echo ${frame.result?.value ?? ''}` : 'authoritative final')
      }
    },
    close(socket) { connections.delete(socket); socket.data.session?.viewers.delete(socket) },
  },
})

/** Apply test controls to native state; publication still crosses the real socket before SDK callers can observe it. */
function control(session, action) {
  if (action === 'release') {
    while (session.active) finish(session.active)
  } else if (action === 'disconnect') disconnect(session)
  else if (action === 'cancelQueued') {
    for (const row of session.queue.splice(0)) { row.status = 'terminal'; row.outcome = 'cancelled'; publish(session, 'message.complete', { text: '', outcome: 'cancelled', status: 'error' }, row) }
    info(session)
  } else if (action === 'external-resolve') {
    for (const prompt of session.prompts.values()) publish(session, prompt.kind + '.settled', { prompt_id: prompt.prompt_id, execution_generation: prompt.execution_generation })
    session.prompts.clear(); if (session.active) finish(session.active)
  }
}
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }))
process.stdin.resume()
process.stdin.on('end', () => { server.stop(true); process.exit(0) })
