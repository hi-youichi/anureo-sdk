/**
 * Start a batch of zero-argument callbacks and collect their awaited results in input order.
 * Callbacks start without waiting for earlier ones to finish. The promise resolves after all
 * callbacks settle and preserves the result type at each tuple position. An empty batch resolves to [].
 *
 * A synchronous throw or rejection produces null at that position, just like an explicit null result.
 * Other falsy values are preserved. Handle errors inside a callback if you need the original cause,
 * and arrange any concurrency limits, cancellation, retries and resource cleanup in the callback.
 *
 * The function snapshots the task array and rejects with TypeError for a non-array argument
 * or a non-function entry before invoking any callback.
 */
export async function parallel<const Tasks extends readonly (() => unknown)[]>(
  tasks: Tasks,
): Promise<ParallelResults<Tasks>> {
  if (!Array.isArray(tasks)) throw new TypeError('parallel expects an array of functions')
  const callbacks = [...tasks]
  for (const task of callbacks) {
    if (typeof task !== 'function') {
      throw new TypeError('parallel expects functions, not promises; wrap each call in () => task()')
    }
  }
  // An async wrapper captures synchronous throws without skipping later callbacks.
  const results = await Promise.allSettled(callbacks.map(async task => task()))
  return results.map(result => result.status === 'fulfilled' ? result.value : null) as ParallelResults<Tasks>
}

/** Preserve each callback's awaited type and allow a failed callback to yield null in any slot. */
type ParallelResults<Tasks extends readonly (() => unknown)[]> = {
  -readonly [K in keyof Tasks]: Awaited<ReturnType<Tasks[K]>> | null
}
