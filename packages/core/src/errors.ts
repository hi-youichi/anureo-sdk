// Provides the stable error and wait import path; owns no error or waiting policy.
/** Public error envelope and normalization exports; implementations live with the error contract. */
export { HarnessSdkError, sdkError } from './sdk-error';
/** Caller-scoped wait API; implementation owns only timeout and abort observation. */
export { waitForRequest } from './request';
/** Options for caller-scoped wait observation. */
export type { RequestOptions } from './request';
