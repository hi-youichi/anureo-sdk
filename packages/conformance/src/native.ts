import type { Client, Input, Session, Turn } from '@anureo/sdk';
export type NativeScenario = 'overlap' | 'close-active' | 'observer-cancel';
export interface NativeFixture {
  client: Client;
  session: Session;
  first: Input;
  second: Input;
  relation: 'same' | 'different';
  /** Release an external native fixture after both submissions have actually been sent. */
  release?(): Promise<void>;
}
export type NativeFixtureFactory = (scenario: NativeScenario) => Promise<NativeFixture>;
export interface NativeConformanceReport { passed: boolean; results: Array<{ scenario: NativeScenario; passed: boolean; error?: string }> }

async function assertObservationClosed(turn: Turn): Promise<void> {
  try {
    await turn.result({ timeoutMs: 3000 });
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'OBSERVATION_CLOSED') return;
    throw cause;
  }
  throw new Error('FALSE_TERMINAL');
}

/** Uses the public root client and resources. The fixture owns only external native behavior. */
export async function runNativeConformance(factory: NativeFixtureFactory, scenarios: readonly NativeScenario[] = ['overlap', 'close-active', 'observer-cancel']): Promise<NativeConformanceReport> {
  const results: NativeConformanceReport['results'] = [];
  for (const scenario of scenarios) {
    let fixture: NativeFixture | undefined, failure: string | undefined;
    try {
      fixture = await factory(scenario);
      const first = fixture.session.submit({ input: fixture.first }, { timeoutMs: 3000 });
      // Register rejection handlers early to avoid unhandled rejections while awaiting release or other work.
      // Later awaits still use the original submission promises, so failures reach the outer catch.
      void first.catch(() => {});
      if (scenario === 'overlap') {
        const second = fixture.session.submit({ input: fixture.second }, { timeoutMs: 3000 });
        // Apply the same early rejection handling to the second submission.
        void second.catch(() => {});
        await fixture.release?.();
        const [a, b] = await Promise.all([first, second]);
        if ((a.id === b.id) !== (fixture.relation === 'same')) throw new Error('EXECUTION_ASSOCIATION');
        const [one, two] = await Promise.all([a.result({ timeoutMs: 3000 }), b.result({ timeoutMs: 3000 })]);
        if (one.status !== 'completed' || two.status !== 'completed') throw new Error('NATIVE_TERMINAL');
        if (a.id === b.id && JSON.stringify(one) !== JSON.stringify(two)) throw new Error('SHARED_RESULT');
      } else if (scenario === 'close-active') {
        const turn = await first;
        const result = await fixture.session.close({ timeoutMs: 3000 });
        if (!result.observationClosed) throw new Error('OBSERVATION_NOT_CLOSED');
        await assertObservationClosed(turn);
      } else {
        const firstTurn = await first;
        const siblingObserver = firstTurn.observe();
        await firstTurn.dispose();
        const secondSubmission = fixture.session.submit({ input: fixture.second }, { timeoutMs: 3000 });
        // As above, handle rejection during release; awaiting the original second promise still propagates it.
        void secondSubmission.catch(() => {});
        await fixture.release?.();
        await secondSubmission;
        if ((await siblingObserver.result({ timeoutMs: 3000 })).status !== 'completed') throw new Error('SIBLING_OBSERVER_CANCELLED');
      }
    } catch (cause) { failure = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : 'CONFORMANCE_FAILED'; }
    finally {
      try { await fixture?.client.dispose(); }
      catch { failure = failure ? `${failure}+RESOURCE_RELEASE_FAILED` : 'RESOURCE_RELEASE_FAILED'; }
    }
    results.push({ scenario, passed: !failure, ...(failure ? { error: failure } : {}) });
  }
  return { passed: results.every(value => value.passed), results };
}
