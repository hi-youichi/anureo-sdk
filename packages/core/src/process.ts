// Owns harness subprocess I/O, exit observation, and process-tree cleanup.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/** Child exit status observed independently of output EOF. */
export type ProcessExit = {
  /** Exit status, or null for signal termination or startup failure. */
  code: number | null;
  /** Terminating signal, or null for normal exit or startup failure. */
  signal: string | null;
  /** Native code, if supplied, when the exit observer receives a child error without a PID. */
  errorCode?: string;
};

/** Configure a shell-free harness launch and choose who is responsible for terminating the child. */
export interface HarnessProcessOptions {
  /** Executable path or name. Empty strings and NUL bytes are rejected before launch. */
  command: string;
  /** Literal argument vector, empty by default. Entries containing NUL bytes are rejected before launch. */
  args?: readonly string[];
  /** Working directory for the child; omitted means the parent working directory. */
  cwd?: string;
  /** Complete environment for the child. Omit to inherit the parent environment. */
  env?: Record<string, string | undefined>;
  /** Defaults to true. Set to false when another owner will terminate the launched child. */
  owned?: boolean;
  /**
   * Grace period before escalation for an owned child. Accepts integer milliseconds from 0 to
   * 60,000 and defaults to 1000. Validated for either ownership mode.
   */
  shutdownTimeoutMs?: number;
}

/**
 * Local I/O handles for one harness process. Drain output and await disposal even after exit.
 * Custom process factories for the AHP, Codex, and Hermes adapters also supply this handle.
 * The adapter receiving it takes responsibility for disposal.
 */
export interface HarnessProcess {
  /** PID captured at launch and retained after exit. */
  readonly pid: number;
  /** True when this handle is responsible for terminating the process tree on disposal. */
  readonly owned: boolean;
  /** Child stdout bytes; callers should drain buffered output before disposal. */
  readonly stdout: AsyncIterable<Uint8Array>;
  /** Child stderr bytes; callers should drain buffered output before disposal. */
  readonly stderr: AsyncIterable<Uint8Array>;
  /**
   * Resolves with status on child exit or an observed child error without a PID. Read the output
   * streams through EOF to collect buffered bytes.
   */
  readonly exited: Promise<ProcessExit>;
  /**
   * Write once to stdin and resolve when its native write callback completes, without waiting for
   * the peer to consume the bytes. Reject with PROCESS_WRITE_FAILED if the input is closed, exit
   * has been observed, disposal has started, or the native write callback reports an error.
   */
  write(chunk: string | Uint8Array): Promise<void>;
  /**
   * End stdin after queued writes. Await writes first to observe each write's outcome. Resolve when
   * the native end callback completes, or immediately if input is already ending or destroyed.
   * A native close callback error rejects with PROCESS_WRITE_FAILED. Output and exit remain observable.
   */
  closeInput(): Promise<void>;
  /**
   * Release local stdin, stdout, and stderr even when termination fails. Drain buffered output first.
   * For an owned child, terminate the tree, escalating as needed, then allow up to 1000 ms for any
   * pending child exit observation. Termination failure or a missing exit observation rejects with
   * PROCESS_DISPOSE_FAILED. For an external child, unref it and release the pipes without waiting for
   * exit. Every call returns the same promise, including after rejection.
   */
  dispose(): Promise<void>;
}

/** Process failure category for adapters; native causes are reduced to a format-checked code. */
export class ProcessPortError extends Error {
  /**
   * Construct a failure using caller-supplied safe message text, which is retained verbatim.
   * Supply a native cause to retain only its format-checked error code.
   */
  constructor(code: ProcessPortError['code'], message: string, options?: ErrorOptions) {
    // Native spawn errors contain spawnargs. Never retain their raw cause in a public error.
    super(message);
    this.name = 'ProcessPortError';
    this.code = code;
    const nativeCode = readNativeErrorCode(options?.cause);
    if (nativeCode !== undefined) this.nativeCode = nativeCode;
  }
  /** Stable category for adapter startup, input, or disposal failures. */
  readonly code: 'HARNESS_UNAVAILABLE' | 'PROCESS_WRITE_FAILED' | 'PROCESS_DISPOSE_FAILED';
  /**
   * Native code of 1 to 64 characters, beginning with an uppercase letter and containing only
   * uppercase letters, digits, and underscores.
   */
  readonly nativeCode?: string;
}

/**
 * Launch a harness executable directly with piped I/O and literal arguments, without a shell.
 * Resolve after the spawn event provides a process handle. The caller handles protocol readiness.
 * Invalid inputs or launch failures reject with HARNESS_UNAVAILABLE. Failed startup releases any
 * local pipes it acquired. Drain output and await disposal even after child exit.
 *
 * ACP's processStream awaits launch to wire the pipes into its channel, propagates launch
 * rejection, and delegates channel disposal to the handle.
 */
export async function spawnHarnessProcess(options: HarnessProcessOptions): Promise<HarnessProcess> {
  const timeoutMs = validateProcessOptions(options);
  const owned = options.owned ?? true;
  const child = launchProcess({ options, owned });
  const initialPid = child.pid;
  const exit = observeProcessExit(child);
  // Prevent an unhandled pipe error if a peer closes while the caller isn't writing.
  child.stdin.on('error', () => {});
  const pid = await waitForSpawn(child, initialPid);
  return createProcessHandle({ child, pid, owned, timeoutMs, ...exit });
}

/**
 * Return the validated grace period for disposal. Throw HARNESS_UNAVAILABLE for an empty
 * executable, NUL bytes in the executable or arguments, or an invalid timeout. spawnHarnessProcess
 * calls this before launching the child.
 */
function validateProcessOptions(options: HarnessProcessOptions): number {
  if (!options.command || options.command.includes('\0') || options.args?.some((arg) => arg.includes('\0'))) {
    throw new ProcessPortError('HARNESS_UNAVAILABLE', 'Invalid harness executable or argument');
  }
  const timeoutMs = options.shutdownTimeoutMs ?? 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
    throw new ProcessPortError('HARNESS_UNAVAILABLE', 'Invalid process shutdown timeout');
  }
  return timeoutMs;
}

/**
 * Open piped stdio for a shell-free launch. Detach owned POSIX children so teardown can signal
 * their whole group. Convert synchronous spawn failures to HARNESS_UNAVAILABLE. spawnHarnessProcess
 * installs the event observers after this returns.
 */
function launchProcess({ options, owned }: { options: HarnessProcessOptions; owned: boolean }): ChildProcessWithoutNullStreams {
  try {
    return spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'],
      detached: owned && process.platform !== 'win32', shell: false, windowsHide: true,
    });
  } catch (cause) {
    throw new ProcessPortError('HARNESS_UNAVAILABLE', 'Unable to start harness executable', { cause });
  }
}

/** Shared exit state for stdin admission and disposal, both of which can run after spawn returns. */
interface ProcessExitObservation {
  readonly exited: Promise<ProcessExit>;
  readonly didExit: () => boolean;
}

/**
 * Register child exit and error listeners before spawnHarnessProcess awaits startup. Update the exit
 * flag before resolving so writes and teardown can consult the observation immediately.
 */
function observeProcessExit(child: ChildProcessWithoutNullStreams): ProcessExitObservation {
  let didExit = false;
  const exited = new Promise<ProcessExit>((resolve) => {
    child.once('exit', (code, signal) => {
      didExit = true;
      resolve({ code, signal });
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (!child.pid) {
        didExit = true;
        resolve({ code: null, signal: null, errorCode: error.code });
      }
    });
  });
  return { exited, didExit: () => didExit };
}

/**
 * Wait for the spawn event and retain its PID before the runtime can clear it on exit. Fall back
 * to the initial PID if the event provides no usable PID. On failure, release the pipes and
 * reject with HARNESS_UNAVAILABLE so spawnHarnessProcess never publishes a partial handle.
 */
async function waitForSpawn(child: ChildProcessWithoutNullStreams, initialPid: number | undefined): Promise<number> {
  let pid = initialPid;
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => {
        const spawnPid = child.pid;
        if (spawnPid !== undefined && spawnPid > 1) pid = spawnPid;
        resolve();
      });
      child.once('error', reject);
    });
  } catch (cause) {
    return failProcessStartup(child, cause);
  }
  if (pid === undefined || pid <= 1) return failProcessStartup(child);
  return pid;
}

/** Release startup's local pipes before rejecting launch with a privacy-safe error. */
function failProcessStartup(child: ChildProcessWithoutNullStreams, cause?: unknown): never {
  destroyProcessStreams(child);
  throw new ProcessPortError('HARNESS_UNAVAILABLE', 'Unable to start harness executable', { cause });
}

/** Close all three local pipes after failed startup or after disposal, even if termination failed. */
function destroyProcessStreams(child: ChildProcessWithoutNullStreams): void {
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}

/** Resources transferred to the handle after spawn, including the PID retained for teardown. */
interface ProcessResources extends ProcessExitObservation {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pid: number;
  readonly owned: boolean;
  readonly timeoutMs: number;
}

/**
 * Give spawnHarnessProcess's callers the pipes and exit observation. Keep stdin write admission
 * and the teardown promise together so disposing closes admission and shares the cleanup outcome.
 */
function createProcessHandle(resources: ProcessResources): HarnessProcess {
  const { child, pid, owned, didExit, exited } = resources;
  const { stdin, stdout, stderr } = child;
  let disposePromise: Promise<void> | undefined;
  return {
    pid, owned, stdout, stderr, exited,
    write(chunk) {
      if (disposePromise || isInputClosed(stdin) || didExit()) {
        return Promise.reject(new ProcessPortError('PROCESS_WRITE_FAILED', 'Harness process input is closed'));
      }
      return runInputOperation('Unable to write harness input', (complete) => {
        stdin.write(chunk, complete);
      });
    },
    closeInput() {
      return runInputOperation('Unable to close harness input', (complete) => {
        if (isInputClosed(stdin)) complete();
        else stdin.end(complete);
      });
    },
    dispose() {
      return disposePromise ??= disposeProcess(resources);
    },
  };
}

/** Treat ending as closed for writes and redundant close requests. */
function isInputClosed(stdin: ChildProcessWithoutNullStreams['stdin']): boolean {
  return stdin.destroyed || stdin.writableEnded;
}

/**
 * Settle the handle's write or close promise from the callback passed to stdin. Convert callback
 * errors to PROCESS_WRITE_FAILED and let synchronous exceptions reject through the promise executor.
 */
function runInputOperation(
  failureMessage: string,
  start: (complete: (error?: Error | null) => void) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    start((error) => {
      if (error) reject(new ProcessPortError('PROCESS_WRITE_FAILED', failureMessage, { cause: error }));
      else resolve();
    });
  });
}

/**
 * createProcessHandle's dispose method caches this promise. Terminate owned trees or unref
 * external processes, then destroy local pipes even on failure. Convert native termination or
 * unref errors to a ProcessPortError containing only safe error details.
 */
async function disposeProcess({ child, pid, owned, timeoutMs, didExit, exited }: ProcessResources): Promise<void> {
  try {
    if (owned) {
      await terminateTree(pid, timeoutMs, didExit);
      if (!didExit()) await waitForTerminatedProcessExit(didExit, exited);
    } else {
      child.unref();
    }
  } catch (cause) {
    if (cause instanceof ProcessPortError) throw cause;
    throw new ProcessPortError('PROCESS_DISPOSE_FAILED', 'Unable to dispose harness process', { cause });
  } finally {
    destroyProcessStreams(child);
  }
}

/**
 * After tree termination, disposeProcess allows 1000 ms for any pending child exit observation.
 * A vanished group can precede the child exit event. Reject PROCESS_DISPOSE_FAILED if exit still
 * has not been observed.
 */
async function waitForTerminatedProcessExit(didExit: () => boolean, exited: Promise<ProcessExit>): Promise<void> {
  await Promise.race([exited, delay(1000)]);
  if (!didExit()) throw new ProcessPortError('PROCESS_DISPOSE_FAILED', 'Harness process did not exit after termination');
}

/**
 * disposeProcess awaits this only for owned children and sanitizes failures before rejecting its
 * public dispose promise. Validate the retained PID, then delegate platform cleanup; callers retain
 * ownership of exit observation and pipe destruction.
 */
async function terminateTree(pid: number, timeoutMs: number, didExit: () => boolean): Promise<void> {
  // Bun may clear/change ChildProcess.pid after exit. Only use the original positive PID.
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new ProcessPortError('PROCESS_DISPOSE_FAILED', 'Invalid original harness PID');
  if (process.platform === 'win32') return terminateWindowsTree(pid, timeoutMs, didExit);
  return terminatePosixTree(pid, timeoutMs);
}

/**
 * terminateTree delegates here on POSIX; exit observation and pipe destruction remain in
 * disposeProcess. Stop the detached POSIX group and force remaining descendants after the grace
 * period.
 */
async function terminatePosixTree(pid: number, timeoutMs: number): Promise<void> {
  // Descendants can keep inherited pipes open after the direct child has exited.
  const group = -pid;
  await signalGroupWithExitRace(group, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (processOrGroupExists(group) && Date.now() < deadline) await delay(10);
  if (processOrGroupExists(group)) await signalGroupWithExitRace(group, 'SIGKILL');
}

/**
 * Signal the negative group PID for terminatePosixTree. A vanished group completes the attempt.
 * Retry a short exit-time EPERM race up to four times, then propagate the failure to disposal.
 */
async function signalGroupWithExitRace(group: number, signal: NodeJS.Signals): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      process.kill(group, signal);
      return;
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code === 'ESRCH') return;
      if (code !== 'EPERM' || attempt >= 4) throw error;
      await delay(10);
    }
  }
}

/**
 * Stop the Windows tree for terminateTree. Attempt graceful taskkill while the child is still
 * running. Escalate immediately if that attempt fails and exit is still pending, or after the
 * grace period if the child remains alive. Forced taskkill failures reject teardown.
 */
async function terminateWindowsTree(pid: number, timeoutMs: number, didExit: () => boolean): Promise<void> {
  if (!didExit()) {
    try {
      await windowsKillTree(pid, 'graceful');
    } catch {
      // Console-less Windows children may reject non-forced taskkill, so retry while alive.
      if (!didExit()) await windowsKillTree(pid, 'force');
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (!didExit() && Date.now() < deadline) await delay(10);
  if (!didExit()) await windowsKillTree(pid, 'force');
}

/**
 * Run shell-free taskkill for terminateWindowsTree. Reject if the tool fails to start or exits
 * unsuccessfully while the original PID is still present.
 */
async function windowsKillTree(pid: number, mode: 'graceful' | 'force'): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', ...(mode === 'force' ? ['/F'] : [])], {
      stdio: 'ignore', windowsHide: true, shell: false,
    });
    killer.once('error', reject);
    killer.once('exit', (code) => {
      // taskkill reports a nonzero result if the process exited during the call.
      if (code === 0 || !processOrGroupExists(pid)) resolve();
      else reject(new ProcessPortError('PROCESS_DISPOSE_FAILED', 'Unable to terminate harness process tree'));
    });
  });
}

/**
 * terminatePosixTree uses this for POSIX polling; windowsKillTree uses it to distinguish a taskkill
 * failure from concurrent child exit. Probe a PID or negative POSIX group without signalling it; EPERM
 * counts as existing so cleanup still escalates.
 */
function processOrGroupExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Extract only a bounded uppercase code for ProcessPortError; a native cause may contain private
 * spawn arguments and must never become part of the public error.
 */
function readNativeErrorCode(cause: unknown): string | undefined {
  if (!cause || typeof cause !== 'object' || !('code' in cause)) return undefined;
  if (typeof cause.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(cause.code)) return undefined;
  return cause.code;
}
