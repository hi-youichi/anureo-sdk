// Publishes the supported host and adapter API; must not implement behavior or take ownership of runtime resources.
/** Host lifecycle entry points; Client owns adapter/session cleanup, while Session owns execution observation. */
export { createClient, Client } from './client';
export { Session } from './session';
export type { ClientOptions, InteractionHandlers, SubmitOptions } from './client-options';
export { Turn } from './turn';
export type { EventSubscriptionOptions, Input, RequestOptions, TurnResult } from './types';
export type * from './ports';
export * from './errors';
export { waitForRequest } from './request';
export * from './queue';
export * from './adapter/identity';
export * from './lifecycle/interactions';
export * from './process';
export * from './privacy/secrets';
/** Host-owned LogTape configuration is re-exported so applications can install sinks through this package; SDK logging stays silent until the host configures them. */
export { configure, configureSync, dispose, disposeSync, drain, getLogger, reset, resetSync } from '@logtape/logtape';
export type { Config, LogLevel, LogRecord, Logger, Sink } from '@logtape/logtape';
