import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { TeamTask } from './state.js';
import { hasStructuredVerificationEvidence } from '../verification/verifier.js';

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
    && !/^(?:todo|tbd|placeholder|pending|not run)[.!]?$/i.test(value.trim());
}

export async function validateCompletionEvidence(
  cwd: string, teamName: string, task: TeamTask, result: string | undefined,
): Promise<void> {
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
  if (!text(evidence.summary) || !Array.isArray(evidence.verification) || !evidence.verification.length
    || evidence.verification.some((check: unknown) => {
      if (!check || typeof check !== 'object') return true;
      const value = check as Record<string, unknown>;
      return !text(value.command) || value.result !== 'passed' || !text(value.output);
    }) || !Array.isArray(evidence.unverified) || evidence.unverified.some((item: unknown) => !text(item))) {
    throw new Error('Evidence requires summary, passing verification checks (command/result/output), and an unverified array.');
  }
  const verificationSummary = (result ?? '').replace(/^\s*EVIDENCE_RECORDED:\s*\S+\s*$/gm, '');
  if (!hasStructuredVerificationEvidence(verificationSummary)) {
    throw new Error('Include a Verification: section with PASS/FAIL checks or command references in the completion result.');
  }
}
