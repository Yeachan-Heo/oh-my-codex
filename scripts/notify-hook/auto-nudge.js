/**
 * Auto-nudge: detect Codex "asking for permission" stall patterns and
 * automatically send a continuation prompt so the agent keeps working.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { asNumber, safeString } from './utils.js';
import { readJsonIfExists, getScopedStateDirsForCurrentSession, readdir } from './state-io.js';
import { runProcess } from './process-runner.js';
import { logTmuxHookEvent } from './log.js';
import { checkPaneReadyForTeamSendKeys } from './team-tmux-guard.js';
import { buildCapturePaneArgv, DEFAULT_MARKER } from '../tmux-hook-engine.js';

export const SKILL_ACTIVE_STATE_FILE = 'skill-active-state.json';
export const DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS = ['yes', 'y', 'proceed', 'continue', 'ok', 'sure', 'go ahead', 'next i should'];
export const DEEP_INTERVIEW_INPUT_LOCK_MESSAGE = 'Deep interview is active; auto-approval shortcuts are blocked until the interview finishes.';
const DEEP_INTERVIEW_ERROR_PATTERNS = [' error', ' failed', ' failure', ' exception', 'unable to continue', 'cannot continue', 'could not continue'];
const DEEP_INTERVIEW_ABORT_PATTERNS = ['aborted', 'cancelled', 'canceled'];
const DEEP_INTERVIEW_ABORT_INPUTS = new Set(['abort', 'cancel', 'stop']);
const DEEP_INTERVIEW_BLOCKED_APPROVAL_PREFIXES = new Set(['next i should']);
const SKILL_PHASES = new Set(['planning', 'executing', 'reviewing', 'completing']);

function normalizeSkillPhase(phase) {
  const normalized = safeString(phase).toLowerCase().trim();
  return SKILL_PHASES.has(normalized) ? normalized : 'planning';
}

function normalizeInputLock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    active: raw.active !== false,
    scope: safeString(raw.scope),
    acquired_at: safeString(raw.acquired_at),
    released_at: safeString(raw.released_at),
    blocked_inputs: Array.isArray(raw.blocked_inputs)
      ? raw.blocked_inputs.map((value) => safeString(value).toLowerCase()).filter(Boolean)
      : [...DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS],
    message: safeString(raw.message) || DEEP_INTERVIEW_INPUT_LOCK_MESSAGE,
    exit_reason: safeString(raw.exit_reason),
  };
}

export function normalizeBlockedAutoApprovalInput(text) {
  return safeString(text)
    .toLowerCase()
    .replace(/\[omx_tmux_inject\]/gi, '')
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

export function isBlockedAutoApprovalInput(text, blockedInputs = DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS) {
  const normalized = normalizeBlockedAutoApprovalInput(text);
  if (!normalized) return false;
  if (blockedInputs.some((entry) => normalizeBlockedAutoApprovalInput(entry) === normalized)) return true;
  if (
    blockedInputs
      .map((entry) => normalizeBlockedAutoApprovalInput(entry))
      .filter((entry) => DEEP_INTERVIEW_BLOCKED_APPROVAL_PREFIXES.has(entry))
      .some((prefix) => normalized.startsWith(`${prefix} `))
  ) return true;

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  const blockedTokenSet = new Set(
    blockedInputs.flatMap((entry) => normalizeBlockedAutoApprovalInput(entry).split(/\s+/).filter(Boolean)),
  );
  return tokens.every((token) => blockedTokenSet.has(token));
}

function isDeepInterviewAbortInput(text) {
  return DEEP_INTERVIEW_ABORT_INPUTS.has(normalizeBlockedAutoApprovalInput(text));
}

function hasAnySubstring(text, patterns) {
  const lower = safeString(text).toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern));
}

export function isDeepInterviewAutoApprovalLocked(skillState) {
  return Boolean(
    skillState
    && skillState.skill === 'deep-interview'
    && skillState.input_lock
    && (safeString(skillState.input_lock.scope) === '' || skillState.input_lock.scope === 'deep-interview-auto-approval')
    && skillState.input_lock.active === true,
  );
}

export function inferDeepInterviewReleaseReason({ skillState, latestUserInput = '', lastMessage = '' }) {
  if (!isDeepInterviewAutoApprovalLocked(skillState)) {
    return null;
  }
  if (isDeepInterviewAbortInput(latestUserInput) || hasAnySubstring(lastMessage, DEEP_INTERVIEW_ABORT_PATTERNS)) {
    return 'abort';
  }
  if (hasAnySubstring(` ${safeString(lastMessage).toLowerCase()}`, DEEP_INTERVIEW_ERROR_PATTERNS)) {
    return 'error';
  }
  if (skillState.phase === 'completing') {
    return 'success';
  }
  return null;
}

function releaseDeepInterviewInputLock(skillState, reason, nowIso) {
  if (!skillState?.input_lock) return skillState;
  skillState.input_lock = {
    ...skillState.input_lock,
    active: false,
    released_at: nowIso,
    exit_reason: reason,
  };
  skillState.phase = 'completing';
  skillState.active = false;
  skillState.updated_at = nowIso;
  return skillState;
}

export function normalizeSkillActiveState(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const skill = safeString(raw.skill);
  if (!skill) return null;
  return {
    version: asNumber(raw.version) ?? 1,
    active: raw.active !== false,
    skill,
    keyword: safeString(raw.keyword),
    phase: normalizeSkillPhase(raw.phase),
    activated_at: safeString(raw.activated_at),
    updated_at: safeString(raw.updated_at),
    source: safeString(raw.source),
    input_lock: normalizeInputLock(raw.input_lock),
  };
}

export function inferSkillPhaseFromText(text, currentPhase = 'planning') {
  const lower = safeString(text).toLowerCase();
  if (!lower) return normalizeSkillPhase(currentPhase);

  const hasAny = (patterns) => patterns.some((p) => lower.includes(p));

  if (hasAny(['all tests pass', 'build succeeded', 'completed', 'complete', 'done', 'final summary', 'summary'])) {
    return 'completing';
  }
  if (hasAny(['verify', 'verified', 'verification', 'review', 'reviewed', 'diagnostic', 'typecheck', 'test'])) {
    return 'reviewing';
  }
  if (hasAny(['implement', 'implemented', 'apply patch', 'change', 'fix', 'update', 'refactor'])) {
    return 'executing';
  }
  if (hasAny(['plan', 'approach', 'steps', 'todo'])) {
    return 'planning';
  }
  return normalizeSkillPhase(currentPhase);
}

async function loadSkillActiveState(stateDir) {
  const raw = await readJsonIfExists(join(stateDir, SKILL_ACTIVE_STATE_FILE), null);
  return normalizeSkillActiveState(raw);
}

async function persistSkillActiveState(stateDir, state) {
  await writeFile(join(stateDir, SKILL_ACTIVE_STATE_FILE), JSON.stringify(state, null, 2)).catch(() => {});
}

function latestUserInputFromPayload(payload) {
  const inputMessages = payload['input-messages'] || payload.input_messages || [];
  if (!Array.isArray(inputMessages) || inputMessages.length === 0) return '';
  return safeString(inputMessages[inputMessages.length - 1]);
}

export const DEFAULT_STALL_PATTERNS = [
  'if you want',
  'would you like',
  'shall i',
  'next i can',
  'continue with',
  'continue on',
  'do you want me to',
  'let me know if',
  'do you want',
  'want me to',
  'let me know',
  'just let me know',
  'i can also',
  'i could also',
  'pick up with',
  'next step',
  'next steps',
  'ready to proceed',
  'i\'m ready to',
  'keep going',
  'should i',
  'whenever you',
  'say go',
  'say yes',
  'type continue',
  'and i\'ll continue',
  'and i\'ll proceed',
  'keep driving',
  'keep pushing',
  'move forward',
  'drive forward',
  'proceed from here',
  'i\'ll continue from',
];

function normalizeStallDetectionText(text) {
  return safeString(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !line.includes(DEFAULT_MARKER))
    .join('\n')
    .toLowerCase()
    .replace(/[’‘`]/g, '\'');
}

export function normalizeAutoNudgeConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      enabled: true,
      patterns: DEFAULT_STALL_PATTERNS,
      response: 'yes, proceed',
      delaySec: 3,
      maxNudgesPerSession: Infinity,
    };
  }
  return {
    enabled: raw.enabled !== false,
    patterns: Array.isArray(raw.patterns) && raw.patterns.length > 0
      ? raw.patterns.filter(p => typeof p === 'string' && p.trim() !== '')
      : DEFAULT_STALL_PATTERNS,
    response: typeof raw.response === 'string' && raw.response.trim() !== ''
      ? raw.response
      : 'yes, proceed',
    delaySec: typeof raw.delaySec === 'number' && raw.delaySec >= 0 && raw.delaySec <= 60
      ? raw.delaySec
      : 3,
    maxNudgesPerSession: typeof raw.maxNudgesPerSession === 'number' && raw.maxNudgesPerSession > 0
      ? raw.maxNudgesPerSession
      : Infinity,
  };
}

export async function loadAutoNudgeConfig() {
  const codexHomePath = process.env.CODEX_HOME || join(homedir(), '.codex');
  const configPath = join(codexHomePath, '.omx-config.json');
  const raw = await readJsonIfExists(configPath, null);
  if (!raw || typeof raw !== 'object') return normalizeAutoNudgeConfig(null);
  return normalizeAutoNudgeConfig(raw.autoNudge);
}

export function detectStallPattern(text, patterns) {
  if (!text || typeof text !== 'string') return false;
  const normalized = normalizeStallDetectionText(text);
  if (!normalized) return false;
  const tail = normalized.slice(-800);
  const normalizedPatterns = patterns.map((pattern) => normalizeStallDetectionText(pattern)).filter(Boolean);
  const lines = tail.split('\n').filter((line) => line.trim());
  const hotZone = lines.slice(-3).join('\n');
  if (normalizedPatterns.some((pattern) => hotZone.includes(pattern))) return true;
  return normalizedPatterns.some((pattern) => tail.includes(pattern));
}

export async function capturePane(paneId, lines = 10) {
  try {
    const result = await runProcess('tmux', buildCapturePaneArgv(paneId, lines), 3000);
    return result.stdout || '';
  } catch {
    return '';
  }
}

export async function resolveNudgePaneTarget(stateDir) {
  const envPane = safeString(process.env.TMUX_PANE || '');
  if (envPane) return envPane;

  try {
    const scopedDirs = await getScopedStateDirsForCurrentSession(stateDir);
    for (const dir of scopedDirs) {
      const files = await readdir(dir).catch(() => []);
      for (const f of files) {
        if (!f.endsWith('-state.json')) continue;
        const path = join(dir, f);
        try {
          const state = JSON.parse(await readFile(path, 'utf-8'));
          if (state && state.active && state.tmux_pane_id) {
            return safeString(state.tmux_pane_id);
          }
        } catch {
          // skip malformed state
        }
      }
    }
  } catch {
    // Non-critical
  }

  return '';
}

async function emitInjectionMessage(paneId, message) {
  const markedResponse = `${message} ${DEFAULT_MARKER}`;
  await runProcess('tmux', ['send-keys', '-t', paneId, '-l', markedResponse], 3000);
  await new Promise(r => setTimeout(r, 100));
  await runProcess('tmux', ['send-keys', '-t', paneId, 'C-m'], 3000);
  await new Promise(r => setTimeout(r, 100));
  await runProcess('tmux', ['send-keys', '-t', paneId, 'C-m'], 3000);
}

export async function maybeAutoNudge({ cwd, stateDir, logsDir, payload }) {
  const config = await loadAutoNudgeConfig();
  if (!config.enabled) return;

  const lastMessage = safeString(payload['last-assistant-message'] || payload.last_assistant_message || '');
  const latestUserInput = latestUserInputFromPayload(payload);
  let skillState = await loadSkillActiveState(stateDir);
  let releaseReason = null;

  try {
    if (skillState) {
      const inferredPhase = inferSkillPhaseFromText(lastMessage, skillState.phase);
      skillState.phase = inferredPhase;
      skillState.active = inferredPhase !== 'completing';
      skillState.updated_at = new Date().toISOString();
      releaseReason = inferDeepInterviewReleaseReason({ skillState, latestUserInput, lastMessage });
      await persistSkillActiveState(stateDir, skillState);
    }

    const nudgeStatePath = join(stateDir, 'auto-nudge-state.json');
    let nudgeState = await readJsonIfExists(nudgeStatePath, null);
    if (!nudgeState || typeof nudgeState !== 'object') {
      nudgeState = { nudgeCount: 0, lastNudgeAt: '' };
    }
    const nudgeCount = asNumber(nudgeState.nudgeCount) ?? 0;
    if (Number.isFinite(config.maxNudgesPerSession) && nudgeCount >= config.maxNudgesPerSession) return;

    const paneId = await resolveNudgePaneTarget(stateDir);

    let detected = detectStallPattern(lastMessage, config.patterns);
    let source = 'payload';

    if (!detected && paneId) {
      const captured = await capturePane(paneId);
      detected = detectStallPattern(captured, config.patterns);
      source = 'capture-pane';
    }

    if (skillState?.phase === 'completing' && !detected) return;
    if (!detected || !paneId) return;

    const paneGuard = await checkPaneReadyForTeamSendKeys(paneId);
    if (!paneGuard.ok) {
      await logTmuxHookEvent(logsDir, {
        timestamp: new Date().toISOString(),
        type: 'auto_nudge_skipped',
        pane_id: paneId,
        reason: paneGuard.reason,
        source,
      }).catch(() => {});
      return;
    }

    const deepInterviewLockActive = isDeepInterviewAutoApprovalLocked(skillState) && !releaseReason;
    if (deepInterviewLockActive && isBlockedAutoApprovalInput(config.response, skillState.input_lock?.blocked_inputs)) {
      const blockedMessage = skillState.input_lock?.message || DEEP_INTERVIEW_INPUT_LOCK_MESSAGE;
      await emitInjectionMessage(paneId, blockedMessage);
      await logTmuxHookEvent(logsDir, {
        timestamp: new Date().toISOString(),
        type: 'auto_nudge_blocked',
        pane_id: paneId,
        response: config.response,
        source,
        blocked_by: 'deep-interview-lock',
        message: blockedMessage,
      }).catch(() => {});
      return;
    }

    if (config.delaySec > 0) {
      await new Promise(r => setTimeout(r, config.delaySec * 1000));
    }

    const nowIso = new Date().toISOString();
    try {
      await emitInjectionMessage(paneId, config.response);

      nudgeState.nudgeCount = nudgeCount + 1;
      nudgeState.lastNudgeAt = nowIso;
      await writeFile(nudgeStatePath, JSON.stringify(nudgeState, null, 2)).catch(() => {});

      if (skillState && skillState.phase === 'planning') {
        skillState.phase = 'executing';
        skillState.active = true;
        skillState.updated_at = nowIso;
        await persistSkillActiveState(stateDir, skillState);
      }

      await logTmuxHookEvent(logsDir, {
        timestamp: nowIso,
        type: 'auto_nudge',
        pane_id: paneId,
        response: config.response,
        source,
        nudge_count: nudgeState.nudgeCount,
      });
    } catch (err) {
      await logTmuxHookEvent(logsDir, {
        timestamp: nowIso,
        type: 'auto_nudge',
        pane_id: paneId,
        error: err instanceof Error ? err.message : safeString(err),
      }).catch(() => {});
    }
  } finally {
    if (releaseReason && skillState && isDeepInterviewAutoApprovalLocked(skillState)) {
      releaseDeepInterviewInputLock(skillState, releaseReason, new Date().toISOString());
      await persistSkillActiveState(stateDir, skillState).catch(() => {});
    }
  }
}
