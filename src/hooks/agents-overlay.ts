/**
 * AGENTS.md Runtime Overlay for oh-my-codex
 *
 * Dynamically injects session-specific context into AGENTS.md before Codex
 * launches, then strips it after session ends. Uses marker-bounded sections
 * for idempotent apply/strip cycles.
 *
 * Injected context:
 * - Codebase map (directory/module structure for token-efficient exploration)
 * - Active mode state (ralph iteration, autopilot phase, etc.)
 * - Priority notepad content
 * - Project memory summary (tech stack, conventions, directives)
 * - Compaction survival instructions
 * - Session metadata
 */

import { readFile, writeFile, mkdir, rm } from "fs/promises";
import { dirname, join } from "path";
import { existsSync } from "fs";
import {
  codexHome,
  listInstalledSkillDirectories,
  omxNotepadPath,
  omxProjectMemoryPath,
  omxStateDir,
  packageRoot,
} from "../utils/paths.js";
import {
  isPlanningComplete,
  readPlanningArtifacts,
} from "../planning/artifacts.js";
import {
  getReadScopedStateDirs,
  getStateDir,
  listModeStateFilesWithScopePreference,
} from "../mcp/state-paths.js";
import { generateCodebaseMap } from "./codebase-map.js";
import { buildExploreRoutingGuidance } from "./explore-routing.js";
import {
  SKILL_ACTIVE_STATE_FILE,
  listActiveSkills,
  readVisibleSkillActiveState,
} from "../state/skill-active.js";
import {
  OMX_GENERATED_AGENTS_MARKER,
  OMX_MANAGED_AGENTS_END_MARKER,
  OMX_MANAGED_AGENTS_START_MARKER,
} from "../utils/agents-md.js";

const START_MARKER = "<!-- OMX:RUNTIME:START -->";
const END_MARKER = "<!-- OMX:RUNTIME:END -->";
const WORKER_START_MARKER = "<!-- OMX:TEAM:WORKER:START -->";
const WORKER_END_MARKER = "<!-- OMX:TEAM:WORKER:END -->";
const MAX_OVERLAY_SIZE = 3500;
const SKILL_REFERENCE_PATTERN = /\/skills\/([^/\s`]+)\/SKILL\.md\b/g;

// ── Lock helpers ─────────────────────────────────────────────────────────────

function lockPath(cwd: string): string {
  return join(omxStateDir(cwd), "agents-md.lock");
}

async function acquireLock(
  cwd: string,
  timeoutMs: number = 5000,
): Promise<void> {
  const lock = lockPath(cwd);
  // Ensure parent directory exists
  const { dirname } = await import("path");
  await mkdir(dirname(lock), { recursive: true });

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await mkdir(lock, { recursive: false });
      // Write owner metadata for stale detection
      const ownerFile = join(lock, "owner.json");
      await writeFile(
        ownerFile,
        JSON.stringify({ pid: process.pid, ts: Date.now() }),
      );
      return; // Lock acquired
    } catch {
      // Lock exists - check if owner is dead
      try {
        const ownerFile = join(lock, "owner.json");
        const ownerData = JSON.parse(await readFile(ownerFile, "utf-8"));
        try {
          process.kill(ownerData.pid, 0);
        } catch {
          // Owner PID is dead, safe to reap
          await rm(lock, { recursive: true, force: true }).catch(() => {});
          continue; // Retry acquire immediately
        }
      } catch (err) {
        process.stderr.write(
          `[agents-overlay] lock owner check failed: ${err}\n`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  // Timeout: do NOT silently proceed - throw so caller knows lock failed
  throw new Error("Failed to acquire AGENTS.md lock within timeout");
}

async function releaseLock(cwd: string): Promise<void> {
  try {
    await rm(lockPath(cwd), { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`[agents-overlay] release lock failed: ${err}\n`);
  }
}

async function withAgentsMdLock<T>(
  cwd: string,
  fn: () => Promise<T>,
): Promise<T> {
  await acquireLock(cwd);
  try {
    return await fn();
  } finally {
    await releaseLock(cwd);
  }
}

// ── Truncation helpers ───────────────────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

type OverlaySection = {
  key: string;
  text: string;
  optional: boolean;
};

export type SessionOrchestrationMode = "default" | "team";

export interface GenerateOverlayOptions {
  orchestrationMode?: SessionOrchestrationMode;
}

function joinSections(sections: OverlaySection[]): string {
  return sections.map((s) => s.text).join("\n\n");
}

function capBodyToMax(sections: OverlaySection[], maxBody: number): string {
  // Deterministic overflow policy (lowest priority removed first):
  // 1) Drop optional sections from the end until it fits.
  // 2) If still too large, hard-truncate the final section with ellipsis.
  let body = joinSections(sections);
  if (body.length <= maxBody) return body;

  const optionalIndices: number[] = [];
  for (let i = sections.length - 1; i >= 0; i--) {
    if (sections[i].optional) optionalIndices.push(i);
  }

  const current = sections.slice();
  for (const idx of optionalIndices) {
    current.splice(idx, 1);
    body = joinSections(current);
    if (body.length <= maxBody) return body;
  }

  if (body.length > maxBody) {
    if (maxBody <= 3) return ".".repeat(Math.max(0, maxBody));
    body = body.slice(0, maxBody - 3) + "...";
  }

  return body;
}

// ── Overlay generation ───────────────────────────────────────────────────────

async function isRalphActive(
  cwd: string,
  sessionId?: string,
): Promise<boolean> {
  if (sessionId && !existsSync(getStateDir(cwd, sessionId))) {
    return false;
  }
  const refs = await listModeStateFilesWithScopePreference(cwd, sessionId);
  const ralphRef = refs.find((ref) => ref.mode === "ralph");
  if (!ralphRef) return false;

  try {
    const data = JSON.parse(await readFile(ralphRef.path, "utf-8"));
    return data?.active === true;
  } catch {
    return false;
  }
}

async function readRalphPlanningArtifacts(
  cwd: string,
): Promise<{ hasPrd: boolean; hasTestSpec: boolean; complete: boolean }> {
  const artifacts = readPlanningArtifacts(cwd);
  return {
    hasPrd: artifacts.prdPaths.length > 0,
    hasTestSpec: artifacts.testSpecPaths.length > 0,
    complete: isPlanningComplete(artifacts),
  };
}

async function readActiveModes(
  cwd: string,
  sessionId?: string,
): Promise<string> {
  if (sessionId && !existsSync(getStateDir(cwd, sessionId))) {
    return "";
  }
  const refs = await listModeStateFilesWithScopePreference(cwd, sessionId);
  const canonicalState = await readVisibleSkillActiveState(cwd, sessionId);
  const canonicalSkills = new Map(
    listActiveSkills(canonicalState).map((entry) => [entry.skill, entry] as const),
  );
  const useCompatibilityFallback = canonicalState == null;

  const preferredByMode = new Map<
    string,
    { mode: string; path: string; scope: "root" | "session" }
  >();
  for (const ref of refs) {
    preferredByMode.set(ref.mode, ref);
  }

  const modes: string[] = [];
  const emittedCanonicalSkills = new Set<string>();
  for (const ref of [...preferredByMode.values()].sort((a, b) =>
    a.mode.localeCompare(b.mode),
  )) {
    try {
      if (
        !useCompatibilityFallback &&
        !canonicalSkills.has(ref.mode)
      ) {
        continue;
      }
      const data = JSON.parse(await readFile(ref.path, "utf-8"));
      if (!data.active) continue;
      const details: string[] = [];
      if (data.iteration !== undefined)
        details.push(
          `iteration ${data.iteration}/${data.max_iterations || "?"}`,
        );
      const canonicalPhase = canonicalSkills.get(ref.mode)?.phase;
      const phase = data.current_phase || canonicalPhase;
      if (phase) details.push(`phase: ${phase}`);
      modes.push(`- ${ref.mode}: ${details.join(", ") || "active"}`);
      emittedCanonicalSkills.add(ref.mode);
    } catch {
      // Skip malformed mode state files.
    }
  }

  if (!useCompatibilityFallback) {
    for (const [skill, entry] of [...canonicalSkills.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (emittedCanonicalSkills.has(skill)) continue;
      const details: string[] = [];
      if (entry.phase) details.push(`phase: ${entry.phase}`);
      modes.push(`- ${skill}: ${details.join(", ") || "active"}`);
    }
  }

  return modes.length > 0 ? modes.join("\n") : "";
}

async function readNotepadPriority(cwd: string): Promise<string> {
  const notePath = omxNotepadPath(cwd);
  if (!existsSync(notePath)) return "";

  try {
    const content = await readFile(notePath, "utf-8");
    const header = "## PRIORITY";
    const idx = content.indexOf(header);
    if (idx < 0) return "";
    const nextHeader = content.indexOf("\n## ", idx + header.length);
    const section =
      nextHeader < 0
        ? content.slice(idx + header.length).trim()
        : content.slice(idx + header.length, nextHeader).trim();
    return section || "";
  } catch {
    return "";
  }
}

async function readProjectMemorySummary(cwd: string): Promise<string> {
  const memPath = omxProjectMemoryPath(cwd);
  if (!existsSync(memPath)) return "";

  try {
    const data = JSON.parse(await readFile(memPath, "utf-8"));
    const parts: string[] = [];
    if (data.techStack) parts.push(`- Stack: ${data.techStack}`);
    if (data.conventions) parts.push(`- Conventions: ${data.conventions}`);
    if (data.build) parts.push(`- Build: ${data.build}`);
    if (data.directives && Array.isArray(data.directives)) {
      const highPriority = data.directives.filter(
        (d: { priority?: string }) => d.priority === "high",
      );
      for (const d of highPriority.slice(0, 3)) {
        parts.push(`- Directive: ${d.directive}`);
      }
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}

function getCompactionInstructions(): string {
  return [
    "Before context compaction, preserve critical state:",
    "1. Write progress checkpoint via state_write MCP tool",
    "2. Save key decisions to notepad via notepad_write_working",
    "3. If context is >80% full, proactively checkpoint state",
  ].join("\n");
}

async function readTeamOrchestratorOverlay(): Promise<string> {
  const overlayPath = join(packageRoot(), "prompts", "team-orchestrator.md");
  try {
    return (await readFile(overlayPath, "utf-8")).trim();
  } catch {
    return "";
  }
}

export async function resolveSessionOrchestrationMode(
  cwd: string,
  sessionId?: string,
  activeSkill?: string,
): Promise<SessionOrchestrationMode> {
  if (activeSkill === "team") return "team";
  if (activeSkill) return "default";
  if (sessionId && !existsSync(getStateDir(cwd, sessionId))) {
    return "default";
  }

  const scopedStateDirs = await getReadScopedStateDirs(cwd, sessionId);
  for (const stateDir of scopedStateDirs) {
    const statePath = join(stateDir, SKILL_ACTIVE_STATE_FILE);
    if (!existsSync(statePath)) continue;

    try {
      const state = JSON.parse(await readFile(statePath, "utf-8")) as {
        active?: boolean;
        skill?: string;
      };
      if (state.active !== true) return "default";
      return state.skill === "team" ? "team" : "default";
    } catch {
      return "default";
    }
  }

  return "default";
}

/**
 * Generate the overlay content to inject into AGENTS.md.
 * Total output is capped at MAX_OVERLAY_SIZE chars.
 */
export async function generateOverlay(
  cwd: string,
  sessionId?: string,
  options: GenerateOverlayOptions = {},
): Promise<string> {
  const orchestrationMode = options.orchestrationMode ?? "default";
  const [
    activeModes,
    notepadPriority,
    projectMemory,
    codebaseMap,
    ralphActive,
    planningArtifacts,
    teamOverlay,
    exploreRoutingGuidance,
  ] = await Promise.all([
    readActiveModes(cwd, sessionId),
    readNotepadPriority(cwd),
    readProjectMemorySummary(cwd),
    generateCodebaseMap(cwd),
    isRalphActive(cwd, sessionId),
    readRalphPlanningArtifacts(cwd),
    orchestrationMode === "team"
      ? readTeamOrchestratorOverlay()
      : Promise.resolve(""),
    Promise.resolve(buildExploreRoutingGuidance()),
  ]);

  // Build sections with deterministic overflow behavior.
  const sections: OverlaySection[] = [];

  // Session metadata (max 200 chars) - required
  const sessionMeta = `**Session:** ${sessionId || "unknown"} | ${new Date().toISOString()}`;
  sections.push({
    key: "session",
    text: truncate(sessionMeta, 200),
    optional: false,
  });

  // Codebase map (max 1000 chars) - optional, injected at session start for token-efficient exploration
  if (codebaseMap) {
    sections.push({
      key: "codebase_map",
      text: `**Codebase Map:**\n${truncate(codebaseMap, 1000)}`,
      optional: true,
    });
  }

  // Active modes (max 300 chars) - optional
  if (activeModes) {
    sections.push({
      key: "active_modes",
      text: `**Active Modes:**\n${truncate(activeModes, 600)}`,
      optional: true,
    });
  }

  // Priority notepad (max 300 chars) - optional
  if (notepadPriority) {
    sections.push({
      key: "priority_notes",
      text: `**Priority Notes:**\n${truncate(notepadPriority, 600)}`,
      optional: true,
    });
  }

  // Project memory (max 500 chars) - optional
  if (projectMemory) {
    sections.push({
      key: "project_context",
      text: `**Project Context:**\n${truncate(projectMemory, 1000)}`,
      optional: true,
    });
  }

  if (teamOverlay) {
    sections.push({
      key: "team_orchestrator",
      text: `**Orchestration Mode:** team\n${truncate(teamOverlay, 900)}`,
      optional: true,
    });
  }

  if (exploreRoutingGuidance) {
    sections.push({
      key: "explore_routing",
      text: truncate(exploreRoutingGuidance, 600),
      optional: true,
    });
  }

  if (ralphActive) {
    const gateStatus = planningArtifacts.complete ? "UNLOCKED" : "BLOCKED";
    const missing: string[] = [];
    if (!planningArtifacts.hasPrd) missing.push("`prd-*.md`");
    if (!planningArtifacts.hasTestSpec) missing.push("`test-spec-*.md`");
    const details =
      missing.length > 0
        ? `Missing: ${missing.join(", ")}`
        : "Planning artifacts present: PRD + test spec";

    sections.push({
      key: "ralph_planning_gate",
      text: `**Ralph Ralplan-First Gate:** ${gateStatus}\n- Requirement: complete planning artifacts before implementation/tool execution.\n- ${details}\n- Path: \`.omx/plans/\``,
      optional: false,
    });
  }

  // Compaction protocol (max 400 chars) - required
  sections.push({
    key: "compaction",
    text: `**Compaction Protocol:**\n${truncate(getCompactionInstructions(), 380)}`,
    optional: false,
  });

  const prefix = `${START_MARKER}\n<session_context>\n`;
  const suffix = `\n</session_context>\n${END_MARKER}`;
  const maxBody = Math.max(0, MAX_OVERLAY_SIZE - prefix.length - suffix.length);
  const body = capBodyToMax(sections, maxBody);

  const overlay = `${prefix}${body}${suffix}`;
  // Belt-and-suspenders: never exceed cap even if assumptions drift.
  if (overlay.length <= MAX_OVERLAY_SIZE) return overlay;

  const safeBody = capBodyToMax(
    [
      { key: "session", text: truncate(sessionMeta, 200), optional: false },
      {
        key: "compaction",
        text: `**Compaction Protocol:**\n${truncate(getCompactionInstructions(), 380)}`,
        optional: false,
      },
    ],
    maxBody,
  );
  return `${prefix}${safeBody}${suffix}`.slice(0, MAX_OVERLAY_SIZE);
}

/**
 * Apply overlay to AGENTS.md. Strips any existing overlay first (idempotent).
 * Uses file locking to prevent concurrent access corruption.
 */
export async function applyOverlay(
  agentsMdPath: string,
  overlay: string,
  cwd?: string,
): Promise<void> {
  const dir = cwd || join(agentsMdPath, "..");
  await withAgentsMdLock(dir, async () => {
    let content = "";
    if (existsSync(agentsMdPath)) {
      content = await readFile(agentsMdPath, "utf-8");
    }

    // Strip existing overlay
    content = stripOverlayContent(content);

    // Append new overlay
    content = content.trimEnd() + "\n\n" + overlay + "\n";

    await writeFile(agentsMdPath, content);
  });
}

/**
 * Strip overlay from AGENTS.md, restoring it to clean state.
 * Uses file locking to prevent concurrent access corruption.
 */
export async function stripOverlay(
  agentsMdPath: string,
  cwd?: string,
): Promise<void> {
  if (!existsSync(agentsMdPath)) return;

  const dir = cwd || join(agentsMdPath, "..");
  await withAgentsMdLock(dir, async () => {
    const content = await readFile(agentsMdPath, "utf-8");
    const stripped = stripOverlayContent(content);

    if (stripped !== content) {
      await writeFile(agentsMdPath, stripped);
    }
  });
}

/**
 * Remove overlay markers and content from a string (pure function).
 */
function stripOverlayContent(content: string): string {
  // Strip all marker-bounded segments (handles multiple overlays from corruption)
  let result = content;
  let iterations = 0;
  const MAX_STRIP_ITERATIONS = 50; // Safety bound (enough to clean up corrupt duplicates)

  while (iterations < MAX_STRIP_ITERATIONS) {
    const startIdx = result.indexOf(START_MARKER);
    if (startIdx < 0) break;

    const endIdx = result.indexOf(END_MARKER, startIdx);
    if (endIdx < 0) {
      // Malformed runtime marker block. Remove only until the next known marker
      // so unrelated overlays (e.g. worker overlay) are preserved.
      const markerCandidates = [
        result.indexOf(START_MARKER, startIdx + START_MARKER.length),
        result.indexOf(WORKER_START_MARKER, startIdx + START_MARKER.length),
        result.indexOf(WORKER_END_MARKER, startIdx + START_MARKER.length),
      ].filter((i) => i >= 0);

      const nextMarkerIdx =
        markerCandidates.length > 0 ? Math.min(...markerCandidates) : -1;

      if (nextMarkerIdx < 0) {
        result = result.slice(0, startIdx).trimEnd() + "\n";
        break;
      }

      const before = result.slice(0, startIdx).trimEnd();
      const after = result.slice(nextMarkerIdx).trimStart();
      result = after ? before + "\n" + after : before + "\n";
      iterations++;
      continue;
    }

    const before = result.slice(0, startIdx).trimEnd();
    const after = result.slice(endIdx + END_MARKER.length).trimStart();
    result = after ? before + "\n" + after : before + "\n";
    iterations++;
  }

  return result;
}

/**
 * Check if AGENTS.md currently has an overlay applied.
 */
export function hasOverlay(content: string): boolean {
  return content.includes(START_MARKER) && content.includes(END_MARKER);
}

export function sessionModelInstructionsPath(
  cwd: string,
  sessionId: string,
): string {
  return join(getStateDir(cwd, sessionId), "AGENTS.md");
}

function dropShadowedSkillReferenceLines(
  content: string,
  shadowedSkillNames: ReadonlySet<string>,
): string {
  if (shadowedSkillNames.size === 0) return content;

  const lines = content.split("\n");
  const keptLines = lines.filter((line) => {
    SKILL_REFERENCE_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SKILL_REFERENCE_PATTERN.exec(line)) !== null) {
      if (shadowedSkillNames.has(match[1] || "")) {
        return false;
      }
    }
    return true;
  });

  return keptLines.join("\n");
}

function stripOmxManagedAgentsBlocks(content: string): string {
  let next = content;

  while (true) {
    const startIndex = next.indexOf(OMX_MANAGED_AGENTS_START_MARKER);
    if (startIndex < 0) return next;

    const endIndex = next.indexOf(
      OMX_MANAGED_AGENTS_END_MARKER,
      startIndex + OMX_MANAGED_AGENTS_START_MARKER.length,
    );
    if (endIndex < 0) return next;

    const replaceEnd = endIndex + OMX_MANAGED_AGENTS_END_MARKER.length;
    next = `${next.slice(0, startIndex)}${next.slice(replaceEnd)}`;
  }
}

function stripGeneratedOmxAgentsForSession(content: string): string {
  const withoutManagedBlocks = stripOmxManagedAgentsBlocks(content).trim();
  if (withoutManagedBlocks.includes(OMX_GENERATED_AGENTS_MARKER)) return "";
  return withoutManagedBlocks;
}

/**
 * Build a session-scoped AGENTS.md that combines user-level CODEX_HOME
 * instructions, project instructions (if any), and the runtime overlay,
 * without mutating the source AGENTS.md files.
 */
export async function writeSessionModelInstructionsFile(
  cwd: string,
  sessionId: string,
  overlay: string,
): Promise<string> {
  const sessionPath = sessionModelInstructionsPath(cwd, sessionId);
  await mkdir(dirname(sessionPath), { recursive: true });

  const baseParts: string[] = [];
  const sourcePaths = [join(codexHome(), "AGENTS.md"), join(cwd, "AGENTS.md")];
  const seenPaths = new Set<string>();
  const installedSkills = await listInstalledSkillDirectories(cwd);
  const projectSkillNames = new Set(
    installedSkills
      .filter((skill) => skill.scope === "project")
      .map((skill) => skill.name),
  );

  for (const sourcePath of sourcePaths) {
    if (seenPaths.has(sourcePath) || !existsSync(sourcePath)) continue;
    seenPaths.add(sourcePath);

    let content = await readFile(sourcePath, "utf-8");
    content = stripOverlayContent(content).trim();
    content = stripGeneratedOmxAgentsForSession(content);
    if (sourcePath === join(codexHome(), "AGENTS.md")) {
      content = dropShadowedSkillReferenceLines(
        content,
        projectSkillNames,
      ).trim();
    }
    if (!content) continue;
    baseParts.push(content);
  }

  const base = baseParts.join("\n\n");
  const composed =
    base.trim().length > 0 ? `${base}\n\n${overlay}\n` : `${overlay}\n`;

  await writeFile(sessionPath, composed);
  return sessionPath;
}

/**
 * Best-effort cleanup for session-scoped model instructions file.
 */
export async function removeSessionModelInstructionsFile(
  cwd: string,
  sessionId: string,
): Promise<void> {
  const sessionPath = sessionModelInstructionsPath(cwd, sessionId);
  await rm(sessionPath, { force: true });
}
