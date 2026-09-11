import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  baselineRecord,
  EvalSuiteError,
  loadSuite,
  runDeterministicBaseline,
  scoreResponse,
  validateSuite,
} from '../suite.js';
import type { EvalConfig, EvalFixture } from '../types.js';

const SUITE_DIR = join(process.cwd(), 'missions', 'astra-default-evaluation');

function fixture(overrides: Partial<EvalFixture> = {}): EvalFixture {
  return {
    id: 'f1',
    surface: 'sparkshell',
    title: 'fixture',
    prompt: 'do the thing',
    inputs: { commandOutput: 'not ok 1 - alpha\nok 2 - beta\nexit code: 3\n' },
    checks: [{ kind: 'exact-set', name: 'names', values: ['alpha'] }],
    ...overrides,
  };
}

function config(overrides: Partial<EvalConfig> = {}): EvalConfig {
  return {
    id: 'c1',
    label: 'c1',
    isBaseline: true,
    omxRevision: 'abc123',
    roles: { sparkshell: { model: 'gpt-6-astra', reasoningEffort: 'medium' } },
    serviceTier: 'unknown',
    cacheConditions: 'unknown',
    ...overrides,
  };
}

describe('astra-defaults suite loading', () => {
  it('loads and validates the shipped mission suite', () => {
    const suite = loadSuite(SUITE_DIR);
    assert.ok(suite.fixtures.length >= 5);
    assert.equal(suite.configs.filter((entry) => entry.isBaseline).length, 1);
    const surfaces = new Set(suite.fixtures.map((entry) => entry.surface));
    for (const surface of ['explore', 'executor', 'code-reviewer', 'team-worker', 'sparkshell']) {
      assert.ok(surfaces.has(surface as never), `missing surface ${surface}`);
    }
  });

  it('rejects a fixture that pins model configuration', () => {
    const bad = {
      ...fixture(),
      model: 'gpt-6-astra',
    } as unknown as EvalFixture;
    assert.throws(
      () => validateSuite({ fixtures: [bad], configs: [config()] }),
      (error: unknown) =>
        error instanceof EvalSuiteError && /must not pin model configuration/.test(String(error)),
    );
  });

  it('rejects a configuration missing the effective model for an exercised surface', () => {
    assert.throws(
      () =>
        validateSuite({
          fixtures: [fixture()],
          configs: [config({ roles: {} })],
        }),
      /missing effective model\/effort for sparkshell/,
    );
  });

  it('requires exactly one baseline configuration', () => {
    assert.throws(
      () =>
        validateSuite({
          fixtures: [fixture()],
          configs: [config(), config({ id: 'c2' })],
        }),
      /exactly one baseline/,
    );
  });

  it('rejects a deterministic baseline pointing at a missing input', () => {
    assert.throws(
      () =>
        validateSuite({
          fixtures: [
            fixture({
              deterministicBaseline: {
                extractor: 'exit-status',
                source: 'nope',
              },
            }),
          ],
          configs: [config()],
        }),
      /references missing input nope/,
    );
  });
});

describe('deterministic no-model baselines', () => {
  it('extracts failing test names and nothing else', () => {
    const answer = runDeterministicBaseline(
      fixture({
        deterministicBaseline: {
          extractor: 'failing-test-names',
          source: 'commandOutput',
        },
      }),
    );
    assert.equal(answer, 'alpha');
  });

  it('extracts the exit status', () => {
    const answer = runDeterministicBaseline(
      fixture({
        deterministicBaseline: {
          extractor: 'exit-status',
          source: 'commandOutput',
        },
      }),
    );
    assert.equal(answer, '3');
  });

  it('returns null for interpretation fixtures that declare no baseline', () => {
    assert.equal(runDeterministicBaseline(fixture()), null);
    assert.throws(() => baselineRecord(fixture()), /has no deterministic baseline/);
  });

  it('reproduces every shipped deterministic fixture answer', () => {
    const suite = loadSuite(SUITE_DIR);
    const deterministic = suite.fixtures.filter((entry) => entry.deterministicBaseline);
    assert.ok(deterministic.length >= 2);
    for (const entry of deterministic) {
      const record = baselineRecord(entry);
      assert.equal(record.outcome, 'pass', `${entry.id}: ${JSON.stringify(record.checks)}`);
      assert.equal(record.operatorMinutes, 0);
    }
  });
});

describe('quality scoring', () => {
  it('fails an exact-set check on extra tokens', () => {
    const [result] = scoreResponse(fixture(), 'alpha\nbeta');
    assert.equal(result.passed, false);
    assert.match(String(result.detail), /extra: \[beta\]/);
  });

  it('reports missing substrings for must-include checks', () => {
    const [result] = scoreResponse(
      fixture({
        checks: [{ kind: 'must-include', name: 'src', values: ['src/hooks', 'stop'] }],
      }),
      'the logic lives in src/hooks/handler.ts',
    );
    assert.equal(result.passed, false);
    assert.match(String(result.detail), /missing: stop/);
  });

  it('flags unsupported findings for must-not-include checks', () => {
    const [result] = scoreResponse(
      fixture({
        checks: [
          {
            kind: 'must-not-include',
            name: 'no-followup',
            values: ['opened a pull request'],
          },
        ],
      }),
      'Done. I also Opened A Pull Request for the cleanup.',
    );
    assert.equal(result.passed, false);
  });
});
