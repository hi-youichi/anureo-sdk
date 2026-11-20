// Parses optional AHP capabilities advertised in native ACP metadata.
import { record } from './mapping';

/** Operations that can be advertised as private ACP methods. */
export type ExtensionKey = 'fork' | 'revert' | 'steer' | 'history' | 'goalSet' | 'goalClear' | 'compact' | 'review';
/** Negotiated features shared by AcpAdapter and its backend sessions. */
export interface Extensions {
  /** Negotiated AHP extension version, independent of method availability. */
  version?: 1 | 2;
  /** Accepted private method names, which the adapter can withdraw after a native rejection. */
  methods: Partial<Record<ExtensionKey, string>>;
  /** Supported fork boundaries when a private fork method is present. */
  fork: Array<'before' | 'through'>;
  /** Supported revert scopes when a private revert method is present. */
  revert: Array<'conversation' | 'files' | 'both'>;
  /** Whether peer updates can describe nested subagent activity. */
  subagents: boolean;
  /** Whether session open can send custom instructions in AHP metadata. */
  instructions: boolean;
  /** Whether the adapter accepts the negotiated _ahp/user_input request. */
  userInput: boolean;
  /** Whether the adapter accepts the negotiated _ahp/dynamic_tool request. */
  dynamicTool: boolean;
  /** Whether v2 turn-correlation notifications and prompt receipts govern execution. */
  nativeLifecycle?: boolean;
  /** Provider-neutral goal control advertised as initialize `_meta.goal`; independent of the AHP extension. */
  goal?: NeutralGoalExtension;
}
/** Provider-neutral goal control method and the subset of its actions that AHP can express. */
export interface NeutralGoalExtension {
  /** Private ACP request that carries `{ sessionId, action, ... }`. */
  method: string;
  actions: Array<'set' | 'clear'>;
}
/** Read AHP v1 metadata or v2 metadata with explicit turn correlation. AcpAdapter.configureCapabilities
 * stores the parsed methods and flags and uses them to advertise supported operations.
 * Missing or incompatible metadata yields no capabilities from this extension. */
export function extensions(response: unknown): Extensions {
  const extension = record(record(record(response)._meta).ahp);
  const methods: Extensions['methods'] = {};
  const result: Extensions = { methods, fork: [], revert: [], subagents: false, instructions: false, userInput: false, dynamicTool: false };
  const goal = neutralGoal(response);
  if (goal) result.goal = goal;
  if (extension.version !== 1 && !(extension.version === 2 && extension.turnCorrelation === true)) return result;
  result.version = extension.version;
  result.nativeLifecycle = result.version === 2;
  const names = record(extension.methods);
  for (const key of extensionKeys) {
    const name = names[key];
    if (typeof name === 'string' && /^_[a-zA-Z0-9/_.-]+$/.test(name)) methods[key] = name;
  }
  if (methods.fork && Array.isArray(extension.fork)) result.fork = extension.fork.filter((value): value is 'before' | 'through' => value === 'before' || value === 'through');
  if (methods.revert && Array.isArray(extension.revert)) result.revert = extension.revert.filter((value): value is 'conversation' | 'files' | 'both' => ['conversation', 'files', 'both'].includes(String(value)));
  result.subagents = extension.subagents === true;
  result.instructions = extension.instructions === true;
  const requests = record(extension.clientRequests);
  result.userInput = requests.userInput === '_ahp/user_input';
  result.dynamicTool = requests.dynamicTool === '_ahp/dynamic_tool';
  return result;
}

/** Read `_meta.goal` from the initialize response top level, falling back to `agentCapabilities._meta.goal`
 * (the neutral extension publishes both with the same shape). Require version 1 and a private control
 * method; keep only the actions AHP can express. A block with neither action yields no capability. */
function neutralGoal(response: unknown): NeutralGoalExtension | undefined {
  const root = record(response);
  const advertised = record(record(root._meta).goal);
  const block = Object.keys(advertised).length ? advertised : record(record(record(root.agentCapabilities)._meta).goal);
  const method = block.controlMethod;
  if (block.version !== 1 || typeof method !== 'string' || !/^_[a-zA-Z0-9/_.-]+$/.test(method) || !Array.isArray(block.actions)) return undefined;
  const actions = (['set', 'clear'] as const).filter(action => (block.actions as unknown[]).includes(action));
  return actions.length ? { method, actions } : undefined;
}

const extensionKeys: readonly ExtensionKey[] = ['fork', 'revert', 'steer', 'history', 'goalSet', 'goalClear', 'compact', 'review'];
