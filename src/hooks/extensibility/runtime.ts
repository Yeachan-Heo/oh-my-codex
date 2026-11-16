import { dispatchHookEvent } from './dispatcher.js';
import { isHookPluginsEnabled } from './loader.js';
import type { HookRuntimeDispatchInput, HookRuntimeDispatchResult } from './types.js';

async function handleNativeStopTeamLeaderAttention(input: HookRuntimeDispatchInput): Promise<void> {
  if (input.event.source !== 'native' || input.event.event !== 'stop') return;
  const sessionId = typeof input.event.session_id === 'string' ? input.event.session_id.trim() : '';
  if (!sessionId) return;
  try {
    const { markOwnedTeamsLeaderStopObserved } = await import('../../team/state.js');
    await markOwnedTeamsLeaderStopObserved(input.cwd, sessionId, input.event.timestamp, 'native_stop');
  } catch (err) {
    // If team state access fails (e.g., stale lock), do not propagate.
    // The main Stop hook dispatch will handle the error and return appropriate guidance.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('team_lock_recovery_required')) {
      throw err;
    }
  }
}


export async function dispatchHookEventRuntime(input: HookRuntimeDispatchInput): Promise<HookRuntimeDispatchResult> {
  const enabled = input.event.source === 'native' || input.event.source === 'derived'
    ? true
    : isHookPluginsEnabled(process.env);
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

  await handleNativeStopTeamLeaderAttention(input);

  const result = await dispatchHookEvent(input.event, {
    cwd: input.cwd,
    pluginDiscoveryCwd: input.pluginDiscoveryCwd,
    allowTeamWorkerSideEffects: input.allowTeamWorkerSideEffects,
    enabled,
  });

  return {
    dispatched: true,
    reason: 'ok',
    result,
  };
}
