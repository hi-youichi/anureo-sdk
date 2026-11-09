import { createClient, type HarnessAdapter, type Client, type Session, type RuntimeOptions, type InteractionHandlers } from '@anureo/sdk';
import type { Capabilities, AhpEvent, InteractionRequested, InteractionResponse, SessionOpenParams } from '@anureo/protocol';

export const CONFORMANCE_SCENARIOS = ['lifecycle','immediate','identity','approval','userInput','elicitation','dynamicTool','interrupt','steer','fork','revert','history','unknown-item','disconnect','backpressure'] as const;
export type ConformanceScenario = typeof CONFORMANCE_SCENARIOS[number];
export interface ConformanceDriver {
  adapter: HarnessAdapter;
  openParams: SessionOpenParams;
  runtimeOptions?: RuntimeOptions;
  afterStart?: (session: Session) => Promise<void>;
  expectedText?: string;
  answer?: (request: InteractionRequested) => InteractionResponse;
}
export type ConformanceFactory = (scenario: ConformanceScenario) => Promise<ConformanceDriver> | ConformanceDriver;
export interface ConformanceCaseResult { scenario: ConformanceScenario; status: 'passed' | 'failed' | 'not-applicable'; message?: string }
export interface ConformanceReport { passed: boolean; cases: ConformanceCaseResult[] }
function requireCondition(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Conformance timed out')),timeoutMs);promise.then(value=>{clearTimeout(timer);resolve(value);},cause=>{clearTimeout(timer);reject(cause);});});
}
function applicable(scenario: ConformanceScenario, c: Capabilities): boolean {
  if (['approval','userInput','elicitation','dynamicTool'].includes(scenario)) return c.interactions?.includes(scenario as InteractionRequested['kind']) ?? false;
  if(scenario==='steer')return c.input?.steer?.atomicMatch===true;
  if(scenario==='interrupt')return !!c.input?.interrupt?.targets.length;
  if(scenario==='fork')return !!c.session?.fork?.length;
  if(scenario==='revert')return !!c.session?.revert?.length;
  if(scenario==='history')return !!c.session?.history;
  return true;
}
function defaultAnswer(r: InteractionRequested): InteractionResponse {
  switch(r.kind){
    case 'approval':return {kind:r.kind,optionId:r.options[0]!.id};
    case 'userInput':return {kind:r.kind,answers:Object.fromEntries(r.questions.map(q=>[q.id,q.options?.[0]?.id??'conformance']))};
    case 'elicitation':return {kind:r.kind,action:'decline'};
    case 'dynamicTool':return {kind:r.kind,content:[{type:'text',text:'conformance'}]};
  }
}
/** Drives the public root client and native fixtures; no separate lifecycle dispatcher. */
export async function runConformance(factory: ConformanceFactory, options: {timeoutMs?:number;scenarios?:readonly ConformanceScenario[]}={}):Promise<ConformanceReport>{
  const cases:ConformanceCaseResult[]=[];
  for(const scenario of options.scenarios??CONFORMANCE_SCENARIOS){
    let client:Client|undefined,reader:AsyncIterator<AhpEvent>|undefined,reading:Promise<void>|undefined;
    try{
      const f=await factory(scenario);
      const handlers=Object.fromEntries(['approval','userInput','elicitation','dynamicTool'].map(kind=>[kind,async(r:InteractionRequested)=>(f.answer??defaultAnswer)(r)])) as InteractionHandlers;
      client=await createClient({adapter:f.adapter,identity:f.openParams.binding,runtime:f.runtimeOptions,interactions:handlers});
      const session=await client.openSession(f.openParams),sessionId=session.id,c=session.capabilities;
      if(!applicable(scenario,c)){cases.push({scenario,status:'not-applicable'});continue;}
      const events:AhpEvent[]=[];let sourceFailure:unknown;
      reader=session.events()[Symbol.asyncIterator]();
      reading=(async()=>{try{for(;;){const event=await reader!.next();if(event.done)return;events.push(event.value);if(events.length>10_000)throw new Error('Too many events without completion');}}catch(cause){sourceFailure=cause;}})();
      const run=async()=>{
        const pending=session.submit({input:'conformance'});void pending.catch(()=>{});
        if(scenario==='interrupt'&&!c.input?.interrupt?.targets.includes('turn')){await Promise.resolve();await session.interrupt();}
        const turn=await pending;
        if(scenario==='steer')await turn.steer({input:'redirect'});
        if(scenario==='interrupt'){
          if(c.input?.interrupt?.targets.includes('turn'))await turn.interrupt();

        }
        await f.afterStart?.(session);
        return {turn,result:await turn.result()};
      };
      if(scenario==='disconnect'||scenario==='backpressure'){
        let failed=false;try{await deadline(run(),options.timeoutMs??3000);}catch(cause){
          requireCondition(cause&&typeof cause==='object'&&'code'in cause,'Source failure must be typed');
          requireCondition((scenario==='disconnect'?['CONNECTION_CLOSED','ACP_CONNECTION_CLOSED','RPC_CONNECTION_CLOSED']:['BACKPRESSURE_EXCEEDED','FRAME_TOO_LARGE']).includes(String(cause.code)),`Unexpected observation error: ${String(cause.code)}`);failed=true;
        }
        requireCondition(failed,'Lost source must fail observation');
        requireCondition(!events.some(e=>e.type==='turn/completed'),'SDK must not fabricate native terminal');
      }else{
        const {turn,result}=await deadline(Promise.race([run(),reading.then(()=>{throw sourceFailure??new Error('Source ended before result');})]),options.timeoutMs??3000);
        requireCondition(result.status===(scenario==='interrupt'?'interrupted':'completed'),'Unexpected native terminal');
        requireCondition(events.filter(e=>e.type==='turn/started').length===1,'Execution must start once');
        requireCondition(events.filter(e=>e.type==='turn/completed').length===1,'Execution must end once');
        if(['approval','userInput','elicitation','dynamicTool'].includes(scenario))requireCondition(events.some(e=>e.type==='interaction/requested')&&events.some(e=>e.type==='interaction/resolved'),'Interaction not exercised');
        if(scenario==='lifecycle'||scenario==='immediate')requireCondition(result.text===(f.expectedText??'conformance'),'Authoritative final text missing');
        if(scenario==='unknown-item')requireCondition(result.items.some(item=>item.type==='toolCall'&&item.kind==='other'&&item.nativeType),'Unknown native item lost');
        if(scenario==='identity'){
          const other=await session.submit({input:'conformance'});await other.result();requireCondition(other.id!==turn.id,'Execution identity reused');
        }
        if(scenario==='history'){
          const page=await session.request('history/read',{sessionId,requestId:'history'});requireCondition(page.items.length&&page.items.every(item=>item.turnId&&item.item.id),'History identity missing');
        }
        if(scenario==='fork')for(const relation of c.session!.fork!){
          const fork=await client.sessions.fork(session.reference,{boundary:{turnId:turn.id,relation}});
          requireCondition(fork.id!==session.id&&fork.binding.adapterId===session.binding.adapterId,'Fork binding invalid');
          if(c.session?.history){const page=await fork.request('history/read',{sessionId:fork.id,requestId:'fork-history'});requireCondition(relation==='before'?!page.items.some(i=>i.turnId===turn.id):page.items.some(i=>i.turnId===turn.id),'Fork boundary lost');}
          await fork.close();
        }
        if(scenario==='revert'){
          const scope=c.session!.revert![0]!;
          const result=await session.request('session/revert',{sessionId,requestId:'revert',scope,boundary:{turnId:turn.id,relation:'before'}});
          requireCondition(result.appliedScope===scope&&result.boundary.turnId===turn.id,'Revert scope mismatch');
          if(scope!=='files'&&c.session?.history){const page=await session.request('history/read',{sessionId,requestId:'reverted-history'});requireCondition(!page.items.some(i=>i.turnId===turn.id),'Revert boundary retained');}
        }
      }
      requireCondition(!sourceFailure||scenario==='disconnect'||scenario==='backpressure','Unexpected source failure');
      requireCondition(events.every((e,i)=>e.seq===events[0]!.seq+i&&e.sessionId===sessionId&&e.streamId===events[0]!.streamId),'Source sequence gap');
      cases.push({scenario,status:'passed'});
    }catch(cause){cases.push({scenario,status:'failed',message:cause instanceof Error?cause.message:'Conformance failed'});}
    finally{await reader?.return?.();await reading;try{await client?.dispose();}catch{const entry=cases[cases.length-1];if(entry?.scenario===scenario){entry.status='failed';entry.message='RESOURCE_RELEASE_FAILED';}}}
  }
  return {passed:cases.every(c=>c.status!=='failed'),cases};
}
