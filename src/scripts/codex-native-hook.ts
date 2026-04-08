import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import { join } from "path";
import { readModeState } from "../modes/base.js";
import { getReadScopedStateDirs } from "../mcp/state-paths.js";
import { readSubagentSessionSummary } from "../subagents/tracker.js";
import { resolveCanonicalTeamStateRoot } from "../team/state-root.js";
import { readTeamManifestV2, readTeamPhase } from "../team/state.js";
import { omxNotepadPath, omxProjectMemoryPath } from "../utils/paths.js";
import {
  detectPrimaryKeyword,
  recordSkillActivation,
  type SkillActiveState,
} from "../hooks/keyword-detector.js";
import {
  detectStallPattern,
  isDeepInterviewStateActive,
  loadAutoNudgeConfig,
} from "./notify-hook/auto-nudge.js";
import {
  buildNativePostToolUseOutput,
  buildNativePreToolUseOutput,
} from "./codex-native-pre-post.js";
import {
  buildNativeHookEvent,
} from "../hooks/extensibility/events.js";
import type { HookEventEnvelope } from "../hooks/extensibility/types.js";
import { dispatchHookEvent } from "../hooks/extensibility/dispatcher.js";
import { writeSessionStart } from "../hooks/session.js";

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
}

export interface NativeHookDispatchResult {
  hookEventName: CodexHookEventName | null;
  omxEventName: string | null;
  skillState: SkillActiveState | null;
  outputJson: Record<string, unknown> | null;
}

const TERMINAL_RALPH_PHASES = new Set(["complete", "failed", "cancelled"]);
const TERMINAL_MODE_PHASES = new Set(["complete", "failed", "cancelled"]);
const SKILL_STOP_BLOCKERS = new Set(["ralplan", "deep-interview"]);

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
    payload.input,
    payload.user_prompt,
    payload.userPrompt,
    payload.text,
  ];
  for (const candidate of candidates) {
    const value = safeString(candidate).trim();
    if (value) return value;
  }
  return "";
}

function buildBaseContext(
  cwd: string,
  payload: CodexHookPayload,
  hookEventName: CodexHookEventName,
): Record<string, unknown> {
  return {
    cwd,
    project_path: cwd,
    transcript_path: safeString(payload.transcript_path ?? payload.transcriptPath) || null,
    source: safeString(payload.source),
    payload,
    ...(hookEventName === "UserPromptSubmit"
      ? { prompt: readPromptText(payload) }
      : {}),
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

async function readScopedJsonState(
  fileName: string,
  cwd: string,
  sessionId?: string,
): Promise<Record<string, unknown> | null> {
  const dirs = await getReadScopedStateDirs(cwd, sessionId);
  for (const dir of dirs) {
    const candidate = await readJsonIfExists(join(dir, fileName));
    if (candidate) return candidate;
  }
  return null;
}

function isNonTerminalPhase(value: unknown): boolean {
  const phase = safeString(value).trim().toLowerCase();
  return phase !== "" && !TERMINAL_MODE_PHASES.has(phase);
}

function formatPhase(value: unknown, fallback = "active"): string {
  const phase = safeString(value).trim();
  return phase || fallback;
}

async function readActiveRalphState(stateDir: string): Promise<Record<string, unknown> | null> {
  const direct = await readJsonIfExists(join(stateDir, "ralph-state.json"));
  if (direct?.active === true && !TERMINAL_RALPH_PHASES.has(safeString(direct.current_phase).trim().toLowerCase())) {
    return direct;
  }

  const sessionInfo = await readJsonIfExists(join(stateDir, "session.json"));
  const currentOmxSessionId = safeString(sessionInfo?.session_id).trim();
  if (!currentOmxSessionId) return null;

  const sessionScoped = await readJsonIfExists(
    join(stateDir, "sessions", currentOmxSessionId, "ralph-state.json"),
  );
  if (
    sessionScoped?.active === true
    && !TERMINAL_RALPH_PHASES.has(
      safeString(sessionScoped.current_phase).trim().toLowerCase(),
    )
  ) {
    return sessionScoped;
  }

  const sessionsRoot = join(stateDir, "sessions");
  if (!existsSync(sessionsRoot)) return null;
  const entries = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = await readJsonIfExists(join(sessionsRoot, entry.name, "ralph-state.json"));
    if (
      candidate?.active === true
      && !TERMINAL_RALPH_PHASES.has(
        safeString(candidate.current_phase).trim().toLowerCase(),
      )
    ) {
      return candidate;
    }
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
  return /\b(?:codex|cursor)(?:\.js)?\b/i.test(command);
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

async function ensureOmxGitignoreEntry(cwd: string): Promise<{ changed: boolean; gitignorePath?: string }> {
  let repoRoot = "";
  try {
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return { changed: false };
  }
  if (!repoRoot) return { changed: false };

  const gitignorePath = join(repoRoot, ".gitignore");
  const existing = existsSync(gitignorePath)
    ? await readFile(gitignorePath, "utf-8")
    : "";
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(".omx/")) {
    return { changed: false, gitignorePath };
  }

  const next = `${existing}${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}.omx/\n`;
  await writeFile(gitignorePath, next);
  return { changed: true, gitignorePath };
}

async function buildSessionStartContext(
  cwd: string,
  sessionId: string,
): Promise<string> {
  const sections = [
    "OMX native SessionStart detected. Load workspace conventions from AGENTS.md, restore relevant .omx runtime/project memory context, and continue from existing mode state before making changes.",
  ];

  const gitignoreResult = await ensureOmxGitignoreEntry(cwd);
  if (gitignoreResult.changed) {
    sections.push(`Added .omx/ to ${gitignoreResult.gitignorePath} to keep local OMX state out of source control.`);
  }

  const modeSummaries: string[] = [];
  for (const mode of ["ralph", "autopilot", "ultrawork", "ultraqa", "ralplan", "deep-interview", "team"] as const) {
    const state = await readModeState(mode, cwd);
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
      const compact = notepad.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 3).join(" ");
      if (compact) {
        sections.push(`[Notepad]\n- ${compact.slice(0, 220)}`);
      }
    } catch {
      // best effort only
    }
  }

  const subagentSummary = await readSubagentSessionSummary(cwd, sessionId).catch(() => null);
  if (subagentSummary && subagentSummary.activeSubagentThreadIds.length > 0) {
    sections.push(`[Subagents]\n- active subagent threads: ${subagentSummary.activeSubagentThreadIds.length}`);
  }

  return sections.join("\n\n");
}

function buildAdditionalContextMessage(prompt: string): string | null {
  if (!prompt) return null;
  const match = detectPrimaryKeyword(prompt);
  if (!match) return null;

  return `OMX native UserPromptSubmit detected workflow keyword "${match.keyword}" -> ${match.skill}. Follow AGENTS.md routing and preserve ralplan/ralph execution gates.`;
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
): Promise<Record<string, unknown> | null> {
  const state = await readModeState(mode, cwd);
  if (state?.active !== true || !isNonTerminalPhase(state.current_phase)) return null;
  const phase = formatPhase(state.current_phase);
  return {
    decision: "block",
    reason: `OMX ${mode} is still active (phase: ${phase}); continue the task and gather fresh verification evidence before stopping.`,
    stopReason: `${mode}_${phase}`,
    systemMessage: `OMX ${mode} is still active (phase: ${phase}).`,
  };
}

async function buildTeamStopOutput(cwd: string): Promise<Record<string, unknown> | null> {
  const teamState = await readModeState("team", cwd);
  if (teamState?.active !== true) return null;
  const teamName = safeString(teamState.team_name).trim();
  const coarsePhase = teamState.current_phase;
  const canonicalPhase = teamName ? (await readTeamPhase(teamName, cwd))?.current_phase ?? coarsePhase : coarsePhase;
  if (!isNonTerminalPhase(canonicalPhase)) return null;
  const phase = formatPhase(canonicalPhase);
  return {
    decision: "block",
    reason: `OMX team pipeline is still active${teamName ? ` (${teamName})` : ""} at phase ${phase}; continue coordinating until the team reaches a terminal phase.`,
    stopReason: `team_${phase}`,
    systemMessage: `OMX team pipeline is still active at phase ${phase}.`,
  };
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

async function buildSkillStopOutput(
  cwd: string,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  const state = await readScopedJsonState("skill-active-state.json", cwd, sessionId);
  if (!state || state.active !== true) return null;
  const skill = safeString(state.skill).trim();
  const phase = formatPhase(state.phase, "planning");
  if (!SKILL_STOP_BLOCKERS.has(skill) || phase === "completing") return null;

  const subagentSummary = await readSubagentSessionSummary(cwd, sessionId).catch(() => null);
  if (subagentSummary && subagentSummary.activeSubagentThreadIds.length > 0) {
    return null;
  }

  return {
    decision: "block",
    reason: `OMX skill ${skill} is still active (phase: ${phase}); continue until the current ${skill} workflow reaches a terminal state.`,
    stopReason: `skill_${skill}_${phase}`,
    systemMessage: `OMX skill ${skill} is still active (phase: ${phase}).`,
  };
}

async function buildStopHookOutput(
  payload: CodexHookPayload,
  cwd: string,
  stateDir: string,
): Promise<Record<string, unknown> | null> {
  if (isStopExempt(payload)) {
    return null;
  }

  const sessionId = safeString(payload.session_id ?? payload.sessionId).trim();
  const ralphState = await readActiveRalphState(stateDir);
  const stopHookActive = payload.stop_hook_active === true || payload.stopHookActive === true;
  if (!ralphState) {
    const autopilotOutput = await buildModeBasedStopOutput("autopilot", cwd);
    if (!stopHookActive && autopilotOutput) return autopilotOutput;

    const ultraworkOutput = await buildModeBasedStopOutput("ultrawork", cwd);
    if (!stopHookActive && ultraworkOutput) return ultraworkOutput;

    const ultraqaOutput = await buildModeBasedStopOutput("ultraqa", cwd);
    if (!stopHookActive && ultraqaOutput) return ultraqaOutput;

    const teamOutput = await buildTeamStopOutput(cwd);
    if (!stopHookActive && teamOutput) return teamOutput;

    if (sessionId) {
      const canonicalTeam = await findCanonicalActiveTeamForSession(cwd, sessionId);
      if (!stopHookActive && canonicalTeam) {
        return {
          decision: "block",
          reason: `OMX team pipeline is still active (${canonicalTeam.teamName}) at phase ${canonicalTeam.phase}; continue coordinating until the team reaches a terminal phase.`,
          stopReason: `team_${canonicalTeam.phase}`,
          systemMessage: `OMX team pipeline is still active at phase ${canonicalTeam.phase}.`,
        };
      }

      const skillOutput = await buildSkillStopOutput(cwd, sessionId);
      if (!stopHookActive && skillOutput) return skillOutput;
    }

    const deepInterviewActive = await isDeepInterviewStateActive(stateDir);
    const lastAssistantMessage = safeString(
      payload.last_assistant_message ?? payload.lastAssistantMessage,
    );
    const autoNudgeConfig = await loadAutoNudgeConfig();

    if (
      !stopHookActive
      && !deepInterviewActive
      && autoNudgeConfig.enabled
      && detectStallPattern(lastAssistantMessage, autoNudgeConfig.patterns)
    ) {
      return {
        decision: "block",
        reason: autoNudgeConfig.response,
        stopReason: "auto_nudge",
        systemMessage:
          "OMX native Stop detected a stall/permission-style handoff and continued the turn automatically.",
      };
    }

    return null;
  }

  if (stopHookActive) {
    return null;
  }

  const currentPhase = safeString(ralphState?.current_phase).trim() || "executing";
  const stopReason = `ralph_${currentPhase}`;
  const systemMessage =
    `OMX Ralph is still active (phase: ${currentPhase}); continue the task and gather fresh verification evidence before stopping.`;

  return {
    decision: "block",
    reason: systemMessage,
    stopReason,
    systemMessage,
  };
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

  const sessionId = safeString(payload.session_id ?? payload.sessionId).trim();
  const threadId = safeString(payload.thread_id ?? payload.threadId).trim();
  const turnId = safeString(payload.turn_id ?? payload.turnId).trim();

  if (hookEventName === "SessionStart" && sessionId) {
    await writeSessionStart(cwd, sessionId, {
      pid: options.sessionOwnerPid ?? resolveSessionOwnerPid(payload),
    });
  }

  if (hookEventName === "UserPromptSubmit") {
    const prompt = readPromptText(payload);
    if (prompt) {
      skillState = await recordSkillActivation({
        stateDir,
        text: prompt,
        sessionId,
        threadId,
        turnId,
      });
    }
  }

  if (omxEventName) {
    const event: HookEventEnvelope = buildNativeHookEvent(
      omxEventName,
      buildBaseContext(cwd, payload, hookEventName!),
      {
        session_id: sessionId || undefined,
        thread_id: threadId || undefined,
        turn_id: turnId || undefined,
        mode: safeString(payload.mode).trim() || undefined,
      },
    );
    await dispatchHookEvent(event, { cwd });
  }

  let outputJson: Record<string, unknown> | null = null;
  if (hookEventName === "SessionStart" || hookEventName === "UserPromptSubmit") {
    const additionalContext = hookEventName === "SessionStart"
      ? await buildSessionStartContext(cwd, sessionId)
      : buildAdditionalContextMessage(readPromptText(payload));
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

async function readStdinJson(): Promise<CodexHookPayload> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  return raw ? safeObject(JSON.parse(raw)) : {};
}

export async function runCodexNativeHookCli(): Promise<void> {
  const payload = await readStdinJson();
  const result = await dispatchCodexNativeHook(payload);
  if (result.outputJson) {
    process.stdout.write(`${JSON.stringify(result.outputJson)}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCodexNativeHookCli().catch((error) => {
    process.stderr.write(
      `[omx] codex-native-hook failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
