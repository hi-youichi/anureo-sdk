// Outbound JSON-RPC request construction shared by standalone ACP wire fixtures.
/** Create a requester using the fixture's frame writer, pending-reply map and shared ID sequence.
 * Each promise waits for the fixture's reply handler to settle it; the fixture owns shutdown and
 * pending-request cleanup. Writer failures reject the promise, preserving its pending entry. */
export function createRequester(send, pending, nextId) {
  return (method, params) => new Promise((resolve, reject) => {
    const id = `agent:${nextId()}`;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
}
