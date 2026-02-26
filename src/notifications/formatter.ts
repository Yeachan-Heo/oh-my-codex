/**
 * Notification Message Formatters
 *
 * Produces human-readable notification messages for each event type.
 * Supports markdown (Discord/Telegram) and plain text (Slack/webhook) formats.
 */

import type { FullNotificationPayload } from "./types.js";
import { basename } from "path";

/** ANSI CSI escape sequences and two-character escapes */
const ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-9;]*[A-Za-z])/g;

/** OMX UI chrome: spinner/progress indicator characters */
const SPINNER_LINE_RE = /^[●⎿✻·◼]/;

/** tmux expand hint injected by some pane-capture scripts */
const CTRL_O_RE = /ctrl\+o to expand/i;

/** Lines composed entirely of box-drawing characters and whitespace */
const BOX_DRAWING_RE = /^[\s─═│║┌┐└┘┬┴├┤╔╗╚╝╠╣╦╩╬╟╢╤╧╪━┃┏┓┗┛┣┫┳┻╋┠┨┯┷┿╂]+$/;

/** OMX HUD status lines: [OMX#...] or [OMX] (unversioned) */
const OMX_HUD_RE = /\[OMX[#\]]/;

/** Bypass-permissions indicator lines starting with ⏵ */
const BYPASS_PERM_RE = /^⏵/;

/** Bare shell prompt with no command after it */
const BARE_PROMPT_RE = /^[❯>$%#]+$/;

/** Minimum ratio of alphanumeric characters for a line to be "meaningful" */
const MIN_ALNUM_RATIO = 0.15;

/** Maximum number of meaningful lines to include in a notification */
const MAX_TAIL_LINES = 10;

/**
 * Parse raw tmux pane output into clean, human-readable text suitable for
 * inclusion in a notification message.
 *
 * - Strips ANSI escape codes
 * - Removes UI chrome lines (spinner/progress characters: ●⎿✻·◼)
 * - Removes "ctrl+o to expand" hint lines
 * - Removes box-drawing character lines
 * - Removes OMX HUD status lines
 * - Removes bypass-permissions indicator lines
 * - Removes bare shell prompt lines
 * - Drops lines with < 15% alphanumeric density (for lines >= 8 chars)
 * - Caps at the last 10 meaningful (non-empty) lines
 */
export function parseTmuxTail(raw: string): string {
  const meaningful: string[] = [];

  for (const line of raw.split("\n")) {
    const stripped = line.replace(ANSI_RE, "");
    const trimmed = stripped.trim();

    if (!trimmed) continue;
    if (SPINNER_LINE_RE.test(trimmed)) continue;
    if (CTRL_O_RE.test(trimmed)) continue;
    if (BOX_DRAWING_RE.test(trimmed)) continue;
    if (OMX_HUD_RE.test(trimmed)) continue;
    if (BYPASS_PERM_RE.test(trimmed)) continue;
    if (BARE_PROMPT_RE.test(trimmed)) continue;

    // Alphanumeric density check: drop lines mostly composed of special characters
    const alnumCount = (trimmed.match(/[a-zA-Z0-9]/g) || []).length;
    if (trimmed.length >= 8 && alnumCount / trimmed.length < MIN_ALNUM_RATIO) continue;

    meaningful.push(stripped.trimEnd());
  }

  return meaningful.slice(-MAX_TAIL_LINES).join("\n");
}

function formatDuration(ms?: number): string {
  if (!ms) return "unknown";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function projectDisplay(payload: FullNotificationPayload): string {
  if (payload.projectName) return payload.projectName;
  if (payload.projectPath) return basename(payload.projectPath);
  return "unknown";
}

function buildTmuxTailBlock(payload: FullNotificationPayload): string {
  if (!payload.tmuxTail) return "";
  const cleaned = parseTmuxTail(payload.tmuxTail);
  if (!cleaned) return "";
  return `\n**Recent output:**\n\`\`\`\n${cleaned}\n\`\`\``;
}

function buildFooter(payload: FullNotificationPayload, markdown: boolean): string {
  const parts: string[] = [];

  if (payload.tmuxSession) {
    parts.push(
      markdown
        ? `**tmux:** \`${payload.tmuxSession}\``
        : `tmux: ${payload.tmuxSession}`,
    );
  }

  parts.push(
    markdown
      ? `**project:** \`${projectDisplay(payload)}\``
      : `project: ${projectDisplay(payload)}`,
  );

  return parts.join(markdown ? " | " : " | ");
}

export function formatSessionStart(payload: FullNotificationPayload): string {
  const time = new Date(payload.timestamp).toLocaleTimeString();
  const project = projectDisplay(payload);

  const lines = [
    `# Session Started`,
    "",
    `**Session:** \`${payload.sessionId}\``,
    `**Project:** \`${project}\``,
    `**Time:** ${time}`,
  ];

  if (payload.tmuxSession) {
    lines.push(`**tmux:** \`${payload.tmuxSession}\``);
  }

  return lines.join("\n");
}

export function formatSessionStop(payload: FullNotificationPayload): string {
  const lines = [`# Session Continuing`, ""];

  if (payload.activeMode) {
    lines.push(`**Mode:** ${payload.activeMode}`);
  }

  if (payload.iteration != null && payload.maxIterations != null) {
    lines.push(`**Iteration:** ${payload.iteration}/${payload.maxIterations}`);
  }

  if (payload.incompleteTasks != null && payload.incompleteTasks > 0) {
    lines.push(`**Incomplete tasks:** ${payload.incompleteTasks}`);
  }

  const tail = buildTmuxTailBlock(payload);
  if (tail) lines.push(tail);

  lines.push("");
  lines.push(buildFooter(payload, true));

  return lines.join("\n");
}

export function formatSessionEnd(payload: FullNotificationPayload): string {
  const duration = formatDuration(payload.durationMs);

  const lines = [
    `# Session Ended`,
    "",
    `**Session:** \`${payload.sessionId}\``,
    `**Duration:** ${duration}`,
    `**Reason:** ${payload.reason || "unknown"}`,
  ];

  if (payload.agentsSpawned != null) {
    lines.push(
      `**Agents:** ${payload.agentsCompleted ?? 0}/${payload.agentsSpawned} completed`,
    );
  }

  if (payload.modesUsed && payload.modesUsed.length > 0) {
    lines.push(`**Modes:** ${payload.modesUsed.join(", ")}`);
  }

  if (payload.contextSummary) {
    lines.push("", `**Summary:** ${payload.contextSummary}`);
  }

  const tail = buildTmuxTailBlock(payload);
  if (tail) lines.push(tail);

  lines.push("");
  lines.push(buildFooter(payload, true));

  return lines.join("\n");
}

export function formatSessionIdle(payload: FullNotificationPayload): string {
  const lines = [`# Session Idle`, ""];

  lines.push(`Codex has finished and is waiting for input.`);
  lines.push("");

  if (payload.reason) {
    lines.push(`**Reason:** ${payload.reason}`);
  }

  if (payload.modesUsed && payload.modesUsed.length > 0) {
    lines.push(`**Modes:** ${payload.modesUsed.join(", ")}`);
  }

  const tail = buildTmuxTailBlock(payload);
  if (tail) lines.push(tail);

  lines.push("");
  lines.push(buildFooter(payload, true));

  return lines.join("\n");
}

export function formatAskUserQuestion(payload: FullNotificationPayload): string {
  const lines = [`# Input Needed`, ""];

  if (payload.question) {
    lines.push(`**Question:** ${payload.question}`);
    lines.push("");
  }

  lines.push(`Codex is waiting for your response.`);
  lines.push("");
  lines.push(buildFooter(payload, true));

  return lines.join("\n");
}

export function formatNotification(payload: FullNotificationPayload): string {
  switch (payload.event) {
    case "session-start":
      return formatSessionStart(payload);
    case "session-stop":
      return formatSessionStop(payload);
    case "session-end":
      return formatSessionEnd(payload);
    case "session-idle":
      return formatSessionIdle(payload);
    case "ask-user-question":
      return formatAskUserQuestion(payload);
    default:
      return payload.message || `Event: ${payload.event}`;
  }
}
