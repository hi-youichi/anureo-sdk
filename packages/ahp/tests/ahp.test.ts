import { expect,test } from "bun:test";
import path from "node:path";
import { createHarnessRuntime,BoundedEventQueue,type HarnessRuntime,type HarnessSession } from "@anureo/sdk";
import type { AhpEvent } from "@anureo/protocol";
import { createAhpAdapter,createWebSocketTransport,AhpWire,createStdioTransport,type AhpTransport } from "../src/index";
import { createReferenceHarness } from "../examples/reference";

async function fixture(options:{dropSeq?:number;replay?:boolean;duplicate?:boolean}={}){
  const queue=new BoundedEventQueue<string>();let dropped=false;
  const reference=createReferenceHarness(frame=>{
    const m=JSON.parse(frame) as {method?:string;params?:AhpEvent;result?:{capabilities?:{extensions?:unknown}}};
    if(options.replay===false&&m.result?.capabilities)delete m.result.capabilities.extensions;
    if(options.dropSeq!==undefined&&m.params?.seq===options.dropSeq&&!dropped){dropped=true;return;}
    const projected=JSON.stringify(m);queue.push(projected);if(options.duplicate&&m.params?.seq===1)queue.push(projected);
  });
  const transport:AhpTransport={messages:queue,send:frame=>reference.receive(frame),close:async()=>{await reference.close();queue.end();}};
  const runtime=createHarnessRuntime(createAhpAdapter({transport,timeoutMs:500}));
  await runtime.initialize({protocolVersions:[1],clientInfo:{name:"test",version:"1"},clientCapabilities:{interactions:["approval"]}});
  const session=await runtime.openSession({requestId:"open",mode:"new",binding:{sessionId:"session",adapterId:"ahp",runtimeConfigId:"ref"},cwd:process.cwd()});
  return {runtime,session,queue};
}
async function collect(session:HarnessSession,turnId:string,answer=false):Promise<AhpEvent[]>{
  const events:AhpEvent[]=[],reader=session.events()[Symbol.asyncIterator]();
  const timer=setTimeout(()=>{void reader.return?.();},1500);
  try{for(;;){const next=await reader.next();if(next.done)throw new Error("Missing terminal");events.push(next.value);
    if(answer&&next.value.type==="interaction/requested")await session.respond({requestId:"respond",sessionId:session.binding.sessionId,interactionId:next.value.payload.interactionId,response:{kind:"approval",optionId:"deny"}});
    if(next.value.type==="turn/completed"&&next.value.payload.turnId===turnId)return events;
  }}finally{clearTimeout(timer);await reader.return?.();}
}
test("external AHP preserves immediate lifecycle over stdio",async()=>{
  const runtime=createHarnessRuntime(createAhpAdapter({command:process.execPath,args:[path.resolve(import.meta.dir,"../examples/reference.ts")],timeoutMs:1500}));
  try{
    await runtime.initialize({protocolVersions:[1],clientInfo:{name:"stdio",version:"1"},clientCapabilities:{interactions:["approval"]}});
    const session=await runtime.openSession({requestId:"open",mode:"new",binding:{sessionId:"s",adapterId:"ahp",runtimeConfigId:"ref"},cwd:process.cwd()});
    const collecting=collect(session,"turn");await session.startTurn({requestId:"start",sessionId:"s",turnId:"turn",input:[{type:"text",text:"stdio"}]});
    const events=await collecting;expect(events.some(e=>e.type==="item/completed"&&e.payload.item.type==="agentMessage"&&e.payload.item.text==="stdio")).toBe(true);
  }finally{await runtime.dispose();}
});
test("remote interaction responds once, with no duplicate local resolution",async()=>{
  const f=await fixture();try{
    const reading=collect(f.session,"turn",true);await f.session.startTurn({requestId:"start",sessionId:"session",turnId:"turn",input:[{type:"text",text:"/approval"}]});
    const events=await reading;expect(events.filter(e=>e.type==="interaction/resolved")).toHaveLength(1);expect(events.filter(e=>e.type==="interaction/requested")).toHaveLength(1);
  }finally{await f.runtime.dispose();}
});
test("advertised source replay fills remote gaps and dedupes source notifications",async()=>{
  const f=await fixture({dropSeq:3,duplicate:true});try{
    const reading=collect(f.session,"turn");await f.session.startTurn({requestId:"start",sessionId:"session",turnId:"turn",input:[{type:"text",text:"replayed"}]});
    const events=await reading;expect(events.filter(e=>e.type==="item/started")).toHaveLength(1);expect(events.at(-1)?.type).toBe("turn/completed");
    expect(events.every((e,i)=>e.seq===i+1)).toBe(true);
  }finally{await f.runtime.dispose();}
});
test("source without replay fails a missing sequence instead of silently continuing",async()=>{
  const f=await fixture({dropSeq:3,replay:false});try{
    const reading=collect(f.session,"turn");const start=f.session.startTurn({requestId:"start",sessionId:"session",turnId:"turn",input:[{type:"text",text:"gap"}]});void start.catch(()=>{});
    const events=await reading;await start.catch(()=>{});expect(events.at(-1)).toMatchObject({type:"turn/completed",payload:{status:"failed"}});
  }finally{await f.runtime.dispose();}
});
test("WebSocket factory uses identical lifecycle and closes only its connection",async()=>{
  const sessions=new Map<string,ReturnType<typeof createReferenceHarness>>();
  const server=Bun.serve<{id:string}>({hostname:"127.0.0.1",port:0,fetch(req,s){if(s.upgrade(req,{data:{id:crypto.randomUUID()}}))return;return new Response("no",{status:400});},websocket:{open(socket){sessions.set(socket.data.id,createReferenceHarness(frame=>{socket.send(frame);}));},message(socket,frame){void sessions.get(socket.data.id)?.receive(String(frame));},close(socket){void sessions.get(socket.data.id)?.close();sessions.delete(socket.data.id);}}});
  const runtime=createHarnessRuntime(createAhpAdapter({url:`ws://127.0.0.1:${server.port}/`,connect:url=>createWebSocketTransport(url)}));
  try{
    await runtime.initialize({protocolVersions:[1],clientInfo:{name:"ws",version:"1"},clientCapabilities:{interactions:["approval"]}});
    const session=await runtime.openSession({requestId:"open",mode:"new",binding:{sessionId:"ws",adapterId:"ahp",runtimeConfigId:"ref"},cwd:process.cwd()});
    const text=collect(session,"text");await session.startTurn({requestId:"text",sessionId:"ws",turnId:"text",input:[{type:"text",text:"stdio"}]});expect((await text).some(e=>e.type==="item/completed"&&e.payload.item.type==="agentMessage"&&e.payload.item.text==="stdio")).toBe(true);
    const approval=collect(session,"approval",true);await session.startTurn({requestId:"approval",sessionId:"ws",turnId:"approval",input:[{type:"text",text:"/approval"}]});expect((await approval).filter(e=>e.type==="interaction/resolved")).toHaveLength(1);
    const reading=collect(session,"turn");await session.startTurn({requestId:"start",sessionId:"ws",turnId:"turn",input:[{type:"text",text:"/wait"}]});await session.interrupt({requestId:"stop",sessionId:"ws",turnId:"turn"});expect((await reading).at(-1)).toMatchObject({payload:{status:"interrupted"}});
    await runtime.dispose();expect(server.port).toBeGreaterThan(0);
  }finally{await runtime.dispose();await server.stop(true);}
});


test("negotiated metadata extensions map to standard title events through replay", async () => {
  const f = await fixture({ dropSeq: 3, replay: true });
  try {
    const pending = collect(f.session, 'title');
    await f.session.startTurn({ requestId: 'title', sessionId: 'session', turnId: 'title', input: [{ type: 'text', text: '/title Native title' }] });
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
    const reading = collect(f.session, "turn");
    f.queue.push(JSON.stringify({ jsonrpc: "2.0", method: "custom/ping", params: { hello: "world" } }));
    await f.session.startTurn({ requestId: "start", sessionId: "session", turnId: "turn", input: [{ type: "text", text: "x" }] });
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
