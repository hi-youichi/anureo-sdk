/** Minimal third-party AHP harness, intentionally independent of Anureo Host and test conformance. */
import { createInterface } from "node:readline";
import { createHarnessRuntime,HarnessSdkError,type HarnessAdapter,type BackendSession,type SessionEventSink,type SessionMethod,type HarnessSession } from "@anureo/sdk";
import { assertRequest,negotiateVersion,supportsExtension,type Capabilities,type AhpRequestMap,type AhpResultMap,type AhpEvent,type SessionOpenParams,type SessionState } from "@anureo/protocol";
const capabilities:Capabilities={turn:{interrupt:true,inputModalities:["text"]},interactions:["approval"],extensions:[{name:"x-anureo/event-replay",version:"1"},{name:"x-anureo/session-metadata",version:"1"}]};
class ReferenceAdapter implements HarnessAdapter {
  private metadataEnabled=false;
  async initialize(p:AhpRequestMap["initialize"]){negotiateVersion(p.protocolVersions);this.metadataEnabled=supportsExtension(p.clientCapabilities??{},"x-anureo/session-metadata","1");return {protocolVersion:1 as const,runtime:{name:"reference",version:"1.0.0",adapter:"reference/1"},capabilities};}
  async openSession(p:SessionOpenParams,sink:SessionEventSink):Promise<BackendSession>{
    const binding={...p.binding,nativeRef:{provider:"reference",value:p.binding.sessionId}};
    let active:string|undefined,closed=false;
    const metadataEnabled=this.metadataEnabled;
    return {binding,capabilities,async execute<M extends SessionMethod>(method:M,params:AhpRequestMap[M]):Promise<AhpResultMap[M]>{
      if(method==="session/close")return {closed:true} as AhpResultMap[M];
      if(method==="turn/interrupt") {const turnId=(params as AhpRequestMap["turn/interrupt"]).turnId;if(active===turnId){active=undefined;await sink.emit({type:"turn/completed",payload:{turnId,status:"interrupted"}});}return {accepted:true,turnId} as AhpResultMap[M];}
      if(method!=="turn/start")throw new HarnessSdkError("CAPABILITY_UNSUPPORTED");
      const request=params as AhpRequestMap["turn/start"];active=request.turnId;
      await sink.emit({type:"turn/started",payload:{turnId:request.turnId,nativeTurnId:request.turnId}});
      const text=request.input.filter(x=>x.type==="text").map(x=>x.text).join("\n");
      if(metadataEnabled&&text.startsWith("/title "))await sink.emit({type:"session/metadata",payload:{title:text.slice(7)||null}});
      if(text!=="/wait")void (async()=>{
        if(text==="/approval")await sink.requestInteraction({kind:"approval",interactionId:`approval:${request.turnId}`,turnId:request.turnId,options:[{id:"allow",label:"Allow once",semantic:"allowOnce"},{id:"deny",label:"Deny",semantic:"deny"}]},async()=>{});
        if(closed||active!==request.turnId)return;
        const item={id:"message",type:"agentMessage" as const,text,phase:"final" as const};await sink.emit({type:"item/started",payload:{item:{...item,text:""}}},{turnId:request.turnId});await sink.emit({type:"item/completed",payload:{item}},{turnId:request.turnId});active=undefined;await sink.emit({type:"turn/completed",payload:{turnId:request.turnId,status:"completed"}});
      })().catch(async()=>{if(!closed&&active===request.turnId){active=undefined;await sink.emit({type:"turn/completed",payload:{turnId:request.turnId,status:"interrupted"}});}});
      return {turnId:request.turnId,accepted:true} as AhpResultMap[M];
    },async dispose(){closed=true;active=undefined;}};
  }
  async dispose(){}
}
export function createReferenceHarness(send:(message:string)=>void|Promise<void>){
  const runtime=createHarnessRuntime(new ReferenceAdapter()),sessions=new Map<string,HarnessSession>(),logs=new Map<string,AhpEvent[]>();
  const publish=async(event:AhpEvent)=>{if(event.type==="session/metadata")event={...event,type:"extension",payload:{name:"x-anureo/session-metadata",version:"1",data:event.payload}};const log=logs.get(event.sessionId)??[];log.push(event);if(log.length>2048)log.shift();logs.set(event.sessionId,log);await send(JSON.stringify({jsonrpc:"2.0",method:event.type,params:event}));};
  const invoke=async(method:string,params:unknown):Promise<unknown>=>{
    if(method==="initialize"){assertRequest("initialize",params);return runtime.initialize(params);}
    if(method==="session/open"){
      assertRequest("session/open",params);const session=await runtime.openSession(params);sessions.set(session.binding.sessionId,session);const reader=session.events()[Symbol.asyncIterator](),first=await reader.next();
      if(first.done||first.value.type!=="session/state")throw new HarnessSdkError("PROTOCOL_ERROR");await publish(first.value);
      void(async()=>{for(;;){const entry=await reader.next();if(entry.done)return;await publish(entry.value);}})().catch(()=>{});
      return {binding:session.binding,streamId:first.value.streamId,state:first.value.payload,capabilities:session.capabilities};
    }
    if(!params||typeof params!=="object"||!("sessionId" in params)||typeof params.sessionId!=="string")throw new HarnessSdkError("INVALID_PARAMS");
    if(method==="x-anureo/events/read"){
      const p=params as {sessionId:string;streamId:string;afterSeq:number;throughSeq:number},log=logs.get(p.sessionId)??[];
      const events=log.filter(e=>e.streamId===p.streamId&&e.seq>p.afterSeq&&e.seq<=p.throughSeq);if(events[0]?.seq!==p.afterSeq+1&&p.afterSeq<p.throughSeq)throw new HarnessSdkError("SOURCE_STREAM_UNAVAILABLE");return {events};
    }
    const session=sessions.get(params.sessionId);if(!session)throw new HarnessSdkError("SESSION_NOT_FOUND");
    switch(method){
      case "turn/start":assertRequest(method,params);return session.startTurn(params);
      case "turn/interrupt":assertRequest(method,params);return session.interrupt(params);
      case "interaction/respond":assertRequest(method,params);return session.respond(params);
      case "interaction/cancel":assertRequest(method,params);return session.cancelInteraction(params);
      case "session/close":assertRequest(method,params);await session.close();sessions.delete(params.sessionId);return {closed:true};
      default:throw new HarnessSdkError("CAPABILITY_UNSUPPORTED");
    }
  };
  return {async receive(frame:string){
    let message:Record<string,unknown>;try{message=JSON.parse(frame);}catch{await send(JSON.stringify({jsonrpc:"2.0",id:null,error:{code:-32700,message:"Parse error"}}));return;}
    if(message.method==="initialized"&&message.id===undefined)return;
    if(message.jsonrpc!=="2.0"||typeof message.method!=="string"||message.id===undefined){await send(JSON.stringify({jsonrpc:"2.0",id:message.id??null,error:{code:-32600,message:"Invalid request"}}));return;}
    try{const result=await invoke(message.method,message.params);await send(JSON.stringify({jsonrpc:"2.0",id:message.id,result}));}catch(cause){const code=cause&&typeof cause==="object"&&"code" in cause?String(cause.code):"HARNESS_ERROR";await send(JSON.stringify({jsonrpc:"2.0",id:message.id,error:{code:-32070,message:code,data:{code,retryable:false,outcomeUnknown:false}}}));}
  },close:()=>runtime.dispose()};
}
if(import.meta.main){
  const harness=createReferenceHarness(message=>{process.stdout.write(message+"\n");});
  const input=createInterface({input:process.stdin});for await(const line of input){void harness.receive(line);}
  await harness.close();
}
