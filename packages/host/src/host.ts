import { HarnessCatalogService } from "./catalog";
import { createOwnedSwarmClient } from "./swarm-client";
import { swarmWorkflowOptions } from "./swarm-workflows";
import type { SwarmWorkflowOptions } from "@anureo/adapter-swarm";
import { publicSubagents, registerSubagent, inlineSubagentHistory, type SubagentTurn, type SubagentHistoryPort, type SubagentDiscoveryPort } from './subagents';
import type { CatalogWorker,CatalogDiagnostic } from "./catalog-worker";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { realpathSync } from "node:fs";
import path from "node:path";
import { SecretRedactor,type Client,type Session } from "@anureo/sdk";
import { HarnessSdkError } from "@anureo/sdk";
import { clientInteractionCapture } from "./interaction-capture";
import { assertDefinition,publicValue,assertInteractionResponse,assertResult, type Item,type Capabilities,type JsonObject,type JsonValue,type AhpEvent,type SessionOpenParams,type InteractionResponse,type Boundary,type RevertScope,type InputBlock,type McpServer,type JsonSchema } from "@anureo/protocol";
import { isHxMethod,validateHxRequest,validateHxResult,type HxMethod,type HxRequestMap,type HxResultMap,type OperationResult,type HostEvent,type HxContextReference,type HxHarnessChangedNotification,type HxQueueState } from "./legacy-protocol";
import type { HarnessStore, SessionRecord } from "./store";
import { nativeSubagentActivity } from "./native-subagent";
import type { RpcRequest, RpcResponse } from "./rpc";
import { sessionSummary, type SessionListParams, type SessionListResult } from "./protocol";
import type { HostActor } from "./scoped-host";
import { HostError,historyReadError,hostError,rpcError } from "./errors";
import { PersistentSecretRedactor } from "./persistent-secrets";
import { publicQueue,type StoredQueueItem } from "./queue";
import { assertWorkspaceMutable,type WorkspacePort,type WorkspaceRequest,type WorkspaceAllocation,type WorkspaceStopEvidence } from "./workspaces";

export type Role="viewer"|"member"|"maintainer";
export interface Principal {userId:string;mode:"on"|"off";isAdmin?:boolean;service?:boolean}
export type HostConnection = import("./rpc").HostConnection<Principal>;
export type RuntimeAuthStatus="unknown"|"required"|"ready";
export interface RuntimeRegistration {
  discoverSubagents?:SubagentDiscoveryPort;
  readSubagentHistory?:SubagentHistoryPort;
  id:string;adapterId:string;providerId?:string;name?:string;authStatus?:RuntimeAuthStatus;version?:string;capabilities?:Capabilities;available?:boolean;reason?:string;maxConcurrency?:number;ownedRuntime?:boolean;
  /** Builds one Client per live session; createClient initializes and negotiates native-lifecycle before anything opens on it. */
  create:(context?:{commandOutputPrivacy:SecretRedactor})=>Client|Promise<Client>;
  catalogScope?:string;catalogFingerprint?:string;catalogWorker?:()=>CatalogWorker;
  models?:()=>Promise<{id:string;name:string;isDefault?:boolean;group?:"primary"|"more";effortLevels?:string[];defaultEffort?:string;supportsFast?:boolean}[]>;
  getAuthStatus?:()=>Promise<RuntimeAuthStatus>;
  /** Provider query only: return evidence, never resubmit or mutate an execution. */
  inspectExecution?:(binding:SessionRecord["binding"],turnId?:string)=>Promise<{stopped:boolean;status?:"completed"|"interrupted"|"failed";turnId?:string}>;
}
export interface PermissionPolicyPort {
  isFullAccess(context:{adapterId:string;config:JsonObject;overrides?:JsonObject}):boolean;
  downgrade(context:{adapterId:string;config:JsonObject;overrides?:JsonObject}):{config:JsonObject;overrides?:JsonObject;permissionMode?:string};
}
export interface HostProjection {
  readonly lastSeq: number;
  apply(event: HostEvent): void;
  restore(checkpoint: unknown): boolean;
  reset(): void;
  serialize(): JsonValue;
  snapshot(): readonly SubagentTurn[];
}
export type FullAccessSession={sessionId:string;projectId:string;agentId:string;title:string;running:boolean;connected:boolean};
export type PermissionDowngradeResult={downgraded:string[];deferred:string[];failed:{sessionId:string;message:string}[]};
export interface HostOptions {
  store:HarnessStore;runtimes:RuntimeRegistration[];
  projection?: {version:number;create():HostProjection};
  /** Rebuild an independent catalog; failure preserves the installed catalog. */
  loadRuntimes?:()=>Promise<RuntimeRegistration[]>;
  projectRoot:(id:string)=>string|undefined|Promise<string|undefined>;
  can:(principal:Principal,projectId:string,minimum:Role)=>boolean|Promise<boolean>;
  applicationAuthorization?:boolean;
  maxNotificationEvents?:number;maxNotificationBytes?:number;
  shutdownTimeoutMs?:number;
  /** Product may temporarily suspend the shared gate; capacity reports limit=0 (unlimited). */
  enforceConcurrencyLimits?:boolean;
  onCatalogDiagnostic?:(event:CatalogDiagnostic)=>void;
  catalogPolicy?:{freshMs?:number;refreshTimeoutMs?:number;concurrency?:number};
  onError?:(code:string)=>void;
  /** Observability fan-out: every persisted durable event, at the single publish point. Must not throw; never used for control flow. */
  onEvent?:(event:HostEvent)=>void;
  /**
   * A live session event stream failed; surfaced for forensics. `recoveryRequired` tells whether the session was moved to
   * recovery (uncertain execution) or merely closed (idle, safe to reopen). `message` is the raw source error message.
   */
  onEventStreamError?:(context:{sessionId:string;code:string;message?:string;outcomeUnknown?:boolean;recoveryRequired?:boolean})=>void;
  /** Resolve product defaults before opening a switched binding; never changes create inputs. */
  resolveHarnessConfiguration?:(context:{principal:Principal;session:ReturnType<HarnessHost['publicSession']>;runtimeConfigId:string})=>Promise<{model?:string;config:JsonObject}|undefined>;
  /** Product preference synchronization; failures never change a committed operation result. */
  onConfigurationCommitted?:(context:{principal:Principal;session:ReturnType<HarnessHost['publicSession']>;changed:string[]})=>Promise<void>|void;
  workspaces?:WorkspacePort;
  permissionPolicy?:PermissionPolicyPort;
  onBeforeTurn?:(context:{sessionId:string;turnId:string;projectId:string;cwd:string})=>Promise<void>|void;
  onTurnSettled?:(context:{sessionId:string;turnId:string;projectId:string;cwd:string;status:"completed"|"interrupted"|"failed"})=>Promise<void>|void;
  /** Product policy is injected by the authenticated Server, never imported by the SDK. */
  resolveSessionContext?:(context:{principal:Principal;projectId:string;agentId?:string;adapterId:string;runtimeConfigId?:string;providerId?:string})=>Promise<{instructions?:string;mcpServers?:McpServer[]}>;
  /** Adds per-runtime MCP credentials. The Host does not persist these servers or their headers. */
  bindRuntimeMcp?:(context:{sessionId:string;projectId:string;ownerId:string;adapterId:string;providerId?:string;mode:"new"|"resume"|"fork"})=>RuntimeMcpBinding|undefined|Promise<RuntimeMcpBinding|undefined>;
  validateConfig?:(context:{principal:Principal;sessionId?:string;projectId:string;runtimeConfigId:string;adapterId:string;config:JsonObject;overrides?:JsonObject})=>Promise<void>|void;
  prepareItem?:(context:{sessionId:string;projectId:string;cwd:string;item:Item})=>Promise<Item>;
  resolveInput?:(context:{sessionId:string;projectId:string;cwd:string;input:InputBlock[];references:HxContextReference[]})=>Promise<InputBlock[]>;
}
interface RuntimeMcpBinding {servers:readonly McpServer[];release():void}
interface LiveSession {client:Client;session:Session;reader:AsyncIterator<AhpEvent>;pump:Promise<void>;runtimeConfigId:string;registration:RuntimeRegistration;bindingGeneration:number;nativeTurnToCanonical:Map<string,string>;pendingCanonical:string[];streamSeqs:Map<string,number>;mcp?:RuntimeMcpBinding}
interface Subscription {id:string;sessionId:string;connection:HostConnection;lastSeq:number;pending:number;bytes:number;tail:Promise<void>;active:boolean}
type Values=Record<string,unknown>;
const goalWrites=["hx.goal.set","hx.goal.clear","hx.goal.pause","hx.goal.resume"] as const;
const writes=new Set(["hx.session.create","hx.session.open","hx.session.close","hx.session.fork","hx.session.revert","hx.session.config.set","hx.session.archive","hx.session.restore","hx.turn.start","hx.turn.steer","hx.turn.interrupt","hx.interaction.respond","hx.interaction.cancel",...goalWrites,"hx.compact.start","hx.review.start","hx.session.harness.set","hx.workspace.integrate","hx.workspace.discard",...Array.from(["enqueue","update","remove","reorder","clear","pause","resume","run","steer","retry"],action=>`hx.queue.${action}`)]);
const metadataWrites=new Set(["hx.session.open","hx.session.close","hx.session.revert","hx.session.config.set","hx.session.archive","hx.session.restore",...goalWrites,"hx.session.harness.set","hx.workspace.integrate","hx.workspace.discard"]);
const revisionRequired=new Set([...metadataWrites,"hx.session.fork","hx.turn.start","hx.compact.start","hx.review.start"]);
const str=(p:Values,key:string)=>{const v=p[key];if(typeof v!=="string"||!v)throw new HostError("INVALID_PARAMS");return v;};
const optionalStr=(p:Values,key:string)=>typeof p[key]==="string"?p[key] as string:undefined;

export class HarnessHost {
  readonly store:HarnessStore;
  private runtimes:RuntimeRegistration[];
  private catalogRevision=1;
  private catalogRefresh:Promise<void>=Promise.resolve();
  private readonly catalogScopes=new Map<string,{connection:HostConnection;projects:Set<string>}>();
  private readonly catalogAuthChecks=new WeakMap<RuntimeRegistration,{pending:boolean;checkedAt:number}>();
  readonly catalog:HarnessCatalogService;
  private readonly catalogEpoch=randomUUID();
  private readonly snapshotScopes=new Map<string,{connection:HostConnection;projects:Set<string>}>();
  private readonly manualRefreshes=new Map<string,number>();
  private bootstrap?:Promise<void>;
  private backgroundStarted=false;
  private bootstrapRetry?:ReturnType<typeof setTimeout>;
  private readonly initialized=new Set<string>();
  private readonly live=new Map<string,LiveSession>();
  private readonly subscriptions=new Map<string,Subscription>();
  private readonly locks=new Map<string,Promise<void>>();
  private readonly privateInteractions=new Map<string,JsonObject>();
  private readonly secrets=new Map<string,SecretRedactor>();
  private readonly activeCounts=new Map<string,number>();
  private readonly controlBusy=new Set<string>();
  private readonly bindingBusy=new Set<string>();
  private readonly queuePumps=new Map<string,Promise<void>>();
  private readonly queueAgain=new Set<string>();
  private readonly admissions=new Map<string,string>();
  private shuttingDown=false;
  private storageClosed=false;
  private readonly inFlight=new Set<Promise<unknown>>();
  private readonly subagentDiscovery=new Map<string,Promise<void>>();
  private readonly repairedSubagentSessions=new Set<string>();
  private readonly closedResults=new Map<string,OperationResult>();
  private closing?:Promise<void>;
  constructor(private readonly options:HostOptions){this.store=options.store;this.runtimes=[...options.runtimes];this.catalog=new HarnessCatalogService({store:this.store.catalog,digest:value=>this.store.digest(value),...options.catalogPolicy,onDiagnostic:options.onCatalogDiagnostic,onChanged:(id,changes)=>{void this.notifyCatalogSnapshot([id],changes);if(changes.includes("models"))void this.notifyCatalogChanged();}});this.catalog.replace(this.runtimes);this.store.recover();queueMicrotask(()=>{if(!this.shuttingDown)for(const session of this.store.sessions())this.scheduleQueue(session.id);});}

  private async authorizeSessionList(principal:Principal,params:HxRequestMap['hx.session.list']):Promise<void> {
    if(this.shuttingDown)throw new HostError("HOST_CLOSED");
    try { validateHxRequest('hx.session.list',params); } catch { throw new HostError("INVALID_PARAMS"); }
    await this.access(this.trustedConnection(principal),params.projectId,"viewer");
  }

  readonly sessions = {
    list: async ({actor}:{actor:HostActor}, params:SessionListParams):Promise<SessionListResult> => {
      const {scopeId,...page}=params;
      await this.authorizeSessionList({userId:actor.userId,mode:"on"},{...page,projectId:scopeId});
      const {ids,nextCursor}=this.store.sessionIdPage(scopeId,page.archived===true,page.cursor,page.limit??100);
      return {
        sessions:ids.map(id=>sessionSummary(this.store.session(id))),
        nextCursor,
      };
    },
  };

  private readSessionPage(params:HxRequestMap['hx.session.list']):HxResultMap['hx.session.list'] {
    const {projectId,archived,cursor,limit=100}=params;
    const {ids,nextCursor}=this.store.sessionIdPage(projectId,archived===true,cursor,limit);
    return {sessions:ids.map(id=>this.publicSession(id)),nextCursor};
  }
  publicSession(id:string) {
    this.repairLegacySubagents(id);
    const value=this.store.publicSession(id),options=value.capabilities?.config?.options;
    // Older persisted Codex capabilities predate the adapter's permission preset.
    // Upgrade only a dormant, still-configurable binding from its verified catalog;
    // never override a live capability downgrade or reopen a process for a read.
    if(value.adapterId==="codex"&&!this.live.has(id)&&options?.some(option=>option.id==="approvalPolicy")&&!options.some(option=>option.id==="permissionMode")){
      const preset=this.runtimes.find(runtime=>runtime.id===value.runtimeConfigId&&runtime.adapterId==="codex"&&runtime.available!==false)?.capabilities?.config?.options.find(option=>option.id==="permissionMode");
      if(preset)value.capabilities={...value.capabilities,config:{options:[structuredClone(preset),...options]}};
    }
    const subagents=publicSubagents(this.store.session(id),runtimeConfigId=>!!this.runtimes.find(runtime=>runtime.id===runtimeConfigId&&runtime.available!==false)?.readSubagentHistory);
    return {...value,executionMode:value.executionMode??"normal",subagents,bindingGeneration:value.bindingGeneration??1,hostCapabilities:{queue:true,worktree:!!this.options.workspaces,harnessSwitch:true,managed:true,subagents:true}};
  }
  catalogSnapshot():HxResultMap["hx.harness.list"]["harnesses"] {
    return this.runtimes.map(r=>({runtimeConfigId:r.id,adapterId:r.adapterId,providerId:r.providerId??(r.adapterId==="claude"?"claude-code":r.adapterId),name:r.name??r.id,authStatus:r.authStatus??"unknown",available:r.available!==false,...(r.reason?{reason:r.reason}:{}),...(r.version?{version:r.version}:{}),capabilities:structuredClone(r.capabilities??{})}));
  }
  async modelCatalog(runtimeConfigId:string):Promise<HxResultMap["hx.harness.models"]> {
    await this.prepareRuntime(runtimeConfigId);
    const descriptor=this.runtimes.find(runtime=>runtime.id===runtimeConfigId&&runtime.available!==false);if(!descriptor)throw new HostError("HARNESS_UNAVAILABLE");
    return descriptor.models||descriptor.catalogWorker?{models:await this.catalog.legacyModels(runtimeConfigId),source:"live"}:{models:[],source:"unavailable"};
  }
  startBackground():void {
    if(this.backgroundStarted||this.shuttingDown)return;this.backgroundStarted=true;
    this.bootstrapBackground();
  }
  private bootstrapBackground():void {
    if(this.shuttingDown)return;
    this.bootstrap=this.refreshCatalog().catch(cause=>{
      if(this.shuttingDown)return;
      try{this.options.onError?.(hostError(cause).code);}catch{}
      this.bootstrapRetry=setTimeout(()=>this.bootstrapBackground(),30_000);this.bootstrapRetry.unref?.();
    }).finally(()=>{if(!this.shuttingDown)this.catalog.startBackground();});
  }
  private async prepareRuntime(id:string):Promise<void> {
    const candidate=this.runtimes.find(r=>r.id===id);
    if(candidate?.reason!=="HARNESS_PREPARING")return;
    if(!this.bootstrap)throw new HostError("HARNESS_PREPARING","HARNESS_PREPARING",true,false);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([this.bootstrap,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new HostError("HARNESS_PREPARING","HARNESS_PREPARING",true,false)),10_000);})]);}finally{if(timer)clearTimeout(timer);}
    if(this.runtimes.find(r=>r.id===id)?.reason==="HARNESS_PREPARING")throw new HostError("HARNESS_PREPARING","HARNESS_PREPARING",true,false);
  }
  resolveRuntimeConfigId(providerId:string):string {
    const matches=this.runtimes.filter(runtime=>(runtime.available!==false||runtime.reason==="HARNESS_PREPARING")&&(runtime.providerId??(runtime.adapterId==="claude"?"claude-code":runtime.adapterId))===providerId);
    const preferred=({codex:"codex-native","claude-code":"claude-native",anureo:"anureo-acp"} as Record<string,string>)[providerId];
    if(preferred&&matches.some(runtime=>runtime.id===preferred))return preferred;
    if(matches.length===1)return matches[0]!.id;
    throw new HostError(matches.length?"HARNESS_SELECTION_REQUIRED":"HARNESS_UNAVAILABLE");
  }
  capacity(runtimeConfigId:string):{busy:number;limit:number} {
    const registration=this.runtimes.find(runtime=>runtime.id===runtimeConfigId);if(!registration)throw new HostError("HARNESS_UNAVAILABLE");
    const uncertain=this.store.sessions().filter(record=>record.uncertainRuntimeConfigIds?.includes(runtimeConfigId)||(record.runtimeConfigId===runtimeConfigId&&!this.live.has(record.id)&&record.status==="recoveryRequired"&&this.store.evidence(record.id,record.bindingGeneration??1,"session")?.quiescent!==true)).length;
    return{busy:(this.activeCounts.get(runtimeConfigId)??0)+uncertain+[...this.admissions.values()].filter(id=>id===runtimeConfigId).length,limit:this.concurrencyLimit(registration)};
  }
  private concurrencyLimit(registration:RuntimeRegistration):number {return this.options.enforceConcurrencyLimits===false?0:registration.maxConcurrency??4;}
  queueSnapshot(id:string):HxQueueState {return publicQueue(this.store.queue(id));}
  transcript(id:string,seen=new Set<string>()):HostEvent[] {
    const session=this.store.session(id);if(seen.has(id)||seen.size>=64)throw new HostError("TRANSCRIPT_ANCESTRY_INVALID");seen.add(id);
    let inherited:HostEvent[]=[];
    if(session.parent){const parent=this.store.session(session.parent.sessionId);if(parent.projectId!==session.projectId)throw new HostError("PROJECT_FORBIDDEN");const records=this.transcript(parent.id,seen),boundary=session.parent.boundary;
      const indexes=records.map((event,index)=>({event,index})).filter(({event})=>(event.turnId??("turnId"in event.event.payload?event.event.payload.turnId:undefined))===boundary.turnId);
      if(!indexes.length)throw new HostError("TURN_NOT_FOUND");const first=indexes[0]!.index;const terminal=indexes.find(({event})=>event.event.type==="turn/completed")?.index??indexes.at(-1)!.index;
      inherited=records.slice(0,boundary.relation==="before"?first:terminal+1);
    }
    const current:HostEvent[]=[];let cursor=0;const through=this.store.session(id).latestSeq;while(cursor<through){const page=this.store.events(id,cursor,through,1000);current.push(...page.events);if(page.nextAfterSeq<=cursor)throw new HostError("CURSOR_INVALID");cursor=page.nextAfterSeq;}
    return [...inherited,...current];
  }
  /** Trusted product port. This is intentionally absent from the browser protocol. */
  reserveAdmission(input:{admissionRef:string;runtimeConfigId:string}):void {
    if(this.shuttingDown)throw new HostError("HOST_CLOSED");
    const old=this.admissions.get(input.admissionRef);if(old){if(old!==input.runtimeConfigId)throw new HostError("ADMISSION_CONFLICT");return;}
    const runtime=this.runtimes.find(value=>value.id===input.runtimeConfigId&&value.available!==false);if(!runtime)throw new HostError("HARNESS_UNAVAILABLE");
    const capacity=this.capacity(runtime.id);
    if(capacity.limit>0&&capacity.busy>=capacity.limit)throw new HostError("HARNESS_CAPACITY_EXCEEDED");
    this.admissions.set(input.admissionRef,runtime.id);
  }
  releaseAdmission(ref:string):void {this.admissions.delete(ref);}
  private trustedConnection(principal:Principal):HostConnection {return {id:`trusted:${principal.userId}`,principal:()=>principal,send:()=>{}};}
  async createManagedSession(input:{principal:Principal;projectId:string;agentId?:string;scopeId:string;executionKey:string;runtimeConfigId:string;instructions:string;config?:JsonObject;model?:string;mcpServers?:McpServer[];admissionRef?:string;workspace?:WorkspaceRequest;directory?:{cwd:string;allowedRoots:string[]}}):Promise<OperationResult> {
    if(!input.scopeId||!input.executionKey)throw new HostError("INVALID_PARAMS");
    const {principal,...context}=input;
    return this.write(this.trustedConnection(principal),"hx.session.create",{projectId:context.projectId,runtimeConfigId:context.runtimeConfigId,idempotencyKey:`managed:${context.scopeId}:${context.executionKey}`,config:context.config??{},...(context.agentId?{agentId:context.agentId}:{}),...(context.model?{model:context.model}:{}),...(context.workspace?{workspace:context.workspace}:{}),_trusted:true,_managed:{scopeId:context.scopeId,executionKey:context.executionKey},_fixedContext:{instructions:context.instructions,mcpServers:context.mcpServers??[]},...(context.admissionRef?{_admissionRef:context.admissionRef}:{}),...(context.directory?{_directory:context.directory}:{})});
  }
  async startManagedTurn(input:{principal:Principal;sessionId:string;executionKey:string;input:InputBlock[];outputSchema?:JsonSchema}):Promise<OperationResult> {
    const record=this.store.session(input.sessionId);if(!record.managed||record.managed.executionKey!==input.executionKey)throw new HostError("MANAGED_CONTEXT_MISMATCH");
    return this.write(this.trustedConnection(input.principal),"hx.turn.start",{sessionId:record.id,expectedRevision:record.revision,idempotencyKey:`managed-turn:${input.executionKey}`,input:input.input,...(input.outputSchema!==undefined?{outputSchema:input.outputSchema}:{}),_trusted:true});
  }
  async managedSessionOperation(input:{principal:Principal;projectId:string;scopeId:string;executionKey:string}):Promise<OperationResult|undefined> {
    await this.access(this.trustedConnection(input.principal),input.projectId,"viewer");
    return this.store.lookup(input.principal.userId,"hx.session.create",input.projectId,`managed:${input.scopeId}:${input.executionKey}`)?.value;
  }
  async managedOperation(input:{principal:Principal;sessionId:string;executionKey:string}):Promise<OperationResult|undefined> {
    const record=await this.authorizedSession(this.trustedConnection(input.principal),{sessionId:input.sessionId},"viewer");
    if(record.managed?.executionKey!==input.executionKey)throw new HostError("MANAGED_CONTEXT_MISMATCH");
    return this.store.lookup(record.ownerId,"hx.turn.start",record.id,`managed-turn:${input.executionKey}`)?.value;
  }
  async stopManagedExecution(input:{principal:Principal;sessionId:string;turnId?:string}):Promise<{quiescent:boolean;evidenceRef?:string}> {
    const record=await this.authorizedSession(this.trustedConnection(input.principal),{sessionId:input.sessionId},"maintainer");if(!record.managed)throw new HostError("MANAGED_CONTEXT_MISMATCH");
    const turnId=input.turnId??record.activeTurnId;
    if(turnId&&this.live.has(record.id)){try{await this.write(this.trustedConnection(input.principal),"hx.turn.interrupt",{sessionId:record.id,turnId,idempotencyKey:`managed-stop:${record.managed.executionKey}:${turnId}`,_trusted:true});}catch{/* Only independent evidence below can report quiescence. */}}
    const evidence=await this.executionEvidence(record.id,turnId,true);return{quiescent:evidence.quiescent,...(evidence.evidenceRef?{evidenceRef:evidence.evidenceRef}:{})};
  }
  private async turnHook(kind:"before"|"settled",id:string,turnId:string,status?:"completed"|"interrupted"|"failed"):Promise<void> {
    const record=this.store.session(id),generation=record.bindingGeneration??1,key=`hook:${kind}:${turnId}`;
    if(this.store.evidence(id,generation,key))return;
    this.store.recordEvidence(id,generation,key,{attempted:true});
    try{const context={sessionId:id,turnId,projectId:record.projectId,cwd:record.cwd};if(kind==="before")await this.options.onBeforeTurn?.(context);else await this.options.onTurnSettled?.({...context,status:status!});}catch(cause){try{this.options.onError?.(hostError(cause).code);}catch{}}
  }
  private async policyAccess(principal:Principal,projectId?:string):Promise<void> {
    if(projectId)await this.access(this.trustedConnection(principal),projectId,"maintainer");
    else if(principal.mode!=="off"&&!principal.isAdmin&&!principal.service)throw new HostError("PROJECT_FORBIDDEN");
  }
  async fullAccessSessions(principal:Principal,projectId?:string):Promise<FullAccessSession[]> {
    await this.policyAccess(principal,projectId);const policy=this.options.permissionPolicy;if(!policy)throw new HostError("PERMISSION_POLICY_UNAVAILABLE");
    return this.store.sessions(projectId).filter(record=>!!record.permissionDowngrade||policy.isFullAccess({adapterId:record.adapterId,config:record.config})).map(record=>({sessionId:record.id,projectId:record.projectId,agentId:record.agentId??"",title:record.title??record.id,running:!!record.activeTurnId||record.status==="running",connected:this.live.has(record.id)}));
  }
  async requestPermissionDowngrades(principal:Principal,projectId?:string):Promise<PermissionDowngradeResult> {
    const targets=await this.fullAccessSessions(principal,projectId),policy=this.options.permissionPolicy!,result:PermissionDowngradeResult={downgraded:[],deferred:[],failed:[]};
    for(const target of targets)try{
      await this.serial(target.sessionId,async()=>{
        const record=this.store.session(target.sessionId),safe=policy.downgrade({adapterId:record.adapterId,config:structuredClone(record.config)});
        if(policy.isFullAccess({adapterId:record.adapterId,...safe}))throw new HostError("PERMISSION_DOWNGRADE_UNVERIFIED");
        record.permissionDowngrade={config:safe.config,...(safe.permissionMode?{permissionMode:safe.permissionMode}:{}),key:record.permissionDowngrade?.state==="pending"?record.permissionDowngrade.key:randomUUID(),principalId:principal.userId,state:"pending"};this.store.saveSession(record);
        if(this.store.queue(record.id).items.some(item=>["queued","failed"].includes(item.state)))this.store.mutateQueue(record.id,undefined,state=>{for(const item of state.items)if(["queued","failed"].includes(item.state)){
          const safeItem=policy.downgrade({adapterId:record.adapterId,config:item.configSnapshot,overrides:item.overrides});if(policy.isFullAccess({adapterId:record.adapterId,...safeItem}))throw new HostError("PERMISSION_DOWNGRADE_UNVERIFIED");item.configSnapshot=safeItem.config;item.overrides=safeItem.overrides;
        }});this.publishQueue(record.id);
      });
      if(await this.applyPermissionDowngrade(target.sessionId))result.downgraded.push(target.sessionId);
      else {const pending=this.store.session(target.sessionId).permissionDowngrade;if(pending?.state==="failed")result.failed.push({sessionId:target.sessionId,message:pending.error??"PERMISSION_DOWNGRADE_FAILED"});else result.deferred.push(target.sessionId);}
    }catch(cause){const record=this.store.session(target.sessionId);if(record.permissionDowngrade){record.permissionDowngrade.state="failed";record.permissionDowngrade.error=hostError(cause).code;this.store.saveSession(record);}result.failed.push({sessionId:target.sessionId,message:hostError(cause).code});}
    return result;
  }
  private async applyPermissionDowngrade(id:string):Promise<boolean> {
    const reserved=await this.serial(id,async()=>{const record=this.store.session(id),pending=record.permissionDowngrade;if(!pending)return undefined;
      if(pending.state==="failed"||this.controlBusy.has(id)||this.bindingBusy.has(id)||record.activeTurnId||["running","opening","recoveryRequired"].includes(record.status)||record.goal?.status==="active"||this.store.interactions(id).some(item=>item.state!=="resolved"))return undefined;
      const previous=this.store.lookup(pending.principalId,"host.permissions.downgrade",id,pending.key);
      if(previous){if(previous.value.state==="completed"){delete record.permissionDowngrade;this.store.saveSession(record);}else{pending.state="failed";pending.error=previous.value.outcomeUnknown?"RESULT_UNKNOWN":previous.value.error?.code??"PERMISSION_DOWNGRADE_FAILED";record.permissionDowngrade=pending;if(previous.value.outcomeUnknown)record.status="recoveryRequired";this.store.saveSession(record);}return undefined;}
      const initial=this.store.beginOperation(randomUUID(),pending.principalId,"host.permissions.downgrade",id,pending.key,this.store.digest({config:pending.config,permissionMode:pending.permissionMode??null}),id);
      this.controlBusy.add(id);return{record,pending,initial};
    });
    if(!reserved)return !this.store.session(id).permissionDowngrade;
    try{
      this.store.phase(reserved.initial.operationId,"dispatching");
      const {pending}=reserved,live=this.live.get(id);
      if(live){
        if(!live.session.capabilities.session?.resume)throw new HostError("CAPABILITY_UNSUPPORTED");
        const proof=await this.executionEvidence(id,undefined,true);if(!proof.quiescent)throw new HostError("RESULT_UNKNOWN","Native execution stop is unverified",false,true);
        await this.closeLive(id);
      }
      const next=this.store.session(id);next.config=structuredClone(pending.config);next.permissionMode=pending.permissionMode;this.store.saveSession(next);
      if(live)await this.open(next,"resume");
      const confirmed=this.store.session(id);if(this.options.permissionPolicy!.isFullAccess({adapterId:confirmed.adapterId,config:confirmed.config}))throw new HostError("PERMISSION_DOWNGRADE_UNVERIFIED");
      confirmed.revision++;this.store.finishOperation({...reserved.initial,state:"completed",outcomeUnknown:false,revision:confirmed.revision,result:{downgraded:true}});delete confirmed.permissionDowngrade;this.store.saveSession(confirmed);
      const event=this.store.append(id,{type:"host/permissions",payload:{state:"downgraded",revision:confirmed.revision}});if(event)this.publish(event);return true;
    }catch(cause){const error=hostError(cause);this.store.finishOperation({...reserved.initial,state:error.outcomeUnknown?"unknown":"failed",outcomeUnknown:error.outcomeUnknown,error});const record=this.store.session(id);if(record.permissionDowngrade){record.permissionDowngrade.state="failed";record.permissionDowngrade.error=error.code;if(error.outcomeUnknown)record.status="recoveryRequired";this.store.saveSession(record);}return false;}
    finally{this.controlBusy.delete(id);}
  }
  private redactor(id:string):SecretRedactor {let value=this.secrets.get(id);if(!value){value=new PersistentSecretRedactor(this.store,id);this.secrets.set(id,value);}return value;}
  private projectResult(method:HxMethod,id:string,result:JsonValue):JsonValue {
    const privacy=this.redactor(id);
    if(method==="hx.session.config.set")return privacy.state(result as unknown as Parameters<SecretRedactor["state"]>[0]) as unknown as JsonValue;
    if(method.startsWith("hx.goal."))return privacy.goal(result as unknown as Parameters<SecretRedactor["goal"]>[0]) as unknown as JsonValue;
    if(result&&typeof result==="object"&&!Array.isArray(result)&&result.config&&typeof result.config==="object")return {...result,config:privacy.json(result.config)};
    return result;
  }
  private principal(connection:HostConnection):Principal {const p=connection.principal();if(!p)throw new HostError("AUTH_REQUIRED");return p;}
  private async access(connection:HostConnection,projectId:string,minimum:Role):Promise<Principal> {
    const p=this.principal(connection);
    const delegated=this.options.applicationAuthorization||p.mode!=="off"&&!p.isAdmin&&!p.service;
    if(delegated&&!await this.options.can(p,projectId,minimum))throw new HostError("PROJECT_FORBIDDEN");
    return p;
  }
  private async authorizedSession(connection:HostConnection,p:Values,minimum:Role):Promise<SessionRecord> {
    const record=this.store.session(str(p,"sessionId"));
    if(p.projectId!==undefined&&p.projectId!==record.projectId)throw new HostError("PROJECT_FORBIDDEN");
    await this.access(connection,record.projectId,minimum);return record;
  }
  private runtime(record:SessionRecord):RuntimeRegistration {
    const descriptor=this.live.get(record.id)?.registration??this.runtimes.find(r=>r.id===record.runtimeConfigId&&r.adapterId===record.adapterId);
    if(!descriptor||descriptor.available===false)throw new HostError("HARNESS_UNAVAILABLE");return descriptor;
  }
  private async serial<T>(key:string,run:()=>Promise<T>):Promise<T> {
    const previous=this.locks.get(key)??Promise.resolve();
    let release!:()=>void;const next=new Promise<void>(resolve=>release=resolve);this.locks.set(key,next);
    await previous.catch(()=>{});
    try{return await run();}finally{release();if(this.locks.get(key)===next)this.locks.delete(key);}
  }
  async request<M extends HxMethod>(connection:HostConnection,method:M,params:HxRequestMap[M]):Promise<HxResultMap[M]>;
  async request(connection:HostConnection,method:string,params:unknown):Promise<unknown> {
    if(this.shuttingDown)throw new HostError("HOST_CLOSED");
    const pending=this.dispatch(connection,method,params);this.inFlight.add(pending);
    try{return await pending;}finally{this.inFlight.delete(pending);}
  }
  /** 服务端投影快照（方案C）：同会话并发请求合并为一次推进。 */
  private projectionJobs=new Map<string,Promise<HxResultMap["hx.projection.snapshot"]>>();
  private projectionSnapshotRequest(record:SessionRecord):Promise<HxResultMap["hx.projection.snapshot"]> {
    const existing=this.projectionJobs.get(record.id);
    if(existing)return existing;
    const job=this.advanceProjection(record).finally(()=>this.projectionJobs.delete(record.id));
    this.projectionJobs.set(record.id,job);
    return job;
  }
  /** 按需推进：持久快照 + gap 分页 apply；读路径实现，不挂 append 钩子（无 stale 风险，天然自愈）。 */
  private async advanceProjection(record:SessionRecord):Promise<HxResultMap["hx.projection.snapshot"]> {
    const latestSeq=this.store.session(record.id).latestSeq;
    // fork 会话的 inherited transcript 不在 durable 流内，P1 不物化，由浏览器 seed 路径回退。
    const projector=this.options.projection;
    if(!projector||record.parent||latestSeq===0)return {checkpoint:null,seq:0,latestSeq};
    const projection=projector.create();
    let from=0;
    const stored=this.store.projectionSnapshot(record.id);
    if(stored&&stored.projectionVersion===projector.version) {
      try{if(projection.restore(JSON.parse(stored.checkpointJson)))from=projection.lastSeq;}catch{/* Replay damaged checkpoints from the log. */}
    }
    if(from<latestSeq) {
      try{from=this.applyEventRange(projection,record.id,from,latestSeq);}
      catch(error) {
        if(from===0)throw error;
        // 旧快照与事件流不衔接：丢弃快照，从零重放自愈
        projection.reset();
        from=this.applyEventRange(projection,record.id,0,latestSeq);
      }
    }
    if(projection.lastSeq!==latestSeq)throw new HostError("EVENT_STREAM_RECOVERY_FAILED");
    const checkpoint=projection.serialize();
    try{this.store.saveProjectionSnapshot(record.id,projector.version,projection.lastSeq,JSON.stringify(checkpoint));}catch{/* A cache write cannot block a read. */}
    return {checkpoint,seq:projection.lastSeq,latestSeq};
  }
  private applyEventRange(projection:HostProjection,sessionId:string,from:number,to:number):number {
    let cursor=from;
    while(cursor<to) {
      const page=this.store.events(sessionId,cursor,to,1000);
      if(!page.events.length)throw new HostError("EVENT_STREAM_RECOVERY_FAILED");
      for(const event of page.events)projection.apply(event);
      if(projection.lastSeq===cursor)throw new HostError("EVENT_STREAM_RECOVERY_FAILED");
      cursor=projection.lastSeq;
    }
    return cursor;
  }
  private async dispatch(connection:HostConnection,method:string,params:unknown):Promise<unknown> {
    if(!isHxMethod(method))throw new HostError("METHOD_NOT_FOUND");
    try{validateHxRequest(method,params);}catch{throw new HostError("INVALID_PARAMS");}
    this.principal(connection);
    const p=params as Values;
    if(method==="hx.initialize") {
      if(!(p.protocolVersions as number[]).includes(1))throw new HostError("PROTOCOL_VERSION_UNSUPPORTED");
      this.initialized.add(connection.id);
      return {protocolVersion:1,features:["durable-events","operations","private-interactions","catalog-snapshots-v1","goal-events-v1"],limits:{maxEventPage:1000}};
    }
    if(!this.initialized.has(connection.id))throw new HostError("NOT_INITIALIZED");
    const result=writes.has(method)?await this.write(connection,method,p):await this.read(connection,method,p);
    if(this.storageClosed&&!writes.has(method))throw new HostError("HOST_CLOSED");
    validateHxResult(method,result);return result;
  }
  private async read(connection:HostConnection,method:HxMethod,p:Values):Promise<unknown> {
    if(method==="hx.events.unsubscribe") {
      const id=str(p,"subscriptionId"),sub=this.subscriptions.get(id);
      if(sub&&sub.connection.id!==connection.id)throw new HostError("PROJECT_FORBIDDEN");
      if(sub){sub.active=false;this.subscriptions.delete(id);}return {removed:!!sub};
    }
    if(method==="hx.operation.get") {
      const principal=this.principal(connection);
      const found=typeof p.operationId==="string"?this.store.operation(p.operationId):this.store.lookup(principal.userId,str(p,"method"),str(p,"target"),str(p,"idempotencyKey"));
      if(!found)throw new HostError("OPERATION_NOT_FOUND");
      if(found.row.principal_id!==principal.userId&&!principal.isAdmin&&!principal.service)throw new HostError("PROJECT_FORBIDDEN");
      const projectId=found.row.method==="hx.session.create"?found.row.target:found.row.session_id?this.store.session(found.row.session_id).projectId:found.row.target;
      await this.access(connection,projectId,"viewer");return found.value;
    }
    if(method==="hx.catalog.get"||method==="hx.catalog.refresh"){
      const projectId=str(p,"projectId"),principal=await this.access(connection,projectId,method==="hx.catalog.refresh"?"maintainer":"viewer");
      let scope=this.snapshotScopes.get(connection.id);if(!scope){scope={connection,projects:new Set()};this.snapshotScopes.set(connection.id,scope);}scope.connection=connection;scope.projects.add(projectId);
      if(method==="hx.catalog.refresh"){
        const runtimeConfigId=str(p,"runtimeConfigId"),key=JSON.stringify([principal.userId,runtimeConfigId]),last=this.manualRefreshes.get(key);
        const existing=this.catalog.coalescedRefresh(runtimeConfigId);if(existing)return existing;
        if(last!==undefined&&Date.now()-last<5_000)throw new HostError("CATALOG_REFRESH_RATE_LIMITED","CATALOG_REFRESH_RATE_LIMITED",true);
        for(const [id,at] of this.manualRefreshes)if(Date.now()-at>=5_000)this.manualRefreshes.delete(id);
        this.manualRefreshes.set(key,Date.now());return this.catalog.schedule(runtimeConfigId,"manual");
      }
      this.refreshCatalogAuth();
      const requested=optionalStr(p,"runtimeConfigId"),rows=this.catalogSnapshot().filter(r=>!requested||r.runtimeConfigId===requested);
      if(requested&&!rows.length)throw new HostError("HARNESS_UNAVAILABLE");
      return {epoch:this.catalogEpoch,revision:this.catalogRevision,runtimes:rows.map(row=>({...row,readiness:row.reason==="HARNESS_PREPARING"?"preparing":row.available?"ready":"unavailable",...this.catalog.view(row.runtimeConfigId,!!requested)}))};
    }
    if(method.startsWith("hx.harness.")||method==="hx.session.list"||method==="hx.usage.get") {
      const projectId=str(p,"projectId");await this.access(connection,projectId,"viewer");
      if(method==="hx.usage.get"){
        const rows=this.store.sessions(projectId).filter(row=>(p.includeArchived===true||!row.archived)&&(!p.agentId||row.agentId===p.agentId)).map(row=>({sessionId:row.id,...(row.agentId?{agentId:row.agentId}:{}),usage:this.store.usage(row.id)}));
        const sum=(key:"input"|"output"|"total")=>rows.length&&rows.every(row=>typeof row.usage?.[key]==="number")?rows.reduce((n,row)=>n+row.usage![key]!,0):null;
        return {sessions:rows,totals:{input:sum("input"),output:sum("output"),total:sum("total")}};
      }
      if(method==="hx.session.list")return this.readSessionPage(p as HxRequestMap['hx.session.list']);
      if(method==="hx.harness.list"){
        let scope=this.catalogScopes.get(connection.id);if(!scope){scope={connection,projects:new Set()};this.catalogScopes.set(connection.id,scope);}scope.connection=connection;scope.projects.add(projectId);
        this.refreshCatalogAuth();
        return {harnesses:this.catalogSnapshot()};
      }
      await this.prepareRuntime(str(p,"runtimeConfigId"));
      const descriptor=this.runtimes.find(r=>r.id===p.runtimeConfigId);
      if(!descriptor||descriptor.available===false)throw new HostError("HARNESS_UNAVAILABLE");
      return this.modelCatalog(descriptor.id);
    }
    const minimum=method==="hx.interaction.private.get"||method==="hx.session.reconcile"?"maintainer":"viewer";
    const record=await this.authorizedSession(connection,p,minimum);
    switch(method) {
      case "hx.session.get":return this.publicSession(record.id);
      case "hx.subagents.list":{
        await this.discoverSubagents(record);
        await this.authorizedSession(connection,p,'viewer');
        return {subagents:this.publicSession(record.id).subagents};
      }
      case "hx.subagents.history":{
        const inline=record.inlineSubagents?.find(child=>child.summary.sessionId===p.childSessionId&&child.summary.parentSessionId===record.id);
        if(inline){
          const projection=this.options.projection?.create();
          if(!projection)throw new HostError("CAPABILITY_UNSUPPORTED");
          const snapshot=await this.projectionSnapshotRequest(record);
          if(snapshot.checkpoint)projection.restore(snapshot.checkpoint);
          else this.applyEventRange(projection,record.id,0,this.store.session(record.id).latestSeq);
          const history=inlineSubagentHistory(projection.snapshot(),inline,optionalStr(p,'cursor'),typeof p.limit==='number'?p.limit:50);
          await this.authorizedSession(connection,p,'viewer');
          return {subagent:{...inline.summary,canOpen:true},history:this.redactor(record.id).history(history)};
        }
        const child=record.nativeSubagents?.find(child=>child.summary.sessionId===p.childSessionId&&child.summary.parentSessionId===record.id);
        if(!child)throw new HostError('SUBAGENT_UNAVAILABLE');
        const runtime=this.runtimes.find(runtime=>runtime.id===child.runtimeConfigId&&runtime.available!==false);
        if(!runtime?.readSubagentHistory)throw new HostError('CAPABILITY_UNSUPPORTED');
        const history=await runtime.readSubagentHistory({parentNativeRef:child.parentNativeRef,nativeRef:child.nativeRef,cwd:record.cwd,...(typeof p.cursor==='string'?{cursor:p.cursor}:{}),...(typeof p.limit==='number'?{limit:p.limit}:{})}).catch(cause=>{throw historyReadError(cause);});
        // Access may have been revoked while the native reader was in flight.
        await this.authorizedSession(connection,p,'viewer');
        assertResult('history/read',history);
        const safe=this.redactor(record.id).history(history);
        const prepared={...safe,source:undefined,items:await Promise.all(safe.items.map(async entry=>({...entry,item:await this.prepareItem(record.id,entry.item,undefined,false)})))};
        return {subagent:{...child.summary,canOpen:true},history:prepared};
      }
      case "hx.queue.get":return this.queueSnapshot(record.id);
      case "hx.transcript.read":{const own=this.store.session(record.id).latestSeq,all=this.transcript(record.id);return {inherited:all.filter(event=>event.sessionId!==record.id||event.hostSeq>own)};}
      case "hx.workspace.get":return record.workspace??{kind:"project"};
      case "hx.events.read":return this.store.events(record.id,p.afterSeq as number|undefined,p.throughSeq as number|undefined,p.limit as number|undefined);
      case "hx.projection.snapshot":return this.projectionSnapshotRequest(record);
      case "hx.events.subscribe": {
        const after=p.afterSeq as number,cutoverSeq=this.store.session(record.id).latestSeq;
        if(after>cutoverSeq)throw new HostError("CURSOR_INVALID");
        const id=randomUUID();this.subscriptions.set(id,{id,sessionId:record.id,connection,lastSeq:cutoverSeq,pending:0,bytes:0,tail:Promise.resolve(),active:true});
        return {subscriptionId:id,cutoverSeq,earliestSeq:1};
      }
      case "hx.interaction.list":return {interactions:this.store.interactions(record.id).filter(i=>p.state===undefined||i.state===p.state)};
      case "hx.interaction.private.get": {
        const item=this.store.interaction(record.id,str(p,"interactionId"));
        const liveInteraction=this.live.get(record.id);
        const privateData=this.privateInteractions.get(`${record.id}:${item.interactionId}`)??clientInteractionCapture(liveInteraction!.client)?.requests.get(item.interactionId)?.privatePayload;
        if(item.state!=="pending"||!privateData)throw new HostError("INTERACTION_EXPIRED");return privateData;
      }
      case "hx.history.read": {
        const live=this.requireLive(record.id);
        const history=await live.session.request("history/read",{requestId:randomUUID(),sessionId:record.id,...(typeof p.cursor==="string"?{cursor:p.cursor}:{}),...(typeof p.limit==="number"?{limit:p.limit}:{}),...(typeof p.snapshotToken==="string"?{snapshotToken:p.snapshotToken}:{})}).catch((cause:unknown)=>{throw historyReadError(cause);});
        if(this.storageClosed)throw new HostError("HOST_CLOSED");assertResult("history/read",history);
        const prepared={...history,items:await Promise.all(history.items.map(async entry=>{
          const canonical=live.nativeTurnToCanonical.get(entry.turnId);
          const turnId=canonical??entry.turnId;
          // Claude history reports the prompt UUID. The live turn map links its execution ID to the Host turn.
          const nativeTurnId=record.adapterId==='claude'&&canonical?entry.turnId:entry.nativeTurnId;
          return {...entry,turnId,...(nativeTurnId?{nativeTurnId}:{}),item:await this.prepareItem(record.id,entry.item,turnId,'history')};
        }))};
        this.store.indexHistory(record.id,prepared);return this.redactor(record.id).history(prepared);
      }
      case "hx.session.reconcile":return this.reconcile(record);
      default:throw new HostError("METHOD_NOT_FOUND");
    }
  }
  private async write(connection:HostConnection,method:HxMethod,p:Values):Promise<OperationResult> {
    const create=method==="hx.session.create";
    const record=create?undefined:await this.authorizedSession(connection,p,["hx.session.archive","hx.session.restore"].includes(method)?"member":"maintainer");
    if(record?.managed&&!p._trusted&&!["hx.interaction.respond","hx.interaction.cancel"].includes(method))throw new HostError("MANAGED_SESSION_IMMUTABLE");
    const projectId=record?.projectId??str(p,"projectId");
    const principal=await this.access(connection,projectId,create?"maintainer":["hx.session.archive","hx.session.restore"].includes(method)?"member":"maintainer");
    const target=record?.id??projectId,key=str(p,"idempotencyKey"),digest=this.store.digest(p);
    const reservation=await this.serial(target,async()=>{
      if(this.shuttingDown)throw new HostError("HOST_CLOSED");
      const old=this.store.lookup(principal.userId,method,target,key);
      if(old){if(old.row.request_digest!==digest)throw new HostError("IDEMPOTENCY_CONFLICT");return {existing:old.value};}
      const current=record?this.store.session(record.id):undefined;
      if(current&&revisionRequired.has(method)&&p.expectedRevision!==current.revision)throw new HostError("REVISION_CONFLICT");
      if(current&&method.startsWith("hx.queue.")&&p.expectedQueueRevision!==this.store.queue(current.id).revision)throw new HostError("QUEUE_REVISION_CONFLICT");
      if(current&&method.startsWith("hx.queue.")&&this.bindingBusy.has(current.id))throw new HostError("SESSION_BUSY");
      if(current&&["hx.session.harness.set","hx.workspace.integrate","hx.workspace.discard"].includes(method))this.assertProductIdle(current);
      if(current?.permissionDowngrade&&!p._trusted&&!["hx.turn.interrupt","hx.interaction.respond","hx.interaction.cancel","hx.session.close","hx.queue.clear","hx.queue.remove","hx.queue.pause"].includes(method)&&!(current.permissionDowngrade.state==="failed"&&method==="hx.session.harness.set"))throw new HostError("PERMISSION_DOWNGRADE_PENDING");
      if(current?.archived&&method!=="hx.session.restore")throw new HostError("SESSION_ARCHIVED");
      const queueControl=!!current&&["hx.queue.run","hx.queue.steer"].includes(method);
      if(queueControl&&this.controlBusy.has(target))throw new HostError("SESSION_BUSY");
      const livePermissionChange=method==="hx.session.config.set"&&!!p.patch&&typeof p.patch==="object"&&!Array.isArray(p.patch)&&Object.keys(p.patch as Values).length===1&&typeof (p.patch as Values).permissionMode==="string";
      const exclusive=!!current&&(metadataWrites.has(method)||["hx.session.fork","hx.turn.start","hx.compact.start","hx.review.start"].includes(method));
      const mayControlLiveGoal=method==="hx.goal.pause"||method==="hx.goal.clear";
      if(exclusive&&(this.controlBusy.has(target)||!livePermissionChange&&!mayControlLiveGoal&&(current!.activeTurnId||current!.status==="running"||this.store.interactions(current!.id).some(i=>i.state!=="resolved"))))throw new HostError("SESSION_BUSY");
      if(method==="hx.interaction.respond"||method==="hx.interaction.cancel") {
        const item=this.store.interaction(current!.id,str(p,"interactionId"));
        if(item.state!=="pending")throw new HostError(item.resolution?.reason==="HOST_RESTARTED"?"INTERACTION_EXPIRED":"INTERACTION_ALREADY_RESOLVED");
        if(p.expectedInteractionRevision!==item.revision)throw new HostError("REVISION_CONFLICT");
        if(method==="hx.interaction.respond"){try{assertInteractionResponse(item.request,p.response);}catch{throw new HostError("INVALID_PARAMS");}this.redactor(current!.id).rememberResponse(item.request,p.response as InteractionResponse);}
      }
      if(current&&method==="hx.turn.start"&&!p._trustedQueue&&this.store.queue(current.id).items.length)throw new HostError("SESSION_BUSY");
      if(current?.status==="recoveryRequired"&&method!=="hx.turn.interrupt")throw new HostError("RECOVERY_REQUIRED");
      const sessionId=method==="hx.session.fork"?randomUUID():current?.id??randomUUID();const turnId=["hx.turn.start","hx.review.start","hx.queue.enqueue","hx.queue.retry"].includes(method)?optionalStr(p,"_turnId")??randomUUID():method==="hx.turn.steer"?str(p,"expectedTurnId"):optionalStr(p,"turnId");
      const initial=this.store.beginOperation(randomUUID(),principal.userId,method,target,key,digest,sessionId,turnId);
      if(exclusive||queueControl)this.controlBusy.add(target);
      if(["hx.session.harness.set","hx.workspace.integrate","hx.workspace.discard"].includes(method))this.bindingBusy.add(target);
      if(current&&["hx.turn.start","hx.review.start"].includes(method)){this.store.clearEvidence(current.id,current.bindingGeneration??1,"session");current.activeTurnId=turnId;current.status="running";this.store.saveSession(current);}
      if(current&&["hx.interaction.respond","hx.interaction.cancel"].includes(method)){const item=this.store.interaction(current.id,str(p,"interactionId"));this.store.saveInteraction(current.id,{...item,state:"responding"});}
      return {initial,current,sessionId,turnId,exclusive,queueControl};
    });
    if("existing"in reservation)return reservation.existing!;
    const {initial,current,sessionId,turnId,exclusive,queueControl}=reservation;
    // Native calls may require an interaction before returning their start acknowledgement.
    // Never hold the command reservation lock while waiting for a backend response.
    try {
        this.store.phase(initial.operationId,"dispatching");
        const result=await this.perform(method,p,current,sessionId,projectId,principal,turnId,initial.operationId);
        if(this.storageClosed)return this.closedResults.get(initial.operationId)??this.unknownResult(initial);
        if(method==="hx.compact.start"&&result&&typeof result==="object"&&!Array.isArray(result)&&result.status==="accepted"){
          const latest=this.store.session(sessionId);latest.status="running";this.store.saveSession(latest);
        }
        if(current&&metadataWrites.has(method)) {
          const latest=this.store.session(current.id);latest.revision++;this.store.saveSession(latest);
        }
        const resultSessionId=method==="hx.session.fork" && typeof result==="object" && result!==null && !Array.isArray(result) && typeof result.id==="string"?result.id:sessionId;
        const revision=this.store.session(resultSessionId).revision;
        const completed=this.store.finishOperation({...initial,sessionId:resultSessionId,state:"completed",outcomeUnknown:false,revision,result:publicValue(this.projectResult(method,resultSessionId,result))});
        if (["hx.session.config.set","hx.session.harness.set"].includes(method)) {
          try { await this.options.onConfigurationCommitted?.({principal,session:this.publicSession(resultSessionId),changed:method==="hx.session.config.set"?Object.keys((p.patch as Values)??{}):[]}); }
          catch { try { this.options.onError?.("PREFERENCE_SYNC_FAILED"); } catch {} }
        }
        this.publishTurnOperation(method,completed);return completed;
      }catch(cause){
        if(this.storageClosed)return this.closedResults.get(initial.operationId)??this.unknownResult(initial);
        const error=hostError(cause);
        if(error.details)error.details=this.redactor(sessionId).json(error.details) as JsonObject;
        if(this.hasSession(sessionId)){
          const s=this.store.session(sessionId);
          if(error.outcomeUnknown)s.status="recoveryRequired";
          else if(turnId&&s.activeTurnId===turnId&&["hx.turn.start","hx.review.start"].includes(method)){delete s.activeTurnId;s.status="ready";}
          this.store.saveSession(s);
          if(!error.outcomeUnknown&&["hx.interaction.respond","hx.interaction.cancel"].includes(method)){const item=this.store.interaction(sessionId,str(p,"interactionId"));if(item.state==="responding")this.store.saveInteraction(sessionId,{...item,state:"pending"});}
        }
        const failed=this.store.finishOperation({...initial,state:error.outcomeUnknown?"unknown":"failed",outcomeUnknown:error.outcomeUnknown,error});
        this.publishTurnOperation(method,failed);return failed;
      }finally{if(exclusive||queueControl)this.controlBusy.delete(target);this.bindingBusy.delete(target);this.scheduleQueue(sessionId);}
  }
  private publishTurnOperation(method:HxMethod,result:OperationResult):void {
    if(!["hx.turn.start","hx.turn.steer","hx.session.revert"].includes(method)||!result.sessionId||!this.hasSession(result.sessionId))return;
    const event=this.store.append(result.sessionId,{type:"host/operation",payload:{method,operationId:result.operationId,state:result.state,outcomeUnknown:result.outcomeUnknown,...(method==="hx.session.revert"&&result.result!==undefined?{result:result.result}:{}),...(result.turnId?{turnId:result.turnId}:{}),...(result.error?{error:result.error as unknown as JsonValue}:{})}},undefined,{turnId:result.turnId});
    if(event)this.publish(event);
  }
  private hasSession(id:string):boolean {try{this.store.session(id);return true;}catch{return false;}}
  private unknownResult(initial:OperationResult):OperationResult{return {...initial,state:"unknown",outcomeUnknown:true,error:{code:"RESULT_UNKNOWN",message:"RESULT_UNKNOWN",retryable:false,outcomeUnknown:true}};}
  private requireLive(id:string):LiveSession {const live=this.live.get(id);if(!live)throw new HostError("SESSION_CLOSED");return live;}
  private async perform(method:HxMethod,p:Values,current:SessionRecord|undefined,id:string,projectId:string,principal:Principal,turnId?:string,operationId?:string):Promise<JsonValue> {
    const ownerId=principal.userId;
    const requestId=method.startsWith("hx.goal.")&&operationId?operationId:randomUUID(),common={requestId,sessionId:id};
    if(method==="hx.session.create") {
      await this.prepareRuntime(str(p,"runtimeConfigId"));
      const descriptor=this.runtimes.find(r=>r.id===p.runtimeConfigId);if(!descriptor||descriptor.available===false)throw new HostError("HARNESS_UNAVAILABLE");
      const root=await this.options.projectRoot(projectId);if(!root)throw new HostError("PROJECT_NOT_FOUND");
      if(descriptor.getAuthStatus){try{descriptor.authStatus=await descriptor.getAuthStatus();}catch(cause){const failure=hostError(cause);throw new HostError(failure.code,failure.message,failure.retryable,false,failure.details);}if(descriptor.authStatus==="required")throw new HostError("AUTH_REQUIRED");}
      if(this.shuttingDown)throw new HostError("HOST_CLOSED");
      const context=p._trusted&&p._fixedContext?p._fixedContext as {instructions:string;mcpServers:McpServer[]}:await this.options.resolveSessionContext?.({principal,projectId,agentId:optionalStr(p,"agentId"),adapterId:descriptor.adapterId,runtimeConfigId:descriptor.id,providerId:descriptor.providerId});
      if(p.agentId&&!p._fixedContext&&!this.options.resolveSessionContext)throw new HostError("AGENT_CONTEXT_UNAVAILABLE");
      await this.options.validateConfig?.({principal,sessionId:id,projectId,runtimeConfigId:descriptor.id,adapterId:descriptor.adapterId,config:structuredClone((p.config as JsonObject|undefined)??{})});
      const instructions=[context?.instructions,optionalStr(p,"instructions")].filter(Boolean).join("\n\n");
      let allocation:WorkspaceAllocation|undefined;
      if(this.options.workspaces&&!p._directory)allocation=await this.options.workspaces.allocate({principal,projectId,sessionId:id,request:p.workspace as WorkspaceRequest|undefined});
      else if(p.workspace&&((p.workspace as Values).kind!=="project"))throw new HostError("WORKSPACE_UNAVAILABLE");
      let cwd:string;try{
        const directory=p._trusted?p._directory as {cwd:string;allowedRoots:string[]}|undefined:undefined;
        cwd=realpathSync(directory?.cwd??allocation?.binding.cwd??root);
        if(directory&&!directory.allowedRoots.some(root=>{const relative=path.relative(realpathSync(root),cwd);return !path.isAbsolute(relative)&&relative!==".."&&!relative.startsWith(`..${path.sep}`);}))throw new HostError("WORKING_DIRECTORY_FORBIDDEN");
      }catch(cause){if(allocation?.created)await allocation.rollback().catch(()=>{});throw cause;}
      const binding={sessionId:id,adapterId:descriptor.adapterId,runtimeConfigId:descriptor.id};
      const record:SessionRecord={id,projectId,ownerId,adapterId:binding.adapterId,runtimeConfigId:binding.runtimeConfigId,cwd,binding,config:(p.config as JsonObject|undefined)??{},revision:1,latestSeq:0,status:"opening",archived:false,bindingGeneration:1,...(p._trusted&&p._managed?{managed:p._managed as {scopeId:string;executionKey:string}}:{}),...(p._admissionRef?{admissionRef:String(p._admissionRef)}:{}),...(allocation?{workspaceBinding:allocation.binding,workspace:this.workspacePublic(allocation.binding)}:{workspace:{kind:"project"}}),createdAt:Date.now(),updatedAt:Date.now(),...(typeof p.agentId==="string"?{agentId:p.agentId}:{}),...(context?.mcpServers?{mcpServers:context.mcpServers}:{}),...(typeof p.model==="string"?{model:p.model}:{}),...(instructions?{instructions}:{})};
      record.executionMode=p.executionMode==='swarm'?'swarm':'normal';
      this.store.saveSession(record);try{await this.open(record,"new");}catch(cause){if(allocation?.created)await allocation.rollback().catch(()=>{});throw cause;}return this.publicSession(id) as unknown as JsonValue;
    }
    if(!current)throw new HostError("SESSION_NOT_FOUND");
    if(["hx.review.start","hx.goal.set","hx.goal.resume","hx.compact.start"].includes(method))await this.validateConfig(principal,current,current.config);
    if(method.startsWith("hx.queue."))return await this.performQueue(method,p,current,principal,turnId,operationId!) as unknown as JsonValue;
    switch(method) {
      case "hx.session.harness.set":return await this.switchHarness(current,p,principal) as unknown as JsonValue;
      case "hx.workspace.integrate":case "hx.workspace.discard":return await this.mutateWorkspace(current,method,p,principal) as unknown as JsonValue;
      case "hx.session.open":await this.validateConfig(principal,current,current.config);await this.open(current,"resume");return this.publicSession(id) as unknown as JsonValue;
      case "hx.session.close": {
        const live=this.live.get(id);if(live){await live.session.close();await live.reader.return?.();await this.disposeLive(live);await live.pump;}
        const next=this.store.session(id);next.status="closed";this.store.saveSession(next);return {closed:true};
      }
      case "hx.session.archive":case "hx.session.restore": {
        const next=this.store.session(id);next.archived=method==="hx.session.archive";this.store.saveSession(next);return this.publicSession(id) as unknown as JsonValue;
      }
      case "hx.session.fork": {
        const nextId=id,binding={...current.binding,sessionId:nextId};
        const next={...current,id:nextId,binding,ownerId,latestSeq:0,revision:1,parent:{sessionId:current.id,boundary:p.boundary as Boundary,bindingGeneration:current.bindingGeneration??1},createdAt:Date.now(),updatedAt:Date.now(),status:"opening" as const};delete next.activeTurnId;delete next.goal;delete next.nativeTitle;delete next.nativeSubagents;delete next.inlineSubagents;next.title=next.fallbackTitle;
        // The adapter-side boundary carries the native turn id; next.parent keeps the canonical one for the product.
        const resolvedBoundary=this.store.boundary(current.id,p.boundary as Boundary);
        const boundary={...resolvedBoundary,turnId:resolvedBoundary.nativeTurnId??resolvedBoundary.turnId};
        let allocation:WorkspaceAllocation|undefined;
        if(this.options.workspaces){allocation=await this.options.workspaces.allocate({principal,projectId,sessionId:nextId,request:p.workspace as WorkspaceRequest|undefined});next.cwd=realpathSync(allocation.binding.cwd);next.workspaceBinding=allocation.binding;next.workspace=this.workspacePublic(allocation.binding);}
        else if(p.workspace&&(p.workspace as Values).kind!=="project")throw new HostError("WORKSPACE_UNAVAILABLE");
        this.store.saveSession(next);this.store.inheritPrivate(current.id,nextId);try{await this.open(next,"fork",{sourceSessionId:current.id,nativeRef:current.binding.nativeRef,boundary});}catch(cause){if(allocation?.created)await allocation.rollback().catch(()=>{});throw cause;}return this.publicSession(nextId) as unknown as JsonValue;
      }
    }
    const live=this.requireLive(id);
    let input=p.input as InputBlock[];
    if(method==="hx.turn.start"||method==="hx.turn.steer") {
      await this.validateConfig(principal,current,current.config,p.overrides as JsonObject|undefined);
      const references=(p.references as HxContextReference[]|undefined)??[];
      if(references.length&&!this.options.resolveInput)throw new HostError("CONTEXT_REFERENCE_UNAVAILABLE");
      if(p._resolvedInput)input=p._resolvedInput as InputBlock[];else if(this.options.resolveInput)input=await this.options.resolveInput({sessionId:id,projectId,cwd:current.cwd,input,references});
      const canonicalTurnId=turnId??str(p,"expectedTurnId");
      const safeInput=this.redactor(id).json(p.input as JsonValue) as unknown as InputBlock[];
      const safeReferences=this.redactor(id).json(references as unknown as JsonValue);
      const next=this.store.session(id);
      if(!next.fallbackTitle){const text=safeInput.filter(b=>b.type==="text").map(b=>b.text).join(" ").trim();if(text){next.fallbackTitle=Array.from(text).slice(0,100).join("");next.title=next.nativeTitle?.trim()||next.fallbackTitle;this.store.saveSession(next);}}
      const event=this.store.append(id,{type:"host/turnInput",payload:{turnId:canonicalTurnId,input:safeInput as unknown as JsonValue,...(references.length?{references:safeReferences}:{}),operationId:operationId!,kind:method==="hx.turn.start"?"start":"steer",state:"dispatching"}},undefined,{turnId:canonicalTurnId});
      if(event)this.publish(event);
    }
    switch(method) {
      case "hx.session.config.set": {
        await this.validateConfig(principal,current,{...current.config,...p.patch as JsonObject});
        const state=await live.session.request("session/config/set",{...common,patch:p.patch as JsonObject});
        if(this.storageClosed)throw new HostError("RESULT_UNKNOWN","RESULT_UNKNOWN",false,true);
        const safe=this.redactor(id).state(state);const next=this.store.session(id);next.config=safe.config;next.model=safe.model;this.store.saveSession(next);return safe as unknown as JsonValue;
      }
      case "hx.session.revert": {
        // The wire boundary must carry the native turn id (native-lifecycle adapters only know native ids); the durable control record keeps the canonical one.
        const resolved=this.store.boundary(id,p.boundary as Boundary);
        const result=await live.session.request("session/revert",{...common,boundary:{...resolved,turnId:resolved.nativeTurnId??resolved.turnId},scope:p.scope as RevertScope});
        if(this.storageClosed)throw new HostError("RESULT_UNKNOWN","RESULT_UNKNOWN",false,true);
        if(result.nativeRef){const next=this.store.session(id);next.binding={...next.binding,nativeRef:result.nativeRef};this.store.saveSession(next);}
        return {appliedScope:result.appliedScope,boundary:p.boundary as Boundary} as unknown as JsonValue;
      }
      case "hx.turn.start":{
        // Hermes has no session-instruction channel. Explicit submissions carry current
        // context; Host operation idempotency covers uncertain/retried submissions.
        if(current.adapterId==="hermes"&&current.instructions)input=[{type:"text",text:`<cowork_context>\n${current.instructions}\n</cowork_context>`},...input];
        await this.turnHook("before",id,turnId!);live.pendingCanonical.push(turnId!);try{await live.session.submit({input,...(p.overrides?{overrides:p.overrides as JsonObject}:{}),...(p.outputSchema!==undefined?{outputSchema:p.outputSchema as JsonObject|boolean}:{})});console.error('[turn-debug] submitted',id,turnId);await this.waitForTurnRow(id,turnId!);console.error('[turn-debug] row registered',id,turnId);return {turnId:turnId!} as unknown as JsonValue;}catch(cause){console.error('[turn-debug] submit failed',id,turnId,cause instanceof Error?cause.message:String(cause));const index=live.pendingCanonical.indexOf(turnId!);if(index>=0)live.pendingCanonical.splice(index,1);throw cause;}}
      case "hx.turn.steer":{const native=this.store.nativeTurn(id,str(p,"expectedTurnId"));return await live.session.request("turn/steer",{...common,expectedTurnId:native??str(p,"expectedTurnId"),input,submissionId:operationId??requestId}) as unknown as JsonValue;}
      case "hx.turn.interrupt":{
        // 适配器在 input.interrupt.targets 下声明中断目标：含 turn 走 turn/interrupt（SDK guard 校验
        // atomicMatch 语义）；仅含 session 的 Harness（Claude/ACP）拒绝 turn/interrupt，翻译为
        // session/interrupt 停止当前生成（不传 cancelQueued，排队项由队列端口管理）。
        const targets=live.session.capabilities.input?.interrupt?.targets;
        if(targets?.includes("session")&&!targets.includes("turn"))return await live.session.request("session/interrupt",{...common}) as unknown as JsonValue;
        const native=this.store.nativeTurn(id,str(p,"turnId"));
        return await live.session.request("turn/interrupt",{...common,turnId:native??str(p,"turnId")}) as unknown as JsonValue;
      }
      case "hx.interaction.respond":{const capture=clientInteractionCapture(live.client);const parked=capture?.pending.get(str(p,"interactionId"));if(parked){capture!.pending.delete(str(p,"interactionId"));parked.resolve(p.response as InteractionResponse);return {interactionId:str(p,"interactionId"),outcome:"responded"} as unknown as JsonValue;}return await live.session.request("interaction/respond",{...common,interactionId:str(p,"interactionId"),response:p.response as InteractionResponse}) as unknown as JsonValue;}
      case "hx.interaction.cancel":{const reason=optionalStr(p,"reason");const capture=clientInteractionCapture(live.client);const parked=capture?.pending.get(str(p,"interactionId"));if(parked){capture!.pending.delete(str(p,"interactionId"));parked.reject(new HarnessSdkError("INTERACTION_CANCELLED"));return {interactionId:str(p,"interactionId"),outcome:"cancelled"} as unknown as JsonValue;}return await live.session.request("interaction/cancel",{...common,interactionId:str(p,"interactionId"),...(reason?{reason}:{})}) as unknown as JsonValue;}
      case "hx.goal.set":{
        const goal=p.goal as JsonObject;
        const input=current.adapterId==="hermes"&&current.instructions?{...goal,context:current.instructions}:goal;
        return await live.session.request("goal/set",{...common,goal:input}) as unknown as JsonValue;
      }
      case "hx.goal.clear":return await live.session.request("goal/clear",common) as unknown as JsonValue;
      case "hx.goal.pause":return await live.session.request("goal/pause",common) as unknown as JsonValue;
      case "hx.goal.resume":return await live.session.request("goal/resume",common) as unknown as JsonValue;
      case "hx.compact.start":return await live.session.request("compact/start",{...common}) as unknown as JsonValue;
      case "hx.review.start":{live.pendingCanonical.push(turnId!);try{await live.session.review({target:p.target as JsonObject});await this.waitForTurnRow(id,turnId!);return {turnId:turnId!} as unknown as JsonValue;}catch(cause){const index=live.pendingCanonical.indexOf(turnId!);if(index>=0)live.pendingCanonical.splice(index,1);throw cause;}}
      default:throw new HostError("METHOD_NOT_FOUND");
    }
  }
  private async validateConfig(principal:Principal,record:SessionRecord,config:JsonObject,overrides?:JsonObject):Promise<void> {
    await this.options.validateConfig?.({principal,sessionId:record.id,projectId:record.projectId,runtimeConfigId:record.runtimeConfigId,adapterId:record.adapterId,config:structuredClone(config),...(overrides?{overrides:structuredClone(overrides)}:{})});
  }
  private workspacePublic(binding:import('./workspaces').WorkspaceBinding) {const {cwd,...metadata}=binding;return metadata;}
  private assertProductIdle(record:SessionRecord):void {
    assertWorkspaceMutable({status:record.status,activeTurnId:record.activeTurnId,pendingInteractions:this.store.interactions(record.id).some(item=>item.state!=="resolved"),pendingQueue:this.store.queue(record.id).items.length>0,unknownOperation:this.store.evidence(record.id,record.bindingGeneration??1,"session")?.quiescent!==true&&this.store.incomplete().some(item=>item.row.session_id===record.id&&item.value.outcomeUnknown&&!this.store.operationStopped(record.id,item.value.operationId)),activeGoal:record.goal?.status==="active",managed:!!record.managed,executedTurns:this.store.executedTurns(record.id)});
  }
  private publishQueue(id:string):void {const event=this.store.append(id,{type:"host/queue",payload:{queue:this.queueSnapshot(id) as unknown as JsonValue}});if(event)this.publish(event);}
  private async performQueue(method:HxMethod,p:Values,current:SessionRecord,principal:Principal,turnId:string|undefined,operationId:string):Promise<HxQueueState> {
    const id=current.id,action=method.slice("hx.queue.".length),now=Date.now();
    let input:InputBlock[]|undefined;
    if(action==="enqueue"||action==="update"){
      await this.validateConfig(principal,current,current.config,p.overrides as JsonObject|undefined);
      const references=(p.references as HxContextReference[]|undefined)??[];
      if(references.length&&!this.options.resolveInput)throw new HostError("CONTEXT_REFERENCE_UNAVAILABLE");
      input=this.options.resolveInput?await this.options.resolveInput({sessionId:id,projectId:current.projectId,cwd:current.cwd,input:p.input as InputBlock[],references}):p.input as InputBlock[];
      // A private answer cannot become a durable retry payload. Reject rather than silently changing model input.
      if(JSON.stringify(this.redactor(id).json(input as unknown as JsonValue))!==JSON.stringify(input))throw new HostError("PRIVATE_QUEUE_INPUT");
    }
    if(action==="steer")await this.validateConfig(principal,current,current.config);
    if(action==="run"&&this.store.interactions(id).some(item=>item.state!=="resolved"))throw new HostError("SESSION_BUSY");
    let steering:StoredQueueItem|undefined;
    const changed=this.store.mutateQueue(id,p.expectedQueueRevision as number,state=>{
      if((this.store.session(id).bindingGeneration??1)!==(current.bindingGeneration??1))throw new HostError("BINDING_GENERATION_MISMATCH");
      const item=typeof p.itemId==="string"?state.items.find(item=>item.id===p.itemId):undefined;
      if(["update","remove","run","steer","retry"].includes(action)&&!item)throw new HostError("QUEUE_ITEM_NOT_FOUND");
      if(item&&["dispatching","running","unknown"].includes(item.state))throw new HostError(item.state==="unknown"?"RECOVERY_REQUIRED":"QUEUE_ITEM_BUSY");
      if(action==="enqueue"){
        state.items.push({id:operationId,turnId:turnId!,state:"queued",input:this.redactor(id).json(p.input as JsonValue) as unknown as InputBlock[],...(Array.isArray(p.references)?{references:p.references as HxContextReference[]}:{}),executionInput:input!,configSnapshot:structuredClone(current.config),...(current.model?{modelSnapshot:current.model}:{}),runtimeConfigId:current.runtimeConfigId,ownerId:principal.userId,bindingGeneration:current.bindingGeneration??1,createdAt:now,updatedAt:now,...(p.overrides?{overrides:p.overrides as JsonObject}:{}),...(p.outputSchema!==undefined?{outputSchema:p.outputSchema as boolean|JsonObject}:{})});
      }else if(action==="update"){
        if(item!.state!=="queued"&&item!.state!=="failed")throw new HostError("QUEUE_ITEM_BUSY");
        Object.assign(item!,{input:p.input,executionInput:input,references:p.references??[],configSnapshot:structuredClone(current.config),modelSnapshot:current.model,updatedAt:now,...(p.overrides?{overrides:p.overrides}:{}),...(p.outputSchema!==undefined?{outputSchema:p.outputSchema}:{})});
      }else if(action==="remove")state.items=state.items.filter(value=>value.id!==item!.id);
      else if(action==="clear"){
        if(state.items.some(value=>value.state==="unknown"))throw new HostError("RECOVERY_REQUIRED");state.items=state.items.filter(value=>value.state==="dispatching"||value.state==="running");state.paused=false;
      }else if(action==="reorder"){
        const ids=p.itemIds as string[],queued=state.items.filter(value=>value.state==="queued"),fixed=state.items.filter(value=>value.state!=="queued");
        if(new Set(ids).size!==ids.length||ids.length!==queued.length||ids.some(itemId=>!queued.some(value=>value.id===itemId)))throw new HostError("QUEUE_ORDER_INVALID");state.items=[...fixed,...ids.map(itemId=>queued.find(value=>value.id===itemId)!)];
      }else if(action==="pause")state.paused=true;
      else if(action==="resume"){if(state.items.some(value=>value.state==="unknown"))throw new HostError("RECOVERY_REQUIRED");state.paused=false;}
      else if(action==="retry"){
        if(item!.state!=="failed")throw new HostError("QUEUE_ITEM_NOT_FAILED");Object.assign(item!,{state:"queued",turnId:turnId!,updatedAt:now});delete item!.error;delete item!.operationId;
      }else if(action==="run"){
        if(item!.state!=="queued")throw new HostError("QUEUE_ITEM_BUSY");state.items=[item!,...state.items.filter(value=>value.id!==item!.id)];state.paused=false;
      }else if(action==="steer"){
        if(item!.state!=="queued")throw new HostError("QUEUE_ITEM_BUSY");item!.state="dispatching";item!.operationId=operationId;item!.updatedAt=now;steering=structuredClone(item!);
      }
    });
    this.publishQueue(id);
    if(action==="run"&&this.store.session(id).activeTurnId){const active=this.store.session(id).activeTurnId!;const native=this.store.nativeTurn(id,active);await this.requireLive(id).session.request("turn/interrupt",{requestId:operationId,sessionId:id,turnId:native??active});}
    if(steering){
      try{
        const native=this.store.nativeTurn(id,str(p,"expectedTurnId"));const result=await this.requireLive(id).session.request("turn/steer",{requestId:operationId,sessionId:id,expectedTurnId:native??str(p,"expectedTurnId"),input:steering.executionInput,submissionId:operationId});
        const event=this.store.append(id,{type:"host/turnInput",payload:{turnId:str(p,"expectedTurnId"),input:steering.input as unknown as JsonValue,...(steering.references?{references:steering.references as unknown as JsonValue}:{}),kind:"steer",state:"completed",operationId}},undefined,{turnId:str(p,"expectedTurnId")});
        if(event)this.publish(event);this.store.mutateQueue(id,undefined,state=>{const item=state.items.find(value=>value.id===steering!.id);if(item)item.state="completed";});
        void result;
      }catch(cause){const error=hostError(cause);this.store.mutateQueue(id,undefined,state=>{const item=state.items.find(value=>value.id===steering!.id);if(item){item.state=error.outcomeUnknown?"unknown":"queued";item.error=error;}if(error.outcomeUnknown)state.paused=true;});this.publishQueue(id);throw cause;}
      this.publishQueue(id);return this.queueSnapshot(id);
    }
    return publicQueue(changed);
  }
  private scheduleQueue(id:string):void {
    if(this.shuttingDown||this.storageClosed)return;if(this.queuePumps.has(id)){this.queueAgain.add(id);return;}
    const pending=Promise.resolve().then(()=>this.drainQueue(id)).catch(cause=>{try{this.options.onError?.(hostError(cause).code);}catch{}}).finally(()=>{if(this.queuePumps.get(id)===pending)this.queuePumps.delete(id);if(this.queueAgain.delete(id))this.scheduleQueue(id);});this.queuePumps.set(id,pending);
  }
  private async drainQueue(id:string):Promise<void> {
    if(this.shuttingDown||!this.hasSession(id)||this.controlBusy.has(id)||this.bindingBusy.has(id))return;
    if(this.store.session(id).permissionDowngrade){await this.applyPermissionDowngrade(id);if(this.store.session(id).permissionDowngrade)return;}
    const queue=this.store.queue(id),record=this.store.session(id);
    if(queue.paused||record.archived||record.managed||record.status==="recoveryRequired"||record.status==="running"||record.activeTurnId||record.goal?.status==="active"||queue.items.some(item=>["dispatching","running","unknown"].includes(item.state))||this.store.interactions(id).some(item=>item.state!=="resolved"))return;
    const item=queue.items.find(item=>item.state==="queued");if(!item)return;
    const connection:HostConnection={id:`queue:${id}`,principal:()=>({userId:item.ownerId,mode:"on"}),send:()=>{}};
    try{await this.access(connection,record.projectId,"maintainer");}catch(cause){this.store.mutateQueue(id,undefined,state=>{state.paused=true;const current=state.items.find(value=>value.id===item.id);if(current){current.state="failed";current.error=hostError(cause);}});this.publishQueue(id);return;}
    try{
      await this.validateConfig(this.principal(connection),record,item.configSnapshot,item.overrides);
      if((record.bindingGeneration??1)!==item.bindingGeneration||record.runtimeConfigId!==item.runtimeConfigId)throw new HostError("BINDING_GENERATION_MISMATCH");
      if(!this.live.has(id))await this.open(record,record.binding.nativeRef?"resume":"new");
    }catch(cause){
      const error=hostError(cause);this.store.mutateQueue(id,undefined,state=>{const current=state.items.find(value=>value.id===item.id);if(current){current.state=error.outcomeUnknown?"unknown":"failed";current.error=error;current.updatedAt=Date.now();}state.paused=true;});
      if(error.outcomeUnknown){const next=this.store.session(id);next.status="recoveryRequired";this.store.saveSession(next);}this.publishQueue(id);return;
    }
    if(this.shuttingDown||this.controlBusy.has(id))return;
    this.store.mutateQueue(id,undefined,state=>{const current=state.items.find(value=>value.id===item.id);if(!current||current.state!=="queued")throw new HostError("QUEUE_ITEM_BUSY");current.state="dispatching";current.updatedAt=Date.now();});this.publishQueue(id);
    let result:OperationResult;
    try{
          const live=this.requireLive(id).session;
      const modelChanged=this.store.session(id).model!==item.modelSnapshot,capturedConfig={...item.configSnapshot,...(modelChanged&&item.modelSnapshot?{model:item.modelSnapshot}:{})},currentConfig=this.store.session(id).config;
      if(Object.keys(currentConfig).some(key=>!(key in capturedConfig)))throw new HostError("QUEUE_CONFIG_CHANGED","The captured configuration cannot be restored by a patch; explicitly edit the queued item to capture the current settings");
      if(this.store.digest(currentConfig)!==this.store.digest(capturedConfig)||modelChanged){
        const state=await live.request("session/config/set",{requestId:randomUUID(),sessionId:id,patch:capturedConfig});
        const safe=this.redactor(id).state(state),next=this.store.session(id);next.config=safe.config;next.model=safe.model;this.store.saveSession(next);
        if(this.store.digest(safe.config)!==this.store.digest(capturedConfig))throw new HostError("QUEUE_CONFIG_CHANGED","The runtime did not restore the captured configuration");
      }
      result=await this.write(connection,"hx.turn.start",{sessionId:id,projectId:record.projectId,idempotencyKey:`queue:${item.id}:${item.turnId}`,expectedRevision:this.store.session(id).revision,input:item.input,references:item.references,_resolvedInput:item.executionInput,_turnId:item.turnId,_trustedQueue:true,...(item.overrides?{overrides:item.overrides}:{}),...(item.outputSchema!==undefined?{outputSchema:item.outputSchema}:{})});
    }catch(cause){const error=hostError(cause);result={operationId:"",sessionId:id,turnId:item.turnId,state:error.outcomeUnknown?"unknown":"failed",outcomeUnknown:error.outcomeUnknown,error};}
    if(this.storageClosed)return;
    this.store.mutateQueue(id,undefined,state=>{const current=state.items.find(value=>value.id===item.id);if(!current||current.state!=="dispatching")return;current.state=result.outcomeUnknown||result.state==="unknown"?"unknown":result.state==="failed"?"failed":"running";current.updatedAt=Date.now();if(result.operationId)current.operationId=result.operationId;if(result.error)current.error=result.error;if(current.state==="unknown"||current.state==="failed")state.paused=true;});this.publishQueue(id);
    if(!this.store.queue(id).items.some(value=>["dispatching","running","unknown"].includes(value.state))&&!this.store.queue(id).paused)queueMicrotask(()=>this.scheduleQueue(id));
  }
  private completeQueuedTurn(id:string,turnId:string,status:string,error?:import('@anureo/protocol').HarnessError):void {
    if(!this.store.queue(id).items.some(item=>item.turnId===turnId))return;
    this.store.mutateQueue(id,undefined,state=>{const item=state.items.find(value=>value.turnId===turnId);if(item){item.state=error?.outcomeUnknown?"unknown":status==="failed"?"failed":"completed";item.updatedAt=Date.now();if(error)item.error=error;if(item.state==="failed"||item.state==="unknown")state.paused=true;}});this.publishQueue(id);
  }
  private async closeLive(id:string):Promise<void> {
    const live=this.live.get(id);if(!live)return;
    try{await live.session.close();await live.reader.return?.();await this.disposeLive(live);await live.pump;}catch{const current=this.store.session(id);current.status="recoveryRequired";this.store.saveSession(current);throw new HostError("RESULT_UNKNOWN","Native runtime shutdown could not be verified",false,true);}
  }
  private async switchHarness(record:SessionRecord,p:Values,principal:Principal):Promise<unknown> {
    await this.prepareRuntime(str(p,"runtimeConfigId"));
    const descriptor=this.runtimes.find(item=>item.id===p.runtimeConfigId&&item.available!==false);if(!descriptor)throw new HostError("HARNESS_UNAVAILABLE");
    this.assertProductIdle(this.store.session(record.id));
    await this.options.validateConfig?.({principal,sessionId:record.id,projectId:record.projectId,runtimeConfigId:descriptor.id,adapterId:descriptor.adapterId,config:{}});
    if(descriptor.getAuthStatus){try{descriptor.authStatus=await descriptor.getAuthStatus();}catch(cause){const error=hostError(cause);throw new HostError(error.code,error.message,error.retryable,false,error.details);}if(descriptor.authStatus==="required")throw new HostError("AUTH_REQUIRED");}
    const context=await this.options.resolveSessionContext?.({principal,projectId:record.projectId,agentId:record.agentId,adapterId:descriptor.adapterId,runtimeConfigId:descriptor.id,providerId:descriptor.providerId});
    const preferred=await this.options.resolveHarnessConfiguration?.({principal,session:this.publicSession(record.id),runtimeConfigId:descriptor.id});
    if(preferred)await this.options.validateConfig?.({principal,sessionId:record.id,projectId:record.projectId,runtimeConfigId:descriptor.id,adapterId:descriptor.adapterId,config:preferred.config});
    const next=structuredClone(this.store.session(record.id));next.adapterId=descriptor.adapterId;next.runtimeConfigId=descriptor.id;next.bindingGeneration=(next.bindingGeneration??1)+1;next.binding={sessionId:next.id,adapterId:descriptor.adapterId,runtimeConfigId:descriptor.id};next.config=preferred?.config??{};next.status="opening";next.model=optionalStr(p,"model")??preferred?.model;delete next.goal;delete next.capabilities;delete next.activeTurnId;delete next.permissionDowngrade;delete next.nativeTitle;next.title=next.fallbackTitle;
    if(context){next.instructions=context.instructions;next.mcpServers=context.mcpServers;}
    // Negotiate/open the target in isolation. Its buffered initial events cannot mutate the old binding.
    const staged=await this.prepareLive(next,descriptor,"new");
    try{await this.closeLive(record.id);if(this.shuttingDown)throw new HostError("HOST_CLOSED");this.installLive(next,staged);}
    catch(cause){try{await this.disposeLive(staged);await staged.reader.return?.();}catch{
      const current=this.store.session(record.id);current.status="recoveryRequired";current.uncertainRuntimeConfigIds=[...new Set([...(current.uncertainRuntimeConfigIds??[]),descriptor.id])];this.store.saveSession(current);
      throw new HostError("RESULT_UNKNOWN","Staged runtime termination could not be verified",false,true);
    }finally{this.releaseRuntime(descriptor.id);}throw cause;}
    const event=this.store.append(next.id,{type:"host/binding",payload:{bindingGeneration:next.bindingGeneration,runtimeConfigId:next.runtimeConfigId,adapterId:next.adapterId}});if(event)this.publish(event);
    return this.publicSession(next.id);
  }
  private async mutateWorkspace(record:SessionRecord,method:HxMethod,p:Values,principal:Principal):Promise<JsonValue> {
    const port=this.options.workspaces;if(!port||!record.workspaceBinding?.worktreeId)throw new HostError("WORKSPACE_UNAVAILABLE");
    this.assertProductIdle(this.store.session(record.id));const proof=await this.executionEvidence(record.id,undefined,true);if(!proof.quiescent||!proof.source)throw new HostError("RESULT_UNKNOWN","Native execution stop has not been verified",false,true);
    const context={principal,projectId:record.projectId,sessionId:record.id,worktreeId:record.workspaceBinding.worktreeId,evidence:{stopped:true as const,source:proof.source,bindingGeneration:record.bindingGeneration??1}};
    if(method==="hx.workspace.integrate"){
      const result=await port.integrate({...context,mode:p.mode as "merge"|"patch",message:optionalStr(p,"message"),force:p.force===true});
      if(!this.live.has(record.id))await this.open(this.store.session(record.id),"resume");
      const event=this.store.append(record.id,{type:"host/workspace",payload:{workspace:this.store.session(record.id).workspace as unknown as JsonValue,action:"integrate"}});if(event)this.publish(event);
      return result as unknown as JsonValue;
    }
    await this.closeLive(record.id);
    const binding=await port.discard({...context,force:p.force===true});const next=this.store.session(record.id);next.cwd=realpathSync(binding.cwd);next.workspaceBinding=binding;next.workspace=this.workspacePublic(binding);next.binding={sessionId:next.id,adapterId:next.adapterId,runtimeConfigId:next.runtimeConfigId};next.bindingGeneration=(next.bindingGeneration??1)+1;delete next.goal;next.status="closed";this.store.saveSession(next);await this.open(next,"new");const event=this.store.append(next.id,{type:"host/workspace",payload:{workspace:next.workspace as unknown as JsonValue,action:"discard"}});if(event)this.publish(event);return next.workspace as unknown as JsonValue;
  }
  private recordWholeStop(id:string,generation:number,evidence:{quiescent:true;evidenceRef:string;source:WorkspaceStopEvidence['source']}):void {
    this.store.recordEvidence(id,generation,"session",evidence);
    for(const operation of this.store.incomplete())if(operation.row.session_id===id)this.store.recordEvidence(id,generation,`operation:${operation.value.operationId}`,evidence);
  }
  async executionEvidence(id:string,turnId?:string,disposeOwned=false):Promise<{quiescent:boolean;evidenceRef?:string;source?:WorkspaceStopEvidence['source']}> {
    const record=this.store.session(id),generation=record.bindingGeneration??1,key=turnId??"session";
    if(record.uncertainRuntimeConfigIds?.length)return{quiescent:false};
    const saved=this.store.evidence(id,generation,key);
    if(saved?.quiescent===true)return {quiescent:true,evidenceRef:String(saved.evidenceRef),source:saved.source as WorkspaceStopEvidence['source']};
    if(turnId&&record.activeTurnId===turnId){
      const wholeStop=this.store.evidence(id,generation,"session");
      if(wholeStop?.quiescent===true&&wholeStop.source==="owned-runtime-disposed"&&!this.live.has(id)){
        return {quiescent:true,evidenceRef:String(wholeStop.evidenceRef),source:"owned-runtime-disposed"};
      }
    }
    const live=this.live.get(id);let descriptor:RuntimeRegistration;try{descriptor=this.runtime(record);}catch{return{quiescent:false};}const nativeId=turnId?this.store.nativeTurn(id,turnId):this.store.nativeTurn(id);
    if(descriptor.inspectExecution)try{const result=await descriptor.inspectExecution(record.binding,nativeId);if(result.stopped){const evidenceRef=`hx-native-inspect:${id}:${generation}:${key}`;this.store.recordEvidence(id,generation,key,{quiescent:true,evidenceRef,source:"native-inspect"});if(!turnId||record.activeTurnId===turnId)this.recordWholeStop(id,generation,{quiescent:true,evidenceRef,source:"native-inspect"});return {quiescent:true,evidenceRef,source:"native-inspect"};}}catch(cause){try{this.options.onError?.(hostError(cause).code);}catch{}}
    if(disposeOwned&&live&&descriptor.ownedRuntime){
      try{await this.disposeLive(live);await live.reader.return?.();await live.pump;}catch{const current=this.store.session(id);current.status="recoveryRequired";this.store.saveSession(current);throw new HostError("RESULT_UNKNOWN","Owned runtime termination could not be verified",false,true);}
      const evidenceRef=`hx-owned-runtime-disposed:${id}:${generation}:${key}`;this.store.recordEvidence(id,generation,key,{quiescent:true,evidenceRef,source:"owned-runtime-disposed"});this.recordWholeStop(id,generation,{quiescent:true,evidenceRef,source:"owned-runtime-disposed"});return {quiescent:true,evidenceRef,source:"owned-runtime-disposed"};
    }
    return {quiescent:false};
  }
  private async prepareLive(record:SessionRecord,descriptor:RuntimeRegistration,mode:"new"|"resume"|"fork",fork?:SessionOpenParams["fork"]):Promise<LiveSession> {
    if(this.shuttingDown)throw new HostError("HOST_CLOSED");
    const active=this.activeCounts.get(descriptor.id)??0,reservation=record.admissionRef&&this.admissions.get(record.admissionRef);
    if(record.admissionRef&&reservation!==descriptor.id)throw new HostError("ADMISSION_EXPIRED");
    const otherReservations=[...this.admissions.entries()].filter(([ref,id])=>id===descriptor.id&&ref!==record.admissionRef).length;
    const uncertain=this.store.sessions().filter(value=>value.uncertainRuntimeConfigIds?.includes(descriptor.id)||(value.id!==record.id&&value.runtimeConfigId===descriptor.id&&!this.live.has(value.id)&&value.status==="recoveryRequired"&&this.store.evidence(value.id,value.bindingGeneration??1,"session")?.quiescent!==true)).length;
    const limit=this.concurrencyLimit(descriptor);
    if(limit>0&&active+otherReservations+uncertain>=limit)throw new HostError("HARNESS_CAPACITY_EXCEEDED");
    if(record.admissionRef){this.admissions.delete(record.admissionRef);delete record.admissionRef;this.store.saveSession(record);}
    this.activeCounts.set(descriptor.id,active+1);
    const context=descriptor.adapterId==="codex"?{commandOutputPrivacy:new PersistentSecretRedactor(this.store,record.id)}:undefined;
    let client:Client;try{
      const cached=record.executionMode==='swarm'?this.catalog.view(descriptor.id,true):undefined;
      const backend=await descriptor.create(context);
      if(record.executionMode==='swarm') {
        // Workspace workflow files load per open; a broken file reports through onError and
        // leaves the session usable without workflows instead of failing the open.
        let workflows:SwarmWorkflowOptions|undefined;try{workflows=await swarmWorkflowOptions(record.cwd);}catch{this.options.onError?.("SWARM_WORKFLOW_LOAD_FAILED");}
        client=await createOwnedSwarmClient(backend,cached&&cached.cache.state!=='empty'?{default:{status:'available',models:(cached.models??[]).map(model=>({id:model.id,name:model.name,isDefault:model.isDefault,efforts:model.effortLevels?.map(id=>({id})),defaultEffort:model.defaultEffort})),...(descriptor.adapterId==='codex'?{effortConfigKey:'effort' as const}:{})}}:undefined,workflows,()=>descriptor.create(context));
      } else client=backend;
    }catch(cause){this.releaseRuntime(descriptor.id);throw cause;}
    let mcp:RuntimeMcpBinding|undefined;
    try{
      if(this.shuttingDown)throw new HostError("HOST_CLOSED");
      const mcpEnabled=!(descriptor.adapterId==="hermes"&&mode==="resume");
      if(mcpEnabled&&this.options.bindRuntimeMcp)mcp=await this.options.bindRuntimeMcp({sessionId:record.id,projectId:record.projectId,ownerId:record.ownerId,adapterId:descriptor.adapterId,providerId:descriptor.providerId,mode});
      if(this.shuttingDown)throw new HostError("HOST_CLOSED");
      const boundServers=mcp?.servers;
      const mcpServers=boundServers?[...boundServers,...(record.mcpServers??[]).filter(server=>!boundServers.some(bound=>bound.name===server.name))]:record.mcpServers;
      // @anureo/sdk 0.3.2 将 SessionOpenParams 收紧为按 mode 判别的联合（fork 必带 fork 明细）；host 侧 wire 形状不变，此处断言过渡。
      const session=await client.openSession({requestId:randomUUID(),mode,binding:record.binding,cwd:record.cwd,config:record.config,...(mcpServers&&mcpEnabled?{mcpServers}:{}),...(record.model?{model:record.model}:{}),...(record.permissionMode?{permissionMode:record.permissionMode}:{}),...(record.instructions&&descriptor.adapterId!=="hermes"?{instructions:record.instructions}:{}),...(fork?{fork}:{})} as Parameters<typeof client.openSession>[0]);
      if(this.shuttingDown)throw new HostError("HOST_CLOSED");if(record.executionMode!=='swarm')descriptor.capabilities={...session.capabilities};
      const nativeTurnToCanonical = mode === "resume"
        ? this.store.executionTurnMap(record.id, record.bindingGeneration ?? 1)
        : new Map<string, string>();
      if(fork&&fork.sourceSessionId){const origin=this.live.get(fork.sourceSessionId);if(origin)for(const [nativeId,canonicalId] of origin.nativeTurnToCanonical)nativeTurnToCanonical.set(nativeId,canonicalId);}
      return{client,session,reader:session.events()[Symbol.asyncIterator](),pump:Promise.resolve(),runtimeConfigId:descriptor.id,registration:descriptor,bindingGeneration:record.bindingGeneration??1,nativeTurnToCanonical,pendingCanonical:[],streamSeqs:new Map(),mcp};
    }catch(cause){
      this.releaseMcp(mcp);
      try{await client.dispose();}catch{
        if(!this.storageClosed&&this.hasSession(record.id)){const current=this.store.session(record.id);current.status="recoveryRequired";current.uncertainRuntimeConfigIds=[...new Set([...(current.uncertainRuntimeConfigIds??[]),descriptor.id])];this.store.saveSession(current);}
        throw new HostError("RESULT_UNKNOWN","Target runtime termination could not be verified",false,true);
      }finally{this.releaseRuntime(descriptor.id);}throw cause;
    }
  }
  private releaseMcp(binding:RuntimeMcpBinding|undefined):void {
    try{binding?.release();}catch{try{this.options.onError?.("RUNTIME_MCP_RELEASE_FAILED");}catch{}}
  }
  private disposeLive(live:LiveSession):Promise<void> {
    this.releaseMcp(live.mcp);
    delete live.mcp;
    return live.client.dispose();
  }
  /** The pump registers canonical turn rows asynchronously while submit resolves at association; boundary consumers need the row, so give it a bounded window before the operation result lands. */
  private async waitForTurnRow(id:string,turnId:string,ms=1000):Promise<void> {
    for(let deadline=Date.now()+ms;Date.now()<deadline;){if(this.store.nativeTurn(id,turnId)!==undefined)return;await new Promise(r=>setTimeout(r,10));}
  }
  /** Rewrite native turn identities into the product's canonical contract: envelope scope and turn payloads carry the canonical id while the native id lands in nativeTurnId; source seq renumbers from the store ledger because 0.3 native streams skip the ledger's reserved first slot. */
  private async *translate(_id:string,reader:AsyncIterator<AhpEvent>,live:LiveSession):AsyncGenerator<AhpEvent> {
    for(;;){let item:IteratorResult<AhpEvent>;try{item=await reader.next();}catch(cause){if(hostError(cause).code==="OBSERVATION_CLOSED")return;throw cause;}if(item.done)return;const source=item.value;
      if(source.type==="turn/started"){const native=source.payload.turnId;if(native&&!live.nativeTurnToCanonical.has(native)){const bound=live.pendingCanonical.shift()??native;live.nativeTurnToCanonical.set(native,bound);}}
      let canonical=source.turnId?live.nativeTurnToCanonical.get(source.turnId)??source.turnId:source.turnId;
      if(!canonical&&(source.type==="turn/started"||source.type==="turn/completed")&&typeof source.payload.turnId==="string")canonical=live.nativeTurnToCanonical.get(source.payload.turnId)??source.payload.turnId;
      const payload=source.type==="turn/started"||source.type==="turn/completed"?{...source.payload,turnId:canonical,nativeTurnId:source.payload.turnId}:source.type==='interaction/requested'&&canonical?{...source.payload,turnId:canonical}:source.payload;
      const streamSeq=(live.streamSeqs.get(source.streamId)??0)+1;live.streamSeqs.set(source.streamId,streamSeq);
      yield {...source,seq:streamSeq,turnId:canonical,payload} as AhpEvent;
    }
  }
  private installLive(record:SessionRecord,live:LiveSession):void {
    this.store.clearEvidence(record.id,record.bindingGeneration??1,"session");
    record.binding={...live.session.binding};record.status="ready";record.capabilities=this.redactor(record.id).capabilities(live.session.capabilities);record.capabilityRevision=record.capabilityRevision??1;this.store.saveSession(record);
    const nativeGoal=live.session.snapshot.goal;
    const prior=record.goal?.goal;
    const goal=nativeGoal?.goal?.status==="complete"&&prior?.status==="complete"&&prior.objective===nativeGoal.goal.objective
      &&prior.createdAt===nativeGoal.goal.createdAt&&typeof prior.completionTurnId==="string"&&!nativeGoal.goal.completionTurnId
      ? {...nativeGoal,goal:{...nativeGoal.goal,completionTurnId:prior.completionTurnId}} : nativeGoal;
    if(goal&&!isDeepStrictEqual(goal,record.goal)){
      const event=this.store.append(record.id,{type:"session/goal",payload:this.redactor(record.id).goal(goal)},undefined,{bindingGeneration:live.bindingGeneration});
      if(event)this.publish(event);
    }
    this.live.set(record.id,live);live.pump=this.pump(record.id,this.translate(record.id,live.reader,live),live).catch(cause=>{try{this.options.onError?.(hostError(cause).code);}catch{}});
  }
  private async open(record:SessionRecord,mode:"new"|"resume"|"fork",fork?:SessionOpenParams["fork"]):Promise<void> {
    if(this.live.has(record.id))throw new HostError("SESSION_ALREADY_OPEN");
    this.store.clearEvidence(record.id,record.bindingGeneration??1,"session");
    try{this.installLive(record,await this.prepareLive(record,this.runtime(record),mode,fork));}
    catch(cause){if(!this.shuttingDown&&!this.storageClosed){const current=this.store.session(record.id);if(current.status!=="recoveryRequired"){current.status="closed";this.store.saveSession(current);}}throw cause;}
  }
  private releaseRuntime(id:string):void {this.activeCounts.set(id,Math.max(0,(this.activeCounts.get(id)??1)-1));}
  /** Append explicit corrections for structured fallback items saved by older Codex adapters. */
  private repairLegacySubagents(id:string):void {
    if(this.repairedSubagentSessions.has(id))return;
    this.repairedSubagentSessions.add(id);
    const record=this.store.session(id);
    if(record.adapterId!=='codex'||!record.binding.nativeRef)return;
    // Most sessions need no repair. Avoid replaying their transcripts during session-list reads.
    if(!this.store.hasLegacySubagentActivity(id))return;
    const candidates=new Map<string,{source:HostEvent;item:Item}>();
    const repaired=new Set<string>(),latestNativeState=new Map<string,number>();
    let cursor=0;const through=record.latestSeq;
    while(cursor<through){
      const page=this.store.events(id,cursor,through,1000);
      for(const source of page.events){
        const event=source.event;
        if(event.type==='host/subagent'){
          const activity=event.payload.activity;
          if(activity&&typeof activity==='object'&&!Array.isArray(activity)&&typeof activity.turnId==='string'&&activity.item&&typeof activity.item==='object'&&!Array.isArray(activity.item)&&typeof activity.item.id==='string')repaired.add(`${activity.turnId}\0${activity.item.id}`);
        }
        if((event.type!=='item/started'&&event.type!=='item/completed')||!source.turnId||(source.bindingGeneration??1)!==(record.bindingGeneration??1))continue;
        const item=event.payload.item;
        if(item.type==='subagent')latestNativeState.set(item.subagentId,source.hostSeq);
        else if(nativeSubagentActivity(item))candidates.set(`${source.turnId}\0${item.id}`,{source,item});
      }
      if(page.nextAfterSeq<=cursor)break;
      cursor=page.nextAfterSeq;
    }
    for(const [key,{source,item}] of [...candidates].sort((a,b)=>a[1].source.hostSeq-b[1].source.hostSeq)){
      if(repaired.has(key))continue;
      const native=nativeSubagentActivity(item)!;
      const result=registerSubagent(this.store,this.store.session(id),native,!!this.runtimes.find(runtime=>runtime.id===record.runtimeConfigId&&runtime.available!==false)?.readSubagentHistory,source.turnId,(latestNativeState.get(native.subagentId)??0)>source.hostSeq);
      if(!result.summary)continue;
      const event=this.store.append(id,{type:'host/subagent',payload:{subagent:{...result.summary},activity:{turnId:source.turnId!,item:result.item as unknown as JsonObject}}});
      if(event)this.publish(event);
    }
  }
  private async discoverSubagents(record:SessionRecord):Promise<void> {
    const parentNativeRef=record.binding.nativeRef;
    const discover=this.runtimes.find(runtime=>runtime.id===record.runtimeConfigId&&runtime.available!==false)?.discoverSubagents;
    if(!parentNativeRef||!discover)return;
    const key=`${record.id}:${record.bindingGeneration??1}`;
    let pending=this.subagentDiscovery.get(key);
    if(!pending){
      pending=(async()=>{
        let children:Awaited<ReturnType<SubagentDiscoveryPort>>;
        try{children=await discover({parentNativeRef,cwd:record.cwd});}
        catch(cause){if(hostError(cause).code==='CAPABILITY_UNSUPPORTED')return;throw historyReadError(cause);}
        const current=this.store.session(record.id);
        if((current.bindingGeneration??1)!==(record.bindingGeneration??1)||current.binding.nativeRef?.value!==parentNativeRef.value)return;
        for(const child of children){
          if(!child.id||child.id===parentNativeRef.value||child.parentThreadId!==parentNativeRef.value)continue;
          const previous=current.nativeSubagents?.find(entry=>entry.nativeRef.value===child.id&&entry.runtimeConfigId===current.runtimeConfigId&&entry.bindingGeneration===(current.bindingGeneration??1));
          this.observeSubagent(current,{id:`discovered:${child.id}`,type:'subagent',subagentId:child.id,state:previous?.summary.status==='disconnected'?'running':previous?.summary.status??'running',...(child.name?{name:child.name}:{}),...(child.task?{task:child.task}:{})});
        }
      })().finally(()=>this.subagentDiscovery.delete(key));
      this.subagentDiscovery.set(key,pending);
    }
    await pending;
  }
  private observeSubagent(record:SessionRecord,item:Extract<Item,{type:'subagent'}>,parentTurnId?:string,preserveLifecycle=false) {
    const result=registerSubagent(this.store,record,this.redactor(record.id).item(item) as Extract<Item,{type:'subagent'}>,!!this.runtimes.find(runtime=>runtime.id===record.runtimeConfigId&&runtime.available!==false)?.readSubagentHistory,parentTurnId,preserveLifecycle);
    if(result.changed&&result.summary){const event=this.store.append(record.id,{type:'host/subagent',payload:{subagent:{...result.summary}}});if(event)this.publish(event);}
    return result;
  }
  private async prepareItem(id:string,item:Item,parentTurnId?:string,register:boolean|'history'=true):Promise<Item> {
    const record=this.store.session(id);
    let prepared=this.options.prepareItem?await this.options.prepareItem({sessionId:id,projectId:record.projectId,cwd:record.cwd,item}):item;
    // Binary source payloads must never enter durable events or public history.
    if(prepared.type==="toolCall"&&prepared.image?.data!==undefined){const {data:_data,...image}=prepared.image;prepared={...prepared,image:{...image,unavailable:image.unavailable??"notProvided"}};}
    assertDefinition<Item>("Item",prepared);
    if(prepared.id!==item.id||prepared.type!==item.type)throw new HostError("PROTOCOL_ERROR");
    if(prepared.type==='subagent'){
      const current=this.store.session(id);
      if(register&&(record.bindingGeneration??1)===(current.bindingGeneration??1)){
        const registered=this.observeSubagent(current,prepared,parentTurnId,register==='history');
        prepared=registered.item;
      }else{const {coworkSubagent:_ignored,...extensions}=prepared.extensions??{};prepared={...prepared,extensions};}
    }
    return prepared;
  }
  private async pump(id:string,reader:AsyncIterator<AhpEvent>,live:LiveSession):Promise<void> {
    try{
      for(;;){const item=await reader.next();if(item.done||this.storageClosed)break;
        if(item.value.sessionId!==id)throw new HostError("SOURCE_SESSION_MISMATCH");
        if(live.bindingGeneration!==(this.store.session(id).bindingGeneration??1))continue;
        if(item.value.type==="interaction/requested"&&item.value.payload.privatePayload)this.privateInteractions.set(`${id}:${item.value.payload.interactionId}`,item.value.payload.privatePayload);
        if(item.value.type==="interaction/resolved")this.privateInteractions.delete(`${id}:${item.value.payload.interactionId}`);
        let source=item.value;
        if(source.type==='notice'&&source.payload.code==='SUBAGENT_THREAD_STARTED'){
          const evidence=source.payload.extensions;
          const current=this.store.session(id);
          if(evidence&&typeof evidence.nativeThreadId==='string'&&evidence.parentThreadId===current.binding.nativeRef?.value){
            this.observeSubagent(current,{id:`discovered:${evidence.nativeThreadId}`,type:'subagent',subagentId:evidence.nativeThreadId,state:'running',...(typeof evidence.agentNickname==='string'?{name:evidence.agentNickname}:{})},undefined,true);
          }
        }
        if(source.type==="item/started"||source.type==="item/completed")source={...source,payload:{item:await this.prepareItem(id,source.payload.item,source.turnId?live.nativeTurnToCanonical.get(source.turnId)??source.turnId:undefined)}};
        else if(source.type==="item/delta"&&source.payload.kind==="patch"&&source.payload.value&&typeof source.payload.value==="object"&&"type" in source.payload.value){assertDefinition<Item>("Item",source.payload.value);source={...source,payload:{...source.payload,value:await this.prepareItem(id,source.payload.value) as unknown as JsonValue}};}
        const safe=this.redactor(id).event({type:source.type,payload:source.payload} as Parameters<SecretRedactor["event"]>[0]);
        const event=this.store.appendSource({...item.value,...safe} as AhpEvent,live.bindingGeneration);if(event)this.publish(event);
        if(item.value.type==="turn/completed"){this.completeQueuedTurn(id,item.value.payload.turnId,item.value.payload.status,item.value.payload.error);if(!item.value.payload.error?.outcomeUnknown)await this.turnHook("settled",id,item.value.payload.turnId,item.value.payload.status);}
        if(item.value.type==="turn/completed"||item.value.type==="interaction/resolved"||item.value.type==="session/state"||item.value.type==="session/goal")this.scheduleQueue(id);
      }
    }catch(cause){

      const failure=hostError(cause);
      // Only an uncertain execution needs explicit recovery. An idle session (no active turn, unresolved interaction or
      // in-flight queue item) just closes in the `finally` below and is reopened transparently on the next use.
      // `failure.outcomeUnknown` is deliberately not consulted: the SDK marks every observation failure as outcome-unknown
      // ("native stop unconfirmed"), which would make this check vacuous. An unverified runtime stop is still escalated to
      // recovery by the `finally` (dispose failure). Fail safe: if the durable state cannot be read, require recovery.
      let needsRecovery=true;
      try{if(this.hasSession(id)){const current=this.store.session(id);needsRecovery=!!current.activeTurnId||this.store.interactions(id).some(i=>i.state!=="resolved")||this.store.queue(id).items.some(item=>["dispatching","running","unknown"].includes(item.state));}}catch{}
      try{this.options.onError?.(failure.code);}catch{}
      try{this.options.onEventStreamError?.({sessionId:id,code:failure.code,...(cause instanceof Error&&cause.message?{message:cause.message.slice(0,500)}:{}),outcomeUnknown:failure.outcomeUnknown,recoveryRequired:needsRecovery});}catch{}
      for(const [key,sub] of this.subscriptions){if(sub.sessionId===id){sub.active=false;this.subscriptions.delete(key);let lastAvailableSeq=0;try{lastAvailableSeq=this.store.session(id).latestSeq;}catch{}
        try{await sub.connection.send({jsonrpc:"2.0",method:"hx.subscription.error",params:{subscriptionId:sub.id,code:"EVENT_STREAM_FAILED",lastAvailableSeq}});}catch{}
      }}
      if(needsRecovery)try{if(this.hasSession(id)){const s=this.store.session(id);s.status="recoveryRequired";this.store.saveSession(s);}}catch{}
      // Stop the source on storage failure; never acknowledge unpersisted events as delivered.
      await Promise.resolve().then(()=>reader.return?.()).catch(()=>{});await this.disposeLive(live).catch(()=>{});
    }finally{
      let disposed=false;try{await this.disposeLive(live);disposed=true;}catch{}
      if(this.live.get(id)===live){
        // Preserve verified owned-process cleanup before transferring the live owner
        // to recovery. A failed turn can remain unknown without retaining a seat.
        if(disposed&&live.registration.ownedRuntime&&!this.storageClosed)try{
          if(this.hasSession(id))this.recordWholeStop(id,live.bindingGeneration,{quiescent:true,evidenceRef:`hx-owned-runtime-disposed:${id}:${live.bindingGeneration}:session`,source:"owned-runtime-disposed"});
        }catch(cause){try{this.options.onError?.(hostError(cause).code);}catch{}}
        // Transfer a failed live owner to the durable recovery capacity hold before releasing its live count.
        if(!disposed)try{if(this.hasSession(id)){const current=this.store.session(id);current.status="recoveryRequired";this.store.saveSession(current);}}catch{}
        this.live.delete(id);this.releaseRuntime(live.runtimeConfigId);
        try{if(this.hasSession(id)){
          const current=this.store.session(id);
          if(current.status!=="recoveryRequired"){
            current.status=current.activeTurnId||this.store.interactions(id).some(i=>i.state!=="resolved")?"recoveryRequired":"closed";this.store.saveSession(current);
          }
        }}catch{}
      }
    }
  }
  private publish(event:HostEvent):void {
    try{this.options.onEvent?.(event);}catch{}
    for(const sub of this.subscriptions.values()) {
      if(!sub.active||sub.sessionId!==event.sessionId||event.hostSeq<=sub.lastSeq)continue;
      const bytes=new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if(sub.pending+1>(this.options.maxNotificationEvents??2048)||sub.bytes+bytes>(this.options.maxNotificationBytes??16*1024*1024)) {
        sub.active=false;this.subscriptions.delete(sub.id);
        void Promise.resolve(sub.connection.send({jsonrpc:"2.0",method:"hx.subscription.error",params:{subscriptionId:sub.id,code:"SUBSCRIPTION_OVERFLOW",lastAvailableSeq:event.hostSeq}})).catch(()=>sub.connection.close?.());continue;
      }
      sub.pending++;sub.bytes+=bytes;
      sub.tail=sub.tail.then(async()=>{
        if(!sub.active)return;
        await this.access(sub.connection,this.store.session(event.sessionId).projectId,"viewer");
        await sub.connection.send({jsonrpc:"2.0",method:"hx.event",params:{subscriptionId:sub.id,...event}});sub.lastSeq=event.hostSeq;
      }).catch(()=>{sub.active=false;this.subscriptions.delete(sub.id);sub.connection.close?.();}).finally(()=>{sub.pending--;sub.bytes-=bytes;});
    }
  }
  private async reconcile(record:SessionRecord):Promise<unknown> {
    // Explicit reconciliation may terminate an independently owned runtime, but never resubmits.
    if(record.status==="recoveryRequired"||this.store.queue(record.id).items.some(item=>item.state==="unknown")){
      const evidence=await this.executionEvidence(record.id,record.activeTurnId,true);
      if(evidence.quiescent){
        const events=this.store.reconcileStopped(record,this.live.has(record.id),evidence.evidenceRef);
        for(const event of events)this.publish(event);
      }
    }
    // Original operation results stay unknown. Retry is a separate explicit intent with a new turn ID.
    return {session:this.publicSession(record.id),operations:this.store.incomplete().filter(o=>o.row.session_id===record.id).map(o=>o.value)};
  }
  /** Replaces discovery metadata and future factories; running sessions retain their original registration. */
  refreshRuntimes(runtimes:RuntimeRegistration[]):Promise<void> {
    return this.queueCatalogRefresh(async()=>runtimes);
  }
  authChanged(providerId:string):void {
    if(this.shuttingDown)return;
    const ids=this.runtimes.filter(r=>(r.providerId??r.adapterId)===providerId).map(r=>r.id);
    this.catalog.resetIdentity(ids);
    void this.notifyCatalogSnapshot(ids,["auth"]);
  }
  /** Re-read the configured source. Explicit empty and invalid files never fall back to discovery. */
  refreshCatalog():Promise<void> {
    if(!this.options.loadRuntimes)return Promise.resolve();
    return this.queueCatalogRefresh(this.options.loadRuntimes);
  }
  /** Catalog reads never wait for a native process. Session creation still checks auth live. */
  private refreshCatalogAuth():void {
    for(const runtime of this.runtimes){
      if(runtime.available===false||!runtime.getAuthStatus)continue;
      const previous=this.catalogAuthChecks.get(runtime);
      if(previous&&(previous.pending||Date.now()-previous.checkedAt<30_000))continue;
      const check={pending:true,checkedAt:0};this.catalogAuthChecks.set(runtime,check);
      const initial=runtime.authStatus;
      void Promise.resolve().then(()=>runtime.getAuthStatus!()).catch(()=>"unknown" as const).then(async status=>{
        // A replaced registration or a newer live auth check owns its own status.
        if(this.shuttingDown||!this.runtimes.includes(runtime)||runtime.authStatus!==initial)return;
        if((runtime.authStatus??"unknown")===status)return;
        runtime.authStatus=status;
        await this.notifyCatalogChanged();await this.notifyCatalogSnapshot([runtime.id],["auth"]);
      }).finally(()=>{check.pending=false;check.checkedAt=Date.now();});
    }
  }
  private async notifyCatalogSnapshot(runtimeConfigIds:string[],changes:Array<"runtime"|"models"|"auth"|"refresh">):Promise<void>{
    if(this.shuttingDown)return;const revision=++this.catalogRevision;
    await Promise.all([...this.snapshotScopes.entries()].map(async([id,scope])=>{
      if(!this.initialized.has(id))return;
      for(const projectId of [...scope.projects])try{
        await this.access(scope.connection,projectId,"viewer");if(this.shuttingDown||this.snapshotScopes.get(id)!==scope)break;
        await scope.connection.send({jsonrpc:"2.0",method:"hx.catalog.changed",params:{projectId,epoch:this.catalogEpoch,revision,runtimeConfigIds,changes}});
      }catch{scope.projects.delete(projectId);}
    }));
  }
  private async notifyCatalogChanged():Promise<void> {
    const revision=++this.catalogRevision;
    await Promise.all([...this.catalogScopes.entries()].map(async([connectionId,scope])=>{
      if(!this.initialized.has(connectionId))return;
      for(const projectId of [...scope.projects]){
        try{
          await this.access(scope.connection,projectId,"viewer");
          if(this.shuttingDown||this.catalogScopes.get(connectionId)!==scope||!this.initialized.has(connectionId))break;
          const notification:HxHarnessChangedNotification={jsonrpc:"2.0",method:"hx.harness.changed",params:{projectId,revision}};
          await scope.connection.send(notification);
        }catch{scope.projects.delete(projectId);}
      }
      if(!scope.projects.size&&this.catalogScopes.get(connectionId)===scope)this.catalogScopes.delete(connectionId);
    }));
  }
  private queueCatalogRefresh(load:()=>Promise<RuntimeRegistration[]>|RuntimeRegistration[]):Promise<void> {
    const refreshed=this.catalogRefresh.catch(()=>{}).then(async()=>{
      if(this.shuttingDown)throw new HostError("HOST_CLOSED");
      const next=await load();
      if(this.shuttingDown)throw new HostError("HOST_CLOSED");
      const ids=new Set<string>();
      for(const registration of next){if(!registration.id||ids.has(registration.id)||!registration.adapterId||typeof registration.create!=="function")throw new HostError("HOST_CONFIG_INVALID");ids.add(registration.id);}
      this.runtimes=[...next];this.catalog.replace(this.runtimes);await this.notifyCatalogChanged();await this.notifyCatalogSnapshot(this.runtimes.map(r=>r.id),["runtime"]);
    });
    this.catalogRefresh=refreshed;return refreshed;
  }
  disconnect(connectionId:string):void {this.snapshotScopes.delete(connectionId);this.catalogScopes.delete(connectionId);this.initialized.delete(connectionId);for(const [id,sub] of this.subscriptions){if(sub.connection.id===connectionId){sub.active=false;this.subscriptions.delete(id);}}}
  close():Promise<void> {this.shuttingDown=true;if(this.bootstrapRetry)clearTimeout(this.bootstrapRetry);return this.closing??=this.performClose();}
  private async performClose():Promise<void> {
    for(const sub of this.subscriptions.values())sub.active=false;this.subscriptions.clear();this.initialized.clear();this.catalogScopes.clear();this.snapshotScopes.clear();await this.catalog.close();
    const limit=this.options.shutdownTimeoutMs??10_000;
    const drain=async(pending:Promise<unknown>[])=>{
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([Promise.allSettled(pending),new Promise<void>(resolve=>{timer=setTimeout(resolve,limit);})]);}finally{if(timer)clearTimeout(timer);}
    };
    await drain([...this.live.values()].map(async live=>{await this.disposeLive(live).catch(()=>{});await live.reader.return?.();await live.pump.catch(()=>{});}));
    await drain([...this.inFlight]);
    try{for(const {row,value} of this.store.incomplete()){
      const ended:OperationResult=row.phase==="accepted"&&value.state==="accepted"?{...value,state:"failed",outcomeUnknown:false,error:{code:"NOT_DISPATCHED",message:"NOT_DISPATCHED",retryable:false,outcomeUnknown:false}}:this.unknownResult(value);
      this.closedResults.set(value.operationId,ended);
      try{this.store.finishOperation(ended);}catch(cause){try{this.options.onError?.(hostError(cause).code);}catch{}}
    }}catch(cause){try{this.options.onError?.(hostError(cause).code);}catch{}}
    finally{
      this.storageClosed=true;this.live.clear();this.privateInteractions.clear();this.secrets.clear();
      try{this.store.close();}catch(cause){try{this.options.onError?.(hostError(cause).code);}catch{}}
    }
  }
  async handle(connection:HostConnection,request:RpcRequest):Promise<RpcResponse> {
    if(typeof request.id!=="number"||!Number.isSafeInteger(request.id))return {jsonrpc:"2.0",id:null,error:{code:-32600,message:"Invalid Request",data:{code:"INVALID_REQUEST",message:"Invalid Request",retryable:false,outcomeUnknown:false}}};
    try{if(!isHxMethod(request.method))throw new HostError("METHOD_NOT_FOUND");return {jsonrpc:"2.0",id:request.id,result:await this.request(connection,request.method,(request.params??{}) as HxRequestMap[HxMethod])};}catch(cause){
      const error=rpcError(cause),params=request.params as Values|undefined;
      if(error.data.details&&params&&typeof params.sessionId==="string"){const privacy=this.secrets.get(params.sessionId);if(privacy)error.data.details=privacy.json(error.data.details) as JsonObject;}
      return {jsonrpc:"2.0",id:request.id,error};
    }
  }
}
