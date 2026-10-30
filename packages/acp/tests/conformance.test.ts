import { test, expect } from 'bun:test';
import { resolve } from 'node:path';
import { runConformance } from '@anureo/conformance';
import { createAcpAdapter } from '../src/index';

test('vanilla ACP and negotiated ACP extensions pass the same public SDK conformance suite', async () => {
  const executable = resolve(import.meta.dirname, '../../../scripts/harness-sdk/fixtures/fake-acp.mjs');
  for (const extended of [false, true]) {
    const report = await runConformance((scenario) => ({
      adapter: createAcpAdapter({ command: process.execPath, args: [executable, '--scenario', scenario, ...(extended ? ['--extensions'] : [])], ...(scenario === 'backpressure' ? { maxFrameBytes: 1024 } : {}) }),
      openParams: { requestId: 'open', mode: 'new', binding: { sessionId: 's', adapterId: 'acp', runtimeConfigId: 'conformance' }, cwd: process.cwd() },
      expectedText: 'Hello conformance',
    }), { timeoutMs: 3000 });
    expect(report.cases.filter((result) => result.status === 'failed')).toEqual([]);
    expect(report.passed).toBe(true);
    if (!extended) expect(report.cases.find((result) => result.scenario === 'fork')?.status).toBe('not-applicable');
    else expect(report.cases.every((result) => result.status === 'passed')).toBe(true);
  }
}, 25_000);
