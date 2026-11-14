import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from './adapter';
import type { AcpAdapterOptions } from './options';

/** Configure the DSH command and approval policy alongside ACP's host ports and transport options. */
export interface DshAcpOptions extends Omit<AcpAdapterOptions, 'command' | 'args'> {
  /** `dsh` executable; defaults to `dsh` on PATH. */
  command?: string;
  /** Value passed to `--profile`; defaults to `acp`. */
  profile?: string;
  /**
   * Set the child's DSH home. An explicit env.DSH_HOME entry takes precedence, including undefined.
   * Otherwise the preset uses this value, the host's DSH_HOME, or `~/.dsh`, in that order.
   */
  dshHome?: string;
  /**
   * Opt into the allow-once policy for unattended hosts, overriding autoRespondPermission.
   * Requests without a matching option still fall back to interactive handling. Defaults to false.
   */
  autoApprove?: boolean;
}

/**
 * Create an ACP adapter for DeepSeek Harness, launching `dsh --profile acp` by default.
 * Pass it to createClient to start the transport and negotiate ACP, then await client disposal
 * when finished. Construction only configures the adapter. A supplied connect factory takes
 * precedence over the command during initialization.
 *
 * DSH needs Node.js >= 24.9 and provider credentials in DSH_HOME. Startup failures during the
 * handshake include the redacted stderr tail when available. The preset sets a 120,000 ms
 * native request wait (excluding session/prompt) when requestTimeoutMs is omitted. Passing it
 * explicitly as undefined uses ACP's 30,000 ms fallback. Stdio retains up to 200 stderr lines by default.
 * Child environment overrides are merged over the host environment and preset DSH_HOME.
 */
export function createDshAcpAdapter(options: DshAcpOptions = {}): AcpAdapter {
  const { dshHome, profile = 'acp', autoApprove = false, ...rest } = options;
  return createAcpAdapter({
    stderrTailLines: 200,
    requestTimeoutMs: 120_000,
    ...rest,
    command: rest.command ?? 'dsh',
    args: ['--profile', profile],
    env: {
      ...process.env,
      DSH_HOME: dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'),
      ...rest.env,
    },
    ...(autoApprove ? { autoRespondPermission: 'allow-once' as const } : {}),
  });
}
