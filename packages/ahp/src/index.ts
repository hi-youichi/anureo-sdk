import { HarnessSdkError,type HarnessAdapter,type BackendSession,type SessionEventSink,type SessionMethod } from "@anureo/sdk";
import { assertRequest,assertDefinition,assertEvent,assertResult,negotiateVersion,supportsExtension,publicValue,type JsonValue,type AhpEvent,type AhpRequestMap,type AhpResultMap,type InitializeParams,type InitializeResult,type SessionOpenParams,type InteractionRequested,type InteractionResult,type InteractionResponse } from "@anureo/protocol";
import { AhpWire,createStdioTransport,type AhpTransport,type WireOptions } from "./wire";
import type { HarnessProcessOptions } from "@anureo/sdk/process";
export { AhpWire,createStdioTransport,type AhpTransport } from "./wire";
export { createWebSocketTransport } from "./websocket";
export interface AhpAdapterOptions extends WireOptions {
  transport?:AhpTransport|(()=>Promise<AhpTransport>);
  command?:string;args?:string[];env?:Record<string,string|undefined>;cwd?:string;
  url?:string;connect?:(url:string)=>Promise<AhpTransport>;
  processFactory?:Parameters<typeof createStdioTransport>[0]["processFactory"];
}
interface SessionRecord {
  sink:SessionEventSink;
  lastByStream:Map<string,number>;
  streamId?:string;
  metadataObserved?:boolean;
  // Registered on receipt; removed by external resolution or the response callback's finally.
  pendingInteractionIds:Set<string>;
}
interface InFlightInteractionResponse {resolve:(result:InteractionResult)=>void;reject:(cause:unknown)=>void}
const METADATA_EXTENSION = {name:"x-anureo/session-metadata",version:"1"};
export class AhpAdapter implements HarnessAdapter {
  private wire?:AhpWire;private initialized?:Promise<InitializeResult>;private result?:InitializeResult;
  private readonly sessions=new Map<string,SessionRecord>();
  private readonly retiredStreams=new Set<string>();
  // Registered only while a response callback runs; its finally or wire close removes the entry.
  private readonly inFlightInteractionResponses=new Map<string,InFlightInteractionResponse>();
  private disposed=false;
  constructor(private readonly options:AhpAdapterOptions){}
  initialize(params:InitializeParams):Promise<InitializeResult>{
    if(this.disposed)return Promise.reject(new HarnessSdkError('RUNTIME_DISPOSED'));
    assertRequest("initialize",params);
    negotiateVersion(params.protocolVersions);
    return this.initialized??=(async()=>{
      let transport:AhpTransport;
      if(this.options.transport)transport=typeof this.options.transport==="function"?await this.options.transport():this.options.transport;
      else if(this.options.url){if(!this.options.connect)throw new HarnessSdkError("WEBSOCKET_FACTORY_REQUIRED");transport=await this.options.connect(this.options.url);}
      else {if(!this.options.command)throw new HarnessSdkError("HARNESS_UNAVAILABLE");transport=await createStdioTransport({...this.options,command:this.options.command});}
      if(this.disposed){await transport.close();throw new HarnessSdkError('RUNTIME_DISPOSED');}
      const wire=this.wire=new AhpWire(transport,this.options);
      wire.onNotification=(method,event)=>this.notification(method,event);
      wire.onClose=async cause=>{for(const session of this.sessions.values())await session.sink.fail(cause);for(const response of this.inFlightInteractionResponses.values())response.reject(cause);this.inFlightInteractionResponses.clear();};
      const clientCapabilities={...params.clientCapabilities,extensions:[...(params.clientCapabilities?.extensions??[]).filter(e=>e.name!==METADATA_EXTENSION.name),METADATA_EXTENSION]};
      const result=await wire.request("initialize",{...params,clientCapabilities});assertResult("initialize",result);negotiateVersion([result.protocolVersion]);this.result=result;await wire.notify("initialized");return result;
    })();
  }
  private async notification(method:string,value:unknown):Promise<void>{
    const known=["submission/bound","submission/status","session/metadata","session/state","turn/started","turn/completed","item/started","item/delta","item/completed","usage/updated","interaction/requested","interaction/resolved","notice","extension"];
    if(!known.includes(method)){
      const raw=publicValue(JSON.parse(JSON.stringify(value??null)) as JsonValue);
      for(const session of this.sessions.values())await session.sink.emit({type:"notice",payload:{severity:"info",code:"UNKNOWN_NOTIFICATION",message:"Unknown AHP notification",raw}});
      return;
    }
    assertEvent(value);if(value.type!==method)throw new HarnessSdkError("PROTOCOL_ERROR");
    if(this.retiredStreams.has(JSON.stringify([value.sessionId,value.streamId])))return;
    const session=this.sessions.get(value.sessionId);if(!session)throw new HarnessSdkError("SOURCE_SESSION_MISMATCH");
    const last=session.lastByStream.get(value.streamId)??0;if(value.seq<=last)return;
    if(session.streamId&&session.streamId!==value.streamId)throw new HarnessSdkError("SOURCE_STREAM_UNAVAILABLE");session.streamId=value.streamId;
    if(value.seq!==last+1){
      await this.replayMissingEvents(session,value,last);
    }
    await this.deliver(session,value);
  }
  private async replayMissingEvents(session:SessionRecord,value:AhpEvent,last:number):Promise<void>{
    if(!this.result||!supportsExtension(this.result.capabilities,"x-anureo/event-replay","1")){
      throw new HarnessSdkError("SOURCE_SEQUENCE_GAP");
    }
    const raw=await this.wire!.request("x-anureo/events/read",{
      sessionId:value.sessionId,
      streamId:value.streamId,
      afterSeq:last,
      throughSeq:value.seq-1,
    });
    if(!raw||typeof raw!=="object"||!("events" in raw)||!Array.isArray(raw.events)){
      throw new HarnessSdkError("SOURCE_STREAM_UNAVAILABLE");
    }
    for(const event of raw.events){
      assertEvent(event);
      if(event.sessionId!==value.sessionId||event.streamId!==value.streamId){
        throw new HarnessSdkError("SOURCE_SEQUENCE_GAP");
      }
      const nextExpectedSeq=(session.lastByStream.get(value.streamId)??0)+1;
      if(event.seq!==nextExpectedSeq||event.seq>=value.seq){
        throw new HarnessSdkError("SOURCE_SEQUENCE_GAP");
      }
      // deliver advances lastByStream before awaiting the sink.
      await this.deliver(session,event);
    }
    if((session.lastByStream.get(value.streamId)??0)+1!==value.seq){
      throw new HarnessSdkError("SOURCE_SEQUENCE_GAP");
    }
  }
  private async deliver(session:SessionRecord,event:AhpEvent):Promise<void>{
    session.lastByStream.set(event.streamId,event.seq);
    const scope={turnId:event.turnId,itemId:event.itemId};
    if(event.type==="session/metadata"||event.type==="extension"&&event.payload.name===METADATA_EXTENSION.name){
      if(!this.result||!supportsExtension(this.result.capabilities,METADATA_EXTENSION.name,METADATA_EXTENSION.version))throw new HarnessSdkError("CAPABILITY_UNSUPPORTED");
      if(event.type==="extension"&&event.payload.version!==METADATA_EXTENSION.version)throw new HarnessSdkError("CAPABILITY_UNSUPPORTED");
      const metadata=event.type==="session/metadata"?event.payload:event.payload.data;
      assertDefinition<import("@anureo/protocol").SessionMetadata>("SessionMetadata",metadata);
      if(Object.hasOwn(metadata,"title"))session.metadataObserved=true;
      await session.sink.emit({type:"session/metadata",payload:metadata});return;
    }
    if(event.type==="interaction/requested"){
      const request=event.payload,key=`${event.sessionId}:${request.interactionId}`;
      session.pendingInteractionIds.add(request.interactionId);
      void session.sink.requestInteraction(request,(response,reason)=>
        this.respondToInteraction(session,event,request,key,response,reason)
      ).catch(()=>{});
      return;
    }
    if(event.type==="interaction/resolved"){
      const key=`${event.sessionId}:${event.payload.interactionId}`;
      const inFlightResponse=this.inFlightInteractionResponses.get(key);
      if(inFlightResponse){inFlightResponse.resolve(event.payload);return;}
      if(session.pendingInteractionIds.has(event.payload.interactionId)){
        session.pendingInteractionIds.delete(event.payload.interactionId);
        await session.sink.resolveInteraction(event.payload);return;
      }
      return; // Acknowledgement duplicated after the response RPC completed locally.
    }
    if(event.type==="session/state"&&event.payload.metadata&&Object.hasOwn(event.payload.metadata,"title"))session.metadataObserved=true;
    await session.sink.emit({type:event.type,payload:event.payload} as Parameters<SessionEventSink["emit"]>[0],scope);
  }
  private async respondToInteraction(
    session:SessionRecord,
    event:AhpEvent,
    request:InteractionRequested,
    key:string,
    response:InteractionResponse|null,
    reason?:string,
  ):Promise<void>{
    let resolve!:(result:InteractionResult)=>void;
    let reject!:(cause:unknown)=>void;
    const confirmation=new Promise<InteractionResult>((yes,no)=>{resolve=yes;reject=no;});
    this.inFlightInteractionResponses.set(key,{resolve,reject});
    try{
      const method=response?"interaction/respond":"interaction/cancel";
      const call=this.wire!.request(method,{
        requestId:`ahp:${event.streamId}:${event.seq}`,
        sessionId:event.sessionId,
        interactionId:request.interactionId,
        ...(response?{response}:{reason}),
      });
      const result=await Promise.race([call,confirmation]);
      assertResult(method,result);
      if(result.outcome==="unknown")throw new HarnessSdkError("RESULT_UNKNOWN","RESULT_UNKNOWN",false,true);
    }finally{
      this.inFlightInteractionResponses.delete(key);
      session.pendingInteractionIds.delete(request.interactionId);
    }
  }
  async openSession(params:SessionOpenParams,sink:SessionEventSink):Promise<BackendSession>{
    if(!this.wire||this.disposed)throw new HarnessSdkError("NOT_INITIALIZED");
    if(this.sessions.has(params.binding.sessionId))throw new HarnessSdkError("SESSION_ALREADY_OPEN");
    const record:SessionRecord={
      sink,
      lastByStream:new Map(),
      pendingInteractionIds:new Set()
    };
    this.sessions.set(params.binding.sessionId,record);

    try{
      const opened=await this.wire.request("session/open",params);
      assertResult("session/open",opened);
      if(opened.binding.sessionId!==params.binding.sessionId||opened.binding.adapterId!==params.binding.adapterId||opened.binding.runtimeConfigId!==params.binding.runtimeConfigId)throw new HarnessSdkError("SESSION_BINDING_MISMATCH");
      if(this.retiredStreams.has(JSON.stringify([params.binding.sessionId,opened.streamId])))throw new HarnessSdkError("SOURCE_STREAM_UNAVAILABLE");
      record.streamId=opened.streamId;

      if(!record.metadataObserved&&opened.state?.metadata)await sink.emit({type:"session/metadata",payload:opened.state.metadata});

      const adapter=this;
      return {
        binding:opened.binding,
        capabilities:opened.capabilities,
        state:opened.state,
        async execute<M extends SessionMethod>(method:M,p:AhpRequestMap[M]):Promise<AhpResultMap[M]>{
          const result=await adapter.wire!.request(method,p);
          assertResult(method,result);
          return result;
        },
        async dispose(){
          adapter.retire(params.binding.sessionId,record);
        }
      };
    }catch(cause){
      this.sessions.delete(params.binding.sessionId);
      throw cause;
    }
  }
  private retire(sessionId:string,record:SessionRecord):void{
    if(this.sessions.get(sessionId)!==record)return;
    this.sessions.delete(sessionId);
    if(record.streamId){
      this.retiredStreams.add(JSON.stringify([sessionId,record.streamId]));
      if(this.retiredStreams.size>128)this.retiredStreams.delete(this.retiredStreams.values().next().value!);
    }
  }
  async dispose():Promise<void>{if(this.disposed)return;this.disposed=true;await this.wire?.close();this.sessions.clear();}
}
export function createAhpAdapter(options:AhpAdapterOptions):HarnessAdapter{return new AhpAdapter(options);}
