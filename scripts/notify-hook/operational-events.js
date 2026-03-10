import { execFileSync } from 'child_process';
import { basename, dirname } from 'path';
import { safeString } from './utils.js';

const TEST_SEGMENT_PATTERNS = [
  /^npm\s+(?:run\s+)?test\b/i,
  /^pnpm\s+test\b/i,
  /^yarn\s+test\b/i,
  /^bun\s+test\b/i,
  /^node\s+--test\b/i,
  /^python(?:3)?\s+-m\s+pytest\b/i,
  /^pytest\b/i,
  /^go\s+test\b/i,
  /^cargo\s+test\b/i,
  /^uv\s+run\s+pytest\b/i,
];

const PR_CREATE_SEGMENT_RE = /^gh\s+pr\s+create\b/i;
const SEARCH_SEGMENT_RE = /^(?:rg|grep|ag|ack|find|sed|awk|cat|printf|echo)\b/i;
const HANDOFF_PATTERNS = [
  /\bhandoff\b/i,
  /\bhand off\b/i,
  /\bnext i can do one of\b/i,
  /\bif you want, next i can\b/i,
  /\bchoose one of\b/i,
  /\brecommended handoff\b/i,
];
const RETRY_PATTERNS = [
  /\bretry\b/i,
  /\brerun\b/i,
  /\bre-run\b/i,
  /\btry again\b/i,
];

function gitValue(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
  } catch {
    return '';
  }
}

function shellSegments(command) {
  return safeString(command)
    .split(/(?:&&|\|\||;|\n)/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function sanitizeTmuxToken(value) {
  const cleaned = safeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'unknown';
}

function buildTmuxSessionName(cwd, sessionId) {
  const parentDir = basename(dirname(cwd));
  const dirName = basename(cwd);
  const dirToken = parentDir.endsWith('.omx-worktrees')
    ? sanitizeTmuxToken(`${parentDir.slice(0, -'.omx-worktrees'.length)}-${dirName}`)
    : sanitizeTmuxToken(dirName);
  const branch = gitValue(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branchToken = branch ? sanitizeTmuxToken(branch) : 'detached';
  const sessionToken = sanitizeTmuxToken(safeString(sessionId).replace(/^omx-/, ''));
  const name = `omx-${dirToken}-${branchToken}-${sessionToken}`;
  return name.length > 120 ? name.slice(0, 120) : name;
}

export function resolveOperationalSessionName(cwd, sessionId = '', sessionName = '') {
  const explicit = safeString(sessionName).trim();
  if (explicit) return explicit;

  if (process.env.TMUX) {
    try {
      const tmuxSession = execFileSync('tmux', ['display-message', '-p', '#S'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      }).trim();
      if (tmuxSession) return tmuxSession;
    } catch {
      // best effort only
    }
  }

  const normalizedSessionId = safeString(sessionId).trim();
  if (!normalizedSessionId) return undefined;
  return buildTmuxSessionName(cwd, normalizedSessionId);
}

export function readRepositoryMetadata(cwd) {
  const worktreePath = safeString(cwd).trim();
  const repoPath = gitValue(worktreePath, ['rev-parse', '--show-toplevel']) || worktreePath;
  const branch = gitValue(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']) || undefined;
  return {
    repo_path: repoPath,
    repo_name: basename(repoPath || worktreePath),
    worktree_path: worktreePath,
    branch,
  };
}

export function extractIssueNumber(text) {
  const source = safeString(text);
  const explicit = source.match(/\bissue\s*#(\d+)\b/i);
  if (explicit) return Number.parseInt(explicit[1], 10);
  const generic = source.match(/(^|[^\w/])#(\d+)\b/);
  return generic ? Number.parseInt(generic[2], 10) : undefined;
}

export function extractPrInfo(text) {
  const source = safeString(text);
  const urlMatch = source.match(/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/i);
  if (urlMatch) {
    return {
      pr_number: Number.parseInt(urlMatch[1], 10),
      pr_url: urlMatch[0],
    };
  }
  const refMatch = source.match(/\b(?:pr|pull request)\s*#(\d+)\b/i);
  if (refMatch) {
    return {
      pr_number: Number.parseInt(refMatch[1], 10),
    };
  }
  return {};
}

export function extractErrorSummary(text, maxLength = 240) {
  const source = safeString(text).trim();
  if (!source) return undefined;
  const lines = source.split('\n').map((line) => line.trim()).filter(Boolean);
  const preferred = [...lines].reverse().find((line) => /(error|failed|exception|invalid|timed out|timeout)/i.test(line));
  const summary = preferred || lines.at(-1) || source;
  return summary.length > maxLength ? `${summary.slice(0, maxLength - 1)}…` : summary;
}

export function parseExecCommandArgs(rawArguments) {
  try {
    const parsed = JSON.parse(safeString(rawArguments));
    return {
      command: safeString(parsed?.cmd).trim(),
      workdir: safeString(parsed?.workdir).trim(),
    };
  } catch {
    return { command: '', workdir: '' };
  }
}

export function classifyExecCommand(command) {
  const source = safeString(command).trim();
  if (!source) return null;

  for (const segment of shellSegments(source)) {
    if (SEARCH_SEGMENT_RE.test(segment)) continue;
    if (PR_CREATE_SEGMENT_RE.test(segment)) {
      return { kind: 'pr-create', command: source };
    }
    if (TEST_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment))) {
      return { kind: 'test', command: source };
    }
  }

  return null;
}

export function parseCommandResult(rawOutput) {
  const output = safeString(rawOutput);
  const exitMatch = output.match(/Process exited with code (\d+)/i);
  const exitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : undefined;
  const success = exitCode === undefined ? undefined : exitCode === 0;
  return {
    exit_code: exitCode,
    success,
    ...extractPrInfo(output),
    error_summary: success === false ? extractErrorSummary(output) : undefined,
  };
}

export function buildOperationalContext({
  cwd,
  normalizedEvent,
  sessionId = '',
  sessionName = '',
  text = '',
  output = '',
  command = '',
  toolName = '',
  status = '',
  issueNumber,
  prNumber,
  prUrl,
  errorSummary,
  extra = {},
}) {
  const repoMeta = readRepositoryMetadata(cwd);
  const referenceText = [text, output, command, repoMeta.branch, repoMeta.worktree_path].filter(Boolean).join('\n');
  const detectedIssue = issueNumber ?? extractIssueNumber(referenceText);
  const detectedPrInfo = {
    ...extractPrInfo(referenceText),
    ...(prNumber !== undefined ? { pr_number: prNumber } : {}),
    ...(prUrl !== undefined ? { pr_url: prUrl } : {}),
  };
  const resolvedSessionName = resolveOperationalSessionName(cwd, sessionId, sessionName);

  return {
    normalized_event: normalizedEvent,
    ...(resolvedSessionName ? { session_name: resolvedSessionName } : {}),
    ...repoMeta,
    ...(detectedIssue !== undefined ? { issue_number: detectedIssue } : {}),
    ...(detectedPrInfo.pr_number !== undefined ? { pr_number: detectedPrInfo.pr_number } : {}),
    ...(detectedPrInfo.pr_url ? { pr_url: detectedPrInfo.pr_url } : {}),
    ...(command ? { command } : {}),
    ...(toolName ? { tool_name: toolName } : {}),
    ...(status ? { status } : {}),
    ...(errorSummary ? { error_summary: errorSummary } : {}),
    ...extra,
  };
}

export function deriveAssistantSignalEvents(message) {
  const text = safeString(message).trim();
  if (!text) return [];

  const signals = [];
  const handoff = HANDOFF_PATTERNS.some((pattern) => pattern.test(text));
  const retryNeeded = RETRY_PATTERNS.some((pattern) => pattern.test(text));

  if (handoff) {
    signals.push({
      event: 'handoff-needed',
      normalized_event: 'handoff-needed',
      parser_reason: 'assistant_message_handoff',
      confidence: 0.8,
    });
  }

  if (retryNeeded) {
    signals.push({
      event: 'retry-needed',
      normalized_event: 'retry-needed',
      parser_reason: 'assistant_message_retry',
      confidence: 0.78,
    });
  }

  return signals;
}
