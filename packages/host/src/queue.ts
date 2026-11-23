import type { InputBlock,JsonObject,JsonSchema } from '@anureo/protocol';
import type { HxQueueItem,HxQueueState } from './legacy-protocol';
/** The durable execution snapshot stays private; public input is the caller's original content. */
export type StoredQueueItem=HxQueueItem&{
  executionInput:InputBlock[];configSnapshot:JsonObject;modelSnapshot?:string;runtimeConfigId:string;ownerId:string;
  overrides?:JsonObject;outputSchema?:JsonSchema;
};
export type StoredQueueState=Omit<HxQueueState,'items'>&{items:StoredQueueItem[]};
export function publicQueue(state:StoredQueueState):HxQueueState {
  return {revision:state.revision,paused:state.paused,items:state.items.map(({executionInput,configSnapshot,modelSnapshot,runtimeConfigId,ownerId,overrides,outputSchema,...item})=>item)};
}
export const queuePending=(item:HxQueueItem)=>!['completed','cancelled'].includes(item.state);
