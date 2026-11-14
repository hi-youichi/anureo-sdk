// Registers explicitly marked secrets and projects public events, state and history.
import { boundFileChangeItem } from "./file-change-limits";
import type { Capabilities, AhpEventPayload, AhpMethod, AhpResultMap, FileChange, GoalState, HistoryPage, InputBlock, InteractionRequested, InteractionResponse, Item, JsonObject, JsonSchema, JsonValue, SessionState, ToolCallItem } from "@anureo/protocol";
import { assertDefinition } from "@anureo/protocol";
import { HarnessSdkError } from "../errors";

/**
 * Register explicitly marked answers before projecting content for public observation.
 * This root-exported implementation helper is owned by Session, which installs registration in
 * InteractionRegistry's pre-response callback and projects events and request results. Direct
 * consumers own the same registration/publication order. Secrets and pending prefixes stay in
 * memory; the optional synchronous hook owns persistence. No native resources are acquired.
 */
export class SecretRedactor {
  /**
   * Create an empty in-memory registry with an optional synchronous persistence hook. Session
   * forwards runtime.onMarkedSecret here; rememberScalar invokes it before accepting each new value.
   * Construction only retains the hook. The host owns persistence and any effects its hook performs.
   */
  constructor(private readonly onRemember?: (secret: string) => void) {}
  /**
   * Register answers marked secret/writeOnly by the request before exposing or delivering them.
   * Empty strings, null and duplicates are ignored; at most 128 distinct scalar strings and 64 KiB
   * of UTF-8 text are retained. Exceeding either budget throws BACKPRESSURE_EXCEEDED; hook exceptions
   * also propagate, leaving earlier registrations intact. Schema traversal stops beyond depth 32.
   * Session installs this as InteractionRegistry's pre-response check, which runs after validation
   * and before replay/native delivery. Direct consumers must validate and deliver responses themselves.
   */
  rememberResponse(request: InteractionRequested, response: InteractionResponse): void {
    if (request.kind === "userInput" && response.kind === "userInput") {
      for (const question of request.questions) {
        if (question.secret) this.remember(response.answers[question.id]);
      }
    }
    if (request.kind === "elicitation" && response.kind === "elicitation" && response.content && request.schema !== undefined) {
      this.fromSchema(request.schema, response.content, { root: request.schema, depth: 0 });
    }
    if (request.kind === "dynamicTool" && response.kind === "dynamicTool" && request.schema !== undefined) {
      this.fromSchema(request.schema, response as unknown as JsonValue, { root: request.schema, depth: 0 });
    }
  }
  /**
   * Replace complete secret matches with [redacted], preferring the longest match at each position.
   * Unmatched trailing prefixes are emitted without retaining stream state. Session.projectOutput
   * and projectSubmissionStatus use this before exposure; OutputSession.publishOutput revalidates
   * projected JSON and owns any resulting schema failure.
   */
  text(value: string): string { return this.values.size ? this.scan(value, "complete").text : value; }
  /**
   * Project an ordered text chunk, withholding a possible trailing secret prefix until the next chunk.
   * Complete matches win even when a longer secret is incomplete. event scopes streams by turn/item
   * and discards pending prefixes on item/completed, whose snapshot carries authoritative full text.
   * Direct consumers must use distinct ordered keys; this method has no flush/reset operation, so
   * they must discard the redactor when they no longer need its retained prefixes and secrets.
   */
  delta(stream: string, value: string): string {
    if (!this.values.size) return value;
    const result = this.scan((this.streams.get(stream) ?? "") + value, "stream");
    if (result.pending) this.streams.set(stream, result.pending); else this.streams.delete(stream);
    return result.text;
  }
  /**
   * Return recursively projected JSON content, including keys and marked scalar values, without
   * mutating input; preserve unmarked scalars.
   * Marked numbers/booleans become the string [redacted]. Session.projectSubmissionStatus and the
   * protocol projections select content fields; direct callers must do the same to preserve identity.
   */
  json(value: JsonValue): JsonValue {
    if (typeof value === "string") return this.text(value);
    if (typeof value === "number" || typeof value === "boolean") return this.values.has(String(value)) ? "[redacted]" : value;
    if (Array.isArray(value)) return value.map((entry) => this.json(entry));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [this.text(key), this.json(child)]));
    return value;
  }
  /**
   * Project configuration annotations and values without modifying validation constraints or
   * property names. Return the original value when no configuration is advertised. state uses this
   * for session snapshots; the caller owns storing or publishing the result.
   */
  capabilities(value: Capabilities): Capabilities {
    if (!value.config) return value;
    return {
      ...value,
      config: {
        ...value.config,
        options: value.config.options.map((option) => ({
          ...option,
          ...(option.title !== undefined ? { title: this.text(option.title) } : {}),
          ...(option.value !== undefined ? { value: this.json(option.value) } : {}),
          schema: this.schema(option.schema),
        })),
      },
    };
  }
  /**
   * Return a new outer value with projected goal JSON and unchanged native goal metadata.
   * state and result call this before exposing goal content; no session state is written here.
   */
  goal(value: GoalState): GoalState { return { ...value, goal: value.goal === null ? null : this.json(value.goal) as JsonObject }; }
  /**
   * Project content-bearing state fields while preserving bindings, protocol enums and revisions; no
   * session bookkeeping is changed. Session.snapshot calls this on reads; event and result use it
   * for state/config observations. Session freezes reads and validates/stores request results;
   * direct consumers retain responsibility for validation and publication.
   */
  state(value: SessionState): SessionState {
    return {
      ...value,
      ...(value.metadata ? { metadata: this.json(value.metadata as JsonObject) as SessionState["metadata"] } : {}),
      config: Object.fromEntries(Object.entries(value.config).map(([id, entry]) => [id, this.json(entry)])),
      capabilities: this.capabilities(value.capabilities),
      ...(value.goal ? { goal: this.goal(value.goal) } : {}),
    };
  }
  /**
   * Project configuration/goal results, passing other method results through unchanged. History
   * requires history instead. Session.projectRequestResult calls this before executeRequest stores
   * config/goal state and validates/freezes the result. IDs, revisions and schema constraints remain
   * authoritative; direct consumers own result validation and storage.
   */
  result<M extends AhpMethod>(method: M, value: AhpResultMap[M]): AhpResultMap[M] {
    if (method === "session/config/set") return this.state(value as SessionState) as AhpResultMap[M];
    if (method === "goal/set" || method === "goal/clear") return this.goal(value as GoalState) as AhpResultMap[M];
    return value;
  }
  /**
   * Project validated item content without changing protocol identity or registering new secrets.
   * Tool-call file changes additionally use the shared material/mirror budget. event uses this for
   * snapshots and validated patches; history applies it to each native entry. Direct consumers
   * must validate item shape first, as Session and deltaValue do for their respective input paths.
   */
  item(item: Item): Item {
    if (item.extensions) item = { ...item, extensions: this.json(item.extensions) as JsonObject };
    switch (item.type) {
      case "agentMessage": return { ...item, text: this.text(item.text) };
      case "userMessage": return { ...item, content: item.content.map((block) => this.input(block)) };
      case "reasoning": return { ...item, ...(item.text ? { text: this.text(item.text) } : {}), ...(item.summary ? { summary: this.text(item.summary) } : {}) };
      case "toolCall": return this.toolCall(item);
      case "plan": return { ...item, steps: item.steps.map((step) => ({ ...step, text: this.text(step.text) })) };
      case "subagent": return { ...item, ...(item.name ? { name: this.text(item.name) } : {}), ...(item.task ? { task: this.text(item.task) } : {}) };
      case "review": return { ...item, ...(item.text ? { text: this.text(item.text) } : {}) };
      case "compaction": return { ...item, ...(item.summary ? { summary: this.text(item.summary) } : {}) };
      case "hook": return { ...item, name: this.text(item.name), ...(item.input !== undefined ? { input: this.json(item.input) } : {}), ...(item.output !== undefined ? { output: this.json(item.output) } : {}) };
      case "notice": return { ...item, text: this.text(item.text) };
    }
  }
  /**
   * Project public request content while preserving identifiers, answer keys and protocol alternatives.
   * event calls this after Session.requestInteraction applies protocol publicInteraction; direct
   * consumers must likewise remove private protocol fields before projection. This does not register
   * answers or deliver them natively. InteractionRegistry retains the native request for validation
   * and marked-field lookup.
   */
  interaction(request: InteractionRequested): InteractionRequested {
    const common = {
      ...request,
      ...(request.title ? { title: this.text(request.title) } : {}),
      ...(request.privatePayload ? { privatePayload: this.json(request.privatePayload) as JsonObject } : {}),
    };
    switch (common.kind) {
      case "approval": return {
        ...common,
        ...(common.input !== undefined ? { input: this.json(common.input) } : {}),
        options: common.options.map((option) => ({
          ...option,
          label: this.text(option.label),
          ...(option.description ? { description: this.text(option.description) } : {}),
        })),
      };
      case "userInput": return {
        ...common,
        questions: common.questions.map((question) => ({
          ...question,
          prompt: this.text(question.prompt),
          ...(question.options ? { options: question.options.map((option) => ({ ...option, label: this.text(option.label) })) } : {}),
        })),
      };
      case "elicitation": return { ...common, ...(common.message ? { message: this.text(common.message) } : {}) };
      case "dynamicTool": return { ...common, arguments: this.json(common.arguments) as JsonObject };
    }
  }
  /**
   * Project validated events in publication order, clearing an item's buffered prefix on completion.
   * Supply turnId to isolate reused item IDs across turns; omission uses an item-only stream key.
   * Session.publish invokes this after lifecycle admission and before retaining/publishing results.
   * Item-shaped patch validation failures throw and reject Session.emit; direct consumers own event
   * validation, ordering and publication. Completed snapshots, rather than buffered prefixes, supply
   * authoritative item content.
   */
  event(event: AhpEventPayload, turnId?: string): AhpEventPayload {
    switch (event.type) {
      case "item/started": case "item/completed": {
        if (event.type === "item/completed") this.streams.delete(streamKey(event.payload.item.id, turnId));
        return { ...event, payload: { item: this.item(event.payload.item) } };
      }
      case "item/delta": return { ...event, payload: this.itemDelta(event.payload, turnId) };
      case "notice": return { ...event, payload: { ...event.payload, message: this.text(event.payload.message), ...(event.payload.raw !== undefined ? { raw: this.json(event.payload.raw) } : {}) } };
      case "extension": return { ...event, payload: { ...event.payload, data: this.json(event.payload.data) } };
      case "session/metadata": return { ...event, payload: this.json(event.payload as JsonObject) as typeof event.payload };
      case "session/state": return { ...event, payload: this.state(event.payload) };
      case "interaction/requested": return { ...event, payload: this.interaction(event.payload) };
      case "turn/completed": return {
        ...event,
        payload: {
          ...event.payload,
          ...(event.payload.error ? {
            error: {
              ...event.payload.error,
              message: this.text(event.payload.error.message),
              ...(event.payload.error.details ? { details: this.json(event.payload.error.details) as JsonObject } : {}),
            },
          } : {}),
        },
      };
      default: return event;
    }
  }
  /**
   * Project a prevalidated history page using live items' privacy/retention rules, preserving
   * pagination and execution identities. The input must already be validated; no history is fetched
   * here. Session.projectRequestResult calls this before executeRequest awaits the optional host
   * redactHistory hook, validates and freezes the result; host-hook rejection fails that request.
   */
  history(page: HistoryPage): HistoryPage { return { ...page, items: page.items.map((entry) => ({ ...entry, item: this.item(entry.item) })) }; }

  private readonly values = new Set<string>();
  private readonly streams = new Map<string, string>();
  private secretBytes = 0;
  /**
   * rememberResponse and fromSchema call this before a response can be sent. Recursively retain marked
   * scalar values within session budgets; invoke the host hook before accepting each new value.
   * Capacity or hook failures throw to InteractionRegistry.respond before native delivery; values
   * already accepted during the traversal remain registered, with no rollback of host effects.
   */
  private remember(value: JsonValue | undefined): void {
    if (value === undefined || value === null) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      this.rememberScalar(value);
    }
    else if (Array.isArray(value)) value.forEach((entry) => this.remember(entry));
    else for (const entry of Object.values(value)) this.remember(entry);
  }
  /**
   * Accept a new nonempty scalar only after capacity checks and the synchronous persistence hook
   * succeed. remember preserves traversal order, so a later failure never rolls back earlier values;
   * a failed hook leaves this value unregistered and retryable.
   */
  private rememberScalar(value: string | number | boolean): void {
    const text = String(value);
    if (!text || this.values.has(text)) return;
    const bytes = new TextEncoder().encode(text).byteLength;
    if (this.values.size >= 128 || this.secretBytes + bytes > 64 * 1024) {
      throw new HarnessSdkError("BACKPRESSURE_EXCEEDED", "Marked secret limit exceeded");
    }
    this.onRemember?.(text);
    this.values.add(text);
    this.secretBytes += bytes;
  }
  /**
   * fromSchema uses the returned node for marked-value traversal without validating the response.
   * Resolve a local JSON-pointer schema reference without fetching external data; return undefined
   * when a token is missing or a traversed node is not an object. The caller checks the node's shape.
   */
  private resolveLocalReference(reference: string, root: JsonSchema): JsonValue | undefined {
    let target: JsonValue | undefined = root;
    for (const token of reference.slice(2).split("/")) {
      const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
      target = isJsonObject(target) ? target[key] : undefined;
    }
    return target;
  }
  /**
   * rememberResponse calls this for elicitation/dynamicTool schemas; recursive branches pass marked
   * values to remember. Collect marked values through bounded local schema traversal, including
   * referenced and sibling rules; does not validate response values or fetch references. Visit
   * references before siblings because registration order determines host-hook and budget failures.
   * Stop beyond depth 32; registration failures propagate without undoing earlier registrations.
   */
  private fromSchema(schema: JsonSchema, value: JsonValue | undefined, { root, depth }: SchemaTraversal): void {
    if (depth > 32 || typeof schema !== "object" || !schema || value === undefined) return;
    if (schema.writeOnly === true || schema.secret === true) {
      this.remember(value);
      return;
    }
    const children = { root, depth: depth + 1 };
    if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/") && typeof root === "object") {
      const target = this.resolveLocalReference(schema.$ref, root);
      if (isJsonSchema(target)) {
        this.fromSchema(target, value, children);
      }
    }
    // Referenced schemas are visited first; sibling keywords still apply below.
    if (isJsonObject(value)) this.rememberObjectProperties(schema, value, children);
    if (
      Array.isArray(value) && schema.items &&
      (typeof schema.items === "boolean" || (typeof schema.items === "object" && !Array.isArray(schema.items)))
    ) {
      for (const child of value) {
        this.fromSchema(schema.items, child, children);
      }
    }
    for (const key of ["allOf", "anyOf", "oneOf"] as const) {
      if (Array.isArray(schema[key])) {
        for (const branch of schema[key]) {
          if (isJsonSchema(branch)) {
            this.fromSchema(branch, value, children);
          }
        }
      }
    }
  }
  /**
   * fromSchema calls this between reference and array/composition visits. Register declared
   * properties before additional ones, sharing the next-depth context and propagating registration
   * failures. Even a declared non-schema property excludes that key from additionalProperties.
   */
  private rememberObjectProperties(schema: JsonObject, value: JsonObject, context: SchemaTraversal): void {
    const properties = schema.properties;
    if (isJsonObject(properties)) {
      for (const [key, child] of Object.entries(properties)) {
        if (isJsonSchema(child)) this.fromSchema(child, value[key], context);
      }
    }
    if (isJsonObject(schema.additionalProperties)) {
      for (const [key, child] of Object.entries(value)) {
        if (!properties || typeof properties !== "object" || !Object.hasOwn(properties, key)) {
          this.fromSchema(schema.additionalProperties, child, context);
        }
      }
    }
  }
  /**
   * text consumes the complete scan; delta stores a stream scan's pending prefix for the next chunk.
   * Return longest complete matches as redactions. Stream mode withholds an unmatched trailing
   * prefix so it cannot leak before the next chunk arrives; complete mode emits that prefix.
   * This scan reads registered secrets but changes no stream or registration state.
   */
  private scan(value: string, mode: "complete" | "stream"): { text: string; pending: string } {
    const secretsByDescendingLength = [...this.values].sort((a, b) => b.length - a.length);
    const output: string[] = [];
    for (let offset = 0; offset < value.length;) {
      const candidates = secretsByDescendingLength.filter((secret) => secret[0] === value[offset]);
      // Prefer the longest complete match, even if a longer secret is still incomplete.
      const completeMatch = candidates.find((entry) => value.startsWith(entry, offset));
      if (completeMatch) { output.push("[redacted]"); offset += completeMatch.length; continue; }
      const unprocessedSuffix = value.slice(offset);
      // Hold a possible secret prefix only when no complete match exists; complete scans emit it.
      if (mode === "stream" && candidates.some((entry) => entry.startsWith(unprocessedSuffix))) return { text: output.join(""), pending: unprocessedSuffix };
      output.push(value[offset]!); offset++;
    }
    return { text: output.join(""), pending: "" };
  }
  /**
   * capabilities calls this for config-option schemas before exposing state. Project schema
   * annotations/defaults recursively while preserving constraints and property names; privacy must not
   * silently change validation rules. Return a copy without mutating the native schema; annotations
   * are content, while property names and validation keywords remain authoritative.
   */
  private schema(schema: JsonSchema): JsonSchema {
    if (typeof schema === "boolean") return schema;
    const output = { ...schema };
    for (const key of ["title", "description", "default", "examples"]) if (output[key] !== undefined) output[key] = this.json(output[key]);
    for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
      const map = output[key];
      if (isJsonObject(map)) output[key] = Object.fromEntries(Object.entries(map).map(([name, child]) => [name, isJsonSchema(child) ? this.schema(child) : child]));
    }
    for (const key of ["additionalProperties", "unevaluatedProperties", "propertyNames", "items", "contains", "additionalItems", "unevaluatedItems", "not", "if", "then", "else", "contentSchema"]) {
      const child = output[key];
      if (isJsonSchema(child)) output[key] = this.schema(child);
    }
    for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
      const children = output[key];
      if (Array.isArray(children)) output[key] = children.map((child) => isJsonSchema(child) ? this.schema(child) : child);
    }
    return output;
  }
  /**
   * item maps user-message content through this projection. Project content-bearing input block fields
   * while preserving modality and protocol structure; return a detached outer block without loading
   * files or fetching URLs. item returns the block in the public user message.
   */
  private input(block: InputBlock): InputBlock {
    if (block.type === "text") return { ...block, text: this.text(block.text) };
    if (block.type === "file") return { ...block, uri: this.text(block.uri), ...(block.name ? { name: this.text(block.name) } : {}) };
    return { ...block, ...(block.url ? { url: this.text(block.url) } : {}), ...(block.data ? { data: this.text(block.data) } : {}) };
  }
  /**
   * toolCall merges these fields into projected tool-call items before bounding file-change material.
   * Project tool image paths/prompts only; image identity and other native metadata remain
   * authoritative. Return only the image field (or no fields) without reading or modifying an image.
   */
  private toolImage(item: ToolCallItem): Pick<ToolCallItem, "image"> {
    return item.image ? {
      image: {
        ...item.image,
        ...(item.image.path ? { path: this.text(item.image.path) } : {}),
        ...(item.image.revisedPrompt ? { revisedPrompt: this.text(item.image.revisedPrompt) } : {}),
      },
    } : {};
  }
  /**
   * toolCall maps fileChanges through this before boundFileChangeItem enforces retention.
   * Project change paths and material text while preserving source metadata; the caller subsequently
   * applies the shared retention budget. Return copied text material without applying patches or
   * changing unavailable-material metadata.
   */
  private fileChange(change: FileChange): FileChange {
    return {
      ...change,
      path: this.text(change.path),
      ...(change.oldPath !== undefined ? { oldPath: this.text(change.oldPath) } : {}),
      materials: change.materials.map((material) => {
        if (material.format === "unified") return { ...material, patch: this.text(material.patch) };
        if (material.format === "text") return {
          ...material,
          oldText: material.oldText === null ? null : this.text(material.oldText),
          newText: this.text(material.newText),
        };
        return material;
      }),
    };
  }
  /**
   * item delegates tool content projection here after extensions have been projected. Redact every
   * content field before enforcing the shared file-change budget so accounting measures projected
   * text. Return the bounded snapshot without changing native identity or source material.
   */
  private toolCall(item: ToolCallItem): Item {
    const redactedItem: ToolCallItem = {
      ...item,
      ...this.toolImage(item),
      ...(item.fileChanges !== undefined ? { fileChanges: item.fileChanges.map((change) => this.fileChange(change)) } : {}),
      title: this.text(item.title),
      ...(item.input !== undefined ? { input: this.json(item.input) } : {}),
      ...(item.output !== undefined ? { output: this.json(item.output) } : {}),
      ...(item.raw !== undefined ? { raw: this.json(item.raw) } : {}),
      ...(item.locations ? { locations: item.locations.map((location) => ({ ...location, path: this.text(location.path) })) } : {}),
    };
    return boundFileChangeItem(redactedItem);
  }
  /**
   * itemDelta calls this for JSON-valued payloads before Session retains or publishes the event.
   * Validate Item-shaped patches before applying item privacy/limits; project arbitrary extension
   * JSON as content. Throw protocol validation failure to Session.publish before malformed snapshots
   * can be retained; emit rejects publication and observes the failure through Session.fail.
   */
  private deltaValue(kind: string, value: JsonValue): JsonValue {
    if (kind === "patch" && isJsonObject(value) && ("type" in value || "fileChanges" in value)) {
      // Item-shaped snapshots must not bypass source limits through generic JSON.
      // Arbitrary extension JSON without Item discriminators remains compatible.
      assertDefinition<Item>("Item", value);
      return this.item(value) as unknown as JsonValue;
    }
    return this.json(value);
  }
  /**
   * event projects delta text before validating/projecting an optional JSON value. A malformed patch
   * throws after any prefix update, as publication fails through Session.emit; no buffered state is
   * rolled back. Non-Item JSON still receives ordinary content projection.
   */
  private itemDelta(payload: ItemDeltaPayload, turnId?: string): ItemDeltaPayload {
    return {
      ...payload,
      ...(payload.text !== undefined ? { text: this.delta(streamKey(payload.itemId, turnId), payload.text) } : {}),
      ...(payload.value !== undefined ? { value: this.deltaValue(payload.kind, payload.value) } : {}),
    };
  }
}

/**
 * Schema collection, projection and local-reference resolution use this pure shape guard before
 * reading named children. Arrays and null cannot supply schema property maps.
 */
function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * fromSchema, rememberObjectProperties and schema use this pure guard for selected schema children.
 * Accept boolean/object nodes without validating schema keywords or response values.
 */
function isJsonSchema(value: JsonValue | undefined): value is JsonSchema {
  return typeof value === "boolean" || isJsonObject(value);
}

/** fromSchema carries the original reference root and bounded recursion depth through sibling visits. */
interface SchemaTraversal {
  /** Local references always resolve against the request schema, never a nested schema node. */
  root: JsonSchema;
  /** Current visit depth; references and sibling child rules share the next depth. */
  depth: number;
}

/** The delta projection shares the protocol payload shape while leaving envelope identity to event. */
type ItemDeltaPayload = Extract<AhpEventPayload, { type: "item/delta" }>["payload"];

/** Share turn/item key encoding between delta buffering and completion cleanup; omission keeps the legacy item-only key. */
function streamKey(itemId: string, turnId?: string): string {
  return turnId === undefined ? itemId : JSON.stringify([turnId, itemId]);
}
