import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { basename, dirname, resolve as resolvePath } from 'path';
import { readSessionState, isSessionStale } from '../../hooks/session.js';
import { runProcess } from './process-runner.js';
import { safeString } from './utils.js';

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

function readCurrentTmuxSessionName(): string {
  if (!process.env.TMUX) return '';
  try {
    return execFileSync('tmux', ['display-message', '-p', '#S'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
  } catch {
    return '';
  }
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

export async function resolveManagedSessionContext(cwd: string, payload: any, { allowTeamWorker = true } = {}): Promise<any> {
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
    if (resolvePath(safeString(sessionState.cwd || cwd)) !== resolvePath(cwd)) {
      return { managed: false, reason: 'cwd_mismatch', invocationSessionId, sessionState, expectedTmuxSessionName: '', currentTmuxSessionName: '' };
    }
    if (safeString(sessionState.session_id).trim() !== invocationSessionId) {
      return { managed: false, reason: 'session_id_mismatch', invocationSessionId, sessionState, expectedTmuxSessionName: '', currentTmuxSessionName: '' };
    }
    if (isSessionStale(sessionState)) {
      return { managed: false, reason: 'stale_session', invocationSessionId, sessionState, expectedTmuxSessionName: '', currentTmuxSessionName: '' };
    }

    const expectedTmuxSessionName = buildExpectedManagedTmuxSessionName(cwd, invocationSessionId);
    const currentTmuxSessionName = readCurrentTmuxSessionName();
    if (currentTmuxSessionName && currentTmuxSessionName === expectedTmuxSessionName) {
      return {
        managed: true,
        reason: 'tmux_session_match',
        invocationSessionId,
        sessionState,
        expectedTmuxSessionName,
        currentTmuxSessionName,
      };
    }

    if (processHasAncestorPid(sessionState.pid)) {
      return {
        managed: true,
        reason: currentTmuxSessionName ? 'pid_ancestry_match_tmux_mismatch' : 'pid_ancestry_match',
        invocationSessionId,
        sessionState,
        expectedTmuxSessionName,
        currentTmuxSessionName: '',
      };
    }

    return {
      managed: false,
      reason: currentTmuxSessionName ? 'tmux_session_mismatch' : 'pid_ancestry_mismatch',
      invocationSessionId,
      sessionState,
      expectedTmuxSessionName,
      currentTmuxSessionName,
    };
  } catch {
    return {
      managed: false,
      reason: 'session_check_failed',
      invocationSessionId,
      sessionState: null,
      expectedTmuxSessionName: '',
      currentTmuxSessionName: '',
    };
  }
}

export async function isManagedOmxSession(cwd: string, payload: any, options: { allowTeamWorker?: boolean } = {}): Promise<boolean> {
  const context = await resolveManagedSessionContext(cwd, payload, options);
  return context.managed === true;
}

export async function verifyManagedPaneTarget(paneId: string, cwd: string, payload: any, { allowTeamWorker = true } = {}): Promise<any> {
  const paneTarget = safeString(paneId).trim();
  if (!paneTarget) {
    return { ok: false, reason: 'missing_pane_target', paneTarget: '' };
  }

  const managedContext = await resolveManagedSessionContext(cwd, payload, { allowTeamWorker });
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
    const sessionResult = await runProcess('tmux', ['display-message', '-p', '-t', paneTarget, '#S'], 2000);
    const paneSessionName = safeString(sessionResult.stdout).trim();
    if (!paneSessionName) {
      return { ok: false, reason: 'pane_session_missing', paneTarget, managedContext };
    }
    if (paneSessionName !== expectedSession) {
      return { ok: false, reason: 'pane_not_managed_session', paneTarget, paneSessionName, managedContext };
    }
    return { ok: true, reason: 'ok', paneTarget, paneSessionName, managedContext };
  } catch {
    return { ok: false, reason: 'pane_session_lookup_failed', paneTarget, managedContext };
  }
}


async function readManagedPaneCommandState(paneTarget: string): Promise<{ currentCommand: string; startCommand: string }> {
  try {
    const [currentResult, startResult] = await Promise.all([
      runProcess('tmux', ['display-message', '-p', '-t', paneTarget, '#{pane_current_command}'], 2000),
      runProcess('tmux', ['display-message', '-p', '-t', paneTarget, '#{pane_start_command}'], 2000),
    ]);
    return {
      currentCommand: safeString(currentResult.stdout).trim().toLowerCase(),
      startCommand: safeString(startResult.stdout).trim().toLowerCase(),
    };
  } catch {
    return { currentCommand: '', startCommand: '' };
  }
}

function paneLooksLikeManagedAgent({ currentCommand, startCommand }: { currentCommand: string; startCommand: string }): boolean {
  if (/\bomx\b.*\bhud\b.*--watch/i.test(startCommand)) return false;
  if (startCommand.includes('codex')) return true;
  return currentCommand === 'codex' || currentCommand === 'node' || currentCommand === 'npx';
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
  const expectedSession = safeString(managedContext.expectedTmuxSessionName).trim();
  if (!expectedSession) return '';

  try {
    const panesResult = await runProcess(
      'tmux',
      ['list-panes', '-s', '-t', expectedSession, '-F', '#{pane_id}\t#{pane_current_command}\t#{pane_start_command}'],
      2000,
    );
    const panes = safeString(panesResult.stdout)
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const line of panes) {
      const [candidatePaneId, rawCurrentCommand = '', rawStartCommand = ''] = line.split('\t');
      const startCommand = safeString(rawStartCommand).toLowerCase();
      const currentCommand = safeString(rawCurrentCommand).trim().toLowerCase();
      if (!candidatePaneId) continue;
      if (/\bomx\b.*\bhud\b.*--watch/i.test(startCommand)) continue;
      if (startCommand.includes('codex')) return candidatePaneId;
      if (currentCommand === 'codex') return candidatePaneId;
    }
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

  try {
    const sessionResult = await runProcess('tmux', ['display-message', '-p', '-t', paneTarget, '#S'], 2000);
    const sessionName = safeString(sessionResult.stdout).trim();
    if (!sessionName) return paneTarget;

    const panesResult = await runProcess(
      'tmux',
      ['list-panes', '-s', '-t', sessionName, '-F', '#{pane_id}\t#{pane_current_command}\t#{pane_start_command}'],
      2000,
    );
    const panes = safeString(panesResult.stdout).trim().split('\n').filter(Boolean);
    for (const line of panes) {
      const [candidatePaneId, rawCurrentCommand = '', rawStartCommand = ''] = line.split('\t');
      const startCommand = safeString(rawStartCommand).toLowerCase();
      const currentCommand = safeString(rawCurrentCommand).trim().toLowerCase();
      if (!candidatePaneId) continue;
      if (/\bomx\b.*\bhud\b.*--watch/i.test(startCommand)) continue;
      if (startCommand.includes('codex')) return candidatePaneId;
      if (currentCommand === 'codex') return candidatePaneId;
    }
  } catch {
    // best effort only
  }

  return paneTarget;
}
