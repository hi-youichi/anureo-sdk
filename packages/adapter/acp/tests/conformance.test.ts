import { test, expect } from 'bun:test';
import { resolve } from 'node:path';
import { runConformance } from '@anureo/conformance';
import { createAcpAdapter } from '../src/index';

test('vanilla ACP and negotiated ACP extensions pass the same public SDK conformance suite', async () => {
  const executable = resolve(import.meta.dirname, './fixtures/fake-acp.mjs');
  const modes = [
    { name: 'standard', args: [] },
    { name: 'extensions', args: ['--extensions'] },
  ] as const;
  for (const { name, args } of modes) {
    const report = await runConformance((scenario) => ({
      adapter: createAcpAdapter({
        command: process.execPath,
        args: [
          executable,
          '--scenario',
          scenario,
          ...args,
        ],
        ...(scenario === 'backpressure' ? { maxFrameBytes: 1024 } : {}),
      }),
      openParams: { requestId: 'open', mode: 'new', binding: { sessionId: 's', adapterId: 'acp', runtimeConfigId: 'conformance' }, cwd: process.cwd() },
      expectedText: 'Hello conformance',
    }), { timeoutMs: 3000 });
    expect(report.cases.filter((result) => result.status === 'failed')).toEqual([]);
    expect(report.passed).toBe(true);
    if (name === 'standard') expect(report.cases.find((result) => result.scenario === 'fork')?.status).toBe('not-applicable');
    else expect(report.cases.filter(result => result.status === 'not-applicable').map(result => result.scenario)).toEqual(['steer']);
  }
}, 25_000);
