import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { JsonValue } from '@anureo/protocol';
import { HarnessSdkError, type NativeHookCallbacks } from '@anureo/sdk';

const supportedTools = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep']);

/** These built-ins use Claude's per-call PreToolUse callback before native permission handling. */
export function validateNativeHooks(hooks: NativeHookCallbacks): void {
  if (hooks.beforeTool?.toolNames.some(name => !supportedTools.has(name))) {
    throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Unsupported Claude pre-tool hook target');
  }
}

interface StopTurn {
  id: string;
  stopExtended?: boolean;
}

interface HookScope {
  sessionId: string;
  current: () => StopTurn | undefined;
  stopTurn: () => Promise<StopTurn | undefined>;
  mayContinue: () => boolean;
  signal: () => AbortSignal;
}

/** Map host hook decisions to native control responses for a single query generation. */
export function claudeNativeHooks(hooks: NativeHookCallbacks, scope: HookScope): Options['hooks'] {
  const timeout = Math.ceil(hooks.timeoutMs / 1000) + 2;
  const { beforeTool, beforeStop } = hooks;
  const result: NonNullable<Options['hooks']> = {};
  if (beforeTool) {
    result.PreToolUse = [{
      matcher: `^(?:${beforeTool.toolNames.join('|')})$`, timeout,
      hooks: [async (input, toolId, { signal }) => {
        if (input.hook_event_name !== 'PreToolUse' || !beforeTool.toolNames.includes(input.tool_name)) return {};
        const deny = { hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: 'Tool call rejected by the application policy.',
        } };
        const scopedSignal = AbortSignal.any([signal, scope.signal()]);
        const toolCallId = toolId || input.tool_use_id;
        if (!toolCallId || scopedSignal.aborted) return deny;
        const turnId = scope.current()?.id;
        // The SDK decodes callback input from JSON on the native transport.
        const decision = await beforeTool.invoke({
          sessionId: scope.sessionId, turnId, toolCallId, toolName: input.tool_name, input: (input.tool_input ?? null) as JsonValue,
        }, scopedSignal);
        return scopedSignal.aborted || decision === 'deny' ? deny : {};
      }],
    }];
  }
  if (beforeStop) {
    result.Stop = [{ timeout, hooks: [async (input, _toolId, { signal }) => {
      if (input.hook_event_name !== 'Stop' || input.agent_id || input.stop_hook_active || !scope.mayContinue()) return {};
      const turn = await scope.stopTurn();
      if (!turn || turn.stopExtended) return {};
      const scopedSignal = AbortSignal.any([signal, scope.signal()]);
      if (scopedSignal.aborted) return {};
      const prompt = await beforeStop({
        sessionId: scope.sessionId, turnId: turn.id, lastAssistantMessage: input.last_assistant_message,
      }, scopedSignal);
      if (!prompt || scopedSignal.aborted || scope.current() !== turn || turn.stopExtended || !scope.mayContinue()) return {};
      turn.stopExtended = true;
      return { decision: 'block', reason: prompt };
    }] }];
  }
  return result;
}
