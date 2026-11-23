import { SecretRedactor } from "@anureo/sdk";
import type { AhpEventPayload,JsonValue } from "@anureo/protocol";
import type { HarnessStore } from "./store";
import { HostError } from "./errors";

/** Only irreversible keyed hints persist; raw answers and their delta tails remain in memory. */
export class PersistentSecretRedactor extends SecretRedactor {
  private readonly tails=new Map<string,string>();
  private bytes=0;
  constructor(private readonly store:HarnessStore,private readonly sessionId:string){super(value=>store.rememberPrivate(sessionId,value));}
  override text(value:string):string{return this.store.scanPrivate(this.sessionId,value).text;}
  override json(value:JsonValue):JsonValue {
    if((typeof value==="number"||typeof value==="boolean")&&this.store.scanPrivate(this.sessionId,String(value)).text!==String(value))return "[redacted]";
    return super.json(value);
  }
  override delta(stream:string,value:string):string {
    const old=this.tails.get(stream)??"",result=this.store.scanPrivate(this.sessionId,old+value,false);
    const bytes=new TextEncoder().encode(result.pending).byteLength-new TextEncoder().encode(old).byteLength;
    if(this.bytes+bytes>16*1024*1024||(!this.tails.has(stream)&&result.pending&&this.tails.size>=2048))throw new HostError("BACKPRESSURE_EXCEEDED");
    this.bytes+=bytes;
    if(result.pending)this.tails.set(stream,result.pending);else this.tails.delete(stream);
    return result.text;
  }
  override event(event:AhpEventPayload,turnId?:string):AhpEventPayload {
    if(event.type==="item/completed"){
      const itemId=event.payload.item.id;
      const key=turnId===undefined?itemId:JSON.stringify([turnId,itemId]);
      const tail=this.tails.get(key);
      if(tail){this.bytes-=new TextEncoder().encode(tail).byteLength;this.tails.delete(key);}
    }
    if(event.type==="turn/completed"){this.tails.clear();this.bytes=0;}
    return super.event(event,turnId);
  }
}
