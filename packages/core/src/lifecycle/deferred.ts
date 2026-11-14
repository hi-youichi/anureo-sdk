// Creates externally settled promises for lifecycle gates; must not decide when work completes or cancel it.
/**
 * Session constructs its closure gate here; context and record allocate execution-result and
 * submission-binding gates. Return a promise with resolve/reject callbacks and rejection already
 * observed, so consumers may attach later without changing their outcome. Session owns settlement order;
 * host wait cancellation never settles these shared gates or cancels underlying native work.
 */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Avoid unhandled rejections before callers attach a handler. Returning the
  // original promise below preserves its rejection for callers.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
