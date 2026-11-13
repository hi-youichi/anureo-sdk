/** Defines host launch and resource-limit inputs shared by adapter and catalog owners; it must not launch processes or negotiate capabilities. */
import type { HarnessProcess, HarnessProcessOptions } from '@anureo/sdk/process'
import type { JsonlOptions } from './jsonl'

/** Host construction contract retained by adapter/catalog owners, without validation or I/O here. Each launched process belongs to its calling owner; changing these settings does not reset an adapter's cached initialization. */
export interface CodexAdapterOptions extends JsonlOptions {
  /** Executable selected by the host; never inferred from account state. */
  command: string;
  /** Native server arguments; defaults to ['app-server'], while version probing always uses ['--version']. */
  args?: string[];
  /** Default working directory for discovery processes; session opening supplies its own cwd. */
  cwd?: string;
  /** Environment passed to the process factory, including any explicitly selected Codex home. */
  env?: Record<string, string | undefined>;
  /** Trusted version override that skips --version; semantic-version suffixes normalize, otherwise text is preserved for profile selection. */
  version?: string;
  /** Optional injected launcher; each returned process becomes the calling owner’s cleanup responsibility. */
  processFactory?: (options: HarnessProcessOptions) => Promise<HarnessProcess>;
  /** Receives safe diagnostic codes only; raw native stderr and request data are excluded. */
  diagnostic?: (code: string) => void;
  /** Maximum retained items or paged turns per history read; defaults to 10,000. */
  maxHistoryItems?: number;
}
