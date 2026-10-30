import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, link, copyFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnHarnessProcess, ProcessPortError } from './process.ts';

async function textOf(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder(); let text = '';
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

async function firstLine(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const iterator = stream[Symbol.asyncIterator]();
  const decoder = new TextDecoder(); let text = '';
  while (!text.includes('\n')) {
    const next = await iterator.next();
    if (next.done) throw new Error('Process ended before readiness');
    text += decoder.decode(next.value, { stream: true });
  }
  return text.split('\n')[0]!;
}

test('spawn reports an unavailable executable without unhandled errors', async () => {
  await assert.rejects(spawnHarnessProcess({ command: join(tmpdir(), 'not-a-harness-binary-does-not-exist'), args: ['secret-process-argument'] }), (error: unknown) => {
    assert.ok(error instanceof ProcessPortError);
    assert.equal(error.code, 'HARNESS_UNAVAILABLE');
    assert.equal('cause' in error, false); assert.equal(JSON.stringify(error).includes('secret-process-argument'), false);
    return true;
  });
});

test('argument arrays preserve executable/cwd spaces and literal shell metacharacters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness process '));
  try {
    const command = join(root, process.platform === 'win32' ? 'runtime with spaces.exe' : 'runtime with spaces');
    try { await link(process.execPath, command); } catch { await copyFile(process.execPath, command); }
    const cwd = join(root, 'cwd with spaces'); await mkdir(cwd);
    const literal = 'literal `echo wrong` $(echo wrong) ; & spaces';
    const child = await spawnHarnessProcess({ command, cwd, args: ['-e', 'console.log(JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(1),env:process.env.HARNESS_PROCESS_TEST}))', literal], env: { ...process.env, HARNESS_PROCESS_TEST: 'injected' } });
    const output = textOf(child.stdout);
    const exit = await child.exited;
    assert.equal(exit.code, 0);
    const data = JSON.parse((await output).trim());
    assert.equal(await realpath(data.cwd), await realpath(cwd)); assert.deepEqual(data.argv, [literal]); assert.equal(data.env, 'injected');
    assert.notEqual(process.env.HARNESS_PROCESS_TEST, 'injected');
    await child.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stdio writes drain, input closes, and nonzero exits are observable', async () => {
  const child = await spawnHarnessProcess({ command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout);process.stdin.on("end",()=>{process.stderr.write("diagnostic");process.exitCode=7})'] });
  const output = textOf(child.stdout); const errors = textOf(child.stderr);
  const input = 'x'.repeat(1024 * 1024);
  await child.write(input); await child.closeInput();
  assert.equal((await child.exited).code, 7);
  assert.equal(await output, input); assert.equal(await errors, 'diagnostic');
  await assert.rejects(child.write('after-exit'), (error: unknown) => error instanceof ProcessPortError && error.code === 'PROCESS_WRITE_FAILED');
  await child.dispose();
});

test('owned dispose is idempotent and escalates after grace timeout', async () => {
  const child = await spawnHarnessProcess({ command: process.execPath, args: ['-e', 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'], shutdownTimeoutMs: 50 });
  assert.equal(await firstLine(child.stdout), 'ready');
  await Promise.all([child.dispose(), child.dispose()]);
  const exit = await child.exited;
  if (process.platform !== 'win32') assert.equal(exit.signal, 'SIGKILL');
  assert.throws(() => process.kill(child.pid, 0));
});

test('owned dispose terminates a child process tree', async () => {
  const code = 'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(child.pid);setInterval(()=>{},1000)';
  const child = await spawnHarnessProcess({ command: process.execPath, args: ['-e', code], shutdownTimeoutMs: 50 });
  const descendant = Number(await firstLine(child.stdout)); assert.ok(descendant > 0);
  await child.dispose();
  for (let i = 0; i < 100; i++) {
    try { process.kill(descendant, 0); }
    catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Owned descendant remains alive after dispose');
});

test('external ownership detaches without terminating the process', async () => {
  const child = await spawnHarnessProcess({ command: process.execPath, args: ['-e', 'process.stdin.on("error",()=>{});process.stdout.on("error",()=>{});console.log("ready");setInterval(()=>{},1000)'], owned: false });
  assert.equal(await firstLine(child.stdout), 'ready');
  try {
    await child.dispose(); assert.doesNotThrow(() => process.kill(child.pid, 0));
  } finally { process.kill(child.pid, 'SIGKILL'); await child.exited; }
});

test('invalid timeout and NUL arguments fail before spawning', async () => {
  await assert.rejects(spawnHarnessProcess({ command: process.execPath, shutdownTimeoutMs: -1 }));
  await assert.rejects(spawnHarnessProcess({ command: process.execPath, args: ['\0'] }));
});

test('abruptly exited children retain their original PID for safe cleanup', async () => {
  for (let i = 0; i < 12; i++) {
    const child = await spawnHarnessProcess({ command: process.execPath, args: ['-e', 'process.exit(1)'] });
    await child.exited;
    await child.dispose();
    assert.ok(child.pid > 1);
  }
});

test('posix termination retries a transient EPERM and settles once the group is gone', async () => {
  const child = await spawnHarnessProcess({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shutdownTimeoutMs: 200 });
  const killDescriptor = Object.getOwnPropertyDescriptor(process, 'kill');
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const realKill = process.kill;
  const seen: Array<{ pid: number; signal: unknown }> = [];
  let termAttempts = 0;
  const mockKill = ((pid: number, signal?: NodeJS.Signals | number) => {
    seen.push({ pid, signal });
    if (pid < 0) {
      if (signal === 'SIGTERM' && ++termAttempts === 1) {
        const error = new Error('transient group signal') as NodeJS.ErrnoException; error.code = 'EPERM'; throw error;
      }
      const error = new Error('group gone') as NodeJS.ErrnoException; error.code = 'ESRCH'; throw error;
    }
    return (realKill as (pid: number, signal?: NodeJS.Signals | number) => void)(pid, signal);
  }) as typeof process.kill;
  Object.defineProperty(process, 'kill', { value: mockKill, configurable: true, writable: true });
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    await assert.rejects(child.dispose(), (error: unknown) => error instanceof ProcessPortError && error.code === 'PROCESS_DISPOSE_FAILED');
    assert.equal(seen.filter((entry) => entry.pid < 0 && entry.signal === 'SIGTERM').length, 2);
    assert.ok(seen.some((entry) => entry.pid < 0 && entry.signal === 0));
  } finally {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    if (killDescriptor) Object.defineProperty(process, 'kill', killDescriptor);
    try { (realKill as (pid: number) => void)(child.pid); } catch { /* already gone */ }
  }
});

test('posix termination swallows ESRCH when the group already exited', async () => {
  const child = await spawnHarnessProcess({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shutdownTimeoutMs: 200 });
  const killDescriptor = Object.getOwnPropertyDescriptor(process, 'kill');
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const realKill = process.kill;
  const mockKill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0) { const error = new Error('group gone') as NodeJS.ErrnoException; error.code = 'ESRCH'; throw error; }
    return (realKill as (pid: number, signal?: NodeJS.Signals | number) => void)(pid, signal);
  }) as typeof process.kill;
  Object.defineProperty(process, 'kill', { value: mockKill, configurable: true, writable: true });
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    await assert.rejects(child.dispose(), (error: unknown) => error instanceof ProcessPortError && error.code === 'PROCESS_DISPOSE_FAILED');
  } finally {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    if (killDescriptor) Object.defineProperty(process, 'kill', killDescriptor);
    try { (realKill as (pid: number) => void)(child.pid); } catch { /* already gone */ }
  }
});

test('an unspawnable executable surfaces its native error code without leaking spawn arguments', async () => {
  await assert.rejects(spawnHarnessProcess({ command: 'definitely-not-a-real-executable-xyz' }), (error: unknown) =>
    error instanceof ProcessPortError && error.code === 'HARNESS_UNAVAILABLE');
  await assert.rejects(spawnHarnessProcess({ command: 'valid', args: ['bad\0arg'] }), (error: unknown) =>
    error instanceof ProcessPortError && error.code === 'HARNESS_UNAVAILABLE');
  await assert.rejects(spawnHarnessProcess({ command: 'valid', shutdownTimeoutMs: 99_999 }), (error: unknown) =>
    error instanceof ProcessPortError && error.code === 'HARNESS_UNAVAILABLE');
});
