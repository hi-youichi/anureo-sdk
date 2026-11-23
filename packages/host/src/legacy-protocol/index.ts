import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import ahpSchema from "@anureo/protocol/schema";
import schema from "../../schema/v1/hx.schema.json";
import { HX_DEFINITIONS, type HxMethod, type HxRequestMap, type HxResultMap } from "./generated/types";
export * from "./generated/types";
export { schema as hxSchema };

// 浏览器首屏不应在模块加载时就编译 JSON Schema 2020 元 schema（约 80ms 主线程）：
// 延迟到第一次校验时再创建 Ajv；两份 schema 均为构建期生成并由测试覆盖，因此跳过运行时的 schema 自校验。
let ajvInstance:Ajv2020|undefined;
function getAjv():Ajv2020 {
  if(!ajvInstance){
    ajvInstance=new Ajv2020({strict:false,allErrors:true,validateSchema:false});
    ajvInstance.addSchema(ahpSchema);ajvInstance.addSchema(schema);
  }
  return ajvInstance;
}
const cache=new Map<string,ValidateFunction>();
export class HxContractError extends Error {
  readonly code="INVALID_PARAMS";
  constructor(readonly method:string){super(`Invalid hx contract: ${method}`);}
}
function check(name:string,value:unknown):void {
  let validate=cache.get(name);
  if(!validate){validate=getAjv().compile({$ref:`${schema.$id}#/$defs/${name}`});cache.set(name,validate);}
  if(!validate(value))throw new HxContractError(name);
}
export function isHxMethod(value:string):value is HxMethod{return Object.hasOwn(HX_DEFINITIONS,value);}
export function validateHxRequest<M extends HxMethod>(method:M,value:unknown):asserts value is HxRequestMap[M] {check(HX_DEFINITIONS[method][0],value);}
export function validateHxResult<M extends HxMethod>(method:M,value:unknown):asserts value is HxResultMap[M] {check(HX_DEFINITIONS[method][1],value);}
export function validateHostEvent(value:unknown):void {check("HostEvent",value);}
export function validateSubscriptionError(value:unknown):void {check("SubscriptionError",value);}
export function validateSessionListSummaryPage(value:unknown):void {check("HostSessionListSummaryPage",value);}

export function validateHarnessChanged(value:unknown):void {check("HxHarnessChangedParams",value);}

export function validateCatalogChanged(value:unknown):void {check("HxCatalogChangedParams",value);}
