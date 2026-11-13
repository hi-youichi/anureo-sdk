// Owns harness subprocess I/O, exit observation, and process-tree cleanup.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/** Exit observation, independent of output EOF; startup errors carry a native code without arguments or messages. */
export type ProcessExit = {
  /** Exit status, or null for signal termination or startup failure. */
  code: number | null;
  /** Terminating signal, or null for normal exit or startup failure. */
  signal: string | null;
  /** Native error code when an error is observed without a child PID. */
  errorCode?: string;
};

/** Direct executable launch and ownership policy; shell parsing is disabled and shutdown timeout bounds the graceful termination phase. */
export interface HarnessProcessOptions {
  /** Executable path/name passed directly to the OS without shell interpretation. */
  command: string;
  /** Literal argument vector; each entry is preserved as one argument. */
  args?: readonly string[];
  /** Working directory for the child; omitted means the parent working directory. */
  cwd?: string;
  /** A complete child environment; omitted means inherit. Never mutates the parent environment. */
  env?: Record<string, string | undefined>;
  /** Defaults to true; false leaves termination to an external owner while this handle still owns its pipes. */
  owned?: boolean;
  /** Grace period for owned-tree termination; defaults to 1000 ms, accepts integer milliseconds in 0..60000. */
  shutdownTimeoutMs?: number;
}

/** Local I/O handles for one harness process; drain output and await disposal even after the process exits. */
export interface HarnessProcess {
  /** Original positive PID, retained even if the runtime clears child.pid after exit. */
  readonly pid: number;
  /** True when this handle is responsible for terminating the process tree on disposal. */
  readonly owned: boolean;
  /** Child stdout bytes; callers should drain buffered output before disposal. */
  readonly stdout: AsyncIterable<Uint8Array>;
  /** Child stderr bytes; callers should drain buffered output before disposal. */
  readonly stderr: AsyncIterable<Uint8Array>;
  /** Resolves without rejecting at exit (or startup error without a PID); output EOF and disposal are separate. */
  readonly exited: Promise<ProcessExit>;
  /**
   * Write once to stdin and resolve when its native write callback completes, without waiting for
   * the peer to consume the bytes. Reject closed, exited, or disposing input and native write failure
   * with PROCESS_WRITE_FAILED; no retries are performed.
   */
  write(chunk: string | Uint8Array): Promise<void>;
  /**
   * End stdin after queued writes; await writes before calling. Resolve on the native end callback,
   * or immediately if input is already ending or destroyed; reject native close failure with
   * PROCESS_WRITE_FAILED. Output and process exit remain independently observable.
   */
  closeInput(): Promise<void>;
  /**
   * Share one teardown promise across calls. Terminate an owned process tree and observe child exit;
   * otherwise unref without signalling or waiting for exit. Owned cleanup escalates when needed
   * and allows a further 1000 ms for child exit observation, rejecting PROCESS_DISPOSE_FAILED
   * if cleanup fails or the child still has not exited. Failure is cached rather than retried.
   * Always destroys local stdin/stdout/stderr streams, regardless of ownership or
   * termination success. Drain buffered output before disposal.
   */
  dispose(): Promise<void>;
}

/** Process failure category for adapters; native causes are reduced to an allowlisted code. */
export class ProcessPortError extends Error {
  /** Stable adapter-facing category; native error messages are not exposed. */
  readonly code: 'HARNESS_UNAVAILABLE' | 'PROCESS_WRITE_FAILED' | 'PROCESS_DISPOSE_FAILED';
  /** Safe OS error code extracted without retaining raw spawn arguments or causes. */
  readonly nativeCode?: string;
  /**
   * Construct a failure using caller-supplied safe message text, which is retained verbatim.
   * Inspect the optional native cause for a code, but never retain its message, arguments, or cause.
   */
  constructor(code: ProcessPortError['code'], message: string, options?: ErrorOptions) {
    // Native spawn errors contain spawnargs. Never retain their raw cause in a public error.
    super(message);
    this.name = 'ProcessPortError';
    this.code = code;
    const cause = options?.cause;
    if (cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(cause.code)) this.nativeCode = cause.code;
  }
}

/**
 * Launch a harness executable directly with piped I/O and literal arguments, without a shell.
 * Resolve after the OS spawn event, without waiting for protocol readiness. Invalid inputs or launch
 * failures reject with HARNESS_UNAVAILABLE and release local pipes acquired during failed startup.
 * Adapter consumers must drain output and await dispose, including after child exit; owned processes
 * default to tree termination on disposal, while external owners remain responsible for termination.
 */
export async function spawnHarnessProcess(options: HarnessProcessOptions): Promise<HarnessProcess> {
  const timeoutMs = validateProcessOptions(options);
  const owned = options.owned ?? true;
  const child = launchProcess({ options, owned });
  const observation = observeProcess(child);
  let disposePromise: Promise<void> | undefined;
  // Prevent an unhandled pipe error if a peer closes while the caller isn't writing.
  child.stdin.on('error', () => {});
  const pid = await waitForSpawn(child, observation);
  return {
    pid, owned, stdout: child.stdout, stderr: child.stderr, exited: observation.exited,
    /** Write to live stdin and resolve its native callback; reject closed/disposed/exited input or OS write failure without retrying. */
    write(chunk) {
      if (disposePromise || child.stdin.destroyed || child.stdin.writableEnded || observation.didExit()) {
        return Promise.reject(new ProcessPortError('PROCESS_WRITE_FAILED', 'Harness process input is closed'));
      }
      return new Promise<void>((resolve, reject) => {
        child.stdin.write(chunk, (error?: Error | null) => error
          ? reject(new ProcessPortError('PROCESS_WRITE_FAILED', 'Unable to write harness input', { cause: error }))
          : resolve());
      });
    },
    closeInput: () => closeProcessInput(child),
    /**
     * Cache tree teardown, escalate owned children, and always destroy all local pipes; unowned
     * children are unrefed without waiting. Reject sanitized cleanup failure.
     */
    dispose() {
      return disposePromise ??= disposeProcess({ child, pid, owned, timeoutMs, didExit: observation.didExit, exited: observation.exited });
    },
  };
}

/**
 * processGroupExists uses this for POSIX polling; windowsKillTree uses it to distinguish a taskkill
 * failure from concurrent child exit. Probe a PID or negative POSIX group without signalling it; EPERM
 * counts as existing so cleanup still escalates.
 */
function processOrGroupExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * terminatePosixTree polls this during the graceful phase and before escalation. Probe the original
 * POSIX group, including descendants that can outlive the direct child.
 */
function processGroupExists(processGroupId: number): boolean {
  return processOrGroupExists(-processGroupId);
}

/**
 * signalGroupWithExitRace calls this for each bounded attempt. Signal the original POSIX group; ignore
 * vanished groups and propagate other OS failures to the cleanup owner.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/**
 * terminatePosixTree awaits this for SIGTERM and any SIGKILL escalation. Signal a POSIX group with
 * short bounded retries for exit-time EPERM races; propagate persistent permission or other OS
 * failure.
 */
async function signalGroupWithExitRace(pid: number, signal: NodeJS.Signals): Promise<void> {
  // A source can close its pipes just before process exit is delivered. Give that
  // short race time to settle; a persistent permission failure is still an error.
  for (let attempt = 0; ; attempt++) {
    try { signalGroup(pid, signal); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= 4) throw error;
      await delay(10);
    }
  }
}

/**
 * terminateWindowsTree awaits this for graceful or forced teardown. Run taskkill without a shell for
 * the original child/tree; reject spawn or persistent nonzero failure, allowing concurrent exit races.
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
 * terminateTree delegates here on win32 using the exit observation supplied by observeProcess.
 * Gracefully stop the Windows tree, escalating when taskkill or the grace period leaves the child
 * alive.
 */
async function terminateWindowsTree(pid: number, timeoutMs: number, didExit: () => boolean): Promise<void> {
  if (!didExit()) {
    try { await windowsKillTree(pid, 'graceful'); }
    catch {
      // Console-less Windows children may reject non-forced taskkill, so retry while alive.
      if (!didExit()) await windowsKillTree(pid, 'force');
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (!didExit() && Date.now() < deadline) await delay(10);
  if (!didExit()) await windowsKillTree(pid, 'force');
}

/**
 * terminateTree delegates here on POSIX; exit observation and pipe destruction remain in
 * disposeProcess. Stop the detached POSIX group and force remaining descendants after the grace
 * period.
 */
async function terminatePosixTree(pid: number, timeoutMs: number): Promise<void> {
  // A detached POSIX child leads its own group. Kill the group, not only its parent.
  // Children holding inherited pipes must not keep either the stream or SDK alive.
  await signalGroupWithExitRace(pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid) && Date.now() < deadline) await delay(10);
  if (processGroupExists(pid)) await signalGroupWithExitRace(pid, 'SIGKILL');
}

/**
 * spawnHarnessProcess uses the returned timeout for later disposal and propagates validation failure
 * without launching. Validate spawn inputs before any OS effect; reject malformed executable,
 * arguments, or shutdown timeout.
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
 * spawnHarnessProcess calls this after input validation, then installs exit observation and waits for
 * spawn. Start a direct, shell-free child with piped stdio; synchronous OS launch errors become
 * privacy-safe failures.
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

/** Lifecycle observations for one child; closures expose state without allowing callers to mutate it. */
interface ProcessObservation {
  readonly exited: Promise<ProcessExit>;
  readonly didExit: () => boolean;
  readonly originalPid: () => number | undefined;
  readonly recordSpawn: () => void;
}

/**
 * spawnHarnessProcess registers exit/error listeners here before waiting for spawn. Its returned
 * handle exposes the non-rejecting exit promise and uses didExit for write admission and disposal.
 * Retain the spawn-time PID because runtimes may clear or change child.pid after exit.
 */
function observeProcess(child: ChildProcessWithoutNullStreams): ProcessObservation {
  let didExit = false;
  let originalPid = child.pid;
  const exited = new Promise<ProcessExit>((resolve) => {
    child.once('exit', (code, signal) => { didExit = true; resolve({ code, signal }); });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (!child.pid) { didExit = true; resolve({ code: null, signal: null, errorCode: error.code }); }
    });
  });
  return {
    exited,
    didExit: () => didExit,
    originalPid: () => originalPid,
    recordSpawn: () => { if (child.pid !== undefined && child.pid > 1) originalPid = child.pid; },
  };
}

/**
 * spawnHarnessProcess awaits this PID before returning its I/O handles. Wait for the spawn event,
 * recording its PID; on startup failure destroy every local pipe before rejecting.
 */
async function waitForSpawn(child: ChildProcessWithoutNullStreams, observation: ProcessObservation): Promise<number> {
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => { observation.recordSpawn(); resolve(); });
      child.once('error', reject);
    });
  } catch (cause) {
    destroyProcessStreams(child);
    throw new ProcessPortError('HARNESS_UNAVAILABLE', 'Unable to start harness executable', { cause });
  }
  const pid = observation.originalPid();
  if (pid === undefined || pid <= 1) {
    destroyProcessStreams(child);
    throw new ProcessPortError('HARNESS_UNAVAILABLE', 'Unable to start harness executable');
  }
  return pid;
}

/**
 * waitForSpawn calls this after failed startup; disposeProcess always calls it from finally. Destroy
 * local stdio handles; disposal uses this in finally so pipe cleanup survives termination errors.
 */
function destroyProcessStreams(child: ChildProcessWithoutNullStreams): void {
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}

/**
 * The HarnessProcess.closeInput callback returned by spawnHarnessProcess delegates here; adapters must
 * finish their writes before closing input. Idempotently end stdin after pending writes; reject native
 * close failures without terminating the child.
 */
function closeProcessInput(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.stdin.destroyed || child.stdin.writableEnded) { resolve(); return; }
    child.stdin.end((error?: Error | null) => error
      ? reject(new ProcessPortError('PROCESS_WRITE_FAILED', 'Unable to close harness input', { cause: error }))
      : resolve());
  });
}

/** Inputs needed for ordered process teardown; ownership chooses termination versus unref. */
interface ProcessDisposal {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pid: number;
  readonly owned: boolean;
  readonly timeoutMs: number;
  readonly didExit: () => boolean;
  readonly exited: Promise<ProcessExit>;
}

/**
 * The returned HarnessProcess.dispose caches this promise so repeated callers observe the same
 * teardown. Dispose once: terminate owned trees or unref external processes, then destroy local pipes
 * even on failure.
 */
async function disposeProcess({ child, pid, owned, timeoutMs, didExit, exited }: ProcessDisposal): Promise<void> {
  try {
    if (owned) {
      await terminateTree(pid, timeoutMs, didExit);
      if (!didExit()) await waitForTerminatedProcessExit(didExit, exited);
    } else child.unref();
  } catch (cause) {
    if (cause instanceof ProcessPortError) throw cause;
    throw new ProcessPortError('PROCESS_DISPOSE_FAILED', 'Unable to dispose harness process', { cause });
  } finally {
    destroyProcessStreams(child);
  }
}

/**
 * disposeProcess awaits this when owned-tree termination has not yet produced a child exit event:
 * a vanished group does not prove the direct child has exited. Allow up to 1000 ms, then reject failure;
 * disposeProcess still destroys the pipes in its finally block.
 */
async function waitForTerminatedProcessExit(didExit: () => boolean, exited: Promise<ProcessExit>): Promise<void> {
  await Promise.race([exited, delay(1000)]);
  if (!didExit()) throw new ProcessPortError('PROCESS_DISPOSE_FAILED', 'Harness process did not exit after termination');
}
