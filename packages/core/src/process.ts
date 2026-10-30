import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export type ProcessExit = { code: number | null; signal: string | null; errorCode?: string };

export interface HarnessProcessOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** A complete child environment; omitted means inherit. Never mutates the parent environment. */
  env?: Record<string, string | undefined>;
  /** False for a process whose lifetime belongs to an external owner. */
  owned?: boolean;
  shutdownTimeoutMs?: number;
}

export interface HarnessProcess {
  readonly pid: number;
  readonly owned: boolean;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  /** Resolves at process exit; consumers may still drain buffered stdout/stderr. */
  readonly exited: Promise<ProcessExit>;
  write(chunk: string | Uint8Array): Promise<void>;
  closeInput(): Promise<void>;
  /** Idempotent: terminate an owned process tree, detach an externally owned process. */
  dispose(): Promise<void>;
}

export class ProcessPortError extends Error {
  readonly code: 'HARNESS_UNAVAILABLE' | 'PROCESS_WRITE_FAILED' | 'PROCESS_DISPOSE_FAILED';
  readonly nativeCode?: string;
  constructor(code: ProcessPortError['code'], message: string, options?: ErrorOptions) {
    // Native spawn errors contain spawnargs. Never retain their raw cause in a public error.
    super(message);
    this.name = 'ProcessPortError';
    this.code = code;
    const cause = options?.cause;
    if (cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(cause.code)) this.nativeCode = cause.code;
  }
}

function exists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

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

async function windowsKillTree(pid: number, force: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
      stdio: 'ignore', windowsHide: true, shell: false,
    });
    killer.once('error', reject);
    killer.once('exit', (code) => {
      // taskkill reports a nonzero result if the process exited during the call.
      if (code === 0 || !exists(pid)) resolve();
      else reject(new ProcessPortError('PROCESS_DISPOSE_FAILED', 'Unable to terminate harness process tree'));
    });
  });
}

async function terminateTree(child: ChildProcessWithoutNullStreams, pid: number, timeoutMs: number, didExit: () => boolean): Promise<void> {
  // Bun may clear/change ChildProcess.pid after exit. Only use the original positive PID.
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new ProcessPortError('PROCESS_DISPOSE_FAILED', 'Invalid original harness PID');
  if (process.platform === 'win32') {
    if (!didExit()) {
      try { await windowsKillTree(pid, false); }
      catch {
        // Console-less Windows children may reject non-forced taskkill.
        // Escalate while the original child is still alive, as after grace expiry.
        if (!didExit()) await windowsKillTree(pid, true);
      }
    }
    const deadline = Date.now() + timeoutMs;
    while (!didExit() && Date.now() < deadline) await delay(10);
    if (!didExit()) await windowsKillTree(pid, true);
    return;
  }
  // A detached POSIX child leads its own group. Kill the group, not only its parent.
  // Children holding inherited pipes must not keep either the stream or SDK alive.
  await signalGroupWithExitRace(pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (exists(-pid) && Date.now() < deadline) await delay(10);
  if (exists(-pid)) await signalGroupWithExitRace(pid, 'SIGKILL');
}

/** Node's child_process implementation is also supported by Bun; no shell parsing is involved. */
export async function spawnHarnessProcess(options: HarnessProcessOptions): Promise<HarnessProcess> {
  if (!options.command || options.command.includes('\0') || options.args?.some((arg) => arg.includes('\0'))) {
    throw new ProcessPortError('HARNESS_UNAVAILABLE', 'Invalid harness executable or argument');
  }
  const timeoutMs = options.shutdownTimeoutMs ?? 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
    throw new ProcessPortError('HARNESS_UNAVAILABLE', 'Invalid process shutdown timeout');
  }
  const owned = options.owned ?? true;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'],
      detached: owned && process.platform !== 'win32', shell: false, windowsHide: true,
    });
  } catch (cause) {
      throw new ProcessPortError('HARNESS_UNAVAILABLE', 'Unable to start harness executable', { cause });
  }
  let didExit = false;
  let originalPid = child.pid;
  let disposePromise: Promise<void> | undefined;
  const exited = new Promise<ProcessExit>((resolve) => {
    child.once('exit', (code, signal) => { didExit = true; resolve({ code, signal }); });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (!child.pid) { didExit = true; resolve({ code: null, signal: null, errorCode: error.code }); }
    });
  });
  // Prevent an unhandled pipe error if a peer closes while the caller isn't writing.
  child.stdin.on('error', () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => { if (child.pid !== undefined && child.pid > 1) originalPid = child.pid; resolve(); });
      child.once('error', reject);
    });
  } catch (cause) {
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    throw new ProcessPortError('HARNESS_UNAVAILABLE', 'Unable to start harness executable', { cause });
  }
  const pid = originalPid!;
  const closeInput = (): Promise<void> => new Promise((resolve, reject) => {
    if (child.stdin.destroyed || child.stdin.writableEnded) { resolve(); return; }
    child.stdin.end((error?: Error | null) => error ? reject(new ProcessPortError('PROCESS_WRITE_FAILED', 'Unable to close harness input', { cause: error })) : resolve());
  });
  return {
    pid, owned, stdout: child.stdout, stderr: child.stderr, exited,
    write(chunk) {
      if (disposePromise || child.stdin.destroyed || child.stdin.writableEnded || didExit) {
        return Promise.reject(new ProcessPortError('PROCESS_WRITE_FAILED', 'Harness process input is closed'));
      }
      return new Promise<void>((resolve, reject) => {
        child.stdin.write(chunk, (error?: Error | null) => error
          ? reject(new ProcessPortError('PROCESS_WRITE_FAILED', 'Unable to write harness input', { cause: error }))
          : resolve());
      });
    },
    closeInput,
    dispose() {
      return disposePromise ??= (async () => {
        try {
          if (owned) {
            await terminateTree(child, pid, timeoutMs, () => didExit);
            if (!didExit) {
              await Promise.race([exited, delay(1000)]);
              if (!didExit) throw new ProcessPortError('PROCESS_DISPOSE_FAILED', 'Harness process did not exit after termination');
            }
          } else child.unref();
        } catch (cause) {
          if (cause instanceof ProcessPortError) throw cause;
          throw new ProcessPortError('PROCESS_DISPOSE_FAILED', 'Unable to dispose harness process', { cause });
        } finally {
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        }
      })();
    },
  };
}
