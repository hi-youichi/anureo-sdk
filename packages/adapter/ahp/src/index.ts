/** Negotiates a remote AHP peer and routes its validated streams into SDK session sinks. */
import { HarnessSdkError,type HarnessAdapter,type BackendSession,type SessionEventSink,type SessionMethod } from "@anureo/sdk";
import { assertRequest,assertDefinition,assertEvent,assertResult,negotiateVersion,supportsExtension,publicValue,type JsonValue,type AhpEvent,type AhpRequestMap,type AhpResultMap,type InitializeParams,type InitializeResult,type SessionOpenParams,type InteractionRequested,type InteractionResult,type InteractionResponse } from "@anureo/protocol";
import { AhpWire,createStdioTransport,type AhpTransport,type WireOptions } from "./wire";
export { AhpWire,createStdioTransport,type AhpTransport } from "./wire";
export { createWebSocketTransport } from "./websocket";
/**
 * Configure one adapter-owned connection. Selection is transport, then url/connect, then command;
 * wire limits and timeouts apply to that connection. Client disposal closes the selected transport.
 */
export interface AhpAdapterOptions extends WireOptions {
  /** Supply a connection or an asynchronous factory invoked once on the first valid initialize call. */
  transport?:AhpTransport|(()=>Promise<AhpTransport>);
  /** Executable and process options used when neither transport nor url is supplied. */
  command?:string;
  args?:string[];
  env?:Record<string,string|undefined>;
  cwd?:string;
  /** A url requires connect; no WebSocket implementation is selected implicitly. */
  url?:string;
  /** Open the url connection; the adapter assumes responsibility for closing the returned transport. */
  connect?:(url:string)=>Promise<AhpTransport>;
  /** Override stdio process creation; the returned process is released through its dispose method. */
  processFactory?:Parameters<typeof createStdioTransport>[0]["processFactory"];
}
/**
 * Connect SDK sessions to one AHP peer. Applications normally use createAhpAdapter with createClient;
 * direct users must initialize first and release session handles before disposing this adapter.
 */
export class AhpAdapter implements HarnessAdapter {
  /** Configure without I/O; await initialize before opening and dispose after session cleanup. */
  constructor(private readonly options:AhpAdapterOptions){}
  /**
   * Negotiate once and send initialized before resolving. Valid calls share the first attempt,
   * including rejection; invalid params/version throw synchronously, while disposal and connection
   * failures reject. Client.initialize awaits this through its adapter wrapper and stores capabilities.
   */
  initialize(params:InitializeParams):Promise<InitializeResult>{
    if(this.disposed)return Promise.reject(new HarnessSdkError('RUNTIME_DISPOSED'));
    assertRequest("initialize",params);
    negotiateVersion(params.protocolVersions);
    return this.initialized??=this.initializeConnection(params);
  }
  /**
   * Open a remote session, accepting notifications during the RPC, and publish fallback metadata
   * before returning its backend handle. Reject duplicate IDs, invalid bindings or retired streams;
   * failed setup removes local routing. The SDK wrapper supplies the sink and owns backend disposal.
   */
  async openSession(params:SessionOpenParams,sink:SessionEventSink):Promise<BackendSession>{
    if(!this.wire||this.disposed)throw new HarnessSdkError("NOT_INITIALIZED");
    if(this.sessions.has(params.binding.sessionId))throw new HarnessSdkError("SESSION_ALREADY_OPEN");
    const wire=this.wire;
    const record:SessionRecord={
      sink,
      lastByStream:new Map(),
      pendingInteractionIds:new Set()
    };
    this.sessions.set(params.binding.sessionId,record);

    try{
      const opened=await wire.request("session/open",params);
      assertResult("session/open",opened);
      if(opened.binding.sessionId!==params.binding.sessionId||opened.binding.adapterId!==params.binding.adapterId||opened.binding.runtimeConfigId!==params.binding.runtimeConfigId)throw new HarnessSdkError("SESSION_BINDING_MISMATCH");
      if(this.retiredStreams.has(streamKey(params.binding.sessionId,opened.streamId)))throw new HarnessSdkError("SOURCE_STREAM_UNAVAILABLE");
      record.streamId=opened.streamId;

      if(!record.metadataObserved&&opened.state?.metadata)await sink.emit({type:"session/metadata",payload:opened.state.metadata});

      const adapter=this;
      return {
        binding:opened.binding,
        capabilities:opened.capabilities,
        state:opened.state,
        /** Return a validated remote result or reject the RPC/schema failure; the SDK validates input. */
        async execute<M extends SessionMethod>(method:M,p:AhpRequestMap[M]):Promise<AhpResultMap[M]>{
          const result=await wire.request(method,p);
          assertResult(method,result);
          return result;
        },
        /** Release local routing only; session/close is a separate remote request owned by the SDK. */
        async dispose(){
          adapter.retire(params.binding.sessionId,record);
        }
      };
    }catch(cause){
      this.sessions.delete(params.binding.sessionId);
      throw cause;
    }
  }
  /**
   * Close the owned connection and clear routing after successful close; reject cleanup failure.
   * The SDK disposes session handles first. Calls after disposal starts return immediately, and a
   * transport still being acquired is closed by initialize before that attempt rejects.
   */
  async dispose():Promise<void>{if(this.disposed)return;this.disposed=true;await this.wire?.close();this.sessions.clear();}

  private wire?:AhpWire;private initialized?:Promise<InitializeResult>;private result?:InitializeResult;
  private readonly sessions=new Map<string,SessionRecord>();
  private readonly retiredStreams=new Set<string>();
  // Registered only while a response callback runs; its finally or wire close removes the entry.
  private readonly inFlightInteractionResponses=new Map<string,InFlightInteractionResponse>();
  private disposed=false;
  /** Acquire the connection, install routing before the handshake, then publish negotiated readiness. */
  private async initializeConnection(params:InitializeParams):Promise<InitializeResult>{
    let transport:AhpTransport;
    if(this.options.transport){
      transport=typeof this.options.transport==="function"
        ?await this.options.transport()
        :this.options.transport;
    }else if(this.options.url){
      if(!this.options.connect)throw new HarnessSdkError("WEBSOCKET_FACTORY_REQUIRED");
      transport=await this.options.connect(this.options.url);
    }else{
      if(!this.options.command)throw new HarnessSdkError("HARNESS_UNAVAILABLE");
      transport=await createStdioTransport({...this.options,command:this.options.command});
    }
    if(this.disposed){
      await transport.close();
      throw new HarnessSdkError('RUNTIME_DISPOSED');
    }
    const wire=this.wire=new AhpWire(transport,this.options);
    wire.onNotification=(method,event)=>this.notification(wire,method,event);
    wire.onClose=cause=>this.failConnection(cause);
    const clientCapabilities={
      ...params.clientCapabilities,
      extensions:[
        ...(params.clientCapabilities?.extensions??[]).filter(e=>e.name!==METADATA_EXTENSION.name),
        METADATA_EXTENSION,
      ],
    };
    const result=await wire.request("initialize",{...params,clientCapabilities});
    assertResult("initialize",result);
    negotiateVersion([result.protocolVersion]);
    this.result=result;
    await wire.notify("initialized");
    return result;
  }
  /** AhpWire awaits this on close; fail sinks in registration order before rejecting response waiters. */
  private async failConnection(cause:unknown):Promise<void>{
    for(const session of this.sessions.values())await session.sink.fail(cause);
    for(const response of this.inFlightInteractionResponses.values())response.reject(cause);
    this.inFlightInteractionResponses.clear();
  }
  /**
   * AhpWire serializes these callbacks while continuing to read RPC replies. Ignore duplicates and
   * retired streams; repair gaps before delivery and surface unknown methods as notices. Rejection
   * makes the wire close and fail its sinks.
   */
  private async notification(wire:AhpWire,method:string,value:unknown):Promise<void>{
    if(!KNOWN_NOTIFICATIONS.includes(method)){
      const raw=publicValue(JSON.parse(JSON.stringify(value??null)) as JsonValue);
      for(const session of this.sessions.values())await session.sink.emit({type:"notice",payload:{severity:"info",code:"UNKNOWN_NOTIFICATION",message:"Unknown AHP notification",raw}});
      return;
    }
    assertEvent(value);if(value.type!==method)throw new HarnessSdkError("PROTOCOL_ERROR");
    if(this.retiredStreams.has(streamKey(value.sessionId,value.streamId)))return;
    const session=this.sessions.get(value.sessionId);if(!session)throw new HarnessSdkError("SOURCE_SESSION_MISMATCH");
    const last=session.lastByStream.get(value.streamId)??0;if(value.seq<=last)return;
    if(session.streamId&&session.streamId!==value.streamId)throw new HarnessSdkError("SOURCE_STREAM_UNAVAILABLE");session.streamId=value.streamId;
    if(value.seq!==last+1){
      await this.replayMissingEvents(wire,session,value,last);
    }
    await this.deliver(wire,session,value);
  }
  /** Fill exactly the missing prefix of this stream, rejecting unsupported, foreign or incomplete replay. */
  private async replayMissingEvents(wire:AhpWire,session:SessionRecord,value:AhpEvent,last:number):Promise<void>{
    if(!this.result||!supportsExtension(this.result.capabilities,"x-anureo/event-replay","1")){
      throw new HarnessSdkError("SOURCE_SEQUENCE_GAP");
    }
    const raw=await wire.request("x-anureo/events/read",{
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
      await this.deliver(wire,session,event);
    }
    if((session.lastByStream.get(value.streamId)??0)+1!==value.seq){
      throw new HarnessSdkError("SOURCE_SEQUENCE_GAP");
    }
  }
  /**
   * Advance source sequence before sink publication, map negotiated metadata and register interaction
   * responders. Interaction waits run separately so their confirming notifications can be delivered.
   */
  private async deliver(wire:AhpWire,session:SessionRecord,event:AhpEvent):Promise<void>{
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
        this.respondToInteraction({wire,session,event,request,key,response,reason})
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
  /**
   * The sink invokes this responder for a host answer or cancellation. Await the RPC reply or a
   * matching remote resolution, validate the winner and reject unknown outcomes; the sink owns
   * local settlement publication. Always release both pending-response registrations, without retry.
   */
  private async respondToInteraction({wire,session,event,request,key,response,reason}:InteractionResponseInput):Promise<void>{
    let resolve!:(result:InteractionResult)=>void;
    let reject!:(cause:unknown)=>void;
    const confirmation=new Promise<InteractionResult>((yes,no)=>{resolve=yes;reject=no;});
    this.inFlightInteractionResponses.set(key,{resolve,reject});
    try{
      const method=response?"interaction/respond":"interaction/cancel";
      const call=wire.request(method,{
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
  /** Remove only this registration and retain up to 128 retired stream identities to ignore late events. */
  private retire(sessionId:string,record:SessionRecord):void{
    if(this.sessions.get(sessionId)!==record)return;
    this.sessions.delete(sessionId);
    if(record.streamId){
      this.retiredStreams.add(streamKey(sessionId,record.streamId));
      if(this.retiredStreams.size>128)this.retiredStreams.delete(this.retiredStreams.values().next().value!);
    }
  }
}
/** Create an uninitialized adapter for createClient; the returned Client owns initialization and disposal. */
export function createAhpAdapter(options:AhpAdapterOptions):HarnessAdapter{return new AhpAdapter(options);}

/** Captures the connection and source request while the sink owns the response/cancellation lifecycle. */
interface InteractionResponseInput {
  wire:AhpWire;
  session:SessionRecord;
  event:AhpEvent;
  request:InteractionRequested;
  key:string;
  response:InteractionResponse|null;
  reason?:string;
}

interface SessionRecord {
  sink:SessionEventSink;
  /** Source sequences already admitted for delivery, including a publication still being awaited. */
  lastByStream:Map<string,number>;
  /** Expected source, learned from an early notification or the open reply. */
  streamId?:string;
  /** An explicit title, including null, suppresses fallback metadata from the open reply. */
  metadataObserved?:boolean;
  // Registered on receipt; removed by external resolution or the response callback's finally.
  pendingInteractionIds:Set<string>;
}
interface InFlightInteractionResponse {resolve:(result:InteractionResult)=>void;reject:(cause:unknown)=>void}
const METADATA_EXTENSION = {name:"x-anureo/session-metadata",version:"1"};
const KNOWN_NOTIFICATIONS = ["submission/bound","submission/status","session/metadata","session/state","turn/started","turn/completed","item/started","item/delta","item/completed","usage/updated","interaction/requested","interaction/resolved","notice","extension"];

/** Preserve tuple boundaries even when either peer-supplied identifier contains a separator. */
function streamKey(sessionId:string,streamId:string):string{return JSON.stringify([sessionId,streamId]);}
