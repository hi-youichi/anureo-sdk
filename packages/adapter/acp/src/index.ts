// Publishes the ACP adapter, host integration contracts and DeepSeek Harness preset.
export { AcpAdapter, AcpBackendSession, createAcpAdapter } from './adapter';
export { createDshAcpAdapter, type DshAcpOptions } from './dsh';
export type {
  AcpAdapterOptions, AcpChannel, AcpFileSystemPort, AcpPermissionContext,
  AcpPermissionDecision, AcpPermissionPolicy, AcpTerminalPort,
} from './options';
