import { safeString } from './utils.js';
import { runProcess } from './process-runner.js';
import { buildPaneCurrentCommandArgv, isPaneRunningShell } from '../tmux-hook-engine.js';

export async function checkPaneReadyForTeamSendKeys(paneTarget) {
  const target = safeString(paneTarget).trim();
  if (!target) {
    return { ok: false, reason: 'missing_pane_target', paneCurrentCommand: '' };
  }

  try {
    const result = await runProcess('tmux', buildPaneCurrentCommandArgv(target), 1000);
    const paneCurrentCommand = safeString(result.stdout).trim();
    if (isPaneRunningShell(paneCurrentCommand)) {
      return {
        ok: false,
        reason: 'pane_running_shell',
        paneCurrentCommand,
      };
    }
    return {
      ok: true,
      paneCurrentCommand,
    };
  } catch {
    return {
      ok: true,
      paneCurrentCommand: '',
    };
  }
}
