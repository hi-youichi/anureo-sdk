/** Bridges 0.3 native interaction handlers into the host's manual RPC flow: handlers receive the full request (private payloads are stripped from the event stream) and park until the host settles them from hx.interaction.respond / cancel. */
import type { Client, InteractionHandlers } from "@anureo/sdk";
import type { InteractionRequested, InteractionResponse } from "@anureo/protocol";

/** Full requests captured from registered handlers plus the pending host settlements, keyed by native interaction id (unique per adapter instance). */
export interface InteractionCapture {
  /** Full original requests, including privatePayload the event stream intentionally withholds. */
  requests: Pick<Map<string, InteractionRequested>, "get">;
  /** Handler promises parked for the host's manual answer; settled exactly once from respond/cancel RPCs. */
  pending: Pick<Map<string, { resolve: (response: InteractionResponse) => void; reject: (cause: unknown) => void }>, "get" | "delete">;
}

const KINDS = ["approval", "userInput", "elicitation", "dynamicTool"] as const;

/** Build one capture per backend client, plus handlers that park adapter-local interactions for manual host settlement. */
export function createInteractionCapture(): { capture: InteractionCapture; handlers: InteractionHandlers } {
  const requests = new Map<string, InteractionRequested>();
  const pending = new Map<string, { resolve: (response: InteractionResponse) => void; reject: (cause: unknown) => void }>();
  const capture: InteractionCapture = { requests, pending };
  const handlers = Object.fromEntries(KINDS.map((kind) => [kind, async (request: InteractionRequested) => {
    requests.set(request.interactionId, structuredClone(request));
    return new Promise<InteractionResponse>((resolve, reject) => { pending.set(request.interactionId, { resolve, reject }); });
  }])) as InteractionHandlers;
  return { capture, handlers };
}

/** Read the capture attached to a client by a registration factory; undefined for clients built without capture handlers. */
export function clientInteractionCapture(client: Client): InteractionCapture | undefined {
  return (client as Client & { interactionCapture?: InteractionCapture }).interactionCapture;
}

/** Attach the capture to a client instance (or the promise createClient resolves) so the host can find it after descriptor.create(). */
export async function attachInteractionCapture(client: Client | Promise<Client>, capture: InteractionCapture): Promise<Client> {
  const resolved = await client;
  (resolved as Client & { interactionCapture?: InteractionCapture }).interactionCapture = capture;
  return resolved;
}
