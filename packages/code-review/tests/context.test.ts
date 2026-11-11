import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseReport } from '../src/fix'
import { discoverPackages } from '../src/io'
import { hash, ReviewContext, SnapshotIntegrityError, mergePromptSources } from '../src/context'
import { createDesignPlan } from '../src/review'
import { readDesignConfig } from '../src/project'
import type { LanguageAdapter } from '../src/language'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture(files: Record<string, string> = { 'a.ts': 'export const a = 1\n', 'b.ts': 'export const b = 2\n' }) {
  const cwd = await mkdtemp(join(tmpdir(), 'anureo-design-'))
  directories.push(cwd)
  execFileSync('git', ['init', '--quiet'], { cwd })
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), text)
  }
  return cwd
}

test('indexes consumers, static call targets and state owners without inventing injected implementations', async () => {
  const cwd = await fixture({ 'a.ts': 'export function a() { return 1 }\n', 'b.ts': "import { a } from './a.js'\nexport function b(port: { run(): void }) { a(); port.run() }\n" })
  const context = await ReviewContext.create(cwd, await discoverPackages(cwd))
  const b = context.index.find(i => i.path === 'b.ts')!
  expect(b.imports[0]!.target).toBe('a.ts')
  expect(b.calls.find(c => c.expression === 'a')!.target?.path).toBe('a.ts')
  expect(b.calls.find(c => c.expression === 'port.run')!.target).toBeNull()
  expect(b.unknowns.length).toBeGreaterThan(0)
})

test('polyglot ownership and raw-source review do not require Node manifests or a known language', async () => {
  const cwd = await fixture({ 'README.md': '异构项目', 'service/pyproject.toml': '[project]\nname="service"',
    'service/main.py': 'def total(items):\n    return sum(items)\n', 'store/Cargo.toml': '[package]\nname="store"',
    'store/src/lib.rs': 'pub fn total(n: u64) -> u64 { n }', 'db/query.sql': 'SELECT id FROM orders;',
    'workers/go.mod': 'module example/workers', 'workers/main.go': 'package main\nfunc run() {}',
    'rules/Flow': 'ON approved => charge; EMIT receipt' })
  const packages = await discoverPackages(cwd, [{ path: 'db', name: 'queries' }, { path: 'rules', name: 'policies' }])
  expect(packages.find(p => p.path === 'service')!.files).toContain('service/main.py')
  expect(packages.find(p => p.path === 'store')!.files).toContain('store/src/lib.rs')
  expect(packages.find(p => p.path === 'workers')!.files).toContain('workers/main.go')
  expect(packages.find(p => p.name === 'queries')!.files).toEqual(['db/query.sql'])
  const context = await ReviewContext.create(cwd, packages)
  expect(context.index.find(i => i.path === 'service/main.py')!.language).toBe('python')
  expect(context.index.find(i => i.path === 'rules/Flow')!.adapter).toBe('text-v1')
  expect(context.index.find(i => i.path === 'rules/Flow')!.unknowns.join()).toContain('unindexed')
  const matched = await context.resolveRequestsDetailed([{ path: null, symbol: 'total', query: null, reason: '找定义和消费者' }], 10)
  expect(matched.snapshots.map(s => s.path)).toEqual(['service/main.py', 'store/src/lib.rs'])
  expect(matched.resolution.searches[0]!.definitionPaths).toEqual([])
  const source = context.baseline.get('rules/Flow')!
  context.validateEvidence([{ path: source.path, snapshotId: source.id, sha256: source.sha256!, symbol: '',
    startLine: 1, endLine: 1, quote: 'EMIT receipt', role: '转换规则' }], new Set([source.id]))
  expect(() => context.validateEvidence([{ path: source.path, snapshotId: source.id, sha256: source.sha256!, symbol: 'approved',
    startLine: 1, endLine: 1, quote: 'EMIT receipt', role: '规则' }], new Set([source.id]))).toThrow('unindexed')
})

test('syntax adapters can supply other languages without modifying the design engine', async () => {
  const cwd = await fixture({ 'a.custom': 'step calculate = 1' })
  const adapter: LanguageAdapter = { id: 'custom-test-v1', supports: s => s.path.endsWith('.custom'), index: sources => sources.map(s => ({
    path: s.path, language: 'custom', adapter: 'custom-test-v1', capabilities: ['symbols'],
    symbols: [{ name: 'calculate', startLine: 1, endLine: 1, column: 1, kind: 'step' }], imports: [], exports: [], calls: [], unknowns: ['Runtime dispatch is unknown'],
  })) }
  const context = await ReviewContext.create(cwd, await discoverPackages(cwd), [adapter])
  expect(context.index[0]!.symbols[0]!.name).toBe('calculate')
  const snapshot = context.baseline.get('a.custom')!
  context.validateEvidence([{ path: snapshot.path, snapshotId: snapshot.id, sha256: snapshot.sha256!, symbol: 'calculate',
    startLine: 1, endLine: 1, quote: 'step calculate', role: 'step' }], new Set([snapshot.id]))
  await expect(ReviewContext.create(cwd, await discoverPackages(cwd), [{ ...adapter, index: () => [] }])).rejects.toThrow('adapter coverage')
})

test('configured groups and flows are validated before any model call', async () => {
  const cwd = await fixture({ 'a.py': 'pass' })
  const path = join(cwd, 'config.json')
  await writeFile(path, JSON.stringify({ version: 1, groups: [{ path: '.', name: 'root' }], flows: [{ id: 'work', purpose: '计算', paths: ['a.py'], symbols: [] }] }))
  const config = await readDesignConfig(path)
  expect(config.groups[0]!.name).toBe('root')
  await writeFile(path, JSON.stringify({ version: 1, groups: [{ path: '../outside', name: 'x' }] }))
  await expect(readDesignConfig(path)).rejects.toThrow('canonical')
  await expect(discoverPackages(cwd, [{ path: '../outside', name: 'x' }])).rejects.toThrow('Invalid')
})

test('refuses traversal, output reads, symlinks and ambiguous oversized context requests', async () => {
  const cwd = await fixture()
  await symlink('a.ts', join(cwd, 'link.ts'))
  const context = await ReviewContext.create(cwd, await discoverPackages(cwd))
  expect(context.baseline.get('link.ts')!.kind).toBe('symlink')
  await expect(context.acquire('../a.ts')).rejects.toThrow('inventory')
  await expect(context.acquire('link.ts')).rejects.toThrow('source text')
  await expect(context.resolveRequests([{ path: null, symbol: null, query: 'export', reason: '搜索' }], 1)).rejects.toThrow('budget')
  await expect(context.resolveRequests([{ path: null, symbol: null, query: null, reason: '空请求' }], 10)).rejects.toThrow('Empty')
  const first = await context.acquire('a.ts'), second = await context.acquire('a.ts')
  expect(first.id).not.toBe(second.id)
  expect(first.sha256).toBe(second.sha256)
})

test('every artifact root stays excluded even when explicitly tracked', async () => {
  const cwd = await fixture()
  for (const root of ['design-review', 'readability-review', 'readability-fix']) {
    const path = `draft/docs/${root}/old/report.md`
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), 'report')
    execFileSync('git', ['add', '--', path], { cwd })
  }
  expect((await discoverPackages(cwd)).flatMap(p => p.files)).toEqual(['a.ts', 'b.ts'])
  expect(() => parseReport('{"reportKind":"design-review"}')).toThrow()
})

test('static searches report absence and repeated definitions without fabricating runtime consumers', async () => {
  const cwd = await fixture({ 'entry.ts': 'export class Settings { setModel() {} }\n' })
  const context = await ReviewContext.create(cwd, await discoverPackages(cwd))
  const found = await context.resolveRequestsDetailed([{ path: null, symbol: 'Settings', query: null, reason: '寻找消费者' }], 10)
  expect(found.resolution.searches[0]!.definitionPaths).toEqual(['entry.ts'])
  expect(found.resolution.searches[0]!.candidateConsumerPaths).toEqual([])
  expect(found.resolution.searchedPaths).toEqual(['entry.ts'])
  const absent = await context.resolveRequestsDetailed([{ path: null, symbol: null, query: 'new Settings(', reason: '寻找构造点' }], 10)
  expect(absent.snapshots).toHaveLength(0)
  expect(absent.resolution.searches[0]!.matchedPaths).toEqual([])
  expect(absent.resolution.limitations).toContain('not no possible external consumer')
})

test('ignored canonical contract documents are contextual evidence, never primary coverage', async () => {
  const cwd = await fixture({ 'entry.ts': 'export const value = 1\n', '.gitignore': 'draft/\n.env\n', 'README.md': 'Contract: [reference](draft/docs/contract.md)\n' })
  await mkdir(join(cwd, 'draft/docs'), { recursive: true })
  await writeFile(join(cwd, 'draft/docs/contract.md'), 'The public value remains stable.\n')
  await writeFile(join(cwd, '.env'), 'SECRET=not-context\n')
  const packages = await discoverPackages(cwd)
  const context = await ReviewContext.create(cwd, packages)
  const snapshot = await context.acquire('draft/docs/contract.md')
  expect(snapshot.text).toContain('remains stable')
  expect(context.baseline.has(snapshot.path)).toBe(false)
  expect(createDesignPlan(context).primaryFiles).toEqual(['.gitignore', 'README.md', 'entry.ts'])
  expect(await context.contractReferences()).toEqual([{ path: 'draft/docs/contract.md', kind: 'contract_reference', sha256: null }])
  expect(await context.changes()).toEqual([])
  await expect(context.acquire('.env')).rejects.toThrow('Invalid context path')
  await expect(context.acquire('draft/docs/design-review/old/report.md')).rejects.toThrow('Invalid context path')
  await writeFile(join(cwd, 'draft/docs/contract.md'), 'Changed contract.\n')
  expect(await context.changes()).toEqual(['draft/docs/contract.md'])
})

test('ignored contract references are independent of project documentation directory names', async () => {
  const cwd = await fixture({ '.gitignore': 'specifications/\n', 'README.md': '[Contract](specifications/state.adoc)\n', 'main.py': 'state = 0' })
  await mkdir(join(cwd, 'specifications'))
  await writeFile(join(cwd, 'specifications/state.adoc'), 'Only the coordinator may change state.')
  const context = await ReviewContext.create(cwd, await discoverPackages(cwd))
  expect(await context.contractReferences()).toEqual([{ path: 'specifications/state.adoc', kind: 'contract_reference', sha256: null }])
  expect((await context.acquire('specifications/state.adoc')).text).toContain('coordinator')
  expect(context.baseline.has('specifications/state.adoc')).toBe(false)
})

test('UTF-8 BOM snapshots retain their exact bytes through text and evidence validation', async () => {
  const text = '\ufeffexport const value = 1\n'
  const cwd = await fixture({ 'bom.ts': text })
  const context = await ReviewContext.create(cwd, await discoverPackages(cwd))
  const snapshot = context.baseline.get('bom.ts')!
  expect(snapshot.kind).toBe('text')
  expect(snapshot.text).toBe(text)
  expect(hash(snapshot.text)).toBe(snapshot.sha256!)
  expect(() => context.validateEvidence([{ path: snapshot.path, snapshotId: snapshot.id, sha256: snapshot.sha256!,
    symbol: 'value', startLine: 1, endLine: 1, quote: 'export const value = 1', role: 'declaration' }], new Set([snapshot.id]))).not.toThrow()
})

test('contract references cannot clamp escaped relative links into unrelated in-project files', async () => {
  const cwd = await fixture({ '.gitignore': 'contract.md\nlocal.md\n', 'contract.md': 'unrelated internal contract',
    'local.md': 'valid internal contract', 'README.md': '[escape](../contract.md)\n[encoded](%2e%2e/contract.md)\n[absolute](/contract.md)\n[valid](guide/../local.md)\n',
    'docs/page.md': '[escape](../../contract.md)\n' })
  const context = await ReviewContext.create(cwd, await discoverPackages(cwd))
  expect(await context.contractReferences()).toEqual([{ path: 'local.md', kind: 'contract_reference', sha256: null }])
})

test('symbol evidence preserves repository context for baseline and reread language adapters', async () => {
  const cwd = await fixture({ 'a.custom': 'step calculate = 1', 'registry.meta': 'calculate alternate' })
  const adapter: LanguageAdapter = { id: 'cross-file-v1', supports: source => source.path.endsWith('.custom'),
    index: (sources, _, repository) => sources.map(source => {
      const name = /step (\w+)/.exec(source.text)?.[1] ?? ''
      const registered = repository.some(file => file.path === 'registry.meta' && file.text.includes(name))
      return { path: source.path, language: 'custom', adapter: 'cross-file-v1', capabilities: ['symbols'],
        symbols: registered ? [{ name, startLine: 1, endLine: 1, column: 1, kind: 'step' }] : [],
        imports: [], exports: [], calls: [], unknowns: [] }
    }) }
  const context = await ReviewContext.create(cwd, await discoverPackages(cwd), [adapter])
  for (const name of ['calculate', 'alternate']) {
    if (name === 'alternate') await writeFile(join(cwd, 'a.custom'), 'step alternate = 1')
    const snapshot = name === 'calculate' ? context.baseline.get('a.custom')! : await context.acquire('a.custom')
    expect(() => context.validateEvidence([{ path: snapshot.path, snapshotId: snapshot.id, sha256: snapshot.sha256!,
      symbol: name, startLine: 1, endLine: 1, quote: `step ${name}`, role: 'step' }], new Set([snapshot.id]))).not.toThrow()
  }
})


test('language navigation resolves declared package entries without assuming a source directory convention', async () => {
  const cwd = await fixture({ 'lib/package.json': JSON.stringify({ name: 'numbers', exports: './public.ts' }),
    'lib/public.ts': 'export function value() { return 1 }', 'lib/src/index.ts': 'export function value() { return 999 }',
    'caller.ts': 'import { value } from "numbers"; export function read() { return value() }' })
  let context = await ReviewContext.create(cwd, await discoverPackages(cwd))
  expect(context.index.find(i => i.path === 'caller.ts')!.calls.find(c => c.expression === 'value')!.target!.path).toBe('lib/public.ts')
  await writeFile(join(cwd, 'lib/package.json'), JSON.stringify({ name: 'numbers', exports: { import: './public.ts', require: './src/index.ts' } }))
  context = await ReviewContext.create(cwd, await discoverPackages(cwd))
  expect(context.index.find(i => i.path === 'caller.ts')!.imports[0]!.target).toBeNull()
  expect(context.index.find(i => i.path === 'caller.ts')!.unknowns.join()).toContain('Unresolved')
})


test('a rejected supplemental batch drains reads without registering partial snapshots', async () => {
  const cwd = await fixture()
  const context = await ReviewContext.create(cwd, await discoverPackages(cwd))
  const original = context.currentSnapshot.bind(context)
  let release!: () => void
  let started!: () => void
  let finished!: () => void
  const readFinished = new Promise<void>(resolve => { finished = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  const reading = new Promise<void>(resolve => { started = resolve })
  context.currentSnapshot = async path => {
    if (path === 'a.ts') {
      started(); await waiting
      try { return await original(path) } finally { finished() }
    }
    return original(path)
  }
  const before = [...context.snapshots.keys()]
  const batch = context.resolveRequests([
    { path: 'a.ts', symbol: null, query: null, reason: 'slow valid source' },
    { path: 'missing.md', symbol: null, query: null, reason: 'missing source' },
  ], 2)
  // Observe rejection immediately, while still allowing the other read to drain.
  const observed = batch.then(() => null, error => error)
  await reading
  release()
  expect(await observed).toBeInstanceOf(Error)
  await readFinished
  await new Promise<void>(resolve => setImmediate(resolve))
  expect([...context.snapshots.keys()]).toEqual(before)
})

test('long call-chain navigation stays bounded and preserves exact source locations', async () => {
  const text = `const emoji = "😀"; const result = client${'.next()'.repeat(140)}\n`
  const cwd = await fixture({ 'chain.ts': text })
  const context = await ReviewContext.create(cwd, await discoverPackages(cwd))
  const calls = context.index.find(item => item.path === 'chain.ts')!.calls
  expect(calls).toHaveLength(140)
  expect(calls.every(call => call.expression.length <= 513)).toBe(true)
  expect(calls.some(call => call.expressionTruncated)).toBe(true)
  for (const call of calls) {
    const range = call.sourceRange!
    const original = text.slice(range.start, range.end)
    expect(original.startsWith('client')).toBe(true)
    if (call.expressionTruncated) expect(call.expression).toBe(`${original.slice(0, 512)}…`)
    else expect(call.expression).toBe(original)
    expect(call.line).toBe(1)
    expect(call.target).toBeNull()
  }
  expect(context.index[0]!.unknowns.join(' ')).toContain('truncated')
})

test('bare-package root entries cannot resolve sibling files outside the package', async () => {
  for (const entry of [{ main: '.' }, { exports: './' }]) {
    const files = { 'consumer.ts': "import { value } from 'widget'\nvalue()\n", 'pkg/package.json': JSON.stringify({ name: 'widget', ...entry }),
      'pkg.ts': 'export function value() { return "outside" }\n', 'pkg/index.ts': 'export function value() { return "inside" }\n' }
    const cwd = await fixture(files)
    const context = await ReviewContext.create(cwd, await discoverPackages(cwd))
    const consumer = context.index.find(item => item.path === 'consumer.ts')!
    expect(consumer.imports[0]!.target).toBe('pkg/index.ts')
    expect(consumer.calls[0]!.target?.path).toBe('pkg/index.ts')
    await rm(join(cwd, 'pkg/index.ts'))
    const missing = await ReviewContext.create(cwd, await discoverPackages(cwd))
    const unresolved = missing.index.find(item => item.path === 'consumer.ts')!
    expect(unresolved.imports[0]!.target).toBeNull()
    expect(unresolved.calls[0]!.target).toBeNull()
  }
})


test('snapshot adoption stages business evidence and rolls back registry and symbol state on rejection', async () => {
  const cwd = await fixture({ 'a.ts': 'export const a = 1\n', '.gitignore': 'contract.md\n', 'contract.md': 'old' })
  const adapter: LanguageAdapter = { id: 'contract-test', supports: source => source.path === 'contract.md',
    index: sources => sources.map(source => ({ path: source.path, language: 'contract', adapter: 'contract-test', capabilities: ['symbols'],
      symbols: [{ name: source.text, startLine: 1, endLine: 1, column: 1, kind: 'contract' }], imports: [], exports: [], calls: [], unknowns: [] })) }
  const packages = await discoverPackages(cwd)
  const producer = await ReviewContext.create(cwd, packages, [adapter])
  const saved = { ...await producer.acquire('contract.md'), id: 'historical-contract' }
  const context = await ReviewContext.create(cwd, packages, [adapter])
  const before = [...context.snapshots.keys()]
  const citation = (snapshot: typeof saved) => [{ path: snapshot.path, snapshotId: snapshot.id, sha256: snapshot.sha256!,
    symbol: snapshot.text, startLine: 1, endLine: 1, quote: snapshot.text, role: 'contract' }]
  expect(() => context.adoptSnapshots([saved], () => {
    context.validateEvidence(citation(saved), new Set([saved.id]))
    throw new Error('business rejection')
  })).toThrow('business rejection')
  expect([...context.snapshots.keys()]).toEqual(before)
  await writeFile(join(cwd, 'contract.md'), 'new')
  const incoming = { ...saved, text: 'new', sha256: hash('new') }
  expect(await context.matchesSavedSnapshots([incoming])).toBe(true)
  context.adoptSnapshots([incoming], () => {
    context.validateEvidence(citation(incoming), new Set([incoming.id]))
    return true
  })
  expect(Object.isFrozen(context.snapshots.get(incoming.id))).toBe(true)
  incoming.text = 'caller mutation'
  expect(context.snapshots.get(incoming.id)!.text).toBe('new')
})

test('snapshot admission rejects corrupt batches and conflicting identities without partial registration', async () => {
  const cwd = await fixture({ 'a.ts': 'export const a = 1\n' })
  const context = await ReviewContext.create(cwd, await discoverPackages(cwd))
  const source = context.baseline.get('a.ts')!
  const saved = { ...source, id: `${source.id}:saved` }
  const before = [...context.snapshots.keys()]
  expect(() => context.adoptSnapshots([saved, { ...saved, id: 'corrupt', text: 'changed without digest' }], () => true)).toThrow(SnapshotIntegrityError)
  expect([...context.snapshots.keys()]).toEqual(before)
  await expect(context.matchesSavedSnapshots([saved, saved])).rejects.toBeInstanceOf(SnapshotIntegrityError)
  context.adoptSnapshots([saved], () => true)
  const conflicting = { ...saved, text: 'different', sha256: hash('different') }
  expect(() => context.adoptSnapshots([conflicting], () => true)).toThrow(SnapshotIntegrityError)
  expect(context.snapshots.get(saved.id)!.text).toBe(source.text)
})

test('changed and missing saved sources are cache misses without granting evidence access', async () => {
  const cwd = await fixture({ 'a.ts': 'export const a = 1\n', '.gitignore': 'contract.md\n', 'contract.md': 'original' })
  const packages = await discoverPackages(cwd)
  const producer = await ReviewContext.create(cwd, packages)
  const saved = await producer.acquire('contract.md')
  const context = await ReviewContext.create(cwd, packages)
  expect(await context.matchesSavedSnapshots([saved])).toBe(true)
  await writeFile(join(cwd, 'contract.md'), 'changed')
  expect(await context.matchesSavedSnapshots([saved])).toBe(false)
  await rm(join(cwd, 'contract.md'))
  expect(await context.matchesSavedSnapshots([saved])).toBe(false)
  expect(context.snapshots.has(saved.id)).toBe(false)
})


test('prompt source compaction keeps supplied IDs and all distinct versions without losing read history', async () => {
  const cwd = await fixture({ 'a.ts': 'export const a = 1\n' })
  const context = await ReviewContext.create(cwd, await discoverPackages(cwd))
  const original = context.baseline.get('a.ts')!
  const repeated = await context.acquire('a.ts')
  let sources = mergePromptSources([original], [repeated])
  expect(sources.map(source => source.id)).toEqual([original.id])
  expect(context.snapshots.has(repeated.id)).toBe(true)
  await writeFile(join(cwd, 'a.ts'), 'export const a = 2\n')
  const changed = await context.acquire('a.ts')
  sources = mergePromptSources(sources, [changed, repeated])
  expect(sources.map(source => source.id)).toEqual([original.id, changed.id])
  await writeFile(join(cwd, 'a.ts'), original.text)
  const restored = await context.acquire('a.ts')
  expect(mergePromptSources(sources, [restored]).map(source => source.id)).toEqual([original.id, changed.id])
  expect(context.snapshots.has(restored.id)).toBe(true)
  expect(await context.changes()).toEqual(['a.ts'])
})

test('different unavailable-source diagnostics remain distinct prompt facts', () => {
  const first = { id: 'first', path: 'a.ts', kind: 'unavailable' as const, sha256: null, text: '', error: 'missing' }
  const second = { ...first, id: 'second', error: 'access denied' }
  expect(mergePromptSources([first], [second])).toEqual([first, second])
})
