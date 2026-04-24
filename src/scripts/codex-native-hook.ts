import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import { readModeState, readModeStateForSession, updateModeState } from "../modes/base.js";
import {
  listActiveSkills,
  readVisibleSkillActiveState,
} from "../state/skill-active.js";
import { readSubagentSessionSummary } from "../subagents/tracker.js";
import { resolveCanonicalTeamStateRoot } from "../team/state-root.js";
import {
  isSessionStateUsable,
  readSessionState,
  readUsableSessionState,
  reconcileNativeSessionStart,
} from "../hooks/session.js";
import {
  appendTeamEvent,
  readTeamLeaderAttention,
  readTeamManifestV2,
  readTeamPhase,
  writeTeamLeaderAttention,
  writeTeamPhase,
} from "../team/state.js";
import { omxNotepadPath, omxProjectMemoryPath } from "../utils/paths.js";
import { getStateFilePath, getStatePath } from "../mcp/state-paths.js";
import {
  detectKeywords,
  detectPrimaryKeyword,
  recordSkillActivation,
  type SkillActiveState,
} from "../hooks/keyword-detector.js";
import {
  detectNativeStopStallPattern,
  loadAutoNudgeConfig,
  normalizeAutoNudgeSignatureText,
  resolveEffectiveAutoNudgeResponse,
} from "./notify-hook/auto-nudge.js";
import {
  buildNativePostToolUseOutput,
  buildNativePreToolUseOutput,
  detectMcpTransportFailure,
} from "./codex-native-pre-post.js";
import {
  buildNativeHookEvent,
} from "../hooks/extensibility/events.js";
import type { HookEventEnvelope } from "../hooks/extensibility/types.js";
import { dispatchHookEvent } from "../hooks/extensibility/dispatcher.js";
import { reconcileHudForPromptSubmit } from "../hud/reconcile.js";
import { shellEscapeSingle } from "../hud/tmux.js";
import { onSessionStart as buildWikiSessionStartContext } from "../wiki/lifecycle.js";
import { readAutoresearchCompletionStatus, readAutoresearchModeState } from "../autoresearch/skill-validation.js";
import { shouldContinueRun } from "../runtime/run-loop.js";
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
import { resolveOmxCliEntryPath } from "../utils/paths.js";

type CodexHookEventName =
  | "SessionStart"
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
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

const TERMINAL_MODE_PHASES = new Set(["complete", "failed", "cancelled"]);
const SKILL_STOP_BLOCKERS = new Set(["ralplan"]);
const TEAM_TERMINAL_TASK_STATUSES = new Set(["completed", "failed"]);
const NATIVE_STOP_STATE_FILE = "native-stop-state.json";
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

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
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
    || raw === "Stop"
  ) {
    return raw;
  }
  return null;
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
  const state = await readAutoresearchModeState(cwd, normalizedSessionId);
  if (state?.active !== true) return null;
  if (!isNonTerminalPhase(state.current_phase ?? state.currentPhase ?? 'executing')) return null;
  return state;
}

async function readActiveRalphState(
  stateDir: string,
  preferredSessionId?: string,
): Promise<Record<string, unknown> | null> {
  const cwd = resolve(stateDir, "..", "..");
  const [rawSessionInfo, usableSessionInfo] = await Promise.all([
    readSessionState(cwd),
    readUsableSessionState(cwd),
  ]);
  const currentOmxSessionId = safeString(usableSessionInfo?.session_id).trim();
  const staleCurrentSessionId = rawSessionInfo && !isSessionStateUsable(rawSessionInfo, cwd)
    ? safeString(rawSessionInfo.session_id).trim()
    : "";
  const sessionCandidates = [...new Set([
    safeString(preferredSessionId).trim(),
    currentOmxSessionId,
  ].filter(Boolean))];

  // Ralph Stop stays authoritative-scope-only once the Stop payload is session-bound.
  // That is intentionally stricter than generic state MCP reads: do not scan sibling
  // session scopes or fall back to root when a current/explicit session is in play.
  for (const sessionId of sessionCandidates) {
    if (staleCurrentSessionId && sessionId === staleCurrentSessionId) {
      continue;
    }
    const sessionScoped = await readStopSessionPinnedState("ralph-state.json", cwd, sessionId);
    if (sessionScoped?.active === true && shouldContinueRun(sessionScoped)) {
      return sessionScoped;
    }
  }

  if (sessionCandidates.length > 0) return null;

  const direct = await readJsonIfExists(join(stateDir, "ralph-state.json"));
  if (direct?.active === true && shouldContinueRun(direct)) {
    return direct;
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
  if (isPathIgnoredByGit(repoRoot, ".omx/")) {
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
): Promise<string | null> {
  const sections: string[] = [];

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

  const projectMemory = await readJsonIfExists(omxProjectMemoryPath(cwd));
  if (projectMemory) {
    const directives = Array.isArray(projectMemory.directives) ? projectMemory.directives : [];
    const notes = Array.isArray(projectMemory.notes) ? projectMemory.notes : [];
    const techStack = safeString(projectMemory.techStack).trim();
    const conventions = safeString(projectMemory.conventions).trim();
    const build = safeString(projectMemory.build).trim();
    const summary: string[] = [];
    if (techStack) summary.push(`- stack: ${techStack}`);
    if (conventions) summary.push(`- conventions: ${conventions}`);
    if (build) summary.push(`- build: ${build}`);
    if (directives.length > 0) {
      const firstDirective = directives[0] as Record<string, unknown>;
      const directive = safeString(firstDirective.directive).trim();
      if (directive) summary.push(`- directive: ${directive}`);
    }
    if (notes.length > 0) {
      const firstNote = notes[0] as Record<string, unknown>;
      const note = safeString(firstNote.content).trim();
      if (note) summary.push(`- note: ${note}`);
    }
    if (summary.length > 0) {
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
  const omxBin = resolveOmxCliEntryPath({ cwd }) || process.argv[1] || "omx";
  const leaderPaneHint = resolveQuestionLeaderPaneHint(cwd, payload);
  const bridgeCommand = leaderPaneHint
    ? `OMX_QUESTION_RETURN_PANE=${shellEscapeSingle(leaderPaneHint)} ${shellEscapeSingle(process.execPath)} ${shellEscapeSingle(omxBin)} question`
    : `${shellEscapeSingle(process.execPath)} ${shellEscapeSingle(omxBin)} question`;
  const enforcementNote = leaderPaneHint
    ? ` When using Bash/background-terminal tool paths, preserve the leader pane by exporting \`OMX_QUESTION_RETURN_PANE=${leaderPaneHint}\` (or equivalent) before invoking \`omx question\`.`
    : '';
  return `Deep-interview must ask each interview round via \`omx question\`; do not fall back to \`request_user_input\` or plain-text questioning. After starting \`omx question\` in a background terminal, wait for that terminal to finish and read the JSON answer before continuing the interview. If bare \`omx question\` is unavailable in this reused session, use the current-session CLI bridge command: \`${bridgeCommand}\`.${enforcementNote} Stop remains blocked while a deep-interview question obligation is pending.`;
}

function buildAdditionalContextMessage(
  prompt: string,
  skillState?: SkillActiveState | null,
  cwd: string = process.cwd(),
  payload?: CodexHookPayload,
): string | null {
  if (!prompt) return null;
  const promptPriorityMessage = buildPromptPriorityMessage(prompt);
  const matches = detectKeywords(prompt);
  const match = detectPrimaryKeyword(prompt);
  if (!match) return promptPriorityMessage;
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
  const ultraworkPromptActivationNote = skillState?.initialized_mode === "ultrawork"
    ? "Ultrawork protocol: ground the task before editing, define pass/fail acceptance criteria, keep shared-file work local, and use direct-tool plus background evidence lanes only for truly independent work. Direct ultrawork provides lightweight verification only; Ralph owns persistence and the full verified-completion promise."
    : null;
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
      skillState.initialized_mode && skillState.initialized_state_path
        ? `skill: ${skillState.initialized_mode} activated and initial state initialized at ${skillState.initialized_state_path}; write subsequent updates via omx_state MCP.`
        : null,
      teamDetected
        ? "Use the durable OMX team runtime via `omx team ...` for coordinated execution; do not replace it with in-process fanout."
        : null,
      teamDetected ? "If you need runtime syntax, run `omx team --help` yourself." : null,
      'Follow AGENTS.md routing and preserve workflow transition and planning-safety rules.',
    ].filter(Boolean).join(' ');
  }

  if (teamDetected) {
    const initializedStateMessage = skillState?.initialized_mode && skillState.initialized_state_path
      ? `skill: ${skillState.initialized_mode} activated and initial state initialized at ${skillState.initialized_state_path}; write subsequent updates via omx_state MCP.`
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
      ultraworkPromptActivationNote,
      "Use the durable OMX team runtime via `omx team ...` for coordinated execution; do not replace it with in-process fanout.",
      "If you need runtime syntax, run `omx team --help` yourself.",
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
      `skill: ${skillState.initialized_mode} activated and initial state initialized at ${skillState.initialized_state_path}; write subsequent updates via omx_state MCP.`,
      deepInterviewPromptActivationNote,
      ultraworkPromptActivationNote,
      ralphPromptActivationNote,
      "Follow AGENTS.md routing and preserve workflow transition and planning-safety rules.",
    ].join(" ");
  }

  return [detectedKeywordMessage, promptPriorityMessage, "Follow AGENTS.md routing and preserve workflow transition and planning-safety rules."].filter(Boolean).join(" ");
}

function parseTeamWorkerEnv(rawValue: string): { teamName: string; workerName: string } | null {
  const match = /^([a-z0-9][a-z0-9-]{0,29})\/(worker-\d+)$/.exec(rawValue.trim());
  if (!match) return null;
  return {
    teamName: match[1] || "",
    workerName: match[2] || "",
  };
}

async function readTeamStateRootFromJson(path: string): Promise<string | null> {
  const parsed = await readJsonIfExists(path);
  const value = safeString(parsed?.team_state_root).trim();
  return value || null;
}

async function resolveTeamStateDirForWorkerContext(
  cwd: string,
  workerContext: { teamName: string; workerName: string },
): Promise<string> {
  const explicitStateRoot = safeString(process.env.OMX_TEAM_STATE_ROOT).trim();
  if (explicitStateRoot) {
    return resolve(cwd, explicitStateRoot);
  }

  const leaderCwd = safeString(process.env.OMX_TEAM_LEADER_CWD).trim();
  const candidateStateDirs = [
    ...(leaderCwd ? [join(resolve(leaderCwd), ".omx", "state")] : []),
    join(cwd, ".omx", "state"),
  ];

  for (const candidateStateDir of candidateStateDirs) {
    const teamRoot = join(candidateStateDir, "team", workerContext.teamName);
    if (!existsSync(teamRoot)) continue;

    const identityRoot = await readTeamStateRootFromJson(
      join(teamRoot, "workers", workerContext.workerName, "identity.json"),
    );
    if (identityRoot) return resolve(cwd, identityRoot);

    const manifestRoot = await readTeamStateRootFromJson(join(teamRoot, "manifest.v2.json"));
    if (manifestRoot) return resolve(cwd, manifestRoot);

    const configRoot = await readTeamStateRootFromJson(join(teamRoot, "config.json"));
    if (configRoot) return resolve(cwd, configRoot);

    return candidateStateDir;
  }

  return join(cwd, ".omx", "state");
}

async function buildTeamWorkerStopOutput(
  cwd: string,
): Promise<Record<string, unknown> | null> {
  const workerContext = parseTeamWorkerEnv(safeString(process.env.OMX_TEAM_WORKER));
  if (!workerContext) return null;

  const stateDir = await resolveTeamStateDirForWorkerContext(cwd, workerContext);
  const workerRoot = join(stateDir, "team", workerContext.teamName, "workers", workerContext.workerName);
  const [identity, status] = await Promise.all([
    readJsonIfExists(join(workerRoot, "identity.json")),
    readJsonIfExists(join(workerRoot, "status.json")),
  ]);

  const candidateTaskIds = new Set<string>();
  const currentTaskId = safeString(status?.current_task_id).trim();
  if (currentTaskId) candidateTaskIds.add(currentTaskId);
  const assignedTasks = Array.isArray(identity?.assigned_tasks) ? identity?.assigned_tasks : [];
  for (const taskId of assignedTasks) {
    const normalized = safeString(taskId).trim();
    if (normalized) candidateTaskIds.add(normalized);
  }

  for (const taskId of candidateTaskIds) {
    const task = await readJsonIfExists(
      join(stateDir, "team", workerContext.teamName, "tasks", `task-${taskId}.json`),
    );
    const statusValue = safeString(task?.status).trim().toLowerCase();
    if (!statusValue || TEAM_TERMINAL_TASK_STATUSES.has(statusValue)) continue;
    return {
      decision: "block",
      reason:
        `OMX team worker ${workerContext.workerName} is still assigned non-terminal task ${taskId} (${statusValue}); continue the current assigned task or report a concrete blocker before stopping.`,
      stopReason: `team_worker_${workerContext.workerName}_${taskId}_${statusValue}`,
      systemMessage:
        `OMX team worker ${workerContext.workerName} is still assigned task ${taskId} (${statusValue}).`,
    };
  }

  return null;
}

function hasTeamWorkerContext(): boolean {
  return parseTeamWorkerEnv(safeString(process.env.OMX_TEAM_WORKER)) !== null;
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

async function buildModeBasedStopOutput(
  mode: "autopilot" | "ultrawork" | "ultraqa",
  cwd: string,
  sessionId?: string,
): Promise<Record<string, unknown> | null> {
  const state = sessionId
    ? await readModeStateForSession(mode, sessionId, cwd)
    : await readModeState(mode, cwd);
  if (!state || !shouldContinueRun(state)) return null;
  const phase = formatPhase(state.current_phase);
  return {
    decision: "block",
    reason: `OMX ${mode} is still active (phase: ${phase}); continue the task and gather fresh verification evidence before stopping.`,
    stopReason: `${mode}_${phase}`,
    systemMessage: `OMX ${mode} is still active (phase: ${phase}).`,
  };
}

async function readTeamModeStateForStop(
  cwd: string,
  sessionId?: string,
): Promise<Record<string, unknown> | null> {
  const normalizedSessionId = safeString(sessionId).trim();
  if (!normalizedSessionId) {
    return await readModeState("team", cwd);
  }

  const scopedState = await readStopSessionPinnedState("team-state.json", cwd, normalizedSessionId);
  if (scopedState) return scopedState;

  const rootState = await readJsonIfExists(join(cwd, ".omx", "state", "team-state.json"));
  if (rootState?.active !== true) return null;

  const ownerSessionId = safeString(rootState.session_id).trim();
  if (ownerSessionId && ownerSessionId !== normalizedSessionId) {
    return null;
  }

  return rootState;
}

async function buildTeamStopOutput(cwd: string, sessionId?: string): Promise<Record<string, unknown> | null> {
  const teamState = await readTeamModeStateForStop(cwd, sessionId);
  if (teamState?.active !== true) return null;
  const teamName = safeString(teamState.team_name).trim();
  if (teamName) {
    const canonicalTeamDir = join(resolveCanonicalTeamStateRoot(cwd), "team", teamName);
    if (!existsSync(canonicalTeamDir)) {
      return null;
    }
  }
  const coarsePhase = teamState.current_phase;
  const canonicalPhase = teamName ? (await readTeamPhase(teamName, cwd))?.current_phase ?? coarsePhase : coarsePhase;
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
  sessionId: string,
  teamName: string,
): Promise<boolean> {
  if (!sessionId) return false;

  const markerState = await readStopSessionPinnedState("release-readiness-state.json", cwd, sessionId);
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
  return safeString(payload.thread_id ?? payload.threadId).trim();
}

function readPayloadTurnId(payload: CodexHookPayload): string {
  return safeString(payload.turn_id ?? payload.turnId).trim();
}

async function resolveInternalSessionIdForPayload(
  cwd: string,
  payloadSessionId: string,
): Promise<string> {
  const currentSession = await readUsableSessionState(cwd);
  const canonicalSessionId = safeString(currentSession?.session_id).trim();
  if (!canonicalSessionId) return payloadSessionId;

  const nativeSessionId = safeString(currentSession?.native_session_id).trim();
  if (!payloadSessionId) return canonicalSessionId;
  if (payloadSessionId === canonicalSessionId) return canonicalSessionId;
  if (nativeSessionId && payloadSessionId === nativeSessionId) return canonicalSessionId;
  return payloadSessionId;
}

async function readStopSessionPinnedState(
  fileName: string,
  cwd: string,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  const statePath = getStateFilePath(fileName, cwd, sessionId || undefined);
  return readJsonIfExists(statePath);
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

async function readBlockingSkillForStop(
  cwd: string,
  sessionId: string,
  threadId: string,
  requiredSkill?: string,
): Promise<{ skill: string; phase: string } | null> {
  const canonicalState = await readVisibleSkillActiveState(cwd, sessionId);
  const visibleEntries = canonicalState ? listActiveSkills(canonicalState) : [];
  const candidateSkills = requiredSkill
    ? [requiredSkill]
    : [...SKILL_STOP_BLOCKERS];

  for (const skill of candidateSkills) {
    const modeState = await readStopSessionPinnedState(`${skill}-state.json`, cwd, sessionId);
    if (!modeState || modeState.active !== true) continue;

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
      return { skill, phase };
    }

    const blocker = visibleEntries.find((entry) => (
      entry.skill === skill
      && matchesSkillStopContext(entry, canonicalState, sessionId, threadId)
    ));
    if (!blocker) continue;

    return {
      skill,
      phase: formatPhase(modeState.current_phase ?? blocker.phase ?? canonicalState.phase, "planning"),
    };
  }

  return null;
}

async function readStopAutoNudgePhase(
  cwd: string,
  sessionId: string,
  threadId: string,
): Promise<string> {
  const normalizedSessionId = sessionId.trim();
  if (normalizedSessionId) {
    const scopedModeState = await readStopSessionPinnedState("deep-interview-state.json", cwd, normalizedSessionId);
    if (
      scopedModeState?.active === true
      && safeString(scopedModeState.current_phase).trim().toLowerCase() === "intent-first"
    ) {
      return "planning";
    }
  } else {
    const rootModeState = await readJsonIfExists(join(cwd, ".omx", "state", "deep-interview-state.json"));
    if (
      rootModeState?.active === true
      && safeString(rootModeState.current_phase).trim().toLowerCase() === "intent-first"
    ) {
      return "planning";
    }
  }

  if (!normalizedSessionId) return "";

  const canonicalState = await readVisibleSkillActiveState(cwd, normalizedSessionId);
  const visibleEntries = canonicalState ? listActiveSkills(canonicalState) : [];
  const deepInterview = visibleEntries.find((entry) => (
    entry.skill === "deep-interview"
    && matchesSkillStopContext(entry, canonicalState ?? {}, normalizedSessionId, threadId)
  ));
  if (!deepInterview) return "";

  const modeState = await readStopSessionPinnedState("deep-interview-state.json", cwd, normalizedSessionId);
  if (!modeState || modeState.active !== true) return "";

  const modePhase = safeString(modeState.current_phase).trim().toLowerCase();
  return modePhase === "intent-first" ? "planning" : "";
}

async function buildDeepInterviewQuestionStopOutput(
  cwd: string,
  sessionId: string,
  threadId: string,
): Promise<{ output: Record<string, unknown>; obligationId: string } | null> {
  await reconcileDeepInterviewQuestionEnforcementFromAnsweredRecords(cwd, sessionId);
  const modeState = await readStopSessionPinnedState("deep-interview-state.json", cwd, sessionId);
  if (!modeState) return null;

  const questionEnforcement = safeObject(modeState.question_enforcement);
  const hasPendingQuestionObligation = isPendingDeepInterviewQuestionEnforcement(questionEnforcement);
  if (modeState.active !== true && !hasPendingQuestionObligation) return null;

  const phase = formatPhase(modeState.current_phase, "planning");
  if (TERMINAL_MODE_PHASES.has(phase.toLowerCase()) || phase === "completing") {
    return null;
  }

  const canonicalState = await readVisibleSkillActiveState(cwd, sessionId);
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
    `OMX deep-interview is still active (phase: ${phase}) and requires a structured question via omx question before stopping.`;

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
  return canonicalSessionId?.trim() || readPayloadSessionId(payload) || "";
}

function buildRepeatableStopSignature(
  payload: CodexHookPayload,
  kind: string,
  detail = "",
  canonicalSessionId?: string,
): string {
  const sessionId = resolveRepeatableStopSessionId(payload, canonicalSessionId) || "no-session";
  const threadId = readPayloadThreadId(payload) || "no-thread";
  const turnId = readPayloadTurnId(payload);
  const normalizedDetail = normalizeAutoNudgeSignatureText(detail) || safeString(detail).trim().toLowerCase();
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
  sessionId: string,
): Promise<string> {
  const directState = await readTeamModeStateForStop(cwd, sessionId);
  const directTeamName = safeString(directState?.team_name).trim();
  if (directState?.active === true && directTeamName) return directTeamName;

  const canonicalTeam = await findCanonicalActiveTeamForSession(cwd, sessionId);
  return canonicalTeam?.teamName ?? "";
}

async function maybeBuildReleaseReadinessFinalizeStopOutput(
  payload: CodexHookPayload,
  cwd: string,
  stateDir: string,
  sessionId: string,
): Promise<{ matched: boolean; output: Record<string, unknown> | null }> {
  if (!sessionId) return { matched: false, output: null };

  const teamName = await resolveActiveTeamNameForStop(cwd, sessionId);
  if (!teamName) return { matched: false, output: null };

  const explicitReleaseReadinessContext =
    hasReleaseReadinessMode(payload)
    || await hasReleaseReadinessStopMarker(cwd, sessionId, teamName);
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
  sessionId: string,
  threadId: string,
): Promise<Record<string, unknown> | null> {
  const blocker = await readBlockingSkillForStop(cwd, sessionId, threadId);
  if (!blocker) return null;

  const subagentSummary = await readSubagentSessionSummary(cwd, sessionId).catch(() => null);
  if (subagentSummary && subagentSummary.activeSubagentThreadIds.length > 0) {
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
): Promise<Record<string, unknown> | null> {
  if (isStopExempt(payload)) {
    return null;
  }

  const sessionId = readPayloadSessionId(payload);
  const canonicalSessionId = await resolveInternalSessionIdForPayload(cwd, sessionId);
  const threadId = readPayloadThreadId(payload);
  const ralphState = await readActiveRalphState(stateDir, canonicalSessionId);
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

    const teamWorkerOutput = await buildTeamWorkerStopOutput(cwd);
    if (hasTeamWorkerContext() && teamWorkerOutput) return teamWorkerOutput;

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

    const teamOutput = await buildTeamStopOutput(cwd, canonicalSessionId);
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

      const canonicalTeam = await findCanonicalActiveTeamForSession(cwd, canonicalSessionId);
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

      const skillOutput = await buildSkillStopOutput(cwd, canonicalSessionId, threadId);
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
    const autoNudgeConfig = await loadAutoNudgeConfig();
    const autoNudgePhase = await readStopAutoNudgePhase(cwd, canonicalSessionId, threadId);

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

    return null;
  }

  const currentPhase = safeString(ralphState?.current_phase).trim() || "executing";
  const stopReason = `ralph_${currentPhase}`;
  const systemMessage =
    `OMX Ralph is still active (phase: ${currentPhase}); continue the task and gather fresh verification evidence before stopping.`;

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
  const stateDir = join(cwd, ".omx", "state");
  await mkdir(stateDir, { recursive: true });

  const omxEventName = mapCodexHookEventToOmxEvent(hookEventName);
  let skillState: SkillActiveState | null = null;
  let triageAdditionalContext: string | null = null;

  const nativeSessionId = safeString(payload.session_id ?? payload.sessionId).trim();
  const threadId = safeString(payload.thread_id ?? payload.threadId).trim();
  const turnId = safeString(payload.turn_id ?? payload.turnId).trim();
  const currentSessionState = await readUsableSessionState(cwd);
  let canonicalSessionId = safeString(currentSessionState?.session_id).trim();
  let resolvedNativeSessionId = nativeSessionId;

  if (hookEventName === "SessionStart" && nativeSessionId) {
    const sessionState = await reconcileNativeSessionStart(cwd, nativeSessionId, {
      pid: options.sessionOwnerPid ?? resolveSessionOwnerPid(payload),
    });
    canonicalSessionId = safeString(sessionState.session_id).trim();
    resolvedNativeSessionId = safeString(sessionState.native_session_id).trim() || nativeSessionId;
  } else if (!canonicalSessionId) {
    canonicalSessionId = safeString(currentSessionState?.session_id).trim();
  }

  if (hookEventName === "Stop") {
    const stopCanonicalSessionId = await resolveInternalSessionIdForPayload(
      cwd,
      readPayloadSessionId(payload),
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

  if (hookEventName === "UserPromptSubmit") {
    const prompt = readPromptText(payload);
    if (prompt) {
      skillState = await recordSkillActivation({
        stateDir,
        text: prompt,
        sessionId: sessionIdForState,
        threadId,
        turnId,
      });
    }
    // --- Triage classifier (advisory-only, non-keyword prompts) ---
    if (prompt && skillState === null) {
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
              }
              if (triageAdditionalContext !== null) {
                const dest = decision.destination as "explore" | "executor" | "designer";
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
    const reconcileHudForPromptSubmitFn = options.reconcileHudForPromptSubmitFn ?? reconcileHudForPromptSubmit;
    await reconcileHudForPromptSubmitFn(cwd, { sessionId: canonicalSessionId || sessionIdForState || undefined }).catch(() => {});
  }

  if (omxEventName) {
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
    await dispatchHookEvent(event, { cwd });
  }

  if (hookEventName === "SessionStart" || hookEventName === "UserPromptSubmit") {
    const additionalContext = hookEventName === "SessionStart"
      ? await buildSessionStartContext(cwd, canonicalSessionId || nativeSessionId)
      : (buildAdditionalContextMessage(readPromptText(payload), skillState, cwd, payload) ?? triageAdditionalContext);
    if (additionalContext) {
      outputJson = {
        hookSpecificOutput: {
          hookEventName,
          additionalContext,
        },
      };
    }
  } else if (hookEventName === "PreToolUse") {
    outputJson = buildNativePreToolUseOutput(payload);
  } else if (hookEventName === "PostToolUse") {
    if (detectMcpTransportFailure(payload)) {
      await markTeamTransportFailure(cwd, payload);
    }
    outputJson = buildNativePostToolUseOutput(payload);
  } else if (hookEventName === "Stop") {
    outputJson = await buildStopHookOutput(payload, cwd, stateDir);
  }

  return {
    hookEventName,
    omxEventName,
    skillState,
    outputJson,
  };
}

interface NativeHookCliReadResult {
  payload: CodexHookPayload;
  parseError: Error | null;
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
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) {
    return { payload: {}, parseError: null };
  }

  try {
    return {
      payload: safeObject(JSON.parse(raw)),
      parseError: null,
    };
  } catch (error) {
    return {
      payload: {},
      parseError: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export async function runCodexNativeHookCli(): Promise<void> {
  const { payload, parseError } = await readStdinJson();
  if (parseError) {
    process.stdout.write(`${JSON.stringify({
      decision: "block",
      reason: "OMX native hook received malformed JSON input. Preserve runtime state, inspect the emitting hook payload yourself, and retry with valid JSON.",
      hookSpecificOutput: {
        hookEventName: "Unknown",
        additionalContext:
          `stdin JSON parsing failed inside codex-native-hook: ${parseError.message}. Emit valid JSON from the native hook caller before retrying.`,
      },
    })}\n`);
    return;
  }

  const result = await dispatchCodexNativeHook(payload);
  if (result.outputJson) {
    process.stdout.write(`${JSON.stringify(result.outputJson)}\n`);
  }
}

if (isCodexNativeHookMainModule(import.meta.url, process.argv[1])) {
  runCodexNativeHookCli().catch((error) => {
    process.stderr.write(
      `[omx] codex-native-hook failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
