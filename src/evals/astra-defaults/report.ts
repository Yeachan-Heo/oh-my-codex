import type { EvalConfig, EvalSuite, RunRecord, TaskFrequencies, Usage } from './types.js';

export interface ConfigSummary {
  configId: string;
  total: number;
  passed: number;
  failed: number;
  errored: number;
  difficult: number;
  retries: number;
  /** null when any record is missing latency. */
  totalLatencyMs: number | null;
  /** null when any record is missing usage attribution; never silently zero. */
  totalUsage: Usage | null;
  usageAttributionComplete: boolean;
  /** Operator effort stays separate so model savings cannot hide human work. */
  totalOperatorMinutes: number | null;
  operatorAttributionComplete: boolean;
}

export function summarize(records: RunRecord[], configId: string): ConfigSummary {
  const rows = records.filter((record) => record.configId === configId);
  let latency: number | null = 0;
  let usage: Usage | null = { inputTokens: 0, outputTokens: 0 };
  let operator: number | null = 0;
  for (const row of rows) {
    if (row.latencyMs === null) latency = null;
    else if (latency !== null) latency += row.latencyMs;
    if (row.usage === null) usage = null;
    else if (usage !== null) {
      usage.inputTokens += row.usage.inputTokens;
      usage.outputTokens += row.usage.outputTokens;
    }
    if (row.operatorMinutes === null) operator = null;
    else if (operator !== null) operator += row.operatorMinutes;
  }
  return {
    configId,
    total: rows.length,
    passed: rows.filter((row) => row.outcome === 'pass').length,
    failed: rows.filter((row) => row.outcome === 'fail').length,
    errored: rows.filter((row) => row.outcome === 'error').length,
    difficult: rows.filter((row) => row.difficult).length,
    retries: rows.reduce((sum, row) => sum + row.retries, 0),
    totalLatencyMs: latency,
    totalUsage: usage,
    usageAttributionComplete: usage !== null,
    totalOperatorMinutes: operator,
    operatorAttributionComplete: operator !== null,
  };
}

export interface WeightedResult {
  configId: string;
  weightedPassRate: number;
}

/**
 * Workload-weighted results are only produced when every evaluated fixture has
 * a documented frequency. Otherwise callers must report per-task results and
 * make no representative-savings claim.
 */
export function weightedPassRates(
  suite: EvalSuite,
  records: RunRecord[],
  frequencies: TaskFrequencies | null,
): WeightedResult[] | null {
  if (!frequencies) return null;
  const evaluated = [...new Set(records.map((record) => record.fixtureId))];
  if (evaluated.some((id) => typeof frequencies[id] !== 'number')) return null;
  const totalWeight = evaluated.reduce((sum, id) => sum + frequencies[id], 0);
  if (totalWeight <= 0) return null;
  const configIds = [...new Set(records.map((record) => record.configId))];
  return configIds.map((configId) => {
    const weighted = records
      .filter((record) => record.configId === configId && record.outcome === 'pass')
      .reduce((sum, record) => sum + frequencies[record.fixtureId], 0);
    return { configId, weightedPassRate: weighted / totalWeight };
  });
}

function num(value: number | null): string {
  return value === null ? 'unknown' : String(value);
}

function configTable(configs: EvalConfig[], surfaces: string[]): string {
  const header = `| config | baseline | omx revision | service tier | cache | ${surfaces.join(' | ')} |`;
  const divider = `| --- | --- | --- | --- | --- | ${surfaces.map(() => '---').join(' | ')} |`;
  const rows = configs.map((config) => {
    const cells = surfaces.map((surface) => {
      const role = config.roles[surface];
      return role ? `${role.model} / ${role.reasoningEffort}` : 'unknown';
    });
    return `| ${config.id} | ${config.isBaseline ? 'yes' : 'no'} | ${config.omxRevision} | ${config.serviceTier} | ${config.cacheConditions} | ${cells.join(' | ')} |`;
  });
  return [header, divider, ...rows].join('\n');
}

export function renderReport(
  suite: EvalSuite,
  records: RunRecord[],
  frequencies: TaskFrequencies | null = null,
): string {
  const surfaces = [...new Set(suite.fixtures.map((fixture) => fixture.surface))];
  const configIds = [...new Set(records.map((record) => record.configId))];
  const summaries = configIds.map((configId) => summarize(records, configId));
  const lines: string[] = [];

  lines.push('# OMX default-model evaluation report');
  lines.push('');
  lines.push('## Configurations');
  lines.push(configTable(suite.configs, surfaces));
  lines.push('');

  lines.push('## Per-task results');
  lines.push(
    '| fixture | config | outcome | failed checks | retries | latency ms | usage | operator min |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const record of records) {
    const failed = record.checks.filter((check) => !check.passed).map((check) => check.name);
    const usage = record.usage
      ? `${record.usage.inputTokens}/${record.usage.outputTokens}`
      : 'unknown';
    lines.push(
      `| ${record.fixtureId} | ${record.configId} | ${record.outcome} | ${failed.join(', ') || '—'} | ${record.retries} | ${num(record.latencyMs)} | ${usage} | ${num(record.operatorMinutes)} |`,
    );
  }
  lines.push('');

  lines.push('## Aggregate per configuration');
  lines.push(
    '| config | pass | fail | error | difficult | retries | latency ms | usage | operator min |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const summary of summaries) {
    const usage = summary.totalUsage
      ? `${summary.totalUsage.inputTokens}/${summary.totalUsage.outputTokens}`
      : 'unknown';
    lines.push(
      `| ${summary.configId} | ${summary.passed} | ${summary.failed} | ${summary.errored} | ${summary.difficult} | ${summary.retries} | ${num(summary.totalLatencyMs)} | ${usage} | ${num(summary.totalOperatorMinutes)} |`,
    );
  }
  lines.push('');

  const failures = records.filter((record) => record.outcome !== 'pass' || record.difficult);
  lines.push('## Failed and difficult cases');
  if (failures.length === 0) lines.push('None recorded.');
  for (const record of failures) {
    const failed = record.checks.filter((check) => !check.passed);
    lines.push(
      `- \`${record.fixtureId}\` @ \`${record.configId}\`: ${record.outcome}${record.difficult ? ' (difficult)' : ''}` +
        (failed.length
          ? ` — ${failed.map((check) => `${check.name}: ${check.detail ?? 'failed'}`).join('; ')}`
          : ''),
    );
  }
  lines.push('');

  lines.push('## Cost claims');
  const incomplete = summaries.filter((summary) => !summary.usageAttributionComplete);
  if (incomplete.length > 0) {
    lines.push(
      `Usage attribution is incomplete for: ${incomplete.map((summary) => summary.configId).join(', ')}. No complete cost claim is made for those configurations.`,
    );
  } else {
    lines.push('Usage attribution is complete for every evaluated configuration.');
  }
  const operatorIncomplete = summaries.filter((summary) => !summary.operatorAttributionComplete);
  if (operatorIncomplete.length > 0) {
    lines.push(
      `Operator effort is unknown for: ${operatorIncomplete.map((summary) => summary.configId).join(', ')}; reduced model usage cannot be read as reduced total effort.`,
    );
  }
  lines.push('A lower token count alone is not a successful result.');
  lines.push('');

  lines.push('## Workload-weighted summary');
  const weighted = weightedPassRates(suite, records, frequencies);
  if (!weighted) {
    lines.push(
      'Not reported: documented, representative task frequencies are missing for at least one evaluated fixture. Per-task results above stand on their own and imply no representative savings.',
    );
  } else {
    for (const row of weighted) {
      lines.push(
        `- ${row.configId}: ${(row.weightedPassRate * 100).toFixed(1)}% weighted pass rate`,
      );
    }
  }
  lines.push('');

  lines.push('## Limitations');
  lines.push(
    '- Estimates (implementation/maintenance effort) are labeled separately from measurements.',
  );
  lines.push(
    '- Identical reasoning-effort labels across models do not establish equivalent quality or cost.',
  );
  lines.push(
    '- Codex-owned context, caching, and compaction behavior is not controlled by this suite; such fields are recorded as observed or `unknown`.',
  );
  return lines.join('\n');
}
