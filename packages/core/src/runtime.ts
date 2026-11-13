// Owns client initialization and session resource ownership; must not implement session event processing.
import { randomUUID } from 'node:crypto';
import { AHP_PROTOCOL_CONTRACT, assertRequest, assertResult, supportsCapability,
  type AhpRequestMap, type Capabilities, type InteractionRequested, type SessionBinding, type SessionOpenParams } from '@anureo/protocol';
import { HarnessSdkError } from './sdk-error';
import { invalidWait, waitForRequest, type RequestOptions } from './request';
import type { ClientOptions } from './client-options';
import { Session } from './session';
import { immutable } from './lifecycle/immutable';
import { positive } from './limits';
import { combined } from './lifecycle/errors';
import { withStructuredOutput } from './structured-output/adapter';

export { Session } from './session';
export type { ClientOptions, InteractionHandlers, SubmitOptions } from './client-options';

/** Check host configuration before initialization; throw INVALID_PARAMS without calling host handlers or acquiring native resources. */
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

/** Compare a session/source binding with the client's identity without side effects; session IDs may differ when forking within that identity. */
function matchesIdentity(binding: SessionBinding, identity: ClientOptions['identity']): boolean {
  return binding.adapterId === identity.adapterId && binding.runtimeConfigId === identity.runtimeConfigId;
}

/** For failed client/open setup, await owned cleanup then reject the original cause; aggregate cleanup failure so neither cause is lost. */
async function rethrowAfterCleanup(cause: unknown, cleanup: () => Promise<void>): Promise<never> {
  try { await cleanup(); }
  catch (cleanupFailure) { throw combined([cause, cleanupFailure]); }
  throw cause;
}

/** Owns an adapter and its opened sessions; hosts initialize before opening and dispose to release all owned resources. Session execution semantics belong to Session. */
export class Client {
  private initialized?: Capabilities;
  private closed = false;
  private disposing?: Promise<void>;
  private readonly owned = new Set<Session>();
  private readonly createId: () => string;
  /** Hosts may construct without I/O, then initialize before opening; wrap the owned adapter and throw INVALID_PARAMS for invalid identity, handlers or limits. */
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
  /** Return a detached identity for host/workflow cache keys; changing it cannot alter the client's binding checks. */
  get identity(): ClientOptions['identity'] {
    return { adapterId: this.options.identity.adapterId, runtimeConfigId: this.options.identity.runtimeConfigId };
  }
  /** Negotiate and validate adapter capabilities before opening sessions; reject protocol, adapter or wait failures. A caller timeout does not cancel initialization. */
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
  /** Convenience session entry points share open validation and resource ownership; generated identities remain stable for each attempted open. */
  readonly sessions = {
    /** Open a new native session with fresh binding/request IDs; reject open/wait failure through the shared owner. */
    create: (options: Omit<SessionOpenParams, 'requestId' | 'binding' | 'mode'>, wait?: RequestOptions) => this.open({
      ...options, mode: 'new', requestId: this.createId(),
      binding: { ...this.options.identity, sessionId: this.createId() },
    }, wait),
    /** Resume a matching stable binding through shared open validation; reject unsupported resume or native/wait failure. */
    resume: (reference: { binding: SessionBinding; cwd: string }, wait?: RequestOptions) => this.open({ ...reference, mode: 'resume', requestId: this.createId() }, wait),
    /** Fork an explicit native boundary into a fresh session; reject foreign source bindings before shared open admission. */
    fork: (reference: { binding: SessionBinding; cwd: string }, options: { boundary: AhpRequestMap['session/revert']['boundary'] }, wait?: RequestOptions) => {
      if (!matchesIdentity(reference.binding, this.options.identity)) return Promise.reject(new HarnessSdkError('SESSION_BINDING_MISMATCH'));
      return this.open({
        cwd: reference.cwd, mode: 'fork', requestId: this.createId(),
        binding: { ...this.options.identity, sessionId: this.createId() },
        fork: { sourceSessionId: reference.binding.sessionId, nativeRef: reference.binding.nativeRef, boundary: options.boundary },
      }, wait);
    },
  };
  /** Open from host-supplied params after initialization; clone params for session/native ownership and reject invalid bindings, unsupported modes, wait or setup/cleanup failures. */
  openSession(params: SessionOpenParams, wait?: RequestOptions): Promise<Session> { return this.open(params, wait); }
  /** Validate binding/capabilities before native open, register ownership first, and dispose failed opens; reject original or aggregated cleanup errors without abandoning late attachment cleanup. */
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

  /** Check open admission synchronously in error-precedence order; return negotiated capabilities or throw before allocating a session or dispatching native work. */
  private validateOpen(params: SessionOpenParams, wait?: RequestOptions): Capabilities {
    if (invalidWait(wait)) throw new HarnessSdkError('INVALID_PARAMS');
    if (wait?.signal?.aborted) throw new HarnessSdkError('REQUEST_ABORTED');
    if (this.closed) throw new HarnessSdkError('CLIENT_DISPOSED');
    if (!this.initialized) throw new HarnessSdkError('NOT_INITIALIZED');
    assertRequest('session/open', params);
    if (!matchesIdentity(params.binding, this.options.identity)) throw new HarnessSdkError('SESSION_BINDING_MISMATCH');
    if (params.mode === 'resume' && !supportsCapability(this.initialized, 'session.resume')) {
      throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    }
    // The protocol schema requires fork details in fork mode, though its public type is optional.
    if (params.mode === 'fork' && params.fork && !supportsCapability(this.initialized, 'session.fork', params.fork.boundary.relation)) {
      throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    }
    return this.initialized;
  }

  /** Open and attach for the caller-wait wrapper; keep observing late work so the adapter wrapper or Session.attach releases backends after timeout/disposal. Native and attachment failures propagate. */
  private async attachSession(params: SessionOpenParams, session: Session): Promise<void> {
    const backend = await this.options.adapter.openSession(structuredClone(params), session);
    await session.attach(backend);
  }
  /** Idempotently close admission, settle all session disposals, then dispose the adapter; reject aggregated release failures only after all owned cleanup attempts finish. */
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
}
/** Copy host options and initialize a new Client; return it ready for opens or dispose it before propagating initialization/cleanup failure. Reject pre-aborted waits before constructing resources. */
export async function createClient(options: ClientOptions, wait?: RequestOptions): Promise<Client> {
  if (wait?.signal?.aborted) throw new HarnessSdkError('REQUEST_ABORTED');
  const client = new Client({
    ...options, identity: { ...options.identity }, runtime: { ...options.runtime },
    interactions: { ...options.interactions }, limits: { ...options.limits },
  });
  try { await client.initialize(wait); return client; }
  catch (cause) { return rethrowAfterCleanup(cause, () => client.dispose()); }
}
