import type { Client, Input, Session, Turn } from '@anureo/sdk';

/** Native execution association, active observation closure, and independent observer ownership cases. */
export type NativeScenario = 'overlap' | 'close-active' | 'observer-cancel';
/** Supply an already opened, isolated native session; the runner always disposes its client. */
export interface NativeFixture {
  client: Client;
  session: Session;
  /** Inputs whose native behavior keeps execution active until close or release, as required by the case. */
  first: Input;
  /** Follow-up input for overlap/observer-cancel; unused by close-active. */
  second: Input;
  /** Expected execution identity association for the two overlapping submissions. */
  relation: 'same' | 'different';
  /**
   * Called after both submit calls begin in overlap/observer-cancel, before awaiting the second receipt.
   * Wait for native receipt evidence before releasing held execution; close-active never calls this.
   * The fixture provider retains ownership of external resources beyond the SDK client.
   */
  release?(): Promise<void>;
}
/** Adapter suites supply fresh owned clients per case; failed setup must release its own partial resources. */
export type NativeFixtureFactory = (scenario: NativeScenario) => Promise<NativeFixture>;
/** Ordered native verdicts; errors use a thrown code when present, otherwise CONFORMANCE_FAILED, with release failure appended. */
export interface NativeConformanceReport { passed: boolean; results: Array<{ scenario: NativeScenario; passed: boolean; error?: string }> }

/**
 * Check native lifecycle behavior through public SDK resources, sequentially in the requested order.
 * Codex, Pi and Hermes adapter suites supply fixtures and assert the returned verdicts. Submission,
 * result and close waits use 3000 ms; factory, release and client disposal have no runner deadline.
 * Failures become case verdicts, including client disposal failures. The runner disposes each returned
 * client; fixture providers must separately release external servers or controls they own.
 */
export async function runNativeConformance(factory: NativeFixtureFactory, scenarios: readonly NativeScenario[] = ['overlap', 'close-active', 'observer-cancel']): Promise<NativeConformanceReport> {
  const results: NativeConformanceReport['results'] = [];
  for (const scenario of scenarios) {
    results.push(await runNativeCase(factory, scenario));
  }
  return { passed: results.every(value => value.passed), results };
}

/** Own acquisition and disposal independently of the selected native assertion path. */
async function runNativeCase(factory: NativeFixtureFactory, scenario: NativeScenario): Promise<NativeConformanceReport['results'][number]> {
  let fixture: NativeFixture | undefined;
  let failure: string | undefined;
  try {
    fixture = await factory(scenario);
    const first = submitObserved(fixture.session, fixture.first);
    if (scenario === 'overlap') await checkOverlap(fixture, first);
    else if (scenario === 'close-active') await checkActiveClose(fixture, first);
    else await checkObserverCancellation(fixture, first);
  } catch (cause) {
    failure = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : 'CONFORMANCE_FAILED';
  } finally {
    try { await fixture?.client.dispose(); }
    catch { failure = failure ? `${failure}+RESOURCE_RELEASE_FAILED` : 'RESOURCE_RELEASE_FAILED'; }
  }
  return { scenario, passed: !failure, ...(failure ? { error: failure } : {}) };
}

/** Handle early rejection during release while returning the original promise so later awaits preserve the failure. */
function submitObserved(session: Session, input: Input): Promise<Turn> {
  const submission = session.submit({ input }, { timeoutMs: 3000 });
  void submission.catch(() => {});
  return submission;
}

/** Release only after initiating both inputs, then compare native association and authoritative results. */
async function checkOverlap(fixture: NativeFixture, first: Promise<Turn>): Promise<void> {
  const second = submitObserved(fixture.session, fixture.second);
  await fixture.release?.();
  const [a, b] = await Promise.all([first, second]);
  if ((a.id === b.id) !== (fixture.relation === 'same')) throw new Error('EXECUTION_ASSOCIATION');
  const [one, two] = await Promise.all([a.result({ timeoutMs: 3000 }), b.result({ timeoutMs: 3000 })]);
  if (one.status !== 'completed' || two.status !== 'completed') throw new Error('NATIVE_TERMINAL');
  if (a.id === b.id && JSON.stringify(one) !== JSON.stringify(two)) throw new Error('SHARED_RESULT');
}

/** Closing an active session must end observation without synthesizing a native execution result. */
async function checkActiveClose(fixture: NativeFixture, first: Promise<Turn>): Promise<void> {
  const turn = await first;
  const result = await fixture.session.close({ timeoutMs: 3000 });
  if (!result.observationClosed) throw new Error('OBSERVATION_NOT_CLOSED');
  await assertObservationClosed(turn);
}

/** Disposing one observer must leave its sibling able to receive the native completion after release. */
async function checkObserverCancellation(fixture: NativeFixture, first: Promise<Turn>): Promise<void> {
  const firstTurn = await first;
  const siblingObserver = firstTurn.observe();
  await firstTurn.dispose();
  const second = submitObserved(fixture.session, fixture.second);
  await fixture.release?.();
  await second;
  if ((await siblingObserver.result({ timeoutMs: 3000 })).status !== 'completed') throw new Error('SIBLING_OBSERVER_CANCELLED');
}

/** Accept only observation closure; a native terminal or any other rejection fails the active-close case. */
async function assertObservationClosed(turn: Turn): Promise<void> {
  try {
    await turn.result({ timeoutMs: 3000 });
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'OBSERVATION_CLOSED') return;
    throw cause;
  }
  throw new Error('FALSE_TERMINAL');
}
