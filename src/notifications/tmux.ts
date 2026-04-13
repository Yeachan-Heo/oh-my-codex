/**
 * tmux Session Detection for Notifications
 *
 * Detects the current tmux session name and pane ID for inclusion in notification payloads.
 */

import { execFileSync } from "child_process";
import { buildCapturePaneArgv } from "./tmux-detector.js";
import { resolveTmuxBinaryForPlatform } from "../utils/platform-command.js";

const TMUX_PANE_TARGET_RE = /^%\d+$/;
const DEFAULT_CAPTURE_LINES = 12;
const MAX_CAPTURE_LINES = 2000;
const ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-9;]*[A-Za-z])/g;
const OMX_METADATA_SEGMENT_RE = /^\[OMX(?:[#\]].*)?$/;
const HUD_STATUS_SEGMENT_RE = /^(?:ralph:\d+\/(?:\d+|\?)|autopilot:[\w-]+|ralplan:(?:\d+\/(?:\d+|\?)|[\w-]+)|interview:[\w:-]+|research:[\w-]+|qa:[\w-]+|team:(?:\d+\s+workers|[\w.-]+)|ultrawork|turns:\d+|tokens:[\dkm.]+|quota:[\w%,.]+|session:[\dhms]+|last:\d+[smh](?:\s+ago)?|total-turns:\d+|tmux:[\w:.-]+)$/i;
const BRANCH_METADATA_SEGMENT_RE = /^(?:(?:fix|feat|feature|chore|refactor|hotfix|release|docs|doc|test|tests|ci|build|perf|revert|bugfix|spike|wip)\/[A-Za-z0-9._/-]+|HEAD(?: -> [A-Za-z0-9._/-]+)?|detached)$/;

function isMetadataOnlyTmuxSegment(segment: string): boolean {
  return OMX_METADATA_SEGMENT_RE.test(segment)
    || HUD_STATUS_SEGMENT_RE.test(segment)
    || BRANCH_METADATA_SEGMENT_RE.test(segment);
}

function isMetadataOnlyTmuxLine(line: string): boolean {
  const normalized = line.replace(ANSI_RE, "").trim();
  if (!normalized) return false;

  const segments = normalized.split("|").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => !isMetadataOnlyTmuxSegment(segment))) {
    return false;
  }

  const hasExplicitStatusSegment = segments.some((segment) => OMX_METADATA_SEGMENT_RE.test(segment) || HUD_STATUS_SEGMENT_RE.test(segment));
  return hasExplicitStatusSegment || (segments.length === 1 && BRANCH_METADATA_SEGMENT_RE.test(segments[0]));
}

/**
 * Remove metadata-only tmux lines from alert-facing payload text while
 * preserving real runtime failures. Raw capture helpers remain unchanged.
 */
export function sanitizeTmuxAlertText(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const filtered = raw
    .split("\n")
    .filter((line) => !isMetadataOnlyTmuxLine(line));
  const joined = filtered.join("\n").trim();
  return joined || undefined;
}

export interface TmuxPaneCaptureResult {
  content: string | null;
  live: boolean;
}

function shouldUsePidFallback(): boolean {
  return process.env.OMX_TMUX_PID_FALLBACK === "1";
}

function execTmux(args: string[]): string {
  return execFileSync(resolveTmuxBinaryForPlatform() || "tmux", args, {
    encoding: "utf-8",
    timeout: 3000,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: process.platform === "win32",
  }).trim();
}

/**
 * Get the current tmux session name.
 * First checks $TMUX env, then falls back to finding the tmux session
 * that owns the current process tree (for hooks/subprocesses that don't
 * inherit $TMUX).
 */
export function getCurrentTmuxSession(): string | null {
  // Fast path: $TMUX is set (we're directly inside tmux)
  if (process.env.TMUX) {
    try {
      const tmuxPaneTarget = process.env.TMUX_PANE;
      const paneTargetSafe = tmuxPaneTarget && TMUX_PANE_TARGET_RE.test(tmuxPaneTarget) ? tmuxPaneTarget : null;
      const sessionName = execTmux(
        paneTargetSafe
          ? ["display-message", "-p", "-t", paneTargetSafe, "#S"]
          : ["display-message", "-p", "#S"],
      );
      if (sessionName) return sessionName;
    } catch {
      // fall through to PID-based detection
    }
  }

  if (!shouldUsePidFallback()) return null;

  // Fallback: walk the process tree to find a tmux pane that owns us.
  // This handles hooks/subprocesses that don't inherit $TMUX.
  return detectTmuxSessionByPid();
}

/**
 * Detect tmux session by walking the process tree.
 * Lists all tmux panes and their PIDs, then checks if our PID (or any ancestor)
 * is a child of a tmux pane process.
 */
function detectTmuxSessionByPid(): string | null {
  if (process.platform === 'win32') return null;
  try {
    // Get all tmux pane PIDs with their session names
    const output = execTmux(["list-panes", "-a", "-F", "#{pane_pid} #{session_name}"]);
    if (!output) return null;

    const panePids = new Map<number, string>();
    for (const line of output.split("\n")) {
      const parts = line.trim().split(" ", 2);
      if (parts.length === 2) {
        const pid = parseInt(parts[0], 10);
        if (!isNaN(pid)) panePids.set(pid, parts[1]);
      }
    }

    if (panePids.size === 0) return null;

    // Walk up the process tree from our PID
    let currentPid = process.pid;
    const visited = new Set<number>();
    while (currentPid > 1 && !visited.has(currentPid)) {
      visited.add(currentPid);

      // Check if this PID is a tmux pane process
      if (panePids.has(currentPid)) {
        return panePids.get(currentPid) || null;
      }

      // Get parent PID
      try {
        const ppidStr = execFileSync("ps", ["-o", "ppid=", "-p", String(currentPid)], {
          encoding: "utf-8",
          timeout: 1000,
          stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
        const ppid = parseInt(ppidStr, 10);
        if (isNaN(ppid) || ppid <= 1) break;
        currentPid = ppid;
      } catch {
        break;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * List active omx-team tmux sessions for a given team.
 */
export function getTeamTmuxSessions(teamName: string): string[] {
  const sanitized = teamName.replace(/[^a-zA-Z0-9-]/g, "");
  if (!sanitized) return [];

  const prefix = `omx-team-${sanitized}`;
  try {
    const output = execTmux(["list-sessions", "-F", "#{session_name}"]);
    return output
      .trim()
      .split("\n")
      .filter((s) => s === prefix || s.startsWith(`${prefix}-`));
  } catch {
    return [];
  }
}

/**
 * Capture the last N lines of output from a tmux pane.
 * Used to include a tail snippet in session-level notifications.
 * Returns null if capture fails or tmux is not available.
 */
export function captureTmuxPane(paneId?: string | null, lines: number = 12): string | null {
  return captureTmuxPaneWithLiveness(paneId, lines).content;
}

export function captureTmuxPaneWithLiveness(paneId?: string | null, lines: number = 12): TmuxPaneCaptureResult {
  const target = paneId || process.env.TMUX_PANE;
  if (!target) return { content: null, live: false };
  if (!process.env.TMUX && !paneId) return { content: null, live: false };
  if (!TMUX_PANE_TARGET_RE.test(target)) return { content: null, live: false };

  const safeLines = Number.isFinite(lines) ? Math.trunc(lines) : DEFAULT_CAPTURE_LINES;
  const clampedLines = Math.max(1, Math.min(MAX_CAPTURE_LINES, safeLines));

  try {
    const paneStatus = execTmux(["list-panes", "-t", target, "-F", "#{pane_dead} #{pane_pid}"]);
    const firstStatusLine = paneStatus.split("\n")[0]?.trim() || "";
    const [paneDead = "", panePidRaw = ""] = firstStatusLine.split(/\s+/, 2);
    const panePid = Number.parseInt(panePidRaw, 10);
    if (paneDead === "1" || !Number.isFinite(panePid)) {
      return { content: null, live: false };
    }
    try {
      process.kill(panePid, 0);
    } catch {
      return { content: null, live: false };
    }

    const output = execFileSync(resolveTmuxBinaryForPlatform() || "tmux", buildCapturePaneArgv(target, clampedLines), {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: process.platform === "win32",
    }).trim();
    return { content: output || null, live: true };
  } catch {
    return { content: null, live: false };
  }
}

/**
 * Format tmux session info for human-readable display.
 * Returns null if not in tmux.
 */
export function formatTmuxInfo(): string | null {
  const session = getCurrentTmuxSession();
  if (!session) return null;
  return `tmux: ${session}`;
}

/**
 * Get the current tmux pane ID (e.g., "%0").
 * Tries $TMUX_PANE env var first, then tmux display-message,
 * then falls back to PID-based detection.
 */
export function getCurrentTmuxPaneId(): string | null {
  // Fast path: $TMUX_PANE is set
  const envPane = process.env.TMUX_PANE;
  if (process.env.TMUX && envPane && /^%\d+$/.test(envPane)) return envPane;

  // Try tmux display-message if $TMUX is set.
  // NOTE: This fallback is intentionally untargeted -- it is only reached when
  // TMUX_PANE is absent or invalid, so there is no env-based pane target
  // available. In the multi-session case this may resolve to the wrong client,
  // but it is still better than nothing and matches the PID-walk fallback below.
  if (process.env.TMUX) {
    try {
      const paneId = execTmux(["display-message", "-p", "#{pane_id}"]);
      if (paneId && /^%\d+$/.test(paneId)) return paneId;
    } catch {
      // fall through
    }
  }

  if (!shouldUsePidFallback()) return null;

  // Fallback: find pane by walking the process tree
  return detectTmuxPaneByPid();
}

/**
 * Detect tmux pane ID by walking the process tree.
 */
function detectTmuxPaneByPid(): string | null {
  if (process.platform === 'win32') return null;
  try {
    const output = execTmux(["list-panes", "-a", "-F", "#{pane_pid} #{pane_id}"]);
    if (!output) return null;

    const panePids = new Map<number, string>();
    for (const line of output.split("\n")) {
      const parts = line.trim().split(" ", 2);
      if (parts.length === 2) {
        const pid = parseInt(parts[0], 10);
        if (!isNaN(pid)) panePids.set(pid, parts[1]);
      }
    }

    if (panePids.size === 0) return null;

    let currentPid = process.pid;
    const visited = new Set<number>();
    while (currentPid > 1 && !visited.has(currentPid)) {
      visited.add(currentPid);
      if (panePids.has(currentPid)) {
        return panePids.get(currentPid) || null;
      }
      try {
        const ppidStr = execFileSync("ps", ["-o", "ppid=", "-p", String(currentPid)], {
          encoding: "utf-8",
          timeout: 1000,
          stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
        const ppid = parseInt(ppidStr, 10);
        if (isNaN(ppid) || ppid <= 1) break;
        currentPid = ppid;
      } catch {
        break;
      }
    }

    return null;
  } catch {
    return null;
  }
}
