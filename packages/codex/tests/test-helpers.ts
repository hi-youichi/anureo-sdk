/** Await native I/O before entering a synchronous matcher in Bun's Windows runner. */
export async function rejectionOf(operation: Promise<unknown>): Promise<unknown> {
  try { await operation } catch (cause) { return cause }
  throw new Error('Expected the operation to reject')
}
