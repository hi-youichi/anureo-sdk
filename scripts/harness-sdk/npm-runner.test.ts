import { expect,test } from 'bun:test'
import { mkdtemp,mkdir,writeFile,rm,realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveNpmCommand } from './npm-runner'

test('local trusted npm JS entry runs through Node without a shell',()=>{
  const command=resolveNpmCommand();expect(path.basename(command.args[0])).toBe('npm-cli.js')
  const result=spawnSync(command.executable,[...command.args,'--version'],{shell:false,encoding:'utf8'})
  expect(result.status).toBe(0);expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
})
test('Windows npm.cmd is never executed and literal argv with spaces is preserved',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'npm runner with spaces '))
  try {
    const directory=path.join(root,'node install'),cli=path.join(directory,'node_modules/npm/bin/npm-cli.js');await mkdir(path.dirname(cli),{recursive:true})
    await writeFile(path.join(directory,'npm.cmd'),'@echo This shim must never execute\r\n')
    await writeFile(cli,"console.log(JSON.stringify(process.argv.slice(2)))\n")
    const actual=resolveNpmCommand();const resolved=resolveNpmCommand({platform:'win32',environment:{},searchDirectories:[directory],nodeExecutable:actual.executable})
    expect(await realpath(resolved.args[0])).toBe(await realpath(cli))
    const result=spawnSync(resolved.executable,[...resolved.args,'pack','a b','$(never-execute)'],{shell:false,encoding:'utf8'})
    expect(result.status).toBe(0);expect(JSON.parse(result.stdout)).toEqual(['pack','a b','$(never-execute)'])
  } finally {await rm(root,{recursive:true,force:true})}
})
