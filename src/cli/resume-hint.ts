import { basename } from 'node:path';
import { MADMAX_FLAG, HIGH_REASONING_FLAG, XHIGH_REASONING_FLAG } from './constants.js';

export interface ResumeBlockInput {
  /** Codex session id, or null when none was captured. */
  sessionId: string | null;
  /** Original omx launch args (flags that shape the context are re-emitted). */
  launchArgs: readonly string[];
  /** Directory the launch started from (source cwd for madmax). */
  launchCwd: string;
  madmaxStateDir?: string;
  worktree?: { path: string; name?: string | null };
  /** Session lives in the project-local Codex home. */
  projectLocalHome?: boolean;
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\''`)}'`;
}

/**
 * Compute the effective working directory where a session will be created.
 * When a worktree is enabled, the session cwd will be the worktree path.
 * Otherwise, it will be the launch cwd.
 */
export function resolveEffectiveSessionCwd(
  launchCwd: string,
  worktreeEnabled: boolean,
  worktreePath?: string,
): string {
  return worktreeEnabled && worktreePath ? worktreePath : launchCwd;
}

function contextFlags(launchArgs: readonly string[]): string[] {
  const flags: string[] = [];
  let madmax = false;
  let reasoning: string | undefined;
  let model: string | undefined;
  for (let i = 0; i < launchArgs.length; i += 1) {
    const arg = launchArgs[i]!;
    if (arg === '--') break;
    if (arg === MADMAX_FLAG || arg === '--madmax-spark') madmax = true;
    else if (arg === HIGH_REASONING_FLAG || arg === XHIGH_REASONING_FLAG) reasoning = arg;
    else if ((arg === '--model' || arg === '-m') && launchArgs[i + 1]) { model = launchArgs[i + 1]; i += 1; }
    else if (arg.startsWith('--model=')) model = arg.slice('--model='.length);
  }
  if (madmax) flags.push(MADMAX_FLAG);
  if (reasoning) flags.push(reasoning);
  if (model) flags.push('--model', shellQuote(model));
  return flags;
}

/** Resume uses only Codex's own syntax: `resume <session-id>`. */
export function buildResumeCommand(input: ResumeBlockInput): string | null {
  if (!input.sessionId) return null;
  const flags = contextFlags(input.launchArgs);
  if (input.projectLocalHome) flags.push('--project');
  const omx = ['omx', ...flags, 'resume', shellQuote(input.sessionId)].join(' ');
  const madmax = flags.includes(MADMAX_FLAG);
  const cdTarget = input.worktree?.path ?? (madmax ? input.launchCwd : undefined);
  return cdTarget ? `cd ${shellQuote(cdTarget)} && ${omx}` : omx;
}

export function formatResumeBlock(input: ResumeBlockInput): string {
  const lines: string[] = [];
  if (input.madmaxStateDir) lines.push(`[omx] madmax isolated state: ${input.madmaxStateDir} (source: ${input.launchCwd})`);
  if (input.worktree) {
    lines.push(`[omx] worktree: ${input.worktree.name || basename(input.worktree.path)} (${input.worktree.path})`);
  }
  const command = buildResumeCommand(input);
  if (!command) {
    lines.push('[omx] No Codex session id was captured for this run, so there is no resume command to print.');
    lines.push('[omx] To pick up the newest session in this context, run: omx resume --last');
    return `${lines.join('\n')}\n`;
  }
  lines.push(`[omx] Session id: ${input.sessionId}`);
  lines.push('[omx] To resume this session, run:');
  lines.push(`  ${command}`);
  return `${lines.join('\n')}\n`;
}
