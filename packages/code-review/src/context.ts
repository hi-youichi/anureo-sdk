import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { execFileSync } from 'node:child_process'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { buildIndex, type SourceIndex, type SourceSymbol, type LanguageAdapter } from './language'
export { buildIndex } from './language'
export type { SourceIndex, SourceSymbol } from './language'
import { discoverPackages, isReviewOutput, saveJson, type Package } from './io'
import type { ContextRequest, Evidence } from './schema'

export const snapshotSchema = z.strictObject({
  id: z.string(), path: z.string(), sha256: z.string().nullable(),
  kind: z.enum(['text', 'binary', 'symlink', 'unavailable']),
  text: z.string(), error: z.string().nullable(),
})
export type Snapshot = Readonly<z.output<typeof snapshotSchema>>
export class SnapshotIntegrityError extends Error {
  constructor() { super('Invalid source snapshot') }
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
    // Preserve the BOM so decoded text round-trips to the bytes named by sha256.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch { return { id: `snapshot:${hash(`${path}\0${sha256}`)}`, path, sha256, kind: 'binary', text: '', error: null } }
  return { id: `snapshot:${hash(`${path}\0${sha256}`)}`, path, sha256, kind: 'text', text, error: null }
}

export class ReviewContext {
  private readonly recordedSnapshots = new Map<string, Snapshot>()
  get snapshots(): ReadonlyMap<string, Snapshot> { return this.recordedSnapshots }
  private readonly primarySnapshots = new Map<string, Snapshot>()
  get baseline(): ReadonlyMap<string, Snapshot> { return this.primarySnapshots }
  readonly index: SourceIndex[]
  private readonly evidenceSymbols = new Map<string, SourceSymbol[]>()
  private readonly indexByPath: Map<string, SourceIndex>
  private constructor(readonly cwd: string, readonly packages: Package[], initial: Snapshot[], readonly adapters: readonly LanguageAdapter[], readonly exclusions: readonly string[]) {
    for (const source of initial) {
      const snapshot = Object.freeze({ ...source })
      this.primarySnapshots.set(snapshot.path, snapshot)
      this.recordedSnapshots.set(snapshot.id, snapshot)
    }
    this.index = buildIndex([...this.baseline.values()], packages, adapters)
    this.indexByPath = new Map(this.index.map(item => [item.path, item]))
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
    return this.registerRead(read)
  }

  private registerRead(read: Snapshot): Snapshot {
    const snapshot = Object.freeze({ ...read, id: `${read.id}:read-${randomUUID()}` })
    this.recordedSnapshots.set(snapshot.id, snapshot)
    return snapshot
  }

  private decodeSavedSnapshots(values: readonly unknown[]): Snapshot[] {
    let snapshots: Snapshot[]
    try { snapshots = snapshotSchema.array().parse(values) }
    catch { throw new SnapshotIntegrityError() }
    const ids = new Set<string>()
    for (const snapshot of snapshots) {
      if (!snapshot.id || ids.has(snapshot.id) || (snapshot.kind === 'text' && hash(snapshot.text) !== snapshot.sha256)) throw new SnapshotIntegrityError()
      ids.add(snapshot.id)
      const existing = this.recordedSnapshots.get(snapshot.id)
      if (existing && !isDeepStrictEqual(existing, snapshot)) throw new SnapshotIntegrityError()
    }
    return snapshots
  }

  /** A changed or missing source is a cache miss; malformed saved evidence is an error. */
  async matchesSavedSnapshots(values: readonly unknown[]): Promise<boolean> {
    const snapshots = this.decodeSavedSnapshots(values)
    for (const snapshot of snapshots) {
      let current: Snapshot
      try { current = await this.currentSnapshot(snapshot.path) }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false; throw cause }
      if (current.kind !== snapshot.kind || current.sha256 !== snapshot.sha256) return false
    }
    return true
  }

  /** Stage immutable source facts for synchronous business checks; reject without leaking them. */
  adoptSnapshots(values: readonly unknown[], validate: () => true): void {
    const snapshots = this.decodeSavedSnapshots(values)
    for (const snapshot of snapshots) if (!this.recordedSnapshots.has(snapshot.id)) this.assertContextPath(snapshot.path)
    const staged: string[] = []
    try {
      for (const snapshot of snapshots) if (!this.recordedSnapshots.has(snapshot.id)) {
        this.recordedSnapshots.set(snapshot.id, Object.freeze({ ...snapshot }))
        staged.push(snapshot.id)
      }
      if (validate() !== true) throw new Error('Snapshot validation must explicitly accept synchronously')
    } catch (cause) {
      for (const id of staged) { this.recordedSnapshots.delete(id); this.evidenceSymbols.delete(id) }
      throw cause
    }
  }

  async contractReferences() {
    const paths = new Set<string>()
    for (const source of this.baseline.values()) {
      if (source.kind !== 'text' || !/\.mdx?$/i.test(source.path)) continue
      for (const match of source.text.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1]!.replace(/^<|>$/g, '').split('#')[0]!
        if (!target || /^[a-z]+:/i.test(target)) continue
        let path: string
        try {
          const decoded = decodeURIComponent(target)
          if (posix.isAbsolute(decoded) || /^[a-z][a-z0-9+.-]*:/i.test(decoded)) continue
          path = posix.normalize(posix.join(posix.dirname(source.path), decoded))
          this.assertContextPath(path)
        } catch { continue }
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
      const symbol = request.symbol
      const definitions = symbol ? this.index.filter(item => item.symbols.some(s => s.name === symbol || s.name.endsWith(`.${symbol}`))).map(item => item.path) : []
      const definitionPaths = new Set(definitions)
      let matched: string[]
      if (request.path) {
        this.assertContextPath(request.path)
        paths.add(request.path)
        matched = [request.path]
      } else {
        const matches = [...this.baseline.values()].filter(source => source.kind === 'text'
          && (request.symbol
            ? definitionPaths.has(source.path)
              || source.text.includes(request.symbol)
            : !request.query || source.text.includes(request.query)))
        matched = matches.map(source => source.path)
        for (const match of matches) paths.add(match.path)
      }
      searches.push({ request, matchedPaths: matched, definitionPaths: definitions,
        candidateConsumerPaths: matched.filter(path => !definitionPaths.has(path)) })
    }
    if (paths.size > maxFiles) throw new ContextSelectionRequired([...paths], maxFiles)
    // Drain all reads and validate the whole batch before publishing shared evidence.
    const reads = await Promise.allSettled([...paths].map(path => this.currentSnapshot(path)))
    const snapshots = reads.map(read => {
      if (read.status === 'rejected') throw read.reason
      if (read.value.kind !== 'text') throw new Error(`Context is not source text: ${read.value.path}`)
      return read.value
    }).map(read => this.registerRead(read))
    return { snapshots, resolution: { status: 'resolved', searches, searchedPaths: [...this.baseline.keys()],
      limitations: 'This is a static inventory search. Candidate consumers are navigation matches, not proven runtime calls. Zero matches means no match in this inventory, not no possible external consumer.',
      instruction: '若只命中已经提供的定义，仓库未提供更多对应实现/候选消费者；不要重复请求同一符号。结合已读契约审查接口与不变量，将外部运行事实标为假设或待验证。确实缺少必要源码时只将相应维度标 incomplete。' } }
  }

  async resolveRequests(requests: ContextRequest[], maxFiles: number) {
    return (await this.resolveRequestsDetailed(requests, maxFiles)).snapshots
  }

  validateEvidence(evidence: Evidence[], allowed: Set<string>, linesBySnapshot = new Map<string, string[]>()) {
    for (const e of evidence) {
      const snapshot = this.snapshots.get(e.snapshotId)
      if (!snapshot || !allowed.has(e.snapshotId) || snapshot.kind !== 'text' || snapshot.path !== e.path || snapshot.sha256 !== e.sha256) {
        throw new Error(`Invalid evidence snapshot: ${e.path}`)
      }
      let lines = linesBySnapshot.get(snapshot.id)
      if (!lines) { lines = snapshot.text.split('\n'); linesBySnapshot.set(snapshot.id, lines) }
      if (e.endLine < e.startLine || e.endLine > lines.length || !lines.slice(e.startLine - 1, e.endLine).join('\n').includes(e.quote)) {
        throw new Error(`Invalid source evidence: ${e.path}:${e.startLine}-${e.endLine}`)
      }
      if (e.symbol) {
        let symbols = this.evidenceSymbols.get(snapshot.id)
        if (!symbols) {
          const baseline = this.baseline.get(snapshot.path)
          if (baseline?.kind === snapshot.kind && baseline.sha256 === snapshot.sha256) {
            symbols = this.indexByPath.get(snapshot.path)?.symbols ?? []
          } else {
            // Recheck this historical file in the repository view used for navigation.
            const repository = [...this.baseline.values()].filter(source => source.path !== snapshot.path).concat(snapshot)
            symbols = buildIndex(repository, this.packages, this.adapters).find(item => item.path === snapshot.path)?.symbols ?? []
          }
          this.evidenceSymbols.set(snapshot.id, symbols)
        }
        if (!symbols.some(s => (s.name === e.symbol || s.name.endsWith(`.${e.symbol}`)) && s.startLine <= e.endLine && s.endLine >= e.startLine)) {
          throw new Error(`Invalid evidence symbol: ${e.symbol}; unindexed source must use an empty symbol and exact line/quote evidence`)
        }
      }
    }
  }

  async changes() {
    const current = (await discoverPackages(this.cwd, [], this.exclusions)).flatMap(pkg => pkg.files)
    const changed = new Set(current.filter(path => !this.baseline.has(path)))
    const histories = new Map<string, Snapshot[]>()
    for (const snapshot of this.snapshots.values()) {
      const versions = histories.get(snapshot.path) ?? []
      versions.push(snapshot)
      histories.set(snapshot.path, versions)
    }
    for (const [path, versions] of histories) {
      try {
        const actual = await readSnapshot(this.cwd, path, this.exclusions)
        if (versions.some(snapshot => snapshot.sha256 !== actual.sha256 || snapshot.kind !== actual.kind)) changed.add(path)
      } catch { changed.add(path) }
    }
    const currentPaths = new Set(current)
    for (const path of this.baseline.keys()) if (!currentPaths.has(path)) changed.add(path)
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
