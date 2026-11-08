import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { TeamTask } from './state.js';
import { hasStructuredVerificationEvidence } from '../verification/verifier.js';
import { TEAM_NAME_SAFE_PATTERN, TASK_ID_SAFE_PATTERN } from './contracts.js';

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
    && !/^(?:todo|tbd|placeholder|pending|not run)[.!]?$/i.test(value.trim());
}

function hasCompletionEvidenceContent(evidence: Record<string, unknown>): boolean {
  return text(evidence.summary) && Array.isArray(evidence.verification) && evidence.verification.length > 0
    && evidence.verification.every((check: unknown) => {
      if (!check || typeof check !== 'object') return false;
      const value = check as Record<string, unknown>;
      return text(value.command) && value.result === 'passed' && text(value.output);
    }) && Array.isArray(evidence.unverified) && evidence.unverified.every(text);
}

export function isCompletionEvidenceReport(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const evidence = value as Record<string, unknown>;
  return typeof evidence.teamName === 'string' && TEAM_NAME_SAFE_PATTERN.test(evidence.teamName)
    && typeof evidence.taskId === 'string' && TASK_ID_SAFE_PATTERN.test(evidence.taskId)
    && typeof evidence.claimTokenSha256 === 'string' && /^[a-f0-9]{64}$/.test(evidence.claimTokenSha256)
    && typeof evidence.verifiedHead === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(evidence.verifiedHead)
    && hasCompletionEvidenceContent(evidence);
}

export async function validateCompletionEvidence(
  cwd: string, teamName: string, task: TeamTask, result: string | undefined,
): Promise<string> {
  const path = /^\s*EVIDENCE_RECORDED:\s*(\S+)\s*$/m.exec(result ?? '')?.[1];
  if (!path) throw new Error('Include EVIDENCE_RECORDED: .omx/evidence/<file>.json in the completion result.');
  const target = resolve(cwd, path);
  const rel = relative(resolve(cwd, '.omx/evidence'), target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Evidence must be inside .omx/evidence.');
  let current = await realpath(cwd);
  for (const part of relative(resolve(cwd), target).split(/[/\\]/)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Evidence paths must not contain symlinks.');
  }
  const stat = await lstat(target);
  if (!stat.isFile() || stat.size === 0 || stat.size > 1024 * 1024) throw new Error('Evidence must be a non-empty JSON file of at most 1 MiB.');
  const since = Date.parse(task.claim?.claimed_at ?? task.created_at);
  // Claim timestamps have millisecond precision, while some filesystems round
  // mtimes down (and FAT timestamps have a two-second resolution).
  if (!Number.isFinite(since) || stat.mtimeMs < since - 2_000) throw new Error('Evidence predates the current task claim.');
  const evidence = JSON.parse(await readFile(target, 'utf8'));
  const claimHash = createHash('sha256').update(task.claim?.token ?? '').digest('hex');
  if (!evidence || evidence.teamName !== teamName || evidence.taskId !== task.id || evidence.claimTokenSha256 !== claimHash) {
    throw new Error('Evidence must belong to this team, task, and current claim.');
  }
  if (!hasCompletionEvidenceContent(evidence)) {
    throw new Error('Evidence requires summary, passing verification checks (command/result/output), and an unverified array.');
  }
  const verificationSummary = (result ?? '').replace(/^\s*EVIDENCE_RECORDED:\s*\S+\s*$/gm, '');
  if (!hasStructuredVerificationEvidence(verificationSummary)) {
    throw new Error('Include a Verification: section with PASS/FAIL checks or command references in the completion result.');
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(evidence.verifiedHead ?? '') || evidence.verifiedHead !== head) {
    throw new Error('Evidence verifiedHead must match the current committed worker HEAD.');
  }
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'], { cwd, encoding: 'utf8' });
  if (dirty.trim()) throw new Error('Commit worker changes before verifying and completing the task; the worktree must be clean.');
  return head;
}
