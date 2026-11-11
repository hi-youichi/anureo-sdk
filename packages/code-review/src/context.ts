import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { buildIndex, type SourceIndex, type SourceSymbol, type LanguageAdapter } from './language'
export { buildIndex } from './language'
export type { SourceIndex, SourceSymbol } from './language'
import { discoverPackages, isReviewOutput, saveJson, type Package } from './io'
import type { ContextRequest, Evidence } from './schema'

export type Snapshot = {
  id: string; path: string; sha256: string | null; kind: 'text' | 'binary' | 'symlink' | 'unavailable'
  text: string; error: string | null
}
export function hash(value: string | Uint8Array) { return createHash('sha256').update(value).digest('hex') }
export class ContextSelectionRequired extends Error {
  constructor(readonly paths: string[], readonly limit: number) { super(`Context file budget exceeded: ${paths.length} > ${limit}; choose explicit paths from candidates`) }
}

/** Refuse any symlink parent. A leaf symlink is metadata and is never followed. */
export async function readSnapshot(cwd: string, path: string, exclusions: readonly string[] = []): Promise<Snapshot> {
  cwd = await realpath(cwd)
  const absolute = resolve(cwd, path)
  const inside = relative(cwd, absolute).split(sep).join('/')
  if (isAbsolute(path) || !inside || inside === '..' || inside.startsWith('../')
    || inside !== path || isReviewOutput(path, exclusions) || path.split('/').includes('node_modules') || path.startsWith('.git/')) {
    throw new Error(`Invalid context path: ${path}`)
  }
  const parent = dirname(absolute)
  if (await realpath(parent) !== parent) throw new Error(`Symlink parent: ${path}`)
  const stat = await lstat(absolute)
  if (stat.isSymbolicLink()) {
    const target = await readlink(absolute)
    return { id: `snapshot:${hash(`${path}\0${target}`)}`, path, sha256: hash(target), kind: 'symlink', text: '', error: null }
  }
  if (!stat.isFile()) throw new Error(`Not a regular file: ${path}`)
  const bytes = await readFile(absolute)
  const sha256 = hash(bytes)
  let text: string
  try {
    if (bytes.includes(0)) throw new Error('Binary data')
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch { return { id: `snapshot:${hash(`${path}\0${sha256}`)}`, path, sha256, kind: 'binary', text: '', error: null } }
  return { id: `snapshot:${hash(`${path}\0${sha256}`)}`, path, sha256, kind: 'text', text, error: null }
}

export class ReviewContext {
  readonly snapshots = new Map<string, Snapshot>()
  readonly baseline = new Map<string, Snapshot>()
  readonly index: SourceIndex[]
  private readonly evidenceSymbols = new Map<string, SourceSymbol[]>()
  private constructor(readonly cwd: string, readonly packages: Package[], initial: Snapshot[], readonly adapters: readonly LanguageAdapter[], readonly exclusions: readonly string[]) {
    for (const s of initial) { this.baseline.set(s.path, s); this.snapshots.set(s.id, s) }
    this.index = buildIndex(initial, packages, adapters)
  }

  static async create(cwd: string, packages: Package[], adapters: readonly LanguageAdapter[] = [], exclusions: readonly string[] = []) {
    const paths = packages.flatMap(pkg => pkg.files)
    if (paths.length !== new Set(paths).size) throw new Error('Duplicate primary file ownership')
    const snapshots: Snapshot[] = []
    for (const path of paths) {
      try { snapshots.push(await readSnapshot(cwd, path, exclusions)) }
      catch (error) { snapshots.push({ id: `unavailable:${hash(path)}`, path, sha256: null, kind: 'unavailable', text: '', error: String(error) }) }
    }
    return new ReviewContext(cwd, packages, snapshots, adapters, exclusions)
  }

  gitBaseline() {
    const git = (args: string[]) => {
      try { return execFileSync('git', args, { cwd: this.cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim() } catch { return null }
    }
    return { commit: git(['rev-parse', '--verify', 'HEAD']), status: git(['status', '--porcelain=v1']) }
  }

  /** Ignored contract documents may be context without becoming primary inventory. */
  assertContextPath(path: string) {
    if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Invalid context path outside inventory: ${path}`)
    if (isReviewOutput(path, this.exclusions)) throw new Error(`Invalid context path: review output ${path}`)
    const ignoredContract = /\.(mdx?|rst|adoc)$/i.test(path)
      && !path.split('/').some(part => part.startsWith('.'))
    if (!this.baseline.has(path) && !ignoredContract) throw new Error(`Invalid context path outside inventory or supported contract documents: ${path}`)
  }

  async currentSnapshot(path: string) {
    this.assertContextPath(path)
    return readSnapshot(this.cwd, path, this.exclusions)
  }

  async acquire(path: string): Promise<Snapshot> {
    const read = await this.currentSnapshot(path)
    if (read.kind !== 'text') throw new Error(`Context is not source text: ${path}`)
    const snapshot = { ...read, id: `${read.id}:read-${randomUUID()}` }
    this.snapshots.set(snapshot.id, snapshot)
    return snapshot
  }

  async contractReferences() {
    const paths = new Set<string>()
    for (const source of this.baseline.values()) {
      if (source.kind !== 'text' || !/\.mdx?$/i.test(source.path)) continue
      for (const match of source.text.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1]!.replace(/^<|>$/g, '').split('#')[0]!
        if (!target || /^[a-z]+:/i.test(target)) continue
        let path: string
        try { path = posix.resolve('/', posix.dirname(source.path), decodeURIComponent(target)).slice(1); this.assertContextPath(path) } catch { continue }
        if (this.baseline.has(path)) continue
        try {
          const root = await realpath(this.cwd)
          const absolute = join(root, path)
          if (await realpath(dirname(absolute)) === dirname(absolute) && (await lstat(absolute)).isFile()) paths.add(path)
        } catch { /* A missing reference is not an existing readable contract. */ }
      }
    }
    return [...paths].sort().map(path => ({ path, kind: 'contract_reference', sha256: null }))
  }

  async resolveRequestsDetailed(requests: ContextRequest[], maxFiles: number) {
    const paths = new Set<string>()
    const searches: Array<{ request: ContextRequest; matchedPaths: string[]; definitionPaths: string[]; candidateConsumerPaths: string[] }> = []
    for (const request of requests) {
      if (!request.path && !request.symbol && !request.query) throw new Error('Empty context request')
      const definitions = request.symbol ? this.index.filter(item => item.symbols.some(s => s.name === request.symbol || s.name.endsWith(`.${request.symbol}`))).map(item => item.path) : []
      let matched: string[]
      if (request.path) {
        this.assertContextPath(request.path)
        paths.add(request.path)
        matched = [request.path]
      } else {
        const matches = [...this.baseline.values()].filter(source => source.kind === 'text'
          && (request.symbol
            ? this.index.find(item => item.path === source.path)?.symbols.some(s => s.name === request.symbol || s.name.endsWith(`.${request.symbol}`))
              || source.text.includes(request.symbol)
            : !request.query || source.text.includes(request.query)))
        matched = matches.map(source => source.path)
        for (const match of matches) paths.add(match.path)
      }
      searches.push({ request, matchedPaths: matched, definitionPaths: definitions,
        candidateConsumerPaths: matched.filter(path => !definitions.includes(path)) })
    }
    if (paths.size > maxFiles) throw new ContextSelectionRequired([...paths], maxFiles)
    const snapshots = await Promise.all([...paths].map(path => this.acquire(path)))
    return { snapshots, resolution: { status: 'resolved', searches, searchedPaths: [...this.baseline.keys()],
      limitations: 'This is a static inventory search. Candidate consumers are navigation matches, not proven runtime calls. Zero matches means no match in this inventory, not no possible external consumer.',
      instruction: '若只命中已经提供的定义，仓库未提供更多对应实现/候选消费者；不要重复请求同一符号。结合已读契约审查接口与不变量，将外部运行事实标为假设或待验证。确实缺少必要源码时只将相应维度标 incomplete。' } }
  }

  async resolveRequests(requests: ContextRequest[], maxFiles: number) {
    return (await this.resolveRequestsDetailed(requests, maxFiles)).snapshots
  }

  validateEvidence(evidence: Evidence[], allowed: Set<string>) {
    for (const e of evidence) {
      const snapshot = this.snapshots.get(e.snapshotId)
      if (!snapshot || !allowed.has(e.snapshotId) || snapshot.kind !== 'text' || snapshot.path !== e.path || snapshot.sha256 !== e.sha256) {
        throw new Error(`Invalid evidence snapshot: ${e.path}`)
      }
      const lines = snapshot.text.split('\n')
      if (e.endLine < e.startLine || e.endLine > lines.length || !lines.slice(e.startLine - 1, e.endLine).join('\n').includes(e.quote)) {
        throw new Error(`Invalid source evidence: ${e.path}:${e.startLine}-${e.endLine}`)
      }
      if (e.symbol) {
        let symbols = this.evidenceSymbols.get(snapshot.id)
        if (!symbols) { symbols = buildIndex([snapshot], this.packages, this.adapters)[0]?.symbols ?? []; this.evidenceSymbols.set(snapshot.id, symbols) }
        if (!symbols.some(s => (s.name === e.symbol || s.name.endsWith(`.${e.symbol}`)) && s.startLine <= e.endLine && s.endLine >= e.startLine)) {
          throw new Error(`Invalid evidence symbol: ${e.symbol}; unindexed source must use an empty symbol and exact line/quote evidence`)
        }
      }
    }
  }

  async changes() {
    const current = (await discoverPackages(this.cwd, [], this.exclusions)).flatMap(pkg => pkg.files)
    const changed = new Set(current.filter(path => !this.baseline.has(path)))
    for (const snapshot of this.snapshots.values()) {
      try {
        const actual = await readSnapshot(this.cwd, snapshot.path, this.exclusions)
        if (snapshot.sha256 !== actual.sha256 || snapshot.kind !== actual.kind) changed.add(snapshot.path)
      } catch { changed.add(snapshot.path) }
    }
    for (const path of this.baseline.keys()) if (!current.includes(path)) changed.add(path)
    return [...changed].sort()
  }

  async save(outputDir: string) {
    await saveJson(join(outputDir, 'index.json'), this.index)
    for (const snapshot of this.snapshots.values()) await saveJson(join(outputDir, 'snapshots', `${hash(snapshot.id)}.json`), snapshot)
  }
}

export function sourceInput(snapshot: Snapshot) {
  return { ...snapshot, text: undefined, source: snapshot.text.split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n') }
}
