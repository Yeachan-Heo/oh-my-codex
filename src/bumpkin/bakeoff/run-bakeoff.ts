import type { PipelineDeps, PipelineInput } from '../pipeline.js';
import { runUpgradePipeline } from '../pipeline.js';
import type { UpgradeRunResult } from '../github/pr-opener.js';

export interface BakeoffCase {
  label: string;
  input: PipelineInput;
  depsFactory: () => PipelineDeps;
  expectedStatus: UpgradeRunResult['status'];
}

export interface BakeoffRunReport {
  total: number;
  passed: number;
  failed: number;
  byCase: Array<{
    label: string;
    status: UpgradeRunResult['status'];
    expected: UpgradeRunResult['status'];
    ok: boolean;
    escalationReason?: string;
    error?: string;
  }>;
}

export async function runBakeoff(cases: readonly BakeoffCase[]): Promise<BakeoffRunReport> {
  const report: BakeoffRunReport = { total: cases.length, passed: 0, failed: 0, byCase: [] };
  for (const bakeoffCase of cases) {
    try {
      const result = await runUpgradePipeline(bakeoffCase.input, bakeoffCase.depsFactory());
      const ok = result.status === bakeoffCase.expectedStatus;
      if (ok) report.passed += 1;
      else report.failed += 1;
      report.byCase.push({
        label: bakeoffCase.label,
        status: result.status,
        expected: bakeoffCase.expectedStatus,
        ok,
        ...(result.escalationReason ? { escalationReason: result.escalationReason } : {}),
      });
    } catch (err) {
      report.failed += 1;
      report.byCase.push({
        label: bakeoffCase.label,
        status: 'failed',
        expected: bakeoffCase.expectedStatus,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return report;
}

export function formatBakeoffReport(report: BakeoffRunReport): string {
  const lines: string[] = [];
  lines.push(`## Bakeoff report`);
  lines.push('');
  lines.push(`- Total: ${report.total}`);
  lines.push(`- Passed: ${report.passed}`);
  lines.push(`- Failed: ${report.failed}`);
  lines.push(
    `- Pass rate: ${report.total === 0 ? '-' : `${((report.passed / report.total) * 100).toFixed(1)}%`}`,
  );
  lines.push('');
  lines.push('| Case | Expected | Got | OK | Note |');
  lines.push('|---|---|---|---|---|');
  for (const entry of report.byCase) {
    const note = entry.error ?? entry.escalationReason ?? '';
    lines.push(
      `| ${entry.label} | ${entry.expected} | ${entry.status} | ${entry.ok ? '✅' : '❌'} | ${note} |`,
    );
  }
  return lines.join('\n');
}
