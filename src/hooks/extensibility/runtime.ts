import { dispatchHookEvent } from './dispatcher.js';
import { isHookPluginsEnabled } from './loader.js';
import type { HookRuntimeDispatchInput, HookRuntimeDispatchResult } from './types.js';

async function handleNativeStopTeamLeaderAttention(input: HookRuntimeDispatchInput): Promise<void> {
  if (input.event.source !== 'native' || input.event.event !== 'stop') return;
  const sessionId = typeof input.event.session_id === 'string' ? input.event.session_id.trim() : '';
  if (!sessionId) return;
  const { markOwnedTeamsLeaderStopObserved } = await import('../../team/state.js');
  await markOwnedTeamsLeaderStopObserved(input.cwd, sessionId, input.event.timestamp, 'native_stop');
}

async function reportHerdrLifecycle(input: HookRuntimeDispatchInput): Promise<void> {
  try {
    const { reportHerdrLifecycleEvent } = await import('../../adapt/herdr/wiring.js');
    await reportHerdrLifecycleEvent({ cwd: input.cwd, event: input.event });
  } catch {
    // Opt-in, best-effort bridge: a Herdr failure never affects the OMX run.
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
  await reportHerdrLifecycle(input);

  const result = await dispatchHookEvent(input.event, {
    cwd: input.cwd,
    allowTeamWorkerSideEffects: input.allowTeamWorkerSideEffects,
    enabled,
  });

  return {
    dispatched: true,
    reason: 'ok',
    result,
  };
}
