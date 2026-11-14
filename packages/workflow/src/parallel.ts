/**
 * Start every callback without waiting for earlier callbacks, then return awaited results in input order.
 * Snapshot and validate the task array before invoking callbacks; invalid input rejects with TypeError.
 * Callbacks may return values or promises. Synchronous throws and rejections become null at their
 * positions, indistinguishable from returned null; other falsy values are preserved. Empty input returns [].
 * Completion waits for every callback to settle, including siblings of failed callbacks.
 * Callers supply any concurrency limits, cancellation, retries and resource cleanup inside their callbacks.
 */
export async function parallel<const Tasks extends readonly (() => unknown)[]>(
  tasks: Tasks,
): Promise<{ -readonly [K in keyof Tasks]: Awaited<ReturnType<Tasks[K]>> | null }> {
  if (!Array.isArray(tasks)) throw new TypeError('parallel expects an array of functions')
  const callbacks = [...tasks]
  for (const task of callbacks) {
    if (typeof task !== 'function') throw new TypeError('parallel expects functions, not promises; wrap each call in () => task()')
  }
  // An async wrapper captures synchronous throws without skipping later callbacks.
  const results = await Promise.allSettled(callbacks.map(async task => task()))
  return results.map(result => result.status === 'fulfilled' ? result.value : null) as {
    -readonly [K in keyof Tasks]: Awaited<ReturnType<Tasks[K]>> | null
  }
}
