export { HarnessHost } from './host'
export type {
  HostConnection, HostOptions, HostProjection, PermissionPolicyPort, Principal, Role,
  RuntimeRegistration, RuntimeAuthStatus, FullAccessSession, PermissionDowngradeResult,
} from './host'
export { HostError } from './errors'
export { attachInteractionCapture, createInteractionCapture } from './interaction-capture'
export type { HostDispatcher, RpcNotification, RpcRequest, RpcResponse } from './rpc'
export type { CatalogWorker, CatalogDiagnostic } from './catalog-worker'
export type { CatalogModel } from './catalog-store'
export type { SessionRecord, HostStorage } from './store'
export type { SubagentDiscoveryPort, SubagentHistoryPort } from './subagents'
export * from './workspaces'

export type { HostActor, HostAuthorizationPolicy, CreateHostOptions } from './scoped-host'
export { createHarnessHost, createScopedHostDispatcher } from './scoped-host'
