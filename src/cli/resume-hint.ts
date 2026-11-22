import { basename } from 'node:path';
import { MADMAX_FLAG, HIGH_REASONING_FLAG, XHIGH_REASONING_FLAG } from './constants.js';
import { classifySessionStateLiveness, type SessionState } from '../hooks/session.js';
import { resolveTmuxBinaryForPlatform } from '../utils/platform-command.js';

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
  /** Session owner process information (pid, platform, tmux session name, and state for liveness classification). */
  ownerInfo?: {
    pid: number;
    platform: NodeJS.Platform;
    tmuxSessionName?: string;
    state?: SessionState;
  };
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Extract the -C/--cd directory override from Codex args.
 * Codex uses -C or --cd to override the working directory.
 */
export function extractCodexDirectoryOverride(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '-C' || arg === '--cd') {
      if (args[i + 1]) {
        return args[i + 1];
      }
    } else if (arg.startsWith('--cd=')) {
      return arg.slice('--cd='.length);
    }
  }
  return undefined;
}

/**
 * Compute the effective working directory where a session will be created.
 * When a worktree is enabled, the session cwd will be the worktree path.
 * When a -C/--cd override is used, the session cwd will be the override directory.
 * Otherwise, it will be the launch cwd.
 */
export function resolveEffectiveSessionCwd(
  launchCwd: string,
  worktreeEnabled: boolean,
  worktreePath?: string,
  codexDirOverride?: string,
): string {
  // Worktree takes precedence over -C override
  if (worktreeEnabled && worktreePath) return worktreePath;
  // -C/--cd override determines the actual cwd where Codex runs
  if (codexDirOverride) return codexDirOverride;
  return launchCwd;
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

/**
 * Build a tmux attach command to reattach to a live session.
 * When the session owner is still alive and has an active tmux session,
 * suggest tmux attach instead of omx resume.
 */
function buildTmuxAttachCommand(tmuxBinary: string, tmuxSessionName: string): string {
  return `${shellQuote(tmuxBinary)} attach -t ${shellQuote(tmuxSessionName)}`;
}

/**
 * Build an omx resume command for a known-dead owner.
 */
function buildOmxResumeCommand(sessionId: string, input: ResumeBlockInput): string {
  const flags = contextFlags(input.launchArgs);
  if (input.projectLocalHome) flags.push('--project');
  const omx = ['omx', ...flags, 'resume', shellQuote(sessionId)].join(' ');
  const madmax = flags.includes(MADMAX_FLAG);
  const cdTarget = input.worktree?.path ?? (madmax ? input.launchCwd : undefined);
  return cdTarget ? `cd ${shellQuote(cdTarget)} && ${omx}` : omx;
}

/** Resume uses only Codex's own syntax: `resume <session-id>`, or tmux reattach if owner is alive. */
export function buildResumeCommand(input: ResumeBlockInput): string | null {
  if (!input.sessionId) return null;
  
  // If the session owner state is available, classify its liveness properly.
  if (input.ownerInfo?.state) {
    const liveness = classifySessionStateLiveness(input.ownerInfo.state);
    
    // Only 'usable' and 'identity-indeterminate' are candidates for tmux attach or omx doctor.
    // 'non-runtime-owner' and 'stale-dead' always use omx resume.
    if (liveness === 'usable' || liveness === 'identity-indeterminate') {
      if (input.ownerInfo.tmuxSessionName) {
        // Try tmux attach if session is active
        const tmuxBinary = resolveTmuxBinaryForPlatform(input.ownerInfo.platform) ?? 'tmux';
        return buildTmuxAttachCommand(tmuxBinary, input.ownerInfo.tmuxSessionName);
      } else {
        // No tmux session, suggest omx doctor to diagnose the owner state
        return 'omx doctor';
      }
    }
    
    // 'non-runtime-owner' or 'stale-dead' always use omx resume
    return buildOmxResumeCommand(input.sessionId, input);
  }
  
  // Fallback: without state, always use omx resume
  return buildOmxResumeCommand(input.sessionId, input);
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
