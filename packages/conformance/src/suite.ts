import { createClient, type Client, type HarnessAdapter, type InteractionHandlers, type RuntimeOptions, type Session, type Turn } from '@anureo/sdk';
import type { AhpEvent, Boundary, Capabilities, InteractionRequested, InteractionResponse, RevertScope, SessionOpenParams } from '@anureo/protocol';

/** Default shared acceptance cases in execution order. Use runNativeConformance for native lifecycle cases. */
export const CONFORMANCE_SCENARIOS = [
  'lifecycle', 'immediate', 'identity', 'approval', 'userInput', 'elicitation', 'dynamicTool',
  'interrupt', 'steer', 'fork', 'revert', 'history', 'unknown-item', 'disconnect', 'backpressure',
] as const;

/** Select a shared behavioral case to run or to supply fixture behavior for. */
export type ConformanceScenario = typeof CONFORMANCE_SCENARIOS[number];

/** Supply scenario-specific native behavior to the runner that manages the SDK client. */
export interface ConformanceDriver {
  /** Fresh adapter passed to createClient for SDK-managed initialization and release. */
  adapter: HarnessAdapter;
  /** Native session setup passed to Client.openSession. Its binding also supplies the client identity. */
  openParams: SessionOpenParams;
  /** SDK policy overrides, including queue limits for backpressure fixtures. */
  runtimeOptions?: RuntimeOptions;
  /**
   * runConformance awaits this hook after obtaining the initial Turn and completing any control request,
   * before waiting for its result. Fixtures can use it to induce source loss. A rejection reaches the
   * case as an execution failure and can satisfy a fault case if it carries one of that case's codes.
   */
  afterStart?: (session: Session) => Promise<void>;
  /** Authoritative text expected by lifecycle and immediate. Defaults to 'conformance'. */
  expectedText?: string;
  /**
   * Answer a native interaction with a response of the matching kind. The SDK calls the runner's
   * registered handler after publishing the request and delivers the answer to the native responder.
   * If the callback throws, the SDK cancels the interaction while it is still actionable.
   * By default the runner selects the first approval option and the first option for each question,
   * uses 'conformance' for free-text answers and tool output, and declines elicitation.
   */
  answer?: (request: InteractionRequested) => InteractionResponse;
}
/** Supply an isolated driver each time runConformance starts a selected case, even if it later skips the case. Release external resources and clean up failed factory setup yourself. */
export type ConformanceFactory = (scenario: ConformanceScenario) => Promise<ConformanceDriver> | ConformanceDriver;

/** Verdict for one selected case. */
export interface ConformanceCaseResult {
  scenario: ConformanceScenario;
  /** An undeclared required capability yields 'not-applicable'. A broken declared capability yields 'failed'. */
  status: 'passed' | 'failed' | 'not-applicable';
  /** Diagnostic for a failed case, replaced by RESOURCE_RELEASE_FAILED if disposal of its client rejects. */
  message?: string;
}

/** Shared case verdicts in the order requested by the caller. */
export interface ConformanceReport {
  /** True when no selected case failed, including an empty selection or cases that were skipped. */
  passed: boolean;
  cases: ConformanceCaseResult[];
}

/**
 * Check an adapter through the public SDK, sequentially in the selected order (all shared cases by default).
 * The timeoutMs option bounds initial submission, controls, afterStart and result observation.
 * It defaults to 3000 ms and leaves setup, later session operations and cleanup on their own
 * SDK or fixture wait policies. The runner awaits reader teardown before client disposal and
 * starts the next case after cleanup. Setup and check failures become case verdicts. Reader
 * teardown failure rejects the run before client disposal. Client disposal failure marks the
 * case failed with RESOURCE_RELEASE_FAILED. Callers still own resources outside the SDK client.
 */
export async function runConformance(
  factory: ConformanceFactory,
  options: { timeoutMs?: number; scenarios?: readonly ConformanceScenario[] } = {},
): Promise<ConformanceReport> {
  const cases: ConformanceCaseResult[] = [];
  for (const scenario of options.scenarios ?? CONFORMANCE_SCENARIOS) {
    cases.push(await runConformanceCase({ factory, scenario, timeoutMs: options.timeoutMs ?? 3000 }));
  }
  return { passed: cases.every(entry => entry.status !== 'failed'), cases };
}

/**
 * Supply runConformance with one verdict after fixture setup, applicable checks and ordered cleanup.
 * Returning the reader first detaches it from the session and lets its collection task finish.
 * Reader teardown failure propagates directly. Client disposal failure replaces any earlier verdict.
 */
async function runConformanceCase({ factory, scenario, timeoutMs }: {
  factory: ConformanceFactory; scenario: ConformanceScenario; timeoutMs: number;
}): Promise<ConformanceCaseResult> {
  let client: Client | undefined;
  let observation: ReturnType<typeof collectEvents> | undefined;
  let result: ConformanceCaseResult;
  try {
    const driver = await factory(scenario);
    client = await createCaseClient(driver);
    const session = await client.openSession(driver.openParams);
    if (!isApplicable(scenario, session.capabilities)) {
      result = { scenario, status: 'not-applicable' };
    } else {
      observation = collectEvents(session);
      await checkScenario({ client, session, driver, scenario, observation, timeoutMs });
      result = { scenario, status: 'passed' };
    }
  } catch (cause) {
    result = { scenario, status: 'failed', message: cause instanceof Error ? cause.message : 'Conformance failed' };
  } finally {
    await observation?.reader.return?.();
    await observation?.task;
    try {
      await client?.dispose();
    } catch {
      result = { scenario, status: 'failed', message: 'RESOURCE_RELEASE_FAILED' };
    }
  }
  return result;
}

const interactionKinds = ['approval', 'userInput', 'elicitation', 'dynamicTool'] as const;

/**
 * Initialize the driver adapter for runConformanceCase, advertising every interaction kind.
 * The SDK invokes the registered handler after publishing the request and uses its answer for
 * native settlement. Return createClient's initialization promise so runConformanceCase can
 * open a session and later dispose the client, or record an initialization failure.
 */
function createCaseClient(driver: ConformanceDriver): Promise<Client> {
  const handlers = Object.fromEntries(interactionKinds.map(kind => [
    kind,
    async (request: InteractionRequested) => (driver.answer ?? defaultAnswer)(request),
  ])) as InteractionHandlers;
  return createClient({
    adapter: driver.adapter,
    identity: driver.openParams.binding,
    runtime: driver.runtimeOptions,
    interactions: handlers,
  });
}

/**
 * Subscribe before submission so the case can inspect events published before association.
 * The task records read failures and enforces a 10,000-event limit. checkScenario uses its
 * completion and failure during verification. runConformanceCase owns reader teardown.
 */
function collectEvents(session: Session) {
  const reader = session.events()[Symbol.asyncIterator]();
  const events: AhpEvent[] = [];
  let failure: unknown;
  const task = (async () => {
    try {
      for (;;) {
        const event = await reader.next();
        if (event.done) return;
        events.push(event.value);
        if (events.length > 10_000) throw new Error('Too many events without completion');
      }
    } catch (cause) {
      failure = cause;
    }
  })();
  return { reader, events, task, get failure() { return failure; } };
}

/**
 * Verify the initial execution before any follow-up operations add events. runConformanceCase
 * awaits this before recording a pass. Only source fault cases expect observation to fail.
 */
async function checkScenario({ client, session, driver, scenario, observation, timeoutMs }: {
  client: Client; session: Session; driver: ConformanceDriver; scenario: ConformanceScenario;
  observation: ReturnType<typeof collectEvents>; timeoutMs: number;
}): Promise<void> {
  const { events } = observation;
  const capabilities = session.capabilities;
  const execution = executeScenarioTurn({ session, driver, scenario, capabilities });
  const expectsSourceFailure = scenario === 'disconnect' || scenario === 'backpressure';
  if (expectsSourceFailure) {
    await checkSourceFailure({ execution, scenario, events, timeoutMs });
  } else {
    const { turn, result } = await deadline(Promise.race([
      execution,
      observation.task.then(() => { throw observation.failure ?? new Error('Source ended before result'); }),
    ]), timeoutMs);
    checkTurnResult({ scenario, driver, events, result });
    if (scenario === 'identity' || scenario === 'history' || scenario === 'fork' || scenario === 'revert') {
      await checkSessionOperation({ client, session, turn, scenario, capabilities });
    }
  }
  requireCondition(!observation.failure || expectsSourceFailure, 'Unexpected source failure');
  checkEventSequence(session, events);
}

/** Dispatch the selected follow-up after initial terminal evidence passes. Its rejection fails the case. */
async function checkSessionOperation({ client, session, turn, scenario, capabilities }: {
  client: Client; session: Session; turn: Turn;
  scenario: 'identity' | 'history' | 'fork' | 'revert'; capabilities: Capabilities;
}): Promise<void> {
  switch (scenario) {
    case 'identity':
      await checkDistinctExecution(session, turn);
      break;
    case 'history':
      await checkHistoryIdentity(session);
      break;
    case 'fork': {
      const relations = capabilities.session?.fork;
      requireCondition(relations !== undefined, 'Fork capability missing');
      await checkForkBoundaries({ client, session, turn, relations, history: capabilities.session?.history });
      break;
    }
    case 'revert': {
      const scope = capabilities.session?.revert?.[0];
      requireCondition(scope !== undefined, 'Revert capability missing');
      await checkRevertBoundary({ session, turn, scope, history: capabilities.session?.history });
      break;
    }
  }
}

/**
 * Start the initial input for checkScenario and return its associated Turn and retained result.
 * Session-level interruption is issued before awaiting association, which turn controls require.
 * Await afterStart after controls so its effects or failure precede the result wait.
 */
async function executeScenarioTurn({ session, driver, scenario, capabilities }: {
  session: Session; driver: ConformanceDriver; scenario: ConformanceScenario; capabilities: Capabilities;
}) {
  const pendingTurn = session.submit({ input: 'conformance' });
  // Interruption/release may reject submission before we await the original promise.
  void pendingTurn.catch(() => {});
  const supportsTurnInterrupt = scenario === 'interrupt' && capabilities.input?.interrupt?.targets.includes('turn') === true;
  if (scenario === 'interrupt' && !supportsTurnInterrupt) {
    await Promise.resolve();
    await session.interrupt();
  }
  const turn = await pendingTurn;
  if (scenario === 'steer') await turn.steer({ input: 'redirect' });
  if (scenario === 'interrupt' && supportsTurnInterrupt) await turn.interrupt();
  await driver.afterStart?.(session);
  return { turn, result: await turn.result() };
}

/** Fail the case unless execution rejects with an allowed source-loss code and no terminal event was published. */
async function checkSourceFailure({ execution, scenario, events, timeoutMs }: {
  execution: ReturnType<typeof executeScenarioTurn>; scenario: 'disconnect' | 'backpressure'; events: AhpEvent[]; timeoutMs: number;
}): Promise<void> {
  try {
    await deadline(execution, timeoutMs);
  } catch (cause) {
    requireCondition(cause && typeof cause === 'object' && 'code' in cause, 'Source failure must be typed');
    const expectedCodes = scenario === 'disconnect'
      ? ['CONNECTION_CLOSED', 'ACP_CONNECTION_CLOSED', 'RPC_CONNECTION_CLOSED']
      : ['BACKPRESSURE_EXCEEDED', 'FRAME_TOO_LARGE'];
    requireCondition(expectedCodes.includes(String(cause.code)), `Unexpected observation error: ${String(cause.code)}`);
    requireCondition(!events.some(event => event.type === 'turn/completed'), 'SDK must not fabricate native terminal');
    return;
  }
  throw new Error('Lost source must fail observation');
}

/** Check native terminal evidence before identity/history operations add further executions and events. */
function checkTurnResult({ scenario, driver, events, result }: {
  scenario: ConformanceScenario; driver: ConformanceDriver; events: AhpEvent[]; result: Awaited<ReturnType<Turn['result']>>;
}): void {
  requireCondition(result.status === (scenario === 'interrupt' ? 'interrupted' : 'completed'), 'Unexpected native terminal');
  requireCondition(events.filter(event => event.type === 'turn/started').length === 1, 'Execution must start once');
  requireCondition(events.filter(event => event.type === 'turn/completed').length === 1, 'Execution must end once');
  if (isInteractionScenario(scenario)) {
    requireCondition(events.some(event => event.type === 'interaction/requested') && events.some(event => event.type === 'interaction/resolved'), 'Interaction not exercised');
  }
  if (scenario === 'lifecycle' || scenario === 'immediate') {
    requireCondition(result.text === (driver.expectedText ?? 'conformance'), 'Authoritative final text missing');
  }
  if (scenario === 'unknown-item') {
    requireCondition(result.items.some(item => item.type === 'toolCall' && item.kind === 'other' && item.nativeType), 'Unknown native item lost');
  }
}

/** After the first terminal result, wait for a second execution and require a fresh identity. */
async function checkDistinctExecution(session: Session, turn: Turn): Promise<void> {
  const other = await session.submit({ input: 'conformance' });
  await other.result();
  requireCondition(other.id !== turn.id, 'Execution identity reused');
}

/** Verify the first history page retains both execution and item IDs after completion. */
async function checkHistoryIdentity(session: Session): Promise<void> {
  const page = await session.request('history/read', { sessionId: session.id, requestId: 'history' });
  requireCondition(page.items.length && page.items.every(item => item.turnId && item.item.id), 'History identity missing');
}

/**
 * Verify each advertised fork boundary in order. Check history when supported and close each
 * verified fork before opening the next. The case client still owns a fork if a check rejects.
 */
async function checkForkBoundaries({ client, session, turn, relations, history }: {
  client: Client; session: Session; turn: Turn; relations: readonly Boundary['relation'][]; history?: boolean;
}): Promise<void> {
  for (const relation of relations) {
    const fork = await client.sessions.fork(session.reference, { boundary: { turnId: turn.id, relation } });
    requireCondition(fork.id !== session.id && fork.binding.adapterId === session.binding.adapterId, 'Fork binding invalid');
    if (history) {
      const page = await fork.request('history/read', { sessionId: fork.id, requestId: 'fork-history' });
      const includesBoundary = page.items.some(item => item.turnId === turn.id);
      requireCondition(includesBoundary === (relation !== 'before'), 'Fork boundary lost');
    }
    await fork.close();
  }
}

/** Verify the receipt for the first advertised scope, and check supported history when the scope includes conversation. */
async function checkRevertBoundary({ session, turn, scope, history }: {
  session: Session; turn: Turn; scope: RevertScope; history?: boolean;
}): Promise<void> {
  const sessionId = session.id;
  const result = await session.request('session/revert', { sessionId, requestId: 'revert', scope, boundary: { turnId: turn.id, relation: 'before' } });
  requireCondition(result.appliedScope === scope && result.boundary.turnId === turn.id, 'Revert scope mismatch');
  if (scope !== 'files' && history) {
    const page = await session.request('history/read', { sessionId, requestId: 'reverted-history' });
    requireCondition(!page.items.some(item => item.turnId === turn.id), 'Revert boundary retained');
  }
}

/** Check the contiguous session stream from the first observed sequence, since subscriptions have no replay. */
function checkEventSequence(session: Session, events: AhpEvent[]): void {
  const firstEvent = events[0];
  if (firstEvent === undefined) return;
  const contiguous = events.every((event, index) =>
    event.seq === firstEvent.seq + index && event.sessionId === session.id && event.streamId === firstEvent.streamId,
  );
  requireCondition(contiguous, 'Source sequence gap');
}

/** Throw assertion messages that runConformanceCase records as failed-case diagnostics. */
function requireCondition(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

/** Reject the wait at its deadline. The underlying promise stays observed and the case owner handles cleanup. */
function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Conformance timed out')), timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); }, cause => { clearTimeout(timer); reject(cause); });
  });
}

/** Let runConformanceCase skip scenarios whose required session capability was omitted. */
function isApplicable(scenario: ConformanceScenario, capabilities: Capabilities): boolean {
  if (isInteractionScenario(scenario)) return capabilities.interactions?.includes(scenario) ?? false;
  if (scenario === 'steer') return capabilities.input?.steer?.atomicMatch === true;
  if (scenario === 'interrupt') return !!capabilities.input?.interrupt?.targets.length;
  if (scenario === 'fork') return !!capabilities.session?.fork?.length;
  if (scenario === 'revert') return !!capabilities.session?.revert?.length;
  if (scenario === 'history') return !!capabilities.session?.history;
  return true;
}

/** Identify cases whose applicability and verdict depend on a native interaction. */
function isInteractionScenario(scenario: ConformanceScenario): scenario is typeof interactionKinds[number] {
  return interactionKinds.some(kind => kind === scenario);
}

/** Answer the SDK handler's request when the driver supplies no override. Approval fixtures must provide an option. */
function defaultAnswer(request: InteractionRequested): InteractionResponse {
  switch (request.kind) {
    case 'approval': return { kind: request.kind, optionId: request.options[0]!.id };
    case 'userInput': return { kind: request.kind, answers: Object.fromEntries(request.questions.map(question => [question.id, question.options?.[0]?.id ?? 'conformance'])) };
    case 'elicitation': return { kind: request.kind, action: 'decline' };
    case 'dynamicTool': return { kind: request.kind, content: [{ type: 'text', text: 'conformance' }] };
  }
}
