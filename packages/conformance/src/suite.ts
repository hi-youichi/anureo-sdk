import { createClient, type HarnessAdapter, type Client, type Session, type Turn, type RuntimeOptions, type InteractionHandlers } from '@anureo/sdk';
import type { Capabilities, AhpEvent, InteractionRequested, InteractionResponse, SessionOpenParams } from '@anureo/protocol';

/** Shared acceptance cases; native overlap and observation ownership are checked separately by runNativeConformance. */
export const CONFORMANCE_SCENARIOS = ['lifecycle','immediate','identity','approval','userInput','elicitation','dynamicTool','interrupt','steer','fork','revert','history','unknown-item','disconnect','backpressure'] as const;
/** Select a shared behavioral case for an adapter fixture. */
export type ConformanceScenario = typeof CONFORMANCE_SCENARIOS[number];
/** Supply scenario-specific native behavior; runConformance creates and disposes the SDK client. */
export interface ConformanceDriver {
  /** Fresh adapter owned by the runner once client creation begins. */
  adapter: HarnessAdapter;
  /** Initial session identity and native setup, passed to Client.openSession. */
  openParams: SessionOpenParams;
  /** SDK policy overrides, including queue limits for backpressure fixtures. */
  runtimeOptions?: RuntimeOptions;
  /** Awaited after submit and any steer/interrupt, before result observation; rejection fails the case (or supplies the expected source fault). */
  afterStart?: (session: Session) => Promise<void>;
  /** Authoritative text expected by lifecycle/immediate; defaults to 'conformance'. */
  expectedText?: string;
  /** Automatic interaction answer; defaults to the first approval/choice, 'conformance' input/tool text, or declined elicitation. */
  answer?: (request: InteractionRequested) => InteractionResponse;
}
/** Called once per selected case. Return isolated fixtures; retain cleanup responsibility for external resources and failed factory setup. */
export type ConformanceFactory = (scenario: ConformanceScenario) => Promise<ConformanceDriver> | ConformanceDriver;
/** A missing optional capability is not-applicable; declared but broken behavior is failed. */
export interface ConformanceCaseResult { scenario: ConformanceScenario; status: 'passed' | 'failed' | 'not-applicable'; message?: string }
/** Ordered case verdicts; passed means no selected case failed, including when cases are not-applicable. */
export interface ConformanceReport { passed: boolean; cases: ConformanceCaseResult[] }

/**
 * Check an adapter through the public SDK, sequentially in the selected order (all shared cases by default).
 * Adapter suites assert the returned verdicts; fixture/assertion failures become failed cases and client
 * release failures replace that case's message with RESOURCE_RELEASE_FAILED. Event-reader teardown
 * failures reject the run before client disposal. Initial turn observation has a 3000 ms deadline unless timeoutMs is supplied;
 * setup, later history/fork checks and cleanup retain their own SDK/fixture wait policies.
 * The runner releases readers and clients; factories must release their external fixture resources.
 */
export async function runConformance(factory: ConformanceFactory, options: {timeoutMs?:number;scenarios?:readonly ConformanceScenario[]}={}):Promise<ConformanceReport>{
  const cases: ConformanceCaseResult[] = [];
  for (const scenario of options.scenarios ?? CONFORMANCE_SCENARIOS) {
    cases.push(await runConformanceCase({ factory, scenario, timeoutMs: options.timeoutMs ?? 3000 }));
  }
  return { passed: cases.every(entry => entry.status !== 'failed'), cases };
}

/** Keep acquisition and ordered release together so skipped and failed cases release the same owners. */
async function runConformanceCase({ factory, scenario, timeoutMs }: {
  factory: ConformanceFactory; scenario: ConformanceScenario; timeoutMs: number;
}): Promise<ConformanceCaseResult> {
  let client: Client | undefined;
  let observation: ReturnType<typeof collectEvents> | undefined;
  let result: ConformanceCaseResult;
  try {
    const driver = await factory(scenario);
    const handlers = Object.fromEntries(['approval','userInput','elicitation','dynamicTool'].map(kind => [kind,
      async (request: InteractionRequested) => (driver.answer ?? defaultAnswer)(request),
    ])) as InteractionHandlers;
    client = await createClient({ adapter: driver.adapter, identity: driver.openParams.binding, runtime: driver.runtimeOptions, interactions: handlers });
    const session = await client.openSession(driver.openParams);
    if (!applicable(scenario, session.capabilities)) {
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

/** Own the reader's mutable state; a fulfilled task lets scenario logic decide whether source loss is expected. */
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

/** Run the bounded observation phase, then verify retained events and any session operations. */
async function checkScenario({ client, session, driver, scenario, observation, timeoutMs }: {
  client: Client; session: Session; driver: ConformanceDriver; scenario: ConformanceScenario;
  observation: ReturnType<typeof collectEvents>; timeoutMs: number;
}): Promise<void> {
  const { events } = observation;
  const capabilities = session.capabilities;
  const execution = executeScenarioTurn({ session, driver, scenario, capabilities });
  if (scenario === 'disconnect' || scenario === 'backpressure') {
    await checkSourceFailure({ execution, scenario, events, timeoutMs });
  } else {
    const { turn, result } = await deadline(Promise.race([
      execution,
      observation.task.then(() => { throw observation.failure ?? new Error('Source ended before result'); }),
    ]), timeoutMs);
    checkTurnResult({ scenario, driver, events, result });
    if (['identity', 'history', 'fork', 'revert'].includes(scenario)) {
      await checkSessionOperations({ client, session, scenario, turn, capabilities });
    }
  }
  requireCondition(!observation.failure || scenario === 'disconnect' || scenario === 'backpressure', 'Unexpected source failure');
  requireCondition(events.every((event, index) => event.seq === events[0]!.seq + index && event.sessionId === session.id && event.streamId === events[0]!.streamId), 'Source sequence gap');
}

/** Preserve native admission ordering: session interruption can precede a receipt; turn controls require its identity. */
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

/** Lost sources must reject with a recognized observation error, never a fabricated native terminal. */
async function checkSourceFailure({ execution, scenario, events, timeoutMs }: {
  execution: ReturnType<typeof executeScenarioTurn>; scenario: 'disconnect' | 'backpressure'; events: AhpEvent[]; timeoutMs: number;
}): Promise<void> {
  let failed = false;
  try {
    await deadline(execution, timeoutMs);
  } catch (cause) {
    requireCondition(cause && typeof cause === 'object' && 'code' in cause, 'Source failure must be typed');
    const expectedCodes = scenario === 'disconnect'
      ? ['CONNECTION_CLOSED', 'ACP_CONNECTION_CLOSED', 'RPC_CONNECTION_CLOSED']
      : ['BACKPRESSURE_EXCEEDED', 'FRAME_TOO_LARGE'];
    requireCondition(expectedCodes.includes(String(cause.code)), `Unexpected observation error: ${String(cause.code)}`);
    failed = true;
  }
  requireCondition(failed, 'Lost source must fail observation');
  requireCondition(!events.some(event => event.type === 'turn/completed'), 'SDK must not fabricate native terminal');
}

/** Check native terminal evidence before identity/history operations add further executions and events. */
function checkTurnResult({ scenario, driver, events, result }: {
  scenario: ConformanceScenario; driver: ConformanceDriver; events: AhpEvent[]; result: Awaited<ReturnType<Turn['result']>>;
}): void {
  requireCondition(result.status === (scenario === 'interrupt' ? 'interrupted' : 'completed'), 'Unexpected native terminal');
  requireCondition(events.filter(event => event.type === 'turn/started').length === 1, 'Execution must start once');
  requireCondition(events.filter(event => event.type === 'turn/completed').length === 1, 'Execution must end once');
  if (['approval','userInput','elicitation','dynamicTool'].includes(scenario)) {
    requireCondition(events.some(event => event.type === 'interaction/requested') && events.some(event => event.type === 'interaction/resolved'), 'Interaction not exercised');
  }
  if (scenario === 'lifecycle' || scenario === 'immediate') requireCondition(result.text === (driver.expectedText ?? 'conformance'), 'Authoritative final text missing');
  if (scenario === 'unknown-item') requireCondition(result.items.some(item => item.type === 'toolCall' && item.kind === 'other' && item.nativeType), 'Unknown native item lost');
}

/** Exercise only the selected post-turn operation; applicability has already established required capabilities. */
async function checkSessionOperations({ client, session, scenario, turn, capabilities }: {
  client: Client; session: Session; scenario: ConformanceScenario; turn: Turn; capabilities: Capabilities;
}): Promise<void> {
  const sessionId = session.id;
  if (scenario === 'identity') {
    const other = await session.submit({ input: 'conformance' });
    await other.result();
    requireCondition(other.id !== turn.id, 'Execution identity reused');
  }
  if (scenario === 'history') {
    const page = await session.request('history/read', { sessionId, requestId: 'history' });
    requireCondition(page.items.length && page.items.every(item => item.turnId && item.item.id), 'History identity missing');
  }
  if (scenario === 'fork') for (const relation of capabilities.session!.fork!) {
    const fork = await client.sessions.fork(session.reference, { boundary: { turnId: turn.id, relation } });
    requireCondition(fork.id !== session.id && fork.binding.adapterId === session.binding.adapterId, 'Fork binding invalid');
    if (capabilities.session?.history) {
      const page = await fork.request('history/read', { sessionId: fork.id, requestId: 'fork-history' });
      requireCondition(relation === 'before' ? !page.items.some(item => item.turnId === turn.id) : page.items.some(item => item.turnId === turn.id), 'Fork boundary lost');
    }
    await fork.close();
  }
  if (scenario === 'revert') {
    const scope = capabilities.session!.revert![0]!;
    const result = await session.request('session/revert', { sessionId, requestId: 'revert', scope, boundary: { turnId: turn.id, relation: 'before' } });
    requireCondition(result.appliedScope === scope && result.boundary.turnId === turn.id, 'Revert scope mismatch');
    if (scope !== 'files' && capabilities.session?.history) {
      const page = await session.request('history/read', { sessionId, requestId: 'reverted-history' });
      requireCondition(!page.items.some(item => item.turnId === turn.id), 'Revert boundary retained');
    }
  }
}

/** Throw assertion messages that runConformanceCase records as failed-case diagnostics. */
function requireCondition(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

/** Bound observation without cancelling its work; the case owner still returns the reader and disposes the client. */
function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Conformance timed out')), timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); }, cause => { clearTimeout(timer); reject(cause); });
  });
}

/** Omitted optional capabilities skip cases; a declared capability must exercise its native fixture. */
function applicable(scenario: ConformanceScenario, capabilities: Capabilities): boolean {
  if (['approval','userInput','elicitation','dynamicTool'].includes(scenario)) return capabilities.interactions?.includes(scenario as InteractionRequested['kind']) ?? false;
  if (scenario === 'steer') return capabilities.input?.steer?.atomicMatch === true;
  if (scenario === 'interrupt') return !!capabilities.input?.interrupt?.targets.length;
  if (scenario === 'fork') return !!capabilities.session?.fork?.length;
  if (scenario === 'revert') return !!capabilities.session?.revert?.length;
  if (scenario === 'history') return !!capabilities.session?.history;
  return true;
}

/** Automatic handler fallback for fixture requests; approval fixtures must supply at least one option. */
function defaultAnswer(request: InteractionRequested): InteractionResponse {
  switch (request.kind) {
    case 'approval': return { kind: request.kind, optionId: request.options[0]!.id };
    case 'userInput': return { kind: request.kind, answers: Object.fromEntries(request.questions.map(question => [question.id, question.options?.[0]?.id ?? 'conformance'])) };
    case 'elicitation': return { kind: request.kind, action: 'decline' };
    case 'dynamicTool': return { kind: request.kind, content: [{ type: 'text', text: 'conformance' }] };
  }
}
