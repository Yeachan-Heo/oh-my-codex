// @ts-nocheck
/**
 * Auto-nudge: detect Codex "asking for permission" stall patterns and
 * automatically send a continuation prompt so the agent keeps working.
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { asNumber, safeString } from './utils.js';
import {
  getScopedStateDirsForCurrentSession,
  getScopedStatePath,
  readJsonIfExists,
  readScopedJsonIfExists,
  readdir,
  writeScopedJson,
} from './state-io.js';
import { runProcess } from './process-runner.js';
import { logTmuxHookEvent } from './log.js';
import { evaluatePaneInjectionReadiness, mapPaneInjectionReadinessReason, sendPaneInput } from './team-tmux-guard.js';
import { stripOrchestrationIntentTags } from './orchestration-intent.js';
import { buildCapturePaneArgv, DEFAULT_MARKER, tmuxHookExplicitlyDisablesInjection } from '../tmux-hook-engine.js';
import { readAutoresearchCompletionStatus } from '../../autoresearch/skill-validation.js';
import { persistDeepInterviewModeState } from '../../hooks/keyword-detector.js';
import {
  isManagedOmxSession,
  isManagedOmxSessionAtPromptContext,
  resolveManagedCurrentPane,
  resolveManagedCurrentPaneAtPromptContext,
  resolveManagedPaneFromAnchor,
  resolveManagedPaneFromAnchorAtPromptContext,
  resolveManagedSessionPane,
  resolveManagedSessionPaneAtPromptContext,
  resolveInvocationSessionId,
  verifyManagedPaneTarget,
} from './managed-tmux.js';
import type { PromptMutationAuthorization, ResolvedPromptTurnContext } from '../../hooks/prompt-session-provenance.js';

export const SKILL_ACTIVE_STATE_FILE = 'skill-active-state.json';
export const DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS = ['yes', 'y', 'proceed', 'continue', 'ok', 'sure', 'go ahead', 'next i should'];
export const DEEP_INTERVIEW_INPUT_LOCK_MESSAGE = 'Deep interview is active; auto-approval shortcuts are blocked until the interview finishes.';
export const DEFAULT_AUTO_NUDGE_RESPONSE = 'continue with the current task only if it is already authorized';
const DEEP_INTERVIEW_ERROR_PATTERNS = [' error', ' failed', ' failure', ' exception', 'unable to continue', 'cannot continue', 'could not continue'];
const DEEP_INTERVIEW_ABORT_PATTERNS = ['aborted', 'cancelled', 'canceled'];
const DEEP_INTERVIEW_SUCCESS_PATTERNS = ['interview completed', 'interview complete', 'interview finished', 'final summary ready'];
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

function buildBlockedAutoApprovalMatcher(blockedInputs) {
  const normalizedBlockedInputs = blockedInputs.map((entry) => normalizeBlockedAutoApprovalInput(entry)).filter(Boolean);
  return {
    exactMatches: new Set(normalizedBlockedInputs),
    prefixedMatches: normalizedBlockedInputs.filter((entry) => DEEP_INTERVIEW_BLOCKED_APPROVAL_PREFIXES.has(entry)),
    blockedTokenSet: new Set(normalizedBlockedInputs.flatMap((entry) => entry.split(/\s+/).filter(Boolean))),
  };
}

export function isBlockedAutoApprovalInput(text, blockedInputs = DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS) {
  const normalized = normalizeBlockedAutoApprovalInput(text);
  if (!normalized) return false;
  const { exactMatches, prefixedMatches, blockedTokenSet } = buildBlockedAutoApprovalMatcher(blockedInputs);
  if (exactMatches.has(normalized)) return true;
  if (prefixedMatches.some((prefix) => normalized.startsWith(`${prefix} `))) return true;

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((token) => blockedTokenSet.has(token));
}

function isDeepInterviewAbortInput(text) {
  return DEEP_INTERVIEW_ABORT_INPUTS.has(normalizeBlockedAutoApprovalInput(text));
}

function hasAnySubstring(text, patterns) {
  const lower = safeString(text).toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern));
}

function looksLikeDeepInterviewSuccess(text) {
  return hasAnySubstring(text, DEEP_INTERVIEW_SUCCESS_PATTERNS);
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
    owner_codex_session_id: safeString(raw.owner_codex_session_id),
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

async function loadSkillActiveState(stateDir, sessionId) {
  const raw = await readScopedJsonIfExists(stateDir, SKILL_ACTIVE_STATE_FILE, sessionId, null);
  return normalizeSkillActiveState(raw);
}

async function persistSkillActiveState(stateDir, sessionId, state) {
  await writeScopedJson(stateDir, SKILL_ACTIVE_STATE_FILE, sessionId, state).catch(() => {});
}

function cloneSkillActiveState(state) {
  if (!state || typeof state !== 'object') return null;
  return {
    ...state,
    input_lock: state.input_lock
      ? {
        ...state.input_lock,
        blocked_inputs: Array.isArray(state.input_lock.blocked_inputs)
          ? [...state.input_lock.blocked_inputs]
          : state.input_lock.blocked_inputs,
      }
      : state.input_lock,
  };
}

export async function syncSkillStateFromTurn(stateDir, payload, invocationSessionIdOverride = '', authorization: PromptMutationAuthorization | null = null) {
  const lastMessage = safeString(payload['last-assistant-message'] || payload.last_assistant_message || '');
  const latestUserInput = latestUserInputFromPayload(payload);
  const invocationSessionId = invocationSessionIdOverride || resolveInvocationSessionId(payload);
  let skillState = await loadSkillActiveState(stateDir, invocationSessionId);
  let releaseReason = null;

  if (!skillState) {
    return { invocationSessionId, skillState: null, releaseReason };
  }
  if (authorization) {
    const allowedOwners = Array.isArray(authorization.allowedOwnerCodexSessionIds)
      ? authorization.allowedOwnerCodexSessionIds
      : [];
    const existingOwner = safeString(skillState.owner_codex_session_id).trim();
    if (existingOwner && !allowedOwners.includes(existingOwner)) {
      return { invocationSessionId, skillState: null, releaseReason: 'owner_conflict' };
    }
    if (authorization.ownerCodexSessionId) {
      skillState.owner_codex_session_id = authorization.ownerCodexSessionId;
    }
  }

  const previousSkillState = cloneSkillActiveState(skillState);
  const previousPhase = normalizeSkillPhase(skillState.phase);
  const inferredPhase = inferSkillPhaseFromText(lastMessage, previousPhase);
  const explicitDeepInterviewSuccess = skillState.skill === 'deep-interview' && looksLikeDeepInterviewSuccess(lastMessage);
  const nextPhase = skillState.skill === 'deep-interview'
    && inferredPhase === 'completing'
    && previousPhase !== 'completing'
    && !explicitDeepInterviewSuccess
    ? previousPhase
    : inferredPhase;
  skillState.phase = nextPhase;
  skillState.active = nextPhase !== 'completing';

  if (skillState.skill === 'autoresearch') {
    const completion = await readAutoresearchCompletionStatus(payload.cwd || process.cwd(), invocationSessionId);
    skillState.validation_mode = completion.validationMode;
    skillState.autoresearch_completion_reason = completion.reason;
    skillState.completion_artifact_path = completion.artifactPath;
    if (completion.complete) {
      skillState.phase = 'completing';
      skillState.active = false;
    } else if (inferredPhase === 'completing') {
      skillState.phase = previousPhase === 'completing' ? 'reviewing' : previousPhase;
      skillState.active = true;
    }
  }

  const nowIso = new Date().toISOString();
  skillState.updated_at = nowIso;
  releaseReason = inferDeepInterviewReleaseReason({ skillState, latestUserInput, lastMessage });
  if (releaseReason && isDeepInterviewAutoApprovalLocked(skillState)) {
    releaseDeepInterviewInputLock(skillState, releaseReason, nowIso);
  }
  await persistSkillActiveState(stateDir, invocationSessionId, skillState);

  if (skillState.skill === 'deep-interview' || previousSkillState?.skill === 'deep-interview') {
    await persistDeepInterviewModeState(stateDir, skillState, nowIso, previousSkillState, {
      sessionId: invocationSessionId,
      threadId: safeString(payload?.['thread-id'] || payload?.thread_id || ''),
      turnId: safeString(payload?.['turn-id'] || payload?.turn_id || ''),
    });
  }

  return { invocationSessionId, skillState, releaseReason };
}


export async function isDeepInterviewStateActive(stateDir, sessionId) {
  const modeState = typeof sessionId === 'string' && sessionId.trim()
    ? await readScopedJsonIfExists(stateDir, 'deep-interview-state.json', sessionId, null)
    : await readJsonIfExists(join(stateDir, 'deep-interview-state.json'), null);
  return Boolean(modeState && modeState.active === true);
}

export async function isDeepInterviewInputLockActive(stateDir, sessionId) {
  const skillState = await loadSkillActiveState(stateDir, sessionId);
  return isDeepInterviewAutoApprovalLocked(skillState);
}

export async function resolveAutoNudgeSignature(stateDir, payload, lastMessage = '') {
  const normalizedMessage = normalizeAutoNudgeSignatureText(lastMessage);
  const invocationSessionId = resolveInvocationSessionId(payload);
  const hudState = await readScopedJsonIfExists(stateDir, 'hud-state.json', invocationSessionId, null);
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
  'continue with',
  'continue on',
  'pick up with',
  'keep going',
  'and i\'ll continue',
  'keep driving',
  'keep pushing',
  'move forward',
  'drive forward',
  'i\'ll continue from',
];

const SEMANTIC_STALL_PROMPT_PATTERNS = [
  /\bcontinue (?:with|on)\b/g,
  /\bpick up with\b/g,
  /\bkeep going\b/g,
  /\band i'?ll continue\b/g,
  /\bkeep (?:driving|pushing)\b/g,
  /\bmove forward\b/g,
  /\bdrive forward\b/g,
  /\bi'?ll continue from\b/g,
];

const PLANNING_ONLY_STALL_PATTERNS = [
  'plan',
  'planning',
  'approach',
  'proposal',
  'options',
  'review',
  'feedback',
  'spec',
  'design',
  'next step',
  'next steps',
  'ready to proceed',
];

const PERMISSION_SEEKING_STALL_PATTERNS = [
  'if you want',
  'would you like',
  'shall i',
  'should i',
  'do you want me to',
  'do you want',
  'want me to',
  'let me know if',
  'let me know',
  'just let me know',
  'i can also',
  'i could also',
  'next i can',
  'whenever you',
  'say go',
  'say yes',
  'type continue',
  'proceed from here',
];

function normalizeStallDetectionText(text) {
  return stripOrchestrationIntentTags(safeString(text))
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

function normalizePatternList(patterns) {
  return patterns.map((pattern) => normalizeStallDetectionText(pattern)).filter(Boolean);
}

function usesDefaultStallPatterns(patterns) {
  const normalizedPatterns = normalizePatternList(patterns);
  const normalizedDefaults = normalizePatternList(DEFAULT_STALL_PATTERNS);
  return normalizedPatterns.length === normalizedDefaults.length
    && normalizedPatterns.every((pattern, index) => pattern === normalizedDefaults[index]);
}

function matchesNormalizedPatterns(normalizedText, normalizedPatterns) {
  if (!normalizedText || normalizedPatterns.length === 0) return false;
  const tail = normalizedText.slice(-800);
  const lines = tail.split('\n').filter((line) => line.trim());
  const hotZone = lines.slice(-3).join('\n');
  if (normalizedPatterns.some((pattern) => hotZone.includes(pattern))) return true;
  return normalizedPatterns.some((pattern) => tail.includes(pattern));
}

function looksLikePlanningOnlyContinuation(normalizedText) {
  return matchesNormalizedPatterns(normalizedText, normalizePatternList(PLANNING_ONLY_STALL_PATTERNS));
}

function looksLikePermissionSeekingContinuation(normalizedText) {
  return matchesNormalizedPatterns(normalizedText, normalizePatternList(PERMISSION_SEEKING_STALL_PATTERNS));
}

/**
 * Pattern to identify test-runner output lines (status symbols, PASS/FAIL prefixes).
 * These lines may incidentally contain stall-pattern words inside test names and
 * should be excluded before running stall detection on pane captures.
 */
const CAPTURE_TEST_LINE_RE = /^\s*(?:[✓✗✕×●✔✘▶◆○]|(?:PASS|FAIL|SKIP|ERROR)\s)/u;

/**
 * Strip lines that look like test-runner output so stall patterns inside test
 * names (e.g. "✓ should continue with the next step") do not trigger a nudge.
 */
function filterCapturedTestLines(text) {
  return safeString(text)
    .split('\n')
    .filter((line) => !CAPTURE_TEST_LINE_RE.test(line))
    .join('\n');
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

export function resolveEffectiveAutoNudgeResponse(response) {
  const normalized = safeString(response).trim();
  if (!normalized) return DEFAULT_AUTO_NUDGE_RESPONSE;
  return isBlockedAutoApprovalInput(normalized) ? DEFAULT_AUTO_NUDGE_RESPONSE : normalized;
}

export async function loadAutoNudgeConfig() {
  const codexHomePath = process.env.CODEX_HOME || join(homedir(), '.codex');
  const configPath = join(codexHomePath, '.omx-config.json');
  const raw = await readJsonIfExists(configPath, null);
  if (!raw || typeof raw !== 'object') return normalizeAutoNudgeConfig(null);
  return normalizeAutoNudgeConfig(raw.autoNudge);
}

async function localTmuxInjectionDisabled(cwd) {
  const normalizedCwd = safeString(cwd).trim();
  if (!normalizedCwd) return false;
  const raw = await readJsonIfExists(join(normalizedCwd, '.omx', 'tmux-hook.json'), null);
  return tmuxHookExplicitlyDisablesInjection(raw);
}

function detectStallPatternWithOptions(text, patterns, currentPhase = '', options = {}) {
  if (!text || typeof text !== 'string') return false;
  const normalized = normalizeStallDetectionText(text);
  if (!normalized) return false;
  const normalizedPatterns = normalizePatternList(patterns);
  if (!matchesNormalizedPatterns(normalized, normalizedPatterns)) return false;
  if (!usesDefaultStallPatterns(patterns)) return true;
  if (options.allowPermissionSeeking !== true && looksLikePermissionSeekingContinuation(normalized)) return false;
  if (safeString(currentPhase).trim().toLowerCase() === 'planning') return false;
  return !looksLikePlanningOnlyContinuation(normalized);
}

export function detectStallPattern(text, patterns, currentPhase = '') {
  return detectStallPatternWithOptions(text, patterns, currentPhase);
}

export function detectNativeStopStallPattern(text, patterns, currentPhase = '') {
  return detectStallPatternWithOptions(text, patterns, currentPhase, {
    allowPermissionSeeking: true,
  });
}

export async function capturePane(paneId, lines = 10) {
  try {
    const result = await runProcess('tmux', buildCapturePaneArgv(paneId, lines), 3000);
    return result.stdout || '';
  } catch {
    return '';
  }
}

async function resolveTeamWorkerNudgeBinding(stateDir: string): Promise<{
  paneId: string;
  panePid: number;
  paneOwnerId: string;
  hudPaneId: string;
} | null> {
  const workerContext = safeString(process.env.OMX_TEAM_WORKER || '').trim();
  if (!workerContext) return null;
  const match = /^([A-Za-z0-9][A-Za-z0-9_-]*)\/(worker-[1-9]\d*)$/.exec(workerContext);
  if (!match) return null;
  const [, teamName, workerName] = match;
  const teamDir = join(stateDir, 'team', teamName);
  try {
    const manifestPath = join(teamDir, 'manifest.v2.json');
    const configPath = join(teamDir, 'config.json');
    let raw: any;
    try {
      raw = JSON.parse(await readFile(manifestPath, 'utf-8'));
    } catch {
      raw = JSON.parse(await readFile(configPath, 'utf-8'));
    }
    if (safeString(raw?.name).trim() !== teamName || !Array.isArray(raw?.workers)) return null;
    const worker = raw.workers.find((entry: any) => safeString(entry?.name).trim() === workerName);
    const paneId = safeString(worker?.pane_id).trim();
    const panePid = asNumber(worker?.pid);
    const hudPaneId = safeString(raw?.hud_pane_id).trim();
    const paneOwnerId = typeof raw?.tmux_pane_owner_id === 'string' ? raw.tmux_pane_owner_id.trim() : '';
    if (!/^%\d+$/.test(paneId) || !Number.isInteger(panePid) || panePid <= 0 || !paneOwnerId || paneId === hudPaneId) return null;
    return { paneId, panePid, paneOwnerId, hudPaneId };
  } catch {
    return null;
  }
}

export async function resolveNudgePaneTarget(stateDir: any, cwd = '', payload: any = undefined, context: ResolvedPromptTurnContext | null = null) {
  const allowTeamWorker = safeString(process.env.OMX_TEAM_WORKER || '').trim() !== '';
  const managedCurrentPane = context
    ? await resolveManagedCurrentPaneAtPromptContext(cwd, context)
    : await resolveManagedCurrentPane(cwd, payload, { allowTeamWorker });
  if (managedCurrentPane) return managedCurrentPane;

  const invocationSessionId = context?.status === 'authorized'
    ? context.authorization.targetSessionId
    : resolveInvocationSessionId(payload);
  const scopedDirs = await getScopedStateDirsForCurrentSession(stateDir, invocationSessionId).catch(() => []);
  for (const dir of scopedDirs) {
    const files = await readdir(dir).catch(() => []);
    for (const f of files) {
      if (!f.endsWith('-state.json')) continue;
      const path = join(dir, f);
      try {
        const state = JSON.parse(await readFile(path, 'utf-8'));
        if (!state || !state.active || !state.tmux_pane_id) continue;
        const anchoredPane = safeString(state.tmux_pane_id).trim();
        if (!anchoredPane) continue;
        const managedPane = context
          ? await resolveManagedPaneFromAnchorAtPromptContext(anchoredPane, cwd, context)
          : await resolveManagedPaneFromAnchor(anchoredPane, cwd, payload, { allowTeamWorker });
        if (managedPane) return managedPane;
        if (allowTeamWorker && !context) {
          const verdict = await verifyManagedPaneTarget(anchoredPane, cwd, payload, { allowTeamWorker });
          if (verdict.ok) return anchoredPane;
        }
      } catch {
        // skip malformed state
      }
    }
  }

  return context
    ? await resolveManagedSessionPaneAtPromptContext(cwd, context)
    : await resolveManagedSessionPane(cwd, payload);
}

export async function maybeAutoNudge({ cwd, stateDir, logsDir, payload, context = null, syncResult = null }: { cwd: string; stateDir: string; logsDir: string; payload: any; context?: ResolvedPromptTurnContext | null; syncResult?: any }) {
  const config = await loadAutoNudgeConfig();
  const effectiveResponse = resolveEffectiveAutoNudgeResponse(config.response);
  if (!config.enabled) return;
  if (await localTmuxInjectionDisabled(cwd)) {
    await logTmuxHookEvent(logsDir, {
      timestamp: new Date().toISOString(),
      type: 'auto_nudge_skipped',
      reason: 'tmux_hook_disabled',
    }).catch(() => {});
    return;
  }

  const sourceName = safeString(payload?.source || '');
  const managedSession = context
    ? await isManagedOmxSessionAtPromptContext(cwd, context, { allowTeamWorker: false })
    : await isManagedOmxSession(cwd, payload, { allowTeamWorker: true });
  if (!managedSession) {
    if (sourceName === 'notify-fallback-watcher-stall') return;
    await logTmuxHookEvent(logsDir, {
      timestamp: new Date().toISOString(),
      type: 'auto_nudge_skipped',
      reason: 'unmanaged_session',
    }).catch(() => {});
    return;
  }

  const lastMessage = safeString(payload['last-assistant-message'] || payload.last_assistant_message || '');
  const { invocationSessionId, skillState, releaseReason } = syncResult
    || (context?.status === 'authorized'
      ? { invocationSessionId: context.authorization.targetSessionId, skillState: null, releaseReason: null }
      : await syncSkillStateFromTurn(stateDir, payload));

  try {
    const nudgeStatePath = await getScopedStatePath(stateDir, 'auto-nudge-state.json', invocationSessionId);
    let nudgeState = await readScopedJsonIfExists(stateDir, 'auto-nudge-state.json', invocationSessionId, null);
    if (!nudgeState || typeof nudgeState !== 'object') {
      nudgeState = { nudgeCount: 0, lastNudgeAt: '', lastSignature: '', lastSemanticSignature: '' };
    }
    const teamWorkerBinding = await resolveTeamWorkerNudgeBinding(stateDir);
    if (safeString(process.env.OMX_TEAM_WORKER || '').trim() && !teamWorkerBinding) return;
    const paneId = teamWorkerBinding?.paneId
      ?? await resolveNudgePaneTarget(stateDir, cwd, payload, context);
    const teamPaneOptions = teamWorkerBinding
      ? {
        exactPaneId: teamWorkerBinding.paneId,
        expectedPanePid: teamWorkerBinding.panePid,
        expectedPaneOwnerId: teamWorkerBinding.paneOwnerId,
        expectedHudPaneId: teamWorkerBinding.hudPaneId,
      }
      : { exactPaneId: paneId };

    let detected = detectStallPattern(lastMessage, config.patterns, skillState?.phase);
    let source = 'payload';
    let captured = '';

    if (!detected && paneId) {
      if (teamWorkerBinding) {
        const captureGuard = await evaluatePaneInjectionReadiness(paneId, {
          skipIfScrolling: true,
          ...teamPaneOptions,
        });
        if (!captureGuard.ok) return;
        captured = captureGuard.paneCapture;
      } else {
        captured = await capturePane(paneId);
      }
      detected = detectStallPattern(filterCapturedTestLines(captured), config.patterns, skillState?.phase);
      source = 'capture-pane';
    }

    if (skillState?.phase === 'completing' && !detected) return;
    if (!detected || !paneId) return;

    const signatureSourceText = source === 'capture-pane' ? captured : lastMessage;
    const signature = await resolveAutoNudgeSignature(stateDir, payload, signatureSourceText);
    const semanticSignature = normalizeAutoNudgeSignatureText(signatureSourceText);

    if (signature && safeString(nudgeState.lastSignature) === signature) {
      await logTmuxHookEvent(logsDir, {
        timestamp: new Date().toISOString(),
        type: 'auto_nudge_skipped',
        reason: 'already_nudged_for_signature',
        source,
        signature,
        semantic_signature: semanticSignature,
      }).catch(() => {});
      return;
    }

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

    const isFallbackWatcherSource = sourceName === 'notify-fallback-watcher-stall';
    if (!isFallbackWatcherSource && config.stallMs > 0) {
      nudgeState.pendingSignature = signature;
      nudgeState.pendingSince = new Date().toISOString();
      await mkdir(dirname(nudgeStatePath), { recursive: true }).catch(() => {});
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

    const paneGuard = await evaluatePaneInjectionReadiness(paneId, { skipIfScrolling: true, ...teamPaneOptions });
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
    const readinessPanePid = asNumber(paneGuard.exactPaneProof?.pid);
    if (!Number.isInteger(readinessPanePid) || readinessPanePid <= 0) {
      await logTmuxHookEvent(logsDir, {
        timestamp: new Date().toISOString(),
        type: 'auto_nudge_skipped',
        pane_id: paneId,
        reason: 'pane_readiness_unverified',
        source,
      }).catch(() => {});
      return;
    }
    const pinnedPaneOptions = { ...teamPaneOptions, expectedPanePid: readinessPanePid };

    const blockedAutoApproval = isDeepInterviewAutoApprovalLocked(skillState)
      && !releaseReason
      && isBlockedAutoApprovalInput(effectiveResponse, skillState.input_lock?.blocked_inputs);
    if (blockedAutoApproval) {
      const blockedMessage = skillState.input_lock?.message || DEEP_INTERVIEW_INPUT_LOCK_MESSAGE;
      await logTmuxHookEvent(logsDir, {
        timestamp: new Date().toISOString(),
        type: 'auto_nudge_blocked',
        pane_id: paneId,
        response: effectiveResponse,
        source,
        blocked_by: 'deep-interview-lock',
        block_kind: 'blocked-auto-approval',
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
        exactPaneId: paneId,
        ...pinnedPaneOptions,
        prompt: `${effectiveResponse} ${DEFAULT_MARKER}`,
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
      await mkdir(dirname(nudgeStatePath), { recursive: true }).catch(() => {});
      await writeFile(nudgeStatePath, JSON.stringify(nudgeState, null, 2)).catch(() => {});

      await logTmuxHookEvent(logsDir, {
        timestamp: nowIso,
        type: 'auto_nudge',
        pane_id: paneId,
        response: effectiveResponse,
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
      await persistSkillActiveState(stateDir, invocationSessionId, skillState).catch(() => {});
    }
  }
}
