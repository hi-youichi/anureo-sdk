// Preserves legacy lifecycle helper imports; must not duplicate the helpers' policy or implementation.
/** Forward detached snapshot creation; snapshot ownership and clone failures stay with immutable's caller. */
export { immutable } from './immutable';
/** Forward input normalization; request admission and dispatch remain the consumer's responsibility. */
export { inputBlocks } from './input';
/** Forward budget validation; consumers still select defaults and enforce capacity. */
export { positive } from './limits';
/** Forward lifecycle gates; consumers still own settlement order and underlying work. */
export { deferred } from './deferred';
