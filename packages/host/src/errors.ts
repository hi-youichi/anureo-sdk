import { publicValue,type HarnessError,type JsonObject } from "@anureo/protocol";
export class HostError extends Error implements HarnessError {
  constructor(readonly code:string, message=code, readonly retryable=false, readonly outcomeUnknown=false,readonly details?:JsonObject){super(message);}
}
export function hostError(cause:unknown,defaultCode="HOST_ERROR"):HarnessError {
  if(cause instanceof HostError)return {code:cause.code,message:cause.message,retryable:cause.retryable,outcomeUnknown:cause.outcomeUnknown,...(cause.details?{details:cause.details}:{})};
  if(cause && typeof cause==="object" && "code" in cause && typeof cause.code==="string") {
    let details:JsonObject|undefined;
    if("details"in cause&&cause.details&&typeof cause.details==="object"&&!Array.isArray(cause.details))try{details=publicValue(JSON.parse(JSON.stringify(cause.details))) as JsonObject;}catch{}
    return {code:cause.code,message:cause.code,retryable:"retryable" in cause && cause.retryable===true,outcomeUnknown:"outcomeUnknown" in cause && cause.outcomeUnknown===true,...(details?{details}:{})};
  }
  return {code:defaultCode,message:defaultCode,retryable:false,outcomeUnknown:false};
}
export function rpcError(cause:unknown):{code:number;message:string;data:HarnessError} {
  const error=hostError(cause);
  const code=error.code==="AUTH_REQUIRED"?4010:error.code==="PROJECT_FORBIDDEN"?4013:error.code==="METHOD_NOT_FOUND"||error.code==="HX_DISABLED"?-32601:error.code==="INVALID_PARAMS"?-32602:-32070;
  return {code,message:error.message,data:error};
}
/** History pages that exceed a transport frame limit are a stable, user-visible failure; keep every other error untouched. */
export function historyReadError(cause:unknown):unknown {
  const code=cause && typeof cause==="object" && "code" in cause ? cause.code : undefined;
  if(code==="FRAME_TOO_LARGE"||code==="HISTORY_TOO_LARGE")return new HostError("HISTORY_TOO_LARGE","Session history is too large to load",false,false);
  return cause;
}
