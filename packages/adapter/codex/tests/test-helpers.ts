/** Supplies shared rejection observation to adapter and catalog tests; it must not assert domain policy or take ownership of process resources. */
/** For async assertions, await a supplied operation and return its rejection cause unchanged; throw Error if it resolves. Observation leaves cleanup to the test's owner and completes native I/O before synchronous matchers run on Bun's Windows runner. */
export async function rejectionOf(operation: Promise<unknown>): Promise<unknown> {
  try { await operation } catch (cause) { return cause }
  throw new Error('Expected the operation to reject')
}
