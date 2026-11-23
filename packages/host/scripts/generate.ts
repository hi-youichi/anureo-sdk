import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
type Schema=boolean|{[key:string]:unknown};
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const document=JSON.parse(await readFile(path.join(root,"schema/v1/hx.schema.json"),"utf8")) as {$defs:Record<string,Schema>;"x-methods":Record<string,[string,string]>};
function emit(v:Schema):string {
  if(v===true)return "unknown";if(v===false)return "never";
  if(typeof v.$ref==="string") {
    const name=v.$ref.split("/$defs/").at(-1)!;
    if(v.$ref.startsWith("#/")){if(!document.$defs[name])throw new Error(`Unknown definition ${name}`);return name;}
    if(v.$ref.startsWith("urn:anureo:ahp:v1#/$defs/"))return `Ahp.${name}`;
    throw new Error(`Unsupported reference ${v.$ref}`);
  }
  if("const"in v)return JSON.stringify(v.const);
  if(Array.isArray(v.enum))return v.enum.map(x=>JSON.stringify(x)).join(" | ");
  for(const [key,join] of [["anyOf"," | "],["oneOf"," | "],["allOf"," & "]])if(Array.isArray(v[key]))return (v[key] as Schema[]).map(x=>`(${emit(x)})`).join(join);
  if(v.type==="string")return "string";if(v.type==="integer"||v.type==="number")return "number";if(v.type==="boolean")return "boolean";if(v.type==="null")return "null";
  if(v.type==="array")return `Array<${emit(v.items as Schema)}>`;
  if(v.type==="object") {
    const required=new Set((v.required??[]) as string[]);
    return `{ ${Object.entries((v.properties??{}) as Record<string,Schema>).map(([k,s])=>`${JSON.stringify(k)}${required.has(k)?"":"?"}: ${emit(s)}`).join("; ")} }`;
  }
  throw new Error(`Unsupported schema: ${JSON.stringify(v)}`);
}
const methods=Object.entries(document["x-methods"]);
const out=["// Generated from schema/v1/hx.schema.json; do not edit.","import type * as Ahp from '@anureo/protocol';",...Object.entries(document.$defs).map(([k,v])=>`export type ${k} = ${emit(v)};`),"export interface HxRequestMap {",...methods.map(([m,[p]])=>`${JSON.stringify(m)}: ${p};`),"}","export interface HxResultMap {",...methods.map(([m,[,r]])=>`${JSON.stringify(m)}: ${r};`),"}","export type HxMethod = keyof HxRequestMap;",`export const HX_METHODS = ${JSON.stringify(methods.map(([m])=>m))} as const;`,`export const HX_DEFINITIONS = ${JSON.stringify(document["x-methods"])} as const;`].join("\n")+"\n";
const target=path.join(root,"src/legacy-protocol/generated/types.ts");
if(process.argv.includes("--check")){if(await readFile(target,"utf8")!==out)throw new Error("Generated hx types differ");}else await writeFile(target,out);
