import { execFileSync } from "child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "fs";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import { extname, join, relative, resolve } from "path";
import { pathToFileURL } from "url";
import { readModeStateForActiveDecision, readModeStateForSession, updateModeState } from "../modes/base.js";
import { redactAuthSecrets } from "../auth/redact.js";
import {
  SKILL_ACTIVE_STATE_FILE,
  extractSessionIdFromInitializedStatePath,
  getSkillActiveStatePathsForStateDir,
  listActiveSkills,
  readSkillActiveState,
  readVisibleSkillActiveStateForStateDir,
  type SkillActiveStateLike,
  type SkillActiveEntry,
} from "../state/skill-active.js";
import {
  isTrustedSubagentThread,
  readSubagentSessionSummary,
  readSubagentTrackingState,
  recordSubagentTurnForSession,
} from "../subagents/tracker.js";
import { resolveCanonicalTeamStateRoot, resolveWorkerNotifyTeamStateRootPath } from "../team/state-root.js";
import { inferTerminalLifecycleOutcome } from "../runtime/run-outcome.js";
import {
  appendToLog,
  isSessionStale,
  isSessionStateUsable,
  readSessionState,
  readUsableSessionState,
  reconcileNativeSessionStart,
  type SessionState,
} from "../hooks/session.js";
import {
  appendTeamEvent,
  readTeamLeaderAttention,
  readTeamConfig,
  readTeamManifestV2,
  readTeamPhase,
  writeTeamLeaderAttention,
  writeTeamPhase,
} from "../team/state.js";
import { omxNotepadPath, resolveProjectMemoryPath } from "../utils/paths.js";
import { findGitLayout } from "../utils/git-layout.js";
import { getBaseStateDir, getStateFilePath, getStatePath, getAuthoritativeActiveStatePaths } from "../mcp/state-paths.js";
import {
  detectKeywords,
  detectPrimaryKeyword,
  recordSkillActivation,
  type SkillActiveState,
} from "../hooks/keyword-detector.js";
import { buildDeepInterviewConfigInstruction } from "../hooks/deep-interview-config-instruction.js";
import { readTeamModeConfig } from "../config/team-mode.js";
import {
  detectNativeStopStallPattern,
  loadAutoNudgeConfig,
  normalizeAutoNudgeSignatureText,
  resolveEffectiveAutoNudgeResponse,
} from "./notify-hook/auto-nudge.js";
import {
  SLOPPY_FALLBACK_GROUNDING_PATTERNS,
  SLOPPY_FALLBACK_IMPLEMENTATION_CONTEXT_PATTERNS,
  SLOPPY_FALLBACK_PHRASE_PATTERNS,
  buildNativePostToolUseOutput,
  buildNativePreToolUseOutput,
  commandInvokesApplyPatch,
  detectMcpTransportFailure,
  hasAnyPattern,
} from "./codex-native-pre-post.js";
import { handleTeamWorkerPostToolUseSuccess } from "./notify-hook/team-worker-posttooluse.js";
import { maybeNudgeLeaderForAllowedWorkerStop } from "./notify-hook/team-worker-stop.js";
import {
  resolveCodexExecutionSurface,
  type CodexLauncherKind,
  type CodexTransportKind,
} from "./codex-execution-surface.js";
import {
  buildNativeHookEvent,
} from "../hooks/extensibility/events.js";
import type { HookEventEnvelope } from "../hooks/extensibility/types.js";
import { isTrackedWorkflowMode } from "../state/workflow-transition.js";
import { dispatchHookEventRuntime } from "../hooks/extensibility/runtime.js";
import { getNotificationConfig, getVerbosity } from "../notifications/config.js";
import { reconcileHudForPromptSubmit } from "../hud/reconcile.js";
import {
  onPreCompact as buildWikiPreCompactContext,
  onSessionStart as buildWikiSessionStartContext,
} from "../wiki/lifecycle.js";
import { readAutoresearchCompletionStatus, readAutoresearchModeStateForActiveDecision } from "../autoresearch/skill-validation.js";
import { normalizeAutopilotPhase } from "../autopilot/fsm.js";
import { readRunState } from "../runtime/run-state.js";
import { evaluateRalphCompletionAuditEvidence, isRalphCompletePhase } from "../ralph/completion-audit.js";
import {
  buildCodexGoalTerminalCleanupNotice,
} from "../goal-workflows/codex-goal-snapshot.js";
import { getRunContinuationSnapshot, shouldContinueRun } from "../runtime/run-loop.js";
import {
  parseUltragoalSteeringDirective,
  steerUltragoal,
  type UltragoalSteeringProposal,
} from "../ultragoal/artifacts.js";
import { triagePrompt } from "../hooks/triage-heuristic.js";
import { readTriageConfig } from "../hooks/triage-config.js";
import {
  readTriageState,
  writeTriageState,
  shouldSuppressFollowup,
  promptSignature,
  type TriageStateFile,
} from "../hooks/triage-state.js";
import {
  isPendingDeepInterviewQuestionEnforcement,
  reconcileDeepInterviewQuestionEnforcementFromAnsweredRecords,
} from "../question/deep-interview.js";
import { readAutopilotDeepInterviewQuestionWaitState } from "../question/autopilot-wait.js";
import {
  buildDocumentRefreshAdvisoryOutput,
  evaluateFinalHandoffDocumentRefresh,
  isFinalHandoffDocumentRefreshCandidate,
} from "../document-refresh/enforcer.js";
import { buildExecFollowupStopOutput } from "../exec/followup.js";
import {
  MAX_NATIVE_STDIN_JSON_BYTES,
  extractRawCodexHookEventName,
} from "./hook-payload-guard.js";

type CodexHookEventName =
  | "SessionStart"
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "PreCompact"
  | "PostCompact"
  | "Stop";

type CodexHookPayload = Record<string, unknown>;

interface NativeHookDispatchOptions {
  cwd?: string;
  sessionOwnerPid?: number;
  reconcileHudForPromptSubmitFn?: typeof reconcileHudForPromptSubmit;
}

export interface NativeHookDispatchResult {
  hookEventName: CodexHookEventName | null;
  omxEventName: string | null;
  skillState: SkillActiveState | null;
  outputJson: Record<string, unknown> | null;
}

const TERMINAL_MODE_PHASES = new Set(["complete", "completed", "failed", "cancelled"]);
const SKILL_STOP_BLOCKERS = new Set(["ralplan"]);
const TEAM_STOP_BLOCKING_TASK_STATUSES = new Set(["pending", "in_progress", "blocked"]);
const TEAM_WORKER_TERMINAL_RUN_STATES = new Set(["done", "complete", "completed", "failed", "stopped", "cancelled"]);
const NATIVE_STOP_STATE_FILE = "native-stop-state.json";
const NATIVE_SUBAGENT_CAPACITY_BLOCKER_FILE = "native-subagent-capacity-blocker.json";
const NATIVE_SUBAGENT_CAPACITY_BLOCKER_TTL_MS = 30 * 60_000;
const ORDINARY_STOP_NO_PROGRESS_DEFAULT_MAX_REPEATS = 8;
const RALPH_ORPHANED_STARTING_STALE_MS = 15 * 60_000;
const ORDINARY_STOP_NO_PROGRESS_DEFAULT_IDLE_MS = 10 * 60_000;
const ORDINARY_STOP_NO_PROGRESS_MAX_MESSAGE_LENGTH = 240;
const OMX_OWNER_SESSION_ID_PATTERN = /^omx-[A-Za-z0-9_-]{1,60}$/;
const STABLE_FINAL_RECOMMENDATION_PATTERNS = [
  /^\s*(?:launch|release|ship)-?ready\s*:\s*(?:yes|no)\b[^\n\r]*/im,
  /^\s*ready to release\s*:\s*(?:yes|no)\b[^\n\r]*/im,
  /^\s*(?:final\s+)?recommendation\s*:\s*(?:yes|no|ship|hold|release|do not release|proceed|do not proceed)\b[^\n\r]*/im,
  /^\s*decision\s*:\s*(?:yes|no|ship|hold|release|do not release|proceed|do not proceed)\b[^\n\r]*/im,
] as const;
const RELEASE_READINESS_FINALIZE_SYSTEM_MESSAGE =
  "OMX release-readiness detected a stable final recommendation with no active worker tasks; emit one concise final decision summary and finalize.";
const EXECUTION_HANDOFF_PATTERNS = [
  /^(?:好|好的|行|可以|那就|那现在)?[，,\s]*(?:开始|继续|直接)\s*(?:执行|优化|实现|修改|修复)(?=$|\s|[，,。.!！?？])/u,
  /(?:按照|按|基于)(?:这个|上述|当前)?\s*(?:plan|计划|方案).{0,16}(?:开始|继续|直接)?\s*(?:执行|优化|实现|修改|修复)/u,
  /(?:不用|别|不要).{0,6}讨论/u,
  /\b(?:start|begin|go ahead(?: and)?|proceed(?: now)?)\s+(?:to\s+)?(?:implement|execute|apply|fix)\b/i,
  /\b(?:according to|based on)\s+(?:the|this|that)\s+plan\b.{0,20}\b(?:start|begin|proceed(?: now)?|go ahead(?: and)?)\b/i,
] as const;
const SHORT_FOLLOWUP_PRIORITY_PATTERNS = [
  /^(?:继续|接着|然后|那就|那现在|还有(?:一个)?问题|这些优化都做了么|这些都做了么|现在呢|本轮|当前轮|这一轮)/u,
  /(?:按照|按|基于)(?:这个|上述|当前)?(?:plan|计划|方案)/u,
  /\b(?:follow up|latest request|this turn|current turn|newest request)\b/i,
] as const;
const RALPH_CONTINUATION_INTENT_PATTERNS = [
  /\b(?:continue|resume|keep going|carry on|proceed|finish|complete)\b/i,
  /\b(?:same|current|active|that|this)\s+(?:ralph|task|work|job|workflow)\b/i,
  /\b(?:ralph)\b.{0,40}\b(?:continue|resume|finish|complete)\b/i,
  /\b(?:continue|resume|finish|complete)\b.{0,40}\b(?:ralph)\b/i,
] as const;
const RALPH_LIVE_RISK_PATTERNS = [
  /\b(?:prod|production|live|customer|user\s+data|billing|payment|credential|secret|token|key)\b/i,
  /\b(?:deploy|release|publish|merge|push|delete|remove|drop|destroy|migrate|migration)\b/i,
  /\b(?:database|db|terraform|kubectl|kubernetes|aws|gcp|azure|external|destructive)\b/i,
  /\b(?:telegram|vps|service|restart|send|notify|notification|notifications|cron)\b/i,
] as const;
const RALPH_TASK_TEXT_FIELDS = [
  "task_description",
  "taskDescription",
  "objective",
  "task",
  "prompt",
  "initial_prompt",
  "initialPrompt",
  "user_prompt",
  "userPrompt",
  "last_user_message",
  "lastUserMessage",
  "task_slug",
] as const;
const RALPH_INTENT_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it",
  "of", "on", "or", "that", "the", "this", "to", "with", "you", "your", "task", "work",
  "ralph", "continue", "resume", "finish", "complete", "fix", "issue",
]);
const MAX_SESSION_META_LINE_BYTES = 256 * 1024;

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function resolveHudReconcileSessionId(
  currentSessionState: SessionState | null,
  canonicalSessionId: string | null,
  sessionIdForState: string | null,
): string | undefined {
  const ownerOmxSessionId = safeString(currentSessionState?.owner_omx_session_id).trim();
  if (OMX_OWNER_SESSION_ID_PATTERN.test(ownerOmxSessionId)) return ownerOmxSessionId;
  return canonicalSessionId || sessionIdForState || undefined;
}

function resolveHudReconcileSessionIds(
  currentSessionState: SessionState | null,
  canonicalSessionId: string | null,
  sessionIdForState: string | null,
  nativeSessionId: string | null,
): string[] {
  const ownerOmxSessionId = safeString(currentSessionState?.owner_omx_session_id).trim();
  return uniqueNonEmpty([
    resolveHudReconcileSessionId(currentSessionState, canonicalSessionId, sessionIdForState),
    canonicalSessionId ?? undefined,
    sessionIdForState ?? undefined,
    nativeSessionId ?? undefined,
    safeString(currentSessionState?.session_id),
    safeString(currentSessionState?.native_session_id),
    OMX_OWNER_SESSION_ID_PATTERN.test(ownerOmxSessionId) ? ownerOmxSessionId : undefined,
    safeString(currentSessionState?.owner_codex_session_id),
  ]);
}

function safeContextSnippet(value: unknown, maxLength = 300): string {
  const text = safeString(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

const SIDE_CONVERSATION_BOUNDARY_PATTERNS = [
  /side conversation boundary/i,
  /inherited history from the parent thread/i,
  /reference context only/i,
  /only messages submitted after this boundary are active/i,
  /side-conversation assistant/i,
] as const;

function textHasSideConversationBoundary(text: string): boolean {
  return SIDE_CONVERSATION_BOUNDARY_PATTERNS.some((pattern) => pattern.test(text));
}

function isLikelySideConversationStopPayload(payload: CodexHookPayload): boolean {
  const payloadText = [
    payload.prompt,
    payload.user_prompt,
    payload.userPrompt,
    payload.input,
    payload.last_user_message,
    payload.lastUserMessage,
    payload.last_assistant_message,
    payload.lastAssistantMessage,
  ].map(safeString).join("\n");
  if (textHasSideConversationBoundary(payloadText)) return true;

  const transcriptPath = safeString(payload.transcript_path ?? payload.transcriptPath).trim();
  if (!transcriptPath || !existsSync(transcriptPath)) return false;

  try {
    const maxBytes = 256 * 1024;
    const stats = statSync(transcriptPath);
    const fd = openSync(transcriptPath, "r");
    try {
      const bytesToRead = Math.min(maxBytes, Math.max(0, stats.size));
      const buffer = Buffer.alloc(bytesToRead);
      const position = Math.max(0, stats.size - bytesToRead);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
      return textHasSideConversationBoundary(buffer.toString("utf-8", 0, bytesRead));
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

function shouldSuppressParentWorkflowStopForSideConversation(payload: CodexHookPayload): boolean {
  if (safeString(payload.hook_event_name ?? payload.hookEventName).trim() !== "Stop") return false;
  return isLikelySideConversationStopPayload(payload);
}

interface NativeSubagentSessionStartMetadata {
  parentThreadId: string;
  agentNickname?: string;
  agentRole?: string;
}

function readBoundedFirstLineSync(path: string): string {
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(Math.min(8192, MAX_SESSION_META_LINE_BYTES));
    let totalBytesRead = 0;

    while (totalBytesRead < MAX_SESSION_META_LINE_BYTES) {
      const bytesToRead = Math.min(buffer.length, MAX_SESSION_META_LINE_BYTES - totalBytesRead);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, totalBytesRead);
      if (bytesRead <= 0) break;

      totalBytesRead += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      const newlineOffset = chunk.indexOf(0x0a);
      if (newlineOffset >= 0) {
        chunks.push(Buffer.from(chunk.subarray(0, newlineOffset)));
        break;
      }
      chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks).toString("utf-8").replace(/\r$/, "");
  } finally {
    closeSync(fd);
  }
}

function readNativeSubagentSessionStartMetadata(transcriptPath: string): NativeSubagentSessionStartMetadata | null {
  const normalizedPath = transcriptPath.trim();
  if (!normalizedPath) return null;

  try {
    const firstLine = readBoundedFirstLineSync(normalizedPath).trim();
    if (!firstLine) return null;
    const firstRecord = safeObject(JSON.parse(firstLine));
    if (safeString(firstRecord.type) !== "session_meta") return null;

    const payload = safeObject(firstRecord.payload);
    const source = safeObject(payload.source);
    const subagent = safeObject(source.subagent);
    const threadSpawn = safeObject(subagent.thread_spawn);
    const parentThreadId = safeString(threadSpawn.parent_thread_id).trim();
    if (!parentThreadId) return null;

    const agentNickname = safeString(threadSpawn.agent_nickname ?? payload.agent_nickname).trim();
    const agentRole = safeString(threadSpawn.agent_role ?? payload.agent_role).trim();
    return {
      parentThreadId,
      ...(agentNickname ? { agentNickname } : {}),
      ...(agentRole ? { agentRole } : {}),
    };
  } catch {
    return null;
  }
}

async function recordNativeSubagentSessionStart(
  cwd: string,
  canonicalSessionId: string,
  childSessionId: string,
  metadata: NativeSubagentSessionStartMetadata,
  transcriptPath: string,
): Promise<void> {
  const parentThreadId = metadata.parentThreadId.trim();
  const childThreadId = childSessionId.trim();
  const trackingSessionIds = [...new Set([
    canonicalSessionId.trim(),
    parentThreadId,
  ].filter(Boolean))];
  for (const sessionId of trackingSessionIds) {
    if (parentThreadId && parentThreadId !== childThreadId) {
      await recordSubagentTurnForSession(cwd, {
        sessionId,
        threadId: parentThreadId,
        kind: 'leader',
      }).catch(() => {});
    }
    await recordSubagentTurnForSession(cwd, {
      sessionId,
      threadId: childThreadId,
      kind: 'subagent',
      ...(parentThreadId && parentThreadId !== childThreadId ? { leaderThreadId: parentThreadId } : {}),
      mode: metadata.agentRole,
    }).catch(() => {});
  }
  await appendToLog(cwd, {
    event: "subagent_session_start",
    session_id: canonicalSessionId,
    native_owner_session_id: metadata.parentThreadId,
    native_session_id: childSessionId,
    parent_thread_id: metadata.parentThreadId,
    ...(metadata.agentNickname ? { agent_nickname: metadata.agentNickname } : {}),
    ...(metadata.agentRole ? { agent_role: metadata.agentRole } : {}),
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    timestamp: new Date().toISOString(),
  }).catch(() => {});
}

async function nativeSubagentSessionStartBelongsToCanonicalSession(
  cwd: string,
  canonicalSessionId: string,
  currentSessionState: SessionState | null,
  metadata: NativeSubagentSessionStartMetadata,
): Promise<boolean> {
  const parentThreadId = metadata.parentThreadId.trim();
  if (!parentThreadId) return false;

  const currentNativeSessionId = safeString(currentSessionState?.native_session_id).trim();
  if (currentNativeSessionId && currentNativeSessionId === parentThreadId) {
    return true;
  }

  const summary = await readSubagentSessionSummary(cwd, canonicalSessionId).catch(() => null);
  if (!summary) return false;
  if (summary.leaderThreadId === parentThreadId) return true;
  return summary.allThreadIds.includes(parentThreadId);
}

async function isNativeSubagentHook(
  cwd: string,
  canonicalSessionId: string,
  nativeSessionId: string,
  threadId: string,
  canonicalLeaderNativeSessionId = "",
): Promise<boolean> {
  const nativeId = nativeSessionId.trim();
  const promptThreadId = threadId.trim();
  const candidateIds = [nativeId, promptThreadId]
    .map((value) => value.trim())
    .filter(Boolean);
  if (candidateIds.length === 0) return false;

  const sessionId = canonicalSessionId.trim();
  const currentLeaderNativeSessionId = canonicalLeaderNativeSessionId.trim();
  const summary = sessionId
    ? await readSubagentSessionSummary(cwd, sessionId).catch(() => null)
    : null;
  const currentLeaderIds = new Set([
    currentLeaderNativeSessionId,
    summary?.leaderThreadId?.trim(),
  ].filter(Boolean));
  if (
    summary
    && candidateIds.some((id) => !currentLeaderIds.has(id) && summary.allSubagentThreadIds.includes(id))
  ) {
    return true;
  }
  // Native UserPromptSubmit can carry a per-turn thread_id that differs from
  // the long-lived native session id.  Treat the current canonical native
  // session as the leader before consulting stale/global tracker state.
  if (
    sessionId
    && currentLeaderNativeSessionId
    && (
      nativeId === currentLeaderNativeSessionId
      || (!nativeId && promptThreadId === currentLeaderNativeSessionId)
    )
  ) {
    return false;
  }

  if (summary) {
    const leaderThreadId = summary.leaderThreadId?.trim();
    if (
      leaderThreadId
      && (
        nativeId === leaderThreadId
        || (!nativeId && promptThreadId === leaderThreadId)
      )
    ) {
      return false;
    }
  }

  // Native Codex resume can report the child native session as the canonical
  // session id before OMX reconciles it back to the owning session.  In that
  // window the per-session summary lookup above misses the child and a
  // subagent UserPromptSubmit can accidentally activate workflow keywords from
  // quoted review context.  Fall back to the global tracking index so any known
  // subagent thread is treated as subagent-scoped, regardless of the current
  // hook payload's session-id mapping.
  const trackingState = await readSubagentTrackingState(cwd).catch(() => null);
  if (!trackingState) return false;

  return Object.values(trackingState.sessions).some((session) => (
    candidateIds.some((id) => isTrustedSubagentThread(session, id))
  ));
}

function shouldSuppressSubagentLifecycleHookDispatch(): boolean {
  const config = getNotificationConfig();
  if (config?.includeChildAgents === true) return false;
  const verbosity = getVerbosity(config);
  return verbosity !== "agent" && verbosity !== "verbose";
}

async function recordIgnoredNativeSubagentSessionStart(
  cwd: string,
  canonicalSessionId: string,
  childSessionId: string,
  metadata: NativeSubagentSessionStartMetadata,
  transcriptPath: string,
): Promise<void> {
  await appendToLog(cwd, {
    event: "subagent_session_start_ignored",
    reason: "parent_not_in_canonical_session",
    session_id: canonicalSessionId,
    native_session_id: childSessionId,
    parent_thread_id: metadata.parentThreadId,
    ...(metadata.agentNickname ? { agent_nickname: metadata.agentNickname } : {}),
    ...(metadata.agentRole ? { agent_role: metadata.agentRole } : {}),
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    timestamp: new Date().toISOString(),
  }).catch(() => {});
}

function safePositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function normalizePromptSignalText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function looksLikeExecutionHandoffPrompt(prompt: string): boolean {
  const normalized = normalizePromptSignalText(prompt);
  if (!normalized) return false;
  return EXECUTION_HANDOFF_PATTERNS.some((pattern) => pattern.test(normalized));
}

function looksLikeShortFollowupPrompt(prompt: string): boolean {
  const normalized = normalizePromptSignalText(prompt);
  if (!normalized) return false;
  if (looksLikeExecutionHandoffPrompt(normalized)) return true;
  if (normalized.length > 240) return false;
  return SHORT_FOLLOWUP_PRIORITY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function buildPromptPriorityMessage(prompt: string): string | null {
  if (looksLikeExecutionHandoffPrompt(prompt)) {
    return "Newest user input is an execution handoff for the current task. Treat it as authorization to act now against the latest approved plan/request. Do not restate the prior plan unless the user explicitly asks for a recap or status update.";
  }
  if (looksLikeShortFollowupPrompt(prompt)) {
    return "Newest user input is a same-thread follow-up. Answer that latest follow-up directly and prefer it over older unresolved prompts when choosing what to do next.";
  }
  return null;
}

function readHookEventName(payload: CodexHookPayload): CodexHookEventName | null {
  const raw = safeString(
    payload.hook_event_name
    ?? payload.hookEventName
    ?? payload.event
    ?? payload.name,
  ).trim();
  if (
    raw === "SessionStart"
    || raw === "PreToolUse"
    || raw === "PostToolUse"
    || raw === "UserPromptSubmit"
    || raw === "PreCompact"
    || raw === "PostCompact"
    || raw === "Stop"
  ) {
    return raw;
  }
  return null;
}

function sanitizeCodexHookOutput(
  hookEventName: CodexHookEventName | null,
  output: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!output || hookEventName !== "PreToolUse") return output;
  const preToolUseDenyOutput = toPreToolUseDenyOutput(output);
  if (preToolUseDenyOutput) return preToolUseDenyOutput;

  const systemMessage = safeString(output.systemMessage).trim();
  if (systemMessage) return { systemMessage };

  const reason = safeString(output.reason).trim();
  const hookSpecificOutput = output.hookSpecificOutput;
  const additionalContext = hookSpecificOutput && typeof hookSpecificOutput === "object"
    ? safeString((hookSpecificOutput as { additionalContext?: unknown }).additionalContext).trim()
    : "";
  const derivedSystemMessage = [reason, additionalContext].filter(Boolean).join("\n\n");
  return derivedSystemMessage ? { systemMessage: derivedSystemMessage } : {};
}

function toPreToolUseDenyOutput(output: Record<string, unknown>): Record<string, unknown> | null {
  const sourceHookSpecificOutput = safeObject(output.hookSpecificOutput);
  const legacyBlock = output.decision === "block";
  const hookSpecificDeny = sourceHookSpecificOutput.permissionDecision === "deny";
  if (!legacyBlock && !hookSpecificDeny) return null;

  const permissionDecisionReason = safeString(sourceHookSpecificOutput.permissionDecisionReason).trim();
  const legacyReason = safeString(output.reason).trim();
  const additionalContext = safeString(sourceHookSpecificOutput.additionalContext).trim();
  const systemMessage = safeString(output.systemMessage).trim();
  const reason = permissionDecisionReason || legacyReason || systemMessage;
  if (!reason) {
    throw new Error(
      "Malformed PreToolUse block output: explicit deny/block requires non-empty permissionDecisionReason, reason, or systemMessage.",
    );
  }

  const hookSpecificOutput: Record<string, unknown> = {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  };
  if (additionalContext) {
    hookSpecificOutput.additionalContext = additionalContext;
  }

  return {
    ...(systemMessage ? { systemMessage } : {}),
    hookSpecificOutput,
  };
}

export function mapCodexHookEventToOmxEvent(
  hookEventName: CodexHookEventName | null,
): string | null {
  switch (hookEventName) {
    case "SessionStart":
      return "session-start";
    case "PreToolUse":
      return "pre-tool-use";
    case "PostToolUse":
      return "post-tool-use";
    case "UserPromptSubmit":
      return "keyword-detector";
    case "PreCompact":
      return "pre-compact";
    case "PostCompact":
      return "post-compact";
    case "Stop":
      return "stop";
    default:
      return null;
  }
}

function readPromptText(payload: CodexHookPayload): string {
  const candidates = [
    payload.prompt,
    payload.user_prompt,
    payload.userPrompt,
  ];
  for (const candidate of candidates) {
    const value = safeString(candidate).trim();
    if (value) return value;
  }
  return "";
}


function extractBalancedJsonObject(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  return null;
}

function normalizePromptSteeringProposal(raw: unknown, prompt: string): UltragoalSteeringProposal | null {
  const candidate = safeObject(raw);
  const nested = candidate.omx_ultragoal_steer ?? candidate.ultragoal_steer ?? candidate.steering ?? candidate;
  const proposal = parseUltragoalSteeringDirective(JSON.stringify(nested));
  if (!proposal) return null;
  if (proposal.source !== "user_prompt_submit") return null;
  const normalized = prompt.trim().toLowerCase();
  return {
    ...proposal,
    directiveText: proposal.directiveText ?? safeContextSnippet(prompt, 600),
    promptSignature: proposal.promptSignature ?? promptSignature(normalized),
    idempotencyKey: proposal.idempotencyKey ?? `user_prompt_submit:${promptSignature(normalized)}`,
  };
}

function parseUserPromptUltragoalSteeringDirective(prompt: string): UltragoalSteeringProposal | null {
  const trimmed = prompt.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:omx-ultragoal-steer|ultragoal-steer)\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return normalizePromptSteeringProposal(JSON.parse(fenced[1]), prompt);
    } catch {
      return null;
    }
  }

  const label = trimmed.match(/(?:^|\n)\s*(?:OMX_ULTRAGOAL_STEER|omx\.ultragoal\.steer|omx ultragoal steer)\s*:\s*{/i);
  if (label?.index !== undefined) {
    const brace = trimmed.indexOf("{", label.index);
    const json = brace >= 0 ? extractBalancedJsonObject(trimmed, brace) : null;
    if (json) {
      try {
        return normalizePromptSteeringProposal(JSON.parse(json), prompt);
      } catch {
        return null;
      }
    }
  }

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const object = safeObject(parsed);
      if ("omx_ultragoal_steer" in object || "ultragoal_steer" in object) {
        return normalizePromptSteeringProposal(parsed, prompt);
      }
    } catch {
      return null;
    }
  }
  return null;
}

async function applyUserPromptUltragoalSteering(cwd: string, prompt: string): Promise<string | null> {
  const proposal = parseUserPromptUltragoalSteeringDirective(prompt);
  if (!proposal) return null;
  try {
    const result = await steerUltragoal(cwd, proposal);
    const status = result.deduped ? "deduped" : result.accepted ? "accepted" : "rejected";
    const reasons = result.rejectedReasons.length > 0 ? ` rejectedReasons=${result.rejectedReasons.join("; ")}` : "";
    return [
      `OMX native UserPromptSubmit applied bounded .omx/ultragoal steering for G002-cli-and-prompt-submit-bridge: ${status}.`,
      `mutation=${result.audit.kind}; source=${result.audit.source}; targets=${result.audit.targetGoalIds.join(",") || "none"}; idempotencyKey=${result.audit.idempotencyKey ?? "none"}.${reasons}`,
      "Only explicit structured steering directives are parsed; normal prose is ignored and cannot mutate .omx/ultragoal.",
    ].join(" ");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `OMX native UserPromptSubmit rejected bounded .omx/ultragoal steering for G002-cli-and-prompt-submit-bridge: ${message}`;
  }
}

function sanitizePayloadForHookContext(
  payload: CodexHookPayload,
  hookEventName: CodexHookEventName,
  canonicalSessionId = "",
): CodexHookPayload {
  const sanitized = { ...payload };

  if (hookEventName === "UserPromptSubmit") {
    delete sanitized.prompt;
    delete sanitized.input;
    delete sanitized.user_prompt;
    delete sanitized.userPrompt;
    delete sanitized.text;
    return sanitized;
  }

  if (hookEventName === "Stop") {
    delete sanitized.stop_hook_active;
    delete sanitized.stopHookActive;
    delete sanitized.sessionId;
    sanitized.session_id = canonicalSessionId.trim() || safeString(payload.session_id ?? payload.sessionId).trim();
  }

  return sanitized;
}

function buildBaseContext(
  cwd: string,
  payload: CodexHookPayload,
  hookEventName: CodexHookEventName,
  canonicalSessionId = "",
): Record<string, unknown> {
  return {
    cwd,
    project_path: cwd,
    transcript_path: safeString(payload.transcript_path ?? payload.transcriptPath) || null,
    source: safeString(payload.source),
    payload: sanitizePayloadForHookContext(payload, hookEventName, canonicalSessionId),
  };
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isNonTerminalPhase(value: unknown): boolean {
  const phase = safeString(value).trim().toLowerCase();
  return phase !== "" && !TERMINAL_MODE_PHASES.has(phase);
}

function formatPhase(value: unknown, fallback = "active"): string {
  const phase = safeString(value).trim();
  return phase || fallback;
}

async function readActiveAutoresearchState(
  cwd: string,
  sessionId?: string,
): Promise<Record<string, unknown> | null> {
  const normalizedSessionId = sessionId?.trim() || undefined;
  if (!normalizedSessionId) return null;
  const state = await readAutoresearchModeStateForActiveDecision(cwd, normalizedSessionId);
  if (state?.active !== true) return null;
  if (!isNonTerminalPhase(state.current_phase ?? state.currentPhase ?? 'executing')) return null;
  return state;
}

interface ActiveRalphStopState {
  state: Record<string, unknown>;
  path: string;
}

interface RalphCompletionAuditBlockState {
  state: Record<string, unknown>;
  path: string;
  reason: string;
}

interface RalphStopOwnershipContext {
  sessionId: string;
  payloadSessionId: string;
  threadId: string;
  currentNativeSessionId: string;
  tmuxPaneId: string;
  payload?: CodexHookPayload;
}

function isRalphStartingPhase(state: Record<string, unknown>): boolean {
  return safeString(state.current_phase ?? state.currentPhase).trim().toLowerCase() === "starting";
}


function parseTimestampMs(value: unknown): number | null {
  const text = safeString(value).trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function hasRalphOwnerHint(state: Record<string, unknown>): boolean {
  return [
    state.owner_omx_session_id,
    state.owner_codex_session_id,
    state.owner_codex_thread_id,
    state.thread_id,
    state.tmux_pane_id,
    state.task_slug,
  ].some((value) => safeString(value).trim() !== "");
}

async function isStaleOrphanedRalphStartingState(
  state: Record<string, unknown>,
  path: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!isRalphStartingPhase(state)) return false;
  if (numericValue(state.iteration) !== 0) return false;
  if (hasRalphOwnerHint(state)) return false;

  const timestampMs = parseTimestampMs(state.updated_at)
    ?? parseTimestampMs(state.started_at)
    ?? parseTimestampMs(state.created_at)
    ?? await stat(path).then((info) => info.mtimeMs, () => null);
  if (timestampMs === null) return false;

  return nowMs - timestampMs > RALPH_ORPHANED_STARTING_STALE_MS;
}

function hasValue(values: string[], value: string): boolean {
  return value !== "" && values.some((candidate) => candidate === value);
}

function hasPositiveRalphStopOwnerMatch(
  state: Record<string, unknown>,
  context: RalphStopOwnershipContext,
): boolean {
  const ownerOmxSessionId = safeString(state.owner_omx_session_id).trim();
  if (ownerOmxSessionId && ownerOmxSessionId === context.sessionId) return true;

  const stateSessionId = safeString(state.session_id).trim();
  if (!ownerOmxSessionId && stateSessionId && stateSessionId === context.sessionId) return true;

  const codexOwnerSessionId = safeString(state.owner_codex_session_id).trim();
  if (codexOwnerSessionId) {
    const stopCodexSessionIds = [
      context.payloadSessionId,
      context.currentNativeSessionId,
      context.sessionId,
    ].filter(Boolean);
    if (hasValue(stopCodexSessionIds, codexOwnerSessionId)) return true;
  }

  const stateThreadId = safeString(state.owner_codex_thread_id ?? state.thread_id).trim();
  if (stateThreadId && context.threadId && stateThreadId === context.threadId) return true;

  const statePaneId = safeString(state.tmux_pane_id).trim();
  return statePaneId !== "" && context.tmuxPaneId !== "" && statePaneId === context.tmuxPaneId;
}

function textMatchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function extractRalphTaskText(state: Record<string, unknown>): string {
  const values: string[] = [];
  for (const field of RALPH_TASK_TEXT_FIELDS) {
    const value = safeString(state[field]).trim();
    if (value) values.push(value);
  }

  const taskMetadata = state.task_metadata ?? state.taskMetadata;
  if (taskMetadata && typeof taskMetadata === "object") {
    const metadata = taskMetadata as Record<string, unknown>;
    for (const field of RALPH_TASK_TEXT_FIELDS) {
      const value = safeString(metadata[field]).trim();
      if (value) values.push(value);
    }
  }

  return values.join("\n");
}

function extractRalphStopUserText(payload?: CodexHookPayload): string {
  if (!payload) return "";
  return [
    payload.prompt,
    payload.user_prompt,
    payload.userPrompt,
    payload.input,
    payload.last_user_message,
    payload.lastUserMessage,
  ].map(safeString).filter(Boolean).join("\n");
}

function tokenizeRalphIntentText(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]{2,}/g)) {
    const token = match[0].replace(/^issue-/, "");
    if (!token || RALPH_INTENT_STOPWORDS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

function countTokenOverlap(left: Set<string>, right: Set<string>): number {
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap;
}

function hasCurrentRalphTaskOverlap(state: Record<string, unknown>, userText: string): boolean {
  const taskText = extractRalphTaskText(state);
  const taskTokens = tokenizeRalphIntentText(taskText);
  const userTokens = tokenizeRalphIntentText(userText);
  if (taskTokens.size === 0) return false;
  if (userTokens.size === 0) return false;

  const overlap = countTokenOverlap(taskTokens, userTokens);
  const smallerSide = Math.min(taskTokens.size, userTokens.size);
  return overlap >= 2 || (smallerSide <= 2 && overlap >= 1);
}

function hasMeaningfulRalphTaskText(state: Record<string, unknown>): boolean {
  return tokenizeRalphIntentText(extractRalphTaskText(state)).size > 0;
}

function isRalphLiveRiskContinuation(state: Record<string, unknown>, userText: string): boolean {
  return textMatchesAny(`${extractRalphTaskText(state)}\n${userText}`, RALPH_LIVE_RISK_PATTERNS);
}

function shouldAllowGlobalRalphStopContinuation(
  state: Record<string, unknown>,
  context: RalphStopOwnershipContext,
): boolean {
  const userText = extractRalphStopUserText(context.payload);
  const hasContinuationIntent = textMatchesAny(userText, RALPH_CONTINUATION_INTENT_PATTERNS);
  const hasTaskOverlap = hasCurrentRalphTaskOverlap(state, userText);
  const hasTaskText = hasMeaningfulRalphTaskText(state);
  const hasUserTaskText = tokenizeRalphIntentText(userText).size > 0;
  const hasPositiveOwnerMatch = hasPositiveRalphStopOwnerMatch(state, context);

  if (!activeRalphStateMatchesStopOwner(state, context)) return false;
  if (!userText.trim()) {
    if (isRalphLiveRiskContinuation(state, userText)) return false;
    return hasPositiveOwnerMatch || !hasRalphOwnerHint(state);
  }
  if (isRalphLiveRiskContinuation(state, userText)) {
    return hasContinuationIntent && (hasPositiveOwnerMatch || hasTaskOverlap);
  }
  if (hasPositiveOwnerMatch && hasContinuationIntent) {
    return true;
  }
  if (hasTaskText && hasUserTaskText) {
    return hasTaskOverlap;
  }

  return hasContinuationIntent || hasTaskOverlap;
}

function activeRalphStateMatchesStopOwner(
  state: Record<string, unknown>,
  context: RalphStopOwnershipContext,
): boolean {
  const ownerOmxSessionId = safeString(state.owner_omx_session_id).trim();
  if (ownerOmxSessionId && ownerOmxSessionId !== context.sessionId) {
    return false;
  }

  const stateSessionId = safeString(state.session_id).trim();
  if (!ownerOmxSessionId && stateSessionId && stateSessionId !== context.sessionId) {
    return false;
  }

  const codexOwnerSessionId = safeString(state.owner_codex_session_id).trim();
  if (codexOwnerSessionId) {
    const stopCodexSessionIds = [
      context.payloadSessionId,
      context.currentNativeSessionId,
      context.sessionId,
    ].filter(Boolean);
    if (!hasValue(stopCodexSessionIds, codexOwnerSessionId)) return false;
  }

  const stateThreadId = safeString(state.owner_codex_thread_id ?? state.thread_id).trim();
  if (stateThreadId && context.threadId && stateThreadId !== context.threadId) {
    return false;
  }

  const statePaneId = safeString(state.tmux_pane_id).trim();
  if (statePaneId && context.tmuxPaneId && statePaneId !== context.tmuxPaneId) {
    return false;
  }

  return true;
}

function shouldHonorCanonicalTerminalRunState(
  runState: Record<string, unknown> | null,
  mode: string,
): boolean {
  if (!runState) return false;
  const runMode = safeString(runState.mode).trim();
  if (runMode && runMode !== mode) return false;
  return getRunContinuationSnapshot(runState)?.terminal === true;
}

async function readCanonicalTerminalRunStateForStop(
  cwd: string,
  sessionId: string | undefined,
  mode: string,
): Promise<Record<string, unknown> | null> {
  if (!safeString(sessionId).trim()) return null;
  const runState = await readRunState(cwd, sessionId).catch(() => null);
  const runRecord = runState as unknown as Record<string, unknown> | null;
  return shouldHonorCanonicalTerminalRunState(runRecord, mode) ? runRecord : null;
}

async function isVisibleRalphActiveForSession(stateDir: string, sessionId: string): Promise<boolean> {
  const canonicalState = await readVisibleSkillActiveStateForStateDir(stateDir, sessionId);
  if (!canonicalState) return false;
  return listActiveSkills(canonicalState).some((entry) => (
    entry.skill === "ralph"
    && matchesSkillStopContext(entry, canonicalState, sessionId, "")
  ));
}

async function hasConsistentRalphSkillActivation(stateDir: string, sessionId: string): Promise<boolean> {
  const canonicalState = await readVisibleSkillActiveStateForStateDir(stateDir, sessionId);
  if (!canonicalState) return true;

  const initializedMode = safeString(canonicalState.initialized_mode).trim();
  if (initializedMode && initializedMode !== "ralph") return true;

  const initializedPathSessionId = extractSessionIdFromInitializedStatePath(canonicalState.initialized_state_path);
  if (initializedPathSessionId && initializedPathSessionId !== sessionId) return false;

  return true;
}

function isShadowableRalphStartingSeed(state: Record<string, unknown>): boolean {
  if (state.active !== true) return false;
  if (!isRalphStartingPhase(state)) return false;
  if (state.completion_audit || state.completionAudit) return false;
  const iteration = numericValue(state.iteration);
  return iteration === null || iteration <= 0;
}

function hasPassingCompletedRalphAudit(state: Record<string, unknown> | null, cwd: string): boolean {
  if (!state) return false;
  if (state.mode && safeString(state.mode) !== "ralph") return false;
  if (!isRalphCompletePhase(state.current_phase ?? state.currentPhase)) return false;
  if (state.active === true) return false;
  return evaluateRalphCompletionAuditEvidence(state, cwd).complete === true;
}

function shouldRetireShadowedRalphStartingSeed(
  seedState: Record<string, unknown>,
  completedState: Record<string, unknown> | null,
  cwd: string,
  ownerContext?: {
    completedSessionId?: string;
    payloadSessionId?: string;
    threadId?: string;
    currentNativeSessionId?: string;
    tmuxPaneId?: string;
  },
): boolean {
  if (!isShadowableRalphStartingSeed(seedState)) return false;
  if (!hasPassingCompletedRalphAudit(completedState, cwd)) return false;
  if (!completedState) return false;

  const completedSessionId = safeString(ownerContext?.completedSessionId ?? completedState.session_id).trim();
  if (
    completedSessionId
    && !activeRalphStateMatchesStopOwner(completedState, {
      sessionId: completedSessionId,
      payloadSessionId: safeString(ownerContext?.payloadSessionId).trim(),
      threadId: safeString(ownerContext?.threadId).trim(),
      currentNativeSessionId: safeString(ownerContext?.currentNativeSessionId).trim(),
      tmuxPaneId: safeString(ownerContext?.tmuxPaneId).trim(),
    })
  ) {
    return false;
  }

  const seedThreadId = safeString(seedState.owner_codex_thread_id ?? seedState.thread_id).trim();
  const completedThreadId = safeString(completedState?.owner_codex_thread_id ?? completedState?.thread_id).trim();
  const stopThreadId = safeString(ownerContext?.threadId).trim();
  if (seedThreadId && completedThreadId && seedThreadId !== completedThreadId) return false;
  if (seedThreadId && stopThreadId && seedThreadId !== stopThreadId) return false;
  if (completedThreadId && stopThreadId && completedThreadId !== stopThreadId) return false;

  const seedPaneId = safeString(seedState.tmux_pane_id).trim();
  const completedPaneId = safeString(completedState?.tmux_pane_id).trim();
  const stopPaneId = safeString(ownerContext?.tmuxPaneId).trim();
  if (seedPaneId && completedPaneId && seedPaneId !== completedPaneId) return false;
  if (seedPaneId && stopPaneId && seedPaneId !== stopPaneId) return false;
  if (completedPaneId && stopPaneId && completedPaneId !== stopPaneId) return false;

  const seedStartedAt = parseTimestampMs(seedState.started_at ?? seedState.startedAt);
  const completedAt = parseTimestampMs(completedState?.completed_at ?? completedState?.completedAt);
  if (completedAt === null) return false;
  if (seedStartedAt !== null && seedStartedAt > completedAt) return false;

  return true;
}

async function retireShadowedRalphStartingSeed(
  path: string,
  seedState: Record<string, unknown>,
  completedSessionId: string,
  completedPath: string,
  completedState: Record<string, unknown>,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const completedAt = safeString(completedState.completed_at ?? completedState.completedAt).trim() || nowIso;
  const next: Record<string, unknown> = {
    ...seedState,
    active: false,
    current_phase: "complete",
    completed_at: completedAt,
    stop_reason: "shadowed_by_completed_canonical_ralph",
    shadowed_by_completed_canonical_ralph: {
      session_id: completedSessionId,
      state_path: completedPath,
      completed_at: completedAt,
      reconciled_at: nowIso,
    },
  };
  await writeFile(path, JSON.stringify(next, null, 2));
}


async function readRalphCompletionAuditBlockState(
  cwd: string,
  stateDir: string,
  preferredSessionId?: string,
  ownerContext?: {
    payloadSessionId?: string;
    threadId?: string;
    tmuxPaneId?: string;
  },
): Promise<RalphCompletionAuditBlockState | null> {
  const [rawSessionInfo, usableSessionInfo] = await Promise.all([
    readSessionState(cwd),
    readUsableSessionState(cwd),
  ]);
  const currentOmxSessionId = safeString(usableSessionInfo?.session_id).trim();
  const currentNativeSessionId = safeString(usableSessionInfo?.native_session_id).trim();
  const staleCurrentSessionId = rawSessionInfo && !isSessionStateUsable(rawSessionInfo, cwd)
    ? safeString(rawSessionInfo.session_id).trim()
    : "";
  const sessionCandidates = [...new Set([
    safeString(preferredSessionId).trim(),
    currentOmxSessionId,
  ].filter(Boolean))];

  const evaluateCandidate = (state: Record<string, unknown> | null, path: string, sessionId: string): RalphCompletionAuditBlockState | null => {
    if (!state || state.mode && safeString(state.mode) !== "ralph") return null;
    if (!isRalphCompletePhase(state.current_phase ?? state.currentPhase)) return null;
    if (activeRalphStateMatchesStopOwner(state, {
      sessionId,
      payloadSessionId: safeString(ownerContext?.payloadSessionId).trim(),
      threadId: safeString(ownerContext?.threadId).trim(),
      currentNativeSessionId,
      tmuxPaneId: safeString(ownerContext?.tmuxPaneId).trim(),
    }) !== true) return null;
    const audit = evaluateRalphCompletionAuditEvidence(state, cwd);
    return audit.complete ? null : { state, path, reason: audit.reason };
  };

  for (const sessionId of sessionCandidates) {
    if (staleCurrentSessionId && sessionId === staleCurrentSessionId) continue;
    const sessionScopedPath = getStateFilePath("ralph-state.json", cwd, sessionId);
    const result = evaluateCandidate(await readJsonIfExists(sessionScopedPath), sessionScopedPath, sessionId);
    if (result) return result;
  }

  if (sessionCandidates.length > 0) return null;

  const directPath = join(stateDir, "ralph-state.json");
  return evaluateCandidate(await readJsonIfExists(directPath), directPath, "");
}

async function reopenRalphCompletionAuditBlock(block: RalphCompletionAuditBlockState): Promise<void> {
  const nowIso = new Date().toISOString();
  const next: Record<string, unknown> = {
    ...block.state,
    active: false,
    current_phase: "complete",
    completion_audit_gate: "blocked",
    completion_audit_missing_reason: block.reason,
    completion_audit_blocked_at: nowIso,
  };
  await writeFile(block.path, JSON.stringify(next, null, 2));
}

async function readActiveRalphState(
  cwd: string,
  stateDir: string,
  preferredSessionId?: string,
  ownerContext?: {
    payloadSessionId?: string;
    threadId?: string;
    tmuxPaneId?: string;
    payload?: CodexHookPayload;
  },
): Promise<ActiveRalphStopState | null> {
  const [rawSessionInfo, usableSessionInfo] = await Promise.all([
    readSessionState(cwd),
    readUsableSessionState(cwd),
  ]);
  const currentOmxSessionId = safeString(usableSessionInfo?.session_id).trim();
  const currentNativeSessionId = safeString(usableSessionInfo?.native_session_id).trim();
  const staleCurrentSessionId = rawSessionInfo && !isSessionStateUsable(rawSessionInfo, cwd)
    ? safeString(rawSessionInfo.session_id).trim()
    : "";
  const sessionCandidates = [...new Set([
    safeString(preferredSessionId).trim(),
    currentOmxSessionId,
  ].filter(Boolean))];
  const completedCanonicalPath = currentOmxSessionId
    ? getStateFilePath("ralph-state.json", cwd, currentOmxSessionId)
    : "";
  const completedCanonicalState = completedCanonicalPath
    ? await readJsonIfExists(completedCanonicalPath)
    : null;

  // Ralph Stop stays authoritative-scope-only once the Stop payload is session-bound.
  // That is intentionally stricter than generic state MCP reads: do not scan sibling
  // session scopes or fall back to root when a current/explicit session is in play.
  for (const sessionId of sessionCandidates) {
    if (staleCurrentSessionId && sessionId === staleCurrentSessionId) {
      continue;
    }
    if (await readCanonicalTerminalRunStateForStop(cwd, sessionId, "ralph")) {
      continue;
    }
    const sessionScopedPath = getStateFilePath("ralph-state.json", cwd, sessionId);
    const sessionScoped = await readJsonIfExists(sessionScopedPath);
    if (sessionScoped?.active === true) {
      if (
        currentOmxSessionId
        && sessionId !== currentOmxSessionId
        && completedCanonicalState
        && shouldRetireShadowedRalphStartingSeed(sessionScoped, completedCanonicalState, cwd, {
          completedSessionId: currentOmxSessionId,
          payloadSessionId: safeString(ownerContext?.payloadSessionId).trim(),
          threadId: safeString(ownerContext?.threadId).trim(),
          currentNativeSessionId,
          tmuxPaneId: safeString(ownerContext?.tmuxPaneId).trim(),
        })
      ) {
        await retireShadowedRalphStartingSeed(
          sessionScopedPath,
          sessionScoped,
          currentOmxSessionId,
          completedCanonicalPath,
          completedCanonicalState,
        );
        continue;
      }
      if (await isStaleOrphanedRalphStartingState(sessionScoped, sessionScopedPath)) {
        continue;
      }
      if (
        isRalphStartingPhase(sessionScoped)
        && !(await isVisibleRalphActiveForSession(stateDir, sessionId))
      ) {
        continue;
      }
    }
    if (
      sessionScoped?.active === true
      && shouldContinueRun(sessionScoped)
      && activeRalphStateMatchesStopOwner(sessionScoped, {
        sessionId,
        payloadSessionId: safeString(ownerContext?.payloadSessionId).trim(),
        threadId: safeString(ownerContext?.threadId).trim(),
        currentNativeSessionId,
        tmuxPaneId: safeString(ownerContext?.tmuxPaneId).trim(),
      })
      && await hasConsistentRalphSkillActivation(stateDir, sessionId)
    ) {
      return { state: sessionScoped, path: sessionScopedPath };
    }
  }

  if (sessionCandidates.length > 0) return null;

  const directPath = join(stateDir, "ralph-state.json");
  const direct = await readJsonIfExists(directPath);
  if (
    direct?.active === true
    && shouldContinueRun(direct)
    && shouldAllowGlobalRalphStopContinuation(direct, {
      sessionId: safeString(ownerContext?.payloadSessionId).trim(),
      payloadSessionId: safeString(ownerContext?.payloadSessionId).trim(),
      threadId: safeString(ownerContext?.threadId).trim(),
      currentNativeSessionId,
      tmuxPaneId: safeString(ownerContext?.tmuxPaneId).trim(),
      payload: ownerContext?.payload,
    })
  ) {
    return { state: direct, path: directPath };
  }

  return null;
}

function readParentPid(pid: number): number | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd === -1) return null;
      const remainder = stat.slice(commandEnd + 1).trim();
      const fields = remainder.split(/\s+/);
      const ppid = Number(fields[1]);
      return Number.isFinite(ppid) && ppid > 0 ? ppid : null;
    }

    const raw = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    const ppid = Number.parseInt(raw, 10);
    return Number.isFinite(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

function readProcessCommand(pid: number): string {
  try {
    if (process.platform === "linux") {
      return readFileSync(`/proc/${pid}/cmdline`, "utf-8")
        .replace(/\u0000+/g, " ")
        .trim();
    }

    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return "";
  }
}

function looksLikeShellCommand(command: string): boolean {
  return /(^|[\/\s])(bash|zsh|sh|dash|fish|ksh)(\s|$)/i.test(command);
}

function looksLikeCodexCommand(command: string): boolean {
  if (/codex-native-hook(?:\.js)?/i.test(command)) return false;
  return /\bcodex(?:\.js)?\b/i.test(command);
}

export function resolveSessionOwnerPidFromAncestry(
  startPid: number,
  options: {
    readParentPid?: (pid: number) => number | null;
    readProcessCommand?: (pid: number) => string;
  } = {},
): number | null {
  const readParent = options.readParentPid ?? readParentPid;
  const readCommand = options.readProcessCommand ?? readProcessCommand;
  const lineage: Array<{ pid: number; command: string }> = [];
  let currentPid = startPid;

  for (let i = 0; i < 6 && Number.isInteger(currentPid) && currentPid > 1; i += 1) {
    const command = readCommand(currentPid);
    lineage.push({ pid: currentPid, command });
    const nextPid = readParent(currentPid);
    if (!nextPid || nextPid === currentPid) break;
    currentPid = nextPid;
  }

  const codexAncestor = lineage.find((entry) => looksLikeCodexCommand(entry.command));
  if (codexAncestor) return codexAncestor.pid;

  if (lineage.length >= 2 && looksLikeShellCommand(lineage[0]?.command || "")) {
    return lineage[1].pid;
  }

  if (lineage.length >= 1) return lineage[0].pid;
  return null;
}

function resolveSessionOwnerPid(payload: CodexHookPayload): number {
  const explicitPid = [
    payload.session_pid,
    payload.sessionPid,
    payload.codex_pid,
    payload.codexPid,
    payload.parent_pid,
    payload.parentPid,
  ]
    .map(safePositiveInteger)
    .find((value): value is number => value !== null);
  if (explicitPid) return explicitPid;

  const resolved = resolveSessionOwnerPidFromAncestry(process.ppid);
  if (resolved) return resolved;
  return process.pid;
}

function tryReadGitValue(cwd: string, args: string[]): string | null {
  try {
    const value = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

interface SloppyFallbackDiffFinding {
  path: string;
  line: string;
  source: "staged" | "unstaged" | "untracked";
}

const SOURCE_DIFF_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cjs",
  ".cpp",
  ".cs",
  ".cts",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".mts",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".swift",
  ".ts",
  ".tsx",
]);

function gitOutput(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

function normalizeGitPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isDiffAuditableSourcePath(path: string): boolean {
  const normalized = normalizeGitPath(path).toLowerCase();
  if (!normalized || normalized.startsWith(".git/") || normalized.startsWith(".omx/")) return false;
  if (/(^|\/)(?:docs?|documentation|changelog|changeset|\.github)(?:\/|$)/i.test(normalized)) return false;
  if (/(^|\/)(?:__tests__|__test__|test|tests|spec|specs|fixtures?|mocks?)(?:\/|$)/i.test(normalized)) return false;
  if (/(?:^|\/)[^\/]+\.(?:test|spec)\.[^.\/]+$/i.test(normalized)) return false;
  if (/(?:^|\/)(?:readme|changelog|changes|license|notice)(?:\.[^\/]*)?$/i.test(normalized)) return false;
  if (/\.(?:md|mdx|markdown|txt|rst|adoc|ya?ml|json|lock)$/i.test(normalized)) return false;
  return SOURCE_DIFF_EXTENSIONS.has(extname(normalized));
}

function isDiffHeaderLine(line: string): boolean {
  return line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("diff --git ");
}

function isSuspiciousSloppyFallbackAddedLine(line: string, nearbyContext: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (!hasAnyPattern(trimmed, SLOPPY_FALLBACK_PHRASE_PATTERNS)) return false;
  if (!hasAnyPattern(trimmed, SLOPPY_FALLBACK_IMPLEMENTATION_CONTEXT_PATTERNS)) return false;
  if (hasAnyPattern(nearbyContext, SLOPPY_FALLBACK_GROUNDING_PATTERNS)) return false;
  if (/compatib(?:le|ility)|fail-?safe|tested|regression|coverage|because|issue|PR\s*#?\d|#\d/i.test(nearbyContext)) return false;
  return true;
}

interface SloppyFallbackCandidateLine {
  text: string;
  added: boolean;
}

function collectFindingsFromCandidateLines(
  path: string,
  lines: SloppyFallbackCandidateLine[],
  source: SloppyFallbackDiffFinding["source"],
): SloppyFallbackDiffFinding[] {
  if (!path || !isDiffAuditableSourcePath(path)) return [];
  const findings: SloppyFallbackDiffFinding[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines[index];
    if (!candidate?.added) continue;
    const nearbyContext = lines
      .slice(Math.max(0, index - 2), Math.min(lines.length, index + 3))
      .map((line) => line.text)
      .join("\n");
    if (isSuspiciousSloppyFallbackAddedLine(candidate.text, nearbyContext)) {
      findings.push({ path, line: candidate.text.trim(), source });
    }
  }
  return findings;
}

function collectSloppyFallbackFindingsFromPatch(
  patch: string,
  source: SloppyFallbackDiffFinding["source"],
): SloppyFallbackDiffFinding[] {
  const findings: SloppyFallbackDiffFinding[] = [];
  let currentPath = "";
  let hunkLines: SloppyFallbackCandidateLine[] = [];

  const flushHunk = () => {
    findings.push(...collectFindingsFromCandidateLines(currentPath, hunkLines, source));
    hunkLines = [];
  };

  for (const rawLine of patch.split(/\r?\n/)) {
    const fileMatch = rawLine.match(/^diff --git a\/(.*?) b\/(.*)$/);
    if (fileMatch) {
      flushHunk();
      currentPath = normalizeGitPath(fileMatch[2] || fileMatch[1] || "");
      continue;
    }
    const renameMatch = rawLine.match(/^\+\+\+ b\/(.*)$/);
    if (renameMatch) {
      currentPath = normalizeGitPath(renameMatch[1] || currentPath);
      continue;
    }
    if (rawLine.startsWith("@@")) {
      flushHunk();
      continue;
    }
    if (!currentPath || !isDiffAuditableSourcePath(currentPath) || isDiffHeaderLine(rawLine)) continue;
    if (rawLine.startsWith("+")) {
      hunkLines.push({ text: rawLine.slice(1), added: true });
    } else if (rawLine.startsWith(" ")) {
      hunkLines.push({ text: rawLine.slice(1), added: false });
    }
  }
  flushHunk();
  return findings;
}

function collectSloppyFallbackFindingsFromUntracked(cwd: string): SloppyFallbackDiffFinding[] {
  const output = gitOutput(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!output) return [];
  const findings: SloppyFallbackDiffFinding[] = [];
  for (const rawPath of output.split("\0")) {
    const path = normalizeGitPath(rawPath.trim());
    if (!path || !isDiffAuditableSourcePath(path)) continue;
    let content = "";
    try {
      content = readFileSync(join(cwd, path), "utf-8");
    } catch {
      continue;
    }
    findings.push(...collectFindingsFromCandidateLines(path, content.split(/\r?\n/).map((text) => ({ text, added: true })), "untracked"));
  }
  return findings;
}

function findSloppyFallbackDiffFindings(cwd: string): SloppyFallbackDiffFinding[] {
  const layout = findGitLayout(cwd);
  if (!layout) return [];
  const auditRoot = layout.worktreeRoot;
  return [
    ...collectSloppyFallbackFindingsFromPatch(gitOutput(auditRoot, ["diff", "--cached", "--no-ext-diff", "--unified=3"]), "staged"),
    ...collectSloppyFallbackFindingsFromPatch(gitOutput(auditRoot, ["diff", "--no-ext-diff", "--unified=3"]), "unstaged"),
    ...collectSloppyFallbackFindingsFromUntracked(auditRoot),
  ];
}

function buildSloppyFallbackDiffStopOutput(findings: SloppyFallbackDiffFinding[]): Record<string, unknown> | null {
  if (findings.length === 0) return null;
  const preview = findings
    .slice(0, 3)
    .map((finding) => `${finding.path} (${finding.source}): ${finding.line}`)
    .join("; ");
  const systemMessage =
    `Sloppy fallback/workaround diff audit detected ungrounded fallback code in added source lines: ${preview}. `
    + "Continue by replacing the bypass/workaround with a grounded design, or add explicit compatibility/fail-safe/tested/issue rationale near the code if the fallback is intentional.";
  return {
    decision: "block",
    reason: systemMessage,
    stopReason: "sloppy_fallback_diff_audit",
    systemMessage,
  };
}

function localExcludeAlreadyIgnoresOmx(cwd: string): boolean {
  const layout = findGitLayout(cwd);
  if (!layout) return false;
  const excludePath = join(layout.gitDir, "info", "exclude");
  try {
    const lines = readFileSync(excludePath, "utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    return lines.includes(".omx/") || lines.includes(".omx");
  } catch {
    return false;
  }
}

function isPathIgnoredByGit(cwd: string, path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", path], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function ensureOmxLocalIgnoreEntry(cwd: string): Promise<{ changed: boolean; excludePath?: string }> {
  const repoRoot = tryReadGitValue(cwd, ["rev-parse", "--show-toplevel"]);
  if (!repoRoot) return { changed: false };
  if (localExcludeAlreadyIgnoresOmx(repoRoot) || isPathIgnoredByGit(repoRoot, ".omx/")) {
    return { changed: false };
  }

  const excludePathValue = tryReadGitValue(repoRoot, ["rev-parse", "--git-path", "info/exclude"]);
  if (!excludePathValue) return { changed: false };
  const excludePath = resolve(repoRoot, excludePathValue);

  const existing = existsSync(excludePath)
    ? await readFile(excludePath, "utf-8")
    : "";
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(".omx/")) {
    return { changed: false, excludePath };
  }

  const next = `${existing}${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}.omx/\n`;
  await writeFile(excludePath, next);
  return { changed: true, excludePath };
}

async function buildSessionStartContext(
  cwd: string,
  sessionId: string,
  options: {
    hookEventName?: CodexHookEventName | null;
    payload?: CodexHookPayload;
    canonicalSessionId?: string;
    nativeSessionId?: string;
  } = {},
): Promise<string | null> {
  const sections: string[] = [];

  sections.push(buildExecutionEnvironmentSection(cwd, {
    hookEventName: options.hookEventName,
    payload: options.payload,
    canonicalSessionId: options.canonicalSessionId,
    nativeSessionId: options.nativeSessionId,
  }));

  const localIgnoreResult = await ensureOmxLocalIgnoreEntry(cwd);
  if (localIgnoreResult.changed) {
    sections.push(`Added .omx/ to ${localIgnoreResult.excludePath} to keep local OMX state out of source control without mutating tracked repo ignores.`);
  }

  const modeSummaries: string[] = [];
  for (const mode of ["ralph", "autopilot", "ultrawork", "ultraqa", "ralplan", "deep-interview", "team"] as const) {
    const state = await readJsonIfExists(getStatePath(mode, cwd, sessionId));
    if (state?.active !== true || !isNonTerminalPhase(state.current_phase)) continue;
    if (mode === "team") {
      const teamName = safeString(state.team_name).trim();
      if (teamName) {
        const phase = await readTeamPhase(teamName, cwd);
        const canonicalPhase = phase?.current_phase ?? state.current_phase;
        if (isNonTerminalPhase(canonicalPhase)) {
          modeSummaries.push(`- team (${teamName}) phase: ${formatPhase(canonicalPhase)}`);
        }
        continue;
      }
    }
    modeSummaries.push(`- ${mode} phase: ${formatPhase(state.current_phase)}`);
  }
  if (modeSummaries.length > 0) {
    sections.push(["[Active OMX modes]", ...modeSummaries].join("\n"));
  }

  const projectMemoryPath = resolveProjectMemoryPath(cwd);
  const projectMemory = projectMemoryPath ? await readJsonIfExists(projectMemoryPath) : null;
  if (projectMemory && projectMemoryPath) {
    const directives = Array.isArray(projectMemory.directives) ? projectMemory.directives : [];
    const notes = Array.isArray(projectMemory.notes) ? projectMemory.notes : [];
    const techStack = safeContextSnippet(projectMemory.techStack);
    const conventions = safeContextSnippet(projectMemory.conventions);
    const build = safeContextSnippet(projectMemory.build);
    const summary: string[] = [];
    const relativeMemoryPath = relative(cwd, projectMemoryPath).replace(/\\/g, "/");
    summary.push(`- source: ${relativeMemoryPath === "project-memory.json" ? "project-memory.json" : ".omx/project-memory.json"}`);
    if (techStack) summary.push(`- stack: ${techStack}`);
    if (conventions) summary.push(`- conventions: ${conventions}`);
    if (build) summary.push(`- build: ${build}`);
    if (directives.length > 0) {
      const firstDirective = directives[0] as Record<string, unknown>;
      const directive = safeContextSnippet(firstDirective.directive);
      if (directive) summary.push(`- directive: ${directive}`);
    }
    if (notes.length > 0) {
      const firstNote = notes[0] as Record<string, unknown>;
      const note = safeContextSnippet(firstNote.content);
      if (note) summary.push(`- note: ${note}`);
    }
    if (summary.length > 1) {
      sections.push(["[Project memory]", ...summary].join("\n"));
    }
  }

  if (existsSync(omxNotepadPath(cwd))) {
    try {
      const notepad = await readFile(omxNotepadPath(cwd), "utf-8");
      const header = "## PRIORITY";
      const idx = notepad.indexOf(header);
      if (idx >= 0) {
        const nextHeader = notepad.indexOf("\n## ", idx + header.length);
        const section = (
          nextHeader < 0
            ? notepad.slice(idx + header.length)
            : notepad.slice(idx + header.length, nextHeader)
        )
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .join(" ");
        if (section) {
          sections.push(`[Priority notes]\n- ${section.slice(0, 220)}`);
        }
      }
    } catch {
      // best effort only
    }
  }

  const wikiContext = buildWikiSessionStartContext({ cwd });
  if (wikiContext.additionalContext) {
    sections.push(wikiContext.additionalContext);
  }

  const subagentSummary = await readSubagentSessionSummary(cwd, sessionId).catch(() => null);
  if (subagentSummary && subagentSummary.activeSubagentThreadIds.length > 0) {
    sections.push(`[Subagents]\n- active subagent threads: ${subagentSummary.activeSubagentThreadIds.length}`);
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}

type ExecutionEnvironmentKind =
  | "attached-tmux-runtime"
  | "outside-tmux-with-bridge"
  | "native-outside-tmux"
  | "direct-cli-outside-tmux";

interface ExecutionEnvironmentInfo {
  kind: ExecutionEnvironmentKind;
  launcher: CodexLauncherKind;
  transport: CodexTransportKind;
  surface: string;
  tmuxWorkflowGuidance: string;
  questionGuidance: string;
  teamRuntimeInstruction: string;
  teamHelpInstruction: string;
  deepInterviewInstruction: string;
  leaderPaneHint: string;
}

function resolveExecutionEnvironment(
  cwd: string,
  options: {
    hookEventName?: CodexHookEventName | null;
    payload?: CodexHookPayload;
    canonicalSessionId?: string;
    nativeSessionId?: string;
  } = {},
): ExecutionEnvironmentInfo {
  const executionSurface = resolveCodexExecutionSurface(cwd, options);
  const leaderPaneHint = resolveQuestionLeaderPaneHint(cwd, options.payload);
  const questionBridgeHint = leaderPaneHint
    ? `tmux return bridge recorded at ${leaderPaneHint}, but this process is not attached to tmux; prefer native/user-input fallback unless running from an attached tmux pane`
    : "not available from this outside-tmux surface; use native structured input when available or ask one concise plain-text question";

  if (executionSurface.transport === "attached-tmux") {
    return {
      kind: "attached-tmux-runtime",
      launcher: executionSurface.launcher,
      transport: executionSurface.transport,
      surface: "attached tmux runtime - tmux",
      tmuxWorkflowGuidance: "omx team, omx hud, and omx question are directly usable in this session",
      questionGuidance: "visible temporary renderer available from the current pane; primary success JSON is answers[]",
      teamRuntimeInstruction: "Use the durable OMX team runtime via `omx team ...` for coordinated execution; do not replace it with in-process fanout.",
      teamHelpInstruction: "If you need runtime syntax, run `omx team --help` yourself.",
      deepInterviewInstruction: "Deep-interview must ask each interview round via `omx question`; do not fall back to `request_user_input` or plain-text questioning. This session is already attached to tmux, so `omx question` can open its temporary renderer directly over the leader pane. After starting `omx question` in a background terminal, wait for that terminal to finish and read the JSON answer before continuing the interview. Prefer `answers[0].answer` / `answers[]`; use legacy `answer` only as fallback. Deep-interview remains one question per round, so do not batch multiple interview rounds into one `questions[]` form. Stop remains blocked while a deep-interview question obligation is pending.",
      leaderPaneHint,
    };
  }

  if (leaderPaneHint) {
    const isNativeOutsideTmux = executionSurface.launcher === "native";
    return {
      kind: "outside-tmux-with-bridge",
      launcher: executionSurface.launcher,
      transport: executionSurface.transport,
      surface: isNativeOutsideTmux
        ? "native-hook / Codex App outside tmux with tmux return bridge"
        : "direct CLI outside tmux with tmux return bridge",
      tmuxWorkflowGuidance: "omx team and omx hud need an attached tmux OMX CLI shell from this surface; omx question can use the detected bridge",
      questionGuidance: questionBridgeHint,
      teamRuntimeInstruction: isNativeOutsideTmux
        ? "This session is native-hook / Codex App outside tmux; `omx team` is a CLI/tmux runtime surface, not directly available here. Launch OMX CLI from an attached tmux shell first; do not replace it with in-process fanout."
        : "This session is direct CLI outside tmux with a tmux return bridge for `omx question`; prompt-side `$team` does not auto-start the durable tmux team runtime here. If you intentionally want the runtime, run `omx team ...` yourself from shell instead of replacing it with in-process fanout.",
      teamHelpInstruction: isNativeOutsideTmux
        ? "If you need runtime syntax, run `omx team --help` from an attached tmux OMX CLI shell."
        : "If you need runtime syntax, run `omx team --help` yourself from shell.",
      deepInterviewInstruction: `Deep-interview is active, but this session is not attached to tmux. Do not invoke \`omx question\`, \`omx hud\`, or \`omx team\` from this surface. Ask each interview round through the native structured question tool when available; otherwise ask exactly one concise plain-text question and wait for the answer. A tmux return bridge (${leaderPaneHint}) is recorded for explicit attached-tmux recovery only, not for default Codex App/native fallback.`,
      leaderPaneHint,
    };
  }

  const isNativeOutsideTmux = executionSurface.launcher === "native" && executionSurface.transport === "outside-tmux";
  const surface = isNativeOutsideTmux
    ? "native-hook / Codex App outside tmux"
    : "direct CLI outside tmux";
  const teamRuntimeInstruction = isNativeOutsideTmux
    ? "This session is native-hook / Codex App outside tmux; `omx team` is a CLI/tmux runtime surface, not directly available here. Launch OMX CLI from an attached tmux shell first; do not replace it with in-process fanout."
    : "This session is direct CLI outside tmux; prompt-side `$team` does not auto-start the durable tmux team runtime here. If you intentionally want the runtime, run `omx team ...` yourself from shell instead of replacing it with in-process fanout.";
  const teamHelpInstruction = isNativeOutsideTmux
    ? "If you need runtime syntax, run `omx team --help` from an attached tmux OMX CLI shell rather than from Codex App/native outside-tmux context."
    : "If you need runtime syntax, run `omx team --help` yourself from shell.";
  return {
    kind: isNativeOutsideTmux ? "native-outside-tmux" : "direct-cli-outside-tmux",
    launcher: executionSurface.launcher,
    transport: executionSurface.transport,
    surface,
    tmuxWorkflowGuidance: "omx team, omx hud, and omx question need an attached tmux OMX CLI shell or preserved question bridge from this surface",
    questionGuidance: questionBridgeHint,
    teamRuntimeInstruction,
    teamHelpInstruction,
    deepInterviewInstruction: "Deep-interview is active, but this session is not attached to tmux. Do not invoke `omx question`, `omx hud`, or `omx team` from this surface. Ask each interview round through the native structured question tool when available; otherwise ask exactly one concise plain-text question and wait for the answer. Stop gating still applies to the interview, but no tmux question obligation should be created outside tmux.",
    leaderPaneHint: "",
  };
}

function buildExecutionEnvironmentSection(
  cwd: string,
  options: {
    hookEventName?: CodexHookEventName | null;
    payload?: CodexHookPayload;
    canonicalSessionId?: string;
    nativeSessionId?: string;
  } = {},
): string {
  const environment = resolveExecutionEnvironment(cwd, options);
  return [
    "[Execution environment]",
    `- surface: ${environment.surface}`,
    `- omx runtime surfaces: ${environment.tmuxWorkflowGuidance}`,
    `- omx question: ${environment.questionGuidance}`,
  ].join("\n");
}

function resolveQuestionLeaderPaneHint(cwd: string, payload?: CodexHookPayload): string {
  const payloadSessionId = safeString(payload?.session_id).trim();
  const envSessionId = safeString(process.env.OMX_SESSION_ID || process.env.CODEX_SESSION_ID || process.env.SESSION_ID).trim();
  const sessionId = payloadSessionId || envSessionId;
  const candidatePaths = [
    ...(sessionId ? [getStatePath('deep-interview', cwd, sessionId), getStatePath('ralplan', cwd, sessionId), getStatePath('ralph', cwd, sessionId)] : []),
    getStatePath('deep-interview', cwd),
    getStatePath('ralplan', cwd),
    getStatePath('ralph', cwd),
  ];

  for (const path of candidatePaths) {
    try {
      if (!existsSync(path)) continue;
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      const pane = safeString(parsed?.tmux_pane_id).trim();
      if (/^%\d+$/.test(pane)) return pane;
    } catch {
      // best effort only
    }
  }

  const envPane = safeString(process.env.TMUX_PANE).trim();
  return /^%\d+$/.test(envPane) ? envPane : '';
}

function buildDeepInterviewQuestionBridgeInstruction(cwd: string, payload?: CodexHookPayload): string {
  return resolveExecutionEnvironment(cwd, {
    hookEventName: "UserPromptSubmit",
    payload,
    nativeSessionId: safeString(payload?.session_id ?? payload?.sessionId).trim(),
  }).deepInterviewInstruction;
}

function buildTeamRuntimeInstruction(cwd: string, payload?: CodexHookPayload): string {
  return resolveExecutionEnvironment(cwd, {
    hookEventName: "UserPromptSubmit",
    payload,
    nativeSessionId: safeString(payload?.session_id ?? payload?.sessionId).trim(),
  }).teamRuntimeInstruction;
}

function buildTeamHelpInstruction(cwd: string, payload?: CodexHookPayload): string {
  return resolveExecutionEnvironment(cwd, {
    hookEventName: "UserPromptSubmit",
    payload,
    nativeSessionId: safeString(payload?.session_id ?? payload?.sessionId).trim(),
  }).teamHelpInstruction;
}

function buildNativeOutsideTmuxTeamPromptBlockState(
  prompt: string,
  cwd: string,
  payload: CodexHookPayload,
  sessionId?: string,
  threadId?: string,
  turnId?: string,
): SkillActiveState | null {
  if (!readTeamModeConfig(cwd).enabled) return null;
  const match = detectPrimaryKeyword(prompt);
  if (match?.skill !== "team") return null;

  const environment = resolveExecutionEnvironment(cwd, {
    hookEventName: "UserPromptSubmit",
    payload,
    canonicalSessionId: sessionId ?? "",
    nativeSessionId: safeString(payload.session_id ?? payload.sessionId).trim(),
  });
  if (!(environment.launcher === "native" && environment.transport === "outside-tmux")) return null;

  const nowIso = new Date().toISOString();
  return {
    version: 1,
    active: false,
    skill: "team",
    keyword: match.keyword,
    phase: "planning",
    activated_at: nowIso,
    updated_at: nowIso,
    source: "keyword-detector",
    session_id: sessionId,
    thread_id: threadId,
    turn_id: turnId,
    active_skills: [],
    transition_error: "Codex App/native outside-tmux sessions cannot activate the tmux-only `team` workflow directly. Launch OMX CLI from an attached tmux shell first, then run `omx team ...` there.",
  };
}

function buildSkillStateCliInstruction(mode: string, statePath: string): string {
  return `skill: ${mode} activated and initial state initialized at ${statePath}; use CLI-first state updates via \`omx state write/read/clear --input '<json>' --json\`; use omx_state MCP only when explicit MCP compatibility is enabled.`;
}

function buildAutopilotPromptActivationNote(
  skillState?: SkillActiveState | null,
  options: { markedQuestionAnswer?: boolean; cwd?: string } = {},
): string | null {
  if (skillState?.initialized_mode !== "autopilot") return null;
  const teamHandoff = readTeamModeConfig(options.cwd).enabled
    ? " (+ $team if needed)"
    : "";
  return [
    `Autopilot protocol: the durable default chain is $deep-interview -> $ralplan -> $ultragoal${teamHandoff} -> $code-review -> $ultraqa (deep-interview -> ralplan -> ultragoal -> code-review -> ultraqa).`,
    "Start/resume at current_phase=deep-interview unless the task is clear and bounded; if deep-interview is intentionally skipped, persist and state an explicit deep_interview_gate.skip_reason before moving to ralplan.",
    "Deep-interview is a structured question chain, not a one-question gate: after an omx question answer, re-score ambiguity against the active threshold, treat max_rounds as a cap, and crystallize once ambiguity is at or below threshold and readiness gates pass.",
    options.markedQuestionAnswer
      ? "This turn is a marked omx question answer. Treat ordinary selected option/freeform answer text as interview input, then re-score. Do not close merely because the first question was answered; if ambiguity is at or below threshold and readiness gates pass, write interview_complete evidence and hand off. Ask another deep-interview follow-up only when a readiness gate remains unresolved and the answer would materially change execution."
      : null,
    "Do not advance from deep-interview to ralplan merely because the first question was answered; persist explicit interview_complete evidence before setting current_phase=ralplan, and do advance when threshold plus readiness gates are satisfied.",
    "The ralplan phase is not complete until Planner output has been reviewed sequentially by Architect and then Critic; do not hand off to Ultragoal or implementation until the ralplan state/artifact records both ralplan_architect_review and ralplan_critic_review with approval or an explicit blocker.",
    "Do not silently fall back to ordinary $plan/ralplan-only handling; keep autopilot-state.json, skill-active-state.json, HUD/statusline, and Codex goal-mode handoff guidance visible while the workflow is active.",
    "When Codex goal tools are available, call get_goal/create_goal only from the active thread handoff and treat the active goal as the completion contract until code-review and ultraqa are clean.",
  ].filter(Boolean).join(" ");
}

function formatExecutionHandoffList(cwd: string): string {
  return readTeamModeConfig(cwd).enabled
    ? "`$ultragoal`, `$team`, or `$ralph`"
    : "`$ultragoal` or `$ralph`";
}

function buildAdditionalContextMessage(
  prompt: string,
  skillState?: SkillActiveState | null,
  cwd: string = process.cwd(),
  payload?: CodexHookPayload,
): string | null {
  if (!prompt) return null;
  const promptPriorityMessage = buildPromptPriorityMessage(prompt);
  const teamMode = readTeamModeConfig(cwd);
  const matches = detectKeywords(prompt).filter((entry) => teamMode.enabled || entry.skill !== "team");
  const match = matches[0] ?? null;
  if (!match) {
    const continuedSkill = safeString(skillState?.skill).trim();
    if (!continuedSkill) return promptPriorityMessage;
    const deepInterviewPromptActivationNote = skillState?.initialized_mode === "deep-interview"
      ? buildDeepInterviewQuestionBridgeInstruction(cwd, payload)
      : null;
    const deepInterviewConfigPromptActivationNote = buildDeepInterviewConfigInstruction(cwd, skillState);
    const markedQuestionAnswer = /^\s*\[omx question answered\]/i.test(prompt);
    const autopilotPromptActivationNote = buildAutopilotPromptActivationNote(skillState, { markedQuestionAnswer, cwd });
    return [
      `OMX native UserPromptSubmit continued active workflow skill "${continuedSkill}".`,
      promptPriorityMessage,
      skillState?.initialized_mode && skillState.initialized_state_path
        ? buildSkillStateCliInstruction(skillState.initialized_mode, skillState.initialized_state_path)
        : null,
      deepInterviewPromptActivationNote,
      deepInterviewConfigPromptActivationNote,
      autopilotPromptActivationNote,
      "Follow AGENTS.md routing and preserve workflow transition and planning-safety rules.",
    ].filter(Boolean).join(" ");
  }
  const detectedKeywordMessage = matches.length > 1
    ? `OMX native UserPromptSubmit detected workflow keywords ${matches.map((entry) => `"${entry.keyword}" -> ${entry.skill}`).join(", ")}.`
    : `OMX native UserPromptSubmit detected workflow keyword "${match.keyword}" -> ${match.skill}.`;
  const continuedSkill = safeString(skillState?.skill).trim();
  if (
    continuedSkill
    && continuedSkill !== match.skill
    && /^\s*\[omx question answered\]/i.test(prompt)
  ) {
    const deepInterviewPromptActivationNote = skillState?.initialized_mode === "deep-interview"
      ? buildDeepInterviewQuestionBridgeInstruction(cwd, payload)
      : null;
    const deepInterviewConfigPromptActivationNote = buildDeepInterviewConfigInstruction(cwd, skillState);
    const autopilotPromptActivationNote = buildAutopilotPromptActivationNote(skillState, { markedQuestionAnswer: true, cwd });
    return [
      `OMX native UserPromptSubmit continued active workflow skill "${continuedSkill}"; workflow-like tokens inside the marked omx question answer are treated as answer text, not a new workflow activation.`,
      promptPriorityMessage,
      skillState?.initialized_mode && skillState.initialized_state_path
        ? buildSkillStateCliInstruction(skillState.initialized_mode, skillState.initialized_state_path)
        : null,
      deepInterviewPromptActivationNote,
      deepInterviewConfigPromptActivationNote,
      autopilotPromptActivationNote,
      "Follow AGENTS.md routing and preserve workflow transition and planning-safety rules.",
    ].filter(Boolean).join(" ");
  }
  const activeSkills = Array.isArray(skillState?.active_skills)
    ? skillState.active_skills.map((entry) => entry.skill)
    : [];
  const deferredSkills = Array.isArray(skillState?.deferred_skills)
    ? skillState.deferred_skills
    : [];
  const teamDetected = activeSkills.includes("team");
  const ralphPromptActivationNote = skillState?.initialized_mode === "ralph"
    ? "Prompt-side `$ralph` activation seeds Ralph workflow state only; it does not invoke `omx ralph`. Use `omx ralph --prd ...` only when you explicitly want the PRD-gated CLI startup path."
    : null;
  const deepInterviewPromptActivationNote = skillState?.initialized_mode === "deep-interview"
    ? buildDeepInterviewQuestionBridgeInstruction(cwd, payload)
    : null;
  const deepInterviewConfigPromptActivationNote = buildDeepInterviewConfigInstruction(cwd, skillState);
  const ultraworkPromptActivationNote = skillState?.initialized_mode === "ultrawork"
    ? "Ultrawork protocol: ground the task before editing, define pass/fail acceptance criteria, keep shared-file work local, and use direct-tool plus background evidence lanes only for truly independent work. Direct ultrawork provides lightweight verification only; Ralph owns persistence and the full verified-completion promise."
    : null;
  const ultragoalPromptActivationNote = match.skill === "ultragoal"
    ? "Ultragoal protocol: use `omx ultragoal create-goals` / `complete-goals` / `checkpoint` for `.omx/ultragoal` artifacts, then use Codex goal model tools only from the active agent handoff (`get_goal`, `create_goal`, `update_goal`) and never overwrite a different active Codex goal. Ultragoal does not call `/goal clear`; for multiple sequential ultragoal runs in one Codex session/thread, manually clear the completed Codex goal in the UI before creating the next aggregate goal."
    : null;
  const autopilotPromptActivationNote = buildAutopilotPromptActivationNote(skillState, { cwd });
  const combinedTransitionMessage = (() => {
    if (!skillState?.transition_message) return null;
    if (matches.length <= 1 || activeSkills.length <= 1) return skillState.transition_message;
    const source = skillState.transition_message.match(/^mode transiting: (.+?) -> /)?.[1];
    if (!source) return skillState.transition_message;
    return `mode transiting: ${source} -> ${activeSkills.join(" + ")}`;
  })();

  if (skillState?.transition_error) {
    return [
      `OMX native UserPromptSubmit denied workflow keyword "${match.keyword}" -> ${match.skill}.`,
      skillState.transition_error,
      promptPriorityMessage,
      'Follow AGENTS.md routing and preserve workflow transition and planning-safety rules.',
    ].join(' ');
  }

  if (skillState?.transition_message) {
    return [
      detectedKeywordMessage,
      combinedTransitionMessage,
      activeSkills.length > 1 ? `active skills: ${activeSkills.join(", ")}.` : null,
      deferredSkills.length > 0
        ? `planning preserved over simultaneous execution follow-up; deferred skills: ${deferredSkills.join(", ")}.`
        : null,
      promptPriorityMessage,
      ultragoalPromptActivationNote,
      autopilotPromptActivationNote,
      deepInterviewConfigPromptActivationNote,
      skillState.initialized_mode && skillState.initialized_state_path
        ? buildSkillStateCliInstruction(skillState.initialized_mode, skillState.initialized_state_path)
        : null,
      teamDetected
        ? buildTeamRuntimeInstruction(cwd, payload)
        : null,
      teamDetected ? buildTeamHelpInstruction(cwd, payload) : null,
      'Follow AGENTS.md routing and preserve workflow transition and planning-safety rules.',
    ].filter(Boolean).join(' ');
  }

  if (teamDetected) {
    const initializedStateMessage = skillState?.initialized_mode && skillState.initialized_state_path
      ? buildSkillStateCliInstruction(skillState.initialized_mode, skillState.initialized_state_path)
      : null;
    return [
      detectedKeywordMessage,
      activeSkills.length > 1 ? `active skills: ${activeSkills.join(", ")}.` : null,
      deferredSkills.length > 0
        ? `planning preserved over simultaneous execution follow-up; deferred skills: ${deferredSkills.join(", ")}.`
        : null,
      promptPriorityMessage,
      initializedStateMessage,
      deepInterviewPromptActivationNote,
      deepInterviewConfigPromptActivationNote,
      ultraworkPromptActivationNote,
      ultragoalPromptActivationNote,
      autopilotPromptActivationNote,
      buildTeamRuntimeInstruction(cwd, payload),
      buildTeamHelpInstruction(cwd, payload),
      "Follow AGENTS.md routing and preserve workflow transition and planning-safety rules.",
    ].filter(Boolean).join(" ");
  }

  if (skillState?.initialized_mode && skillState.initialized_state_path) {
    return [
      detectedKeywordMessage,
      activeSkills.length > 1 ? `active skills: ${activeSkills.join(", ")}.` : null,
      deferredSkills.length > 0
        ? `planning preserved over simultaneous execution follow-up; deferred skills: ${deferredSkills.join(", ")}.`
        : null,
      promptPriorityMessage,
      buildSkillStateCliInstruction(skillState.initialized_mode, skillState.initialized_state_path),
      deepInterviewPromptActivationNote,
      deepInterviewConfigPromptActivationNote,
      ultraworkPromptActivationNote,
      ultragoalPromptActivationNote,
      autopilotPromptActivationNote,
      ralphPromptActivationNote,
      "Follow AGENTS.md routing and preserve workflow transition and planning-safety rules.",
    ].join(" ");
  }

  return [detectedKeywordMessage, promptPriorityMessage, ultragoalPromptActivationNote, autopilotPromptActivationNote, "Follow AGENTS.md routing and preserve workflow transition and planning-safety rules."].filter(Boolean).join(" ");
}

function parseTeamWorkerEnv(rawValue: string): { teamName: string; workerName: string } | null {
  const match = /^([a-z0-9][a-z0-9-]{0,29})\/(worker-\d+)$/.exec(rawValue.trim());
  if (!match) return null;
  return {
    teamName: match[1] || "",
    workerName: match[2] || "",
  };
}

async function resolveTeamStateDirForWorkerContext(
  cwd: string,
  workerContext: { teamName: string; workerName: string },
): Promise<string | null> {
  const resolved = await resolveWorkerNotifyTeamStateRootPath(cwd, workerContext, process.env).catch(() => null);
  if (resolved) return resolved;
  const explicit = safeString(process.env.OMX_TEAM_STATE_ROOT).trim();
  if (explicit) {
    const candidate = resolve(cwd, explicit);
    const workerRoot = join(candidate, "team", workerContext.teamName, "workers", workerContext.workerName);
    if (existsSync(workerRoot)) return candidate;
    return candidate;
  }
  return null;
}

async function isConfirmedTeamWorkerPromptSubmitPane(cwd: string): Promise<boolean> {
  const workerContext =
    parseTeamWorkerEnv(safeString(process.env.OMX_TEAM_INTERNAL_WORKER))
    || parseTeamWorkerEnv(safeString(process.env.OMX_TEAM_WORKER));
  if (!workerContext) return false;

  const currentPaneId = safeString(process.env.TMUX_PANE).trim();
  if (!currentPaneId) return false;

  const config = await readTeamConfig(workerContext.teamName, cwd).catch(() => null);
  if (!config) return false;

  const leaderPaneId = safeString(config.leader_pane_id).trim();
  if (leaderPaneId && leaderPaneId === currentPaneId) return false;

  const workerPaneId = safeString(
    config.workers.find((worker) => worker.name === workerContext.workerName)?.pane_id,
  ).trim();
  return workerPaneId !== "" && workerPaneId === currentPaneId;
}


type TeamWorkerStopDecision =
  | {
      kind: "blocked";
      stateDir: string;
      workerContext: { teamName: string; workerName: string };
      output: Record<string, unknown>;
      allowRepeatDuringStopHook: boolean;
    }
  | {
      kind: "allowed";
      stateDir: string;
      workerContext: { teamName: string; workerName: string };
    }
  | {
      kind: "unresolved";
      reason: string;
    };

async function resolveTeamWorkerStopDecision(
  cwd: string,
): Promise<TeamWorkerStopDecision> {
  const workerContext =
    parseTeamWorkerEnv(safeString(process.env.OMX_TEAM_INTERNAL_WORKER))
    || parseTeamWorkerEnv(safeString(process.env.OMX_TEAM_WORKER));
  if (!workerContext) return { kind: "unresolved", reason: "missing_worker_context" };

  const blockWorkerStop = (
    reasonCode: string,
    detail: string,
    stateDirForDecision = getBaseStateDir(cwd),
  ): TeamWorkerStopDecision => ({
    kind: "blocked",
    stateDir: stateDirForDecision,
    workerContext,
    allowRepeatDuringStopHook: false,
    output: {
      decision: "block",
      reason:
        `OMX team worker ${workerContext.workerName} Stop cannot be allowed for ${reasonCode}: ${detail}. ` +
        "Continue the assigned task, repair worker state, or report a concrete blocker before stopping.",
      stopReason: `team_worker_${workerContext.workerName}_${reasonCode}`,
      systemMessage:
        `OMX team worker ${workerContext.workerName} Stop lacks completed task evidence (${reasonCode}).`,
    },
  });

  const stateDir = await resolveTeamStateDirForWorkerContext(cwd, workerContext);
  if (!stateDir) {
    return blockWorkerStop("missing_state_dir", "team state root could not be resolved");
  }
  const workerRoot = join(stateDir, "team", workerContext.teamName, "workers", workerContext.workerName);
  const [identity, status] = await Promise.all([
    readJsonIfExists(join(workerRoot, "identity.json")),
    readJsonIfExists(join(workerRoot, "status.json")),
  ]);
  const workerRunState = safeString(status?.state).trim().toLowerCase();
  const workerRunStateIsTerminal = TEAM_WORKER_TERMINAL_RUN_STATES.has(workerRunState);
  if (!identity && !status && !existsSync(workerRoot)) {
    return blockWorkerStop("missing_worker_state", "worker identity/status state is missing", stateDir);
  }

  const candidateTaskIds = new Set<string>();
  const currentTaskId = safeString(status?.current_task_id).trim();
  if (currentTaskId) candidateTaskIds.add(currentTaskId);
  const assignedTasks = Array.isArray(identity?.assigned_tasks) ? identity?.assigned_tasks : [];
  for (const taskId of assignedTasks) {
    const normalized = safeString(taskId).trim();
    if (normalized) candidateTaskIds.add(normalized);
  }

  const tasksDir = join(stateDir, "team", workerContext.teamName, "tasks");
  if (existsSync(tasksDir)) {
    const taskFiles = await readdir(tasksDir).catch(() => []);
    for (const entry of taskFiles) {
      if (!/^task-\d+\.json$/.test(entry)) continue;
      const task = await readJsonIfExists(join(tasksDir, entry));
      const taskOwner = safeString(task?.owner).trim();
      const taskClaimOwner = safeString(safeObject(task?.claim).owner).trim();
      if (taskOwner !== workerContext.workerName && taskClaimOwner !== workerContext.workerName) continue;
      const idFromFile = /^task-(\d+)\.json$/.exec(entry)?.[1] ?? "";
      const taskId = safeString(task?.id).trim() || idFromFile;
      if (taskId) candidateTaskIds.add(taskId);
    }
  }

  if (candidateTaskIds.size === 0) {
    return blockWorkerStop("missing_task_assignment", "no current_task_id or assigned_tasks are recorded", stateDir);
  }

  let completedTaskCount = 0;
  for (const taskId of candidateTaskIds) {
    const task = await readJsonIfExists(
      join(stateDir, "team", workerContext.teamName, "tasks", `task-${taskId}.json`),
    );
    const statusValue = safeString(task?.status).trim().toLowerCase();
    if (!statusValue) {
      return blockWorkerStop(`missing_task_state_${taskId}`, `task ${taskId} has no readable status`, stateDir);
    }
    if (statusValue === "completed") {
      completedTaskCount += 1;
      continue;
    }
    if (!TEAM_STOP_BLOCKING_TASK_STATUSES.has(statusValue)) {
      return blockWorkerStop(
        `non_completed_task_${taskId}_${statusValue}`,
        `task ${taskId} is ${statusValue}, not completed`,
        stateDir,
      );
    }
    return {
      kind: "blocked",
      stateDir,
      workerContext,
      allowRepeatDuringStopHook: !workerRunStateIsTerminal,
      output: {
        decision: "block",
        reason:
          `OMX team worker ${workerContext.workerName} is still assigned non-terminal task ${taskId} (${statusValue}); continue the current assigned task or report a concrete blocker before stopping.`,
        stopReason: `team_worker_${workerContext.workerName}_${taskId}_${statusValue}`,
        systemMessage:
          `OMX team worker ${workerContext.workerName} is still assigned task ${taskId} (${statusValue}).`,
      },
    };
  }

  if (completedTaskCount === candidateTaskIds.size) {
    return { kind: "allowed", stateDir, workerContext };
  }

  return blockWorkerStop("missing_completed_task_evidence", "no referenced worker task is completed", stateDir);
}

function isStopExempt(payload: CodexHookPayload): boolean {
  const candidates = [
    payload.stop_reason,
    payload.stopReason,
    payload.reason,
    payload.exit_reason,
    payload.exitReason,
  ]
    .map((value) => safeString(value).toLowerCase())
    .filter(Boolean);
  return candidates.some((value) =>
    value.includes("cancel")
    || value.includes("abort")
    || value.includes("context")
    || value.includes("compact")
    || value.includes("limit"),
  );
}

async function readModeStateWithStopSource(
  mode: "autopilot" | "ultrawork" | "ultraqa",
  cwd: string,
  sessionId?: string,
): Promise<{ state: Record<string, unknown>; path: string } | null> {
  const paths = await getAuthoritativeActiveStatePaths(mode, cwd, sessionId?.trim() || undefined).catch(() => [] as string[]);
  const path = paths[0];
  if (!path) return null;
  const state = await readJsonIfExists(path);
  return state ? { state, path } : null;
}
async function readRawSkillActiveState(path: string): Promise<SkillActiveStateLike | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed as SkillActiveStateLike : null;
  } catch {
    return null;
  }
}


function canonicalStopDisagreement(modeState: Record<string, unknown>, canonicalState: SkillActiveStateLike | null, mode: string, sessionId?: string): string {
  if (!canonicalState) return "canonical_state_missing";
  const normalizedSessionId = safeString(sessionId).trim();
  const activeEntry = listRawActiveSkillEntries(canonicalState).find((entry) => {
    if (entry.skill !== mode) return false;
    const entrySessionId = safeString(entry.session_id ?? canonicalState.session_id).trim();
    return normalizedSessionId ? entrySessionId === normalizedSessionId || entrySessionId === "" : true;
  });
  if (!activeEntry) return "canonical_inactive";
  if (mode === "autopilot") {
    const phase = safeString(modeState.current_phase ?? modeState.currentPhase).trim();
    const canonicalPhase = safeString(activeEntry.phase ?? canonicalState.phase).trim();
    if (phase && canonicalPhase && normalizeAutopilotPhase(phase) !== normalizeAutopilotPhase(canonicalPhase)) {
      return `canonical_phase:${canonicalPhase}`;
    }
  }
  return "canonical_agrees";
}

function listRawActiveSkillEntries(state: SkillActiveStateLike | null): SkillActiveEntry[] {
  if (!state) return [];
  const entries: SkillActiveEntry[] = [];
  if (Array.isArray(state.active_skills)) {
    for (const candidate of state.active_skills) {
      if (!candidate || typeof candidate !== "object") continue;
      const raw = candidate as unknown as Record<string, unknown>;
      const skill = safeString(raw.skill).trim();
      if (!skill || raw.active === false) continue;
      entries.push({
        ...raw,
        skill,
        phase: safeString(raw.phase).trim() || undefined,
        session_id: safeString(raw.session_id).trim() || undefined,
        thread_id: safeString(raw.thread_id).trim() || undefined,
      });
    }
  }
  const topLevelSkill = safeString(state.skill).trim();
  if (state.active === true && topLevelSkill) {
    entries.push({
      skill: topLevelSkill,
      phase: safeString(state.phase).trim() || undefined,
      session_id: safeString(state.session_id).trim() || undefined,
      thread_id: safeString(state.thread_id).trim() || undefined,
    });
  }
  return entries;
}

async function buildModeBasedStopOutput(
  mode: "autopilot" | "ultrawork" | "ultraqa",
  cwd: string,
  sessionId?: string,
): Promise<Record<string, unknown> | null> {
  if (await readCanonicalTerminalRunStateForStop(cwd, sessionId, mode)) {
    return null;
  }
  if (mode === "autopilot" && await readAutopilotDeepInterviewQuestionWaitState(cwd, sessionId)) {
    return null;
  }
  const sourcedState = await readModeStateWithStopSource(mode, cwd, sessionId);
  const state = sourcedState?.state ?? null;
  if (!state || !shouldContinueRun(state)) return null;
  const rootCanonicalState = await readRawSkillActiveState(getSkillActiveStatePathsForStateDir(getBaseStateDir(cwd)).rootPath);
  const canonicalDisagreement = rootCanonicalState
    ? canonicalStopDisagreement(state, rootCanonicalState, mode, sessionId)
    : "canonical_state_missing";
  if (canonicalDisagreement === "canonical_inactive") return null;
  const phase = formatPhase(state.current_phase);
  if (!rootCanonicalState || mode !== "autopilot") {
    const systemMessage = mode === "autopilot" && phase.toLowerCase().replace(/_/g, "-") === "code-review"
      ? "OMX autopilot is still active (phase: code-review). Run the required $code-review step before completing or clearing Autopilot state."
      : `OMX ${mode} is still active (phase: ${phase}).`;
    return {
      decision: "block",
      reason: `OMX ${mode} is still active (phase: ${phase}); continue the task and gather fresh verification evidence before stopping.`,
      stopReason: `${mode}_${phase}`,
      systemMessage,
    };
  }
  const statePath = sourcedState ? formatStopStatePath(cwd, sourcedState.path) : "unknown";
  const diagnostic = `state: ${statePath}; canonical: ${canonicalDisagreement}`;
  const systemMessage = mode === "autopilot" && phase.toLowerCase().replace(/_/g, "-") === "code-review"
    ? `OMX autopilot is still active (phase: code-review; ${diagnostic}). Run the required $code-review step before completing or clearing Autopilot state.`
    : `OMX ${mode} is still active (phase: ${phase}; ${diagnostic}).`;
  return {
    decision: "block",
    reason: `OMX ${mode} is still active (phase: ${phase}; ${diagnostic}); continue the task and gather fresh verification evidence before stopping.`,
    stopReason: `${mode}_${phase}`,
    systemMessage,
    statePath,
    canonicalDisagreement,
  };
}

export function looksLikeGoalCompletionPrompt(text: string): boolean {
  return /\bupdate_goal\s*\(/i.test(text)
    || /\bomx\s+(?:ultragoal|performance-goal|autoresearch-goal)\s+(?:checkpoint|complete)\b/i.test(text)
    || /\b(?:complete|checkpoint|finish|close|mark)\b.{0,80}\b(?:goal|ultragoal|performance[-\s]goal|autoresearch[-\s]goal)\b/i.test(text)
    || /\b(?:ultragoal|performance[-\s]goal|autoresearch[-\s]goal)\b.{0,80}\b(?:complete|checkpoint|finish|close|mark)\b/i.test(text)
    || /(?:^|[.!?]\s+)(?:the\s+)?goal\s+(?:is\s+|now\s+|has\s+been\s+)?(?:complete|completed|finished|closed)(?:\s*(?:[.!?]|$)|\s*[:;]\s*\S|\s*[—–-]\s*\S)/i.test(text);
}

function reportsAutoresearchGoalObjectiveMismatch(text: string): boolean {
  return /\bautoresearch[-\s]goal\b/i.test(text)
    && /\b(?:complete|completion|reconciliation)\b/i.test(text)
    && /objective mismatch/i.test(text);
}

function reportsBlockedPerformanceGoalObjectiveMismatch(state: unknown): boolean {
  const performanceState = safeObject(state);
  const lastValidation = safeObject(performanceState.lastValidation);
  if (safeString(performanceState.workflow) !== "performance-goal") return false;
  if (safeString(performanceState.status) !== "blocked") return false;
  if (safeString(lastValidation.status) !== "blocked") return false;

  const evidence = [
    safeString(lastValidation.evidence),
    safeString(lastValidation.message),
    safeString(performanceState.evidence),
    safeString(performanceState.message),
  ].join(" ");
  return /objective mismatch/i.test(evidence);
}

function reportsBlockedUltragoalCompletedAggregateMicrogoalLoop(goal: Record<string, unknown>): boolean {
  const evidence = [
    safeString(goal.failureReason),
    safeString(goal.blockedReason),
    safeString(goal.evidence),
  ].join(" ");
  return /aggregate codex goal/i.test(evidence)
    && /\bcomplete(?:d)?\b/i.test(evidence)
    && /microgoal/i.test(evidence)
    && /\b(?:unreconcilable|mismatch|loop|already complete|already completed|blocks?)\b/i.test(evidence);
}


function sentenceWindowAround(text: string, start: number, end: number): string {
  const rawBefore = text.slice(Math.max(0, start - 80), start);
  const rawAfter = text.slice(end, Math.min(text.length, end + 80));
  const before = rawBefore.slice(Math.max(rawBefore.lastIndexOf("\n"), rawBefore.lastIndexOf("."), rawBefore.lastIndexOf("!"), rawBefore.lastIndexOf("?")) + 1);
  const sentenceEndOffsets = [rawAfter.indexOf("\n"), rawAfter.indexOf("."), rawAfter.indexOf("!"), rawAfter.indexOf("?")].filter((index) => index >= 0);
  const after = sentenceEndOffsets.length > 0 ? rawAfter.slice(0, Math.min(...sentenceEndOffsets)) : rawAfter;
  return `${before}${text.slice(start, end)}${after}`;
}

function isNegatedGoalAttemptWindow(window: string): boolean {
  return /\b(?:do\s+not|don't|never|must\s+not|should\s+not|cannot|can't|not|no)\b.{0,50}\b(?:start|create|begin|new|another|goal|ultragoal|performance[-\s]goal|autoresearch[-\s]goal)\b/i.test(window)
    || /\b(?:without|instead\s+of)\b.{0,30}\b(?:start|create|begin|new|another)?\b.{0,30}\b(?:goal|ultragoal|performance[-\s]goal|autoresearch[-\s]goal)\b/i.test(window)
    || /\b(?:goal|ultragoal|performance[-\s]goal|autoresearch[-\s]goal)\b.{0,30}\b(?:is|was|already)\b.{0,30}\b(?:documented|complete|completed|done|unavailable|not\s+needed)\b/i.test(window);
}

function looksLikeGoalCreationAttempt(text: string): boolean {
  const candidatePattern = /\b(?:start|create|begin|new|another|goal|ultragoal|performance[-\s]goal|autoresearch[-\s]goal)\b/gi;
  for (const match of text.matchAll(candidatePattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const window = sentenceWindowAround(text, start, end);
    if (isNegatedGoalAttemptWindow(window)) continue;
    if (/(?:\b(?:start|create|begin|new|another)\b.{0,80}\b(?:goal|ultragoal|performance[-\s]goal|autoresearch[-\s]goal)\b|\b(?:goal|ultragoal|performance[-\s]goal|autoresearch[-\s]goal)\b.{0,80}\b(?:start|create|begin|new|another)\b)/i.test(window)) return true;
  }
  return false;
}

function looksLikeCreateGoalAttempt(text: string): boolean {
  const candidatePattern = /\bcreate_goal\s*(?:\(|\b)/gi;
  for (const match of text.matchAll(candidatePattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const window = sentenceWindowAround(text, start, end);
    if (/(?:\bno\s+create_goal\s+attempt\b|\b(?:do\s+not|don't|never|must\s+not|should\s+not|cannot|can't|not)\b.{0,40}\bcreate_goal\b|\bwithout\s+create_goal\b|\bfailed\s+to\s+call\s+create_goal\b|\bcreate_goal\s+(?:is|was)\s+(?:unavailable|not\s+available|not\s+called)\b)/i.test(window)) {
      continue;
    }
    if (/\b(?:call|calling|called|invoke|invoking|start|starting|create|creating|begin|beginning|attempt|attempting|try|trying|continue\s+to|proceed\s+to)\b.{0,80}\bcreate_goal\b/i.test(window)
      || /\bcreate_goal\b.{0,80}\b(?:payload|call|tool|now|next|follows|follow|start|starting|create|creating|begin|beginning|attempt|attempting)\b/i.test(window)
      || /\bcreate_goal\s*\(/i.test(match[0])) {
      return true;
    }
  }
  return false;
}

function looksLikeCompletedGoalCleanupAttempt(text: string): boolean {
  return looksLikeGoalCreationAttempt(text) || looksLikeCreateGoalAttempt(text);
}
function hasFreshNativeGoalCleanupEvidence(text: string): boolean {
  return /\b(?:get_goal|Codex goal|native goal|active goal|thread goal)\b.{0,120}\b(?:reports?|returns?|shows?|status|state|still|attached|pending|cleanup|required|requires?)\b.{0,120}\b(?:complete|completed|attached|pending|cleanup|required|clear)\b/i.test(text)
    || /\b(?:complete|completed|attached|pending|cleanup|required|clear)\b.{0,120}\b(?:get_goal|Codex goal|native goal|active goal|thread goal)\b/i.test(text)
    || /\b(?:pending[-_ ]cleanup|native[-_ ]goal[-_ ]cleanup|completed[-_ ]codex[-_ ]goal[-_ ]cleanup)\b/i.test(text);
}


async function findCompletedGoalWorkflowCleanupNotice(cwd: string): Promise<string | null> {
  const ultragoal = await readJsonIfExists(join(cwd, ".omx", "ultragoal", "goals.json"));
  const aggregateCompletion = safeObject(ultragoal?.aggregateCompletion);
  const ultragoals = Array.isArray(ultragoal?.goals) ? ultragoal.goals.map(safeObject) : [];
  if (safeString(aggregateCompletion.status) === "complete" || (ultragoals.length > 0 && ultragoals.every((goal) => safeString(goal.status) === "complete"))) {
    return buildCodexGoalTerminalCleanupNotice("Ultragoal completion");
  }

  const performanceRoot = join(cwd, ".omx", "goals", "performance");
  for (const entry of await readdir(performanceRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const state = await readJsonIfExists(join(performanceRoot, entry.name, "state.json"));
    if (state?.workflow === "performance-goal" && safeString(state.status) === "complete") {
      return buildCodexGoalTerminalCleanupNotice("Performance-goal completion");
    }
  }

  const autoresearchRoot = join(cwd, ".omx", "goals", "autoresearch");
  for (const entry of await readdir(autoresearchRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const mission = await readJsonIfExists(join(autoresearchRoot, entry.name, "mission.json"));
    if (mission?.workflow === "autoresearch-goal" && safeString(mission.status) === "complete") {
      return buildCodexGoalTerminalCleanupNotice("Autoresearch-goal completion");
    }
  }

  return null;
}

async function buildCompletedGoalCleanupPromptWarning(cwd: string, prompt: string): Promise<string | null> {
  if (!looksLikeCompletedGoalCleanupAttempt(prompt)) return null;
  const notice = await findCompletedGoalWorkflowCleanupNotice(cwd);
  if (!notice) return null;
  return `${notice} Do not continue into create_goal until cleanup is explicit; hooks only nudge and must not mutate Codex goal state.`;
}

async function buildCompletedGoalCleanupStopOutput(payload: CodexHookPayload, cwd: string): Promise<Record<string, unknown> | null> {
  const text = [
    safeString(payload.last_user_message ?? payload.lastUserMessage),
    safeString(payload.last_assistant_message ?? payload.lastAssistantMessage),
  ].join("\n");
  if (!looksLikeCompletedGoalCleanupAttempt(text)) return null;
  if (!hasFreshNativeGoalCleanupEvidence(text)) return null;
  const notice = await findCompletedGoalWorkflowCleanupNotice(cwd);
  if (!notice) return null;
  const systemMessage = `${notice} Do not continue into create_goal until cleanup is explicit; hooks only nudge and must not mutate Codex goal state.`;
  return {
    decision: "block",
    reason: systemMessage,
    stopReason: "completed_codex_goal_cleanup_required",
    systemMessage,
  };
}

async function findActiveGoalWorkflowReconciliationRequirement(cwd: string): Promise<{ workflow: string; command: string; remediation?: string } | null> {
  const ultragoal = await readJsonIfExists(join(cwd, ".omx", "ultragoal", "goals.json"));
  const aggregateCompletion = safeObject(ultragoal?.aggregateCompletion);
  const aggregateProductComplete = safeString(aggregateCompletion.status) === "complete";
  const ultragoals = Array.isArray(ultragoal?.goals) ? ultragoal.goals.map(safeObject) : [];
  const activeUltragoal = aggregateProductComplete
    ? undefined
    : ultragoals.find((goal) => safeString(goal.status) === "in_progress" || safeString(goal.id) === safeString(ultragoal?.activeGoalId));
  if (activeUltragoal && reportsBlockedUltragoalCompletedAggregateMicrogoalLoop(activeUltragoal)) {
    return null;
  }
  if (activeUltragoal) {
    const goalId = safeString(activeUltragoal.id) || "<goal-id>";
    return {
      workflow: "ultragoal",
      command: `omx ultragoal checkpoint --goal-id ${goalId} --status complete --codex-goal-json '<get_goal JSON or path>' --evidence '<evidence>'`,
      remediation: [
        `If get_goal returns a completed task-scoped objective for the same aggregate ultragoal plan, checkpoint ${goalId} with evidence naming ${goalId} plus .omx/ultragoal/goals.json or ledger.jsonl and pass final quality-gate JSON; OMX will reconcile the completed planned scope without mutating Codex goal state.`,
        `If get_goal instead returns a different completed legacy objective and complete checkpointing fails, do not repeat --status complete in this thread.`,
        `Record the non-terminal blocker with: omx ultragoal checkpoint --goal-id ${goalId} --status blocked --codex-goal-json '<different completed get_goal JSON or path>' --evidence '<completed legacy Codex goal blocks create_goal in this thread>'.`,
        `If get_goal itself is unavailable with a Codex DB/schema/context error such as "no such table: thread_goals", record an auditable safe-recovery blocker instead: omx ultragoal checkpoint --goal-id ${goalId} --status blocked --codex-goal-json '<unavailable get_goal error JSON or path>' --evidence '<get_goal unavailable due to Codex DB/schema/context error; safe recovery requires a working Codex goal context>'.`,
        "Then continue only from a Codex goal context with no active/completed conflicting goal in the same repo/worktree and create the intended goal there.",
      ].join(" "),
    };
  }

  const performanceRoot = join(cwd, ".omx", "goals", "performance");
  for (const entry of await readdir(performanceRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const state = await readJsonIfExists(join(performanceRoot, entry.name, "state.json"));
    const status = safeString(state?.status);
    if (reportsBlockedPerformanceGoalObjectiveMismatch(state)) {
      continue;
    }
    if (state?.workflow === "performance-goal" && status && status !== "complete") {
      return {
        workflow: "performance-goal",
        command: `omx performance-goal complete --slug ${safeString(state.slug) || entry.name} --codex-goal-json '<get_goal JSON or path>' --evidence '<evidence>'`,
      };
    }
  }

  const autoresearchRoot = join(cwd, ".omx", "goals", "autoresearch");
  for (const entry of await readdir(autoresearchRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const mission = await readJsonIfExists(join(autoresearchRoot, entry.name, "mission.json"));
    const status = safeString(mission?.status);
    const completion = await readJsonIfExists(join(autoresearchRoot, entry.name, "completion.json"));
    const completionVerdict = safeString(completion?.verdict);
    const completionPassed = completion?.passed === true || completionVerdict === "pass";
    if (
      mission?.workflow === "autoresearch-goal"
      && status
      && status !== "complete"
      && completionPassed
    ) {
      return {
        workflow: "autoresearch-goal",
        command: `omx autoresearch-goal complete --slug ${safeString(mission.slug) || entry.name} --codex-goal-json '<get_goal JSON or path>'`,
        remediation: [
          "If that command fails with a Codex goal objective mismatch after a refreshed get_goal snapshot, do not repeat the same complete command blindly in this thread.",
          "Either retry with a correct refreshed snapshot or record an explicit blocked verdict for this autoresearch-goal and continue from the explicit blocker path.",
        ].join(" "),
      };
    }
  }

  return null;
}

async function buildGoalWorkflowReconciliationPromptWarning(cwd: string, prompt: string): Promise<string | null> {
  if (!looksLikeGoalCompletionPrompt(prompt)) return null;
  const requirement = await findActiveGoalWorkflowReconciliationRequirement(cwd);
  if (!requirement) return null;
  return [
    `OMX ${requirement.workflow} goal workflow requires Codex goal snapshot reconciliation before completion.`,
    "Call get_goal, pass the resulting JSON or a path with --codex-goal-json, and do not rely on hooks or shell commands to mutate Codex-owned goal state.",
    `Required command shape: ${requirement.command}.`,
    requirement.remediation,
  ].filter(Boolean).join(" ");
}

async function buildGoalWorkflowReconciliationStopOutput(
  payload: CodexHookPayload,
  cwd: string,
): Promise<Record<string, unknown> | null> {
  const lastAssistantMessage = safeString(payload.last_assistant_message ?? payload.lastAssistantMessage);
  if (!looksLikeGoalCompletionPrompt(lastAssistantMessage)) return null;
  const requirement = await findActiveGoalWorkflowReconciliationRequirement(cwd);
  if (!requirement) return null;
  if (requirement.workflow === "autoresearch-goal" && reportsAutoresearchGoalObjectiveMismatch(lastAssistantMessage)) {
    return null;
  }
  const systemMessage =
    [
      `OMX ${requirement.workflow} requires get_goal snapshot reconciliation before completion; call get_goal and pass --codex-goal-json to ${requirement.command}.`,
      requirement.remediation,
      "Hooks must not mutate Codex goal state.",
    ].filter(Boolean).join(" ");
  return {
    decision: "block",
    reason: systemMessage,
    stopReason: `${requirement.workflow}_codex_goal_snapshot_required`,
    systemMessage,
  };
}

interface TeamModeStateForStop {
  state: Record<string, unknown>;
  scope: "session" | "root";
}

function teamStateMatchesThreadForStop(
  state: Record<string, unknown>,
  threadId?: string,
  options: { requireOwnerThread?: boolean } = {},
): boolean {
  const normalizedThreadId = safeString(threadId).trim();
  if (!normalizedThreadId) return true;

  const ownerThreadId = safeString(state.owner_codex_thread_id ?? state.thread_id).trim();
  if (!ownerThreadId) return options.requireOwnerThread !== true;
  return ownerThreadId === normalizedThreadId;
}

async function readTeamModeStateForStop(
  cwd: string,
  stateDir: string,
  sessionId?: string,
  threadId?: string,
): Promise<TeamModeStateForStop | null> {
  const normalizedSessionId = safeString(sessionId).trim();
  if (!normalizedSessionId) return null;

  const scopedState = await readStopSessionPinnedState("team-state.json", cwd, normalizedSessionId, stateDir);
  if (scopedState) {
    return teamStateMatchesThreadForStop(scopedState, threadId)
      ? { state: scopedState, scope: "session" }
      : null;
  }

  const rootState = await readJsonIfExists(join(stateDir, "team-state.json"));
  if (rootState?.active !== true) return null;

  const teamName = safeString(rootState.team_name).trim();
  if (!teamName) return null;

  const ownerSessionId = safeString(rootState.session_id).trim();
  if (!ownerSessionId || ownerSessionId !== normalizedSessionId) return null;
  if (!teamStateMatchesThreadForStop(rootState, threadId, { requireOwnerThread: true })) return null;

  return { state: rootState, scope: "root" };
}

async function buildTeamStopOutput(cwd: string, sessionId?: string, threadId?: string): Promise<Record<string, unknown> | null> {
  if (await readCanonicalTerminalRunStateForStop(cwd, sessionId, "team")) {
    return null;
  }
  const teamStateForStop = await readTeamModeStateForStop(cwd, getBaseStateDir(cwd), sessionId, threadId);
  if (!teamStateForStop || teamStateForStop.state.active !== true) return null;
  const teamState = teamStateForStop.state;
  const teamName = safeString(teamState.team_name).trim();
  if (teamName) {
    const canonicalTeamDir = join(resolveCanonicalTeamStateRoot(cwd), "team", teamName);
    if (!existsSync(canonicalTeamDir)) {
      return null;
    }
  }
  const coarsePhase = teamState.current_phase;
  const canonicalPhaseState = teamName ? await readTeamPhase(teamName, cwd) : null;
  if (teamStateForStop.scope === "root" && !canonicalPhaseState) return null;
  const canonicalPhase = canonicalPhaseState?.current_phase ?? coarsePhase;
  if (!isNonTerminalPhase(canonicalPhase)) return null;
  return buildTeamStopOutputForPhase(teamName, formatPhase(canonicalPhase));
}

function buildTeamStopReason(teamName: string, phase: string): string {
  const teamContext = teamName ? ` (${teamName})` : "";
  return `OMX team pipeline is still active${teamContext} at phase ${phase}; continue coordinating until the team reaches a terminal phase. If system-generated worker auto-checkpoint commits exist, rewrite them into Lore-format final commits before merge/finalization.`;
}

function buildTeamStopOutputForPhase(teamName: string, phase: string): Record<string, unknown> {
  return {
    decision: "block",
    reason: buildTeamStopReason(teamName, phase),
    stopReason: `team_${phase}`,
    systemMessage: `OMX team pipeline is still active at phase ${phase}.`,
  };
}

function extractStableFinalRecommendationSummary(message: string): string {
  for (const pattern of STABLE_FINAL_RECOMMENDATION_PATTERNS) {
    const match = pattern.exec(message);
    if (!match) continue;
    const summary = match[0]?.trim().replace(/\s+/g, " ");
    if (!summary) continue;
    return /[.!?]$/.test(summary) ? summary : `${summary}.`;
  }
  return "";
}

function buildStableFinalRecommendationStopSignature(
  payload: CodexHookPayload,
  teamName: string,
  summary: string,
): string {
  const sessionId = readPayloadSessionId(payload) || "no-session";
  const threadId = readPayloadThreadId(payload) || "no-thread";
  const normalizedSummary = normalizeAutoNudgeSignatureText(summary) || summary.toLowerCase();
  return ["release-readiness-finalize", sessionId, threadId, teamName, normalizedSummary].join("|");
}

function hasReleaseReadinessMode(payload: CodexHookPayload): boolean {
  const mode = safeString(payload.mode).trim().toLowerCase();
  return mode === "release-readiness";
}

async function hasReleaseReadinessStopMarker(
  cwd: string,
  stateDir: string,
  sessionId: string,
  teamName: string,
): Promise<boolean> {
  if (!sessionId) return false;

  const markerState = await readStopSessionPinnedState("release-readiness-state.json", cwd, sessionId, stateDir);
  if (markerState?.active !== true || markerState.stable_final_recommendation_emitted !== true) {
    return false;
  }

  const markerTeamName = safeString(markerState.team_name).trim();
  if (markerTeamName && markerTeamName !== teamName) return false;

  const markerSessionId = safeString(markerState.session_id).trim();
  if (markerSessionId && markerSessionId !== sessionId) return false;

  return true;
}

function readPayloadSessionId(payload: CodexHookPayload): string {
  return safeString(payload.session_id ?? payload.sessionId).trim();
}

function readPayloadThreadId(payload: CodexHookPayload): string {
  return safeString(payload.owner_codex_thread_id ?? payload.thread_id ?? payload.threadId).trim();
}

function readPayloadTurnId(payload: CodexHookPayload): string {
  return safeString(payload.turn_id ?? payload.turnId).trim();
}

interface NativeSubagentCapacityBlocker {
  schema_version: 1;
  reason: "agent_thread_limit_reached";
  session_id?: string;
  thread_id?: string;
  turn_id?: string;
  tool_name?: string;
  error_summary: string;
  observed_at: string;
  expires_at: string;
}

function nativeSubagentCapacityBlockerPath(stateDir: string): string {
  return join(stateDir, NATIVE_SUBAGENT_CAPACITY_BLOCKER_FILE);
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function payloadEvidenceText(payload: CodexHookPayload): string {
  return [
    safeString(payload.tool_name),
    stringifyUnknown(payload.tool_response),
    stringifyUnknown(payload.response),
    stringifyUnknown(payload.error),
    stringifyUnknown(payload.message),
  ].filter(Boolean).join("\n");
}

function isNativeSubagentCapacityFailure(payload: CodexHookPayload): boolean {
  const evidence = payloadEvidenceText(payload);
  if (!/\bagent thread limit reached\b/i.test(evidence)) return false;
  const toolName = safeString(payload.tool_name).trim();
  return !toolName || /(?:spawn_agent|multi_agent|subagent|collab|agent)/i.test(toolName);
}

function summarizeCapacityFailure(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "agent thread limit reached";
  const match = normalized.match(/[^.?!\n\r]*agent thread limit reached[^.?!\n\r]*/i);
  return (match?.[0] ?? normalized).slice(0, 500);
}

async function recordNativeSubagentCapacityBlocker(
  cwd: string,
  stateDir: string,
  payload: CodexHookPayload,
): Promise<void> {
  if (!isNativeSubagentCapacityFailure(payload)) return;
  const nowMs = Date.now();
  const blocker: NativeSubagentCapacityBlocker = {
    schema_version: 1,
    reason: "agent_thread_limit_reached",
    ...(readPayloadSessionId(payload) ? { session_id: readPayloadSessionId(payload) } : {}),
    ...(readPayloadThreadId(payload) ? { thread_id: readPayloadThreadId(payload) } : {}),
    ...(readPayloadTurnId(payload) ? { turn_id: readPayloadTurnId(payload) } : {}),
    ...(safeString(payload.tool_name).trim() ? { tool_name: safeString(payload.tool_name).trim() } : {}),
    error_summary: summarizeCapacityFailure(payloadEvidenceText(payload)),
    observed_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + NATIVE_SUBAGENT_CAPACITY_BLOCKER_TTL_MS).toISOString(),
  };
  await mkdir(stateDir, { recursive: true });
  await writeFile(nativeSubagentCapacityBlockerPath(stateDir), JSON.stringify({
    ...blocker,
    cwd,
  }, null, 2));
}

function isFreshNativeSubagentCapacityBlocker(
  blocker: Record<string, unknown> | null,
  cwd: string,
  payload: CodexHookPayload,
  nowMs = Date.now(),
): blocker is NativeSubagentCapacityBlocker & Record<string, unknown> {
  if (!blocker) return false;
  if (safeString(blocker.reason) !== "agent_thread_limit_reached") return false;
  const expiresAtMs = Date.parse(safeString(blocker.expires_at));
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return false;
  const blockerCwd = safeString(blocker.cwd).trim();
  if (blockerCwd) {
    try {
      if (resolve(blockerCwd) !== resolve(cwd)) return false;
    } catch {
      return false;
    }
  }
  const blockerSessionId = safeString(blocker.session_id).trim();
  const payloadSessionId = readPayloadSessionId(payload);
  return !blockerSessionId || !payloadSessionId || blockerSessionId === payloadSessionId;
}

function inputContainsCloseAgentRequest(value: unknown): boolean {
  if (typeof value === "string") return /\bclose_agent\b/i.test(value);
  if (!value || typeof value !== "object") return false;
  try {
    return /\bclose_agent\b/i.test(JSON.stringify(value));
  } catch {
    return false;
  }
}

function isCloseAgentToolUse(payload: CodexHookPayload): boolean {
  const toolName = safeString(payload.tool_name).trim();
  if (/\bclose_agent\b/i.test(toolName)) return true;
  if (/multi_tool_use\.parallel/i.test(toolName) && inputContainsCloseAgentRequest(payload.tool_input)) return true;
  return inputContainsCloseAgentRequest(payload.tool_input) && /multi_agent|agent|tool_use/i.test(toolName);
}

async function buildNativeSubagentCapacityCloseGuardOutput(
  payload: CodexHookPayload,
  cwd: string,
  stateDir: string,
): Promise<Record<string, unknown> | null> {
  if (!isCloseAgentToolUse(payload)) return null;
  const blocker = await readJsonIfExists(nativeSubagentCapacityBlockerPath(stateDir));
  if (!isFreshNativeSubagentCapacityBlocker(blocker, cwd, payload)) return null;

  const evidence = safeString(blocker.error_summary).trim() || "agent thread limit reached";
  return {
    decision: "block",
    reason: "Native subagent capacity was exhausted recently; model-level close_agent cleanup is blocked because close_agent can hang indefinitely on stale handles.",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        `OMX blocked ${safeString(payload.tool_name).trim() || "close_agent"} before it could start: a recent native subagent capacity failure was recorded (${evidence}). `
        + "Do not call multi_agent_v1.close_agent, and do not batch close_agent through multi_tool_use.parallel, as stale native handles can hang the whole turn. "
        + "Treat this as a bounded capacity blocker: persist/report the blocker evidence, avoid further native subagent cleanup from the model turn, and recover via runtime-level cleanup or a fresh Codex session.",
    },
  };
}

async function resolveInternalSessionIdForPayload(
  cwd: string,
  payloadSessionId: string,
  stateDir?: string,
): Promise<string> {
  const currentSession = stateDir
    ? await readUsableSessionStateFromStateDir(cwd, stateDir)
    : await readUsableSessionState(cwd);
  const canonicalSessionId = safeString(currentSession?.session_id).trim();
  if (!canonicalSessionId) return payloadSessionId;

  const nativeSessionId = safeString(currentSession?.native_session_id).trim();
  const ownerOmxSessionId = safeString(currentSession?.owner_omx_session_id).trim();
  if (!payloadSessionId) return canonicalSessionId;
  if (payloadSessionId === canonicalSessionId) return canonicalSessionId;
  if (nativeSessionId && payloadSessionId === nativeSessionId) return canonicalSessionId;
  if (ownerOmxSessionId && payloadSessionId === ownerOmxSessionId) return canonicalSessionId;
  return payloadSessionId;
}

async function readRootSessionStateFromStateDir(stateDir: string): Promise<SessionState | null> {
  const sessionPath = join(stateDir, "session.json");
  if (!existsSync(sessionPath)) return null;

  try {
    const content = await readFile(sessionPath, "utf-8");
    return JSON.parse(content) as SessionState;
  } catch {
    return null;
  }
}

function payloadMatchesSessionPointer(payloadSessionId: string, state: SessionState): boolean {
  const canonicalSessionId = safeString(state.session_id).trim();
  const nativeSessionId = safeString(state.native_session_id).trim();
  const ownerOmxSessionId = safeString(state.owner_omx_session_id).trim();
  if (!payloadSessionId) return true;
  return payloadSessionId === canonicalSessionId
    || (nativeSessionId !== "" && payloadSessionId === nativeSessionId)
    || (ownerOmxSessionId !== "" && payloadSessionId === ownerOmxSessionId);
}

function isRootSessionPointerLive(state: SessionState): boolean {
  const hasPidMetadata = Number.isInteger(state.pid) && state.pid > 0;
  if (!hasPidMetadata) return false;
  return !isSessionStale(state, {
    ...(state.platform ? { platform: state.platform } : {}),
  });
}

async function readLiveRootSessionPointerConflict(
  stateDir: string,
  payloadSessionId: string,
): Promise<SessionState | null> {
  if (!payloadSessionId) return null;
  const rootState = await readRootSessionStateFromStateDir(stateDir);
  if (!rootState) return null;
  if (payloadMatchesSessionPointer(payloadSessionId, rootState)) return null;
  if (!isRootSessionPointerLive(rootState)) return null;
  return rootState;
}

async function readUsableSessionStateFromStateDir(
  cwd: string,
  stateDir: string,
): Promise<SessionState | null> {
  const sessionPath = join(stateDir, "session.json");
  if (!existsSync(sessionPath)) return null;

  try {
    const content = await readFile(sessionPath, "utf-8");
    const state = JSON.parse(content) as SessionState;
    return isSessionStateUsable(state, cwd) ? state : null;
  } catch {
    return null;
  }
}

async function readStopSessionPinnedState(
  fileName: string,
  cwd: string,
  sessionId: string,
  stateDir?: string,
): Promise<Record<string, unknown> | null> {
  const statePath = stateDir && sessionId
    ? join(stateDir, "sessions", sessionId, fileName)
    : getStateFilePath(fileName, cwd, sessionId || undefined);
  return readJsonIfExists(statePath);
}

const DEEP_INTERVIEW_ALLOWED_WRITE_PREFIXES = [
  ".omx/context",
  ".omx/interviews",
  ".omx/specs",
  ".omx/state",
] as const;

const RALPLAN_ALLOWED_WRITE_PREFIXES = [
  ".omx/context",
  ".omx/plans",
  ".omx/specs",
  ".omx/state",
  ".beads",
] as const;

const PROTECTED_PLANNING_STATE_FILE_NAMES = new Set([
  "autopilot-state.json",
  "deep-interview-state.json",
  "ralplan-state.json",
  "skill-active-state.json",
]);

const PLANNING_MODE_IMPLEMENTATION_TOOL_NAMES = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
  "ApplyPatch",
]);

const DEEP_INTERVIEW_IMPLEMENTATION_TOOL_NAMES = PLANNING_MODE_IMPLEMENTATION_TOOL_NAMES;

const RALPLAN_EXECUTION_HANDOFF_SKILLS = new Set([
  // Autopilot is intentionally excluded: it supervises planning phases such as
  // ralplan/replan and is not by itself an execution authorization.
  "autoresearch",
  "ralph",
  "team",
  "ultragoal",
  "ultrawork",
  "ultraqa",
]);

function isActiveDeepInterviewPhase(state: Record<string, unknown> | null): boolean {
  if (!state || state.active !== true) return false;
  const mode = safeString(state.mode).trim();
  if (mode && mode !== "deep-interview") return false;
  const phase = safeString(state.current_phase ?? state.currentPhase).trim().toLowerCase();
  if (phase && (TERMINAL_MODE_PHASES.has(phase) || phase === "completing")) return false;
  return true;
}

function isActiveRalplanPhase(state: Record<string, unknown> | null): boolean {
  if (!state || state.active !== true) return false;
  const mode = safeString(state.mode).trim();
  if (mode && mode !== "ralplan") return false;
  const phase = safeString(state.current_phase ?? state.currentPhase).trim().toLowerCase();
  if (phase && (TERMINAL_MODE_PHASES.has(phase) || phase === "completing")) return false;
  return true;
}

function isAutopilotRalplanLikePhase(phase: string): boolean {
  return normalizeAutopilotPhase(phase) === "ralplan";
}

function canAutopilotSkillMirrorSupplyRalplanPhase(phase: string): boolean {
  return phase === "" || normalizeAutopilotPhase(phase) === "ralplan";
}

function isAutopilotReviewReworkPhase(phase: string): boolean {
  return normalizeAutopilotPhase(phase) === "rework";
}

function hasExplicitExecutionHandoffSkill(
  state: SkillActiveStateLike | null,
  sessionId: string,
  threadId: string,
): boolean {
  return listActiveSkills(state ?? {}).some((entry) => (
    RALPLAN_EXECUTION_HANDOFF_SKILLS.has(entry.skill)
    && matchesSkillStopContext(entry, state ?? {}, sessionId, threadId)
  ));
}

function normalizePlanningArtifactRelativePath(cwd: string, rawPath: string): string | null {
  const trimmed = rawPath.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed || trimmed.includes("\0")) return null;
  try {
    const absolute = resolve(cwd, trimmed);
    const relativePath = relative(cwd, absolute).replace(/\\/g, "/");
    if (!relativePath || relativePath.startsWith("..") || relativePath.startsWith("/")) return null;
    return relativePath;
  } catch {
    return null;
  }
}

function isProtectedPlanningStatePath(relativePath: string): boolean {
  if (relativePath !== ".omx/state" && !relativePath.startsWith(".omx/state/")) return false;
  const fileName = relativePath.split("/").pop() ?? "";
  return PROTECTED_PLANNING_STATE_FILE_NAMES.has(fileName);
}

function isAllowedPlanningArtifactPath(
  cwd: string,
  rawPath: string,
  allowedPrefixes: readonly string[],
): boolean {
  const relativePath = normalizePlanningArtifactRelativePath(cwd, rawPath);
  if (!relativePath) return false;
  if (isProtectedPlanningStatePath(relativePath)) return false;
  return allowedPrefixes.some((prefix) => (
    relativePath === prefix || relativePath.startsWith(`${prefix}/`)
  ));
}

function isAllowedDeepInterviewArtifactPath(cwd: string, rawPath: string): boolean {
  return isAllowedPlanningArtifactPath(cwd, rawPath, DEEP_INTERVIEW_ALLOWED_WRITE_PREFIXES);
}

function isAllowedRalplanArtifactPath(cwd: string, rawPath: string): boolean {
  return isAllowedPlanningArtifactPath(cwd, rawPath, RALPLAN_ALLOWED_WRITE_PREFIXES);
}

interface RalplanBeadsCommandClassification {
  present: boolean;
  allowed: boolean;
  reason?: string;
}

function shellTokenizeLiteralCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of command.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    if (/[;&|<>`$(){}\n\r]/.test(char)) return null;
    current += char;
  }

  if (escaping || quote) return null;
  if (current) tokens.push(current);
  return tokens;
}

function findLiteralBdExecutableIndex(tokens: string[]): number {
  if (tokens[0] === "bd") return 0;
  if (tokens[0] === "command" || tokens[0] === "builtin" || tokens[0] === "exec" || tokens[0] === "nohup") {
    return tokens[1] === "bd" ? 1 : -1;
  }
  if (tokens[0] !== "env") return -1;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "bd") return index;
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) continue;
    if (token.startsWith("-")) continue;
    return -1;
  }
  return -1;
}

function isAllowedRalplanBeadsDbPath(cwd: string, rawPath: string): boolean {
  const trimmed = rawPath.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed || trimmed.includes("\0")) return false;
  let relativePath: string;
  try {
    const absolute = resolve(cwd, trimmed);
    relativePath = relative(cwd, absolute).replace(/\\/g, "/");
  } catch {
    return false;
  }
  return relativePath.startsWith(".beads/") && relativePath.length > ".beads/".length;
}

function classifyRalplanBeadsMetadataCommand(cwd: string, command: string): RalplanBeadsCommandClassification {
  const trimmedCommand = command.trim();
  const startsWithBd = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"$`]*"|'[^']*'|[^\s"'$`;&|<>]+)\s+)*bd(?:\s|$)/.test(trimmedCommand);
  const hasCompoundBd = /[;&|()]\s*bd(?:\s|$)/.test(command);
  const tokens = shellTokenizeLiteralCommand(command);
  const bdExecutableIndex = tokens ? findLiteralBdExecutableIndex(tokens) : -1;
  if (!startsWithBd && !hasCompoundBd && bdExecutableIndex === -1) return { present: false, allowed: false };

  if (!tokens || bdExecutableIndex !== 0) {
    return { present: true, allowed: false, reason: "Beads tracker command must be a single literal bd invocation" };
  }

  let dbPath = "";
  let dbValueIndex = -1;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--db") {
      dbPath = tokens[index + 1] ?? "";
      dbValueIndex = index + 1;
      break;
    }
    if (token.startsWith("--db=")) {
      dbPath = token.slice("--db=".length);
      dbValueIndex = index;
      break;
    }
  }

  if (!dbPath) {
    return { present: true, allowed: false, reason: "Beads tracker command is missing a literal --db .beads/<db> target" };
  }
  if (!isAllowedRalplanBeadsDbPath(cwd, dbPath)) {
    return { present: true, allowed: false, reason: `Beads tracker db target ${dbPath} is outside repo-local .beads metadata` };
  }

  const operationTokens = tokens
    .slice(dbValueIndex + 1)
    .filter((token) => token && !token.startsWith("-"));
  const operation = operationTokens[0] ?? "";
  const suboperation = operationTokens[1] ?? "";
  if (["create", "update", "edit", "close", "reopen", "status", "dep"].includes(operation)) {
    return { present: true, allowed: true };
  }
  if (operation === "comments" && suboperation === "add") {
    return { present: true, allowed: true };
  }
  return {
    present: true,
    allowed: false,
    reason: operation
      ? `Beads tracker operation ${operation}${suboperation ? ` ${suboperation}` : ""} is not allowed during planning`
      : "Beads tracker command is missing an allowed metadata operation",
  };
}

function readPreToolUseCommand(payload: CodexHookPayload): string {
  const toolInput = safeObject(payload.tool_input);
  return safeString(toolInput.command).trim();
}

function readPreToolUsePathCandidates(payload: CodexHookPayload): string[] {
  const input = safeObject(payload.tool_input);
  const candidates = [
    input.file_path,
    input.filePath,
    input.path,
    input.target_path,
    input.targetPath,
  ];
  return candidates.map((candidate) => safeString(candidate).trim()).filter(Boolean);
}

const APPLY_PATCH_TOOL_NAMES = new Set(["apply_patch", "ApplyPatch"]);

function isApplyPatchToolName(toolName: string): boolean {
  return APPLY_PATCH_TOOL_NAMES.has(toolName);
}

function readApplyPatchText(payload: CodexHookPayload): string {
  const input = safeObject(payload.tool_input);
  for (const key of ["input", "patch", "content", "text", "command"]) {
    const value = safeString(input[key]).trim();
    if (value) return value;
  }
  return "";
}

function extractApplyPatchTargetPaths(patchText: string): string[] {
  if (!patchText) return [];
  const paths: string[] = [];
  for (const match of patchText.matchAll(/^\s*\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$/gm)) {
    const candidate = safeString(match[1]).trim();
    if (candidate) paths.push(candidate);
  }
  for (const match of patchText.matchAll(/^\s*\*\*\*\s+Move\s+to:\s*(.+?)\s*$/gm)) {
    const candidate = safeString(match[1]).trim();
    if (candidate) paths.push(candidate);
  }
  return paths;
}

function collectImplementationToolPathCandidates(
  payload: CodexHookPayload,
  toolName: string,
  structuredCandidates: string[],
): string[] {
  if (!isApplyPatchToolName(toolName)) return structuredCandidates;
  return [...structuredCandidates, ...extractApplyPatchTargetPaths(readApplyPatchText(payload))];
}

function isNullDeviceRedirectTarget(target: string): boolean {
  const normalized = target.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  return normalized === "/dev/null" || normalized === "nul";
}

// Collects same-command literal variable assignments (`NAME="value"`), skipping
// any value that involves expansion (`$`, backticks) so unresolved/dynamic
// targets stay conservatively blocked.
function extractCommandLiteralAssignments(command: string): Map<string, string> {
  const assignments = new Map<string, string>();
  const pattern = /(?:^|[\n;&|(]|&&|\|\|)\s*([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"$`]*)"|'([^']*)'|([^\s"'$`;&|<>]+))/g;
  for (const match of command.matchAll(pattern)) {
    const name = safeString(match[1]).trim();
    if (!name) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    assignments.set(name, value);
  }
  return assignments;
}

// Resolves a redirect/tee target of the form `$NAME`/`${NAME}` against
// same-command literal assignments; non-variable or unresolved targets are
// returned unchanged so they remain subject to the allowed-path check.
function resolveCommandRedirectTarget(target: string, assignments: Map<string, string>): string {
  const variableMatch = target.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
  if (!variableMatch) return target;
  const resolved = assignments.get(safeString(variableMatch[1]));
  return resolved !== undefined ? resolved : target;
}

function extractDeepInterviewCommandRedirectTargets(command: string): string[] {
  const targets: string[] = [];
  for (const match of command.matchAll(/(?:^|[^>])>{1,2}\s*(["']?)([^\s&|;<>]+)\1/g)) {
    const candidate = safeString(match[2]).trim();
    if (candidate && !isNullDeviceRedirectTarget(candidate)) targets.push(candidate);
  }
  return targets;
}

function commandHasDestructiveGitSubcommand(command: string): boolean {
  const destructiveSubcommands = new Set([
    "am",
    "apply",
    "checkout",
    "merge",
    "rebase",
    "reset",
    "restore",
    "switch",
  ]);

  for (const segment of splitShellCommandSegments(stripHeredocBodiesForCommandScan(command))) {
    const words = tokenizeShellWords(segment);
    for (let index = 0; index < words.length; index += 1) {
      if (shellWordBaseName(words[index] ?? "") !== "git") continue;
      const subcommandIndex = findGitSubcommandIndex(words, index + 1);
      if (subcommandIndex === null) continue;
      const subcommand = words[subcommandIndex] ?? "";
      if (destructiveSubcommands.has(subcommand)) return true;
      if (subcommand.startsWith("checkout-")) return true;
      if (subcommand.startsWith("merge-") && subcommand !== "merge-base") return true;
    }
  }
  return false;
}

function findGitSubcommandIndex(words: string[], startIndex: number): number | null {
  for (let index = startIndex; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word || word === "--") continue;
    if (isShellAssignmentWord(word)) continue;
    if (word === "-C" || word === "-c" || word === "--git-dir" || word === "--work-tree" || word === "--namespace") {
      index += 1;
      continue;
    }
    if (word.startsWith("--git-dir=") || word.startsWith("--work-tree=") || word.startsWith("--namespace=")) continue;
    if (word.startsWith("-")) continue;
    return index;
  }
  return null;
}

function commandHasDeepInterviewWriteIntent(command: string): boolean {
  return commandInvokesApplyPatch(command)
    || extractDeepInterviewCommandRedirectTargets(command).length > 0
    || /\btee\s+(?:-a\s+)?[^\s&|;]+/.test(command)
    || /\bsed\s+(?:[^\n;&|]*\s)?-i(?:\b|['"])/.test(command)
    || /\b(?:python3?|node|perl|ruby)\b[\s\S]{0,260}\b(?:writeFileSync|writeFile|write_text|open\([^)]*["']w|File\.write|Path\()/.test(command)
    || commandHasDestructiveGitSubcommand(command)
    || /\b(?:npm\s+(?:install|i|ci)|pnpm\s+(?:install|i)|yarn\s+(?:install|add))\b/.test(command);
}

function extractDeepInterviewCommandWriteTargets(command: string): string[] {
  const assignments = extractCommandLiteralAssignments(command);
  const targets = extractDeepInterviewCommandRedirectTargets(command)
    .map((target) => resolveCommandRedirectTarget(target, assignments));
  for (const segment of splitShellCommandSegments(command)) {
    const words = tokenizeShellWords(segment);
    for (let index = 0; index < words.length; index += 1) {
      if (shellWordBaseName(words[index] ?? "") !== "tee") continue;
      let afterDoubleDash = false;
      for (let targetIndex = index + 1; targetIndex < words.length; targetIndex += 1) {
        const word = words[targetIndex] ?? "";
        if (!word || word === "|" || word === "|&" || word === "&&" || word === "||" || word === ";") break;
        if (!afterDoubleDash && word === "--") {
          afterDoubleDash = true;
          continue;
        }
        if (!afterDoubleDash && word.startsWith("-")) continue;
        if (word === ">" || word === ">>" || word === ">&" || word === "<" || word === "<<" || word === "<<<") {
          targetIndex += 1;
          continue;
        }
        if (/^(?:>{1,2}|<)\S+/.test(word)) continue;
        if (!isNullDeviceRedirectTarget(word)) targets.push(resolveCommandRedirectTarget(word, assignments));
      }
    }
  }
  return targets;
}
function formatPlanningWriteBlockDetail(
  operationClass: string,
  target: string | undefined,
  allowedPrefixes: readonly string[],
): string {
  const targetDetail = target ? `target ${target}` : "target <unresolved>";
  return `${operationClass} ${targetDetail} is not under allowed planning artifact paths (${allowedPrefixes.join(", ")})`;
}

function isUnresolvedVariableTarget(target: string): boolean {
  const normalized = target.trim().replace(/^['"]|['"]$/g, "");
  return /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(normalized);
}

function normalizeSameCommandScriptTarget(
  cwd: string,
  rawPath: string,
  assignments: Map<string, string>,
): string | null {
  const trimmed = resolveCommandRedirectTarget(
    rawPath.trim().replace(/^['"]|['"]$/g, ""),
    assignments,
  );
  if (!trimmed || trimmed.includes("\0") || isUnresolvedVariableTarget(trimmed)) return null;
  try {
    return resolve(cwd, trimmed);
  } catch {
    return null;
  }
}

function normalizeCommandDirectoryTarget(rawPath: string): string | null {
  const trimmed = rawPath.trim().replace(/^['"]|['"]$/g, "");
  if (
    !trimmed
    || trimmed.includes("\0")
    || trimmed.startsWith("~")
    || trimmed.startsWith("-")
    || isUnresolvedVariableTarget(trimmed)
    || /[`$]/.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function isEnvCwdChangingOption(word: string): boolean {
  return word === "-C"
    || word === "--chdir"
    || word.startsWith("--chdir=")
    || /^-C.+/.test(word);
}

function resolveStateWriteInputFileCwd(cwd: string, commandPrefix: string): string | null {
  const words = tokenizeShellWords(stripHeredocBodiesForCommandScan(commandPrefix));
  let effectiveCwd = cwd;
  let activeWrapper: "env" | "npm" | "pnpm" | "yarn" | null = null;

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word || isShellAssignmentWord(word)) continue;

    const wordBase = shellWordBaseName(word);
    if (wordBase === "env" || wordBase === "npm" || wordBase === "pnpm" || wordBase === "yarn") {
      activeWrapper = wordBase;
      continue;
    }

    if (!activeWrapper) continue;

    const isEnvChdirOption = activeWrapper === "env" && isEnvCwdChangingOption(word);
    const isPackageManagerCwdOption =
      activeWrapper !== "env"
        && (word === "-C"
          || word === "--prefix"
          || word === "--dir"
          || word === "--cwd"
          || word.startsWith("--prefix=")
          || word.startsWith("--dir=")
          || word.startsWith("--cwd=")
          || /^-C.+/.test(word));

    if (isEnvChdirOption || isPackageManagerCwdOption) {
      let target = "";
      if (word === "-C" || word === "--chdir" || word === "--prefix" || word === "--dir" || word === "--cwd") {
        target = words[index + 1] ?? "";
      } else if (word.startsWith("--chdir=")) {
        target = word.slice("--chdir=".length);
      } else if (word.startsWith("--prefix=")) {
        target = word.slice("--prefix=".length);
      } else if (word.startsWith("--dir=")) {
        target = word.slice("--dir=".length);
      } else if (word.startsWith("--cwd=")) {
        target = word.slice("--cwd=".length);
      } else if (word.startsWith("-C") && word.length > 2) {
        target = word.slice(2);
      }
      const normalizedTarget = normalizeCommandDirectoryTarget(target);
      if (normalizedTarget === null) return null;
      effectiveCwd = resolve(effectiveCwd, normalizedTarget);
      if (word === "-C" || word === "--chdir" || word === "--prefix" || word === "--dir" || word === "--cwd") {
        index += 1;
      }
    }
  }

  return effectiveCwd;
}

function findShellFunctionDefinitionAt(command: string, index: number): { name: string; openBraceIndex: number; bodyOpenChar: "{" | "(" } | null {
  if (index > 0) {
    let previous = index - 1;
    while (previous >= 0 && /\s/.test(command[previous] ?? "")) previous -= 1;
    if (previous >= 0 && !/[;&|(){}]/.test(command[previous] ?? "")) return null;
  }

  let cursor = index;
  while (/\s/.test(command[cursor] ?? "")) cursor += 1;
  const candidate = command.slice(cursor);
  const functionKeywordMatch = candidate.match(/^function\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?\s*([\{(])/);
  if (functionKeywordMatch) {
    return {
      name: functionKeywordMatch[1],
      openBraceIndex: cursor + functionKeywordMatch[0].length - 1,
      bodyOpenChar: functionKeywordMatch[2] === "(" ? "(" : "{",
    };
  }
  const bareFunctionMatch = candidate.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*([\{(])/);
  if (bareFunctionMatch) {
    return {
      name: bareFunctionMatch[1],
      openBraceIndex: cursor + bareFunctionMatch[0].length - 1,
      bodyOpenChar: bareFunctionMatch[2] === "(" ? "(" : "{",
    };
  }
  return null;
}

function findShellFunctionBodyEnd(command: string, openBraceIndex: number, bodyOpenChar: "{" | "("): number {
  let depth = 1;
  let quote: "'" | "\"" | null = null;
  for (let index = openBraceIndex + 1; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) {
        quote = null;
      } else if (!quote) {
        quote = char;
      }
      continue;
    }
    if (quote) continue;
    if (bodyOpenChar === "{" && char === "{") {
      depth += 1;
      continue;
    }
    if (bodyOpenChar === "{" && char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
    if (bodyOpenChar === "(" && char === "(") {
      depth += 1;
      continue;
    }
    if (bodyOpenChar === "(" && char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function isShellFunctionInvokedLater(command: string, functionName: string): boolean {
  for (const segment of splitShellCommandSegments(command)) {
    const words = tokenizeShellWords(segment);
    if (isShellFunctionInvokedFromWords(words, 0, functionName)) return true;
  }
  return false;
}

function isShellFunctionInvokedFromWords(words: string[], startIndex: number, functionName: string): boolean {
  const index = skipShellCommandPositionPrefixWords(words, startIndex);
  const head = words[index] ?? "";
  if (head === functionName) return true;

  if (shellWordBaseName(head) === "time") {
    const timeOperandIndex = findTimeDispatchOperandIndex(words, index + 1);
    if (timeOperandIndex !== null) {
      const timeCommandIndex = skipShellCommandPositionPrefixWords(words, timeOperandIndex);
      if ((words[timeCommandIndex] ?? "") === functionName) return true;
    }
  }

  if (shellWordBaseName(head) === "coproc") {
    const coprocOperandIndex = findCoprocDispatchOperandIndex(words, index + 1);
    if (coprocOperandIndex !== null) {
      return isShellFunctionInvokedFromWords(words, coprocOperandIndex, functionName);
    }
  }

  if (shellWordBaseName(head) === "setsid") {
    const setsidOperandIndex = findCommandDispatchOperandIndex(words, index + 1);
    if (setsidOperandIndex !== null) {
      return isShellFunctionInvokedFromWords(words, setsidOperandIndex, functionName);
    }
  }

  if (shellWordBaseName(head) === "command") {
    const commandOperandIndex = findCommandDispatchOperandIndex(words, index + 1);
    if (commandOperandIndex !== null && shellWordBaseName(words[commandOperandIndex] ?? "") === "time") {
      return isShellFunctionInvokedFromWords(words, commandOperandIndex, functionName);
    }
  }

  return false;
}

function firstNonOptionSourceOperand(words: string[], sourceWordIndex: number): string {
  for (let index = sourceWordIndex + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word || word === "--") continue;
    if (word.startsWith("-")) continue;
    return word;
  }
  return "";
}

function firstShellScriptOperand(words: string[], shellWordIndex: number): string {
  for (let index = shellWordIndex + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word || word === "--") continue;
    if (isShellCommandStringOption(word)) return "";
    if (isShellOptionWithSeparateValue(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith("-")) continue;
    return word;
  }
  return "";
}

function sourcesFileWrittenEarlierInSameCommand(cwd: string, command: string): boolean {
  const scanCommand = (currentCommand: string, activeCommands: Set<string>, writtenTargets: Set<string>): boolean => {
    const normalizedCommand = stripHeredocBodiesForCommandScan(normalizeShellLineContinuations(currentCommand));
    const commandKey = normalizedCommand.trim();
    if (!commandKey || activeCommands.has(commandKey)) return false;

    const assignments = extractCommandLiteralAssignments(normalizedCommand);
    const nextActiveCommands = new Set(activeCommands);
    nextActiveCommands.add(commandKey);

    for (const segment of splitShellCommandSegments(normalizedCommand)) {
      const words = tokenizeShellWords(segment);
      for (let index = 0; index < words.length; index += 1) {
        const word = words[index] ?? "";
        const operand = word === "source" || word === "."
          ? normalizeSameCommandScriptTarget(cwd, firstNonOptionSourceOperand(words, index), assignments)
          : isNestedShellCommandWord(word)
            ? normalizeSameCommandScriptTarget(cwd, firstShellScriptOperand(words, index), assignments)
            : null;
        if (operand && writtenTargets.has(operand)) return true;
      }

      const commandWordIndex = findWrappedCommandPositionIndex(words, 0);
      const directExecutionTarget = commandWordIndex === null
        ? null
        : normalizeSameCommandScriptTarget(cwd, words[commandWordIndex] ?? "", assignments);
      if (directExecutionTarget && writtenTargets.has(directExecutionTarget)) return true;

      for (const nestedCommand of extractNestedShellCommandStringsForStateScan(segment)) {
        if (scanCommand(nestedCommand, nextActiveCommands, writtenTargets)) return true;
      }

      for (const target of extractDeepInterviewCommandWriteTargets(segment)) {
        const normalizedTarget = normalizeSameCommandScriptTarget(cwd, target, assignments);
        if (normalizedTarget) writtenTargets.add(normalizedTarget);
      }
    }

    return false;
  };

  return scanCommand(command, new Set(), new Set());
}


function describeImplementationToolBlock(
  toolName: string,
  blockedPath: string | undefined,
  pathCount: number,
): string {
  if (pathCount === 0) {
    const operationClass = isApplyPatchToolName(toolName) ? "apply_patch target extraction failed" : `${toolName} path`;
    return `${operationClass} target <unresolved>; only planning artifact paths are allowed (${RALPLAN_ALLOWED_WRITE_PREFIXES.join(", ")})`;
  }
  const operationClass = isApplyPatchToolName(toolName) ? "apply_patch target" : `${toolName} path`;
  return formatPlanningWriteBlockDetail(operationClass, blockedPath, RALPLAN_ALLOWED_WRITE_PREFIXES);
}

// `omx state` mutations normally route through the gate-enforcing `state_write`
// backend, so the hook defers to that gate rather than blocking the transport.
// The backend does NOT gate standalone deep-interview/ralplan *deactivation*,
// and it normalizes non-terminal tracked-workflow writes to `active=true`, so
// commands that would implicitly activate a tracked workflow while planning is
// still protected are blocked here. Broader backend authority belongs to a
// separate follow-up; this PR keeps the model/tool-originated guard at the
// native-hook transport boundary.
function readStateWriteInputPayload(
  cwd: string,
  command: string,
  sourceCommand: string = command,
): Record<string, unknown> | null {
  const stateWriteOperations = collectOmxStateCommandOperations(command, "write");
  if (stateWriteOperations.length === 0) return null;
  if (stateWriteOperations.length > 1) return null;

  const stateWriteOperation = stateWriteOperations[0];
  if (!stateWriteOperation) return null;
  const stateWriteArgs = stateWriteOperation.args;

  const mergeModeFlag = (payload: Record<string, unknown>): Record<string, unknown> => {
    const mode = readStateWriteFlagValue(stateWriteArgs, "--mode");
    return normalizeStateWriteClassificationPayload(mode ? { ...payload, mode } : payload);
  };

  const inlineInput = readStateWriteFlagValue(stateWriteArgs, "--input");
  const inputFile = readStateWriteFlagValue(stateWriteArgs, "--input-file");
  if (inlineInput !== undefined && inputFile !== undefined) return null;

  if (inlineInput !== undefined) {
    try {
      const parsed = JSON.parse(inlineInput);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? mergeModeFlag(parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  if (inputFile === undefined) return null;
  if (stateWriteOperation.nested) return null;
  if (hasPriorExecutableCommand(stateWriteOperation.prefix)) return null;

  const canonicalCommandPrefix = stateWriteOperation.commandPrefix || stateWriteOperation.prefix || "";
  const rawCommandPrefix = sourceCommand !== command
    ? (() => {
      const sourceCommandIndex = sourceCommand.lastIndexOf(command);
      return sourceCommandIndex >= 0 ? sourceCommand.slice(0, sourceCommandIndex) : "";
    })()
    : "";
  const resolvedInputFileCwd = resolveStateWriteInputFileCwd(cwd, canonicalCommandPrefix || rawCommandPrefix);
  if (resolvedInputFileCwd === null) return null;

  try {
    const raw = readFileSync(resolve(resolvedInputFileCwd, inputFile.trim()), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? mergeModeFlag(parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function envCommandHasCwdChangingOption(words: string[], startIndex: number): boolean {
  for (let index = startIndex; index < words.length; index += 1) {
    const token = words[index] ?? "";
    if (!token || token === "--") continue;
    if (isShellAssignmentWord(token)) continue;
    if (isEnvCwdChangingOption(token)) return true;
    if (token === "-S" || token === "--split-string" || token.startsWith("-S") || token.startsWith("--split-string=")) {
      return false;
    }
    if (token === "-u" || token === "--unset" || token === "-a" || token === "--argv0") {
      index += 1;
      continue;
    }
    if (token.startsWith("--unset=") || token.startsWith("--argv0=")) continue;
    if (/^-u.+/.test(token) || /^-a.+/.test(token)) continue;
    if (token.startsWith("-")) continue;
    return false;
  }
  return false;
}

function hasPriorExecutableCommand(commandPrefix: string): boolean {
  const words = tokenizeShellWords(stripHeredocBodiesForCommandScan(commandPrefix));
  let commandStart = true;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word) continue;
    if (word === "&&" || word === "||" || word === ";" || word === "&" || word === "|" || word === "|&") {
      commandStart = true;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    if (commandStart) return true;
    commandStart = false;
  }
  return false;
}

function tokenizeShellWords(segment: string): string[] {
  segment = normalizeShellLineContinuations(segment);
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (char === "\\" && quote !== "'") {
      index += 1;
      current += segment[index] ?? "";
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) {
        quote = null;
      } else if (!quote) {
        quote = char;
      } else {
        current += char;
      }
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    if (!quote && (char === "(" || char === ")" || char === "{" || char === "}")) {
      if (current) {
        words.push(current);
        current = "";
      }
      words.push(char);
      continue;
    }
    if (!quote && char === "|") {
      if (current) {
        words.push(current);
        current = "";
      }
      const next = segment[index + 1] ?? "";
      if (next === "&" || next === "|") {
        words.push(`${char}${next}`);
        index += 1;
      } else {
        words.push(char);
      }
      continue;
    }
    if (!quote && (char === "<" || char === ">")) {
      if (current) {
        words.push(current);
        current = "";
      }
      const next = segment[index + 1] ?? "";
      if (next === char) {
        const third = segment[index + 2] ?? "";
        if (char === "<" && third === "<") {
          words.push("<<<");
          index += 2;
        } else {
          words.push(`${char}${next}`);
          index += 1;
        }
      } else if (char === ">" && next === "&") {
        words.push(">&");
        index += 1;
      } else {
        words.push(char);
      }
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

function isOmxCliEntryPath(token: string, runtimeWrapper: string | null): boolean {
  const trimmed = token.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed || trimmed.includes("\0")) return false;

  const normalized = trimmed.replace(/\\/g, "/");
  const entryBasename = normalized.split("/").filter(Boolean).pop() ?? "";
  if (entryBasename === "omx" || entryBasename === "omx.js") return true;
  if (normalized.endsWith("/node_modules/.bin/omx") || normalized === "node_modules/.bin/omx") return true;
  if (normalized.endsWith("/dist/cli/omx.js") || normalized === "dist/cli/omx.js") return true;
  if (runtimeWrapper === "tsx" && (normalized.endsWith("/src/cli/omx.ts") || normalized === "src/cli/omx.ts")) return true;
  if (runtimeWrapper === "tsx" && (normalized.endsWith("/dist/cli/omx.js") || normalized === "dist/cli/omx.js")) return true;
  return false;
}

function extractEnvSplitStringCommand(words: string[], startIndex: number): string {
  for (let index = startIndex; index < words.length; index += 1) {
    const token = words[index] ?? "";
    if (!token) continue;
    if (token === "-S" || token === "--split-string") {
      const operand = words[index + 1] ?? "";
      if (!operand) return "";
      const tail = words.slice(index + 2).join(" ");
      return tail ? `env ${operand} ${tail}` : `env ${operand}`;
    }
    if (token.startsWith("--split-string=") || (token.startsWith("-S") && token.length > 2)) {
      const operand = token.startsWith("--split-string=")
        ? token.slice("--split-string=".length)
        : token.slice(2);
      if (!operand) return "";
      const tail = words.slice(index + 1).join(" ");
      return tail ? `env ${operand} ${tail}` : `env ${operand}`;
    }
    if (isShellAssignmentWord(token)) continue;
    if (token === "-u" || token === "--unset" || token === "-C" || token === "--chdir" || token === "-a" || token === "--argv0") {
      index += 1;
      continue;
    }
    if (token.startsWith("--unset=") || token.startsWith("--chdir=") || token.startsWith("--argv0=")) continue;
    if (/^-u.+/.test(token) || /^-C.+/.test(token) || /^-a.+/.test(token)) continue;
    if (token.startsWith("-")) continue;
    break;
  }
  return "";
}

function extractPackageManagerExecCommand(command: string, words: string[], startIndex: number, headBase: string): string {
  let index = startIndex;
  if (headBase === "npm" || headBase === "pnpm" || headBase === "yarn") {
    const subcommandIndex = findPackageManagerExecSubcommandIndex(words, startIndex, headBase);
    if (subcommandIndex === null) return "";
    index = subcommandIndex + 1;
  } else if (headBase !== "npx" && headBase !== "pnpx") {
    return "";
  }

  for (; index < words.length; index += 1) {
    const token = words[index] ?? "";
    if (!token) continue;
    if (token === "--") {
      const tail = sliceShellWordsTailPreservingQuoting(command, index + 1);
      return tail || "";
    }
    if (isShellAssignmentWord(token)) continue;
    if (token === "-c" || token === "--call") {
      return words[index + 1] ?? "";
    }
    if (token.startsWith("-c") && token.length > 2) return token.slice(2);
    if (token.startsWith("--call=")) return token.slice("--call=".length);
    if (token === "--package" || token === "-w" || token === "--workspace" || token === "--allow-scripts") {
      index += 1;
      continue;
    }
    if (token.startsWith("--package=") || token.startsWith("--workspace=") || token.startsWith("--allow-scripts=")) continue;
    if (token.startsWith("-w") && token.length > 2) continue;
    if (token.startsWith("-")) continue;
    const tail = sliceShellWordsTailPreservingQuoting(command, index);
    return tail || "";
  }
  return "";
}

function findPackageManagerExecSubcommandIndex(words: string[], startIndex: number, headBase: string): number | null {
  for (let index = startIndex; index < words.length; index += 1) {
    const token = words[index] ?? "";
    if (!token) continue;
    if (isShellAssignmentWord(token)) continue;
    if (token === "-C" || token === "--prefix" || token === "--dir" || token === "-w" || token === "--workspace" || token === "--package" || token === "--allow-scripts") {
      index += 1;
      continue;
    }
    if (token.startsWith("--prefix=") || token.startsWith("--dir=") || token.startsWith("--workspace=") || token.startsWith("--package=") || token.startsWith("--allow-scripts=")) continue;
    if (/^-C.+/.test(token) || /^-w.+/.test(token)) continue;
    if (token.startsWith("-")) continue;
    if (token === "exec" || (headBase === "npm" && token === "x") || ((headBase === "pnpm" || headBase === "yarn") && token === "dlx")) {
      return index;
    }
    return null;
  }
  return null;
}

function unwrapOmxStateTransportCommandOnce(command: string): string | null {
  const words = tokenizeShellWords(normalizeShellLineContinuations(command).trim());
  if (words.length === 0) return null;

  let index = 0;
  while (index < words.length && isShellAssignmentWord(words[index] ?? "")) index += 1;
  if (index >= words.length) return null;

  const head = words[index] ?? "";
  if (!head) return null;
  const headBase = shellWordBaseName(head);

  if (headBase === "command" || headBase === "builtin" || headBase === "exec" || headBase === "nohup" || headBase === "setsid") {
    let remainderIndex = index + 1;
    while (remainderIndex < words.length) {
      const token = words[remainderIndex] ?? "";
      if (!token) {
        remainderIndex += 1;
        continue;
      }
      if (token === "--") {
        remainderIndex += 1;
        continue;
      }
      if (head === "exec" && token === "-a") {
        remainderIndex += 2;
        continue;
      }
      if (token.startsWith("-")) {
        remainderIndex += 1;
        continue;
      }
      break;
    }
    const remainder = sliceShellWordsTailPreservingQuoting(command, remainderIndex);
    return remainder || null;
  }

  if (headBase === "env") {
    if (envCommandHasCwdChangingOption(words, index + 1)) {
      return null;
    }
    const splitOperand = extractEnvSplitStringCommand(words, index + 1);
    if (splitOperand) {
      return splitOperand;
    }
    const envCommandIndex = findEnvDispatchOperandIndex(words, index + 1);
    if (envCommandIndex !== null) {
      const remainder = sliceShellWordsTailPreservingQuoting(command, envCommandIndex);
      return remainder || null;
    }
    const remainder = sliceShellWordsTailPreservingQuoting(command, index + 1);
    return remainder || null;
  }

  if (headBase === "time") {
    const operandIndex = findTimeDispatchOperandIndex(words, index + 1);
    if (operandIndex !== null) {
      const remainder = sliceShellWordsTailPreservingQuoting(command, operandIndex);
      return remainder || null;
    }
    return null;
  }

  if (headBase === "nice") {
    const operandIndex = findNiceDispatchOperandIndex(words, index + 1);
    if (operandIndex !== null) {
      const remainder = sliceShellWordsTailPreservingQuoting(command, operandIndex);
      return remainder || null;
    }
    return null;
  }

  if (headBase === "stdbuf") {
    const operandIndex = findStdbufDispatchOperandIndex(words, index + 1);
    if (operandIndex !== null) {
      const remainder = sliceShellWordsTailPreservingQuoting(command, operandIndex);
      return remainder || null;
    }
    return null;
  }

  if (headBase === "npm" || headBase === "pnpm" || headBase === "yarn" || headBase === "npx" || headBase === "pnpx") {
    const packageManagerCommand = extractPackageManagerExecCommand(command, words, index + 1, headBase);
    if (packageManagerCommand) {
      return packageManagerCommand;
    }
  }

  if (isNestedShellCommandWord(headBase)) {
    const commandStringIndex = findShellCommandStringArgIndex(words, index + 1);
    if (commandStringIndex !== null) {
      const nestedCommand = words[commandStringIndex] ?? "";
      if (nestedCommand && !isDynamicNestedCommandString(nestedCommand)) {
        const remainder = sliceShellWordsTailPreservingQuoting(command, commandStringIndex + 1);
        return remainder ? `${nestedCommand} ${remainder}` : nestedCommand;
      }
    }
  }

  if (headBase === "eval") {
    const nestedCommand = words.slice(index + 1).join(" ");
    if (nestedCommand && !isDynamicNestedCommandString(nestedCommand)) return nestedCommand;
  }

  if (headBase === "node" || headBase === "bun" || headBase === "tsx") {
    const entryIndex = (() => {
      for (let candidateIndex = index + 1; candidateIndex < words.length; candidateIndex += 1) {
        const candidate = words[candidateIndex] ?? "";
        if (!candidate) continue;
        if (candidate.startsWith("-")) continue;
        return candidateIndex;
      }
      return -1;
    })();
    if (entryIndex >= 0) {
      const entryPath = words[entryIndex] ?? "";
      if (entryPath && isOmxCliEntryPath(entryPath, headBase)) {
        const remainder = sliceShellWordsTailPreservingQuoting(command, entryIndex + 1);
        return remainder ? `omx ${remainder}` : "omx";
      }
    }
    return null;
  }

  if (isOmxCliEntryPath(head, null)) {
    const remainder = sliceShellWordsTailPreservingQuoting(command, index + 1);
    return remainder ? `omx ${remainder}` : "omx";
  }

  return null;
}

function canonicalizeOmxStateTransportCommand(command: string): string {
  let current = normalizeShellLineContinuations(command).trim();
  for (let passes = 0; passes < 8; passes += 1) {
    const next = unwrapOmxStateTransportCommandOnce(current);
    if (!next || next === current) return current;
    current = next.trim();
  }
  return current;
}

function sliceShellWordsTailPreservingQuoting(command: string, startWordIndex: number): string | null {
  const normalized = normalizeShellLineContinuations(command);
  let quote: "'" | "\"" | null = null;
  let wordIndex = 0;
  let currentWordStart: number | null = null;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? "";
    if (char === "\\" && quote !== "'") {
      if (currentWordStart === null) currentWordStart = index;
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) {
        quote = null;
      } else if (!quote) {
        quote = char;
        if (currentWordStart === null) currentWordStart = index;
      } else if (currentWordStart === null) {
        currentWordStart = index;
      }
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (currentWordStart !== null) {
        if (wordIndex === startWordIndex) return normalized.slice(currentWordStart);
        wordIndex += 1;
        currentWordStart = null;
      }
      continue;
    }
    if (currentWordStart === null) currentWordStart = index;
  }

  if (currentWordStart !== null && wordIndex === startWordIndex) {
    return normalized.slice(currentWordStart);
  }
  return null;
}

function normalizeShellLineContinuations(command: string): string {
  let normalized = "";
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "'" || char === "\"") {
      if (quote === char) {
        quote = null;
      } else if (!quote) {
        quote = char;
      }
      normalized += char;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      const next = command[index + 1] ?? "";
      if (next === "\r" && command[index + 2] === "\n") {
        index += 2;
        continue;
      }
      if (next === "\n") {
        index += 1;
        continue;
      }
    }
    normalized += char;
  }
  return normalized;
}

function readStateWriteFlagValue(args: string[], flagName: "--input" | "--input-file" | "--mode"): string | undefined {
  let value: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === flagName) {
      value = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith(`${flagName}=`)) value = arg.slice(flagName.length + 1);
  }
  return value;
}

interface OmxStateCommandOperation {
  args: string[];
  prefix: string;
  commandPrefix: string;
  nested: boolean;
}

interface StateScanSegment {
  segment: string;
  prefix: string;
}

function shellWordBaseName(word: string): string {
  return word.replace(/\\/g, "/").split("/").pop() ?? word;
}

function isOmxCliWrapperRuntime(word: string): boolean {
  const base = shellWordBaseName(word);
  return base === "node" || base === "bun" || base === "tsx";
}

function isOmxCliWrapperScript(word: string): boolean {
  const base = shellWordBaseName(word);
  return base === "omx" || base === "omx.js";
}

function runtimeOptionConsumesNextWord(option: string): boolean {
  return option === "-r"
    || option === "--require"
    || option === "--import"
    || option === "--loader"
    || option === "--experimental-loader"
    || option === "--env-file"
    || option === "--conditions"
    || option === "--title"
    || option === "-C";
}

function runtimeOptionIsInlineCode(option: string): boolean {
  return option === "-e"
    || option === "--eval"
    || option.startsWith("--eval=")
    || option === "-p"
    || option === "--print"
    || option.startsWith("--print=");
}

function findOmxCliWrapperRuntimeScriptIndex(words: string[]): number | null {
  if (!isOmxCliWrapperRuntime(words[0] ?? "")) return null;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word) continue;
    if (word === "--") continue;
    if (runtimeOptionIsInlineCode(word)) return null;
    if (runtimeOptionConsumesNextWord(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith("-r") && word.length > 2) continue;
    if (word.startsWith("--") && word.includes("=")) continue;
    if (word.startsWith("-")) continue;
    return isOmxCliWrapperScript(word) ? index : null;
  }
  return null;
}

function readOmxStateCommandArgsFromWords(words: string[], operation: "write" | "clear"): string[] | null {
  if (isOmxCliWrapperScript(words[0] ?? "") && words[1] === "state" && words[2] === operation) {
    return words.slice(3);
  }
  const runtimeScriptIndex = findOmxCliWrapperRuntimeScriptIndex(words);
  if (runtimeScriptIndex !== null && words[runtimeScriptIndex + 1] === "state" && words[runtimeScriptIndex + 2] === operation) {
    return words.slice(runtimeScriptIndex + 3);
  }
  return null;
}

// Shell compound-command introducers can occupy command position after wrappers
// such as `time`/`command`; skip them before matching the protected `omx state`
// operation so wrapper-unwrapping keeps scanning the actual command body.
function isShellCommandPositionPrefixWord(word: string): boolean {
  return word === "("
    || word === "{"
    || word === "!"
    || word === "if"
    || word === "then"
    || word === "else"
    || word === "elif"
    || word === "do"
    || word === "while"
    || word === "until";
}

function findEnvDispatchOperandIndex(words: string[], startIndex: number): number | null {
  for (let index = startIndex; index < words.length; index += 1) {
    const option = words[index] ?? "";
    if (!option || option === "--") continue;
    if (isShellAssignmentWord(option)) continue;
    if (option === "-S" || option === "--split-string" || option.startsWith("-S") || option.startsWith("--split-string=")) {
      return null;
    }
    if (option === "-u" || option === "--unset" || option === "-C" || option === "--chdir" || option === "-a" || option === "--argv0") {
      index += 1;
      continue;
    }
    if (option.startsWith("--unset=") || option.startsWith("--chdir=") || option.startsWith("--argv0=")) continue;
    if (/^-u.+/.test(option) || /^-C.+/.test(option) || /^-a.+/.test(option)) continue;
    if (option.startsWith("-")) continue;
    return index;
  }
  return null;
}

function findCommandDispatchOperandIndex(words: string[], startIndex: number): number | null {
  for (let index = startIndex; index < words.length; index += 1) {
    const option = words[index] ?? "";
    if (!option || option === "--") continue;
    if (isShellAssignmentWord(option)) continue;
    if (option.startsWith("-")) continue;
    return index;
  }
  return null;
}

function findExecDispatchOperandIndex(words: string[], startIndex: number): number | null {
  for (let index = startIndex; index < words.length; index += 1) {
    const option = words[index] ?? "";
    if (!option || option === "--") continue;
    if (isShellAssignmentWord(option)) continue;
    if (option === "-a") {
      index += 1;
      continue;
    }
    if (option.startsWith("-")) continue;
    return index;
  }
  return null;
}

function findTimeDispatchOperandIndex(words: string[], startIndex: number): number | null {
  for (let index = startIndex; index < words.length; index += 1) {
    const option = words[index] ?? "";
    if (!option || option === "--") continue;
    if (isShellAssignmentWord(option)) continue;
    if (option === "-f" || option === "--format" || option === "-o" || option === "--output") {
      index += 1;
      continue;
    }
    if (option.startsWith("--format=") || option.startsWith("--output=")) continue;
    if (/^-[^-]/.test(option)) {
      const shortOptions = option.slice(1);
      const lastValueOptionIndex = Math.max(shortOptions.lastIndexOf("f"), shortOptions.lastIndexOf("o"));
      if (lastValueOptionIndex >= 0 && lastValueOptionIndex === shortOptions.length - 1) {
        index += 1;
      }
      continue;
    }
    if (option.startsWith("-")) continue;
    return index;
  }
  return null;
}

function findTimeoutDispatchOperandIndex(words: string[], startIndex: number): number | null {
  let durationSeen = false;
  for (let index = startIndex; index < words.length; index += 1) {
    const token = words[index] ?? "";
    if (!token || token === "--") continue;
    if (isShellAssignmentWord(token)) continue;
    if (!durationSeen) {
      if (
        token === "-k"
        || token === "--kill-after"
        || token === "-s"
        || token === "--signal"
        || token.startsWith("--kill-after=")
        || token.startsWith("--signal=")
        || token.startsWith("-k")
        || token.startsWith("-s")
      ) {
        if (
          token === "-k"
          || token === "--kill-after"
          || token === "-s"
          || token === "--signal"
        ) {
          index += 1;
        }
        continue;
      }
      if (
        token === "-f"
        || token === "--foreground"
        || token === "-p"
        || token === "--preserve-status"
        || token === "-v"
        || token === "--verbose"
      ) {
        continue;
      }
      if (token.startsWith("-")) continue;
      durationSeen = true;
      continue;
    }
    return index;
  }
  return null;
}

function findNiceDispatchOperandIndex(words: string[], startIndex: number): number | null {
  for (let index = startIndex; index < words.length; index += 1) {
    const token = words[index] ?? "";
    if (!token || token === "--") continue;
    if (isShellAssignmentWord(token)) continue;
    if (token === "-n" || token === "--adjustment") {
      index += 1;
      continue;
    }
    if (token.startsWith("--adjustment=") || /^-n.+/.test(token)) continue;
    if (token.startsWith("-")) continue;
    return index;
  }
  return null;
}

function findStdbufDispatchOperandIndex(words: string[], startIndex: number): number | null {
  for (let index = startIndex; index < words.length; index += 1) {
    const token = words[index] ?? "";
    if (!token || token === "--") continue;
    if (isShellAssignmentWord(token)) continue;
    if (token === "-i" || token === "-o" || token === "-e" || token === "--input" || token === "--output" || token === "--error") {
      index += 1;
      continue;
    }
    if (
      token.startsWith("--input=")
      || token.startsWith("--output=")
      || token.startsWith("--error=")
      || /^-[ioe].+/.test(token)
    ) {
      continue;
    }
    if (token.startsWith("-")) continue;
    return index;
  }
  return null;
}

function isXargsOptionWithNextValue(option: string): boolean {
  return option === "-a"
    || option === "--arg-file"
    || option === "-d"
    || option === "--delimiter"
    || option === "-E"
    || option === "--eof"
    || option === "-I"
    || option === "--replace"
    || option === "-J"
    || option === "-L"
    || option === "--max-lines"
    || option === "-n"
    || option === "--max-args"
    || option === "-P"
    || option === "--max-procs"
    || option === "-s"
    || option === "--max-chars";
}

function isXargsStandaloneOption(option: string): boolean {
  return option === "-0"
    || option === "--null"
    || option === "-r"
    || option === "--no-run-if-empty"
    || option === "-t"
    || option === "--verbose"
    || option === "-p"
    || option === "--interactive"
    || option === "-x"
    || option === "--exit"
    || option === "-o"
    || option === "--open-tty"
    || option === "--show-limits";
}

function findXargsDispatchOperandIndex(words: string[], startIndex: number): number | null {
  for (let index = startIndex; index < words.length; index += 1) {
    const option = words[index] ?? "";
    if (!option || option === "--") continue;
    if (isShellAssignmentWord(option)) continue;
    if (isXargsOptionWithNextValue(option)) {
      index += 1;
      continue;
    }
    if (
      option.startsWith("--arg-file=")
      || option.startsWith("--delimiter=")
      || option.startsWith("--eof=")
      || option.startsWith("--replace=")
      || option.startsWith("--max-lines=")
      || option.startsWith("--max-args=")
      || option.startsWith("--max-procs=")
      || option.startsWith("--max-chars=")
      || /^-[aAdDEIJLnPs][^-\s]*$/.test(option)
    ) {
      continue;
    }
    if (isXargsStandaloneOption(option)) continue;
    if (option.startsWith("-")) continue;
    return index;
  }
  return null;
}

function findCoprocDispatchOperandIndex(words: string[], startIndex: number): number | null {
  const firstIndex = findDispatchWordIndex(words, startIndex);
  if (firstIndex === null) return null;
  const firstWord = words[firstIndex] ?? "";
  if (isShellCommandPositionPrefixWord(firstWord)) return firstIndex;

  const secondIndex = findDispatchWordIndex(words, firstIndex + 1);
  if (secondIndex !== null && isShellCommandPositionPrefixWord(words[secondIndex] ?? "")) {
    return secondIndex;
  }
  return firstIndex;
}

function findCaseArmCommandIndex(words: string[], startIndex: number): number | null {
  let index = startIndex;
  while (index < words.length && isShellAssignmentWord(words[index] ?? "")) index += 1;
  const head = words[index] ?? "";
  if (!head) return null;

  if (head === "case") {
    let inIndex = -1;
    for (let scanIndex = index + 1; scanIndex < words.length; scanIndex += 1) {
      const token = words[scanIndex] ?? "";
      if (!token) continue;
      if (token === "in") {
        inIndex = scanIndex;
        break;
      }
      if (token === "esac") return null;
    }
    if (inIndex < 0) return null;
    for (let scanIndex = inIndex + 1; scanIndex < words.length; scanIndex += 1) {
      const token = words[scanIndex] ?? "";
      if (!token) continue;
      if (token === "esac") return null;
      if (token === ")" || token.endsWith(")")) return scanIndex + 1;
    }
    return null;
  }

  if (head === ")" || head.endsWith(")")) {
    return index + 1;
  }

  if (words[index + 1] === ")") {
    return index + 2;
  }

  return null;
}

function isShellRedirectionWord(word: string): boolean {
  return word === ">"
    || word === ">>"
    || word === "<"
    || word === "<<"
    || word === "<<<"
    || word === ">&"
    || word === "<&";
}

function skipShellCommandPositionPrefixWords(words: string[], startIndex: number): number {
  let commandWordIndex = startIndex;
  while (
    isShellAssignmentWord(words[commandWordIndex] ?? "")
    || isShellCommandPositionPrefixWord(words[commandWordIndex] ?? "")
  ) {
    commandWordIndex += 1;
  }
  while (commandWordIndex < words.length) {
    const word = words[commandWordIndex] ?? "";
    const nextWord = words[commandWordIndex + 1] ?? "";
    if (isShellRedirectionWord(word)) {
      commandWordIndex += 2;
      continue;
    }
    if (/^\d+$/.test(word) && isShellRedirectionWord(nextWord)) {
      commandWordIndex += 3;
      continue;
    }
    break;
  }
  return commandWordIndex;
}

function findWrappedCommandPositionIndex(words: string[], startIndex: number): number | null {
  let commandWordIndex = skipShellCommandPositionPrefixWords(words, startIndex);
  for (let unwrapCount = 0; unwrapCount < 8; unwrapCount += 1) {
    const commandWord = words[commandWordIndex] ?? "";
    if (!commandWord) return null;

    const commandWordBase = shellWordBaseName(commandWord);
    const operandIndex =
      commandWordBase === "env"
        ? findEnvDispatchOperandIndex(words, commandWordIndex + 1)
        : commandWordBase === "command"
          ? findCommandDispatchOperandIndex(words, commandWordIndex + 1)
          : commandWordBase === "exec"
            ? findExecDispatchOperandIndex(words, commandWordIndex + 1)
            : commandWordBase === "time"
              ? findTimeDispatchOperandIndex(words, commandWordIndex + 1)
              : commandWordBase === "timeout"
                ? findTimeoutDispatchOperandIndex(words, commandWordIndex + 1)
                : commandWordBase === "nohup"
                  ? findCommandDispatchOperandIndex(words, commandWordIndex + 1)
                  : commandWordBase === "coproc"
                    ? findCoprocDispatchOperandIndex(words, commandWordIndex + 1)
                    : commandWordBase === "xargs"
                      ? findXargsDispatchOperandIndex(words, commandWordIndex + 1)
                      : commandWordBase === "nice"
                        ? findNiceDispatchOperandIndex(words, commandWordIndex + 1)
                        : commandWordBase === "stdbuf"
                          ? findStdbufDispatchOperandIndex(words, commandWordIndex + 1)
                          : null;
    if (operandIndex === null) return commandWordIndex;

    const nextCommandWordIndex = skipShellCommandPositionPrefixWords(words, operandIndex);
    if (nextCommandWordIndex === commandWordIndex) return commandWordIndex;
    commandWordIndex = nextCommandWordIndex;
  }

  return null;
}

function readOmxStateCommandFromSegmentWords(
  words: string[],
  operation: "write" | "clear",
): { args: string[]; commandWords: string[]; prefixWords: string[] } | null {
  let commandWordIndex = skipShellCommandPositionPrefixWords(words, 0);

  for (let unwrapCount = 0; unwrapCount < 8; unwrapCount += 1) {
    commandWordIndex = skipShellCommandPositionPrefixWords(words, commandWordIndex);
    const caseArmCommandIndex = findCaseArmCommandIndex(words, commandWordIndex);
    if (caseArmCommandIndex !== null) {
      commandWordIndex = skipShellCommandPositionPrefixWords(words, caseArmCommandIndex);
    }
    const directArgs = readOmxStateCommandArgsFromWords(words.slice(commandWordIndex), operation);
    if (directArgs) {
      return {
        args: directArgs,
        commandWords: words.slice(commandWordIndex),
        prefixWords: words.slice(0, commandWordIndex),
      };
    }

    const commandWord = words[commandWordIndex] ?? "";
    const operandIndex =
      shellWordBaseName(commandWord) === "env"
        ? findEnvDispatchOperandIndex(words, commandWordIndex + 1)
        : shellWordBaseName(commandWord) === "command"
          ? findCommandDispatchOperandIndex(words, commandWordIndex + 1)
          : shellWordBaseName(commandWord) === "exec"
            ? findExecDispatchOperandIndex(words, commandWordIndex + 1)
            : shellWordBaseName(commandWord) === "nohup"
              ? findCommandDispatchOperandIndex(words, commandWordIndex + 1)
            : shellWordBaseName(commandWord) === "timeout"
              ? findTimeoutDispatchOperandIndex(words, commandWordIndex + 1)
            : shellWordBaseName(commandWord) === "coproc"
              ? findCoprocDispatchOperandIndex(words, commandWordIndex + 1)
            : shellWordBaseName(commandWord) === "xargs"
              ? findXargsDispatchOperandIndex(words, commandWordIndex + 1)
            : shellWordBaseName(commandWord) === "time"
              ? findTimeDispatchOperandIndex(words, commandWordIndex + 1)
              : null;
    if (operandIndex === null) return null;
    commandWordIndex = operandIndex;
  }

  return null;
}

function splitStateScanSegments(command: string): StateScanSegment[] {
  const segments: StateScanSegment[] = [];
  let current = "";
  let segmentStart = 0;
  let quote: "'" | "\"" | null = null;
  const pushSegment = (endIndex: number): void => {
    if (current.trim()) {
      segments.push({
        segment: current,
        prefix: command.slice(0, segmentStart),
      });
    }
    current = "";
    segmentStart = endIndex;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "'" || char === "\"") {
      if (quote === char) {
        quote = null;
      } else if (!quote) {
        quote = char;
      }
      current += char;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      index += 1;
      current += command[index] ?? "";
      continue;
    }
    if (quote) {
      current += char;
      continue;
    }
    if (char === ";" || char === "\n" || char === "\r") {
      pushSegment(index + 1);
      continue;
    }
    if (char === "&" && command[index + 1] === "&") {
      pushSegment(index + 2);
      index += 1;
      continue;
    }
    if (char === "&") {
      const previous = command[index - 1] ?? "";
      const next = command[index + 1] ?? "";
      if (previous === ">" || previous === "<" || next === ">") {
        current += char;
      } else {
        pushSegment(index + 1);
      }
      continue;
    }
    if (char === "|" && command[index + 1] === "|") {
      pushSegment(index + 2);
      index += 1;
      continue;
    }
    if (char === "|") {
      const next = command[index + 1] ?? "";
      if (next === "&") {
        pushSegment(index + 2);
        index += 1;
      } else {
        pushSegment(index + 1);
      }
      continue;
    }
    current += char;
  }

  if (current.trim()) {
    segments.push({
      segment: current,
      prefix: command.slice(0, segmentStart),
    });
  }
  return segments.length > 0 ? segments : [{ segment: command, prefix: "" }];
}

function collectOmxStateCommandOperations(
  command: string,
  operation: "write" | "clear",
  nested = false,
): OmxStateCommandOperation[] {
  command = normalizeShellLineContinuations(stripHeredocBodiesForCommandScan(command));
  const operations: OmxStateCommandOperation[] = [];
  const addOperation = (candidate: OmxStateCommandOperation): void => {
    operations.push(candidate);
  };

  const scanNestedSubstitutions = (): void => {
    let quote: "'" | "\"" | null = null;
    for (let index = 0; index < command.length; index += 1) {
      const char = command[index];
      if (char === "\\" && quote !== "'") {
        index += 1;
        continue;
      }
      if (quote !== "'" && char === "$" && command[index + 1] === "(") {
        const substitutionEnd = findCommandSubstitutionEnd(command, index + 2);
        const substitutionBodyEnd = substitutionEnd >= 0 ? substitutionEnd : command.length;
        const substitutionBody = command.slice(index + 2, substitutionBodyEnd);
        for (const nestedOperation of collectOmxStateCommandOperations(substitutionBody, operation, true)) {
          addOperation(nestedOperation);
        }
        index = substitutionEnd >= 0 ? substitutionEnd : command.length;
        continue;
      }
      if (quote !== "'" && char === "<" && command[index + 1] === "(") {
        const substitutionEnd = findProcessSubstitutionEnd(command, index + 2);
        const substitutionBodyEnd = substitutionEnd >= 0 ? substitutionEnd : command.length;
        const substitutionBody = command.slice(index + 2, substitutionBodyEnd);
        for (const nestedOperation of collectOmxStateCommandOperations(substitutionBody, operation, true)) {
          addOperation(nestedOperation);
        }
        index = substitutionEnd >= 0 ? substitutionEnd : command.length;
        continue;
      }
      if (quote !== "'" && char === ">" && command[index + 1] === "(") {
        const substitutionEnd = findProcessSubstitutionEnd(command, index + 2);
        const substitutionBodyEnd = substitutionEnd >= 0 ? substitutionEnd : command.length;
        const substitutionBody = command.slice(index + 2, substitutionBodyEnd);
        for (const nestedOperation of collectOmxStateCommandOperations(substitutionBody, operation, true)) {
          addOperation(nestedOperation);
        }
        index = substitutionEnd >= 0 ? substitutionEnd : command.length;
        continue;
      }
      if (quote !== "'" && char === "`") {
        const substitutionEnd = findBacktickCommandSubstitutionEnd(command, index + 1);
        const substitutionBodyEnd = substitutionEnd >= 0 ? substitutionEnd : command.length;
        const substitutionBody = command.slice(index + 1, substitutionBodyEnd);
        for (const nestedOperation of collectOmxStateCommandOperations(substitutionBody, operation, true)) {
          addOperation(nestedOperation);
        }
        index = substitutionEnd >= 0 ? substitutionEnd : command.length;
        continue;
      }
      if (char === "'" || char === "\"") {
        if (quote === char) {
          quote = null;
        } else if (!quote) {
          quote = char;
        }
      }
    }
  };

  scanNestedSubstitutions();

  for (const functionBody of extractInvokedShellFunctionBodiesForStateScan(command)) {
    for (const nestedOperation of collectOmxStateCommandOperations(functionBody, operation, true)) {
      addOperation(nestedOperation);
    }
  }

  for (const scanSegment of splitStateScanSegments(command)) {
    const words = tokenizeShellWords(scanSegment.segment);
    const stateCommand = readOmxStateCommandFromSegmentWords(words, operation);
    if (stateCommand) {
      addOperation({
        args: stateCommand.args,
        prefix: scanSegment.prefix,
        commandPrefix: stateCommand.prefixWords.join(" "),
        nested,
      });
    }
  }

  for (const nestedCommand of extractNestedShellCommandStringsForStateScan(command)) {
    for (const nestedOperation of collectOmxStateCommandOperations(nestedCommand, operation, true)) {
      addOperation(nestedOperation);
    }
  }

  return operations;
}

function extractInvokedShellFunctionBodiesForStateScan(command: string): string[] {
  const bodies: string[] = [];
  command = stripHeredocBodiesForCommandScan(normalizeShellLineContinuations(command));
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) {
        quote = null;
      } else if (!quote) {
        quote = char;
      }
      continue;
    }
    if (quote) continue;
    const functionDefinition = findShellFunctionDefinitionAt(command, index);
    if (!functionDefinition) continue;
    const functionBodyEnd = findShellFunctionBodyEnd(command, functionDefinition.openBraceIndex, functionDefinition.bodyOpenChar);
    if (functionBodyEnd < 0) continue;
    if (isShellFunctionInvokedLater(command.slice(functionBodyEnd + 1), functionDefinition.name)) {
      bodies.push(command.slice(functionDefinition.openBraceIndex + 1, functionBodyEnd));
    }
    index = functionBodyEnd;
  }
  return bodies;
}

function findUnquotedOmxStateCommandIndexes(command: string, operation: "write" | "clear"): number[] {
  return collectOmxStateCommandOperations(command, operation).map((_, index) => index);
}

function extractNestedShellCommandStringsForStateScan(command: string): string[] {
  const words = tokenizeShellWords(stripHeredocBodiesForCommandScan(command));
  const nested: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (isNestedShellCommandWord(word)) {
      const commandStringIndex = findShellCommandStringArgIndex(words, index + 1);
      if (commandStringIndex !== null) {
        const nestedCommand = words[commandStringIndex];
        if (nestedCommand) {
          nested.push(nestedCommand);
          const positionalArgs = words.slice(commandStringIndex + 1);
          const expandedNestedCommand = expandShellPositionalParameters(nestedCommand, positionalArgs);
          if (expandedNestedCommand !== nestedCommand) nested.push(expandedNestedCommand);
        }
      }
    }
    if (word === "eval") {
      const nestedCommand = words.slice(index + 1).join(" ");
      if (nestedCommand) nested.push(nestedCommand);
    }
    if (shellWordBaseName(word) === "env") {
      const splitStringCommand = extractEnvSplitStringCommand(words, index + 1);
      if (splitStringCommand) {
        nested.push(splitStringCommand);
      }
    } else if (isPackageManagerCommandWord(word)) {
      const packageManagerCommand = extractPackageManagerExecCommand(command, words, index + 1, shellWordBaseName(word));
      if (packageManagerCommand) {
        nested.push(packageManagerCommand);
      }
    }
  }
  return nested;
}

function isPackageManagerCommandWord(word: string): boolean {
  const base = shellWordBaseName(word);
  return base === "npm" || base === "pnpm" || base === "yarn" || base === "npx" || base === "pnpx";
}

function hasDynamicNestedShellExecution(command: string): boolean {
  const commands = splitShellCommandSegments(stripHeredocBodiesForCommandScan(command));
  for (const segment of commands) {
    const words = tokenizeShellWords(segment);
    let sawCommandWord = false;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index] ?? "";
      if (!sawCommandWord) {
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
        sawCommandWord = true;
        if (isDynamicNestedCommandString(word)) return true;
      }
      if (isCommandDispatchBuiltin(word)) {
        const dispatchedCommand = extractDispatchBuiltinOperand(words, index + 1, word);
        if (dispatchedCommand && hasDynamicNestedShellExecution(dispatchedCommand)) return true;
      }
      if (containsUnquotedProcessSubstitution(segment) && (isNestedShellCommandWord(word) || word === "." || word === "source")) return true;
      if (isNestedShellCommandWord(word)) {
        const commandStringIndex = findShellCommandStringArgIndex(words, index + 1);
        if (commandStringIndex === null && (hasUnquotedShellStdinFlowAroundShellWord(words, index) || segment.includes("<<"))) return true;
        if (commandStringIndex !== null) {
          const nestedCommand = words[commandStringIndex] ?? "";
          if (isDynamicNestedCommandString(nestedCommand)) return true;
        }
      }
      if (word === "eval") {
        const nestedCommand = words.slice(index + 1).join(" ");
        if (isDynamicNestedCommandString(nestedCommand)) return true;
      }
    }
  }
  return false;
}

function isCommandDispatchBuiltin(word: string): boolean {
  return word === "exec" || word === "command" || word === "." || word === "source" || word === "env" || word === "nohup";
}

function extractDispatchBuiltinOperand(words: string[], startIndex: number, builtin: string): string {
  for (let index = startIndex; index < words.length; index += 1) {
    const option = words[index] ?? "";
    if (!option) continue;
    if (option === "--") continue;
    if (isShellAssignmentWord(option)) continue;
    if (builtin === "exec" && option === "-a") {
      index += 1;
      continue;
    }
    if (builtin === "env" && (option === "-S" || option === "--split-string")) {
      const splitOperand = words[index + 1] ?? "";
      return splitOperand;
    }
    if (builtin === "env" && option.startsWith("--split-string=")) {
      return option.slice("--split-string=".length);
    }
    if (builtin === "env" && option.startsWith("-S") && option.length > 2) {
      return option.slice(2);
    }
    if (option.startsWith("-")) continue;
    return words.slice(index).join(" ");
  }
  return "";
}

function isNestedShellCommandWord(word: string): boolean {
  const base = word.split(/[\\/]/).pop() ?? word;
  return /^(?:bash|sh|zsh|dash|ksh|mksh|ash)$/.test(base);
}

function findShellCommandStringArgIndex(words: string[], optionStartIndex: number): number | null {
  for (let index = optionStartIndex; index < words.length; index += 1) {
    const option = words[index] ?? "";
    if (option === "--") return null;
    if (isShellCommandStringOption(option)) return index + 1;
    if (isShellOptionWithSeparateValue(option)) {
      index += 1;
      continue;
    }
    if (option.startsWith("-")) continue;
    return null;
  }
  return null;
}

function isShellCommandStringOption(option: string): boolean {
  return /^-[^-]*c[^-]*$/.test(option);
}

function isShellOptionWithSeparateValue(option: string): boolean {
  return option === "--rcfile" || option === "--init-file" || option === "-o" || option === "-O";
}

function isDynamicNestedCommandString(command: string): boolean {
  return /(?:^|[^\\])\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]+\}|\()/.test(command)
    || /(?:^|[^\\])`/.test(command);
}

function shellQuoteForStateScan(value: string): string {
  if (value === "") return "''";
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function expandShellPositionalParameters(command: string, positionalArgs: string[]): string {
  if (!command.includes("$") || positionalArgs.length === 0) return command;

  let expanded = "";
  let replaced = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && index + 1 < command.length) {
      expanded += char;
      index += 1;
      expanded += command[index] ?? "";
      continue;
    }
    if (char !== "$") {
      expanded += char;
      continue;
    }

    const next = command[index + 1] ?? "";
    if (next === "{") {
      let endIndex = index + 2;
      let digits = "";
      while (endIndex < command.length) {
        const bodyChar = command[endIndex] ?? "";
        if (bodyChar === "}") break;
        digits += bodyChar;
        endIndex += 1;
      }
      if (command[endIndex] === "}" && /^\d+$/.test(digits)) {
        const positionalIndex = Number.parseInt(digits, 10);
        const replacement = positionalArgs[positionalIndex];
        if (replacement !== undefined) {
          expanded += shellQuoteForStateScan(replacement);
          replaced = true;
          index = endIndex;
          continue;
        }
      }
      if (command[endIndex] === "}" && (digits === "@" || digits === "*")) {
        const expansionArgs = positionalArgs.slice(1);
        const replacement = expansionArgs.map((arg) => shellQuoteForStateScan(arg)).join(" ");
        expanded += replacement;
        replaced = true;
        index = endIndex;
        continue;
      }
    } else if (next === "@" || next === "*") {
      const replacement = positionalArgs.slice(1).map((arg) => shellQuoteForStateScan(arg)).join(" ");
      if (replacement) {
        expanded += replacement;
        replaced = true;
        index += 1;
        continue;
      }
    } else if (/[0-9]/.test(next)) {
      let endIndex = index + 1;
      let digits = "";
      while (endIndex < command.length && /[0-9]/.test(command[endIndex] ?? "")) {
        digits += command[endIndex] ?? "";
        endIndex += 1;
      }
      const positionalIndex = Number.parseInt(digits, 10);
      const replacement = positionalArgs[positionalIndex];
      if (replacement !== undefined) {
        expanded += shellQuoteForStateScan(replacement);
        replaced = true;
        index = endIndex - 1;
        continue;
      }
    }

    expanded += char;
  }

  return replaced ? expanded : command;
}

function splitShellCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "'" || char === "\"") {
      if (quote === char) {
        quote = null;
      } else if (!quote) {
        quote = char;
      }
      current += char;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      index += 1;
      current += command[index] ?? "";
      continue;
    }
    if (quote) {
      current += char;
      continue;
    }
    if (char === ";" || char === "\n" || char === "\r") {
      if (current.trim()) segments.push(current);
      current = "";
      continue;
    }
    if (char === "&" && command[index + 1] === "&") {
      if (current.trim()) segments.push(current);
      current = "";
      index += 1;
      continue;
    }
    if (char === "|" && command[index + 1] === "|") {
      if (current.trim()) segments.push(current);
      current = "";
      index += 1;
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current);
  return segments.length > 0 ? segments : [command];
}

function findDispatchWordIndex(words: string[], startIndex: number): number | null {
  for (let index = startIndex; index < words.length; index += 1) {
    const token = words[index] ?? "";
    if (!token || token === "--") continue;
    if (isShellAssignmentWord(token)) continue;
    return index;
  }
  return null;
}

function isShellAssignmentWord(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function hasUnquotedShellStdinFlowAroundShellWord(words: string[], wordIndex: number): boolean {
  for (let index = 0; index < wordIndex; index += 1) {
    const word = words[index] ?? "";
    if (word === "|" || word === "|&") return true;
    if (word === "<" || word === "<<" || word === "<<<" || word.startsWith("<")) return true;
  }
  for (let index = wordIndex + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "<" || word === "<<" || word === "<<<" || word.startsWith("<")) return true;
  }
  return false;
}

function findCommandSubstitutionEnd(command: string, bodyStartIndex: number): number {
  let depth = 1;
  let quote: "'" | "\"" | null = null;
  for (let index = bodyStartIndex; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) {
        quote = null;
      } else if (!quote) {
        quote = char;
      }
      continue;
    }
    if (quote) continue;
    if (char === "$" && command[index + 1] === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findBacktickCommandSubstitutionEnd(command: string, bodyStartIndex: number): number {
  for (let index = bodyStartIndex; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "`") return index;
  }
  return -1;
}

function findProcessSubstitutionEnd(command: string, bodyStartIndex: number): number {
  let depth = 1;
  let quote: "'" | "\"" | null = null;
  for (let index = bodyStartIndex; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) {
        quote = null;
      } else if (!quote) {
        quote = char;
      }
      continue;
    }
    if (quote) continue;
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function containsUnquotedProcessSubstitution(command: string): boolean {
  command = normalizeShellLineContinuations(command);
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < command.length - 1; index += 1) {
    const char = command[index];
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) {
        quote = null;
      } else if (!quote) {
        quote = char;
      }
      continue;
    }
    if (quote) continue;
    if ((char === "<" || char === ">") && command[index + 1] === "(") return true;
  }
  return false;
}

function stripHeredocBodiesForCommandScan(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    kept.push(line);
    const heredocMatch = line.match(/<<-?\s*(?:"([^"]+)"|'([^']+)'|([^\s"'<>|;&]+))/);
    const delimiter = safeString(heredocMatch?.[1] ?? heredocMatch?.[2] ?? heredocMatch?.[3]).trim();
    if (!delimiter) continue;
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim() !== delimiter) {
      kept.push("");
      index += 1;
    }
    if (index < lines.length) kept.push(lines[index] ?? "");
  }
  return kept.join("\n");
}

function hasUnsafeUnquotedHeredocExpansion(command: string): boolean {
  const lines = normalizeShellLineContinuations(command).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heredocMatch = line.match(/<<-?\s*(?:"([^"]+)"|'([^']+)'|([^\s"'<>|;&]+))/);
    if (!heredocMatch) continue;
    const quoted = Boolean(heredocMatch[1] || heredocMatch[2]);
    const delimiter = safeString(heredocMatch[1] ?? heredocMatch[2] ?? heredocMatch[3]).trim();
    if (!delimiter || quoted) continue;
    index += 1;
    const bodyLines: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim() !== delimiter) {
      bodyLines.push(lines[index] ?? "");
      index += 1;
    }
    if (isDynamicNestedCommandString(bodyLines.join("\n"))) return true;
  }
  return false;
}

function normalizeStateWriteClassificationPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const targetMode = safeString(payload.mode).trim();
  const {
    mode: _mode,
    workingDirectory: _workingDirectory,
    session_id: _sessionId,
    state,
    ...fields
  } = payload;
  const normalized: Record<string, unknown> = {
    ...fields,
    ...safeObject(state),
    ...(targetMode ? { mode: targetMode } : {}),
  };
  if (normalized.current_phase === undefined && normalized.currentPhase !== undefined) {
    normalized.current_phase = normalized.currentPhase;
  }
  if (normalized.run_outcome === undefined && normalized.runOutcome !== undefined) {
    normalized.run_outcome = normalized.runOutcome;
  }
  if (normalized.lifecycle_outcome === undefined && normalized.lifecycleOutcome !== undefined) {
    normalized.lifecycle_outcome = normalized.lifecycleOutcome;
  }
  if (normalized.terminal_outcome === undefined && normalized.terminalOutcome !== undefined) {
    normalized.terminal_outcome = normalized.terminalOutcome;
  }
  return {
    ...normalized,
  };
}

function isPlanningPhaseDeactivationPayload(payload: Record<string, unknown>): boolean {
  const mode = safeString(payload.mode).trim().toLowerCase();
  if (!mode) return false;
  if (mode !== "deep-interview" && mode !== "ralplan") {
    if (!isTrackedWorkflowMode(mode)) return false;
    const currentPhase = safeString(payload.current_phase ?? payload.currentPhase).trim().toLowerCase();
    const normalizedAutopilotPhase = normalizeAutopilotPhase(currentPhase);
    if (mode === "autopilot" && (normalizedAutopilotPhase === "deep-interview" || normalizedAutopilotPhase === "ralplan" || normalizedAutopilotPhase === "ultragoal")) {
      return payload.active === false;
    }
    if (payload.active === true) return true;
    return inferTerminalLifecycleOutcome(payload, { includeQuestionEnforcement: false }) === undefined;
  }

  if (payload.active === false) return true;
  return inferTerminalLifecycleOutcome(payload, { includeQuestionEnforcement: false }) !== undefined;
}

function commandEndsPlanningPhase(cwd: string, command: string): boolean {
  const canonicalCommand = canonicalizeOmxStateTransportCommand(command);
  if (hasUnsafeUnquotedHeredocExpansion(canonicalCommand)) return true;
  if (sourcesFileWrittenEarlierInSameCommand(cwd, canonicalCommand)) return true;
  if (findUnquotedOmxStateCommandIndexes(canonicalCommand, "clear").length > 0) return true;
  if (hasDynamicNestedShellExecution(canonicalCommand)) return true;
  const stateWriteCount = findUnquotedOmxStateCommandIndexes(canonicalCommand, "write").length;
  if (stateWriteCount > 1) return true;
  if (stateWriteCount === 0) return false;
  const payload = readStateWriteInputPayload(cwd, canonicalCommand, command);
  return payload ? isPlanningPhaseDeactivationPayload(payload) : true;
}

function isAllowedDeepInterviewBashWrite(cwd: string, command: string): boolean {
  if (commandEndsPlanningPhase(cwd, command)) return false;
  if (!commandHasDeepInterviewWriteIntent(command)) return true;
  const targets = extractDeepInterviewCommandWriteTargets(command);
  if (targets.some((target) => !isAllowedDeepInterviewArtifactPath(cwd, target))) return false;
  return targets.length > 0 && targets.every((target) => isAllowedDeepInterviewArtifactPath(cwd, target));
}

async function readActiveDeepInterviewStateForPreToolUse(
  cwd: string,
  stateDir: string,
  sessionId: string,
  threadId: string,
): Promise<Record<string, unknown> | null> {
  const canonicalState = sessionId
    ? await readVisibleSkillActiveStateForStateDir(stateDir, sessionId)
    : await readSkillActiveState(join(stateDir, SKILL_ACTIVE_STATE_FILE));
  if (!canonicalState) return null;

  const modeState = sessionId
    ? await readStopSessionPinnedState("deep-interview-state.json", cwd, sessionId, stateDir)
    : await readJsonIfExists(join(stateDir, "deep-interview-state.json"));
  if (isActiveDeepInterviewPhase(modeState) && modeState && modeStateMatchesSkillStopContext(modeState, cwd, sessionId)) {
    const hasActiveDeepInterviewSkill = listActiveSkills(canonicalState).some((entry) => (
      entry.skill === "deep-interview"
      && matchesSkillStopContext(entry, canonicalState, sessionId, threadId)
    ));
    if (hasActiveDeepInterviewSkill) return modeState;
  }

  const autopilotState = sessionId
    ? await readStopSessionPinnedState("autopilot-state.json", cwd, sessionId, stateDir)
    : await readJsonIfExists(join(stateDir, "autopilot-state.json"));
  if (!autopilotState || autopilotState.active !== true) return null;
  const autopilotMode = safeString(autopilotState.mode).trim();
  if (autopilotMode && autopilotMode !== "autopilot") return null;
  if (!modeStateMatchesSkillStopContext(autopilotState, cwd, sessionId)) return null;
  const autopilotStatePhase = safeString(autopilotState.current_phase ?? autopilotState.currentPhase).trim().toLowerCase();
  const autopilotIsDeepInterview = normalizeAutopilotPhase(autopilotStatePhase) === "deep-interview";
  const hasDeepInterviewScopedAutopilotSkill = listActiveSkills(canonicalState).some((entry) => (
    entry.skill === "autopilot"
    && normalizeAutopilotPhase(safeString(entry.phase).trim().toLowerCase()) === "deep-interview"
    && matchesSkillStopContext(entry, canonicalState, sessionId, threadId)
  ));
  const hasActiveAutopilotSkill = listActiveSkills(canonicalState).some((entry) => (
    entry.skill === "autopilot"
    && matchesSkillStopContext(entry, canonicalState, sessionId, threadId)
  ));
  if (!hasActiveAutopilotSkill) return null;
  if (!autopilotIsDeepInterview && !hasDeepInterviewScopedAutopilotSkill) return null;
  return autopilotState;
}

async function readActiveRalplanStateForPreToolUse(
  cwd: string,
  stateDir: string,
  sessionId: string,
  threadId: string,
): Promise<Record<string, unknown> | null> {
  const modeState = sessionId
    ? await readStopSessionPinnedState("ralplan-state.json", cwd, sessionId, stateDir)
    : await readJsonIfExists(join(stateDir, "ralplan-state.json"));
  const canonicalState = sessionId
    ? await readVisibleSkillActiveStateForStateDir(stateDir, sessionId)
    : await readSkillActiveState(join(stateDir, SKILL_ACTIVE_STATE_FILE));
  if (isActiveRalplanPhase(modeState) && modeState && modeStateMatchesSkillStopContext(modeState, cwd, sessionId)) {
    if (hasExplicitExecutionHandoffSkill(canonicalState, sessionId, threadId)) return null;
    if (!canonicalState) return null;
    const hasActiveRalplanSkill = listActiveSkills(canonicalState).some((entry) => (
      entry.skill === "ralplan"
      && matchesSkillStopContext(entry, canonicalState, sessionId, threadId)
    ));
    if (hasActiveRalplanSkill) return modeState;
  }

  const autopilotState = sessionId
    ? await readStopSessionPinnedState("autopilot-state.json", cwd, sessionId, stateDir)
    : await readJsonIfExists(join(stateDir, "autopilot-state.json"));
  if (!autopilotState || autopilotState.active !== true) return null;
  const autopilotMode = safeString(autopilotState.mode).trim();
  if (autopilotMode && autopilotMode !== "autopilot") return null;
  if (!modeStateMatchesSkillStopContext(autopilotState, cwd, sessionId)) return null;
  if (!canonicalState) return null;
  const hasActiveAutopilotSkill = listActiveSkills(canonicalState).some((entry) => (
    entry.skill === "autopilot"
    && matchesSkillStopContext(entry, canonicalState, sessionId, threadId)
  ));
  if (!hasActiveAutopilotSkill) return null;
  const autopilotStatePhase = safeString(autopilotState.current_phase ?? autopilotState.currentPhase).trim().toLowerCase();
  if (isAutopilotReviewReworkPhase(autopilotStatePhase)) return null;
  if (!canAutopilotSkillMirrorSupplyRalplanPhase(autopilotStatePhase)) return null;
  const hasRalplanScopedAutopilotSkill = listActiveSkills(canonicalState).some((entry) => (
    entry.skill === "autopilot"
    && isAutopilotRalplanLikePhase(safeString(entry.phase).trim().toLowerCase())
    && matchesSkillStopContext(entry, canonicalState, sessionId, threadId)
  ));
  if (!isAutopilotRalplanLikePhase(autopilotStatePhase) && !hasRalplanScopedAutopilotSkill) return null;
  return hasActiveAutopilotSkill ? autopilotState : null;
}

function isAllowedRalplanBashWrite(cwd: string, command: string): boolean {
  const beadsCommand = classifyRalplanBeadsMetadataCommand(cwd, command);
  const targets = extractDeepInterviewCommandWriteTargets(command);
  const hasAllowedTargets = targets.length > 0
    && targets.every((target) => isAllowedRalplanArtifactPath(cwd, target));

  if (beadsCommand.present) {
    return beadsCommand.allowed && (targets.length === 0 || hasAllowedTargets);
  }
  if (commandEndsPlanningPhase(cwd, command)) return false;
  if (!commandHasDeepInterviewWriteIntent(command)) return true;
  if (targets.some((target) => !isAllowedRalplanArtifactPath(cwd, target))) return false;
  return hasAllowedTargets;
}

function buildRalplanBashBlockedDetail(cwd: string, command: string): string {
  const targets = extractDeepInterviewCommandWriteTargets(command);
  const blockedTarget = targets.find((target) => !isAllowedRalplanArtifactPath(cwd, target));
  if (blockedTarget && isUnresolvedVariableTarget(blockedTarget)) {
    return `unresolved Bash write target ${blockedTarget} is not under allowed planning artifact paths or metadata paths (${RALPLAN_ALLOWED_WRITE_PREFIXES.join(", ")})`;
  }
  if (blockedTarget) {
    const operationClass = /\btee\s+(?:-a\s+)?/.test(command) ? "Bash tee write" : "Bash redirect write";
    return `${operationClass} target ${blockedTarget} is not under allowed planning artifact paths or metadata paths (${RALPLAN_ALLOWED_WRITE_PREFIXES.join(", ")})`;
  }
  const beadsCommand = classifyRalplanBeadsMetadataCommand(cwd, command);
  if (beadsCommand.present && !beadsCommand.allowed) {
    return beadsCommand.reason ?? "Beads tracker command is not an allowed planning metadata mutation";
  }
  if (beadsCommand.present) {
    return "Beads tracker command also performs an implementation write outside allowed planning metadata";
  }
  return "Bash write intent did not identify an allowed planning artifact path or metadata path";
}

async function buildRalplanPreToolUseBoundaryOutput(
  payload: CodexHookPayload,
  cwd: string,
  stateDir: string,
  resolvedSessionId?: string,
): Promise<Record<string, unknown> | null> {
  const sessionId = safeString(resolvedSessionId ?? readPayloadSessionId(payload)).trim();
  const threadId = readPayloadThreadId(payload);
  const activeState = await readActiveRalplanStateForPreToolUse(cwd, stateDir, sessionId, threadId);
  if (!activeState) return null;

  const toolName = safeString(payload.tool_name).trim();
  const command = readPreToolUseCommand(payload);
  const pathCandidates = readPreToolUsePathCandidates(payload);
  let blocked = false;
  let blockedDetail = "implementation/write tools are blocked until an explicit execution handoff workflow is activated";

  if (toolName === "Bash") {
    blocked = !isAllowedRalplanBashWrite(cwd, command);
    if (blocked) {
      blockedDetail = buildRalplanBashBlockedDetail(cwd, command);
    }
  } else if (
    toolName === "mcp__omx_state__state_clear"
    || (
      toolName === "mcp__omx_state__state_write"
      && isPlanningPhaseDeactivationPayload(normalizeStateWriteClassificationPayload(safeObject(payload.tool_input)))
    )
  ) {
    blocked = true;
    blockedDetail = `${toolName} would deactivate protected planning state`;
  } else if (PLANNING_MODE_IMPLEMENTATION_TOOL_NAMES.has(toolName)) {
    const toolPathCandidates = collectImplementationToolPathCandidates(payload, toolName, pathCandidates);
    if (toolPathCandidates.length === 0) {
      blocked = true;
      blockedDetail = describeImplementationToolBlock(toolName, undefined, toolPathCandidates.length);
    } else {
      const blockedPath = toolPathCandidates.find((candidate) => !isAllowedRalplanArtifactPath(cwd, candidate));
      blocked = blockedPath !== undefined;
      if (blockedPath !== undefined) {
        blockedDetail = describeImplementationToolBlock(toolName, blockedPath, toolPathCandidates.length);
      }
    }
  }

  if (!blocked) return null;

  const phase = formatPhase(activeState.current_phase ?? activeState.currentPhase, "planning");
  const activeMode = safeString(activeState.mode).trim().toLowerCase();
  const planningModeLabel = activeMode === "autopilot" ? "Autopilot planning" : "Ralplan";
  const planningModeDescription = activeMode === "autopilot"
    ? "Autopilot is supervising a planning phase"
    : "Ralplan is consensus-planning mode";
  return {
    decision: "block",
    reason: `${planningModeLabel} is active (phase: ${phase}); implementation/write tools are blocked until an explicit execution handoff workflow is activated; ${blockedDetail}.`,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        `${planningModeDescription}. `
        + "Write only planning artifacts under `.omx/context/`, `.omx/plans/`, `.omx/specs/`, required `.omx/state/` files, or tracker metadata under `.beads/`. "
        + "Do not edit implementation files or run implementation-focused writes from planning phases. "
        + `To execute, first process an explicit handoff such as ${formatExecutionHandoffList(cwd)}, which must emit terminal planning state before implementation begins.`,
    },
  };
}

async function buildDeepInterviewPreToolUseBoundaryOutput(
  payload: CodexHookPayload,
  cwd: string,
  stateDir: string,
  resolvedSessionId?: string,
): Promise<Record<string, unknown> | null> {
  const sessionId = safeString(resolvedSessionId ?? readPayloadSessionId(payload)).trim();
  const threadId = readPayloadThreadId(payload);
  const activeState = await readActiveDeepInterviewStateForPreToolUse(cwd, stateDir, sessionId, threadId);
  if (!activeState) return null;

  const toolName = safeString(payload.tool_name).trim();
  const command = readPreToolUseCommand(payload);
  const pathCandidates = readPreToolUsePathCandidates(payload);
  let blocked = false;

  if (toolName === "Bash") {
    blocked = !isAllowedDeepInterviewBashWrite(cwd, command);
  } else if (
    toolName === "mcp__omx_state__state_clear"
    || (
      toolName === "mcp__omx_state__state_write"
      && isPlanningPhaseDeactivationPayload(normalizeStateWriteClassificationPayload(safeObject(payload.tool_input)))
    )
  ) {
    blocked = true;
  } else if (DEEP_INTERVIEW_IMPLEMENTATION_TOOL_NAMES.has(toolName)) {
    const candidates = collectImplementationToolPathCandidates(payload, toolName, pathCandidates);
    blocked = candidates.length === 0
      || !candidates.every((candidate) => isAllowedDeepInterviewArtifactPath(cwd, candidate));
  }

  if (!blocked) return null;

  const phase = formatPhase(activeState.current_phase ?? activeState.currentPhase, "planning");
  return {
    decision: "block",
    reason: `Deep-interview is active (phase: ${phase}); implementation/write tools are blocked until an explicit handoff workflow is activated.`,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        `Deep-interview is requirements/spec mode. Treat detailed user answers as interview/spec material, not implicit implementation authorization. You may write only deep-interview artifacts under \`.omx/context/\`, \`.omx/interviews/\`, \`.omx/specs/\`, or required \`.omx/state/\` files. To implement, first ask for or process an explicit transition such as \`$ralplan\`, \`$autopilot\`, ${formatExecutionHandoffList(cwd)}.`,
    },
  };
}

function blocksDeepInterviewImplementationWrite(payload: CodexHookPayload, cwd: string): boolean {
  const toolName = safeString(payload.tool_name).trim();
  if (toolName === "Bash") {
    return !isAllowedDeepInterviewBashWrite(cwd, readPreToolUseCommand(payload));
  }
  if (!DEEP_INTERVIEW_IMPLEMENTATION_TOOL_NAMES.has(toolName)) return false;
  const candidates = collectImplementationToolPathCandidates(
    payload,
    toolName,
    readPreToolUsePathCandidates(payload),
  );
  return candidates.length === 0
    || !candidates.every((candidate) => isAllowedDeepInterviewArtifactPath(cwd, candidate));
}

// Shared builder for the "live root session pointer owned by another session"
// fail-closed block. Deep-interview and ralplan/autopilot only differ in the
// human-readable mode label and phase-description fragment; the decision,
// structure, and guidance are identical.
function buildRootPointerConflictBlock(
  activeState: Record<string, unknown>,
  planningModeLabel: string,
  planningPhaseDescription: string,
): Record<string, unknown> {
  const phase = formatPhase(activeState.current_phase ?? activeState.currentPhase, "planning");
  return {
    decision: "block",
    reason: `${planningModeLabel} is active in the live root session pointer (phase: ${phase}), but the current native session could not be authoritatively resolved to that owner; failing closed for planning-write protection.`,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        `OMX detected a live root session pointer owned by another session while a ${planningPhaseDescription} is active. `
        + "This indicates collapsed session-root isolation. Do not perform implementation writes from this unresolved session; use the owning OMX session or restart with an isolated OMX_ROOT.",
    },
  };
}

function buildDeepInterviewRootPointerConflictBlock(activeState: Record<string, unknown>): Record<string, unknown> {
  return buildRootPointerConflictBlock(activeState, "Deep-interview", "deep-interview planning phase");
}

function buildRalplanRootPointerConflictBlock(activeState: Record<string, unknown>): Record<string, unknown> {
  const activeMode = safeString(activeState.mode).trim().toLowerCase();
  const planningModeLabel = activeMode === "autopilot" ? "Autopilot planning" : "Ralplan";
  return buildRootPointerConflictBlock(activeState, planningModeLabel, "ralplan/autopilot planning phase");
}

async function buildPlanningRootPointerConflictPreToolUseOutput(
  payload: CodexHookPayload,
  cwd: string,
  stateDir: string,
  rootState: SessionState | null,
): Promise<Record<string, unknown> | null> {
  const rootSessionId = safeString(rootState?.session_id).trim();
  if (!rootSessionId) return null;
  const ownerCwd = safeString(rootState?.cwd).trim() || cwd;

  const deepInterviewState = await readActiveDeepInterviewStateForPreToolUse(
    ownerCwd,
    stateDir,
    rootSessionId,
    "",
  );
  if (deepInterviewState) {
    const conflictToolName = safeString(payload.tool_name).trim();
    if (
      conflictToolName === "mcp__omx_state__state_clear"
      || (
        conflictToolName === "mcp__omx_state__state_write"
        && isPlanningPhaseDeactivationPayload(normalizeStateWriteClassificationPayload(safeObject(payload.tool_input)))
      )
    ) {
      return buildDeepInterviewRootPointerConflictBlock(deepInterviewState);
    }
    if (blocksDeepInterviewImplementationWrite(payload, cwd)) {
      return buildDeepInterviewRootPointerConflictBlock(deepInterviewState);
    }
  }

  const ralplanState = await readActiveRalplanStateForPreToolUse(
    ownerCwd,
    stateDir,
    rootSessionId,
    "",
  );
  if (!ralplanState) return null;

  const toolName = safeString(payload.tool_name).trim();
  let blocked = false;
  if (toolName === "Bash") {
    blocked = !isAllowedRalplanBashWrite(cwd, readPreToolUseCommand(payload));
  } else if (
    toolName === "mcp__omx_state__state_clear"
    || (
      toolName === "mcp__omx_state__state_write"
      && isPlanningPhaseDeactivationPayload(normalizeStateWriteClassificationPayload(safeObject(payload.tool_input)))
    )
  ) {
    blocked = true;
  } else if (PLANNING_MODE_IMPLEMENTATION_TOOL_NAMES.has(toolName)) {
    const toolPathCandidates = collectImplementationToolPathCandidates(
      payload,
      toolName,
      readPreToolUsePathCandidates(payload),
    );
    blocked = toolPathCandidates.length === 0
      || toolPathCandidates.some((candidate) => !isAllowedRalplanArtifactPath(cwd, candidate));
  }

  return blocked ? buildRalplanRootPointerConflictBlock(ralplanState) : null;
}

function matchesSkillStopContext(
  entry: { session_id?: string; thread_id?: string },
  state: { session_id?: string; thread_id?: string },
  sessionId: string,
  threadId: string,
): boolean {
  const entrySessionId = safeString(entry.session_id ?? state.session_id).trim();
  const entryThreadId = safeString(entry.thread_id ?? state.thread_id).trim();
  if (sessionId && entrySessionId && entrySessionId !== sessionId) return false;
  if (sessionId && !entrySessionId && threadId && entryThreadId && entryThreadId !== threadId) {
    return false;
  }
  return true;
}

function modeStateMatchesSkillStopContext(
  state: Record<string, unknown>,
  cwd: string,
  sessionId: string,
): boolean {
  const stateSessionId = safeString(
    state.owner_omx_session_id
      ?? state.session_id
      ?? state.codex_session_id
      ?? state.owner_codex_session_id,
  ).trim();
  if (sessionId && stateSessionId && stateSessionId !== sessionId) return false;

  const stateCwd = safeString(
    state.cwd
      ?? state.workingDirectory
      ?? state.working_directory
      ?? state.project_path,
  ).trim();
  if (stateCwd) {
    try {
      if (resolve(stateCwd) !== resolve(cwd)) return false;
    } catch {
      return false;
    }
  }

  return true;
}

function modeStateHasExplicitMatchingCwd(state: Record<string, unknown>, cwd: string): boolean {
  const stateCwd = safeString(
    state.cwd
      ?? state.workingDirectory
      ?? state.working_directory
      ?? state.project_path,
  ).trim();
  if (!stateCwd) return false;

  try {
    return resolve(stateCwd) === resolve(cwd);
  } catch {
    return false;
  }
}

async function readBlockingSkillForStop(
  cwd: string,
  stateDir: string,
  sessionId: string,
  threadId: string,
  requiredSkill?: string,
): Promise<{ skill: string; phase: string; latestPlanPath?: string; planningComplete?: boolean; runOutcome?: string } | null> {
  const canonicalState = await readVisibleSkillActiveStateForStateDir(stateDir, sessionId);
  const visibleEntries = canonicalState ? listActiveSkills(canonicalState) : [];
  const candidateSkills = requiredSkill
    ? [requiredSkill]
    : [...SKILL_STOP_BLOCKERS];

  for (const skill of candidateSkills) {
    const terminalRunState = await readCanonicalTerminalRunStateForStop(cwd, sessionId, skill);
    if (terminalRunState) continue;

    const modeState = await readStopSessionPinnedState(`${skill}-state.json`, cwd, sessionId, stateDir);
    if (!modeState || modeState.active !== true) continue;
    if (!modeStateMatchesSkillStopContext(modeState, cwd, sessionId)) continue;

    const modeSnapshot = getRunContinuationSnapshot(modeState);
    if (modeSnapshot?.terminal === true) continue;

    if (await shouldIgnoreSessionSkillBlockerForCanonicalInactiveRoot(
      cwd,
      stateDir,
      skill,
      sessionId,
      threadId,
    )) continue;

    const phase = formatPhase(
      modeState.current_phase,
      formatPhase(
        visibleEntries.find((entry) => entry.skill === skill)?.phase,
        "planning",
      ),
    );
    if (TERMINAL_MODE_PHASES.has(phase.toLowerCase()) || phase === "completing") {
      continue;
    }

    if (!canonicalState) {
      return {
        skill,
        phase,
        latestPlanPath: safeString(modeState.latest_plan_path ?? modeState.latestPlanPath).trim() || undefined,
        planningComplete: modeState.planning_complete === true || modeState.planningComplete === true,
        runOutcome: safeString(modeState.run_outcome ?? modeState.outcome).trim() || undefined,
      };
    }

    const blocker = visibleEntries.find((entry) => (
      entry.skill === skill
      && matchesSkillStopContext(entry, canonicalState, sessionId, threadId)
    ));
    if (!blocker) continue;

    return {
      skill,
      phase: formatPhase(modeState.current_phase ?? blocker.phase ?? canonicalState.phase, "planning"),
      latestPlanPath: safeString(modeState.latest_plan_path ?? modeState.latestPlanPath).trim() || undefined,
      planningComplete: modeState.planning_complete === true || modeState.planningComplete === true,
      runOutcome: safeString(modeState.run_outcome ?? modeState.outcome).trim() || undefined,
    };
  }

  return null;
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => safeString(value).trim()).filter(Boolean))];
}

function isTerminalOrInactiveModeState(state: Record<string, unknown> | null): boolean {
  if (!state) return true;
  if (state.active !== true) return true;
  if (getRunContinuationSnapshot(state)?.terminal === true) return true;
  const phase = safeString(state.current_phase ?? state.currentPhase).trim().toLowerCase();
  return phase !== "" && TERMINAL_MODE_PHASES.has(phase);
}

function rootSkillStateHasNoActiveSkillForStopContext(
  rootState: SkillActiveStateLike | null,
  skill: string,
  sessionId: string,
  threadId: string,
): boolean {
  if (!rootState) return false;
  return !listActiveSkills(rootState).some((entry) => (
    entry.skill === skill
    && matchesSkillStopContext(entry, rootState, sessionId, threadId)
  ));
}

function rootModeStateIsCanonicalForStopContext(
  state: Record<string, unknown>,
  cwd: string,
  sessionId: string,
  threadId: string,
): boolean {
  if (!modeStateMatchesSkillStopContext(state, cwd, sessionId)) return false;

  const stateSessionId = safeString(
    state.owner_omx_session_id
      ?? state.session_id
      ?? state.codex_session_id
      ?? state.owner_codex_session_id,
  ).trim();
  if (sessionId && stateSessionId !== sessionId) return false;

  const stateThreadId = safeString(state.owner_codex_thread_id ?? state.thread_id).trim();
  if (threadId && stateThreadId && stateThreadId !== threadId) return false;

  return true;
}

function hasExplicitSessionScope(state: Record<string, unknown>): boolean {
  return safeString(
    state.owner_omx_session_id
      ?? state.session_id
      ?? state.codex_session_id
      ?? state.owner_codex_session_id,
  ).trim() !== "";
}

async function readStateTimestampMs(state: Record<string, unknown>, path: string): Promise<number | null> {
  return parseTimestampMs(state.updated_at)
    ?? parseTimestampMs(state.completed_at)
    ?? parseTimestampMs(state.created_at)
    ?? await stat(path).then((info) => info.mtimeMs, () => null);
}

async function unscopedRootRalplanStateIsNewerTerminalPlanningCompletion(
  rootState: Record<string, unknown>,
  rootPath: string,
  sessionPath: string,
  cwd: string,
  threadId: string,
): Promise<boolean> {
  if (hasExplicitSessionScope(rootState)) return false;

  const stateThreadId = safeString(rootState.owner_codex_thread_id ?? rootState.thread_id).trim();
  if (threadId && stateThreadId && stateThreadId !== threadId) return false;

  if (!modeStateHasExplicitMatchingCwd(rootState, cwd)) return false;

  const phase = safeString(rootState.current_phase ?? rootState.currentPhase).trim().toLowerCase();
  if (phase !== "complete" && phase !== "completed") return false;

  const planningComplete = rootState.planning_complete === true || rootState.planningComplete === true;
  const latestPlanPath = safeString(rootState.latest_plan_path ?? rootState.latestPlanPath).trim();
  if (!planningComplete || !latestPlanPath) return false;

  const sessionState = await readJsonIfExists(sessionPath);
  if (!sessionState) return false;
  const sessionPhase = safeString(sessionState.current_phase ?? sessionState.currentPhase).trim().toLowerCase();
  if (sessionPhase && TERMINAL_MODE_PHASES.has(sessionPhase)) return false;

  const rootTimestamp = await readStateTimestampMs(rootState, rootPath);
  const sessionTimestamp = await readStateTimestampMs(sessionState, sessionPath);
  if (rootTimestamp === null || sessionTimestamp === null) return false;
  return rootTimestamp > sessionTimestamp;
}

async function shouldIgnoreSessionSkillBlockerForCanonicalInactiveRoot(
  cwd: string,
  stateDir: string,
  skill: string,
  sessionId: string,
  threadId: string,
): Promise<boolean> {
  const rootModeStatePath = join(stateDir, `${skill}-state.json`);
  const rootModeState = await readJsonIfExists(rootModeStatePath);
  if (!rootModeState) return false;
  if (!isTerminalOrInactiveModeState(rootModeState)) return false;

  const canonicalRoot = rootModeStateIsCanonicalForStopContext(rootModeState, cwd, sessionId, threadId)
    && (skill !== "ralplan" || modeStateHasExplicitMatchingCwd(rootModeState, cwd));
  const freshUnscopedRoot = canonicalRoot || skill !== "ralplan"
    ? false
    : await unscopedRootRalplanStateIsNewerTerminalPlanningCompletion(
      rootModeState,
      rootModeStatePath,
      join(stateDir, "sessions", sessionId, `${skill}-state.json`),
      cwd,
      threadId,
    );
  if (!canonicalRoot && !freshUnscopedRoot) return false;

  const { rootPath } = getSkillActiveStatePathsForStateDir(stateDir);
  const rootSkillState = await readSkillActiveState(rootPath);
  return rootSkillStateHasNoActiveSkillForStopContext(rootSkillState, skill, sessionId, threadId);
}

async function readSessionScopedModeStateForRootSkill(
  cwd: string,
  stateDir: string,
  skill: string,
  sessionIds: string[],
): Promise<Record<string, unknown> | null> {
  for (const sessionId of sessionIds) {
    const state = await readStopSessionPinnedState(`${skill}-state.json`, cwd, sessionId, stateDir);
    if (state) return state;
  }
  return null;
}

async function reconcileStaleRootSkillActiveStateForStop(
  cwd: string,
  stateDir: string,
  sessionId: string,
): Promise<void> {
  const { rootPath } = getSkillActiveStatePathsForStateDir(stateDir);
  const rootState = await readSkillActiveState(rootPath);
  if (!rootState?.active) return;

  const initializedSessionId = extractSessionIdFromInitializedStatePath(rootState.initialized_state_path);
  const rootSessionIds = uniqueNonEmpty([
    sessionId,
    safeString(rootState.session_id),
    initializedSessionId,
    ...listActiveSkills(rootState).map((entry) => safeString(entry.session_id)),
  ]);
  if (rootSessionIds.length === 0) return;

  const activeEntries = listActiveSkills(rootState);
  let changed = false;
  const keptEntries = [];
  for (const entry of activeEntries) {
    const skill = safeString(entry.skill).trim();
    if (!skill) continue;
    const entrySessionId = safeString(entry.session_id).trim();
    const candidateSessionIds = uniqueNonEmpty([
      entrySessionId,
      sessionId,
      initializedSessionId,
      safeString(rootState.session_id),
    ]);
    const modeState = await readSessionScopedModeStateForRootSkill(cwd, stateDir, skill, candidateSessionIds);
    if (isTerminalOrInactiveModeState(modeState)) {
      changed = true;
      continue;
    }
    keptEntries.push(entry);
  }

  if (!changed) return;

  const nowIso = new Date().toISOString();
  const nextRoot: SkillActiveStateLike = {
    ...rootState,
    active: keptEntries.length > 0,
    skill: keptEntries[0]?.skill ?? safeString(rootState.skill).trim(),
    phase: keptEntries[0]?.phase ?? safeString(rootState.phase).trim(),
    updated_at: nowIso,
    active_skills: keptEntries,
    reconciled_at: nowIso,
    reconciliation_reason: "stop_hook_session_state_terminal",
  };
  if (keptEntries.length === 0) {
    nextRoot.phase = "inactive";
  }
  await writeFile(rootPath, JSON.stringify(nextRoot, null, 2));
}

function buildRalplanContinuationStatus(
  blocker: { phase: string; latestPlanPath?: string; planningComplete?: boolean; runOutcome?: string },
  activeSubagentCount: number,
  cwd: string,
): { reason: string; systemMessage: string; stopReasonSuffix: string } {
  const phase = blocker.phase || "planning";
  const artifact = blocker.latestPlanPath
    ? ` Artifact: ${blocker.latestPlanPath}.`
    : " Artifact: use the latest `.omx/plans/` ralplan artifact if present.";

  if (activeSubagentCount > 0) {
    return {
      reason:
        `Status: waiting — ralplan is waiting for ${activeSubagentCount} active native subagent thread(s) to finish (phase: ${phase}). Do not stop silently; wait for the subagent result, then continue from the current ralplan artifact and proceed to the next planning/review step.${artifact}`,
      stopReasonSuffix: "waiting_subagent",
      systemMessage:
        `OMX ralplan status: waiting for ${activeSubagentCount} active native subagent thread(s) at phase ${phase}; after they finish, continue from the current ralplan artifact and state the next status explicitly.`,
    };
  }

  const normalizedPhase = phase.toLowerCase();
  const normalizedOutcome = (blocker.runOutcome ?? "").toLowerCase();
  const waitingForInput =
    normalizedOutcome === "blocked_on_user"
    || normalizedPhase.includes("blocked")
    || normalizedPhase.includes("input")
    || normalizedPhase.includes("question");

  if (waitingForInput) {
    return {
      reason:
        `Status: waiting_for_input — ralplan is paused for required user/operator input (phase: ${phase}). Ask the missing question or present the review choice explicitly before stopping.${artifact}`,
      stopReasonSuffix: "waiting_input",
      systemMessage:
        `OMX ralplan status: waiting for input at phase ${phase}; ask the required question or present the explicit review choice before stopping.`,
    };
  }

  const completeHint = blocker.planningComplete
    ? ` The planning artifacts are present; if consensus is approved, emit terminal ralplan complete/approved handoff state and stop planning. Implementation must wait for an explicit ${formatExecutionHandoffList(cwd).replaceAll("`", "")} handoff.`
    : "";

  return {
    reason:
      `Status: continue_from_artifact — ralplan is still active (phase: ${phase}) and has not emitted a terminal complete/paused/waiting status. Continue from the current ralplan artifact, resolve any review ambiguity conservatively or ask the user if needed, and proceed to the next planning/review step before stopping; do not begin implementation from ralplan.${artifact}${completeHint}`,
    stopReasonSuffix: "continue_artifact",
    systemMessage:
      `OMX ralplan status: continue_from_artifact at phase ${phase}; continue from the current ralplan artifact and finish by stating whether ralplan is complete, paused for review, waiting for input, or still continuing; do not begin implementation from ralplan.`,
  };
}

async function readStopAutoNudgePhase(
  cwd: string,
  stateDir: string,
  sessionId: string,
  threadId: string,
): Promise<string> {
  const normalizedSessionId = sessionId.trim();
  if (normalizedSessionId) {
    const scopedModeState = await readStopSessionPinnedState("deep-interview-state.json", cwd, normalizedSessionId, stateDir);
    if (
      scopedModeState?.active === true
      && safeString(scopedModeState.current_phase).trim().toLowerCase() === "intent-first"
    ) {
      return "planning";
    }
  } else {
    const rootModeState = await readJsonIfExists(join(stateDir, "deep-interview-state.json"));
    if (
      rootModeState?.active === true
      && safeString(rootModeState.current_phase).trim().toLowerCase() === "intent-first"
    ) {
      return "planning";
    }
  }

  if (!normalizedSessionId) return "";

  const canonicalState = await readVisibleSkillActiveStateForStateDir(stateDir, normalizedSessionId);
  const visibleEntries = canonicalState ? listActiveSkills(canonicalState) : [];
  const deepInterview = visibleEntries.find((entry) => (
    entry.skill === "deep-interview"
    && matchesSkillStopContext(entry, canonicalState ?? {}, normalizedSessionId, threadId)
  ));
  if (!deepInterview) return "";

  const modeState = await readStopSessionPinnedState("deep-interview-state.json", cwd, normalizedSessionId, stateDir);
  if (!modeState || modeState.active !== true) return "";

  const modePhase = safeString(modeState.current_phase).trim().toLowerCase();
  return modePhase === "intent-first" ? "planning" : "";
}

async function buildDeepInterviewQuestionStopOutput(
  cwd: string,
  stateDir: string,
  sessionId: string,
  threadId: string,
): Promise<{ output: Record<string, unknown>; obligationId: string } | null> {
  await reconcileDeepInterviewQuestionEnforcementFromAnsweredRecords(cwd, sessionId);
  if (await readAutopilotDeepInterviewQuestionWaitState(cwd, sessionId)) {
    return null;
  }
  const modeState = await readStopSessionPinnedState("deep-interview-state.json", cwd, sessionId, stateDir);
  if (!modeState) return null;

  const questionEnforcement = safeObject(modeState.question_enforcement);
  const hasPendingQuestionObligation = isPendingDeepInterviewQuestionEnforcement(questionEnforcement);
  if (modeState.active !== true && !hasPendingQuestionObligation) return null;

  const phase = formatPhase(modeState.current_phase, "planning");
  if (TERMINAL_MODE_PHASES.has(phase.toLowerCase()) || phase === "completing") {
    return null;
  }

  const canonicalState = await readVisibleSkillActiveStateForStateDir(stateDir, sessionId);
  if (canonicalState) {
    const blocker = listActiveSkills(canonicalState).find((entry) => (
      entry.skill === "deep-interview"
      && matchesSkillStopContext(entry, canonicalState, sessionId, threadId)
    ));
    if (!blocker) return null;
  }

  if (!hasPendingQuestionObligation) {
    return null;
  }

  const obligationId = safeString(questionEnforcement.obligation_id).trim();
  if (!obligationId) return null;

  const systemMessage =
    `OMX deep-interview is still active (phase: ${phase}) and requires a structured question via omx question before stopping; read the returned answers[] JSON before continuing.`;

  return {
    obligationId,
    output: {
      decision: "block",
      reason:
        `Deep interview is still active (phase: ${phase}) and has a pending structured question obligation; use \`omx question\` before stopping.`,
      stopReason: "deep_interview_question_required",
      systemMessage,
    },
  };
}

function resolveRepeatableStopSessionId(
  payload: CodexHookPayload,
  canonicalSessionId?: string,
): string {
  const inheritedSessionId = safeString(process.env.OMX_SESSION_ID || process.env.CODEX_SESSION_ID).trim();
  return canonicalSessionId?.trim() || readPayloadSessionId(payload) || inheritedSessionId || "";
}

function isStateLevelStopSignatureKind(kind: string): boolean {
  return kind === "team-worker-stop" || kind === "team-stop";
}

function buildRepeatableStopSignature(
  payload: CodexHookPayload,
  kind: string,
  detail = "",
  canonicalSessionId?: string,
): string {
  const sessionId = resolveRepeatableStopSessionId(payload, canonicalSessionId) || "no-session";
  const threadId = readPayloadThreadId(payload) || "no-thread";
  const normalizedDetail = normalizeAutoNudgeSignatureText(detail) || safeString(detail).trim().toLowerCase();
  if (isStateLevelStopSignatureKind(kind)) {
    return [kind, sessionId, threadId, normalizedDetail || "no-detail"].join("|");
  }
  const turnId = readPayloadTurnId(payload);
  const transcriptPath = safeString(payload.transcript_path ?? payload.transcriptPath).trim() || "no-transcript";
  const lastAssistantMessage = normalizeAutoNudgeSignatureText(
    payload.last_assistant_message ?? payload.lastAssistantMessage,
  ) || "no-message";
  if (turnId) {
    return [
      kind,
      sessionId,
      threadId,
      turnId,
      transcriptPath,
      lastAssistantMessage,
      normalizedDetail || "no-detail",
    ].join("|");
  }
  return [
    kind,
    sessionId,
    threadId,
    transcriptPath,
    lastAssistantMessage,
    normalizedDetail || "no-detail",
  ].join("|");
}

function formatStopStatePath(cwd: string, statePath: string): string {
  const relativePath = relative(cwd, statePath);
  if (!relativePath || relativePath.startsWith("..")) return statePath;
  return relativePath.replace(/\\/g, "/");
}

function readNativeStopSessionKey(
  payload: CodexHookPayload,
  canonicalSessionId?: string,
): string {
  return resolveRepeatableStopSessionId(payload, canonicalSessionId) || readPayloadThreadId(payload) || "global";
}

function readPreviousNativeStopSignature(
  state: Record<string, unknown>,
  sessionKey: string,
): string {
  const sessions = safeObject(state.sessions);
  const sessionState = safeObject(sessions[sessionKey]);
  return safeString(sessionState.last_signature).trim();
}

function parseBoundedPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoundedNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeOrdinaryStopProgressText(value: unknown): string {
  return safeString(value)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function shortenOrdinaryStopProgressText(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= ORDINARY_STOP_NO_PROGRESS_MAX_MESSAGE_LENGTH) return trimmed;
  return `${trimmed.slice(0, ORDINARY_STOP_NO_PROGRESS_MAX_MESSAGE_LENGTH - 1).trimEnd()}…`;
}

function ordinaryStopProgressFingerprint(payload: CodexHookPayload): string {
  const message = normalizeOrdinaryStopProgressText(
    payload.last_assistant_message ?? payload.lastAssistantMessage,
  ) || "<no assistant message>";
  const mode = normalizeOrdinaryStopProgressText(payload.mode) || "ordinary";
  return `${mode}|${message}`;
}

function readIsoTimeMs(value: unknown): number | null {
  const parsed = Date.parse(safeString(value));
  return Number.isFinite(parsed) ? parsed : null;
}

async function maybeBuildOrdinaryStopNoProgressOutput(
  payload: CodexHookPayload,
  stateDir: string,
  canonicalSessionId?: string,
): Promise<Record<string, unknown> | null> {
  const lastAssistantMessage = safeString(
    payload.last_assistant_message ?? payload.lastAssistantMessage,
  ).trim();
  if (!lastAssistantMessage) return null;

  const statePath = join(stateDir, NATIVE_STOP_STATE_FILE);
  const state = await readJsonIfExists(statePath) ?? {};
  const sessions = safeObject(state.sessions);
  const sessionKey = readNativeStopSessionKey(payload, canonicalSessionId);
  const sessionState = safeObject(sessions[sessionKey]);
  const previousGuard = safeObject(sessionState.ordinary_no_progress_guard);
  const fingerprint = ordinaryStopProgressFingerprint(payload);
  const nowIso = new Date().toISOString();
  const previousFingerprint = safeString(previousGuard.fingerprint).trim();
  const sameFingerprint = previousFingerprint === fingerprint;
  const firstSeenAt = sameFingerprint
    ? safeString(previousGuard.first_seen_at).trim() || nowIso
    : nowIso;
  const repeatCount = sameFingerprint
    ? parseBoundedPositiveInteger(previousGuard.repeat_count, 1) + 1
    : 1;

  sessions[sessionKey] = {
    ...sessionState,
    ordinary_no_progress_guard: {
      fingerprint,
      first_seen_at: firstSeenAt,
      last_seen_at: nowIso,
      repeat_count: repeatCount,
      last_turn_id: readPayloadTurnId(payload) || null,
      last_thread_id: readPayloadThreadId(payload) || null,
    },
  };
  await mkdir(stateDir, { recursive: true });
  await writeFile(statePath, JSON.stringify({ ...state, sessions }, null, 2));

  const maxRepeats = parseBoundedPositiveInteger(
    process.env.OMX_NATIVE_STOP_NO_PROGRESS_MAX_REPEATS,
    ORDINARY_STOP_NO_PROGRESS_DEFAULT_MAX_REPEATS,
  );
  const idleMs = parseBoundedNonNegativeInteger(
    process.env.OMX_NATIVE_STOP_NO_PROGRESS_IDLE_MS,
    ORDINARY_STOP_NO_PROGRESS_DEFAULT_IDLE_MS,
  );
  const firstSeenMs = readIsoTimeMs(firstSeenAt) ?? Date.now();
  const elapsedMs = Math.max(0, Date.now() - firstSeenMs);
  if (repeatCount < maxRepeats || elapsedMs < idleMs) return null;

  const message = shortenOrdinaryStopProgressText(
    safeString(payload.last_assistant_message ?? payload.lastAssistantMessage) || "no assistant message recorded",
  );
  const elapsedSeconds = Math.round(elapsedMs / 1000);
  const diagnostic =
    `OMX ordinary task no-progress guard triggered after ${repeatCount} repeated Stop-hook pass(es) over ~${elapsedSeconds}s with unchanged status: "${message}". ` +
    "Emit a concise diagnostic summary now: state the last concrete progress/evidence, whether the task is complete, blocked, failed, or needs missing information, and stop instead of continuing a vague working loop.";

  return {
    decision: "block",
    reason: diagnostic,
    stopReason: "ordinary_task_no_progress_guard",
    systemMessage: diagnostic,
  };
}

async function persistNativeStopSignature(
  stateDir: string,
  payload: CodexHookPayload,
  signature: string,
  canonicalSessionId?: string,
): Promise<void> {
  if (!signature) return;
  const statePath = join(stateDir, NATIVE_STOP_STATE_FILE);
  const state = await readJsonIfExists(statePath) ?? {};
  const sessions = safeObject(state.sessions);
  const sessionKey = readNativeStopSessionKey(payload, canonicalSessionId);
  sessions[sessionKey] = {
    ...safeObject(sessions[sessionKey]),
    last_signature: signature,
    updated_at: new Date().toISOString(),
  };
  await mkdir(stateDir, { recursive: true });
  await writeFile(statePath, JSON.stringify({
    ...state,
    sessions,
  }, null, 2));
}

async function maybeReturnRepeatableStopOutput(
  payload: CodexHookPayload,
  stateDir: string,
  signature: string,
  output: Record<string, unknown> | null,
  canonicalSessionId?: string,
  options: { allowRepeatDuringStopHook?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  if (!output) return null;
  const stopHookActive = payload.stop_hook_active === true || payload.stopHookActive === true;
  if (stopHookActive && options.allowRepeatDuringStopHook !== true) {
    const state = await readJsonIfExists(join(stateDir, NATIVE_STOP_STATE_FILE)) ?? {};
    const previousSignature = readPreviousNativeStopSignature(
      state,
      readNativeStopSessionKey(payload, canonicalSessionId),
    );
    if (!signature || previousSignature === signature) {
      return null;
    }
  }
  await persistNativeStopSignature(stateDir, payload, signature, canonicalSessionId);
  return output;
}

async function returnPersistentStopBlock(
  payload: CodexHookPayload,
  stateDir: string,
  signatureKind: string,
  signatureValue: string,
  output: Record<string, unknown> | null,
  canonicalSessionId?: string,
  options: { allowRepeatDuringStopHook?: boolean } = { allowRepeatDuringStopHook: true },
): Promise<Record<string, unknown> | null> {
  return await maybeReturnRepeatableStopOutput(
    payload,
    stateDir,
    buildRepeatableStopSignature(payload, signatureKind, signatureValue, canonicalSessionId),
    output,
    canonicalSessionId,
    options,
  );
}

async function findCanonicalActiveTeamForSession(
  cwd: string,
  sessionId: string,
  threadId?: string,
): Promise<{ teamName: string; phase: string } | null> {
  if (!sessionId.trim()) return null;
  const teamsRoot = join(resolveCanonicalTeamStateRoot(cwd), "team");
  if (!existsSync(teamsRoot)) return null;

  const entries = await readdir(teamsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const teamName = entry.name.trim();
    if (!teamName) continue;

    const [manifest, phaseState] = await Promise.all([
      readTeamManifestV2(teamName, cwd),
      readTeamPhase(teamName, cwd),
    ]);
    if (!manifest || !phaseState) continue;
    const ownerSessionId = (manifest.leader?.session_id ?? "").trim();
    if (ownerSessionId && ownerSessionId !== sessionId.trim()) continue;
    if (!teamStateMatchesThreadForStop(manifest.leader as unknown as Record<string, unknown>, threadId)) continue;
    if (!isNonTerminalPhase(phaseState.current_phase)) continue;

    return {
      teamName,
      phase: formatPhase(phaseState.current_phase),
    };
  }

  return null;
}

async function resolveActiveTeamNameForStop(
  cwd: string,
  stateDir: string,
  sessionId: string,
  threadId?: string,
): Promise<string> {
  const directState = await readTeamModeStateForStop(cwd, stateDir, sessionId, threadId);
  const directTeamName = safeString(directState?.state.team_name).trim();
  if (directState?.state.active === true && directTeamName) return directTeamName;

  const canonicalTeam = await findCanonicalActiveTeamForSession(cwd, sessionId, threadId);
  return canonicalTeam?.teamName ?? "";
}

async function maybeBuildReleaseReadinessFinalizeStopOutput(
  payload: CodexHookPayload,
  cwd: string,
  stateDir: string,
  sessionId: string,
): Promise<{ matched: boolean; output: Record<string, unknown> | null }> {
  if (!sessionId) return { matched: false, output: null };

  const teamName = await resolveActiveTeamNameForStop(cwd, stateDir, sessionId, readPayloadThreadId(payload));
  if (!teamName) return { matched: false, output: null };

  const explicitReleaseReadinessContext =
    hasReleaseReadinessMode(payload)
    || await hasReleaseReadinessStopMarker(cwd, stateDir, sessionId, teamName);
  if (!explicitReleaseReadinessContext) {
    return { matched: false, output: null };
  }

  const summary = extractStableFinalRecommendationSummary(
    safeString(payload.last_assistant_message ?? payload.lastAssistantMessage),
  );
  if (!summary) return { matched: false, output: null };

  const leaderAttention = await readTeamLeaderAttention(teamName, cwd);
  if (
    !leaderAttention
    || leaderAttention.leader_decision_state !== "done_waiting_on_leader"
    || leaderAttention.work_remaining !== false
  ) {
    return { matched: false, output: null };
  }

  const signature = buildStableFinalRecommendationStopSignature(payload, teamName, summary);
  const output = await maybeReturnRepeatableStopOutput(
    payload,
    stateDir,
    signature,
    {
      decision: "block",
      reason:
        `Stable final recommendation already reached with no active worker tasks. Emit exactly one concise final decision summary aligned to "${summary}" with no filler or residual acknowledgements (for example "yes"), then stop.`,
      stopReason: "release_readiness_auto_finalize",
      systemMessage: RELEASE_READINESS_FINALIZE_SYSTEM_MESSAGE,
    },
    sessionId,
  );
  return { matched: true, output };
}

async function buildSkillStopOutput(
  cwd: string,
  stateDir: string,
  sessionId: string,
  threadId: string,
): Promise<Record<string, unknown> | null> {
  const blocker = await readBlockingSkillForStop(cwd, stateDir, sessionId, threadId);
  if (!blocker) return null;

  const subagentSummary = await readSubagentSessionSummary(cwd, sessionId).catch(() => null);
  const activeSubagentCount = subagentSummary?.activeSubagentThreadIds.length ?? 0;

  if (blocker.skill === "ralplan") {
    const status = buildRalplanContinuationStatus(blocker, activeSubagentCount, cwd);
    return {
      decision: "block",
      reason: status.reason,
      stopReason: `skill_${blocker.skill}_${blocker.phase}_${status.stopReasonSuffix}`,
      systemMessage: status.systemMessage,
    };
  }

  if (activeSubagentCount > 0) {
    return null;
  }

  return {
    decision: "block",
    reason: `OMX skill ${blocker.skill} is still active (phase: ${blocker.phase}); continue until the current ${blocker.skill} workflow reaches a terminal state.`,
    stopReason: `skill_${blocker.skill}_${blocker.phase}`,
    systemMessage: `OMX skill ${blocker.skill} is still active (phase: ${blocker.phase}).`,
  };
}

async function findActiveTeamForTransportFailure(
  cwd: string,
  sessionId: string,
): Promise<{ teamName: string; phase: string } | null> {
  const teamState = await readModeStateForSession("team", sessionId, cwd);
  if (teamState?.active === true) {
    const teamName = safeString(teamState.team_name).trim();
    const coarsePhase = formatPhase(teamState.current_phase);
    if (teamName) {
      const canonicalPhase = (await readTeamPhase(teamName, cwd))?.current_phase ?? coarsePhase;
      if (isNonTerminalPhase(canonicalPhase)) {
        return { teamName, phase: formatPhase(canonicalPhase) };
      }
    }
  }

  return await findCanonicalActiveTeamForSession(cwd, sessionId);
}

async function markTeamTransportFailure(
  cwd: string,
  payload: CodexHookPayload,
): Promise<void> {
  const canonicalSessionId = await resolveInternalSessionIdForPayload(cwd, readPayloadSessionId(payload));
  const activeTeam = await findActiveTeamForTransportFailure(cwd, canonicalSessionId);
  if (!activeTeam) return;

  const nowIso = new Date().toISOString();
  const existingPhase = await readTeamPhase(activeTeam.teamName, cwd);
  const currentPhase = existingPhase?.current_phase ?? activeTeam.phase;
  if (!isNonTerminalPhase(currentPhase)) return;

  await writeTeamPhase(
    activeTeam.teamName,
    {
      current_phase: "failed",
      max_fix_attempts: existingPhase?.max_fix_attempts ?? 3,
      current_fix_attempt: existingPhase?.current_fix_attempt ?? 0,
      transitions: [
        ...(existingPhase?.transitions ?? []),
        {
          from: formatPhase(currentPhase),
          to: "failed",
          at: nowIso,
          reason: "mcp_transport_dead",
        },
      ],
      updated_at: nowIso,
    },
    cwd,
  );

  const existingAttention = await readTeamLeaderAttention(activeTeam.teamName, cwd);
  await writeTeamLeaderAttention(
    activeTeam.teamName,
    {
      team_name: activeTeam.teamName,
      updated_at: nowIso,
      source: "notify_hook",
      leader_decision_state: existingAttention?.leader_decision_state ?? "still_actionable",
      leader_attention_pending: true,
      leader_attention_reason: "mcp_transport_dead",
      attention_reasons: [
        ...new Set([...(existingAttention?.attention_reasons ?? []), "mcp_transport_dead"]),
      ],
      leader_stale: existingAttention?.leader_stale ?? false,
      leader_session_active: existingAttention?.leader_session_active ?? true,
      leader_session_id: existingAttention?.leader_session_id ?? (canonicalSessionId || null),
      leader_session_stopped_at: existingAttention?.leader_session_stopped_at ?? null,
      unread_leader_message_count: existingAttention?.unread_leader_message_count ?? 0,
      work_remaining: existingAttention?.work_remaining ?? true,
      stalled_for_ms: existingAttention?.stalled_for_ms ?? null,
    },
    cwd,
  );

  await appendTeamEvent(
    activeTeam.teamName,
    {
      type: "leader_attention",
      worker: "leader-fixed",
      reason: "mcp_transport_dead",
      metadata: {
        phase_before: formatPhase(currentPhase),
      },
    },
    cwd,
  ).catch(() => {});

  try {
    await updateModeState(
      "team",
      {
        current_phase: "failed",
        error: "mcp_transport_dead",
        last_turn_at: nowIso,
      },
      cwd,
      canonicalSessionId || undefined,
    );
  } catch {
    // Canonical team state already carries the preserved failure for coarse-state-missing sessions.
  }
}

async function buildStopHookOutput(
  payload: CodexHookPayload,
  cwd: string,
  stateDir: string,
  options: { skipRalphStopBlock?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  if (isStopExempt(payload)) {
    return null;
  }

  const sessionId = readPayloadSessionId(payload);
  const canonicalSessionId = await resolveInternalSessionIdForPayload(cwd, sessionId);
  const threadId = readPayloadThreadId(payload);
  const suppressParentWorkflowStop = shouldSuppressParentWorkflowStopForSideConversation(payload);
  if (canonicalSessionId) {
    await reconcileStaleRootSkillActiveStateForStop(cwd, stateDir, canonicalSessionId);
  }
  if (suppressParentWorkflowStop) {
    return null;
  }
  const execFollowupOutput = await buildExecFollowupStopOutput(cwd, canonicalSessionId);
  if (execFollowupOutput) return execFollowupOutput;
  const ralphOwnerContext = {
    payloadSessionId: sessionId,
    threadId,
    tmuxPaneId: safeString(process.env.TMUX_PANE).trim(),
    payload,
  };
  const ralphCompletionAuditBlock = options.skipRalphStopBlock === true
    ? null
    : await readRalphCompletionAuditBlockState(cwd, stateDir, canonicalSessionId, ralphOwnerContext);
  if (ralphCompletionAuditBlock) {
    await reopenRalphCompletionAuditBlock(ralphCompletionAuditBlock);
    const blockingPath = formatStopStatePath(cwd, ralphCompletionAuditBlock.path);
    const systemMessage = [
      `OMX Ralph completion audit is missing required evidence (${ralphCompletionAuditBlock.reason}; state: ${blockingPath}).`,
      "Continue verification and do not report complete yet.",
      "Record machine-readable completion evidence before stopping:",
      '- either set "completion_audit" on the Ralph state object, for example: omx state write --input \'{"mode":"ralph","active":false,"current_phase":"complete","completion_audit":{"passed":true,"prompt_to_artifact_checklist":["..."],"verification_evidence":["..."]}}\' --json',
      "- or set completion_audit_path / completion_audit_evidence_path to a repo-relative JSON file with those same fields.",
      "Markdown artifacts and flat top-level checklist/evidence fields are not accepted by the Ralph Stop gate.",
    ].join(" ");
    return await returnPersistentStopBlock(
      payload,
      stateDir,
      "ralph-completion-audit-stop",
      `${blockingPath}|${ralphCompletionAuditBlock.reason}`,
      {
        decision: "block",
        reason: systemMessage,
        stopReason: `ralph_completion_audit_${ralphCompletionAuditBlock.reason}`,
        systemMessage,
      },
      canonicalSessionId,
      { allowRepeatDuringStopHook: true },
    );
  }
  const ralphState = options.skipRalphStopBlock === true
    ? null
    : await readActiveRalphState(cwd, stateDir, canonicalSessionId, ralphOwnerContext);
  if (!ralphState) {
    const autoresearchState = await readActiveAutoresearchState(cwd, canonicalSessionId);
    if (autoresearchState) {
      const completion = await readAutoresearchCompletionStatus(cwd, canonicalSessionId!.trim());
      if (!completion.complete) {
        const currentPhase = safeString(autoresearchState.current_phase ?? autoresearchState.currentPhase).trim() || 'executing';
        const systemMessage = `OMX autoresearch is still active (phase: ${currentPhase}); continue until validator evidence is complete before stopping.`;
        return await maybeReturnRepeatableStopOutput(
          payload,
          stateDir,
          buildRepeatableStopSignature(payload, 'autoresearch-stop', `${currentPhase}|${completion.reason}`, canonicalSessionId),
          {
            decision: 'block',
            reason: systemMessage,
            stopReason: `autoresearch_${currentPhase}`,
            systemMessage,
          },
          canonicalSessionId,
          { allowRepeatDuringStopHook: true },
        );
      }
    }

    const teamWorkerDecision = await resolveTeamWorkerStopDecision(cwd);
    if (teamWorkerDecision.kind === "blocked") {
      return await returnPersistentStopBlock(
        payload,
        stateDir,
        "team-worker-stop",
        safeString(teamWorkerDecision.output.stopReason),
        teamWorkerDecision.output,
        canonicalSessionId,
        { allowRepeatDuringStopHook: teamWorkerDecision.allowRepeatDuringStopHook },
      );
    }
    if (teamWorkerDecision.kind === "allowed") {
      try {
        await maybeNudgeLeaderForAllowedWorkerStop({
          stateDir: teamWorkerDecision.stateDir,
          logsDir: join(cwd, ".omx", "logs"),
          workerContext: teamWorkerDecision.workerContext,
        });
      } catch (err) {
        void err;
      }
      return null;
    }

    const autopilotOutput = await buildModeBasedStopOutput("autopilot", cwd, canonicalSessionId);
    if (autopilotOutput) {
      return await returnPersistentStopBlock(
        payload,
        stateDir,
        "autopilot-stop",
        safeString(autopilotOutput.stopReason),
        autopilotOutput,
        canonicalSessionId,
        { allowRepeatDuringStopHook: false },
      );
    }

    const ultraworkOutput = await buildModeBasedStopOutput("ultrawork", cwd, canonicalSessionId);
    if (ultraworkOutput) {
      return await returnPersistentStopBlock(
        payload,
        stateDir,
        "ultrawork-stop",
        safeString(ultraworkOutput.stopReason),
        ultraworkOutput,
        canonicalSessionId,
        { allowRepeatDuringStopHook: false },
      );
    }

    const ultraqaOutput = await buildModeBasedStopOutput("ultraqa", cwd, canonicalSessionId);
    if (ultraqaOutput) {
      return await returnPersistentStopBlock(
        payload,
        stateDir,
        "ultraqa-stop",
        safeString(ultraqaOutput.stopReason),
        ultraqaOutput,
        canonicalSessionId,
      );
    }

    const releaseReadinessFinalizeResult = await maybeBuildReleaseReadinessFinalizeStopOutput(
      payload,
      cwd,
      stateDir,
      canonicalSessionId,
    );
    if (releaseReadinessFinalizeResult.matched) return releaseReadinessFinalizeResult.output;

    const teamOutput = await buildTeamStopOutput(cwd, canonicalSessionId, threadId);
    if (teamOutput) {
      return await returnPersistentStopBlock(
        payload,
        stateDir,
        "team-stop",
        safeString(teamOutput.stopReason),
        teamOutput,
        canonicalSessionId,
      );
    }

    if (canonicalSessionId) {
      const deepInterviewQuestionOutput = await buildDeepInterviewQuestionStopOutput(
        cwd,
        stateDir,
        canonicalSessionId,
        threadId,
      );
      if (deepInterviewQuestionOutput) {
        return await returnPersistentStopBlock(
          payload,
          stateDir,
          "deep-interview-question-stop",
          deepInterviewQuestionOutput.obligationId,
          deepInterviewQuestionOutput.output,
          canonicalSessionId,
        );
      }

      const canonicalTeam = await readCanonicalTerminalRunStateForStop(cwd, canonicalSessionId, "team")
        ? null
        : await findCanonicalActiveTeamForSession(cwd, canonicalSessionId, threadId);
      if (canonicalTeam) {
        const canonicalTeamOutput = buildTeamStopOutputForPhase(
          canonicalTeam.teamName,
          canonicalTeam.phase,
        );
        const repeatedCanonicalTeamOutput = await returnPersistentStopBlock(
          payload,
          stateDir,
          "team-stop",
          `${canonicalTeam.teamName}|${canonicalTeam.phase}`,
          canonicalTeamOutput,
          canonicalSessionId,
        );
        if (repeatedCanonicalTeamOutput) return repeatedCanonicalTeamOutput;
      }

      const skillOutput = await buildSkillStopOutput(cwd, stateDir, canonicalSessionId, threadId);
      if (skillOutput) {
        return await returnPersistentStopBlock(
          payload,
          stateDir,
          "skill-stop",
          safeString(skillOutput.stopReason),
          skillOutput,
          canonicalSessionId,
        );
      }
    }


    const lastAssistantMessage = safeString(
      payload.last_assistant_message ?? payload.lastAssistantMessage,
    );
    const goalWorkflowStopOutput = await buildGoalWorkflowReconciliationStopOutput(payload, cwd);
    if (goalWorkflowStopOutput) {
      return await returnPersistentStopBlock(
        payload,
        stateDir,
        "goal-workflow-reconciliation-stop",
        safeString(goalWorkflowStopOutput.stopReason),
        goalWorkflowStopOutput,
        canonicalSessionId,
        { allowRepeatDuringStopHook: true },
      );
    }
    const ordinaryNoProgressOutput = await maybeBuildOrdinaryStopNoProgressOutput(
      payload,
      stateDir,
      canonicalSessionId,
    );
    if (ordinaryNoProgressOutput) return ordinaryNoProgressOutput;

    const autoNudgeConfig = await loadAutoNudgeConfig();
    const autoNudgePhase = await readStopAutoNudgePhase(cwd, stateDir, canonicalSessionId, threadId);

    if (
      autoNudgeConfig.enabled
      && detectNativeStopStallPattern(lastAssistantMessage, autoNudgeConfig.patterns, autoNudgePhase)
    ) {
      const effectiveResponse = resolveEffectiveAutoNudgeResponse(autoNudgeConfig.response);
      return await returnPersistentStopBlock(
        payload,
        stateDir,
        "auto-nudge",
        lastAssistantMessage,
        {
          decision: "block",
          reason: effectiveResponse,
          stopReason: "auto_nudge",
          systemMessage:
            "OMX native Stop detected a stall/permission-style handoff and continued the turn automatically.",
        },
        canonicalSessionId,
      );
    }

    const sloppyFallbackDiffFindings = findSloppyFallbackDiffFindings(cwd);
    const sloppyFallbackDiffOutput = buildSloppyFallbackDiffStopOutput(sloppyFallbackDiffFindings);
    if (sloppyFallbackDiffOutput) {
      return await returnPersistentStopBlock(
        payload,
        stateDir,
        "sloppy-fallback-diff-stop",
        JSON.stringify(sloppyFallbackDiffFindings),
        sloppyFallbackDiffOutput,
        canonicalSessionId,
        { allowRepeatDuringStopHook: true },
      );
    }

    if (isFinalHandoffDocumentRefreshCandidate(lastAssistantMessage)) {
      const documentRefreshWarning = evaluateFinalHandoffDocumentRefresh(cwd, lastAssistantMessage);
      if (documentRefreshWarning) {
        return await maybeReturnRepeatableStopOutput(
          payload,
          stateDir,
          buildRepeatableStopSignature(
            payload,
            "document-refresh-stop",
            documentRefreshWarning.triggeringPaths.join("|"),
            canonicalSessionId,
          ),
          buildDocumentRefreshAdvisoryOutput(documentRefreshWarning, "Stop"),
          canonicalSessionId,
          { allowRepeatDuringStopHook: false },
        );
      }
    }

    return null;
  }

  const currentPhase = safeString(ralphState.state.current_phase).trim() || "executing";
  const blockingPath = formatStopStatePath(cwd, ralphState.path);
  const stopReason = `ralph_${currentPhase}`;
  const systemMessage =
    `OMX Ralph is still active (phase: ${currentPhase}; state: ${blockingPath}); continue the task and gather fresh verification evidence before stopping.`;

  return await returnPersistentStopBlock(
    payload,
    stateDir,
    "ralph-stop",
    currentPhase,
    {
      decision: "block",
      reason: systemMessage,
      stopReason,
      systemMessage,
    },
    canonicalSessionId,
  );
}

export async function dispatchCodexNativeHook(
  payload: CodexHookPayload,
  options: NativeHookDispatchOptions = {},
): Promise<NativeHookDispatchResult> {
  const hookEventName = readHookEventName(payload);
  const cwd = options.cwd ?? (safeString(payload.cwd).trim() || process.cwd());
  if (hookEventName === "Stop" && !hasNativeStopRuntimeSurface(cwd)) {
    return {
      hookEventName,
      omxEventName: mapCodexHookEventToOmxEvent(hookEventName),
      skillState: null,
      outputJson: null,
    };
  }
  // Native hooks must use the same authoritative runtime state root as HUD/MCP
  // when boxed/team roots are active; do not bypass it with cwd/.omx/state.
  const stateDir = getBaseStateDir(cwd);
  if (hookEventName !== "Stop") {
    await mkdir(stateDir, { recursive: true });
  }

  const omxEventName = mapCodexHookEventToOmxEvent(hookEventName);
  let skillState: SkillActiveState | null = null;
  let triageAdditionalContext: string | null = null;
  let goalWorkflowAdditionalContext: string | null = null;
  let ultragoalSteeringAdditionalContext: string | null = null;

  const nativeSessionId = safeString(payload.session_id ?? payload.sessionId).trim();
  const threadId = safeString(payload.thread_id ?? payload.threadId).trim();
  const turnId = safeString(payload.turn_id ?? payload.turnId).trim();
  const currentSessionState = await readUsableSessionState(cwd);
  let canonicalSessionId = safeString(currentSessionState?.session_id).trim();
  let resolvedNativeSessionId = nativeSessionId;
  let skipCanonicalSessionStartContext = false;
  let isSubagentSessionStart = false;

  if (hookEventName === "SessionStart" && nativeSessionId) {
    const transcriptPath = safeString(payload.transcript_path ?? payload.transcriptPath).trim();
    const subagentSessionStart = readNativeSubagentSessionStartMetadata(transcriptPath);
    if (subagentSessionStart) {
      // A native child/subagent SessionStart carries a parent_thread_id in its
      // transcript session_meta. Treat it as a child-agent lifecycle event for
      // notification suppression and subagent tracking even when the canonical
      // leader session has not been reconciled yet (#2831). A child start must
      // never promote itself into a root/leader session or emit an independent
      // session-start notification at session/minimal verbosity.
      isSubagentSessionStart = true;
      if (canonicalSessionId) {
        const belongsToCanonicalSession = await nativeSubagentSessionStartBelongsToCanonicalSession(
          cwd,
          canonicalSessionId,
          currentSessionState,
          subagentSessionStart,
        );
        if (belongsToCanonicalSession) {
          resolvedNativeSessionId = nativeSessionId;
          await recordNativeSubagentSessionStart(
            cwd,
            canonicalSessionId,
            nativeSessionId,
            subagentSessionStart,
            transcriptPath,
          );
        } else {
          skipCanonicalSessionStartContext = true;
          resolvedNativeSessionId =
            safeString(currentSessionState?.native_session_id).trim() || nativeSessionId;
          await recordIgnoredNativeSubagentSessionStart(
            cwd,
            canonicalSessionId,
            nativeSessionId,
            subagentSessionStart,
            transcriptPath,
          );
        }
      } else {
        // No canonical leader session is resolved in this worktree yet. Still
        // register the child thread under its parent so its later Stop is
        // recognized as subagent-scoped, skip leader SessionStart context, and
        // do not reconcile the child as a new root session.
        skipCanonicalSessionStartContext = true;
        resolvedNativeSessionId = nativeSessionId;
        await recordNativeSubagentSessionStart(
          cwd,
          canonicalSessionId,
          nativeSessionId,
          subagentSessionStart,
          transcriptPath,
        );
      }
    } else {
      const sessionState = await reconcileNativeSessionStart(cwd, nativeSessionId, {
        pid: options.sessionOwnerPid ?? resolveSessionOwnerPid(payload),
      });
      canonicalSessionId = safeString(sessionState.session_id).trim();
      resolvedNativeSessionId = safeString(sessionState.native_session_id).trim() || nativeSessionId;
    }
  } else if (!canonicalSessionId) {
    canonicalSessionId = safeString(currentSessionState?.session_id).trim();
  }

  if (hookEventName === "Stop") {
    const inheritedSessionId = safeString(process.env.OMX_SESSION_ID || process.env.CODEX_SESSION_ID).trim();
    const stopCanonicalSessionId = await resolveInternalSessionIdForPayload(
      cwd,
      readPayloadSessionId(payload) || inheritedSessionId,
    );
    if (stopCanonicalSessionId) {
      canonicalSessionId = stopCanonicalSessionId;
    }
    if (canonicalSessionId && safeString(currentSessionState?.session_id).trim() === canonicalSessionId) {
      resolvedNativeSessionId =
        safeString(currentSessionState?.native_session_id).trim() || resolvedNativeSessionId;
    }
  }

  const eventSessionId = canonicalSessionId || nativeSessionId || undefined;
  const sessionIdForState = canonicalSessionId || nativeSessionId;
  let outputJson: Record<string, unknown> | null = null;
  const isSubagentPromptSubmit = hookEventName === "UserPromptSubmit"
    ? await isNativeSubagentHook(
      cwd,
      canonicalSessionId,
      nativeSessionId,
      threadId,
      safeString(currentSessionState?.native_session_id).trim(),
    )
    : false;
  const isSubagentStop = hookEventName === "Stop"
    ? (await Promise.all(
      [...new Set([
        canonicalSessionId,
        safeString(currentSessionState?.session_id).trim(),
      ].filter(Boolean))]
        .map((candidateSessionId) => isNativeSubagentHook(
          cwd,
          candidateSessionId,
          nativeSessionId,
          threadId,
          candidateSessionId === safeString(currentSessionState?.session_id).trim()
            ? safeString(currentSessionState?.native_session_id).trim()
            : "",
        )),
    )).some(Boolean)
    : false;
  const suppressNoisySubagentLifecycleDispatch =
    (isSubagentSessionStart || isSubagentStop)
    && shouldSuppressSubagentLifecycleHookDispatch();

  if (hookEventName === "UserPromptSubmit") {
    const prompt = readPromptText(payload);
    goalWorkflowAdditionalContext = await buildCompletedGoalCleanupPromptWarning(cwd, prompt).catch(() => null)
      ?? await buildGoalWorkflowReconciliationPromptWarning(cwd, prompt).catch(() => null);
    ultragoalSteeringAdditionalContext = prompt && !isSubagentPromptSubmit
      ? await applyUserPromptUltragoalSteering(cwd, prompt).catch((error) => `OMX native UserPromptSubmit rejected bounded .omx/ultragoal steering for G002-cli-and-prompt-submit-bridge: ${error instanceof Error ? error.message : String(error)}`)
      : null;
    if (prompt && !isSubagentPromptSubmit) {
      skillState = buildNativeOutsideTmuxTeamPromptBlockState(
        prompt,
        cwd,
        payload,
        sessionIdForState,
        threadId || undefined,
        turnId || undefined,
      ) ?? await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: prompt,
        sessionId: sessionIdForState,
        threadId,
        turnId,
      });
    }
    // --- Triage classifier (advisory-only, non-keyword prompts) ---
    if (prompt && skillState === null && !isSubagentPromptSubmit) {
      try {
        if (readTriageConfig().enabled) {
          const normalized = prompt.trim().toLowerCase();
          const previous = readTriageState({ cwd, sessionId: sessionIdForState || null });
          const suppress = shouldSuppressFollowup({
            previous,
            currentPrompt: normalized,
            currentHasKeyword: false,
          });
          if (!suppress) {
            const decision = triagePrompt(prompt);
            const nowIso = new Date().toISOString();
            const effectiveTurnId = turnId || nowIso;
            if (decision.lane === "HEAVY") {
              triageAdditionalContext =
                "OMX native UserPromptSubmit triage detected a multi-step goal with no workflow keyword. This is advisory prompt-routing context only; it did not activate autopilot or initialize workflow state. Prefer the existing autopilot-style workflow if AGENTS.md/runtime conditions allow it, unless newer user context narrows or opts out.";
              const newState: TriageStateFile = {
                version: 1,
                last_triage: {
                  lane: "HEAVY",
                  destination: "autopilot",
                  reason: decision.reason,
                  prompt_signature: promptSignature(normalized),
                  turn_id: effectiveTurnId,
                  created_at: nowIso,
                },
                suppress_followup: true,
              };
              writeTriageState({ cwd, sessionId: sessionIdForState || null, state: newState });
            } else if (decision.lane === "LIGHT") {
              if (decision.destination === "explore") {
                triageAdditionalContext =
                  "OMX native UserPromptSubmit triage detected a read-only/question-shaped request with no workflow keyword. This is advisory prompt-routing context only. Prefer the explore role surface rather than escalating to autopilot.";
              } else if (decision.destination === "executor") {
                triageAdditionalContext =
                  "OMX native UserPromptSubmit triage detected a narrow edit-shaped request with no workflow keyword. This is advisory prompt-routing context only. Prefer the executor role surface rather than autopilot.";
              } else if (decision.destination === "designer") {
                triageAdditionalContext =
                  "OMX native UserPromptSubmit triage detected a visual/style request with no workflow keyword. This is advisory prompt-routing context only. Prefer the designer role surface.";
              } else if (decision.destination === "researcher") {
                triageAdditionalContext =
                  "OMX native UserPromptSubmit triage detected an external documentation/reference research request with no workflow keyword. This is advisory prompt-routing context only. Prefer the researcher role surface rather than repo-local explore or autopilot.";
              }
              if (triageAdditionalContext !== null) {
                const dest = decision.destination as "explore" | "executor" | "designer" | "researcher";
                const newState: TriageStateFile = {
                  version: 1,
                  last_triage: {
                    lane: "LIGHT",
                    destination: dest,
                    reason: decision.reason,
                    prompt_signature: promptSignature(normalized),
                    turn_id: effectiveTurnId,
                    created_at: nowIso,
                  },
                  suppress_followup: true,
                };
                writeTriageState({ cwd, sessionId: sessionIdForState || null, state: newState });
              }
            }
            // lane === "PASS": no context, no state write
          }
        }
      } catch {
        // Swallow all triage errors; never break the hook
        triageAdditionalContext = null;
      }
    }
    const skipHudReconcileForDoctorSmoke = process.env.OMX_NATIVE_HOOK_DOCTOR_SMOKE === "1";
    const skipHudReconcileForTeamWorkerPane = !isSubagentPromptSubmit
      && await isConfirmedTeamWorkerPromptSubmitPane(cwd).catch(() => false);
    if (!skipHudReconcileForDoctorSmoke && !skipHudReconcileForTeamWorkerPane) {
      const reconcileHudForPromptSubmitFn = options.reconcileHudForPromptSubmitFn ?? reconcileHudForPromptSubmit;
      const hudSessionId = resolveHudReconcileSessionId(
        currentSessionState,
        canonicalSessionId,
        sessionIdForState,
      );
      const hudSessionIds = resolveHudReconcileSessionIds(
        currentSessionState,
        canonicalSessionId,
        sessionIdForState,
        nativeSessionId,
      );
      await reconcileHudForPromptSubmitFn(cwd, { sessionId: hudSessionId, sessionIds: hudSessionIds }).catch(() => {});
    }
  }

  if (omxEventName && !skipCanonicalSessionStartContext && !suppressNoisySubagentLifecycleDispatch) {
    const baseContext = buildBaseContext(cwd, payload, hookEventName!, canonicalSessionId);
    if (resolvedNativeSessionId) {
      baseContext.native_session_id = resolvedNativeSessionId;
      baseContext.codex_session_id = resolvedNativeSessionId;
    }
    if (canonicalSessionId) {
      baseContext.omx_session_id = canonicalSessionId;
    }
    const event: HookEventEnvelope = buildNativeHookEvent(
      omxEventName,
      baseContext,
      {
        session_id: eventSessionId,
        thread_id: threadId || undefined,
        turn_id: turnId || undefined,
        mode: safeString(payload.mode).trim() || undefined,
      },
    );
    await dispatchHookEventRuntime({
      event,
      cwd,
      allowTeamWorkerSideEffects: false,
    });
  }

  if (hookEventName === "PreCompact") {
    // Codex native PreCompact currently accepts only the common continuation fields.
    // Keep the OMX lifecycle dispatch above, but do not emit `hookSpecificOutput`
    // unless Codex defines a supported PreCompact output contract.
    buildWikiPreCompactContext({ cwd });
  } else if ((hookEventName === "SessionStart" && !skipCanonicalSessionStartContext) || hookEventName === "UserPromptSubmit") {
    const additionalContext = hookEventName === "SessionStart"
      ? await buildSessionStartContext(cwd, canonicalSessionId || nativeSessionId, {
        hookEventName,
        payload,
        canonicalSessionId,
        nativeSessionId: resolvedNativeSessionId || nativeSessionId,
      })
      : isSubagentPromptSubmit
        ? null
        : [
          buildAdditionalContextMessage(readPromptText(payload), skillState, cwd, payload),
          ultragoalSteeringAdditionalContext,
          goalWorkflowAdditionalContext,
          triageAdditionalContext,
        ].filter((entry): entry is string => Boolean(entry)).join("\n\n") || null;
    if (additionalContext) {
      outputJson = {
        hookSpecificOutput: {
          hookEventName,
          additionalContext,
        },
      };
    }
  } else if (hookEventName === "PreToolUse") {
    const payloadSessionId = readPayloadSessionId(payload);
    const rootPointerConflict = await readLiveRootSessionPointerConflict(stateDir, payloadSessionId);
    const preToolUseSessionId = payloadSessionId
      ? await resolveInternalSessionIdForPayload(cwd, payloadSessionId, stateDir)
      : "";
    outputJson = await buildDeepInterviewPreToolUseBoundaryOutput(payload, cwd, stateDir, preToolUseSessionId)
      ?? await buildRalplanPreToolUseBoundaryOutput(payload, cwd, stateDir, preToolUseSessionId)
      ?? await buildPlanningRootPointerConflictPreToolUseOutput(payload, cwd, stateDir, rootPointerConflict)
      ?? await buildNativeSubagentCapacityCloseGuardOutput(payload, cwd, stateDir)
      ?? buildMalformedPreToolUseBlockTestOutput(payload)
      ?? buildNativePreToolUseOutput(payload);
  } else if (hookEventName === "PostToolUse") {
    await recordNativeSubagentCapacityBlocker(cwd, stateDir, payload).catch(() => {});
    if (detectMcpTransportFailure(payload)) {
      await markTeamTransportFailure(cwd, payload);
    }
    outputJson = buildNativePostToolUseOutput(payload);
    await handleTeamWorkerPostToolUseSuccess(payload, cwd);
  } else if (hookEventName === "Stop") {
    outputJson = await buildStopHookOutput(payload, cwd, stateDir, {
      skipRalphStopBlock: isSubagentStop,
    }) ?? await buildCompletedGoalCleanupStopOutput(payload, cwd);
  }

  return {
    hookEventName,
    omxEventName,
    skillState,
    outputJson,
  };
}

function hasNativeStopRuntimeSurface(cwd: string): boolean {
  if (existsSync(join(cwd, ".omx"))) return true;
  if (findGitLayout(cwd)) return true;
  const omxRoot = safeString(process.env.OMX_ROOT).trim();
  if (omxRoot && existsSync(join(omxRoot, ".omx"))) return true;
  const stateRoot = safeString(process.env.OMX_STATE_ROOT).trim();
  if (stateRoot && existsSync(stateRoot)) return true;
  return [
    process.env.OMX_SESSION_ID,
    process.env.OMX_TEAM_INTERNAL_WORKER,
    process.env.OMX_TEAM_WORKER,
    process.env.OMX_TEAM_STATE_ROOT,
    process.env.OMX_TEAM_LEADER_CWD,
    process.env.OMX_NOTIFY_HOOK_TRUSTED_MANAGED_CWD,
    process.env.OMX_TMUX_HUD_OWNER,
    process.env.OMX_TMUX_HUD_LEADER_PANE,
  ].some((value) => safeString(value).trim() !== "");
}

interface NativeHookCliReadResult {
  payload: CodexHookPayload;
  parseError: Error | null;
  rawInput: string;
  oversized: boolean;
  rawHookEventName: CodexHookEventName | null;
}

export function isCodexNativeHookMainModule(
  moduleUrl: string,
  argv1: string | undefined,
): boolean {
  if (!argv1) return false;
  return moduleUrl === pathToFileURL(argv1).href;
}

async function readStdinJson(): Promise<NativeHookCliReadResult> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let oversized = false;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_NATIVE_STDIN_JSON_BYTES) {
      const remaining = Math.max(0, MAX_NATIVE_STDIN_JSON_BYTES - (totalBytes - buffer.byteLength));
      if (remaining > 0) chunks.push(Buffer.from(buffer.subarray(0, remaining)));
      oversized = true;
      process.stdin.destroy();
      break;
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  const rawHookEventName = extractRawCodexHookEventName(raw);
  if (oversized) {
    return {
      payload: {},
      parseError: null,
      rawInput: raw,
      oversized: true,
      rawHookEventName,
    };
  }
  if (!raw) {
    return { payload: {}, parseError: null, rawInput: raw, oversized: false, rawHookEventName };
  }

  try {
    return {
      payload: safeObject(JSON.parse(raw)),
      parseError: null,
      rawInput: raw,
      oversized: false,
      rawHookEventName,
    };
  } catch (error) {
    return {
      payload: {},
      parseError: error instanceof Error ? error : new Error(String(error)),
      rawInput: raw,
      oversized: false,
      rawHookEventName,
    };
  }
}

function inferHookEventNameFromMalformedInput(raw: string): CodexHookEventName | null {
  const match = raw.match(/(?:\"|['"])?hook[_-]?event[_-]?name(?:\"|['"])?\s*:\s*(?:\"|['"])?(SessionStart|PreToolUse|PostToolUse|UserPromptSubmit|PreCompact|PostCompact|Stop)\b/i);
  const value = match?.[1];
  if (!value) return null;
  return readHookEventName({ hook_event_name: value });
}

function buildMalformedStdinHookOutput(
  parseError: Error,
  rawInput: string,
  cwd = process.cwd(),
): Record<string, unknown> {
  const reason =
    "OMX native hook received malformed JSON input. Preserve runtime state, inspect the emitting hook payload yourself, and retry with valid JSON.";
  const systemMessage =
    `${reason} stdin JSON parsing failed inside codex-native-hook: ${parseError.message}.`;
  const inferredHookEventName = inferHookEventNameFromMalformedInput(rawInput);
  if (inferredHookEventName === "PreToolUse") {
    return { systemMessage };
  }
  if (inferredHookEventName === "Stop" || (!inferredHookEventName && hasNativeStopRuntimeSurface(cwd))) {
    return {
      decision: "block",
      reason,
      stopReason: "native_hook_stdin_parse_error",
      systemMessage,
    };
  }
  return {
    continue: false,
    stopReason: "native_hook_stdin_parse_error",
    systemMessage,
  };
}

async function buildOversizedStopActiveWorkflowOutput(cwd: string): Promise<Record<string, unknown> | null> {
  const currentSession = await readUsableSessionState(cwd);
  const currentSessionId = safeString(currentSession?.session_id).trim()
    || safeString(process.env.OMX_SESSION_ID || process.env.CODEX_SESSION_ID).trim();
  if (!currentSessionId) return null;

  if (await readCanonicalTerminalRunStateForStop(cwd, currentSessionId, "autopilot")) return null;

  const autopilotState = await readModeStateForActiveDecision("autopilot", currentSessionId, cwd);
  if (!autopilotState || !shouldContinueRun(autopilotState)) return null;

  const phase = formatPhase(autopilotState.current_phase);
  const reason =
    `OMX native Stop received oversized stdin before parsing while the current session has active OMX autopilot state (phase: ${phase}); continue once with a compact response or reduce hook payload size so normal Stop gates can run.`;
  return {
    decision: "block",
    reason,
    stopReason: "native_stop_stdin_oversized_active_workflow",
    systemMessage:
      "OMX native Stop rejected oversized stdin before parsing; active current-session workflow state is present, so Stop is blocked instead of silently allowing termination.",
  };
}

function buildOversizedStopInactiveWorkflowOutput(): Record<string, unknown> {
  return {};
}

async function buildOversizedStdinHookOutput(
  rawHookEventName: CodexHookEventName | null,
  cwd: string,
): Promise<Record<string, unknown>> {
  const systemMessage =
    `OMX native hook rejected oversized stdin JSON before parsing; maxBytes=${MAX_NATIVE_STDIN_JSON_BYTES}.`;
  if (rawHookEventName === "PreToolUse") {
    return { systemMessage };
  }
  if (rawHookEventName === "Stop") {
    return await buildOversizedStopActiveWorkflowOutput(cwd) ?? buildOversizedStopInactiveWorkflowOutput();
  }
  return {
    continue: false,
    stopReason: "native_hook_stdin_oversized",
    systemMessage,
  };
}

function writeNativeHookJsonStdout(output: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function redactMalformedHookPreview(rawInput: string): string {
  const withoutControls = rawInput.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  const withoutAuthSecrets = redactAuthSecrets(withoutControls);
  return withoutAuthSecrets
    .replace(
      /(["']?(?:prompt|user_prompt|input|text)["']?\s*:\s*)(["'])(?:\\.|(?!\2)[^\\])*\2/gi,
      "$1$2[REDACTED]$2",
    )
    .replace(
      /(["']?(?:prompt|user_prompt|input|text)["']?\s*:\s*)(["'])(?:\\.|[^\\])*$/gi,
      "$1$2[REDACTED]$2",
    )
    .replace(
      /(["']?(?:prompt|user_prompt|input|text)["']?\s*:\s*)(?!["'])[^,}]*/gi,
      "$1[REDACTED]",
    );
}

function buildRawInputLogFields(rawInput: string): Record<string, unknown> {
  if (!rawInput) return {};
  return {
    raw_input_length: Buffer.byteLength(rawInput, "utf-8"),
    raw_input_prefix: redactMalformedHookPreview(rawInput).slice(0, 240),
  };
}

async function logNativeHookCliError(
  cwd: string,
  type: string,
  error: unknown,
  payload: CodexHookPayload = {},
  details: Record<string, unknown> = {},
): Promise<void> {
  const logsDir = join(cwd || process.cwd(), ".omx", "logs");
  await mkdir(logsDir, { recursive: true }).catch(() => {});
  const logPath = join(logsDir, `native-hook-${new Date().toISOString().split("T")[0]}.jsonl`);
  await appendFile(
    logPath,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type,
      hook_event_name: readHookEventName(payload) ?? "Unknown",
      session_id: readPayloadSessionId(payload) || undefined,
      thread_id: readPayloadThreadId(payload) || undefined,
      turn_id: readPayloadTurnId(payload) || undefined,
      error: error instanceof Error ? error.message : String(error),
      ...details,
    }) + "\n",
  ).catch(() => {});
}

function isStopDispatchFailureTestTrigger(payload: CodexHookPayload): boolean {
  return process.env.NODE_ENV === "test"
    && process.env.OMX_NATIVE_HOOK_TEST_THROW_STOP_DISPATCH === "1"
    && readHookEventName(payload) === "Stop";
}

function isDispatchFailureTestTrigger(): boolean {
  return process.env.NODE_ENV === "test"
    && process.env.OMX_NATIVE_HOOK_TEST_THROW_DISPATCH === "1";
}

function buildMalformedPreToolUseBlockTestOutput(payload: CodexHookPayload): Record<string, unknown> | null {
  if (process.env.NODE_ENV !== "test" || readHookEventName(payload) !== "PreToolUse") return null;
  switch (process.env.OMX_NATIVE_HOOK_TEST_MALFORMED_PRETOOL_BLOCK) {
    case "legacy":
      return {
        decision: "block",
        systemMessage: "This advisory text must not validate a malformed legacy PreToolUse block.",
      };
    case "deny":
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "   ",
        },
        systemMessage: "This advisory text must not validate a malformed deny PreToolUse block.",
      };
    default:
      return null;
  }
}

function buildStopDispatchFailureOutput(error: unknown): Record<string, unknown> {
  const detail = error instanceof Error ? error.message : String(error);
  const reason =
    "OMX native Stop hook failed before normal continuation handling. Continue once more, preserve runtime state, inspect the hook logs, and retry with a valid Stop JSON response.";
  return {
    decision: "block",
    reason,
    stopReason: "native_stop_dispatch_failure",
    systemMessage: `${reason} Failure: ${detail}`,
  };
}

export async function runCodexNativeHookCli(): Promise<void> {
  const { payload, parseError, rawInput, oversized, rawHookEventName } = await readStdinJson();
  if (oversized) {
    writeNativeHookJsonStdout(await buildOversizedStdinHookOutput(rawHookEventName, process.cwd()));
    return;
  }
  if (parseError) {
    await logNativeHookCliError(
      process.cwd(),
      "native_hook_stdin_parse_error",
      parseError,
      {},
      buildRawInputLogFields(rawInput),
    );
    writeNativeHookJsonStdout(buildMalformedStdinHookOutput(parseError, rawInput, process.cwd()));
    return;
  }

  try {
    if (isStopDispatchFailureTestTrigger(payload)) {
      throw new Error("test-induced Stop dispatch failure");
    }
    if (isDispatchFailureTestTrigger()) {
      throw new Error("test-induced dispatch failure");
    }

    const result = await dispatchCodexNativeHook(payload);
    if (result.outputJson) {
      writeNativeHookJsonStdout(sanitizeCodexHookOutput(result.hookEventName, result.outputJson) ?? {});
    } else if (result.hookEventName !== "PreCompact" && result.hookEventName !== "PostCompact") {
      writeNativeHookJsonStdout({});
    }
  } catch (error) {
    const cwd = safeString(payload.cwd).trim() || process.cwd();
    await logNativeHookCliError(cwd, "native_hook_dispatch_error", error, payload);
    if (readHookEventName(payload) === "Stop") {
      writeNativeHookJsonStdout(buildStopDispatchFailureOutput(error));
    } else {
      process.exitCode = 1;
    }
  }
}

if (isCodexNativeHookMainModule(import.meta.url, process.argv[1])) {
  runCodexNativeHookCli().catch((error) => {
    process.exitCode = 1;
    void logNativeHookCliError(process.cwd(), "native_hook_fatal_error", error);
  });
}
