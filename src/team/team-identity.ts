import { createHash, randomUUID } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { TEAM_NAME_SAFE_PATTERN } from './contracts.js';
import { resolveCanonicalTeamStateRoot } from './state-root.js';

export interface TeamIdentityScope {
  sessionId: string;
  paneId: string;
  tmuxTarget: string;
  runId: string;
  source: 'env-session' | 'tmux-pane' | 'run-id';
}

export interface TeamLookupCandidate {
  teamName: string;
  displayName: string;
  requestedName: string;
  leaderSessionId: string;
  leaderPaneId: string;
  tmuxSession: string;
  terminal: boolean;
  phaseUpdatedAt: string;
}

export class TeamLookupAmbiguityError extends Error {
  readonly candidates: TeamLookupCandidate[];

  constructor(input: string, candidates: TeamLookupCandidate[]) {
    super(`ambiguous_team_name:${input}:${candidates.map((c) => c.teamName).join(',')}`);
    this.name = 'TeamLookupAmbiguityError';
    this.candidates = candidates;
  }
}

function sanitizeBase(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return sanitized || 'team';
}

function normalizeLookupName(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const input = sanitized.slice(0, 30).replace(/-$/, '');
  if (!TEAM_NAME_SAFE_PATTERN.test(input)) {
    throw new Error(`invalid_team_name:${value}`);
  }
  return input;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

export function resolveTeamIdentityScope(env: NodeJS.ProcessEnv = process.env): TeamIdentityScope {
  const sessionId = (env.OMX_SESSION_ID || env.CODEX_SESSION_ID || env.SESSION_ID || '').trim();
  if (sessionId) {
    return { sessionId, paneId: (env.TMUX_PANE || '').trim(), tmuxTarget: (env.TMUX || '').trim(), runId: '', source: 'env-session' };
  }

  const paneId = (env.TMUX_PANE || '').trim();
  const tmuxTarget = (env.TMUX || '').trim();
  if (paneId || tmuxTarget) {
    return { sessionId: '', paneId, tmuxTarget, runId: '', source: 'tmux-pane' };
  }

  return { sessionId: '', paneId: '', tmuxTarget: '', runId: randomUUID(), source: 'run-id' };
}

export function buildInternalTeamName(displayName: string, scope: TeamIdentityScope): string {
  const base = sanitizeBase(displayName);
  const identity = scope.sessionId || (scope.tmuxTarget || scope.paneId ? `${scope.tmuxTarget}:${scope.paneId}` : '') || scope.runId;
  const suffix = shortHash(identity || randomUUID());
  const prefix = base.slice(0, Math.max(1, 30 - suffix.length - 1)).replace(/-$/, '') || 'team';
  const teamName = `${prefix}-${suffix}`;
  if (!TEAM_NAME_SAFE_PATTERN.test(teamName)) {
    throw new Error(`invalid_internal_team_name:${teamName}`);
  }
  return teamName;
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function candidateFromDir(root: string, teamName: string): TeamLookupCandidate | null {
  const manifest = readJson(join(root, teamName, 'manifest.v2.json'));
  const config = readJson(join(root, teamName, 'config.json'));
  const source = manifest || config;
  if (!source) return null;
  const leader = source.leader && typeof source.leader === 'object' && !Array.isArray(source.leader)
    ? source.leader as Record<string, unknown>
    : {};
  const phase = readJson(join(root, teamName, 'phase.json'));
  const currentPhase = str(phase?.current_phase);
  const displayName = str(source.display_name) || str(source.requested_name) || str(config?.display_name) || str(config?.requested_name) || teamName;
  return {
    teamName,
    displayName,
    requestedName: str(source.requested_name) || str(config?.requested_name) || displayName,
    leaderSessionId: str(leader.session_id),
    leaderPaneId: str(source.leader_pane_id) || str(config?.leader_pane_id),
    tmuxSession: str(source.tmux_session) || str(config?.tmux_session),
    terminal: currentPhase === 'complete' || currentPhase === 'failed' || currentPhase === 'cancelled',
    phaseUpdatedAt: str(phase?.updated_at),
  };
}

function teamLookupRoots(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  // Identity lookup follows the canonical state root only. Enumerating
  // cwd/.omx/state alongside an explicitly selected root lets an alias in the
  // unselected root rename or mask teams addressed through the selected root
  // and makes the reported state path unreliable.
  const canonical = resolveCanonicalTeamStateRoot(cwd, env);
  return [join(canonical, 'team')];
}

export function listTeamLookupCandidates(cwd: string, env: NodeJS.ProcessEnv = process.env): TeamLookupCandidate[] {
  const byTeamName = new Map<string, TeamLookupCandidate>();
  for (const root of teamLookupRoots(cwd, env)) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = candidateFromDir(root, entry.name);
      if (candidate && !byTeamName.has(candidate.teamName)) {
        byTeamName.set(candidate.teamName, candidate);
      }
    }
  }
  return [...byTeamName.values()];
}

function matchingCurrentLeader(candidate: TeamLookupCandidate, scope: TeamIdentityScope): boolean {
  return (Boolean(scope.sessionId) && candidate.leaderSessionId === scope.sessionId)
    || (Boolean(scope.paneId) && candidate.leaderPaneId === scope.paneId);
}

function selectLatestTerminalCandidate(candidates: TeamLookupCandidate[]): TeamLookupCandidate | null {
  const terminal = candidates.filter((candidate) => candidate.terminal);
  if (terminal.length === 0) return null;

  const ranked = terminal
    .map((candidate) => ({ candidate, time: Date.parse(candidate.phaseUpdatedAt) }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => b.time - a.time);
  if (ranked.length === 0) return terminal.length === 1 ? terminal[0] : null;
  if (ranked.length === 1 || ranked[0].time > ranked[1].time) return ranked[0].candidate;
  return null;
}

export function resolveTeamNameForCurrentContext(inputName: string, cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const input = normalizeLookupName(inputName);
  const candidates = listTeamLookupCandidates(cwd, env).filter((candidate) => {
    return candidate.teamName === input
      || sanitizeBase(candidate.displayName) === input
      || sanitizeBase(candidate.requestedName) === input;
  });
  if (candidates.length === 0) return input;

  const scope = resolveTeamIdentityScope(env);
  const activeCandidates = candidates.filter((candidate) => !candidate.terminal);
  const lookupCandidates = activeCandidates.length > 0 ? activeCandidates : candidates;
  if (lookupCandidates.length === 1) return lookupCandidates[0].teamName;

  const current = lookupCandidates.filter((candidate) => matchingCurrentLeader(candidate, scope));
  if (current.length === 1) return current[0].teamName;

  if (activeCandidates.length === 0) {
    const latestTerminal = selectLatestTerminalCandidate(lookupCandidates);
    if (latestTerminal) return latestTerminal.teamName;
  }

  throw new TeamLookupAmbiguityError(input, current.length > 1 ? current : lookupCandidates);
}
