/** Return the rejection cause for synchronous matchers after native I/O; throw if the operation succeeds. */
export async function rejectionOf(operation: Promise<unknown>): Promise<unknown> {
  try { await operation } catch (cause) { return cause }
  throw new Error('Expected the operation to reject')
}
