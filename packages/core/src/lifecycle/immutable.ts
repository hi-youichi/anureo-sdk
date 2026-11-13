// Creates immutable observation snapshots; must not validate protocol values or manage resources.
/** Return a detached deeply frozen clone for observation consumers; structuredClone failures propagate. Never freezes or mutates the caller’s value. */
export function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  /** Freeze only the detached clone recursively so observers cannot mutate retained lifecycle state. */
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
