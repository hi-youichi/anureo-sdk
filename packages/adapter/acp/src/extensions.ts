// Parses optional AHP capabilities advertised in native ACP metadata.
import { record } from './mapping';

/** Operations that can be advertised as private ACP methods. */
export type ExtensionKey = 'fork' | 'revert' | 'steer' | 'history' | 'goalSet' | 'goalClear' | 'compact' | 'review';
/** Negotiated features shared by AcpAdapter and its backend sessions. */
export interface Extensions {
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
}
/** Read AHP v1 metadata or v2 metadata with explicit turn correlation. AcpAdapter.configureCapabilities
 * stores the parsed methods and flags and uses them to advertise supported operations.
 * Missing or incompatible metadata yields no capabilities from this extension. */
export function extensions(response: unknown): Extensions {
  const extension = record(record(record(response)._meta).ahp);
  const methods: Extensions['methods'] = {};
  const result: Extensions = { methods, fork: [], revert: [], subagents: false, instructions: false, userInput: false, dynamicTool: false };
  if (extension.version !== 1 && !(extension.version === 2 && extension.turnCorrelation === true)) return result;
  result.nativeLifecycle = extension.version === 2 && extension.turnCorrelation === true;
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

const extensionKeys: readonly ExtensionKey[] = ['fork', 'revert', 'steer', 'history', 'goalSet', 'goalClear', 'compact', 'review'];
