// Publishes host APIs and adapter support exports; must not implement behavior or acquire runtime resources.
/** Hosts construct/initialize a client here and await its disposal to release sessions before the adapter. */
export { createClient, Client } from './client';
/** Hosts receive sessions from Client opens; Session owns request dispatch, ordered events and observation cleanup. */
export { Session } from './session';
/** Host configuration, automatic interaction handlers and submission policy consumed by Client/Session. */
export type { ClientOptions, InteractionHandlers, SubmitOptions } from './client-options';
/** Session.submit returns this independent execution observer; disposal releases only that handle's observation. */
export { Turn } from './turn';
/** Host inputs, terminal snapshots and caller-scoped wait/subscription policy. */
export type { EventSubscriptionOptions, Input, RequestOptions, TurnResult } from './types';
/** Adapter-implemented resource ports and runtime-supplied callbacks; implementations retain their documented native cleanup duties. */
export type * from './ports';
/** Safe failure construction/normalization for host error handling and adapter boundaries. */
export * from './errors';
/** Runtime/adapter callers can bound observation waits while keeping dispatched work observed; this helper never cancels native execution. */
export { waitForRequest } from './request';
/** Adapter/observer buffering primitives, also available from the package's queue entry point. */
export * from './queue';
/** Adapter-owned session-local identity mapping; adapters decide when old native mappings can be cleared. */
export * from './adapter/identity';
/** Interaction settlement/replay registry used by Session; direct consumers supply publication and own handler/privacy integration. */
export * from './lifecycle/interactions';
/** Adapter subprocess handles and launch helpers, also available from the process entry point; callers drain output and await handle disposal. */
export * from './process';
/** Marked-secret projection used by Session; direct consumers own registration order and any privacy-metadata persistence. */
export * from './privacy/secrets';
/**
 * Forward LogTape's host logging controls without adding SDK ownership. The exported dispose is
 * LogTape's logging teardown; native resources are released through Client.dispose separately.
 */
export { configure, configureSync, dispose, disposeSync, drain, getLogger, reset, resetSync } from '@logtape/logtape';
/** LogTape types for hosts configuring logging through the forwarded functions above. */
export type { Config, LogLevel, LogRecord, Logger, Sink } from '@logtape/logtape';
