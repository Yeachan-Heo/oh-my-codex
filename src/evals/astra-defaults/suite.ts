import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CheckResult,
  EvalConfig,
  EvalFixture,
  EvalSuite,
  QualityCheck,
  RunRecord,
} from './types.js';

export class EvalSuiteError extends Error {}

function readJsonDir<T>(dir: string): T[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    throw new EvalSuiteError(`missing suite directory: ${dir}`);
  }
  entries.sort();
  return entries.map((name) => {
    const path = join(dir, name);
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as T;
    } catch (error) {
      throw new EvalSuiteError(`invalid JSON in ${path}: ${(error as Error).message}`);
    }
  });
}

const SURFACES = new Set(['explore', 'executor', 'code-reviewer', 'team-worker', 'sparkshell']);

function validateFixture(fixture: EvalFixture): void {
  if (!fixture.id) throw new EvalSuiteError('fixture is missing an id');
  if (!SURFACES.has(fixture.surface)) {
    throw new EvalSuiteError(`fixture ${fixture.id} has unknown surface ${fixture.surface}`);
  }
  if (!fixture.prompt?.trim()) {
    throw new EvalSuiteError(`fixture ${fixture.id} is missing a prompt`);
  }
  if (!Array.isArray(fixture.checks) || fixture.checks.length === 0) {
    throw new EvalSuiteError(`fixture ${fixture.id} declares no quality checks`);
  }
  for (const check of fixture.checks) {
    if (!check.name) throw new EvalSuiteError(`fixture ${fixture.id} has an unnamed check`);
    if (!Array.isArray(check.values) || check.values.length === 0) {
      throw new EvalSuiteError(`check ${fixture.id}/${check.name} has no values`);
    }
  }
  const baseline = fixture.deterministicBaseline;
  if (baseline && !(baseline.source in fixture.inputs)) {
    throw new EvalSuiteError(
      `fixture ${fixture.id} baseline references missing input ${baseline.source}`,
    );
  }
  // Model configuration must never leak into a task fixture.
  for (const key of ['model', 'models', 'reasoningEffort', 'config'] as const) {
    if (key in (fixture as unknown as Record<string, unknown>)) {
      throw new EvalSuiteError(`fixture ${fixture.id} must not pin model configuration (${key})`);
    }
  }
}

function validateConfigs(configs: EvalConfig[], fixtures: EvalFixture[]): void {
  if (configs.length === 0) throw new EvalSuiteError('suite declares no configurations');
  const baselines = configs.filter((config) => config.isBaseline);
  if (baselines.length !== 1) {
    throw new EvalSuiteError(`suite must declare exactly one baseline, found ${baselines.length}`);
  }
  const surfaces = new Set(fixtures.map((fixture) => fixture.surface));
  for (const config of configs) {
    if (!config.id) throw new EvalSuiteError('configuration is missing an id');
    if (!config.omxRevision?.trim()) {
      throw new EvalSuiteError(`configuration ${config.id} is not pinned to an OMX revision`);
    }
    if (!config.serviceTier?.trim() || !config.cacheConditions?.trim()) {
      throw new EvalSuiteError(
        `configuration ${config.id} must record serviceTier and cacheConditions ("unknown" is allowed)`,
      );
    }
    for (const surface of surfaces) {
      const role = config.roles?.[surface];
      if (!role?.model?.trim() || !role?.reasoningEffort?.trim()) {
        throw new EvalSuiteError(
          `configuration ${config.id} is missing effective model/effort for ${surface}`,
        );
      }
    }
  }
}

export function validateSuite(suite: EvalSuite): EvalSuite {
  if (suite.fixtures.length === 0) throw new EvalSuiteError('suite declares no fixtures');
  const seen = new Set<string>();
  for (const fixture of suite.fixtures) {
    validateFixture(fixture);
    if (seen.has(fixture.id)) throw new EvalSuiteError(`duplicate fixture id ${fixture.id}`);
    seen.add(fixture.id);
  }
  validateConfigs(suite.configs, suite.fixtures);
  return suite;
}

export function loadSuite(suiteDir: string): EvalSuite {
  const suite: EvalSuite = {
    fixtures: readJsonDir<EvalFixture>(join(suiteDir, 'fixtures')),
    configs: readJsonDir<EvalConfig>(join(suiteDir, 'configs')),
  };
  return validateSuite(suite);
}

function tokenize(response: string): Set<string> {
  return new Set(
    response
      .split(/[\n,]/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0),
  );
}

function evaluateCheck(check: QualityCheck, response: string): CheckResult {
  const haystack = response.toLowerCase();
  if (check.kind === 'must-include') {
    const missing = check.values.filter((value) => !haystack.includes(value.toLowerCase()));
    return {
      name: check.name,
      kind: check.kind,
      passed: missing.length === 0,
      detail: missing.length ? `missing: ${missing.join(', ')}` : undefined,
    };
  }
  if (check.kind === 'must-not-include') {
    const present = check.values.filter((value) => haystack.includes(value.toLowerCase()));
    return {
      name: check.name,
      kind: check.kind,
      passed: present.length === 0,
      detail: present.length ? `unsupported content: ${present.join(', ')}` : undefined,
    };
  }
  const actual = tokenize(response);
  const expected = new Set(check.values);
  const missing = [...expected].filter((value) => !actual.has(value));
  const extra = [...actual].filter((value) => !expected.has(value));
  return {
    name: check.name,
    kind: check.kind,
    passed: missing.length === 0 && extra.length === 0,
    detail:
      missing.length || extra.length
        ? `missing: [${missing.join(', ')}] extra: [${extra.join(', ')}]`
        : undefined,
  };
}

export function scoreResponse(fixture: EvalFixture, response: string): CheckResult[] {
  return fixture.checks.map((check) => evaluateCheck(check, response));
}

/** Deterministic, no-model answer for fixtures whose output contract permits it. */
export function runDeterministicBaseline(fixture: EvalFixture): string | null {
  const spec = fixture.deterministicBaseline;
  if (!spec) return null;
  const source = fixture.inputs[spec.source] ?? '';
  if (spec.extractor === 'failing-test-names') {
    const names: string[] = [];
    for (const line of source.split('\n')) {
      const match = /^\s*(?:not ok\s+\d+\s+-\s+|FAIL\s+)(.+?)\s*$/.exec(line);
      if (match) names.push(match[1]);
    }
    return names.join('\n');
  }
  const match = /^\s*exit(?:\s+code)?[:=]?\s*(\d+)\s*$/m.exec(source);
  return match ? match[1] : '';
}

export function baselineRecord(
  fixture: EvalFixture,
  configId = 'deterministic-no-model',
): RunRecord {
  const response = runDeterministicBaseline(fixture);
  if (response === null) {
    throw new EvalSuiteError(`fixture ${fixture.id} has no deterministic baseline`);
  }
  const checks = scoreResponse(fixture, response);
  return {
    fixtureId: fixture.id,
    configId,
    outcome: checks.every((check) => check.passed) ? 'pass' : 'fail',
    checks,
    requiredChecksPassed: null,
    retries: 0,
    latencyMs: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    operatorMinutes: 0,
    difficult: false,
    notes: 'deterministic extractor, no model invoked',
  };
}
