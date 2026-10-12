import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { loadSuite } from '../../evals/astra-defaults/suite.js';
import { collectMatrix } from '../../evals/astra-defaults/collector.js';
import { renderReport } from '../../evals/astra-defaults/report.js';
import type { RunRecord } from '../../evals/astra-defaults/types.js';

/**
 * Live collector runner for astra-defaults evaluation.
 * Usage:
 *   node dist/scripts/eval/collect-astra-defaults.js [suite-dir] [output-file] [--provider <name>] [config-ids...]
 *
 * Examples:
 *   # Run all configs
 *   node dist/scripts/eval/collect-astra-defaults.js
 *
 *   # Run specific configs only
 *   node dist/scripts/eval/collect-astra-defaults.js \
 *     missions/astra-default-evaluation \
 *     records.json \
 *     astra-defaults gpt-6.1-sol-candidate gpt-6-sol-control luna-uniform
 *
 *   # Run with custom provider (e.g., Layofflabs)
 *   node dist/scripts/eval/collect-astra-defaults.js \
 *     missions/astra-default-evaluation \
 *     records.json \
 *     --provider layofflabs \
 *     gpt-6.1-sol-candidate gpt-6-sol-control
 */

interface CollectionStats {
  total: number;
  passed: number;
  failed: number;
  error: number;
  totalLatencyMs: number;
  startTime: string;
  endTime: string;
}

async function main() {
  const args = process.argv.slice(2);

  const suiteDir = args[0] && !args[0].startsWith('--')
    ? args.shift()!
    : join(process.cwd(), 'missions', 'astra-default-evaluation');

  const outputFile = args[0] && !args[0].startsWith('--')
    ? args.shift()!
    : join(process.cwd(), 'astra-defaults-records.json');

  let provider: string | undefined;
  if (args[0] === '--provider') {
    args.shift();
    provider = args.shift();
    if (!provider) {
      throw new Error('--provider requires a provider name argument');
    }
  }

  const configIds = args.length > 0 ? args : ['astra-defaults', 'gpt-6.1-sol-candidate', 'gpt-6-sol-control', 'luna-uniform'];

  process.stderr.write(`Loading suite from ${suiteDir}...\n`);
  const suite = loadSuite(suiteDir);

  // Filter to requested configs only
  const configs = suite.configs.filter((c) => configIds.includes(c.id));
  if (configs.length === 0) {
    throw new Error(`No configs found matching: ${configIds.join(', ')}`);
  }

  process.stderr.write(
    `Collecting records for ${configs.length} config(s) x ${suite.fixtures.length} fixture(s)\n`,
  );
  process.stderr.write(`Output will be written to: ${outputFile}\n\n`);

  const records: RunRecord[] = [];
  const stats: CollectionStats = {
    total: 0,
    passed: 0,
    failed: 0,
    error: 0,
    totalLatencyMs: 0,
    startTime: new Date().toISOString(),
    endTime: '',
  };

  let aborted = false;

  for await (const { fixture, config, result } of collectMatrix(suite.fixtures, configs, { provider })) {
    stats.total++;
    const { record } = result;
    records.push(record);

    const latency = record.latencyMs ?? 0;
    stats.totalLatencyMs += latency;

    if (record.outcome === 'pass') stats.passed++;
    else if (record.outcome === 'fail') stats.failed++;
    else stats.error++;

    const statusEmoji = record.outcome === 'pass' ? '✓' : record.outcome === 'fail' ? '✗' : '⚠';
    const configIdPad = config.id.padEnd(25);
    const fixtureIdPad = fixture.id.padEnd(35);
    process.stderr.write(
      `${statusEmoji} ${configIdPad} ${fixtureIdPad} (${latency}ms)\n`,
    );

    // Abort if any single run exceeds 15 minutes
    if (latency > 15 * 60 * 1000) {
      process.stderr.write(`\nAborting: run exceeded 15 minute timeout\n`);
      aborted = true;
      break;
    }
  }

  stats.endTime = new Date().toISOString();

  // Write records to file
  const output = {
    evidence: 'observed' as const,
    records,
  };

  writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf-8');

  // Print summary
  process.stderr.write(`\n${'='.repeat(70)}\n`);
  process.stderr.write(`Collection Summary\n`);
  process.stderr.write(`${'='.repeat(70)}\n`);
  process.stderr.write(`Total runs:    ${stats.total}\n`);
  process.stderr.write(`Passed:        ${stats.passed}\n`);
  process.stderr.write(`Failed:        ${stats.failed}\n`);
  process.stderr.write(`Error:         ${stats.error}\n`);
  process.stderr.write(`Total latency: ${(stats.totalLatencyMs / 1000 / 60).toFixed(1)} minutes\n`);
  process.stderr.write(`Start time:    ${stats.startTime}\n`);
  process.stderr.write(`End time:      ${stats.endTime}\n`);
  process.stderr.write(`Records saved: ${outputFile}\n`);

  if (aborted) {
    process.stderr.write(`\nCollection was ABORTED due to timeout exceeded.\n`);
    process.exit(1);
  }

  // Generate and output report
  process.stdout.write(
    `\n${renderReport(suite, records, null, 'observed')}\n`,
  );

  process.exit(stats.error > 0 || stats.failed > 0 ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
