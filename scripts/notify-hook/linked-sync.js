/**
 * Linked ralph/team terminal-phase synchronisation for notify-hook.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { safeString, isTerminalPhase } from './utils.js';
import { getScopedStateDirsForCurrentSession } from './state-io.js';

export async function syncLinkedRalphOnTeamTerminalInDir(stateDir, nowIso) {
  const teamStatePath = join(stateDir, 'team-state.json');
  const ralphStatePath = join(stateDir, 'ralph-state.json');
  if (!existsSync(teamStatePath) || !existsSync(ralphStatePath)) return;

  try {
    const teamState = JSON.parse(await readFile(teamStatePath, 'utf-8'));
    const ralphState = JSON.parse(await readFile(ralphStatePath, 'utf-8'));
    const teamPhase = safeString(teamState.current_phase);
    const linked = teamState.linked_ralph === true && ralphState.linked_team === true;
    if (!linked || !isTerminalPhase(teamPhase)) return;

    let changed = false;
    if (ralphState.active !== false) {
      ralphState.active = false;
      changed = true;
    }
    if (ralphState.current_phase !== teamPhase) {
      ralphState.current_phase = teamPhase;
      changed = true;
    }

    const terminalAt = safeString(teamState.completed_at) || nowIso;
    if (ralphState.linked_team_terminal_phase !== teamPhase) {
      ralphState.linked_team_terminal_phase = teamPhase;
      changed = true;
    }
    if (ralphState.linked_team_terminal_at !== terminalAt) {
      ralphState.linked_team_terminal_at = terminalAt;
      changed = true;
    }
    if (!ralphState.completed_at) {
      ralphState.completed_at = terminalAt;
      changed = true;
    }

    if (changed) {
      ralphState.last_turn_at = nowIso;
      await writeFile(ralphStatePath, JSON.stringify(ralphState, null, 2));
    }
  } catch {
    // Non-critical
  }
}

export async function syncLinkedRalphOnTeamTerminal(stateRootDir, nowIso, payloadSessionId) {
  const scopedDirs = await getScopedStateDirsForCurrentSession(stateRootDir, payloadSessionId);
  for (const scopedDir of scopedDirs) {
    await syncLinkedRalphOnTeamTerminalInDir(scopedDir, nowIso);
  }
}
