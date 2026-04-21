import type { ModelProvider } from '../model/provider.js';
import {
  evaluateReviewer,
  type EvalCase,
  type EvalReport,
  type ReviewInput,
} from '../skills/llm-reviewer.js';

export interface ReviewerEvalCorpus {
  kind: 'reviewer';
  cases: Array<{ label: string; input: ReviewInput; expectedVerdict: 'APPROVE' | 'REJECT' }>;
}

export interface EvalRunOptions {
  provider: ModelProvider;
  corpus: ReviewerEvalCorpus;
  thresholds?: { minPrecision?: number; minRecall?: number };
}

export interface EvalRunResult {
  report: EvalReport;
  meetsThresholds: boolean;
  failures: string[];
}

export async function runEval(opts: EvalRunOptions): Promise<EvalRunResult> {
  const cases: EvalCase[] = opts.corpus.cases.map((c) => ({
    label: c.label,
    input: c.input,
    expectedVerdict: c.expectedVerdict,
  }));
  const report = await evaluateReviewer(opts.provider, cases);

  const failures: string[] = [];
  const minP = opts.thresholds?.minPrecision ?? 0.95;
  const minR = opts.thresholds?.minRecall ?? 0.8;
  if (report.precision < minP) {
    failures.push(`precision ${report.precision.toFixed(3)} < required ${minP}`);
  }
  if (report.recall < minR) {
    failures.push(`recall ${report.recall.toFixed(3)} < required ${minR}`);
  }

  return {
    report,
    meetsThresholds: failures.length === 0,
    failures,
  };
}

export function parseCorpusFromJsonl(jsonl: string): ReviewerEvalCorpus {
  const cases: ReviewerEvalCorpus['cases'] = [];
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const obj = JSON.parse(trimmed) as {
      label?: string;
      input?: ReviewInput;
      expectedVerdict?: 'APPROVE' | 'REJECT';
    };
    if (!obj.label || !obj.input || (obj.expectedVerdict !== 'APPROVE' && obj.expectedVerdict !== 'REJECT')) {
      throw new Error(`invalid corpus line: ${trimmed.slice(0, 120)}`);
    }
    cases.push({ label: obj.label, input: obj.input, expectedVerdict: obj.expectedVerdict });
  }
  return { kind: 'reviewer', cases };
}

export function formatEvalReport(label: string, result: EvalRunResult): string {
  const lines: string[] = [];
  lines.push(`## Eval report: ${label}`);
  lines.push('');
  lines.push(`- Total cases: ${result.report.total}`);
  lines.push(`- Correct: ${result.report.correct}`);
  lines.push(`- Precision: ${result.report.precision.toFixed(3)}`);
  lines.push(`- Recall: ${result.report.recall.toFixed(3)}`);
  lines.push(
    `- TP=${result.report.truePositives} FP=${result.report.falsePositives} ` +
      `FN=${result.report.falseNegatives} TN=${result.report.trueNegatives}`,
  );
  lines.push('');
  lines.push(result.meetsThresholds ? '✅ Passes thresholds' : '❌ Fails thresholds');
  if (result.failures.length > 0) {
    for (const f of result.failures) lines.push(`- ${f}`);
  }
  return lines.join('\n');
}
