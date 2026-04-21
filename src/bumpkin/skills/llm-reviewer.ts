import type { ModelProvider, ModelRequest } from '../model/provider.js';

export type ReviewVerdict = 'APPROVE' | 'REJECT';

export interface ReviewInput {
  diff: string;
  failingTestOutput: string;
  releaseNotes: string;
  libraryName: string;
  fromVersion: string;
  toVersion: string;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  rationale: string;
  raw: string;
}

export const REVIEWER_SYSTEM_PROMPT =
  'You are Bumpkin\'s independent code reviewer, a SECOND model whose only job is ' +
  'to detect semantically wrong fixes that happen to make tests pass. Read the ' +
  'diff, the original failing test output, and the library release notes. Decide ' +
  'APPROVE only if the fix semantically aligns with the documented API change. ' +
  'Respond with JSON: {"verdict": "APPROVE"|"REJECT", "rationale": "..."}.';

export function buildReviewerRequest(input: ReviewInput): ModelRequest {
  const user =
    `Library: ${input.libraryName} ${input.fromVersion} -> ${input.toVersion}\n\n` +
    `Release notes:\n${input.releaseNotes}\n\n` +
    `Original failing test output:\n${input.failingTestOutput}\n\n` +
    `Proposed diff:\n${input.diff}`;
  return {
    system: REVIEWER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: user }],
  };
}

export class ReviewerResponseError extends Error {}

export function parseReviewerResponse(raw: string): ReviewResult {
  let parsed: { verdict?: string; rationale?: string };
  try {
    parsed = JSON.parse(raw) as { verdict?: string; rationale?: string };
  } catch (e) {
    throw new ReviewerResponseError(`reviewer output was not JSON: ${(e as Error).message}`);
  }
  if (parsed.verdict !== 'APPROVE' && parsed.verdict !== 'REJECT') {
    throw new ReviewerResponseError(
      `reviewer verdict must be APPROVE or REJECT, got ${String(parsed.verdict)}`,
    );
  }
  return {
    verdict: parsed.verdict,
    rationale: parsed.rationale ?? '',
    raw,
  };
}

export async function reviewFix(
  provider: ModelProvider,
  input: ReviewInput,
): Promise<ReviewResult> {
  const response = await provider.call(buildReviewerRequest(input));
  return parseReviewerResponse(response.content);
}

export interface EvalCase {
  label: string;
  input: ReviewInput;
  expectedVerdict: ReviewVerdict;
}

export interface EvalReport {
  total: number;
  correct: number;
  precision: number;
  recall: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
}

export async function evaluateReviewer(
  provider: ModelProvider,
  cases: readonly EvalCase[],
): Promise<EvalReport> {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const c of cases) {
    const result = await reviewFix(provider, c.input);
    const predictedApprove = result.verdict === 'APPROVE';
    const actualApprove = c.expectedVerdict === 'APPROVE';
    if (predictedApprove && actualApprove) tp += 1;
    else if (predictedApprove && !actualApprove) fp += 1;
    else if (!predictedApprove && actualApprove) fn += 1;
    else tn += 1;
  }
  const correct = tp + tn;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  return {
    total: cases.length,
    correct,
    precision,
    recall,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
  };
}
