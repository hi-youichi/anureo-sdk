import { boundFileChangeItem } from "./file-change-limits";
import type { Capabilities, AhpEventPayload, AhpMethod, AhpResultMap, GoalState, HistoryPage, InputBlock, InteractionRequested, InteractionResponse, Item, JsonObject, JsonSchema, JsonValue, SessionState } from "@anureo/protocol";
import { assertDefinition } from "@anureo/protocol";
import { HarnessSdkError } from "./errors";

/** Session-local marked answers only. Values never persist and unmarked chat text is not inferred. */
export class SecretRedactor {
  private readonly values = new Set<string>();
  private readonly streams = new Map<string, string>();
  private secretBytes = 0;
  constructor(private readonly onRemember?: (secret: string) => void) {}
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
  rememberResponse(request: InteractionRequested, response: InteractionResponse): void {
    if (request.kind === "userInput" && response.kind === "userInput") for (const question of request.questions) if (question.secret) this.remember(response.answers[question.id]);
    if (request.kind === "elicitation" && response.kind === "elicitation" && response.content && request.schema !== undefined) this.fromSchema(request.schema, response.content, request.schema);
    if (request.kind === "dynamicTool" && response.kind === "dynamicTool" && request.schema !== undefined) this.fromSchema(request.schema, response as unknown as JsonValue, request.schema);
  }
  private fromSchema(schema: JsonSchema, value: JsonValue | undefined, root: JsonSchema, depth = 0): void {
    if (depth > 32 || typeof schema !== "object" || !schema || value === undefined) return;
    if (schema.writeOnly === true || schema.secret === true) { this.remember(value); return; }
    if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/") && typeof root === "object") {
      let target: JsonValue | undefined = root;
      for (const token of schema.$ref.slice(2).split("/")) { const key = token.replace(/~1/g, "/").replace(/~0/g, "~"); target = target && typeof target === "object" && !Array.isArray(target) ? target[key] : undefined; }
      if (typeof target === "boolean" || (target && typeof target === "object" && !Array.isArray(target))) this.fromSchema(target, value, root, depth + 1);
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const properties = schema.properties;
      if (properties && typeof properties === "object" && !Array.isArray(properties)) for (const [key, child] of Object.entries(properties)) if (typeof child === "boolean" || (child && typeof child === "object" && !Array.isArray(child))) this.fromSchema(child, value[key], root, depth + 1);
      if (schema.additionalProperties && typeof schema.additionalProperties === "object" && !Array.isArray(schema.additionalProperties)) for (const [key, child] of Object.entries(value)) if (!properties || typeof properties !== "object" || !Object.hasOwn(properties, key)) this.fromSchema(schema.additionalProperties, child, root, depth + 1);
    }
    if (Array.isArray(value) && schema.items && (typeof schema.items === "boolean" || (typeof schema.items === "object" && !Array.isArray(schema.items)))) for (const child of value) this.fromSchema(schema.items, child, root, depth + 1);
    for (const key of ["allOf", "anyOf", "oneOf"] as const) if (Array.isArray(schema[key])) for (const branch of schema[key]) if (typeof branch === "boolean" || (branch && typeof branch === "object" && !Array.isArray(branch))) this.fromSchema(branch, value, root, depth + 1);
  }
  private scan(value: string, final: boolean): { text: string; pending: string } {
    const values = [...this.values].sort((a, b) => b.length - a.length); const output: string[] = [];
    for (let offset = 0; offset < value.length;) {
      const candidates = values.filter((secret) => secret[0] === value[offset]);
      const secret = candidates.find((entry) => value.startsWith(entry, offset));
      if (secret) { output.push("[redacted]"); offset += secret.length; continue; }
      const remaining = value.slice(offset);
      if (!final && candidates.some((entry) => entry.startsWith(remaining))) return { text: output.join(""), pending: remaining };
      output.push(value[offset]!); offset++;
    }
    return { text: output.join(""), pending: "" };
  }
  text(value: string): string { return this.values.size ? this.scan(value, true).text : value; }
  delta(stream: string, value: string): string {
    if (!this.values.size) return value;
    const result = this.scan((this.streams.get(stream) ?? "") + value, false);
    if (result.pending) this.streams.set(stream, result.pending); else this.streams.delete(stream);
    return result.text;
  }
  json(value: JsonValue): JsonValue {
    if (typeof value === "string") return this.text(value);
    if (typeof value === "number" || typeof value === "boolean") return this.values.has(String(value)) ? "[redacted]" : value;
    if (Array.isArray(value)) return value.map((entry) => this.json(entry));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [this.text(key), this.json(child)]));
    return value;
  }
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
  capabilities(value: Capabilities): Capabilities {
    if (!value.config) return value;
    return { ...value, config: { ...value.config, options: value.config.options.map((option) => ({ ...option, ...(option.title !== undefined ? { title: this.text(option.title) } : {}), ...(option.value !== undefined ? { value: this.json(option.value) } : {}), schema: this.schema(option.schema) })) } };
  }
  goal(value: GoalState): GoalState { return { ...value, goal: value.goal === null ? null : this.json(value.goal) as JsonObject }; }
  state(value: SessionState): SessionState {
    return { ...value, ...(value.metadata ? { metadata: this.json(value.metadata as JsonObject) as SessionState["metadata"] } : {}), config: Object.fromEntries(Object.entries(value.config).map(([id, entry]) => [id, this.json(entry)])), capabilities: this.capabilities(value.capabilities), ...(value.goal ? { goal: this.goal(value.goal) } : {}) };
  }
  /** Redact content fields while preserving IDs, protocol enums, revisions and schema constraints. */
  result<M extends AhpMethod>(method: M, value: AhpResultMap[M]): AhpResultMap[M] {
    if (method === "session/config/set") return this.state(value as SessionState) as AhpResultMap[M];
    if (method === "goal/set" || method === "goal/clear") return this.goal(value as GoalState) as AhpResultMap[M];
    return value;
  }
  private input(block: InputBlock): InputBlock {
    if (block.type === "text") return { ...block, text: this.text(block.text) };
    if (block.type === "file") return { ...block, uri: this.text(block.uri), ...(block.name ? { name: this.text(block.name) } : {}) };
    return { ...block, ...(block.url ? { url: this.text(block.url) } : {}), ...(block.data ? { data: this.text(block.data) } : {}) };
  }
  item(item: Item): Item {
    if (item.extensions) item = { ...item, extensions: this.json(item.extensions) as JsonObject };
    switch (item.type) {
      case "agentMessage": return { ...item, text: this.text(item.text) };
      case "userMessage": return { ...item, content: item.content.map((block) => this.input(block)) };
      case "reasoning": return { ...item, ...(item.text ? { text: this.text(item.text) } : {}), ...(item.summary ? { summary: this.text(item.summary) } : {}) };
      case "toolCall": return boundFileChangeItem({ ...item, ...(item.image ? { image: { ...item.image, ...(item.image.path ? { path: this.text(item.image.path) } : {}), ...(item.image.revisedPrompt ? { revisedPrompt: this.text(item.image.revisedPrompt) } : {}) } } : {}), ...(item.fileChanges !== undefined ? { fileChanges: item.fileChanges.map(change => ({ ...change, path: this.text(change.path), ...(change.oldPath !== undefined ? { oldPath: this.text(change.oldPath) } : {}), materials: change.materials.map(material => material.format === "unified" ? { ...material, patch: this.text(material.patch) } : material.format === "text" ? { ...material, oldText: material.oldText === null ? null : this.text(material.oldText), newText: this.text(material.newText) } : material) })) } : {}), title: this.text(item.title), ...(item.input !== undefined ? { input: this.json(item.input) } : {}), ...(item.output !== undefined ? { output: this.json(item.output) } : {}), ...(item.raw !== undefined ? { raw: this.json(item.raw) } : {}), ...(item.locations ? { locations: item.locations.map((location) => ({ ...location, path: this.text(location.path) })) } : {}) });
      case "plan": return { ...item, steps: item.steps.map((step) => ({ ...step, text: this.text(step.text) })) };
      case "subagent": return { ...item, ...(item.name ? { name: this.text(item.name) } : {}), ...(item.task ? { task: this.text(item.task) } : {}) };
      case "review": return { ...item, ...(item.text ? { text: this.text(item.text) } : {}) };
      case "compaction": return { ...item, ...(item.summary ? { summary: this.text(item.summary) } : {}) };
      case "hook": return { ...item, name: this.text(item.name), ...(item.input !== undefined ? { input: this.json(item.input) } : {}), ...(item.output !== undefined ? { output: this.json(item.output) } : {}) };
      case "notice": return { ...item, text: this.text(item.text) };
    }
  }
  interaction(request: InteractionRequested): InteractionRequested {
    const common = { ...request, ...(request.title ? { title: this.text(request.title) } : {}), ...(request.privatePayload ? { privatePayload: this.json(request.privatePayload) as JsonObject } : {}) };
    switch (common.kind) {
      case "approval": return { ...common, ...(common.input !== undefined ? { input: this.json(common.input) } : {}), options: common.options.map((option) => ({ ...option, label: this.text(option.label), ...(option.description ? { description: this.text(option.description) } : {}) })) };
      case "userInput": return { ...common, questions: common.questions.map((question) => ({ ...question, prompt: this.text(question.prompt), ...(question.options ? { options: question.options.map((option) => ({ ...option, label: this.text(option.label) })) } : {}) })) };
      case "elicitation": return { ...common, ...(common.message ? { message: this.text(common.message) } : {}) };
      case "dynamicTool": return { ...common, arguments: this.json(common.arguments) as JsonObject };
    }
  }
  private deltaValue(kind: string, value: JsonValue): JsonValue {
    if (kind === "patch" && value && typeof value === "object" && !Array.isArray(value) && ("type" in value || "fileChanges" in value)) {
      // Item-shaped snapshots must not bypass source limits through generic JSON.
      // Arbitrary extension JSON without Item discriminators remains compatible.
      assertDefinition<Item>("Item", value);
      return this.item(value) as unknown as JsonValue;
    }
    return this.json(value);
  }
  event(event: AhpEventPayload): AhpEventPayload {
    switch (event.type) {
      case "item/started": case "item/completed": {
        if (event.type === "item/completed") this.streams.delete(event.payload.item.id);
        return { ...event, payload: { item: this.item(event.payload.item) } };
      }
      case "item/delta": return { ...event, payload: { ...event.payload, ...(event.payload.text !== undefined ? { text: this.delta(event.payload.itemId, event.payload.text) } : {}), ...(event.payload.value !== undefined ? { value: this.deltaValue(event.payload.kind, event.payload.value) } : {}) } };
      case "notice": return { ...event, payload: { ...event.payload, message: this.text(event.payload.message), ...(event.payload.raw !== undefined ? { raw: this.json(event.payload.raw) } : {}) } };
      case "extension": return { ...event, payload: { ...event.payload, data: this.json(event.payload.data) } };
      case "session/metadata": return { ...event, payload: this.json(event.payload as JsonObject) as typeof event.payload };
      case "session/state": return { ...event, payload: this.state(event.payload) };
      case "interaction/requested": return { ...event, payload: this.interaction(event.payload) };
      case "turn/completed": return { ...event, payload: { ...event.payload, ...(event.payload.error ? { error: { ...event.payload.error, message: this.text(event.payload.error.message), ...(event.payload.error.details ? { details: this.json(event.payload.error.details) as JsonObject } : {}) } } : {}) } };
      default: return event;
    }
  }
  history(page: HistoryPage): HistoryPage { return { ...page, items: page.items.map((entry) => ({ ...entry, item: this.item(entry.item) })) }; }
}
