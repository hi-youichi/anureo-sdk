import { expect,test } from "bun:test";
import path from "node:path";
import { createClient,BoundedEventQueue,type Session } from "@anureo/sdk";
import type { AhpEvent } from "@anureo/protocol";
import { createAhpAdapter,createWebSocketTransport,AhpWire,createStdioTransport,type AhpTransport } from "../src/index";
import { createReferenceHarness } from "../examples/reference";

/** Connect an owned client/session to a scripted peer, optionally perturbing notifications; dispose runtime. */
async function fixture(options:{dropSeq?:number;replay?:boolean;duplicate?:boolean}={}){
  const queue=new BoundedEventQueue<string>();
  const forwardedFrames: Array<{method?:string;params?:AhpEvent}>=[];
  let dropped=false;
  const reference=createReferenceHarness(frame=>{
    const message=JSON.parse(frame) as {method?:string;params?:AhpEvent;result?:{capabilities?:{extensions?:unknown}}};
    if(options.replay===false&&message.result?.capabilities){
      delete message.result.capabilities.extensions;
    }

    // Drop only the first matching frame, before recording or forwarding it.
    if(options.dropSeq!==undefined&&message.params?.seq===options.dropSeq&&!dropped){
      dropped=true;
      return;
    }

    forwardedFrames.push(message);
    const serializedFrame=JSON.stringify(message);
    queue.push(serializedFrame);
    if(options.duplicate&&message.params?.seq===1){
      // Record once, but deliver the same serialized frame twice.
      queue.push(serializedFrame);
    }
  });
  const transport:AhpTransport={messages:queue,send:frame=>reference.receive(frame),close:async()=>{await reference.close();queue.end();}};
  const runtime=await createClient({identity:{adapterId:"ahp",runtimeConfigId:"ref"},interactions:{approval:undefined},adapter:createAhpAdapter({transport,timeoutMs:500})});
  const session=await runtime.openSession({requestId:"open",mode:"new",binding:{sessionId:"session",adapterId:"ahp",runtimeConfigId:"ref"},cwd:process.cwd()});
  return {runtime,session,queue,forwardedFrames};
}
/** Collect through the first terminal, optionally answer requests, and release the reader and timer. */
async function collect(
  session: Session,
  onInteraction?: (session: Session, request: Extract<AhpEvent, { type: "interaction/requested" }>["payload"]) => Promise<unknown>,
): Promise<AhpEvent[]> {
  const events: AhpEvent[] = [];
  const reader = session.events()[Symbol.asyncIterator]();
  const timer = setTimeout(() => { void reader.return?.(); }, 1500);
  try {
    for (;;) {
      const next = await reader.next();
      if (next.done) throw new Error("Missing terminal");
      const event = next.value;
      events.push(event);
      if (onInteraction && event.type === "interaction/requested") await onInteraction(session, event.payload);
      if (event.type === "turn/completed") return events;
    }
  } finally {
    clearTimeout(timer);
    await reader.return?.();
  }
}

/** Settle the scripted peer's approval manually before collect resumes reading. */
function denyApproval(session: Session, { interactionId }: { interactionId: string }) {
  return session.request("interaction/respond", {
    requestId: "respond",
    sessionId: session.binding.sessionId,
    interactionId,
    response: { kind: "approval", optionId: "deny" },
  });
}
test("external AHP preserves immediate lifecycle over stdio",async()=>{
  const runtime=await createClient({identity:{adapterId:"ahp",runtimeConfigId:"ref"},interactions:{approval:undefined},adapter:createAhpAdapter({command:process.execPath,args:[path.resolve(import.meta.dir,"../examples/reference.ts")],timeoutMs:1500})});
  try{
    const session=await runtime.openSession({requestId:"open",mode:"new",binding:{sessionId:"s",adapterId:"ahp",runtimeConfigId:"ref"},cwd:process.cwd()});
    const collecting=collect(session);await session.submit({ input:[{type:"text",text:"stdio"}] });
    const events=await collecting;expect(events.some(e=>e.type==="item/completed"&&e.payload.item.type==="agentMessage"&&e.payload.item.text==="stdio")).toBe(true);
  }finally{await runtime.dispose();}
});
test("remote interaction responds once, with no duplicate local resolution",async()=>{
  const f=await fixture();try{
    const reading=collect(f.session,denyApproval);await f.session.submit({ input:[{type:"text",text:"/approval"}] });
    const events=await reading;expect(events.filter(e=>e.type==="interaction/resolved")).toHaveLength(1);expect(events.filter(e=>e.type==="interaction/requested")).toHaveLength(1);
  }finally{await f.runtime.dispose();}
});
test("advertised source replay fills remote gaps and dedupes source notifications",async()=>{
  const f=await fixture({dropSeq:3,duplicate:true});try{
    const reading=collect(f.session);await f.session.submit({ input:[{type:"text",text:"replayed"}] });
    const events=await reading;expect(events.filter(e=>e.type==="item/started")).toHaveLength(1);expect(events.at(-1)?.type).toBe("turn/completed");
    expect(events.every((e,i)=>e.seq===events[0]!.seq+i)).toBe(true);
  }finally{await f.runtime.dispose();}
});
test("source without replay fails a missing sequence instead of silently continuing",async()=>{
  const f=await fixture({dropSeq:3,replay:false});try{
    const reading=collect(f.session);
    const submission=f.session.submit({ input:[{type:"text",text:"gap"}] });
    const submissionSettled=submission.catch(()=>undefined);
    await expect(reading).rejects.toMatchObject({code:"SOURCE_SEQUENCE_GAP"});
    await submissionSettled;
  }finally{await f.runtime.dispose();}
});
test("WebSocket factory uses identical lifecycle and closes only its connection",async()=>{
  const harnessesByConnectionId=new Map<string,ReturnType<typeof createReferenceHarness>>();
  const server=Bun.serve<{id:string}>({
    hostname:"127.0.0.1",
    port:0,
    fetch(req,s){
      if(s.upgrade(req,{data:{id:crypto.randomUUID()}}))return;
      return new Response("no",{status:400});
    },
    websocket:{
      open(socket){
        harnessesByConnectionId.set(socket.data.id,createReferenceHarness(frame=>{
          socket.send(frame);
        }));
      },
      message(socket,frame){
        const harness=harnessesByConnectionId.get(socket.data.id);
        void harness?.receive(String(frame));
      },
      close(socket){
        const harness=harnessesByConnectionId.get(socket.data.id);
        void harness?.close();
        harnessesByConnectionId.delete(socket.data.id);
      },
    },
  });
  const runtime=await createClient({identity:{adapterId:"ahp",runtimeConfigId:"ref"},interactions:{approval:undefined},adapter:createAhpAdapter({url:`ws://127.0.0.1:${server.port}/`,connect:url=>createWebSocketTransport(url)})});
  try{
    const session=await runtime.openSession({requestId:"open",mode:"new",binding:{sessionId:"ws",adapterId:"ahp",runtimeConfigId:"ref"},cwd:process.cwd()});
    const text=collect(session);await session.submit({ input:[{type:"text",text:"stdio"}] });expect((await text).some(e=>e.type==="item/completed"&&e.payload.item.type==="agentMessage"&&e.payload.item.text==="stdio")).toBe(true);
    const approval=collect(session,denyApproval);await session.submit({ input:[{type:"text",text:"/approval"}] });expect((await approval).filter(e=>e.type==="interaction/resolved")).toHaveLength(1);
    const reading=collect(session);const active=await session.submit({ input:"/wait" });await active.interrupt();expect((await reading).at(-1)).toMatchObject({payload:{status:"interrupted"}});
    await runtime.dispose();expect(server.port).toBeGreaterThan(0);
  }finally{await runtime.dispose();await server.stop(true);}
});


test("negotiated metadata extensions map to standard title events through replay", async () => {
  const f = await fixture({ dropSeq: 3, replay: true });
  try {
    const pending = collect(f.session);
    await f.session.submit({ input: [{ type: 'text', text: '/title Native title' }] });
    const events = await pending;
    expect(events.filter(e => e.type === 'session/metadata').map(e => e.payload)).toEqual([{ title: 'Native title' }]);
    expect(events.filter(e => e.type === 'turn/completed')).toHaveLength(1);
  } finally { await f.runtime.dispose(); }
});

test("closing a remote session disposes its backend session record", async () => {
  const f = await fixture();
  try {
    await f.session.close();
    const reopened = await f.runtime.openSession({ requestId: "reopen", mode: "new", binding: { sessionId: "session", adapterId: "ahp", runtimeConfigId: "ref" }, cwd: process.cwd() });
    await reopened.close();
  } finally { await f.runtime.dispose(); }
});

test("unknown remote notifications surface as neutral notices", async () => {
  const f = await fixture();
  try {
    const reading = collect(f.session);
    f.queue.push(JSON.stringify({ jsonrpc: "2.0", method: "custom/ping", params: { hello: "world" } }));
    await f.session.submit({ input: [{ type: "text", text: "x" }] });
    const events = await reading;
    expect(events.some(e => e.type === "notice" && e.payload.code === "UNKNOWN_NOTIFICATION")).toBe(true);
  } finally { await f.runtime.dispose(); }
});

test("wire send failures reject the caller once with an unknown outcome", async () => {
  const frames = new BoundedEventQueue<string>();
  const transport: AhpTransport = { messages: frames, send: () => Promise.reject(new Error("pipe gone")), close: async () => { frames.end(); } };
  const wire = new AhpWire(transport, { timeoutMs: 100 });
  await expect(wire.request("doomed", {})).rejects.toMatchObject({ code: "RPC_CONNECTION_CLOSED", outcomeUnknown: true });
  await expect(wire.notify("ignored")).rejects.toMatchObject({ message: "pipe gone" });
  await wire.close();
});

test("stdio transport frames stdout and drains broken stderr silently", async () => {
  const transport = await createStdioTransport({
    command: process.execPath, args: ["-e", "console.log('unused')"],
    processFactory: async () => ({
      pid: 4242, owned: true,
      stdout: (async function* () { yield new TextEncoder().encode("frame\r\n"); })(),
      stderr: (async function* () { throw new Error("stderr gone"); })(),
      exited: Promise.resolve({ code: 0, signal: null }),
      async write() {}, async closeInput() {}, async dispose() {},
    }),
  });
  const reader = transport.messages[Symbol.asyncIterator]();
  expect(await reader.next()).toMatchObject({ value: "frame" });
  await transport.close();
});

/** Model socket state and event listeners so tests can drive handshake/frame failures without a server. */
function fakeWebSocket(initialReadyState = 0) {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const sent: string[] = [];
  const object = {
    readyState: initialReadyState, bufferedAmount: 0, sent,
    addEventListener(type: string, listener: (event: unknown) => void) { const all = listeners.get(type); if (all) all.push(listener); else listeners.set(type, [listener]); },
    removeEventListener(type: string, listener: (event: unknown) => void) { const all = listeners.get(type); if (all) { const index = all.indexOf(listener); if (index >= 0) all.splice(index, 1); } },
    dispatchEvent(event: Event & { data?: unknown }) { for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event); return true; },
    send(data: unknown) { sent.push(String(data)); },
    close() { if (object.readyState !== 3) { object.readyState = 3; object.dispatchEvent(new Event("close")); } },
  };
  const dispatch = (type: string, data?: unknown) => { object.dispatchEvent(Object.assign(new Event(type), { data })); };
  return { object: object as unknown as WebSocket, dispatch };
}

test("webSocket transport times out an unresponsive handshake and closes the socket", async () => {
  const socket = fakeWebSocket();
  await expect(createWebSocketTransport("ws://127.0.0.1/x", { factory: () => socket.object, timeoutMs: 30 })).rejects.toMatchObject({ code: "RPC_CONNECTION_FAILED" });
  expect(socket.object.readyState).toBe(3);
});

test("webSocket transport reports failed handshakes", async () => {
  const socket = fakeWebSocket();
  const pending = createWebSocketTransport("ws://127.0.0.1/x", { factory: () => socket.object, timeoutMs: 5000 });
  socket.dispatch("error");
  await expect(pending).rejects.toMatchObject({ code: "RPC_CONNECTION_FAILED" });
});

test("webSocket transport rejects non-text frames and closes", async () => {
  const socket = fakeWebSocket(1);
  const transport = await createWebSocketTransport("ws://127.0.0.1/x", { factory: () => socket.object });
  socket.dispatch("message", new ArrayBuffer(4));
  const reader = transport.messages[Symbol.asyncIterator]();
  await expect(reader.next()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(socket.object.readyState).toBe(3);
  await transport.close();
});

for(const reopen of [false,true])test(`late notifications from a closed source do not fail ${reopen?'a reopened':'another live'} session`,async()=>{
  const f=await fixture();
  try{
    const old=f.forwardedFrames.find(frame=>frame.params?.sessionId==='session')!.params!;
    await f.session.close();
    const live=await f.runtime.openSession({requestId:'other',mode:'new',binding:{sessionId:reopen?'session':'other',adapterId:'ahp',runtimeConfigId:'ref'},cwd:process.cwd()});
    const late={...old,seq:50,type:'notice',payload:{severity:'info',code:'LATE',message:'closed source'}};
    f.queue.push(JSON.stringify({jsonrpc:'2.0',method:'notice',params:late}));
    const turn=await live.submit({input:'still connected'},{timeoutMs:1000});
    expect((await turn.result({timeoutMs:1000})).text).toBe('still connected');
    await live.close();
  }finally{await f.runtime.dispose();}
});
