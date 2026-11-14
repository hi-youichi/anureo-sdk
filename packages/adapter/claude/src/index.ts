// Public application and extension exports; runtime implementations live in their owning modules.
export { ClaudeNativeAdapter, ClaudeBackendSession, createClaudeAdapter } from './adapter';
export type { ClaudeAdapterOptions, ClaudeQuery, ClaudeQueryFactory } from './options';
export { FileSessionStore } from './store';
export { createClaudeCatalogSession } from './catalog';
