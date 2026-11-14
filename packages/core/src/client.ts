// Owns negotiation, open admission and client-wide resource release; must not process session events.
import { randomUUID } from 'node:crypto';
import { AHP_PROTOCOL_CONTRACT, assertRequest, assertResult, supportsCapability,
  type AhpRequestMap, type Capabilities, type InteractionRequested, type SessionBinding, type SessionOpenParams } from '@anureo/protocol';
import { HarnessSdkError } from './errors';
import { invalidWait, waitForRequest } from './request';
import type { RequestOptions } from './types';
import type { ClientOptions } from './client-options';
import { Session } from './session';
import { immutable } from './lifecycle/immutable';
import { positive } from './lifecycle/limits';
import { combined } from './lifecycle/errors';
import { withStructuredOutput } from './structured-output/adapter';

/** Preserve the client-module Session export for hosts consuming sessions returned by open methods. */
export { Session } from './session';
/** Preserve host configuration exports alongside the Client entry point; implementations live in client-options. */
export type { ClientOptions, InteractionHandlers, SubmitOptions } from './client-options';

/**
 * Host entry point owning an adapter and every admitted Session. createClient returns an initialized
 * instance; direct constructors require initialize before opens. Hosts must await dispose for
 * session-before-adapter release; native execution/observation policy remains with Session.
 */
export class Client {
  /**
   * createClient and hosts constructing directly supply the owned adapter and host policy. Install
   * structured-output wrapping without native I/O, then validate options; invalid identity, handlers
   * or limits throw INVALID_PARAMS. Direct callers must initialize before opening and dispose later.
   */
  constructor(private readonly options: ClientOptions) {
    this.options = {
      ...options,
      adapter: withStructuredOutput(options.adapter, {
        queue: options.runtime?.queue,
        maxSubmissions: options.limits?.maxSubmissions,
        maxResultBytes: options.limits?.maxResultBytes,
        maxItems: options.limits?.maxItems,
      }),
    };
    this.createId = options.runtime?.createId ?? randomUUID;
    assertClientOptions(options);
  }
  /** Give host consumers a fresh adapter/configuration identity; mutating this copy cannot change open-admission checks. */
  get identity(): ClientOptions['identity'] {
    return { adapterId: this.options.identity.adapterId, runtimeConfigId: this.options.identity.runtimeConfigId };
  }
  /**
   * createClient awaits this negotiation before returning; direct users await it before opens.
   * Each call negotiates anew; callers must order initialization before opening sessions.
   * Validate and store a detached frozen capability snapshot only if the caller wait succeeds.
   * Protocol, adapter, abort and timeout failures reject; late initialization remains observed but
   * does not store capabilities after a failed wait. Direct users retain disposal responsibility.
   */
  async initialize(wait?: RequestOptions): Promise<void> {
    if (invalidWait(wait)) throw new HarnessSdkError('INVALID_PARAMS');
    const result = await waitForRequest(() => this.options.adapter.initialize({
      protocolVersions: [1],
      protocolContract: AHP_PROTOCOL_CONTRACT,
      clientInfo: { name: 'anureo-native-lifecycle', version: '0.2.0' },
      // Own keys advertise support even when the host will respond manually.
      clientCapabilities: { interactions: Object.keys(this.options.interactions ?? {}) as InteractionRequested['kind'][] },
    }), wait, this.options.runtime?.requestTimeoutMs);
    assertResult('initialize', result);
    this.initialized = immutable(result.capabilities);
  }
  /**
   * Hosts supplying their own request/binding IDs enter the same open path as sessions.create,
   * resume and fork. Resolve only after native attachment and initial state publication; reject
   * admission, wait or setup/cleanup failure. The returned Session remains owned by this client.
   */
  openSession(params: SessionOpenParams, wait?: RequestOptions): Promise<Session> { return this.open(params, wait); }
  /**
   * Hosts await this to release the client; createClient also awaits it after initialization failure.
   * Close open admission immediately and share one promise across calls. Attempt every owned session
   * disposal before adapter disposal, then clear ownership and reject aggregated release failures.
   * Disposal ends local observation; it does not confirm native execution stopped.
   */
  dispose(): Promise<void> {
    return this.disposing ??= (async () => {
      this.closed = true;
      const results = await Promise.allSettled([...this.owned].map(session => session.dispose()));
      // Adapter resources can underpin every session, so release them only after all session attempts settle.
      results.push(...await Promise.allSettled([this.options.adapter.dispose()]));
      this.owned.clear();
      const failures = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected');
      if (failures.length) throw combined(failures.map(value => value.reason));
    })();
  }

  // Preserve state-field initialization before the sessions convenience object.
  private initialized?: Capabilities;
  private closed = false;
  private disposing?: Promise<void>;
  private readonly owned = new Set<Session>();
  private readonly createId: () => string;
  /** Host convenience operations return the Session owned by open, or its admission/setup rejection; callers still dispose the client. */
  readonly sessions = {
    /** Generate request/session IDs for a new host session, then return open's attachment result or rejection; ID-source throws propagate synchronously. */
    create: (options: Omit<SessionOpenParams, 'requestId' | 'binding' | 'mode'>, wait?: RequestOptions) => this.open({
      ...options, mode: 'new', requestId: this.createId(),
      binding: { ...this.options.identity, sessionId: this.createId() },
    }, wait),
    /** Reopen a host resume reference with a fresh request ID; open rejects foreign/unsupported references or setup/wait failure. ID-source throws are synchronous. */
    resume: (reference: { binding: SessionBinding; cwd: string }, wait?: RequestOptions) => this.open({ ...reference, mode: 'resume', requestId: this.createId() }, wait),
    /** Reject a foreign source before generating IDs, then return open's fresh fork at the supplied boundary; ID-source throws are synchronous. */
    fork: (reference: { binding: SessionBinding; cwd: string }, options: { boundary: AhpRequestMap['session/revert']['boundary'] }, wait?: RequestOptions) => {
      if (!matchesIdentity(reference.binding, this.options.identity)) return Promise.reject(new HarnessSdkError('SESSION_BINDING_MISMATCH'));
      return this.open({
        cwd: reference.cwd, mode: 'fork', requestId: this.createId(),
        binding: { ...this.options.identity, sessionId: this.createId() },
        fork: { sourceSessionId: reference.binding.sessionId, nativeRef: reference.binding.nativeRef, boundary: options.boundary },
      }, wait);
    },
  };
  /**
   * openSession and sessions.create/resume/fork return this promise to hosts. Validate before
   * allocating a Session, then own it before native callbacks or disposal can race attachment.
   * Resolve the attached session, or remove it and await disposal before rejecting setup/wait failure
   * (aggregated if cleanup fails). attachSession continues to release late backends after wait failure.
   */
  private async open(params: SessionOpenParams, wait?: RequestOptions): Promise<Session> {
    const capabilities = this.validateOpen(params, wait);
    const session = new Session(structuredClone(params), this.options, capabilities, this.createId);
    // Own the sink before dispatch: native events and client disposal can race attachment.
    this.owned.add(session);
    try {
      await waitForRequest(() => this.attachSession(params, session), wait, this.options.runtime?.openTimeoutMs ?? 120_000);
      if (this.closed) throw new HarnessSdkError('CLIENT_DISPOSED');
      return session;
    } catch (cause) {
      this.owned.delete(session);
      return rethrowAfterCleanup(cause, () => session.dispose());
    }
  }

  /**
   * Client.open uses the returned negotiated capabilities to construct Session. Preserve admission
   * precedence: wait validity, abort, client state, protocol shape, binding, then mode capability.
   * Throws before session allocation/native dispatch; open exposes that failure as its rejection.
   */
  private validateOpen(params: SessionOpenParams, wait?: RequestOptions): Capabilities {
    if (invalidWait(wait)) throw new HarnessSdkError('INVALID_PARAMS');
    if (wait?.signal?.aborted) throw new HarnessSdkError('REQUEST_ABORTED');
    if (this.closed) throw new HarnessSdkError('CLIENT_DISPOSED');
    if (!this.initialized) throw new HarnessSdkError('NOT_INITIALIZED');
    assertRequest('session/open', params);
    if (!matchesIdentity(params.binding, this.options.identity)) throw new HarnessSdkError('SESSION_BINDING_MISMATCH');
    assertOpenCapability(params, this.initialized);
    return this.initialized;
  }

  /**
   * Client.open passes this operation to waitForRequest. Give the wrapped adapter a separate params
   * clone and the Session sink, then await attachment/publication. This work outlives caller abort or
   * timeout: OutputSession.open or Session.attach disposes a backend arriving after teardown.
   * Native/attachment failures reject the operation and remain observed by waitForRequest.
   */
  private async attachSession(params: SessionOpenParams, session: Session): Promise<void> {
    const backend = await this.options.adapter.openSession(structuredClone(params), session);
    await session.attach(backend);
  }
}
/**
 * Host factory returning a Client ready for session opens. Copy the option containers, construct and
 * await initialize; on initialization/wait failure, await disposal before rejecting the cause or
 * combined cleanup failure. Pre-aborted waits reject before construction. Successful callers own
 * the returned client and must await dispose; supplied callbacks keep their host-owned effects.
 */
export async function createClient(options: ClientOptions, wait?: RequestOptions): Promise<Client> {
  if (wait?.signal?.aborted) throw new HarnessSdkError('REQUEST_ABORTED');
  const client = new Client({
    ...options, identity: { ...options.identity }, runtime: { ...options.runtime },
    interactions: { ...options.interactions }, limits: { ...options.limits },
  });
  try { await client.initialize(wait); return client; }
  catch (cause) { return rethrowAfterCleanup(cause, () => client.dispose()); }
}

/**
 * Client's constructor checks host identity, retention limits and interaction registrations here
 * after installing the output wrapper. Throw INVALID_PARAMS before native initialization; no host
 * callback is invoked and no native resource is acquired by these checks.
 */
function assertClientOptions(options: ClientOptions): void {
  for (const value of [options.identity.adapterId, options.identity.runtimeConfigId]) {
    if (typeof value !== 'string' || !value.trim()) throw new HarnessSdkError('INVALID_PARAMS');
  }
  for (const value of Object.values(options.limits ?? {})) positive(value, 1);
  for (const [kind, handler] of Object.entries(options.interactions ?? {})) {
    if (!['approval', 'userInput', 'elicitation', 'dynamicTool'].includes(kind)
      || handler !== undefined && typeof handler !== 'function') throw new HarnessSdkError('INVALID_PARAMS');
  }
}

/**
 * Return whether a binding belongs to this adapter/configuration, without comparing session IDs.
 * Client.sessions.fork rejects foreign sources with this result before generating IDs;
 * Client.validateOpen rejects foreign destination bindings before allocating Session state.
 */
function matchesIdentity(binding: SessionBinding, identity: ClientOptions['identity']): boolean {
  return binding.adapterId === identity.adapterId && binding.runtimeConfigId === identity.runtimeConfigId;
}

/**
 * Client.validateOpen calls this only after protocol shape and binding validation. Reject unsupported
 * resume/fork modes with CAPABILITY_UNSUPPORTED before native work; new sessions need no mode
 * capability. Keep shape checks with the caller so malformed fork details fail before capability checks.
 */
function assertOpenCapability(params: SessionOpenParams, capabilities: Capabilities): void {
  if (params.mode === 'resume' && !supportsCapability(capabilities, 'session.resume')) {
    throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
  }
  // assertRequest requires fork details in fork mode, although the public type leaves them optional.
  if (params.mode === 'fork' && params.fork && !supportsCapability(capabilities, 'session.fork', params.fork.boundary.relation)) {
    throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
  }
}

/**
 * Client.open supplies Session.dispose after failed attachment/wait; createClient supplies
 * Client.dispose after failed initialization. Await that cleanup before rejecting with the original
 * cause, or a privacy-safe aggregate if cleanup also fails. Callers return this rejection to hosts.
 */
async function rethrowAfterCleanup(cause: unknown, cleanup: () => Promise<void>): Promise<never> {
  try { await cleanup(); }
  catch (cleanupFailure) { throw combined([cause, cleanupFailure]); }
  throw cause;
}
