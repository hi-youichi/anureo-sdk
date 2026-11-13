// Provides externally settled lifecycle promises; must not choose settlement order or schedule work.
/** Return a promise and its settlement callbacks for lifecycle owners; observe early rejection without swallowing it for consumers. Settlement does not cancel underlying work. */
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Avoid unhandled rejections before callers attach a handler. Returning the
  // original promise below preserves its rejection for callers.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
