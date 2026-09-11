import { join } from 'node:path';
import { baselineRecord, loadSuite } from '../../evals/astra-defaults/suite.js';

const suiteDir = process.argv[2] ?? join(process.cwd(), 'missions', 'astra-default-evaluation');

try {
  const suite = loadSuite(suiteDir);
  const deterministic = suite.fixtures.filter((fixture) => fixture.deterministicBaseline);
  if (deterministic.length === 0) {
    throw new Error('suite declares no deterministic no-model baseline');
  }
  const records = deterministic.map((fixture) => baselineRecord(fixture));
  const passed = records.filter((record) => record.outcome === 'pass');
  const pass = passed.length === records.length;
  for (const record of records.filter((record) => record.outcome !== 'pass')) {
    process.stderr.write(
      `${record.fixtureId}: ${record.checks
        .filter((check) => !check.passed)
        .map((check) => `${check.name} ${check.detail ?? ''}`)
        .join('; ')}\n`,
    );
  }
  process.stdout.write(
    JSON.stringify({
      pass,
      score: Number((passed.length / records.length).toFixed(2)),
      fixtures: suite.fixtures.length,
      configs: suite.configs.length,
      deterministicBaselines: records.length,
    }),
  );
  process.exit(pass ? 0 : 1);
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.stdout.write(JSON.stringify({ pass: false, score: 0 }));
  process.exit(1);
}
