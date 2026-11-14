/**
 * Clone acyclic protocol data and freeze enumerable object and array descendants. Cloning or
 * freezing failures throw and leave the original value untouched.
 *
 * Called by:
 * - Client.initialize to store negotiated capabilities; failure rejects initialization.
 * - Session's constructor/attach and binding/reference/capabilities/snapshot getters to detach stored
 *   or exposed state. Session.executeRequest returns frozen receipts; failure rejects its request.
 * - ResultAccumulator.finish to return a terminal snapshot. Session.retainEvent settles the shared
 *   Turn result with that snapshot, or lets a failure propagate through ordered publication.
 */
export function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  /**
   * immutable invokes this recursive walk on its detached clone. Freeze descendants first so no
   * enumerable object/array child of a returned protocol snapshot remains writable; failures propagate.
   */
  const freeze = (entry: unknown): void => {
    if (entry && typeof entry === 'object') {
      for (const child of Object.values(entry)) {
        freeze(child);
      }
      Object.freeze(entry);
    }
  };
  freeze(copy);
  return copy;
}
