// Records graph coverage and writes the graph supplied to each refactor phase.
import { writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { message } from './errors'
import { loadGraph, type RepositoryGraph } from './graph'
import type { RefactorOptions } from './options'
import type { GraphCoverage, RefactorReport } from './results'

/** Internal state shared by runDesign and prepareModules while withRun holds the writer lock. */
export interface GraphArtifactContext {
  options: Pick<RefactorOptions, 'cwd' | 'noGraph' | 'graphLoader' | 'repographEntry'>
  report: Pick<RefactorReport, 'directory' | 'graphCoverage'>
  progress: (event: string) => void
  /** Cached default-exporter failure. A later phase records its own coverage without retrying. */
  graphError?: string
}

/** Record coverage for the phase's Git-relative source paths and return the written graph path.
 * runDesign calls this before the design agent starts. prepareModules calls it after planning when
 * design changed files, then passes the result to runModules for the module prompts. Disabled or
 * unavailable default exports return null for source inspection. The first default-exporter failure
 * is recorded before progress is reported. Configured exporter failures and artifact serialization
 * or write failures reject and stop the pending agent work. Coverage records export availability
 * before serialization so the report retains coverage even if the artifact cannot be written.
 * Callers supply the existing report directory and serialize writes under the run lock. */
export async function exportGraph(context: GraphArtifactContext, phase: string, files: string[]): Promise<string | null> {
  const { options, report, progress } = context
  if (options.noGraph) {
    report.graphCoverage.push({ phase, status: 'disabled', filesWithoutSymbols: files })
    return null
  }
  if (context.graphError !== undefined) {
    recordUnavailable(report.graphCoverage, { phase, files, error: context.graphError })
    return null
  }
  let graph: RepositoryGraph
  try {
    graph = options.graphLoader ? await options.graphLoader(options.cwd) : await loadGraph(options.cwd, options.repographEntry)
  } catch (cause) {
    const error = message(cause)
    recordUnavailable(report.graphCoverage, { phase, files, error })
    if (options.graphLoader || options.repographEntry) throw cause
    context.graphError = error
    progress(`graph/${phase}: unavailable; continuing with source`)
    return null
  }
  report.graphCoverage.push({ phase, status: 'available', filesWithoutSymbols: filesWithoutSymbols(graph, options.cwd, files) })
  const file = join(report.directory, `graph-${phase}.json`)
  await writeFile(file, JSON.stringify(graph))
  return file
}

/** Append unavailable coverage for exportGraph using the current phase's inventory, including on
 * later phases that reuse a cached error. */
function recordUnavailable(coverage: GraphCoverage[], { phase, files, error }: { phase: string; files: string[]; error: string }): void {
  coverage.push({ phase, status: 'unavailable', filesWithoutSymbols: files, error })
}

/** Return inventory paths in input order that lack indexed symbols. Container labels alone
 * establish that a path was seen, so exportGraph counts a node only if it has a non-container
 * label. Convert absolute paths to target-relative paths and use slash separators to match Git. */
function filesWithoutSymbols(graph: RepositoryGraph, cwd: string, files: string[]): string[] {
  const containerLabel = /^(file|folder|directory|package|project|module)$/i
  const symbols = graph.nodes.filter(node => node.labels.some(label => !containerLabel.test(label)))
  const indexed = new Set(symbols.map(({ filePath }) => {
    const targetPath = isAbsolute(filePath) ? relative(cwd, filePath) : filePath
    return targetPath.split(sep).join('/')
  }))
  return files.filter(file => !indexed.has(file))
}
