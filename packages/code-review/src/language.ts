import { extname } from 'node:path'
import type { Snapshot } from './context'
import type { Package } from './io'
import { indexTypeScript } from './typescript'

export type SourceSymbol = { name: string; startLine: number; endLine: number; column: number; kind: string }
export type SourceIndex = {
  path: string; language: string; adapter: string; capabilities: Array<'symbols' | 'imports' | 'static_calls'>
  symbols: SourceSymbol[]; imports: Array<{ specifier: string; target: string | null }>
  exports: string[]; calls: Array<{
    expression: string; line: number; target: { path: string; line: number } | null
    /** Zero-based UTF-16 offsets into the complete source snapshot, with an exclusive end. */
    sourceRange?: { start: number; end: number }; expressionTruncated?: boolean
  }>
  unknowns: string[]
}
/** Adapters supply navigation, never design judgements or runtime guarantees. IDs must version their semantics. */
export type LanguageAdapter = {
  id: string
  supports: (source: Snapshot) => boolean
  index: (sources: Snapshot[], packages: Package[], repository: readonly Snapshot[]) => SourceIndex[]
}

const languages: Record<string, string> = {
  '.py': 'python', '.pyi': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'csharp', '.rb': 'ruby', '.php': 'php',
  '.swift': 'swift', '.scala': 'scala', '.clj': 'clojure', '.cljs': 'clojure', '.ex': 'elixir', '.exs': 'elixir',
  '.erl': 'erlang', '.hs': 'haskell', '.ml': 'ocaml', '.sql': 'sql', '.sh': 'shell', '.bash': 'shell',
  '.vue': 'vue', '.svelte': 'svelte', '.lua': 'lua', '.dart': 'dart', '.r': 'r',
}
const typescript: LanguageAdapter = {
  id: 'typescript-compiler-v2', supports: source => /\.[cm]?[jt]sx?$/i.test(source.path), index: indexTypeScript,
}

/** Every text file remains reviewable, including extensionless code and an unknown DSL. */
export function buildIndex(snapshots: Snapshot[], packages: Package[], adapters: readonly LanguageAdapter[] = []): SourceIndex[] {
  const available = [...adapters, typescript]
  if (new Set(available.map(a => a.id)).size !== available.length) throw new Error('Duplicate language adapter IDs')
  const text = snapshots.filter(s => s.kind === 'text')
  const owners = new Map(text.map(source => [source.path, available.find(a => a.supports(source))]))
  const indexed = new Map<string, SourceIndex>()
  for (const adapter of available) {
    const assigned = text.filter(s => owners.get(s.path) === adapter)
    if (!assigned.length) continue
    const records = adapter.index(assigned, packages, snapshots)
    if (records.length !== assigned.length || new Set(records.map(i => i.path)).size !== assigned.length
      || records.some(i => owners.get(i.path) !== adapter || i.adapter !== adapter.id)) throw new Error(`Invalid language adapter coverage: ${adapter.id}`)
    for (const record of records) indexed.set(record.path, record)
  }
  return text.map(source => indexed.get(source.path) ?? {
    path: source.path, language: languages[extname(source.path).toLowerCase()] ?? 'unknown', adapter: 'text-v1', capabilities: [],
    symbols: [], imports: [], exports: [], calls: [],
    unknowns: ['No syntax adapter: full source, literal search and exact quotes are available. Empty symbols/imports/calls mean unindexed, never absent. Use explicit paths or literal queries; evidence.symbol must be empty.'],
  })
}
