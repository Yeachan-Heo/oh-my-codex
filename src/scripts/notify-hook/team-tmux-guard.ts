import { safeString } from './utils.js';
import { runProcess } from './process-runner.js';
import {
  buildCapturePaneArgv,
  buildPaneInModeArgv,
  buildPaneCurrentCommandArgv,
  buildSendKeysArgv,
  isPaneRunningShell,
  paneHasActiveTask,
  paneLooksReady,
} from '../tmux-hook-engine.js';

export const PANE_READINESS_UNVERIFIED_REASON = 'pane_readiness_unverified';

export function mapPaneInjectionReadinessReason(reason: any): any {
  return reason === 'pane_running_shell' ? 'agent_not_running' : reason;
}

export async function evaluatePaneInjectionReadiness(paneTarget: any, {
  skipIfScrolling = false,
  captureLines = 80,
  requireRunningAgent = true,
  requireReady = true,
  requireIdle = true,
  requireObservableState = false,
  requireCaptureEvidence = undefined,
} = {}): Promise<any> {
  const normalizedRequireObservableState = typeof requireCaptureEvidence === 'boolean' ? requireCaptureEvidence : requireObservableState;
  const target = safeString(paneTarget).trim();
  if (!target) {
    return {
      ok: false,
      sent: false,
      reason: 'missing_pane_target',
      paneTarget: '',
      paneCurrentCommand: '',
      paneCapture: '',
    };
  }
  if (skipIfScrolling) {
    try {
      const modeResult = await runProcess('tmux', buildPaneInModeArgv(target), 3000);
      if (safeString(modeResult.stdout).trim() === '1') {
        return {
          ok: false,
          sent: false,
          reason: 'scroll_active',
          paneTarget: target,
          paneCurrentCommand: '',
          paneCapture: '',
        };
      }
    } catch {
      // Non-fatal: continue with remaining preflight checks.
    }
  }

  let paneCurrentCommand = '';
  let paneRunningShell = false;
  const buildReadinessResult = (ok: boolean, reason: string, paneCapture: string, readinessEvidence: string) => ({
    ok,
    sent: false,
    reason,
    paneTarget: target,
    paneCurrentCommand,
    paneCapture,
    readinessEvidence,
  });
  try {
    const result = await runProcess('tmux', buildPaneCurrentCommandArgv(target), 3000);
    paneCurrentCommand = safeString(result.stdout).trim();
    paneRunningShell = requireRunningAgent && isPaneRunningShell(paneCurrentCommand);
  } catch {
    paneCurrentCommand = '';
  }

  try {
    const capture = await runProcess('tmux', buildCapturePaneArgv(target, captureLines), 3000);
    const paneCapture = safeString(capture.stdout);
    const hasCaptureEvidence = paneCapture.trim() !== '';
    if (hasCaptureEvidence) {
      const paneShowsLiveAgent = paneLooksReady(paneCapture) || paneHasActiveTask(paneCapture);
      if (paneRunningShell && !paneShowsLiveAgent) {
        return buildReadinessResult(false, 'pane_running_shell', paneCapture, 'captured');
      }
      if (requireIdle && paneHasActiveTask(paneCapture)) {
        return buildReadinessResult(false, 'pane_has_active_task', paneCapture, 'captured');
      }
      if (requireReady && !paneLooksReady(paneCapture)) {
        return buildReadinessResult(false, 'pane_not_ready', paneCapture, 'captured');
      }
      if (normalizedRequireObservableState && !paneShowsLiveAgent) {
        return buildReadinessResult(false, PANE_READINESS_UNVERIFIED_REASON, paneCapture, 'captured_unverified');
      }
      if (requireObservableState && !paneShowsLiveAgent) {
        return {
          ok: false,
          sent: false,
          reason: 'pane_state_unverified',
          paneTarget: target,
          paneCurrentCommand,
          paneCapture,
        };
      }
    }
    if (paneRunningShell && !hasCaptureEvidence) {
      return {
        ok: false,
        sent: false,
        reason: 'pane_running_shell',
        paneTarget: target,
        paneCurrentCommand,
        paneCapture,
      };
    }
    if (normalizedRequireObservableState && !hasCaptureEvidence && !paneCurrentCommand) {
      return buildReadinessResult(false, PANE_READINESS_UNVERIFIED_REASON, paneCapture, 'capture_empty');
    }
    return buildReadinessResult(true, 'ok', paneCapture, hasCaptureEvidence ? 'captured' : (paneCurrentCommand ? 'command_only' : 'none'));
  } catch {
    if (paneRunningShell) {
      return buildReadinessResult(false, 'pane_running_shell', '', 'capture_failed');
    }
    if (normalizedRequireObservableState) {
      return buildReadinessResult(false, PANE_READINESS_UNVERIFIED_REASON, '', 'capture_failed');
    }
    return buildReadinessResult(true, 'ok', '', paneCurrentCommand ? 'command_only' : 'none');
  }
}

export async function sendPaneInput({
  paneTarget,
  prompt,
  submitKeyPresses = 2,
  submitDelayMs = 0,
  typePrompt = true,
}: any): Promise<any> {
  const target = safeString(paneTarget).trim();
  if (!target) {
    return { ok: false, sent: false, reason: 'missing_pane_target', paneTarget: '' };
  }

  const normalizedSubmitKeyPresses = Number.isFinite(submitKeyPresses)
    ? Math.max(0, Math.floor(submitKeyPresses))
    : 2;
  const literalPrompt = safeString(prompt);
  const argv = normalizedSubmitKeyPresses === 0
    ? {
      typeArgv: ['send-keys', '-t', target, '-l', literalPrompt],
      submitArgv: [] as string[][],
    }
    : buildSendKeysArgv({
      paneTarget: target,
      prompt: literalPrompt,
      dryRun: false,
      submitKeyPresses: normalizedSubmitKeyPresses,
    });
  if (!argv) {
    return { ok: false, sent: false, reason: 'send_failed', paneTarget: target };
  }

  try {
    if (typePrompt) {
      await runProcess('tmux', argv.typeArgv, 3000);
    }
    for (const submit of argv.submitArgv) {
      if (submitDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
      }
      await runProcess('tmux', submit, 3000);
    }
    return { ok: true, sent: true, reason: 'sent', paneTarget: target, argv };
  } catch (error) {
    return {
      ok: false,
      sent: false,
      reason: 'send_failed',
      paneTarget: target,
      argv,
      error: error instanceof Error ? error.message : safeString(error),
    };
  }
}

export async function checkPaneReadyForTeamSendKeys(paneTarget: any): Promise<any> {
  return evaluatePaneInjectionReadiness(paneTarget);
}
