import { BoundedEventQueue,HarnessSdkError } from "@anureo/sdk";
import type { AhpTransport } from "./wire";
export async function createWebSocketTransport(url:string,options:{factory?:(url:string)=>WebSocket;timeoutMs?:number;maxFrameBytes?:number;maxBufferedBytes?:number}={}):Promise<AhpTransport>{
  const address=new URL(url);
  const isSupportedProtocol = ["ws:", "wss:"].includes(address.protocol);
  const hasForbiddenAddressInfo = Boolean(address.username || address.password || address.search || address.hash);
  const isPlaintextRemoteHost = address.protocol === "ws:"
    && !["127.0.0.1", "localhost", "[::1]"].includes(address.hostname);
  if (!isSupportedProtocol || hasForbiddenAddressInfo || isPlaintextRemoteHost) {
    throw new HarnessSdkError("INVALID_PARAMS", "Invalid AHP WebSocket address");
  }
  if(!options.factory&&typeof WebSocket==="undefined")throw new HarnessSdkError("WEBSOCKET_FACTORY_REQUIRED");
  const socket=options.factory?options.factory(url):new WebSocket(url);
  const queue=new BoundedEventQueue<string>({maxFrameBytes:options.maxFrameBytes,maxBytes:options.maxBufferedBytes??16*1024*1024,maxEvents:2048},v=>new TextEncoder().encode(v).byteLength);
  let closed=false;
  const fail=()=>{queue.end(new HarnessSdkError("RPC_CONNECTION_CLOSED","RPC_CONNECTION_CLOSED",false,true));};
  socket.addEventListener("message",event=>{try{if(typeof event.data!=="string")throw new HarnessSdkError("PROTOCOL_ERROR");queue.push(event.data);}catch(cause){queue.end(cause);socket.close();}});
  socket.addEventListener("close",()=>{closed=true;fail();});socket.addEventListener("error",fail);
  await new Promise<void>((resolve,reject)=>{
    const timeout=setTimeout(()=>{socket.close();reject(new HarnessSdkError("RPC_TIMEOUT"));},options.timeoutMs??30_000);
    const cleanupConnectionWait = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onConnectionFailure);
      socket.removeEventListener("close", onConnectionFailure);
    };
    const onOpen = () => {
      cleanupConnectionWait();
      resolve();
    };
    const onConnectionFailure = () => {
      cleanupConnectionWait();
      reject(new HarnessSdkError("RPC_CONNECTION_FAILED"));
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onConnectionFailure);
    socket.addEventListener("close", onConnectionFailure);
    if (socket.readyState === 1) onOpen();
  });
  return {
    messages: queue,
    async send(message) {
      if (closed || socket.readyState !== 1) {
        throw new HarnessSdkError("RPC_CONNECTION_CLOSED", "RPC_CONNECTION_CLOSED", false, true);
      }
      if (socket.bufferedAmount > (options.maxBufferedBytes ?? 16 * 1024 * 1024)) {
        throw new HarnessSdkError("BACKPRESSURE_EXCEEDED");
      }
      socket.send(message);
    },
    async close() {
      if (closed) return;
      closed = true;
      socket.close();
      queue.end();
    },
  };
}
