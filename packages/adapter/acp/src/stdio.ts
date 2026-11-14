// Adapts a subprocess to ACP's framed message streams and drains startup diagnostics.
import * as acp from '@agentclientprotocol/sdk';
import { HarnessSdkError, spawnHarnessProcess, type HarnessProcess } from '@anureo/sdk';
import { StderrTail } from './diagnostics';
import type { AcpAdapterOptions, AcpChannel } from './options';

/**
 * Start the owned stdio channel used by AcpAdapter.initialize when connect is omitted.
 * Reject with HARNESS_UNAVAILABLE for a missing command or failed spawn. Resolve after spawning
 * so initialize can negotiate ACP over the returned stream and await channel disposal on teardown.
 * AcpAdapter.withDiagnostics reads the tail captured so far when annotating handshake or
 * connection-closure failures.
 */
export async function processStream(options: AcpAdapterOptions): Promise<AcpChannel> {
  if (!options.command) throw new HarnessSdkError('HARNESS_UNAVAILABLE', 'An ACP executable or stream factory is required');
  const child = await spawnHarnessProcess({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
  });
  const incoming = framedStdout(child.stdout, options);
  const outgoing = framedStdin(child, options);
  const tail = captureStderr(child, options);
  return {
    stream: acp.ndJsonStream(outgoing, incoming),
    dispose: () => child.dispose(),
    diagnostics: () => tail.text(),
  };
}

/**
 * Supply ACP's ndJSON decoder with guarded stdout chunks. EOF closes the stream, and read or
 * limit failures error it. Cancelling calls the stdout iterator's return method when present.
 * Channel disposal owns child teardown.
 */
function framedStdout(stdout: HarnessProcess['stdout'], options: AcpAdapterOptions): ReadableStream<Uint8Array> {
  const iterator = stdout[Symbol.asyncIterator]();
  const checkIncoming = frameGuard(options, 'ACP frame exceeds its limit');
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const value = await iterator.next();
        if (value.done) {
          controller.close();
          return;
        }
        checkIncoming(value.value);
        controller.enqueue(value.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() { await iterator.return?.(); },
  });
}

/**
 * Guard bytes from ACP's ndJSON encoder before forwarding them to child stdin. Writes await the
 * process write callback and propagate limit or pipe failures. Closing ends stdin.
 */
function framedStdin(child: HarnessProcess, options: AcpAdapterOptions): WritableStream<Uint8Array> {
  const checkOutgoing = frameGuard(options, 'ACP outgoing frame exceeds its limit');
  return new WritableStream<Uint8Array>({
    write(chunk) {
      checkOutgoing(chunk);
      return child.write(chunk);
    },
    close: () => child.closeInput(),
  });
}

/**
 * Keep one direction's frame length across chunks, resetting on LF. Throw BACKPRESSURE_EXCEEDED
 * before the caller forwards a chunk that takes a frame over the limit (8 MiB by default).
 */
function frameGuard(options: AcpAdapterOptions, message: string): (chunk: Uint8Array) => void {
  let lineBytes = 0;
  return (chunk) => {
    for (const byte of chunk) {
      if (byte === 10) {
        lineBytes = 0;
      } else if (++lineBytes > (options.maxFrameBytes ?? 8 * 1024 * 1024)) {
        throw new HarnessSdkError('BACKPRESSURE_EXCEEDED', message);
      }
    }
  };
}

/**
 * Start draining immediately so startup stderr is available even when no ACP frame arrives.
 * processStream exposes the live tail as channel diagnostics. A pipe read failure ends capture
 * and flushes buffered text without failing the protocol. Channel disposal does not await the drain.
 */
function captureStderr(child: HarnessProcess, options: AcpAdapterOptions): StderrTail {
  const tail = new StderrTail(options.stderrTailLines ?? 200, options.onStderr);
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for await (const chunk of child.stderr) tail.write(decoder.decode(chunk, { stream: true }));
    } catch {
      // Pipe teardown can race the drain.
    } finally {
      tail.flush();
    }
  })();
  return tail;
}
