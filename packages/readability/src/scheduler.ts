export function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  return value
}

/** Preserve input order and wait for every started operation, including on failure. */
export async function mapSettled<T, R>(
  values: readonly T[],
  concurrency: number,
  run: (value: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<PromiseSettledResult<R>[]> {
  positiveInteger(concurrency, 'concurrency')
  const results: PromiseSettledResult<R>[] = new Array(values.length)
  let next = 0
  async function worker(): Promise<void> {
    while (!signal?.aborted) {
      const index = next++
      if (index >= values.length) return
      try {
        results[index] = { status: 'fulfilled', value: await run(values[index]!, index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker))
  signal?.throwIfAborted()
  return results
}
