import { execFileSync } from "child_process";
import { accessSync, closeSync, constants as fsConstants, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "fs";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "path";

import { fileURLToPath, pathToFileURL } from "url";
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
  readSubagentSessionLedger,
  readSubagentTrackingState,
  recordSubagentTurnForSession,
  resolveInstalledRoleName,
} from "../subagents/tracker.js";
import { readRoleRoutingMarker, writeRoleRoutingMarker } from "../subagents/role-routing-marker.js";
import { evaluateCodex01445PreToolUse } from "../ralplan/documented-leader-preflight.js";
import {
  resolveCanonicalTeamStateRoot,
  resolveWorkerNotifyTeamStateRootPath,
  resolveWorkerTeamStateRootPath,
} from "../team/state-root.js";
import { inferTerminalLifecycleOutcome } from "../runtime/run-outcome.js";
import {
  appendPromptSessionProvenanceRejection,
  appendToLog,
  isSessionPointerLaunchAbort,
  isSessionStale,
  isSessionStateUsable,
  normalizeSessionId,
  readSessionPointer,
  readSessionState,
  readUsableSessionState,
  reconcileNativeSessionStart,
  resolveSessionPointerContext,
  type SessionStartOptions,
  type SessionState,
} from "../hooks/session.js";
import {
  evaluateResolvedPromptTurn,
  extractSelectedTargetOwnerEvidence,
  preflightSelectedTargetOwner,
  type PromptThreadFacts,
  type ResolvedPromptTurnContext,
} from "../hooks/prompt-session-provenance.js";
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
import {
  getAuthoritativeActiveStatePaths,
  getBaseStateDir,
  getStateFilePath,
  getStatePath,
  resolveWritableStateScope,
  WRITABLE_STATE_SCOPE_ERRORS,
} from "../mcp/state-paths.js";
import {
  classifyKeywordInput,
  recordSkillActivation,
  type KeywordInputClassification,
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
import { probeActualTmuxInstanceEvidence, tmuxEvidenceBindsCandidate } from "./notify-hook/managed-tmux.js";
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
import { deriveAutopilotChildPhase, normalizeAutopilotPhase } from "../autopilot/fsm.js";
import {
  CONDUCTOR_ORCHESTRATION_METADATA_PREFIXES,
  LEADER_CONDUCTOR_BLOCK,
  LEADER_CONDUCTOR_REUSE_AND_LEDGER_GUIDANCE,
  NATIVE_SUBAGENT_SUPPORT_BLOCKER_FILE,
  actionKindForConductorArtifact,
  authorizeConductorAction,
  buildRoleRoutingUnavailableGuidance,
  buildUnsupportedNativeSubagentGuidance,
  classifyConductorArtifactKind,
  isNativeSubagentSpawnToolName,
  isRoleRoutingUnavailableEvidence,
  isUnsupportedNativeSubagentEvidence,
  parseRoleIntentCorrelationToken,
  parseNativeSubagentResultDisposition,
  resolveNativeSubagentSupportStatus,
  type NativeSubagentUnsupportedReason,
} from "../leader/contract.js";
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
  /** @internal Scoped deterministic SessionStart durability seam for native-hook tests. */
  sessionStartOptions?: Pick<SessionStartOptions, 'platform' | 'regularFileSync'>;
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
const LEADER_CONDUCTOR_GOLDEN_RULE = "Main-root Conductor golden rule: delegate implementation work; do not self-execute source or plan edits.";
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

async function resolveVerifiedOwnerOmxSessionId(): Promise<string | undefined> {
  const candidate = normalizeSessionId(process.env.OMX_SESSION_ID);
  if (!candidate) return undefined;
  const evidence = await probeActualTmuxInstanceEvidence(process.env.TMUX_PANE);
  return tmuxEvidenceBindsCandidate(evidence, candidate) ? candidate : undefined;
}

function isImplicitWritableScopeFailure(error: unknown): boolean {
  return error instanceof Error
    && (error.message === WRITABLE_STATE_SCOPE_ERRORS.unboundEnvironment
      || error.message === WRITABLE_STATE_SCOPE_ERRORS.unusableSession);
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
  correlationToken?: string;
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

function selectAuthoritativeTaskName(
  threadSpawn: unknown,
  subagent: unknown,
  payload: unknown,
): { present: boolean; value: unknown } {
  for (const obj of [threadSpawn, subagent, payload]) {
    if (obj && typeof obj === "object" && "task_name" in obj) {
      return { present: true, value: (obj as Record<string, unknown>).task_name };
    }
  }
  return { present: false, value: undefined };
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

    const agentNicknameCarrierValues = [
      threadSpawn.agent_nickname ?? threadSpawn.agentNickname,
      subagent.agent_nickname ?? subagent.agentNickname,
      payload.agent_nickname ?? payload.agentNickname,
    ];
    const agentNickname = safeString(agentNicknameCarrierValues[0]).trim();
    const authoritativeTaskName = selectAuthoritativeTaskName(threadSpawn, subagent, payload);
    const correlationToken = authoritativeTaskName.present
      ? parseRoleIntentCorrelationToken(authoritativeTaskName.value)
      : undefined;
    const agentRole = safeString(
      threadSpawn.agent_role
        ?? threadSpawn.agentRole
        ?? threadSpawn.agent_type
        ?? threadSpawn.agentType
        ?? payload.agent_role
        ?? payload.agentRole
        ?? payload.agent_type
        ?? payload.agentType,
    ).trim();
    return {
      parentThreadId,
      ...(agentNickname ? { agentNickname } : {}),
      ...(agentRole ? { agentRole } : {}),
      ...(correlationToken ? { correlationToken } : {}),
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
  const correlationSessionId = canonicalSessionId.trim() || parentThreadId;
  const trackingSessionIds = [...new Set([
    canonicalSessionId.trim(),
    parentThreadId,
  ].filter(Boolean))];

  for (const sessionId of trackingSessionIds) {
    if (parentThreadId && parentThreadId !== childThreadId) {
      await recordSubagentTurnForSession(cwd, {
        sessionId,
        threadId: parentThreadId,
        kind: "leader",
      }).catch(() => {});
    }
    await recordSubagentTurnForSession(cwd, {
      sessionId,
      threadId: childThreadId,
      kind: "subagent",
      ...(parentThreadId && parentThreadId !== childThreadId ? { leaderThreadId: parentThreadId } : {}),
      mode: metadata.agentRole,
    }).catch(() => {});
  }
  refreshNativeSubagentRoleRoutingMarker(
    cwd,
    getBaseStateDir(cwd),
    correlationSessionId,
    parentThreadId,
  );
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

async function readNativePromptThreadFacts(
  cwd: string,
  nativeSessionId: string,
  threadId: string,
  currentSessionState?: SessionState | null,
): Promise<PromptThreadFacts | undefined> {
  const candidateIds = [nativeSessionId, threadId].map((value) => value.trim()).filter(Boolean);
  if (candidateIds.length === 0) return undefined;
  const currentNativeIds = new Set([
    safeString(currentSessionState?.native_session_id).trim(),
    safeString(currentSessionState?.codex_session_id).trim(),
    safeString(currentSessionState?.owner_codex_session_id).trim(),
  ].filter(Boolean));
  const currentTargetAnchored = Boolean(nativeSessionId && currentNativeIds.has(nativeSessionId));
  const trackingState = await readSubagentTrackingState(cwd).catch(() => null);
  if (!trackingState) return currentTargetAnchored ? { currentTargetAnchored: true, rootOrDrift: true } : undefined;
  const roots = Object.values(trackingState.sessions).flatMap((session) => (
    candidateIds.some((candidate) => isTrustedSubagentThread(session, candidate))
      ? [session.session_id]
      : []
  ));
  return roots.length > 0 || currentTargetAnchored
    ? { trackerRootOwnerSessionIds: roots, currentTargetAnchored, rootOrDrift: currentTargetAnchored }
    : undefined;
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
    const value = safeString(candidate);
    if (value.trim()) return value;
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

const PLANNING_TMP_SCRIPT_LIKE_EXTENSIONS = new Set([
  ".bash",
  ".bat",
  ".cjs",
  ".cmd",
  ".cts",
  ".fish",
  ".js",
  ".jsx",
  ".ksh",
  ".mjs",
  ".mts",
  ".php",
  ".pl",
  ".ps1",
  ".py",
  ".rb",
  ".sh",
  ".ts",
  ".tsx",
  ".zsh",
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

function readSessionStartSource(payload: CodexHookPayload | undefined): string {
  return safeString(payload?.source ?? payload?.session_start_source ?? payload?.sessionStartSource).trim().toLowerCase();
}

function shouldBuildSubagentReopenContext(options: {
  hookEventName?: CodexHookEventName | null;
  payload?: CodexHookPayload;
}): boolean {
  if (options.hookEventName !== "SessionStart") return false;
  const source = readSessionStartSource(options.payload);
  return source === "startup" || source === "resume";
}

function formatSubagentLedgerMetadata(entry: {
  role?: string;
  laneId?: string;
  scope?: string;
  status?: string;
  lastHandoffSummary?: string;
  resumeFailureReason?: string;
}): string {
  const metadata = [
    entry.role ? `role: ${entry.role}` : null,
    entry.laneId ? `lane: ${entry.laneId}` : null,
    entry.scope ? `scope: ${entry.scope}` : null,
    entry.status ? `status: ${entry.status}` : null,
    entry.lastHandoffSummary ? `handoff: ${entry.lastHandoffSummary.slice(0, 120)}` : null,
    entry.resumeFailureReason ? `last failure: ${entry.resumeFailureReason.slice(0, 120)}` : null,
  ].filter((item): item is string => Boolean(item));
  return metadata.length > 0 ? ` (${metadata.join("; ")})` : "";
}

async function buildPersistedSubagentReopenContext(
  cwd: string,
  sessionId: string,
  options: {
    hookEventName?: CodexHookEventName | null;
    payload?: CodexHookPayload;
  },
): Promise<string | null> {
  if (!shouldBuildSubagentReopenContext(options)) return null;

  const ledger = await readSubagentSessionLedger(cwd, sessionId).catch(() => null);
  if (!ledger || ledger.savedSubagents.length === 0) return null;

  const source = readSessionStartSource(options.payload);
  const reopenTargets = ledger.resumeTargets.filter((entry) => entry.status !== "unavailable");
  const unavailableTargets = ledger.unavailableSubagents;
  const failedTargets = ledger.savedSubagents.filter((entry) => entry.resumeFailedAt || entry.resumeFailureReason);
  const nowIso = new Date().toISOString();

  await Promise.all(reopenTargets.map((entry) => recordSubagentTurnForSession(cwd, {
    sessionId,
    threadId: entry.threadId,
    kind: "subagent",
    role: entry.role,
    laneId: entry.laneId,
    scope: entry.scope,
    agentNickname: entry.agentNickname,
    status: entry.status,
    resumeRequestedAt: nowIso,
    preserveCompletionEvidence: true,
  }).catch(() => null)));

  const lines = [
    "[Persisted subagent reopen]",
    `- SessionStart source: ${source}; saved subagent ids found: ${ledger.savedSubagents.length}.`,
  ];

  if (reopenTargets.length > 0) {
    lines.push("- Reopen these persisted subagents by id before continuing work or spawning any same-role/same-lane replacement:");
    for (const entry of reopenTargets.slice(0, 12)) {
      lines.push(`  - resume_agent(${JSON.stringify(entry.agentId)})${formatSubagentLedgerMetadata(entry)}`);
    }
    if (reopenTargets.length > 12) {
      lines.push(`  - ... ${reopenTargets.length - 12} more saved subagent id(s) omitted from this compact SessionStart context; consult .omx/state/subagent-tracking.json before spawning replacements.`);
    }
  } else {
    lines.push("- No compatible saved subagent id is currently marked reopenable; do not spawn a replacement merely because reopen was unavailable.");
  }

  lines.push("- Silver rule: when follow-up work targets an existing role/lane, reuse the matching reopened id; avoid duplicate same-type subagent spawns.");
  lines.push("- If resume_agent fails, surface a clear warning with the id and reason, then continue in the root or another compatible existing lane; do not spawn a new agent solely because reopen failed.");

  const warningEntries = [...new Map([...unavailableTargets, ...failedTargets].map((entry) => [entry.agentId, entry])).values()];
  if (warningEntries.length > 0) {
    lines.push("- Reopen warnings:");
    for (const entry of warningEntries.slice(0, 8)) {
      lines.push(`  - ${entry.agentId}${formatSubagentLedgerMetadata(entry)}`);
    }
  }

  return lines.join("\n");
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

  const persistedSubagentReopenContext = await buildPersistedSubagentReopenContext(cwd, sessionId, {
    hookEventName: options.hookEventName,
    payload: options.payload,
  });
  if (persistedSubagentReopenContext) {
    sections.push(persistedSubagentReopenContext);
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

function isNativeOutsideTmuxUserPrompt(cwd: string, payload: CodexHookPayload, sessionId?: string): boolean {
  const environment = resolveExecutionEnvironment(cwd, {
    hookEventName: "UserPromptSubmit",
    payload,
    canonicalSessionId: sessionId ?? "",
    nativeSessionId: safeString(payload.session_id ?? payload.sessionId).trim(),
  });
  return environment.launcher === "native" && environment.transport === "outside-tmux";
}

function buildNativeOutsideTmuxTeamPromptBlockState(
  classification: KeywordInputClassification,
  cwd: string,
  payload: CodexHookPayload,
  sessionId?: string,
  threadId?: string,
  turnId?: string,
): SkillActiveState | null {
  const teamMode = readTeamModeConfig(cwd);
  const match = classification.matches.filter((entry) => teamMode.enabled || entry.skill !== "team")[0] ?? null;
  if (match?.skill !== "team") return null;

  if (!isNativeOutsideTmuxUserPrompt(cwd, payload, sessionId)) return null;

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
  options: { markedQuestionAnswer?: boolean; cwd?: string; payload?: CodexHookPayload; sessionId?: string } = {},
): string | null {
  if (skillState?.initialized_mode !== "autopilot") return null;
  const teamHandoff = readTeamModeConfig(options.cwd).enabled
    ? " (+ $team if needed)"
    : "";
  const stateDir = getBaseStateDir(options.cwd);
  const nativeSubagentSupport = resolveNativeSubagentSupportStatus({
    payload: options.payload,
    persistedSupportBlocker: readJsonSyncIfExists(nativeSubagentSupportBlockerPath(stateDir)),
    persistedRoleRoutingMarker: readRoleRoutingMarker(stateDir, {
      cwd: options.cwd,
      sessionId: options.sessionId ?? "",
    }),
    persistedCapacityBlocker: readJsonSyncIfExists(nativeSubagentCapacityBlockerPath(stateDir)),
    cwd: options.cwd,
    sessionId: options.sessionId,
  });
  const conductorGuidance = nativeSubagentSupport.status === "unsupported"
    ? buildUnsupportedNativeSubagentGuidance(nativeSubagentSupport)
    : nativeSubagentSupport.status === "role_routing_unavailable"
      ? buildRoleRoutingUnavailableGuidance(nativeSubagentSupport)
      : `${LEADER_CONDUCTOR_BLOCK} ${LEADER_CONDUCTOR_REUSE_AND_LEDGER_GUIDANCE}`;
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
    conductorGuidance,
  ].filter(Boolean).join(" ");
}

function formatExecutionHandoffList(cwd: string): string {
  return readTeamModeConfig(cwd).enabled
    ? "`$ultragoal`, `$team`, or `$ralph`"
    : "`$ultragoal` or `$ralph`";
}

function buildAdditionalContextMessage(
  classification: KeywordInputClassification,
  skillState?: SkillActiveState | null,
  cwd: string = process.cwd(),
  payload?: CodexHookPayload,
): string | null {
  const prompt = classification.originalText;
  if (!prompt) return null;
  const promptPriorityMessage = buildPromptPriorityMessage(prompt);
  if (payload && isTypedAgentRolePayload(payload, cwd)) {
    return promptPriorityMessage;
  }
  const teamMode = readTeamModeConfig(cwd);
  const matches = classification.matches.filter((entry) => teamMode.enabled || entry.skill !== "team");
  const match = matches[0] ?? null;
  if (!match) {
    const markedQuestionAnswer = classification.reservedInput === "omx-question-answered";
    const continuedSkill = safeString(skillState?.skill).trim();
    const eligibleMarkedContinuation = markedQuestionAnswer
      && skillState?.active === true
      && (continuedSkill === "autopilot" || continuedSkill === "deep-interview");
    const eligibleOrdinaryContinuation = classification.reservedInput === null
      && !classification.hasExplicitLikeInvocation
      && skillState?.active === true
      && Boolean(continuedSkill);
    if (!eligibleMarkedContinuation && !eligibleOrdinaryContinuation) return promptPriorityMessage;
    const deepInterviewPromptActivationNote = skillState?.initialized_mode === "deep-interview"
      ? buildDeepInterviewQuestionBridgeInstruction(cwd, payload)
      : null;
    const deepInterviewConfigPromptActivationNote = buildDeepInterviewConfigInstruction(cwd, skillState);
    const autopilotPromptActivationNote = buildAutopilotPromptActivationNote(skillState, { markedQuestionAnswer, cwd, payload, sessionId: safeString(skillState?.session_id).trim() });
    return [
      markedQuestionAnswer
        ? `OMX native UserPromptSubmit continued active workflow skill "${continuedSkill}"; workflow-like tokens inside the marked omx question answer are treated as answer text, not a new workflow activation.`
        : `OMX native UserPromptSubmit continued active workflow skill "${continuedSkill}".`,
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
  const autopilotPromptActivationNote = buildAutopilotPromptActivationNote(skillState, { cwd, payload, sessionId: safeString(skillState?.session_id).trim() });
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

function readTeamWorkerEnvironment(): { teamName: string; workerName: string } | null {
  const internalWorker = parseTeamWorkerEnv(safeString(process.env.OMX_TEAM_INTERNAL_WORKER));
  const externalWorker = parseTeamWorkerEnv(safeString(process.env.OMX_TEAM_WORKER));
  if (internalWorker && externalWorker && internalWorker.workerName !== externalWorker.workerName) return null;
  // The public Team name is a display alias; only the session-scoped internal
  // identity is authoritative for state-root/config/manifest validation.
  return internalWorker ?? externalWorker;
}

async function hasAuthoritativeTeamWorkerContext(cwd: string): Promise<boolean> {
  const workerContext = readTeamWorkerEnvironment();
  if (!workerContext) return false;

  const currentPaneId = safeString(process.env.TMUX_PANE).trim();
  if (!currentPaneId) return false;
  const stateRoot = await resolveWorkerTeamStateRootPath(cwd, workerContext, process.env).catch(() => null);
  if (!stateRoot) return false;

  const teamRoot = join(stateRoot, "team", workerContext.teamName);
  const identity = await readJsonIfExists(join(teamRoot, "workers", workerContext.workerName, "identity.json"));
  const manifest = await readJsonIfExists(join(teamRoot, "manifest.v2.json"));
  const config = await readJsonIfExists(join(teamRoot, "config.json"));
  if (!identity || !manifest || !config) return false;

  const canonicalStateRoot = resolve(stateRoot);
  const canonicalCwd = resolve(cwd);
  const canonicalLeaderCwd = resolve(safeString(process.env.OMX_TEAM_LEADER_CWD).trim() || cwd);
  const pathMatches = (value: unknown, expected: string): boolean => {
    const candidate = safeString(value).trim();
    if (!candidate) return false;
    try {
      return resolve(candidate) === expected;
    } catch {
      return false;
    }
  };
  const matchingWorker = (state: Record<string, unknown>): Record<string, unknown> | null => {
    const workers = Array.isArray(state.workers) ? state.workers : [];
    return workers
      .map((candidate) => safeObject(candidate))
      .find((candidate) => safeString(candidate.name).trim() === workerContext.workerName) ?? null;
  };
  const manifestWorker = matchingWorker(manifest);
  const configWorker = matchingWorker(config);
  if (!manifestWorker || !configWorker) return false;
  if (safeString(identity.name).trim() !== workerContext.workerName) return false;
  if (safeString(identity.pane_id).trim() !== currentPaneId) return false;
  if (!pathMatches(identity.team_state_root, canonicalStateRoot)) return false;
  if (!pathMatches(identity.worktree_path ?? identity.working_dir, canonicalCwd)) return false;
  for (const state of [manifest, config]) {
    if (safeString(state.name).trim() !== workerContext.teamName) return false;
    if (safeString(state.leader_pane_id).trim() === currentPaneId) return false;
    if (!pathMatches(state.team_state_root, canonicalStateRoot)) return false;
    if (!pathMatches(state.leader_cwd, canonicalLeaderCwd)) return false;
  }
  if (safeString(manifest.leader_pane_id).trim() !== safeString(config.leader_pane_id).trim()) return false;
  for (const worker of [manifestWorker, configWorker]) {
    if (safeString(worker.pane_id).trim() !== currentPaneId) return false;
    if (!pathMatches(worker.team_state_root, canonicalStateRoot)) return false;
    const workingDir = safeString(worker.working_dir).trim();
    const worktreePath = safeString(worker.worktree_path).trim();
    if (!workingDir && !worktreePath) return false;
    if (workingDir && !pathMatches(workingDir, canonicalCwd)) return false;
    if (worktreePath && !pathMatches(worktreePath, canonicalCwd)) return false;
  }
  return true;
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
  const workerContext = readTeamWorkerEnvironment();
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
      command: `omx ultragoal checkpoint --goal-id ${goalId} --status complete --codex-goal-json '<get_goal JSON or path>' --quality-gate-json '<quality-gate JSON or path>' --evidence '<evidence>' --json`,
      remediation: [
        `If get_goal returns a completed task-scoped objective for the same aggregate ultragoal plan, checkpoint ${goalId} with evidence naming ${goalId} plus .omx/ultragoal/goals.json or ledger.jsonl and pass final quality-gate JSON; OMX will reconcile the completed planned scope without mutating Codex goal state.`,
        `If get_goal instead returns a different completed legacy objective and complete checkpointing fails, do not repeat --status complete in this thread.`,
        `Record the non-terminal blocker with: omx ultragoal checkpoint --goal-id ${goalId} --status blocked --codex-goal-json '<different completed get_goal JSON or path>' --quality-gate-json '<quality-gate JSON or path>' --evidence '<completed legacy Codex goal blocks create_goal in this thread>' --json.`,
        `If get_goal itself is unavailable with a Codex DB/schema/context error such as "no such table: thread_goals", record an auditable safe-recovery blocker instead: omx ultragoal checkpoint --goal-id ${goalId} --status blocked --codex-goal-json '<unavailable get_goal error JSON or path>' --quality-gate-json '<quality-gate JSON or path>' --evidence '<get_goal unavailable due to Codex DB/schema/context error; safe recovery requires a working Codex goal context>' --json.`,
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
        command: `omx performance-goal complete --slug ${safeString(state.slug) || entry.name} --codex-goal-json '<get_goal JSON or path>' --evidence '<evidence>' --json`,
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
        command: `omx autoresearch-goal complete --slug ${safeString(mission.slug) || entry.name} --codex-goal-json '<get_goal JSON or path>' --json`,
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

function payloadAliasValues(payload: CodexHookPayload, keys: readonly string[]): string[] {
  return [...new Set(keys.map((key) => safeString(payload[key]).trim()).filter(Boolean))];
}

function payloadHasConflictingIdentityAliases(payload: CodexHookPayload): boolean {
  const sessionAliases = payloadAliasValues(payload, ["session_id", "sessionId"]);
  const threadAliases = payloadAliasValues(payload, ["thread_id", "threadId"]);
  const agentAliases = payloadAliasValues(payload, ["agent_id", "agentId"]);
  const actors = [...new Set([...threadAliases, ...agentAliases])];
  const ownerThreads = payloadAliasValues(payload, ["owner_codex_thread_id"]);
  return sessionAliases.length > 1 || threadAliases.length > 1 || agentAliases.length > 1
    || actors.length > 1
    || (ownerThreads.length > 0 && actors.some((actor) => ownerThreads.some((owner) => owner !== actor)));
}

function payloadHasOwnerIdentityClaim(payload: CodexHookPayload): boolean {
  return payloadAliasValues(payload, [
    "owner_codex_thread_id",
    "owner_omx_session_id",
    "owner_codex_session_id",
    "native_owner_session_id",
  ]).length > 0;
}
function readPayloadSessionId(payload: CodexHookPayload): string {
  return payloadAliasValues(payload, ["session_id", "sessionId"])[0] ?? "";
}

function readPayloadThreadId(payload: CodexHookPayload): string {
  return payloadAliasValues(payload, ["thread_id", "threadId"])[0] ?? "";
}

function readPayloadAgentId(payload: CodexHookPayload): string {
  return safeString(payload.agent_id).trim();
}
interface PreToolUseSessionBinding {
  canonicalSessionId: string;
  valid: boolean;
  missing: boolean;
}

async function resolvePreToolUseSessionBinding(
  cwd: string,
  stateDir: string,
  payload: CodexHookPayload,
  allowSharedTeamRoot = false,
): Promise<PreToolUseSessionBinding> {
  const currentSession = allowSharedTeamRoot
    ? await readRootSessionStateFromStateDir(stateDir).catch(() => null)
    : await readUsableSessionStateFromStateDir(cwd, stateDir).catch(() => null);
  const canonicalSessionId = safeString(currentSession?.session_id).trim();
  const aliases = payloadAliasValues(payload, ["session_id", "sessionId"]);
  const knownAliases = new Set([
    canonicalSessionId,
    safeString(currentSession?.native_session_id).trim(),
  ].filter(Boolean));
  return {
    canonicalSessionId,
    missing: aliases.length === 0,
    valid: canonicalSessionId !== ""
      && !payloadHasConflictingIdentityAliases(payload)
      && aliases.length === 1
      && knownAliases.has(aliases[0] ?? ""),
  };
}

interface ConductorPolicyRootResolution {
  cwd: string;
  valid: boolean;
  statePresent: boolean;
  externalStateRoot: boolean;
}

function resolveConductorPolicyRoot(stateDir: string, fallbackCwd: string): ConductorPolicyRootResolution {
  const statePresent = existsSync(join(stateDir, "session.json"))
    || existsSync(join(stateDir, "sessions"));
  let canonicalFallback: string;
  try {
    canonicalFallback = realpathSync(resolve(fallbackCwd));
  } catch {
    canonicalFallback = resolve(fallbackCwd);
  }
  try {
    const canonicalStateDir = realpathSync(stateDir);
    const rootSession = readJsonSyncIfExists(join(canonicalStateDir, "session.json"));
    const recordedCwd = safeString(rootSession?.cwd ?? rootSession?.workingDirectory).trim();
    if (recordedCwd) {
      const canonicalRecordedCwd = realpathSync(resolve(recordedCwd));
      return {
        cwd: canonicalRecordedCwd,
        valid: true,
        statePresent,
        externalStateRoot: canonicalStateDir !== join(canonicalRecordedCwd, ".omx", "state"),
      };
    }
    if (canonicalStateDir === join(canonicalFallback, ".omx", "state")) {
      return { cwd: canonicalFallback, valid: true, statePresent, externalStateRoot: false };
    }
  } catch {
    // An external state surface with an unusable pointer must not borrow execution-cwd authority.
  }
  return { cwd: canonicalFallback, valid: !statePresent, statePresent, externalStateRoot: statePresent };
}


function readPayloadAgentRole(payload: CodexHookPayload): string {
  const directRole = safeString(
    payload.agent_role
      ?? payload.agentRole
      ?? payload.agent_type
      ?? payload.agentType,
  ).trim().toLowerCase();
  if (directRole) return directRole;

  const source = safeObject(payload.source);
  const subagent = safeObject(source?.subagent);
  const threadSpawn = safeObject(subagent?.thread_spawn);
  return safeString(
    threadSpawn?.agent_role
      ?? threadSpawn?.agentRole
      ?? threadSpawn?.agent_type
      ?? threadSpawn?.agentType,
  ).trim().toLowerCase();
}

function readRequestedSpawnRole(payload: CodexHookPayload): string {
  const toolName = safeString(payload.tool_name).trim();
  if (!isNativeSubagentSpawnToolName(toolName)) return "";
  const toolInput = safeObject(payload.tool_input);
  return safeString(
    toolInput.agent_role
      ?? toolInput.agentRole
      ?? toolInput.agent_type
      ?? toolInput.agentType,
  ).trim().toLowerCase();
}

function isTypedAgentRolePayload(payload: CodexHookPayload, cwd: string): boolean {
  const agentRole = readPayloadAgentRole(payload);
  return agentRole !== "" && resolveInstalledRoleName(agentRole, undefined, cwd) !== null;
}



function buildNativeUnknownRolePreToolUseOutput(
  payload: CodexHookPayload,
  cwd: string,
): Record<string, unknown> | null {
  const requestedRole = readRequestedSpawnRole(payload);
  if (!requestedRole || resolveInstalledRoleName(requestedRole, undefined, cwd) !== null) return null;
  return {
    decision: "block",
    reason: "Native typed-subagent dispatch denied: supplied agent_type/agent_role is unknown or not installed.",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        "Use an installed OMX role for native agent_type/agent_role dispatch. When the surface reports role_routing_unavailable, do not fabricate agent_type; run `omx ralplan preflight --json` before Ralplan planning, state, HUD, runtime, or delegation work and stop on `unsupported_documented_leader_proof`.",
    },
  };
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

function nativeSubagentSupportBlockerPath(stateDir: string): string {
  return join(stateDir, NATIVE_SUBAGENT_SUPPORT_BLOCKER_FILE);
}

function readJsonSyncIfExists(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}


function nativeSubagentResultDisposition(payload: CodexHookPayload) {
  const toolName = safeString(payload.tool_name).trim();
  const result = payload.tool_response ?? payload.response ?? payload.error ?? payload.message;
  return parseNativeSubagentResultDisposition(toolName, result);
}

function isNativeSubagentCapacityFailure(payload: CodexHookPayload): boolean {
  return nativeSubagentResultDisposition(payload).kind === "capacity";
}

function nativeSubagentFailureReason(payload: CodexHookPayload): NativeSubagentUnsupportedReason | null {
  const disposition = nativeSubagentResultDisposition(payload);
  return disposition.kind === "unsupported" ? disposition.reason : null;
}

function summarizeNativeSubagentSupportFailure(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return (normalized || "native subagent support unavailable").slice(0, 500);
}

async function recordNativeSubagentSupportBlocker(
  cwd: string,
  stateDir: string,
  payload: CodexHookPayload,
): Promise<void> {
  const reason = nativeSubagentFailureReason(payload);
  if (!reason) return;
  const nowIso = new Date().toISOString();
  await mkdir(stateDir, { recursive: true });
  await writeFile(nativeSubagentSupportBlockerPath(stateDir), JSON.stringify({
    schema_version: 1,
    status: "unsupported",
    reason,
    ...(readPayloadSessionId(payload) ? { session_id: readPayloadSessionId(payload) } : {}),
    ...(readPayloadThreadId(payload) ? { thread_id: readPayloadThreadId(payload) } : {}),
    ...(readPayloadTurnId(payload) ? { turn_id: readPayloadTurnId(payload) } : {}),
    ...(safeString(payload.tool_name).trim() ? { tool_name: safeString(payload.tool_name).trim() } : {}),
    evidence: summarizeNativeSubagentSupportFailure(nativeSubagentResultDisposition(payload).evidenceSummary),
    observed_at: nowIso,
    cwd,
  }, null, 2));
}


function refreshNativeSubagentRoleRoutingMarker(
  cwd: string,
  stateDir: string,
  sessionId: string,
  parentThreadId?: string,
): void {
  const marker = readRoleRoutingMarker(stateDir, {
    cwd,
    sessionId,
    ...(parentThreadId ? { parentThreadId } : {}),
  });
  if (!marker) return;
  const nowMs = Date.now();
  writeRoleRoutingMarker(stateDir, {
    ...marker,
    observed_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + 60 * 60_000).toISOString(),
  });
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
    error_summary: summarizeCapacityFailure(nativeSubagentResultDisposition(payload).evidenceSummary),
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
  pointerSessionState?: SessionState | null,
  allowUnboundPayloadFallback = true,
): Promise<string> {
  const currentSession = pointerSessionState ?? (stateDir
    ? await readUsableSessionStateFromStateDir(cwd, stateDir)
    : await readUsableSessionState(cwd));
  const canonicalSessionId = safeString(currentSession?.session_id).trim();
  if (!canonicalSessionId) return allowUnboundPayloadFallback ? payloadSessionId : "";

  const nativeSessionId = safeString(currentSession?.native_session_id).trim();
  const ownerOmxSessionId = safeString(currentSession?.owner_omx_session_id).trim();
  if (!payloadSessionId) return canonicalSessionId;
  if (payloadSessionId === canonicalSessionId) return canonicalSessionId;
  if (nativeSessionId && payloadSessionId === nativeSessionId) return canonicalSessionId;
  if (ownerOmxSessionId && payloadSessionId === ownerOmxSessionId) return canonicalSessionId;
  return allowUnboundPayloadFallback ? payloadSessionId : "";
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
  ".omx/tmp",
  ".omx/state",
] as const;

const RALPLAN_ALLOWED_WRITE_PREFIXES = [
  ".omx/context",
  ".omx/plans",
  ".omx/specs",
  ".omx/tmp",
  ".omx/state",
  ".beads",
] as const;

const PROTECTED_PLANNING_STATE_FILE_NAMES = new Set([
  "autopilot-state.json",
  "autoresearch-state.json",
  "deep-interview-state.json",
  "ralplan-state.json",
  "ralph-state.json",
  "ultrawork-state.json",
  "team-state.json",
  "ultraqa-state.json",
  "ultragoal-state.json",
  "skill-active-state.json",
  "release-readiness-state.json",
  "run-state.json",
  "session.json",
  "subagent-tracking.json",
  "native-stop-state.json",
]);


const PLANNING_MODE_IMPLEMENTATION_TOOL_NAMES = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
  "ApplyPatch",
]);


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


function isInactiveCompletedDeepInterviewPhase(state: Record<string, unknown> | null): boolean {
  if (!state || state.active !== false) return false;
  const mode = safeString(state.mode).trim();
  if (mode && mode !== "deep-interview") return false;
  const phase = safeString(state.current_phase ?? state.currentPhase).trim().toLowerCase();
  return phase === "complete" || phase === "completed";
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
  const trimmed = rawPath.trim();
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

function normalizeProtectedPlanningStateFileName(fileName: string): string {
  return fileName.normalize("NFKC").replace(/[. ]+$/u, "").toLowerCase();
}

function isProtectedPlanningStatePath(relativePath: string): boolean {
  if (relativePath !== ".omx/state" && !relativePath.startsWith(".omx/state/")) return false;
  if (relativePath === ".omx/state") return true;
  const components = relativePath.split("/").map(normalizeProtectedPlanningStateFileName);
  const fileName = components.at(-1) ?? "";
  if (PROTECTED_PLANNING_STATE_FILE_NAMES.has(fileName)) return true;

  // Session-scoped gate state and Team membership/authority records are not raw
  // metadata. Protect their trees as well as their leaf filenames so rm/mv cannot
  // remove the gate and release the next substantive write.
  if (components[2] === "sessions") return true;
  if (components[2] !== "team") return false;
  return true;
}

function isRawProtectedPlanningStateCandidate(stateDir: string, cwd: string, rawPath: string): boolean {
  try {
    const lexicalPath = resolve(cwd, rawPath);
    const canonicalStateDir = realpathSync(resolve(stateDir));
    let existingPath = lexicalPath;
    const missingSegments: string[] = [];
    while (true) {
      try {
        const canonicalExisting = realpathSync(existingPath);
        const canonicalPath = resolve(canonicalExisting, ...missingSegments.reverse());
        const relativePath = relative(canonicalStateDir, canonicalPath).replace(/\\/g, "/");
        if (relativePath.startsWith("../") || relativePath === "..") return false;
        if (!relativePath) return true;
        return isProtectedPlanningStatePath(`.omx/state/${relativePath}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
        const parent = dirname(existingPath);
        if (parent === existingPath) return true;
        missingSegments.push(basename(existingPath));
        existingPath = parent;
      }
    }
  } catch {
    return true;
  }
}




function isPlanningTmpRelativePath(relativePath: string): boolean {
  return relativePath === ".omx/tmp" || relativePath.startsWith(".omx/tmp/");
}

function isAllowedPlanningTmpScratchPath(relativePath: string): boolean {
  if (!isPlanningTmpRelativePath(relativePath)) return true;
  const fileName = relativePath.split("/").pop() ?? "";
  if (!fileName || fileName === "tmp") return true;
  const extension = extname(fileName).toLowerCase();
  return !PLANNING_TMP_SCRIPT_LIKE_EXTENSIONS.has(extension);
}


function isAllowedPlanningArtifactPath(
  cwd: string,
  rawPath: string,
  allowedPrefixes: readonly string[],
  authoritativeSessionId?: string,
): boolean {
  // Gate-bearing state never admits raw artifact writes; a matching session cannot relax this boundary.
  void authoritativeSessionId;
  const relativePath = normalizePlanningArtifactRelativePath(cwd, rawPath);
  if (!relativePath || conductorPathnameExpansionIsAmbiguous(relativePath)) return false;
  if (conductorPathTraversesLink(cwd, relativePath)) return false;
  if (isProtectedPlanningStatePath(relativePath)) return false;
  if (isPlanningTmpRelativePath(relativePath)) {
    return allowedPrefixes.includes(".omx/tmp") && isAllowedPlanningTmpScratchPath(relativePath);
  }
  return allowedPrefixes.some((prefix) => (
    relativePath === prefix || relativePath.startsWith(`${prefix}/`)
  ));

}

function isAllowedDeepInterviewArtifactPath(cwd: string, rawPath: string, authoritativeSessionId?: string): boolean {
  return isAllowedPlanningArtifactPath(cwd, rawPath, DEEP_INTERVIEW_ALLOWED_WRITE_PREFIXES, authoritativeSessionId);
}

function isAllowedRalplanDraftPath(cwd: string, rawPath: string): boolean {
  const relativePath = normalizePlanningArtifactRelativePath(cwd, rawPath);
  return relativePath !== null
    && !conductorPathnameExpansionIsAmbiguous(relativePath)
    && !conductorPathTraversesLink(cwd, relativePath)
    && /^\.omx\/drafts\/[^/]+\.md$/.test(relativePath);
}

function isAllowedRalplanArtifactPath(cwd: string, rawPath: string, authoritativeSessionId?: string): boolean {
  return isAllowedRalplanDraftPath(cwd, rawPath)
    || isAllowedPlanningArtifactPath(cwd, rawPath, RALPLAN_ALLOWED_WRITE_PREFIXES, authoritativeSessionId);
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
  const trimmed = rawPath.trim();
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
    input.source_path,
    input.sourcePath,
    input.destination_path,
    input.destinationPath,
    input.source,
    input.destination,
    ...(Array.isArray(input.paths) ? input.paths : []),
  ];
  return [...new Set(candidates.map((candidate) => safeString(candidate).trim()).filter(Boolean))];
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
  const normalized = target.trim().toLowerCase();
  return normalized === "/dev/null" || normalized === "nul";
}

// Collects same-command literal variable assignments (`NAME="value"`), skipping
// any value that involves expansion (`$`, backticks) so unresolved/dynamic
// targets stay conservatively blocked.
function extractCommandLiteralAssignments(command: string): Map<string, string> {
  const assignments = new Map<string, string>();
  const invalidNames = new Set<string>();
  let remaining = command;
  const leadingAssignment = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"$`]*)"|'([^']*)'|([^\s"'$`;&|<>]+))\s*(?:[;\n]+|$)/;
  while (remaining) {
    const match = remaining.match(leadingAssignment);
    if (!match) break;
    const name = safeString(match[1]).trim();
    if (!name || assignments.has(name) || invalidNames.has(name)) {
      if (name) {
        assignments.delete(name);
        invalidNames.add(name);
      }
    } else {
      assignments.set(name, match[2] ?? match[3] ?? match[4] ?? "");
    }
    remaining = remaining.slice(safeString(match[0]).length);
  }
  for (const name of [...assignments.keys()]) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const laterAssignment = new RegExp(`(?:^|[\\s;&|(){}])(?:export\\s+)?${escapedName}(?:\\[[^\\]]+\\])?\\s*(?:\\+?=)`);
    if (laterAssignment.test(remaining)) assignments.delete(name);
    const mutationPatterns = [
      new RegExp(`\\bprintf\\b[^;\\n]*\\s-v\\s+${escapedName}\\b`),
      new RegExp(`\\b(?:read|unset)\\b[^;\\n]*\\b${escapedName}\\b`),
      new RegExp(`\\b(?:declare|typeset|local|export)\\b[^;\\n]*\\b${escapedName}(?:\\[[^\\]]+\\])?(?:\\b|\\s*(?:\\+?=))`),
      new RegExp(`\\b(?:mapfile|readarray)\\b[^;\\n]*\\b${escapedName}\\b`),
      new RegExp(`\\bgetopts\\b[^;\\n]*\\s${escapedName}\\b`),
      new RegExp(`\\b(?:for|select)\\s+${escapedName}\\b`),
      new RegExp(`\\$\\{${escapedName}(?::?[-+=?])`),
    ];
    if (/\beval\b|\|/.test(remaining) || mutationPatterns.some((pattern) => pattern.test(remaining))) {
      assignments.delete(name);
    }
  }
  const redirectControl = stripHeredocBodiesForCommandScan(remaining).trim();
  for (const name of [...assignments.keys()]) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const boundedCatRedirect = new RegExp(`^cat\\s+>\\s+"\\$(?:\\{${escapedName}\\}|${escapedName})"\\s+<<-?\\s*['"][^'"\\s]+['"]\\s*$`);
    if (!boundedCatRedirect.test(redirectControl)) assignments.delete(name);
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

// Masks redirect metacharacters (`<`/`>`) that appear INSIDE shell quotes so a
// quoted regex/source value (e.g. `gh issue create --body '...>{1,2}...'` or
// `omx state write --input '{"reason":"a>b"}'`) is not misread as a redirect
// write target. Escaped quotes at the top level (`\'`, `\"`) are literal
// characters and must NOT open a span, and `$'...'` ANSI-C quoting processes
// backslash escapes (so `\'` does not close it) — otherwise a genuine `>`
// redirect could be masked behind a false span and its write missed. Only
// characters inside a real quoted span are masked; unquoted redirect operators
// survive intact. Unterminated/ambiguous quoting fails closed: the original
// command is returned unmasked so genuine redirects stay visible to the scan.
function maskQuotedRedirectMetacharsForCommandScan(command: string): string {
  let masked = "";
  // null = unquoted; "'" = single quotes (no escapes); '"' = double quotes
  // (backslash escapes); "$'" = ANSI-C $'...' (backslash escapes, incl. \').
  let quote: "'" | "\"" | "$'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote === null) {
      // A backslash escapes the next character at the top level, so an escaped
      // quote is a literal char and must not open a quoted span.
      if (char === "\\") {
        masked += char;
        const next = command[index + 1];
        if (next !== undefined) {
          masked += next;
          index += 1;
        }
        continue;
      }
      if (char === "$" && command[index + 1] === "'") {
        quote = "$'";
        masked += "$'";
        index += 1;
        continue;
      }
      if (char === "'" || char === "\"") quote = char;
      masked += char;
      continue;
    }
    if ((quote === "\"" || quote === "$'") && char === "\\") {
      // Escapes inside double/ANSI-C spans keep the backslash and its escaped
      // char (masking a redirect metachar so quoted data cannot be a false
      // target); the escaped char never closes the span.
      masked += char;
      const next = command[index + 1];
      if (next !== undefined) {
        masked += next === "<" || next === ">" ? "_" : next;
        index += 1;
      }
      continue;
    }
    const closesSpan = quote === "$'" ? char === "'" : char === quote;
    if (closesSpan) {
      quote = null;
      masked += char;
      continue;
    }
    masked += char === "<" || char === ">" ? "_" : char;
  }
  if (quote !== null) return command;
  return masked;
}

function decodeStaticRedirectShellWord(raw: string): string | null {
  const simpleVariable = raw.match(/^"?(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)"?$/);
  if (simpleVariable && !raw.startsWith("'")) return safeString(simpleVariable[1]);
  let quote: "'" | '"' | null = null;
  let decoded = "";
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (!quote && (char === "'" || char === '"')) {
      quote = char;
      continue;
    }
    if (quote && char === quote) {
      quote = null;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      const next = raw[index + 1];
      if (next === undefined) return null;
      decoded += next;
      index += 1;
      continue;
    }
    if ((char === "$" || char === "`") && quote !== "'") return null;
    decoded += char;
  }
  return quote ? null : decoded;
}

function extractDeepInterviewCommandRedirectTargets(command: string): string[] {
  const targets: string[] = [];
  const commandOutsideHeredocBodies = maskQuotedRedirectMetacharsForCommandScan(stripHeredocBodiesForCommandScan(command));
  for (const match of commandOutsideHeredocBodies.matchAll(/(?:^|[^<>])(?:[0-9]*)(?:<>|>>|>\||>&|>)\s*((?:"[^"]*"|'[^']*'|\\.|[^\s&|;<>])+)/g)) {
    const candidate = decodeStaticRedirectShellWord(safeString(match[1]).trim());
    // >&2 and >&- duplicate or close a descriptor; only non-fd words open a file.
    if (candidate === null) {
      targets.push("<unresolved-redirect-target>");
    } else if (candidate && candidate !== "-" && !/^\d+$/.test(candidate) && !isNullDeviceRedirectTarget(candidate)) {
      targets.push(candidate);
    }
  }
  return targets;
}

function conductorRedirectTargetIsSafe(executionCwd: string, target: string, policyCwd = executionCwd): boolean {
  if (shellWordMayProduceWgetOptions(target) || !isAllowedConductorMetadataExecutionPath(executionCwd, policyCwd, target)) return false;
  try {
    const entry = lstatSync(isAbsolute(target) ? resolve(target) : resolve(executionCwd, target));
    return entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function conductorCommandMayMutatePathResolution(command: string): boolean {
  const source = stripHeredocBodiesForCommandScan(command);
  const resolutionVariable = `["']?(?:PATH|BASH_CMDS)(?:\\[[^\\]\\r\\n]+\\])?["']?`;
  return new RegExp(`(?:^|[\\s;|&(){}])(?:${resolutionVariable}\\s*\\+?=|(?:export|readonly|declare|typeset|local|env)\\b[^;|&(){}\\n]*${resolutionVariable}\\s*\\+?=|unset\\s+(?:-[A-Za-z]+\\s+)*${resolutionVariable}(?:\\s|$)|printf\\s+(?:-[A-Za-z]+\\s+)*-v\\s+${resolutionVariable}(?:\\s|$)|read\\s+(?:-[A-Za-z]+(?:\\s+\\S+)?\\s+)*${resolutionVariable}(?:\\s|$))`).test(source);
}

function conductorCommandMayChangeProducerResolution(command: string, depth = 0): boolean {
  for (const segment of splitShellCommandSegments(stripHeredocBodiesForCommandScan(command))) {
    const words = tokenizeConductorShellWords(segment);
    const commandIndex = skipShellCommandPositionPrefixWords(words, 0);
    if (new Set(["enable", "hash", "declare", "typeset", "readonly", "local", "export", "unset", "read", "builtin", "command"]).has(commandNameFromShellWord(words[commandIndex] ?? ""))) return true;
  }
  const invokedFunctionBodies = extractInvokedShellFunctionBodiesForStateScan(command);
  if (invokedFunctionBodies.length > 0) {
    if (depth >= CONDUCTOR_BASH_MAX_NESTING_DEPTH) return true;
    if (invokedFunctionBodies.some((body) =>
      conductorCommandMayMutatePathResolution(body)
      || conductorCommandMayChangeProducerResolution(body, depth + 1)
    )) return true;
  }
  return false;
}

function conductorRedirectProducerMayBeShadowed(command: string, commandName: string): boolean {
  if (safeString(process.env[`BASH_FUNC_${commandName}%%`]).trim() !== "") return true;
  if (conductorCommandMayMutatePathResolution(command)) return true;
  const source = stripHeredocBodiesForCommandScan(command);
  if (conductorCommandMayChangeProducerResolution(source)) return true;
  for (let index = 0; index < source.length; index += 1) {
    const definition = findShellFunctionDefinitionAt(source, index);
    if (!definition) continue;
    if (definition.name === commandName) return true;
    const bodyEnd = findShellFunctionBodyEnd(source, definition.openBraceIndex, definition.bodyOpenChar);
    if (bodyEnd < 0) return true;
    index = bodyEnd;
  }
  return new RegExp(`(?:^|[;\\n])\\s*alias\\s+${commandName}(?:=|\\s|$)`).test(source);
}

function conductorHeredocRedirectHasBoundedProducer(command: string, fullCommand: string): boolean {
  const openers = extractShellHeredocOpeners(command);
  if (openers.length !== 1 || !openers[0]?.quoted || extractDeepInterviewCommandRedirectTargets(command).length !== 1) return false;
  const words = tokenizeConductorShellWords(command);
  const commandIndex = skipShellCommandPositionPrefixWords(words, 0);
  if (commandIndex !== 0) return false;
  if (commandNameFromShellWord(words[commandIndex] ?? "") !== "cat" || conductorRedirectProducerMayBeShadowed(fullCommand, "cat")) return false;
  let sawHeredoc = false;
  let sawOutput = false;
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "<<") {
      if (sawHeredoc || words[index + 1] === undefined) return false;
      sawHeredoc = true;
      index += 1;
      continue;
    }
    if (word === ">" || word === ">>") {
      if (sawOutput || words[index + 1] === undefined) return false;
      sawOutput = true;
      index += 1;
      continue;
    }
    return false;
  }
  return sawHeredoc && sawOutput;
}

function conductorMetadataRedirectsHaveBoundedProducers(command: string): boolean {
  const redirectTargets = extractDeepInterviewCommandRedirectTargets(command);
  if (redirectTargets.length === 0) return true;
  const openers = command.split("\n").flatMap((line) => extractShellHeredocOpeners(line));
  if (openers.length > 0) {
    const bodies = extractShellHeredocBodies(command);
    if (
      openers.length !== bodies.length
      || openers.some((opener) => !opener.quoted)
      || bodies.some((body) => Buffer.byteLength(body, "utf-8") > MAX_CONDUCTOR_METADATA_COPY_BYTES)
    ) return false;
  }
  for (const segment of splitShellCommandSegments(stripHeredocBodiesForCommandScan(command))) {
    if (extractDeepInterviewCommandRedirectTargets(segment).length === 0) continue;
    if (extractShellHeredocOpeners(segment).length > 0) {
      if (!conductorHeredocRedirectHasBoundedProducer(segment, command)) return false;
      continue;
    }
    const words = tokenizeConductorShellWords(segment);
    const commandIndex = skipShellCommandPositionPrefixWords(words, 0);
    if (commandIndex !== 0) return false;
    const commandName = commandNameFromShellWord(words[commandIndex] ?? "");
    if (!new Set([":", "echo", "printf"]).has(commandName) || conductorRedirectProducerMayBeShadowed(command, commandName)) return false;
    const operands = collectConductorInvocationWords(words, commandIndex);
    if (operands.some((operand) => /[$`]/.test(operand) || conductorPathnameExpansionIsAmbiguous(shellWordLiteral(operand)))) return false;
    if (commandName === "printf" && operands.some((operand) => shellWordLiteral(operand).includes("%"))) return false;
    if (Buffer.byteLength(operands.map(shellWordLiteral).join(" "), "utf-8") > MAX_CONDUCTOR_METADATA_COPY_BYTES) return false;
  }
  return true;
}

function conductorMetadataLeafSize(cwd: string, target: string): number | null {
  try {
    const path = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) return null;
    return entry.size;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null;
  }
}

function conductorStaticTruncateSize(words: string[], commandIndex: number): number | null {
  let size: number | null = null;
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = shellWordLiteral(words[index] ?? "");
    if (!word || isShellCommandTerminatorOrGroupClose(word)) break;
    const candidate = word === "--size" || word === "-s"
      ? shellWordLiteral(words[++index] ?? "")
      : word.startsWith("--size=")
        ? word.slice("--size=".length)
        : word.startsWith("-s") && word.length > 2
          ? word.slice(2)
          : "";
    if (!candidate) continue;
    if (size !== null || !/^(?:0|[1-9][0-9]*)$/.test(candidate)) return null;
    const parsed = Number(candidate);
    if (!Number.isSafeInteger(parsed) || parsed > MAX_CONDUCTOR_METADATA_COPY_BYTES) return null;
    size = parsed;
  }
  return size;
}

function conductorMetadataWriteSizesStayBounded(cwd: string, command: string): boolean {
  const sizes = new Map<string, number>();
  const keyFor = (target: string): string | null => {
    if (!target || shellWordMayProduceWgetOptions(target) || conductorPathnameExpansionIsAmbiguous(target)) return null;
    try {
      return isAbsolute(target) ? resolve(target) : resolve(cwd, target);
    } catch {
      return null;
    }
  };
  const readSize = (target: string): number | null => {
    const key = keyFor(target);
    if (!key) return null;
    const known = sizes.get(key);
    if (known !== undefined) return known;
    const size = conductorMetadataLeafSize(cwd, target);
    if (size === null) return null;
    sizes.set(key, size);
    return size;
  };
  for (const segment of splitShellCommandSegments(stripHeredocBodiesForCommandScan(command))) {
    const words = tokenizeConductorShellWords(segment);
    const commandIndex = skipShellCommandPositionPrefixWords(words, 0);
    if (commandNameFromShellWord(words[commandIndex] ?? "") === "truncate") {
      const targets = collectConductorBoundedTruncateTargets(words, commandIndex);
      const size = conductorStaticTruncateSize(words, commandIndex);
      if (targets === null || size === null) return false;
      for (const target of targets) {
        const key = keyFor(target);
        if (!key) return false;
        sizes.set(key, size);
      }
    }
    const redirectScanSegment = maskQuotedRedirectMetacharsForCommandScan(segment);
    for (const match of redirectScanSegment.matchAll(/(?:^|[^<>])(?:[0-9]*)(<>|>>|>\||>&|>)\s*(["']?)([^\s&|;<>]+)\2/g)) {
      const operator = match[1] ?? "";
      const target = safeString(match[3]).trim();
      if (!target || target === "-" || /^\d+$/.test(target)) continue;
      const key = keyFor(target);
      const current = readSize(target);
      if (!key || current === null) return false;
      // Quoted heredoc bodies were separately bounded by the producer validator.
      // They may replace a leaf, but appending would require an exact existing-size proof.
      if (segment.includes("<<")) {
        if (operator === ">>") return false;
        sizes.set(key, MAX_CONDUCTOR_METADATA_COPY_BYTES);
        continue;
      }
      // Use the complete static segment as an upper bound for the producer bytes.
      const producerBytes = Buffer.byteLength(segment, "utf-8");
      if (producerBytes > MAX_CONDUCTOR_METADATA_COPY_BYTES) return false;
      const next = operator === ">>" ? current + producerBytes : producerBytes;
      if (next > MAX_CONDUCTOR_METADATA_COPY_BYTES) return false;
      sizes.set(key, next);
    }
  }
  return true;
}

function commandHasDestructiveGitSubcommand(command: string): boolean {
  const destructiveSubcommands = new Set([
    "am",
    "apply",
    "checkout",
    "clean",
    "merge",
    "rebase",
    "reset",
    "restore",
    "rm",
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
      if (subcommand === "worktree") {
        const worktreeSubcommandIndex = findGitSubcommandIndex(words, subcommandIndex + 1);
        if (worktreeSubcommandIndex === null) continue;
        const worktreeSubcommand = words[worktreeSubcommandIndex] ?? "";
        if (worktreeSubcommand === "add" || worktreeSubcommand === "move" || worktreeSubcommand === "mv" || worktreeSubcommand === "remove" || worktreeSubcommand === "rm" || worktreeSubcommand === "prune" || worktreeSubcommand === "repair" || worktreeSubcommand === "clean") return true;
      }
      if (subcommand.startsWith("checkout-")) return true;
      if (subcommand.startsWith("merge-") && subcommand !== "merge-base") return true;
    }
  }
  return false;
}
function commandHasPackageInstallIntent(command: string): boolean {
  for (const segment of splitShellCommandSegments(stripHeredocBodiesForCommandScan(command))) {
    const words = tokenizeShellWords(segment);
    for (let index = 0; index < words.length; index += 1) {
      const headBase = shellWordBaseName(words[index] ?? "");
      if (headBase !== "npm" && headBase !== "pnpm" && headBase !== "yarn") continue;
      const subcommandIndex = findPackageInstallSubcommandIndex(words, index + 1);
      if (subcommandIndex === null) continue;
      const subcommand = words[subcommandIndex] ?? "";
      if (headBase === "npm" && (subcommand === "install" || subcommand === "i" || subcommand === "ci")) return true;
      if (headBase === "pnpm" && (subcommand === "install" || subcommand === "i" || subcommand === "add")) return true;
      if (headBase === "yarn" && (subcommand === "install" || subcommand === "add")) return true;
    }
  }
  return false;
}

function findPackageInstallSubcommandIndex(words: string[], startIndex: number): number | null {
  for (let index = startIndex; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word || word === "--") continue;
    if (isShellAssignmentWord(word)) continue;
    if (word === "-C" || word === "--prefix" || word === "--dir" || word === "--cwd" || word === "-w" || word === "--workspace") {
      index += 1;
      continue;
    }
    if (word.startsWith("--prefix=") || word.startsWith("--dir=") || word.startsWith("--cwd=") || word.startsWith("--workspace=")) continue;
    if (/^-C.+/.test(word) || /^-w.+/.test(word)) continue;
    if (word.startsWith("-")) continue;
    return index;
  }
  return null;
}

function commandHasUntargetedPlanningForbiddenIntent(command: string): boolean {
  return commandHasDestructiveGitSubcommand(command) || commandHasPackageInstallIntent(command);
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
function commandExecutesUninspectedScript(
  command: string,
  cwd = process.cwd(),
  inheritedShellFunctions: ReadonlyMap<string, string[]> = new Map(),
  depth = 0,
): boolean {
  const runtimeFunctionScan = collectConductorStaticNestedBashExecutions(command, cwd, inheritedShellFunctions);
  for (const segment of [stripHeredocBodiesForCommandScan(command)]) {
    if (
      collectOmxStateCommandOperations(segment, "write").length > 0
      || collectOmxStateCommandOperations(segment, "clear").length > 0
    ) continue;
    const words = tokenizeConductorShellWords(segment);
    const commandStarts = new Set(collectShellCommandStartIndexes(words));
    const casePhases = collectShellCasePhases(words);
    let commandStart = true;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index] ?? "";
      if (!word) continue;
      if (casePhases[index] === "pattern") continue;
      if (commandStarts.has(index)) commandStart = true;
      if (isShellCommandSeparatorAt(words, index)) {
        commandStart = true;
        continue;
      }
      if (isShellGroupingSyntaxWord(word)) continue;
      if (commandStart && word === "case") {
        commandStart = false;
        continue;
      }
      if (commandStart && (isEnvironmentAssignmentWord(word) || CONDUCTOR_BASH_COMPOUND_SYNTAX_WORDS.has(word))) continue;
      if (!commandStart) continue;

      let commandIndex = index;
      const visitedIndexes = new Set<number>();
      while (!visitedIndexes.has(commandIndex)) {
        visitedIndexes.add(commandIndex);
        const commandName = commandNameFromShellWord(words[commandIndex] ?? "");
        const operandIndex = findConductorWrapperOperandIndex(commandName, words, commandIndex + 1);
        if (operandIndex === undefined) break;
        if (operandIndex === null) return true;
        commandIndex = operandIndex;
      }

      const commandWord = words[commandIndex] ?? "";
      const commandName = commandNameFromShellWord(commandWord);
      const functionBodies = runtimeFunctionScan.functions.get(commandWord) ?? [];
      if (functionBodies.some(isConductorFunctionBody) && !isConductorShellFunctionDefinitionInvocation(words, commandIndex)) {
        if (depth >= CONDUCTOR_BASH_MAX_NESTING_DEPTH) return true;
        if (functionBodies.some((body) => isConductorFunctionBody(body) && commandExecutesUninspectedScript(body, cwd, runtimeFunctionScan.functions, depth + 1))) return true;
      }
      if (commandName === "source" || commandName === ".") {
        if (firstNonOptionSourceOperand(words, commandIndex)) return true;
      } else if (isScriptInterpreterCommandWord(commandWord)) {
        if (firstInterpreterScriptOperands(words, commandIndex).length > 0) return true;
      } else if (/\.(?:ba|z|k)?sh$|\.(?:[cm]?js|[cm]?ts|py|rb|pl|php|lua)$/i.test(commandWord)) {
        return true;
      }
      commandStart = false;
    }
  }
  if (depth >= CONDUCTOR_BASH_MAX_NESTING_DEPTH && runtimeFunctionScan.executions.length > 0) return true;
  return runtimeFunctionScan.executions.some((nested) => commandExecutesUninspectedScript(nested.command, cwd, nested.functions, depth + 1));
}



function commandHasDeepInterviewWriteIntent(command: string, depth = 0, cwd = process.cwd()): boolean {
  return commandInvokesApplyPatch(command)
    || extractDeepInterviewCommandRedirectTargets(command).length > 0
    || /\btee\s+(?:-a\s+)?[^\s&|;]+/.test(command)
    || extractConductorEditorWriteTargets(command).length > 0
    || /\bsed\s+(?:[^\n;&|]*\s)?-i(?:\b|['"])/.test(command)
    || /\bperl\s+(?:[^\n;&|]*\s)?-[^-\s]*i(?:\b|['"])/.test(command)
    || /\b(?:python3?|perl|ruby)\b[\s\S]{0,260}\b(?:writeFileSync|writeFile|write_text|open\([^)]*["']w|File\.write|Path\()/.test(command)
    || extractConductorBashMutations(command, cwd).length > 0
    || extractConductorInterpreterWrites(command).length > 0
    || collectOmxStateCommandOperations(command, "clear").length > 0
    || commandExecutesUninspectedScript(command, cwd)
    || commandHasDestructiveGitSubcommand(command)
    || commandHasPackageInstallIntent(command)
    // Recurse into wrapped shells (`bash -lc "cat > f"`, `eval`, `env`) and
    // command substitutions so a real redirect INSIDE a nested command string
    // is still classified as write intent. This is required because quoted
    // redirect metacharacters are now masked at the outer scan (#3119): the
    // mask removes false positives from quoted DATA values while nested-command
    // recursion re-detects genuine redirects, preserving fail-closed blocking.
    // The depth guard mirrors evaluateConductorBashWrite's nesting bound;
    // extractors return strict substrings, so recursion always terminates.
    || (depth < CONDUCTOR_BASH_MAX_NESTING_DEPTH && (
      extractNestedShellCommandStringsForStateScan(command).some((nested) => commandHasDeepInterviewWriteIntent(nested, depth + 1, cwd))
      || extractNestedCommandSubstitutionStringsForStateScan(command).some((nested) => commandHasDeepInterviewWriteIntent(nested, depth + 1, cwd))
    ));
}

type PreToolUseMutationTransport = "read-only" | "bash" | "path" | "state" | "orchestration" | "unknown";

const READ_ONLY_PRETOOLUSE_TOOL_NAMES = new Set([
  "Read",
  "Glob",
  "Grep",
  "Search",
  "WebFetch",
  "WebSearch",
]);
const READ_ONLY_PRETOOLUSE_MCP_CONTRACT = {
  filesystem: [
    "mcp__filesystem__read_file",
    "mcp__filesystem__read_text_file",
    "mcp__filesystem__read_media_file",
    "mcp__filesystem__read_multiple_files",
    "mcp__filesystem__list_directory",
    "mcp__filesystem__directory_tree",
    "mcp__filesystem__search_files",
    "mcp__filesystem__get_file_info",
    "mcp__filesystem__list_allowed_directories",
  ],
  state: [
    "mcp__omx_state__state_read",
    "mcp__omx_state__state_list_active",
    "mcp__omx_state__state_get_status",
  ],
  trace: [
    "mcp__omx_trace__trace_timeline",
    "mcp__omx_trace__trace_summary",
  ],
  codeIntel: [
    "mcp__omx_code_intel__lsp_diagnostics",
    "mcp__omx_code_intel__lsp_servers",
    "mcp__omx_code_intel__lsp_diagnostics_directory",
    "mcp__omx_code_intel__lsp_document_symbols",
    "mcp__omx_code_intel__lsp_workspace_symbols",
    "mcp__omx_code_intel__lsp_hover",
    "mcp__omx_code_intel__lsp_find_references",
    "mcp__omx_code_intel__ast_grep_search",
  ],
  wiki: [
    "mcp__omx_wiki__wiki_query",
    "mcp__omx_wiki__wiki_lint",
    "mcp__omx_wiki__wiki_list",
    "mcp__omx_wiki__wiki_read",
  ],
  memory: [
    "mcp__omx_memory__project_memory_read",
    "mcp__omx_memory__notepad_read",
    "mcp__omx_memory__notepad_stats",
  ],
} as const;

// This set is intentionally explicit and auditable. Additions require inspecting
// the registered handler and proving that the named operation exposes no
// caller-directed product, workflow-state, durable-memory, or lifecycle mutation
// authority. Any bounded read telemetry or tool cache side effect must be understood
// and must not turn caller-supplied targets/content into write authority.
const READ_ONLY_PRETOOLUSE_MCP_TOOL_NAMES = new Set<string>(
  Object.values(READ_ONLY_PRETOOLUSE_MCP_CONTRACT).flat(),
);
const OMX_STATE_MUTATION_TOOL_NAMES = new Set([
  "mcp__omx_state__state_write",
  "mcp__omx_state__state_clear",
]);
const CONDUCTOR_ORCHESTRATION_TOOL_NAMES = new Set([
  "Task",
  "task",
  "spawn_agent",
  "close_agent",
  "collaboration.spawn_agent",
  "collaboration.close_agent",
  "multi_agent_v1.spawn_agent",
  "multi_agent_v1.close_agent",
]);

function classifyPreToolUseMutationTransport(
  payload: CodexHookPayload,
  toolName: string,
  cwd = process.cwd(),
): PreToolUseMutationTransport {
  if (toolName === "Bash") {
    const command = readPreToolUseCommand(payload);
    return commandHasDeepInterviewWriteIntent(command, 0, cwd) || collectOmxStateCommandOperations(command, "write").length > 0 || commandHasNestedCliMutationIntent(command) || classifyConductorExecutableRuntime(command, 0, cwd) !== null
      ? "bash"
      : "read-only";
  }
  if (OMX_STATE_MUTATION_TOOL_NAMES.has(toolName)) return "state";
  if (PLANNING_MODE_IMPLEMENTATION_TOOL_NAMES.has(toolName)) return "path";
  if (READ_ONLY_PRETOOLUSE_TOOL_NAMES.has(toolName) || READ_ONLY_PRETOOLUSE_MCP_TOOL_NAMES.has(toolName)) {
    return "read-only";
  }
  if (
    CONDUCTOR_ORCHESTRATION_TOOL_NAMES.has(toolName)
    || toolName.startsWith("collaboration.")
    || toolName.startsWith("multi_agent_v1.")
    || toolName.startsWith("mcp__omx_team__")
    || toolName.startsWith("mcp__omx_ultragoal__")
  ) {
    return "orchestration";
  }
  if (toolName.startsWith("mcp__filesystem__")) return "path";

  // A hook cannot infer that an unfamiliar transport is read-only. Keeping this
  // distinct from known path/state transports lets each guard reject it rather
  // than accidentally treating a new mutation API as a no-op.
  return "unknown";
}

function extractDeepInterviewCommandWriteTargets(command: string, cwd = process.cwd(), rootCwd = cwd): string[] {
  const assignments = new Map<string, string>();
  const targets = extractDeepInterviewCommandRedirectTargets(command)
    .map((target) => resolveCommandRedirectTarget(target, assignments));
  targets.push(...extractConductorEditorWriteTargets(command));
  for (const mutation of extractConductorBashMutations(command, cwd, rootCwd)) {
    targets.push(...mutation.targets);
  }
  for (const write of extractConductorInterpreterWrites(command)) {
    targets.push(...write.targets);
  }
  for (const segment of splitShellCommandSegments(stripHeredocBodiesForCommandScan(command))) {
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
  for (const nestedCommand of extractNestedShellCommandStringsForStateScan(command)) {
    targets.push(...extractDeepInterviewCommandWriteTargets(nestedCommand, cwd));
  }
  for (const nestedCommand of extractNestedCommandSubstitutionStringsForStateScan(command)) {
    targets.push(...extractDeepInterviewCommandWriteTargets(nestedCommand, cwd));
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
  const normalized = target.trim();
  return target === "<unresolved-redirect-target>"
    || /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(normalized);
}

function normalizeSameCommandScriptTarget(
  cwd: string,
  rawPath: string,
  assignments: Map<string, string>,
): string | null {
  const trimmed = resolveCommandRedirectTarget(
    rawPath.trim(),
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
  const trimmed = rawPath.trim();
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

function resolveSimpleCdCommandCwd(currentCwd: string, words: string[]): string | null {
  const commandIndex = findWrappedCommandPositionIndex(words, 0);
  if (commandIndex === null || shellWordBaseName(words[commandIndex] ?? "") !== "cd") return null;

  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word || word === "--") continue;
    if (word === "-L" || word === "-P" || word === "-e") continue;
    if (word.startsWith("-")) return null;

    const normalizedTarget = normalizeCommandDirectoryTarget(word);
    if (normalizedTarget === null) return null;
    try {
      return resolve(currentCwd, normalizedTarget);
    } catch {
      return null;
    }
  }

  return null;
}

function isEnvCwdChangingOption(word: string): boolean {
  return word === "-C"
    || word === "--chdir"
    || word.startsWith("--chdir=")
    || /^-C.+/.test(word);
}

interface WrappedCommandExecutionContext {
  index: number;
  cwd: string;
}

function resolveEnvWrappedCommandCwd(currentCwd: string, words: string[], envWordIndex: number, operandIndex: number): string | null {
  let effectiveCwd = currentCwd;
  for (let index = envWordIndex + 1; index < operandIndex; index += 1) {
    const word = words[index] ?? "";
    if (!word || word === "--" || isShellAssignmentWord(word)) continue;
    if (word === "-S" || word === "--split-string" || word.startsWith("-S") || word.startsWith("--split-string=")) return null;
    if (word === "-u" || word === "--unset" || word === "-a" || word === "--argv0") {
      index += 1;
      continue;
    }
    if (word.startsWith("--unset=") || word.startsWith("--argv0=") || /^-u.+/.test(word) || /^-a.+/.test(word)) continue;
    if (isEnvCwdChangingOption(word)) {
      let target = "";
      if (word === "-C" || word === "--chdir") {
        target = words[index + 1] ?? "";
        index += 1;
      } else if (word.startsWith("--chdir=")) {
        target = word.slice("--chdir=".length);
      } else if (word.startsWith("-C") && word.length > 2) {
        target = word.slice(2);
      }
      const normalizedTarget = normalizeCommandDirectoryTarget(target);
      if (normalizedTarget === null) return null;
      try {
        effectiveCwd = resolve(effectiveCwd, normalizedTarget);
      } catch {
        return null;
      }
    }
  }
  return effectiveCwd;
}

function conductorInvocationUsesEnvCwdChangingWrapper(words: string[], commandStartIndex: number, commandIndex: number): boolean {
  return words.slice(commandStartIndex, commandIndex).some(isEnvCwdChangingOption);
}

function resolveWrappedCommandExecutionContext(words: string[], currentCwd: string, startIndex = 0): WrappedCommandExecutionContext | null {
  let commandWordIndex = skipShellCommandPositionPrefixWords(words, startIndex);
  let effectiveCwd = currentCwd;
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
                : commandWordBase === "nohup" || commandWordBase === "setsid"
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
    if (operandIndex === null) return { index: commandWordIndex, cwd: effectiveCwd };

    if (commandWordBase === "env") {
      const envCwd = resolveEnvWrappedCommandCwd(effectiveCwd, words, commandWordIndex, operandIndex);
      if (envCwd === null) return null;
      effectiveCwd = envCwd;
    }

    const nextCommandWordIndex = skipShellCommandPositionPrefixWords(words, operandIndex);
    if (nextCommandWordIndex === commandWordIndex) return { index: commandWordIndex, cwd: effectiveCwd };
    commandWordIndex = nextCommandWordIndex;
  }

  return null;
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

function findShellFunctionDefinitionAt(command: string, index: number): { name: string; startIndex: number; openBraceIndex: number; bodyOpenChar: "{" | "(" } | null {
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
      startIndex: cursor,
      openBraceIndex: cursor + functionKeywordMatch[0].length - 1,
      bodyOpenChar: functionKeywordMatch[2] === "(" ? "(" : "{",
    };
  }
  const bareFunctionMatch = candidate.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*([\{(])/);
  if (bareFunctionMatch) {
    return {
      name: bareFunctionMatch[1],
      startIndex: cursor,
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
    const commandStarts = new Set(collectShellCommandStartIndexes(words));
    if ([...commandStarts].some((startIndex) => isShellFunctionInvokedFromWords(words, startIndex, functionName))) return true;
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

function stdinRedirectOperands(words: string[]): string[] {
  const operands: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "<") {
      const operand = words[index + 1] ?? "";
      if (operand) operands.push(operand);
      index += 1;
      continue;
    }
    if (/^\d*<[^<&].+/.test(word)) {
      operands.push(word.replace(/^\d*</, ""));
    }
  }
  return operands;
}

function firstShellScriptOperands(words: string[], shellWordIndex: number): string[] {
  const operands: string[] = [];
  for (let index = shellWordIndex + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word || word === "--") continue;
    if (isShellCommandStringOption(word)) return operands;
    if (isShellOptionWithSeparateValue(word)) {
      const value = words[index + 1] ?? "";
      if ((word === "--init-file" || word === "--rcfile") && value) operands.push(value);
      index += 1;
      continue;
    }
    if (word.startsWith("--init-file=") || word.startsWith("--rcfile=")) {
      operands.push(word.slice(word.indexOf("=") + 1));
      continue;
    }
    if (word.startsWith("-")) continue;
    operands.push(word);
    return operands;
  }
  return operands;
}

function firstShellScriptOperand(words: string[], shellWordIndex: number): string {
  return firstShellScriptOperands(words, shellWordIndex)[0] ?? "";
}

function isPythonInterpreterCommandWord(base: string): boolean {
  return /^python(?:[0-9]+(?:\.[0-9]+)*)?$/.test(base);
}


function pythonCommandUsesIsolatedStartup(words: string[], commandIndex: number): boolean {
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word || isShellCommandSeparator(word) || word === "--") break;
    if (word === "-c" || word === "-m" || word.startsWith("-c") || word.startsWith("-m")) break;
    if (word === "-I" || /^-[^-]*I/.test(word)) return true;
    if (!word.startsWith("-")) break;
    if (isPythonRuntimeOptionWithSeparateValue(word)) index += 1;
  }
  return false;
}

function isConductorWritableMetadataRuntimeCwd(cwd: string): boolean {
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return CONDUCTOR_ORCHESTRATION_METADATA_PREFIXES.some((prefix) => (
    normalized.endsWith(`/${prefix}`) || normalized.includes(`/${prefix}/`)
  ));
}

function pythonCwdHasLoadableStartupCandidate(cwd: string): boolean {
  const startupModules = ["sitecustomize", "usercustomize"];
  let entries: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }>;
  try {
    entries = readdirSync(cwd, { withFileTypes: true });
  } catch {
    return true;
  }

  for (const entry of entries) {
    for (const moduleName of startupModules) {
      if (entry.name === moduleName) return true;
      const escapedModuleName = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (
        new RegExp(`^${escapedModuleName}\\.(?:py|pyc|pyo)$`, "i").test(entry.name)
        || new RegExp(`^${escapedModuleName}(?:\\.[A-Za-z0-9_-]+)*\\.(?:so|pyd|dll|dylib)$`, "i").test(entry.name)
      ) return true;
    }
  }

  const pycache = entries.find((entry) => entry.name === "__pycache__");
  if (!pycache) return false;
  if (!pycache.isDirectory()) return pycache.isSymbolicLink();
  try {
    const cachedEntries = readdirSync(join(cwd, "__pycache__"));
    return startupModules.some((moduleName) => {
      const escapedModuleName = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return cachedEntries.some((entry) => new RegExp(`^${escapedModuleName}(?:\\.[A-Za-z0-9_-]+)*\\.(?:py[co]|so|pyd|dll|dylib)$`, "i").test(entry));
    });
  } catch {
    return true;
  }
}

function pythonInvocationHomeHasLoadableStartupCandidate(words: string[], commandIndex: number, isolated: boolean): boolean {
  if (isolated) return false;
  let home = safeString(process.env.HOME).trim();
  for (let index = commandIndex - 1; index >= 0 && !isShellCommandSeparatorAt(words, index); index -= 1) {
    const assignment = parseShellAssignmentWord(words[index] ?? "");
    if (assignment?.name === "HOME") {
      if (shellWordMayProduceWgetOptions(assignment.value)) return true;
      home = assignment.value;
      break;
    }
  }
  if (!home || home === "/dev/null") return false;
  try {
    const userLib = join(home, ".local", "lib");
    for (const entry of readdirSync(userLib, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return true;
      const sitePackages = join(userLib, entry.name, "site-packages");
      if (existsSync(sitePackages) && pythonCwdHasLoadableStartupCandidate(sitePackages)) return true;
    }
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function isNodeInterpreterCommandWord(base: string): boolean {
  return /^(?:node|nodejs)$/.test(base);
}

const CONDUCTOR_SAFE_PYTHON_X_OPTIONS = new Set(["dev", "utf8", "warn_default_encoding"]);

// Only startup, import/helper resolution, interactive execution, or filesystem-output controls are authorization-relevant.
const CONDUCTOR_PYTHON_DANGEROUS_ENVIRONMENT_NAMES = new Set([
  "PYTHONHOME", "PYTHONINSPECT", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONUSERBASE", "PYTHONWARNINGS", "PYTHONPYCACHEPREFIX",
  "PYTHONBREAKPOINT", "PYTHONPLATLIBDIR",
]);

function isPythonRuntimeOptionWithSeparateValue(word: string): boolean {
  return word === "--check-hash-based-pycs" || word === "-W" || word === "-X";
}

function pythonCommandHasOnlySafeOptions(words: string[], commandIndex: number): boolean {
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = shellWordLiteral(words[index] ?? "");
    if (!word || isShellCommandSeparator(word) || word === "--") break;
    if (word === "-c" || word === "-m") return true;
    if (word === "-X") {
      const value = shellWordLiteral(words[index + 1] ?? "");
      if (!CONDUCTOR_SAFE_PYTHON_X_OPTIONS.has(value)) return false;
      index += 1;
      continue;
    }
    if (word.startsWith("-X")) {
      if (!CONDUCTOR_SAFE_PYTHON_X_OPTIONS.has(word.slice(2))) return false;
      continue;
    }
    if (word === "-W" || word === "--check-hash-based-pycs") {
      const value = shellWordLiteral(words[index + 1] ?? "");
      if (!value || isShellCommandSeparator(value)) return false;
      index += 1;
      continue;
    }
    if (word.startsWith("-W") || word.startsWith("--check-hash-based-pycs=")) continue;
    if (word === "-I") continue;
    if (/^-[A-Za-z]+$/.test(word)) {
      // Python short-option clusters can contain -i, which executes stdin after -c.
      // Only the isolated-startup flag is modeled for authorization-sensitive runtimes.
      return false;
    }
    if (word === "-") return true;
    if (word.startsWith("-")) return false;
    return true;
  }
  return true;
}

function pythonCommandHasLiteralReviewedReadOnlyInlineSource(words: string[], commandIndex: number): boolean {
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = shellWordLiteral(words[index] ?? "");
    if (!word || isShellCommandSeparator(word) || word === "--") return false;
    if (word !== "-c") continue;
    const rawSource = words[index + 1] ?? "";
    if (!rawSource || isShellCommandTerminatorOrGroupClose(rawSource) || shellWordMayProduceWgetOptions(rawSource)) return false;
    return isPositivelyReadOnlyPythonInlineSource(shellWordLiteral(rawSource));
  }
  return false;
}

function pythonInvocationHasUnsafeRuntimeEnvironment(words: string[], commandIndex: number): boolean {
  let invocationStart = commandIndex;
  while (
    invocationStart > 0
    && !isShellCommandSeparatorAt(words, invocationStart - 1)
    && !isShellGroupingSyntaxWord(words[invocationStart - 1] ?? "")
  ) invocationStart -= 1;

  const unsafeNames = new Set(
    [...CONDUCTOR_PYTHON_DANGEROUS_ENVIRONMENT_NAMES].filter((name) => safeString(process.env[name]).trim() !== ""),
  );
  const applyRange = (start: number, end: number): void => {
    for (let index = start; index < end; index += 1) {
      const assignment = parseShellAssignmentWord(words[index] ?? "");
      if (assignment && CONDUCTOR_PYTHON_DANGEROUS_ENVIRONMENT_NAMES.has(assignment.name)) {
        if (assignment.value.trim()) unsafeNames.add(assignment.name);
        else unsafeNames.delete(assignment.name);
        continue;
      }
      if (commandNameFromShellWord(words[index] ?? "") === "env") {
        for (let cursor = index + 1; cursor < end; cursor += 1) {
          const option = shellWordLiteral(words[cursor] ?? "");
          if (!option || isShellCommandTerminatorOrGroupClose(option)) break;
          if (option === "-u" || option === "--unset") {
            const name = shellWordLiteral(words[cursor + 1] ?? "");
            if (!name) break;
            if (CONDUCTOR_PYTHON_DANGEROUS_ENVIRONMENT_NAMES.has(name)) unsafeNames.delete(name);
            cursor += 1;
            continue;
          }
          if (option.startsWith("--unset=")) {
            const name = option.slice("--unset=".length);
            if (CONDUCTOR_PYTHON_DANGEROUS_ENVIRONMENT_NAMES.has(name)) unsafeNames.delete(name);
            continue;
          }
          if (/^-u.+/.test(option)) {
            const name = option.slice(2);
            if (CONDUCTOR_PYTHON_DANGEROUS_ENVIRONMENT_NAMES.has(name)) unsafeNames.delete(name);
            continue;
          }
          if (!option.startsWith("-")) break;
        }
      }
      if (commandNameFromShellWord(words[index] ?? "") !== "unset") continue;
      for (index += 1; index < end; index += 1) {
        const operand = shellWordLiteral(words[index] ?? "");
        if (!operand || isShellCommandTerminatorOrGroupClose(operand)) break;
        if (!operand.startsWith("-") && CONDUCTOR_PYTHON_DANGEROUS_ENVIRONMENT_NAMES.has(operand)) unsafeNames.delete(operand);
      }
    }
  };

  const clearBoundary = nestedExecEnvironmentClearBoundary(words, invocationStart, commandIndex);
  if (clearBoundary === null) applyRange(0, commandIndex);
  else {
    applyRange(0, clearBoundary);
    unsafeNames.clear();
    applyRange(clearBoundary + 1, commandIndex);
  }
  return unsafeNames.size > 0;
}

function isScriptInterpreterCommandWord(word: string): boolean {
  const base = shellWordBaseName(word);
  return isNestedShellCommandWord(base)
    || isNodeInterpreterCommandWord(base)
    || base === "bun"
    || base === "tsx"
    || base === "deno"
    || isPythonInterpreterCommandWord(base)
    || base === "perl"
    || base === "ruby"
    || base === "php"
    || base === "lua"
    || base === "go"
    || base === "npx"
    || base === "npm"
    || base === "pnpm"
    || base === "yarn";
}

function isTsxRuntimeOptionWithSeparateValue(word: string): boolean {
  return word === "--tsconfig";
}

function isTsxRuntimeModeWord(word: string): boolean {
  return word === "watch";
}


function firstInterpreterScriptOperands(words: string[], interpreterWordIndex: number): string[] {
  const base = shellWordBaseName(words[interpreterWordIndex] ?? "");
  if (isNestedShellCommandWord(base)) return firstShellScriptOperands(words, interpreterWordIndex);

  const operands: string[] = [];
  let sawGoRun = false;
  let sawPackageRunner = base === "npx";
  for (let index = interpreterWordIndex + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word || word === "--") continue;
    if (isPythonInterpreterCommandWord(base)) {
      if (word === "-c" || word === "-m") return operands;
      if (isPythonRuntimeOptionWithSeparateValue(word)) {
        index += 1;
        continue;
      }
      if (word.startsWith("-W") || word.startsWith("-X")) continue;
      if (word.startsWith("-")) continue;
      operands.push(word);
      return operands;
    }
    if (isNodeInterpreterCommandWord(base) || base === "bun" || base === "tsx") {
      if (word === "-e" || word === "--eval" || word === "-p" || word === "--print") return operands;
      if (runtimeOptionConsumesNextWord(word) || (base === "tsx" && isTsxRuntimeOptionWithSeparateValue(word))) {
        const value = words[index + 1] ?? "";
        if (value && (word === "-r" || word === "--require" || word === "--import" || word === "--loader" || word === "--experimental-loader")) {
          operands.push(value);
        }
        index += 1;
        continue;
      }
      if (word.startsWith("--require=") || word.startsWith("--import=") || word.startsWith("--loader=") || word.startsWith("--experimental-loader=")) {
        operands.push(word.slice(word.indexOf("=") + 1));
        continue;
      }
      if (word.startsWith("--eval=") || word.startsWith("--print=")) return operands;
      if (base === "tsx" && isTsxRuntimeModeWord(word)) continue;
      if (word.startsWith("-")) continue;
      operands.push(word);
      return operands;
    }
    if (base === "deno") {
      if (word === "eval" || word === "repl") return operands;
      if (word === "run") continue;
      if (word.startsWith("-")) continue;
      operands.push(word);
      return operands;
    }
    if (base === "go") {
      if (!sawGoRun) {
        if (word === "run") {
          sawGoRun = true;
          continue;
        }
        return operands;
      }
      if (word.startsWith("-")) continue;
      operands.push(word);
      return operands;
    }
    if (base === "npm" || base === "pnpm" || base === "yarn" || base === "npx") {
      if (!sawPackageRunner) {
        if (word === "exec" || word === "x" || word === "dlx") {
          sawPackageRunner = true;
          continue;
        }
        return operands;
      }
      if (word.startsWith("-")) continue;
      if (word === "tsx" || word === "node" || word === "bun" || word === "deno") continue;
      operands.push(word);
      return operands;
    }
    if (base === "perl" || base === "ruby" || base === "php" || base === "lua") {
      if (word === "-e" || /^-[A-Za-z]*e/.test(word)) return operands;
      if (word.startsWith("-")) continue;
      operands.push(word);
      return operands;
    }
  }
  return operands;
}


function firstPlanningTmpScriptExecutionTarget(cwd: string, command: string): string | null {
  const scanCommand = (currentCwd: string, currentCommand: string, activeCommands: Set<string>): string | null => {
    const normalizedCommand = stripHeredocBodiesForCommandScan(normalizeShellLineContinuations(currentCommand));
    const commandKey = `${currentCwd}\0${normalizedCommand.trim()}`;
    if (!normalizedCommand.trim() || activeCommands.has(commandKey)) return null;

    const assignments = extractCommandLiteralAssignments(normalizedCommand);
    const nextActiveCommands = new Set(activeCommands);
    nextActiveCommands.add(commandKey);
    let effectiveCwd = currentCwd;
    const normalizeExecutionTarget = (operandCwd: string, rawPath: string): string | null => {
      const absoluteTarget = normalizeSameCommandScriptTarget(operandCwd, rawPath, assignments);
      if (!absoluteTarget) return null;
      const relativePath = relative(cwd, absoluteTarget).replace(/\\/g, "/");
      if (!relativePath || relativePath.startsWith("..") || relativePath.startsWith("/")) return null;
      return relativePath;
    };


    for (const segment of splitShellCommandSegments(normalizedCommand)) {
      const words = tokenizeShellWords(segment);
      const cdCwd = resolveSimpleCdCommandCwd(effectiveCwd, words);
      if (cdCwd !== null) {
        effectiveCwd = cdCwd;
        continue;
      }

      const wrappedCommandContext = resolveWrappedCommandExecutionContext(words, effectiveCwd);
      for (let index = 0; index < words.length; index += 1) {
        const word = words[index] ?? "";
        const operandCwd = wrappedCommandContext && index >= wrappedCommandContext.index ? wrappedCommandContext.cwd : effectiveCwd;
        const operands = word === "source" || word === "."
          ? [firstNonOptionSourceOperand(words, index)].filter(Boolean)
          : isScriptInterpreterCommandWord(word)
            ? [...firstInterpreterScriptOperands(words, index), ...stdinRedirectOperands(words)]
            : [];
        for (const operand of operands) {
          const relativePath = normalizeExecutionTarget(operandCwd, operand);
          if (!relativePath && /[$`]/.test(operand)) return "<unresolved-script-target>";
          if (relativePath && (
            isPlanningTmpRelativePath(relativePath)
            || relativePath.startsWith(".omx/")
            || relativePath === ".beads"
            || relativePath.startsWith(".beads/")
          )) return relativePath;
        }
      }

      if (wrappedCommandContext !== null) {
        const directTarget = words[wrappedCommandContext.index] ?? "";
        const relativePath = normalizeExecutionTarget(
          wrappedCommandContext.cwd,
          directTarget,
        );
        if (relativePath && isPlanningTmpRelativePath(relativePath)) return relativePath;
      }

      for (const nestedCommand of extractNestedShellCommandStringsForStateScan(segment)) {
        const nestedTarget = scanCommand(effectiveCwd, nestedCommand, nextActiveCommands);
        if (nestedTarget) return nestedTarget;
      }
      for (const nestedCommand of extractNestedCommandSubstitutionStringsForStateScan(segment)) {
        const nestedTarget = scanCommand(effectiveCwd, nestedCommand, nextActiveCommands);
        if (nestedTarget) return nestedTarget;
      }
    }

    return null;
  };

  return scanCommand(cwd, command, new Set());
}


function sourcesFileWrittenEarlierInSameCommand(cwd: string, command: string): boolean {
  const scanCommand = (currentCwd: string, currentCommand: string, activeCommands: Set<string>, writtenTargets: Set<string>): boolean => {
    const normalizedCommand = stripHeredocBodiesForCommandScan(normalizeShellLineContinuations(currentCommand));
    const commandKey = `${currentCwd}\0${normalizedCommand.trim()}`;
    if (!normalizedCommand.trim() || activeCommands.has(commandKey)) return false;

    const assignments = extractCommandLiteralAssignments(normalizedCommand);
    const nextActiveCommands = new Set(activeCommands);
    nextActiveCommands.add(commandKey);

    for (const write of extractConductorInterpreterWrites(currentCommand)) {
      for (const target of write.targets) {
        const normalizedTarget = normalizeSameCommandScriptTarget(currentCwd, target, assignments);
        if (normalizedTarget) writtenTargets.add(normalizedTarget);
      }
    }
    let effectiveCwd = currentCwd;

    for (const segment of splitShellCommandSegments(normalizedCommand)) {
      const words = tokenizeShellWords(segment);
      const cdCwd = resolveSimpleCdCommandCwd(effectiveCwd, words);
      if (cdCwd !== null) {
        effectiveCwd = cdCwd;
        continue;
      }

      const wrappedCommandContext = resolveWrappedCommandExecutionContext(words, effectiveCwd);

      for (let index = 0; index < words.length; index += 1) {
        const word = words[index] ?? "";
        const operandCwd = wrappedCommandContext && index >= wrappedCommandContext.index ? wrappedCommandContext.cwd : effectiveCwd;
        const rawOperands = word === "source" || word === "."
          ? [firstNonOptionSourceOperand(words, index)]
          : isNestedShellCommandWord(word)
            ? [firstShellScriptOperand(words, index)]
            : isScriptInterpreterCommandWord(word)
              ? [...firstInterpreterScriptOperands(words, index), ...stdinRedirectOperands(words)]
              : [];
        for (const rawOperand of rawOperands) {
          const operand = normalizeSameCommandScriptTarget(operandCwd, rawOperand, assignments);
          if (operand && writtenTargets.has(operand)) return true;
        }
        if (isNestedShellCommandWord(word)) {
          for (let optionIndex = index + 1; optionIndex < words.length; optionIndex += 1) {
            const option = words[optionIndex] ?? "";
            if (!isShellCommandStringOption(option)) continue;
            const nestedSource = shellWordLiteral(words[optionIndex + 1] ?? "");
            const sourcesZero = /(?:^|[;&|]\s*|\s)(?:source|\.)\s+['"]?\$0/.test(nestedSource);
            const sourcesArguments = /(?:^|[;&|]\s*|\s)(?:source|\.)\s+['"]?\$@/.test(nestedSource);
            if (!sourcesZero && !sourcesArguments) break;
            if (sourcesZero) {
              const zeroTarget = normalizeSameCommandScriptTarget(operandCwd, words[optionIndex + 2] ?? "", assignments);
              if (zeroTarget && writtenTargets.has(zeroTarget)) return true;
            }
            if (sourcesArguments) {
              for (let argumentIndex = optionIndex + 3; argumentIndex < words.length; argumentIndex += 1) {
                const positionalTarget = normalizeSameCommandScriptTarget(operandCwd, words[argumentIndex] ?? "", assignments);
                if (positionalTarget && writtenTargets.has(positionalTarget)) return true;
              }
            }
            break;
          }
        }
      }

      const directExecutionTarget = wrappedCommandContext === null
        ? null
        : normalizeSameCommandScriptTarget(wrappedCommandContext.cwd, words[wrappedCommandContext.index] ?? "", assignments);
      if (directExecutionTarget && writtenTargets.has(directExecutionTarget)) return true;

      for (const nestedCommand of extractNestedShellCommandStringsForStateScan(segment)) {
        if (scanCommand(effectiveCwd, nestedCommand, nextActiveCommands, writtenTargets)) return true;
      }

      for (const target of extractDeepInterviewCommandWriteTargets(segment)) {
        const normalizedTarget = normalizeSameCommandScriptTarget(effectiveCwd, target, assignments);
        if (normalizedTarget) writtenTargets.add(normalizedTarget);
      }
    }

    return false;
  };

  return scanCommand(cwd, command, new Set(), new Set());
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
// The backend does NOT gate generic standalone deep-interview/ralplan
// *deactivation*, and it normalizes non-terminal tracked-workflow writes to
// `active=true`, so commands that would implicitly activate a tracked workflow
// while planning is still protected are blocked here. Ralplan terminal closeout
// is the narrow exception: the backend has a dedicated completeRalplanSession
// path that coherently terminalizes root and session state when the payload is a
// complete consensus-approved terminal state.
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

  const mergeModeFlag = (payload: Record<string, unknown>): Record<string, unknown> | null => {
    if (!conductorStateWritePayloadHasExactSchema(payload)) return null;
    const mode = readStateWriteFlagValue(stateWriteArgs, "--mode");
    const payloadMode = safeString(payload.mode).trim();
    if (mode && payloadMode && mode !== payloadMode) return null;
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

function decodeAnsiCShellEscape(segment: string, startIndex: number): { value: string; endIndex: number } | null {
  if (segment[startIndex] !== "\\") return null;
  const escape = segment[startIndex + 1] ?? "";
  const decodeDigits = (digits: string, radix: number, endIndex: number) => ({
    value: String.fromCodePoint(Number.parseInt(digits, radix)),
    endIndex,
  });
  if (escape === "u" || escape === "U") {
    const width = escape === "u" ? 4 : 8;
    const digits = segment.slice(startIndex + 2, startIndex + 2 + width);
    if (!new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(digits)) return null;
    const codePoint = Number.parseInt(digits, 16);
    if (codePoint > 0x10ffff) return null;
    return decodeDigits(digits, 16, startIndex + 1 + width);
  }
  if (escape === "x") {
    const digits = /^([0-9A-Fa-f]{1,2})/.exec(segment.slice(startIndex + 2))?.[1] ?? "";
    return digits ? decodeDigits(digits, 16, startIndex + 1 + digits.length) : null;
  }
  if (/^[0-7]$/.test(escape)) {
    const digits = /^([0-7]{1,3})/.exec(segment.slice(startIndex + 1))?.[1] ?? "";
    return digits ? decodeDigits(digits, 8, startIndex + digits.length) : null;
  }
  return null;
}

function tokenizeShellWords(segment: string): string[] {
  segment = normalizeShellLineContinuations(segment);
  const words: string[] = [];
  let current = "";
  let wordStarted = false;
  let quote: "'" | "\"" | "$'" | null = null;
  let wordQuoted = false;
  const pushCurrent = (): void => {
    if (wordStarted) {
      const reserved = new Set(["case", "coproc", "esac", "in", "if", "then", "else", "elif", "fi", "for", "time", "while", "until", "do", "done"]);
      words.push(wordQuoted && reserved.has(current) ? `${CONDUCTOR_QUOTED_RESERVED_WORD_PREFIX}${current}` : current);
    }
    current = "";
    wordStarted = false;
    wordQuoted = false;
  };
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (char === "\\" && quote === "$'") {
      const ansiEscape = decodeAnsiCShellEscape(segment, index);
      if (ansiEscape) {
        current += ansiEscape.value;
        wordStarted = true;
        index = ansiEscape.endIndex;
        continue;
      }
    }
    if (char === "\\" && quote !== "'") {
      index += 1;
      current += segment[index] ?? "";
      wordStarted = true;
      wordQuoted = true;
      continue;
    }
    if (!quote && char === "$" && segment[index + 1] === "'") {
      quote = "$'";
      wordStarted = true;
      wordQuoted = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char || (quote === "$'" && char === "'")) {
        quote = null;
      } else if (!quote) {
        quote = char;
      } else {
        current += char;
      }
      wordStarted = true;
      wordQuoted = true;
      continue;
    }
    if (quote !== "'" && quote !== "$'" && char === "$") {
      const arithmeticEnd = findShellArithmeticExpansionEnd(segment, index);
      const legacyArithmeticEnd = findShellLegacyArithmeticExpansionEnd(segment, index);
      const parameterEnd = segment[index + 1] === "{"
        ? findShellParameterExpansionEnd(segment, index)
        : null;
      const expansionEnd = arithmeticEnd ?? legacyArithmeticEnd ?? parameterEnd;
      if (expansionEnd !== null) {
        current += parameterEnd === null
          ? "0"
          : segment[index + 2] === "#"
            ? "0"
            : "$CONDUCTOR_DYNAMIC_PARAMETER";
        wordStarted = true;
        index = expansionEnd;
        continue;
      }
    }
    if (!quote && (char === ";" || char === "&")) {
      pushCurrent();
      const next = segment[index + 1] ?? "";
      if (char === ";" && next === ";" && segment[index + 2] === "&") {
        words.push(";;&");
        index += 2;
      } else if (char === ";" && next === ";") {
        words.push(";;");
        index += 1;
      } else if (char === ";" && next === "&") {
        words.push(";&");
        index += 1;
      } else if (char === "&" && next === "&") {
        words.push("&&");
        index += 1;
      } else {
        words.push(char);
      }
      continue;
    }
    if (!quote && /\s/.test(char)) {
      pushCurrent();
      continue;
    }
    if (!quote && (char === "(" || char === ")" || char === "{" || char === "}")) {
      pushCurrent();
      words.push(char);
      continue;
    }
    if (!quote && char === "|") {
      pushCurrent();
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
      pushCurrent();
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
    wordStarted = true;
  }
  pushCurrent();
  return words;
}

function isOmxCliEntryPath(token: string, runtimeWrapper: string | null): boolean {
  const trimmed = token.trim();
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

function omxStateTransportHasUnsafeRuntimeWrapper(command: string): boolean {
  let current = normalizeShellLineContinuations(command).trim();
  const unsafeEnvironmentNames = new Set(["NODE_OPTIONS", ...CONDUCTOR_NODE_OUTPUT_ENVIRONMENT_NAMES]);
  if ([...unsafeEnvironmentNames].some((name) => safeString(process.env[name]).trim() !== "")) return true;
  const rawWords = tokenizeConductorShellWords(current);
  if (rawWords.some((word) => isEnvironmentAssignmentWord(word) && unsafeEnvironmentNames.has(shellAssignmentName(word)))) return true;
  for (let passes = 0; passes < 8; passes += 1) {
    const words = tokenizeConductorShellWords(current);
    const runtimeIndex = words.findIndex((word) => {
      const commandName = commandNameFromShellWord(word);
      return isNodeInterpreterCommandWord(commandName) || commandName === "bun" || commandName === "tsx";
    });
    if (runtimeIndex >= 0) {
      const commandName = commandNameFromShellWord(words[runtimeIndex] ?? "");
      if (nodeCommandHasPreloadExecution(words, runtimeIndex)) return true;
      return !isOmxCliEntryPath(words[runtimeIndex + 1] ?? "", commandName);
    }
    const next = unwrapOmxStateTransportCommandOnce(current);
    if (!next || next === current) return false;
    current = next.trim();
  }
  return true;
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

const CONDUCTOR_QUOTED_RESERVED_WORD_PREFIX = "\0quoted-reserved:";

function shellWordLiteral(word: string): string {
  return word.startsWith(CONDUCTOR_QUOTED_RESERVED_WORD_PREFIX)
    ? word.slice(CONDUCTOR_QUOTED_RESERVED_WORD_PREFIX.length)
    : word;
}

function conductorWordHasQuotedReservedProvenance(word: string): boolean {
  return word.startsWith(CONDUCTOR_QUOTED_RESERVED_WORD_PREFIX);
}


function shellWordBaseName(word: string): string {
  const literal = shellWordLiteral(word);
  return literal.replace(/\\/g, "/").split("/").pop() ?? literal;
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
    if (option === "-i" || option === "--ignore-environment") continue;
    if (option.startsWith("-")) return null;
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

function resolveConductorTimeLongOption(word: string): { option: string; inlineValue: string | undefined } | null {
  if (!word.startsWith("--")) return null;
  const separator = word.indexOf("=");
  const candidate = separator < 0 ? word : word.slice(0, separator);
  const matches = ["--append", "--format", "--output", "--portability", "--quiet", "--verbose", "--help", "--version"]
    .filter((option) => option.startsWith(candidate));
  if (matches.length !== 1) return null;
  return { option: matches[0] ?? "", inlineValue: separator < 0 ? undefined : word.slice(separator + 1) };
}

interface ConductorTimeInvocation {
  dispatchIndex: number;
  outputTarget?: string;
}

function parseConductorTimeInvocation(words: string[], startIndex: number): ConductorTimeInvocation | null {
  const shortOptionsWithoutValues = new Set(["a", "p", "q", "v", "h", "V"]);
  let outputTarget: string | undefined;
  for (let index = startIndex; index < words.length; index += 1) {
    const option = shellWordLiteral(words[index] ?? "");
    if (!option) return null;
    if (isShellAssignmentWord(option)) continue;
    if (option === "--") {
      const dispatchIndex = skipShellCommandPositionPrefixWords(words, index + 1);
      return dispatchIndex < words.length ? { dispatchIndex, outputTarget } : null;
    }
    if (option.startsWith("--")) {
      const timeOption = resolveConductorTimeLongOption(option);
      if (timeOption === null) return null;
      if (timeOption.option === "--output" || timeOption.option === "--format") {
        const value = timeOption.inlineValue ?? shellWordLiteral(words[index + 1] ?? "");
        if (!value || isShellCommandTerminatorOrGroupClose(value) || shellWordMayProduceWgetOptions(value)) return null;
        if (timeOption.option === "--output") outputTarget = value;
        if (timeOption.inlineValue === undefined) index += 1;
      } else if (timeOption.inlineValue !== undefined) {
        return null;
      }
      continue;
    }
    if (/^-[^-]+$/.test(option)) {
      const shortOptions = option.slice(1);
      for (let offset = 0; offset < shortOptions.length; offset += 1) {
        const shortOption = shortOptions[offset] ?? "";
        if (shortOption === "o" || shortOption === "f") {
          const attached = shortOptions.slice(offset + 1);
          const value = attached || shellWordLiteral(words[index + 1] ?? "");
          if (!value || isShellCommandTerminatorOrGroupClose(value) || shellWordMayProduceWgetOptions(value)) return null;
          if (shortOption === "o") outputTarget = value;
          if (!attached) index += 1;
          break;
        }
        if (!shortOptionsWithoutValues.has(shortOption)) return null;
      }
      continue;
    }
    if (option.startsWith("-")) return null;
    return { dispatchIndex: index, outputTarget };
  }
  return null;
}

function findTimeDispatchOperandIndex(words: string[], startIndex: number): number | null {
  return parseConductorTimeInvocation(words, startIndex)?.dispatchIndex ?? null;
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

function findXargsDispatchOperandIndex(words: string[], startIndex: number): number | null {
  for (let index = startIndex; index < words.length; index += 1) {
    const option = words[index] ?? "";
    if (!option || option === "--") continue;
    if (isShellAssignmentWord(option)) continue;
    if (option.startsWith("-")) {
      const optionValueWordCount = conductorXargsOptionValueWordCount(words, index);
      if (optionValueWordCount === null) return null;
      index += optionValueWordCount;
      continue;
    }
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

function collectShellCasePhases(words: string[]): Array<"pattern" | "body" | null> {
  const phases: Array<"pattern" | "body" | null> = Array.from({ length: words.length }, () => null);
  const stack: Array<"subject" | "pattern" | "body"> = [];
  let commandStart = true;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    const phase = stack.at(-1);
    phases[index] = phase === "pattern" || phase === "body" ? phase : null;
    if (phase === "subject") {
      if (word === "in") stack[stack.length - 1] = "pattern";
      continue;
    }
    if (phase === "pattern") {
      if (word === ")") {
        stack[stack.length - 1] = "body";
        commandStart = true;
      } else if (word === "esac" && words[index + 1] !== ")") {
        stack.pop();
        commandStart = false;
      }
      continue;
    }
    if (phase === "body" && (word === ";;" || word === ";&" || word === ";;&")) {
      stack[stack.length - 1] = "pattern";
      commandStart = true;
      continue;
    }
    if (phase === "body" && word === "esac" && commandStart) {
      stack.pop();
      commandStart = false;
      continue;
    }
    if (word === "case" && commandStart) {
      stack.push("subject");
      commandStart = false;
      continue;
    }
    if (word === ";" || word === "&&" || word === "||" || word === "&" || word === "|" || word === "|&") {
      commandStart = true;
      continue;
    }
    if (["then", "else", "elif", "do"].includes(word)) {
      commandStart = true;
      continue;
    }
    commandStart = false;
  }
  return phases;
}

function isCasePatternPipe(words: string[], pipeIndex: number): boolean {
  return words[pipeIndex] === "|" && collectShellCasePhases(words)[pipeIndex] === "pattern";
}

function isShellCommandSeparatorAt(words: string[], index: number): boolean {
  const word = words[index] ?? "";
  return isShellCommandSeparator(word) && !(word === "|" && isCasePatternPipe(words, index));
}

function collectShellCommandStartIndexes(words: string[]): number[] {
  const starts = new Set<number>([0]);
  const phases = collectShellCasePhases(words);
  const commandIntroducers = new Set(["if", "then", "else", "elif", "while", "until", "do", "!"]);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    const phase = phases[index];
    if (phase === "pattern") {
      if (word === ")") starts.add(index + 1);
      continue;
    }
    if (phase === "body" && (word === ";;" || word === ";&" || word === ";;&")) continue;
    if (isShellCommandSeparatorAt(words, index) || word === "(" || word === "{" || commandIntroducers.has(word)) starts.add(index + 1);
  }
  return [...starts].filter((index) => index < words.length && phases[index] !== "pattern").sort((left, right) => left - right);
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
        : commandWordBase === "command" || commandWordBase === "builtin"
          ? findCommandDispatchOperandIndex(words, commandWordIndex + 1)
          : commandWordBase === "exec"
            ? findExecDispatchOperandIndex(words, commandWordIndex + 1)
            : commandWordBase === "time"
              ? findTimeDispatchOperandIndex(words, commandWordIndex + 1)
              : commandWordBase === "timeout"
                ? findTimeoutDispatchOperandIndex(words, commandWordIndex + 1)
                : commandWordBase === "nohup" || commandWordBase === "setsid"
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
    if (quote !== "'" && char === "$" && command[index + 1] === "(" && command[index + 2] !== "(") {
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

function extractNestedCommandSubstitutionStringsForStateScan(command: string): string[] {
  const nested: string[] = [];
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
      if (substitutionBody) nested.push(substitutionBody);
      index = substitutionEnd >= 0 ? substitutionEnd : command.length;
      continue;
    }
    if (quote !== "'" && char === "`") {
      const substitutionEnd = findBacktickCommandSubstitutionEnd(command, index + 1);
      const substitutionBodyEnd = substitutionEnd >= 0 ? substitutionEnd : command.length;
      const substitutionBody = command.slice(index + 1, substitutionBodyEnd);
      if (substitutionBody) nested.push(substitutionBody);
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
  return nested;
}

function extractNestedProcessSubstitutionStringsForStateScan(command: string): string[] {
  const nested: string[] = [];
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (quote !== "'" && (char === "<" || char === ">") && command[index + 1] === "(") {
      const substitutionEnd = findProcessSubstitutionEnd(command, index + 2);
      const substitutionBodyEnd = substitutionEnd >= 0 ? substitutionEnd : command.length;
      const substitutionBody = command.slice(index + 2, substitutionBodyEnd);
      if (substitutionBody) nested.push(substitutionBody);
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
  return nested;
}

function isPackageManagerCommandWord(word: string): boolean {
  const base = shellWordBaseName(word);
  return base === "npm" || base === "pnpm" || base === "yarn" || base === "npx" || base === "pnpx";
}

function isStructuredUltragoalSteeringShellCommand(command: string): boolean {
  if (
    isDynamicNestedCommandString(command)
    || tokenizeConductorShellWords(command).some((word) => ["for", "while", "until", "select", "read"].includes(shellWordLiteral(word)))
  ) return false;
  const segments = splitShellCommandSegments(stripHeredocBodiesForCommandScan(command));
  let sawStructuredSteer = false;

  for (const segment of segments) {
    const words = tokenizeShellWords(segment);
    let commandStart = true;

    for (let index = 0; index < words.length; index += 1) {
      const word = words[index] ?? "";
      if (!word) continue;
      if (isShellCommandSeparator(word)) {
        commandStart = true;
        continue;
      }
      if (isShellGroupingSyntaxWord(word)) continue;
      if (commandStart && isEnvironmentAssignmentWord(word)) continue;
      if (commandStart && CONDUCTOR_BASH_COMPOUND_SYNTAX_WORDS.has(word)) continue;
      if (commandStart && word.startsWith("-")) continue;
      if (!commandStart) continue;

      const commandName = commandNameFromShellWord(word);
      if (commandName === "read" || commandName === "true" || commandName === ":") {
        commandStart = false;
        continue;
      }
      if ((commandName === "omx" || commandName === "gjc") && words[index + 1] === "ultragoal" && words[index + 2] === "steer") {
        sawStructuredSteer = true;
        commandStart = false;
        continue;
      }
      return false;
    }
  }

  return sawStructuredSteer;
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
          if (isDynamicNestedCommandString(nestedCommand) && !isStructuredUltragoalSteeringShellCommand(nestedCommand)) return true;
        }
      }
      if (word === "eval") {
        const nestedCommand = words.slice(index + 1).join(" ");
        if (isDynamicNestedCommandString(nestedCommand) && !isStructuredUltragoalSteeringShellCommand(nestedCommand)) return true;
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
    if (option.startsWith("-") || /^\+O.+/.test(option)) continue;
    return null;
  }
  return null;
}

function isShellCommandStringOption(option: string): boolean {
  return /^-[^-]*c[^-]*$/.test(option);
}

function isShellOptionWithSeparateValue(option: string): boolean {
  return option === "--rcfile" || option === "--init-file" || option === "-o" || option === "-O" || option === "+O";
}
function nestedBashLastpipeEnabled(words: string[], shellIndex: number, commandStringIndex: number): boolean {
  let enabled = false;
  for (let index = shellIndex + 1; index < commandStringIndex; index += 1) {
    const option = shellWordLiteral(words[index] ?? "");
    if (option === "-O" || option === "+O") {
      const name = shellWordLiteral(words[index + 1] ?? "");
      if (name === "lastpipe") enabled = option === "-O";
      index += 1;
    } else if (option === "-Olastpipe") {
      enabled = true;
    } else if (option === "+Olastpipe") {
      enabled = false;
    }
  }
  return enabled;
}


function isDynamicNestedCommandString(command: string): boolean {
  return hasUnresolvedShellArithmeticExpansion(command)
    || /(?:^|[^\\])\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]+\}|\()/.test(command)
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
    if (char === "$") {
      const expansionEnd = findShellArithmeticExpansionEnd(command, index)
        ?? findShellLegacyArithmeticExpansionEnd(command, index)
        ?? findShellParameterExpansionEnd(command, index);
      if (expansionEnd !== null) {
        current += command.slice(index, expansionEnd + 1);
        index = expansionEnd;
        continue;
      }
    }
    if (char === ";" || char === "\n" || char === "\r") {
      if (current.trim()) segments.push(current);
      current = "";
      continue;
    }
    if (char === "&" && command[index - 1] !== "|") {
      if (current.trim()) segments.push(current);
      current = "";
      if (command[index + 1] === "&") index += 1;
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

function parseShellAssignmentWord(word: string): { name: string; append: boolean; value: string } | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)([\s\S]*)$/.exec(shellWordLiteral(word));
  return match ? { name: match[1] ?? "", append: match[2] === "+=", value: match[3] ?? "" } : null;
}

function isShellAssignmentWord(word: string): boolean {
  return parseShellAssignmentWord(word) !== null;
}

function shellAssignmentName(word: string): string {
  return parseShellAssignmentWord(word)?.name ?? "";
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

interface ShellHeredocOpener {
  delimiter: string;
  quoted: boolean;
  stripLeadingTabs: boolean;
}

function decodeShellHeredocAnsiEscape(line: string, startIndex: number): { value: string; endIndex: number } | null {
  const decoded = decodeAnsiCShellEscape(line, startIndex);
  if (decoded) return decoded;
  const escape = line[startIndex + 1] ?? "";
  const value = escape === "a" ? "\x07"
    : escape === "b" ? "\b"
      : escape === "e" || escape === "E" ? "\x1b"
        : escape === "f" ? "\f"
          : escape === "n" ? "\n"
            : escape === "r" ? "\r"
              : escape === "t" ? "\t"
                : escape === "v" ? "\v"
                  : escape === "\\" || escape === "'" || escape === "\"" || escape === "?" ? escape
                    : null;
  return value === null ? null : { value, endIndex: startIndex + 1 };
}

function parseShellHeredocDelimiter(line: string, startIndex: number): Omit<ShellHeredocOpener, "stripLeadingTabs"> | null {
  let index = startIndex;
  while (/\s/.test(line[index] ?? "")) index += 1;

  let delimiter = "";
  let quoted = false;
  let quote: "'" | "\"" | "$'" | "$\"" | null = null;
  for (; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (char === "\\" && quote === "$'") {
      const decoded = decodeShellHeredocAnsiEscape(line, index);
      if (!decoded) return null;
      delimiter += decoded.value;
      index = decoded.endIndex;
      continue;
    }
    if (char === "\\" && (quote === "\"" || quote === "$\"")) {
      const next = line[index + 1] ?? "";
      if (next === "$" || next === "`" || next === "\"" || next === "\\") {
        delimiter += next;
        index += 1;
      } else {
        delimiter += char;
      }
      continue;
    }
    if (char === "\\" && quote !== "'") {
      quoted = true;
      index += 1;
      delimiter += line[index] ?? "";
      continue;
    }
    if (!quote && char === "$" && (line[index + 1] === "'" || line[index + 1] === "\"")) {
      quote = line[index + 1] === "'" ? "$'" : "$\"";
      quoted = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char || (quote === "$'" && char === "'") || (quote === "$\"" && char === "\"")) {
        quote = null;
      } else if (!quote) {
        quote = char;
        quoted = true;
      } else {
        delimiter += char;
      }
      continue;
    }
    if (!quote && (/\s/.test(char) || char === "|" || char === ";" || char === "&" || char === "<" || char === ">" || char === "(" || char === ")")) break;
    delimiter += char;
  }

  return delimiter && !quote && !delimiter.includes("\0") ? { delimiter, quoted } : null;
}

function findShellArithmeticExpansionEnd(line: string, startIndex: number): number | null {
  if (line.slice(startIndex, startIndex + 3) !== "$((") return null;
  if (line[startIndex + 2] !== "(") return null;
  let depth = 1;
  let quote: "'" | "\"" | null = null;
  for (let index = startIndex + 3; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
      continue;
    }
    if (quote) continue;
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0 && line[index + 1] === ")") return index + 1;
    }
  }
  return null;
}

function findShellLegacyArithmeticExpansionEnd(line: string, startIndex: number): number | null {
  if (line.slice(startIndex, startIndex + 2) !== "$[") return null;
  let quote: "'" | "\"" | null = null;
  for (let index = startIndex + 2; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
      continue;
    }
    if (!quote && char === "]") return index;
  }
  return null;
}

function findConductorBareArithmeticCommandEnd(line: string, startIndex: number): number | null {
  if (line.slice(startIndex, startIndex + 2) !== "((") return null;
  let depth = 1;
  let quote: "'" | "\"" | null = null;
  for (let index = startIndex + 2; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
      continue;
    }
    if (quote) continue;
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0 && line[index + 1] === ")") return index + 1;
    }
  }
  return null;
}

function hasUnsafeConductorArithmeticCommand(command: string): boolean {
  let quote: "'" | "\"" | null = null;
  let lineComment = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
      continue;
    }
    if (quote) continue;
    if (char === "#" && (index === 0 || /\s/.test(command[index - 1] ?? ""))) {
      lineComment = true;
      continue;
    }
    if (command.slice(index, index + 3) === "let" && (index === 0 || /[\s;&|()]/.test(command[index - 1] ?? "")) && /(?:\s|$)/.test(command[index + 3] ?? "")) return true;
    if (char !== "(" || command[index + 1] !== "(" || command[index - 1] === "$") continue;
    const end = findConductorBareArithmeticCommandEnd(command, index);
    if (end === null) return true;
    const expression = command.slice(index + 2, end - 1);
    if (!/^[0-9\s()+\-*/%~!<>&|^]+$/.test(expression) || /(?:\+\+|--|=)/.test(expression)) return true;
    index = end;
  }
  return false;
}

function hasUnresolvedShellArithmeticExpansion(command: string): boolean {
  if (hasUnsafeConductorArithmeticCommand(command)) return true;
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
      continue;
    }
    if (quote === "'") continue;
    if (char !== "$") continue;
    const arithmeticEnd = findShellArithmeticExpansionEnd(command, index);
    const legacyArithmeticEnd = findShellLegacyArithmeticExpansionEnd(command, index);
    if (!command.startsWith("$((", index) && !command.startsWith("$[", index)) continue;
    const expansionEnd = arithmeticEnd ?? legacyArithmeticEnd;
    if (expansionEnd === null) return true;
    const raw = command.slice(index, expansionEnd + 1);
    const expression = command.startsWith("$((", index)
      ? raw.slice(3, -2)
      : raw.slice(2, -1);
    if (
      !/^[0-9\s()+\-*/%~!<>&|^]+$/.test(expression)
      || /(?:\+\+|--|=)/.test(expression)
    ) return true;
    index = expansionEnd;
  }
  return false;
}


function hasConductorPromptParameterTransform(command: string): boolean {
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
      continue;
    }
    if (quote === "'" || char !== "$" || command[index + 1] !== "{") continue;
    const end = findShellParameterExpansionEnd(command, index);
    if (end === null) return true;
    if (/@P\s*$/.test(command.slice(index + 2, end))) return true;
    index = end;
  }
  return false;
}

function findShellParameterExpansionEnd(line: string, startIndex: number): number | null {
  if (line.slice(startIndex, startIndex + 2) !== "${") return null;
  let depth = 1;
  let quote: "'" | "\"" | null = null;
  for (let index = startIndex + 2; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
      continue;
    }
    if (quote) continue;
    if (char === "$" && line[index + 1] === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function staticExpansionAssignmentMarker(raw: string, kind: "ARITH" | "PARAMETER"): string | null {
  const expression = kind === "ARITH"
    ? raw.replace(/^\$\(\(|\)\)$/g, "").replace(/^\$\[|\]$/g, "")
    : raw.slice(2, -1);
  const markers: string[] = [];
  const assignmentPattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(\+=|=|\+\+|--|[+*/%&|^~-]=)\s*([A-Za-z0-9_./-]*)/g;
  for (const match of expression.matchAll(assignmentPattern)) {
    const name = match[1] ?? "";
    const operator = match[2] ?? "";
    const rawValue = match[3] ?? "";
    const mode = operator === "+=" ? "APPEND" : operator === "=" ? "SET" : "DYNAMIC";
    const value = mode === "DYNAMIC" || /[$`]/.test(rawValue) || !rawValue ? "DYNAMIC" : rawValue;
    markers.push(`$CONDUCTOR_${kind}_ASSIGN_${name}_${mode}_${value}`);
  }
  if (kind === "ARITH" && /(?:=|\+\+|--)/.test(expression)) {
    for (const name of CONDUCTOR_SHELL_BINDING_NAMES) {
      if (new RegExp(`\\b${name}\\b`).test(expression) && !markers.some((marker) => marker.includes(`_ASSIGN_${name}_`))) {
        markers.push(`$CONDUCTOR_ARITH_ASSIGN_${name}_DYNAMIC_DYNAMIC`);
      }
    }
  }
  if (kind === "PARAMETER" && markers.length === 0) {
    const parameter = /^([A-Za-z_][A-Za-z0-9_]*):?=([\s\S]*)$/.exec(expression);
    if (parameter) {
      const name = parameter[1] ?? "";
      const value = parameter[2] ?? "";
      markers.push(`$CONDUCTOR_PARAMETER_ASSIGN_${name}_SET_${/[$`]/.test(value) || !value ? "DYNAMIC" : value}`);
    }
  }
  return markers.length > 0 ? markers.join("") : null;
}

function maskShellNonCommandExpansionsForConductorScan(command: string): string {
  let result = "";
  let quote: "'" | "\"" | "$'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && quote !== "'") {
      result += char;
      index += 1;
      result += command[index] ?? "";
      continue;
    }
    if (!quote && char === "$" && command[index + 1] === "'") {
      quote = "$'";
      result += "$'";
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char || (quote === "$'" && char === "'")) quote = null;
      else if (!quote) quote = char;
      result += char;
      continue;
    }
    if (quote === "'" || quote === "$'") {
      result += char;
      continue;
    }
    const arithmeticEnd = char === "$" ? findShellArithmeticExpansionEnd(command, index) : null;
    const legacyArithmeticEnd = char === "$" ? findShellLegacyArithmeticExpansionEnd(command, index) : null;
    const parameterEnd = char === "$" && command[index + 1] === "{"
      ? findShellParameterExpansionEnd(command, index)
      : null;
    const end = arithmeticEnd ?? legacyArithmeticEnd ?? parameterEnd;
    if (end !== null) {
      const raw = command.slice(index, end + 1);
      const marker = arithmeticEnd !== null
        ? staticExpansionAssignmentMarker(raw, "ARITH")
        : parameterEnd !== null
          ? staticExpansionAssignmentMarker(raw, "PARAMETER")
          : null;
      result += marker ?? (parameterEnd === null
        ? "0"
        : command[index + 2] === "#"
          ? "0"
          : "$CONDUCTOR_DYNAMIC_PARAMETER");
      index = end;
      continue;
    }
    result += char;
  }
  return result;
}

function isShellCommentStart(line: string, index: number): boolean {
  if (line[index] !== "#") return false;
  if (index === 0) return true;
  return /[\s;|&()<>]/.test(line[index - 1] ?? "");
}

function extractShellHeredocOpeners(line: string): ShellHeredocOpener[] {
  const openers: ShellHeredocOpener[] = [];
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < line.length - 1; index += 1) {
    const char = line[index] ?? "";
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
      continue;
    }
    if (quote) continue;
    if (isShellCommentStart(line, index)) break;
    const expansionEnd = char === "$"
      ? findShellArithmeticExpansionEnd(line, index)
        ?? findShellLegacyArithmeticExpansionEnd(line, index)
        ?? findShellParameterExpansionEnd(line, index)
      : null;
    if (expansionEnd !== null) {
      index = expansionEnd;
      continue;
    }
    if (char !== "<" || line[index + 1] !== "<" || line[index + 2] === "<") continue;
    const stripLeadingTabs = line[index + 2] === "-";
    const delimiterStart = stripLeadingTabs ? index + 3 : index + 2;
    const opener = parseShellHeredocDelimiter(line, delimiterStart);
    if (opener) openers.push({ ...opener, stripLeadingTabs });
    index = delimiterStart;
  }
  return openers;
}

function isShellHeredocTerminator(line: string, opener: ShellHeredocOpener): boolean {
  const rawCandidate = opener.stripLeadingTabs ? line.replace(/^\t+/, "") : line;
  if (rawCandidate === opener.delimiter) return true;
  if (!rawCandidate.endsWith("\r")) return false;
  return rawCandidate.slice(0, -1) === opener.delimiter;
}

function stripHeredocBodiesForCommandScan(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    kept.push(line);
    const openers = extractShellHeredocOpeners(line);
    for (const opener of openers) {
      index += 1;
      while (index < lines.length && !isShellHeredocTerminator(lines[index] ?? "", opener)) {
        kept.push("");
        index += 1;
      }
      if (index < lines.length) kept.push("");
    }
  }
  return kept.join("\n");
}
function extractShellHeredocBodies(command: string): string[] {
  const bodies: string[] = [];
  const lines = command.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const opener of extractShellHeredocOpeners(line)) {
      index += 1;
      const bodyLines: string[] = [];
      while (index < lines.length && !isShellHeredocTerminator(lines[index] ?? "", opener)) {
        bodyLines.push(lines[index] ?? "");
        index += 1;
      }
      bodies.push(bodyLines.join("\n"));
    }
  }
  return bodies;
}


function hasUnsafeUnquotedHeredocExpansion(command: string): boolean {
  const lines = normalizeShellLineContinuations(command).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const opener of extractShellHeredocOpeners(line)) {
      index += 1;
      const bodyLines: string[] = [];
      while (index < lines.length && !isShellHeredocTerminator(lines[index] ?? "", opener)) {
        bodyLines.push(lines[index] ?? "");
        index += 1;
      }
      if (!opener.quoted && isDynamicNestedCommandString(bodyLines.join("\n"))) return true;
    }
  }
  return false;
}

function hasUnquotedShellSubstitution(command: string): boolean {
  command = normalizeShellLineContinuations(command);
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
    if (quote === "'") continue;
    if (char === "$" && command[index + 1] === "(") return true;
    if (char === "`") return true;
    if ((char === "<" || char === ">") && command[index + 1] === "(") return true;
  }
  return false;
}

function normalizeStateWriteClassificationPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const targetMode = safeString(payload.mode).trim();
  const targetSessionId = safeString(payload.session_id).trim();
  const targetWorkingDirectory = safeString(payload.workingDirectory).trim();
  const {
    mode: _mode,
    workingDirectory: _workingDirectory,
    state,
    ...fields
  } = payload;
  const normalized: Record<string, unknown> = {
    ...fields,
    ...safeObject(state),
    ...(targetMode ? { mode: targetMode } : {}),
    ...(targetSessionId ? { session_id: targetSessionId } : {}),
    ...(targetWorkingDirectory ? { workingDirectory: targetWorkingDirectory } : {}),
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

function hasCompleteDeepInterviewGateMetadata(state: Record<string, unknown>): boolean {
  const nestedState = safeObject(state.state);
  const gate = safeObject(state.deep_interview_gate) ?? safeObject(nestedState?.deep_interview_gate);
  if (!gate) return false;
  const status = safeString(gate.status).trim().toLowerCase().replace(/_/g, "-");
  if (status === "complete" || gate.complete === true) {
    return ["rationale", "completion_rationale", "handoff_summary", "summary", "reason"]
      .some((key) => safeString(gate[key]).trim().length > 0);
  }
  if (status !== "skipped") return false;
  const reason = safeString(gate.reason).trim() || safeString(gate.skip_reason).trim() || safeString(gate.rationale).trim();
  const timestamp = safeString(gate.skipped_at).trim() || safeString(gate.timestamp).trim() || safeString(gate.updated_at).trim();
  const source = safeString(gate.source).trim();
  return (gate.skip_authorized_by_user === true || gate.authorized_by_user === true)
    && reason.length > 0
    && timestamp.length > 0
    && source.length > 0;
}

function isDeepInterviewRalplanHandoffStatePayload(payload: Record<string, unknown>): boolean {
  const mode = safeString(payload.mode).trim().toLowerCase();
  if (mode !== "autopilot") return false;
  const phase = normalizeAutopilotPhase(safeString(payload.current_phase ?? payload.currentPhase).trim().toLowerCase());
  if (phase !== "ralplan" || payload.active === false) return false;
  return hasCompleteDeepInterviewGateMetadata(payload);
}

function hasOnlyAllowedDeepInterviewRalplanHandoffMutations(cwd: string, command: string, authoritativeSessionId: string): boolean {
  for (const mutation of extractConductorBashMutations(command)) {
    if (mutation.mainRootStructuredStateWrite) continue;
    if (mutation.targets.length === 0) return false;
    if (mutation.targets.some((target) => !isAllowedDeepInterviewArtifactPath(cwd, target, authoritativeSessionId))) return false;
  }
  for (const write of extractConductorInterpreterWrites(command)) {
    if (write.unresolved || write.targets.length === 0) return false;
    if (write.targets.some((target) => !isAllowedDeepInterviewArtifactPath(cwd, target, authoritativeSessionId))) return false;
  }
  return true;
}

function isDurableDeepInterviewHandoffEvidencePath(cwd: string, rawPath: string): boolean {
  const relativePath = normalizePlanningArtifactRelativePath(cwd, rawPath);
  if (!relativePath) return false;
  return relativePath === ".omx/context"
    || relativePath.startsWith(".omx/context/")
    || relativePath === ".omx/interviews"
    || relativePath.startsWith(".omx/interviews/")
    || relativePath === ".omx/specs"
    || relativePath.startsWith(".omx/specs/");
}

function hasExistingDurableDeepInterviewHandoffEvidence(cwd: string): boolean {
  const roots = [".omx/context", ".omx/interviews", ".omx/specs"] as const;
  const maxEntries = 2_000;
  let visited = 0;

  for (const root of roots) {
    const stack = [resolve(cwd, root)];
    while (stack.length > 0 && visited < maxEntries) {
      const current = stack.pop();
      if (!current) continue;
      visited += 1;
      try {
        const stat = statSync(current);
        if (stat.isFile()) return true;
        if (!stat.isDirectory()) continue;
        for (const entry of readdirSync(current)) {
          stack.push(join(current, entry));
        }
      } catch {
        // Missing or unreadable roots are not completion evidence.
      }
    }
  }

  return false;
}

function isStandaloneParsedOmxStateWriteTransport(cwd: string, command: string, authoritativeSessionId: string): boolean {
  if (omxStateTransportHasUnsafeRuntimeWrapper(command)) return false;
  const canonicalCommand = canonicalizeOmxStateTransportCommand(command);
  if (hasUnsafeUnquotedHeredocExpansion(canonicalCommand)) return false;
  if (hasUnquotedShellSubstitution(canonicalCommand)) return false;
  if (hasDynamicNestedShellExecution(canonicalCommand)) return false;
  if (commandHasUntargetedPlanningForbiddenIntent(canonicalCommand)) return false;
  const stateWriteOperations = collectOmxStateCommandOperations(canonicalCommand, "write");
  if (stateWriteOperations.length !== 1 || stateWriteOperations[0]?.nested) return false;
  const stateWriteOperation = stateWriteOperations[0];
  if (!stateWriteOperation) return false;
  const payload = readStateWriteInputPayload(cwd, canonicalCommand, command);
  if (!payload
    || safeString(payload.session_id).trim() !== authoritativeSessionId
    || !suppliedSessionAliasesMatch(payload, authoritativeSessionId)
    || safeString(payload.workingDirectory).trim() === ""
    || resolve(safeString(payload.workingDirectory)) !== resolve(cwd)) return false;
  const usesInputFile = readStateWriteFlagValue(stateWriteOperation.args, "--input-file") !== undefined;
  if (usesInputFile && splitStateScanSegments(canonicalCommand).length !== 1) return false;
  if (extractDeepInterviewCommandRedirectTargets(command).length > 0) return false;
  if (extractConductorEditorWriteTargets(command).length > 0) return false;
  if (extractConductorInterpreterWrites(command).length > 0) return false;
  if (classifyConductorExecutableRuntime(canonicalCommand, 0, cwd) !== null) return false;
  const mutations = extractConductorBashMutations(command, cwd);
  return mutations.length === 1 && mutations[0]?.mainRootStructuredStateWrite === true;
}

function isAllowedDeepInterviewRalplanHandoffCommand(cwd: string, command: string, authoritativeSessionId: string): boolean {
  if (omxStateTransportHasUnsafeRuntimeWrapper(command)) return false;
  const canonicalCommand = canonicalizeOmxStateTransportCommand(command);
  if (hasUnsafeUnquotedHeredocExpansion(canonicalCommand)) return false;
  if (hasUnquotedShellSubstitution(canonicalCommand)) return false;
  if (findUnquotedOmxStateCommandIndexes(canonicalCommand, "clear").length > 0) return false;
  if (hasDynamicNestedShellExecution(canonicalCommand)) return false;
  if (commandHasUntargetedPlanningForbiddenIntent(canonicalCommand)) return false;
  if (sourcesFileWrittenEarlierInSameCommand(cwd, canonicalCommand)) return false;
  const stateWriteOperations = collectOmxStateCommandOperations(canonicalCommand, "write");
  if (stateWriteOperations.length !== 1) return false;
  const stateWriteOperation = stateWriteOperations[0];
  if (!stateWriteOperation || stateWriteOperation.nested) return false;
  const payload = readStateWriteInputPayload(cwd, canonicalCommand, command);
  if (!payload || !isDeepInterviewRalplanHandoffStatePayload(payload)) return false;
  if (
    safeString(payload.session_id).trim() !== authoritativeSessionId
    || !suppliedSessionAliasesMatch(payload, authoritativeSessionId)
    || safeString(payload.workingDirectory).trim() === ""
    || resolve(safeString(payload.workingDirectory)) !== resolve(cwd)
  ) return false;
  const targets = extractDeepInterviewCommandWriteTargets(command);
  if (targets.length === 0) {
    return !hasPriorExecutableCommand(stateWriteOperation.prefix)
      && hasExistingDurableDeepInterviewHandoffEvidence(cwd);
  }
  if (!targets.some((target) => isDurableDeepInterviewHandoffEvidencePath(cwd, target))) return false;
  if (!hasOnlyAllowedDeepInterviewRalplanHandoffMutations(cwd, command, authoritativeSessionId)) return false;
  return targets.every((target) => isAllowedDeepInterviewArtifactPath(cwd, target, authoritativeSessionId));
}


function hasDeepInterviewRalplanHandoffStateMutation(cwd: string, command: string): boolean {
  const canonicalCommand = canonicalizeOmxStateTransportCommand(command);
  const stateWriteOperations = collectOmxStateCommandOperations(canonicalCommand, "write");
  if (stateWriteOperations.length === 0) return false;
  const payload = readStateWriteInputPayload(cwd, canonicalCommand, command);
  return payload ? isDeepInterviewRalplanHandoffStatePayload(payload) : false;
}

function isCompleteRalplanTerminalWritePayload(
  payload: Record<string, unknown>,
  activeState: Record<string, unknown>,
  sessionId: string,
  cwd: string,
): boolean {
  if (!sessionId) return false;
  const mode = safeString(payload.mode).trim().toLowerCase();
  if (mode !== "ralplan") return false;
  const phase = safeString(payload.current_phase ?? payload.currentPhase).trim().toLowerCase();
  if (payload.active !== false || phase !== "complete") return false;

  const payloadSessionId = safeString(payload.session_id).trim();
  const activeSessionId = safeString(
    activeState.session_id
      ?? activeState.owner_omx_session_id
      ?? activeState.codex_session_id
      ?? activeState.owner_codex_session_id,
  ).trim();
  if (payloadSessionId !== sessionId) return false;
  if (!suppliedSessionAliasesMatch(payload, sessionId)) return false;
  if (safeString(payload.workingDirectory).trim() === "" || resolve(safeString(payload.workingDirectory)) !== resolve(cwd)) return false;
  if (activeSessionId && payloadSessionId !== activeSessionId) return false;
  return true;
}

function hasUnquotedShellControlOrRedirection(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (!quote && ";&|()<>\n\r".includes(char)) return true;
  }
  return false;
}

function suppliedSessionAliasesMatch(payload: Record<string, unknown>, sessionId: string): boolean {
  return [
    payload.session_id,
    payload.owner_omx_session_id,
    payload.codex_session_id,
    payload.owner_codex_session_id,
  ].filter((value) => value !== undefined)
    .every((value) => safeString(value).trim() === sessionId);
}

function hasOnlyFinishedExplicitOutcomes(payload: Record<string, unknown>): boolean {
  const values = [
    payload.lifecycle_outcome,
    payload.lifecycleOutcome,
    payload.terminal_outcome,
    payload.terminalOutcome,
    payload.run_outcome,
    payload.runOutcome,
  ].filter((value) => value !== undefined);
  return values.every((value) => inferTerminalLifecycleOutcome(
    { lifecycle_outcome: value },
    { includeQuestionEnforcement: false },
  ) === "finished");
}

function isCompleteDeepInterviewTerminalWritePayload(
  payload: Record<string, unknown>,
  activeState: Record<string, unknown>,
  sessionId: string,
  cwd: string,
): boolean {
  if (!sessionId) return false;
  const activeMode = safeString(activeState.mode).trim().toLowerCase();
  if (activeMode && activeMode !== "deep-interview") return false;
  const activeSessionId = safeString(
    activeState.session_id
      ?? activeState.owner_omx_session_id
      ?? activeState.codex_session_id
      ?? activeState.owner_codex_session_id,
  ).trim();
  if (activeSessionId && activeSessionId !== sessionId) return false;

  const mode = safeString(payload.mode).trim().toLowerCase();
  const phase = safeString(payload.current_phase ?? payload.currentPhase).trim().toLowerCase();
  const payloadSessionId = safeString(payload.session_id).trim();
  if (!hasOnlyFinishedExplicitOutcomes(payload)) return false;
  if (safeString(payload.workingDirectory).trim() === "" || resolve(safeString(payload.workingDirectory)) !== resolve(cwd)) return false;
  return mode === "deep-interview"
    && payload.active === false
    && phase === "complete"
    && payloadSessionId === sessionId
    && inferTerminalLifecycleOutcome(payload, { includeQuestionEnforcement: false }) === "finished";
}

function isAllowedDeepInterviewTerminalStateWriteCommand(
  cwd: string,
  command: string,
  activeState: Record<string, unknown>,
  sessionId: string,
): boolean {
  if (omxStateTransportHasUnsafeRuntimeWrapper(command)) return false;
  const rawWords = tokenizeShellWords(normalizeShellLineContinuations(command).trim());
  if (rawWords[0] !== "omx") return false;
  const canonicalCommand = canonicalizeOmxStateTransportCommand(command);
  if (hasUnquotedShellControlOrRedirection(command)) return false;
  if (hasUnsafeUnquotedHeredocExpansion(canonicalCommand)) return false;
  if (hasUnquotedShellSubstitution(canonicalCommand)) return false;
  if (splitStateScanSegments(canonicalCommand).length !== 1) return false;
  if (sourcesFileWrittenEarlierInSameCommand(cwd, canonicalCommand)) return false;
  if (findUnquotedOmxStateCommandIndexes(canonicalCommand, "clear").length > 0) return false;
  if (hasDynamicNestedShellExecution(canonicalCommand)) return false;
  if (extractDeepInterviewCommandWriteTargets(command).length > 0) return false;

  const operations = collectOmxStateCommandOperations(command, "write");
  if (operations.length !== 1) return false;
  const operation = operations[0];
  if (!operation || operation.nested || operation.commandPrefix.trim() || hasPriorExecutableCommand(operation.prefix)) return false;
  const inlineInputCount = operation.args.filter((arg) => arg === "--input" || arg.startsWith("--input=")).length;
  if (inlineInputCount !== 1 || operation.args.some((arg) => arg === "--input-file" || arg.startsWith("--input-file="))) return false;
  const inlineInput = readStateWriteFlagValue(operation.args, "--input");
  let rawPayload: Record<string, unknown> | null = null;
  try {
    rawPayload = inlineInput ? safeObject(JSON.parse(inlineInput)) : null;
  } catch {
    rawPayload = null;
  }
  const nestedState = safeObject(rawPayload?.state);
  const allowedTopLevelKeys = new Set([
    "mode",
    "active",
    "current_phase",
    "currentPhase",
    "session_id",
    "state",
    "workingDirectory",
    "terminal_reason",
    "run_outcome",
    "lifecycle_outcome",
    "terminal_outcome",
  ]);
  if (
    !rawPayload
    || Object.keys(rawPayload).some((key) => !allowedTopLevelKeys.has(key))
    || !suppliedSessionAliasesMatch(rawPayload, sessionId)
    || !hasOnlyFinishedExplicitOutcomes(rawPayload)
    || (nestedState && (
      "mode" in nestedState
      || "session_id" in nestedState
      || "workingDirectory" in nestedState
      || "active" in nestedState
      || "current_phase" in nestedState
      || "currentPhase" in nestedState
      || !suppliedSessionAliasesMatch(nestedState, sessionId)
      || !hasOnlyFinishedExplicitOutcomes(nestedState)
    ))
  ) return false;

  return isCompleteDeepInterviewTerminalWritePayload(rawPayload, activeState, sessionId, cwd);
}

function isAllowedRalplanTerminalStateWriteCommand(
  cwd: string,
  command: string,
  activeState: Record<string, unknown>,
  sessionId: string,
): boolean {
  if (omxStateTransportHasUnsafeRuntimeWrapper(command)) return false;
  const canonicalCommand = canonicalizeOmxStateTransportCommand(command);
  if (hasUnsafeUnquotedHeredocExpansion(canonicalCommand)) return false;
  if (hasUnquotedShellSubstitution(canonicalCommand)) return false;
  if (splitStateScanSegments(canonicalCommand).length !== 1) return false;
  if (sourcesFileWrittenEarlierInSameCommand(cwd, canonicalCommand)) return false;
  if (findUnquotedOmxStateCommandIndexes(canonicalCommand, "clear").length > 0) return false;
  if (hasDynamicNestedShellExecution(canonicalCommand)) return false;

  const operations = collectOmxStateCommandOperations(canonicalCommand, "write");
  if (operations.length !== 1) return false;
  const operation = operations[0];
  if (!operation || operation.nested || hasPriorExecutableCommand(operation.prefix)) return false;

  const payload = readStateWriteInputPayload(cwd, canonicalCommand, command);
  return payload ? isCompleteRalplanTerminalWritePayload(payload, activeState, sessionId, cwd) : false;
}

function commandEndsPlanningPhase(cwd: string, command: string): boolean {
  if (findUnquotedOmxStateCommandIndexes(command, "clear").length > 0) return true;
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

function isAllowedDeepInterviewBashWrite(
  cwd: string,
  command: string,
  activeState?: Record<string, unknown>,
  sessionId = "",
): boolean {
  if (sourcesFileWrittenEarlierInSameCommand(cwd, command)) return false;
  const stateWriteOperations = collectOmxStateCommandOperations(command, "write");
  const hasUnsafeRuntimeStateWrite = (words: string[]): boolean => {
    const stateWordIndex = words.indexOf("state");
    const writeWordIndex = stateWordIndex >= 0 ? words.indexOf("write", stateWordIndex + 1) : -1;
    if (writeWordIndex <= stateWordIndex) return false;
    const hasRuntimeBeforeState = words.slice(0, stateWordIndex).some((word) => {
      const base = shellWordBaseName(word);
      return isNodeInterpreterCommandWord(base) || base === "bun" || base === "tsx";
    });
    if (!hasRuntimeBeforeState) return false;

    const inlineInput = readStateWriteFlagValue(words, "--input");
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed = inlineInput ? safeObject(JSON.parse(inlineInput)) : null;
      const modeOverride = readStateWriteFlagValue(words, "--mode");
      payload = parsed
        ? normalizeStateWriteClassificationPayload(modeOverride ? { ...parsed, mode: modeOverride } : parsed)
        : null;
    } catch {
      payload = null;
    }
    return (!payload && stateWriteOperations.length === 0)
      || Boolean(payload && (
        safeString(payload.mode).trim().toLowerCase() !== "deep-interview"
        || isPlanningPhaseDeactivationPayload(payload)
      ));
  };
  if (isAllowedDeepInterviewRalplanHandoffCommand(cwd, command, sessionId)) return true;
  const rawCommand = normalizeShellLineContinuations(command).trim();
  if ([rawCommand, canonicalizeOmxStateTransportCommand(rawCommand)]
    .some((candidate) => hasUnsafeRuntimeStateWrite(tokenizeShellWords(candidate)))) return false;
  if (stateWriteOperations.some((operation) => operation.nested)) return false;
  if (hasDeepInterviewRalplanHandoffStateMutation(cwd, command)) return false;
  if (commandEndsPlanningPhase(cwd, command)) {
    return activeState
      ? isAllowedDeepInterviewTerminalStateWriteCommand(cwd, command, activeState, sessionId)
      : false;
  }
  if (stateWriteOperations.length > 0) {
    const canonicalCommand = canonicalizeOmxStateTransportCommand(command);
    const payload = readStateWriteInputPayload(cwd, canonicalCommand, command);
    if (!payload
      || safeString(payload.mode).trim().toLowerCase() !== "deep-interview"
      || safeString(payload.session_id).trim() !== sessionId
      || !suppliedSessionAliasesMatch(payload, sessionId)
      || safeString(payload.workingDirectory).trim() === ""
      || resolve(safeString(payload.workingDirectory)) !== resolve(cwd)) return false;
  }
  if (commandHasUntargetedPlanningForbiddenIntent(command)) return false;
  if (firstPlanningTmpScriptExecutionTarget(cwd, command)) return false;
  if (!commandHasDeepInterviewWriteIntent(command)) return true;
  if (hasUnresolvedConductorInterpreterWrite(command)) return false;
  const targets = extractDeepInterviewCommandWriteTargets(command);
  if (extractDeepInterviewCommandRedirectTargets(command).length > 0
    && !conductorMetadataRedirectsHaveBoundedProducers(command)) return false;
  if (extractDeepInterviewCommandRedirectTargets(command).length > 0 && conductorCommandMayMutatePathResolution(command)) return false;
  if (extractDeepInterviewCommandRedirectTargets(command).length > 0 && extractConductorBashMutations(command, cwd).some((mutation) => mutation.targets.length === 0 && !mutation.mainRootStructuredStateWrite && !mutation.mainRootStructuredOrchestrationMutation)) return false;

  if (targets.some((target) => !isAllowedDeepInterviewArtifactPath(cwd, target, sessionId))) return false;
  return targets.length > 0 && targets.every((target) => isAllowedDeepInterviewArtifactPath(cwd, target, sessionId));
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
  const hasActiveDeepInterviewSkill = listActiveSkills(canonicalState).some((entry) => (
    entry.skill === "deep-interview"
    && matchesSkillStopContext(entry, canonicalState, sessionId, threadId)
  ));
  if (hasActiveDeepInterviewSkill && modeState?.active === true) return modeState;
  if (isInactiveCompletedDeepInterviewPhase(modeState)) return null;

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

function isAllowedRalplanBashWrite(
  cwd: string,
  command: string,
  activeState: Record<string, unknown>,
  sessionId: string,
): boolean {
  const beadsCommand = classifyRalplanBeadsMetadataCommand(cwd, command);
  const targets = extractDeepInterviewCommandWriteTargets(command);
  const hasAllowedTargets = targets.length > 0
    && targets.every((target) => isAllowedRalplanArtifactPath(cwd, target, sessionId));
  if (sourcesFileWrittenEarlierInSameCommand(cwd, command)) return false;
  if (extractDeepInterviewCommandRedirectTargets(command).length > 0 && conductorCommandMayMutatePathResolution(command)) return false;
  if (extractDeepInterviewCommandRedirectTargets(command).length > 0 && extractConductorBashMutations(command, cwd).some((mutation) => mutation.targets.length === 0 && !mutation.mainRootStructuredStateWrite && !mutation.mainRootStructuredOrchestrationMutation)) return false;
  if (extractDeepInterviewCommandRedirectTargets(command).length > 0
    && !conductorMetadataRedirectsHaveBoundedProducers(command)) return false;

  if (beadsCommand.present) {
    return beadsCommand.allowed && (targets.length === 0 || hasAllowedTargets);
  }
  if (commandEndsPlanningPhase(cwd, command)) {
    return isAllowedRalplanTerminalStateWriteCommand(cwd, command, activeState, sessionId);
  }
  if (isStandaloneParsedOmxStateWriteTransport(cwd, command, sessionId)) return true;
  if (commandHasUntargetedPlanningForbiddenIntent(command)) return false;
  if (firstPlanningTmpScriptExecutionTarget(cwd, command)) return false;
  if (!commandHasDeepInterviewWriteIntent(command)) return true;
  if (hasUnresolvedConductorInterpreterWrite(command)) return false;
  if (targets.some((target) => !isAllowedRalplanArtifactPath(cwd, target, sessionId))) return false;

  return hasAllowedTargets;
}

function buildRalplanBashBlockedDetail(cwd: string, command: string, authoritativeSessionId: string): string {
  const targets = extractDeepInterviewCommandWriteTargets(command);
  const blockedTarget = targets.find((target) => !isAllowedRalplanArtifactPath(cwd, target, authoritativeSessionId));
  if (blockedTarget && isUnresolvedVariableTarget(blockedTarget)) {
    return `unresolved Bash write target ${blockedTarget} is not under allowed planning artifact paths or metadata paths (${RALPLAN_ALLOWED_WRITE_PREFIXES.join(", ")})`;
  }
  if (blockedTarget) {
    const operationClass = /\btee\s+(?:-a\s+)?/.test(command) ? "Bash tee write" : "Bash redirect write";
    return `${operationClass} target ${blockedTarget} is not under allowed planning artifact paths or metadata paths (${RALPLAN_ALLOWED_WRITE_PREFIXES.join(", ")})`;
  }
  const executedTmpTarget = firstPlanningTmpScriptExecutionTarget(cwd, command);
  if (executedTmpTarget) {
    return `execution target ${executedTmpTarget} is under .omx/tmp; planning tmp artifacts must not be used as generated-script transport`;
  }

  if (commandHasPackageInstallIntent(command)) {
    return "package installation commands are implementation actions and cannot be combined with allowed planning artifact writes";
  }
  if (commandHasDestructiveGitSubcommand(command)) {
    return "destructive git commands are implementation actions and cannot be combined with allowed planning artifact writes";
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

function buildDeepInterviewBashBlockedDetail(cwd: string, command: string, authoritativeSessionId: string): string {
  const targets = extractDeepInterviewCommandWriteTargets(command);
  const blockedTarget = targets.find((target) => !isAllowedDeepInterviewArtifactPath(cwd, target, authoritativeSessionId));
  if (blockedTarget && isUnresolvedVariableTarget(blockedTarget)) {
    return `unresolved Bash write target ${blockedTarget} is not under allowed deep-interview artifact paths or metadata paths (${DEEP_INTERVIEW_ALLOWED_WRITE_PREFIXES.join(", ")})`;
  }
  if (blockedTarget) {
    const operationClass = /\btee\s+(?:-a\s+)?/.test(command) ? "Bash tee write" : "Bash write";
    return `${operationClass} target ${blockedTarget} is not under allowed deep-interview artifact paths or metadata paths (${DEEP_INTERVIEW_ALLOWED_WRITE_PREFIXES.join(", ")})`;
  }
  const executedTmpTarget = firstPlanningTmpScriptExecutionTarget(cwd, command);
  if (executedTmpTarget) {
    return `execution target ${executedTmpTarget} is under .omx/tmp; deep-interview tmp artifacts must not be used as generated-script transport`;
  }
  if (commandHasPackageInstallIntent(command)) {
    return "package installation commands are implementation actions and cannot be combined with allowed deep-interview artifact writes";
  }
  if (commandHasDestructiveGitSubcommand(command)) {
    return "destructive git commands are implementation actions and cannot be combined with allowed deep-interview artifact writes";
  }
  return "Bash write intent did not identify an allowed deep-interview artifact path or metadata path";
}

function buildPlanningActorWriteDeny(
  modeLabel: string,
  phase: string,
  actor: PreToolUseWriteActor,
): Record<string, unknown> {
  const provenanceConflict = actor === "provenance-conflict";
  return {
    decision: "block",
    reason: provenanceConflict
      ? `PROVENANCE_DENIED: ${modeLabel} is active (phase: ${phase}); payload identity aliases conflict and cannot authorize a write.`
      : `OWNER_CONFIRMATION_REQUIRED: ${modeLabel} is active (phase: ${phase}); implementation/write tools are blocked because native child/descendant provenance establishes same-session origin, not assigned write authority.`,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: provenanceConflict
        ? "PROVENANCE_DENIED: Conflicting or ambiguous native identity cannot authorize planning or workflow-state mutations."
        : `OWNER_CONFIRMATION_REQUIRED: Native child/descendant provenance permits only positively classified read-only operations unless exact authoritative write assignment exists. ${modeLabel === "Deep-interview" ? "Deep-interview remains requirements/spec mode." : "Planning artifact paths do not grant write authority."}`,
    },
  };
}

function buildTeamWorkerProtectedStateDeny(modeLabel: string, phase: string, toolName: string): Record<string, unknown> {
  return {
    decision: "block",
    reason: `${modeLabel} is active (phase: ${phase}); authenticated Team-worker authority does not permit ${toolName} to mutate protected workflow state.`,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: "Team-worker product-write authority never includes clearing or rewriting protected Deep-interview, Ralplan, or Conductor state.",
    },
  };
}

function buildPlanningStateScopeDeny(modeLabel: string, phase: string): Record<string, unknown> {
  return {
    decision: "block",
    reason: `PROVENANCE_DENIED: ${modeLabel} is active (phase: ${phase}); workflow state writes require exact canonical session and workingDirectory scope.`,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: "Structured planning state writes fail closed unless the operation payload is bound to the current canonical session and policy cwd.",
    },
  };
}

function teamWorkerMutationTargetsProtectedWorkflowState(
  payload: CodexHookPayload,
  toolName: string,
  command: string,
  cwd: string,
  stateDir: string,
  policyCwd = cwd,
): boolean {
  const targetIsProtectedOrAliased = (target: string): boolean => {
    if (isRawProtectedPlanningStateCandidate(stateDir, cwd, target)) return true;
    const relativeTarget = normalizePlanningArtifactRelativePath(cwd, target);
    return relativeTarget === null || conductorPathTraversesLink(cwd, relativeTarget);
  };
  const mutationTransport = classifyPreToolUseMutationTransport(payload, toolName, cwd);
  if (toolName === "mcp__omx_state__state_clear" || toolName === "mcp__omx_state__state_write") return true;
  if (mutationTransport === "unknown" || mutationTransport === "state") return true;
  if (toolName === "Bash") {
    if (collectOmxStateCommandOperations(command, "write").length > 0
      || findUnquotedOmxStateCommandIndexes(command, "clear").length > 0) return true;
    let effectiveCwd = cwd;
    const directoryStack: string[] = [];
    for (const segment of splitShellCommandSegments(stripHeredocBodiesForCommandScan(command))) {
      const words = tokenizeShellWords(segment);
      const commandIndex = findWrappedCommandPositionIndex(words, 0);
      const commandName = commandIndex === null ? "" : basename(words[commandIndex] ?? "").toLowerCase();
      const protectedMutatorCommands = new Set(["patch", "ed", "sponge", "setfacl", "setfattr", "chattr"]);
      if (
        new Set(["xargs", "find"]).has(commandName)
        && words.slice(commandIndex! + 1).some((word) => protectedMutatorCommands.has(basename(shellWordLiteral(word) ?? "").toLowerCase()))
      ) return true;
      if (protectedMutatorCommands.has(commandName)) {
        if (commandName !== "patch") return true;
        const operandWords = words.slice(commandIndex! + 1);
        if (operandWords.length !== 1) return true;
        const target = shellWordLiteral(operandWords[0] ?? "");
        if (!target || target.startsWith("-") || /[$`*?\[\]{}]/.test(target)) return true;
        if (targetIsProtectedOrAliased(isAbsolute(target) ? target : resolve(effectiveCwd, target))) return true;
        continue;
      }
      if (commandName === "cd" || commandName === "pushd" || commandName === "popd") {
        const expectedLength = commandName === "popd" ? commandIndex! + 1 : commandIndex! + 2;
        if (words.length !== expectedLength) return true;
        let changedCwd: string | null = null;
        if (commandName === "popd") {
          changedCwd = directoryStack.pop() ?? null;
        } else {
          changedCwd = resolveSimpleCdCommandCwd(effectiveCwd, ["cd", words[commandIndex! + 1] ?? ""]);
          if (commandName === "pushd" && changedCwd !== null) directoryStack.push(effectiveCwd);
        }
        if (changedCwd === null) return true;
        try {
          const target = lstatSync(changedCwd);
          if (!target.isDirectory() || target.isSymbolicLink()) return true;
          accessSync(changedCwd, fsConstants.X_OK);
        } catch {
          return true;
        }
        effectiveCwd = changedCwd;
        continue;
      }
      const changedCwd = resolveSimpleCdCommandCwd(effectiveCwd, words);
      if (changedCwd !== null) return true;
      const segmentWrites = [
        ...extractDeepInterviewCommandWriteTargets(segment),
        ...extractConductorEditorWriteTargets(segment),
        ...extractConductorInterpreterWrites(segment).flatMap((write) => write.targets),
        ...extractConductorBashMutations(segment, effectiveCwd, policyCwd).flatMap((mutation) => mutation.targets),
      ];
      const segmentHasWriteIntent = commandHasDeepInterviewWriteIntent(segment, 0, effectiveCwd)
        || commandHasNestedCliMutationIntent(segment);
      if (segmentHasWriteIntent && segmentWrites.length === 0) return true;
      for (const target of segmentWrites) {
        const effectiveTarget = isAbsolute(target) ? target : resolve(effectiveCwd, target);
        if (targetIsProtectedOrAliased(effectiveTarget)) return true;
      }
    }
    return false;
  }
  if (mutationTransport !== "path") return false;
  const candidates = collectImplementationToolPathCandidates(payload, toolName, readPreToolUsePathCandidates(payload));
  return candidates.length === 0
    || candidates.some(targetIsProtectedOrAliased);
}


async function buildRalplanPreToolUseBoundaryOutput(
  payload: CodexHookPayload,
  cwd: string,
  stateDir: string,
  resolvedSessionId?: string,
  executionCwd = cwd,
  authorityCwd = executionCwd,
): Promise<Record<string, unknown> | null> {
  const sessionId = safeString(resolvedSessionId ?? readPayloadSessionId(payload)).trim();
  const threadId = readPayloadThreadId(payload);
  const activeState = await readActiveRalplanStateForPreToolUse(cwd, stateDir, sessionId, threadId);
  if (!activeState) return null;

  const toolName = safeString(payload.tool_name).trim();
  if (toolName === "mcp__omx_state__state_write" && !directConductorStateWritePayloadHasExactSchema(payload, cwd, sessionId)) {
    return buildPlanningStateScopeDeny(
      safeString(activeState.mode).trim().toLowerCase() === "autopilot" ? "Autopilot planning" : "Ralplan",
      formatPhase(activeState.current_phase ?? activeState.currentPhase, "planning"),
    );
  }
  const command = readPreToolUseCommand(payload);
  const pathCandidates = readPreToolUsePathCandidates(payload);
  const mutationTransport = classifyPreToolUseMutationTransport(payload, toolName);
  const actor = await resolvePreToolUseWriteActor(payload, authorityCwd, stateDir, sessionId);
  if (actor === "team-worker") {
    if (teamWorkerMutationTargetsProtectedWorkflowState(payload, toolName, command, executionCwd, stateDir)) {
      return buildTeamWorkerProtectedStateDeny(
        safeString(activeState.mode).trim().toLowerCase() === "autopilot" ? "Autopilot planning" : "Ralplan",
        formatPhase(activeState.current_phase ?? activeState.currentPhase, "planning"),
        toolName,
      );
    }
    return null;
  }
  const actorMutation = toolName === "Bash"
    ? commandHasDeepInterviewWriteIntent(command, 0, cwd)
      || collectOmxStateCommandOperations(command, "write").length > 0
      || commandHasNestedCliMutationIntent(command)
    : mutationTransport !== "read-only";
  if (actorMutation && (actor === "native-child" || actor === "provenance-conflict")) {
    return buildPlanningActorWriteDeny(
      safeString(activeState.mode).trim().toLowerCase() === "autopilot" ? "Autopilot planning" : "Ralplan",
      formatPhase(activeState.current_phase ?? activeState.currentPhase, "planning"),
      actor,
    );
  }

  let blocked = false;
  let blockedDetail = "implementation/write tools are blocked until an explicit execution handoff workflow is activated";

  if (toolName === "Bash") {
    blocked = !isAllowedRalplanBashWrite(cwd, command, activeState, sessionId);
    if (blocked) {
      blockedDetail = buildRalplanBashBlockedDetail(cwd, command, sessionId);
    }
  } else if (
    mutationTransport === "state"
    && (
      toolName === "mcp__omx_state__state_clear"
      || isPlanningPhaseDeactivationPayload(normalizeStateWriteClassificationPayload(safeObject(payload.tool_input)))
    )
  ) {
    blocked = true;
    blockedDetail = `${toolName} would deactivate protected planning state`;
  } else if (mutationTransport === "path") {
    const toolPathCandidates = collectImplementationToolPathCandidates(payload, toolName, pathCandidates);
    if (toolPathCandidates.length === 0) {
      blocked = true;
      blockedDetail = describeImplementationToolBlock(toolName, undefined, toolPathCandidates.length);
    } else {
      const blockedPath = toolPathCandidates.find((candidate) => !isAllowedRalplanArtifactPath(cwd, candidate, sessionId));
      blocked = blockedPath !== undefined;
      if (blockedPath !== undefined) {
        blockedDetail = describeImplementationToolBlock(toolName, blockedPath, toolPathCandidates.length);
      }
    }
  } else if (mutationTransport === "unknown") {
    blocked = true;
    blockedDetail = `${toolName || "unknown tool"} is not a recognized read-only or explicitly authorized planning mutation transport`;
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
        + "Write only planning artifacts under `.omx/context/`, `.omx/plans/`, `.omx/specs/`, `.omx/tmp/`, required `.omx/state/` files, Markdown drafts under `.omx/drafts/*.md`, or tracker metadata under `.beads/`. "
        + "Do not edit implementation files or run implementation-focused writes from planning phases. "
        + `To execute, first process an explicit handoff such as ${formatExecutionHandoffList(cwd)}, which must emit terminal planning state before implementation begins.`,
    },
  };
}

function buildRawProtectedWorkflowStatePathOutput(
  payload: CodexHookPayload,
  cwd: string,
  stateDir: string,
): Record<string, unknown> | null {
  const toolName = safeString(payload.tool_name).trim();
  if (classifyPreToolUseMutationTransport(payload, toolName, cwd) !== "path") return null;
  const candidates = collectImplementationToolPathCandidates(payload, toolName, readPreToolUsePathCandidates(payload));
  const protectedPath = candidates.find((candidate) => isRawProtectedPlanningStateCandidate(stateDir, cwd, candidate));
  if (protectedPath === undefined) return null;
  return {
    decision: "block",
    reason: `Protected workflow state is not directly writable; ${describeImplementationToolBlock(toolName, protectedPath, candidates.length)}. Use validated structured state transport instead.`,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: "Gate-bearing workflow state is protected from raw Write/Edit-style mutations. Use validated structured state transport instead.",
    },
  };
}

async function buildDeepInterviewPreToolUseBoundaryOutput(
  payload: CodexHookPayload,
  cwd: string,
  stateDir: string,
  resolvedSessionId?: string,
  executionCwd = cwd,
  authorityCwd = executionCwd,
): Promise<Record<string, unknown> | null> {
  const sessionId = safeString(resolvedSessionId ?? readPayloadSessionId(payload)).trim();
  const threadId = readPayloadThreadId(payload);
  const activeState = await readActiveDeepInterviewStateForPreToolUse(cwd, stateDir, sessionId, threadId);
  if (!activeState) return null;

  const toolName = safeString(payload.tool_name).trim();
  if (toolName === "mcp__omx_state__state_write" && !directConductorStateWritePayloadHasExactSchema(payload, cwd, sessionId)) {
    return buildPlanningStateScopeDeny(
      "Deep-interview",
      formatPhase(activeState.current_phase ?? activeState.currentPhase, "planning"),
    );
  }
  const command = readPreToolUseCommand(payload);
  const pathCandidates = readPreToolUsePathCandidates(payload);
  const mutationTransport = classifyPreToolUseMutationTransport(payload, toolName);
  const actor = await resolvePreToolUseWriteActor(payload, authorityCwd, stateDir, sessionId);
  if (actor === "team-worker") {
    if (teamWorkerMutationTargetsProtectedWorkflowState(payload, toolName, command, executionCwd, stateDir)) {
      return buildTeamWorkerProtectedStateDeny(
        "Deep-interview",
        formatPhase(activeState.current_phase ?? activeState.currentPhase, "planning"),
        toolName,
      );
    }
    return null;
  }
  const actorMutation = toolName === "Bash"
    ? commandHasDeepInterviewWriteIntent(command, 0, cwd)
      || collectOmxStateCommandOperations(command, "write").length > 0
      || commandHasNestedCliMutationIntent(command)
    : mutationTransport !== "read-only";
  if (actorMutation && (actor === "native-child" || actor === "provenance-conflict")) {
    return buildPlanningActorWriteDeny(
      "Deep-interview",
      formatPhase(activeState.current_phase ?? activeState.currentPhase, "planning"),
      actor,
    );
  }
  let blocked = false;
  let blockedDetail = "implementation/write tools are blocked until an explicit handoff workflow is activated";

  if (toolName === "Bash") {
    blocked = !isAllowedDeepInterviewBashWrite(cwd, command, activeState, sessionId);
    if (blocked) {
      blockedDetail = buildDeepInterviewBashBlockedDetail(cwd, command, sessionId);
    }
  } else if (
    toolName === "mcp__omx_state__state_clear"
    || (
      toolName === "mcp__omx_state__state_write"
      && isPlanningPhaseDeactivationPayload(normalizeStateWriteClassificationPayload(safeObject(payload.tool_input)))
    )
  ) {
    blocked = true;
    blockedDetail = `${toolName} would deactivate protected deep-interview planning state`;
  } else if (mutationTransport === "path") {
    const candidates = collectImplementationToolPathCandidates(payload, toolName, pathCandidates);
    blocked = candidates.length === 0
      || !candidates.every((candidate) => isAllowedDeepInterviewArtifactPath(cwd, candidate, sessionId));
    if (blocked) {
      const blockedPath = candidates.find((candidate) => !isAllowedDeepInterviewArtifactPath(cwd, candidate, sessionId));
      blockedDetail = describeImplementationToolBlock(toolName, blockedPath, candidates.length);
    }
  } else if (mutationTransport === "unknown") {
    blocked = true;
    blockedDetail = `${toolName || "unknown tool"} is not a recognized read-only or explicitly authorized deep-interview mutation transport`;
  }

  if (!blocked) return null;

  const phase = formatPhase(activeState.current_phase ?? activeState.currentPhase, "planning");
  return {
    decision: "block",
    reason: `Deep-interview is active (phase: ${phase}); implementation/write tools are blocked until an explicit handoff workflow is activated; ${blockedDetail}.`,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        `Deep-interview is requirements/spec mode. Treat detailed user answers as interview/spec material, not implicit implementation authorization. You may write only deep-interview artifacts under \`.omx/context/\`, \`.omx/interviews/\`, \`.omx/specs/\`, \`.omx/tmp/\`, or required \`.omx/state/\` files. To implement, first ask for or process an explicit transition such as \`$ralplan\`, \`$autopilot\`, ${formatExecutionHandoffList(cwd)}.`,
    },
  };
}

function blocksDeepInterviewImplementationWrite(payload: CodexHookPayload, cwd: string, authoritativeSessionId: string): boolean {
  const toolName = safeString(payload.tool_name).trim();
  if (toolName === "Bash") {
    return !isAllowedDeepInterviewBashWrite(cwd, readPreToolUseCommand(payload), undefined, authoritativeSessionId);
  }
  const mutationTransport = classifyPreToolUseMutationTransport(payload, toolName);
  if (mutationTransport === "unknown") return true;
  if (mutationTransport !== "path") return false;
  const candidates = collectImplementationToolPathCandidates(
    payload,
    toolName,
    readPreToolUsePathCandidates(payload),
  );
  return candidates.length === 0
    || !candidates.every((candidate) => isAllowedDeepInterviewArtifactPath(cwd, candidate, authoritativeSessionId));
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
    if (conflictToolName === "Bash") {
      const conflictCommand = readPreToolUseCommand(payload);
      if (
        collectOmxStateCommandOperations(conflictCommand, "write").length > 0
        || collectOmxStateCommandOperations(conflictCommand, "clear").length > 0
      ) return buildDeepInterviewRootPointerConflictBlock(deepInterviewState);
    }
    if (conflictToolName === "mcp__omx_state__state_clear" || conflictToolName === "mcp__omx_state__state_write") {
      return buildDeepInterviewRootPointerConflictBlock(deepInterviewState);
    }
    if (blocksDeepInterviewImplementationWrite(payload, cwd, rootSessionId)) {
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
  const mutationTransport = classifyPreToolUseMutationTransport(payload, toolName);
  if (toolName === "Bash") {
    const conflictCommand = readPreToolUseCommand(payload);
    if (
      collectOmxStateCommandOperations(conflictCommand, "write").length > 0
      || collectOmxStateCommandOperations(conflictCommand, "clear").length > 0
    ) return buildRalplanRootPointerConflictBlock(ralplanState);
  }
  if (toolName === "mcp__omx_state__state_clear" || toolName === "mcp__omx_state__state_write") {
    return buildRalplanRootPointerConflictBlock(ralplanState);
  }
  let blocked = false;
  if (toolName === "Bash") {
    const command = readPreToolUseCommand(payload);
    blocked = commandEndsPlanningPhase(cwd, command)
      || !isAllowedRalplanBashWrite(cwd, command, ralplanState, rootSessionId);
  } else if (
    mutationTransport === "state"
    && (
      toolName === "mcp__omx_state__state_clear"
      || isPlanningPhaseDeactivationPayload(normalizeStateWriteClassificationPayload(safeObject(payload.tool_input)))
    )
  ) {
    blocked = true;
  } else if (mutationTransport === "path") {
    const toolPathCandidates = collectImplementationToolPathCandidates(
      payload,
      toolName,
      readPreToolUsePathCandidates(payload),
    );
    blocked = toolPathCandidates.length === 0
      || toolPathCandidates.some((candidate) => !isAllowedRalplanArtifactPath(cwd, candidate, rootSessionId));
  } else if (mutationTransport === "unknown") {
    blocked = true;
  }

  return blocked ? buildRalplanRootPointerConflictBlock(ralplanState) : null;
}

interface ActiveConductorState {
  mode: string;
  phase: string;
}


type PreToolUseWriteActor = "main-root" | "native-child" | "provenance-conflict" | "team-worker";
function hasSubagentThreadSpawnProvenance(payload: CodexHookPayload): boolean {
  const source = payload.source;
  if (!source || typeof source !== "object") return false;
  const subagent = (source as Record<string, unknown>).subagent;
  return Boolean(subagent && typeof subagent === "object" && Object.prototype.hasOwnProperty.call(subagent, "thread_spawn"));
}


async function resolvePreToolUseWriteActor(
  payload: CodexHookPayload,
  cwd: string,
  stateDir: string,
  sessionId: string,
): Promise<PreToolUseWriteActor> {
  if (payloadHasConflictingIdentityAliases(payload)) return "provenance-conflict";
  const unofficialAgentId = safeString(payload.agentId).trim();
  if (unofficialAgentId && !safeString(payload.agent_id).trim()) return "provenance-conflict";
  const unofficialThreadId = safeString(payload.threadId).trim();
  if (unofficialThreadId && !safeString(payload.thread_id).trim()) return "provenance-conflict";
  const trackingState = await readSubagentTrackingState(cwd).catch(() => null);
  const session = trackingState?.sessions?.[sessionId];
  const payloadThreadId = readPayloadThreadId(payload);
  const payloadAgentId = readPayloadAgentId(payload);
  if (payloadAgentId && payloadThreadId && payloadAgentId !== payloadThreadId) return "provenance-conflict";

  const leaderAnchors = new Set<string>();
  const trackerLeader = safeString(session?.leader_thread_id).trim();
  if (trackerLeader) leaderAnchors.add(trackerLeader);
  if (leaderAnchors.has(payloadAgentId) || leaderAnchors.has(payloadThreadId)) return "main-root";
  const rootSessionState = await readRootSessionStateFromStateDir(stateDir).catch(() => null);
  const payloadSessionId = readPayloadSessionId(payload);
  const leaderNativeSessionId = rootSessionState && payloadMatchesSessionPointer(sessionId, rootSessionState)
    ? safeString(rootSessionState.native_session_id).trim()
    : "";
  if (!payloadAgentId && !payloadThreadId && leaderNativeSessionId && payloadSessionId === leaderNativeSessionId) return "main-root";
  if (hasSubagentThreadSpawnProvenance(payload)) return "native-child";

  if (payloadHasOwnerIdentityClaim(payload)) return "native-child";
  if (!payloadAgentId && isTypedAgentRolePayload(payload, cwd)) return "native-child";
  if (payloadAgentId || payloadThreadId) return "native-child";
  return (await hasAuthoritativeTeamWorkerContext(cwd)) ? "team-worker" : "native-child";
}

function isActiveConductorModeState(state: Record<string, unknown> | null, mode: string, sessionId: string): boolean {
  if (!state || state.active !== true) return false;
  const stateMode = safeString(state.mode).trim();
  if (stateMode && stateMode !== mode) return false;
  const stateSessionId = safeString(state.session_id).trim();
  if (sessionId && stateSessionId && stateSessionId !== sessionId) return false;
  return isNonTerminalPhase(state.current_phase ?? state.currentPhase);
}

async function readActiveConductorStateForPreToolUse(
  payload: CodexHookPayload,
  cwd: string,
  stateDir: string,
  resolvedSessionId?: string,
): Promise<ActiveConductorState | null> {
  const sessionId = safeString(resolvedSessionId ?? readPayloadSessionId(payload)).trim();
  const threadId = readPayloadThreadId(payload);
  if (!sessionId) return null;

  const canonicalState = await readVisibleSkillActiveStateForStateDir(stateDir, sessionId);
  if (!canonicalState) return null;
  const activeEntries = listActiveSkills(canonicalState).filter((entry) => (
    matchesSkillStopContext(entry, canonicalState, sessionId, threadId)
  ));
  const hasActiveSkill = (skill: string): boolean => activeEntries.some((entry) => entry.skill === skill);

  if (hasActiveSkill("autopilot")) {
    const state = await readStopSessionPinnedState("autopilot-state.json", cwd, sessionId, stateDir);
    const childPhase = deriveAutopilotChildPhase(state);
    const hasMatchingAutopilotEntry = activeEntries.some((entry) => (
      entry.skill === "autopilot"
      && normalizeAutopilotPhase(safeString(entry.phase).trim().toLowerCase()) === childPhase
    ));
    if (
      state
      && childPhase
      && childPhase !== "deep-interview"
      && childPhase !== "ralplan"
      && childPhase !== "rework"
      && hasMatchingAutopilotEntry
      && isActiveConductorModeState(state, "autopilot", sessionId)
    ) {
      return { mode: "autopilot", phase: childPhase };
    }
  }

  if (hasActiveSkill("ralph")) {
    const state = await readStopSessionPinnedState("ralph-state.json", cwd, sessionId, stateDir);
    if (isActiveConductorModeState(state, "ralph", sessionId)) {
      const phase = safeString(state?.current_phase ?? state?.currentPhase) || "active";
      return { mode: "ralph", phase };
    }
  }

  if (hasActiveSkill("ultragoal")) {
    const state = await readStopSessionPinnedState("ultragoal-state.json", cwd, sessionId, stateDir);
    if (isActiveConductorModeState(state, "ultragoal", sessionId)) {
      return { mode: "ultragoal", phase: safeString(state?.current_phase ?? state?.currentPhase) || "active" };
    }
  }

  if (hasActiveSkill("team")) {
    const teamStateForStop = await readTeamModeStateForStop(cwd, stateDir, sessionId, threadId);
    const state = teamStateForStop?.state ?? null;
    if (isActiveConductorModeState(state, "team", sessionId)) {
      const teamName = safeString(state?.team_name).trim();
      const phase = teamName ? (await readTeamPhase(teamName, cwd).catch(() => null))?.current_phase ?? state?.current_phase : state?.current_phase;
      if (isNonTerminalPhase(phase)) return { mode: "team", phase: safeString(phase) || "active" };
    }
  }

  return null;
}

function normalizeRepoRelativePath(cwd: string, rawPath: string): string | null {
  const candidate = rawPath.trim();
  if (!candidate || isUnresolvedVariableTarget(candidate)) return null;
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
  let relativePath = relative(cwd, absolute).replace(/\\/g, "/");
  if (!relativePath || relativePath === ".") return null;
  if (relativePath.startsWith("../") || relativePath === "..") {
    relativePath = candidate.replace(/\\/g, "/");
  }
  return relativePath.replace(/^\.\//, "");
}

function conductorPathTraversesLink(cwd: string, relativePath: string): boolean {
  let current = resolve(cwd);
  for (const segment of relativePath.split("/").filter(Boolean)) {
    current = join(current, segment);
    try {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && entry.nlink > 1)) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return true;
    }
  }
  return false;
}

function isAllowedConductorMetadataPath(cwd: string, rawPath: string): boolean {
  const relativePath = normalizeRepoRelativePath(cwd, rawPath);
  if (!relativePath || conductorPathnameExpansionIsAmbiguous(relativePath)) return false;
  if (conductorPathTraversesLink(cwd, relativePath)) return false;
  if (isProtectedPlanningStatePath(relativePath)) return false;
  const artifactKind = classifyConductorArtifactKind(relativePath);
  const actionKind = actionKindForConductorArtifact(artifactKind);
  return authorizeConductorAction({
    phase: "autopilot-supervision",
    laneKind: "main-conductor",
    actionKind,
    artifactKind,
  }).allowed;
}

function isAllowedConductorMetadataExecutionPath(executionCwd: string, policyCwd: string, rawPath: string): boolean {
  const normalized = normalizeConductorMutationTargets([rawPath], executionCwd, policyCwd);
  return normalized !== null
    && normalized.length === 1
    && isAllowedConductorMetadataPath(policyCwd, normalized[0] ?? "");
}

function isAllowedConductorMetadataSourcePath(cwd: string, rawPath: string): boolean {
  const relativePath = normalizeRepoRelativePath(cwd, rawPath);
  if (!relativePath || conductorPathnameExpansionIsAmbiguous(relativePath)) return false;
  if (conductorPathTraversesLink(cwd, relativePath)) return false;
  const artifactKind = classifyConductorArtifactKind(relativePath);
  const actionKind = actionKindForConductorArtifact(artifactKind);
  return authorizeConductorAction({
    phase: "autopilot-supervision",
    laneKind: "main-conductor",
    actionKind,
    artifactKind,
  }).allowed;
}

function describeConductorBlockedWrite(toolName: string, blockedPath: string | undefined, pathCount: number): string {
  if (pathCount === 0) {
    const operationClass = isApplyPatchToolName(toolName) ? "apply_patch target extraction failed" : `${toolName} path`;
    return `${operationClass} target <unresolved>; Main-root Conductor may write only workflow state/ledger/mailbox/handoff metadata`;
  }
  const operationClass = isApplyPatchToolName(toolName) ? "apply_patch target" : `${toolName} path`;
  return `${operationClass} target ${blockedPath ?? "<unresolved>"} is not workflow state/ledger/mailbox/handoff metadata`;
}

const CONDUCTOR_BASH_MUTATION_COMMANDS = new Set([
  "cp",
  "mv",
  "rm",
  "touch",
  "mkdir",
  "rmdir",
  "install",
  "ln",
  "chmod",
  "chown",
  "chgrp",
  "truncate",
  "sed",
  "perl",
  "dd",
  "rsync",
]);

const CONDUCTOR_BASH_TRANSPARENT_WRAPPERS = new Set([
  "builtin",
  "noglob",
]);

const CONDUCTOR_BASH_DOWNLOADER_COMMANDS = new Set([
  "curl",
  "wget",
]);

const CONDUCTOR_BASH_COMPOUND_SYNTAX_WORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "select",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "in",
  "{",
  "}",
  "(",
  ")",
]);


interface ConductorBashMutation {
  command: string;
  targets: string[];
  nativeChildMetadataControl?: boolean;
  mainRootStructuredStateWrite?: boolean;
  mainRootStructuredOrchestrationMutation?: boolean;
}

interface ConductorInterpreterWrite {
  runtime: string;
  targets: string[];
  unresolved: boolean;
}

const NODE_FS_SINGLE_TARGET_MUTATION_METHODS = new Set([
  "appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync", "createWriteStream",
  "lchmod", "lchmodSync", "lchown", "lchownSync", "lutimes", "lutimesSync", "mkdir", "mkdirSync",
  "open", "openSync", "rm", "rmSync", "rmdir", "rmdirSync", "truncate", "truncateSync", "unlink",
  "unlinkSync", "utimes", "utimesSync", "writeFile", "writeFileSync",
]);
const NODE_FS_TWO_TARGET_MUTATION_METHODS = new Set([
  "copyFile", "copyFileSync", "cp", "cpSync", "link", "linkSync", "rename", "renameSync", "symlink", "symlinkSync",
]);
const NODE_FS_MUTATION_METHODS = new Set([
  ...NODE_FS_SINGLE_TARGET_MUTATION_METHODS,
  ...NODE_FS_TWO_TARGET_MUTATION_METHODS,
]);
const NODE_FS_READ_ONLY_METHODS = new Set([
  "access", "accessSync", "close", "closeSync", "exists", "existsSync", "fstat", "fstatSync",
  "glob", "globSync", "lstat", "lstatSync", "opendir", "opendirSync", "read", "readSync", "readdir",
  "readdirSync", "readFile", "readFileSync", "readlink", "readlinkSync", "realpath", "realpathSync", "stat",
  "statSync", "statfs", "statfsSync", "unwatchFile", "watch", "watchFile",
]);
const NODE_FS_CONDITIONALLY_READ_ONLY_METHODS = new Set(["createReadStream"]);
const NODE_FS_MODULE_NAMES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const NODE_MUTATION_CAPABLE_MODULE_NAMES = new Set(["child_process", "node:child_process"]);
const NODE_REFLECTED_LOADER_MEMBER_NAMES = new Set([
  "require", "getBuiltinModule", "constructor", "__proto__", "_load", "binding", "dlopen", "getPrototypeOf",
]);

function isNodeFsModuleName(moduleName: string | null): boolean {
  return moduleName !== null && NODE_FS_MODULE_NAMES.has(moduleName);
}
function isNodeMutationCapableModuleName(moduleName: string | null): boolean {
  return moduleName !== null && NODE_MUTATION_CAPABLE_MODULE_NAMES.has(moduleName);
}

function isReadOnlyNodeOpenFlags(value: string | null): boolean {
  return value === "r" || value === "rs" || value === "sr";
}

function nodeCreateReadStreamHasReadOnlyOptions(script: string, mask: string, openIndex: number): boolean {
  const closeIndex = findMatchingJavaScriptParen(mask, openIndex);
  if (closeIndex < 0) return false;
  const args = splitJavaScriptCallArguments(script, mask, openIndex, closeIndex);
  if (args.length === 1) return true;
  if (args.length !== 2) return false;
  return /^\{\s*flags\s*:\s*(['"])(?:r|rs|sr)\1\s*\}$/.test(args[1] ?? "");
}

function maskJavaScriptStringsAndComments(script: string): { mask: string; valid: boolean } {
  const chars = [...script];
  type LexMode = "code" | "single" | "double" | "template" | "regex" | "line-comment" | "block-comment";
  let mode: LexMode = "code";
  let regexCharacterClass = false;
  const templateExpressionDepths: number[] = [];
  let previousPreviousSignificant = "";
  let previousSignificant = "";
  let valid = true;

  const maskAt = (index: number): void => {
    if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
  };

  for (let index = 0; index < chars.length; index += 1) {
    const char = script[index] ?? "";
    const next = script[index + 1] ?? "";
    if (mode === "line-comment") {
      if (char === "\n" || char === "\r") mode = "code";
      else maskAt(index);
      continue;
    }
    if (mode === "block-comment") {
      maskAt(index);
      if (char === "*" && next === "/") {
        maskAt(index + 1);
        index += 1;
        mode = "code";
      }
      continue;
    }
    if (mode === "single" || mode === "double") {
      maskAt(index);
      if (char === "\\") {
        if (index + 1 < chars.length) maskAt(index + 1);
        index += 1;
      } else if ((mode === "single" && char === "'") || (mode === "double" && char === '"')) {
        mode = "code";
        previousPreviousSignificant = previousSignificant;
        previousSignificant = "v";
      }
      continue;
    }
    if (mode === "template") {
      maskAt(index);
      if (char === "\\") {
        if (index + 1 < chars.length) maskAt(index + 1);
        index += 1;
      } else if (char === "`") {
        mode = "code";
        previousPreviousSignificant = previousSignificant;
        previousSignificant = "v";
      } else if (char === "$" && next === "{") {
        maskAt(index + 1);
        templateExpressionDepths.push(1);
        index += 1;
        mode = "code";
      }
      continue;
    }
    if (mode === "regex") {
      maskAt(index);
      if (char === "\\") {
        if (index + 1 < chars.length) maskAt(index + 1);
        index += 1;
      } else if (char === "[") {
        regexCharacterClass = true;
      } else if (char === "]") {
        regexCharacterClass = false;
      } else if (char === "/" && !regexCharacterClass) {
        while (/[A-Za-z]/.test(script[index + 1] ?? "")) {
          index += 1;
          maskAt(index);
        }
        mode = "code";
        previousPreviousSignificant = previousSignificant;
        previousSignificant = "/";
      }
      continue;
    }
    if (templateExpressionDepths.length > 0) {
      const depthIndex = templateExpressionDepths.length - 1;
      if (char === "{") templateExpressionDepths[depthIndex] = (templateExpressionDepths[depthIndex] ?? 0) + 1;
      else if (char === "}") {
        const depth = (templateExpressionDepths[depthIndex] ?? 1) - 1;
        templateExpressionDepths[depthIndex] = depth;
        if (depth === 0) {
          templateExpressionDepths.pop();
          maskAt(index);
          mode = "template";
          continue;
        }
      }
    }
    if (char === "/" && next === "/") {
      maskAt(index);
      maskAt(index + 1);
      index += 1;
      mode = "line-comment";
      continue;
    }
    if (char === "/" && next === "*") {
      maskAt(index);
      maskAt(index + 1);
      index += 1;
      mode = "block-comment";
      continue;
    }
    if (char === "'") {
      maskAt(index);
      mode = "single";
      continue;
    }
    if (char === '"') {
      maskAt(index);
      mode = "double";
      continue;
    }
    if (char === "`") {
      maskAt(index);
      mode = "template";
      continue;
    }
    const followsPostfixUpdate = previousPreviousSignificant + previousSignificant === "++"
      || previousPreviousSignificant + previousSignificant === "--";
    if (char === "/" && !followsPostfixUpdate && (!previousSignificant || /[({[=,:;!?&|+\-*%^~<>]/.test(previousSignificant))) {
      maskAt(index);
      mode = "regex";
      regexCharacterClass = false;
      continue;
    }
    if (!/\s/.test(char)) {
      previousPreviousSignificant = previousSignificant;
      previousSignificant = char;
    }
  }

  if (mode !== "code" && mode !== "line-comment") valid = false;
  if (templateExpressionDepths.length > 0) valid = false;
  return { mask: chars.join(""), valid };
}

function parseStaticJavaScriptString(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0];
  if ((quote !== "'" && quote !== '"') || trimmed[trimmed.length - 1] !== quote) return null;
  const body = trimmed.slice(1, -1);
  let decoded = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    if (char === quote) return null;
    if (char !== "\\") {
      decoded += char;
      continue;
    }
    index += 1;
    const escaped = body[index];
    if (escaped === undefined) return null;
    if (escaped === "n") decoded += "\n";
    else if (escaped === "r") decoded += "\r";
    else if (escaped === "t") decoded += "\t";
    else if (escaped === "\\" || escaped === "'" || escaped === '"') decoded += escaped;
    else return null;
  }
  return decoded;
}

function parseStaticJavaScriptStringAt(script: string, startIndex: number): { value: string; endIndex: number } | null {
  let index = startIndex;
  while (/\s/.test(script[index] ?? "")) index += 1;
  const quote = script[index];
  if (quote !== "'" && quote !== '"') return null;
  const literalStart = index;
  index += 1;
  for (; index < script.length; index += 1) {
    const char = script[index] ?? "";
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char !== quote) continue;
    const value = parseStaticJavaScriptString(script.slice(literalStart, index + 1));
    return value === null ? null : { value, endIndex: index + 1 };
  }
  return null;
}

function findMatchingJavaScriptDelimiter(mask: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let index = openIndex; index < mask.length; index += 1) {
    const char = mask[index] ?? "";
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findMatchingJavaScriptParen(mask: string, openIndex: number): number {
  return findMatchingJavaScriptDelimiter(mask, openIndex, "(", ")");
}

function splitJavaScriptCallArguments(script: string, mask: string, openIndex: number, closeIndex: number): string[] {
  const args: string[] = [];
  let start = openIndex + 1;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let index = openIndex + 1; index < closeIndex; index += 1) {
    const char = mask[index] ?? "";
    if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    else if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      args.push(script.slice(start, index).trim());
      start = index + 1;
    }
  }
  args.push(script.slice(start, closeIndex).trim());
  return args;
}

interface ConductorRuntimeExecutionInspection {
  nodeInlineEvalScripts: string[];
  pythonSources: string[];
  uninspectedNodeRuntimeCount: number;
  uninspectedPythonRuntimeCount: number;
  uninspectedPackageScriptRuntimeCount: number;
  uninspectedOtherRuntimeCount: number;
  uninspectedCommandNames: string[];
}
const FAIL_CLOSED_EXECUTABLE_RUNTIME_COMMANDS = new Set([
  "awk",
  "bun",
  "deno",
  "go",
  "lua",
  "npx",
  "php",
  "ruby",
  "tsx",
]);


interface ConductorSubstitutionProgram {
  pattern: string;
  replacement: string;
  flags: string;
}

function parseConductorSingleSubstitutionProgram(script: string): ConductorSubstitutionProgram | null {
  const normalized = shellWordLiteral(script).trim();
  if (normalized.length < 4 || normalized[0] !== "s" || /[\r\n]/.test(normalized)) return null;
  const delimiter = normalized[1] ?? "";
  if (!delimiter || /\s|\\/.test(delimiter)) return null;
  let index = 2;
  const fields: string[] = [];
  for (let field = 0; field < 2; field += 1) {
    const fieldStart = index;
    let closed = false;
    while (index < normalized.length) {
      const character = normalized[index] ?? "";
      if (character === "\\") {
        if (index + 1 >= normalized.length) return null;
        index += 2;
        continue;
      }
      if (character === delimiter) {
        fields.push(normalized.slice(fieldStart, index));
        index += 1;
        closed = true;
        break;
      }
      index += 1;
    }
    if (!closed) return null;
  }
  const flags = normalized.slice(index);
  if (!/^[A-Za-z0-9]*$/.test(flags)) return null;
  return { pattern: fields[0] ?? "", replacement: fields[1] ?? "", flags };
}

function perlInPlaceSubstitutionIsPositivelySafe(substitution: ConductorSubstitutionProgram): boolean {
  return !substitution.flags.includes("e")
    && !/[`$@%]/.test(substitution.pattern)
    && !/[`$@%]/.test(substitution.replacement)
    && !/\(\?/.test(substitution.pattern);
}

function isPositivelyClassifiedPerlCommand(words: string[], commandIndex: number): boolean {
  let inPlace = false;
  let source = "";
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = shellWordLiteral(words[index] ?? "");
    if (!word || isShellCommandSeparator(word)) break;
    if (word === "--") return false;
    if (!word.startsWith("-") || word === "-") continue;
    if (word === "-e" || /^-[^-]*e$/.test(word)) {
      if (!/^-?[npi]*e$/.test(word) || source) return false;
      inPlace ||= word.includes("i");
      source = shellWordLiteral(words[index + 1] ?? "");
      if (!source || isShellCommandSeparator(source)) return false;
      index += 1;
      continue;
    }
    if (!/^-?[npi]+$/.test(word)) return false;
    inPlace ||= word.includes("i");
  }
  if (!source) return false;
  if (inPlace) {
    const substitution = parseConductorSingleSubstitutionProgram(source);
    return substitution !== null && perlInPlaceSubstitutionIsPositivelySafe(substitution);
  }
  return /^print(?:\s+\$_)?\s*;?$/.test(source.trim());
}

function packageManagerInvokesScriptRuntime(words: string[], commandIndex: number): boolean {
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word || isShellCommandSeparator(word)) break;
    if (isEnvironmentAssignmentWord(word)) continue;
    if (word === "-C" || word === "--prefix" || word === "--dir" || word === "--workspace") {
      index += 1;
      continue;
    }
    if (word === "--version" || word === "-v") return false;
    if (word.startsWith("-")) continue;
    return word !== "list" && word !== "ls" && word !== "view" && word !== "info" && word !== "help";
  }
  return false;
}
const CONDUCTOR_BASH_EXTERNAL_DISPATCH_WRAPPERS = new Set([
  "command", "env", "exec", "nice", "nohup", "setsid", "stdbuf", "sudo", "timeout", "xargs",
]);
const CONDUCTOR_BASH_MODELED_CURRENT_SHELL_BUILTINS = new Set([
  "cd", "pushd", "popd",
]);
const CONDUCTOR_BASH_POSITIVELY_CLASSIFIED_COMMANDS = new Set([
  ":", "[", "basename", "break", "cat", "continue", "cut", "date", "declare", "dirname",
  "echo", "export", "false", "getopts", "gjc", "grep", "head", "jq", "local", "ls",
  "omx", "printenv", "printf", "pwd", "read", "readlink", "readonly", "realpath", "return",
  "set", "shift", "sleep", "stat", "tail", "test", "tr", "true",
  "type", "unset", "wait", "wc", "which",
]);

function conductorShellStateNameIsSensitive(name: string): boolean {
  return name === "PATH"
    || name === "POSIXLY_CORRECT"
    || name === "WGETRC"
    || name === "HOME"
    || name === "CDPATH"
    || name === "BASH_ENV"
    || name === "ENV"
    || name === "ZDOTDIR"
    || name === "RIPGREP_CONFIG_PATH"
    || /^NODE_[A-Z0-9_]+$/.test(name)
    || /^LD_[A-Z0-9_]+$/.test(name)
    || /^DYLD_[A-Z0-9_]+$/.test(name)
    || /^PYTHON[A-Z0-9_]*$/.test(name)
    || /^PERL[A-Z0-9_]*$/.test(name)
    || /^GIT_[A-Z0-9_]+$/.test(name)
    || /^RSYNC_[A-Z0-9_]+$/.test(name)
    || /^(?:OMX|GJC)_[A-Z0-9_]+$/.test(name)
    || name === "SSLKEYLOGFILE";
}

function inheritedConductorBashStartupIsUnsafe(): boolean {
  return safeString(process.env.BASH_ENV).trim() !== "";
}

function commandDefinesConductorCommandNotFoundHandler(command: string): boolean {
  const source = stripHeredocBodiesForCommandScan(command);
  for (let index = 0; index < source.length; index += 1) {
    const definition = findShellFunctionDefinitionAt(source, index);
    if (!definition) continue;
    if (definition.name === "command_not_found_handle") return true;
    const bodyEnd = findShellFunctionBodyEnd(source, definition.openBraceIndex, definition.bodyOpenChar);
    if (bodyEnd < 0) return true;
    index = bodyEnd;
  }
  return false;
}

function commandHasUnsafeConductorShellState(command: string, cwd = process.cwd()): boolean {
  if (inheritedConductorBashStartupIsUnsafe()) return true;
  if (hasConductorPromptParameterTransform(command)) return true;
  if (
    commandDefinesConductorCommandNotFoundHandler(command)
    || safeString(process.env["BASH_FUNC_command_not_found_handle%%"]).trim() !== ""
  ) return true;
  const words = tokenizeConductorShellWords(stripHeredocBodiesForCommandScan(command));
  const shellBuiltins = new Set([":", "declare", "typeset", "local", "export", "false", "getopts", "readonly", "return", "set", "shift", "true", "unset", "wait"]);
  let allexport = inheritedConductorShellOptions().allexport;
  let unresolvedNameref = false;

  if (!inheritedConductorShellOptions().known) return true;
  for (const commandStart of collectShellCommandStartIndexes(words)) {
    const directCommandIndex = skipShellCommandPositionPrefixWords(words, commandStart);
    const directCommandWord = shellWordLiteral(words[directCommandIndex] ?? "");
    if (directCommandWord.includes("/") && isAbsolute(directCommandWord)) {
      const commandState = resolveConductorCommandPathState(
        words,
        commandStart,
        directCommandIndex,
        createConductorRuntimeShellState(cwd),
      );
      if (!conductorSlashCommandIsTrusted(directCommandWord, commandState, cwd)) return true;
    }
    for (let index = commandStart; index < directCommandIndex; index += 1) {
      const assignment = parseShellAssignmentWord(words[index] ?? "");
      if (allexport && assignment && conductorShellStateNameIsSensitive(assignment.name)) return true;
    }

    const commandIndex = findWrappedCommandPositionIndex(words, commandStart) ?? directCommandIndex;
    const commandName = commandNameFromShellWord(words[commandIndex] ?? "");
    if (!commandName) continue;
    const rawOperands = collectConductorInvocationWords(words, commandIndex);
    const operands = rawOperands.map(shellWordLiteral);

    if (commandName === "set") {
      for (let index = 0; index < operands.length; index += 1) {
        const operand = operands[index] ?? "";
        if (/[$`]/.test(rawOperands[index] ?? "")) return true;
        if (operand === "--") break;
        if (operand === "--allexport") {
          allexport = true;
          continue;
        }
        if (operand === "-o" || operand === "+o") {
          const name = operands[index + 1] ?? "";
          if (!CONDUCTOR_SAFE_SHELL_OPTIONS.has(name)) return true;
          if (name === "allexport") allexport = operand === "-o";
          index += 1;
          continue;
        }
        if (/^[-+][A-Za-z]+$/.test(operand)) {
          if (![...operand.slice(1)].every((letter) => CONDUCTOR_SAFE_SHORT_SHELL_OPTION_LETTERS.has(letter))) return true;
          if (operand.includes("a")) allexport = operand.startsWith("-");
          continue;
        }
        if (operand.startsWith("-") || operand.startsWith("+")) return true;
      }
      continue;
    }

    const declaration = commandName === "declare" || commandName === "typeset" || commandName === "local";
    if (declaration) {
      if (rawOperands.some((operand) => !parseShellAssignmentWord(operand) && /[$`]/.test(operand))) return true;
      if (operands.some((operand) => (
        (operand.startsWith("-") || operand.startsWith("+"))
        && operand !== "-"
        && operand !== "+"
        && !/^[+-][fFgnprxI]+$/.test(operand)
      ))) return true;
      if (operands.some((operand) => /^[+-][A-Za-z]*[iaA]/.test(operand))) return true;
      if (commandName === "local" && operands.includes("-")) return true;
      const declaresNameref = operands.some((operand) => /^[+-][A-Za-z]*n[A-Za-z]*$/.test(operand));
      if (declaresNameref) {
        for (const operand of operands.filter((candidate) => !candidate.startsWith("-") && !candidate.startsWith("+"))) {
          const assignment = parseShellAssignmentWord(operand);
          if (!assignment || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(assignment.value)) {
            unresolvedNameref = true;
            continue;
          }
          if (conductorShellStateNameIsSensitive(assignment.value)) return true;
        }
      }
      if (allexport) {
        for (const operand of operands) {
          const assignment = parseShellAssignmentWord(operand);
          if (assignment && conductorShellStateNameIsSensitive(assignment.name)) return true;
        }
      }
      continue;
    }

    if (commandName === "export" && allexport) {
      for (const operand of operands) {
        const assignment = parseShellAssignmentWord(operand);
        if (assignment && conductorShellStateNameIsSensitive(assignment.name)) return true;
      }
      continue;
    }

    if (unresolvedNameref && !shellBuiltins.has(commandName) && !CONDUCTOR_BASH_COMPOUND_SYNTAX_WORDS.has(commandName)) return true;
  }

  return false;
}


function commandConfiguresRuntimeEnvironment(command: string, names: Set<string>, depth = 0): boolean {
  for (const segment of splitShellCommandSegments(stripHeredocBodiesForCommandScan(command))) {
    const words = tokenizeShellWords(segment);
    for (const word of words) {
      if (!isEnvironmentAssignmentWord(word)) continue;
      if (names.has(shellAssignmentName(word))) return true;
    }
    const commandIndex = words.findIndex((word) => !isEnvironmentAssignmentWord(word) && !CONDUCTOR_BASH_COMPOUND_SYNTAX_WORDS.has(word));
    const commandName = commandNameFromShellWord(words[commandIndex] ?? "");
    const exportsVariables = commandName === "export"
      || ((commandName === "declare" || commandName === "typeset") && words.slice(commandIndex + 1).some((word) => /^-[^-]*x/.test(word)));
    if (exportsVariables && words.slice(commandIndex + 1).some((word) => /[$`]/.test(word))) return true;
    if (exportsVariables && words.slice(commandIndex + 1).some((word) => names.has(word.split("=", 1)[0] ?? ""))) return true;
  }
  const functionBodies = extractInvokedShellFunctionBodiesForStateScan(command);
  if (functionBodies.length === 0) return false;
  if (depth >= CONDUCTOR_BASH_MAX_NESTING_DEPTH) return true;
  return functionBodies.some((body) => commandConfiguresRuntimeEnvironment(body, names, depth + 1));
}
function inheritedRuntimeEnvironmentConfigured(names: Set<string>): boolean {
  return [...names].some((name) => safeString(process.env[name]).trim() !== "");
}

const CONDUCTOR_DYNAMIC_LOADER_ENVIRONMENT_NAMES = new Set([
  "LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH", "LD_LIBRARY_PATH_32", "LD_LIBRARY_PATH_64",
  "LD_PRELOAD_32", "LD_PRELOAD_64", "LD_DEBUG", "LD_DEBUG_OUTPUT", "LD_PROFILE", "LD_PROFILE_OUTPUT",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_PRINT_TO_FILE",
  "DYLD_FORCE_FLAT_NAMESPACE", "DYLD_ROOT_PATH", "DYLD_FRAMEWORK_PATH",
  "DYLD_FALLBACK_FRAMEWORK_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "LIBPATH", "SHLIB_PATH",
]);

function isConductorDynamicLoaderEnvironmentName(name: string): boolean {
  return CONDUCTOR_DYNAMIC_LOADER_ENVIRONMENT_NAMES.has(name)
    || /^LD_[A-Z0-9_]+$/.test(name)
    || /^DYLD_[A-Z0-9_]+$/.test(name)
    || name === "LIBPATH"
    || name === "SHLIB_PATH";
}

function commandHasAmbiguousDynamicLoaderControlFlow(command: string): boolean {
  const mentionsLoaderState = /\b(?:LD_[A-Z0-9_]+|DYLD_[A-Z0-9_]+|LIBPATH|SHLIB_PATH|loader)\b/.test(command);
  if (!mentionsLoaderState) return false;
  return /&&|\|\||\b(?:if|elif|case|for|while|until|select|function)\b|(?:^|[;|&()]\s*)[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{/.test(command);
}

function commandHasUnsafeDynamicLoaderEnvironment(command: string, depth = 0): boolean {
  if (/\bcommand\s+(?:env\s+)?(?:LD_[A-Z0-9_]+|DYLD_[A-Z0-9_]+|LIBPATH|SHLIB_PATH)=/.test(command)) return true;
  if (/(?:^|[;|&()]\s*)(?:LD_[A-Z0-9_]+|DYLD_[A-Z0-9_]+|LIBPATH|SHLIB_PATH)=[^\s;|&()]+\s+(?:\/[^\s;|&()]+\/)?env(?:\s|$)/.test(command)) return true;
  if (/\bcommand\s+export\s+[^;\n]*(?:LD_[A-Z0-9_]+|DYLD_[A-Z0-9_]+|LIBPATH|SHLIB_PATH)\b/.test(command)) return true;
  if (commandHasAmbiguousDynamicLoaderControlFlow(command)) return true;
  if (Object.entries(process.env).some(([name, value]) => (
    isConductorDynamicLoaderEnvironmentName(name) && safeString(value).trim() !== ""
  ))) return true;
  for (const words of splitShellCommandSegments(stripHeredocBodiesForCommandScan(command)).map(tokenizeConductorShellWords)) {
    for (const word of words) {
      const assignment = parseShellAssignmentWord(word);
      if (
        assignment
        && isConductorDynamicLoaderEnvironmentName(assignment.name)
        && (assignment.append || /[$`]/.test(assignment.value) || assignment.value.trim() !== "")
      ) return true;
    }
  }
  const values = new Map<string, string | undefined>();
  const exported = new Set<string>();
  const aliases = new Map<string, string | null>();
  for (const [name, value] of Object.entries(process.env)) {
    if (!isConductorDynamicLoaderEnvironmentName(name)) continue;
    values.set(name, value);
    exported.add(name);
  }
  const resolveName = (name: string): string | null => aliases.has(name) ? aliases.get(name) ?? null : name;
  const assign = (name: string, value: string | undefined, destinationValues = values, destinationExported = exported, forceExport = false): boolean => {
    const target = resolveName(name);
    if (target === null) return true;
    if (!isConductorDynamicLoaderEnvironmentName(target)) return false;
    destinationValues.set(target, value);
    if (forceExport) destinationExported.add(target);
    return false;
  };
  const environmentIsConfigured = (candidateValues: ReadonlyMap<string, string | undefined>, candidateExported: ReadonlySet<string>): boolean => (
    [...candidateExported].some((name) => isConductorDynamicLoaderEnvironmentName(name) && safeString(candidateValues.get(name)).trim() !== "")
  );
  const shellBuiltins = new Set([":", "declare", "typeset", "local", "export", "readonly", "unset", "true", "false", "echo", "printf", "read", "getopts", "set", "shift", "return", "wait"]);
  for (const segment of splitShellCommandSegments(stripHeredocBodiesForCommandScan(command))) {
    const words = tokenizeShellWords(segment);
    if (words.some((word) => /[$`]/.test(word) && /(?:LD_|DYLD_|LIBPATH|SHLIB_PATH|loader)/.test(word))) return true;
    let commandIndex = 0;
    const prefixAssignments: Array<{ name: string; value: string }> = [];
    while (commandIndex < words.length) {
      const assignment = parseShellAssignmentWord(words[commandIndex] ?? "");
      if (!assignment) break;
      prefixAssignments.push({ name: assignment.name, value: assignment.value });
      commandIndex += 1;
    }
    const commandName = commandNameFromShellWord(words[commandIndex] ?? "");
    if (!commandName) {
      for (const assignment of prefixAssignments) if (assign(assignment.name, assignment.value)) return true;
      continue;
    }
    const commandValues = new Map(values);
    const commandExported = new Set(exported);
    for (const assignment of prefixAssignments) if (assign(assignment.name, assignment.value, commandValues, commandExported, true)) return true;
    const operands = words.slice(commandIndex + 1).map(shellWordLiteral);
    const declaration = commandName === "declare" || commandName === "typeset" || commandName === "local";
    const declaresNameref = declaration && operands.some((operand) => /^-[A-Za-z]*n/.test(operand));
    const declaresExport = (declaration && operands.some((operand) => /^-[A-Za-z]*x/.test(operand))) || commandName === "export";
    if (declaresNameref) {
      for (const operand of operands.filter((operand) => !/^[-+]/.test(operand))) {
        const assignment = parseShellAssignmentWord(operand);
        if (!assignment || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(assignment.value)) aliases.set((assignment?.name ?? operand), null);
        else aliases.set(assignment.name, assignment.value);
        if (declaresExport) {
          const target = resolveName(assignment?.name ?? operand);
          if (target === null) return true;
          if (isConductorDynamicLoaderEnvironmentName(target)) exported.add(target);
        }
      }
      continue;
    }
    if (commandName === "unset") {
      const removesNameref = operands.some((operand) => operand === "-n" || /^-[A-Za-z]*n/.test(operand));
      for (const operand of operands.filter((operand) => !operand.startsWith("-"))) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(operand)) return true;
        if (removesNameref) aliases.delete(operand);
        else if (assign(operand, undefined)) return true;
      }
      continue;
    }
    if (commandName === "export" || commandName === "readonly" || declaration) {
      const unexports = commandName === "export" && operands.some((operand) => /^-.*n/.test(operand));
      for (const operand of operands.filter((operand) => !/^[-+]/.test(operand))) {
        const assignment = parseShellAssignmentWord(operand);
        const name = assignment?.name ?? operand;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return true;
        if (assignment && assign(name, assignment.value)) return true;
        const target = resolveName(name);
        if (target === null) return true;
        if (isConductorDynamicLoaderEnvironmentName(target)) {
          if (unexports) exported.delete(target);
          else if (declaresExport) exported.add(target);
        }
      }
      continue;
    }
    let executionValues = commandValues;
    let executionExported = commandExported;
    let executedCommandName = commandName;
    if (commandName === "env") {
      let cursor = commandIndex + 1;
      let clears = false;
      while (cursor < words.length) {
        const operand = shellWordLiteral(words[cursor] ?? "");
        if (operand === "-i" || operand === "--ignore-environment") {
          clears = true;
          cursor += 1;
          continue;
        }
        if (operand === "-u" || operand === "--unset") {
          const name = shellWordLiteral(words[cursor + 1] ?? "");
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return true;
          const target = resolveName(name);
          if (target === null) return true;
          commandValues.delete(target);
          commandExported.delete(target);
          cursor += 2;
          continue;
        }
        if (operand.startsWith("-")) {
          cursor += 1;
          continue;
        }
        const assignment = parseShellAssignmentWord(operand);
        if (assignment) {
          if (assign(assignment.name, assignment.value, commandValues, commandExported, true)) return true;
          cursor += 1;
          continue;
        }
        executedCommandName = commandNameFromShellWord(operand);
        break;
      }
      if (clears) {
        executionValues = new Map();
        executionExported = new Set();
        for (let index = commandIndex + 1; index < cursor; index += 1) {
          const assignment = parseShellAssignmentWord(shellWordLiteral(words[index] ?? ""));
          if (assignment && assign(assignment.name, assignment.value, executionValues, executionExported, true)) return true;
        }
      }
    } else if (commandName === "exec" && operands.includes("-c")) {
      executionValues = new Map();
      executionExported = new Set();
      const nested = operands.find((operand) => !operand.startsWith("-"));
      executedCommandName = commandNameFromShellWord(nested ?? "");
    }
    if (!shellBuiltins.has(executedCommandName) && environmentIsConfigured(executionValues, executionExported)) return true;
  }
  const functionBodies = extractInvokedShellFunctionBodiesForStateScan(command);
  if (functionBodies.length === 0) return false;
  if (depth >= CONDUCTOR_BASH_MAX_NESTING_DEPTH) return true;
  return functionBodies.some((body) => commandHasUnsafeDynamicLoaderEnvironment(body, depth + 1));
}



function isPositivelyReadOnlyGitCommand(words: string[], commandIndex: number): boolean {
  const args = collectConductorInvocationWords(words, commandIndex);
  let index = 0;
  while (index < args.length) {
    const word = shellWordLiteral(args[index] ?? "");
    if (!word || isDynamicNestedCommandString(word)) return false;
    if (!word.startsWith("-")) break;
    if (!new Set(["--no-pager", "--literal-pathspecs", "--no-optional-locks"]).has(word)) return false;
    index += 1;
  }
  const subcommand = shellWordLiteral(args[index] ?? "");
  if (!subcommand) return false;
  const allowedOptions = new Map<string, Set<string>>([
    ["cat-file", new Set(["-e", "-t", "-s", "--exists", "--batch", "--batch-check", "--batch-command", "--buffer", "--follow-symlinks", "--allow-unknown-type", "--unordered"])],
    ["ls-files", new Set(["-c", "--cached", "-d", "--deleted", "-m", "--modified", "-o", "--others", "-i", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", "--full-name", "--stage", "--debug", "--eol", "--deduplicate", "--error-unmatch"])],
    ["ls-tree", new Set(["-d", "-r", "-t", "-l", "-z", "--name-only", "--name-status", "--object-only", "--full-name", "--full-tree", "--abbrev"])],
    ["merge-base", new Set(["--is-ancestor", "--independent", "--octopus", "--all", "--fork-point"])],
    ["rev-parse", new Set(["--verify", "--quiet", "--sq", "--sq-quote", "--revs-only", "--no-revs", "--flags", "--no-flags", "--show-toplevel", "--show-prefix", "--show-cdup", "--git-dir", "--is-inside-work-tree", "--is-bare-repository", "--show-object-format"])],
  ]);
  const allowed = allowedOptions.get(subcommand);
  if (!allowed) return false;
  for (const rawWord of args.slice(index + 1)) {
    const word = shellWordLiteral(rawWord);
    if (!word || isDynamicNestedCommandString(word)) return false;
    if (word.startsWith("-")) {
      if (!allowed.has(word)) return false;
      continue;
    }
    if (!/^[A-Za-z0-9._~/:=@,+^{}-]+$/.test(word)) return false;
  }
  return true;
}
function ghCommandPath(words: string[], commandIndex: number): [string, string] {
  const operands: string[] = [];
  for (let index = commandIndex + 1; index < words.length && operands.length < 2; index += 1) {
    const word = words[index] ?? "";
    if (!word || isShellCommandSeparator(word)) break;
    if (word === "-R" || word === "--repo" || word === "--hostname") {
      index += 1;
      continue;
    }
    if (!word.startsWith("-")) operands.push(word);
  }
  return [operands[0] ?? "", operands[1] ?? ""];
}

const CONDUCTOR_GH_HELPER_ENVIRONMENT_NAMES = new Set([
  "GH_BROWSER", "GH_EDITOR", "GH_PAGER", "GIT_EDITOR", "EDITOR", "VISUAL", "PAGER", "BROWSER",
]);

function ghInvocationHasUnsafeHelperEnvironment(words: string[], commandIndex: number): boolean {
  let commandStartIndex = commandIndex;
  while (
    commandStartIndex > 0
    && !isShellCommandSeparatorAt(words, commandStartIndex - 1)
    && !isShellGroupingSyntaxWord(words[commandStartIndex - 1] ?? "")
  ) commandStartIndex -= 1;
  const clearBoundary = nestedExecEnvironmentClearBoundary(words, commandStartIndex, commandIndex);
  for (const rawWord of words.slice(clearBoundary === null ? commandStartIndex : clearBoundary + 1, commandIndex)) {
    const assignment = parseShellAssignmentWord(rawWord);
    if (assignment && CONDUCTOR_GH_HELPER_ENVIRONMENT_NAMES.has(assignment.name)) return true;
  }
  return false;
}

function ghStaticValue(rawWord: string, allowData = false): string | null {
  const value = shellWordLiteral(rawWord);
  if (
    !value
    || isDynamicNestedCommandString(value)
    || /[$`\0]/.test(value)
    || (!allowData && /[?*\[\]{}]/.test(value))
  ) return null;
  return value;
}

function ghStaticOptionValue(args: string[], index: number, option: string, allowData = false): { value: string; nextIndex: number } | null {
  const rawWord = args[index] ?? "";
  if (rawWord.startsWith(`${option}=`)) {
    const value = ghStaticValue(rawWord.slice(option.length + 1), allowData);
    return value === null ? null : { value, nextIndex: index };
  }
  const value = ghStaticValue(args[index + 1] ?? "", allowData);
  return value === null || value.startsWith("-") ? null : { value, nextIndex: index + 1 };
}

interface ConductorStaticGhApiInvocation {
  mutationIntent: boolean;
}

function parseConductorStaticGhApiInvocation(words: string[], commandIndex: number): ConductorStaticGhApiInvocation | null {
  const args = collectConductorInvocationWords(words, commandIndex);
  if (shellWordLiteral(args[0] ?? "") !== "api") return null;
  const longValueOptions = new Set(["--repo", "--hostname", "--method", "--field", "--raw-field", "--input", "--jq", "--template"]);
  const shortValueOptions = new Set(["R", "X", "f", "F", "H"]);
  let endpoint = "";
  let method = "GET";
  let hasRequestBody = false;
  const applyOption = (name: string, value: string): boolean => {
    if (name === "--method" || name === "X") {
      const normalizedMethod = value.toUpperCase();
      if (!new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]).has(normalizedMethod)) return false;
      method = normalizedMethod;
    }
    if (name === "--field" || name === "--raw-field" || name === "--input" || name === "f" || name === "F") hasRequestBody = true;
    if (name === "H") {
      const override = /^x-http-method-override\s*:\s*(GET|POST|PUT|PATCH|DELETE)\s*$/i.exec(value);
      if (override) method = (override[1] ?? "").toUpperCase();
    }
    return true;
  };

  for (let index = 1; index < args.length; index += 1) {
    const rawWord = args[index] ?? "";
    const word = shellWordLiteral(rawWord);
    if (!word || word === "--" || ghStaticValue(rawWord, true) === null) return null;
    if (word.startsWith("--")) {
      const option = word.split("=", 1)[0] ?? "";
      if (option === "--include" || option === "--silent") {
        if (word.includes("=")) return null;
        continue;
      }
      if (!longValueOptions.has(option)) return null;
      const parsed = ghStaticOptionValue(args, index, option, true);
      if (!parsed || !applyOption(option, parsed.value)) return null;
      index = parsed.nextIndex;
      continue;
    }
    if (word.startsWith("-") && word !== "-") {
      const attached = /^-([RXfFH])(.+)$/.exec(word);
      if (attached) {
        const name = attached[1] ?? "";
        const value = ghStaticValue(attached[2] ?? "", true);
        if (!shortValueOptions.has(name) || value === null || !applyOption(name, value)) return null;
        continue;
      }
      if (!/^-([RXfFH])$/.test(word)) return null;
      const name = word.slice(1);
      const value = ghStaticValue(args[index + 1] ?? "", true);
      if (!shortValueOptions.has(name) || value === null || value.startsWith("-") || !applyOption(name, value)) return null;
      index += 1;
      continue;
    }
    if (endpoint || !/^\/[A-Za-z0-9._~/:,;=@&+\-]+$/.test(word)) return null;
    endpoint = word;
  }
  return endpoint ? { mutationIntent: method !== "GET" || hasRequestBody } : null;
}

function ghApiHasStaticRemoteEndpoint(words: string[], commandIndex: number): boolean {
  return parseConductorStaticGhApiInvocation(words, commandIndex) !== null;
}

function ghIssueCreateHasStaticRemoteArguments(words: string[], commandIndex: number): boolean {
  const args = collectConductorInvocationWords(words, commandIndex);
  if (shellWordLiteral(args[0] ?? "") !== "issue" || shellWordLiteral(args[1] ?? "") !== "create") return false;
  const values = new Map<string, string>();
  for (let index = 2; index < args.length; index += 1) {
    const rawWord = args[index] ?? "";
    const word = shellWordLiteral(rawWord);
    if (!word || !word.startsWith("--")) return false;
    const option = word.split("=", 1)[0] ?? "";
    if (!new Set(["--title", "--body", "--body-file", "--repo", "--hostname"]).has(option) || values.has(option)) return false;
    const value = ghStaticOptionValue(args, index, option, option === "--body");
    if (!value) return false;
    values.set(option, value.value);
    index = value.nextIndex;
  }
  return values.has("--title") && (values.has("--body") || values.has("--body-file"));
}

function isPositivelyClassifiedGhCommand(words: string[], commandIndex: number): boolean {
  if (ghInvocationHasUnsafeHelperEnvironment(words, commandIndex)) return false;
  return ghApiHasStaticRemoteEndpoint(words, commandIndex)
    || ghIssueCreateHasStaticRemoteArguments(words, commandIndex);
}

function ghCommandUsesOnlyRemoteOptions(words: string[], commandIndex: number): boolean {
  return isPositivelyClassifiedGhCommand(words, commandIndex);
}


function ghCommandHasMutationIntent(words: string[], commandIndex: number): boolean {
  if (!ghCommandUsesOnlyRemoteOptions(words, commandIndex)) return true;
  const [command, subcommand] = ghCommandPath(words, commandIndex);
  if (!command) return false;
  if (command === "api") return parseConductorStaticGhApiInvocation(words, commandIndex)?.mutationIntent ?? true;
  const readOnly = new Map<string, string[]>([
    ["issue", ["list", "status", "view"]], ["pr", ["checks", "diff", "list", "status", "view"]],
    ["release", ["list", "view"]], ["run", ["list", "view", "watch"]], ["repo", ["list", "view"]],
    ["gist", ["list", "view"]], ["workflow", ["list", "view"]],
    ["auth", ["status"]], ["config", ["get"]], ["alias", ["list"]], ["extension", ["list"]],
  ]);
  return !readOnly.get(command)?.includes(subcommand);
}

interface ShellCliInvocation {
  commandIndex: number;
  argumentProducingWrapper: boolean;
}

function collectShellCliInvocations(words: string[]): ShellCliInvocation[] {
  const invocations: ShellCliInvocation[] = [];
  const commandStarts = [0, ...words.flatMap((word, index) => isShellCommandSeparator(word) ? [index + 1] : [])];
  for (const startIndex of commandStarts) {
    let commandIndex = skipShellCommandPositionPrefixWords(words, startIndex);
    let argumentProducingWrapper = false;
    const visited = new Set<number>();
    while (commandIndex < words.length && !visited.has(commandIndex)) {
      visited.add(commandIndex);
      const commandName = commandNameFromShellWord(words[commandIndex] ?? "");
      const operandIndex = findConductorWrapperOperandIndex(commandName, words, commandIndex + 1);
      if (operandIndex === undefined) break;
      if (operandIndex === null) {
        commandIndex = -1;
        break;
      }
      if (commandName === "xargs") argumentProducingWrapper = true;
      commandIndex = operandIndex;
    }
    if (commandIndex >= 0 && commandIndex < words.length) invocations.push({ commandIndex, argumentProducingWrapper });
  }
  return invocations;
}

function commandHasGhMutationIntent(command: string): boolean {
  return splitShellCommandSegments(stripHeredocBodiesForCommandScan(command)).some((segment) => {
    const words = tokenizeShellWords(segment);
    return collectShellCliInvocations(words).some(({ commandIndex, argumentProducingWrapper }) => (
      commandNameFromShellWord(words[commandIndex] ?? "") === "gh"
      && (argumentProducingWrapper || ghCommandHasMutationIntent(words, commandIndex))
    ));
  });
}

function omxCliInvocationHasMutationIntent(words: string[], commandIndex: number): boolean {
  const invocationWords = words.slice(commandIndex + 1);
  const separatorIndex = invocationWords.findIndex(isShellCommandSeparator);
  const boundedWords = separatorIndex >= 0 ? invocationWords.slice(0, separatorIndex) : invocationWords;
  if (boundedWords.some((word) => word === "--help" || word === "-h" || word === "--version" || word === "-v")) return false;
  const operands = boundedWords.filter((word) => word && !word.startsWith("-"));
  const commandName = operands[0] ?? "";
  const subcommand = operands[1] ?? "";
  if (!commandName || ["help", "read", "status", "version"].includes(commandName)) return false;
  if (commandName === "state" && ["read", "status"].includes(subcommand)) return false;
  if (["deep-interview", "ralplan", "ralph", "team", "ultragoal"].includes(commandName) && ["read", "status"].includes(subcommand)) return false;
  return true;
}

function commandHasOmxCliMutationIntent(command: string): boolean {
  return splitShellCommandSegments(stripHeredocBodiesForCommandScan(command)).some((segment) => {
    const words = tokenizeShellWords(segment);
    return collectShellCliInvocations(words).some(({ commandIndex, argumentProducingWrapper }) => {
      const commandName = commandNameFromShellWord(words[commandIndex] ?? "");
      return (commandName === "omx" || commandName === "gjc")
        && (argumentProducingWrapper || omxCliInvocationHasMutationIntent(words, commandIndex));
    });
  });
}

function commandHasNestedCliMutationIntent(command: string, depth = 0): boolean {
  const normalizedCommand = stripHeredocBodiesForCommandScan(normalizeShellLineContinuations(command));
  if (commandHasGhMutationIntent(normalizedCommand) || commandHasOmxCliMutationIntent(normalizedCommand)) return true;
  if (depth >= CONDUCTOR_BASH_MAX_NESTING_DEPTH) return false;
  const nestedCommands = [
    ...extractInvokedShellFunctionBodiesForStateScan(normalizedCommand),
    ...extractNestedShellCommandStringsForStateScan(normalizedCommand),
    ...extractNestedCommandSubstitutionStringsForStateScan(normalizedCommand),
    ...extractNestedProcessSubstitutionStringsForStateScan(normalizedCommand),
  ];
  return nestedCommands.some((nestedCommand) => commandHasNestedCliMutationIntent(nestedCommand, depth + 1));
}

function isPositivelyClassifiedUniqCommand(words: string[], commandIndex: number, posixlyCorrect: boolean): boolean {
  let positionalCount = 0;
  let optionsTerminated = false;
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = shellWordLiteral(words[index] ?? "");
    if (!word || isShellCommandSeparator(word)) break;
    if (isDynamicNestedCommandString(word) || /[$`]/.test(word)) return false;
    if (!optionsTerminated && word === "--") {
      optionsTerminated = true;
      continue;
    }
    if (!optionsTerminated && word.startsWith("-")) {
      if (/^-[cdiuz]+$/.test(word) || new Set(["--count", "--repeated", "--ignore-case", "--unique", "--zero-terminated"]).has(word)) continue;
      if (/^-(?:f|s|w)[1-9][0-9]*$/.test(word) || /^(?:--skip-fields|--skip-chars|--check-chars)=[1-9][0-9]*$/.test(word)) continue;
      if (new Set(["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"]).has(word)) {
        const value = shellWordLiteral(words[index + 1] ?? "");
        if (!/^[1-9][0-9]*$/.test(value)) return false;
        index += 1;
        continue;
      }
      return false;
    }
    positionalCount += 1;
    if (posixlyCorrect && positionalCount === 1) optionsTerminated = true;
    if (positionalCount > 1) return false;
  }
  return true;
}

function isPositivelyClassifiedRgCommand(words: string[], commandIndex: number): boolean {
  if (safeString(process.env.RIPGREP_CONFIG_PATH).trim() !== "") return false;
  if (words.slice(0, commandIndex).some((word) => shellAssignmentName(word) === "RIPGREP_CONFIG_PATH")) return false;
  const safeFlags = new Set([
    "--no-config", "--ignore-case", "--case-sensitive", "--smart-case", "--word-regexp", "--line-regexp",
    "--fixed-strings", "--pcre2", "--no-ignore", "--hidden", "--line-number", "--with-filename",
    "--no-filename", "--files-with-matches", "--files-without-match", "--count", "--count-matches",
    "--only-matching", "--quiet", "--text", "--binary", "--null", "--no-messages", "--json",
  ]);
  const valueOptions = new Set([
    "--glob", "--iglob", "--type", "--type-not", "--regexp", "--file", "--before-context", "--after-context",
    "--context", "--max-count", "--threads", "--max-columns", "--max-filesize", "--encoding", "--color", "--colors",
  ]);
  const safeShortFlags = new Set(["i", "s", "v", "w", "x", "F", "P", "n", "H", "h", "l", "L", "c", "o", "q", "a", "u", "I"]);
  const shortValueOptions = new Set(["g", "t", "T", "e", "f", "A", "B", "C", "m", "j", "M"]);
  const args = collectConductorInvocationWords(words, commandIndex);
  let optionsTerminated = false;
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index] ?? "";
    const word = shellWordLiteral(raw);
    if (!word || isDynamicNestedCommandString(word) || /[$`]/.test(raw)) return false;
    if (!optionsTerminated && word === "--") {
      optionsTerminated = true;
      continue;
    }
    if (optionsTerminated || !word.startsWith("-") || word === "-") continue;
    if (word.startsWith("--")) {
      const name = word.split("=", 1)[0] ?? "";
      if (safeFlags.has(word)) continue;
      if (!valueOptions.has(name)) return false;
      const value = word.startsWith(`${name}=`) ? word.slice(name.length + 1) : shellWordLiteral(args[index + 1] ?? "");
      if (!value || isDynamicNestedCommandString(value) || /[$`]/.test(value)) return false;
      if (word === name) index += 1;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(word) && [...word.slice(1)].every((option) => safeShortFlags.has(option))) continue;
    if (/^-[A-Za-z]$/.test(word) && shortValueOptions.has(word[1] ?? "")) {
      const value = shellWordLiteral(args[index + 1] ?? "");
      if (!value || isDynamicNestedCommandString(value) || /[$`]/.test(value)) return false;
      index += 1;
      continue;
    }
    return false;
  }
  return !existsSync(join(process.cwd(), ".ripgreprc")) || args.some((word) => shellWordLiteral(word) === "--no-config");
}

function isPositivelyClassifiedSortCommand(words: string[], commandIndex: number): boolean {
  const safeLongOptions = new Set([
    "--ignore-leading-blanks", "--dictionary-order", "--ignore-case", "--general-numeric-sort", "--human-numeric-sort",
    "--ignore-nonprinting", "--month-sort", "--numeric-sort", "--reverse", "--random-sort", "--version-sort",
    "--stable", "--unique", "--zero-terminated", "--check",
  ]);
  const safeShortOptions = new Set(["b", "d", "f", "g", "h", "i", "M", "n", "r", "R", "V", "s", "u", "z", "c", "C"]);
  for (const rawWord of collectConductorInvocationWords(words, commandIndex)) {
    const word = shellWordLiteral(rawWord);
    if (!word || isDynamicNestedCommandString(word) || /[$`]/.test(word)) return false;
    if (word === "--") continue;
    if (word.startsWith("--")) {
      if (!safeLongOptions.has(word)) return false;
      continue;
    }
    if (word.startsWith("-") && word !== "-" && ![...word.slice(1)].every((option) => safeShortOptions.has(option))) return false;
  }
  return true;
}

function sedScriptIsPositivelyReadOnly(script: string): boolean {
  const normalized = shellWordLiteral(script).trim();
  const substitution = parseConductorSingleSubstitutionProgram(normalized);
  if (substitution) return !/[ew]/.test(substitution.flags);
  return /^[0-9$.,+~\-]*(?:p|P|q|Q|n|N|l|d|=)$/.test(normalized);
}

function isPositivelyClassifiedSedCommand(words: string[], commandIndex: number): boolean {
  const scripts: string[] = [];
  let sawInPlace = false;
  let sawImplicitScript = false;
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word || isShellCommandSeparator(word)) break;
    if (isConductorSedInPlaceOption(word)) {
      if (conductorSedInPlaceBackupSuffixIsUnsafe(word)) return false;
      sawInPlace = true;
      continue;
    }
    if (word.startsWith("--") && !new Set(["--in-place", "--expression", "--file"]).has(word.split("=", 1)[0] ?? "")) return false;
    if (word === "-f" || word === "--file" || word.startsWith("-f") || word.startsWith("--file=")) return false;
    if (word === "-e" || word === "--expression") {
      const script = words[index + 1] ?? "";
      if (!script) return false;
      scripts.push(script);
      index += 1;
      continue;
    }
    if (word.startsWith("-e") && word.length > 2) {
      scripts.push(word.slice(2));
      continue;
    }
    if (word.startsWith("--expression=")) {
      scripts.push(word.slice("--expression=".length));
      continue;
    }
    if (word.startsWith("-")) continue;
    if (!sawImplicitScript && scripts.length === 0) {
      scripts.push(word);
      sawImplicitScript = true;
    }
  }
  return scripts.length > 0 && (!sawInPlace || scripts.length === 1) && scripts.every((script) => sedScriptIsPositivelyReadOnly(script));
}

function commandConfiguresNodeOptions(command: string, depth = 0): boolean {
  for (const segment of splitShellCommandSegments(stripHeredocBodiesForCommandScan(command))) {
    const words = tokenizeShellWords(segment);
    let leadingIndex = 0;
    while (leadingIndex < words.length && (isEnvironmentAssignmentWord(words[leadingIndex] ?? "") || CONDUCTOR_BASH_COMPOUND_SYNTAX_WORDS.has(words[leadingIndex] ?? ""))) {
      const word = words[leadingIndex] ?? "";
      if (isEnvironmentAssignmentWord(word) && shellAssignmentName(word) === "NODE_OPTIONS") return true;
      leadingIndex += 1;
    }
    let commandIndex = leadingIndex;
    const visitedWrapperIndexes = new Set<number>();
    while (commandIndex >= 0) {
      if (visitedWrapperIndexes.has(commandIndex)) return true;
      visitedWrapperIndexes.add(commandIndex);
      const wrappedIndex = findConductorWrapperOperandIndex(commandNameFromShellWord(words[commandIndex] ?? ""), words, commandIndex + 1);
      if (wrappedIndex === undefined) break;
      if (wrappedIndex === null) return true;
      commandIndex = wrappedIndex;
    }
    const commandName = commandNameFromShellWord(words[commandIndex] ?? "");
    const exportsVariables = commandName === "export"
      || ((commandName === "declare" || commandName === "typeset") && words.slice(commandIndex + 1).some((word) => /^-[^-]*x/.test(word)));
    if (!exportsVariables) continue;
    if (words.slice(commandIndex + 1).some((word) => /[$`]/.test(word))) return true;
    for (let index = commandIndex + 1; index < words.length; index += 1) {
      const word = words[index] ?? "";
      if (word === "NODE_OPTIONS" || (isEnvironmentAssignmentWord(word) && shellAssignmentName(word) === "NODE_OPTIONS")) return true;
    }
  }
  const functionBodies = extractInvokedShellFunctionBodiesForStateScan(command);
  if (functionBodies.length > 0) {
    if (depth >= CONDUCTOR_BASH_MAX_NESTING_DEPTH) return true;
    if (functionBodies.some((body) => commandConfiguresNodeOptions(body, depth + 1))) return true;
  }
  return false;
}

function nodeCommandHasPreloadExecution(words: string[], commandIndex: number): boolean {
  const preloadPattern = /(?:^|\s)(?:-r|--require|--import|--loader|--experimental-loader)(?:\s|=|$)/;
  if (preloadPattern.test(safeString(process.env.NODE_OPTIONS))) return true;
  for (const word of words) {
    if (!isEnvironmentAssignmentWord(word)) continue;
    const separator = word.indexOf("=");
    if (separator < 0 || shellAssignmentName(word) !== "NODE_OPTIONS") continue;
    if (preloadPattern.test(word.slice(separator + 1))) return true;
  }
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word || isShellCommandSeparator(word)) break;
    if (word === "-r" || word === "--require" || word === "--import" || word === "--loader" || word === "--experimental-loader") return true;
    if (word === "--env-file" || word.startsWith("--env-file=")) return true;
    if (/^(?:-r.+|--(?:require|import|loader|experimental-loader)=.+)$/.test(word)) return true;
  }
  return false;
}

const CONDUCTOR_NODE_OUTPUT_ENVIRONMENT_NAMES = new Set([
  "NODE_V8_COVERAGE", "NODE_COMPILE_CACHE", "NODE_REDIRECT_WARNINGS", "NODE_REPORT_DIRECTORY", "NODE_REPORT_FILENAME",
]);

function gitRuntimeEnvironmentIsUnsafe(name: string): boolean {
  return name === "GIT_EXTERNAL_DIFF"
    || name === "GIT_EXEC_PATH"
    || name === "GIT_ASKPASS"
    || name === "GIT_SSH"
    || name === "GIT_SSH_COMMAND"
    || name === "GIT_PAGER"
    || name === "GIT_EDITOR"
    || name === "GIT_SEQUENCE_EDITOR"
    || name === "GIT_CONFIG_COUNT"
    || /^GIT_CONFIG(?:_|$)/.test(name)
    || /^GIT_DIFF_PATH_(?:COUNTER|TOTAL)$/.test(name)
    || /^GIT_TRACE(?:_|$)/.test(name);
}
function gitCommandHasUnsafeRuntimeEnvironment(words: string[], commandIndex: number): boolean {
  if (Object.keys(process.env).some(gitRuntimeEnvironmentIsUnsafe)) return true;
  return words.slice(0, commandIndex).some((word) => {
    const assignment = parseShellAssignmentWord(word);
    return assignment !== null && gitRuntimeEnvironmentIsUnsafe(assignment.name);
  });
}

function conductorRuntimeEnvironmentNameIsSensitive(name: string): boolean {
  return name === "NODE_OPTIONS"
    || name === "SSLKEYLOGFILE"
    || CONDUCTOR_NODE_OUTPUT_ENVIRONMENT_NAMES.has(name)
    || CONDUCTOR_PYTHON_DANGEROUS_ENVIRONMENT_NAMES.has(name)
    || new Set(["PERL5LIB", "PERL5OPT", "RIPGREP_CONFIG_PATH", "BASH_ENV", "ENV", "ZDOTDIR", ...CONDUCTOR_GH_HELPER_ENVIRONMENT_NAMES]).has(name)
    || /^RSYNC_[A-Z0-9_]+$/.test(name)
    || isConductorDynamicLoaderEnvironmentName(name)
    || gitRuntimeEnvironmentIsUnsafe(name);
}

function commandMayPopulateSensitiveRuntimeEnvironment(command: string): boolean {
  const isSensitiveTarget = (rawName: string | undefined): boolean => {
    const name = shellWordLiteral(rawName ?? "");
    return !isConductorStaticVariableName(name) || conductorRuntimeEnvironmentNameIsSensitive(name);
  };
  for (const segment of splitShellCommandSegments(stripHeredocBodiesForCommandScan(command))) {
    const words = tokenizeConductorShellWords(segment);
    for (let index = 0; index < words.length; index += 1) {
      const commandName = commandNameFromShellWord(words[index] ?? "");
      if (commandName === "printf") {
        const operands = collectConductorInvocationWords(words, index);
        const valueIndex = operands.findIndex((operand) => shellWordLiteral(operand) === "-v");
        if (valueIndex >= 0 && isSensitiveTarget(operands[valueIndex + 1])) return true;
        if (operands.some((operand) => /^-v[^-]/.test(shellWordLiteral(operand)))) return true;
      } else if (commandName === "read") {
        const operands = collectConductorInvocationWords(words, index);
        const names = operands.filter((operand) => {
          const literal = shellWordLiteral(operand);
          return literal !== "--" && !literal.startsWith("-");
        });
        if (names.some((name) => isSensitiveTarget(name))) return true;
      } else if (commandName === "getopts") {
        const operands = collectConductorInvocationWords(words, index);
        if (isSensitiveTarget(operands[1])) return true;
      } else if (commandName === "for" || commandName === "select") {
        if (isSensitiveTarget(words[index + 1])) return true;
      }
    }
  }
  return false;
}

function nodeCommandHasUnsafeRuntimeOutput(
  words: string[],
  commandStartIndex: number,
  commandIndex: number,
  persistentOutputEnvironmentConfigured = false,
): boolean {
  const clearBoundary = nestedExecEnvironmentClearBoundary(
    words,
    skipShellCommandPositionPrefixWords(words, commandStartIndex),
    commandIndex,
  );
  if (
    clearBoundary === null
    && (
      persistentOutputEnvironmentConfigured
      || safeString(process.env.NODE_OPTIONS).trim() !== ""
      || [...CONDUCTOR_NODE_OUTPUT_ENVIRONMENT_NAMES].some((name) => safeString(process.env[name]).trim() !== "")
    )
  ) return true;
  for (const word of words.slice(clearBoundary === null ? commandStartIndex : clearBoundary + 1, commandIndex)) {
    const assignment = parseShellAssignmentWord(word);
    if (!assignment) continue;
    if (CONDUCTOR_NODE_OUTPUT_ENVIRONMENT_NAMES.has(assignment.name) || assignment.name === "NODE_OPTIONS") return true;
  }
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word || isShellCommandSeparator(word)) break;
    if (word === "-e" || word === "--eval" || word === "-p" || word === "--print" || word === "--input-type" || word === "--conditions") {
      const value = words[index + 1] ?? "";
      if (!value || isShellCommandSeparator(value) || /[$`]/.test(value)) return true;
      index += 1;
      continue;
    }
    if (/^(?:-e|-p).+/.test(word) || /^(?:--(?:eval|print|input-type|conditions)=).+/.test(word)) continue;
    // Runtime-owned diagnostic/profile/report/trace/test/warning output flags,
    // plus unknown or version-dependent flags, are fail-closed.
    if (word.startsWith("-")) return true;
    break;
  }
  return false;
}

interface ConductorCoprocCompoundBody {
  start: number;
  end: number;
  body: string;
}

function collectConductorCoprocCompoundBodies(command: string): ConductorCoprocCompoundBody[] {
  const bodies: ConductorCoprocCompoundBody[] = [];
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
      continue;
    }
    if (quote || command.slice(index, index + "coproc".length) !== "coproc") continue;
    if (/[_A-Za-z0-9]/.test(command[index - 1] ?? "") || /[_A-Za-z0-9]/.test(command[index + "coproc".length] ?? "")) continue;
    let cursor = index + "coproc".length;
    while (/\s/.test(command[cursor] ?? "")) cursor += 1;
    if (/^[A-Za-z_]/.test(command[cursor] ?? "")) {
      while (/[_A-Za-z0-9]/.test(command[cursor] ?? "")) cursor += 1;
      while (/\s/.test(command[cursor] ?? "")) cursor += 1;
    }
    if (command[cursor] !== "{") continue;
    const end = findShellFunctionBodyEnd(command, cursor, "{");
    if (end < 0) continue;
    bodies.push({ start: index, end: end + 1, body: command.slice(cursor + 1, end) });
    index = end;
  }
  return bodies;
}

function stripConductorCoprocCompoundBodiesForRuntimeInspection(command: string): { command: string; bodies: string[] } {
  const regions = collectConductorCoprocCompoundBodies(command);
  if (regions.length === 0) return { command, bodies: [] };
  let stripped = "";
  let cursor = 0;
  for (const region of regions) {
    stripped += `${command.slice(cursor, region.start)}:`;
    cursor = region.end;
  }
  return { command: `${stripped}${command.slice(cursor)}`, bodies: regions.map((region) => region.body) };
}

function nestedShellHasUnsafeStartup(words: string[], commandIndex: number, commandStartIndex = commandIndex): boolean {
  const commandName = commandNameFromShellWord(words[commandIndex] ?? "");
  let login = false;
  let interactive = false;
  let noProfile = false;
  let noRorc = false;
  let noZshRcs = false;
  for (let index = commandStartIndex; index < commandIndex; index += 1) {
    const wrapper = commandNameFromShellWord(words[index] ?? "");
    const option = shellWordLiteral(words[index + 1] ?? "");
    if (wrapper === "exec" && (option === "-l" || /^-[^-]*l/.test(option))) login = true;
    const argv0Value = wrapper === "exec"
      ? option === "-a" ? shellWordLiteral(words[index + 2] ?? "") : /^-a(.+)$/.exec(option)?.[1]
      : wrapper === "env"
        ? option === "-a" || option === "--argv0" ? shellWordLiteral(words[index + 2] ?? "") : /^(?:-a|--argv0)=(.+)$/.exec(option)?.[1] ?? /^-a(.+)$/.exec(option)?.[1]
        : undefined;
    if (argv0Value?.startsWith("-")) login = true;
  }
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = shellWordLiteral(words[index] ?? "");
    if (!word || isShellCommandSeparator(word)) break;
    if (word === "--login" || /^-[^-]*l/.test(word)) login = true;
    if (word === "--interactive" || /^-[^-]*i/.test(word)) interactive = true;
    if (word === "--noprofile") noProfile = true;
    if (word === "--norc") noRorc = true;
    if (word === "-f" || /^-[^-]*f/.test(word)) noZshRcs = true;
    if (!word.startsWith("-")) break;
  }
  if (commandName === "zsh") return !noZshRcs;
  if (commandName !== "bash") return login || interactive;
  if (interactive) return true;
  return login && (!noProfile || !noRorc);
}

function mergeConductorRuntimeExecutionInspection(
  target: ConductorRuntimeExecutionInspection,
  source: ConductorRuntimeExecutionInspection,
): void {
  target.nodeInlineEvalScripts.push(...source.nodeInlineEvalScripts);
  target.pythonSources.push(...source.pythonSources);
  target.uninspectedNodeRuntimeCount += source.uninspectedNodeRuntimeCount;
  target.uninspectedPythonRuntimeCount += source.uninspectedPythonRuntimeCount;
  target.uninspectedPackageScriptRuntimeCount += source.uninspectedPackageScriptRuntimeCount;
  target.uninspectedOtherRuntimeCount += source.uninspectedOtherRuntimeCount;
  target.uninspectedCommandNames.push(...source.uninspectedCommandNames);
}

function isConductorShellFunctionDefinitionInvocation(words: string[], commandIndex: number): boolean {
  return words[commandIndex + 1] === "(" && words[commandIndex + 2] === ")" && words[commandIndex + 3] === "{";
}

function staticLastpipeShoptSetting(words: string[], commandIndex: number): boolean | null {
  const operands = collectConductorInvocationWords(words, commandIndex).map(shellWordLiteral);
  if (operands.length !== 2 || operands[1] !== "lastpipe") return null;
  if (operands[0] === "-s") return true;
  if (operands[0] === "-u") return false;
  return null;
}


function inspectConductorRuntimeExecutions(command: string, cwd?: string, depth = 0, inheritedShellFunctions: ReadonlyMap<string, string[]> = new Map()): ConductorRuntimeExecutionInspection {
  const inspection: ConductorRuntimeExecutionInspection = {
    nodeInlineEvalScripts: [],
    pythonSources: [],
    uninspectedNodeRuntimeCount: 0,
    uninspectedPythonRuntimeCount: 0,
    uninspectedPackageScriptRuntimeCount: 0,
    uninspectedOtherRuntimeCount: 0,
    uninspectedCommandNames: [],
  };
  const coprocCompounds = stripConductorCoprocCompoundBodiesForRuntimeInspection(command);
  const topLevelCommand = coprocCompounds.command;
  const unsafeDynamicLoaderEnvironment = commandHasUnsafeDynamicLoaderEnvironment(topLevelCommand);
  if (commandMayPopulateSensitiveRuntimeEnvironment(topLevelCommand)) {
    inspection.uninspectedOtherRuntimeCount += 1;
    inspection.uninspectedCommandNames.push("runtime-environment-writer");
  }

  const runtimeCwd = cwd ?? process.cwd();
  const runtimeFunctionScan = collectConductorStaticNestedBashExecutions(topLevelCommand, runtimeCwd, inheritedShellFunctions);
  const functionBindings = runtimeFunctionScan.functions;
  const definedShellFunctionNames = new Set(
    [...functionBindings]
      .filter(([, bodies]) => bodies.some(isConductorFunctionBody))
      .map(([name]) => name),
  );
  for (const body of coprocCompounds.bodies) {
    if (depth >= CONDUCTOR_BASH_MAX_NESTING_DEPTH) {
      inspection.uninspectedOtherRuntimeCount += 1;
      inspection.uninspectedCommandNames.push("coproc");
    } else {
      mergeConductorRuntimeExecutionInspection(
        inspection,
        inspectConductorRuntimeExecutions(body, cwd, depth + 1, new Map(functionBindings)),
      );
    }
  }
  const heredocBodies = extractShellHeredocBodies(topLevelCommand);
  const commandSetsNodeOptions = commandConfiguresNodeOptions(topLevelCommand);
  const commandSetsNodeOutputEnvironment = commandConfiguresRuntimeEnvironment(
    topLevelCommand,
    CONDUCTOR_NODE_OUTPUT_ENVIRONMENT_NAMES,
  );
  const perlStartupNames = new Set(["PERL5LIB", "PERL5OPT"]);
  const commandSetsPerlStartup = inheritedRuntimeEnvironmentConfigured(perlStartupNames) || commandConfiguresRuntimeEnvironment(topLevelCommand, perlStartupNames);
  const shellStartupNames = new Set(["BASH_ENV", "ENV", "ZDOTDIR"]);
  const commandSetsShellStartup = inheritedRuntimeEnvironmentConfigured(shellStartupNames) || commandConfiguresRuntimeEnvironment(topLevelCommand, shellStartupNames);
  const gitHelperNames = new Set(["GIT_EXTERNAL_DIFF"]);
  const commandSetsGitHelper = inheritedRuntimeEnvironmentConfigured(gitHelperNames) || commandConfiguresRuntimeEnvironment(topLevelCommand, gitHelperNames);
  const runtimeShellState = createConductorRuntimeShellState(runtimeCwd);
  let heredocBodyIndex = 0;
  for (const segment of [stripHeredocBodiesForCommandScan(topLevelCommand)]) {
    const segmentHeredocCount = segment.split("\n").flatMap((line) => extractShellHeredocOpeners(line)).length;
    const words = tokenizeConductorShellWords(segment);
    const commandStarts = new Set(collectShellCommandStartIndexes(words));
    const casePhases = collectShellCasePhases(words);
    if (segmentHeredocCount > 0 && words.some((word) => word === "|" || word === "|&")) {
      inspection.uninspectedOtherRuntimeCount += 1;
      inspection.uninspectedCommandNames.push("heredoc-pipeline");
    }
    let commandStart = true;
    let inForHeader = false;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index] ?? "";
      if (!word) continue;
      if (casePhases[index] === "pattern") continue;
      if (commandStarts.has(index)) commandStart = true;
      if (isShellCommandSeparatorAt(words, index)) {
        commandStart = true;
        continue;
      }
      if (inForHeader) {
        if (word === "do") inForHeader = false;
        continue;
      }
      if (word === "for") {
        inForHeader = true;
        continue;
      }
      if (!commandStart) continue;
      if (word === "case") {
        commandStart = false;
        continue;
      }
      if (isShellGroupingSyntaxWord(word)) continue;
      if (isEnvironmentAssignmentWord(word)) {
        const assignment = parseShellAssignmentWord(word);
        if (assignment && isShellCommandSeparatorAt(words, index + 1)) {
          applyConductorAssignment(runtimeShellState, assignment, { persistent: true });
        }
        continue;
      }
      if (CONDUCTOR_BASH_COMPOUND_SYNTAX_WORDS.has(word)) continue;
      let commandIndex = index;
      let usedExternalDispatchWrapper = false;
      let argumentProducingWrapper = false;
      const visitedWrapperIndexes = new Set<number>();
      while (!visitedWrapperIndexes.has(commandIndex)) {
        visitedWrapperIndexes.add(commandIndex);
        const wrappedCommandName = commandNameFromShellWord(words[commandIndex] ?? "");
        if (CONDUCTOR_BASH_EXTERNAL_DISPATCH_WRAPPERS.has(wrappedCommandName)) usedExternalDispatchWrapper = true;
        if (wrappedCommandName === "xargs") argumentProducingWrapper = true;
        const operandIndex = findConductorWrapperOperandIndex(wrappedCommandName, words, commandIndex + 1);
        if (operandIndex === undefined) break;
        if (operandIndex === null) {
          commandIndex = -1;
          break;
        }
        commandIndex = operandIndex;
      }
      if (commandIndex >= 0 && !conductorWrapperLayersAreTrusted(words, index, commandIndex, runtimeShellState, runtimeCwd)) {
        inspection.uninspectedOtherRuntimeCount += 1;
        inspection.uninspectedCommandNames.push("wrapper");
        commandStart = false;
        continue;
      }
      const commandWord = commandIndex >= 0 ? words[commandIndex] ?? "" : "";
      const commandName = commandNameFromShellWord(commandWord);
      if (unsafeDynamicLoaderEnvironment) {
        inspection.uninspectedOtherRuntimeCount += 1;
        inspection.uninspectedCommandNames.push("dynamic-loader-environment");
        commandStart = false;
        continue;
      }
      if (argumentProducingWrapper && !new Set([":", "echo", "false", "printf", "true"]).has(commandName)) {
        inspection.uninspectedOtherRuntimeCount += 1;
        inspection.uninspectedCommandNames.push("xargs");
        commandStart = false;
        continue;
      }
      const commandCwd = runtimeShellState.effectiveCwd;
      if (isShellGroupingSyntaxWord(commandWord)) {
        commandStart = false;
        continue;
      }
      const pathOverride = words.slice(index, Math.max(index, commandIndex)).some((candidate) => isEnvironmentAssignmentWord(candidate) && shellAssignmentName(candidate) === "PATH");
      const pathCommandUntrusted = /[\\/]/.test(commandWord)
        && !conductorSlashCommandIsTrusted(commandWord, runtimeShellState, runtimeCwd);
      if (commandWord && (pathCommandUntrusted || pathOverride)) {
        inspection.uninspectedOtherRuntimeCount += 1;
        inspection.uninspectedCommandNames.push(commandName || "path-dispatched-command");
        commandStart = false;
        continue;
      }
      const invokesDefinedShellFunction = !usedExternalDispatchWrapper && /^[A-Za-z_][\w]*$/.test(commandWord) && definedShellFunctionNames.has(commandWord);
      if (invokesDefinedShellFunction && !isConductorShellFunctionDefinitionInvocation(words, commandIndex)) {
        if (depth >= CONDUCTOR_BASH_MAX_NESTING_DEPTH) {
          inspection.uninspectedOtherRuntimeCount += 1;
          inspection.uninspectedCommandNames.push(commandName);
        } else {
          for (const body of functionBindings.get(commandWord) ?? []) {
            if (!isConductorFunctionBody(body)) continue;
            mergeConductorRuntimeExecutionInspection(
              inspection,
              inspectConductorRuntimeExecutions(body, commandCwd ?? runtimeCwd, depth + 1, new Map(functionBindings)),
            );
          }
        }
      }
      if (["node", "node.exe", "nodejs", "nodejs.exe"].includes(commandName)) {
        const commandStartIndex = (() => {
          let start = index;
          while (start > 0 && !isShellCommandSeparatorAt(words, start - 1) && !isShellGroupingSyntaxWord(words[start - 1] ?? "")) start -= 1;
          return start;
        })();
        if (commandSetsNodeOptions) inspection.uninspectedNodeRuntimeCount += 1;
        if (
          nodeCommandHasPreloadExecution(words, commandIndex)
          || nodeCommandHasUnsafeRuntimeOutput(words, commandStartIndex, commandIndex, commandSetsNodeOutputEnvironment)
        ) inspection.uninspectedNodeRuntimeCount += 1;
        let foundInlineEval = false;
        for (let argIndex = commandIndex + 1; argIndex < words.length; argIndex += 1) {
          const arg = words[argIndex] ?? "";
          if (!arg || isShellCommandSeparator(arg)) break;
          if (arg === "-pe" || arg === "-e" || arg === "--eval" || arg === "-p" || arg === "--print") {
            const script = words[argIndex + 1] ?? "";
            if (script && !isShellCommandSeparator(script) && !runtimeOptionIsInlineCode(script)) {
              inspection.nodeInlineEvalScripts.push(script);
              argIndex += 1;
            } else {
              inspection.uninspectedNodeRuntimeCount += 1;
            }
            foundInlineEval = true;
            continue;
          }
          const attachedShortPrefix = (["-pe", "-e", "-p"] as const).find(
            (prefix) => arg.startsWith(prefix) && arg.length > prefix.length,
          );
          if (attachedShortPrefix) {
            inspection.nodeInlineEvalScripts.push(arg.slice(attachedShortPrefix.length));
            foundInlineEval = true;
            continue;
          }
          const inlinePrefix = (["--eval=", "--print="] as const).find(
            (prefix) => arg.startsWith(prefix) && arg.length > prefix.length,
          );
          if (inlinePrefix) {
            inspection.nodeInlineEvalScripts.push(arg.slice(inlinePrefix.length));
            foundInlineEval = true;
            continue;
          }
        }
        if (!foundInlineEval) inspection.uninspectedNodeRuntimeCount += 1;
      } else if (commandName === "omx" || commandName === "gjc") {
        const commandStartIndex = (() => {
          let start = index;
          while (start > 0 && !isShellCommandSeparatorAt(words, start - 1) && !isShellGroupingSyntaxWord(words[start - 1] ?? "")) start -= 1;
          return start;
        })();
        if (
          commandSetsNodeOptions
          || nodeCommandHasPreloadExecution(words, commandIndex)
          || nodeCommandHasUnsafeRuntimeOutput(words, commandStartIndex, commandIndex, commandSetsNodeOutputEnvironment)
        ) inspection.uninspectedNodeRuntimeCount += 1;
      } else if (isPythonInterpreterCommandWord(commandName)) {
        const pythonStartupCwd = runtimeShellState.effectiveCwd;
        const safePythonOptions = pythonCommandHasOnlySafeOptions(words, commandIndex);
        const isolatedPythonStartup = pythonCommandUsesIsolatedStartup(words, commandIndex);
        let pythonSource: string | null = null;
        let inlineSource = false;
        for (let argIndex = commandIndex + 1; argIndex < words.length; argIndex += 1) {
          const arg = words[argIndex] ?? "";
          if (!arg || isShellCommandSeparator(arg)) break;
          if (arg === "-c") {
            const source = words[argIndex + 1] ?? "";
            if (source) pythonSource = shellWordLiteral(source);
            inlineSource = true;
            break;
          }
          if (arg.startsWith("-c") && arg.length > 2) {
            pythonSource = shellWordLiteral(arg.slice(2));
            inlineSource = true;
            break;
          }
        }
        if (pythonSource === null) {
          const heredocBody = segmentHeredocCount === 1 ? heredocBodies[heredocBodyIndex] : undefined;
          if (heredocBody !== undefined) pythonSource = heredocBody;
        }
        if (pythonSource === null) {
          inspection.uninspectedPythonRuntimeCount += 1;
        } else {
          inspection.pythonSources.push(pythonSource);
          const pythonMetadataCwd = pythonStartupCwd !== null && isConductorWritableMetadataRuntimeCwd(pythonStartupCwd);
          const pythonCwdStartup = pythonStartupCwd === null
            || pythonCwdHasLoadableStartupCandidate(pythonStartupCwd)
            || pythonInvocationHomeHasLoadableStartupCandidate(words, commandIndex, isolatedPythonStartup)
            || (pythonMetadataCwd && !isolatedPythonStartup);
          const reviewedReadOnlyInlineSource = inlineSource
            && pythonCommandHasLiteralReviewedReadOnlyInlineSource(words, commandIndex);
          const modeledMetadataWrite = pythonStartupCwd !== null
            && isPositivelyModeledPythonMetadataWriteSource(pythonSource, pythonStartupCwd);
          if (
            !safePythonOptions
            || !isolatedPythonStartup
            || pythonInvocationHasUnsafeRuntimeEnvironment(words, commandIndex)
            || pythonCwdStartup
            || (!reviewedReadOnlyInlineSource && !modeledMetadataWrite)
          ) inspection.uninspectedPythonRuntimeCount += 1;
        }
      } else if (commandName === "gh") {
        if (!isPositivelyClassifiedGhCommand(words, commandIndex)) {
          inspection.uninspectedOtherRuntimeCount += 1;
          inspection.uninspectedCommandNames.push(commandName);
        }
      } else if (commandName === "rg") {
        if (!isPositivelyClassifiedRgCommand(words, commandIndex)) {
          inspection.uninspectedOtherRuntimeCount += 1;
          inspection.uninspectedCommandNames.push(commandName);
        }
      } else if (commandName === "uniq") {
        if (!isPositivelyClassifiedUniqCommand(
          words,
          commandIndex,
          stateHasPosixlyCorrect(runtimeShellState) || commandHasPosixlyCorrectPrefix(words, commandIndex),
        )) {
          inspection.uninspectedOtherRuntimeCount += 1;
          inspection.uninspectedCommandNames.push(commandName);
        }
      } else if (commandName === "git") {
        if (commandSetsGitHelper || gitCommandHasUnsafeRuntimeEnvironment(words, commandIndex) || !isPositivelyReadOnlyGitCommand(words, commandIndex)) {
          inspection.uninspectedOtherRuntimeCount += 1;
          inspection.uninspectedCommandNames.push(commandName);
        }
      } else if (commandName === "sort") {
        if (!isPositivelyClassifiedSortCommand(words, commandIndex)) {
          inspection.uninspectedOtherRuntimeCount += 1;
          inspection.uninspectedCommandNames.push(commandName);
        }
      } else if (commandName === "sed") {
        if (!isPositivelyClassifiedSedCommand(words, commandIndex)) {
          inspection.uninspectedOtherRuntimeCount += 1;
          inspection.uninspectedCommandNames.push(commandName);
        }
      } else if (
        (commandName === "npm" || commandName === "pnpm" || commandName === "yarn")
        && packageManagerInvokesScriptRuntime(words, commandIndex)
      ) {
        inspection.uninspectedPackageScriptRuntimeCount += 1;
      } else if (commandName === "perl") {
        if (commandSetsPerlStartup || !isPositivelyClassifiedPerlCommand(words, commandIndex)) {
          inspection.uninspectedOtherRuntimeCount += 1;
          inspection.uninspectedCommandNames.push(commandName);
        }
      } else if (commandName === "shopt") {
        const lastpipeSetting = staticLastpipeShoptSetting(words, commandIndex);
        if (lastpipeSetting === null) {
          inspection.uninspectedOtherRuntimeCount += 1;
          inspection.uninspectedCommandNames.push(commandName);
        } else {
          runtimeShellState.lastpipe = lastpipeSetting;
        }
      } else if (FAIL_CLOSED_EXECUTABLE_RUNTIME_COMMANDS.has(commandName)) {
        inspection.uninspectedOtherRuntimeCount += 1;
        inspection.uninspectedCommandNames.push(commandName);
      } else if (isNestedShellCommandWord(commandName)) {
        const nestedIndex = findShellCommandStringArgIndex(words, commandIndex + 1);
        if (commandSetsShellStartup || nestedShellHasUnsafeStartup(words, commandIndex, index) || (nestedIndex === null && firstInterpreterScriptOperands(words, commandIndex).length === 0)) {
          inspection.uninspectedOtherRuntimeCount += 1;
          inspection.uninspectedCommandNames.push(commandName);
        }
      } else if (
        commandName
        && !CONDUCTOR_BASH_POSITIVELY_CLASSIFIED_COMMANDS.has(commandName)
        && !CONDUCTOR_BASH_MUTATION_COMMANDS.has(commandName)
        && !CONDUCTOR_BASH_DOWNLOADER_COMMANDS.has(commandName)
        && commandName !== "npm"
        && commandName !== "pnpm"
        && commandName !== "yarn"
        && !CONDUCTOR_BASH_MODELED_CURRENT_SHELL_BUILTINS.has(commandName)
        && !invokesDefinedShellFunction
      ) {
        inspection.uninspectedOtherRuntimeCount += 1;
        inspection.uninspectedCommandNames.push(commandName);
      }
      if (CONDUCTOR_BASH_MODELED_CURRENT_SHELL_BUILTINS.has(commandName)) {
        applyShellCwdStateEffect(words, commandIndex, runtimeShellState);
      }
      commandStart = false;
    }
    heredocBodyIndex += segmentHeredocCount;
  }
  for (const nested of runtimeFunctionScan.executions) {
    if (depth >= CONDUCTOR_BASH_MAX_NESTING_DEPTH) {
      inspection.uninspectedOtherRuntimeCount += 1;
      inspection.uninspectedCommandNames.push("bash");
      continue;
    }
    mergeConductorRuntimeExecutionInspection(
      inspection,
      inspectConductorRuntimeExecutions(nested.command, nested.cwd, depth + 1, nested.functions),
    );
  }
  return inspection;
}

function extractNodeInlineEvalScripts(command: string): string[] {
  return inspectConductorRuntimeExecutions(command).nodeInlineEvalScripts;
}

function extractNodeFsSemanticMutations(command: string): ConductorInterpreterWrite[] {
  const writes: ConductorInterpreterWrite[] = [];
  const pushAmbiguous = (): void => {
    writes.push({ runtime: "node", targets: [], unresolved: true });
  };

  for (const script of extractNodeInlineEvalScripts(command)) {
    if (/^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]+\})?$/.test(script.trim())) {
      pushAmbiguous();
      continue;
    }
    // The shell tokenizer yields the actual eval operand but intentionally does not
    // preserve quote provenance. Shell-parameter and backtick syntax inside that
    // operand is therefore ambiguous: it may be expanded before Node parses source.
    if (script.includes("`") || script.includes("$(") || /\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*(?::?[-+?=][^}]*)?\}/.test(script)) {
      pushAmbiguous();
      continue;
    }
    const lexical = maskJavaScriptStringsAndComments(script);
    const mask = lexical.mask;
    if (!lexical.valid) {
      pushAmbiguous();
      continue;
    }
    if (/\\u(?:[0-9A-Fa-f]{4}|\{[0-9A-Fa-f]+\})/.test(mask)) pushAmbiguous();
    if (/\b(?:eval|Function)\b/.test(mask)) pushAmbiguous();
    if (/\.\s*constructor\s*\(/.test(mask)) pushAmbiguous();
    if (/\bcreateRequire\s*\(/.test(mask)) pushAmbiguous();
    if (/\b(?:__proto__|_load)\b|\bmodule\s*\.\s*constructor\b|\bModule\s*\.\s*_load\b|\b(?:globalThis\s*\.\s*)?process\s*\.\s*(?:binding|dlopen)\b/.test(mask)) pushAmbiguous();
    for (const match of mask.matchAll(/\bObject\s*\.\s*getOwnPropertyDescriptor\s*\(/g)) {
      const openIndex = (match.index ?? 0) + match[0].lastIndexOf("(");
      const closeIndex = findMatchingJavaScriptParen(mask, openIndex);
      if (closeIndex < 0) {
        pushAmbiguous();
        continue;
      }
      const args = splitJavaScriptCallArguments(script, mask, openIndex, closeIndex);
      const receiver = (args[0] ?? "").replace(/\s+/g, "");
      const property = parseStaticJavaScriptString(args[1] ?? "");
      if ((receiver === "process" || receiver === "globalThis.process") && property === "getBuiltinModule") pushAmbiguous();
    }
    for (const match of mask.matchAll(/\brequire\b/g)) {
      const afterRequire = (match.index ?? 0) + safeString(match[0]).length;
      if (!/^\s*\(/.test(mask.slice(afterRequire))) pushAmbiguous();
    }
    for (const match of mask.matchAll(/\bgetBuiltinModule\b/g)) {
      const afterLoader = (match.index ?? 0) + safeString(match[0]).length;
      if (!/^\s*\(/.test(mask.slice(afterLoader))) pushAmbiguous();
    }
    for (const match of mask.matchAll(/\[/g)) {
      const openIndex = match.index ?? 0;
      if (!/[A-Za-z0-9_$)\]]\s*(?:\?\.)?\s*$/.test(mask.slice(0, openIndex))) continue;
      const closeIndex = findMatchingJavaScriptDelimiter(mask, openIndex, "[", "]");
      if (closeIndex < 0) continue;
      const computedMember = parseStaticJavaScriptString(script.slice(openIndex + 1, closeIndex));
      const receiver = /([A-Za-z_$][\w$]*)\s*$/.exec(mask.slice(0, openIndex))?.[1] ?? "";
      const invoked = /^\s*(?:\?\.)?\s*\(/.test(mask.slice(closeIndex + 1));
      if (
        computedMember !== null
        && NODE_REFLECTED_LOADER_MEMBER_NAMES.has(computedMember)
        && !(receiver === "Object" && computedMember === "getPrototypeOf")
        && (receiver === "module" || receiver === "process" || receiver === "globalThis" || invoked)
      ) pushAmbiguous();
    }
    for (const match of mask.matchAll(/\b(?:module|(?:globalThis\s*\.\s*)?process(?:\s*\.\s*mainModule)?)\s*\[/g)) {
      const openIndex = (match.index ?? 0) + match[0].lastIndexOf("[");
      const closeIndex = findMatchingJavaScriptDelimiter(mask, openIndex, "[", "]");
      if (closeIndex < 0) {
        pushAmbiguous();
        continue;
      }
      const computedMember = parseStaticJavaScriptString(script.slice(openIndex + 1, closeIndex));
      if (computedMember === null || NODE_REFLECTED_LOADER_MEMBER_NAMES.has(computedMember)) pushAmbiguous();
    }

    const fsBindings = new Set<string>();
    const directFunctionBindings = new Map<string, string>();
    const calls = new Map<number, { method: string; openIndex: number }>();
    const recognizedLoaderCloseIndexes = new Set<number>();
    const registerDestructuredBindings = (entries: string, separator: ":" | "as"): void => {
      for (const rawEntry of entries.split(",")) {
        const entry = rawEntry.trim();
        const parts = separator === ":" ? entry.split(":") : entry.split(/\s+as\s+/);
        const methodName = safeString(parts[0]).trim();
        const localName = safeString(parts[1] ?? methodName).trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(localName)) {
          pushAmbiguous();
          continue;
        }
        if (NODE_FS_MUTATION_METHODS.has(methodName) || NODE_FS_CONDITIONALLY_READ_ONLY_METHODS.has(methodName)) directFunctionBindings.set(localName, methodName);
        else if (!NODE_FS_READ_ONLY_METHODS.has(methodName)) pushAmbiguous();
      }
    };
    const loaderPattern = "(?:process\\.mainModule\\.require|module\\.require|require|import|(?:globalThis\\.)?process\\.getBuiltinModule)";
    const objectBindingPattern = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?${loaderPattern}\\s*\\(`, "g");
    for (const match of mask.matchAll(objectBindingPattern)) {
      const openIndex = (match.index ?? 0) + match[0].lastIndexOf("(");
      const closeIndex = findMatchingJavaScriptParen(mask, openIndex);
      if (closeIndex < 0) {
        pushAmbiguous();
        continue;
      }
      const moduleName = parseStaticJavaScriptString(script.slice(openIndex + 1, closeIndex));
      if (isNodeFsModuleName(moduleName)) {
        fsBindings.add(safeString(match[1]));
        recognizedLoaderCloseIndexes.add(closeIndex);
      } else if (moduleName === null || isNodeMutationCapableModuleName(moduleName)) pushAmbiguous();
    }
    const destructuredPattern = new RegExp(`\\b(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*(?:await\\s+)?${loaderPattern}\\s*\\(`, "g");
    for (const match of mask.matchAll(destructuredPattern)) {
      const openIndex = (match.index ?? 0) + match[0].lastIndexOf("(");
      const closeIndex = findMatchingJavaScriptParen(mask, openIndex);
      if (closeIndex < 0) {
        pushAmbiguous();
        continue;
      }
      const moduleName = parseStaticJavaScriptString(script.slice(openIndex + 1, closeIndex));
      if (isNodeFsModuleName(moduleName)) {
        registerDestructuredBindings(safeString(match[1]), ":");
        recognizedLoaderCloseIndexes.add(closeIndex);
      } else if (moduleName === null || isNodeMutationCapableModuleName(moduleName)) pushAmbiguous();
    }
    for (const match of mask.matchAll(/\bimport\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\b/g)) {
      const moduleLiteral = parseStaticJavaScriptStringAt(script, (match.index ?? 0) + match[0].length);
      const moduleName = moduleLiteral?.value ?? null;
      if (isNodeFsModuleName(moduleName)) fsBindings.add(safeString(match[1]));
      else if (isNodeMutationCapableModuleName(moduleName)) pushAmbiguous();
    }
    for (const match of mask.matchAll(/\bimport\s*\{([^}]*)\}\s*from\b/g)) {
      const moduleLiteral = parseStaticJavaScriptStringAt(script, (match.index ?? 0) + match[0].length);
      const moduleName = moduleLiteral?.value ?? null;
      if (isNodeFsModuleName(moduleName)) registerDestructuredBindings(safeString(match[1]), "as");
      else if (isNodeMutationCapableModuleName(moduleName)) pushAmbiguous();
    }

    const registerAccess = (method: string | null, callOpenIndex: number | null): void => {
      if (method === null) {
        pushAmbiguous();
        return;
      }
      if (NODE_FS_READ_ONLY_METHODS.has(method)) return;
      if (NODE_FS_CONDITIONALLY_READ_ONLY_METHODS.has(method) && callOpenIndex !== null) {
        calls.set(callOpenIndex, { method, openIndex: callOpenIndex });
        return;
      }
      if (!NODE_FS_MUTATION_METHODS.has(method) || callOpenIndex === null) {
        pushAmbiguous();
        return;
      }
      calls.set(callOpenIndex, { method, openIndex: callOpenIndex });
    };
    const inspectAccessTail = (tailStart: number): boolean => {
      const tail = mask.slice(tailStart);
      if (/^\s*\?\./.test(tail)) {
        pushAmbiguous();
        return true;
      }
      const dotMatch = /^\s*(?:\.\s*promises\s*)?\.\s*([A-Za-z_$][\w$]*)(\s*\()?/.exec(tail);
      if (dotMatch) {
        const method = safeString(dotMatch[1]);
        const callOpenIndex = dotMatch[2] ? tailStart + dotMatch[0].lastIndexOf("(") : null;
        registerAccess(method, callOpenIndex);
        return true;
      }
      const computedMatch = /^\s*(?:\.\s*promises\s*)?\[/.exec(tail);
      if (!computedMatch) return false;
      const openIndex = tailStart + computedMatch[0].lastIndexOf("[");
      const closeIndex = findMatchingJavaScriptDelimiter(mask, openIndex, "[", "]");
      if (closeIndex < 0) {
        pushAmbiguous();
        return true;
      }
      const method = parseStaticJavaScriptString(script.slice(openIndex + 1, closeIndex));
      const callMatch = /^\s*\(/.exec(mask.slice(closeIndex + 1));
      registerAccess(method, callMatch ? closeIndex + 1 + callMatch[0].lastIndexOf("(") : null);
      return true;
    };
    const directLoaderPattern = new RegExp(`\\b${loaderPattern}\\s*\\(`, "g");
    for (const match of mask.matchAll(directLoaderPattern)) {
      const openIndex = (match.index ?? 0) + match[0].lastIndexOf("(");
      const closeIndex = findMatchingJavaScriptParen(mask, openIndex);
      if (closeIndex < 0) {
        pushAmbiguous();
        continue;
      }
      const moduleName = parseStaticJavaScriptString(script.slice(openIndex + 1, closeIndex));
      if (isNodeFsModuleName(moduleName)) {
        const handled = inspectAccessTail(closeIndex + 1);
        if (!handled && !recognizedLoaderCloseIndexes.has(closeIndex)) pushAmbiguous();
      }
      else if (moduleName === null || isNodeMutationCapableModuleName(moduleName)) pushAmbiguous();
    }
    for (const binding of fsBindings) {
      const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const accessPattern = new RegExp(`\\b${escaped}\\s*(?:\\.\\s*promises\\s*)?(?:\\?\\.|\\.|\\[)`, "g");
      for (const match of mask.matchAll(accessPattern)) {
        const accessStart = match.index ?? 0;
        inspectAccessTail(accessStart + safeString(match[0]).indexOf(binding) + binding.length);
      }
      const referencePattern = new RegExp(`\\b${escaped}\\b`, "g");
      for (const match of mask.matchAll(referencePattern)) {
        const referenceIndex = match.index ?? 0;
        const afterBinding = referenceIndex + safeString(match[0]).length;
        const before = mask.slice(0, referenceIndex);
        const tail = mask.slice(afterBinding);
        const isDeclaration = /(?:\bconst|\blet|\bvar)\s+$/.test(before) && /^\s*=/.test(tail);
        const isStaticImport = /\bimport\s+(?:\*\s+as\s+)?$/.test(before) && /^\s+from\b/.test(tail);
        if (isDeclaration || isStaticImport || /^\s*(?:\?\.|\.|\[)/.test(tail)) continue;
        pushAmbiguous();
      }
    }
    for (const [binding, method] of directFunctionBindings) {
      const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const referencePattern = new RegExp(`\\b${escaped}\\b`, "g");
      for (const match of mask.matchAll(referencePattern)) {
        const referenceIndex = match.index ?? 0;
        const afterBinding = referenceIndex + safeString(match[0]).length;
        const before = mask.slice(0, referenceIndex);
        const tail = mask.slice(afterBinding);
        const isDestructuredDeclaration = /(?:\bconst|\blet|\bvar)\s*\{[^{}]*$/.test(before)
          && /^[^{}]*(?:,|\})/.test(tail);
        const isStaticImport = /\bimport\s*\{[^{}]*$/.test(before)
          && /^[^{}]*(?:,|\})/.test(tail);
        if (isDestructuredDeclaration || isStaticImport) continue;
        const callMatch = /^\s*\(/.exec(tail);
        if (callMatch) {
          const callOpenIndex = afterBinding + callMatch[0].lastIndexOf("(");
          calls.set(callOpenIndex, { method, openIndex: callOpenIndex });
          continue;
        }
        pushAmbiguous();
      }
    }
    for (const { method, openIndex } of calls.values()) {
      const closeIndex = findMatchingJavaScriptParen(mask, openIndex);
      if (closeIndex < 0) {
        pushAmbiguous();
        continue;
      }
      const args = splitJavaScriptCallArguments(script, mask, openIndex, closeIndex);
      if ((method === "open" || method === "openSync") && isReadOnlyNodeOpenFlags(parseStaticJavaScriptString(args[1] ?? ""))) continue;
      if (method === "createReadStream" && nodeCreateReadStreamHasReadOnlyOptions(script, mask, openIndex)) continue;
      const targetIndexes = NODE_FS_TWO_TARGET_MUTATION_METHODS.has(method) ? [0, 1] : [0];
      const targets = targetIndexes.map((index) => parseStaticJavaScriptString(args[index] ?? ""));
      writes.push({
        runtime: "node",
        targets: targets.filter((target): target is string => target !== null && target !== ""),
        unresolved: targets.some((target) => target === null || target === ""),
      });
    }
  }
  return writes;
}

function isPositivelyReadOnlyNodeInlineEval(script: string): boolean {
  if (script.includes("`") || script.includes("$(") || /\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*(?::?[-+?=][^}]*)?\}/.test(script)) return false;
  const lexical = maskJavaScriptStringsAndComments(script);
  if (!lexical.valid) return false;
  const mask = lexical.mask;
  if (/\\u(?:[0-9A-Fa-f]{4}|\{[0-9A-Fa-f]+\})/.test(mask)) return false;
  if (/\b(?:eval|Function|createRequire|global|globalThis|process|child_process)\b/.test(mask)) return false;
  if (/\.\s*constructor\b/.test(mask)) return false;
  if (/\bReflect\s*\.\s*apply\s*\(/.test(mask)) return false;
  if (/\bimport\s*(["'])/.test(script)) return false;

  for (const match of mask.matchAll(/\bReflect\s*\.\s*get\s*\(/g)) {
    const openIndex = (match.index ?? 0) + match[0].lastIndexOf("(");
    const closeIndex = findMatchingJavaScriptParen(mask, openIndex);
    if (closeIndex < 0 || /^\s*\(/.test(mask.slice(closeIndex + 1))) return false;
    const args = splitJavaScriptCallArguments(script, mask, openIndex, closeIndex);
    const receiver = (args[0] ?? "").trim();
    if (!/^(?:\{|\[)/.test(receiver) || parseStaticJavaScriptString(args[1] ?? "") === null || args.length !== 2) return false;
  }

  for (const match of script.matchAll(/\b([A-Za-z_$][\w$]*)\s*\[([\s\S]*?)\]\s*\(/g)) {
    const receiver = safeString(match[1]);
    const member = parseStaticJavaScriptString(safeString(match[2]));
    if (receiver !== "Object" || member !== "getPrototypeOf") return false;
  }

  for (const match of mask.matchAll(/\b([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g)) {
    const targetStart = match.index ?? 0;
    const target = safeString(match[1]).replace(/\s+/g, "");
    if (mask[targetStart - 1] === ".") {
      const before = script.slice(0, targetStart);
      const fsMethod = target.startsWith("promises.") ? target.slice("promises.".length) : target;
      const directFsReceiver = /\brequire\s*\(\s*(["'])(?:node:)?fs(?:\/promises)?\1\s*\)\s*(?:\.\s*promises\s*)?\.\s*$/.test(before);
      const directPathReceiver = /\brequire\s*\(\s*(["'])(?:node:)?path\1\s*\)\s*\.\s*$/.test(before);
      const directRegexReceiver = /\/(?:\\.|[^/\n])+\/[A-Za-z]*\s*\.\s*$/.test(before);
      if (directFsReceiver && fsMethod === "createReadStream") {
        const openIndex = targetStart + match[0].lastIndexOf("(");
        if (nodeCreateReadStreamHasReadOnlyOptions(script, mask, openIndex)) continue;
        return false;
      }
      if (directFsReceiver && (NODE_FS_READ_ONLY_METHODS.has(fsMethod) || fsMethod === "open" || fsMethod === "openSync")) continue;
      if (directPathReceiver && target === "join") continue;
      if (directRegexReceiver && target === "test") continue;
      return false;
    }
    if (target === "console.log" || target === "console.info" || target === "console.warn" || target === "console.error" || target === "console.dir" || target === "console.table" || target === "Object.getPrototypeOf" || target === "Reflect.get") continue;
    if (target === "require") {
      const openIndex = targetStart + match[0].lastIndexOf("(");
      const closeIndex = findMatchingJavaScriptParen(mask, openIndex);
      if (closeIndex < 0 || !["fs", "node:fs", "fs/promises", "node:fs/promises", "path", "node:path"].includes(parseStaticJavaScriptString(script.slice(openIndex + 1, closeIndex)) ?? "")) return false;
      continue;
    }
    const memberMatch = /^fs\.([A-Za-z_$][\w$]*)$/.exec(target);
    if (memberMatch && safeString(memberMatch[1]) === "createReadStream") {
      const openIndex = targetStart + match[0].lastIndexOf("(");
      if (nodeCreateReadStreamHasReadOnlyOptions(script, mask, openIndex)) continue;
      return false;
    }
    if (memberMatch && (NODE_FS_READ_ONLY_METHODS.has(safeString(memberMatch[1])) || memberMatch[1] === "open" || memberMatch[1] === "openSync")) continue;
    return false;
  }
  return true;
}
function maskPythonStringsAndComments(source: string): { mask: string; valid: boolean } {
  const chars = [...source];
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote !== null) {
      if (char !== "\n" && char !== "\r") chars[index] = " ";
      if (char === "\\") {
        index += 1;
        if (index < chars.length && chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "#") {
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
        chars[index] = " ";
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (char === "'" || char === '"') {
      chars[index] = " ";
      quote = char;
    }
  }
  return { mask: chars.join(""), valid: quote === null };
}

function isPositivelyModeledPythonSource(source: string): boolean {
  if (/(?:^|[^A-Za-z0-9_])(?:f|fr|rf)(?=["'])/i.test(source)) return false;
  for (const match of source.matchAll(/\bfrom\s+([A-Za-z_][\w.]*)\s+import\b/g)) {
    if (safeString(match[1]) !== "pathlib") return false;
  }
  for (const match of source.matchAll(/(?:^|[;\n])\s*import\s+([^;\n]+)/g)) {
    for (const entry of safeString(match[1]).split(",")) {
      const moduleName = entry.trim().split(/\s+as\s+/)[0] ?? "";
      if (moduleName !== "json" && moduleName !== "shutil") return false;
    }
  }
  const lexical = maskPythonStringsAndComments(source);
  if (!lexical.valid) return false;
  for (const match of lexical.mask.matchAll(/\bopen\s*\(/g)) {
    const openIndex = (match.index ?? 0) + match[0].lastIndexOf("(");
    const closeIndex = findMatchingJavaScriptParen(lexical.mask, openIndex);
    if (closeIndex < 0) return false;
    const args = splitJavaScriptCallArguments(source, lexical.mask, openIndex, closeIndex);
    const rawMode = safeString(args[1]).trim();
    if (!rawMode) continue;
    const modeExpression = rawMode.startsWith("mode=") ? rawMode.slice("mode=".length).trim() : rawMode;
    const mode = parseStaticJavaScriptString(modeExpression);
    if (mode === null || !/^r[bt]?$/.test(mode)) return false;
  }
  const allowedCalls = new Set([
    "Path",
    "open",
    "print",
    "json.dump",
    "json.dumps",
    "json.load",
    "json.loads",
    "shutil.copy",
    "shutil.copy2",
    "shutil.copyfile",
    "shutil.copytree",
    "shutil.move",
  ]);
  const allowedMethods = new Set(["mkdir", "write", "write_bytes", "write_text"]);
  for (const match of lexical.mask.matchAll(/\b([A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_][\w]*)*)\s*\(/g)) {
    const index = match.index ?? 0;
    const name = safeString(match[1]).replace(/\s+/g, "");
    if (lexical.mask[index - 1] === ".") {
      if (!allowedMethods.has(name)) return false;
      continue;
    }
    if (!allowedCalls.has(name)) return false;
  }
  return true;
}

function isPositivelyReadOnlyPythonInlineSource(source: string): boolean {
  const lexical = maskPythonStringsAndComments(source);
  if (!lexical.valid) return false;
  if (/\b(?:from|import|__import__|eval|exec|compile|breakpoint|globals|locals|getattr|setattr|delattr|open|Path|json|shutil)\b/.test(lexical.mask)) return false;
  return isPositivelyModeledPythonSource(source);
}


function classifyConductorExecutableRuntime(
  command: string,
  depth = 0,
  cwd?: string,
  inheritedShellFunctions: ReadonlyMap<string, string[]> = new Map(),
): string | null {
  const runtimeCwd = cwd ?? process.cwd();
  if (commandHasUnsafeConductorShellState(command, runtimeCwd)) {
    return "Bash nameref or allexport shell state cannot be statically validated";
  }
  if (hasUnresolvedShellArithmeticExpansion(command)) {
    return "Bash arithmetic expansion is not statically numeric and cannot be validated";
  }
  const runtimeFunctionScan = collectConductorStaticNestedBashExecutions(command, runtimeCwd, inheritedShellFunctions);
  const inspection = inspectConductorRuntimeExecutions(command, runtimeCwd, depth, inheritedShellFunctions);
  if (inspection.uninspectedNodeRuntimeCount > 0) {
    return "Bash Node runtime execution has no positively classified inline source";
  }
  if (inspection.uninspectedPythonRuntimeCount > 0) {
    return "Bash Python runtime execution has no positively classified source";
  }
  if (inspection.pythonSources.some((source) => (
    !isPositivelyReadOnlyPythonInlineSource(source)
    && !isPositivelyModeledPythonMetadataWriteSource(source, runtimeCwd)
  ))) {
    return "Bash Python runtime source is not positively classified as read-only or a modeled write";
  }
  if (inspection.uninspectedPackageScriptRuntimeCount > 0) {
    return "Bash package script runtime execution is not positively classified as read-only";
  }
  if (inspection.uninspectedOtherRuntimeCount > 0) {
    return `Bash executable runtime is not positively classified as read-only: ${inspection.uninspectedCommandNames.join(", ") || "<unknown>"}`;
  }
  if (inspection.nodeInlineEvalScripts.some((script) => !isPositivelyReadOnlyNodeInlineEval(script))) {
    return "Bash Node runtime source is not positively classified as read-only";
  }
  if (depth < CONDUCTOR_BASH_MAX_NESTING_DEPTH) {
    const inspectedNestedShellCommands = new Set(runtimeFunctionScan.executions.map((nested) => nested.command));
    for (const nested of extractNestedShellCommandStringsForStateScan(command)) {
      if (inspectedNestedShellCommands.has(nested)) continue;
      const nestedBlockedDetail = classifyConductorExecutableRuntime(nested, depth + 1, runtimeCwd, runtimeFunctionScan.functions);
      if (nestedBlockedDetail) return nestedBlockedDetail;
    }
    for (const nested of extractNestedCommandSubstitutionStringsForStateScan(command)) {
      const nestedBlockedDetail = classifyConductorExecutableRuntime(nested, depth + 1, runtimeCwd, runtimeFunctionScan.functions);
      if (nestedBlockedDetail) return nestedBlockedDetail;
    }
  }
  return null;
}


function extractConductorInterpreterWrites(command: string): ConductorInterpreterWrite[] {
  const writes: ConductorInterpreterWrite[] = [];
  const scanCommand = normalizeShellLineContinuations(command);
  writes.push(...extractNodeFsSemanticMutations(command));
  let recognizedPythonOpenWrites = 0;
  let recognizedPythonPathMutations = 0;
  let recognizedPythonShutilMutations = 0;
  let recognizedPythonOsSingleTargetMutations = 0;
  const pythonTarget = (value: unknown): { targets: string[]; unresolved: boolean } => {
    const target = safeString(value).trim();
    const unresolved = !target || target.includes("\\");
    return { targets: unresolved ? [] : [target], unresolved };
  };

  for (const match of scanCommand.matchAll(/\bpython3?\b[\s\S]{0,520}\bopen\s*\(\s*(["'])([^"']+)\1\s*,\s*(["'])([^"']*[wax+][^"']*)\3/g)) {
    const target = pythonTarget(match[2]);
    writes.push({ runtime: "python", ...target });
    recognizedPythonOpenWrites += 1;
  }
  for (const match of scanCommand.matchAll(/\bpython3?\b[\s\S]{0,520}\bos\s*\.\s*(?:remove|unlink|rmdir|removedirs|mkdir|makedirs|chmod|chown|truncate)\s*\(\s*(["'])([^"']+)\1/g)) {
    const target = pythonTarget(match[2]);
    writes.push({ runtime: "python", ...target });
    recognizedPythonOsSingleTargetMutations += 1;
  }
  for (const match of scanCommand.matchAll(/\bpython3?\b[\s\S]{0,520}\bPath\s*\(\s*(["'])([^"']+)\1\s*\)\s*\.\s*(?:write_text|write_bytes)\s*\(/g)) {
    const target = pythonTarget(match[2]);
    writes.push({ runtime: "python", ...target });
    recognizedPythonPathMutations += 1;
  }
  for (const match of scanCommand.matchAll(/\bpython3?\b[\s\S]{0,520}\bPath\s*\(\s*(["'])([^"']+)\1\s*\)\s*\.\s*mkdir\s*\(/g)) {
    const target = pythonTarget(match[2]);
    writes.push({ runtime: "python", ...target });
    recognizedPythonPathMutations += 1;
  }
  for (const match of scanCommand.matchAll(/\bpython3?\b[\s\S]{0,520}\bshutil\s*\.\s*(?:copyfile|copy|copy2|copytree|move)\s*\(\s*(["'])([^"']+)\1\s*,\s*(["'])([^"']+)\3/g)) {
    const target = pythonTarget(match[4]);
    writes.push({ runtime: "python", ...target });
    recognizedPythonShutilMutations += 1;
  }
  const hasPythonRuntime = /\bpython3?\b/.test(scanCommand);
  const pythonOpenWriteCalls = hasPythonRuntime
    ? [...scanCommand.matchAll(/\bopen\s*\([^\n;)]*,\s*["'][^"']*[wax+][^"']*["']/g)].length
    : 0;
  const pythonPathMutationCalls = hasPythonRuntime
    ? [...scanCommand.matchAll(/(?:^|[\n;])\s*(?:\([^\n;#]*\bPath\s*\([^\n;#]*\)[^\n;#]*\)|\bPath\s*\([^\n;#]*\))\s*\.\s*(?:write_text|write_bytes|mkdir)\s*\(/g)].length
    : 0;
  const pythonShutilMutationCalls = hasPythonRuntime
    ? [...scanCommand.matchAll(/\bshutil\s*\.\s*(?:copyfile|copy|copy2|copytree|move)\s*\(/g)].length
    : 0;
  const pythonOsSingleTargetMutationCalls = hasPythonRuntime
    ? [...scanCommand.matchAll(/\bos\s*\.\s*(?:remove|unlink|rmdir|removedirs|mkdir|makedirs|chmod|chown|truncate)\s*\(/g)].length
    : 0;
  if (
    pythonOpenWriteCalls > recognizedPythonOpenWrites
    || pythonPathMutationCalls > recognizedPythonPathMutations
    || pythonShutilMutationCalls > recognizedPythonShutilMutations
    || pythonOsSingleTargetMutationCalls > recognizedPythonOsSingleTargetMutations
  ) {
    writes.push({ runtime: "python", targets: [], unresolved: true });
  }

  return writes;
}

const MAX_CONDUCTOR_METADATA_COPY_BYTES = 16 * 1024 * 1024;

function conductorMetadataCopySourceIsFiniteRegular(cwd: string, rawPath: string): boolean {
  if (!rawPath || isUnresolvedVariableTarget(rawPath) || conductorPathnameExpansionIsAmbiguous(rawPath)) return false;
  try {
    const entry = lstatSync(isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath));
    return entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1 && entry.size <= MAX_CONDUCTOR_METADATA_COPY_BYTES;
  } catch {
    return false;
  }
}

function isPositivelyModeledPythonMetadataWriteSource(source: string, cwd: string): boolean {
  const lexical = maskPythonStringsAndComments(source);
  if (!lexical.valid) return false;
  let sawShutilImport = false;
  let copyCount = 0;
  let lineStart = 0;
  for (const rawLine of source.split("\n")) {
    const maskLine = lexical.mask.slice(lineStart, lineStart + rawLine.length);
    const statement = maskLine.trim();
    if (statement) {
      if (statement === "import shutil") {
        if (sawShutilImport) return false;
        sawShutilImport = true;
      } else {
        const copyMatch = /^shutil\s*\.\s*copyfile\s*\(/.exec(statement);
        if (!copyMatch) return false;
        const openIndex = lineStart + maskLine.indexOf("(");
        const closeIndex = findMatchingJavaScriptParen(lexical.mask, openIndex);
        if (openIndex < lineStart || closeIndex < 0 || lexical.mask.slice(closeIndex + 1, lineStart + rawLine.length).trim()) return false;
        const args = splitJavaScriptCallArguments(source, lexical.mask, openIndex, closeIndex);
        const sourcePath = parseStaticJavaScriptString(args[0] ?? "");
        const destinationPath = parseStaticJavaScriptString(args[1] ?? "");
        if (
          !sawShutilImport
          || args.length !== 2
          || !sourcePath
          || !destinationPath
          || !conductorMetadataCopySourceIsFiniteRegular(cwd, sourcePath)
          || !isAllowedConductorMetadataPath(cwd, destinationPath)
        ) return false;
        copyCount += 1;
      }
    }
    lineStart += rawLine.length + 1;
  }
  return sawShutilImport && copyCount > 0;
}

function hasUnresolvedConductorInterpreterWrite(command: string): boolean {
  return extractConductorInterpreterWrites(command).some((write) => write.unresolved || write.targets.length === 0);
}

function commandNameFromShellWord(word: string): string {
  const literal = shellWordLiteral(word);
  const base = literal.trim().split(/[\\/]/).pop() ?? literal.trim();
  return base.toLowerCase();
}

function isShellCommandSeparator(word: string): boolean {
  return word === "&&" || word === "||" || word === ";" || word === ";;" || word === ";&" || word === ";;&" || word === "&" || word === "|" || word === "|&";
}

function isShellGroupingSyntaxWord(word: string): boolean {
  return word === "(" || word === ")" || word === "{" || word === "}";
}

function isShellCommandTerminatorOrGroupClose(word: string): boolean {
  return isShellCommandSeparator(word) || word === ")" || word === "}";
}

function commandUsesTargetDirectoryOption(commandName: string): boolean {
  return commandName === "cp" || commandName === "mv" || commandName === "install" || commandName === "ln";
}
function isEnvironmentAssignmentWord(word: string): boolean {
  return isShellAssignmentWord(word);
}

function findSudoDispatchOperandIndex(words: string[], startIndex: number): number | null {
  for (let index = startIndex; index < words.length; index += 1) {
    const token = words[index] ?? "";
    if (!token || token === "--") continue;
    if (isShellAssignmentWord(token)) continue;
    if (
      token === "-u"
      || token === "--user"
      || token === "-g"
      || token === "--group"
      || token === "-h"
      || token === "--host"
      || token === "-p"
      || token === "--prompt"
      || token === "-C"
      || token === "--close-from"
    ) {
      index += 1;
      continue;
    }
    if (
      token.startsWith("--user=")
      || token.startsWith("--group=")
      || token.startsWith("--host=")
      || token.startsWith("--prompt=")
      || token.startsWith("--close-from=")
      || /^-[ughpC].+/.test(token)
    ) {
      continue;
    }
    if (token.startsWith("-")) continue;
    return index;
  }
  return null;
}

function findConductorWrapperOperandIndex(commandName: string, words: string[], startIndex: number): number | null | undefined {
  switch (commandName) {
    case "env":
      return findEnvDispatchOperandIndex(words, startIndex);
    case "command":
      return findCommandDispatchOperandIndex(words, startIndex);
    case "exec":
      return findExecDispatchOperandIndex(words, startIndex);
    case "sudo":
      return findSudoDispatchOperandIndex(words, startIndex);
    case "nohup":
      return findCommandDispatchOperandIndex(words, startIndex);
    case "setsid":
      return findCommandDispatchOperandIndex(words, startIndex);
    case "time":
      return findTimeDispatchOperandIndex(words, startIndex);
    case "timeout":
      return findTimeoutDispatchOperandIndex(words, startIndex);
    case "nice":
      return findNiceDispatchOperandIndex(words, startIndex);
    case "stdbuf":
      return findStdbufDispatchOperandIndex(words, startIndex);

    case "xargs":
      return findXargsDispatchOperandIndex(words, startIndex);
    case "coproc":
      return findCoprocDispatchOperandIndex(words, startIndex);
    default:
      return undefined;
  }
}

const CONDUCTOR_SHELL_BUILTIN_WRAPPERS = new Set(["command", "exec", "time", "coproc"]);

function conductorWrapperLayersAreTrusted(
  words: string[],
  commandStartIndex: number,
  commandIndex: number,
  state: ShellPosixState,
  rootCwd: string,
): boolean {
  let wrapperIndex = skipShellCommandPositionPrefixWords(words, commandStartIndex);
  let requiresExecutableIdentity = false;
  while (wrapperIndex < commandIndex) {
    const rawWrapperWord = words[wrapperIndex] ?? "";
    const wrapperWord = shellWordLiteral(rawWrapperWord);
    if (!wrapperWord || isEnvironmentAssignmentWord(wrapperWord)) {
      wrapperIndex += 1;
      continue;
    }
    const wrapperName = commandNameFromShellWord(wrapperWord);
    const operandIndex = findConductorWrapperOperandIndex(wrapperName, words, wrapperIndex + 1);
    if (operandIndex === undefined || operandIndex === null || operandIndex <= wrapperIndex) return false;
    const shellBuiltinWrapper = CONDUCTOR_SHELL_BUILTIN_WRAPPERS.has(wrapperName)
      && !conductorWordHasQuotedReservedProvenance(rawWrapperWord);
    if (shellBuiltinWrapper && !requiresExecutableIdentity) {
      if (wrapperWord !== wrapperName) return false;
    } else {
      const trusted = wrapperWord.includes("/")
        ? conductorSlashCommandIsTrusted(wrapperWord, state, rootCwd)
        : !conductorCommandPathMayResolveRepositoryExecutable(words, commandStartIndex, wrapperIndex, state, rootCwd);
      if (!trusted) return false;
    }
    requiresExecutableIdentity ||= !shellBuiltinWrapper || wrapperName === "command" || wrapperName === "exec";
    wrapperIndex = skipShellCommandPositionPrefixWords(words, operandIndex);
  }
  return wrapperIndex === commandIndex;
}

function collectConductorTimeOutputTargets(words: string[], commandStartIndex: number): string[] | null | undefined {
  let wrapperIndex = commandStartIndex;
  while (wrapperIndex < words.length) {
    const wrapperName = commandNameFromShellWord(words[wrapperIndex] ?? "");
    if (wrapperName === "time") {
      const invocation = parseConductorTimeInvocation(words, wrapperIndex + 1);
      if (invocation === null) return null;
      return invocation.outputTarget === undefined ? [] : [invocation.outputTarget];
    }
    const operandIndex = findConductorWrapperOperandIndex(wrapperName, words, wrapperIndex + 1);
    if (operandIndex === undefined || operandIndex === null || operandIndex <= wrapperIndex) return undefined;
    wrapperIndex = skipShellCommandPositionPrefixWords(words, operandIndex);
  }
  return undefined;
}

function isConductorDestinationOnlyMutationCommand(commandName: string): boolean {
  return commandName === "cp" || commandName === "install" || commandName === "ln";
}

function isConductorReferenceTargetModeCommand(commandName: string): boolean {
  return commandName === "chmod" || commandName === "chown" || commandName === "chgrp";
}

function collectConductorSafeReferenceControlTargets(
  commandName: string,
  words: string[],
  commandIndex: number,
  cwd: string,
  posixlyCorrect = false,
): string[] | null {
  if (!isConductorReferenceTargetModeCommand(commandName)) return null;
  let reference: string | null = null;
  const targets: string[] = [];
  let optionsTerminated = false;
  const invocationWords = collectConductorInvocationWords(words, commandIndex);
  for (let index = 0; index < invocationWords.length; index += 1) {
    const rawWord = invocationWords[index] ?? "";
    const word = shellWordLiteral(rawWord);
    if (!word || shellWordMayProduceWgetOptions(word)) return null;
    if (!optionsTerminated && word === "--") {
      optionsTerminated = true;
      continue;
    }
    if (!optionsTerminated && word === "--reference") {
      const rawValue = invocationWords[index + 1] ?? "";
      const value = shellWordLiteral(rawValue);
      if (!value || shellWordMayProduceWgetOptions(value) || reference !== null) return null;
      reference = value;
      index += 1;
      continue;
    }
    if (!optionsTerminated && word.startsWith("--reference=")) {
      const value = word.slice("--reference=".length);
      if (!value || shellWordMayProduceWgetOptions(value) || reference !== null) return null;
      reference = value;
      continue;
    }
    if (!optionsTerminated && word.startsWith("-")) return null;
    targets.push(word);
    if (posixlyCorrect) optionsTerminated = true;
  }
  if (reference === null || targets.length === 0) return null;
  if (!isAllowedConductorMetadataSourcePath(cwd, reference)) return null;
  if (targets.some((target) => !isAllowedConductorMetadataPath(cwd, target))) return null;
  for (const path of [reference, ...targets]) {
    try {
      const effectivePath = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
      const entry = lstatSync(effectivePath);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) return null;
    } catch {
      return null;
    }
  }
  return targets;
}

function conductorMutationUsesUnsafeOption(commandName: string, words: string[], commandIndex: number): boolean {
  if (!new Set(["install", "mv", "ln"]).has(commandName)) return false;
  const permittedLong = commandName === "install"
    ? new Set(["--directory", "--target-directory", "--mode", "--owner", "--group"])
    : commandName === "ln"
      ? new Set(["--target-directory", "--symbolic"])
      : new Set(["--target-directory"]);
  const permittedShort = commandName === "install"
    ? new Set(["-d", "-t", "-m", "-o", "-g"])
    : commandName === "ln"
      ? new Set(["-t", "-s"])
      : new Set(["-t"]);
  let optionsTerminated = false;
  for (const rawWord of collectConductorInvocationWords(words, commandIndex)) {
    const word = shellWordLiteral(rawWord);
    if (word === "--") {
      optionsTerminated = true;
      continue;
    }
    if (optionsTerminated || !word.startsWith("-") || word === "-") continue;
    const option = word.split("=", 1)[0] ?? "";
    if (word.startsWith("--")) {
      if (!permittedLong.has(option)) return true;
      continue;
    }
    if (!permittedShort.has(word) && !(word.startsWith("-t") && word.length > 2)) return true;
  }
  return false;
}


function isConductorInstallDirectoryMode(words: string[], commandIndex: number): boolean {
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word || isShellCommandTerminatorOrGroupClose(word)) break;
    if (word === "-d" || word === "--directory") return true;
    if (word.startsWith("-") && !word.startsWith("--") && word.includes("d")) return true;
  }
  return false;
}

function shellWordMayProduceWgetOptions(word: string): boolean {
  if (isDynamicNestedCommandString(word)) return true;
  const staticExpansionMarkersRemoved = word.replace(/\$CONDUCTOR_(?:ARITH|PARAMETER)_ASSIGN_[A-Za-z_][A-Za-z0-9_]*_(?:SET|APPEND|DYNAMIC)_[A-Za-z0-9_./-]+/g, "");
  if (/(?:^|[^\\])\$(?:\{?[A-Za-z_][A-Za-z0-9_]*\}?|[0-9@*#?$!_-])/.test(staticExpansionMarkersRemoved)) return true;
  if (/(?:^|[^\\])[<>]\(/.test(word)) return true;
  if (!word.includes("://") && (
    /(?:^|[^\\])[*?]/.test(word)
    || /(?:^|[^\\])\[[^\]]*\]/.test(word)
    || /(?:^|[^\\])\{[^}]*,[^}]*\}/.test(word)
  )) return true;
  return false;
}

interface ConductorWgetStartupOptions {
  noConfig: boolean;
  noHsts: boolean;
}

function parseConductorWgetStartupOptions(words: string[], commandIndex: number): ConductorWgetStartupOptions | null {
  const args = collectConductorInvocationWords(words, commandIndex);
  const options: ConductorWgetStartupOptions = {
    noConfig: shellWordLiteral(args[0] ?? "") === "--no-config",
    noHsts: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const word = shellWordLiteral(args[index] ?? "");
    if (!word || shellWordMayProduceWgetOptions(word) || word === "--" || !word.startsWith("-")) break;
    if (word === "--no-hsts") {
      options.noHsts = true;
      continue;
    }
    if (word.startsWith("--")) {
      const name = word.split("=", 1)[0] ?? "";
      if (CONDUCTOR_WGET_LONG_VALUE_OPTIONS.has(name) && !word.includes("=")) {
        const value = shellWordLiteral(args[index + 1] ?? "");
        if (!value || shellWordMayProduceWgetOptions(value)) return null;
        index += 1;
      }
      continue;
    }
    if (wgetShortClusterConsumesNextValue(word)) {
      const value = shellWordLiteral(args[index + 1] ?? "");
      if (!value || shellWordMayProduceWgetOptions(value)) return null;
      index += 1;
    }
  }
  return options;
}

function wgetStartupOptionIsEffective(
  words: string[],
  commandIndex: number,
  option: "--no-config" | "--no-hsts",
  posixlyCorrect: boolean,
): boolean {
  void posixlyCorrect;
  const options = parseConductorWgetStartupOptions(words, commandIndex);
  return options !== null && (option === "--no-config" ? options.noConfig : options.noHsts);
}

function wgetStartupConfigurationIsUnresolved(
  words: string[],
  commandStartIndex: number,
  commandIndex: number,
  state: ShellPosixState,
  posixlyCorrect: boolean,
): boolean {
  void commandStartIndex;
  void state;
  void posixlyCorrect;
  const options = parseConductorWgetStartupOptions(words, commandIndex);
  return options === null || !options.noConfig || !options.noHsts;
}

// Bounded delays/retries keep a read-only transfer from becoming an unbounded execution surface.
const CONDUCTOR_WGET_FINITE_SCALAR_CEILINGS = new Map([
  ["tries", 10],
  ["timeout", 60],
  ["connecttimeout", 60],
  ["dnstimeout", 60],
  ["readtimeout", 60],
  ["wait", 60],
  ["waitretry", 60],
]);
const CONDUCTOR_WGET_UNSAFE_SHORT_OPTIONS = new Set(["r", "m", "p", "k", "E", "x", "H", "i"]);

function wgetFiniteScalarIsSafe(name: string, value: string): boolean {
  const ceiling = CONDUCTOR_WGET_FINITE_SCALAR_CEILINGS.get(name);
  if (ceiling === undefined || !/^[1-9][0-9]*$/.test(value)) return false;
  const numericValue = Number(value);
  return Number.isSafeInteger(numericValue) && numericValue <= ceiling;
}

function wgetInvocationHasUnsafeFiniteTransferMode(words: string[], commandIndex: number): boolean {
  const unsafeLongOptions = new Set([
    "--recursive", "--mirror", "--page-requisites", "--convert-links", "--html-extension", "--force-html",
    "--timestamping", "--no-host-directories", "--span-hosts", "--retr-symlinks", "--warc-file", "--warc-cdx",
    "--save-cookies", "--hsts-file", "--input-file", "--delete-after",
  ]);
  const scalarLongOptions = new Map([
    ["--tries", "tries"],
    ["--timeout", "timeout"],
    ["--connect-timeout", "connecttimeout"],
    ["--dns-timeout", "dnstimeout"],
    ["--read-timeout", "readtimeout"],
    ["--wait", "wait"],
    ["--waitretry", "waitretry"],
  ]);
  const scalarShortOptions = new Map([
    ["t", "tries"],
    ["T", "timeout"],
    ["w", "wait"],
  ]);
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const rawWord = words[index] ?? "";
    if (isShellCommandTerminatorOrGroupClose(rawWord)) break;
    const word = shellWordLiteral(rawWord);
    if (!word || shellWordMayProduceWgetOptions(word)) return true;
    if (word === "--") return false;
    if (word.startsWith("--")) {
      const separator = word.indexOf("=");
      const option = separator < 0 ? word : word.slice(0, separator);
      if (unsafeLongOptions.has(option)) return true;
      if (option === "--execute") {
        const value = separator < 0 ? shellWordLiteral(words[index + 1] ?? "") : word.slice(separator + 1);
        if (parseConductorWgetExecuteTargets(value) === null) return true;
        if (separator < 0) index += 1;
        continue;
      }
      const scalarName = scalarLongOptions.get(option);
      if (scalarName !== undefined) {
        const value = separator < 0 ? shellWordLiteral(words[index + 1] ?? "") : word.slice(separator + 1);
        if (!wgetFiniteScalarIsSafe(scalarName, value)) return true;
        if (separator < 0) index += 1;
      }
      continue;
    }
    if (!word.startsWith("-")) continue;
    const options = word.slice(1);
    for (let optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
      const option = options[optionIndex] ?? "";
      if (CONDUCTOR_WGET_UNSAFE_SHORT_OPTIONS.has(option)) return true;
      if (option === "e") {
        const attached = options.slice(optionIndex + 1);
        const value = attached || shellWordLiteral(words[index + 1] ?? "");
        if (parseConductorWgetExecuteTargets(value) === null) return true;
        if (!attached) index += 1;
        break;
      }
      const scalarName = scalarShortOptions.get(option);
      if (scalarName === undefined) continue;
      const attached = options.slice(optionIndex + 1);
      const value = attached || shellWordLiteral(words[index + 1] ?? "");
      if (!wgetFiniteScalarIsSafe(scalarName, value)) return true;
      if (!attached) index += 1;
      break;
    }
  }
  return false;
}

function downloaderHasUnsafeTlsKeyLogEnvironment(
  words: string[],
  commandStartIndex: number,
  commandIndex: number,
  state: ShellPosixState,
): boolean {
  const clearBoundary = nestedExecEnvironmentClearBoundary(words, commandStartIndex, commandIndex);
  const inherited = getConductorShellBinding(state, "SSLKEYLOGFILE");
  let unsafe = clearBoundary === null
    && inherited.exported
    && (inherited.value === CONDUCTOR_UNKNOWN_SHELL_BINDING || safeString(inherited.value).trim() !== "");
  for (let index = clearBoundary === null ? commandStartIndex : clearBoundary + 1; index < commandIndex; index += 1) {
    const word = words[index] ?? "";
    const assignment = parseShellAssignmentWord(word);
    if (assignment?.name === "SSLKEYLOGFILE") {
      unsafe = assignment.append || /[$`]/.test(assignment.value) || assignment.value.trim() !== "";
      continue;
    }
    const commandName = commandNameFromShellWord(word);
    if (commandName === "unset") {
      if (collectConductorInvocationWords(words, index).some((operand) => shellWordLiteral(operand) === "SSLKEYLOGFILE")) unsafe = false;
      continue;
    }
    if (commandName !== "env") continue;
    const operands = collectConductorInvocationWords(words, index);
    for (let operandIndex = 0; operandIndex < operands.length; operandIndex += 1) {
      const operand = shellWordLiteral(operands[operandIndex] ?? "");
      const unsetName = operand === "-u" || operand === "--unset"
        ? shellWordLiteral(operands[operandIndex + 1] ?? "")
        : operand.startsWith("--unset=")
          ? operand.slice("--unset=".length)
          : /^-u.+/.test(operand)
            ? operand.slice(2)
            : "";
      if (unsetName === "SSLKEYLOGFILE") unsafe = false;
      if (operand === "-u" || operand === "--unset") operandIndex += 1;
    }
  }
  return unsafe;
}

function parseConductorWgetExecuteTargets(value: string): { kind: "output" | "log" | "directory" | "auxiliary"; target: string }[] | null {
  const directive = /^\s*([A-Za-z][A-Za-z_-]*)\s*=\s*(.*?)\s*$/.exec(value);
  if (!directive || /[`$\0\r\n]/.test(value)) return null;
  const name = (directive[1] ?? "").replace(/[-_]/g, "").toLowerCase();
  const target = directive[2] ?? "";
  if (name === "outputdocument") return target ? [{ kind: "output", target }] : null;
  if (name === "dirprefix" || name === "directoryprefix") return target ? [{ kind: "directory", target }] : null;
  if (new Set(["logfile", "outputfile", "appendoutput"]).has(name)) return target ? [{ kind: "log", target }] : null;
  if (new Set(["savecookies", "warcfile", "warccdx", "rejectedlog", "hstsfile"]).has(name)) {
    return target ? [{ kind: "auxiliary", target }] : null;
  }
  if (CONDUCTOR_WGET_FINITE_SCALAR_CEILINGS.has(name)) {
    return wgetFiniteScalarIsSafe(name, target) ? [] : null;
  }
  if (new Set(["useragent", "referer"]).has(name)) return [];
  return null;
}

function parseConductorWgetShortOptionCluster(
  word: string,
  nextWord: string | undefined,
): { kind: "output" | "log" | "directory" | "execute"; value: string | null; consumeNext: boolean } | "safe" | "unknown" | null {
  if (!/^-[^-]+$/.test(word)) return null;
  const options = word.slice(1);
  const standalone = new Set("qvdcNb46Vh?SkEprnxH");
  const valueOptions = new Set("tTUiIXDARwWQBl");
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index] ?? "";
    if (standalone.has(option)) continue;
    const kind = option === "O" ? "output" : option === "o" || option === "a" ? "log" : option === "P" ? "directory" : option === "e" ? "execute" : null;
    if (kind !== null) {
      const attached = options.slice(index + 1);
      const value = attached || nextWord;
      return { kind, value: value?.trim() || null, consumeNext: attached.length === 0 };
    }
    if (valueOptions.has(option)) return "safe";
    return "unknown";
  }
  return "safe";
}
function wgetShortClusterConsumesNextValue(word: string): boolean {
  if (!/^-[^-]+$/.test(word)) return false;
  const options = word.slice(1);
  const valueOptions = new Set("tTUiIXDARwWQBl");
  for (let index = 0; index < options.length; index += 1) {
    if (valueOptions.has(options[index] ?? "")) return index === options.length - 1;
  }
  return false;
}


const CONDUCTOR_WGET_LONG_VALUE_OPTIONS = new Set([
  "--accept", "--reject", "--accept-regex", "--reject-regex", "--base", "--bind-address", "--body-data", "--body-file", "--certificate", "--certificate-type", "--ca-certificate", "--ca-directory", "--ciphers", "--connect-timeout", "--cut-dirs", "--default-page", "--directory-prefix", "--dns-timeout", "--domains", "--exclude-directories", "--exclude-domains", "--execute", "--ftp-password", "--ftp-user", "--header", "--hsts-file", "--http-password", "--http-user", "--ignore-tags", "--include-directories", "--input-file", "--limit-rate", "--load-cookies", "--local-encoding", "--max-redirect", "--method", "--output-document", "--output-file", "--append-output", "--post-data", "--post-file", "--private-key", "--private-key-type", "--progress", "--protocol-directories", "--proxy", "--proxy-password", "--proxy-user", "--read-timeout", "--referer", "--rejected-log", "--restrict-file-names", "--retry-on-http-error", "--save-cookies", "--secure-protocol", "--timeout", "--tries", "--user", "--user-agent", "--wait", "--waitretry", "--warc-file", "--warc-header", "--warc-max-size", "--warc-tempdir",
]);
const CONDUCTOR_WGET_LONG_STANDALONE_OPTIONS = new Set([
  "--cache", "--check-certificate", "--clobber", "--continue", "--convert-links", "--debug", "--delete-after", "--force-html", "--help", "--html-extension", "--ignore-case", "--inet4-only", "--inet6-only", "--keep-session-cookies", "--mirror", "--no-check-certificate", "--no-clobber", "--no-cookies", "--no-host-directories", "--no-hsts", "--no-parent", "--no-proxy", "--no-verbose", "--page-requisites", "--quiet", "--recursive", "--retr-symlinks", "--server-response", "--show-progress", "--span-hosts", "--strict-comments", "--timestamping", "--verbose", "--version", "--warc-cdx",
]);

function parseCurlWriteOutTargets(format: string): string[] | null {
  if (format.startsWith("@") || /[$`\0\r\n]/.test(format)) return null;
  const targets: string[] = [];
  let cursor = 0;
  while (cursor < format.length) {
    const outputStart = format.indexOf("%output", cursor);
    if (outputStart < 0) return targets;
    if (format.slice(outputStart, outputStart + 8) !== "%output{") return null;
    const outputEnd = format.indexOf("}", outputStart + 8);
    if (outputEnd < 0) return null;
    let target = format.slice(outputStart + 8, outputEnd);
    if (target.startsWith(">>")) target = target.slice(2);
    if (!target || target.startsWith("@") || /[$`\0\r\n]/.test(target)) return null;
    targets.push(target);
    cursor = outputEnd + 1;
  }
  return targets;
}

const CONDUCTOR_CURL_GLOB_CARDINALITY_CEILING = 32;

function curlUrlGlobCaptureValues(url: string): string[][] | null {
  if (/[$`\\\0\r\n]/.test(url)) return null;
  const captures: string[][] = [];
  let cardinality = 1;
  for (let index = 0; index < url.length; index += 1) {
    const delimiter = url[index] ?? "";
    if (delimiter !== "[" && delimiter !== "{") continue;
    const closing = delimiter === "[" ? "]" : "}";
    const end = url.indexOf(closing, index + 1);
    if (end < 0) return null;
    const capture = url.slice(index + 1, end);
    let values: string[];
    if (delimiter === "{") {
      values = capture.split(",");
      if (values.length === 0 || values.length > 16 || values.some((value) => !/^[A-Za-z0-9_-]+$/.test(value))) return null;
    } else {
      const range = /^([A-Za-z0-9])-([A-Za-z0-9])$/.exec(capture);
      if (range) {
        const start = range[1] ?? "";
        const finish = range[2] ?? "";
        const compatible = (/[0-9]/.test(start) && /[0-9]/.test(finish))
          || (/[a-z]/.test(start) && /[a-z]/.test(finish))
          || (/[A-Z]/.test(start) && /[A-Z]/.test(finish));
        const span = finish.charCodeAt(0) - start.charCodeAt(0);
        if (!compatible || span < 0 || span > 31) return null;
        values = Array.from({ length: span + 1 }, (_, offset) => String.fromCharCode(start.charCodeAt(0) + offset));
      } else {
        if (!/^[A-Za-z0-9]+$/.test(capture) || capture.length > 16) return null;
        values = [...capture];
      }
    }
    if (values.length === 0 || cardinality > Math.floor(CONDUCTOR_CURL_GLOB_CARDINALITY_CEILING / values.length)) return null;
    cardinality *= values.length;
    captures.push(values);
    if (captures.length > 4) return null;
    index = end;
  }
  return captures.length === 0 ? null : captures;
}

const CONDUCTOR_CURL_LONG_VALUE_OPTIONS = new Set([
  "--append-output", "--alt-svc", "--cookie-jar", "--dump-header", "--etag-save", "--header", "--hsts", "--libcurl",
  "--output", "--output-dir", "--proxy-header", "--request", "--ssl-sessions", "--stderr", "--trace", "--trace-ascii",
  "--write-out", "--write-out-file",
]);
const CONDUCTOR_CURL_LONG_STANDALONE_OPTIONS = new Set([
  "--create-dirs", "--disable", "--fail", "--get", "--head", "--insecure", "--location", "--remote-name", "--remote-name-all",
  "--show-error", "--silent", "--verbose",
]);
const CONDUCTOR_CURL_SHORT_VALUE_OPTIONS = new Set(["A", "b", "c", "C", "d", "D", "e", "E", "F", "H", "h", "K", "m", "M", "o", "P", "Q", "r", "T", "u", "w", "x", "X", "y", "Y", "z"]);

function collectConductorStaticReadOnlyDownloadUrls(
  commandName: "curl" | "wget",
  words: string[],
  startIndex: number,
  endIndex: number,
  wgetPosixlyCorrect = false,
): string[] | null {
  const urls: string[] = [];
  let optionsTerminated = false;
  for (let index = startIndex; index < endIndex; index += 1) {
    const rawWord = words[index] ?? "";
    if (isShellCommandTerminatorOrGroupClose(rawWord)) break;
    const word = shellWordLiteral(rawWord);
    if (!word || /[$`]/.test(word)) return null;
    if (!optionsTerminated && word === "--") {
      optionsTerminated = true;
      continue;
    }
    if (!optionsTerminated && commandName === "curl" && word === "--next") return null;
    if (!optionsTerminated && word.startsWith("--")) {
      const separator = word.indexOf("=");
      const option = separator < 0 ? word : word.slice(0, separator);
      const longValueOptions = commandName === "curl" ? CONDUCTOR_CURL_LONG_VALUE_OPTIONS : CONDUCTOR_WGET_LONG_VALUE_OPTIONS;
      const standaloneOptions = commandName === "curl" ? CONDUCTOR_CURL_LONG_STANDALONE_OPTIONS : CONDUCTOR_WGET_LONG_STANDALONE_OPTIONS;
      if (commandName === "wget" && (option === "--no-config" || option === "--spider")) continue;
      if (commandName === "wget" && option === "--input-file") return null;
      if (!longValueOptions.has(option) && !standaloneOptions.has(option)) return null;
      if (longValueOptions.has(option) && separator < 0) {
        const value = shellWordLiteral(words[index + 1] ?? "");
        if (!value || /[$`]/.test(value) || index + 1 >= endIndex) return null;
        index += 1;
      }
      continue;
    }
    if (!optionsTerminated && word.startsWith("-")) {
      if (commandName === "wget") {
        if (/^-[^-]*i/.test(word)) return null;
        const cluster = parseConductorWgetShortOptionCluster(word, words[index + 1]);
        if (cluster === "unknown") return null;
        if (cluster && cluster !== "safe") {
          if (cluster.value === null) return null;
          if (cluster.consumeNext) {
            if (index + 1 >= endIndex) return null;
            index += 1;
          }
          continue;
        }
        if (cluster === "safe" && wgetShortClusterConsumesNextValue(word)) {
          if (index + 1 >= endIndex) return null;
          index += 1;
        }
        continue;
      }
      const options = word.slice(1);
      for (let optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
        const option = options[optionIndex] ?? "";
        if (!CONDUCTOR_CURL_SHORT_VALUE_OPTIONS.has(option)) continue;
        if (optionIndex === options.length - 1) {
          if (index + 1 >= endIndex) return null;
          index += 1;
        }
        break;
      }
      continue;
    }
    urls.push(word);
    if (commandName === "wget" && wgetPosixlyCorrect) optionsTerminated = true;
  }
  if (urls.length !== 1) return null;
  const url = urls[0] ?? "";
  if (!/^https?:\/\//i.test(url) || /[$`\\\0#]/.test(url)) return null;
  if (commandName === "curl" && /[\[\]{}]/.test(url) && curlUrlGlobCaptureValues(url) === null) return null;
  if (commandName === "wget" && /[\[\]{}]/.test(url)) return null;
  return urls;
}

function staticConductorDownloadLeaf(
  commandName: "curl" | "wget",
  words: string[],
  startIndex: number,
  endIndex: number,
  wgetPosixlyCorrect = false,
): string | null {
  const url = collectConductorStaticReadOnlyDownloadUrls(commandName, words, startIndex, endIndex, wgetPosixlyCorrect)?.[0];
  if (!url) return null;
  const pathname = url.replace(/^https?:\/\/[^/]+/i, "").split("?", 1)[0] ?? "";
  if (!pathname || pathname.endsWith("/")) return null;
  const leaf = pathname.split("/").filter(Boolean).at(-1) ?? "";
  return /^[A-Za-z0-9._-]+$/.test(leaf) ? leaf : null;
}

function curlTransferEndIndex(words: string[], startIndex: number): number {
  for (let index = startIndex; index < words.length; index += 1) {
    if (words[index] === "--next" || isShellCommandTerminatorOrGroupClose(words[index] ?? "")) return index;
  }
  return words.length;
}

function curlOutputTargetTemplateLeaves(target: string, words: string[], transferStartIndex: number): string[] | null {
  if (!target || /[$`\0\r\n]/.test(target)) return null;
  const placeholders = [...target.matchAll(/#([1-9])/g)].map((match) => Number(match[1] ?? "0"));
  if (placeholders.length === 0) return [target];
  const transferEndIndex = curlTransferEndIndex(words, transferStartIndex);
  const urls = collectConductorStaticReadOnlyDownloadUrls("curl", words, transferStartIndex, transferEndIndex);
  if (urls === null) return null;
  const captures = curlUrlGlobCaptureValues(urls[0] ?? "");
  if (captures === null || placeholders.some((placeholder) => captures.length < placeholder)) return null;
  const combinations = captures.reduce<string[][]>((product, values) => (
    product.flatMap((prefix) => values.map((value) => [...prefix, value]))
  ), [[]]);
  if (combinations.length === 0 || combinations.length > 32) return null;
  const leaves = new Set<string>();
  for (const values of combinations) {
    const leaf = target.replace(/#([1-9])/g, (_match, rawIndex: string) => values[Number(rawIndex) - 1] ?? "");
    if (!leaf || /#([1-9])/.test(leaf)) return null;
    leaves.add(leaf);
  }
  return [...leaves];
}

function curlCommandHasUnsafeShellExpandedWord(command: string): boolean {
  const unescaped = stripHeredocBodiesForCommandScan(command).replace(/\\./g, "");
  for (const match of unescaped.matchAll(/\bcurl\b([^;\n]*)/g)) {
    const args = match[1] ?? "";
    if (/(?:^|\s)(?:-o|--output(?:=|\s+)|--output-dir(?:=|\s+))(?!['"])[^\s]*[*?{\[]/.test(args)) return true;
    if (/(?:^|\s)https?:\/\/[^\s'"]*[{\[]/.test(args)) return true;
  }
  return false;
}

function conductorCurlOutputLeavesAreSafe(targets: string[], cwd: string): boolean {
  return targets.every((target) => {
    if (shellWordMayProduceWgetOptions(target)) return false;
    if (target === "-") return true;
    try {
      const entry = lstatSync(isAbsolute(target) ? resolve(target) : resolve(cwd, target));
      return !entry.isSymbolicLink() && !entry.isDirectory();
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  });
}

function curlHeaderOverridesRequestMethod(value: string): boolean {
  return /^\s*x-(?:http-)?method(?:-override)?\s*:/i.test(shellWordLiteral(value));
}

function curlRequestMethodIsReadOnly(value: string): boolean {
  return value === "GET" || value === "HEAD";
}

function curlShortOptionClusterContains(word: string, controls: ReadonlySet<string>): boolean {
  return /^-[^-]+$/.test(word) && [...word.slice(1)].some((option) => controls.has(option));
}

const CURL_SHORT_MUTATION_OPTIONS = new Set(["d", "F", "T"]);
const CURL_SHORT_QUOTE_OPTIONS = new Set(["Q"]);


function curlRequestOptionMutates(word: string): boolean {
  return /^--(?:data(?:-ascii|-binary|-raw|-urlencode)?|form(?:-string)?|json|upload-file|post(?:301|302|303)?)(?:=|$)/.test(word)
    || curlShortOptionClusterContains(word, CURL_SHORT_MUTATION_OPTIONS);
}

function curlQuoteControlIsUnsafe(word: string): boolean {
  return /^(?:--(?:quote|prequote|postquote)(?:=|$))/.test(word)
    || curlShortOptionClusterContains(word, CURL_SHORT_QUOTE_OPTIONS);
}


function curlUnknownRequestControlIsUnsafe(word: string): boolean {
  return /^--(?:request|method|http-method)(?:=|-|$)/.test(word) && !/^--request(?:=|$)/.test(word);
}

function curlRemoteHeaderNameIsUnsafe(word: string): boolean {
  return /^--remote-header-name(?:=|$)/.test(word)
    || /^-[^-]*J/.test(word);
}

function wgetRequestOptionMutates(option: string): boolean {
  return new Set(["--post-data", "--post-file", "--body-data", "--body-file"]).has(option);
}

function curlCommandDisablesStartupConfiguration(words: string[], commandIndex: number): boolean {
  const firstArgument = shellWordLiteral(words[commandIndex + 1] ?? "");
  return firstArgument === "-q" || firstArgument === "--disable";
}

function parseConductorCurlShortOptionCluster(
  word: string,
  nextWord: string | undefined,
): { targets: string[]; directTargets: string[]; consumeNext: boolean; unresolved: boolean; sawSink: boolean } | null {
  if (!/^-[^-]+$/.test(word)) return null;
  const options = word.slice(1);
  const standalone = new Set("sSvvikILfgGNqZ0O");
  const valueOptions = new Set("AbCdeEFHkmMPrTuVxXyYz");
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index] ?? "";
    if (standalone.has(option)) continue;
    if (option === "K") return { targets: [], directTargets: [], consumeNext: false, unresolved: true, sawSink: true };
    if (option === "o" || option === "D" || option === "c") {
      const attached = options.slice(index + 1);
      const value = attached || nextWord;
      return { targets: value ? [value] : [], directTargets: [], consumeNext: attached.length === 0, unresolved: !value, sawSink: true };
    }
    if (option === "w") {
      const attached = options.slice(index + 1);
      const value = attached || nextWord;
      const directTargets = value ? parseCurlWriteOutTargets(value) : null;
      return {
        targets: [],
        directTargets: directTargets ?? [],
        consumeNext: attached.length === 0,
        unresolved: directTargets === null,
        sawSink: directTargets === null || directTargets.some((target) => target !== "-"),
      };
    }
    if (valueOptions.has(option)) return { targets: [], directTargets: [], consumeNext: options.length === index + 1, unresolved: false, sawSink: false };
    return { targets: [], directTargets: [], consumeNext: false, unresolved: true, sawSink: true };
  }
  return { targets: [], directTargets: [], consumeNext: false, unresolved: false, sawSink: false };
}


function collectConductorDownloaderOutputTargets(
  commandName: string,
  words: string[],
  commandIndex: number,
  options: { posixlyCorrect?: boolean; startupConfigurationUnresolved?: boolean; startupIsolationVerified?: boolean; cwd?: string } = {},
): { sawOutputFlag: boolean; targets: string[]; unresolvedWgetTarget: boolean } {
  const targets: string[] = [];
  let explicitCurlTargets: string[] = [];
  let sawOutputFlag = false;
  let curlOutputTargetMissing = false;
  let sawCurlRemoteName = false;
  let curlOutputTemplateUnresolved = false;
  let sawWgetNoBodyMode = false;
  let sawWgetStdoutOrSpider = false;
  let sawUnmodeledWgetOption = false;
  let sawUnresolvedWgetOutputTarget = false;
  let wgetOptionsTerminated = false;
  let curlOptionsTerminated = false;
  const wgetPosixlyCorrect = options.posixlyCorrect === true;
  const commandCwd = options.cwd ?? process.cwd();
  let wgetOutputDocumentTarget: string | null | undefined;
  let wgetDirectoryPrefixTarget: string | null | undefined;
  let wgetLogTarget: string | null | undefined;
  const wgetAuxiliaryTargets: string[] = [];
  const applyWgetExecuteTargets = (value: string): void => {
    const executeTargets = parseConductorWgetExecuteTargets(value);
    if (executeTargets === null) {
      sawUnresolvedWgetOutputTarget = true;
      return;
    }
    for (const executeTarget of executeTargets) {
      if (executeTarget.kind === "output") wgetOutputDocumentTarget = executeTarget.target;
      else if (executeTarget.kind === "log") wgetLogTarget = executeTarget.target;
      else if (executeTarget.kind === "directory") wgetDirectoryPrefixTarget = executeTarget.target;
      else wgetAuxiliaryTargets.push(executeTarget.target);
    }
  };

  let curlOutputDir: string | undefined;
  let curlTransferStartIndex = commandIndex + 1;
  const curlShortOptionsWithArgument = new Set("AbcCdDeEFHhKmMoPQrTuwxXyYz");
  const curlStartupConfigurationUnresolved = commandName === "curl" && !curlCommandDisablesStartupConfiguration(words, commandIndex);

  const isCurlRemoteNameWord = (word: string): boolean => {
    if (word === "--remote-name" || word === "--remote-name-all") return true;
    if (!word.startsWith("-") || word.startsWith("--")) return false;

    for (const option of word.slice(1)) {
      if (option === "O") return true;
      if (curlShortOptionsWithArgument.has(option)) return false;
    }
    return false;
  };

  const pushTarget = (rawTarget: string): void => {
    const target = safeString(rawTarget).trim();
    if (!target) return;
    if (commandName === "curl") explicitCurlTargets.push(target);
    else targets.push(target);
  };
  const finalizeCurlTransfer = (): void => {
    if (collectConductorStaticReadOnlyDownloadUrls("curl", words, curlTransferStartIndex, curlTransferEndIndex(words, curlTransferStartIndex)) === null) {
      curlOutputTemplateUnresolved = true;
    }
    if (sawCurlRemoteName) {
      sawOutputFlag = true;
      const leaf = staticConductorDownloadLeaf("curl", words, curlTransferStartIndex, curlTransferEndIndex(words, curlTransferStartIndex));
      if (!leaf) curlOutputTemplateUnresolved = true;
      else targets.push(join(curlOutputDir ?? ".", leaf));
    }
    if (explicitCurlTargets.length > 0) {
      const outputDir = curlOutputDir;
      const effectiveTargets = outputDir
        ? explicitCurlTargets.map((target) => (isAbsolute(target) ? target : join(outputDir, target)))
        : explicitCurlTargets;
      const expandedTargets: string[] = [];
      for (const target of effectiveTargets) {
        const leaves = curlOutputTargetTemplateLeaves(target, words, curlTransferStartIndex);
        if (leaves === null) {
          curlOutputTemplateUnresolved = true;
          break;
        }
        expandedTargets.push(...leaves);
      }
      if (!curlOutputTemplateUnresolved && !conductorCurlOutputLeavesAreSafe(expandedTargets, commandCwd)) {
        curlOutputTemplateUnresolved = true;
      }
      if (!curlOutputTemplateUnresolved) targets.push(...expandedTargets);
    }
    explicitCurlTargets = [];
    curlOutputDir = undefined;
    sawCurlRemoteName = false;
  };

  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined || isShellCommandTerminatorOrGroupClose(word)) break;
    if (commandName === "wget" && wgetOptionsTerminated) continue;
    if (commandName === "curl") {
      if (!curlOptionsTerminated && word === "--next") {
        finalizeCurlTransfer();
        curlTransferStartIndex = index + 1;
        curlOptionsTerminated = false;
        continue;
      }

      if (word === "--") {
        curlOptionsTerminated = true;
        continue;
      }
      const curlWriteOut = !curlOptionsTerminated ? /^--write-out(?:=(.*))?$/.exec(word) : null;
      if (curlWriteOut) {
        const value = shellWordLiteral(curlWriteOut[1] ?? words[index + 1] ?? "");
        const directTargets = parseCurlWriteOutTargets(value);
        if (
          directTargets === null
          || !value
          || isShellCommandTerminatorOrGroupClose(value)
        ) {
          return { sawOutputFlag: true, targets, unresolvedWgetTarget: true };
        }
        const expandedTargets: string[] = [];
        for (const target of directTargets) {
          const leaves = curlOutputTargetTemplateLeaves(target, words, curlTransferStartIndex);
          if (leaves === null) return { sawOutputFlag: true, targets, unresolvedWgetTarget: true };
          expandedTargets.push(...leaves);
        }
        if (!conductorCurlOutputLeavesAreSafe(expandedTargets, commandCwd)) {
          return { sawOutputFlag: true, targets, unresolvedWgetTarget: true };
        }
        targets.push(...expandedTargets);
        if (expandedTargets.some((target) => target !== "-")) sawOutputFlag = true;
        if (curlWriteOut[1] === undefined) index += 1;
        continue;
      }
      if (!curlOptionsTerminated && shellWordMayProduceWgetOptions(word)) {
        return { sawOutputFlag: true, targets, unresolvedWgetTarget: true };
      }
      if (!curlOptionsTerminated) {
        if (curlRemoteHeaderNameIsUnsafe(word)) {
          return { sawOutputFlag: true, targets, unresolvedWgetTarget: true };
        }
        if (curlQuoteControlIsUnsafe(word) || curlUnknownRequestControlIsUnsafe(word) || curlRequestOptionMutates(word)) {
          return { sawOutputFlag: true, targets, unresolvedWgetTarget: true };
        }
        const longHeader = /^--(?:header|proxy-header)(?:=(.*))?$/.exec(word);
        const shortHeader = /^-[^-]*H/.test(word);
        if (longHeader || shortHeader) {
          const header = longHeader
            ? longHeader[1] ?? words[index + 1]
            : word.slice(word.indexOf("H") + 1) || words[index + 1];
          if (!header || shellWordLiteral(header).startsWith("@") || shellWordMayProduceWgetOptions(header) || curlHeaderOverridesRequestMethod(header)) {
            return { sawOutputFlag: true, targets, unresolvedWgetTarget: true };
          }
          if (longHeader && longHeader[1] === undefined) {
            index += 1;
            continue;
          }
        }
        const longRequest = /^--request(?:=(.*))?$/.exec(word);
        const shortRequestOffset = /^-[^-]*X/.test(word) ? word.slice(1).indexOf("X") : -1;
        const shortRequest = shortRequestOffset >= 0
          ? word.slice(shortRequestOffset + 2) || words[index + 1]
          : undefined;
        const request = longRequest ? longRequest[1] ?? words[index + 1] : shortRequest;
        if (longRequest || shortRequestOffset >= 0) {
          if (!request || shellWordMayProduceWgetOptions(request) || !curlRequestMethodIsReadOnly(shellWordLiteral(request))) {
            return { sawOutputFlag: true, targets, unresolvedWgetTarget: true };
          }
          if (longRequest && longRequest[1] === undefined) index += 1;
        }
      }
      const shortCluster = parseConductorCurlShortOptionCluster(word, words[index + 1]);
      if (shortCluster) {
        if (shortCluster.sawSink) sawOutputFlag = true;
        if (shortCluster.unresolved || (shortCluster.consumeNext && (words[index + 1] === undefined || isShellCommandTerminatorOrGroupClose(words[index + 1] ?? "")))) {
          return { sawOutputFlag, targets, unresolvedWgetTarget: true };
        }
        for (const target of shortCluster.targets) pushTarget(target);
        const expandedDirectTargets: string[] = [];
        for (const target of shortCluster.directTargets) {
          const leaves = curlOutputTargetTemplateLeaves(target, words, curlTransferStartIndex);
          if (leaves === null || !conductorCurlOutputLeavesAreSafe(leaves, commandCwd)) {
            return { sawOutputFlag, targets, unresolvedWgetTarget: true };
          }
          expandedDirectTargets.push(...leaves);
        }
        targets.push(...expandedDirectTargets);
        if (shortCluster.consumeNext) index += 1;
        if (shortCluster.sawSink || shortCluster.consumeNext) continue;
      }
      const curlAuxiliary = /^(?:--trace-ascii|--trace|--dump-header|--cookie-jar|--libcurl|--etag-save|--stderr|--alt-svc|--hsts|--ssl-sessions|--write-out-file)(?:=(.*))?$/.exec(word);
      if (curlAuxiliary) {
        sawOutputFlag = true;
        const value = curlAuxiliary[1] ?? words[index + 1];
        if (!value || isShellCommandTerminatorOrGroupClose(value)) return { sawOutputFlag, targets, unresolvedWgetTarget: true };
        pushTarget(value);
        if (curlAuxiliary[1] === undefined) index += 1;
        continue;
      }
      if (word === "--config" || word.startsWith("--config=")) {
        sawOutputFlag = true;
        return { sawOutputFlag, targets, unresolvedWgetTarget: true };
      }
        const exactCurlLongOptions = new Set([
          "--append-output", "--create-dirs", "--disable", "--dump-header", "--fail", "--get", "--head", "--header",
          "--insecure", "--location", "--output", "--output-dir", "--proxy-header", "--remote-name", "--remote-name-all",
          "--request", "--show-error", "--silent", "--verbose", "--write-out",
          "--trace-ascii", "--trace", "--cookie-jar", "--libcurl", "--etag-save", "--stderr", "--alt-svc", "--hsts",
          "--ssl-sessions", "--write-out-file",
        ]);
        const option = word.split("=", 1)[0] ?? "";
        const standaloneCurlLongOptions = new Set(["--create-dirs", "--disable", "--fail", "--get", "--head", "--insecure", "--location", "--remote-name", "--remote-name-all", "--show-error", "--silent", "--verbose"]);
        if (
          word.startsWith("--") && (
          !exactCurlLongOptions.has(option)
          || (standaloneCurlLongOptions.has(option) && word.includes("="))
          || (!standaloneCurlLongOptions.has(option) && !word.includes("=") && (!words[index + 1] || isShellCommandTerminatorOrGroupClose(words[index + 1] ?? "")))
          || (word.includes("=") && word.endsWith("="))
          )) {
          return { sawOutputFlag: true, targets, unresolvedWgetTarget: true };
        }
    }
    if (commandName === "wget" && /^-[^-]*[Vh?]/.test(word)) sawWgetNoBodyMode = true;
    if (commandName === "wget" && /^-[^-]*b/.test(word)) {
      sawUnresolvedWgetOutputTarget = true;
      sawOutputFlag = true;
    }
    if (commandName === "wget") {
      const cluster = parseConductorWgetShortOptionCluster(word, words[index + 1]);
      if (cluster === "unknown") {
        sawUnmodeledWgetOption = true;
        continue;
      }
      if (cluster && cluster !== "safe") {
        sawOutputFlag = true;
        if (cluster.value === null) {
          sawUnresolvedWgetOutputTarget = true;
        } else if (cluster.kind === "execute") {
          applyWgetExecuteTargets(cluster.value);
        } else if (cluster.kind === "output") {
          wgetOutputDocumentTarget = cluster.value;
        } else if (cluster.kind === "log") {
          wgetLogTarget = cluster.value;
        } else {
          wgetDirectoryPrefixTarget = cluster.value;
        }
        if (cluster.consumeNext) index += 1;
        continue;
      }
      if (cluster === "safe") {
        if (wgetShortClusterConsumesNextValue(word)) {
          const value = words[index + 1];
          if (value === undefined || isShellCommandTerminatorOrGroupClose(value)) sawUnresolvedWgetOutputTarget = true;
          else index += 1;
        }
        continue;
      }
    }
    if (commandName === "wget" && !wgetOptionsTerminated && shellWordMayProduceWgetOptions(word)) {
      sawUnmodeledWgetOption = true;
      continue;
    }
    if (word === "--") {
      if (commandName === "wget") wgetOptionsTerminated = true;
      continue;
    }

    if (commandName === "wget" && word === "--no-config") continue;

    if (commandName === "wget" && word === "--spider") {
      sawWgetNoBodyMode = true;
      sawWgetStdoutOrSpider = true;
      continue;
    }
    if (commandName === "wget" && word.startsWith("--")) {
      const optionSeparator = word.indexOf("=");
      const option = optionSeparator < 0 ? word : word.slice(0, optionSeparator);
      const inlineValue = optionSeparator < 0 ? undefined : word.slice(optionSeparator + 1);
      if (option === "--background") {
        sawUnresolvedWgetOutputTarget = true;
        sawOutputFlag = true;
        continue;
      }
      if (wgetRequestOptionMutates(option)) {
        sawUnresolvedWgetOutputTarget = true;
        sawOutputFlag = true;
        if (inlineValue === undefined) index += 1;
        continue;
      }
      if (option === "--method") {
        const value = inlineValue ?? words[index + 1];
        if (!value || shellWordMayProduceWgetOptions(value) || !curlRequestMethodIsReadOnly(shellWordLiteral(value))) {
          sawUnresolvedWgetOutputTarget = true;
          sawOutputFlag = true;
        }
        if (inlineValue === undefined) index += 1;
        continue;
      }
      if (option === "--header") {
        const value = inlineValue ?? words[index + 1];
        if (!value || shellWordMayProduceWgetOptions(value) || curlHeaderOverridesRequestMethod(value)) {
          sawUnresolvedWgetOutputTarget = true;
          sawOutputFlag = true;
        }
        if (inlineValue === undefined) index += 1;
        continue;
      }
      if (option === "--help" || option === "--version") {
        sawWgetNoBodyMode = true;
        continue;
      }
      if (option === "--execute") {
        const value = inlineValue ?? words[index + 1];
        if (!value || (inlineValue === undefined && isShellCommandTerminatorOrGroupClose(value))) {
          sawUnresolvedWgetOutputTarget = true;
        } else {
          applyWgetExecuteTargets(value);
          if (inlineValue === undefined) index += 1;
        }
        continue;
      }
      if (CONDUCTOR_WGET_LONG_VALUE_OPTIONS.has(option)) {
        const rawValue = inlineValue ?? words[index + 1];
        const value = shellWordLiteral(rawValue ?? "");
        if (!value || shellWordMayProduceWgetOptions(value)) {
          sawUnresolvedWgetOutputTarget = true;
        } else if (option === "--warc-tempdir") {
          sawUnresolvedWgetOutputTarget = true;
          sawOutputFlag = true;
        } else if (option === "--output-document") {
          sawOutputFlag = true;
          wgetOutputDocumentTarget = value;
        } else if (option === "--directory-prefix") {
          sawOutputFlag = true;
          wgetDirectoryPrefixTarget = value;
        } else if (option === "--output-file" || option === "--append-output" || option === "--rejected-log") {
          sawOutputFlag = true;
          wgetLogTarget = value;
        } else if (option === "--save-cookies" || option === "--warc-file" || option === "--hsts-file") {
          sawOutputFlag = true;
          wgetAuxiliaryTargets.push(value);
        }
        if (inlineValue === undefined) index += 1;
        continue;
      }
      if (CONDUCTOR_WGET_LONG_STANDALONE_OPTIONS.has(option)) continue;
    }

    const inlineCurlOutput = commandName === "curl" ? word.match(/^--output=(.+)$/) : null;
    const inlineWgetBodyOutput = commandName === "wget" ? word.match(/^--output-document=(.+)$/) : null;
    const inlineWgetLogOutput = commandName === "wget" ? word.match(/^--(?:output-file|append-output)=(.+)$/) : null;
    const inlineWgetAuxiliaryOutput = commandName === "wget" ? word.match(/^--(?:save-cookies|warc-file|rejected-log|hsts-file)=(.+)$/) : null;
    const inlineWgetDirectoryPrefix = commandName === "wget" ? word.match(/^--directory-prefix=(.+)$/) : null;
    const inlineCurlOutputDir = commandName === "curl" ? word.match(/^--output-dir=(.+)$/) : null;
    if (inlineCurlOutput?.[1] !== undefined) {
      sawOutputFlag = true;
      pushTarget(inlineCurlOutput[1]);
      continue;
    }
    if (inlineWgetBodyOutput?.[1] !== undefined) {
      sawOutputFlag = true;
      wgetOutputDocumentTarget = inlineWgetBodyOutput[1].trim() || null;
      continue;
    }
    if (inlineWgetDirectoryPrefix?.[1] !== undefined) {
      sawOutputFlag = true;
      wgetDirectoryPrefixTarget = inlineWgetDirectoryPrefix[1].trim() || null;
      continue;
    }
    if (inlineWgetLogOutput?.[1] !== undefined) {
      sawOutputFlag = true;
      wgetLogTarget = inlineWgetLogOutput[1].trim() || null;
      continue;
    }
    if (inlineWgetAuxiliaryOutput?.[1] !== undefined) {
      sawOutputFlag = true;
      const target = inlineWgetAuxiliaryOutput[1].trim();
      if (!target) sawUnresolvedWgetOutputTarget = true;
      else wgetAuxiliaryTargets.push(target);
      continue;
    }

    if (inlineCurlOutputDir?.[1] !== undefined) {
      curlOutputDir = inlineCurlOutputDir[1];
      continue;
    }

    if (commandName === "curl" && isCurlRemoteNameWord(word)) {
      sawCurlRemoteName = true;
      continue;
    }
    if (commandName === "curl" && word.startsWith("-o") && word.length > 2) {
      sawOutputFlag = true;
      pushTarget(word.slice(2));
      continue;
    }
    if (commandName === "wget" && word === "-qO") {
      sawOutputFlag = true;
      const nextWord = words[index + 1];
      if (nextWord === undefined || isShellCommandTerminatorOrGroupClose(nextWord)) sawUnresolvedWgetOutputTarget = true;
      else {
        wgetOutputDocumentTarget = nextWord.trim() || null;
        index += 1;
      }
      continue;
    }
    if (commandName === "wget" && /^-qO.+/.test(word)) {
      sawOutputFlag = true;
      wgetOutputDocumentTarget = word.slice(3).trim() || null;
      continue;
    }
    if (commandName === "wget" && (word.startsWith("-O") || word.startsWith("-o") || word.startsWith("-a")) && word.length > 2) {
      sawOutputFlag = true;
      if (word.startsWith("-O")) wgetOutputDocumentTarget = word.slice(2).trim() || null;
      else wgetLogTarget = word.slice(2).trim() || null;
      continue;
    }

    const curlOutputFlag = commandName === "curl" && (word === "-o" || word === "--output" || word === "--append-output");
    const wgetOutputDocumentFlag = commandName === "wget" && (word === "-O" || word === "--output-document");
    const wgetDirectoryPrefixFlag = commandName === "wget" && (word === "-P" || word === "--directory-prefix");
    const wgetLogOutputFlag = commandName === "wget" && (word === "-o" || word === "-a" || word === "--output-file" || word === "--append-output");
    const wgetAuxiliaryOutputFlag = commandName === "wget" && (word === "--save-cookies" || word === "--warc-file" || word === "--rejected-log" || word === "--hsts-file");
    if (!curlOutputFlag && !wgetOutputDocumentFlag && !wgetDirectoryPrefixFlag && !wgetLogOutputFlag && !wgetAuxiliaryOutputFlag) {
      if (commandName === "curl" && word === "--output-dir") {
        const nextWord = words[index + 1];
        if (nextWord !== undefined && !isShellCommandTerminatorOrGroupClose(nextWord)) {
          curlOutputDir = nextWord;
          index += 1;
        }
      }
      if (commandName === "wget") {
        if (!word.startsWith("-")) {
          if (wgetPosixlyCorrect) wgetOptionsTerminated = true;
          continue;
        }
        sawUnmodeledWgetOption = true;
      }
      continue;
    }

    sawOutputFlag = true;
    const nextWord = words[index + 1];
    if (nextWord !== undefined && !isShellCommandTerminatorOrGroupClose(nextWord)) {
      if (wgetOutputDocumentFlag) wgetOutputDocumentTarget = nextWord.trim() || null;
      else if (wgetDirectoryPrefixFlag) wgetDirectoryPrefixTarget = nextWord.trim() || null;
      else if (wgetLogOutputFlag) wgetLogTarget = nextWord.trim() || null;
      else if (wgetAuxiliaryOutputFlag) wgetAuxiliaryTargets.push(nextWord.trim());
      else pushTarget(nextWord);
      index += 1;

    } else if (commandName === "wget") {
      sawUnresolvedWgetOutputTarget = true;
    } else if (commandName === "curl") {
      curlOutputTargetMissing = true;
    }
  }

  if (commandName === "curl") finalizeCurlTransfer();

  if (commandName === "curl" && !curlOutputTargetMissing) {
    for (let index = targets.length - 1; index >= 0; index -= 1) {
      if (targets[index] === "-") targets.splice(index, 1);
    }
    if (targets.length === 0) sawOutputFlag = false;
  }

  let unresolvedWgetTarget = commandName === "wget" && (sawUnmodeledWgetOption || sawUnresolvedWgetOutputTarget || options.startupConfigurationUnresolved === true);
  if (commandName === "wget" && !unresolvedWgetTarget) {
    const leaf = wgetDirectoryPrefixTarget !== undefined
      ? staticConductorDownloadLeaf("wget", words, commandIndex + 1, words.length, wgetPosixlyCorrect)
      : null;
    if (wgetDirectoryPrefixTarget !== undefined) {
      if (wgetDirectoryPrefixTarget === null || !leaf) unresolvedWgetTarget = true;
      else targets.push(join(wgetDirectoryPrefixTarget, leaf));
    }
    if (wgetLogTarget !== undefined) {
      if (wgetLogTarget === null) unresolvedWgetTarget = true;
      else if (wgetLogTarget !== "-") targets.push(wgetLogTarget);
    }
    for (const target of wgetAuxiliaryTargets) {
      if (target !== "-") targets.push(target);
    }
    if (wgetOutputDocumentTarget !== undefined) {
      if (wgetOutputDocumentTarget === null) unresolvedWgetTarget = true;
      else if (wgetOutputDocumentTarget !== "-") targets.push(wgetOutputDocumentTarget);
      else sawWgetStdoutOrSpider = true;
    } else if (!sawWgetNoBodyMode && wgetDirectoryPrefixTarget === undefined) {
      unresolvedWgetTarget = true;
    }
  }
  if (commandName === "wget" && sawWgetStdoutOrSpider && !options.startupIsolationVerified) unresolvedWgetTarget = true;
  if (
    commandName === "curl"
    && (
      curlStartupConfigurationUnresolved
      || curlOutputTargetMissing
      || curlOutputTemplateUnresolved
    )
  ) {
    unresolvedWgetTarget = true;
    sawOutputFlag = true;
  }


  return { sawOutputFlag, targets, unresolvedWgetTarget };
}



function isConductorSedInPlaceOption(word: string): boolean {
  return word === "-i" || word === "--in-place" || word.startsWith("-i") || word.startsWith("--in-place=") || /^-[^-]*i/.test(word);
}

function conductorSedInPlaceBackupSuffixIsUnsafe(rawWord: string): boolean {
  const word = shellWordLiteral(rawWord);
  if (word === "-i" || word === "--in-place") return false;
  if (word.startsWith("--in-place=")) return word.slice("--in-place=".length) !== "";
  if (word.startsWith("-i")) return word.slice(2) !== "";
  const shortInPlaceIndex = word.indexOf("i", 1);
  return shortInPlaceIndex >= 0 && shortInPlaceIndex + 1 < word.length;
}

function conductorSedHasUnsafeOption(words: string[], commandIndex: number): boolean {
  for (const rawWord of collectConductorInvocationWords(words, commandIndex)) {
    const word = shellWordLiteral(rawWord);
    if (conductorSedInPlaceBackupSuffixIsUnsafe(word)) return true;
    if (!word.startsWith("--")) continue;
    const option = word.split("=", 1)[0] ?? "";
    if (!new Set(["--in-place", "--expression", "--file"]).has(option)) return true;
  }
  return false;
}

function conductorEditorHasInPlaceOption(commandName: string, words: string[], commandIndex: number): boolean {
  return collectConductorInvocationWords(words, commandIndex).some((rawWord) => {
    const word = shellWordLiteral(rawWord);
    return commandName === "sed"
      ? isConductorSedInPlaceOption(word) || word.startsWith("--in-")
      : word === "-i" || word.startsWith("-i") || /^-[^-]*i/.test(word);
  });
}

function collectConductorSedTargets(words: string[], commandIndex: number): string[] | null {
  if (conductorSedHasUnsafeOption(words, commandIndex)) return null;
  const targets: string[] = [];
  let sawInPlace = false;
  let sawExplicitScript = false;
  let consumedImplicitScript = false;

  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined || isShellCommandTerminatorOrGroupClose(word)) break;

    if (word === "--") {
      consumedImplicitScript = true;
      continue;
    }
    if (isConductorSedInPlaceOption(word)) {
      sawInPlace = true;
      continue;
    }
    if (word === "-e" || word === "--expression" || word === "-f" || word === "--file") {
      sawExplicitScript = true;
      index += 1;
      continue;
    }
    if (word.startsWith("-e") || word.startsWith("--expression=") || word.startsWith("-f") || word.startsWith("--file=")) {
      sawExplicitScript = true;
      continue;
    }
    if (word.startsWith("-")) continue;

    if (!sawExplicitScript && !consumedImplicitScript) {
      consumedImplicitScript = true;
      continue;
    }
    targets.push(word);
  }

  return sawInPlace ? targets : null;
}

function collectConductorPerlTargets(words: string[], commandIndex: number): string[] | null {
  const targets: string[] = [];
  let sawInPlace = false;

  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === undefined || isShellCommandTerminatorOrGroupClose(word)) break;

    if (word === "--") continue;
    if (word === "-i" || word.startsWith("-i") || /^-[^-]*i/.test(word)) {
      sawInPlace = true;
      continue;
    }
    if (word === "-e") {
      index += 1;
      continue;
    }
    if (word.startsWith("-e") || /^-[^-]*e/.test(word)) continue;
    if (word.startsWith("-")) continue;

    targets.push(word);
  }

  return sawInPlace ? targets : null;
}

const CONDUCTOR_XARGS_LONG_OPTIONS_WITH_REQUIRED_VALUES = new Set([
  "--arg-file",
  "--delimiter",
  "--max-args",
  "--max-chars",
  "--max-procs",
  "--process-slot-var",
]);
const CONDUCTOR_XARGS_LONG_OPTIONS_WITH_OPTIONAL_ATTACHED_VALUES = new Set([
  "--eof",
  "--max-lines",
  "--replace",
]);

const CONDUCTOR_XARGS_LONG_STANDALONE_OPTIONS = new Set([
  "--exit",
  "--help",
  "--interactive",
  "--no-run-if-empty",
  "--null",
  "--open-tty",
  "--show-limits",
  "--verbose",
  "--version",
]);
const CONDUCTOR_XARGS_SHORT_OPTIONS_WITH_REQUIRED_VALUES = new Set(["a", "d", "E", "I", "J", "L", "n", "P", "s"]);
const CONDUCTOR_XARGS_SHORT_OPTIONS_WITH_OPTIONAL_ATTACHED_VALUES = new Set(["e", "i", "l"]);
const CONDUCTOR_XARGS_SHORT_STANDALONE_OPTIONS = new Set(["0", "o", "p", "r", "t", "x"]);

function resolveConductorXargsLongOption(option: string): "required" | "optional" | "standalone" | null {
  if (CONDUCTOR_XARGS_LONG_OPTIONS_WITH_REQUIRED_VALUES.has(option)) return "required";
  if (CONDUCTOR_XARGS_LONG_OPTIONS_WITH_OPTIONAL_ATTACHED_VALUES.has(option)) return "optional";
  if (CONDUCTOR_XARGS_LONG_STANDALONE_OPTIONS.has(option)) return "standalone";

  const matches = [
    ...CONDUCTOR_XARGS_LONG_OPTIONS_WITH_REQUIRED_VALUES,
    ...CONDUCTOR_XARGS_LONG_OPTIONS_WITH_OPTIONAL_ATTACHED_VALUES,
    ...CONDUCTOR_XARGS_LONG_STANDALONE_OPTIONS,
  ].filter((candidate) => candidate.startsWith(option));
  if (matches.length !== 1) return null;
  const match = matches[0] ?? "";
  if (CONDUCTOR_XARGS_LONG_OPTIONS_WITH_REQUIRED_VALUES.has(match)) return "required";
  if (CONDUCTOR_XARGS_LONG_OPTIONS_WITH_OPTIONAL_ATTACHED_VALUES.has(match)) return "optional";
  return "standalone";
}


function conductorXargsOptionValueWordCount(words: string[], optionIndex: number): number | null {
  const word = words[optionIndex] ?? "";
  if (!word.startsWith("-") || word === "-") return null;

  if (word.startsWith("--")) {
    const [option, inlineValue] = word.split("=", 2);
    const optionKind = resolveConductorXargsLongOption(option);
    if (optionKind === null) return null;
    if (optionKind === "standalone") return inlineValue === undefined ? 0 : null;
    if (optionKind === "optional") return 0;
    return inlineValue === undefined ? 1 : 0;
  }

  const shortOptions = word.slice(1);
  for (let offset = 0; offset < shortOptions.length; offset += 1) {
    const option = shortOptions[offset] ?? "";
    if (CONDUCTOR_XARGS_SHORT_OPTIONS_WITH_REQUIRED_VALUES.has(option)) {
      if (offset < shortOptions.length - 1) return 0;
      return option === "I" && (words[optionIndex + 1] ?? "") === "{" && (words[optionIndex + 2] ?? "") === "}" ? 2 : 1;
    }
    if (CONDUCTOR_XARGS_SHORT_OPTIONS_WITH_OPTIONAL_ATTACHED_VALUES.has(option)) return 0;
    if (!CONDUCTOR_XARGS_SHORT_STANDALONE_OPTIONS.has(option)) return null;
  }

  return 0;
}



function conductorMutationOptionValueWordCount(commandName: string, option: string): number {
  if (option === "--target-directory" || option === "-t") return commandUsesTargetDirectoryOption(commandName) ? 1 : 0;
  if (option === "-if" || option === "if" || option === "-of" || option === "of") return commandName === "dd" ? 1 : 0;
  if (option === "-m" || option === "--mode") return commandName === "install" || commandName === "mkdir" ? 1 : 0;
  if (option === "-o" || option === "--owner" || option === "-g" || option === "--group") return commandName === "install" || commandName === "chown" ? 1 : 0;
  if (option === "--reference") return new Set(["chmod", "chown", "chgrp", "cp", "install", "touch"]).has(commandName) ? 1 : 0;
  if (option === "--suffix") return new Set(["cp", "mv", "ln", "install"]).has(commandName) ? 1 : 0;
  if (option === "-S") return commandName === "ln" ? 1 : 0;
  if (option === "--preserve" || option === "--size") return commandName === "install" ? 1 : 0;
  return 0;
}

function conductorLnUsesSymbolicTarget(words: string[], commandIndex: number): boolean {
  let optionsTerminated = false;
  for (const rawWord of collectConductorInvocationWords(words, commandIndex)) {
    const word = shellWordLiteral(rawWord);
    if (word === "--") {
      optionsTerminated = true;
      continue;
    }
    if (optionsTerminated || !word.startsWith("-")) continue;
    if (word === "--symbolic" || /^-[^-]*s/.test(word)) return true;
  }
  return false;
}

function conductorCpUsesUnsafeAliasOrPathShapingOption(words: string[], commandIndex: number): boolean {
  let optionsTerminated = false;
  for (const rawWord of collectConductorInvocationWords(words, commandIndex)) {
    const word = shellWordLiteral(rawWord);
    if (word === "--") {
      optionsTerminated = true;
      continue;
    }
    if (optionsTerminated || !word.startsWith("-") || word === "-") continue;
    const option = word.split("=", 1)[0] ?? "";
    if (option === "--target-directory" || option === "--reference" || word === "-t" || /^-t.+/.test(word)) continue;
    return true;
  }
  return false;
}

function conductorHardLinkSourcesAreSafe(
  sources: string[],
  destinations: string[],
  cwd: string,
): boolean {
  if (!destinations.some((destination) => isAllowedConductorMetadataPath(cwd, destination))) return true;
  return sources.every((source) => {
    if (!isAllowedConductorMetadataPath(cwd, source)) return false;
    try {
      const entry = lstatSync(isAbsolute(source) ? resolve(source) : resolve(cwd, source));
      return entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1;
    } catch {
      return false;
    }
  });
}

function collectConductorFiniteDestinationLeaves(
  commandName: string,
  positionalTargets: string[],
  targetDirectoryTargets: string[],
  sawTargetDirectory: boolean,
  cwd: string,
): string[] | null {
  if (!new Set(["cp", "install", "ln"]).has(commandName)) return null;
  const staticPath = (path: string): boolean => Boolean(path) && !/[$`\0]/.test(path) && !/[?*{}\[\]]/.test(path);
  const sourceLeaf = (source: string): string | null => {
    if (!staticPath(source)) return null;
    const leaf = source.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "";
    if (!leaf || leaf === "." || leaf === "..") return null;
    try {
      const entry = lstatSync(isAbsolute(source) ? resolve(source) : resolve(cwd, source));
      if (entry.isDirectory() || entry.isSymbolicLink() || entry.nlink > 1) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    return leaf;
  };
  const resolveDirectory = (directory: string): string | null => {
    if (!staticPath(directory)) return null;
    try {
      const entry = lstatSync(isAbsolute(directory) ? resolve(directory) : resolve(cwd, directory));
      return entry.isDirectory() && !entry.isSymbolicLink() ? directory : null;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? directory : null;
    }
  };
  if (sawTargetDirectory) {
    if (targetDirectoryTargets.length !== 1 || positionalTargets.length === 0) return null;
    const directory = resolveDirectory(targetDirectoryTargets[0] ?? "");
    if (!directory) return null;
    const leaves = positionalTargets.map(sourceLeaf);
    return leaves.some((leaf) => leaf === null) ? null : leaves.map((leaf) => join(directory, leaf ?? ""));
  }
  if (positionalTargets.length < 2) return null;
  const destination = positionalTargets.at(-1) ?? "";
  const sources = positionalTargets.slice(0, -1);
  if (sources.length !== 1 && commandName === "ln") return null;
  if (sources.some((source) => sourceLeaf(source) === null) || !staticPath(destination)) return null;
  try {
    const entry = lstatSync(isAbsolute(destination) ? resolve(destination) : resolve(cwd, destination));
    if (entry.isSymbolicLink()) return null;
    if (!entry.isDirectory()) return sources.length === 1 ? [destination] : null;
    return sources.map((source) => join(destination, sourceLeaf(source) ?? ""));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" && sources.length === 1 ? [destination] : null;
  }
}

function parseConductorDdPositiveScalar(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function collectConductorBoundedDdTargets(words: string[], commandIndex: number, cwd: string): string[] | null {
  let input: string | null = null;
  let output: string | null = null;
  let blockSize: number | null = null;
  let count: number | null = null;
  for (const rawWord of collectConductorInvocationWords(words, commandIndex)) {
    const word = shellWordLiteral(rawWord);
    if (!word || /[$`]/.test(word)) return null;
    const assignment = /^(if|of|bs|count)=(.*)$/.exec(word);
    if (!assignment) return null;
    const name = assignment[1] ?? "";
    const value = assignment[2] ?? "";
    if (!value || (name === "if" || name === "of") && conductorPathnameExpansionIsAmbiguous(value)) return null;
    if (name === "if") {
      if (input !== null) return null;
      input = value;
    } else if (name === "of") {
      if (output !== null) return null;
      output = value;
    } else if (name === "bs") {
      if (blockSize !== null) return null;
      blockSize = parseConductorDdPositiveScalar(value);
    } else {
      if (count !== null) return null;
      count = parseConductorDdPositiveScalar(value);
    }
  }
  if (input === null || output === null || blockSize === null || count === null) return null;
  if (blockSize > MAX_CONDUCTOR_METADATA_COPY_BYTES || count > Math.floor(MAX_CONDUCTOR_METADATA_COPY_BYTES / blockSize)) return null;
  return conductorMetadataCopySourceIsFiniteRegular(cwd, input) ? [output] : null;
}

function collectConductorBoundedTruncateTargets(words: string[], commandIndex: number): string[] | null {
  const targets: string[] = [];
  let size: number | null = null;
  let optionsTerminated = false;
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const rawWord = words[index] ?? "";
    if (isShellCommandTerminatorOrGroupClose(rawWord)) break;
    const word = shellWordLiteral(rawWord);
    if (!word || /[$`]/.test(rawWord)) return null;
    if (!optionsTerminated && word === "--") {
      optionsTerminated = true;
      continue;
    }
    let sizeValue: string | undefined;
    if (!optionsTerminated && (word === "--size" || word === "-s")) {
      sizeValue = shellWordLiteral(words[index + 1] ?? "");
      index += 1;
    } else if (!optionsTerminated && word.startsWith("--size=")) {
      sizeValue = word.slice("--size=".length);
    } else if (!optionsTerminated && word.startsWith("-s") && word.length > 2) {
      sizeValue = word.slice(2);
    } else if (!optionsTerminated && word.startsWith("-")) {
      return null;
    } else {
      if (conductorPathnameExpansionIsAmbiguous(word)) return null;
      targets.push(word);
      continue;
    }
    if (size !== null || !sizeValue || !/^(?:0|[1-9][0-9]*)$/.test(sizeValue)) return null;
    const parsedSize = Number(sizeValue);
    if (!Number.isSafeInteger(parsedSize) || parsedSize > MAX_CONDUCTOR_METADATA_COPY_BYTES) return null;
    size = parsedSize;
  }
  return size === null || targets.length === 0 ? null : targets;
}

function collectConductorMutationCommandTargets(
  commandName: string,
  words: string[],
  commandIndex: number,
  cwd: string,
  posixlyCorrect = false,
): string[] | null {
  const targets: string[] = [];
  const positionalTargets: string[] = [];
  const targetDirectoryTargets: string[] = [];
  let sawTargetDirectory = false;
  let positionalCount = 0;
  let rsyncRemovesSourceFiles = false;
  let referenceMode = false;
  let optionsTerminated = false;
  if (commandName === "sed") return collectConductorSedTargets(words, commandIndex);
  if (commandName === "perl") return collectConductorPerlTargets(words, commandIndex);
  if (commandName === "dd") return collectConductorBoundedDdTargets(words, commandIndex, cwd);
  if (commandName === "truncate") return collectConductorBoundedTruncateTargets(words, commandIndex);
  if (isConductorReferenceTargetModeCommand(commandName)) {
    return collectConductorSafeReferenceControlTargets(commandName, words, commandIndex, cwd, posixlyCorrect);
  }
  if (commandName === "cp" && conductorCpUsesUnsafeAliasOrPathShapingOption(words, commandIndex)) return null;
  if (conductorMutationUsesUnsafeOption(commandName, words, commandIndex)) return null;
  const installDirectoryMode = commandName === "install" && isConductorInstallDirectoryMode(words, commandIndex);
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = shellWordLiteral(words[index] ?? "");
    if (word === undefined || isShellCommandTerminatorOrGroupClose(word)) break;
    if (commandName === "rsync" && !optionsTerminated && shellWordMayProduceWgetOptions(word)) return null;

    if (!optionsTerminated && word === "--") {
      optionsTerminated = true;
      continue;
    }
    if (commandName === "rsync" && !optionsTerminated && word === "--remove-source-files") {
      rsyncRemovesSourceFiles = true;
      continue;
    }
    if (!optionsTerminated && word.startsWith("--")) {
      const [option, inlineValue] = word.split("=", 2);
      if (isConductorReferenceTargetModeCommand(commandName) && option === "--recursive") return null;
      if (option === "--target-directory" && commandUsesTargetDirectoryOption(commandName)) {
        sawTargetDirectory = true;
        if (inlineValue !== undefined) {
          const target = safeString(inlineValue).trim();
          if (!target) return null;
          targetDirectoryTargets.push(target);
        } else {
          const target = shellWordLiteral(words[index + 1] ?? "");
          if (!target || isShellCommandTerminatorOrGroupClose(target)) return null;
          targetDirectoryTargets.push(target);
          index += 1;
        }
        continue;
      }
      if (option === "--reference") {
        if (!isConductorReferenceTargetModeCommand(commandName)) return null;
        const referenceInput = inlineValue ?? shellWordLiteral(words[index + 1] ?? "");
        if (!referenceInput || isShellCommandTerminatorOrGroupClose(referenceInput)) return null;
        referenceMode = true;
        if (inlineValue === undefined) index += 1;
        continue;
      }
      if (commandName === "rsync" && new Set(["--log-file", "--write-batch", "--only-write-batch", "--backup-dir", "--partial-dir", "--temp-dir"]).has(option)) {
        const target = inlineValue ?? words[index + 1];
        if (!target || isShellCommandTerminatorOrGroupClose(target)) return null;
        targets.push(target);
        if (inlineValue === undefined) index += 1;
        continue;
      }
      if (inlineValue === undefined) index += conductorMutationOptionValueWordCount(commandName, option);
      if ((option === "--backup" || option === "--suffix") && inlineValue) {
        targets.push(inlineValue);
      }
      continue;
    }
    if (!optionsTerminated && word === "-t" && commandUsesTargetDirectoryOption(commandName)) {
      sawTargetDirectory = true;
      const target = shellWordLiteral(words[index + 1] ?? "");
      if (!target || isShellCommandTerminatorOrGroupClose(target)) return null;
      targetDirectoryTargets.push(target);
      index += 1;
      continue;
    }
    if (!optionsTerminated && word.startsWith("-t") && word.length > 2 && commandUsesTargetDirectoryOption(commandName)) {
      const target = safeString(word.slice(2)).trim();
      if (!target) return null;
      sawTargetDirectory = true;
      targetDirectoryTargets.push(target);
      continue;
    }
    if (!optionsTerminated && word.startsWith("-") && word.length > 1) {
      if (isConductorReferenceTargetModeCommand(commandName) && /^-[^-]*R/.test(word)) return null;
      index += conductorMutationOptionValueWordCount(commandName, word);
      continue;
    }
    positionalCount += 1;
    if (
      isConductorReferenceTargetModeCommand(commandName)
      && !referenceMode
      && positionalCount === 1
    ) {
      continue;
    }
    positionalTargets.push(word);
    if (posixlyCorrect) optionsTerminated = true;
  }
  if (referenceMode && positionalTargets.length === 0) return null;
  if (installDirectoryMode) return [...targets, ...positionalTargets];
  const finiteDestinationLeaves = collectConductorFiniteDestinationLeaves(
    commandName,
    positionalTargets,
    targetDirectoryTargets,
    sawTargetDirectory,
    cwd,
  );
  if (commandName === "cp" || commandName === "install") {
    const copySources = sawTargetDirectory ? positionalTargets : positionalTargets.slice(0, -1);
    if (copySources.length === 0 || copySources.some((source) => !conductorMetadataCopySourceIsFiniteRegular(cwd, source))) return null;
  }
  if (new Set(["cp", "install", "ln"]).has(commandName)) {
    if (commandName === "ln") {
      if (conductorLnUsesSymbolicTarget(words, commandIndex)) return null;
      const hardLinkSources = sawTargetDirectory ? positionalTargets : positionalTargets.slice(0, -1);
      if (
        finiteDestinationLeaves === null
        || !conductorHardLinkSourcesAreSafe(hardLinkSources, finiteDestinationLeaves, cwd)
      ) return null;
    }
    return finiteDestinationLeaves === null ? null : [...targets, ...finiteDestinationLeaves];
  }
  if (sawTargetDirectory) {
    return commandName === "mv"
      ? [...targets, ...targetDirectoryTargets, ...positionalTargets]
      : [...targets, ...targetDirectoryTargets];
  }
  if (commandName === "ln") return [...targets, ...targetDirectoryTargets, ...positionalTargets];
  if (commandName === "rsync") {
    if (positionalTargets.length < 2) return null;
    const destination = positionalTargets[positionalTargets.length - 1] ?? "";
    if (/^(?:[^/:\s]+@)?[^/:\s]+:.+/.test(destination)) return null;
    return rsyncRemovesSourceFiles
      ? [...targets, ...positionalTargets]
      : [...targets, destination];
  }
  if (isConductorDestinationOnlyMutationCommand(commandName)) return [...targets, ...positionalTargets.slice(-1)];
  return [...targets, ...positionalTargets];
}

function conductorCommandMayCreateFilesystemAlias(commandName: string, words: string[], commandIndex: number): boolean {
  void words;
  void commandIndex;
  return new Set(["cp", "install", "ln", "mv", "rsync"]).has(commandName);
}

function conductorCommandInvalidatesStaticDirectoryProof(
  commandName: string,
  words: string[],
  commandIndex: number,
): boolean {
  return new Set(["cp", "install", "rm", "rmdir", "mv", "rsync", "chmod", "chown", "chgrp"]).has(commandName)
    || conductorCommandMayCreateFilesystemAlias(commandName, words, commandIndex);
}

const CONDUCTOR_UNKNOWN_SHELL_BINDING = "<dynamic>";
const CONDUCTOR_SHELL_BINDING_NAMES = ["POSIXLY_CORRECT", "WGETRC", "HOME", "CDPATH", "PATH", "SSLKEYLOGFILE"] as const;
type ConductorShellBindingName = typeof CONDUCTOR_SHELL_BINDING_NAMES[number];

interface ConductorShellBinding {
  value: string | undefined;
  exported: boolean;
  readonly: boolean;
  readonlyPossible?: boolean;
  local: boolean;
  dirty: boolean;
  outer?: ConductorShellBinding;
}

interface ShellPosixState {
  bindings: Map<ConductorShellBindingName, ConductorShellBinding>;
  securityEnvironment: Map<string, string>;
  dirtySecurityEnvironmentNames: Set<string>;
  securityEnvironmentUnresolved: boolean;
  staticVariables?: Map<string, string>;
  lastpipe: boolean;
  jobControl: boolean;
  jobControlMayBeDisabled: boolean;
  bashoptsLastpipe: boolean;
  bashoptsExported: boolean;
  allexport: boolean;
  shellOptionsKnown: boolean;
  effectiveCwd: string | null;
  directoryStack: string[] | null;
  aliases: Map<string, ConductorShellBindingName | null>;
  globalAliases: Set<string>;
  functionLocalBindings: Set<ConductorShellBindingName>;
  posixMode: boolean;
  physicalCwd: boolean;
  functionShellOptionSnapshot?: Pick<ShellPosixState, "lastpipe" | "jobControl" | "jobControlMayBeDisabled" | "allexport" | "posixMode" | "physicalCwd">;
  filesystemAliasMayExist: boolean;
  invalidatedStaticDirectories: Set<string>;
  pathUsesSystemDefaultWhenUnset: boolean;
}

const CONDUCTOR_SAFE_SHELL_OPTIONS = new Set([
  "allexport", "braceexpand", "emacs", "errexit", "errtrace", "functrace", "hashall", "histexpand", "history",
  "ignoreeof", "interactive-comments", "monitor", "noclobber", "noexec", "noglob", "notify", "nounset",
  "onecmd", "physical", "pipefail", "posix", "privileged", "verbose", "vi",
]);
const CONDUCTOR_SAFE_SHORT_SHELL_OPTION_LETTERS = new Set(["a", "b", "e", "f", "h", "m", "n", "u", "v", "B", "C", "E", "H", "P", "T"]);
const CONDUCTOR_NESTED_SHELL_INVOCATION_OPTION_LETTERS = new Set(["c", "i", "l", "s"]);

function applyConductorShortShellOptionCluster(
  state: ShellPosixState,
  option: string,
  allowNestedShellInvocationLetters = false,
): boolean {
  if (!/^[+-][A-Za-z]+$/.test(option)) return false;
  const enabled = option.startsWith("-");
  for (const letter of option.slice(1)) {
    if (
      !CONDUCTOR_SAFE_SHORT_SHELL_OPTION_LETTERS.has(letter)
      && !(allowNestedShellInvocationLetters && CONDUCTOR_NESTED_SHELL_INVOCATION_OPTION_LETTERS.has(letter))
    ) {
      state.shellOptionsKnown = false;
      return true;
    }
    if (letter === "a") state.allexport = enabled;
    if (letter === "m") {
      state.jobControl = enabled;
      state.jobControlMayBeDisabled = !enabled;
    }
    if (letter === "P") state.physicalCwd = enabled;
  }
  return true;
}

const CONDUCTOR_SAFE_BASH_OPTIONS = new Set(["lastpipe"]);

function isConductorSecuritySensitiveEnvironmentName(name: string): boolean {
  return /^RSYNC_[A-Z0-9_]+$/.test(name) || /^(?:OMX|GJC)_[A-Z0-9_]+$/.test(name);
}

function inheritedConductorSecurityEnvironment(): Map<string, string> {
  return new Map(
    Object.entries(process.env).filter(([name, value]) => (
      isConductorSecuritySensitiveEnvironmentName(name) && safeString(value).trim() !== ""
    )).map(([name, value]) => [name, safeString(value)]),
  );
}

function parseConductorShellOptions(value: string | undefined): { known: boolean; posix: boolean; allexport: boolean; physical: boolean } {
  const options = safeString(value).split(":").filter(Boolean);
  return {
    known: options.every((option) => CONDUCTOR_SAFE_SHELL_OPTIONS.has(option)),
    posix: options.includes("posix"),
    allexport: options.includes("allexport"),
    physical: options.includes("physical"),
  };
}

function parseConductorBashOptions(value: string | undefined): { known: boolean; lastpipe: boolean } {
  const options = safeString(value).split(":").filter(Boolean);
  return {
    known: options.every((option) => CONDUCTOR_SAFE_BASH_OPTIONS.has(option)),
    lastpipe: options.includes("lastpipe"),
  };
}

function inheritedConductorShellOptions(): { known: boolean; posix: boolean; allexport: boolean; physical: boolean } {
  const shellOptions = parseConductorShellOptions(process.env.SHELLOPTS);
  const bashOptions = parseConductorBashOptions(process.env.BASHOPTS);
  return {
    known: shellOptions.known && bashOptions.known,
    posix: shellOptions.posix,
    allexport: shellOptions.allexport,
    physical: shellOptions.physical,
  };
}
interface ConductorShellSegment {
  command: string;
  isolated: boolean;
}

interface ConductorCommandInvocation {
  index: number;
  unresolved: boolean;
  functionLookupAllowed: boolean;
  argumentProducing: boolean;
  childDispatch: boolean;
}

function splitConductorShellSegments(command: string): ConductorShellSegment[] {
  return command.trim() ? [{ command, isolated: false }] : [];
}

function tokenizeConductorShellWords(command: string): string[] {
  let normalized = "";
  let quote: "'" | "\"" | "$'" | null = null;
  let parameterExpansionDepth = 0;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && quote !== "'") {
      normalized += char;
      index += 1;
      normalized += command[index] ?? "";
      continue;
    }
    if (!quote && char === "$" && command[index + 1] === "'") {
      quote = "$'";
      normalized += "$'";
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char || (quote === "$'" && char === "'")) quote = null;
      else if (!quote) quote = char;
      normalized += char;
      continue;
    }
    if (quote !== "'" && char === "$" && command[index + 1] === "{") {
      parameterExpansionDepth += 1;
      normalized += "${";
      index += 1;
      continue;
    }
    if (parameterExpansionDepth > 0 && char === "}") {
      parameterExpansionDepth -= 1;
      normalized += char;
      continue;
    }
    if (!quote && parameterExpansionDepth === 0 && char === "#" && (index === 0 || /[\s;|&(){}<>]/.test(command[index - 1] ?? ""))) {
      while (index < command.length && command[index] !== "\n" && command[index] !== "\r") index += 1;
      index -= 1;
      continue;
    }
    if (!quote && (char === "\n" || char === "\r")) {
      if (char === "\r" && command[index + 1] === "\n") index += 1;
      normalized += ";";
      continue;
    }
    normalized += char;
  }
  return tokenizeShellWords(maskShellNonCommandExpansionsForConductorScan(normalized));
}

function isShellGroupingOpen(words: string[], index: number): boolean {
  if (words[index] !== "(") return false;
  const previous = words[index - 1] ?? "";
  return previous !== "in";
}

function findConductorBraceGroupEnd(words: string[], openingBraceIndex: number): number | null {
  let braceDepth = 1;
  for (let index = openingBraceIndex + 1; index < words.length; index += 1) {
    if (words[index] === "{") braceDepth += 1;
    else if (words[index] === "}") {
      braceDepth -= 1;
      if (braceDepth === 0) return index;
    }
  }
  return null;
}

function isConductorBraceGroupIsolated(words: string[], openingBraceIndex: number, closingBraceIndex: number): boolean {
  const following = words[closingBraceIndex + 1] ?? "";
  if (following === "&" || following === "|" || following === "|&") return true;
  for (let index = openingBraceIndex - 1; index >= 0; index -= 1) {
    const word = words[index] ?? "";
    if (word === "coproc") return true;
    if (word === "|" || word === "|&") return true;
    if (word === ";" || word === "&&" || word === "||" || word === "&") break;
  }
  return false;
}

function isInsideIsolatedConductorBraceGroup(words: string[], commandStartIndex: number): boolean {
  const braces: number[] = [];
  for (let index = 0; index <= commandStartIndex; index += 1) {
    if (words[index] === "{") braces.push(index);
    else if (words[index] === "}") braces.pop();
  }
  for (const openingBraceIndex of braces) {
    const closingBraceIndex = findConductorBraceGroupEnd(words, openingBraceIndex);
    if (closingBraceIndex === null || isConductorBraceGroupIsolated(words, openingBraceIndex, closingBraceIndex)) return true;
  }
  return false;
}
function isInvocationIsolated(words: string[], commandStartIndex: number, commandIndex: number): boolean {
  let groupingDepth = 0;
  for (let index = 0; index < commandStartIndex; index += 1) {
    if (isShellGroupingOpen(words, index)) groupingDepth += 1;
    else if (words[index] === ")" && groupingDepth > 0) groupingDepth -= 1;
  }
  if (groupingDepth > 0 || isInsideIsolatedConductorBraceGroup(words, commandStartIndex)) return true;

  if (commandNameFromShellWord(words[commandIndex] ?? "") === "coproc") return true;
  for (let index = commandStartIndex; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "&") return true;
    if (word === ";" || word === "&&" || word === "||") break;
    if ((word === "|" || word === "|&") && !isCasePatternPipe(words, index)) return true;
  }
  for (let index = commandStartIndex - 1; index >= 0; index -= 1) {
    const word = words[index] ?? "";
    if (word === ";" || word === "&&" || word === "||" || word === "(" || word === "{") break;
    if ((word === "|" || word === "|&") && !isCasePatternPipe(words, index)) return true;
  }
  return false;
}
function isConductorPipelineMember(words: string[], commandStartIndex: number): boolean {
  for (let index = commandStartIndex - 1; index >= 0; index -= 1) {
    const word = words[index] ?? "";
    if (word === ";" || word === "&&" || word === "||" || word === "&" || word === "(" || word === "{") break;
    if ((word === "|" || word === "|&") && !isCasePatternPipe(words, index)) return true;
  }
  for (let index = commandStartIndex; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === ";" || word === "&&" || word === "||" || word === "&" || word === ")" || word === "}") break;
    if ((word === "|" || word === "|&") && !isCasePatternPipe(words, index)) return true;
  }
  return false;
}

function isConductorFinalPipelineMember(words: string[], commandStartIndex: number): boolean {
  let groupingDepth = 0;
  for (let index = 0; index < commandStartIndex; index += 1) {
    if (isShellGroupingOpen(words, index)) groupingDepth += 1;
    else if (words[index] === ")" && groupingDepth > 0) groupingDepth -= 1;
  }
  if (groupingDepth > 0 || isInsideIsolatedConductorBraceGroup(words, commandStartIndex)) return false;

  let hasPriorPipeline = false;
  for (let index = commandStartIndex - 1; index >= 0; index -= 1) {
    const word = words[index] ?? "";
    if (word === "coproc" || word === "&") return false;
    if (word === ";" || word === "&&" || word === "||" || word === "(" || word === "{") break;
    if ((word === "|" || word === "|&") && !isCasePatternPipe(words, index)) hasPriorPipeline = true;
  }
  if (!hasPriorPipeline) return false;
  for (let index = commandStartIndex; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "&") return false;
    if (word === ";" || word === "&&" || word === "||" || word === ")" || word === "}") break;
    if ((word === "|" || word === "|&") && !isCasePatternPipe(words, index)) return false;
  }
  return true;
}

function findConductorParentIsolationScope(words: string[], commandStartIndex: number, scope: number): number | null {
  const groupingOpens: number[] = [];
  for (let index = 0; index <= commandStartIndex; index += 1) {
    if (isShellGroupingOpen(words, index) || words[index] === "{") groupingOpens.push(index);
    else if (words[index] === ")" || words[index] === "}") groupingOpens.pop();
  }
  if (scope === groupingOpens.at(-1)) return groupingOpens.at(-2) ?? null;
  return groupingOpens.at(-1) ?? null;
}

function findConductorIsolationScope(words: string[], commandStartIndex: number): number | null {
  if (isConductorPipelineMember(words, commandStartIndex)) return commandStartIndex;
  const groupingOpens: number[] = [];
  for (let index = 0; index <= commandStartIndex; index += 1) {
    if (isShellGroupingOpen(words, index) || words[index] === "{") groupingOpens.push(index);
    else if (words[index] === ")" || words[index] === "}") groupingOpens.pop();
  }
  if (groupingOpens.length > 0) return groupingOpens.at(-1) ?? null;
  return isInvocationIsolated(words, commandStartIndex, commandStartIndex) ? commandStartIndex : null;
}

function staticConductorIfCondition(words: string[], ifIndex: number, functions: ReadonlyMap<string, string[]>): boolean | null {
  const conditionWords: string[] = [];
  for (let index = ifIndex + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "then") break;
    if (word === ";" || word === "&") continue;
    if (!word || isShellCommandTerminatorOrGroupClose(word)) return null;
    conditionWords.push(commandNameFromShellWord(word));
  }
  if (conditionWords.length !== 1) return null;
  const condition = conditionWords[0] ?? "";
  if ((condition !== "true" && condition !== "false") || functions.has(condition)) return null;
  return condition === "true";
}

function isInsideCertainlySkippedConductorIfBranch(words: string[], commandStartIndex: number, functions: ReadonlyMap<string, string[]>): boolean {
  const branches: Array<{ condition: boolean | null; phase: "condition" | "then" | "else" }> = [];
  for (let index = 0; index < commandStartIndex; index += 1) {
    const word = words[index] ?? "";
    if (word === "if") {
      branches.push({ condition: staticConductorIfCondition(words, index, functions), phase: "condition" });
      continue;
    }
    const branch = branches.at(-1);
    if (!branch) continue;
    if (word === "then") {
      branch.phase = "then";
      continue;
    }
    if (word === "else") {
      branch.phase = "else";
      continue;
    }
    if (word === "elif") {
      branch.phase = "condition";
      branch.condition = null;
      continue;
    }
    if (word === "fi") branches.pop();
  }
  return branches.some((branch) => (
    (branch.phase === "then" && branch.condition === false)
    || (branch.phase === "else" && branch.condition === true)
  ));
}

function isConductorCommandCertainlySkipped(words: string[], commandStartIndex: number, functions: ReadonlyMap<string, string[]>): boolean {
  if (isInsideCertainlySkippedConductorIfBranch(words, commandStartIndex, functions)) return true;
  const separator = words[commandStartIndex - 1] ?? "";
  if (separator !== "&&" && separator !== "||") return false;
  let previousStart = commandStartIndex - 2;
  while (previousStart >= 0 && !isShellCommandSeparatorAt(words, previousStart) && words[previousStart] !== "(" && words[previousStart] !== "{") previousStart -= 1;
  const previousWord = commandNameFromShellWord(words[previousStart + 1] ?? "");
  if (functions.has(previousWord)) return false;
  return (separator === "&&" && previousWord === "false") || (separator === "||" && previousWord === "true");
}

function collectConductorInvocationWords(words: string[], commandIndex: number): string[] {
  const invocation: string[] = [];
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined || isShellCommandTerminatorOrGroupClose(word)) break;
    invocation.push(word);
  }
  return invocation;
}
const CONDUCTOR_KNOWN_OMX_RUNTIME_ENVIRONMENT_NAMES = new Set([
  "OMX_ROOT", "OMX_STATE_ROOT", "OMX_TEAM_STATE_ROOT", "OMX_SESSION_ID", "OMX_SOURCE_CWD", "OMX_STARTUP_CWD",
  "OMX_TEAM_WORKER", "OMX_TEAM_INTERNAL_WORKER", "OMX_TEAM_LEADER_CWD", "OMX_NOTIFY_HOOK_TRUSTED_MANAGED_CWD",
  "OMX_NATIVE_HOOK_DOCTOR_SMOKE",
]);

// These values identify an already-running GJC/OMX session or toggle diagnostics only.
// They are inputs to the CLI surface, not roots, output destinations, or helper commands.
const CONDUCTOR_BENIGN_ORCHESTRATION_RUNTIME_ENVIRONMENT_NAMES = new Set([
  "GJC_SESSION_CWD", "GJC_SESSION_FILE", "GJC_SESSION_ID",
  "OMX_OPENCLAW", "OMX_OPENCLAW_COMMAND", "OMX_OPENCLAW_DEBUG", "OMX_TEST_RELAX_TMUX_TIMEOUT",
]);

function conductorOrchestrationRuntimeEnvironmentNameIsPermitted(name: string): boolean {
  return CONDUCTOR_KNOWN_OMX_RUNTIME_ENVIRONMENT_NAMES.has(name)
    || CONDUCTOR_BENIGN_ORCHESTRATION_RUNTIME_ENVIRONMENT_NAMES.has(name);
}

function hasSafeConductorOrchestrationRuntimeEnvironment(
  words: string[],
  commandStartIndex: number,
  commandIndex: number,
  rootCwd: string,
  state?: ShellPosixState,
): boolean {
  const clearBoundary = nestedExecEnvironmentClearBoundary(words, commandStartIndex, commandIndex);
  const environment = new Map<string, string>();
  if (clearBoundary === null) {
    for (const [name, value] of Object.entries(process.env)) {
      if (!/^(?:OMX|GJC)_/.test(name) || safeString(value).trim() === "") continue;
      if (!conductorOrchestrationRuntimeEnvironmentNameIsPermitted(name)) return false;
      environment.set(name, safeString(value));
    }
    if (state?.securityEnvironmentUnresolved) return false;
    for (const [name, value] of state?.securityEnvironment ?? []) {
      if (!/^(?:OMX|GJC)_/.test(name)) continue;
      if (value === CONDUCTOR_UNKNOWN_SHELL_BINDING || !conductorOrchestrationRuntimeEnvironmentNameIsPermitted(name)) return false;
      if (value.trim() === "") environment.delete(name);
      else environment.set(name, value);
    }
  }
  for (let index = clearBoundary === null ? 0 : clearBoundary + 1; index < commandIndex; index += 1) {
    const word = words[index] ?? "";
    const assignment = parseShellAssignmentWord(word);
    if (assignment && /^(?:OMX|GJC)_/.test(assignment.name)) {
      if (!conductorOrchestrationRuntimeEnvironmentNameIsPermitted(assignment.name) || assignment.append || /[$`]/.test(assignment.value)) return false;
      environment.set(assignment.name, assignment.value);
      continue;
    }
    const commandName = commandNameFromShellWord(word);
    if (commandName === "unset") {
      for (const operand of collectConductorInvocationWords(words, index)) {
        const name = shellWordLiteral(operand);
        if (/^(?:OMX|GJC)_/.test(name)) environment.delete(name);
      }
      continue;
    }
    if (commandName !== "env" || index !== commandStartIndex) continue;
    const operands = collectConductorInvocationWords(words, index);
    for (let operandIndex = 0; operandIndex < operands.length; operandIndex += 1) {
      const operand = shellWordLiteral(operands[operandIndex] ?? "");
      const unsetName = operand === "-u" || operand === "--unset"
        ? shellWordLiteral(operands[operandIndex + 1] ?? "")
        : operand.startsWith("--unset=")
          ? operand.slice("--unset=".length)
          : /^-u.+/.test(operand)
            ? operand.slice(2)
            : "";
      if (/^(?:OMX|GJC)_/.test(unsetName)) environment.delete(unsetName);
      if (operand === "-u" || operand === "--unset") operandIndex += 1;
    }
  }
  const rootValue = environment.get("OMX_ROOT") ?? rootCwd;
  try {
    const canonicalRoot = realpathSync(resolve(rootCwd));
    if (realpathSync(resolve(rootCwd, rootValue)) !== canonicalRoot) return false;
    const expectedStateRoot = realpathSync(join(canonicalRoot, ".omx", "state"));
    for (const name of ["OMX_STATE_ROOT", "OMX_TEAM_STATE_ROOT"] as const) {
      const value = environment.get(name);
      if (value && realpathSync(resolve(rootCwd, value)) !== expectedStateRoot) return false;
    }
  } catch {
    return false;
  }
  return true;
}

// Structured OMX/GJC mutations additionally require inherited root channels to be
// canonical. Command-prefix assignments are validated separately, above.
function hasCanonicalInheritedConductorOrchestrationRoots(
  words: string[],
  commandStartIndex: number,
  commandIndex: number,
  rootCwd: string,
): boolean {
  if (nestedExecEnvironmentClearBoundary(words, commandStartIndex, commandIndex) !== null) return true;
  try {
    const canonicalRoot = realpathSync(resolve(rootCwd));
    const expectedStateRoot = realpathSync(join(canonicalRoot, ".omx", "state"));
    for (const [name, expectedPath] of [
      ["OMX_ROOT", canonicalRoot],
      ["OMX_STATE_ROOT", expectedStateRoot],
      ["OMX_TEAM_STATE_ROOT", expectedStateRoot],
    ] as const) {
      const value = safeString(process.env[name]).trim();
      if (value && realpathSync(resolve(rootCwd, value)) !== expectedPath) return false;
    }
  } catch {
    return false;
  }
  return true;
}

function commandHasUnsafeConductorOrchestrationPrefixEnvironment(command: string, rootCwd: string): boolean {
  const canonicalRoot = resolve(rootCwd);
  const expectedStateRoot = resolve(canonicalRoot, ".omx", "state");
  return splitShellCommandSegments(command).some((segment) => {
    const words = tokenizeConductorShellWords(segment);
    return collectShellCliInvocations(words).some(({ commandIndex }) => {
      const commandName = commandNameFromShellWord(words[commandIndex] ?? "");
      if (commandName !== "omx" && commandName !== "gjc") return false;
      for (let index = 0; index < commandIndex; index += 1) {
        const assignment = parseShellAssignmentWord(words[index] ?? "");
        if (!assignment || !/^(?:OMX|GJC)_/.test(assignment.name)) continue;
        if (!conductorOrchestrationRuntimeEnvironmentNameIsPermitted(assignment.name)) return true;
        if (assignment.append || /[$`]/.test(assignment.value)) return true;
        const value = shellWordLiteral(assignment.value);
        if (assignment.name === "OMX_ROOT" && value && resolve(rootCwd, value) !== canonicalRoot) return true;
        if (
          (assignment.name === "OMX_STATE_ROOT" || assignment.name === "OMX_TEAM_STATE_ROOT")
          && value
          && resolve(rootCwd, value) !== expectedStateRoot
        ) return true;
      }
      return false;
    });
  });
}

function omxStateWriteInputWordIsStatic(word: string): boolean {
  const input = shellWordLiteral(word);
  if (!input || isDynamicNestedCommandString(input)) return false;
  return !/(?:^|[^\\])\$(?:[0-9@*#?$!_-])/.test(input)
    && !/(?:^|[^\\])[<>]\(/.test(input);
}

const CONDUCTOR_STATE_WRITE_ALLOWED_PAYLOAD_KEYS = new Set([
  "mode", "active", "current_phase", "currentPhase", "previous_phase", "previousPhase", "phase",
  "status", "reason", "rationale", "summary", "handoff_summary", "evidence", "result", "error",
  "run_outcome", "runOutcome", "lifecycle_outcome", "lifecycleOutcome", "terminal_outcome", "terminalOutcome",
  "started_at", "updated_at", "completed_at", "failed_at", "completion_reason", "failure_reason", "deep_interview_gate",
  "session_id", "owner_omx_session_id", "codex_session_id", "owner_codex_session_id", "workingDirectory",
]);

function conductorStateWritePayloadHasExactSchema(payload: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(payload)) {
    if (key === "state") {
      const nested = safeObject(value);
      if (!nested || !conductorStateWritePayloadHasExactSchema(nested)) return false;
      continue;
    }
    if (!CONDUCTOR_STATE_WRITE_ALLOWED_PAYLOAD_KEYS.has(key)) return false;
    if (key === "mode" && (typeof value !== "string" || !safeString(value).trim())) return false;
  }
  return Object.keys(payload).length > 0;
}
function isStaticallyValidatedOmxStateWriteInvocation(words: string[], commandIndex: number): boolean {
  const args = readOmxStateCommandArgsFromWords(
    [words[commandIndex] ?? "", ...collectConductorInvocationWords(words, commandIndex)],
    "write",
  );
  if (args === null) return false;
  let input: string | undefined;
  let mode: string | undefined;
  let sawJson = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = shellWordLiteral(args[index] ?? "");
    if (!argument || shellWordMayProduceWgetOptions(argument)) return false;
    if (argument === "--json") {
      if (sawJson) return false;
      sawJson = true;
      continue;
    }
    if (argument === "--input" || argument === "--mode") {
      const value = shellWordLiteral(args[index + 1] ?? "");
      if (!value || (argument === "--input"
        ? !omxStateWriteInputWordIsStatic(value)
        : shellWordMayProduceWgetOptions(value))) return false;
      if (argument === "--input") {
        if (input !== undefined) return false;
        input = value;
      } else {
        if (mode !== undefined) return false;
        mode = value;
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--input=") || argument.startsWith("--mode=")) {
      const value = argument.slice(argument.indexOf("=") + 1);
      if (!value || (argument.startsWith("--input=")
        ? !omxStateWriteInputWordIsStatic(value)
        : shellWordMayProduceWgetOptions(value))) return false;
      if (argument.startsWith("--input=")) {
        if (input !== undefined) return false;
        input = value;
      } else {
        if (mode !== undefined) return false;
        mode = value;
      }
      continue;
    }
    return false;
  }
  if (!input || !sawJson) return false;
  try {
    const parsed = JSON.parse(input);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const parsedPayload = parsed as Record<string, unknown>;
    const payloadMode = safeString(parsedPayload.mode).trim();
    if (mode && payloadMode && mode !== payloadMode) return false;
    const payload = mode ? { ...parsedPayload, mode } : parsedPayload;
    return conductorStateWritePayloadHasExactSchema(payload);
  } catch {
    return false;
  }
}

function hasExactConductorOrchestrationOptionSchema(commandName: string, words: string[], commandIndex: number): boolean {
  if (commandName !== "omx" && commandName !== "gjc") return false;
  const args = collectConductorInvocationWords(words, commandIndex);
  const command = shellWordLiteral(args[0] ?? "");
  const subcommand = shellWordLiteral(args[1] ?? "");
  let permitted: Set<string>;
  let required: Set<string>;
  if (command === "ultragoal" && subcommand === "steer") {
    permitted = new Set(["--kind", "--target-goal-id", "--evidence", "--rationale", "--json"]);
    required = new Set(["--kind", "--target-goal-id", "--evidence", "--rationale"]);
  } else if (command === "ultragoal" && subcommand === "checkpoint") {
    permitted = new Set(["--goal-id", "--status", "--codex-goal-json", "--quality-gate-json", "--evidence", "--json"]);
    required = new Set(["--goal-id", "--status", "--codex-goal-json", "--quality-gate-json", "--evidence", "--json"]);
  } else if (command === "performance-goal" && subcommand === "complete") {
    permitted = new Set(["--slug", "--codex-goal-json", "--evidence", "--json"]);
    required = new Set(["--slug", "--codex-goal-json", "--evidence", "--json"]);
  } else if (command === "autoresearch-goal" && subcommand === "complete") {
    permitted = new Set(["--slug", "--codex-goal-json", "--evidence", "--json"]);
    required = new Set(["--slug", "--codex-goal-json", "--json"]);
  } else return false;

  const seen = new Map<string, string>();
  for (let index = 2; index < args.length; index += 1) {
    const raw = args[index] ?? "";
    const option = shellWordLiteral(raw);
    if (!option || !option.startsWith("--") || option === "--" || !conductorOrchestrationWordIsStatic(raw)) return false;
    if (option === "--json") {
      if (!permitted.has(option) || seen.has(option)) return false;
      seen.set(option, "");
      continue;
    }
    const name = option.split("=", 1)[0] ?? "";
    if (!permitted.has(name) || seen.has(name)) return false;
    const rawValue = option.startsWith(`${name}=`) ? option.slice(name.length + 1) : args[index + 1] ?? "";
    const value = shellWordLiteral(rawValue);
    if (!value || !conductorOrchestrationWordIsStatic(rawValue) || shellWordMayProduceWgetOptions(value)) return false;
    if (option === name) index += 1;
    seen.set(name, value);
  }
  if (![...required].every((option) => seen.has(option))) return false;
  const status = seen.get("--status");
  return status === undefined || new Set(["complete", "blocked", "failed", "in_progress"]).has(status);
}

function conductorOrchestrationWordIsStatic(word: string): boolean {
  const literal = shellWordLiteral(word);
  return Boolean(literal)
    && !isDynamicNestedCommandString(literal)
    && !/(?:^|[^\\])\$/.test(word)
    && !/(?:^|[^\\])[<>]\(/.test(word);
}

function isStaticallyRecognizedConductorOrchestrationMutation(
  commandName: string,
  words: string[],
  commandIndex: number,
  argumentProducing: boolean,
): boolean {
  const invocationWords = collectConductorInvocationWords(words, commandIndex);
  const operands = invocationWords
    .map(shellWordLiteral)
    .filter((word) => word && !word.startsWith("-"));
  const command = operands[0] ?? "";
  const subcommand = operands[1] ?? "";
  if (!invocationWords.every(conductorOrchestrationWordIsStatic) || argumentProducing || !hasExactConductorOrchestrationOptionSchema(commandName, words, commandIndex) && commandName !== "gh") return false;
  if (
    (commandName === "omx" || commandName === "gjc")
    && command === "ultragoal"
    && subcommand === "steer"
  ) {
    return hasExactConductorOrchestrationOptionSchema(commandName, words, commandIndex)
      && isStructuredUltragoalSteeringShellCommand(words.join(" "));
  }
  if (commandName === "gh") {
    return isPositivelyClassifiedGhCommand(words, commandIndex)
      && !argumentProducing
      && ghCommandHasMutationIntent(words, commandIndex);
  }
  if (commandName !== "omx" && commandName !== "gjc") return false;
  return hasExactConductorOrchestrationOptionSchema(commandName, words, commandIndex);
}


function findConductorIsolatedInvocationBoundary(words: string[], commandStartIndex: number): number {
  const groupingOpens: number[] = [];
  for (let index = 0; index <= commandStartIndex; index += 1) {
    if (isShellGroupingOpen(words, index)) groupingOpens.push(index);
    else if (words[index] === ")") groupingOpens.pop();
  }

  const enclosingGroupingOpen = groupingOpens.at(-1);
  if (enclosingGroupingOpen !== undefined) {
    let groupingDepth = 1;
    for (let index = enclosingGroupingOpen + 1; index < words.length; index += 1) {
      if (isShellGroupingOpen(words, index)) groupingDepth += 1;
      else if (words[index] === ")") {
        groupingDepth -= 1;
        if (groupingDepth === 0) return index;
      }
    }
    return words.length;
  }

  for (let index = commandStartIndex + 1; index < words.length; index += 1) {
    if (isShellCommandSeparatorAt(words, index)) return index;
  }
  return words.length;
}

function collectConductorFunctionBindingsReachableAfter(
  words: string[],
  boundaryIndex: number,
  functions: ReadonlyMap<string, string[]>,
): Set<string> {
  const reachable = new Set<string>();
  for (const commandStartIndex of collectShellCommandStartIndexes(words)) {
    if (commandStartIndex <= boundaryIndex) continue;
    const commandIndex = skipShellCommandPositionPrefixWords(words, commandStartIndex);
    const commandWord = words[commandIndex] ?? "";
    if (!commandWord) continue;
    if (/[$`]/.test(commandWord)) return new Set(functions.keys());
    const commandName = commandNameFromShellWord(commandWord);
    if (functions.has(commandName)) reachable.add(commandName);
  }
  return reachable;
}

function copyConductorShellBinding(binding: ConductorShellBinding): ConductorShellBinding {
  return {
    ...binding,
    outer: binding.outer ? copyConductorShellBinding(binding.outer) : undefined,
  };
}

function cloneConductorShellBinding(binding: ConductorShellBinding): ConductorShellBinding {
  return {
    ...binding,
    dirty: false,
    outer: binding.outer ? cloneConductorShellBinding(binding.outer) : undefined,
  };
}

function cloneShellPosixState(state: ShellPosixState): ShellPosixState {
  return {
    bindings: new Map([...state.bindings].map(([name, binding]) => [
      name,
      cloneConductorShellBinding(binding),
    ])),
    securityEnvironment: new Map(state.securityEnvironment),
    dirtySecurityEnvironmentNames: new Set(state.dirtySecurityEnvironmentNames),
    securityEnvironmentUnresolved: state.securityEnvironmentUnresolved,
    staticVariables: new Map(state.staticVariables ?? []),
    lastpipe: state.lastpipe,
    jobControl: state.jobControl,
    jobControlMayBeDisabled: state.jobControlMayBeDisabled,
    bashoptsLastpipe: state.bashoptsLastpipe,
    bashoptsExported: state.bashoptsExported,
    allexport: state.allexport,
    shellOptionsKnown: state.shellOptionsKnown,
    effectiveCwd: state.effectiveCwd,
    directoryStack: state.directoryStack === null ? null : [...state.directoryStack],
    aliases: new Map(state.aliases),
    globalAliases: new Set(state.globalAliases),
    functionLocalBindings: new Set(state.functionLocalBindings),
    posixMode: state.posixMode,
    physicalCwd: state.physicalCwd,
    functionShellOptionSnapshot: state.functionShellOptionSnapshot ? { ...state.functionShellOptionSnapshot } : undefined,
    filesystemAliasMayExist: state.filesystemAliasMayExist,
    invalidatedStaticDirectories: new Set(state.invalidatedStaticDirectories),
    pathUsesSystemDefaultWhenUnset: state.pathUsesSystemDefaultWhenUnset,
  };
}

function replaceConductorShellState(target: ShellPosixState, source: ShellPosixState): void {
  target.bindings = source.bindings;
  target.securityEnvironment = new Map(source.securityEnvironment);
  target.dirtySecurityEnvironmentNames = new Set(source.dirtySecurityEnvironmentNames);
  target.securityEnvironmentUnresolved = source.securityEnvironmentUnresolved;
  target.staticVariables = new Map(source.staticVariables ?? []);
  target.lastpipe = source.lastpipe;
  target.jobControl = source.jobControl;
  target.bashoptsLastpipe = source.bashoptsLastpipe;
  target.jobControlMayBeDisabled = source.jobControlMayBeDisabled;
  target.effectiveCwd = source.effectiveCwd;
  target.directoryStack = source.directoryStack === null ? null : [...source.directoryStack];
  target.aliases = source.aliases;
  target.globalAliases = source.globalAliases;
  target.bashoptsExported = source.bashoptsExported;
  target.allexport = source.allexport;
  target.shellOptionsKnown = source.shellOptionsKnown;
  target.functionLocalBindings = new Set(source.functionLocalBindings);
  target.posixMode = source.posixMode;
  target.physicalCwd = source.physicalCwd;
  target.functionShellOptionSnapshot = source.functionShellOptionSnapshot ? { ...source.functionShellOptionSnapshot } : undefined;
  target.filesystemAliasMayExist = source.filesystemAliasMayExist;
  target.invalidatedStaticDirectories = new Set(source.invalidatedStaticDirectories);
  target.pathUsesSystemDefaultWhenUnset = source.pathUsesSystemDefaultWhenUnset;
}

function joinConductorShellStateAlternatives(candidates: ShellPosixState[]): ShellPosixState {
  const cloneForJoin = (candidate: ShellPosixState): ShellPosixState => {
    const cloned = cloneShellPosixState(candidate);
    cloned.bindings = new Map([...candidate.bindings].map(([name, binding]) => [
      name,
      copyConductorShellBinding(binding),
    ]));
    return cloned;
  };
  let joined = cloneForJoin(candidates[0] ?? {
    bindings: new Map(),
    securityEnvironment: new Map(),
    dirtySecurityEnvironmentNames: new Set(),
    securityEnvironmentUnresolved: false,
    lastpipe: false,
    jobControl: false,
    jobControlMayBeDisabled: true,
    physicalCwd: false,
    bashoptsLastpipe: false,
    effectiveCwd: null,
    directoryStack: null,
    aliases: new Map(),
    globalAliases: new Set(),
    bashoptsExported: false,
    allexport: false,
    shellOptionsKnown: true,
    functionLocalBindings: new Set(),
    posixMode: false,
    filesystemAliasMayExist: false,
    invalidatedStaticDirectories: new Set(),
    pathUsesSystemDefaultWhenUnset: false,
  });
  for (const candidate of candidates.slice(1)) {
    const merged = cloneForJoin(candidate);
    joinConductorShellStates(joined, merged);
    joined = merged;
  }
  return joined;
}
function isConductorShellBindingName(name: string): name is ConductorShellBindingName {
  return (CONDUCTOR_SHELL_BINDING_NAMES as readonly string[]).includes(name);
}

function getConductorShellBinding(state: ShellPosixState, name: ConductorShellBindingName): ConductorShellBinding {
  return state.bindings.get(name) ?? { value: undefined, exported: false, readonly: false, local: false, dirty: false };
}
function setConductorShellBinding(
  state: ShellPosixState,
  name: ConductorShellBindingName,
  update: Partial<ConductorShellBinding>,
  persistent: boolean,
): void {
  const previous = getConductorShellBinding(state, name);
  const next: ConductorShellBinding = { ...previous, ...update };
  if (update.local === true && !previous.local) next.outer = copyConductorShellBinding(previous);
  state.bindings.set(name, { ...next, dirty: previous.dirty || (persistent && !previous.local && !update.local) });
}

function beginConductorFunctionLocalBinding(state: ShellPosixState, name: ConductorShellBindingName): void {
  if (state.functionLocalBindings.has(name)) return;
  const previous = getConductorShellBinding(state, name);
  state.bindings.set(name, {
    ...previous,
    local: true,
    outer: copyConductorShellBinding(previous),
  });
  state.functionLocalBindings.add(name);
}

function getConductorGlobalShellBinding(binding: ConductorShellBinding): ConductorShellBinding {
  return binding.local
    ? getConductorGlobalShellBinding(binding.outer ?? { value: undefined, exported: false, readonly: false, local: false, dirty: false })
    : binding;
}

function setGlobalConductorShellBinding(
  state: ShellPosixState,
  name: ConductorShellBindingName,
  update: Partial<ConductorShellBinding>,
): void {
  const updateGlobal = (binding: ConductorShellBinding): ConductorShellBinding => {
    if (!binding.local) return { ...binding, ...update, local: false, outer: undefined, dirty: true };
    return {
      ...binding,
      outer: updateGlobal(binding.outer ?? { value: undefined, exported: false, readonly: false, local: false, dirty: false }),
    };
  };
  state.bindings.set(name, updateGlobal(getConductorShellBinding(state, name)));
}
function commandMayBeConditionallyExecuted(words: string[], commandStartIndex: number): boolean {
  let ifDepth = 0;
  let caseDepth = 0;
  let loopDepth = 0;
  for (let index = 0; index < commandStartIndex; index += 1) {
    const word = words[index] ?? "";
    if (word === "if") ifDepth += 1;
    else if (word === "fi" && ifDepth > 0) ifDepth -= 1;
    else if (word === "case") caseDepth += 1;
    else if (word === "esac" && caseDepth > 0) caseDepth -= 1;
    else if (word === "while" || word === "until" || word === "for" || word === "select") loopDepth += 1;
    else if (word === "done" && loopDepth > 0) loopDepth -= 1;
  }
  const previous = words[commandStartIndex - 1] ?? "";
  return ifDepth > 0 || caseDepth > 0 || loopDepth > 0 || previous === "&&" || previous === "||";
}

function joinConductorShellStates(baseline: ShellPosixState, candidate: ShellPosixState): void {
  for (const name of CONDUCTOR_SHELL_BINDING_NAMES) {
    const prior = getConductorShellBinding(baseline, name);
    const next = getConductorShellBinding(candidate, name);
    if (
      prior.value === next.value
      && prior.exported === next.exported
      && prior.readonly === next.readonly
      && prior.readonlyPossible === next.readonlyPossible
      && prior.local === next.local
    ) continue;
    candidate.bindings.set(name, {
      value: prior.value === next.value ? prior.value : CONDUCTOR_UNKNOWN_SHELL_BINDING,
      exported: prior.exported === next.exported ? prior.exported : true,
      readonly: prior.readonly && next.readonly,
      readonlyPossible: prior.readonly || next.readonly || prior.readonlyPossible || next.readonlyPossible,
      local: prior.local && next.local,
      dirty: prior.dirty || next.dirty,
    });
  }
  for (const name of candidate.functionLocalBindings) {
    if (!baseline.functionLocalBindings.has(name)) candidate.functionLocalBindings.delete(name);
  }
  candidate.securityEnvironmentUnresolved ||= baseline.securityEnvironmentUnresolved;
  candidate.dirtySecurityEnvironmentNames = new Set([
    ...baseline.dirtySecurityEnvironmentNames,
    ...candidate.dirtySecurityEnvironmentNames,
  ]);
  for (const name of new Set([...baseline.securityEnvironment.keys(), ...candidate.securityEnvironment.keys()])) {
    const prior = baseline.securityEnvironment.get(name);
    const next = candidate.securityEnvironment.get(name);
    if (prior === next) continue;
    candidate.securityEnvironment.set(name, CONDUCTOR_UNKNOWN_SHELL_BINDING);
  }
  const staticVariableNames = new Set<string>([
    ...(baseline.staticVariables?.keys() ?? []),
    ...(candidate.staticVariables?.keys() ?? []),
  ]);
  const staticVariables = new Map<string, string>();
  for (const name of staticVariableNames) {
    const prior = baseline.staticVariables?.get(name);
    const next = candidate.staticVariables?.get(name);
    if (prior !== undefined && prior === next) staticVariables.set(name, prior);
  }
  candidate.staticVariables = staticVariables;
  const shellOptionSnapshotKeys = ["lastpipe", "jobControl", "jobControlMayBeDisabled", "allexport", "posixMode", "physicalCwd"] as const;
  if (shellOptionSnapshotKeys.some((key) => baseline.functionShellOptionSnapshot?.[key] !== candidate.functionShellOptionSnapshot?.[key])) {
    candidate.shellOptionsKnown = false;
  }
  candidate.lastpipe = baseline.lastpipe || candidate.lastpipe;
  candidate.jobControl = baseline.jobControl || candidate.jobControl;
  candidate.bashoptsLastpipe = baseline.bashoptsLastpipe || candidate.bashoptsLastpipe;
  candidate.bashoptsExported = baseline.bashoptsExported || candidate.bashoptsExported;
  candidate.allexport = baseline.allexport || candidate.allexport;
  candidate.shellOptionsKnown = baseline.shellOptionsKnown && candidate.shellOptionsKnown;
  candidate.posixMode = baseline.posixMode || candidate.posixMode;
  candidate.physicalCwd = baseline.physicalCwd || candidate.physicalCwd;
  candidate.filesystemAliasMayExist = baseline.filesystemAliasMayExist || candidate.filesystemAliasMayExist;
  candidate.pathUsesSystemDefaultWhenUnset = baseline.pathUsesSystemDefaultWhenUnset && candidate.pathUsesSystemDefaultWhenUnset;
  candidate.invalidatedStaticDirectories = new Set([
    ...baseline.invalidatedStaticDirectories,
    ...candidate.invalidatedStaticDirectories,
  ]);
  candidate.jobControlMayBeDisabled = baseline.jobControlMayBeDisabled || candidate.jobControlMayBeDisabled;
  candidate.effectiveCwd = baseline.effectiveCwd === candidate.effectiveCwd ? baseline.effectiveCwd : null;
  candidate.directoryStack = baseline.directoryStack !== null
    && candidate.directoryStack !== null
    && baseline.directoryStack.length === candidate.directoryStack.length
    && baseline.directoryStack.every((directory, index) => directory === candidate.directoryStack?.[index])
    ? [...baseline.directoryStack]
    : null;
  const aliasNames = new Set([...baseline.aliases.keys(), ...candidate.aliases.keys()]);
  for (const name of aliasNames) {
    const baselineTarget = baseline.aliases.get(name);
    const candidateTarget = candidate.aliases.get(name);
    if (baselineTarget !== candidateTarget || !baseline.aliases.has(name) || !candidate.aliases.has(name)) candidate.aliases.set(name, null);
    if (baseline.globalAliases.has(name) && candidate.globalAliases.has(name)) candidate.globalAliases.add(name);
    else candidate.globalAliases.delete(name);
  }
}

function stateHasPosixlyCorrect(state: ShellPosixState): boolean {
  const binding = getConductorShellBinding(state, "POSIXLY_CORRECT");
  return state.posixMode || binding.exported && binding.value !== undefined;
}

function wordConfiguresPosixlyCorrect(word: string): boolean {
  return parseShellAssignmentWord(word)?.name === "POSIXLY_CORRECT";
}

function resolveConductorCommandIndex(words: string[], startIndex: number): ConductorCommandInvocation {
  let commandIndex = skipShellCommandPositionPrefixWords(words, startIndex);
  let functionLookupAllowed = true;
  let argumentProducing = false;
  let childDispatch = false;
  const visited = new Set<number>();
  while (commandIndex < words.length) {
    if (visited.has(commandIndex)) return { index: commandIndex, unresolved: true, functionLookupAllowed, argumentProducing, childDispatch };
    visited.add(commandIndex);
    const commandName = commandNameFromShellWord(words[commandIndex] ?? "");
    if (CONDUCTOR_BASH_TRANSPARENT_WRAPPERS.has(commandName)) {
      if (commandName === "builtin") functionLookupAllowed = false;
      commandIndex += 1;
      continue;
    }
    const operandIndex = findConductorWrapperOperandIndex(commandName, words, commandIndex + 1);
    if (operandIndex === undefined) return { index: commandIndex, unresolved: false, functionLookupAllowed, argumentProducing, childDispatch };
    if (operandIndex === null) return { index: commandIndex, unresolved: true, functionLookupAllowed, argumentProducing, childDispatch };
    if (commandName === "xargs") argumentProducing = true;
    if (["env", "exec", "nice", "nohup", "setsid", "stdbuf", "sudo", "timeout", "xargs", "coproc"].includes(commandName)) childDispatch = true;
    if (commandName !== "time" && commandName !== "coproc") functionLookupAllowed = false;
    commandIndex = skipShellCommandPositionPrefixWords(words, operandIndex);
  }
  return { index: commandIndex, unresolved: true, functionLookupAllowed, argumentProducing, childDispatch };
}

function commandPrefixConfiguresPosixlyCorrect(words: string[], commandStartIndex: number, commandIndex: number): boolean {
  return words.slice(commandStartIndex, commandIndex).some(wordConfiguresPosixlyCorrect);
}

function commandHasPosixlyCorrectPrefix(words: string[], commandIndex: number): boolean {
  for (let index = commandIndex - 1; index >= 0; index -= 1) {
    const word = words[index] ?? "";
    if (isShellCommandSeparator(word) || isShellGroupingSyntaxWord(word)) break;
    if (!isEnvironmentAssignmentWord(word)) break;
    if (wordConfiguresPosixlyCorrect(word)) return true;
  }
  return false;
}

function declarationExportMode(commandName: string, words: string[], commandIndex: number): boolean | undefined {
  if (commandName !== "export" && commandName !== "declare" && commandName !== "typeset" && commandName !== "local") return undefined;
  let exported: boolean | undefined = commandName === "export" ? true : undefined;
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined || isShellCommandTerminatorOrGroupClose(word)) break;
    if (word.startsWith("+")) {
      if (word.slice(1).includes("x")) exported = false;
      continue;
    }
    if (word.startsWith("-")) {
      if (commandName === "export" && word.slice(1).includes("n")) exported = false;
      if (word.slice(1).includes("x")) exported = true;
    }
  }
  return exported;
}

function declarationReadonlyMode(commandName: string, words: string[], commandIndex: number): boolean | undefined {
  if (commandName !== "readonly" && commandName !== "declare" && commandName !== "typeset" && commandName !== "local") return undefined;
  let readonly: boolean | undefined = commandName === "readonly" ? true : undefined;
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (isShellCommandTerminatorOrGroupClose(word)) break;
    if (word.startsWith("+")) {
      if (word.slice(1).includes("r")) readonly = false;
    } else if (word.startsWith("-") && word.slice(1).includes("r")) {
      readonly = true;
    }
  }
  return readonly;
}

function declarationTargetsFunctions(operands: string[]): boolean {
  return operands.some((word) => /^[-+][A-Za-z]*f/.test(word));
}

function declarationInheritsLocal(operands: string[]): boolean {
  return operands.some((word) => /^-[A-Za-z]*I/.test(word));
}

function declarationIsGlobal(commandName: string, words: string[], commandIndex: number): boolean {
  if (commandName !== "declare" && commandName !== "typeset") return false;
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined || isShellCommandTerminatorOrGroupClose(word)) break;
    if (word.startsWith("-") && word.slice(1).includes("g")) return true;
  }
  return false;
}

function resolveConductorShellAssignmentValue(
  previous: ConductorShellBinding,
  assignment: { append: boolean; value: string },
): string {
  if (/[$`]/.test(assignment.value)) return CONDUCTOR_UNKNOWN_SHELL_BINDING;
  if (!assignment.append) return assignment.value;
  if (previous.value === undefined) return assignment.value;
  if (previous.value === CONDUCTOR_UNKNOWN_SHELL_BINDING) return CONDUCTOR_UNKNOWN_SHELL_BINDING;
  return `${previous.value}${assignment.value}`;
}

function applyConductorSecurityEnvironmentAssignment(
  state: ShellPosixState,
  assignment: { name: string; append: boolean; value: string },
  options: { local?: boolean; persistent: boolean },
): void {
  if (!isConductorSecuritySensitiveEnvironmentName(assignment.name)) return;
  const value = assignment.append || /[$`]/.test(assignment.value)
    ? CONDUCTOR_UNKNOWN_SHELL_BINDING
    : assignment.value;
  if (value.trim() === "") state.securityEnvironment.delete(assignment.name);
  else state.securityEnvironment.set(assignment.name, value);
  if (options.persistent) state.dirtySecurityEnvironmentNames.add(assignment.name);
}

function unsetConductorSecurityEnvironment(state: ShellPosixState, name: string, persistent: boolean): void {
  if (!isConductorSecuritySensitiveEnvironmentName(name)) return;
  state.securityEnvironment.delete(name);
  if (persistent) state.dirtySecurityEnvironmentNames.add(name);
}

function applyConductorAssignment(state: ShellPosixState, assignment: { name: string; append: boolean; value: string }, options: { exported?: boolean; local?: boolean; readonly?: boolean; persistent: boolean }): void {
  applyConductorSecurityEnvironmentAssignment(state, assignment, options);
  if (assignment.name === "BASHOPTS") {
    const current = state.bashoptsLastpipe ? "lastpipe" : "";
    const value = resolveConductorShellAssignmentValue({ value: current, exported: state.bashoptsExported, readonly: false, local: false, dirty: false }, assignment);
    const shellOptions = parseConductorBashOptions(value);
    state.bashoptsLastpipe = value === CONDUCTOR_UNKNOWN_SHELL_BINDING || value.split(":").includes("lastpipe");
    state.shellOptionsKnown &&= shellOptions.known;
    if (value === CONDUCTOR_UNKNOWN_SHELL_BINDING) state.shellOptionsKnown = false;
    if (options.exported !== undefined) state.bashoptsExported = options.exported;
    return;
  }
  const alias = state.aliases.get(assignment.name);
  if (alias === null && state.aliases.has(assignment.name)) {
    for (const name of CONDUCTOR_SHELL_BINDING_NAMES) {
      setConductorShellBinding(state, name, { value: CONDUCTOR_UNKNOWN_SHELL_BINDING, exported: true }, true);
    }
    return;
  }
  const targetName = alias ?? assignment.name;
  if (!isConductorShellBindingName(targetName)) return;
  const previous = getConductorShellBinding(state, targetName);
  if (previous.readonly) return;
  if (previous.readonlyPossible) {
    setConductorShellBinding(state, targetName, {
      value: CONDUCTOR_UNKNOWN_SHELL_BINDING,
      exported: options.exported ?? previous.exported,
      local: options.local ?? previous.local,
      readonly: false,
      readonlyPossible: true,
    }, options.persistent);
    return;
  }
  const value = resolveConductorShellAssignmentValue(previous, assignment);
  setConductorShellBinding(state, targetName, {
    value,
    exported: options.exported ?? previous.exported,
    local: options.local ?? previous.local,
    readonly: options.readonly ?? previous.readonly,
    readonlyPossible: false,
  }, options.persistent);
}

function applyCommandPrefixEnvironment(words: string[], commandStartIndex: number, commandIndex: number, state: ShellPosixState): void {
  for (const word of words.slice(commandStartIndex, commandIndex)) {
    const assignment = parseShellAssignmentWord(word);
    if (assignment) applyConductorAssignment(state, assignment, { exported: true, local: true, persistent: false });
  }
}

function applyStandaloneConductorAssignments(words: string[], commandStartIndex: number, commandIndex: number, state: ShellPosixState): void {
  for (const word of words.slice(commandStartIndex, commandIndex)) {
    const assignment = parseShellAssignmentWord(word);
    if (!assignment) continue;
    applyConductorAssignment(state, assignment, {
      exported: state.allexport,
      persistent: !getConductorShellBinding(state, assignment.name as ConductorShellBindingName).local,
    });
    if (!assignment.append && !/[$`]/.test(assignment.value)) {
      (state.staticVariables ??= new Map<string, string>()).set(assignment.name, assignment.value);
    } else {
      state.staticVariables?.delete(assignment.name);
    }
  }
}

function markConductorCwdUnresolved(state: ShellPosixState): void {
  state.effectiveCwd = null;
  state.directoryStack = null;
}

function classifyConductorStaticDirectory(path: string): "accessible" | "unknown" {
  try {
    if (!statSync(path).isDirectory()) return "unknown";
    accessSync(path, fsConstants.X_OK);
    return "accessible";
  } catch {
    return "unknown";
  }
}

function isConductorStaticDirectoryInvalidated(state: ShellPosixState, path: string): boolean {
  return [...state.invalidatedStaticDirectories].some((invalidated) => (
    path === invalidated || path.startsWith(`${invalidated}/`)
  ));
}

function invalidateConductorStaticDirectoryProofs(state: ShellPosixState, targets: string[], cwd: string): void {
  for (const target of targets) {
    if (!target || /[$`]/.test(target)) {
      markConductorCwdUnresolved(state);
      return;
    }
    try {
      state.invalidatedStaticDirectories.add(isAbsolute(target) ? resolve(target) : resolve(cwd, target));
    } catch {
      markConductorCwdUnresolved(state);
      return;
    }
  }
}

function classifyConductorStaticDirectoryForState(state: ShellPosixState, path: string): "accessible" | "unknown" {
  return isConductorStaticDirectoryInvalidated(state, path)
    ? "unknown"
    : classifyConductorStaticDirectory(path);
}


type ConductorStaticDirectoryChange = string | null;

function resolveConductorStaticDirectoryChange(
  state: ShellPosixState,
  target: string,
  physicalCwd = state.physicalCwd,
): ConductorStaticDirectoryChange {
  if (state.effectiveCwd === null || /[$`]/.test(target)) return null;
  const resolveCandidate = (candidate: string): ConductorStaticDirectoryChange => {
    if (classifyConductorStaticDirectoryForState(state, candidate) !== "accessible") return null;
    if (!physicalCwd) return candidate;
    try {
      return realpathSync(candidate);
    } catch {
      return null;
    }
  };
  const resolvesThroughCdpath = !isAbsolute(target)
    && target !== "."
    && !target.startsWith("./")
    && !target.startsWith("../");
  try {
    const cdpath = getConductorShellBinding(state, "CDPATH").value;
    if (!resolvesThroughCdpath || !cdpath) return resolveCandidate(resolve(state.effectiveCwd, target));
    if (cdpath === CONDUCTOR_UNKNOWN_SHELL_BINDING) return null;
    for (const prefix of cdpath.split(":")) {
      const candidate = resolve(state.effectiveCwd, prefix || ".", target);
      if (classifyConductorStaticDirectoryForState(state, candidate) !== "accessible") return null;
      return resolveCandidate(candidate);
    }
    return resolveCandidate(resolve(state.effectiveCwd, target));
  } catch {
    return null;
  }
}

function applyShellCwdStateEffect(words: string[], commandIndex: number, state: ShellPosixState): void {
  const commandName = commandNameFromShellWord(words[commandIndex] ?? "");
  if (commandName !== "cd" && commandName !== "pushd" && commandName !== "popd") return;

  const operands = collectConductorInvocationWords(words, commandIndex).map(shellWordLiteral);
  if (commandName === "popd") {
    if (operands.length > 0 || state.directoryStack === null) {
      markConductorCwdUnresolved(state);
      return;
    }
    if (state.directoryStack.length < 2) return;
    state.directoryStack = state.directoryStack.slice(1);
    state.effectiveCwd = state.directoryStack[0] ?? null;
    return;
  }

  const unsafeOption = operands.some((operand) => (
    operand.startsWith("-")
    && operand !== "-P"
    && operand !== "-L"
    && operand !== "--"
  ));
  const nonOptionOperands = operands.filter((operand) => !operand.startsWith("-"));
  if (commandName === "pushd" && nonOptionOperands.length === 0) {
    if (operands.length > 0 || state.directoryStack === null) {
      markConductorCwdUnresolved(state);
      return;
    }
    if (state.directoryStack.length < 2) return;
    state.directoryStack = [state.directoryStack[1] ?? "", state.directoryStack[0] ?? "", ...state.directoryStack.slice(2)];
    state.effectiveCwd = state.directoryStack[0] ?? null;
    return;
  }
  if (unsafeOption || nonOptionOperands.length !== 1 || !nonOptionOperands[0] || nonOptionOperands[0] === "-") {
    if (nonOptionOperands.length > 1) return;
    markConductorCwdUnresolved(state);
    return;
  }
  const physicalCwd = operands.includes("-P") || (!operands.includes("-L") && state.physicalCwd);
  const directoryChange = resolveConductorStaticDirectoryChange(state, nonOptionOperands[0], physicalCwd);
  if (directoryChange === null) {
    markConductorCwdUnresolved(state);
    return;
  }
  if (commandName === "pushd") {
    if (operands.some((operand) => operand.startsWith("-")) || state.directoryStack === null || state.directoryStack[0] !== state.effectiveCwd || state.directoryStack.length >= 16) {
      markConductorCwdUnresolved(state);
      return;
    }
    state.directoryStack = [directoryChange, ...state.directoryStack];
  } else if (state.directoryStack !== null) {
    state.directoryStack = [directoryChange, ...state.directoryStack.slice(1)];
  }
  state.effectiveCwd = directoryChange;
}

function applyShellCwdStateEffectWithPrefix(
  words: string[],
  commandStartIndex: number,
  commandIndex: number,
  state: ShellPosixState,
): void {
  const commandState = cloneShellPosixState(state);
  applyCommandPrefixEnvironment(words, commandStartIndex, commandIndex, commandState);
  applyShellCwdStateEffect(words, commandIndex, commandState);
  state.effectiveCwd = commandState.effectiveCwd;
  state.directoryStack = commandState.directoryStack === null ? null : [...commandState.directoryStack];
}

const CONDUCTOR_POSIX_SPECIAL_BUILTINS = new Set([
  ".", ":", "break", "continue", "eval", "exec", "exit", "export", "readonly", "return", "set", "shift", "trap", "unset",
]);

function applyPosixSpecialBuiltinPrefixAssignments(
  words: string[],
  commandStartIndex: number,
  commandIndex: number,
  commandName: string,
  state: ShellPosixState,
): void {
  if (!state.posixMode || !CONDUCTOR_POSIX_SPECIAL_BUILTINS.has(commandName)) return;
  for (const word of words.slice(commandStartIndex, commandIndex)) {
    const assignment = parseShellAssignmentWord(word);
    if (!assignment || !isConductorShellBindingName(assignment.name)) continue;
    applyConductorAssignment(state, assignment, { exported: true, local: false, persistent: true });
  }
}

function applyStaticExpansionStateEffects(words: string[], commandStartIndex: number, state: ShellPosixState): void {
  for (let index = commandStartIndex; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (isShellCommandTerminatorOrGroupClose(word)) break;
    for (const match of word.matchAll(/\$CONDUCTOR_(ARITH|PARAMETER)_ASSIGN_([A-Za-z_][A-Za-z0-9_]*)_(SET|APPEND|DYNAMIC)_([A-Za-z0-9_./-]+)/g)) {
      const kind = match[1] ?? "";
      const name = match[2] ?? "";
      const mode = match[3] ?? "DYNAMIC";
      const value = match[4] === "DYNAMIC" ? CONDUCTOR_UNKNOWN_SHELL_BINDING : match[4] ?? "";
      const baseline = kind === "PARAMETER" ? cloneShellPosixState(state) : null;
      applyConductorAssignment(state, { name, append: mode === "APPEND", value }, {
        persistent: isConductorShellBindingName(name) ? !getConductorShellBinding(state, name).local : true,
      });
      if (baseline) joinConductorShellStates(baseline, state);
    }
  }
}

function markConductorTrackedBindingsUnresolved(state: ShellPosixState): void {
  for (const name of CONDUCTOR_SHELL_BINDING_NAMES) {
    const binding = getConductorShellBinding(state, name);
    if (binding.readonly) continue;
    setConductorShellBinding(state, name, {
      value: CONDUCTOR_UNKNOWN_SHELL_BINDING,
      exported: true,
    }, !binding.local);
  }
}

function applyConductorTrackedVariableWrite(state: ShellPosixState, name: string, value: string): void {
  const target = state.aliases.get(name) ?? name;
  if (target === null) {
    markConductorTrackedBindingsUnresolved(state);
    return;
  }
  if (!isConductorShellBindingName(target)) return;
  const binding = getConductorShellBinding(state, target);
  applyConductorAssignment(state, { name, append: false, value }, { persistent: !binding.local });
}

function isConductorStaticVariableName(word: string): boolean {
  const value = shellWordLiteral(word);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !/[$`]/.test(value);
}

function resolveConductorStaticVariableName(state: ShellPosixState, word: string): string | null {
  const literal = shellWordLiteral(word);
  if (isConductorStaticVariableName(literal)) return literal;
  let unresolved = false;
  const value = literal.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_match, bracedName, bareName) => {
    const staticValue = state.staticVariables?.get(bracedName ?? bareName);
    const bindingValue = staticValue ?? getConductorShellBinding(state, bracedName ?? bareName).value;
    if (bindingValue === undefined || bindingValue === CONDUCTOR_UNKNOWN_SHELL_BINDING || /[$`]/.test(bindingValue)) {
      unresolved = true;
      return "";
    }
    return bindingValue;
  });
  return !unresolved && isConductorStaticVariableName(value) ? value : null;
}

function applyConductorTrackedVariableWriter(words: string[], commandIndex: number, state: ShellPosixState): void {
  const commandName = commandNameFromShellWord(words[commandIndex] ?? "");
  const operands = collectConductorInvocationWords(words, commandIndex);
  if (commandName === "printf") {
    const valueIndex = operands.findIndex((operand) => shellWordLiteral(operand) === "-v");
    if (valueIndex < 0) return;
    const name = operands[valueIndex + 1] ?? "";
    if (!isConductorStaticVariableName(name)) {
      markConductorTrackedBindingsUnresolved(state);
      return;
    }
    const format = shellWordLiteral(operands[valueIndex + 2] ?? "");
    const values = operands.slice(valueIndex + 3).map(shellWordLiteral);
    const value = format === "%s" && values.length === 1 && !/[$`]/.test(values[0] ?? "")
      ? values[0] ?? ""
      : !format.includes("%") && values.length === 0 && !/[$`]/.test(format)
        ? format
        : CONDUCTOR_UNKNOWN_SHELL_BINDING;
    applyConductorTrackedVariableWrite(state, shellWordLiteral(name), value);
    return;
  }
  if (commandName === "read") {
    const names: string[] = [];
    let optionsTerminated = false;
    for (let index = 0; index < operands.length; index += 1) {
      const operand = shellWordLiteral(operands[index] ?? "");
      if (operand === "--") {
        optionsTerminated = true;
        continue;
      }
      if (!optionsTerminated && operand.startsWith("-")) {
        if (["-d", "-n", "-N", "-p", "-t", "-u"].includes(operand)) index += 1;
        continue;
      }
      names.push(operand);
    }
    if (names.some((name) => !isConductorStaticVariableName(name))) markConductorTrackedBindingsUnresolved(state);
    else for (const name of names) applyConductorTrackedVariableWrite(state, name, CONDUCTOR_UNKNOWN_SHELL_BINDING);
    return;
  }
  if (commandName === "wait") {
    let targetName: string | null = null;
    let optionsTerminated = false;
    for (let index = 0; index < operands.length; index += 1) {
      const rawOperand = operands[index] ?? "";
      const operand = shellWordLiteral(rawOperand);
      if (!operand || /[$`]/.test(rawOperand)) {
        markConductorTrackedBindingsUnresolved(state);
        return;
      }
      if (!optionsTerminated && operand === "--") {
        optionsTerminated = true;
        continue;
      }
      if (optionsTerminated || !operand.startsWith("-") || operand === "-") continue;
      if (operand === "-p") {
        const target = shellWordLiteral(operands[index + 1] ?? "");
        if (targetName !== null || !isConductorStaticVariableName(target)) {
          markConductorTrackedBindingsUnresolved(state);
          return;
        }
        targetName = target;
        index += 1;
        continue;
      }
      if (!/^-([nf]*p[A-Za-z_][A-Za-z0-9_]*|[nf]*p|[nf]+)$/.test(operand)) {
        markConductorTrackedBindingsUnresolved(state);
        return;
      }
      const cluster = operand.slice(1);
      const pIndex = cluster.indexOf("p");
      if (pIndex < 0) continue;
      if (targetName !== null || cluster.indexOf("p", pIndex + 1) >= 0 || !/^[nf]*$/.test(cluster.slice(0, pIndex))) {
        markConductorTrackedBindingsUnresolved(state);
        return;
      }
      const attachedTarget = cluster.slice(pIndex + 1);
      if (attachedTarget) {
        if (!isConductorStaticVariableName(attachedTarget)) {
          markConductorTrackedBindingsUnresolved(state);
          return;
        }
        targetName = attachedTarget;
        continue;
      }
      const target = shellWordLiteral(operands[index + 1] ?? "");
      if (!isConductorStaticVariableName(target)) {
        markConductorTrackedBindingsUnresolved(state);
        return;
      }
      targetName = target;
      index += 1;
    }
    if (targetName !== null) applyConductorTrackedVariableWrite(state, targetName, CONDUCTOR_UNKNOWN_SHELL_BINDING);
    return;
  }
  if (commandName === "getopts") {
    const name = shellWordLiteral(operands[1] ?? "");
    if (!isConductorStaticVariableName(name)) markConductorTrackedBindingsUnresolved(state);
    else applyConductorTrackedVariableWrite(state, name, CONDUCTOR_UNKNOWN_SHELL_BINDING);
  }
}

function applyConductorLoopVariableWriter(words: string[], commandIndex: number, state: ShellPosixState): void {
  const name = shellWordLiteral(words[commandIndex + 1] ?? "");
  if (!isConductorStaticVariableName(name)) markConductorTrackedBindingsUnresolved(state);
  else applyConductorTrackedVariableWrite(state, name, CONDUCTOR_UNKNOWN_SHELL_BINDING);
}

function resolveConductorCommandPathState(
  words: string[],
  commandStartIndex: number,
  commandIndex: number,
  state: ShellPosixState,
): ShellPosixState {
  const commandState = cloneShellPosixState(state);
  const clearBoundary = nestedExecEnvironmentClearBoundary(words, commandStartIndex, commandIndex);
  if (clearBoundary !== null) {
    commandState.bindings.delete("PATH");
    commandState.pathUsesSystemDefaultWhenUnset = true;
  }
  for (const word of words.slice(clearBoundary === null ? commandStartIndex : clearBoundary + 1, commandIndex)) {
    const assignment = parseShellAssignmentWord(word);
    if (assignment?.name === "PATH") {
      applyConductorAssignment(commandState, assignment, { exported: true, local: false, persistent: true });
    }
  }
  return commandState;
}

function conductorValidatedWorkspaceNpmBinDirectory(rootCwd: string): string | null {
  try {
    const workspaceRoot = realpathSync(resolve(rootCwd));
    const binDirectory = realpathSync(join(workspaceRoot, "node_modules", ".bin"));
    const omxCandidate = join(binDirectory, "omx");
    const knownOmxCli = conductorKnownPackageCliPath("omx");
    if (!lstatSync(omxCandidate).isSymbolicLink() || knownOmxCli === null) return null;
    accessSync(omxCandidate, fsConstants.X_OK);
    return realpathSync(omxCandidate) === knownOmxCli ? binDirectory : null;
  } catch {
    return null;
  }
}

function conductorWorkspaceNpmBinPathMayResolveRepositoryExecutable(
  commandName: string,
  binDirectory: string,
  rootCwd: string,
): boolean | null {
  if (binDirectory !== conductorValidatedWorkspaceNpmBinDirectory(rootCwd)) return null;
  const candidate = join(binDirectory, commandName);
  try {
    if (!existsSync(candidate)) return null;
    accessSync(candidate, fsConstants.X_OK);
    return !conductorWorkspacePackageCliCandidateIsTrusted(commandName, candidate, binDirectory, rootCwd);
  } catch {
    return true;
  }
}

// The hook's own Node executable may be user-managed, but only its exact canonical identity is trusted.
function conductorExecutableHasTrustedCurrentNodeRuntimeIdentity(commandName: string, commandPath: string): boolean {
  const commandBase = shellWordBaseName(commandPath).toLowerCase();
  if ((commandName !== "node" && commandName !== "node.exe") || commandBase !== commandName) return false;
  try {
    const canonical = realpathSync(commandPath);
    if (canonical !== realpathSync(process.execPath)) return false;
    const executable = statSync(canonical);
    if (!executable.isFile()) return false;
    accessSync(canonical, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function conductorExecutableHasTrustedIdentity(
  commandName: string,
  commandPath: string,
  rootCwd: string,
  state: ShellPosixState,
  depth = 0,
  seen = new Set<string>(),
): boolean {
  if (conductorExecutableHasTrustedCurrentNodeRuntimeIdentity(commandName, commandPath)) return true;
  if (!conductorExecutableHasTrustedSystemIdentity(commandPath, rootCwd)) return false;
  if (depth >= CONDUCTOR_BASH_MAX_NESTING_DEPTH) return false;
  let canonical: string;
  try {
    canonical = realpathSync(commandPath);
  } catch {
    return false;
  }
  if (seen.has(canonical)) return false;
  seen.add(canonical);
  return conductorTrustedScriptInterpreterIsSafe(canonical, state, rootCwd, depth, seen);
}

function conductorExecutableHasTrustedSystemIdentity(commandPath: string, rootCwd: string): boolean {
  try {
    const lexical = resolve(commandPath);
    const root = realpathSync(resolve(rootCwd));
    if (lexical === root || lexical.startsWith(`${root}/`)) return false;

    // Trust the spelling and its target. A user-controlled symlink cannot borrow
    // a system executable's identity merely by resolving to it.
    for (let path = lexical; ; path = dirname(path)) {
      const metadata = lstatSync(path);
      // Symlink permission bits are always reported as writable on POSIX. Trust
      // a lexical alias only when its link ownership and every non-link path
      // component are system-controlled; its canonical target is checked below.
      if (metadata.uid !== 0 || (!metadata.isSymbolicLink() && (metadata.mode & 0o022) !== 0)) return false;
      const parent = dirname(path);
      if (parent === path) break;
    }

    const canonical = realpathSync(lexical);
    if (canonical === root || canonical.startsWith(`${root}/`)) return false;
    const executable = statSync(canonical);
    if (!executable.isFile() || executable.uid !== 0 || (executable.mode & 0o022) !== 0) return false;
    accessSync(canonical, fsConstants.X_OK);
    for (let directory = dirname(canonical); ; directory = dirname(directory)) {
      const metadata = statSync(directory);
      if (!metadata.isDirectory() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) return false;
      const parent = dirname(directory);
      if (parent === directory) return true;
    }
  } catch {
    return false;
  }
}

function conductorNativeExecutableHeaderIsRecognized(header: Buffer): boolean {
  if (header.length < 2) return false;
  return (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46)
    || (header[0] === 0x4d && header[1] === 0x5a)
    || header.includes(0);
}

function conductorResolvePathInterpreter(commandName: string, state: ShellPosixState): string | null {
  const path = getConductorShellBinding(state, "PATH").value;
  if (!path || path === CONDUCTOR_UNKNOWN_SHELL_BINDING) return null;
  for (const entry of path.split(":")) {
    if (!entry || !isAbsolute(entry) || isConductorStaticDirectoryInvalidated(state, resolve(entry))) return null;
    const candidate = join(entry, commandName);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return null;
    }
  }
  return null;
}

function conductorTrustedScriptInterpreterIsSafe(
  commandPath: string,
  state: ShellPosixState,
  rootCwd: string,
  depth: number,
  seen: Set<string>,
): boolean {
  let header: Buffer;
  try {
    header = readFileSync(commandPath).subarray(0, 4096);
  } catch {
    return false;
  }
  if (conductorNativeExecutableHeaderIsRecognized(header)) return true;
  const firstLine = header.toString("utf-8").split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.startsWith("#!")) return false;
  const shebangWords = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
  const interpreter = shebangWords.shift() ?? "";
  if (!interpreter || /[$`\\]/.test(interpreter)) return false;
  if (shellWordBaseName(interpreter) === "env") {
    if (!isAbsolute(interpreter) || !conductorExecutableHasTrustedSystemIdentity(interpreter, rootCwd)) return false;
    let environmentWords = shebangWords;
    if (environmentWords[0] === "-S" || environmentWords[0] === "--split-string") {
      environmentWords = tokenizeShellWords(environmentWords.slice(1).join(" "));
    }
    const target = environmentWords[0] ?? "";
    if (!target || target.startsWith("-") || /[$`\\]/.test(target)) return false;
    const targetPath = conductorResolvePathInterpreter(target, state);
    return targetPath !== null
      && conductorExecutableHasTrustedIdentity(target, targetPath, rootCwd, state, depth + 1, seen);
  }
  if (!isAbsolute(interpreter)) return false;
  return conductorExecutableHasTrustedIdentity(
    shellWordBaseName(interpreter),
    interpreter,
    rootCwd,
    state,
    depth + 1,
    seen,
  );
}

function conductorPathMayResolveRepositoryExecutable(
  state: ShellPosixState,
  commandName: string,
  rootCwd: string,
): boolean {
  if (state.filesystemAliasMayExist) return true;
  const binding = getConductorShellBinding(state, "PATH");
  const path = binding.value;
  if (path === undefined) return !state.pathUsesSystemDefaultWhenUnset;
  if (path === "" || path === CONDUCTOR_UNKNOWN_SHELL_BINDING) return true;
  let root: string;
  try {
    root = realpathSync(resolve(rootCwd));
  } catch {
    return true;
  }
  for (const entry of path.split(":")) {
    if (!entry || !isAbsolute(entry)) return true;
    let canonical: string;
    try {
      canonical = realpathSync(entry);
      if (!statSync(canonical).isDirectory()) return true;
    } catch {
      try {
        lstatSync(entry);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return true;
      }
    }

    const candidate = join(entry, commandName);
    if (!existsSync(candidate)) {
      try {
        lstatSync(candidate);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return true;
      }
    }
    // An invalidated PATH entry cannot affect resolution when it lacks this command.
    if (
      isConductorStaticDirectoryInvalidated(state, resolve(entry))
      || isConductorStaticDirectoryInvalidated(state, resolve(candidate))
    ) return true;

    const workspaceNpmBinPathSafety = conductorWorkspaceNpmBinPathMayResolveRepositoryExecutable(
      commandName,
      canonical,
      rootCwd,
    );
    if (workspaceNpmBinPathSafety !== null) return workspaceNpmBinPathSafety;
    if (canonical === root || canonical.startsWith(`${root}/`)) return true;
    return !conductorExecutableHasTrustedIdentity(commandName, candidate, rootCwd, state);
  }
  // PATH exhaustion may invoke command_not_found_handle; no executable identity was proved.
  return true;
}

// Main-root orchestration markers may resolve only to the hook package's canonical
// OMX/GJC CLI target, never to a workspace package declaration or lookalike script.
function conductorDeclaredPackageCliPath(packageRoot: string, commandName: string): string | null {
  try {
    const canonicalPackageRoot = realpathSync(packageRoot);
    const packageManifest = safeObject(JSON.parse(readFileSync(join(canonicalPackageRoot, "package.json"), "utf-8")));
    const packageBin = safeObject(packageManifest.bin);
    const declaredTarget = safeString(packageBin[commandName === "gjc" ? "omx" : commandName]).trim();
    if (
      safeString(packageManifest.name).trim() !== "oh-my-codex"
      || !declaredTarget
      || isAbsolute(declaredTarget)
    ) return null;
    const target = resolve(canonicalPackageRoot, declaredTarget);
    if (target === canonicalPackageRoot || !target.startsWith(`${canonicalPackageRoot}/`)) return null;
    const canonicalTarget = realpathSync(target);
    return canonicalTarget === canonicalPackageRoot || !canonicalTarget.startsWith(`${canonicalPackageRoot}/`)
      ? null
      : canonicalTarget;
  } catch {
    return null;
  }
}

function conductorKnownPackageCliPath(commandName: string): string | null {
  try {
    const packageRoot = resolve(fileURLToPath(import.meta.url), "../../..");
    return conductorDeclaredPackageCliPath(packageRoot, commandName);
  } catch {
    return null;
  }
}

function conductorWorkspacePackageCliCandidateIsTrusted(
  commandName: string,
  candidate: string,
  binDirectory: string,
  rootCwd: string,
): boolean {
  if (commandName !== "omx" && commandName !== "gjc") return false;
  try {
    const workspaceRoot = realpathSync(resolve(rootCwd));
    if (realpathSync(binDirectory) !== realpathSync(join(workspaceRoot, "node_modules", ".bin"))) return false;
    if (!lstatSync(candidate).isSymbolicLink()) return false;
    const knownCli = conductorKnownPackageCliPath(commandName);
    return knownCli !== null && realpathSync(candidate) === knownCli;
  } catch {
    return false;
  }
}

function conductorPackageCliNodeInterpreterIsTrusted(nodeCandidate: string, rootCwd: string): boolean {
  return conductorExecutableHasTrustedSystemIdentity(nodeCandidate, rootCwd)
    || conductorExecutableHasTrustedCurrentNodeRuntimeIdentity("node", nodeCandidate);
}

function conductorPackageCliHasTrustedNodeInterpreter(candidate: string, state: ShellPosixState, rootCwd: string): boolean {
  try {
    const firstLine = readFileSync(realpathSync(candidate), "utf-8").split(/\r?\n/, 1)[0] ?? "";
    if (!/^#!\s*\/usr\/bin\/env\s+node\s*$/.test(firstLine)) return false;
  } catch {
    return false;
  }
  const path = getConductorShellBinding(state, "PATH").value;
  if (!path || path === CONDUCTOR_UNKNOWN_SHELL_BINDING) return false;
  for (const entry of path.split(":")) {
    if (!isAbsolute(entry) || isConductorStaticDirectoryInvalidated(state, resolve(entry))) return false;
    try {
      if (!statSync(realpathSync(entry)).isDirectory()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return false;
    }
    const nodeCandidate = join(entry, "node");
    if (!existsSync(nodeCandidate)) {
      try {
        lstatSync(nodeCandidate);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return false;
      }
    }
    return conductorPackageCliNodeInterpreterIsTrusted(nodeCandidate, rootCwd);
  }
  return false;
}

function conductorResolvedPackageCliCandidateIsTrusted(
  commandName: string,
  state: ShellPosixState,
  rootCwd: string,
): boolean {
  if (commandName !== "omx" && commandName !== "gjc") return false;
  if (state.filesystemAliasMayExist) return false;
  const expectedCandidate = conductorKnownPackageCliPath(commandName);
  const path = getConductorShellBinding(state, "PATH").value;
  if (!path || path === CONDUCTOR_UNKNOWN_SHELL_BINDING) return false;
  for (const entry of path.split(":")) {
    if (!isAbsolute(entry)) return false;
    let binDirectory: string;
    try {
      binDirectory = realpathSync(entry);
    } catch {
      try {
        lstatSync(entry);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return false;
      }
    }
    const candidate = join(binDirectory, commandName);
    if (!existsSync(candidate)) {
      try {
        lstatSync(candidate);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return false;
      }
    }
    try {
      accessSync(candidate, fsConstants.X_OK);
      const trustedCli = expectedCandidate !== null && realpathSync(candidate) === expectedCandidate;
      return trustedCli && conductorPackageCliHasTrustedNodeInterpreter(candidate, state, rootCwd);
    } catch {
      return false;
    }
  }
  return false;
}

function conductorSlashCommandIsTrusted(commandWord: string, state: ShellPosixState, rootCwd: string): boolean {
  if (!commandWord.includes("/") || !isAbsolute(commandWord) || /[$`]/.test(commandWord)) return false;
  if (state.effectiveCwd === null) return false;
  return conductorExecutableHasTrustedIdentity(commandNameFromShellWord(commandWord), commandWord, rootCwd, state);
}
function conductorCommandPathMayResolveRepositoryExecutable(
  words: string[],
  commandStartIndex: number,
  commandIndex: number,
  state: ShellPosixState,
  rootCwd: string,
): boolean {
  return conductorPathMayResolveRepositoryExecutable(
    resolveConductorCommandPathState(words, commandStartIndex, commandIndex, state),
    commandNameFromShellWord(words[commandIndex] ?? ""),
    rootCwd,
  );
}

function conductorCommandResolvesTrustedPackageCli(
  words: string[],
  commandStartIndex: number,
  commandIndex: number,
  state: ShellPosixState,
  rootCwd: string,
): boolean {
  return conductorResolvedPackageCliCandidateIsTrusted(
    commandNameFromShellWord(words[commandIndex] ?? ""),
    resolveConductorCommandPathState(words, commandStartIndex, commandIndex, state),
    rootCwd,
  );
}

const CONDUCTOR_PATH_INDEPENDENT_BUILTINS = new Set([
  ":", "break", "cd", "continue", "declare", "echo", "export", "false", "getopts", "local", "popd", "printf", "pushd", "read", "readonly", "return", "set", "shift", "shopt", "test", "true", "type", "unset", "wait",
]);

function applyShellPosixStateEffect(words: string[], commandIndex: number, state: ShellPosixState, inFunction: boolean): void {
  if (commandIndex >= words.length) return;
  const commandName = commandNameFromShellWord(words[commandIndex] ?? "");
  const operands: string[] = [];
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined || isShellCommandTerminatorOrGroupClose(word)) break;
    operands.push(word);
  }
  if (declarationTargetsFunctions(operands) && (commandName === "readonly" || commandName === "declare" || commandName === "typeset" || commandName === "unset" || commandName === "export")) return;
  if (
    (commandName === "declare" || commandName === "typeset" || commandName === "local")
    && operands.some((operand) => /^[+-][A-Za-z]*[iaA]/.test(operand))
  ) {
    state.securityEnvironmentUnresolved = true;
    return;
  }
  const assignments = operands.flatMap((word) => {
    const assignment = parseShellAssignmentWord(word);
    return assignment ? [assignment] : [];
  });
  const exported = declarationExportMode(commandName, words, commandIndex);
  const readonly = declarationReadonlyMode(commandName, words, commandIndex);
  const global = declarationIsGlobal(commandName, words, commandIndex);
  const localDeclaration = commandName === "local" || (inFunction && (commandName === "declare" || commandName === "typeset") && !global);
  if (!inFunction) {
    const staticVariables = state.staticVariables ?? new Map<string, string>();
    for (const assignment of assignments) {
      if (!assignment.append && !/[$`]/.test(assignment.value)) staticVariables.set(assignment.name, assignment.value);
      else staticVariables.delete(assignment.name);
    }
    state.staticVariables = staticVariables;
  }
  const sensitiveDeclarationNames = new Set([
    ...assignments.map((assignment) => assignment.name),
    ...operands
      .filter((operand) => !operand.startsWith("-") && !operand.startsWith("+") && !parseShellAssignmentWord(operand))
      .map((operand) => resolveConductorStaticVariableName(state, operand))
      .filter((name): name is string => name !== null),
  ]);
  // Attribute and local-scope resolution can make a later assignment or unset fail.
  // Retain a fail-closed marker instead of treating the requested mutation as effective.
  if (
    (readonly === true || localDeclaration)
    && [...sensitiveDeclarationNames].some(isConductorSecuritySensitiveEnvironmentName)
  ) state.securityEnvironmentUnresolved = true;
  const declarationQuery = operands.some((word) => /^-[A-Za-z]*[pF]/.test(word));
  if (declarationQuery) return;
  if (
    (commandName === "export" || commandName === "readonly" || commandName === "unset")
    && operands.some((operand) => (
      !operand.startsWith("-")
      && !operand.startsWith("+")
      && !parseShellAssignmentWord(operand)
      && resolveConductorStaticVariableName(state, operand) === null
    ))
  ) {
    markConductorTrackedBindingsUnresolved(state);
    state.securityEnvironmentUnresolved = true;
    return;
  }
  const supportsNamerefMode = commandName === "declare" || commandName === "typeset" || commandName === "local";
  const namerefMode = supportsNamerefMode && operands.some((word) => /^-[A-Za-z]*n/.test(word));
  const clearNamerefMode = supportsNamerefMode && operands.some((word) => /^\+[A-Za-z]*n/.test(word));
  if (namerefMode || clearNamerefMode) {
    const persistentAlias = !inFunction || global;
    for (const assignment of assignments) {
      if (clearNamerefMode) {
        state.aliases.delete(assignment.name);
        state.globalAliases.delete(assignment.name);
        continue;
      }
      const target = isConductorShellBindingName(assignment.value) ? assignment.value : null;
      if (isConductorSecuritySensitiveEnvironmentName(assignment.value)) state.securityEnvironmentUnresolved = true;
      state.aliases.set(assignment.name, target);
      if (persistentAlias) state.globalAliases.add(assignment.name);
      else state.globalAliases.delete(assignment.name);
    }
    for (const name of operands.filter((word) => !word.startsWith("-") && !word.startsWith("+") && !parseShellAssignmentWord(word))) {
      if (clearNamerefMode) {
        state.aliases.delete(name);
        state.globalAliases.delete(name);
      } else {
        state.aliases.set(name, null);
        if (persistentAlias) state.globalAliases.add(name);
        else state.globalAliases.delete(name);
      }
    }
    return;
  }
  for (const assignment of assignments) {
    if (assignment.name !== "BASHOPTS") continue;
    applyConductorAssignment(state, assignment, { exported: exported ?? state.bashoptsExported, persistent: true });
  }
  const inheritLocal = localDeclaration && declarationInheritsLocal(operands);
  if (localDeclaration && operands.includes("-")) {
    state.functionShellOptionSnapshot ??= {
      lastpipe: state.lastpipe,
      jobControl: state.jobControl,
      jobControlMayBeDisabled: state.jobControlMayBeDisabled,
      allexport: state.allexport,
      posixMode: state.posixMode,
      physicalCwd: state.physicalCwd,
    };
    return;
  }
  if (commandName === "set") {
    for (let index = 0; index < operands.length; index += 1) {
      const option = shellWordLiteral(operands[index] ?? "");
      if (option === "--") break;
      if (option === "--allexport") {
        state.allexport = true;
        continue;
      }
      if (option === "-o" || option === "+o") {
        const name = shellWordLiteral(operands[index + 1] ?? "");
        if (!CONDUCTOR_SAFE_SHELL_OPTIONS.has(name)) {
          state.shellOptionsKnown = false;
          return;
        }
        const enabled = option === "-o";
        if (name === "posix") state.posixMode = enabled;
        if (name === "allexport") state.allexport = enabled;
        if (name === "monitor") {
          state.jobControl = enabled;
          state.jobControlMayBeDisabled = !enabled;
        }
        if (name === "physical") state.physicalCwd = enabled;
        index += 1;
        continue;
      }
      if ((option === "-O" || option === "+O") && operands[index + 1] === "lastpipe") {
        state.lastpipe = option === "-O";
        index += 1;
        continue;
      }
      if (applyConductorShortShellOptionCluster(state, option)) {
        if (!state.shellOptionsKnown) return;
        continue;
      }
      if (option.startsWith("-") || option.startsWith("+")) {
        state.shellOptionsKnown = false;
        return;
      }
    }
  }
  if (commandName === "shopt") {
    const lastpipeSetting = staticLastpipeShoptSetting(words, commandIndex);
    if (lastpipeSetting !== null) state.lastpipe = lastpipeSetting;
  }

  if (commandName === "unset") {
    if (operands.some((word) => /^-[A-Za-z]*n/.test(word))) {
      for (const name of operands.filter((word) => !word.startsWith("-"))) {
        state.aliases.delete(name);
        state.globalAliases.delete(name);
      }
      return;
    }
    for (const operand of operands.filter((word) => !word.startsWith("-"))) {
      const name = resolveConductorStaticVariableName(state, operand);
      if (name === null) {
        markConductorTrackedBindingsUnresolved(state);
        state.securityEnvironmentUnresolved = true;
        continue;
      }
      state.staticVariables?.delete(name);
      unsetConductorSecurityEnvironment(state, name, true);
      if (name === "BASHOPTS") {
        state.bashoptsLastpipe = false;
        state.bashoptsExported = false;
        continue;
      }
      const alias = state.aliases.get(name);
      if (isConductorSecuritySensitiveEnvironmentName(name)) continue;
      if (alias === null && state.aliases.has(name)) {
        for (const trackedName of CONDUCTOR_SHELL_BINDING_NAMES) {
          setConductorShellBinding(state, trackedName, { value: CONDUCTOR_UNKNOWN_SHELL_BINDING, exported: true }, true);
        }
        continue;
      }
      const targetName = alias ?? name;
      if (!isConductorShellBindingName(targetName)) continue;
      const binding = getConductorShellBinding(state, targetName);
      if (binding.readonly) continue;
      if (binding.readonlyPossible) {
        setConductorShellBinding(state, targetName, { value: CONDUCTOR_UNKNOWN_SHELL_BINDING, exported: true, readonlyPossible: true }, !binding.local);
      } else {
        setConductorShellBinding(state, targetName, { value: undefined, exported: false }, !binding.local);
      }
    }
    return;
  }

  const localBinding = (name: ConductorShellBindingName): void => {
    if (localDeclaration && inFunction) beginConductorFunctionLocalBinding(state, name);
  };

  const declaredNames = new Set(assignments.map((assignment) => assignment.name));
  for (const assignment of assignments) {
    applyConductorSecurityEnvironmentAssignment(state, assignment, {
      local: localDeclaration,
      persistent: !localDeclaration,
    });
    const targetName = state.aliases.get(assignment.name) ?? assignment.name;
    if (!isConductorShellBindingName(targetName)) continue;
    localBinding(targetName);
    const existing = getConductorShellBinding(state, targetName);
    const local = localDeclaration ? true : global ? false : existing.local;
    if (global) {
      const globalExisting = getConductorGlobalShellBinding(existing);
      const value = resolveConductorShellAssignmentValue(globalExisting, assignment);
      setGlobalConductorShellBinding(state, targetName, {
        value,
        exported: exported ?? globalExisting.exported,
        readonly: readonly ?? globalExisting.readonly,
      });
      continue;
    }
    applyConductorAssignment(state, assignment, {
      exported: exported ?? existing.exported,
      local,
      readonly: readonly ?? existing.readonly,
      persistent: !local,
    });
  }
  for (const operand of operands) {
    if (parseShellAssignmentWord(operand)) continue;
    if (operand.startsWith("-") || operand.startsWith("+")) continue;
    const name = (commandName === "export" || commandName === "readonly")
      ? resolveConductorStaticVariableName(state, operand)
      : shellWordLiteral(operand);
    if (name === null) {
      markConductorTrackedBindingsUnresolved(state);
      state.securityEnvironmentUnresolved = true;
      continue;
    }
    if (name.startsWith("-") || name.startsWith("+") || declaredNames.has(name)) continue;
    if (isConductorSecuritySensitiveEnvironmentName(name)) {
      if (!state.securityEnvironment.has(name)) state.securityEnvironment.set(name, CONDUCTOR_UNKNOWN_SHELL_BINDING);
      if (!localDeclaration) state.dirtySecurityEnvironmentNames.add(name);
      else state.securityEnvironmentUnresolved = true;
      continue;
    }
    if (name === "BASHOPTS") {
      if (exported !== undefined) state.bashoptsExported = exported;
      continue;
    }
    if (!isConductorShellBindingName(name)) continue;
    localBinding(name);
    const existing = getConductorShellBinding(state, name);
    const local = localDeclaration ? true : global ? false : existing.local;
    const persistent = !local;
    if (global) {
      if (readonly !== undefined) setGlobalConductorShellBinding(state, name, { readonly, readonlyPossible: false });
      if (exported !== undefined) setGlobalConductorShellBinding(state, name, { exported });
      continue;
    }
    if (readonly !== undefined) {
      setConductorShellBinding(state, name, { readonly, readonlyPossible: false, local }, persistent);
    }
    if (exported !== undefined) {
      setConductorShellBinding(state, name, { exported, local }, persistent);
    }
    if (localDeclaration) {
      if (inheritLocal) setConductorShellBinding(state, name, { local: true }, false);
      else if (readonly === undefined && exported === undefined) setConductorShellBinding(state, name, { value: undefined, local: true }, false);
    }
  }
}

function conductorPathnameExpansionIsAmbiguous(path: string): boolean {
  return /[*?\[\]{}~]/.test(path);
}

function normalizeWgetMutationTargets(targets: string[], effectiveCwd: string, rootCwd: string): string[] | null {
  const normalized: string[] = [];
  for (const target of targets) {
    if (isUnresolvedVariableTarget(target) || /[`$]/.test(target) || conductorPathnameExpansionIsAmbiguous(target)) return null;
    try {
      const absoluteTarget = isAbsolute(target) ? resolve(target) : resolve(effectiveCwd, target);
      normalized.push(relative(rootCwd, absoluteTarget).replace(/\\/g, "/") || ".");
    } catch {
      return null;
    }
  }
  return normalized;
}

function normalizeConductorMutationTargets(targets: string[], effectiveCwd: string, rootCwd: string): string[] | null {
  return normalizeWgetMutationTargets(targets, effectiveCwd, rootCwd);
}

function createConductorFunctionState(state: ShellPosixState): ShellPosixState {
  const functionState = cloneShellPosixState(state);
  functionState.functionLocalBindings.clear();
  functionState.functionShellOptionSnapshot = undefined;
  return functionState;
}

function applyPersistentFunctionEffects(caller: ShellPosixState, callee: ShellPosixState, baseline: ShellPosixState): void {
  for (const name of CONDUCTOR_SHELL_BINDING_NAMES) {
    const before = getConductorShellBinding(baseline, name);
    const after = getConductorShellBinding(callee, name);
    if (callee.functionLocalBindings.has(name)) {
      caller.bindings.set(name, copyConductorShellBinding(after.outer ?? before));
      continue;
    }
    if (before.local && after.local) {
      caller.bindings.set(name, copyConductorShellBinding(after));
      continue;
    }
    const persistentBinding = after.local ? after.outer : after;
    if (!persistentBinding?.dirty) continue;
    caller.bindings.set(name, {
      ...cloneConductorShellBinding(persistentBinding),
      local: false,
      outer: undefined,
      dirty: true,
    });
  }
  caller.securityEnvironmentUnresolved ||= callee.securityEnvironmentUnresolved;
  for (const name of callee.dirtySecurityEnvironmentNames) {
    const value = callee.securityEnvironment.get(name);
    if (value === undefined) caller.securityEnvironment.delete(name);
    else caller.securityEnvironment.set(name, value);
    caller.dirtySecurityEnvironmentNames.add(name);
  }
  const restoredShellOptions = callee.functionShellOptionSnapshot;
  caller.lastpipe = restoredShellOptions?.lastpipe ?? callee.lastpipe;
  caller.jobControl = restoredShellOptions?.jobControl ?? callee.jobControl;
  caller.jobControlMayBeDisabled = restoredShellOptions?.jobControlMayBeDisabled ?? callee.jobControlMayBeDisabled;
  caller.bashoptsLastpipe = callee.bashoptsLastpipe;
  caller.bashoptsExported = callee.bashoptsExported;
  caller.allexport = restoredShellOptions?.allexport ?? callee.allexport;
  caller.shellOptionsKnown = callee.shellOptionsKnown;
  caller.effectiveCwd = callee.effectiveCwd;
  caller.directoryStack = callee.directoryStack === null ? null : [...callee.directoryStack];
  caller.posixMode = restoredShellOptions?.posixMode ?? callee.posixMode;
  caller.physicalCwd = restoredShellOptions?.physicalCwd ?? callee.physicalCwd;
  caller.filesystemAliasMayExist = callee.filesystemAliasMayExist;
  caller.invalidatedStaticDirectories = new Set([
    ...caller.invalidatedStaticDirectories,
    ...callee.invalidatedStaticDirectories,
  ]);
  for (const name of new Set([...caller.aliases.keys(), ...callee.aliases.keys()])) {
    if (!baseline.aliases.has(name) && !callee.globalAliases.has(name)) continue;
    if (baseline.aliases.get(name) === callee.aliases.get(name) && baseline.aliases.has(name) === callee.aliases.has(name)) continue;
    if (callee.aliases.has(name)) caller.aliases.set(name, callee.aliases.get(name) ?? null);
    else caller.aliases.delete(name);
    if (callee.globalAliases.has(name)) caller.globalAliases.add(name);
    else caller.globalAliases.delete(name);
  }
}
function joinConductorFunctionMaps(candidates: ReadonlyArray<ReadonlyMap<string, string[]>>): Map<string, string[]> {
  const joined = new Map<string, string[]>();
  const names = new Set(candidates.flatMap((candidate) => [...candidate.keys()]));
  for (const name of names) {
    const bodies = new Set<string>();
    for (const candidate of candidates) {
      for (const body of candidate.get(name) ?? [CONDUCTOR_UNBOUND_FUNCTION_BODY]) bodies.add(body);
    }
    joined.set(name, [...bodies]);
  }
  return joined;
}

function replaceConductorFunctionMap(target: Map<string, string[]>, source: ReadonlyMap<string, string[]>): void {
  target.clear();
  for (const [name, bodies] of source) target.set(name, [...bodies]);
}
function applyNestedBashShoptOptions(words: string[], commandIndex: number, child: ShellPosixState): void {
  if (commandNameFromShellWord(words[commandIndex] ?? "") !== "bash") return;
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const option = shellWordLiteral(words[index] ?? "");
    if (!option || isShellCommandSeparator(option) || option === "--") break;
    if (option === "-o" || option === "+o") {
      const name = shellWordLiteral(words[index + 1] ?? "");
      if (!CONDUCTOR_SAFE_SHELL_OPTIONS.has(name)) {
        child.shellOptionsKnown = false;
      } else {
        const enabled = option === "-o";
        if (name === "allexport") child.allexport = enabled;
        if (name === "posix") child.posixMode = enabled;
        if (name === "monitor") {
          child.jobControl = enabled;
          child.jobControlMayBeDisabled = !enabled;
        }
        if (name === "physical") child.physicalCwd = enabled;
      }
      index += 1;
      continue;
    }
    let shoptEnabled: boolean | null = null;
    let shoptName = "";
    if (option === "-O" || option === "+O") {
      shoptEnabled = option === "-O";
      shoptName = shellWordLiteral(words[index + 1] ?? "");
      index += 1;
    } else if (/^[+-]O.+/.test(option)) {
      shoptEnabled = option.startsWith("-");
      shoptName = option.slice(2);
    }
    if (shoptEnabled !== null) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(shoptName) || shoptName !== "lastpipe") {
        child.shellOptionsKnown = false;
      } else {
        child.lastpipe = shoptEnabled;
      }
      continue;
    }
    if (applyConductorShortShellOptionCluster(child, option, true)) {
      if (!child.shellOptionsKnown) return;
      continue;
    }
    if (!option.startsWith("-") && !option.startsWith("+")) break;
  }
}

function createNestedExecChildState(
  parent: ShellPosixState,
  words: string[],
  commandStartIndex: number,
  commandIndex: number,
  cwd: string,
): ShellPosixState {
  const bindings = new Map<ConductorShellBindingName, ConductorShellBinding>();
  for (const name of CONDUCTOR_SHELL_BINDING_NAMES) {
    const binding = getConductorShellBinding(parent, name);
    if (binding.exported) bindings.set(name, { value: binding.value, exported: true, readonly: false, local: false, dirty: binding.dirty });
  }
  const child: ShellPosixState = {
    bindings,
    securityEnvironment: new Map(parent.securityEnvironment),
    dirtySecurityEnvironmentNames: new Set(),
    securityEnvironmentUnresolved: parent.securityEnvironmentUnresolved,
    lastpipe: false,
    jobControl: false,
    jobControlMayBeDisabled: true,
    bashoptsLastpipe: false,
    effectiveCwd: cwd,
    directoryStack: [cwd],
    aliases: new Map(),
    globalAliases: new Set(),
    functionLocalBindings: new Set(),
    posixMode: stateHasPosixlyCorrect(parent),
    physicalCwd: parent.physicalCwd,
    filesystemAliasMayExist: parent.filesystemAliasMayExist,
    invalidatedStaticDirectories: new Set(parent.invalidatedStaticDirectories),
    pathUsesSystemDefaultWhenUnset: parent.pathUsesSystemDefaultWhenUnset,
    bashoptsExported: false,
    allexport: parent.allexport,
    shellOptionsKnown: parent.shellOptionsKnown,
  };
  const clearBoundary = nestedExecEnvironmentClearBoundary(words, commandStartIndex, commandIndex);
  if (clearBoundary !== null) {
    child.bindings.clear();
    child.securityEnvironment.clear();
    child.dirtySecurityEnvironmentNames.clear();
    child.securityEnvironmentUnresolved = false;
    child.bashoptsLastpipe = false;
    child.bashoptsExported = false;
    child.allexport = false;
    child.shellOptionsKnown = true;
    child.posixMode = false;
    child.physicalCwd = false;
    child.pathUsesSystemDefaultWhenUnset = true;
  } else if (parent.bashoptsExported) {
    child.bashoptsLastpipe = parent.bashoptsLastpipe || parent.lastpipe;
    child.bashoptsExported = true;
  }
  applyNestedBashShoptOptions(words, commandIndex, child);
  applyNestedShellEnvironment(words, clearBoundary === null ? commandStartIndex : clearBoundary + 1, commandIndex, child);
  const nestedPosixMode = nestedShellEnablesPosix(words, commandStartIndex, commandIndex);
  if (nestedPosixMode === null) child.shellOptionsKnown = false;
  else child.posixMode ||= nestedPosixMode;
  return child;
}

function applyNestedShellEnvironment(words: string[], commandStartIndex: number, commandIndex: number, child: ShellPosixState): void {
  for (let index = commandStartIndex; index < commandIndex; index += 1) {
    const word = words[index] ?? "";
    const assignment = parseShellAssignmentWord(word);
    if (assignment?.name === "SHELLOPTS") {
      const options = parseConductorShellOptions(assignment.value);
      child.shellOptionsKnown &&= options.known && !assignment.append && !/[$`]/.test(assignment.value);
      child.posixMode = options.posix;
      child.allexport = options.allexport;
      child.physicalCwd = options.physical;
      continue;
    }
    if (assignment) {
      applyConductorAssignment(child, assignment, { exported: true, local: false, persistent: false });
      if (assignment.name === "PATH") {
        const binding = getConductorShellBinding(child, "PATH");
        child.bindings.set("PATH", { ...binding, dirty: true });
      }
    }
    const unsetName = word === "-u" || word === "--unset"
      ? shellWordLiteral(words[index + 1] ?? "")
      : word.startsWith("--unset=")
        ? word.slice("--unset=".length)
        : /^-u.+/.test(word)
          ? word.slice(2)
          : "";
    if (unsetName === "BASHOPTS") {
      child.bashoptsLastpipe = false;
      child.bashoptsExported = false;
    }
    if (unsetName === "SHELLOPTS") {
      child.allexport = false;
      child.posixMode = false;
      child.physicalCwd = false;
      child.shellOptionsKnown = true;
    }
    unsetConductorSecurityEnvironment(child, unsetName, false);
    if (isConductorShellBindingName(unsetName)) {
      setConductorShellBinding(child, unsetName, { value: undefined, exported: false }, false);
      if (word === "-u" || word === "--unset") index += 1;
    }
  }
}

function nestedShellEnablesPosix(words: string[], commandStartIndex: number, commandIndex: number): boolean | null {
  let argv0: string | undefined;
  const recordArgv0 = (rawValue: string): boolean => {
    const value = shellWordLiteral(rawValue);
    if (!value || /[$`]/.test(rawValue) || argv0 !== undefined) return false;
    argv0 = value;
    return true;
  };
  for (let index = commandStartIndex; index < commandIndex; index += 1) {
    const wrapper = commandNameFromShellWord(words[index] ?? "");
    if (wrapper !== "exec" && wrapper !== "env") continue;
    for (let optionIndex = index + 1; optionIndex < commandIndex; optionIndex += 1) {
      const rawOption = words[optionIndex] ?? "";
      const option = shellWordLiteral(rawOption);
      if (!option || /[$`]/.test(rawOption)) return null;
      const separateArgv0 = wrapper === "exec" ? option === "-a" : option === "-a" || option === "--argv0";
      const attachedArgv0 = wrapper === "exec"
        ? /^-a(.+)$/.exec(option)?.[1]
        : /^(?:-a|--argv0)=(.+)$/.exec(option)?.[1] ?? /^-a(.+)$/.exec(option)?.[1];
      if (separateArgv0) {
        if (!recordArgv0(words[optionIndex + 1] ?? "")) return null;
        optionIndex += 1;
      } else if (attachedArgv0 !== undefined && !recordArgv0(attachedArgv0)) {
        return null;
      }
    }
  }
  const effectiveName = (argv0 ?? commandNameFromShellWord(words[commandIndex] ?? ""))
    .split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (new Set(["sh", "dash", "ash", "ksh", "mksh"]).has(effectiveName)) return true;
  if (effectiveName !== "bash") return false;
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const option = shellWordLiteral(words[index] ?? "");
    if (!option || isShellCommandSeparator(option) || option === "--") break;
    if (option === "--posix") return true;
    if (option === "-o" && shellWordLiteral(words[index + 1] ?? "") === "posix") return true;
    if (option === "-O" || option === "+O") {
      index += 1;
      continue;
    }
    if (/^[+-]O.+/.test(option)) continue;
    if (!option.startsWith("-")) break;
  }
  return false;
}

function nestedShellUsesLastpipe(words: string[], commandStartIndex: number, commandIndex: number, commandStringIndex: number, state: ShellPosixState): boolean {
  if (commandNameFromShellWord(words[commandIndex] ?? "") !== "bash") return false;
  const prefixHasLastpipe = words.slice(commandStartIndex, commandIndex).some((word) => {
    const assignment = parseShellAssignmentWord(word);
    return assignment?.name === "BASHOPTS" && (assignment.append || /[$`]/.test(assignment.value) || assignment.value.split(":").includes("lastpipe"));
  });
  return nestedBashLastpipeEnabled(words, commandIndex, commandStringIndex)
    || prefixHasLastpipe
    || state.lastpipe
    || state.bashoptsLastpipe;
}
const CONDUCTOR_UNBOUND_FUNCTION_BODY = "\0unbound";
const CONDUCTOR_READONLY_FUNCTION_BODY = "\0readonly";
const CONDUCTOR_EXPORTED_FUNCTION_BODY = "\0exported";
const CONDUCTOR_UNINSPECTED_FUNCTION_BODY = "\0uninspected";

function isConductorFunctionBody(body: string): boolean {
  return body !== CONDUCTOR_UNBOUND_FUNCTION_BODY
    && body !== CONDUCTOR_READONLY_FUNCTION_BODY
    && body !== CONDUCTOR_EXPORTED_FUNCTION_BODY
    && body !== CONDUCTOR_UNINSPECTED_FUNCTION_BODY;
}

function inheritedConductorFunctionBindings(): Map<string, string[]> {
  const functions = new Map<string, string[]>();
  for (const [environmentName, value] of Object.entries(process.env)) {
    const name = /^BASH_FUNC_([A-Za-z_][A-Za-z0-9_]*)%%$/.exec(environmentName)?.[1];
    if (!name) continue;
    const source = `${name}${safeString(value)}`;
    const definition = findShellFunctionDefinitionAt(source, 0);
    const bodyEnd = definition
      ? findShellFunctionBodyEnd(source, definition.openBraceIndex, definition.bodyOpenChar)
      : -1;
    const body = definition && bodyEnd >= 0
      ? source.slice(definition.openBraceIndex + 1, bodyEnd)
      : "";
    functions.set(
      name,
      body && body.length <= 8192 && !/\$\(|[<>]\(/.test(body)
        ? [body, CONDUCTOR_EXPORTED_FUNCTION_BODY]
        : [CONDUCTOR_UNINSPECTED_FUNCTION_BODY, CONDUCTOR_EXPORTED_FUNCTION_BODY],
    );
  }
  return functions;
}
function nestedExecEnvironmentClearBoundary(words: string[], commandStartIndex: number, commandIndex: number): number | null {
  let wrapperIndex = commandStartIndex;
  while (wrapperIndex < commandIndex) {
    const wrapperName = commandNameFromShellWord(words[wrapperIndex] ?? "");
    if (wrapperName === "env") {
      const envIndex = wrapperIndex;
      for (let index = wrapperIndex + 1; index < commandIndex; index += 1) {
        const option = shellWordLiteral(words[index] ?? "");
        if (option === "-i" || option === "--ignore-environment") return index;
        if (option === "--") {
          wrapperIndex = index + 1;
          break;
        }
        if (isShellAssignmentWord(option)) continue;
        if (option === "-u" || option === "--unset" || option === "-C" || option === "--chdir" || option === "-a" || option === "--argv0") {
          index += 1;
          continue;
        }
        if (option.startsWith("--unset=") || option.startsWith("--chdir=") || option.startsWith("--argv0=") || /^-(?:u|C|a).+/.test(option) || option.startsWith("-")) continue;
        wrapperIndex = index;
        break;
      }
      if (wrapperIndex === envIndex) break;
      continue;
    }
    if (wrapperName === "exec") {
      const execIndex = wrapperIndex;
      for (let index = wrapperIndex + 1; index < commandIndex; index += 1) {
        const option = shellWordLiteral(words[index] ?? "");
        if (option === "-c") return index;
        if (option === "-a") {
          index += 1;
          continue;
        }
        if (option === "--") {
          wrapperIndex = index + 1;
          break;
        }
        if (option.startsWith("-a") || option.startsWith("-")) continue;
        wrapperIndex = index;
        break;
      }
      if (wrapperIndex === execIndex) break;
      continue;
    }
    const operandIndex = findConductorWrapperOperandIndex(wrapperName, words, wrapperIndex + 1);
    if (operandIndex === undefined || operandIndex === null || operandIndex <= wrapperIndex) break;
    wrapperIndex = operandIndex;
  }
  return null;
}

function nestedExecClearsEnvironment(words: string[], commandStartIndex: number, commandIndex: number): boolean {
  return nestedExecEnvironmentClearBoundary(words, commandStartIndex, commandIndex) !== null;
}

function createNestedExecChildFunctions(
  parent: ReadonlyMap<string, string[]>,
  words: string[],
  commandStartIndex: number,
  commandIndex: number,
): Map<string, string[]> {
  if (commandNameFromShellWord(words[commandIndex] ?? "") !== "bash" || nestedExecClearsEnvironment(words, commandStartIndex, commandIndex)) return new Map();
  const unsetFunctionNames = new Set<string>();
  for (let index = commandStartIndex; index < commandIndex; index += 1) {
    const word = shellWordLiteral(words[index] ?? "");
    const unsetName = word === "-u" || word === "--unset" ? shellWordLiteral(words[index + 1] ?? "") : word.startsWith("--unset=") ? word.slice("--unset=".length) : "";
    const functionName = /^BASH_FUNC_([A-Za-z_][A-Za-z0-9_]*)%%$/.exec(unsetName)?.[1];
    if (functionName) unsetFunctionNames.add(functionName);
  }
  const child = new Map<string, string[]>();
  for (const [name, bodies] of parent) {
    if (unsetFunctionNames.has(name) || !bodies.includes(CONDUCTOR_EXPORTED_FUNCTION_BODY)) continue;
    if (bodies.includes(CONDUCTOR_UNINSPECTED_FUNCTION_BODY)) {
      child.set(name, [CONDUCTOR_UNINSPECTED_FUNCTION_BODY]);
      continue;
    }
    const executableBodies = bodies.filter(isConductorFunctionBody);
    if (executableBodies.length > 0) child.set(name, executableBodies);
  }
  return child;
}


function shellFunctionMode(operands: string[]): boolean {
  return operands.some((word) => /^[-+][A-Za-z]*f/.test(word));
}

function applyShellFunctionBindingEffect(words: string[], commandIndex: number, functions: Map<string, string[]>): void {
  const commandName = commandNameFromShellWord(words[commandIndex] ?? "");
  if (!new Set(["unset", "readonly", "export", "declare", "typeset"]).has(commandName)) return;
  const operands = collectConductorInvocationWords(words, commandIndex);
  if (!shellFunctionMode(operands)) return;
  const functionNames = operands.filter((word) => !word.startsWith("-") && !word.startsWith("+"));
  const negated = operands.some((word) => word.startsWith("-") && word.includes("n"));
  const exported = commandName === "export" || operands.some((word) => word.startsWith("-") && word.includes("x"));
  const readonly = commandName === "readonly" || operands.some((word) => word.startsWith("-") && word.includes("r"));
  for (const name of functionNames) {
    if (!/^[A-Za-z_][\w]*$/.test(name)) continue;
    const prior = functions.get(name) ?? [CONDUCTOR_UNBOUND_FUNCTION_BODY];
    if (commandName === "unset") {
      functions.set(name, [CONDUCTOR_UNBOUND_FUNCTION_BODY]);
      continue;
    }
    let next = prior;
    if (readonly && prior.some(isConductorFunctionBody)) {
      next = [...new Set([...next, CONDUCTOR_READONLY_FUNCTION_BODY])];
    }
    if (exported) {
      next = negated
        ? next.filter((body) => body !== CONDUCTOR_EXPORTED_FUNCTION_BODY)
        : [...new Set([...next, CONDUCTOR_EXPORTED_FUNCTION_BODY])];
    }
    if (next !== prior) functions.set(name, next);
  }
}

function scanConductorShellSegment(
  segment: ConductorShellSegment,
  state: ShellPosixState,
  functions: Map<string, string[]>,
  isolatedFunctionBindings: ReadonlySet<string> | null,
  cwd: string,
  inFunction: boolean,
  depth: number,
  mutations: ConductorBashMutation[],
  rootCwd = cwd,
  onStaticNestedBashExecution?: (command: string, functions: ReadonlyMap<string, string[]>, cwd: string) => void,
): void {
  const words = tokenizeConductorShellWords(segment.command);
  if (!state.shellOptionsKnown) {
    mutations.push({ command: "SHELLOPTS", targets: [] });
    return;
  }
  const isolatedContexts = new Map<number, { state: ShellPosixState; functions: Map<string, string[]> }>();
  const resolvingIsolationScopes = new Set<number>();
  const getIsolatedContext = (scope: number, commandStartIndex: number): { state: ShellPosixState; functions: Map<string, string[]> } => {
    const existing = isolatedContexts.get(scope);
    if (existing) return existing;
    if (resolvingIsolationScopes.has(scope)) return { state, functions };
    resolvingIsolationScopes.add(scope);
    const parentScope = findConductorParentIsolationScope(words, commandStartIndex, scope);
    const parent = parentScope === null || parentScope === scope
      ? { state, functions }
      : getIsolatedContext(parentScope, commandStartIndex);
    const context = { state: cloneShellPosixState(parent.state), functions: new Map(parent.functions) };
    resolvingIsolationScopes.delete(scope);
    isolatedContexts.set(scope, context);
    return context;
  };
  for (const commandStartIndex of collectShellCommandStartIndexes(words)) {
    const commandStartWord = words[commandStartIndex] ?? "";
    if (CONDUCTOR_BASH_COMPOUND_SYNTAX_WORDS.has(commandStartWord)) {
      if (commandStartWord === "for" || commandStartWord === "select") applyConductorLoopVariableWriter(words, commandStartIndex, state);
      continue;
    }
    const initialCommandIndex = skipShellCommandPositionPrefixWords(words, commandStartIndex);
    if (initialCommandIndex >= words.length || isShellCommandTerminatorOrGroupClose(words[initialCommandIndex] ?? "")) {
      const standaloneIsolated = segment.isolated || isInvocationIsolated(words, commandStartIndex, commandStartIndex);
      const standaloneScope = standaloneIsolated ? findConductorIsolationScope(words, commandStartIndex) : null;
      const standaloneContext = standaloneScope === null ? null : getIsolatedContext(standaloneScope, commandStartIndex);
      applyStandaloneConductorAssignments(words, commandStartIndex, initialCommandIndex, standaloneContext?.state ?? state);
      continue;
    }
    const initialCommandName = commandNameFromShellWord(words[initialCommandIndex] ?? "");
    if (!initialCommandName || CONDUCTOR_BASH_COMPOUND_SYNTAX_WORDS.has(initialCommandName)) continue;
    const directFunctionBodies = functions.get(initialCommandName);
    const preliminaryTimeOutputTargets = directFunctionBodies === undefined
      ? collectConductorTimeOutputTargets(words, commandStartIndex)
      : undefined;
    if (preliminaryTimeOutputTargets === null) {
      mutations.push({ command: "time", targets: [] });
      continue;
    }
    const invocation = directFunctionBodies
      ? { index: initialCommandIndex, unresolved: false, functionLookupAllowed: true, argumentProducing: false, childDispatch: false }
      : resolveConductorCommandIndex(words, commandStartIndex);
    if (invocation.unresolved) {
      if (
        initialCommandName === "time"
        || CONDUCTOR_BASH_EXTERNAL_DISPATCH_WRAPPERS.has(initialCommandName)
        || CONDUCTOR_BASH_DOWNLOADER_COMMANDS.has(initialCommandName)
        || CONDUCTOR_BASH_MUTATION_COMMANDS.has(initialCommandName)
      ) mutations.push({ command: initialCommandName, targets: [] });
      continue;
    }
    const commandIndex = invocation.index;
    const commandName = commandNameFromShellWord(words[commandIndex] ?? "");
    const initiallyIsolated = segment.isolated || isInvocationIsolated(words, commandStartIndex, initialCommandIndex);
    const provisionalScope = initiallyIsolated ? findConductorIsolationScope(words, commandStartIndex) : null;
    const parentScope = provisionalScope === null ? null : findConductorParentIsolationScope(words, commandStartIndex, provisionalScope);
    const inheritedContext = parentScope === null ? null : getIsolatedContext(parentScope, commandStartIndex);
    const optionState = inheritedContext?.state ?? state;
    const lastpipeFinalMember = optionState.lastpipe && !optionState.jobControl && optionState.jobControlMayBeDisabled && isConductorFinalPipelineMember(words, commandStartIndex);
    const isolated = initiallyIsolated && !lastpipeFinalMember;
    const scope = isolated ? provisionalScope : null;
    const isolatedContext = scope === null ? inheritedContext : getIsolatedContext(scope, commandStartIndex);
    const activeState = isolatedContext?.state ?? state;
    const activeFunctions = isolatedContext?.functions ?? functions;
    if (isConductorCommandCertainlySkipped(words, commandStartIndex, activeFunctions)) continue;
    if (preliminaryTimeOutputTargets !== undefined && preliminaryTimeOutputTargets.length > 0) {
      const timeExecutionContext = activeState.effectiveCwd === null
        ? null
        : resolveWrappedCommandExecutionContext(words, activeState.effectiveCwd, commandStartIndex);
      if (timeExecutionContext === null) {
        mutations.push({ command: "time", targets: [] });
        continue;
      }
      const normalizedTimeTargets = normalizeConductorMutationTargets(preliminaryTimeOutputTargets, timeExecutionContext.cwd, rootCwd);
      mutations.push({ command: "time", targets: normalizedTimeTargets ?? [] });
    }
    const functionStateBefore = !invocation.childDispatch && commandMayBeConditionallyExecuted(words, commandStartIndex)
      ? new Map(activeFunctions)
      : null;
    const variableStateBefore = !invocation.childDispatch && commandMayBeConditionallyExecuted(words, commandStartIndex)
      ? cloneShellPosixState(activeState)
      : null;
    applyStaticExpansionStateEffects(words, commandStartIndex, activeState);
    if (!invocation.childDispatch) applyConductorTrackedVariableWriter(words, commandIndex, activeState);
    if (variableStateBefore) joinConductorShellStates(variableStateBefore, activeState);
    if (!invocation.childDispatch) applyShellFunctionBindingEffect(words, commandIndex, activeFunctions);
    const childIsolatedFunctionBindings = isolatedFunctionBindings
      ?? (isolated
        ? collectConductorFunctionBindingsReachableAfter(
          words,
          findConductorIsolatedInvocationBoundary(words, commandStartIndex),
          functions,
        )
        : null);
    const functionBodies = invocation.functionLookupAllowed ? activeFunctions.get(commandName) : undefined;

    if (functionBodies !== undefined) {
      if (functionBodies.includes(CONDUCTOR_UNINSPECTED_FUNCTION_BODY)) {
        mutations.push({ command: commandName, targets: [] });
        continue;
      }
      const hasUnboundAlternative = functionBodies.includes(CONDUCTOR_UNBOUND_FUNCTION_BODY);
      if (depth >= CONDUCTOR_BASH_MAX_NESTING_DEPTH) {
        mutations.push({ command: commandName, targets: [] });
        continue;
      }
      const baselineState = cloneShellPosixState(activeState);
      const candidateStates: ShellPosixState[] = [];
      const candidateFunctions: Map<string, string[]>[] = [];
      for (const body of functionBodies.filter(isConductorFunctionBody)) {
        const functionState = createConductorFunctionState(baselineState);
        applyCommandPrefixEnvironment(words, commandStartIndex, commandIndex, functionState);
        const functionMap = new Map(activeFunctions);
        scanConductorShellSource(body, functionState, functionMap, functionState.effectiveCwd ?? cwd, true, depth + 1, mutations, childIsolatedFunctionBindings, rootCwd, true, onStaticNestedBashExecution);
        const projectedState = cloneShellPosixState(baselineState);
        applyPersistentFunctionEffects(projectedState, functionState, baselineState);
        candidateStates.push(projectedState);
        candidateFunctions.push(functionMap);
      }
      if (hasUnboundAlternative) {
        const fallbackState = cloneShellPosixState(baselineState);
        const fallbackFunctions = new Map(activeFunctions);
        fallbackFunctions.delete(commandName);
        scanConductorShellSegment({ command: words.join(" "), isolated: segment.isolated }, fallbackState, fallbackFunctions, childIsolatedFunctionBindings, cwd, inFunction, depth + 1, mutations, rootCwd, onStaticNestedBashExecution);
        candidateStates.push(fallbackState);
        candidateFunctions.push(fallbackFunctions);
      }
      if (commandMayBeConditionallyExecuted(words, commandStartIndex)) {
        candidateStates.push(baselineState);
        candidateFunctions.push(new Map(activeFunctions));
      }
      replaceConductorShellState(activeState, joinConductorShellStateAlternatives(candidateStates));
      replaceConductorFunctionMap(activeFunctions, joinConductorFunctionMaps(candidateFunctions));
      continue;
    }


    const commandWord = shellWordLiteral(words[commandIndex] ?? "");
    const commandIsBare = !commandWord.includes("/");
    const isOmxGjcCommand = commandName === "omx" || commandName === "gjc";
    const omxGjcInheritedRootsAreCanonical = isOmxGjcCommand
      && hasCanonicalInheritedConductorOrchestrationRoots(words, commandStartIndex, commandIndex, rootCwd);
    const omxGjcPrefixEnvironmentIsSafe = !isOmxGjcCommand
      || !commandHasUnsafeConductorOrchestrationPrefixEnvironment(words.join(" "), rootCwd);
    if (
      isOmxGjcCommand
      && (
        !omxGjcPrefixEnvironmentIsSafe
        || !hasSafeConductorOrchestrationRuntimeEnvironment(words, commandStartIndex, commandIndex, rootCwd, activeState)
      )
    ) {
      mutations.push({ command: commandName, targets: [] });
      continue;
    }
    const commandPathMayResolveRepositoryExecutable = commandIsBare
      && (!CONDUCTOR_PATH_INDEPENDENT_BUILTINS.has(commandName) || invocation.childDispatch)
      && conductorCommandPathMayResolveRepositoryExecutable(words, commandStartIndex, commandIndex, activeState, rootCwd);
    const trustedOmxGjcPackageCliPath = isOmxGjcCommand
      && commandIsBare
      && conductorCommandResolvesTrustedPackageCli(words, commandStartIndex, commandIndex, activeState, rootCwd);
    const bareCommandPathIsSafe = commandIsBare && !commandPathMayResolveRepositoryExecutable;
    if (isOmxGjcCommand && (!commandIsBare || !trustedOmxGjcPackageCliPath)) {
      mutations.push({ command: "PATH", targets: [] });
      continue;
    }
    if (!conductorWrapperLayersAreTrusted(words, commandStartIndex, commandIndex, activeState, rootCwd)) {
      mutations.push({ command: "wrapper", targets: [] });
      continue;
    }
    const omxGjcPathIsSafeForStaticOrchestration = trustedOmxGjcPackageCliPath;
    const omxGjcStateWriteDestinationIsCanonical = activeState.effectiveCwd !== null
      && resolve(activeState.effectiveCwd) === resolve(rootCwd)
      && !conductorInvocationUsesEnvCwdChangingWrapper(words, commandStartIndex, commandIndex);
    const mainRootStructuredStateWrite = omxGjcInheritedRootsAreCanonical
      && omxGjcPrefixEnvironmentIsSafe
      && trustedOmxGjcPackageCliPath
      && omxGjcStateWriteDestinationIsCanonical
      && isStaticallyValidatedOmxStateWriteInvocation(words, commandIndex);
    const mainRootStructuredOrchestrationMutation = isStaticallyRecognizedConductorOrchestrationMutation(
      commandName,
      words,
      commandIndex,
      invocation.argumentProducing,
    ) && (
      commandName === "omx" || commandName === "gjc"
        ? omxGjcInheritedRootsAreCanonical && omxGjcPathIsSafeForStaticOrchestration
        : commandName === "gh"
          ? commandIsBare ? bareCommandPathIsSafe : conductorSlashCommandIsTrusted(commandWord, activeState, rootCwd)
          : false
    );
    const cliMutationIntent = commandName === "gh"
      ? ghCommandHasMutationIntent(words, commandIndex) || invocation.argumentProducing && isPositivelyClassifiedGhCommand(words, commandIndex)
      : (commandName === "omx" || commandName === "gjc") && omxCliInvocationHasMutationIntent(words, commandIndex);
    if (mainRootStructuredStateWrite || mainRootStructuredOrchestrationMutation) {
      mutations.push({
        command: commandName,
        targets: [],
        mainRootStructuredStateWrite,
        mainRootStructuredOrchestrationMutation,
      });
      continue;
    }
    if (cliMutationIntent) {
      mutations.push(commandPathMayResolveRepositoryExecutable
        ? { command: "PATH", targets: [] }
        : { command: commandName, targets: [] });
      continue;
    }
    if (
      (!commandIsBare && !conductorSlashCommandIsTrusted(commandWord, activeState, rootCwd))
      || commandPathMayResolveRepositoryExecutable
    ) {
      mutations.push({ command: "PATH", targets: [] });
      continue;
    }
    if (isNestedShellCommandWord(commandName)) {
      const commandStringIndex = findShellCommandStringArgIndex(words, commandIndex + 1);
      if (commandStringIndex !== null) {
        const nestedCommand = words[commandStringIndex] ?? "";
        const executionContext = activeState.effectiveCwd === null
          ? null
          : resolveWrappedCommandExecutionContext(words, activeState.effectiveCwd, commandStartIndex);
        if (!nestedCommand || executionContext === null) {
          mutations.push({ command: commandName, targets: [] });
        } else {
          const childState = createNestedExecChildState(activeState, words, commandStartIndex, commandIndex, executionContext.cwd);
          if (!childState.shellOptionsKnown) {
            mutations.push({ command: commandName, targets: [] });
            continue;
          }
          childState.lastpipe = nestedShellUsesLastpipe(words, commandStartIndex, commandIndex, commandStringIndex, childState);
          const childFunctions = createNestedExecChildFunctions(activeFunctions, words, commandStartIndex, commandIndex);
          onStaticNestedBashExecution?.(nestedCommand, new Map(childFunctions), executionContext.cwd);
          scanConductorShellSource(nestedCommand, childState, childFunctions, executionContext.cwd, false, depth + 1, mutations, null, rootCwd);
          activeState.filesystemAliasMayExist ||= childState.filesystemAliasMayExist;
          for (const directory of childState.invalidatedStaticDirectories) activeState.invalidatedStaticDirectories.add(directory);
        }
        continue;
      }
    }

    const stateBefore = !invocation.childDispatch && commandMayBeConditionallyExecuted(words, commandStartIndex) ? cloneShellPosixState(activeState) : null;
    if (!invocation.childDispatch) {
      applyPosixSpecialBuiltinPrefixAssignments(words, commandStartIndex, commandIndex, commandName, activeState);
      applyShellPosixStateEffect(words, commandIndex, activeState, inFunction);
      if (CONDUCTOR_BASH_MODELED_CURRENT_SHELL_BUILTINS.has(commandName)) {
        applyShellCwdStateEffectWithPrefix(words, commandStartIndex, commandIndex, activeState);
      }
    }
    if (stateBefore) joinConductorShellStates(stateBefore, activeState);
    if (functionStateBefore) replaceConductorFunctionMap(activeFunctions, joinConductorFunctionMaps([functionStateBefore, activeFunctions]));
    const executionContext = activeState.effectiveCwd === null
      ? null
      : resolveWrappedCommandExecutionContext(words, activeState.effectiveCwd, commandStartIndex);
    if (executionContext === null && (CONDUCTOR_BASH_DOWNLOADER_COMMANDS.has(commandName) || CONDUCTOR_BASH_MUTATION_COMMANDS.has(commandName))) {
      mutations.push({ command: commandName, targets: [] });
      continue;
    }
    if (invocation.argumentProducing) {
      if (!CONDUCTOR_PATH_INDEPENDENT_BUILTINS.has(commandName)) mutations.push({ command: commandName || "xargs", targets: [] });
      continue;
    }

    if (CONDUCTOR_BASH_DOWNLOADER_COMMANDS.has(commandName)) {
      const downloaderTargets = collectConductorDownloaderOutputTargets(commandName, words, commandIndex, {
        posixlyCorrect: commandName === "wget" && (stateHasPosixlyCorrect(activeState) || commandPrefixConfiguresPosixlyCorrect(words, commandStartIndex, commandIndex)),
        startupConfigurationUnresolved: commandName === "wget" && wgetStartupConfigurationIsUnresolved(
          words,
          commandStartIndex,
          commandIndex,
          activeState,
          stateHasPosixlyCorrect(activeState) || commandPrefixConfiguresPosixlyCorrect(words, commandStartIndex, commandIndex),
        ),
        startupIsolationVerified: commandName === "wget"
          && wgetStartupOptionIsEffective(words, commandIndex, "--no-config", stateHasPosixlyCorrect(activeState) || commandPrefixConfiguresPosixlyCorrect(words, commandStartIndex, commandIndex))
          && wgetStartupOptionIsEffective(words, commandIndex, "--no-hsts", stateHasPosixlyCorrect(activeState) || commandPrefixConfiguresPosixlyCorrect(words, commandStartIndex, commandIndex)),
        cwd: executionContext?.cwd ?? cwd,
      });
      const wgetArgvIsDynamic = collectConductorInvocationWords(words, commandIndex).some(shellWordMayProduceWgetOptions);
      const wgetPosixlyCorrect = stateHasPosixlyCorrect(activeState) || commandPrefixConfiguresPosixlyCorrect(words, commandStartIndex, commandIndex);
      const wgetInvocationWords = commandName === "wget"
        ? collectConductorInvocationWords(words, commandIndex).map(shellWordLiteral)
        : [];
      const wgetIsExplicitNonNetworkInfoMode = commandName === "wget"
        && wgetInvocationWords.some((word) => word === "-V" || word === "--version" || word === "--help")
        && wgetInvocationWords.every((word) => new Set(["--no-config", "--no-hsts", "-V", "--version", "--help"]).has(word));
      const wgetHasStaticNetworkUrl = commandName === "wget"
        && collectConductorStaticReadOnlyDownloadUrls("wget", words, commandIndex + 1, words.length, wgetPosixlyCorrect) !== null;
      if (
        downloaderTargets.targets.length > 0
        || downloaderHasUnsafeTlsKeyLogEnvironment(words, commandStartIndex, commandIndex, activeState)
        || (commandName === "wget" && (
          wgetArgvIsDynamic
          || (!wgetIsExplicitNonNetworkInfoMode && (
            wgetInvocationHasUnsafeFiniteTransferMode(words, commandIndex)
            || !wgetHasStaticNetworkUrl
          ))
        ))
      ) downloaderTargets.unresolvedWgetTarget = true;
      if (commandName === "wget") {
        if (downloaderTargets.unresolvedWgetTarget) mutations.push({ command: commandName, targets: [] });
        if (downloaderTargets.targets.length > 0) {
          const targets = normalizeConductorMutationTargets(downloaderTargets.targets, executionContext?.cwd ?? cwd, rootCwd);
          mutations.push({ command: commandName, targets: targets ?? [] });
        }
      } else if (downloaderTargets.unresolvedWgetTarget || downloaderTargets.sawOutputFlag) {
        const targets = downloaderTargets.unresolvedWgetTarget
          ? null
          : normalizeConductorMutationTargets(downloaderTargets.targets, executionContext?.cwd ?? cwd, rootCwd);
        mutations.push({ command: commandName, targets: targets ?? [] });
      }
      continue;
    }
    if (CONDUCTOR_BASH_MUTATION_COMMANDS.has(commandName)) {
      if (activeState.filesystemAliasMayExist) {
        mutations.push({ command: commandName, targets: [] });
        continue;
      }
      if (conductorInvocationUsesEnvCwdChangingWrapper(words, commandStartIndex, commandIndex)) {
        mutations.push({ command: commandName, targets: [] });
        continue;
      }

      const rsyncMetadataControl = commandName === "rsync" && isConductorSafeRsyncMetadataControl(
        words,
        commandIndex,
        executionContext?.cwd ?? cwd,
        rootCwd,
        activeState,
      );
      if (commandName === "rsync" && !rsyncMetadataControl) {
        mutations.push({ command: commandName, targets: [] });
        continue;
      }
      const targets = collectConductorMutationCommandTargets(
        commandName,
        words,
        commandIndex,
        executionContext?.cwd ?? cwd,
        stateHasPosixlyCorrect(activeState) || commandPrefixConfiguresPosixlyCorrect(words, commandStartIndex, commandIndex),
      );
      if (targets === null) {
        if (
          commandName === "cp" || commandName === "mv" || commandName === "install" || commandName === "ln"
          || isConductorReferenceTargetModeCommand(commandName)
          || commandName === "rsync"
          || commandName === "dd"
          || commandName === "truncate"
          || ((commandName === "sed" || commandName === "perl") && conductorEditorHasInPlaceOption(commandName, words, commandIndex))
        ) mutations.push({ command: commandName, targets: [] });
      } else {
        const normalizedTargets = normalizeConductorMutationTargets(targets, executionContext?.cwd ?? cwd, rootCwd);
        mutations.push({
          command: commandName,
          targets: normalizedTargets ?? [],
          nativeChildMetadataControl: isNativeChildSafeConductorReferenceControl(words, commandIndex, executionContext?.cwd ?? cwd)
            || rsyncMetadataControl && isNativeChildSafeConductorRsyncMetadataControl(
              words,
              commandIndex,
              executionContext?.cwd ?? cwd,
              rootCwd,
            ),
        });
        if (conductorCommandInvalidatesStaticDirectoryProof(commandName, words, commandIndex)) {
          invalidateConductorStaticDirectoryProofs(activeState, targets, executionContext?.cwd ?? cwd);
          if (activeState !== state) {
            for (const directory of activeState.invalidatedStaticDirectories) state.invalidatedStaticDirectories.add(directory);
          }
        }
        if (conductorCommandMayCreateFilesystemAlias(commandName, words, commandIndex)) {
          activeState.filesystemAliasMayExist = true;
          if (activeState !== state) state.filesystemAliasMayExist = true;
        }
      }
    }
  for (const context of isolatedContexts.values()) {
    state.filesystemAliasMayExist ||= context.state.filesystemAliasMayExist;
    for (const directory of context.state.invalidatedStaticDirectories) state.invalidatedStaticDirectories.add(directory);
  }
  }
}

function functionDefinitionMayBeConditional(commandPrefix: string): boolean {
  const words = tokenizeShellWords(commandPrefix);
  let ifDepth = 0;
  let caseDepth = 0;
  let groupingDepth = 0;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "if") ifDepth += 1;
    else if (word === "fi" && ifDepth > 0) ifDepth -= 1;
    else if (word === "case") caseDepth += 1;
    else if (word === "esac" && caseDepth > 0) caseDepth -= 1;
    else if (isShellGroupingOpen(words, index)) groupingDepth += 1;
    else if (word === ")" && groupingDepth > 0) groupingDepth -= 1;
  }
  return ifDepth > 0 || caseDepth > 0 || groupingDepth > 0 || words.some((word) => word === "while" || word === "until" || word === "for" || word === "select" || word === "&") || words.includes("&&") || words.includes("||");
}

interface ConductorIsolatedFunctionDefinitionRegion {
  start: number;
  end: number;
  source: string;
}

function isConductorIsolatingOperatorAt(source: string, index: number): boolean {
  let cursor = index;
  while (/\s/.test(source[cursor] ?? "")) cursor += 1;
  const operator = source[cursor] ?? "";
  if (operator === "&") return source[cursor + 1] !== "&";
  if (operator === "|") return source[cursor + 1] !== "|";
  return false;
}

function conductorShellCommandStartBefore(source: string, index: number): number {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (source[cursor] === ";" || source[cursor] === "\n" || source[cursor] === "\r" || source[cursor] === "&" || source[cursor] === "|") return cursor + 1;
  }
  return 0;
}

function findConductorIsolatedFunctionDefinitionRegion(
  source: string,
  definitionStart: number,
  bodyEnd: number,
): ConductorIsolatedFunctionDefinitionRegion | null {
  const groupings: Array<{ openIndex: number; openChar: "{" | "(" }> = [];
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < definitionStart; index += 1) {
    const char = source[index] ?? "";
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
      continue;
    }
    if (quote) continue;
    if (char === "{" || char === "(") {
      groupings.push({ openIndex: index, openChar: char });
      continue;
    }
    const expectedOpenChar = char === "}" ? "{" : char === ")" ? "(" : null;
    if (expectedOpenChar && groupings.at(-1)?.openChar === expectedOpenChar) groupings.pop();
  }

  for (const grouping of groupings) {
    const groupingEnd = findShellFunctionBodyEnd(source, grouping.openIndex, grouping.openChar);
    if (groupingEnd <= bodyEnd) continue;
    const prefix = source.slice(conductorShellCommandStartBefore(source, grouping.openIndex), grouping.openIndex);
    const coprocGroup = tokenizeConductorShellWords(prefix).includes("coproc");
    if (grouping.openChar === "(" || coprocGroup || isConductorIsolatingOperatorAt(source, groupingEnd + 1)) {
      return {
        start: grouping.openIndex,
        end: groupingEnd + 1,
        source: source.slice(grouping.openIndex + 1, groupingEnd),
      };
    }
  }

  const definitionPrefix = source.slice(conductorShellCommandStartBefore(source, definitionStart), definitionStart);
  if (!tokenizeConductorShellWords(definitionPrefix).includes("coproc") && !isConductorIsolatingOperatorAt(source, bodyEnd + 1)) return null;
  return {
    start: definitionStart,
    end: bodyEnd + 1,
    source: source.slice(definitionStart, bodyEnd + 1),
  };
}

function stripShellCommentsForConductorScan(command: string): string {
  let result = "";
  let quote: "'" | "\"" | "$'" | null = null;
  let parameterExpansionDepth = 0;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && quote !== "'") {
      result += char;
      index += 1;
      result += command[index] ?? "";
      continue;
    }
    if (!quote && char === "$" && command[index + 1] === "'") {
      quote = "$'";
      result += "$'";
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char || (quote === "$'" && char === "'")) quote = null;
      else if (!quote) quote = char;
      result += char;
      continue;
    }
    if (quote !== "'" && char === "$" && command[index + 1] === "{") {
      parameterExpansionDepth += 1;
      result += "${";
      index += 1;
      continue;
    }
    if (parameterExpansionDepth > 0 && char === "}") {
      parameterExpansionDepth -= 1;
      result += char;
      continue;
    }
    if (!quote && parameterExpansionDepth === 0 && char === "#" && (index === 0 || /[\s;|&(){}<>]/.test(command[index - 1] ?? ""))) {
      while (index < command.length && command[index] !== "\n" && command[index] !== "\r") {
        result += " ";
        index += 1;
      }
      index -= 1;
      continue;
    }
    result += char;
  }
  return result;
}
// Process substitutions run in child scopes. Their bodies are evaluated separately
// below, never as commands in the caller's ordered binding context.
function stripProcessSubstitutionBodiesForConductorScan(command: string): string {
  let result = "";
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && quote !== "'") {
      result += char;
      index += 1;
      result += command[index] ?? "";
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
      result += char;
      continue;
    }
    if (quote) {
      result += char;
      continue;
    }
    if ((char === "<" || char === ">") && command[index + 1] === "(") {
      const substitutionEnd = findProcessSubstitutionEnd(command, index + 2);
      result += `${char} /dev/null`;
      if (substitutionEnd < 0) {
        result += "; __conductor_unresolved_process_substitution";
        break;
      }
      index = substitutionEnd;
      continue;
    }
    result += char;
  }
  return result;
}

function stripCommandSubstitutionBodiesForConductorScan(command: string): string {
  let result = "";
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && quote !== "'") {
      result += char;
      index += 1;
      result += command[index] ?? "";
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
      result += char;
      continue;
    }
    if (quote !== "'" && char === "$" && command[index + 1] === "(" && command[index + 2] !== "(") {
      const end = findCommandSubstitutionEnd(command, index + 2);
      result += "$CONDUCTOR_COMMAND_SUBSTITUTION";
      if (end < 0) {
        result += "; __conductor_unresolved_command_substitution";
        break;
      }
      index = end;
      continue;
    }
    if (quote !== "'" && char === "`") {
      const end = findBacktickCommandSubstitutionEnd(command, index + 1);
      result += "$CONDUCTOR_COMMAND_SUBSTITUTION";
      if (end < 0) {
        result += "; __conductor_unresolved_command_substitution";
        break;
      }
      index = end;
      continue;
    }
    result += char;
  }
  return result;
}


function collectProcessSubstitutionExpansionPrefix(command: string, substitutionIndex: number): string {
  let quote: "'" | "\"" | "$'" | null = null;
  let parameterExpansionDepth = 0;
  let groupingDepth = 0;
  let boundary = 0;
  for (let index = 0; index < substitutionIndex; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (!quote && char === "$" && command[index + 1] === "'") {
      quote = "$'";
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char || (quote === "$'" && char === "'")) quote = null;
      else if (!quote) quote = char;
      continue;
    }
    if (quote) continue;
    if (char === "$" && command[index + 1] === "{") {
      parameterExpansionDepth += 1;
      index += 1;
      continue;
    }
    if (parameterExpansionDepth > 0) {
      if (char === "}") parameterExpansionDepth -= 1;
      continue;
    }
    if (char === "{" || char === "(") {
      groupingDepth += 1;
      continue;
    }
    if ((char === "}" || char === ")") && groupingDepth > 0) {
      groupingDepth -= 1;
      continue;
    }
    if (groupingDepth === 0 && (char === ";" || char === "\n" || char === "\r" || char === "&")) {
      boundary = index + 1;
    }
  }
  return command.slice(0, boundary);
}

function isInsideConductorSubstitutionGrouping(command: string, substitutionIndex: number): boolean {
  let quote: "'" | "\"" | "$'" | null = null;
  let groupingDepth = 0;
  for (let index = 0; index < substitutionIndex; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (!quote && char === "$" && command[index + 1] === "'") {
      quote = "$'";
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char || (quote === "$'" && char === "'")) quote = null;
      else if (!quote) quote = char;
      continue;
    }
    if (quote) continue;
    const arithmeticEnd = char === "$" ? findShellArithmeticExpansionEnd(command, index) : null;
    const legacyArithmeticEnd = char === "$" ? findShellLegacyArithmeticExpansionEnd(command, index) : null;
    const parameterEnd = char === "$" && command[index + 1] === "{"
      ? findShellParameterExpansionEnd(command, index)
      : null;
    const nestedSubstitutionEnd = char === "$" && command[index + 1] === "(" && command[index + 2] !== "("
      ? findCommandSubstitutionEnd(command, index + 2)
      : (char === "<" || char === ">") && command[index + 1] === "("
        ? findProcessSubstitutionEnd(command, index + 2)
        : char === "`"
          ? findBacktickCommandSubstitutionEnd(command, index + 1)
          : null;
    const expansionEnd = arithmeticEnd ?? legacyArithmeticEnd ?? parameterEnd ?? nestedSubstitutionEnd;
    if (expansionEnd !== null) {
      if (expansionEnd < 0) return true;
      index = expansionEnd;
      continue;
    }
    if (char === "{" || char === "(") {
      groupingDepth += 1;
      continue;
    }
    if ((char === "}" || char === ")") && groupingDepth > 0) groupingDepth -= 1;
  }
  return groupingDepth > 0;
}

function isInsideConductorShellFunctionDefinition(command: string, index: number): boolean {
  for (let cursor = 0; cursor < index; cursor += 1) {
    const definition = findShellFunctionDefinitionAt(command, cursor);
    if (!definition) continue;
    const bodyEnd = findShellFunctionBodyEnd(command, definition.openBraceIndex, definition.bodyOpenChar);
    if (bodyEnd < 0) return true;
    if (index > definition.openBraceIndex && index <= bodyEnd) return true;
    cursor = bodyEnd;
  }
  return false;
}

function collectLexicalProcessSubstitutions(command: string): Array<{ prefix: string; body: string; index: number; grouped: boolean }> {
  const substitutions: Array<{ prefix: string; body: string; index: number; grouped: boolean }> = [];
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
      continue;
    }
    if (quote !== "'" && char === "$" && command[index + 1] === "(" && command[index + 2] !== "(") {
      const end = findCommandSubstitutionEnd(command, index + 2);
      if (end < 0) continue;
      index = end;
      continue;
    }
    if (quote !== "'" && char === "`") {
      const end = findBacktickCommandSubstitutionEnd(command, index + 1);
      if (end < 0) continue;
      index = end;
      continue;
    }
    if (quote || (char !== "<" && char !== ">") || command[index + 1] !== "(") continue;
    const end = findProcessSubstitutionEnd(command, index + 2);
    if (end < 0) continue;
    const body = command.slice(index + 2, end);
    if (body && !isInsideConductorShellFunctionDefinition(command, index)) {
      substitutions.push({ prefix: collectProcessSubstitutionExpansionPrefix(command, index), body, index, grouped: isInsideConductorSubstitutionGrouping(command, index) });
    }
    index = end;
  }
  return substitutions;
}

function collectLexicalCommandSubstitutions(command: string): Array<{ prefix: string; body: string; index: number; grouped: boolean }> {
  const substitutions: Array<{ prefix: string; body: string; index: number; grouped: boolean }> = [];
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
      continue;
    }
    if (quote !== "'" && (char === "<" || char === ">") && command[index + 1] === "(") {
      const end = findProcessSubstitutionEnd(command, index + 2);
      if (end < 0) continue;
      index = end;
      continue;
    }
    const commandSubstitution = quote !== "'" && char === "$" && command[index + 1] === "(" && command[index + 2] !== "(";
    const backtickSubstitution = quote !== "'" && char === "`";
    if (!commandSubstitution && !backtickSubstitution) continue;
    const bodyStart = index + (commandSubstitution ? 2 : 1);
    const end = commandSubstitution
      ? findCommandSubstitutionEnd(command, bodyStart)
      : findBacktickCommandSubstitutionEnd(command, bodyStart);
    if (end < 0) continue;
    const body = command.slice(bodyStart, end);
    if (body && !isInsideConductorShellFunctionDefinition(command, index)) {
      substitutions.push({ prefix: collectProcessSubstitutionExpansionPrefix(command, index), body, index, grouped: isInsideConductorSubstitutionGrouping(command, index) });
    }
    index = end;
  }
  return substitutions;
}

function scanConductorShellSource(
  command: string,
  state: ShellPosixState,
  functions: Map<string, string[]>,
  cwd: string,
  inFunction: boolean,
  depth: number,
  mutations: ConductorBashMutation[],
  isolatedFunctionBindings: ReadonlySet<string> | null = null,
  rootCwd = cwd,
  scanLexicalSubstitutions = true,
  onStaticNestedBashExecution?: (command: string, functions: ReadonlyMap<string, string[]>, cwd: string) => void,
): void {
  const structural = maskShellNonCommandExpansionsForConductorScan(stripShellCommentsForConductorScan(stripHeredocBodiesForCommandScan(normalizeShellLineContinuations(command))));
  const normalized = stripCommandSubstitutionBodiesForConductorScan(stripProcessSubstitutionBodiesForConductorScan(structural));
  if (depth >= CONDUCTOR_BASH_MAX_NESTING_DEPTH) {
    if (normalized.trim()) mutations.push({ command: "nested-shell", targets: [] });
    return;
  }
  if (scanLexicalSubstitutions) {
    const substitutions = [
      ...collectLexicalProcessSubstitutions(structural),
      ...collectLexicalCommandSubstitutions(structural),
    ].sort((left, right) => left.index - right.index);
    for (const substitution of substitutions) {
      const prefixState = cloneShellPosixState(state);
      const prefixFunctions = new Map(functions);
      scanConductorShellSource(substitution.prefix, prefixState, prefixFunctions, prefixState.effectiveCwd ?? cwd, inFunction, depth, mutations, isolatedFunctionBindings, rootCwd, false, onStaticNestedBashExecution);
      const childState = cloneShellPosixState(prefixState);
      if (substitution.grouped) markConductorCwdUnresolved(childState);
      scanConductorShellSource(substitution.body, childState, new Map(prefixFunctions), childState.effectiveCwd ?? cwd, false, depth + 1, mutations, null, rootCwd, true, onStaticNestedBashExecution);
      state.filesystemAliasMayExist ||= childState.filesystemAliasMayExist;
      for (const directory of childState.invalidatedStaticDirectories) state.invalidatedStaticDirectories.add(directory);
    }
  }
  let unscannedStart = 0;
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < structural.length; index += 1) {
    const char = structural[index] ?? "";
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
      continue;
    }
    if (quote) continue;
    const commandSubstitution = char === "$" && structural[index + 1] === "(" && structural[index + 2] !== "(";
    const processSubstitution = (char === "<" || char === ">") && structural[index + 1] === "(";
    const backtickSubstitution = char === "`";
    if (commandSubstitution || processSubstitution || backtickSubstitution) {
      const end = commandSubstitution
        ? findCommandSubstitutionEnd(structural, index + 2)
        : processSubstitution
          ? findProcessSubstitutionEnd(structural, index + 2)
          : findBacktickCommandSubstitutionEnd(structural, index + 1);
      if (end < 0) {
        mutations.push({ command: "substitution", targets: [] });
        return;
      }
      index = end;
      continue;
    }
    const definition = findShellFunctionDefinitionAt(structural, index);
    if (!definition) continue;
    const bodyEnd = findShellFunctionBodyEnd(structural, definition.openBraceIndex, definition.bodyOpenChar);
    if (bodyEnd < 0) {
      mutations.push({ command: "function", targets: [] });
      return;
    }
    const isolatedRegion = findConductorIsolatedFunctionDefinitionRegion(structural, definition.startIndex, bodyEnd);
    if (isolatedRegion && isolatedRegion.start >= unscannedStart) {
      for (const segment of splitConductorShellSegments(stripCommandSubstitutionBodiesForConductorScan(stripProcessSubstitutionBodiesForConductorScan(structural.slice(unscannedStart, isolatedRegion.start))))) {
        scanConductorShellSegment(segment, state, functions, isolatedFunctionBindings, cwd, inFunction, depth, mutations, rootCwd, onStaticNestedBashExecution);
      }
      if (depth >= CONDUCTOR_BASH_MAX_NESTING_DEPTH) {
        mutations.push({ command: "function", targets: [] });
      } else {
        const childState = cloneShellPosixState(state);
        scanConductorShellSource(
          isolatedRegion.source,
          childState,
          new Map(functions),
          childState.effectiveCwd ?? cwd,
          inFunction,
          depth + 1,
          mutations,
          null,
          rootCwd,
          true,
          onStaticNestedBashExecution,
        );
        state.filesystemAliasMayExist ||= childState.filesystemAliasMayExist;
        for (const directory of childState.invalidatedStaticDirectories) state.invalidatedStaticDirectories.add(directory);
      }
      unscannedStart = isolatedRegion.end;
      index = isolatedRegion.end - 1;
      continue;
    }
    for (const segment of splitConductorShellSegments(stripCommandSubstitutionBodiesForConductorScan(stripProcessSubstitutionBodiesForConductorScan(structural.slice(unscannedStart, definition.startIndex))))) {
      scanConductorShellSegment(segment, state, functions, isolatedFunctionBindings, cwd, inFunction, depth, mutations, rootCwd, onStaticNestedBashExecution);
    }
    const body = structural.slice(definition.openBraceIndex + 1, bodyEnd);
    const priorBodies = functions.get(definition.name) ?? [];
    const conditional = functionDefinitionMayBeConditional(structural.slice(0, definition.startIndex)) || /^\s*&/.test(structural.slice(bodyEnd + 1));
    if (isolatedFunctionBindings?.has(definition.name)) mutations.push({ command: "function", targets: [] });
    const attributes = priorBodies.filter((priorBody) => !isConductorFunctionBody(priorBody));
    const hasReadonlyAttribute = attributes.includes(CONDUCTOR_READONLY_FUNCTION_BODY);
    functions.set(
      definition.name,
      conditional
        ? [...new Set([...(priorBodies.length > 0 ? priorBodies : [CONDUCTOR_UNBOUND_FUNCTION_BODY]), body])]
        : hasReadonlyAttribute
          ? priorBodies
          : [...new Set([body, ...attributes])],
    );
    unscannedStart = bodyEnd + 1;
    index = bodyEnd;
  }
  for (const segment of splitConductorShellSegments(stripCommandSubstitutionBodiesForConductorScan(stripProcessSubstitutionBodiesForConductorScan(structural.slice(unscannedStart))))) {
    scanConductorShellSegment(segment, state, functions, isolatedFunctionBindings, cwd, inFunction, depth, mutations, rootCwd, onStaticNestedBashExecution);
  }
  if (inFunction && /(?:^|[;\n{}])\s*return(?:\s|;|$)/.test(structural)) {
    // A return terminates the current function before any lexically later cleanup.
    // The lightweight shell scanner cannot safely reconstruct all conditional flow,
    // so retain only a fail-closed caller state after a reachable return surface.
    markConductorCwdUnresolved(state);
    markConductorTrackedBindingsUnresolved(state);
    state.securityEnvironmentUnresolved = true;
  }
}

function extractConductorBashMutations(command: string, cwd = process.cwd(), rootCwd = cwd): ConductorBashMutation[] {
  if (inheritedConductorBashStartupIsUnsafe()) return [{ command: "BASH_ENV", targets: [] }];
  if (hasConductorPromptParameterTransform(command)) return [{ command: "prompt", targets: [] }];
  if (hasUnresolvedShellArithmeticExpansion(command)) return [{ command: "arithmetic", targets: [] }];
  if (curlCommandHasUnsafeShellExpandedWord(command)) return [{ command: "curl", targets: [] }];
  const mutations: ConductorBashMutation[] = [];
  const bindings = new Map<ConductorShellBindingName, ConductorShellBinding>();
  for (const name of CONDUCTOR_SHELL_BINDING_NAMES) {
    const value = process.env[name];
    if (value !== undefined) bindings.set(name, { value, exported: true, readonly: false, local: false, dirty: false });
  }
  const state: ShellPosixState = {
    bindings,
    securityEnvironment: inheritedConductorSecurityEnvironment(),
    dirtySecurityEnvironmentNames: new Set(),
    securityEnvironmentUnresolved: false,
    lastpipe: false,
    jobControl: false,
    jobControlMayBeDisabled: true,
    bashoptsLastpipe: safeString(process.env.BASHOPTS).split(":").includes("lastpipe"),
    functionLocalBindings: new Set(),
    posixMode: safeString(process.env.POSIXLY_CORRECT).length > 0 || inheritedConductorShellOptions().posix,
    physicalCwd: inheritedConductorShellOptions().physical,
    filesystemAliasMayExist: false,
    invalidatedStaticDirectories: new Set(),
    pathUsesSystemDefaultWhenUnset: false,
    effectiveCwd: cwd,
    directoryStack: [cwd],
    aliases: new Map(),
    globalAliases: new Set(),
    bashoptsExported: safeString(process.env.BASHOPTS).length > 0,
    allexport: inheritedConductorShellOptions().allexport,
    shellOptionsKnown: inheritedConductorShellOptions().known,
  };
  if (!state.shellOptionsKnown) return [{ command: "SHELLOPTS", targets: [] }];
  scanConductorShellSource(command, state, inheritedConductorFunctionBindings(), cwd, false, 0, mutations, null, rootCwd);
  if (state.securityEnvironmentUnresolved) mutations.push({ command: "environment", targets: [] });
  return mutations;
}

function rsyncInvocationHasUnsafeRuntimeEnvironment(words: string[], commandIndex: number, state?: ShellPosixState): boolean {
  let commandStartIndex = commandIndex;
  while (
    commandStartIndex > 0
    && !isShellCommandSeparatorAt(words, commandStartIndex - 1)
    && !isShellGroupingSyntaxWord(words[commandStartIndex - 1] ?? "")
  ) commandStartIndex -= 1;
  const clearBoundary = nestedExecEnvironmentClearBoundary(words, commandStartIndex, commandIndex);
  const values = new Map<string, boolean>();
  if (clearBoundary === null) {
    for (const [name, value] of Object.entries(process.env)) {
      if (/^RSYNC_[A-Z0-9_]+$/.test(name)) values.set(name, safeString(value).trim() !== "");
    }
  }
  for (let index = clearBoundary === null ? 0 : clearBoundary + 1; index < commandIndex; index += 1) {
    const word = words[index] ?? "";
    const assignment = parseShellAssignmentWord(word);
    if (assignment && /^RSYNC_[A-Z0-9_]+$/.test(assignment.name)) {
      values.set(assignment.name, assignment.append || /[$`]/.test(assignment.value) || assignment.value.trim() !== "");
      continue;
    }
    const commandName = commandNameFromShellWord(word);
    if (commandName === "env" && index === commandStartIndex) {
      const operands = collectConductorInvocationWords(words, index);
      for (let operandIndex = 0; operandIndex < operands.length; operandIndex += 1) {
        const operand = shellWordLiteral(operands[operandIndex] ?? "");
        const unsetName = operand === "-u" || operand === "--unset"
          ? shellWordLiteral(operands[operandIndex + 1] ?? "")
          : operand.startsWith("--unset=")
            ? operand.slice("--unset=".length)
            : /^-u.+/.test(operand)
              ? operand.slice(2)
              : "";
        if (/^RSYNC_[A-Z0-9_]+$/.test(unsetName)) values.set(unsetName, false);
        if (operand === "-u" || operand === "--unset") operandIndex += 1;
      }
      continue;
    }
    if (commandName === "unset") {
      for (const operand of collectConductorInvocationWords(words, index)) {
        const name = shellWordLiteral(operand);
        if (/^RSYNC_[A-Z0-9_]+$/.test(name)) values.set(name, false);
      }
      continue;
    }
    if (commandName !== "export" && commandName !== "readonly" && commandName !== "declare" && commandName !== "typeset") continue;
    for (const operand of collectConductorInvocationWords(words, index)) {
      const declaration = parseShellAssignmentWord(operand);
      if (declaration && /^RSYNC_[A-Z0-9_]+$/.test(declaration.name)) {
        values.set(declaration.name, declaration.append || /[$`]/.test(declaration.value) || declaration.value.trim() !== "");
      } else if (/^RSYNC_[A-Z0-9_]+$/.test(shellWordLiteral(operand))) {
        values.set(shellWordLiteral(operand), values.get(shellWordLiteral(operand)) ?? true);
      }
    }
  }
  if (clearBoundary === null && state?.securityEnvironmentUnresolved) return true;
  if (clearBoundary === null) {
    for (const [name, value] of state?.securityEnvironment ?? []) {
      if (!/^RSYNC_[A-Z0-9_]+$/.test(name)) continue;
      values.set(name, value === CONDUCTOR_UNKNOWN_SHELL_BINDING || value.trim() !== "");
    }
  }
  return [...values.values()].some(Boolean);
}

function isNativeChildSafeConductorMetadataTarget(cwd: string, target: string): boolean {
  if (!isAllowedConductorMetadataPath(cwd, target)) return false;
  const relativePath = normalizeRepoRelativePath(cwd, target);
  if (!relativePath) return false;
  const normalized = relativePath.replace(/\\/g, "/");
  if (/(^|\/)(?:session(?:s)?|mode|skill(?:s)?|team|config|manifest|actor|run)(?:[._/-]|$)/i.test(normalized)) return false;
  return normalized.startsWith(".omx/state/inbox/")
    || normalized.startsWith(".omx/state/logs/")
    || normalized.startsWith(".omx/state/references/")
    || normalized.startsWith(".omx/handoffs/")
    || normalized.startsWith(".omx/state/") && (normalized.endsWith(".log") || /(?:^|\/)reference[^/]*$/.test(normalized));
}

function collectConductorRsyncStaticTransferPaths(
  words: string[],
  commandIndex: number,
): { source: string; destination: string; logFile?: string } | null {
  const positionalPaths: string[] = [];
  const noArgumentLongOptions = new Set([
    "--verbose", "--quiet", "--checksum", "--compress", "--dry-run", "--human-readable", "--itemize-changes", "--protect-args",
  ]);
  const valueLongOptions = new Set(["--log-file", "--bwlimit", "--timeout", "--contimeout"]);
  const noArgumentFlags = new Set("0cnqvzih");
  let logFile: string | undefined;
  let optionsTerminated = false;
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = shellWordLiteral(words[index] ?? "");
    if (!word || isShellCommandTerminatorOrGroupClose(word) || shellWordMayProduceWgetOptions(word)) return null;
    if (!optionsTerminated && word === "--") {
      optionsTerminated = true;
      continue;
    }
    if (!optionsTerminated && word.startsWith("--")) {
      const separator = word.indexOf("=");
      const option = separator < 0 ? word : word.slice(0, separator);
      const inlineValue = separator < 0 ? undefined : word.slice(separator + 1);
      if (noArgumentLongOptions.has(option)) {
        if (inlineValue !== undefined) return null;
        continue;
      }
      if (!valueLongOptions.has(option)) return null;
      const value = inlineValue ?? shellWordLiteral(words[index + 1] ?? "");
      if (!value || isShellCommandTerminatorOrGroupClose(value) || shellWordMayProduceWgetOptions(value)) return null;
      if (option === "--log-file") {
        if (logFile !== undefined) return null;
        logFile = value;
      }
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (!optionsTerminated && word.startsWith("-") && word !== "-") {
      if (!/^-[-A-Za-z0-9]+$/.test(word) || [...word.slice(1)].some((flag) => !noArgumentFlags.has(flag))) return null;
      continue;
    }
    positionalPaths.push(word);
  }
  if (positionalPaths.length !== 2) return null;
  const [source, destination] = positionalPaths;
  const isRemote = (path: string): boolean => path.startsWith(":") || /^(?:[^/:\s]+@)?[^/:\s]+:.+/.test(path);
  if (!source || !destination || source.endsWith("/") || destination.endsWith("/") || isRemote(source) || isRemote(destination)) return null;
  return logFile === undefined ? { source, destination } : { source, destination, logFile };
}

function conductorMetadataOperandIdentity(cwd: string, rawPath: string): string | null {
  if (!rawPath || shellWordMayProduceWgetOptions(rawPath)) return null;
  try {
    const path = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) return null;
    const resolved = statSync(path);
    return `inode:${resolved.dev}:${resolved.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    try {
      const path = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
      const parent = realpathSync(dirname(path));
      if (!statSync(parent).isDirectory()) return null;
      return `new:${parent}/${basename(path)}`;
    } catch {
      return null;
    }
  }
}

function conductorRsyncOperandsArePairwiseDistinct(cwd: string, transfer: { source: string; destination: string; logFile?: string }): boolean {
  const identities = [transfer.source, transfer.destination, ...(transfer.logFile === undefined ? [] : [transfer.logFile])]
    .map((path) => conductorMetadataOperandIdentity(cwd, path));
  return identities.every((identity): identity is string => identity !== null)
    && new Set(identities).size === identities.length;
}

function isConductorSafeRsyncMetadataControl(
  words: string[],
  commandIndex: number,
  cwd: string,
  rootCwd: string,
  state?: ShellPosixState,
): boolean {
  if (rsyncInvocationHasUnsafeRuntimeEnvironment(words, commandIndex, state)) return false;
  const transfer = collectConductorRsyncStaticTransferPaths(words, commandIndex);
  if (!transfer) return false;
  if (!conductorRsyncOperandsArePairwiseDistinct(cwd, transfer)) return false;

  const normalizedDestination = normalizeConductorMutationTargets([transfer.destination], cwd, rootCwd);
  if (
    normalizedDestination === null
    || normalizedDestination.length !== 1
    || !isAllowedConductorMetadataPath(rootCwd, normalizedDestination[0] ?? "")
  ) return false;
  if (transfer.logFile !== undefined) {
    const normalizedLog = normalizeConductorMutationTargets([transfer.logFile], cwd, rootCwd);
    if (
      normalizedLog === null
      || normalizedLog.length !== 1
      || !isAllowedConductorMetadataPath(rootCwd, normalizedLog[0] ?? "")
    ) return false;
  }

  if (!conductorMetadataCopySourceIsFiniteRegular(cwd, transfer.source)) return false;
  try {
    const destinationPath = isAbsolute(transfer.destination) ? resolve(transfer.destination) : resolve(cwd, transfer.destination);
    if (existsSync(destinationPath)) {
      const destination = lstatSync(destinationPath);
      if (!destination.isFile() || destination.nlink !== 1) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isNativeChildSafeConductorRsyncMetadataControl(
  words: string[],
  commandIndex: number,
  cwd: string,
  rootCwd: string,
): boolean {
  const transfer = collectConductorRsyncStaticTransferPaths(words, commandIndex);
  if (!transfer || !conductorMetadataCopySourceIsFiniteRegular(cwd, transfer.source)) return false;
  if (!conductorRsyncOperandsArePairwiseDistinct(cwd, transfer)) return false;
  const targets = [transfer.destination, ...(transfer.logFile === undefined ? [] : [transfer.logFile])];
  const normalized = normalizeConductorMutationTargets(targets, cwd, rootCwd);
  return normalized !== null && normalized.length === targets.length
    && normalized.every((target) => isNativeChildSafeConductorMetadataTarget(rootCwd, target));
}

function isNativeChildSafeConductorReferenceControl(words: string[], commandIndex: number, cwd: string): boolean {
  const targets = collectConductorSafeReferenceControlTargets(
    commandNameFromShellWord(words[commandIndex] ?? ""),
    words,
    commandIndex,
    cwd,
  );
  return targets !== null && targets.every((target) => isNativeChildSafeConductorMetadataTarget(cwd, target));
}


interface ConductorStaticNestedBashExecution {
  command: string;
  functions: Map<string, string[]>;
  cwd: string;
}

function createConductorRuntimeShellState(cwd: string): ShellPosixState {
  const bindings = new Map<ConductorShellBindingName, ConductorShellBinding>();
  for (const name of CONDUCTOR_SHELL_BINDING_NAMES) {
    const value = process.env[name];
    if (value !== undefined) bindings.set(name, { value, exported: true, readonly: false, local: false, dirty: false });
  }
  return {
    bindings,
    securityEnvironment: inheritedConductorSecurityEnvironment(),
    dirtySecurityEnvironmentNames: new Set(),
    securityEnvironmentUnresolved: false,
    lastpipe: false,
    jobControl: false,
    jobControlMayBeDisabled: true,
    bashoptsLastpipe: safeString(process.env.BASHOPTS).split(":").includes("lastpipe"),
    functionLocalBindings: new Set(),
    posixMode: safeString(process.env.POSIXLY_CORRECT).length > 0 || inheritedConductorShellOptions().posix,
    physicalCwd: inheritedConductorShellOptions().physical,
    filesystemAliasMayExist: false,
    invalidatedStaticDirectories: new Set(),
    pathUsesSystemDefaultWhenUnset: false,
    effectiveCwd: cwd,
    directoryStack: [cwd],
    aliases: new Map(),
    globalAliases: new Set(),
    bashoptsExported: safeString(process.env.BASHOPTS).length > 0,
    allexport: inheritedConductorShellOptions().allexport,
    shellOptionsKnown: inheritedConductorShellOptions().known,
  };
}

function collectConductorStaticNestedBashExecutions(
  command: string,
  cwd: string,
  inheritedFunctions: ReadonlyMap<string, string[]> = new Map(),
): { functions: Map<string, string[]>; executions: ConductorStaticNestedBashExecution[] } {
  const state = createConductorRuntimeShellState(cwd);
  const functions = new Map([...inheritedConductorFunctionBindings(), ...inheritedFunctions]);
  const executions: ConductorStaticNestedBashExecution[] = [];
  scanConductorShellSource(
    command,
    state,
    functions,
    cwd,
    false,
    0,
    [],
    null,
    cwd,
    true,
    (nestedCommand, childFunctions, childCwd) => executions.push({ command: nestedCommand, functions: new Map(childFunctions), cwd: childCwd }),
  );
  return { functions, executions };
}

function collectStaticNestedShellTargetAliases(cwd: string, command: string): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  const words = tokenizeConductorShellWords(stripHeredocBodiesForCommandScan(command));
  for (let index = 0; index < words.length; index += 1) {
    if (!isNestedShellCommandWord(words[index] ?? "")) continue;
    const commandStringIndex = findShellCommandStringArgIndex(words, index + 1);
    if (commandStringIndex === null) continue;
    const nestedCommand = words[commandStringIndex] ?? "";
    if (!nestedCommand) continue;
    let commandStart = index;
    while (commandStart > 0 && !isShellCommandSeparatorAt(words, commandStart - 1)) commandStart -= 1;
    const context = resolveWrappedCommandExecutionContext(words, cwd, commandStart);
    if (context === null) continue;
    for (const rawTarget of extractDeepInterviewCommandWriteTargets(nestedCommand)) {
      const normalized = normalizeConductorMutationTargets([rawTarget], context.cwd, cwd)?.[0];
      if (!normalized) continue;
      const current = aliases.get(rawTarget) ?? [];
      aliases.set(rawTarget, [...current, normalized]);
    }
  }
  return aliases;
}
const CONDUCTOR_BASH_MAX_NESTING_DEPTH = 5;



function conductorStateWriteTransportIsBoundToActiveSession(
  command: string,
  authoritativeSessionId: string,
  cwd: string,
): boolean {
  const canonicalCommand = canonicalizeOmxStateTransportCommand(command);
  const hasStateWrite = collectOmxStateCommandOperations(canonicalCommand, "write").length > 0
    || /\b(?:omx|gjc)\s+state\s+write\b/.test(stripHeredocBodiesForCommandScan(command));
  if (!hasStateWrite) return true;
  if (!authoritativeSessionId) return false;
  const statePayload = readStateWriteInputPayload(cwd, canonicalCommand, command);
  if (
    !statePayload
    || safeString(statePayload.session_id).trim() !== authoritativeSessionId
    || !suppliedSessionAliasesMatch(statePayload, authoritativeSessionId)
    || safeString(statePayload.workingDirectory).trim() === ""
    || resolve(safeString(statePayload.workingDirectory)) !== resolve(cwd)
  ) return false;
  // Inherited hook environment is process-authenticated; model-controlled shell
  // assignments must match the session resolved for this PreToolUse payload.
  const inheritedSessionSelectors = [...new Set(["OMX_SESSION_ID", "GJC_SESSION_ID"]
    .map((name) => safeString(process.env[name]).trim())
    .filter(Boolean))];
  const inheritedSelectorsAreCanonical = inheritedSessionSelectors.length === 1
    && inheritedSessionSelectors[0] === authoritativeSessionId;
  for (const segment of splitShellCommandSegments(stripHeredocBodiesForCommandScan(command))) {
    const segmentHasStateWrite = /\b(?:omx|gjc)\s+state\s+write\b/.test(segment);
    const clearsInheritedEnvironment = /\b(?:env\s+(?:(?:-[A-Za-z]*i[A-Za-z]*|--ignore-environment)\s+|--ignore-environment\s+)|exec\s+-[A-Za-z]*c[A-Za-z]*)/.test(segment);
    const words = tokenizeConductorShellWords(segment);
    const explicitSelectors = words.flatMap((word) => {
      const assignment = parseShellAssignmentWord(word);
      return assignment && (assignment.name === "OMX_SESSION_ID" || assignment.name === "GJC_SESSION_ID") ? [assignment] : [];
    });
    const explicitSelectorsAreCanonical = explicitSelectors.length > 0
      && explicitSelectors.every((assignment) => !assignment.append && !/[$`]/.test(assignment.value) && assignment.value === authoritativeSessionId);
    if (
      segmentHasStateWrite
      && (
        clearsInheritedEnvironment
          ? !explicitSelectorsAreCanonical
          : !inheritedSelectorsAreCanonical && !explicitSelectorsAreCanonical
      )
    ) return false;
    const commandIndex = skipShellCommandPositionPrefixWords(words, 0);
    if (commandNameFromShellWord(words[commandIndex] ?? "") === "unset") {
      if (collectConductorInvocationWords(words, commandIndex).some((operand) => {
        const name = shellWordLiteral(operand);
        return name === "OMX_SESSION_ID" || name === "GJC_SESSION_ID";
      })) return false;
    }
    for (let index = 0; index < words.length; index += 1) {
      const rawWord = words[index] ?? "";
      const assignment = parseShellAssignmentWord(rawWord);
      if (assignment && (assignment.name === "OMX_SESSION_ID" || assignment.name === "GJC_SESSION_ID")) {
        if (assignment.append || /[$`]/.test(assignment.value) || assignment.value !== authoritativeSessionId) return false;
      }
      const word = shellWordLiteral(rawWord);
      if (word !== "-u" && word !== "--unset" && !word.startsWith("--unset=") && !/^-u.+/.test(word)) continue;
      const unsetName = word.startsWith("--unset=")
        ? word.slice("--unset=".length)
        : /^-u.+/.test(word)
          ? word.slice(2)
          : shellWordLiteral(words[index + 1] ?? "");
      if (unsetName === "OMX_SESSION_ID" || unsetName === "GJC_SESSION_ID") return false;
    }
  }
  return true;
}

function evaluateConductorBashWrite(
  cwd: string,
  command: string,
  depth = 0,
  authoritativeSessionId = "",
  policyCwd = cwd,
): { allowed: boolean; blockedDetail?: string } {
  const commandWithHeredocBodies = normalizeShellLineContinuations(command);
  const normalizedCommand = stripHeredocBodiesForCommandScan(commandWithHeredocBodies);
  if (authoritativeSessionId && !conductorStateWriteTransportIsBoundToActiveSession(commandWithHeredocBodies, authoritativeSessionId, policyCwd)) {
    return {
      allowed: false,
      blockedDetail: "Bash structured state writes must remain bound to the active Conductor session",
    };
  }
  if (depth > CONDUCTOR_BASH_MAX_NESTING_DEPTH) {
    return {
      allowed: false,
      blockedDetail: "Bash nested shell depth exceeded Main-root Conductor validation limits",
    };
  }
  if (hasUnresolvedShellArithmeticExpansion(normalizedCommand)) {
    return {
      allowed: false,
      blockedDetail: "Bash arithmetic expansion is not statically numeric and cannot be validated for Main-root Conductor writes",
    };
  }
  if (commandHasUnsafeConductorShellState(normalizedCommand, cwd)) {
    return {
      allowed: false,
      blockedDetail: "Bash nameref or allexport shell state cannot be statically validated for Main-root Conductor writes",
    };
  }
  if (hasDynamicNestedShellExecution(normalizedCommand)) {
    return {
      allowed: false,
      blockedDetail: "Bash nested shell execution is dynamic and cannot be validated for Main-root Conductor writes",
    };
  }
  if (hasUnsafeUnquotedHeredocExpansion(commandWithHeredocBodies)) {
    return {
      allowed: false,
      blockedDetail: "Bash unquoted heredoc expansion is not workflow state/ledger/mailbox/handoff metadata",
    };
  }
  const redirectTargets = extractDeepInterviewCommandRedirectTargets(commandWithHeredocBodies);
  if (!conductorMetadataRedirectsHaveBoundedProducers(commandWithHeredocBodies)) {
    return {
      allowed: false,
      blockedDetail: "Bash metadata redirects require a statically bounded producer",
    };
  }
  if (redirectTargets.some((target) => !conductorRedirectTargetIsSafe(cwd, target, policyCwd))) {
    return {
      allowed: false,
      blockedDetail: "Bash redirect target is not a static workflow metadata leaf",
    };
  }
  if (!conductorMetadataWriteSizesStayBounded(cwd, commandWithHeredocBodies)) {
    return {
      allowed: false,
      blockedDetail: "Bash metadata writes exceed the bounded per-leaf size limit",
    };
  }

function isExactConductorMetadataRoot(cwd: string, target: string): boolean {
  const relativeTarget = normalizeRepoRelativePath(cwd, target);
  return Boolean(relativeTarget && CONDUCTOR_ORCHESTRATION_METADATA_PREFIXES.includes(relativeTarget as (typeof CONDUCTOR_ORCHESTRATION_METADATA_PREFIXES)[number]));
}

  const shellMutations = extractConductorBashMutations(normalizedCommand, cwd, policyCwd);
  if (shellMutations.length > 0) {
    for (const mutation of shellMutations) {
      if (mutation.mainRootStructuredStateWrite || mutation.mainRootStructuredOrchestrationMutation) continue;
      if (mutation.targets.length === 0) {
        return {
          allowed: false,
          blockedDetail: `Bash ${mutation.command} mutation target <unresolved>; Main-root Conductor may write only workflow state/ledger/mailbox/handoff metadata`,
        };
      }
      const blockedTarget = mutation.targets.find((target) => (
        !(target === ".omx/state" && mutation.command === "mkdir")
        && !isAllowedConductorMetadataPath(policyCwd, target)
      ));
      if (blockedTarget) {
        return {
          allowed: false,
          blockedDetail: `Bash ${mutation.command} mutation target ${blockedTarget} is not workflow state/ledger/mailbox/handoff metadata`,
        };
      }
    }
  }


  const editorTargets = extractConductorEditorWriteTargets(commandWithHeredocBodies);
  if (editorTargets.length > 0) {
    const blockedTarget = editorTargets.find((target) => !isAllowedConductorMetadataExecutionPath(cwd, policyCwd, target));
    if (blockedTarget) {
      return {
        allowed: false,
        blockedDetail: `Bash editor mutation target ${blockedTarget} is not workflow state/ledger/mailbox/handoff metadata`,
      };
    }
  }

  if (commandHasDestructiveGitSubcommand(normalizedCommand)) {
    return {
      allowed: false,
      blockedDetail: "Bash git worktree mutation is not workflow state/ledger/mailbox/handoff metadata",
    };
  }
  if (commandHasPackageInstallIntent(normalizedCommand)) {
    return {
      allowed: false,
      blockedDetail: "Bash package manager install is not workflow state/ledger/mailbox/handoff metadata",
    };
  }

  const interpreterWrites = extractConductorInterpreterWrites(commandWithHeredocBodies);
  for (const write of interpreterWrites) {
    if (write.unresolved || write.targets.length === 0) {
      return {
        allowed: false,
        blockedDetail: `Bash ${write.runtime} write target <unresolved>; Main-root Conductor may write only workflow state/ledger/mailbox/handoff metadata`,
      };
    }
    const blockedTarget = write.targets.find((target) => !isAllowedConductorMetadataExecutionPath(cwd, policyCwd, target));
    if (blockedTarget) {
      return {
        allowed: false,
        blockedDetail: `Bash ${write.runtime} write target ${blockedTarget} is not workflow state/ledger/mailbox/handoff metadata`,
      };
    }
  }
  const runtimeBlockedDetail = classifyConductorExecutableRuntime(commandWithHeredocBodies, 0, cwd);
  if (runtimeBlockedDetail) return { allowed: false, blockedDetail: runtimeBlockedDetail };

  const hasGenericWriteIntent = commandHasDeepInterviewWriteIntent(commandWithHeredocBodies, 0, cwd);
  if (!hasGenericWriteIntent) return { allowed: true };
  const targets = extractDeepInterviewCommandWriteTargets(commandWithHeredocBodies, cwd, policyCwd);
  const nestedTargetAliases = collectStaticNestedShellTargetAliases(cwd, commandWithHeredocBodies);
  const accountedShellOnlyWriteIntent = shellMutations.length > 0
    && targets.length === 0
    && shellMutations.every((mutation) => (
      mutation.mainRootStructuredStateWrite === true
      || mutation.mainRootStructuredOrchestrationMutation === true
      || mutation.command === "sed"
      || mutation.command === "perl"
    ));
  if (
    hasGenericWriteIntent
    && targets.length === 0
    && shellMutations.length === 0
    && /\b(?:export\s+(?:-[A-Za-z]*f[A-Za-z]*|--functions?)|(?:declare|typeset)\s+-[A-Za-z]*f[A-Za-z]*)\b/.test(normalizedCommand)
  ) return { allowed: true };
  if (accountedShellOnlyWriteIntent) return { allowed: true };
  if (commandInvokesApplyPatch(normalizedCommand) && targets.length === 0) {
    return {
      allowed: false,
      blockedDetail: "apply_patch target extraction failed for Main-root Conductor write",
    };
  }
  if (targets.length === 0) {
    return {
      allowed: false,
      blockedDetail: "Bash write intent target <unresolved>; Main-root Conductor may write only workflow state/ledger/mailbox/handoff metadata",
    };
  }
  const createsMetadataDirectories = /\binstall\b/.test(normalizedCommand) && /(?:^|\s)-[^\s]*d|(?:^|\s)--directory(?:\s|$)/.test(normalizedCommand);
  const blockedTarget = targets.find((target) => {
    const isNormalizedShellTarget = shellMutations.some((mutation) => mutation.targets.includes(target));
    const matchingShellMutations = shellMutations.filter((mutation) => mutation.targets.includes(target));
    if (
      target === ".omx/state"
      && matchingShellMutations.length > 0
      && matchingShellMutations.every((mutation) => mutation.command === "mkdir")
    ) return false;
    if (isNormalizedShellTarget && isAllowedConductorMetadataPath(policyCwd, target)) return false;
    if (isAllowedConductorMetadataExecutionPath(cwd, policyCwd, target)) return false;
    if (createsMetadataDirectories && isExactConductorMetadataRoot(policyCwd, target)) return false;
    return !(nestedTargetAliases.get(target) ?? []).some((normalized) => isAllowedConductorMetadataPath(policyCwd, normalized));
  });
  if (blockedTarget) {
    const operationClass = /\btee\s+(?:-a\s+)?/.test(commandWithHeredocBodies) ? "Bash tee write" : "Bash write";
    return {
      allowed: false,
      blockedDetail: `${operationClass} target ${blockedTarget} is not workflow state/ledger/mailbox/handoff metadata`,
    };
  }
  return { allowed: true };
}


function buildConductorBashBlockedDetail(cwd: string, command: string): string {
  return evaluateConductorBashWrite(cwd, command).blockedDetail
    ?? "Bash write intent target <unresolved>; Main-root Conductor may write only workflow state/ledger/mailbox/handoff metadata";
}

function directConductorStateWritePayloadHasExactSchema(payload: CodexHookPayload, policyCwd: string, canonicalSessionId: string): boolean {
  const input = safeObject(payload.tool_input);
  if (!input || !conductorStateWritePayloadHasExactSchema(input)) return false;
  if (!canonicalSessionId) return false;
  if (safeString(input.session_id).trim() !== canonicalSessionId) return false;
  if (!suppliedSessionAliasesMatch(input, canonicalSessionId)) return false;
  let nestedState = input.state === undefined ? null : safeObject(input.state);
  while (nestedState) {
    if (!suppliedSessionAliasesMatch(nestedState, canonicalSessionId)) return false;
    const nestedSessionId = safeString(nestedState.session_id).trim();
    if (nestedSessionId && nestedSessionId !== canonicalSessionId) return false;
    const nestedWorkingDirectory = safeString(nestedState.workingDirectory).trim();
    if (nestedWorkingDirectory && resolve(nestedWorkingDirectory) !== resolve(policyCwd)) return false;
    const nestedMode = safeString(nestedState.mode).trim();
    if (nestedMode && nestedMode !== safeString(input.mode).trim()) return false;
    nestedState = nestedState.state === undefined ? null : safeObject(nestedState.state);
  }
  if (safeString(input.workingDirectory).trim() === "" || resolve(safeString(input.workingDirectory)) !== resolve(policyCwd)) return false;
  return true;
}

function conductorStatePayloadPreservesActiveGuard(
  input: Record<string, unknown> | null,
  activeState: ActiveConductorState,
): boolean {
  if (!input || input.active !== true) return false;
  if (safeString(input.mode).trim() !== activeState.mode) return false;
  const phase = safeString(input.current_phase ?? input.currentPhase).trim().toLowerCase();
  return phase !== "" && isNonTerminalPhase(phase);
}


function buildConductorSessionProvenanceDeny(
  activeState: ActiveConductorState,
  detail: string,
): Record<string, unknown> {
  return {
    decision: "block",
    reason:
      `PROVENANCE_DENIED: Conductor mode is active (${activeState.mode} phase: ${formatPhase(activeState.phase, "active")}); `
      + `${detail}. Do not perform this tool call until the hook reports one canonical active-session identity.`,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        "PROVENANCE_DENIED: Conflicting, missing, or foreign payload provenance cannot establish Main-root, native-child, or Team-worker authority.",
    },
  };
}

export async function buildConductorPreToolUseWriteGuardOutput(
  payload: CodexHookPayload,
  cwd: string,
  stateDir: string,
  resolvedSessionId?: string,
  policyCwd = cwd,
): Promise<Record<string, unknown> | null> {
  const activeState = await readActiveConductorStateForPreToolUse(payload, policyCwd, stateDir, resolvedSessionId);
  if (!activeState) return null;
  const sessionId = safeString(resolvedSessionId ?? readPayloadSessionId(payload)).trim();
  const writeActor = await resolvePreToolUseWriteActor(payload, cwd, stateDir, sessionId);
  if (writeActor === "provenance-conflict") {
    return buildConductorSessionProvenanceDeny(activeState, "payload identity aliases conflict");
  }
  const nativeSubagentSupport = resolveNativeSubagentSupportStatus({
    payload,
    persistedSupportBlocker: await readJsonIfExists(nativeSubagentSupportBlockerPath(stateDir)),
    persistedRoleRoutingMarker: readRoleRoutingMarker(stateDir, {
      cwd,
      sessionId: resolvedSessionId || readPayloadSessionId(payload),
    }),
    persistedCapacityBlocker: await readJsonIfExists(nativeSubagentCapacityBlockerPath(stateDir)),
    cwd,
    sessionId: resolvedSessionId || readPayloadSessionId(payload),
  });


  const toolName = safeString(payload.tool_name).trim();
  const command = readPreToolUseCommand(payload);
  const pathCandidates = readPreToolUsePathCandidates(payload);
  const mutationTransport = classifyPreToolUseMutationTransport(payload, toolName, cwd);

  let blocked = false;
  let blockedDetail = "Main-root Conductor write is not delegated";
  let nativeChildMutationAttempt = false;

  if (toolName === "Bash") {
    const shellMutations = extractConductorBashMutations(command, cwd, policyCwd);
    const bashEvaluation = evaluateConductorBashWrite(cwd, command, 0, sessionId, policyCwd);
    blocked = !bashEvaluation.allowed;
    const canonicalStateCommand = canonicalizeOmxStateTransportCommand(command);
    const bashStateOperations = collectOmxStateCommandOperations(canonicalStateCommand, "write");
    if (bashStateOperations.length > 0) {
      const bashStatePayload = readStateWriteInputPayload(policyCwd, canonicalStateCommand, command);
      if (
        !isStandaloneParsedOmxStateWriteTransport(policyCwd, command, sessionId)
        || !conductorStatePayloadPreservesActiveGuard(bashStatePayload, activeState)
      ) {
        blocked = true;
        blockedDetail = "Bash state writes must preserve the canonical active Conductor guard";
      }
    }
    const safeExportedFunctionRead = !blocked
      && shellMutations.length === 0
      && /\b(?:export\s+(?:-[A-Za-z]*f[A-Za-z]*|--functions?)|(?:declare|typeset)\s+-[A-Za-z]*f[A-Za-z]*)\b/.test(command);
    nativeChildMutationAttempt = (mutationTransport === "bash" || shellMutations.length > 0)
      && !safeExportedFunctionRead;
    if (blocked) blockedDetail = bashEvaluation.blockedDetail ?? buildConductorBashBlockedDetail(cwd, command);
  } else if (mutationTransport === "state") {
    nativeChildMutationAttempt = true;
    const directStateInput = safeObject(payload.tool_input);
    if (toolName === "mcp__omx_state__state_clear") {
      blocked = true;
      blockedDetail = "Structured state_clear is not authorized while a Conductor workflow is active";
    } else if (
      toolName === "mcp__omx_state__state_write"
      && (
        !directConductorStateWritePayloadHasExactSchema(payload, policyCwd, sessionId)
        || !conductorStatePayloadPreservesActiveGuard(directStateInput, activeState)
      )
    ) {
      blocked = true;
      blockedDetail = "Structured state writes must preserve the canonical active Conductor guard";
    }
  } else if (mutationTransport === "orchestration") {
    nativeChildMutationAttempt = true;
  } else if (mutationTransport === "path") {
    nativeChildMutationAttempt = true;
    const toolPathCandidates = collectImplementationToolPathCandidates(payload, toolName, pathCandidates);
    if (toolPathCandidates.length === 0) {
      blocked = true;
      blockedDetail = describeConductorBlockedWrite(toolName, undefined, toolPathCandidates.length);
    } else {
      const blockedPath = toolPathCandidates.find((candidate) => !isAllowedConductorMetadataExecutionPath(cwd, policyCwd, candidate));
      blocked = blockedPath !== undefined;
      if (blockedPath !== undefined) {
        blockedDetail = describeConductorBlockedWrite(toolName, blockedPath, toolPathCandidates.length);
      }
    }
  } else if (mutationTransport === "unknown") {
    nativeChildMutationAttempt = true;
    blocked = true;
    blockedDetail = `${toolName || "unknown tool"} is not a recognized read-only or explicitly authorized Conductor mutation transport`;
  }

  const teamWorkerProtectedStateTarget = teamWorkerMutationTargetsProtectedWorkflowState(
    payload,
    toolName,
    command,
    cwd,
    stateDir,
    policyCwd,
  );
  if (writeActor === "team-worker" && !teamWorkerProtectedStateTarget) return null;
  if (writeActor === "team-worker" && teamWorkerProtectedStateTarget && !blocked) {
    blocked = true;
    blockedDetail = "Bash targets protected workflow state outside authorized Team-worker scope";
  }
  if (!blocked && (writeActor !== "native-child" || !nativeChildMutationAttempt)) return null;
  if (!blocked && nativeChildMutationAttempt && writeActor === "native-child") {
    blockedDetail = toolName === "Bash"
      ? "Bash mutation is not authorized by native-child provenance"
      : `${toolName} mutation is not authorized by native-child provenance`;
  }
  if (writeActor === "native-child") {
    return {
      decision: "block",
      reason:
        `OWNER_CONFIRMATION_REQUIRED: Conductor mode is active (${activeState.mode} phase: ${formatPhase(activeState.phase, "active")}); `
        + `native child/descendant provenance establishes same-session origin, not assigned write authority; ${blockedDetail}.`,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          "OWNER_CONFIRMATION_REQUIRED: Native child/descendant provenance establishes only session membership, not assigned write authority. "
          + "Do not perform source, package, git, or other substantive writes; return control to the owning Conductor for explicit confirmation.",
      },
    };
  }

  const unsupportedNativeGuidance = isUnsupportedNativeSubagentEvidence(nativeSubagentSupport)
    ? ` ${buildUnsupportedNativeSubagentGuidance(nativeSubagentSupport)} Treat the active conductor workflow as blocked/cancelled for native delegation recovery; do not call multi_agent_v1.close_agent.`
    : "";
  const roleRoutingUnavailableGuidance = isRoleRoutingUnavailableEvidence(nativeSubagentSupport)
    ? ` ${buildRoleRoutingUnavailableGuidance(nativeSubagentSupport)}`
    : "";
  return {
    decision: "block",
    reason: `Main-root Conductor mode is active (${activeState.mode} phase: ${formatPhase(activeState.phase, "active")}); direct plan/code writes are blocked and must be delegated; ${blockedDetail}.`,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        `${LEADER_CONDUCTOR_GOLDEN_RULE} `
        + "Use specialized agents for source edits and plan/spec authorship. "
        + `Main-root Conductor may write only orchestration metadata/transport/ledger artifacts under ${CONDUCTOR_ORCHESTRATION_METADATA_PREFIXES.join(", ")}; path location alone is not authorization for substantive deliverables. `
        + unsupportedNativeGuidance
        + roleRoutingUnavailableGuidance
        + " Autopilot rework and typed subagent/worker lanes are exempt from this guard.",
    },
  };

}
function isInPlaceEditorCommand(word: string, commandName: string): boolean {
  if (commandName === "sed") return word === "--in-place" || /^--in-place(?:=.+)?$/.test(word) || /^-[^-\s]*i(?:.*)?$/.test(word);
  if (commandName === "perl") return word === "-i" || word === "-pi" || /^-pi(?:\..+)?$/.test(word) || /^-p.*i(?:\..+)?$/.test(word);
  return false;
}

function collectInPlaceEditorWriteTargets(commandName: "sed" | "perl", words: string[], commandIndex: number): string[] {
  const targets: string[] = [];
  let sawInPlaceEdit = false;
  let awaitingOptionValue = false;
  let consumedImplicitSedScript = commandName !== "sed";

  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word || isShellCommandSeparator(word)) break;
    if (CONDUCTOR_BASH_COMPOUND_SYNTAX_WORDS.has(word)) continue;
    if (isEnvironmentAssignmentWord(word)) continue;

    if (awaitingOptionValue) {
      awaitingOptionValue = false;
      continue;
    }

    if (word === "--") {
      consumedImplicitSedScript = true;
      continue;
    }
    if (word === "-e" || word === "-f" || word === "--expression" || word === "--file") {
      awaitingOptionValue = true;
      consumedImplicitSedScript = true;
      continue;
    }
    if (word.startsWith("-e") || word.startsWith("-f") || word.startsWith("--expression=") || word.startsWith("--file=")) {
      consumedImplicitSedScript = true;
      continue;
    }
    if (isInPlaceEditorCommand(word, commandName)) {
      sawInPlaceEdit = true;
      continue;
    }
    if (word.startsWith("-")) continue;
    if (sawInPlaceEdit) {
      if (commandName === "sed" && !consumedImplicitSedScript) {
        consumedImplicitSedScript = true;
        continue;
      }
      targets.push(word);
    }
  }

  return targets;
}

function extractConductorEditorWriteTargets(command: string): string[] {
  const targets: string[] = [];
  for (const segment of splitShellCommandSegments(stripHeredocBodiesForCommandScan(command))) {
    const words = tokenizeShellWords(segment);
    let commandStart = true;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index] ?? "";
      if (!word) continue;
      if (isShellCommandSeparator(word)) {
        commandStart = true;
        continue;
      }
      if (isShellGroupingSyntaxWord(word)) continue;
      if (commandStart && isEnvironmentAssignmentWord(word)) continue;
      if (commandStart && CONDUCTOR_BASH_COMPOUND_SYNTAX_WORDS.has(word)) continue;
      if (commandStart && word.startsWith("-")) continue;
      if (!commandStart) continue;

      const commandName = commandNameFromShellWord(word);
      if (commandName === "sed" || commandName === "perl") {
        targets.push(...collectInPlaceEditorWriteTargets(commandName, words, index));
      }
      commandStart = false;
    }
  }
  return targets;
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

async function clearNativeStopSessionEntries(
  stateDir: string,
  payload: CodexHookPayload,
  canonicalSessionId?: string,
): Promise<void> {
  const statePath = join(stateDir, NATIVE_STOP_STATE_FILE);
  const state = await readJsonIfExists(statePath);
  if (!state) return;

  const sessions = safeObject(state.sessions);
  const keys = new Set(uniqueNonEmpty([
    readNativeStopSessionKey(payload, canonicalSessionId),
    canonicalSessionId,
    readPayloadSessionId(payload),
    readPayloadThreadId(payload),
  ]));
  let changed = false;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(sessions, key)) {
      delete sessions[key];
      changed = true;
    }
  }
  if (!changed) return;

  await writeFile(statePath, JSON.stringify({ ...state, sessions }, null, 2));
}

async function hasAuthoritativeInactiveSkillStopState(
  cwd: string,
  stateDir: string,
  skill: string,
  sessionId: string,
  threadId: string,
): Promise<boolean> {
  const sessionModeState = await readStopSessionPinnedState(`${skill}-state.json`, cwd, sessionId, stateDir);
  if (!sessionModeState || !isTerminalOrInactiveModeState(sessionModeState)) return false;

  const canonicalState = await readVisibleSkillActiveStateForStateDir(stateDir, sessionId);
  if (canonicalState && !rootSkillStateHasNoActiveSkillForStopContext(canonicalState, skill, sessionId, threadId)) {
    return false;
  }

  const rootModeState = await readJsonIfExists(join(stateDir, `${skill}-state.json`));
  if (!rootModeState) return true;
  if (!modeStateMatchesSkillStopContext(rootModeState, cwd, sessionId)) return true;
  return isTerminalOrInactiveModeState(rootModeState);
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
  options: { skipAutoNudge?: boolean; skipRalphStopBlock?: boolean; canonicalSessionId?: string } = {},
): Promise<Record<string, unknown> | null> {
  if (isStopExempt(payload)) {
    return null;
  }

  const sessionId = readPayloadSessionId(payload);
  const canonicalSessionId = options.canonicalSessionId
    ?? await resolveInternalSessionIdForPayload(cwd, sessionId);
  const threadId = readPayloadThreadId(payload);
  const suppressParentWorkflowStop = shouldSuppressParentWorkflowStopForSideConversation(payload);
  if (canonicalSessionId) {
    await reconcileStaleRootSkillActiveStateForStop(cwd, stateDir, canonicalSessionId);
    if (await hasAuthoritativeInactiveSkillStopState(cwd, stateDir, "ralplan", canonicalSessionId, threadId)) {
      await clearNativeStopSessionEntries(stateDir, payload, canonicalSessionId);
    }
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
    : await readActiveRalphState(cwd, stateDir, sessionId || canonicalSessionId, ralphOwnerContext);
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
      options.skipAutoNudge !== true
      && autoNudgeConfig.enabled
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
          { systemMessage: documentRefreshWarning.message },
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

async function preflightNativePromptTarget(
  stateDir: string,
  context: ResolvedPromptTurnContext,
): Promise<ResolvedPromptTurnContext> {
  if (context.status !== "authorized") return context;
  const targetDir = join(stateDir, "sessions", context.authorization.targetSessionId);
  const evidence: Array<{ ownerCodexSessionId?: unknown; targetSessionId?: unknown }> = [];
  let filenames: string[];
  try {
    filenames = await readdir(targetDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return context;
    return preflightSelectedTargetOwner(context, [{ ownerCodexSessionId: {} }], "native", new Date().toISOString());
  }
  for (const filename of filenames) {
    if (!filename.endsWith("-state.json") && filename !== SKILL_ACTIVE_STATE_FILE) continue;
    try {
      const value = JSON.parse(await readFile(join(targetDir, filename), "utf8")) as unknown;
      evidence.push(...extractSelectedTargetOwnerEvidence(value));
    } catch {
      evidence.push({ ownerCodexSessionId: {} });
    }
  }
  return preflightSelectedTargetOwner(context, evidence, "native", new Date().toISOString());
}

export async function dispatchCodexNativeHook(
  payload: CodexHookPayload,
  options: NativeHookDispatchOptions = {},
): Promise<NativeHookDispatchResult> {
  const hookEventName = readHookEventName(payload);
  const cwd = options.cwd ?? (safeString(payload.cwd).trim() || process.cwd());
  if (hookEventName === "PreToolUse" && safeString(payload.tool_name).trim() === "Bash") {
    const denial = evaluateCodex01445PreToolUse(payload, {
      resolveInstalledRoleName: (role) => resolveInstalledRoleName(role, undefined, cwd),
    });
    if (denial) {
      return {
        hookEventName,
        omxEventName: mapCodexHookEventToOmxEvent(hookEventName),
        skillState: null,
        outputJson: denial,
      };
    }
  }
  if (hookEventName === "PostCompact" && process.env.OMX_NATIVE_HOOK_DOCTOR_SMOKE === "1") {
    return {
      hookEventName,
      omxEventName: mapCodexHookEventToOmxEvent(hookEventName),
      skillState: null,
      outputJson: null,
    };
  }
  if (hookEventName === "Stop" && !hasNativeStopRuntimeSurface(cwd)) {
    return {
      hookEventName,
      omxEventName: mapCodexHookEventToOmxEvent(hookEventName),
      skillState: null,
      outputJson: null,
    };
  }
  // Native hooks must use the exact pointer root selected for this dispatch.
  const pointerContext = resolveSessionPointerContext(cwd);
  const stateDir = pointerContext.baseStateDir;
  const policyRoot = resolveConductorPolicyRoot(stateDir, cwd);
  const policyCwd = policyRoot.cwd;

  const omxEventName = mapCodexHookEventToOmxEvent(hookEventName);
  let skillState: SkillActiveState | null = null;
  let triageAdditionalContext: string | null = null;
  let goalWorkflowAdditionalContext: string | null = null;
  let ultragoalSteeringAdditionalContext: string | null = null;
  let promptClassification: KeywordInputClassification | null = null;

  const nativeSessionId = safeString(payload.session_id ?? payload.sessionId).trim();
  const threadId = safeString(payload.thread_id ?? payload.threadId).trim();
  const turnId = safeString(payload.turn_id ?? payload.turnId).trim();
  const pointer = await readSessionPointer(pointerContext);
  const currentSessionState = pointer.status === "usable" ? pointer.state ?? null : null;
  let promptTurnContext: ResolvedPromptTurnContext | null = hookEventName === "UserPromptSubmit"
    ? evaluateResolvedPromptTurn({
      producer: "native",
      payloadSessionId: payload.session_id ?? payload.sessionId,
      ownerEnvSessionId: undefined,
      selectedPointer: pointer,
      threadFacts: await readNativePromptThreadFacts(cwd, nativeSessionId, threadId, currentSessionState),
      nowIso: new Date().toISOString(),
    })
    : null;
  if (promptTurnContext) {
    promptTurnContext = await preflightNativePromptTarget(stateDir, promptTurnContext);
  }
  if (promptTurnContext?.status === "rejected") {
    await appendPromptSessionProvenanceRejection(pointerContext, promptTurnContext.diagnostic).catch(() => {});
    return { hookEventName, omxEventName, skillState: null, outputJson: null };
  }
  if (promptTurnContext?.status === "suppressed-target-child") {
    return { hookEventName, omxEventName, skillState: null, outputJson: null };
  }
  if (hookEventName !== "Stop") {
    await mkdir(stateDir, { recursive: true });
  }
  let allowImplicitSessionSideEffects = pointer.status === "usable" || pointer.status === "absent" || promptTurnContext?.status === "authorized";
  let stopAuthorizationFailure: { stopReason: string; reason: string } | null = allowImplicitSessionSideEffects
    ? null
    : {
      stopReason: "session_pointer_unusable",
      reason: `OMX cannot authorize Stop while the selected session pointer is ${pointer.status}; repair the pointer evidence before continuing.`,
    };
  let canonicalSessionId = safeString(currentSessionState?.session_id).trim();
  if (promptTurnContext?.status === "authorized") {
    canonicalSessionId = promptTurnContext.authorization.targetSessionId;
  }
  const allowPromptGlobalSideEffects = promptTurnContext?.status !== "authorized"
    || promptTurnContext.authorization.globalSideEffects === "allow";
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
      const ownerOmxSessionId = await resolveVerifiedOwnerOmxSessionId();
      try {
        const sessionState = await reconcileNativeSessionStart(cwd, nativeSessionId, {
          context: pointerContext,
          pid: options.sessionOwnerPid ?? resolveSessionOwnerPid(payload),
          ...options.sessionStartOptions,
          ...(ownerOmxSessionId
            ? { ownerOmxSessionId, ownerAliasVerified: true }
            : {}),
        });
        canonicalSessionId = safeString(sessionState.session_id).trim();
        resolvedNativeSessionId = safeString(sessionState.native_session_id).trim() || nativeSessionId;
        allowImplicitSessionSideEffects = true;
        stopAuthorizationFailure = null;
        // #3181: leader attestation is intentionally NOT performed here. This branch is
        // reached whenever readNativeSubagentSessionStartMetadata() returns null, which
        // conflates a genuine root start with an unreadable/malformed child transcript, so
        // it cannot positively classify a leader (a legitimate leader may also carry no
        // transcript). Leader attestation is performed only on the strictly-gated fresh
        // leader PreToolUse path below, which fires before the first in-turn role-intent
        // write. Fail closed here rather than risk a false-leader adoption.
      } catch (error) {
        if (!isSessionPointerLaunchAbort(error)) throw error;
        canonicalSessionId = "";
        resolvedNativeSessionId = nativeSessionId;
        skipCanonicalSessionStartContext = true;
        allowImplicitSessionSideEffects = false;
        stopAuthorizationFailure = {
          stopReason: "session_pointer_unusable",
          reason: `OMX cannot authorize Stop while the selected session pointer is ${pointer.status}; repair the pointer evidence before continuing.`,
        };
      }
    }
  } else if (!canonicalSessionId) {
    canonicalSessionId = safeString(currentSessionState?.session_id).trim();
  }

  if (hookEventName === "Stop") {
    const stopPayloadSessionId = readPayloadSessionId(payload);
    const stopCanonicalSessionId = await resolveInternalSessionIdForPayload(
      cwd,
      stopPayloadSessionId,
      undefined,
      currentSessionState,
      pointer.status === "absent",
    );
    if (stopPayloadSessionId && !stopCanonicalSessionId) {
      canonicalSessionId = "";
      allowImplicitSessionSideEffects = false;
      if (!stopAuthorizationFailure) {
        stopAuthorizationFailure = {
          stopReason: "session_scope_unmatched",
          reason: `OMX cannot authorize Stop for unmatched session id ${stopPayloadSessionId}; the selected session pointer remains authoritative.`,
        };
      }
    } else if (stopCanonicalSessionId) {
      canonicalSessionId = stopCanonicalSessionId;
    }
    if (canonicalSessionId && safeString(currentSessionState?.session_id).trim() === canonicalSessionId) {
      resolvedNativeSessionId =
        safeString(currentSessionState?.native_session_id).trim() || resolvedNativeSessionId;
    }
  }

  let eventSessionId = canonicalSessionId || nativeSessionId || undefined;
  let sessionIdForState: string | null = canonicalSessionId || null;
  let outputJson: Record<string, unknown> | null = null;
  const typedAgentRolePayload = isTypedAgentRolePayload(payload, cwd);
  const isSubagentPromptSubmit = hookEventName === "UserPromptSubmit"
    ? typedAgentRolePayload || await isNativeSubagentHook(
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
  if (isSubagentStop && stopAuthorizationFailure?.stopReason === "session_scope_unmatched") {
    canonicalSessionId = normalizeSessionId(readPayloadSessionId(payload)) ?? "";
    allowImplicitSessionSideEffects = true;
    stopAuthorizationFailure = null;
    eventSessionId = canonicalSessionId || nativeSessionId || undefined;
    sessionIdForState = canonicalSessionId || null;
  }
  const suppressNoisySubagentLifecycleDispatch =
    (isSubagentSessionStart || isSubagentStop)
    && shouldSuppressSubagentLifecycleHookDispatch();

  if (hookEventName === "UserPromptSubmit") {
    const prompt = readPromptText(payload);
    if (!isSubagentPromptSubmit) {
      promptClassification = classifyKeywordInput(prompt);
    }
    goalWorkflowAdditionalContext = allowPromptGlobalSideEffects
      ? await buildCompletedGoalCleanupPromptWarning(cwd, prompt).catch(() => null)
        ?? await buildGoalWorkflowReconciliationPromptWarning(cwd, prompt).catch(() => null)
      : null;
    ultragoalSteeringAdditionalContext = prompt && !isSubagentPromptSubmit && allowImplicitSessionSideEffects && allowPromptGlobalSideEffects
      ? await applyUserPromptUltragoalSteering(cwd, prompt).catch((error) => `OMX native UserPromptSubmit rejected bounded .omx/ultragoal steering for G002-cli-and-prompt-submit-bridge: ${error instanceof Error ? error.message : String(error)}`)
      : null;
    let suppressActivationSeeding = !allowImplicitSessionSideEffects;
    if (promptTurnContext?.status === "authorized") {
      sessionIdForState = promptTurnContext.authorization.targetSessionId;
    } else if (prompt && !isSubagentPromptSubmit && allowImplicitSessionSideEffects) {
      const rawHookSessionId = canonicalSessionId || nativeSessionId;
      const normalizedHookSessionId = normalizeSessionId(rawHookSessionId);
      const explicitHookSessionId = currentSessionState ? undefined : normalizedHookSessionId;
      if (rawHookSessionId && !normalizedHookSessionId) {
        suppressActivationSeeding = true;
      } else {
        try {
          const writableScope = await resolveWritableStateScope(cwd, explicitHookSessionId);
          sessionIdForState = writableScope.sessionId ?? null;
        } catch (error) {
          if (!isImplicitWritableScopeFailure(error)) throw error;
          suppressActivationSeeding = true;
        }
      }
    }
    if (prompt && promptClassification && !isSubagentPromptSubmit && !suppressActivationSeeding) {
      skillState = buildNativeOutsideTmuxTeamPromptBlockState(
        promptClassification,
        cwd,
        payload,
        sessionIdForState || undefined,
        threadId || undefined,
        turnId || undefined,
      ) ?? await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: prompt,
        classification: promptClassification,
        allowSecondaryTeam: !isNativeOutsideTmuxUserPrompt(cwd, payload, sessionIdForState || undefined),
        sessionId: sessionIdForState || undefined,
        threadId,
        turnId,
        resolvedPromptTurnContext: promptTurnContext ?? undefined,
        onProvenanceRejected: async (diagnostic) => {
          await appendPromptSessionProvenanceRejection(pointerContext, diagnostic).catch(() => {});
        },
      });
    }
    // --- Triage classifier (advisory-only, non-keyword prompts) ---
    if (
      prompt
      && skillState === null
      && !isSubagentPromptSubmit
      && allowPromptGlobalSideEffects
      && promptClassification?.reservedInput === null
      && promptClassification.hasExplicitLikeInvocation === false
      && promptClassification.matches.length === 0
    ) {
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
              if (!suppressActivationSeeding) {
                writeTriageState({ cwd, sessionId: sessionIdForState || null, state: newState });
              }
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
                if (!suppressActivationSeeding) {
                  writeTriageState({ cwd, sessionId: sessionIdForState || null, state: newState });
                }
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
    if (allowImplicitSessionSideEffects && allowPromptGlobalSideEffects && !skipHudReconcileForDoctorSmoke && !skipHudReconcileForTeamWorkerPane) {
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

  if (omxEventName && allowImplicitSessionSideEffects && allowPromptGlobalSideEffects && !skipCanonicalSessionStartContext && !suppressNoisySubagentLifecycleDispatch) {
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
        : promptClassification
          ? [
            buildAdditionalContextMessage(promptClassification, skillState, cwd, payload),
            ultragoalSteeringAdditionalContext,
            goalWorkflowAdditionalContext,
            triageAdditionalContext,
          ].filter((entry): entry is string => Boolean(entry)).join("\n\n") || null
          : null;
    if (additionalContext) {
      outputJson = {
        hookSpecificOutput: {
          hookEventName,
          additionalContext,
        },
      };
    }
  } else if (hookEventName === "PreToolUse") {
    const identitylessTeamWorkerContext = !readPayloadAgentId(payload)
      && !safeString(payload.agentId).trim()
      && !safeString(payload.threadId).trim()
      && !readPayloadThreadId(payload)
      && !payloadHasOwnerIdentityClaim(payload)
      && !hasSubagentThreadSpawnProvenance(payload)
      && await hasAuthoritativeTeamWorkerContext(cwd);
    const sessionBinding = await resolvePreToolUseSessionBinding(
      policyCwd,
      stateDir,
      payload,
      identitylessTeamWorkerContext,
    );
    const payloadSessionId = readPayloadSessionId(payload);
    const rootPointerConflict = await readLiveRootSessionPointerConflict(stateDir, payloadSessionId);
    const mutationTransport = classifyPreToolUseMutationTransport(
      payload,
      safeString(payload.tool_name).trim(),
      policyCwd,
    );
    const rootSessionPointer = await readRootSessionStateFromStateDir(stateDir);
    const rootSessionId = safeString(rootSessionPointer?.session_id).trim();
    const payloadPolicyCwd = rootSessionId !== "" && rootSessionId !== payloadSessionId
      ? cwd
      : policyCwd;
    const foreignRootNativeChildDeny = !sessionBinding.valid
      && payloadSessionId
      && rootSessionId !== ""
      && rootSessionId !== payloadSessionId
      && mutationTransport !== "read-only"
      ? await buildConductorPreToolUseWriteGuardOutput(
        payload,
        cwd,
        stateDir,
        payloadSessionId,
        payloadPolicyCwd,
      )
      : null;
    if (!policyRoot.valid && policyRoot.statePresent && mutationTransport !== "read-only") {
      outputJson = buildConductorSessionProvenanceDeny(
        { mode: "conductor", phase: "active" },
        "the selected workflow state root has no usable canonical session cwd",
      );
    } else if (foreignRootNativeChildDeny) {
      outputJson = foreignRootNativeChildDeny;
    } else {
    const activeConductorState = sessionBinding.canonicalSessionId
      ? await readActiveConductorStateForPreToolUse(
        payload,
        policyCwd,
        stateDir,
        sessionBinding.canonicalSessionId,
      )
      : null;
    const canonicalPlanningState = sessionBinding.canonicalSessionId
      ? await readActiveDeepInterviewStateForPreToolUse(
        policyCwd,
        stateDir,
        sessionBinding.canonicalSessionId,
        "",
      ) ?? await readActiveRalplanStateForPreToolUse(
        policyCwd,
        stateDir,
        sessionBinding.canonicalSessionId,
        "",
      )
      : null;
    const canonicalPlanningGuard: ActiveConductorState | null = canonicalPlanningState
      ? {
        mode: safeString(canonicalPlanningState.mode).trim().toLowerCase() || "planning",
        phase: safeString(
          canonicalPlanningState.current_phase ?? canonicalPlanningState.currentPhase,
        ).trim() || "active",
      }
      : null;
    const payloadScopedConductorState = !sessionBinding.valid
      && payloadSessionId
      && policyRoot.externalStateRoot
      ? await readActiveConductorStateForPreToolUse(
        payload,
        payloadPolicyCwd,
        stateDir,
        payloadSessionId,
      )
      : null;
    const payloadScopedPlanningState = !sessionBinding.valid
      && payloadSessionId
      && policyRoot.externalStateRoot
      ? await readActiveDeepInterviewStateForPreToolUse(
        payloadPolicyCwd,
        stateDir,
        payloadSessionId,
        "",
      ) ?? await readActiveRalplanStateForPreToolUse(
        payloadPolicyCwd,
        stateDir,
        payloadSessionId,
        "",
      )
      : null;
    const payloadScopedPlanningGuard: ActiveConductorState | null = payloadScopedPlanningState
      ? {
        mode: safeString(payloadScopedPlanningState.mode).trim().toLowerCase() || "planning",
        phase: safeString(
          payloadScopedPlanningState.current_phase ?? payloadScopedPlanningState.currentPhase,
        ).trim() || "active",
      }
      : null;
    const guardedConductorState = activeConductorState
      ?? payloadScopedConductorState
      ?? payloadScopedPlanningGuard
      ?? canonicalPlanningGuard;
    const preservesIdentitylessTeamWorkerExemption = sessionBinding.missing
      && !payloadHasConflictingIdentityAliases(payload)
      && identitylessTeamWorkerContext;

    if (
      guardedConductorState
      && !sessionBinding.valid
      && mutationTransport !== "read-only"
      && (!preservesIdentitylessTeamWorkerExemption || canonicalPlanningGuard !== null)
    ) {
      const hasExplicitNativeIdentity = Boolean(
        readPayloadAgentId(payload)
        || readPayloadThreadId(payload)
        || payloadHasOwnerIdentityClaim(payload)
      );
      const nativeChildDeny = hasExplicitNativeIdentity
        && !payloadHasConflictingIdentityAliases(payload)
        ? await buildConductorPreToolUseWriteGuardOutput(
          payload,
          cwd,
          stateDir,
          payloadSessionId,
          policyCwd,
        )
        : null;
      outputJson = buildNativeUnknownRolePreToolUseOutput(payload, policyCwd)
        ?? nativeChildDeny
        ?? buildConductorSessionProvenanceDeny(
          guardedConductorState,
          payloadHasConflictingIdentityAliases(payload)
            ? "payload identity aliases conflict"
            : sessionBinding.missing
              ? "payload omits the active session identity"
              : "payload session identity is foreign or cannot be mapped to the active session",
        );
    } else {
      const preToolUseSessionId = sessionBinding.valid || preservesIdentitylessTeamWorkerExemption
        ? sessionBinding.canonicalSessionId
        : "";
      outputJson = buildNativeUnknownRolePreToolUseOutput(payload, policyCwd)
        ?? await buildDeepInterviewPreToolUseBoundaryOutput(
          payload,
          policyCwd,
          stateDir,
          preToolUseSessionId,
          cwd,
        )
        ?? await buildRalplanPreToolUseBoundaryOutput(
          payload,
          policyCwd,
          stateDir,
          preToolUseSessionId,
          cwd,
        )
        ?? await buildPlanningRootPointerConflictPreToolUseOutput(
          payload,
          policyCwd,
          stateDir,
          rootPointerConflict,
        )
        ?? await buildConductorPreToolUseWriteGuardOutput(
          payload,
          cwd,
          stateDir,
          preToolUseSessionId,
          policyCwd,
        )
        ?? buildRawProtectedWorkflowStatePathOutput(payload, policyCwd, stateDir)
        ?? await buildNativeSubagentCapacityCloseGuardOutput(payload, policyCwd, stateDir)
        ?? buildMalformedPreToolUseBlockTestOutput(payload)
        ?? buildNativePreToolUseOutput(payload);
    }
    }
  } else if (hookEventName === "PostToolUse") {
    if (allowImplicitSessionSideEffects) {
      await recordNativeSubagentCapacityBlocker(cwd, stateDir, payload).catch(() => {});
      await recordNativeSubagentSupportBlocker(cwd, stateDir, payload).catch(() => {});
      if (detectMcpTransportFailure(payload)) {
        await markTeamTransportFailure(cwd, payload);
      }
      await handleTeamWorkerPostToolUseSuccess(payload, cwd);
    }
    outputJson = buildNativePostToolUseOutput(payload);
  } else if (hookEventName === "Stop") {
    if (allowImplicitSessionSideEffects) {
      outputJson = await buildStopHookOutput(payload, cwd, stateDir, {
        canonicalSessionId: canonicalSessionId || undefined,
        skipRalphStopBlock: isSubagentStop,
        skipAutoNudge: isSubagentStop,
      }) ?? await buildCompletedGoalCleanupStopOutput(payload, cwd);
    } else {
      const failure = stopAuthorizationFailure ?? {
        stopReason: "session_pointer_unusable",
        reason: "OMX cannot authorize Stop without a writable session authority.",
      };
      outputJson = {
        decision: "block",
        stopReason: failure.stopReason,
        reason: failure.reason,
        systemMessage: failure.reason,
      };
    }
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

function buildUnparseablePreToolUseDenyOutput(reason: string, systemMessage: string): Record<string, unknown> {
  return {
    systemMessage,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
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
    return buildUnparseablePreToolUseDenyOutput(reason, systemMessage);
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
    return buildUnparseablePreToolUseDenyOutput(systemMessage, systemMessage);
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
