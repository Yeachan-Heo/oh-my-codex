import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { basename, dirname } from 'path';
import { readSessionState, isSessionStale } from '../../hooks/session.js';
import { runProcess } from './process-runner.js';
import { safeString } from './utils.js';
import { sameFilePath } from '../../utils/paths.js';
import type { ResolvedPromptTurnContext } from '../../hooks/prompt-session-provenance.js';


const OMX_INSTANCE_OPTION = '@omx_instance_id';
const OMX_PANE_INSTANCE_OPTION = '@omx_pane_instance_id';

function sanitizeTmuxToken(value: string): string {
  const cleaned = safeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'unknown';
}

export function buildExpectedManagedTmuxSessionName(cwd: string, sessionId: string): string {
  const parentPath = dirname(cwd);
  const parentDir = basename(parentPath);
  const dirName = basename(cwd);
  const grandparentPath = dirname(parentPath);
  const grandparentDir = basename(grandparentPath);
  const repoDir = parentDir.endsWith('.omx-worktrees')
    ? parentDir.slice(0, -'.omx-worktrees'.length)
    : parentDir === 'worktrees' && grandparentDir === '.omx'
      ? basename(dirname(grandparentPath))
      : null;
  const dirToken = repoDir
    ? sanitizeTmuxToken(`${repoDir}-${dirName}`)
    : sanitizeTmuxToken(dirName);
  let branchToken = 'detached';
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      windowsHide: true,
    }).trim();
    if (branch) branchToken = sanitizeTmuxToken(branch);
  } catch {
    // best effort only
  }
  const sessionToken = sanitizeTmuxToken(sessionId.replace(/^omx-/, ''));
  const name = `omx-${dirToken}-${branchToken}-${sessionToken}`;
  return name.length > 120 ? name.slice(0, 120) : name;
}

export function resolveInvocationSessionId(payload: any): string {
  return safeString(
    payload?.session_id
    || payload?.['session-id']
    || process.env.OMX_SESSION_ID
    || process.env.CODEX_SESSION_ID
    || process.env.SESSION_ID
    || '',
  ).trim();
}

function readNativeSessionId(sessionState: { native_session_id?: unknown; codex_session_id?: unknown }): string {
  return safeString(sessionState.native_session_id || sessionState.codex_session_id || '').trim();
}

function readAuthoritativeTmuxSessionName(sessionState: { tmux_session_name?: unknown; tmuxSessionName?: unknown }): string {
  return safeString(sessionState.tmux_session_name || sessionState.tmuxSessionName || '').trim();
}

function readCurrentTmuxSessionName(): string {
  if (!process.env.TMUX) return '';
  try {
    return execFileSync('tmux', ['display-message', '-p', '#S'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

interface TmuxOptionProbe {
  status: 'present' | 'absent' | 'error';
  value: string;
}

async function probeTmuxOption(targetValue: string, optionName: string, { pane = false } = {}): Promise<TmuxOptionProbe> {
  const target = safeString(targetValue).trim();
  if (!target) return { status: 'absent', value: '' };
  const args = ['show-option', '-qv'];
  if (pane) args.push('-p');
  args.push('-t', target, optionName);
  try {
    const result = await runProcess('tmux', args, 2000);
    const value = safeString(result.stdout).trim();
    return { status: value ? 'present' : 'absent', value };
  } catch {
    return { status: 'error', value: '' };
  }
}

async function readTmuxOption(targetValue: string, optionName: string, { pane = false } = {}): Promise<string> {
  return (await probeTmuxOption(targetValue, optionName, { pane })).value;
}

async function readTmuxSessionInstanceId(sessionTarget: string): Promise<string> {
  return readTmuxOption(sessionTarget, OMX_INSTANCE_OPTION);
}

async function readTmuxPaneInstanceId(paneTarget: string): Promise<string> {
  return readTmuxOption(paneTarget, OMX_PANE_INSTANCE_OPTION, { pane: true });
}

export interface ActualTmuxInstanceEvidence {
  paneTarget: string;
  sessionName: string;
  paneInstanceId: string;
  sessionInstanceId: string;
  instanceId: string;
  source: 'none' | 'pane' | 'session';
  paneTagStatus: 'not-requested' | 'present' | 'absent' | 'error';
}

export async function probeActualTmuxInstanceEvidence(paneTarget?: string): Promise<ActualTmuxInstanceEvidence> {
  const resolvedPaneTarget = safeString(paneTarget ?? process.env.TMUX_PANE ?? '').trim();
  let sessionName = '';
  if (resolvedPaneTarget) {
    try {
      const result = await runProcess('tmux', ['display-message', '-p', '-t', resolvedPaneTarget, '#S'], 2000);
      sessionName = safeString(result.stdout).trim();
    } catch {
      // A pane target without a session cannot provide session-tag evidence.
    }
  } else {
    sessionName = readCurrentTmuxSessionName();
  }

  const paneProbe = resolvedPaneTarget
    ? await probeTmuxOption(resolvedPaneTarget, OMX_PANE_INSTANCE_OPTION, { pane: true })
    : { status: 'absent' as const, value: '' };
  const paneTagStatus = resolvedPaneTarget ? paneProbe.status : 'not-requested';
  if (paneProbe.status === 'present') {
    return {
      paneTarget: resolvedPaneTarget,
      sessionName,
      paneInstanceId: paneProbe.value,
      sessionInstanceId: '',
      instanceId: paneProbe.value,
      source: 'pane',
      paneTagStatus,
    };
  }
  if (paneProbe.status === 'error') {
    return {
      paneTarget: resolvedPaneTarget,
      sessionName,
      paneInstanceId: '',
      sessionInstanceId: '',
      instanceId: '',
      source: 'none',
      paneTagStatus,
    };
  }

  const sessionInstanceId = sessionName
    ? await readTmuxSessionInstanceId(sessionName)
    : '';
  return {
    paneTarget: resolvedPaneTarget,
    sessionName,
    paneInstanceId: '',
    sessionInstanceId,
    instanceId: sessionInstanceId,
    source: sessionInstanceId ? 'session' : 'none',
    paneTagStatus,
  };
}

export function tmuxEvidenceBindsCandidate(
  evidence: ActualTmuxInstanceEvidence,
  candidateSessionId: string,
): boolean {
  const candidate = safeString(candidateSessionId).trim();
  if (!candidate) return false;
  if (evidence.paneTagStatus === 'present') {
    return evidence.source === 'pane' && evidence.paneInstanceId === candidate;
  }
  return evidence.paneTagStatus === 'absent'
    && evidence.source === 'session'
    && evidence.sessionInstanceId === candidate;
}


function warnPaneInstanceFallback(paneTarget: string): void {
  // Notify hooks run inside Codex foreground hook surfaces. Keep this
  // compatibility fallback silent; downstream tmux-hook events still record
  // skipped/failed injection decisions in .omx/logs.
  void paneTarget;
}

export async function resolveTmuxSessionForInstance(instanceId: string): Promise<string> {
  const expected = safeString(instanceId).trim();
  if (!expected) return '';
  try {
    const result = await runProcess('tmux', ['list-sessions', '-F', `#{session_name}\t#{${OMX_INSTANCE_OPTION}}`], 2000);
    const rows = safeString(result.stdout).split('\n').map(line => line.trim()).filter(Boolean);
    for (const row of rows) {
      const [sessionName = '', taggedInstanceId = ''] = row.split('\t');
      if (sessionName && taggedInstanceId === expected) return sessionName;
    }
  } catch {
    // best effort only
  }
  return '';
}

function readParentPid(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    if (process.platform === 'win32') return null;
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const commandEnd = stat.lastIndexOf(')');
      if (commandEnd === -1) return null;
      const remainder = stat.slice(commandEnd + 1).trim();
      const fields = remainder.split(/\s+/);
      if (fields.length === 0) return null;
      const ppid = Number(fields[1]);
      return Number.isFinite(ppid) && ppid > 0 ? ppid : null;
    }
    const raw = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 2000,
      windowsHide: true,
    }).trim();
    const ppid = Number(raw);
    return Number.isFinite(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

function processHasAncestorPid(targetPid: number, currentPid = process.pid): boolean {
  if (!Number.isInteger(targetPid) || targetPid <= 1) return false;
  let pid = Number.isInteger(currentPid) && currentPid > 1 ? currentPid : process.pid;
  for (let depth = 0; depth < 64 && pid > 1; depth += 1) {
    if (pid === targetPid) return true;
    const parent = readParentPid(pid);
    if (!parent || parent === pid) break;
    pid = parent;
  }
  return false;
}

export async function resolveManagedSessionContext(
  cwd: string,
  payload: any,
  { allowTeamWorker = true, paneTarget = '' }: { allowTeamWorker?: boolean; paneTarget?: string } = {},
): Promise<any> {
  if (allowTeamWorker && safeString(process.env.OMX_TEAM_WORKER || '').trim() !== '') {
    return {
      managed: true,
      reason: 'team_worker',
      invocationSessionId: '',
      sessionState: null,
      expectedTmuxSessionName: '',
      currentTmuxSessionName: '',
    };
  }

  const invocationSessionId = resolveInvocationSessionId(payload);
  if (!invocationSessionId) {
    return {
      managed: false,
      reason: 'missing_session_id',
      invocationSessionId: '',
      sessionState: null,
      expectedTmuxSessionName: '',
      currentTmuxSessionName: '',
    };
  }

  try {
    const sessionState = await readSessionState(cwd);
    if (!sessionState) {
      return { managed: false, reason: 'missing_session_state', invocationSessionId, sessionState: null, expectedTmuxSessionName: '', currentTmuxSessionName: '' };
    }
    if (!sameFilePath(safeString(sessionState.cwd || cwd), cwd)) {
      return { managed: false, reason: 'cwd_mismatch', invocationSessionId, sessionState, expectedTmuxSessionName: '', currentTmuxSessionName: '' };
    }
    const canonicalSessionId = safeString(sessionState.session_id).trim();
    const nativeSessionId = readNativeSessionId(sessionState);
    const allowedInvocationIds = new Set([canonicalSessionId, nativeSessionId].filter(Boolean));
    if (!allowedInvocationIds.has(invocationSessionId)) {
      return { managed: false, reason: 'session_id_mismatch', invocationSessionId, sessionState, expectedTmuxSessionName: '', currentTmuxSessionName: '' };
    }
    if (isSessionStale(sessionState)) {
      return { managed: false, reason: 'stale_session', invocationSessionId, sessionState, expectedTmuxSessionName: '', currentTmuxSessionName: '', taggedTmuxSessionName: '' };
    }

    const authoritativeSessionCwd = safeString(sessionState.cwd || cwd).trim() || cwd;
    const authoritativeTmuxSessionName = readAuthoritativeTmuxSessionName(sessionState);
    const expectedTmuxSessionName = authoritativeTmuxSessionName
      || buildExpectedManagedTmuxSessionName(
        authoritativeSessionCwd,
        canonicalSessionId || invocationSessionId,
      );
    const evidence = await probeActualTmuxInstanceEvidence(paneTarget);
    const currentTmuxSessionName = evidence.sessionName || readCurrentTmuxSessionName();
    const currentTmuxPaneTarget = evidence.paneTarget;
    const currentTmuxPaneInstanceId = evidence.paneInstanceId;
    if (currentTmuxPaneInstanceId && currentTmuxPaneInstanceId !== invocationSessionId) {
      return {
        managed: false,
        reason: 'pane_instance_mismatch',
        invocationSessionId,
        sessionState,
        expectedTmuxSessionName,
        currentTmuxSessionName,
        currentTmuxPaneTarget,
        currentTmuxPaneInstanceId,
        taggedTmuxSessionName: '',
      };
    }
    if (currentTmuxPaneInstanceId === invocationSessionId) {
      return {
        managed: true,
        reason: 'tmux_pane_instance_match',
        invocationSessionId,
        sessionState,
        expectedTmuxSessionName,
        currentTmuxSessionName,
        currentTmuxPaneTarget,
        currentTmuxPaneInstanceId,
        taggedTmuxSessionName: currentTmuxSessionName,
      };
    }

    const currentTmuxInstanceId = evidence.sessionName === currentTmuxSessionName
      ? evidence.sessionInstanceId
      : currentTmuxSessionName
        ? await readTmuxSessionInstanceId(currentTmuxSessionName)
        : '';
    if (currentTmuxInstanceId && currentTmuxInstanceId !== invocationSessionId) {
      return {
        managed: false,
        reason: 'tmux_instance_mismatch',
        invocationSessionId,
        sessionState,
        expectedTmuxSessionName,
        currentTmuxSessionName,
        currentTmuxInstanceId,
        taggedTmuxSessionName: '',
      };
    }
    if (currentTmuxInstanceId === invocationSessionId) {
      if (currentTmuxPaneTarget) warnPaneInstanceFallback(currentTmuxPaneTarget);
      return {
        managed: true,
        reason: 'tmux_instance_match',
        invocationSessionId,
        sessionState,
        expectedTmuxSessionName,
        currentTmuxSessionName,
        currentTmuxInstanceId,
        currentTmuxPaneTarget,
        paneInstanceWarning: 'missing_pane_instance_tag_session_fallback',
        taggedTmuxSessionName: currentTmuxSessionName,
      };
    }

    const taggedTmuxSessionName = await resolveTmuxSessionForInstance(invocationSessionId);
    if (taggedTmuxSessionName) {
      return {
        managed: true,
        reason: 'tmux_instance_tag_match',
        invocationSessionId,
        sessionState,
        expectedTmuxSessionName,
        currentTmuxSessionName,
        taggedTmuxSessionName,
      };
    }

    if (currentTmuxSessionName && currentTmuxSessionName === expectedTmuxSessionName) {
      return {
        managed: true,
        reason: 'tmux_session_match',
        invocationSessionId,
        canonicalSessionId,
        nativeSessionId,
        sessionState,
        expectedTmuxSessionName,
        currentTmuxSessionName,
      };
    }
    if (authoritativeTmuxSessionName && currentTmuxSessionName) {
      return {
        managed: false,
        reason: 'tmux_session_mismatch',
        invocationSessionId,
        canonicalSessionId,
        nativeSessionId,
        sessionState,
        expectedTmuxSessionName,
        currentTmuxSessionName,
        taggedTmuxSessionName: '',
      };
    }

    if (processHasAncestorPid(sessionState.pid)) {
      return {
        managed: true,
        reason: currentTmuxSessionName ? 'pid_ancestry_match_tmux_mismatch' : 'pid_ancestry_match',
        invocationSessionId,
        canonicalSessionId,
        nativeSessionId,
        sessionState,
        expectedTmuxSessionName,
        currentTmuxSessionName: '',
        taggedTmuxSessionName: '',
      };
    }

    return {
      managed: false,
      reason: currentTmuxSessionName ? 'tmux_session_mismatch' : 'pid_ancestry_mismatch',
      invocationSessionId,
      canonicalSessionId,
      nativeSessionId,
      sessionState,
      expectedTmuxSessionName,
      currentTmuxSessionName,
      taggedTmuxSessionName: '',
    };
  } catch {
    return {
      managed: false,
      reason: 'session_check_failed',
      invocationSessionId,
      sessionState: null,
      expectedTmuxSessionName: '',
      currentTmuxSessionName: '',
      taggedTmuxSessionName: '',
    };
  }
}

export async function isManagedOmxSession(cwd: string, payload: any, options: { allowTeamWorker?: boolean } = {}): Promise<boolean> {
  const context = await resolveManagedSessionContext(cwd, payload, options);
  return context.managed === true;
}

/**
 * Leader-only adapter: tmux ownership is derived from the immutable provenance
 * owner instead of re-reading payload or environment session identity.
 */
export async function isManagedOmxSessionAtPromptContext(
  cwd: string,
  context: ResolvedPromptTurnContext,
  options: { allowTeamWorker?: boolean } = {},
): Promise<boolean> {
  if (context.status !== 'authorized') return false;
  return isManagedOmxSession(cwd, { session_id: context.authorization.ownerCodexSessionId }, options);
}

export async function verifyManagedPaneTargetAtPromptContext(paneId: string, cwd: string, context: ResolvedPromptTurnContext): Promise<any> {
  if (context.status !== 'authorized') return { ok: false, reason: 'prompt_context_unauthorized', paneTarget: safeString(paneId).trim() };
  return verifyManagedPaneTarget(paneId, cwd, { session_id: context.authorization.ownerCodexSessionId }, { allowTeamWorker: false });
}

export async function resolveManagedCurrentPaneAtPromptContext(cwd: string, context: ResolvedPromptTurnContext): Promise<string> {
  if (context.status !== 'authorized') return '';
  return resolveManagedCurrentPane(cwd, { session_id: context.authorization.ownerCodexSessionId }, { allowTeamWorker: false });
}

export async function resolveManagedSessionPaneAtPromptContext(cwd: string, context: ResolvedPromptTurnContext): Promise<string> {
  if (context.status !== 'authorized') return '';
  return resolveManagedSessionPane(cwd, { session_id: context.authorization.ownerCodexSessionId });
}

export async function resolveManagedPaneFromAnchorAtPromptContext(anchorPane: string, cwd: string, context: ResolvedPromptTurnContext): Promise<string> {
  if (context.status !== 'authorized') return '';
  return resolveManagedPaneFromAnchor(anchorPane, cwd, { session_id: context.authorization.ownerCodexSessionId }, { allowTeamWorker: false });
}

export async function verifyManagedPaneTarget(paneId: string, cwd: string, payload: any, { allowTeamWorker = true } = {}): Promise<any> {
  const paneTarget = safeString(paneId).trim();
  if (!paneTarget) {
    return { ok: false, reason: 'missing_pane_target', paneTarget: '' };
  }

  const managedContext = await resolveManagedSessionContext(cwd, payload, { allowTeamWorker, paneTarget });
  if (!managedContext.managed) {
    return { ok: false, reason: managedContext.reason || 'unmanaged_session', paneTarget, managedContext };
  }

  if (managedContext.reason === 'team_worker') {
    return { ok: true, reason: 'ok', paneTarget, managedContext };
  }

  const expectedSession = safeString(managedContext.expectedTmuxSessionName).trim();
  if (!expectedSession) {
    return { ok: false, reason: 'missing_expected_tmux_session', paneTarget, managedContext };
  }

  try {
    let paneSessionName = safeString(managedContext.currentTmuxSessionName).trim();
    if (!paneSessionName) {
      const sessionResult = await runProcess('tmux', ['display-message', '-p', '-t', paneTarget, '#S'], 2000);
      paneSessionName = safeString(sessionResult.stdout).trim();
    }
    if (!paneSessionName) {
      return { ok: false, reason: 'pane_session_missing', paneTarget, managedContext };
    }
    const paneInstanceId = safeString(managedContext.currentTmuxPaneInstanceId).trim()
      || await readTmuxPaneInstanceId(paneTarget);
    const sessionInstanceId = paneInstanceId
      ? ''
      : safeString(managedContext.currentTmuxInstanceId).trim()
        || await readTmuxSessionInstanceId(paneSessionName);
    if (paneInstanceId && paneInstanceId !== managedContext.invocationSessionId) {
      return { ok: false, reason: 'pane_instance_mismatch', paneTarget, paneSessionName, paneInstanceId, managedContext };
    }
    if (!paneInstanceId && sessionInstanceId) {
      warnPaneInstanceFallback(paneTarget);
      if (sessionInstanceId !== managedContext.invocationSessionId) {
        return {
          ok: false,
          reason: 'pane_instance_mismatch',
          paneTarget,
          paneSessionName,
          paneInstanceId: sessionInstanceId,
          paneInstanceWarning: 'missing_pane_instance_tag_session_fallback',
          managedContext,
        };
      }
    }
    if (paneSessionName !== expectedSession) {
      const taggedSession = safeString(managedContext.taggedTmuxSessionName).trim();
      if (taggedSession && paneSessionName === taggedSession) {
        return {
          ok: true,
          reason: 'ok',
          paneTarget,
          paneSessionName,
          paneInstanceId: paneInstanceId || sessionInstanceId,
          paneInstanceWarning: paneInstanceId ? '' : 'missing_pane_instance_tag_session_fallback',
          managedContext,
        };
      }
      return { ok: false, reason: 'pane_not_managed_session', paneTarget, paneSessionName, managedContext };
    }
    return {
      ok: true,
      reason: 'ok',
      paneTarget,
      paneSessionName,
      paneInstanceId: paneInstanceId || sessionInstanceId,
      paneInstanceWarning: paneInstanceId ? '' : 'missing_pane_instance_tag_session_fallback',
      managedContext,
    };
  } catch {
    return { ok: false, reason: 'pane_session_lookup_failed', paneTarget, managedContext };
  }
}


async function readManagedPaneCommandState(paneTarget: string): Promise<{ currentCommand: string; startCommand: string; lookupFailed: boolean }> {
  try {
    const [currentResult, startResult] = await Promise.all([
      runProcess('tmux', ['display-message', '-p', '-t', paneTarget, '#{pane_current_command}'], 2000),
      runProcess('tmux', ['display-message', '-p', '-t', paneTarget, '#{pane_start_command}'], 2000),
    ]);
    return {
      currentCommand: safeString(currentResult.stdout).trim().toLowerCase(),
      startCommand: safeString(startResult.stdout).trim().toLowerCase(),
      lookupFailed: false,
    };
  } catch {
    return { currentCommand: '', startCommand: '', lookupFailed: true };
  }
}

function paneLooksLikeManagedAgent({ currentCommand, startCommand }: { currentCommand: string; startCommand: string }): boolean {
  if (/\bomx\b.*\bhud\b.*--watch/i.test(startCommand)) return false;
  if (startCommand.includes('codex')) return true;
  return currentCommand === 'codex' || currentCommand === 'node' || currentCommand === 'npx';
}

function paneLooksLikeRetainableManagedAnchor({ currentCommand, startCommand }: { currentCommand: string; startCommand: string }): boolean {
  if (/\bomx\b.*\bhud\b.*--watch/i.test(startCommand)) return false;
  if (currentCommand === 'codex') return true;
  if ((currentCommand === 'node' || currentCommand === 'npx') && startCommand.includes('codex')) return true;
  return false;
}

function paneLooksLikeDetachedManagedWrapperFallback({ currentCommand, startCommand }: { currentCommand: string; startCommand: string }): boolean {
  if (/\bomx\b.*\bhud\b.*--watch/i.test(startCommand)) return false;
  return currentCommand === 'node' || currentCommand === 'npx';
}

interface ManagedSessionPaneRow {
  paneId: string;
  active: boolean;
  currentCommand: string;
  startCommand: string;
}

function parseManagedSessionPaneRows(stdout: string): ManagedSessionPaneRow[] {
  return safeString(stdout)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [paneId = '', activeRaw = '0', rawCurrentCommand = '', rawStartCommand = ''] = line.split('\t');
      return {
        paneId: safeString(paneId).trim(),
        active: safeString(activeRaw).trim() === '1',
        currentCommand: safeString(rawCurrentCommand).trim().toLowerCase(),
        startCommand: safeString(rawStartCommand).trim().toLowerCase(),
      };
    })
    .filter((row) => row.paneId !== '');
}

function selectManagedSessionPane(
  rows: ManagedSessionPaneRow[],
  { allowWrapperFallback = false }: { allowWrapperFallback?: boolean } = {},
): string {
  const nonHudRows = rows.filter((row) => !/\bomx\b.*\bhud\b.*--watch/i.test(row.startCommand));
  const canonicalRows = nonHudRows.filter((row) => paneLooksLikeRetainableManagedAnchor(row));
  const activeCanonical = canonicalRows.find((row) => row.active);
  if (activeCanonical) return activeCanonical.paneId;
  if (canonicalRows[0]?.paneId) return canonicalRows[0].paneId;
  if (!allowWrapperFallback) return '';

  const wrapperFallbackRows = nonHudRows.filter((row) => paneLooksLikeDetachedManagedWrapperFallback(row));
  const activeWrapperFallback = wrapperFallbackRows.find((row) => row.active);
  if (activeWrapperFallback) return activeWrapperFallback.paneId;
  return wrapperFallbackRows[0]?.paneId || '';
}
export async function resolveManagedCurrentPane(cwd: string, payload: any, { allowTeamWorker = false } = {}): Promise<string> {
  const paneTarget = safeString(process.env.TMUX_PANE || '').trim();
  if (!paneTarget) return '';
  const verdict = await verifyManagedPaneTarget(paneTarget, cwd, payload, { allowTeamWorker });
  if (!verdict.ok) return '';
  const commandState = await readManagedPaneCommandState(paneTarget);
  return paneLooksLikeManagedAgent(commandState) ? paneTarget : '';
}

export async function resolveManagedSessionPane(cwd: string, payload: any): Promise<string> {
  const managedContext = await resolveManagedSessionContext(cwd, payload, { allowTeamWorker: false });
  if (!managedContext.managed) return '';
  const expectedSession = safeString(managedContext.taggedTmuxSessionName || managedContext.expectedTmuxSessionName).trim();
  if (!expectedSession) return '';

  try {
    const panesResult = await runProcess(
      'tmux',
      ['list-panes', '-s', '-t', expectedSession, '-F', '#{pane_id}\t#{pane_active}\t#{pane_current_command}\t#{pane_start_command}'],
      2000,
    );
    return selectManagedSessionPane(parseManagedSessionPaneRows(panesResult.stdout));
  } catch {
    // best effort only
  }

  return '';
}

export async function resolveManagedPaneFromAnchor(anchorPane: string, cwd: string, payload: any, { allowTeamWorker = false } = {}): Promise<string> {
  const paneTarget = safeString(anchorPane).trim();
  if (!paneTarget) return '';
  const verdict = await verifyManagedPaneTarget(paneTarget, cwd, payload, { allowTeamWorker });
  if (!verdict.ok) return '';

  const commandState = await readManagedPaneCommandState(paneTarget);
  if (commandState.lookupFailed) return paneTarget;
  if (paneLooksLikeRetainableManagedAnchor(commandState)) return paneTarget;

  try {
    const sessionName = safeString(verdict.paneSessionName || verdict.managedContext?.expectedTmuxSessionName).trim();
    if (!sessionName) return '';

    const panesResult = await runProcess(
      'tmux',
      ['list-panes', '-s', '-t', sessionName, '-F', '#{pane_id}\t#{pane_active}\t#{pane_current_command}\t#{pane_start_command}'],
      2000,
    );
    const selectedPane = selectManagedSessionPane(parseManagedSessionPaneRows(panesResult.stdout), {
      allowWrapperFallback: paneLooksLikeDetachedManagedWrapperFallback(commandState),
    });
    if (selectedPane) return selectedPane;
  } catch {
    // best effort only
  }

  return '';
}
