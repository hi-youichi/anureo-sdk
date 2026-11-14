import type { Client, Input, Session, Turn } from '@anureo/sdk';

/** Native execution association, active observation closure, and independent observer ownership cases. */
export type NativeScenario = 'overlap' | 'close-active' | 'observer-cancel';
/** Supply an already opened, isolated native session and transfer its client to the runner for disposal. */
export interface NativeFixture {
  client: Client;
  /** Open session owned by client. */
  session: Session;
  /** Input that starts an execution the fixture keeps active for the selected check. */
  first: Input;
  /** Follow-up input for overlap/observer-cancel; unused by close-active. */
  second: Input;
  /** Whether the two overlap submissions should resolve to the same execution ID. */
  relation: 'same' | 'different';
  /**
   * The overlap and observer-cancel checks await this hook after initiating both submissions
   * and before awaiting the second Turn. If the fixture holds execution, wait for evidence
   * that the native backend received both inputs before allowing completion. Omit the hook
   * when native behavior provides that ordering. The close-active check never calls it.
   */
  release?(): Promise<void>;
}
/** Supply a fresh client and open session for each case. Clean up partial setup on rejection and retain ownership of external resources. */
export type NativeFixtureFactory = (scenario: NativeScenario) => Promise<NativeFixture>;

/** Native case verdicts in the order requested by the caller. */
export interface NativeConformanceReport {
  /** True when every selected case passed, including an empty selection. */
  passed: boolean;
  results: Array<{
    scenario: NativeScenario;
    passed: boolean;
    /** Failure code or CONFORMANCE_FAILED. RESOURCE_RELEASE_FAILED is appended after a prior failure. */
    error?: string;
  }>;
}

/**
 * Check native lifecycle behavior through the SDK, sequentially in the requested order.
 * The default order is overlap, close-active, then observer-cancel. Submission association,
 * result and close waits each use 3000 ms. Factory setup, the optional release hook and client
 * disposal have no runner deadline. The runner awaits disposal of each returned client before
 * proceeding and reports setup, check and disposal failures as case verdicts. Fixture providers
 * still own external servers and controls.
 */
export async function runNativeConformance(
  factory: NativeFixtureFactory,
  scenarios: readonly NativeScenario[] = ['overlap', 'close-active', 'observer-cancel'],
): Promise<NativeConformanceReport> {
  const results: NativeConformanceReport['results'] = [];
  for (const scenario of scenarios) {
    results.push(await runNativeCase(factory, scenario));
  }
  return { passed: results.every(value => value.passed), results };
}

const nativeWaitMs = 3000;

/** Give runNativeConformance one verdict after running the selected check and disposing its fixture client. */
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
    try {
      await fixture?.client.dispose();
    } catch {
      failure = failure ? `${failure}+RESOURCE_RELEASE_FAILED` : 'RESOURCE_RELEASE_FAILED';
    }
  }
  return { scenario, passed: !failure, ...(failure ? { error: failure } : {}) };
}

/** Start association immediately. Observe early rejection while the case releases its fixture, and preserve it for later awaits. */
function submitObserved(session: Session, input: Input): Promise<Turn> {
  const submission = session.submit({ input }, { timeoutMs: nativeWaitMs });
  void submission.catch(() => {});
  return submission;
}

/** Initiate both inputs before release, then verify the expected association and matching results for a shared execution. */
async function checkOverlap(fixture: NativeFixture, first: Promise<Turn>): Promise<void> {
  const second = submitObserved(fixture.session, fixture.second);
  await fixture.release?.();
  const [firstTurn, secondTurn] = await Promise.all([first, second]);
  if ((firstTurn.id === secondTurn.id) !== (fixture.relation === 'same')) throw new Error('EXECUTION_ASSOCIATION');
  const [firstResult, secondResult] = await Promise.all([
    firstTurn.result({ timeoutMs: nativeWaitMs }),
    secondTurn.result({ timeoutMs: nativeWaitMs }),
  ]);
  if (firstResult.status !== 'completed' || secondResult.status !== 'completed') throw new Error('NATIVE_TERMINAL');
  if (firstTurn.id === secondTurn.id && JSON.stringify(firstResult) !== JSON.stringify(secondResult)) throw new Error('SHARED_RESULT');
}

/** Closing an active session must end observation without synthesizing a native execution result. */
async function checkActiveClose(fixture: NativeFixture, first: Promise<Turn>): Promise<void> {
  const turn = await first;
  const result = await fixture.session.close({ timeoutMs: nativeWaitMs });
  if (!result.observationClosed) throw new Error('OBSERVATION_NOT_CLOSED');
  await assertObservationClosed(turn);
}

/** Dispose the original observer before the second submission. Its sibling must still receive the native completion after release. */
async function checkObserverCancellation(fixture: NativeFixture, first: Promise<Turn>): Promise<void> {
  const firstTurn = await first;
  const siblingObserver = firstTurn.observe();
  await firstTurn.dispose();
  const second = submitObserved(fixture.session, fixture.second);
  await fixture.release?.();
  await second;
  if ((await siblingObserver.result({ timeoutMs: nativeWaitMs })).status !== 'completed') throw new Error('SIBLING_OBSERVER_CANCELLED');
}

/** Accept only observation closure; a native terminal or any other rejection fails the active-close case. */
async function assertObservationClosed(turn: Turn): Promise<void> {
  try {
    await turn.result({ timeoutMs: nativeWaitMs });
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'OBSERVATION_CLOSED') return;
    throw cause;
  }
  throw new Error('FALSE_TERMINAL');
}
