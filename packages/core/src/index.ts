// Root entry point for the application API, adapter contracts and host utilities.
export { createClient, Client } from './client';
export { Session } from './session';
export type { ClientOptions, InteractionHandlers, SubmitOptions } from './client-options';
export { Turn } from './turn';
export type { EventSubscriptionOptions, Input, RequestOptions, TurnResult } from './types';
export type * from './ports';
export * from './errors';
export { waitForRequest } from './request';
/** Adapter/observer buffering primitives, also available from the package's queue entry point. */
export * from './queue';
/** Session-local native ID mapping implementation. */
export * from './adapter/identity';
/** Interaction settlement and replay implementation used by Session. */
export * from './lifecycle/interactions';
/** Adapter subprocess handles and launch helpers, also available from the process entry point; callers drain output and await handle disposal. */
export * from './process';
/** Marked-secret projection implementation used by Session. */
export * from './privacy/secrets';
/**
 * Forward LogTape's host logging controls without adding SDK ownership. The exported dispose is
 * LogTape's logging teardown; native resources are released through Client.dispose separately.
 */
export { configure, configureSync, dispose, disposeSync, drain, getLogger, reset, resetSync } from '@logtape/logtape';
/** LogTape types for hosts configuring logging through the forwarded functions above. */
export type { Config, LogLevel, LogRecord, Logger, Sink } from '@logtape/logtape';
/** Explicit unattended approval policy for hosts; never enabled by Client automatically. */
export { approveWithNarrowestScope } from './lifecycle/approval';
