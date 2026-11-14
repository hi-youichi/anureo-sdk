// Owns adapter negotiation, session open admission and client-wide resource release.
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

export { Session } from './session';
export type { ClientOptions, InteractionHandlers, SubmitOptions } from './client-options';

/**
 * Open and manage sessions through one adapter. Use createClient for an initialized client, or
 * construct and initialize it explicitly. Await dispose to release owned sessions and the adapter.
 */
export class Client {
  /**
   * Take ownership of the adapter without starting native I/O. Invalid identity, interaction
   * registrations or retention limits throw INVALID_PARAMS. Direct callers must await initialize
   * before opening sessions and later await dispose, including after failed initialization.
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
  /** Read a fresh copy of the adapter and runtime configuration IDs used to check session bindings. */
  get identity(): ClientOptions['identity'] {
    return { adapterId: this.options.identity.adapterId, runtimeConfigId: this.options.identity.runtimeConfigId };
  }
  /**
   * Negotiate adapter capabilities before opening sessions. Each call invokes adapter negotiation
   * once if admitted and stores the validated capability snapshot on success. The wait defaults to
   * 30 seconds unless configured by runtime.requestTimeoutMs. Invalid waits, adapter or protocol
   * failures, abort and timeout reject. A negotiation that finishes after a failed wait cannot update
   * the client's capabilities. createClient awaits this method and handles cleanup on failure.
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
   * Open with explicit request and binding IDs. Resolve with the client-owned Session after backend
   * attachment and initial state publication. Invalid input, unsupported mode, setup or wait failure
   * rejects. The attachment wait defaults to 120 seconds unless configured by runtime.openTimeoutMs.
   * If the wait ends early, the SDK closes local observation and still releases a late backend.
   */
  openSession(params: SessionOpenParams, wait?: RequestOptions): Promise<Session> { return this.open(params, wait); }
  /**
   * Release the client and its sessions. Stop admitting opens immediately and share the disposal
   * promise across calls. Await all owned session disposal attempts before releasing the adapter.
   * Reject with RESOURCE_RELEASE_FAILED if release fails. Disposal ends local observation and leaves
   * native execution stop unconfirmed. An open that delivers a backend after teardown releases it
   * on its own attachment path.
   */
  dispose(): Promise<void> {
    return this.disposing ??= this.disposeOwnedResources();
  }

  // TypeScript emits these as own fields. Keep their initialization order relative to sessions.
  private initialized?: Capabilities;
  private closed = false;
  private disposing?: Promise<void>;
  private readonly owned = new Set<Session>();
  private readonly createId: () => string;

  /** Open sessions using generated request IDs and the same attachment wait and ownership as openSession. */
  readonly sessions = {
    /** Open a new session with a fresh binding. A throwing ID generator fails the call synchronously. */
    create: (options: Omit<SessionOpenParams, 'requestId' | 'binding' | 'mode'>, wait?: RequestOptions) => this.open({
      ...options, mode: 'new', requestId: this.createId(),
      binding: this.newBinding(),
    }, wait),
    /** Reopen a saved session reference when supported. Foreign bindings reject and ID-generator throws propagate synchronously. */
    resume: (reference: { binding: SessionBinding; cwd: string }, wait?: RequestOptions) => this.open({ ...reference, mode: 'resume', requestId: this.createId() }, wait),
    /** Open a fresh session at a supported boundary in the referenced session. Foreign bindings reject before ID generation, which can throw synchronously. */
    fork: (reference: { binding: SessionBinding; cwd: string }, options: { boundary: AhpRequestMap['session/revert']['boundary'] }, wait?: RequestOptions) => {
      if (!matchesIdentity(reference.binding, this.options.identity)) return Promise.reject(new HarnessSdkError('SESSION_BINDING_MISMATCH'));
      return this.open({
        cwd: reference.cwd, mode: 'fork', requestId: this.createId(),
        binding: this.newBinding(),
        fork: { sourceSessionId: reference.binding.sessionId, nativeRef: reference.binding.nativeRef, boundary: options.boundary },
      }, wait);
    },
  };

  /**
   * sessions.create and sessions.fork use this for a fresh destination after generating the request
   * ID. Snapshot the configured identity before invoking the host's session ID generator.
   */
  private newBinding(): SessionBinding {
    return { ...this.options.identity, sessionId: this.createId() };
  }

  /**
   * dispose caches this release attempt. Close admission before taking the session snapshot and
   * keep the adapter alive until all session disposals settle. Report failures in session order,
   * followed by the adapter failure, through the shared disposal promise.
   */
  private async disposeOwnedResources(): Promise<void> {
    this.closed = true;
    const sessions = await Promise.allSettled([...this.owned].map(session => session.dispose()));
    const [adapter] = await Promise.allSettled([this.options.adapter.dispose()]);
    this.owned.clear();
    const failures = [...sessions, adapter].filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw combined(failures.map(failure => failure.reason));
  }

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
 * Create and initialize a client before opening sessions. A pre-aborted wait rejects before the
 * client takes ownership of the adapter. Once construction succeeds, initialization failure triggers
 * disposal before rejection. The original cause is preserved unless disposal also fails, in which
 * case both failures are reported as RESOURCE_RELEASE_FAILED. Await dispose on the returned client.
 * createRefactorClient and createReviewClient return this promise to their CLI commands, which
 * await disposal after the run and report output.
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
