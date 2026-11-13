// Projects explicitly marked secrets out of session content; must not infer secrets or own native execution.
import { boundFileChangeItem } from "./file-change-limits";
import type { Capabilities, AhpEventPayload, AhpMethod, AhpResultMap, FileChange, GoalState, HistoryPage, InputBlock, InteractionRequested, InteractionResponse, Item, JsonObject, JsonSchema, JsonValue, SessionState, ToolCallItem } from "@anureo/protocol";
import { assertDefinition } from "@anureo/protocol";
import { HarnessSdkError } from "../errors";

/** Narrow protocol JSON to a map for schema traversal; arrays and null cannot supply named schema children. */
function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Accept boolean/object schema nodes while walking protocol JSON; this is a shape guard, not schema validation. */
function isJsonSchema(value: JsonValue | undefined): value is JsonSchema {
  return typeof value === "boolean" || isJsonObject(value);
}

/** Session-local marked answers only. Values never persist and unmarked chat text is not inferred. */
export class SecretRedactor {
  private readonly values = new Set<string>();
  private readonly streams = new Map<string, string>();
  private secretBytes = 0;
  /** Retain an optional synchronous host privacy-metadata callback; no values are remembered or persisted until a marked response arrives. */
  constructor(private readonly onRemember?: (secret: string) => void) {}
  /** Recursively retain marked scalar values within session budgets; call host metadata persistence before accepting a new value and throw on capacity/callback failure. */
  private remember(value: JsonValue | undefined): void {
    if (value === undefined || value === null) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = String(value);
      if (text && !this.values.has(text)) {
        const bytes = new TextEncoder().encode(text).byteLength;
        if (this.values.size >= 128 || this.secretBytes + bytes > 64 * 1024) throw new HarnessSdkError("BACKPRESSURE_EXCEEDED", "Marked secret limit exceeded");
        this.onRemember?.(text);
        this.values.add(text); this.secretBytes += bytes;
      }
    }
    else if (Array.isArray(value)) value.forEach((entry) => this.remember(entry));
    else for (const entry of Object.values(value)) this.remember(entry);
  }
  /** Collect only fields explicitly marked secret/writeOnly by the native request before its response is sent; propagate privacy budget or host callback failure. */
  rememberResponse(request: InteractionRequested, response: InteractionResponse): void {
    if (request.kind === "userInput" && response.kind === "userInput") for (const question of request.questions) if (question.secret) this.remember(response.answers[question.id]);
    if (request.kind === "elicitation" && response.kind === "elicitation" && response.content && request.schema !== undefined) this.fromSchema(request.schema, response.content, request.schema);
    if (request.kind === "dynamicTool" && response.kind === "dynamicTool" && request.schema !== undefined) this.fromSchema(request.schema, response as unknown as JsonValue, request.schema);
  }
  /** Resolve a local JSON-pointer schema reference without fetching external data; return undefined when a traversed node is not an object. */
  private resolveLocalReference(reference: string, root: JsonSchema): JsonValue | undefined {
    let target: JsonValue | undefined = root;
    for (const token of reference.slice(2).split("/")) {
      const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
      target = isJsonObject(target) ? target[key] : undefined;
    }
    return target;
  }
  /** Collect marked values through bounded local schema traversal, including referenced and sibling rules; does not validate response values or fetch references. */
  private fromSchema(schema: JsonSchema, value: JsonValue | undefined, root: JsonSchema, depth = 0): void {
    if (depth > 32 || typeof schema !== "object" || !schema || value === undefined) return;
    if (schema.writeOnly === true || schema.secret === true) {
      this.remember(value);
      return;
    }
    if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/") && typeof root === "object") {
      const target = this.resolveLocalReference(schema.$ref, root);
      if (isJsonSchema(target)) {
        this.fromSchema(target, value, root, depth + 1);
      }
    }
    // Referenced schemas are visited first; sibling keywords still apply below.
    if (isJsonObject(value)) {
      const properties = schema.properties;
      if (isJsonObject(properties)) {
        for (const [key, child] of Object.entries(properties)) {
          if (isJsonSchema(child)) {
            this.fromSchema(child, value[key], root, depth + 1);
          }
        }
      }
      if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object" &&
        !Array.isArray(schema.additionalProperties)
      ) {
        for (const [key, child] of Object.entries(value)) {
          if (!properties || typeof properties !== "object" || !Object.hasOwn(properties, key)) {
            this.fromSchema(schema.additionalProperties, child, root, depth + 1);
          }
        }
      }
    }
    if (
      Array.isArray(value) && schema.items &&
      (typeof schema.items === "boolean" || (typeof schema.items === "object" && !Array.isArray(schema.items)))
    ) {
      for (const child of value) {
        this.fromSchema(schema.items, child, root, depth + 1);
      }
    }
    for (const key of ["allOf", "anyOf", "oneOf"] as const) {
      if (Array.isArray(schema[key])) {
        for (const branch of schema[key]) {
          if (isJsonSchema(branch)) {
            this.fromSchema(branch, value, root, depth + 1);
          }
        }
      }
    }
  }
  /** Project longest complete secret matches and optionally retain an incomplete trailing prefix; pure scan used by complete and streaming projections. */
  private scan(value: string, final: boolean): { text: string; pending: string } {
    const secretsByDescendingLength = [...this.values].sort((a, b) => b.length - a.length);
    const output: string[] = [];
    for (let offset = 0; offset < value.length;) {
      const candidates = secretsByDescendingLength.filter((secret) => secret[0] === value[offset]);
      // Prefer the longest complete match, even if a longer secret is still incomplete.
      const completeMatch = candidates.find((entry) => value.startsWith(entry, offset));
      if (completeMatch) { output.push("[redacted]"); offset += completeMatch.length; continue; }
      const unprocessedSuffix = value.slice(offset);
      // Hold a possible secret prefix only when no complete match exists; final scans emit it.
      if (!final && candidates.some((entry) => entry.startsWith(unprocessedSuffix))) return { text: output.join(""), pending: unprocessedSuffix };
      output.push(value[offset]!); offset++;
    }
    return { text: output.join(""), pending: "" };
  }
  /** Return a complete text projection without retaining stream state; unmarked text is preserved. */
  text(value: string): string { return this.values.size ? this.scan(value, true).text : value; }
  /** Project one ordered stream chunk and retain only a possible secret prefix; callers must keep stream identity stable until authoritative completion. */
  delta(stream: string, value: string): string {
    if (!this.values.size) return value;
    const result = this.scan((this.streams.get(stream) ?? "") + value, false);
    if (result.pending) this.streams.set(stream, result.pending); else this.streams.delete(stream);
    return result.text;
  }
  /** Return recursively projected JSON, including keys and marked scalar values; preserve unmarked scalars and do not mutate input. */
  json(value: JsonValue): JsonValue {
    if (typeof value === "string") return this.text(value);
    if (typeof value === "number" || typeof value === "boolean") return this.values.has(String(value)) ? "[redacted]" : value;
    if (Array.isArray(value)) return value.map((entry) => this.json(entry));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [this.text(key), this.json(child)]));
    return value;
  }
  /** Project schema annotations/defaults recursively while preserving constraints and property names; privacy must not silently change validation rules. */
  private schema(schema: JsonSchema): JsonSchema {
    if (typeof schema === "boolean") return schema;
    const output = { ...schema };
    for (const key of ["title", "description", "default", "examples"]) if (output[key] !== undefined) output[key] = this.json(output[key]);
    for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
      const map = output[key];
      if (map && typeof map === "object" && !Array.isArray(map)) output[key] = Object.fromEntries(Object.entries(map).map(([name, child]) => [name, typeof child === "boolean" || (child && typeof child === "object" && !Array.isArray(child)) ? this.schema(child) : child]));
    }
    for (const key of ["additionalProperties", "unevaluatedProperties", "propertyNames", "items", "contains", "additionalItems", "unevaluatedItems", "not", "if", "then", "else", "contentSchema"]) {
      const child = output[key];
      if (typeof child === "boolean" || (child && typeof child === "object" && !Array.isArray(child))) output[key] = this.schema(child);
    }
    for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
      const children = output[key];
      if (Array.isArray(children)) output[key] = children.map((child) => typeof child === "boolean" || (child && typeof child === "object" && !Array.isArray(child)) ? this.schema(child) : child);
    }
    return output;
  }
  /** Project user-facing configuration annotations and values without changing advertised protocol capabilities or schema constraints. */
  capabilities(value: Capabilities): Capabilities {
    if (!value.config) return value;
    return { ...value, config: { ...value.config, options: value.config.options.map((option) => ({ ...option, ...(option.title !== undefined ? { title: this.text(option.title) } : {}), ...(option.value !== undefined ? { value: this.json(option.value) } : {}), schema: this.schema(option.schema) })) } };
  }
  /** Project goal content while preserving native goal metadata; return a new value. */
  goal(value: GoalState): GoalState { return { ...value, goal: value.goal === null ? null : this.json(value.goal) as JsonObject }; }
  /** Project content-bearing state fields while preserving bindings, protocol enums and revisions; no session bookkeeping is changed. */
  state(value: SessionState): SessionState {
    return { ...value, ...(value.metadata ? { metadata: this.json(value.metadata as JsonObject) as SessionState["metadata"] } : {}), config: Object.fromEntries(Object.entries(value.config).map(([id, entry]) => [id, this.json(entry)])), capabilities: this.capabilities(value.capabilities), ...(value.goal ? { goal: this.goal(value.goal) } : {}) };
  }
  /** Redact content fields while preserving IDs, protocol enums, revisions and schema constraints. */
  result<M extends AhpMethod>(method: M, value: AhpResultMap[M]): AhpResultMap[M] {
    if (method === "session/config/set") return this.state(value as SessionState) as AhpResultMap[M];
    if (method === "goal/set" || method === "goal/clear") return this.goal(value as GoalState) as AhpResultMap[M];
    return value;
  }
  /** Project content-bearing input block fields while preserving modality and protocol structure; return a detached outer block. */
  private input(block: InputBlock): InputBlock {
    if (block.type === "text") return { ...block, text: this.text(block.text) };
    if (block.type === "file") return { ...block, uri: this.text(block.uri), ...(block.name ? { name: this.text(block.name) } : {}) };
    return { ...block, ...(block.url ? { url: this.text(block.url) } : {}), ...(block.data ? { data: this.text(block.data) } : {}) };
  }
  /** Project tool image paths/prompts only; image identity and other native metadata remain authoritative. */
  private toolImage(item: ToolCallItem): Pick<ToolCallItem, "image"> {
    return item.image ? {
      image: {
        ...item.image,
        ...(item.image.path ? { path: this.text(item.image.path) } : {}),
        ...(item.image.revisedPrompt ? { revisedPrompt: this.text(item.image.revisedPrompt) } : {}),
      },
    } : {};
  }
  /** Project change paths and material text while preserving source metadata; the caller subsequently applies the shared retention budget. */
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
  /** Project item content without changing protocol identity; tool-call file changes additionally use the shared material/mirror budget. Throws on invalid marked-content processing. */
  item(item: Item): Item {
    if (item.extensions) item = { ...item, extensions: this.json(item.extensions) as JsonObject };
    switch (item.type) {
      case "agentMessage": return { ...item, text: this.text(item.text) };
      case "userMessage": return { ...item, content: item.content.map((block) => this.input(block)) };
      case "reasoning": return { ...item, ...(item.text ? { text: this.text(item.text) } : {}), ...(item.summary ? { summary: this.text(item.summary) } : {}) };
      case "toolCall": {
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
      case "plan": return { ...item, steps: item.steps.map((step) => ({ ...step, text: this.text(step.text) })) };
      case "subagent": return { ...item, ...(item.name ? { name: this.text(item.name) } : {}), ...(item.task ? { task: this.text(item.task) } : {}) };
      case "review": return { ...item, ...(item.text ? { text: this.text(item.text) } : {}) };
      case "compaction": return { ...item, ...(item.summary ? { summary: this.text(item.summary) } : {}) };
      case "hook": return { ...item, name: this.text(item.name), ...(item.input !== undefined ? { input: this.json(item.input) } : {}), ...(item.output !== undefined ? { output: this.json(item.output) } : {}) };
      case "notice": return { ...item, text: this.text(item.text) };
    }
  }
  /** Project public request content while preserving identifiers, answer keys and protocol alternatives; never execute a native responder. */
  interaction(request: InteractionRequested): InteractionRequested {
    const common = { ...request, ...(request.title ? { title: this.text(request.title) } : {}), ...(request.privatePayload ? { privatePayload: this.json(request.privatePayload) as JsonObject } : {}) };
    switch (common.kind) {
      case "approval": return { ...common, ...(common.input !== undefined ? { input: this.json(common.input) } : {}), options: common.options.map((option) => ({ ...option, label: this.text(option.label), ...(option.description ? { description: this.text(option.description) } : {}) })) };
      case "userInput": return { ...common, questions: common.questions.map((question) => ({ ...question, prompt: this.text(question.prompt), ...(question.options ? { options: question.options.map((option) => ({ ...option, label: this.text(option.label) })) } : {}) })) };
      case "elicitation": return { ...common, ...(common.message ? { message: this.text(common.message) } : {}) };
      case "dynamicTool": return { ...common, arguments: this.json(common.arguments) as JsonObject };
    }
  }
  /** Validate Item-shaped patches before applying item privacy/limits; preserve arbitrary extension JSON. Throw protocol validation failure before retaining malformed snapshots. */
  private deltaValue(kind: string, value: JsonValue): JsonValue {
    if (kind === "patch" && value && typeof value === "object" && !Array.isArray(value) && ("type" in value || "fileChanges" in value)) {
      // Item-shaped snapshots must not bypass source limits through generic JSON.
      // Arbitrary extension JSON without Item discriminators remains compatible.
      assertDefinition<Item>("Item", value);
      return this.item(value) as unknown as JsonValue;
    }
    return this.json(value);
  }
  /** Project event content in publication order and clear completed-item prefix state; optional turnId prevents cross-turn stream collisions. Item-shaped patch validation may throw. */
  event(event: AhpEventPayload, turnId?: string): AhpEventPayload {
    const stream = (itemId: string): string => turnId === undefined ? itemId : JSON.stringify([turnId, itemId]);
    switch (event.type) {
      case "item/started": case "item/completed": {
        if (event.type === "item/completed") this.streams.delete(stream(event.payload.item.id));
        return { ...event, payload: { item: this.item(event.payload.item) } };
      }
      case "item/delta": return { ...event, payload: { ...event.payload, ...(event.payload.text !== undefined ? { text: this.delta(stream(event.payload.itemId), event.payload.text) } : {}), ...(event.payload.value !== undefined ? { value: this.deltaValue(event.payload.kind, event.payload.value) } : {}) } };
      case "notice": return { ...event, payload: { ...event.payload, message: this.text(event.payload.message), ...(event.payload.raw !== undefined ? { raw: this.json(event.payload.raw) } : {}) } };
      case "extension": return { ...event, payload: { ...event.payload, data: this.json(event.payload.data) } };
      case "session/metadata": return { ...event, payload: this.json(event.payload as JsonObject) as typeof event.payload };
      case "session/state": return { ...event, payload: this.state(event.payload) };
      case "interaction/requested": return { ...event, payload: this.interaction(event.payload) };
      case "turn/completed": return { ...event, payload: { ...event.payload, ...(event.payload.error ? { error: { ...event.payload.error, message: this.text(event.payload.error.message), ...(event.payload.error.details ? { details: this.json(event.payload.error.details) as JsonObject } : {}) } } : {}) } };
      default: return event;
    }
  }
  /** Return a projected native history page using the same item privacy/retention rules as live events; preserve pagination and execution identities. */
  history(page: HistoryPage): HistoryPage { return { ...page, items: page.items.map((entry) => ({ ...entry, item: this.item(entry.item) })) }; }
}
