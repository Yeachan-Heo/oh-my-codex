import { dispatchHookEvent } from './dispatcher.js';
import { isHookPluginsEnabled } from './loader.js';
import type { HookRuntimeDispatchInput, HookRuntimeDispatchResult } from './types.js';

export async function dispatchHookEventRuntime(input: HookRuntimeDispatchInput): Promise<HookRuntimeDispatchResult> {
  const enabled = isHookPluginsEnabled(process.env);
  if (!enabled) {
    return {
      dispatched: false,
      reason: 'plugins_disabled',
      result: {
        enabled: false,
        reason: 'disabled',
        event: input.event.event,
        source: input.event.source,
        plugin_count: 0,
        results: [],
      },
    };
  }

  const result = await dispatchHookEvent(input.event, {
    cwd: input.cwd,
    allowTeamWorkerSideEffects: input.allowTeamWorkerSideEffects,
  });

  return {
    dispatched: true,
    reason: 'ok',
    result,
  };
}
