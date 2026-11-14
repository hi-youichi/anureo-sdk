// Publishes the Pi adapter, host integration contracts and mapping and catalog helpers.
export { PiAdapter, PiBackendSession, createPiAdapter } from './adapter'
export type { PiAdapterOptions } from './options'
export { VERIFIED_PI_VERSIONS, resolvePiProfile, type PiProfile } from './profile'
export { createPiHost, type PiSessionHost, type PiHostEvent, type PiHostFactory, type PiHostOpenOptions, type PiHostMessage, type PiHostEntry, type PiHostModel } from './host'
export { createRedactor, permissionTools, piTurnError, historyItems, usageOf } from './mapping'
export { createPiCatalogSession, type PiModel } from './catalog'

/** Host history entry shape, also available as PiHostEntry. */
export type { PiHostEntry as PiEntry } from './host'
