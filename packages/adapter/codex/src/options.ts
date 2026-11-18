import type { HarnessProcess, HarnessProcessOptions } from '@anureo/sdk/process'
import type { JsonlOptions } from './jsonl'

/** Configure executable launch and resource limits for the adapter or read-only catalog. */
export interface CodexAdapterOptions extends JsonlOptions {
  /** Executable path or command name passed to the process launcher. */
  command: string;
  /** Native server arguments; defaults to ['app-server'], while version probing always uses ['--version']. */
  args?: string[];
  /** Default working directory for version probing, standalone reads and the catalog. Session opens supply their own cwd. */
  cwd?: string;
  /** Environment passed to the process factory, including any explicitly selected Codex home. */
  env?: Record<string, string | undefined>;
  /** A nonempty override skips the adapter's --version launch. The first matching major.minor.patch is used, or the original text is preserved. Omission or empty text probes the executable. */
  version?: string;
  /** Supply an alternate launcher. The adapter or catalog takes responsibility for disposing each returned process. Launch rejection propagates to the operation. */
  processFactory?: (options: HarnessProcessOptions) => Promise<HarnessProcess>;
  /** Receive CODEX_STDERR on a nonempty stderr chunk from a session, catalog, model discovery or reconciliation connection. */
  diagnostic?: (code: string) => void;
  /** Maximum mapped items from paged item history or turns from paged turn lists, default 10,000. These reads reject with HISTORY_LIMIT_EXCEEDED above the limit. */
  maxHistoryItems?: number;
  /** Deadline in milliseconds per adapter RPC or version read, default 30,000. The version deadline starts after process launch. The catalog uses its preparation context's deadline instead, default 10,000. */
  timeoutMs?: number;
  /** Separate limits for pending RPCs, unfinished RPC writes and submissions awaiting native execution evidence. Each defaults to 128 and rejects new work at capacity. */
  maxPending?: number;
  /** Native page size for paged history requests (`thread/items/list`, `thread/turns/list`); defaults to 50 so one native response frame stays well under the transport limit even when items are large. */
  nativePageLimit?: number;
  /** Serialized byte budget for one public history page; defaults to 4MiB, and every page still carries at least one item so cursors progress. */
  maxPageBytes?: number;
}
