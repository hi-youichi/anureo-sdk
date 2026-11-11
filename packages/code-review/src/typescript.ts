import { posix } from 'node:path'
import ts from 'typescript'
import type { Snapshot } from './context'
import type { Package } from './io'
import type { SourceIndex } from './language'

const { dirname, resolve } = posix

export function indexTypeScript(snapshots: Snapshot[], _packages: Package[], repository: readonly Snapshot[] = snapshots): SourceIndex[] {
  const sources = new Map(snapshots.filter(s => s.kind === 'text' && /\.[cm]?[jt]sx?$/i.test(s.path)).map(s => [`/${s.path}`, s.text]))
  const byName = new Map<string, { root: string; manifest: Record<string, unknown> }>()
  const ambiguousNames = new Set<string>()
  for (const snapshot of repository) {
    if (snapshot.kind !== 'text' || !/(^|\/)package\.json$/.test(snapshot.path)) continue
    try {
      const manifest = JSON.parse(snapshot.text)
      if (typeof manifest.name !== 'string') continue
      // Ambiguous package identities cannot identify a static target.
      if (ambiguousNames.has(manifest.name)) continue
      if (byName.has(manifest.name)) { byName.delete(manifest.name); ambiguousNames.add(manifest.name); continue }
      byName.set(manifest.name, { root: `/${dirname(snapshot.path) === '.' ? '' : dirname(snapshot.path)}`, manifest })
    } catch { /* An invalid manifest is not an import-resolution contract. */ }
  }
  const packageNames = [...byName.keys()].sort((a, b) => b.length - a.length)
  function exportTarget(value: unknown): string | null {
    if (typeof value === 'string') return value.startsWith('./') ? value : null
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    // Only resolve condition maps when every runtime branch agrees. Type declarations
    // alone do not identify which runtime implementation a consumer will execute.
    const branches = Object.entries(value).filter(([key]) => key !== 'types').map(([, target]) => exportTarget(target))
    return branches.length && branches[0] && branches.every(target => target === branches[0]) ? branches[0] : null
  }
  function resolveImport(specifier: string, from: string): string | null {
    let base: string
    if (specifier.startsWith('.')) base = resolve(dirname(from), specifier)
    else {
      const pkg = packageNames.find(name => specifier === name || specifier.startsWith(`${name}/`))
      if (!pkg) return null
      const { root, manifest } = byName.get(pkg)!
      const suffix = specifier.slice(pkg.length)
      const key = suffix ? `.${suffix}` : '.'
      let entry: string | null
      if ('exports' in manifest) {
        const exports = manifest.exports
        const subpaths = exports && typeof exports === 'object' && !Array.isArray(exports)
          && Object.keys(exports).some(key => key.startsWith('.'))
        entry = exportTarget(subpaths ? (exports as Record<string, unknown>)[key] : key === '.' ? exports : null)
      } else {
        if (typeof manifest.module === 'string' && manifest.module !== manifest.main) return null
        entry = suffix ? `.${suffix}` : typeof manifest.main === 'string' ? manifest.main : './index.js'
      }
      if (!entry) return null
      base = resolve(root, entry)
      if (base !== root && !base.startsWith(root.endsWith('/') ? root : `${root}/`)) return null
    }
    const sourceEquivalent = base.replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts').replace(/\.jsx$/, '.tsx').replace(/\.js$/, '.ts')
    return [base, sourceEquivalent, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`, `${base}.d.ts`]
      .find(candidate => sources.has(candidate)) ?? null
  }
  const compilerOptions: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, allowJs: true, noLib: true }
  const host: ts.CompilerHost = {
    getSourceFile: (path, languageVersion) => sources.has(path) ? ts.createSourceFile(path, sources.get(path)!, languageVersion, true) : undefined,
    getDefaultLibFileName: () => '', writeFile: () => {}, getCurrentDirectory: () => '/',
    getDirectories: () => [], fileExists: path => sources.has(path), readFile: path => sources.get(path),
    getCanonicalFileName: path => path, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    resolveModuleNames: (names, from) => names.map(name => {
      const target = resolveImport(name, from)
      return target ? { resolvedFileName: target } : undefined
    }),
  }
  const program = ts.createProgram([...sources.keys()], compilerOptions, host)
  const checker = program.getTypeChecker()
  return [...sources.keys()].map(path => {
    const source = program.getSourceFile(path)!
    const item: SourceIndex = { path: path.slice(1), language: /\.[cm]?tsx?$/i.test(path) ? 'typescript' : 'javascript', adapter: 'typescript-compiler-v2', capabilities: ['symbols', 'imports', 'static_calls'], symbols: [], imports: [], exports: [], calls: [], unknowns: [] }
    function visit(node: ts.Node) {
      const named = node as ts.Node & { name?: ts.Node; body?: ts.Node }
      if (named.name && (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)
        || ts.isTypeAliasDeclaration(node) || ts.isVariableDeclaration(node))) {
        let name = named.name.getText(source)
        const parent = node.parent as ts.Node & { name?: ts.Node }
        if (parent?.name && (ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent))) name = `${parent.name.getText(source)}.${name}`
        const start = source.getLineAndCharacterOfPosition(node.getStart(source))
        item.symbols.push({ name, startLine: start.line + 1, column: start.character + 1,
          endLine: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1, kind: ts.SyntaxKind[node.kind] })
      }
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text
        const target = resolveImport(specifier, path)
        item.imports.push({ specifier, target: target?.slice(1) ?? null })
        if (!target) item.unknowns.push(`Unresolved/external import: ${specifier}`)
      }
      if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) item.exports.push(node.getText(source))
      else if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        item.exports.push(named.name?.getText(source) ?? ts.SyntaxKind[node.kind])
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration
        const targetSource = declaration?.getSourceFile()
        const concrete = declaration && 'body' in declaration && declaration.body
        const target = concrete && targetSource && sources.has(targetSource.fileName)
          ? { path: targetSource.fileName.slice(1), line: targetSource.getLineAndCharacterOfPosition(declaration.getStart()).line + 1 } : null
        const start = node.expression.getStart(source), end = node.expression.getEnd()
        const expressionTruncated = end - start > 512
        const expression = source.text.slice(start, Math.min(end, start + 512)) + (expressionTruncated ? '…' : '')
        item.calls.push({ expression, sourceRange: { start, end }, expressionTruncated,
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, target })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (item.calls.some(call => call.expressionTruncated)) item.unknowns.push('Long call expression navigation is truncated; sourceRange locates the complete expression in the original snapshot.')
    if (item.calls.some(call => !call.target)) item.unknowns.push('Dynamic/injected/external calls need implementation context; a signature does not establish the runtime target.')
    return item
  })
}
