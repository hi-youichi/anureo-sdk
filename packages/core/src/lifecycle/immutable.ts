// Clones and freezes observation snapshots; must not validate protocol values or manage resources.
/**
 * Return a detached clone with enumerable object/array descendants frozen. These callers supply
 * acyclic protocol data; this is not a general-purpose immutability wrapper for collection objects.
 * Cloning/freezing failures throw to the caller without mutating the input.
 *
 * Called by:
 * - Client.initialize to store negotiated capabilities; failure rejects initialization.
 * - Session's constructor/attach and binding/reference/capabilities/snapshot getters to detach stored
 *   or exposed state. Session.executeRequest returns frozen receipts; failure rejects its request.
 * - ResultAccumulator.finish to return a retained terminal snapshot for Session.retainEvent to resolve
 *   to Turn.result. The accumulator keeps its mutable retention separate from this snapshot.
 * Callers still own validation, publication and any failure cleanup.
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
