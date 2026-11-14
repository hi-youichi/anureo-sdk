// Host contracts for connecting an ACP agent and supplying resources and permissions.
import type * as acp from '@agentclientprotocol/sdk';
import type { JsonObject, SessionBinding } from '@anureo/protocol';

/** Host-supplied ACP filesystem callbacks, registered only for provided operations.
 * AcpAdapter validates the session before invoking a callback for a peer request.
 * Hosts enforce path and access policy and return native responses.
 * Callback rejections fail the peer request. */
export interface AcpFileSystemPort {
  /** Read the requested native range as text; the host applies path policy. */
  readTextFile?: (params: acp.ReadTextFileRequest) => Promise<acp.ReadTextFileResponse>;
  /** Resolve after the requested write completes; undefined is normalized by the ACP SDK. */
  writeTextFile?: (params: acp.WriteTextFileRequest) => Promise<acp.WriteTextFileResponse | void>;
}
/** Host-supplied terminal operations for handling ACP peer requests. AcpAdapter checks session
 * ownership and requires a tracked terminal ID for operations on existing terminals.
 * Successful creation makes the session track the returned ID. Explicit release or session disposal calls
 * releaseTerminal. Hosts own process/access policy and must finish each operation before resolving. */
export interface AcpTerminalPort {
  /** Resolve with a session-local terminal ID after creation; subsequent operations use that ID. */
  createTerminal(params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse>;
  /** Return retained terminal output and truncation/exit metadata without releasing the terminal. */
  terminalOutput(params: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse>;
  /** Release terminal resources; successful resolution removes the ID from adapter ownership. */
  releaseTerminal(params: acp.ReleaseTerminalRequest): Promise<acp.ReleaseTerminalResponse | void>;
  /** Wait for terminal completion and return exit information; the terminal still requires release. */
  waitForTerminalExit(params: acp.WaitForTerminalExitRequest): Promise<acp.WaitForTerminalExitResponse>;
  /** Request terminal termination; the terminal remains owned until release. */
  killTerminal(params: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse | void>;
}
/** An owned ACP message transport returned by connect. The adapter locks its streams and calls dispose
 * during adapter teardown, including teardown racing connection setup; hosts implement resource release. */
export interface AcpChannel {
  /** Official ACP message stream; the adapter owns its reader/writer locks. */
  stream: acp.Stream;
  /** Release transport resources. Rejection contributes to adapter release failure during teardown. */
  dispose(): Promise<void>;
  /** Optional redacted diagnostics captured so far; injected transports may also supply this hook. */
  diagnostics?(): string;
}
/** One-shot permission policy choices; selection is limited to an option actually offered by the peer. */
export type AcpPermissionDecision = 'allow-once' | 'reject-once';
/** Native permission request supplied to a host policy before interactive fallback.
 * IDs belong to the ACP peer; rawInput is unprojected provider data and must be handled accordingly. */
export interface AcpPermissionContext {
  /** Native ID of the session that owns this request. */
  sessionId: string;
  /** Native tool call awaiting a permission decision. */
  toolCallId: string;
  /** Optional display title supplied by the peer. */
  title?: string;
  /** Optional native tool category, independent of the offered permission kinds. */
  kind?: string;
  /** Peer-provided tool arguments before projection. They can contain private values. */
  rawInput?: unknown;
  /** Options actually offered by the agent; a policy never fabricates an optionId. */
  options: readonly acp.PermissionOption[];
  /** Native request cancellation signal; policies own cancellation of any host work they start. */
  signal: AbortSignal;
}
/** Answer a native permission request directly, or return undefined to ask through the session sink.
 * Policy throws/rejections fail the native request; the adapter does not retry the policy. */
export type AcpPermissionPolicy =
  | AcpPermissionDecision
  | ((context: AcpPermissionContext) => AcpPermissionDecision | undefined | Promise<AcpPermissionDecision | undefined>);
/** Configure a spawned ACP agent or an injected message transport and optional host resource policies. */
export interface AcpAdapterOptions {
  /** Executable for stdio; required when connect is omitted. */
  command?: string;
  /** Arguments passed to the executable; omitted arguments use the process helper's empty list. */
  args?: readonly string[];
  /** Working directory for the child process. Omission inherits the host working directory.
   * Each session supplies its own cwd independently. */
  cwd?: string;
  /** Complete child environment; omission inherits the host environment. */
  env?: Record<string, string | undefined>;
  /** Advertise only supplied read/write operations; the host retains access-policy responsibility. */
  fs?: AcpFileSystemPort;
  /** Advertise terminal support; the host implements all lifecycle operations. */
  terminal?: AcpTerminalPort;
  /** Supply an owned ACP channel for initialization. Takes precedence over spawning command.
   * A rejected factory rejects initialization. The adapter disposes a successfully returned channel. */
  connect?: () => Promise<AcpChannel>;
  /** Deadline in milliseconds for AcpAdapter.call. Defaults to 30,000. The normal session prompt
   * path waits separately. Expiry ends the wait while native work may continue. */
  requestTimeoutMs?: number;
  /** Incoming/outgoing stdio line limit in bytes, excluding newline; defaults to 8 MiB. Not applied to connect streams. */
  maxFrameBytes?: number;
  /** Maximum retained stderr lines for spawned agents. Defaults to 200. Zero disables capture and callbacks. */
  stderrTailLines?: number;
  /** Receive redacted stderr lines, including bounded chunks for oversized lines. Callback throws are ignored. */
  onStderr?: (line: string) => void;
  /**
   * Answer `session/request_permission` without surfacing an AHP interaction.
   * Returning undefined (or a kind the agent did not offer) falls back to the
   * interactive path. Auto decisions are reported as `ACP_PERMISSION_AUTO_ANSWERED`
   * notices so they remain auditable.
   */
  autoRespondPermission?: AcpPermissionPolicy;
  /**
   * Receive nonempty resume/load snapshots after identity/configuration capture and before initial overrides.
   * Historical updates have no turn boundaries; title updates instead enter session metadata.
   * Return synchronously. AcpAdapter skips awaiting the callback, and a synchronous throw rejects
   * session open and removes its local indexes.
   */
  onLoadSnapshot?: (binding: SessionBinding, updates: readonly JsonObject[]) => void;
}
