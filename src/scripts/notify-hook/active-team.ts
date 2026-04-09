import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { readTeamManifestV2, readTeamPhase } from '../../team/state.js';
import { resolveCanonicalTeamStateRoot } from '../../team/state-root.js';
import { isTerminalPhase, safeString } from './utils.js';

export interface NotifyCanonicalActiveTeam {
  teamName: string;
  phase: string;
  ownerSessionId: string;
  path: string;
  source: 'canonical_fallback';
}

export async function listNotifyCanonicalActiveTeams(
  cwd: string,
  currentSessionId: string,
): Promise<NotifyCanonicalActiveTeam[]> {
  const sessionId = safeString(currentSessionId).trim();
  if (!sessionId) return [];

  const teamsRoot = join(resolveCanonicalTeamStateRoot(cwd), 'team');
  if (!existsSync(teamsRoot)) return [];

  const entries = await readdir(teamsRoot, { withFileTypes: true }).catch(() => []);
  const teams: NotifyCanonicalActiveTeam[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const teamName = entry.name.trim();
    if (!teamName) continue;

    const [manifest, phaseState] = await Promise.all([
      readTeamManifestV2(teamName, cwd),
      readTeamPhase(teamName, cwd),
    ]);
    if (!manifest || !phaseState) continue;

    const ownerSessionId = safeString(manifest.leader?.session_id).trim();
    if (!ownerSessionId || ownerSessionId !== sessionId) continue;

    const phase = safeString(phaseState.current_phase).trim();
    if (!phase || isTerminalPhase(phase)) continue;

    teams.push({
      teamName,
      phase,
      ownerSessionId,
      path: join(teamsRoot, teamName, 'phase.json'),
      source: 'canonical_fallback',
    });
  }
  return teams;
}
