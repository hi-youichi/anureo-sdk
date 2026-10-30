import { BoundedEventQueue,HarnessSdkError } from "@anureo/sdk";
import type { AhpTransport } from "./wire";
export async function createWebSocketTransport(url:string,options:{factory?:(url:string)=>WebSocket;timeoutMs?:number;maxFrameBytes?:number;maxBufferedBytes?:number}={}):Promise<AhpTransport>{
  const address=new URL(url);
  if(!["ws:","wss:"].includes(address.protocol)||address.username||address.password||address.search||address.hash||(address.protocol==="ws:"&&!["127.0.0.1","localhost","[::1]"].includes(address.hostname)))throw new HarnessSdkError("INVALID_PARAMS","Invalid AHP WebSocket address");
  if(!options.factory&&typeof WebSocket==="undefined")throw new HarnessSdkError("WEBSOCKET_FACTORY_REQUIRED");
  const socket=options.factory?options.factory(url):new WebSocket(url);
  const queue=new BoundedEventQueue<string>({maxFrameBytes:options.maxFrameBytes,maxBytes:options.maxBufferedBytes??16*1024*1024,maxEvents:2048},v=>new TextEncoder().encode(v).byteLength);
  let closed=false;
  const fail=()=>{queue.end(new HarnessSdkError("RPC_CONNECTION_CLOSED","RPC_CONNECTION_CLOSED",false,true));};
  socket.addEventListener("message",event=>{try{if(typeof event.data!=="string")throw new HarnessSdkError("PROTOCOL_ERROR");queue.push(event.data);}catch(cause){queue.end(cause);socket.close();}});
  socket.addEventListener("close",()=>{closed=true;fail();});socket.addEventListener("error",fail);
  await new Promise<void>((resolve,reject)=>{
    const timeout=setTimeout(()=>{socket.close();reject(new HarnessSdkError("RPC_TIMEOUT"));},options.timeoutMs??30_000);
    const finish=()=>{clearTimeout(timeout);socket.removeEventListener("open",opened);socket.removeEventListener("error",failed);socket.removeEventListener("close",failed);};
    const opened=()=>{finish();resolve();},failed=()=>{finish();reject(new HarnessSdkError("RPC_CONNECTION_FAILED"));};
    socket.addEventListener("open",opened);socket.addEventListener("error",failed);socket.addEventListener("close",failed);
    if(socket.readyState===1)opened();
  });
  return {messages:queue,async send(message){if(closed||socket.readyState!==1)throw new HarnessSdkError("RPC_CONNECTION_CLOSED","RPC_CONNECTION_CLOSED",false,true);if(socket.bufferedAmount>(options.maxBufferedBytes??16*1024*1024))throw new HarnessSdkError("BACKPRESSURE_EXCEEDED");socket.send(message);},async close(){if(closed)return;closed=true;socket.close();queue.end();}};
}
