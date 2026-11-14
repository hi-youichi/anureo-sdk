/**
 * Create a package-internal promise with caller-owned settlement. Session uses it for observation
 * closure, retained execution results and submission binding. A preinstalled rejection observer
 * allows callers to attach later and still receive the original rejection.
 */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
