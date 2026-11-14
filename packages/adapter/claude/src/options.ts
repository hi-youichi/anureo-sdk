// Launch and extension contracts shared by native adapter and catalog consumers.
import type { query, getSessionMessages, getSessionInfo, forkSession, Query, SDKMessage, SessionStore } from "@anthropic-ai/claude-agent-sdk";

/** Implement message iteration, session controls and discovery for an injected Claude backend.
 * End message iteration when the query closes. Session and catalog cleanup also await a native
 * return() method when present. One-shot ClaudeNativeAdapter.listModels calls close alone. */
export type ClaudeQuery = AsyncIterable<SDKMessage> & Pick<Query, "interrupt" | "setModel" | "setPermissionMode" | "setMaxThinkingTokens" | "applyFlagSettings" | "rewindFiles" | "supportedModels" | "close">;
/** Supply a native-compatible query for adapter sessions or prompt-less catalog discovery.
 * This factory runs synchronously for each query, including replacements. The operation that
 * invokes the factory owns its query and propagates startup failures according to its contract. */
export type ClaudeQueryFactory = (params: Parameters<typeof query>[0]) => ClaudeQuery;
/** Configure Claude launch, state storage and host-supplied query or transcript operations.
 * Initialization accepts an explicit Claude home, defaultHome or a custom query factory.
 * Native launch begins with discovery or a session open. Dispose the SDK client or catalog
 * after use and manage the lifecycle of any injected store separately. */
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
  /** Replace native transcript reads during fork setup, history snapshot creation and stored
   * revert-boundary lookup. Receives the session cwd and a wrapper around the selected store.
   * Read failures reject the operation that requested the transcript. */
  getSessionMessages?: typeof getSessionMessages;
  /** Replace title reads for resumed queries, committed main-session appends and terminal results.
   * Use the supplied session ID, cwd and optional store. Read failures trigger a best-effort warning. */
  getSessionInfo?: typeof getSessionInfo;
  /** Replace native transcript copying for fork and conversation revert when a cutoff entry exists.
   * Return the destination sessionId. Rejections fail the operation. A revert that already rewound
   * files reports REVERT_PARTIAL with the applied file scope. */
  forkSession?: typeof forkSession;
  /** Enable native file checkpoints/revert; defaults to false. History/conversation support also requires a store. */
  enableFileCheckpointing?: boolean;
  /** Script-based external executables can specify the interpreter; native binaries need none. */
  executableRuntime?: "node" | "bun" | "deno";
}
