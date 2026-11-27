import type { OpenSqlite, SqliteConnection } from "./sqlite-driver";
import { CatalogStore, type CatalogStorage } from "./catalog-store";
import { createHash,createHmac,randomBytes } from "node:crypto";
import { mkdirSync,readFileSync,writeFileSync,existsSync,realpathSync } from "node:fs";
import path from "node:path";
import type { AhpEvent,JsonObject,SessionBinding,SessionState,HistoryPage,McpServer,GoalState,Usage } from "@anureo/protocol";
import { publicEvent,publicInteraction,publicValue } from "@anureo/protocol";
import type { PublicSession,PublicInteraction,HostEvent,OperationResult,EventPage } from "./legacy-protocol";
import { HostError } from "./errors";
import { publicQueue,queuePending,type StoredQueueState,type StoredQueueItem } from "./queue";

export type SessionRecord=PublicSession&{inlineSubagents?:import("./subagents").StoredInlineSubagent[];nativeSubagents?:import("./subagents").StoredSubagent[];fallbackTitle?:string;nativeTitle?:string|null;binding:SessionBinding;instructions?:string;mcpServers?:McpServer[];goal?:GoalState;workspaceBinding?:import("./workspaces").WorkspaceBinding;admissionRef?:string;uncertainRuntimeConfigIds?:string[];permissionMode?:string;permissionDowngrade?:{config:JsonObject;permissionMode?:string;key:string;principalId:string;state:"pending"|"failed";error?:string}};
export interface PrivateAnswerHint {length:number;first:string;last:string;digest:string;scope?:string}
interface OperationRow {id:string;principal_id:string;method:string;target:string;idempotency_key:string;request_digest:string;phase:string;state:string;session_id:string|null;turn_id:string|null;result_json:string}
function canonical(value:unknown):string {
  if(value===null||typeof value!=="object")return JSON.stringify(value)??"null";
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
export interface SqliteStoreHooks {beforeCommit?:()=>void;afterCommit?:()=>void}
export class SqliteHostStore {
  readonly db:SqliteConnection;
  readonly catalog:CatalogStore;
  private readonly hmacKey:Uint8Array;
  private readonly privateHints=new Map<string,PrivateAnswerHint[]>();
  private readonly ownership?:SqliteConnection;
  private closed=false;
  constructor(readonly file:string,openSqlite:OpenSqlite,private readonly hooks:SqliteStoreHooks={}) {
    if(file!==":memory:") {
      mkdirSync(path.dirname(file),{recursive:true});
      const canonicalFile=existsSync(file)?realpathSync(file):path.join(realpathSync(path.dirname(file)),path.basename(file));
      const ownership=openSqlite(`${canonicalFile}.owner`);
      try { ownership.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
      catch (error) {
        ownership.close();
        if(error&&typeof error==='object'&&('code' in error&&error.code==='SQLITE_BUSY'||'errcode' in error&&error.errcode===5))throw new HostError('HOST_STORAGE_IN_USE');
        throw error;
      }
      this.ownership=ownership;
    }
    let db:SqliteConnection|undefined;
    try {
      this.hmacKey=this.loadKey(openSqlite);
      db=openSqlite(file);
      this.db=db;
      this.catalog=new CatalogStore(db);
      this.migrate();
    } catch (error) {
      try { db?.close(); } finally { this.ownership?.close(); }
      throw error;
    }
  }
  private loadKey(openSqlite:OpenSqlite):Uint8Array {
    const {file}=this;
    const keyFile=`${file}.key`;
    if(file===":memory:")return randomBytes(32);
    if(existsSync(file)&&!existsSync(keyFile)){
      const existing=openSqlite(file,true);
      try{const version=existing.query("PRAGMA user_version").get() as {user_version:number};if(version.user_version>0)throw new HostError("HOST_KEY_MISSING");}finally{existing.close();}
    }
    try{writeFileSync(keyFile,randomBytes(32),{flag:"wx",mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
    const key=readFileSync(keyFile);if(key.byteLength!==32)throw new HostError("HOST_KEY_INVALID");
    return key;
  }
  private migrate():void {
    const {file}=this;
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const version=this.db.query("PRAGMA user_version").get() as {user_version:number};
    if(version.user_version>4)throw new HostError("SCHEMA_VERSION_UNSUPPORTED");
    if(version.user_version===0){
      if(file!==":memory:" && existsSync(file) && !existsSync(`${file}.pre-v1.bak`) && (this.db.query("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get() as {n:number}).n>0)this.db.query("VACUUM INTO ?").run(`${file}.pre-v1.bak`);
      this.db.transaction(()=>this.db.exec(`
        CREATE TABLE IF NOT EXISTS hx_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS hx_sessions(id TEXT PRIMARY KEY, project_id TEXT NOT NULL,record_json TEXT NOT NULL,last_host_seq INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS hx_events(session_id TEXT NOT NULL,host_seq INTEGER NOT NULL,source_stream_id TEXT,source_seq INTEGER,type TEXT NOT NULL,turn_id TEXT,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(session_id,host_seq),UNIQUE(session_id,source_stream_id,source_seq),FOREIGN KEY(session_id) REFERENCES hx_sessions(id));
        CREATE TABLE IF NOT EXISTS hx_turns(session_id TEXT NOT NULL,turn_id TEXT NOT NULL,native_turn_id TEXT,status TEXT NOT NULL,execution_state TEXT NOT NULL,terminal_host_seq INTEGER,PRIMARY KEY(session_id,turn_id));
        CREATE TABLE IF NOT EXISTS hx_interactions(session_id TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(session_id,id));
        CREATE TABLE IF NOT EXISTS hx_operations(id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,method TEXT NOT NULL,target TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,phase TEXT NOT NULL,state TEXT NOT NULL,session_id TEXT,turn_id TEXT,result_json TEXT NOT NULL,UNIQUE(principal_id,method,target,idempotency_key));
        INSERT OR REPLACE INTO hx_meta(key,value) VALUES('schema_version','1'); PRAGMA user_version=1;
      `))();
    }
    if(version.user_version<2){
      if(version.user_version===1&&file!==":memory:"&&!existsSync(`${file}.pre-v2.bak`))this.db.query("VACUUM INTO ?").run(`${file}.pre-v2.bak`);
      this.db.transaction(()=>{
        this.db.exec(`CREATE TABLE IF NOT EXISTS hx_queue_states(session_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,paused INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS hx_queue_items(session_id TEXT NOT NULL,id TEXT NOT NULL,position INTEGER NOT NULL,state TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(session_id,id));
          CREATE TABLE IF NOT EXISTS hx_execution_evidence(session_id TEXT NOT NULL,binding_generation INTEGER NOT NULL,turn_id TEXT NOT NULL,evidence_json TEXT NOT NULL,PRIMARY KEY(session_id,binding_generation,turn_id));`);
        const columns=this.db.query("PRAGMA table_info(hx_turns)").all() as {name:string}[];
        if(!columns.some(column=>column.name==="binding_generation"))this.db.exec("ALTER TABLE hx_turns ADD COLUMN binding_generation INTEGER NOT NULL DEFAULT 1");
        this.db.exec("INSERT OR REPLACE INTO hx_meta(key,value) VALUES('schema_version','2'); PRAGMA user_version=2;");
      })();
    }
    if(version.user_version<3){
      if(version.user_version===2&&file!==":memory:"&&!existsSync(`${file}.pre-v3.bak`))this.db.query("VACUUM INTO ?").run(`${file}.pre-v3.bak`);
      this.db.transaction(()=>this.db.exec(`
        CREATE TABLE IF NOT EXISTS hx_model_catalog_snapshots(identity_key TEXT PRIMARY KEY,runtime_config_id TEXT NOT NULL,provider_id TEXT NOT NULL,schema_version INTEGER NOT NULL,models_json TEXT NOT NULL,content_hash TEXT NOT NULL,engine_fingerprint TEXT NOT NULL,last_success_at INTEGER NOT NULL,fresh_until INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS hx_model_catalog_attempts(identity_key TEXT PRIMARY KEY,last_attempt_at INTEGER NOT NULL,last_error_code TEXT,failure_count INTEGER NOT NULL DEFAULT 0,next_retry_at INTEGER);
        INSERT OR REPLACE INTO hx_meta(key,value) VALUES('schema_version','3'); PRAGMA user_version=3;
      `))();
    }
    if(version.user_version<4){
      if(version.user_version===3&&file!==":memory:"&&!existsSync(`${file}.pre-v4.bak`))this.db.query("VACUUM INTO ?").run(`${file}.pre-v4.bak`);
      this.db.transaction(()=>this.db.exec(`
        CREATE TABLE IF NOT EXISTS hx_projection_snapshots(session_id TEXT PRIMARY KEY,projection_version INTEGER NOT NULL,seq INTEGER NOT NULL,checkpoint_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
        INSERT OR REPLACE INTO hx_meta(key,value) VALUES('schema_version','4'); PRAGMA user_version=4;
      `))();
    }
    const verifier=this.digest({kind:"cowork-hx-key-verifier",version:1});
    const expected=this.db.query("SELECT value FROM hx_meta WHERE key='key_verifier'").get() as {value:string}|null;
    if(expected&&expected.value!==verifier)throw new HostError("HOST_KEY_INVALID");
    if(!expected)this.db.query("INSERT INTO hx_meta(key,value) VALUES('key_verifier',?)").run(verifier);
  }
  digest(value:unknown):string {return createHmac("sha256",this.hmacKey).update(canonical(value)).digest("hex");}
  privateTag(sessionId:string,value:string):string {return this.digest({kind:"private-answer",sessionId,value});}
  answerHints(sessionId:string):readonly PrivateAnswerHint[] {
    let hints=this.privateHints.get(sessionId);
    if(!hints){const row=this.db.query("SELECT value FROM hx_meta WHERE key=?").get(`private:${sessionId}`) as {value:string}|null;hints=row?JSON.parse(row.value) as PrivateAnswerHint[]:[];this.privateHints.set(sessionId,hints);}
    return hints;
  }
  rememberPrivate(sessionId:string,value:string):void {
    if(!value)return;
    const hints=[...this.answerHints(sessionId)],digest=this.privateTag(sessionId,value);
    if(hints.some(h=>h.length===value.length&&this.privateTag(h.scope??sessionId,value)===h.digest))return;
    if(hints.length>=128||hints.reduce((n,h)=>n+h.length,0)+value.length>64*1024)throw new HostError("BACKPRESSURE_EXCEEDED");
    hints.push({length:value.length,first:this.privateTag(sessionId,value[0]!),last:this.privateTag(sessionId,value.at(-1)!),digest,scope:sessionId});
    this.db.query("INSERT INTO hx_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`private:${sessionId}`,JSON.stringify(hints));
    this.privateHints.set(sessionId,hints);
  }
  inheritPrivate(source:string,target:string):void {
    const hints=this.answerHints(source).map(h=>({...h,scope:h.scope??source}));
    if(!hints.length)return;
    this.db.query("INSERT INTO hx_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`private:${target}`,JSON.stringify(hints));this.privateHints.set(target,hints);
  }
  scanPrivate(sessionId:string,text:string,final=true):{text:string;pending:string} {
    const hints=[...this.answerHints(sessionId)].sort((a,b)=>b.length-a.length);
    if(!hints.length)return {text,pending:""};
    const tags=new Map<string,string>();
    const tag=(character:string,scope:string)=>{const key=scope+"\0"+character;let result=tags.get(key);if(!result){result=this.privateTag(scope,character);tags.set(key,result);}return result;};
    const output:string[]=[];
    for(let offset=0;offset<text.length;){
      if(text.startsWith("[redacted]",offset)){output.push("[redacted]");offset+="[redacted]".length;continue;}
      const candidates=hints.filter(h=>h.first===tag(text[offset]!,h.scope??sessionId));
      // Preserve a possible longer marked value across delta frames, including after process restart.
      if(!final&&candidates.some(h=>h.length>text.length-offset))return {text:output.join(""),pending:text.slice(offset)};
      const match=candidates.find(h=>h.length<=text.length-offset&&tag(text[offset+h.length-1]!,h.scope??sessionId)===h.last&&this.privateTag(h.scope??sessionId,text.slice(offset,offset+h.length))===h.digest);
      if(match){output.push("[redacted]");offset+=match.length;}else{output.push(text[offset]!);offset++;}
    }
    return {text:output.join(""),pending:""};
  }
  session(id:string):SessionRecord {
    const row=this.db.query("SELECT record_json,last_host_seq FROM hx_sessions WHERE id=?").get(id) as {record_json:string;last_host_seq:number}|null;
    if(!row)throw new HostError("SESSION_NOT_FOUND");
    const record=JSON.parse(row.record_json) as SessionRecord;
    // Existing records contain the original prompt-derived title.
    if(record.fallbackTitle===undefined&&record.nativeTitle===undefined)record.fallbackTitle=record.title;
    return {...record,latestSeq:row.last_host_seq};
  }
  saveSession(record:SessionRecord):void {
    this.db.query("INSERT INTO hx_sessions(id,project_id,record_json,last_host_seq) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json,project_id=excluded.project_id").run(record.id,record.projectId,JSON.stringify(record),record.latestSeq);
  }
  sessions(projectId?:string):SessionRecord[] {
    const rows=(projectId?this.db.query("SELECT id FROM hx_sessions WHERE project_id=? ORDER BY id").all(projectId):this.db.query("SELECT id FROM hx_sessions ORDER BY id").all()) as {id:string}[];
    return rows.map(row=>this.session(row.id));
  }
  sessionIdPage(projectId:string,archived:boolean,cursor:string|undefined,limit:number):{ids:string[];nextCursor:string|null} {
    const filter="project_id=? AND COALESCE(json_extract(record_json,'$.archived'),0)=?";
    if(cursor&&!this.db.query(`SELECT 1 FROM hx_sessions WHERE ${filter} AND id=?`).get(projectId,+archived,cursor))throw new HostError("CURSOR_INVALID");
    const rows=this.db.query(`SELECT id FROM hx_sessions WHERE ${filter} AND id>? ORDER BY id LIMIT ?`).all(projectId,+archived,cursor??"",limit+1) as {id:string}[];
    const ids=rows.slice(0,limit).map(row=>row.id);
    return {ids,nextCursor:rows.length>limit?ids.at(-1)!:null};
  }
  publicSession(id:string):PublicSession {
    const {inlineSubagents,nativeSubagents,binding,instructions,mcpServers,fallbackTitle,nativeTitle,workspaceBinding,admissionRef,uncertainRuntimeConfigIds,permissionDowngrade,permissionMode,...session}=this.session(id);
    return {...session,pendingInteractions:this.interactions(id).filter(i=>i.state!=="resolved")};
  }
  hasLegacySubagentActivity(id:string):boolean {
    return !!this.db.query('SELECT 1 FROM hx_events WHERE session_id=? AND type IN (?,?) AND json_extract(payload_json,?)=? LIMIT 1').get(id,'item/started','item/completed','$.event.payload.item.nativeType','subAgentActivity');
  }
  interactions(id:string):PublicInteraction[] {return (this.db.query("SELECT record_json FROM hx_interactions WHERE session_id=? ORDER BY id").all(id) as {record_json:string}[]).map(r=>JSON.parse(r.record_json) as PublicInteraction);}
  interaction(id:string,interactionId:string):PublicInteraction {
    const row=this.interactions(id).find(i=>i.interactionId===interactionId);if(!row)throw new HostError("INTERACTION_EXPIRED");return row;
  }
  saveInteraction(id:string,i:PublicInteraction):void {this.db.query("INSERT INTO hx_interactions(session_id,id,revision,state,record_json) VALUES(?,?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET revision=excluded.revision,state=excluded.state,record_json=excluded.record_json").run(id,i.interactionId,i.revision,i.state,JSON.stringify(i));}
  append(id:string,event:HostEvent["event"],source?:{streamId:string;seq:number},scope:{turnId?:string;itemId?:string;bindingGeneration?:number}={},notifyCommit=true):HostEvent|undefined {
    let committed:HostEvent|undefined;
    this.db.transaction(()=>{
      if(scope.bindingGeneration!==undefined&&scope.bindingGeneration!==(this.session(id).bindingGeneration??1))return;
      if(source && this.db.query("SELECT 1 FROM hx_events WHERE session_id=? AND source_stream_id=? AND source_seq=?").get(id,source.streamId,source.seq))return;
      if(source){const last=this.db.query("SELECT MAX(source_seq) AS seq FROM hx_events WHERE session_id=? AND source_stream_id=?").get(id,source.streamId) as {seq:number|null};if(source.seq!==(last.seq??0)+1)throw new HostError("SOURCE_SEQUENCE_GAP");}
      const session=this.session(id),hostSeq=session.latestSeq+1,recordedAt=new Date().toISOString();
      const safe=publicValue(event as unknown as JsonObject) as unknown as HostEvent["event"];
      committed={sessionId:id,hostSeq,recordedAt,bindingGeneration:scope.bindingGeneration??session.bindingGeneration??1,...scope,...(source?{source}:{}),event:safe};
      session.updatedAt=Date.now();
      if(safe.type==="session/state") {
        const state=safe.payload as SessionState;session.status=state.status;session.config=state.config;session.binding=state.binding;session.model=state.model;session.capabilities=state.capabilities;session.capabilityRevision=state.capabilityRevision;session.fastMode=state.fastMode;
        if(state.goal!==undefined)session.goal=state.goal;
        this.applyMetadata(session,state.metadata);
      } else if(safe.type==="session/goal") {
        session.goal=safe.payload;
      } else if(safe.type==="session/metadata") {
        this.applyMetadata(session,safe.payload);
      } else if(safe.type==="turn/started") {
        session.activeTurnId=safe.payload.turnId;session.status="running";
        this.db.query("INSERT INTO hx_turns(session_id,turn_id,native_turn_id,status,execution_state) VALUES(?,?,?,'running','running') ON CONFLICT(session_id,turn_id) DO UPDATE SET native_turn_id=COALESCE(excluded.native_turn_id,hx_turns.native_turn_id)").run(id,safe.payload.turnId,safe.payload.nativeTurnId??null);
      } else if(safe.type==="turn/completed") {
        const old=this.db.query("SELECT terminal_host_seq FROM hx_turns WHERE session_id=? AND turn_id=?").get(id,safe.payload.turnId) as {terminal_host_seq:number|null}|null;
        if(old?.terminal_host_seq!==null && old?.terminal_host_seq!==undefined){committed=undefined;return;}
        const unknown=safe.payload.error?.outcomeUnknown===true;
        this.db.query("INSERT INTO hx_turns(session_id,turn_id,status,execution_state,terminal_host_seq) VALUES(?,?,?,?,?) ON CONFLICT(session_id,turn_id) DO UPDATE SET status=excluded.status,execution_state=excluded.execution_state,terminal_host_seq=excluded.terminal_host_seq").run(id,safe.payload.turnId,safe.payload.status,unknown?"unknown":"stopped",hostSeq);
        session.status=unknown?"recoveryRequired":"ready";delete session.activeTurnId;
      } else if(safe.type==="interaction/requested") {
        this.saveInteraction(id,{interactionId:safe.payload.interactionId,revision:0,state:"pending",request:publicInteraction(safe.payload)});
      } else if(safe.type==="interaction/resolved") {
        const row=this.interactions(id).find(i=>i.interactionId===safe.payload.interactionId);
        if(row)this.saveInteraction(id,{...row,state:"resolved",revision:row.revision+1,resolution:safe.payload});
      }
      const eventTurnId=scope.turnId??("turnId"in safe.payload?String(safe.payload.turnId):undefined);
      if(eventTurnId)this.db.query("UPDATE hx_turns SET binding_generation=? WHERE session_id=? AND turn_id=?").run(scope.bindingGeneration??session.bindingGeneration??1,id,eventTurnId);
      this.hooks.beforeCommit?.();session.latestSeq=hostSeq;this.saveSession(session);
      this.db.query("UPDATE hx_sessions SET last_host_seq=? WHERE id=?").run(hostSeq,id);
      this.db.query("INSERT INTO hx_events(session_id,host_seq,source_stream_id,source_seq,type,turn_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id,hostSeq,source?.streamId??null,source?.seq??null,safe.type,scope.turnId??("turnId"in safe.payload?String(safe.payload.turnId):null),JSON.stringify(committed),recordedAt);
    })();
    if(committed&&notifyCommit)this.hooks.afterCommit?.();return committed;
  }
  private applyMetadata(session:SessionRecord,metadata:SessionState["metadata"]):void {
    if(!metadata||!Object.hasOwn(metadata,"title"))return;
    session.nativeTitle=metadata.title;
    session.title=session.nativeTitle?.trim()||session.fallbackTitle;
  }
  appendSource(event:AhpEvent,bindingGeneration?:number):HostEvent|undefined {const projected=publicEvent(event);return this.append(event.sessionId,{type:projected.type,payload:projected.payload} as HostEvent["event"],{streamId:event.streamId,seq:event.seq},{...(event.turnId?{turnId:event.turnId}:{}),...(event.itemId?{itemId:event.itemId}:{}),...(bindingGeneration?{bindingGeneration}:{})});}
  boundary(sessionId:string,boundary:import("@anureo/protocol").Boundary):import("@anureo/protocol").Boundary {
    const row=this.db.query("SELECT native_turn_id,binding_generation FROM hx_turns WHERE session_id=? AND turn_id=?").get(sessionId,boundary.turnId) as {native_turn_id:string|null;binding_generation:number}|null;
    if(!row)throw new HostError("TURN_NOT_FOUND",`TURN_NOT_FOUND ${boundary.turnId} rows=${JSON.stringify(this.db.query("SELECT turn_id FROM hx_turns WHERE session_id=?").all(sessionId))}`);
    if(row.binding_generation!==(this.session(sessionId).bindingGeneration??1))throw new HostError("BOUNDARY_GENERATION_MISMATCH");
    return {...boundary,...(row.native_turn_id?{nativeTurnId:row.native_turn_id}:{})};
  }
  nativeTurn(sessionId:string,turnId?:string):string|undefined {
    const row=(turnId?this.db.query("SELECT native_turn_id FROM hx_turns WHERE session_id=? AND turn_id=?").get(sessionId,turnId):this.db.query("SELECT native_turn_id FROM hx_turns WHERE session_id=? AND execution_state IN ('running','unknown') ORDER BY rowid DESC LIMIT 1").get(sessionId)) as {native_turn_id:string|null}|null;
    return row?.native_turn_id??undefined;
  }
  executionTurnMap(sessionId: string, bindingGeneration: number): Map<string, string> {
    // Older history reads could create extra rows for the same execution after resume.
    // Restore only unambiguous associations recorded by the live lifecycle.
    const rows = this.db.query(`
      SELECT native_turn_id, MIN(turn_id) AS turn_id FROM hx_turns
      WHERE session_id = ? AND binding_generation = ? AND execution_state <> 'history' AND native_turn_id IS NOT NULL
      GROUP BY native_turn_id HAVING COUNT(*) = 1
    `).all(sessionId, bindingGeneration) as { native_turn_id: string; turn_id: string }[];
    return new Map(rows.map(row => [row.native_turn_id, row.turn_id]));
  }
  indexHistory(sessionId:string,page:HistoryPage):void {
    this.db.transaction(()=>{
      for(const entry of page.items){
        const existing=this.db.query("SELECT native_turn_id FROM hx_turns WHERE session_id=? AND turn_id=?").get(sessionId,entry.turnId) as {native_turn_id:string|null}|null;
        if(existing?.native_turn_id&&entry.nativeTurnId&&existing.native_turn_id!==entry.nativeTurnId)throw new HostError("HISTORY_IDENTITY_MISMATCH");
        this.db.query("INSERT INTO hx_turns(session_id,turn_id,native_turn_id,status,execution_state,binding_generation) VALUES(?,?,?,'history','history',?) ON CONFLICT(session_id,turn_id) DO UPDATE SET native_turn_id=COALESCE(hx_turns.native_turn_id,excluded.native_turn_id)").run(sessionId,entry.turnId,entry.nativeTurnId??null,this.session(sessionId).bindingGeneration??1);
      }
    })();
  }
  events(id:string,afterSeq=0,throughSeq?:number,limit=200):EventPage {
    const latestSeq=this.session(id).latestSeq,end=throughSeq??latestSeq;
    if(!Number.isSafeInteger(afterSeq)||!Number.isSafeInteger(end)||afterSeq<0||afterSeq>end||end>latestSeq||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new HostError("CURSOR_INVALID");
    const events=(this.db.query("SELECT payload_json FROM hx_events WHERE session_id=? AND host_seq>? AND host_seq<=? ORDER BY host_seq LIMIT ?").all(id,afterSeq,end,limit) as {payload_json:string}[]).map(r=>JSON.parse(r.payload_json) as HostEvent);
    const nextAfterSeq=events.at(-1)?.hostSeq??afterSeq;
    return {events,nextAfterSeq,hasMore:nextAfterSeq<end,latestSeq,earliestSeq:1,throughSeq:end};
  }
  projectionSnapshot(id:string):{projectionVersion:number;seq:number;checkpointJson:string}|undefined {
    const row=this.db.query("SELECT projection_version,seq,checkpoint_json FROM hx_projection_snapshots WHERE session_id=?").get(id) as {projection_version:number;seq:number;checkpoint_json:string}|null;
    return row?{projectionVersion:row.projection_version,seq:row.seq,checkpointJson:row.checkpoint_json}:undefined;
  }
  saveProjectionSnapshot(id:string,projectionVersion:number,seq:number,checkpointJson:string):void {
    this.db.query("INSERT INTO hx_projection_snapshots(session_id,projection_version,seq,checkpoint_json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET projection_version=excluded.projection_version,seq=excluded.seq,checkpoint_json=excluded.checkpoint_json,updated_at=excluded.updated_at").run(id,projectionVersion,seq,checkpointJson,Date.now());
  }
  operation(id:string):{row:OperationRow;value:OperationResult}|undefined {
    const row=this.db.query("SELECT * FROM hx_operations WHERE id=?").get(id) as OperationRow|null;
    return row?{row,value:JSON.parse(row.result_json) as OperationResult}:undefined;
  }
  lookup(principal:string,method:string,target:string,key:string):ReturnType<HarnessStore["operation"]> {
    const row=this.db.query("SELECT id FROM hx_operations WHERE principal_id=? AND method=? AND target=? AND idempotency_key=?").get(principal,method,target,key) as {id:string}|null;
    return row?this.operation(row.id):undefined;
  }
  beginOperation(id:string,principal:string,method:string,target:string,key:string,digest:string,sessionId?:string,turnId?:string):OperationResult {
    const value:OperationResult={operationId:id,state:"accepted",outcomeUnknown:false,...(sessionId?{sessionId}:{}),...(turnId?{turnId}:{})};
    this.db.query("INSERT INTO hx_operations(id,principal_id,method,target,idempotency_key,request_digest,phase,state,session_id,turn_id,result_json) VALUES(?,?,?,?,?,?,'accepted','accepted',?,?,?)").run(id,principal,method,target,key,digest,sessionId??null,turnId??null,JSON.stringify(value));return value;
  }
  phase(id:string,phase:string):void {this.db.query("UPDATE hx_operations SET phase=? WHERE id=?").run(phase,id);}
  finishOperation(value:OperationResult):OperationResult {
    const safe=publicValue(value as unknown as JsonObject) as unknown as OperationResult;
    this.db.query("UPDATE hx_operations SET state=?,result_json=?,session_id=COALESCE(?,session_id) WHERE id=?").run(safe.state,JSON.stringify(safe),safe.sessionId??null,safe.operationId);return safe;
  }
  incomplete():{row:OperationRow;value:OperationResult}[] {
    return (this.db.query("SELECT id FROM hx_operations WHERE state='accepted' OR state='unknown'").all() as {id:string}[]).map(({id})=>this.operation(id)!);
  }
  recover():void {
    for(const {row,value} of this.incomplete()) {
      if(value.state==="unknown")continue;
      const unknown=row.phase!=="accepted";
      this.finishOperation({...value,state:unknown?"unknown":"failed",outcomeUnknown:unknown,error:{code:unknown?"RESULT_UNKNOWN":"NOT_DISPATCHED",message:unknown?"RESULT_UNKNOWN":"NOT_DISPATCHED",retryable:false,outcomeUnknown:unknown}});
      if(unknown && row.session_id && this.db.query("SELECT id FROM hx_sessions WHERE id=?").get(row.session_id)){const s=this.session(row.session_id);s.status="recoveryRequired";this.saveSession(s);}
    }
    for(const s of this.sessions()){
      const queue=this.queue(s.id);if(queue.items.some(item=>["dispatching","running"].includes(item.state)))this.mutateQueue(s.id,undefined,state=>{for(const item of state.items)if(["dispatching","running"].includes(item.state)){item.state="unknown";item.updatedAt=Date.now();item.error={code:"RESULT_UNKNOWN",message:"RESULT_UNKNOWN",retryable:false,outcomeUnknown:true};}state.paused=true;});
      const wasRunning=s.status==="running"||!!s.activeTurnId;
      if(wasRunning){s.status="recoveryRequired";this.saveSession(s);this.append(s.id,{type:"host/turnObservationEnded",payload:{turnId:s.activeTurnId??null,nativeExecutionUnknown:true}});}
      const pending=this.interactions(s.id).filter(i=>i.state!=="resolved");
      if(pending.length){const current=this.session(s.id);current.status="recoveryRequired";this.saveSession(current);}
      else if(!wasRunning&&s.status!=="recoveryRequired"){s.status="closed";this.saveSession(s);}
      for(const i of pending)this.append(s.id,{type:"interaction/resolved",payload:{interactionId:i.interactionId,outcome:"unknown",reason:"HOST_RESTARTED"}});
    }
  }
  reconcileStopped(observed:SessionRecord,live:boolean,evidenceRef?:string):HostEvent[] {
    const committed=this.db.transaction(()=>{
      const id=observed.id;
      const current=this.session(id);
      const generation=current.bindingGeneration??1;
      if(generation!==(observed.bindingGeneration??1)||current.activeTurnId!==observed.activeTurnId||current.uncertainRuntimeConfigIds?.length)return [];
      const turnId=current.activeTurnId;
      const affected=this.queue(id).items.filter(item=>item.bindingGeneration===generation&&(item.state==="unknown"||item.turnId===turnId&&["dispatching","running"].includes(item.state)));
      if(current.status!=="recoveryRequired"&&!affected.length)return [];
      if(current.status!==observed.status)return [];
      current.status=live?"ready":"closed";
      delete current.activeTurnId;
      this.saveSession(current);
      const events:HostEvent[]=[];
      const recovery=this.append(id,{type:"host/recovery",payload:{stopped:true,turnId:turnId??null,evidenceRef:evidenceRef??null}},undefined,{bindingGeneration:generation,...(turnId?{turnId}:{})},false);
      if(recovery)events.push(recovery);
      if(turnId&&recovery)this.db.query("UPDATE hx_turns SET status='interrupted',execution_state='stopped',terminal_host_seq=? WHERE session_id=? AND turn_id=? AND binding_generation=? AND terminal_host_seq IS NULL").run(recovery.hostSeq,id,turnId,generation);
      if(affected.length){
        const ids=new Set(affected.map(item=>item.id));
        const queue=this.mutateQueue(id,undefined,state=>{
          state.paused=true;
          for(const item of state.items){
            if(!ids.has(item.id))continue;
            item.state="failed";
            item.updatedAt=Date.now();
            item.error={code:"RESULT_UNKNOWN_STOPPED",message:"Execution is stopped; its original result remains unknown",retryable:false,outcomeUnknown:true};
          }
        });
        const queueEvent=this.append(id,{type:"host/queue",payload:{queue:publicQueue(queue) as unknown as JsonObject}},undefined,{},false);
        if(queueEvent)events.push(queueEvent);
      }
      return events;
    })();
    for(const _event of committed)this.hooks.afterCommit?.();
    return committed;
  }
  queue(id:string):StoredQueueState {
    this.session(id);
    const state=this.db.query("SELECT revision,paused FROM hx_queue_states WHERE session_id=?").get(id) as {revision:number;paused:number}|null;
    const rows=this.db.query("SELECT record_json FROM hx_queue_items WHERE session_id=? AND state NOT IN ('completed','cancelled') ORDER BY position,id").all(id) as {record_json:string}[];
    return {revision:state?.revision??0,paused:state?.paused===1,items:rows.map(row=>JSON.parse(row.record_json) as StoredQueueItem)};
  }
  mutateQueue(id:string,expectedRevision:number|undefined,update:(state:StoredQueueState)=>void):StoredQueueState {
    let changed!:StoredQueueState;
    this.db.transaction(()=>{
      const state=this.queue(id);if(expectedRevision!==undefined&&state.revision!==expectedRevision)throw new HostError("QUEUE_REVISION_CONFLICT");
      const previous=state.items.map(item=>item.id);update(state);state.revision++;
      this.db.query("INSERT INTO hx_queue_states(session_id,revision,paused) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision,paused=excluded.paused").run(id,state.revision,state.paused?1:0);
      for(const old of previous)if(!state.items.some(item=>item.id===old)){
        const row=this.db.query("SELECT record_json FROM hx_queue_items WHERE session_id=? AND id=?").get(id,old) as {record_json:string};const item=JSON.parse(row.record_json) as StoredQueueItem;item.state="cancelled";item.updatedAt=Date.now();
        this.db.query("UPDATE hx_queue_items SET state='cancelled',record_json=? WHERE session_id=? AND id=?").run(JSON.stringify(item),id,old);
      }
      state.items.forEach((item,index)=>this.db.query("INSERT INTO hx_queue_items(session_id,id,position,state,record_json) VALUES(?,?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET position=excluded.position,state=excluded.state,record_json=excluded.record_json").run(id,item.id,index,item.state,JSON.stringify(item)));
      changed={...state,items:state.items.filter(queuePending)};
    })();return changed;
  }
  queueItem(id:string,itemId:string):StoredQueueItem {
    const row=this.db.query("SELECT record_json FROM hx_queue_items WHERE session_id=? AND id=?").get(id,itemId) as {record_json:string}|null;
    if(!row)throw new HostError("QUEUE_ITEM_NOT_FOUND");return JSON.parse(row.record_json) as StoredQueueItem;
  }
  /** 会话是否已开始：已执行过 turn（hx_turns，含 native 历史 index）或携带继承的 turn 输入事件（fork）。>0 即 Harness 锁定。 */
  executedTurns(id:string):boolean {
    if(this.session(id)?.parent)return true;
    if((this.db.query("SELECT COUNT(*) AS count FROM hx_turns WHERE session_id=?").get(id) as {count:number}).count>0)return true;
    return ((this.db.query("SELECT COUNT(*) AS count FROM hx_events WHERE session_id=? AND type='host/turnInput'").get(id) as {count:number}).count>0);
  }
  clearEvidence(id:string,generation:number,key:string):void {this.db.query("DELETE FROM hx_execution_evidence WHERE session_id=? AND binding_generation=? AND turn_id=?").run(id,generation,key);}
  recordEvidence(id:string,generation:number,turnId:string,evidence:JsonObject):void {
    this.db.query("INSERT INTO hx_execution_evidence(session_id,binding_generation,turn_id,evidence_json) VALUES(?,?,?,?) ON CONFLICT(session_id,binding_generation,turn_id) DO UPDATE SET evidence_json=excluded.evidence_json").run(id,generation,turnId,JSON.stringify(evidence));
  }
  evidence(id:string,generation:number,turnId:string):JsonObject|undefined {
    const row=this.db.query("SELECT evidence_json FROM hx_execution_evidence WHERE session_id=? AND binding_generation=? AND turn_id=?").get(id,generation,turnId) as {evidence_json:string}|null;return row?JSON.parse(row.evidence_json) as JsonObject:undefined;
  }
  operationStopped(id:string,operationId:string):boolean {
    const rows=this.db.query("SELECT evidence_json FROM hx_execution_evidence WHERE session_id=? AND turn_id=?").all(id,`operation:${operationId}`) as {evidence_json:string}[];
    return rows.some(row=>(JSON.parse(row.evidence_json) as JsonObject).quiescent===true);
  }
  usage(id:string):Usage|null {
    const rows=this.db.query("SELECT payload_json FROM hx_events WHERE session_id=? AND type IN ('turn/completed','usage/updated') ORDER BY host_seq").all(id) as {payload_json:string}[];
    const groups=new Map<number,{turns:Map<string,Usage>;cumulative?:Usage;cumulativeTurnId?:string;missing:Set<string>}>();
    for(const row of rows){const event=JSON.parse(row.payload_json) as HostEvent,value=event.event.type==="turn/completed"?event.event.payload.usage:event.event.type==="usage/updated"?event.event.payload:undefined;
      const generation=event.bindingGeneration??1,group=groups.get(generation)??{turns:new Map<string,Usage>(),missing:new Set<string>()};groups.set(generation,group);
      const turnId=event.turnId??(event.event.type==="turn/completed"?event.event.payload.turnId:undefined);
      if(value?.scope==="session"){group.cumulative=value;group.cumulativeTurnId=turnId;group.missing.clear();}else if(value&&turnId){group.turns.set(turnId,value);group.missing.delete(turnId);}else if(event.event.type==="turn/completed"&&turnId&&!group.turns.has(turnId)&&group.cumulativeTurnId!==turnId)group.missing.add(turnId);
    }
    const sum=(values:Usage[],key:keyof Usage)=>values.every(value=>typeof value[key]==="number")?values.reduce((n,value)=>n+(value[key] as number),0):undefined;
    const aggregate=(values:Usage[]):Usage=>({provider:new Set(values.map(value=>value.provider)).size===1?values[0]!.provider:"mixed",scope:"session",source:"native",...Object.fromEntries((["input","output","total","cacheRead","cacheWrite"] as const).flatMap(key=>{const value=sum(values,key);return value===undefined?[]:[[key,value]];}))});
    if([...groups.values()].some(group=>group.missing.size))return null;
    const values=[...groups.values()].flatMap(group=>group.cumulative?[group.cumulative]:group.turns.size?[aggregate([...group.turns.values()])]:[]);
    return values.length?aggregate(values):null;
  }
  checksum():string {return createHash("sha256").update(JSON.stringify(this.sessions())).digest("hex");}
  close():void {
    if(this.closed)return;
    this.closed=true;
    try { this.db.close(); } finally { this.ownership?.close(); }
  }
}

export type HostStorage=Omit<SqliteHostStore,"db"|"file"|"catalog">&{readonly catalog:CatalogStorage};
export type HarnessStore=HostStorage;
