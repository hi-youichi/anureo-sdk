import { HarnessSdkError } from "@anureo/sdk";
import { spawnHarnessProcess,type HarnessProcess,type HarnessProcessOptions } from "@anureo/sdk/process";

export interface AhpTransport {messages:AsyncIterable<string>;send:(message:string)=>Promise<void>;close:()=>Promise<void>}
export interface WireOptions {timeoutMs?:number;maxFrameBytes?:number;maxPending?:number;maxNotifications?:number;diagnostic?:(code:string)=>void}

function remoteErrorToSdkError(error:Record<string,unknown>):HarnessSdkError {
  const data=error.data&&typeof error.data==="object"
    ? error.data as Record<string,unknown>
    : {};
  let code="AHP_RPC_ERROR";
  if(typeof data.code==="string") {
    code=data.code;
  }else if(error.code===-32601) {
    code="CAPABILITY_UNSUPPORTED";
  }
  const retryable=data.retryable===true;
  const outcomeUnknown=data.outcomeUnknown===true;
  return new HarnessSdkError(code,"AHP_RPC_ERROR",retryable,outcomeUnknown);
}

export class AhpWire {
  private nextId=1;
  private readonly pending=new Map<number,{resolve:(r:unknown)=>void;reject:(e:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();
  private closing=false;
  // Covers the close callback and transport cleanup; does not await the read loop or notification queue.
  private closePromise?:Promise<void>;
  private notificationTail=Promise.resolve();
  private queuedNotificationCount=0;
  private readonly loop:Promise<void>;
  onNotification?:(method:string,params:unknown)=>Promise<void>|void;
  onClose?:(cause:unknown)=>Promise<void>|void;
  constructor(private readonly transport:AhpTransport,private readonly options:WireOptions={}){this.loop=this.read();void this.loop.catch(()=>{});}
  request(method:string,params:unknown):Promise<unknown> {
    if(this.closing)return Promise.reject(new HarnessSdkError("RPC_CONNECTION_CLOSED","RPC_CONNECTION_CLOSED",false,true));
    if(this.pending.size>=(this.options.maxPending??256))return Promise.reject(new HarnessSdkError("BACKPRESSURE_EXCEEDED"));
    const id=this.nextId++,message=JSON.stringify({jsonrpc:"2.0",id,method,params});
    if(new TextEncoder().encode(message).byteLength>(this.options.maxFrameBytes??8*1024*1024))return Promise.reject(new HarnessSdkError("FRAME_TOO_LARGE"));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new HarnessSdkError("RPC_TIMEOUT","RPC_TIMEOUT",false,true,{method}));},this.options.timeoutMs??30_000);
      this.pending.set(id,{resolve,reject,timer});
      void this.transport.send(message).catch(()=>{const p=this.pending.get(id);if(p){clearTimeout(p.timer);this.pending.delete(id);p.reject(new HarnessSdkError("RPC_CONNECTION_CLOSED","RPC_CONNECTION_CLOSED",false,true));}});
    });
  }
  notify(method:string,params?:unknown):Promise<void>{return this.transport.send(JSON.stringify({jsonrpc:"2.0",method,...(params===undefined?{}:{params})}));}
  private async read():Promise<void>{
    let failure:unknown=new HarnessSdkError("RPC_CONNECTION_CLOSED","RPC_CONNECTION_CLOSED",false,true);
    try{
      for await(const frame of this.transport.messages){
        if(this.closing)break;
        if(new TextEncoder().encode(frame).byteLength>(this.options.maxFrameBytes??8*1024*1024))throw new HarnessSdkError("FRAME_TOO_LARGE");
        let value:unknown;try{value=JSON.parse(frame);}catch{throw new HarnessSdkError("PROTOCOL_ERROR");}
        if(!value||typeof value!=="object"||Array.isArray(value))throw new HarnessSdkError("PROTOCOL_ERROR");
        const message=value as Record<string,unknown>;
        if(message.jsonrpc!=="2.0")throw new HarnessSdkError("PROTOCOL_ERROR");
        if(typeof message.method==="string") {
          if(message.id!==undefined){await this.transport.send(JSON.stringify({jsonrpc:"2.0",id:message.id,error:{code:-32601,message:"Method not found"}}));continue;}
          this.enqueueNotification(message);
        }else{
          const pending=this.pending.get(message.id as number);
          if(!pending)continue;
          clearTimeout(pending.timer);
          this.pending.delete(message.id as number);

          if(message.error&&typeof message.error==="object"){
            pending.reject(remoteErrorToSdkError(message.error as Record<string,unknown>));
          }else if(Object.hasOwn(message,"result")){
            pending.resolve(message.result);
          }else{
            pending.reject(new HarnessSdkError("PROTOCOL_ERROR"));
          }
        }
      }
    }catch(cause){failure=cause;}
    if(!this.closing)await this.beginClose(failure);
  }
  private enqueueNotification(message:Record<string,unknown>):void {
    if(++this.queuedNotificationCount>(this.options.maxNotifications??2048))throw new HarnessSdkError("BACKPRESSURE_EXCEEDED");
    // Notifications run serially without blocking response reads.
    // Failure cleanup does not cancel callbacks that are already queued.
    this.notificationTail=this.notificationTail
      .then(()=>this.onNotification?.(message.method as string,message.params))
      .catch(cause=>this.beginClose(cause).catch(()=>{}))
      .finally(()=>this.queuedNotificationCount--);
  }
  private beginClose(cause:unknown):Promise<void>{
    if(this.closePromise)return this.closePromise;
    this.closing=true;
    for(const pending of this.pending.values()){
      clearTimeout(pending.timer);
      pending.reject(new HarnessSdkError("RPC_CONNECTION_CLOSED","RPC_CONNECTION_CLOSED",false,true));
    }
    this.pending.clear();
    return this.closePromise=Promise.resolve().then(async()=>{
      try{this.options.diagnostic?.(cause instanceof HarnessSdkError?cause.code:"PROTOCOL_ERROR");}catch{/* Diagnostics do not own connection cleanup. */}
      const [closeHandlerResult,transportCloseResult]=await Promise.allSettled([
        Promise.resolve().then(()=>this.onClose?.(cause)),
        Promise.resolve().then(()=>this.transport.close()),
      ]);
      const errors:{code:string}[]=[];
      if(closeHandlerResult.status==='rejected'){
        errors.push({code:'AHP_CLOSE_HANDLER_FAILED'});
      }
      if(transportCloseResult.status==='rejected'){
        errors.push({code:'AHP_TRANSPORT_CLOSE_FAILED'});
      }
      if(errors.length)throw new HarnessSdkError('RESOURCE_RELEASE_FAILED','AHP connection cleanup failed',false,true,{errors});
    });
  }
  close():Promise<void>{return this.beginClose(new HarnessSdkError("RUNTIME_DISPOSED"));}
}

export async function createStdioTransport(options:HarnessProcessOptions&{processFactory?:(p:HarnessProcessOptions)=>Promise<HarnessProcess>;maxFrameBytes?:number}):Promise<AhpTransport> {
  const process=await (options.processFactory??spawnHarnessProcess)(options);
  const maxFrameBytes=options.maxFrameBytes??8*1024*1024;
  // Drain diagnostics without copying secret-bearing raw stderr into public errors/logs.
  void (async()=>{for await(const _ of process.stderr){}})().catch(()=>{});
  async function* messages():AsyncIterable<string>{
    const decoder=new TextDecoder();
    let buffer="";
    for await(const chunk of process.stdout){
      buffer+=decoder.decode(chunk,{stream:true});

      for(;;){
        const newlineIndex=buffer.indexOf("\n");
        if(newlineIndex<0)break;
        const line=buffer.slice(0,newlineIndex).replace(/\r$/,"");
        buffer=buffer.slice(newlineIndex+1);
        if(new TextEncoder().encode(line).byteLength>maxFrameBytes)throw new HarnessSdkError("FRAME_TOO_LARGE");
        if(line)yield line;
      }

      // Bound the unfinished frame even before its newline arrives.
      if(new TextEncoder().encode(buffer).byteLength>maxFrameBytes)throw new HarnessSdkError("FRAME_TOO_LARGE");
    }

    buffer+=decoder.decode();
    if(buffer.trim())throw new HarnessSdkError("PROTOCOL_ERROR","Unterminated AHP frame");
  }
  return {messages:messages(),send:message=>process.write(message+"\n"),close:()=>process.dispose()};
}
