import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveNpmCommand } from './npm-runner'
import { distributableDependencies } from './dependencies'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const leaves = ['protocol','core','conformance','codex','claude','acp','ahp'] as const
const args = process.argv.slice(2)
function option(name: string): string | undefined { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const selected = (option('--only')?.split(',') ?? [...leaves])
if (!selected.length || selected.some(name => !leaves.includes(name as typeof leaves[number]))) throw new Error('--only must contain comma-separated SDK leaf names')
const verify = args.includes('--verify')
const npmCommand = resolveNpmCommand()
const output = path.resolve(option('--out') ?? await mkdtemp(path.join(tmpdir(), 'anureo-harness-pack-')))
await mkdir(output, { recursive: true })
const work = await mkdtemp(path.join(tmpdir(), 'anureo-harness-stage-'))
type Manifest = { name: string; version: string; exports: Record<string, string>; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; engines?: Record<string, string> }
const manifests = new Map<string, Manifest>()
for (const leaf of leaves) manifests.set(leaf, JSON.parse(await readFile(path.join(repository, 'packages', leaf, 'package.json'), 'utf8')) as Manifest)
const internalVersions = new Map([...manifests.values()].map(manifest => [manifest.name, manifest.version]))
const configPath = (value: string): string => value.split(path.sep).join('/')
const run = async (command: string, argv: string[], cwd: string): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn(command, argv, { cwd, env: process.env, shell: false, stdio: ['ignore','pipe','pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) }); child.stderr.on('data', chunk => { stderr += String(chunk) })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolve(stdout) : reject(new Error(`${command} ${argv[0] ?? ''} failed (${code})\n${stdout}\n${stderr}`)))
})
const safeDependencyField = (field?: Record<string,string>) => distributableDependencies(field, internalVersions)
async function walk(directory: string): Promise<string[]> {
  const output: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) { const name = path.join(directory, entry.name); if (entry.isDirectory()) output.push(...await walk(name)); else output.push(name) }
  return output
}
const packages: Array<{ leaf: string; name: string; tarball: string; files: number }> = []
try {
  for (const leaf of selected) {
    const manifest = manifests.get(leaf)!; const packageRoot = path.join(repository, 'packages', leaf)
    const stage = path.join(work, leaf); await mkdir(path.join(stage, 'dist'), { recursive: true })
    const exports: Record<string, unknown> = {}
    for (const [key, source] of Object.entries(manifest.exports)) {
      if (source.endsWith('.json')) { await cp(path.join(packageRoot, source), path.join(stage, source), { recursive: true }); exports[key] = source; continue }
      if (!/\.tsx?$/.test(source)) throw new Error(`Unsupported public entry ${leaf}:${key}`)
      const relative = path.relative(path.join(packageRoot, 'src'), path.join(packageRoot, source)).replace(/\.tsx?$/, '.js').split(path.sep).join('/')
      if (relative.startsWith('../')) throw new Error(`Entry escapes source root: ${leaf}:${key}`)
      const result = await Bun.build({ entrypoints: [path.join(packageRoot, source)], target: 'node', format: 'esm', packages: 'external', root: path.join(packageRoot, 'src'), outdir: path.join(stage, 'dist') })
      if (!result.success) throw new Error(`Build failed for ${leaf}:${key}\n${result.logs.map(log => log.message).join('\n')}`)
      exports[key] = { types: `./dist/${relative.replace(/\.js$/, '.d.ts')}`, import: `./dist/${relative}`, default: `./dist/${relative}` }
    }
    const declarationConfig = path.join(work, `${leaf}.tsconfig.json`)
    await writeFile(declarationConfig, JSON.stringify({ extends: configPath(path.join(packageRoot,'tsconfig.json')), compilerOptions: { typeRoots: [configPath(path.join(repository,'node_modules/@types'))], rootDir: configPath(path.join(packageRoot,'src')), outDir: configPath(path.join(stage,'dist')), noEmit: false, declaration: true, emitDeclarationOnly: true }, include: [configPath(path.join(packageRoot,'src/**/*.ts'))], exclude: [configPath(path.join(packageRoot,'src/**/*.test.ts')),configPath(path.join(packageRoot,'src/**/*.spec.ts'))] }))
    await run(npmCommand.executable, [path.join(repository, 'node_modules/typescript/bin/tsc'), '-p',declarationConfig], repository)
    for (const asset of ['schema','protocol']) {
      try { await stat(path.join(packageRoot, asset)); await cp(path.join(packageRoot, asset), path.join(stage, asset), { recursive: true }) } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
    }
    for (const filename of await walk(path.join(stage,'dist'))) {
      if (/\.(test|spec)\.d\.ts$/.test(filename)) { await rm(filename); continue }
      if (filename.endsWith('.d.ts')) {
        let text = await readFile(filename,'utf8')
        text = text.replace(/((?:from\s*|import\s*\()\s*["'])(\.[^"']+)(["'])/g, (_match, start: string, target: string, quote: string) => `${start}${/\.(?:js|mjs|cjs|json)$/.test(target) ? target : `${target}.js`}${quote}`)
        await writeFile(filename,text)
      }
    }
    if (leaf === 'ahp') {
      const reference = await Bun.build({ entrypoints: [path.join(packageRoot,'examples/reference.ts')], target:'node',format:'esm',packages:'external',outdir:path.join(stage,'examples'),naming:'reference.mjs' })
      if(!reference.success)throw new Error('AHP reference build failed')
    }
    if (leaf === 'conformance') {
      await mkdir(path.join(stage,'examples'),{recursive:true})
      await cp(path.join(repository,'scripts/harness-sdk/independent-examples/smoke.mjs'),path.join(stage,'examples/standalone.mjs'))
    }
    const packed = { name: manifest.name, version: manifest.version, private: true, type: 'module', description: 'Anureo independent Harness SDK internal preview', exports, files: ['dist','schema','protocol','examples','README.md'],
      dependencies: safeDependencyField(manifest.dependencies), peerDependencies: safeDependencyField(manifest.peerDependencies), optionalDependencies: safeDependencyField(manifest.optionalDependencies), engines: manifest.engines ?? { node: '>=22' } }
    const manifestText = JSON.stringify(packed,null,2)+'\n'
    if (/workspace:|file:\/\/|\/Users\/|[A-Z]:\\\\/.test(manifestText)) throw new Error(`Distributable manifest leaks local/workspace references: ${leaf}`)
    await writeFile(path.join(stage,'package.json'),manifestText)
    await writeFile(path.join(stage,'README.md'),'# '+manifest.name+'\n\nInternal preview. See AHP v1 and the independent conformance examples. This tarball is not a public npm release.\n')
    for (const filename of await walk(stage)) {
      const text = await readFile(filename,'utf8')
      if (text.includes(repository)) throw new Error(`Local source path leaked into ${leaf}/${path.relative(stage, filename)}`)
      for (const match of text.matchAll(/[\"'](@(?:anureo|cowork)\/[a-z0-9-]+)(?:\/[^\"']*)?[\"']/g)) if (!internalVersions.has(match[1]!)) throw new Error(`Unexpected workspace reference leaked into ${leaf}: ${match[1]}`)
    }
    const packedResult = JSON.parse(await run(npmCommand.executable,[...npmCommand.args,'pack','--ignore-scripts','--json','--pack-destination',output],stage)) as Array<{ filename: string; files: unknown[] }>
    packages.push({ leaf,name:manifest.name,tarball:path.join(output,packedResult[0]!.filename),files:packedResult[0]!.files.length })
  }
  const verification: Array<{ runtime: string; result: unknown }> = []
  if (verify) {
    for (const required of ['protocol','core','conformance']) if (!selected.includes(required)) throw new Error(`--verify requires ${required} among packed leaves`)
    const clean = path.join(work,'clean'); await mkdir(clean)
    await writeFile(path.join(clean,'package.json'), JSON.stringify({ name:'harness-independent-verification',private:true,type:'module' }))
    await run(npmCommand.executable,[...npmCommand.args,'install','--ignore-scripts','--no-audit','--no-fund',...packages.map(pkg => pkg.tarball),'typescript@5.8.3','@types/node@22.15.3'],clean)
    if(selected.includes('acp')) {
      const officialSdk = JSON.parse(await readFile(path.join(clean,'node_modules/@agentclientprotocol/sdk/package.json'),'utf8')) as {version:string}
      const implementation = await readFile(path.join(clean,'node_modules/@agentclientprotocol/sdk/dist/acp.js'),'utf8')
      if(officialSdk.version!=='1.4.0'||implementation.includes('observeSession('))throw new Error('Clean ACP verification must use the official unpatched 1.4.0 SDK')
      verification.push({runtime:'official-acp-sdk',result:{status:'passed',version:officialSdk.version,legacyObserveSessionPatch:false,install:'clean npm, no root patchedDependencies'}})
    }
    await cp(path.join(repository,'scripts/harness-sdk/independent-examples/smoke.mjs'),path.join(clean,'smoke.mjs'))
    await cp(path.join(repository,'scripts/harness-sdk/independent-examples/acp-agent.mjs'),path.join(clean,'acp-agent.mjs'))
    if(selected.includes('ahp')) await cp(path.join(clean,'node_modules/@anureo/adapter-ahp/examples/reference.mjs'),path.join(clean,'ahp-reference.mjs'))
    const adapterTypes = selected.filter(leaf=>['codex','claude','acp','ahp'].includes(leaf)).map(leaf=>`import {create${leaf[0]!.toUpperCase()+leaf.slice(1)}Adapter} from '@anureo/adapter-${leaf}'; void create${leaf[0]!.toUpperCase()+leaf.slice(1)}Adapter;`).join('\n')
    await writeFile(path.join(clean,'typecheck.ts'),adapterTypes+'\n'+`import {type TurnStartParams,validateRequest} from '@anureo/protocol';
import {createHarnessRuntime} from '@anureo/sdk';
import {createScriptedAdapter} from '@anureo/conformance';
const good:TurnStartParams={requestId:'r',sessionId:'s',turnId:'t',input:[{type:'text',text:'x'}]};
// @ts-expect-error invalid input discriminant must remain rejected after packing
const bad:TurnStartParams={requestId:'r',sessionId:'s',turnId:'t',input:[{type:'invalid'}]};
const runtime=createHarnessRuntime(createScriptedAdapter());
validateRequest('turn/start',good);void runtime;void bad;
`)
    await writeFile(path.join(clean,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,noEmit:true,skipLibCheck:false,resolveJsonModule:true,types:['node']},files:['typecheck.ts']}))
    await run('node',['node_modules/typescript/bin/tsc','--pretty','false'],clean)
    verification.push({runtime:'typescript',result:{status:'passed',strict:true,skipLibCheck:false,moduleResolution:'NodeNext'}})
    const adapterNames=selected.filter(leaf=>['codex','claude','acp','ahp'].includes(leaf))
    for (const runtime of ['node','bun']) verification.push({runtime,result:JSON.parse((await run(runtime,['smoke.mjs',...adapterNames],clean)).trim())})
    for (const pkg of packages) {
      const installed = JSON.parse(await readFile(path.join(clean,'node_modules',...pkg.name.split('/'),'package.json'),'utf8'))
      if (JSON.stringify(installed).includes('workspace:')) throw new Error(`Installed manifest retains workspace dependency ${pkg.name}`)
    }
  }
  const result = { output, packages, verification }
  await writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify(result,null,2))
} finally { await rm(work,{recursive:true,force:true}) }
