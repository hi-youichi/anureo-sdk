// Launch and extension contracts shared by native adapter and catalog consumers.
import type { query, getSessionMessages, getSessionInfo, forkSession, Query, SDKMessage, SessionStore } from "@anthropic-ai/claude-agent-sdk";

/** Implement message iteration, session controls and discovery for an injected Claude backend.
 * The adapter/catalog owns and closes each returned query. Session cleanup also awaits an optional
 * native return() method; close alone must end message iteration for backends without that method. */
export type ClaudeQuery = AsyncIterable<SDKMessage> & Pick<Query, "interrupt" | "setModel" | "setPermissionMode" | "setMaxThinkingTokens" | "applyFlagSettings" | "rewindFiles" | "supportedModels" | "close">;
/** Supply a native-compatible query for adapter sessions or prompt-less catalog discovery.
 * Each returned query is owned and closed by the caller; factory failures propagate to that operation. */
export type ClaudeQueryFactory = (params: Parameters<typeof query>[0]) => ClaudeQuery;
/** Configure native launch, state and test/host extensions for Claude adapters and catalogs.
 * Construction reads host configuration; initialization validates it without launching Claude.
 * Native queries begin with discovery or session operations.
 * The client owns adapter disposal; direct catalog callers own catalog disposal. */
export interface ClaudeAdapterOptions {
  /** Native executable path; takes precedence over the executable alias. */
  command?: string;
  /** Alias for command when command is omitted; omission of both uses the native SDK executable. */
  executable?: string;
  /** Extra child arguments appended after the native SDK arguments. */
  args?: string[];
  /** Explicit launch environment layered over the adapter's platform-essential variables. */
  env?: Record<string, string | undefined>;
  /** Adapter state directory, defaulting to env.CLAUDE_CONFIG_DIR; also selects native home unless defaultHome. */
  stateDir?: string;
  /** Suppress the stateDir native-home override while retaining adapter storage. Explicit
   * env.CLAUDE_CONFIG_DIR still applies; otherwise the CLI uses its default home and login. */
  defaultHome?: boolean;
  /** Replace native query creation for host integrations or scripted tests; adapter/catalog cleanup owns each returned query. */
  queryFactory?: ClaudeQueryFactory;
  /** Inject an opaque native store instead of the state-directory store; the host retains its lifecycle. */
  sessionStore?: SessionStore;
  /** Replace native history reads used by fork setup, history pages and revert boundaries.
   * Receives the selected store and cwd; read rejections propagate to the requesting operation. */
  getSessionMessages?: typeof getSessionMessages;
  /** Replace title reads after resume, committed main-store appends and terminal results.
   * Read failures publish a best-effort warning; they do not fail a committed append or turn. */
  getSessionInfo?: typeof getSessionInfo;
  /** Replace native transcript copying for fork and conversation revert at a verified cutoff.
   * Return the destination sessionId; rejection fails setup/revert, with partial scope if files changed. */
  forkSession?: typeof forkSession;
  /** Enable native file checkpoints/revert; defaults to false. History/conversation support also requires a store. */
  enableFileCheckpointing?: boolean;
  /** Script-based external executables can specify the interpreter; native binaries need none. */
  executableRuntime?: "node" | "bun" | "deno";
}
