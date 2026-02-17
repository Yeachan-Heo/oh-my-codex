/**
 * tmux Session Detection for Notifications
 *
 * Detects the current tmux session name and pane ID for inclusion in notification payloads.
 */

import { execSync } from "child_process";

function shouldUsePidFallback(): boolean {
  return process.env.OMX_TMUX_PID_FALLBACK === "1";
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
      const sessionName = execSync("tmux display-message -p '#S'", {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
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
  try {
    // Get all tmux pane PIDs with their session names
    const output = execSync(
      "tmux list-panes -a -F '#{pane_pid} #{session_name}'",
      {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    ).trim();
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
        const ppidStr = execSync(`ps -o ppid= -p ${currentPid}`, {
          encoding: "utf-8",
          timeout: 1000,
          stdio: ["pipe", "pipe", "pipe"],
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

  const prefix = `omx-team-${sanitized}-`;
  try {
    const output = execSync("tmux list-sessions -F '#{session_name}'", {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output
      .trim()
      .split("\n")
      .filter((s) => s.startsWith(prefix))
      .map((s) => s.slice(prefix.length));
  } catch {
    return [];
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

  // Try tmux display-message if $TMUX is set
  if (process.env.TMUX) {
    try {
      const paneId = execSync("tmux display-message -p '#{pane_id}'", {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
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
  try {
    const output = execSync(
      "tmux list-panes -a -F '#{pane_pid} #{pane_id}'",
      {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    ).trim();
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
        const ppidStr = execSync(`ps -o ppid= -p ${currentPid}`, {
          encoding: "utf-8",
          timeout: 1000,
          stdio: ["pipe", "pipe", "pipe"],
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
