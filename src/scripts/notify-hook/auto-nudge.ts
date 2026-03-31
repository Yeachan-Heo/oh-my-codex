// @ts-nocheck
/**
 * Auto-nudge: detect Codex "asking for permission" stall patterns and
 * automatically send a continuation prompt so the agent keeps working.
 */

import { readFile, writeFile } from 'fs/promises';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { asNumber, safeString } from './utils.js';
import { readJsonIfExists, getScopedStateDirsForCurrentSession, readdir } from './state-io.js';
import { runProcess } from './process-runner.js';
import { logTmuxHookEvent } from './log.js';
import { evaluatePaneInjectionReadiness, mapPaneInjectionReadinessReason, sendPaneInput } from './team-tmux-guard.js';
import { buildCapturePaneArgv, DEFAULT_MARKER } from '../tmux-hook-engine.js';

export const SKILL_ACTIVE_STATE_FILE = 'skill-active-state.json';
export const DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS = ['yes', 'y', 'proceed', 'continue', 'ok', 'sure', 'go ahead', 'next i should'];
export const DEEP_INTERVIEW_INPUT_LOCK_MESSAGE = 'Deep interview is active; auto-approval shortcuts are blocked until the interview finishes.';
const DEEP_INTERVIEW_ERROR_PATTERNS = [' error', ' failed', ' failure', ' exception', 'unable to continue', 'cannot continue', 'could not continue'];
const DEEP_INTERVIEW_ABORT_PATTERNS = ['aborted', 'cancelled', 'canceled'];
const DEEP_INTERVIEW_ABORT_INPUTS = new Set(['abort', 'cancel', 'stop']);
const DEEP_INTERVIEW_BLOCKED_APPROVAL_PREFIXES = new Set(['next i should']);
const SKILL_PHASES = new Set(['planning', 'executing', 'reviewing', 'completing']);
const DEFAULT_AUTO_NUDGE_TTL_MS = 30_000;

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


export async function isDeepInterviewStateActive(stateDir) {
  const modeState = await readJsonIfExists(join(stateDir, 'deep-interview-state.json'), null);
  return Boolean(modeState && modeState.active === true);
}

export async function resolveAutoNudgeSignature(stateDir, payload, lastMessage = '') {
  const normalizedMessage = normalizeAutoNudgeSignatureText(lastMessage);
  const hudState = await readJsonIfExists(join(stateDir, 'hud-state.json'), null);
  const hudTurnAt = safeString(hudState?.last_turn_at).trim();
  const hudTurnCount = Number.isFinite(hudState?.turn_count) ? hudState.turn_count : null;
  const hudMessage = normalizeAutoNudgeSignatureText(hudState?.last_agent_output || hudState?.last_agent_message || '');

  if (normalizedMessage && hudTurnAt && hudTurnCount !== null && hudMessage === normalizedMessage) {
    return `hud:${hudTurnCount}|${hudTurnAt}|${normalizedMessage}`;
  }

  const threadId = safeString(payload?.['thread-id'] || payload?.thread_id).trim();
  const turnId = safeString(payload?.['turn-id'] || payload?.turn_id).trim();
  if (normalizedMessage && (threadId || turnId)) {
    return `payload:${threadId}|${turnId}|${normalizedMessage}`;
  }

  return normalizedMessage ? `message:${normalizedMessage}` : '';
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

const SEMANTIC_STALL_PROMPT_PATTERNS = [
  /\bif you want\b/g,
  /\bwould you like\b/g,
  /\bshall i\b/g,
  /\bshould i\b/g,
  /\bdo you want(?: me)? to\b/g,
  /\bwant me to\b/g,
  /\blet me know(?: if)?\b/g,
  /\bjust let me know\b/g,
  /\bi can also\b/g,
  /\bi could also\b/g,
  /\bnext i can\b/g,
  /\bcontinue (?:with|on)\b/g,
  /\bpick up with\b/g,
  /\bnext steps?\b/g,
  /\bready to proceed\b/g,
  /\bi'?m ready to\b/g,
  /\bkeep going\b/g,
  /\bwhenever you\b/g,
  /\bsay (?:go|yes)\b/g,
  /\btype continue\b/g,
  /\band i'?ll (?:continue|proceed)\b/g,
  /\bkeep (?:driving|pushing)\b/g,
  /\bmove forward\b/g,
  /\bdrive forward\b/g,
  /\bproceed from here\b/g,
  /\bi'?ll continue from\b/g,
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

export function normalizeAutoNudgeSignatureText(text) {
  const normalized = normalizeStallDetectionText(text)
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return '';

  if (detectStallPattern(normalized, DEFAULT_STALL_PATTERNS)) {
    let semantic = normalized;
    for (const pattern of SEMANTIC_STALL_PROMPT_PATTERNS) {
      semantic = semantic.replace(pattern, ' proceed_intent ');
    }
    semantic = semantic
      .replace(/\b(?:please|just|simply|the|a|an|this|that|these|those|for|from|here|there|now|then|when|you|me|i|can|could|will|would|should|shall|to|with|on|if|also|know)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return semantic.includes('proceed_intent') ? 'stall:proceed_intent' : `stall:${semantic || 'detected'}`;
  }

  return normalized;
}

function summarizePaneCaptureForLog(captured, maxLines = 6) {
  const lines = safeString(captured)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
  if (lines.length === 0) return '';
  return lines.slice(-maxLines).join('\n').slice(0, 600);
}

export function normalizeAutoNudgeConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      enabled: true,
      patterns: DEFAULT_STALL_PATTERNS,
      response: 'yes, proceed',
      delaySec: 3,
      stallMs: 5000,
      ttlMs: DEFAULT_AUTO_NUDGE_TTL_MS,
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
    stallMs: typeof raw.stallMs === 'number' && raw.stallMs >= 0 && raw.stallMs <= 60_000
      ? raw.stallMs
      : 5000,
    ttlMs: typeof raw.ttlMs === 'number' && raw.ttlMs >= 0 && raw.ttlMs <= 10 * 60_000
      ? raw.ttlMs
      : (typeof raw.cooldownMs === 'number' && raw.cooldownMs >= 0 && raw.cooldownMs <= 10 * 60_000
        ? raw.cooldownMs
        : DEFAULT_AUTO_NUDGE_TTL_MS),
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

function resolveCodexPaneByCwdFallback(cwd) {
  const normalizedCwd = safeString(cwd).trim();
  if (!normalizedCwd) return '';

  try {
    const panes = execFileSync('tmux', [
      'list-panes', '-a', '-F', '#{pane_id}	#{pane_current_path}	#{pane_current_command}	#{pane_start_command}',
    ], { encoding: 'utf-8', timeout: 2000 })
      .trim()
      .split('\n')
      .filter(Boolean);

    for (const line of panes) {
      const [paneId, panePath = '', paneCommand = '', startCommand = ''] = line.split('\t');
      const normalizedPanePath = safeString(panePath).trim();
      const normalizedStart = safeString(startCommand).toLowerCase();
      const normalizedCommand = safeString(paneCommand).trim().toLowerCase();
      if (!paneId || normalizedPanePath !== normalizedCwd) continue;
      if (/\bomx\b.*\bhud\b.*--watch/i.test(normalizedStart)) continue;
      if (normalizedStart.includes('codex')) return paneId;
      if (normalizedCommand === 'codex' || normalizedCommand === 'node' || normalizedCommand === 'npx') return paneId;
    }
  } catch {
    // Fall back to empty when tmux scan is unavailable.
  }

  return '';
}

async function resolveCodexPaneFromAnchor(anchorPane) {
  const paneId = safeString(anchorPane).trim();
  if (!paneId) return '';

  try {
    const sessionResult = await runProcess('tmux', ['display-message', '-t', paneId, '-p', '#S'], 2000);
    const sessionName = safeString(sessionResult.stdout).trim();
    if (!sessionName) return '';

    const panesResult = await runProcess(
      'tmux',
      ['list-panes', '-s', '-t', sessionName, '-F', '#{pane_id}\t#{pane_current_command}\t#{pane_start_command}'],
      2000,
    );
    const panes = safeString(panesResult.stdout).trim().split('\n').filter(Boolean);
    for (const line of panes) {
      const [candidatePaneId, , rawStartCommand = ''] = line.split('\t');
      const startCommand = safeString(rawStartCommand).toLowerCase();
      if (!candidatePaneId) continue;
      if (/\bomx\b.*\bhud\b.*--watch/i.test(startCommand)) continue;
      if (startCommand.includes('codex')) return candidatePaneId;
    }
  } catch {
    // Fall back to the anchored pane when session scanning is unavailable.
  }

  return '';
}

export async function resolveNudgePaneTarget(stateDir: any, cwd = '') {
  // Use canonical codex pane resolver — validates pane is running an agent, not a shell
  const { resolveCodexPane } = await import('../tmux-hook-engine.js');
  const codexPane = resolveCodexPane();
  if (codexPane) return codexPane;

  let fallbackPane = '';

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
            const anchoredPane = safeString(state.tmux_pane_id).trim();
            if (!anchoredPane) continue;
            const upgradedPane = await resolveCodexPaneFromAnchor(anchoredPane);
            if (upgradedPane) return upgradedPane;
            if (!fallbackPane) fallbackPane = anchoredPane;
          }
        } catch {
          // skip malformed state
        }
      }
    }
  } catch {
    // Non-critical
  }

  if (fallbackPane) return fallbackPane;

  return resolveCodexPaneByCwdFallback(cwd);
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
      nudgeState = { nudgeCount: 0, lastNudgeAt: '', lastSignature: '', lastSemanticSignature: '' };
    }
    const paneId = await resolveNudgePaneTarget(stateDir, cwd);

    let detected = detectStallPattern(lastMessage, config.patterns);
    let source = 'payload';
    let captured = '';

    if (!detected && paneId) {
      captured = await capturePane(paneId);
      detected = detectStallPattern(captured, config.patterns);
      source = 'capture-pane';
    }

    if (skillState?.phase === 'completing' && !detected) return;
    if (!detected || !paneId) return;

    const signatureSourceText = source === 'capture-pane' ? captured : lastMessage;
    const signature = await resolveAutoNudgeSignature(stateDir, payload, signatureSourceText);
    const semanticSignature = normalizeAutoNudgeSignatureText(signatureSourceText);

    const lastNudgeAtMs = Date.parse(safeString(nudgeState.lastNudgeAt));
    if (
      semanticSignature
      && safeString(nudgeState.lastSemanticSignature) === semanticSignature
      && config.ttlMs > 0
      && Number.isFinite(lastNudgeAtMs)
      && (Date.now() - lastNudgeAtMs) < config.ttlMs
    ) {
      await logTmuxHookEvent(logsDir, {
        timestamp: new Date().toISOString(),
        type: 'auto_nudge_skipped',
        reason: 'ttl_active',
        source,
        ttl_ms: config.ttlMs,
        signature,
        semantic_signature: semanticSignature,
      }).catch(() => {});
      return;
    }

    const sourceName = safeString(payload?.source || '');
    const isFallbackWatcherSource = sourceName === 'notify-fallback-watcher-stall';
    if (!isFallbackWatcherSource && config.stallMs > 0) {
      nudgeState.pendingSignature = signature;
      nudgeState.pendingSince = new Date().toISOString();
      await writeFile(nudgeStatePath, JSON.stringify(nudgeState, null, 2)).catch(() => {});
      await logTmuxHookEvent(logsDir, {
        timestamp: new Date().toISOString(),
        type: 'auto_nudge_skipped',
        reason: 'stall_window_pending',
        source,
        stall_ms: config.stallMs,
        signature,
      }).catch(() => {});
      return;
    }

    const paneGuard = await evaluatePaneInjectionReadiness(paneId, { skipIfScrolling: true });
    if (!paneGuard.ok) {
      await logTmuxHookEvent(logsDir, {
        timestamp: new Date().toISOString(),
        type: 'auto_nudge_skipped',
        pane_id: paneId,
        reason: mapPaneInjectionReadinessReason(paneGuard.reason),
        source,
        pane_current_command: paneGuard.paneCurrentCommand || undefined,
        pane_excerpt: summarizePaneCaptureForLog(paneGuard.paneCapture),
      }).catch(() => {});
      return;
    }

    const deepInterviewLockActive = isDeepInterviewAutoApprovalLocked(skillState) && !releaseReason;
    if (deepInterviewLockActive && isBlockedAutoApprovalInput(config.response, skillState.input_lock?.blocked_inputs)) {
      const blockedMessage = skillState.input_lock?.message || DEEP_INTERVIEW_INPUT_LOCK_MESSAGE;
      await logTmuxHookEvent(logsDir, {
        timestamp: new Date().toISOString(),
        type: 'auto_nudge_blocked',
        pane_id: paneId,
        response: config.response,
        source,
        blocked_by: 'deep-interview-lock',
        message: blockedMessage,
        suppressed: true,
      }).catch(() => {});
      return;
    }

    if (config.delaySec > 0) {
      await new Promise(r => setTimeout(r, config.delaySec * 1000));
    }

    const nowIso = new Date().toISOString();
    try {
      const sendResult = await sendPaneInput({
        paneTarget: paneId,
        prompt: `${config.response} ${DEFAULT_MARKER}`,
        submitKeyPresses: 2,
        submitDelayMs: 100,
      });
      if (!sendResult.ok) {
        throw new Error(sendResult.error || sendResult.reason);
      }

      nudgeState.nudgeCount = (asNumber(nudgeState.nudgeCount) ?? 0) + 1;
      nudgeState.lastNudgeAt = nowIso;
      nudgeState.lastSignature = signature;
      nudgeState.lastSemanticSignature = semanticSignature;
      nudgeState.pendingSignature = '';
      nudgeState.pendingSince = '';
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
