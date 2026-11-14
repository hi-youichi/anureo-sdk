/**
 * Start a batch of zero-argument callbacks and collect their awaited results in input order.
 * After validation, invoke the callbacks in array order before returning the promise. Wait for
 * every callback result to settle before resolving. Tuple inputs preserve the awaited type at each position,
 * and an empty batch resolves to `[]`.
 *
 * A synchronous throw or rejection produces `null` at that position, just like an explicit `null`
 * result. Other falsy values are preserved. Handle errors inside a callback to retain the original
 * cause. The caller owns concurrency limits, cancellation, retries and resource cleanup, and each
 * callback should return the work the batch needs to await.
 *
 * The function snapshots the task array and rejects with `TypeError` for a non-array argument
 * or a non-function entry before invoking any callback.
 */
export async function parallel<const Tasks extends readonly (() => unknown)[]>(
  tasks: Tasks,
): Promise<ParallelResults<Tasks>> {
  if (!Array.isArray(tasks)) throw new TypeError('parallel expects an array of functions')
  const callbacks = [...tasks]
  for (const callback of callbacks) {
    if (typeof callback !== 'function') {
      throw new TypeError('parallel expects functions, not promises; wrap each call in () => task()')
    }
  }
  // An async wrapper captures synchronous throws without skipping later callbacks.
  const settledCallbacks = await Promise.allSettled(callbacks.map(async callback => callback()))
  return settledCallbacks.map(result => result.status === 'fulfilled' ? result.value : null) as ParallelResults<Tasks>
}

/** Preserve each callback's awaited type and allow a failed callback to yield null in any slot. */
type ParallelResults<Tasks extends readonly (() => unknown)[]> = {
  -readonly [K in keyof Tasks]: Awaited<ReturnType<Tasks[K]>> | null
}
