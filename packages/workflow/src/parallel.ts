/** Start every callback, await the batch, and preserve each result's type and position. */
export async function parallel<const Tasks extends readonly (() => unknown)[]>(
  tasks: Tasks,
): Promise<{ -readonly [K in keyof Tasks]: Awaited<ReturnType<Tasks[K]>> }> {
  // An async wrapper captures synchronous throws without skipping later callbacks.
  return await Promise.all(tasks.map(async task => task())) as { -readonly [K in keyof Tasks]: Awaited<ReturnType<Tasks[K]>> }
}
