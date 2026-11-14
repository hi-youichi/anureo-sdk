/** Await a rejection before applying synchronous matchers, including on Bun's Windows runner. Resolve with the original cause or reject if the supplied operation succeeds. The test retains cleanup ownership. */
export async function rejectionOf(operation: Promise<unknown>): Promise<unknown> {
  try { await operation } catch (cause) { return cause }
  throw new Error('Expected the operation to reject')
}
