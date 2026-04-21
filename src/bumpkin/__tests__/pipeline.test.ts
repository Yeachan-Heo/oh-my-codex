import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runUpgradePipeline } from '../pipeline.js';
import type { Gate, GateContext, CommandRunner } from '../gates/types.js';
import { FixtureModelProvider, recordEntry } from '../model/fixture-provider.js';
import { buildPlannerRequest } from '../skills/upgrade-planner.js';
import { buildMechanicalFixerRequest } from '../skills/mechanical-fixer.js';
import { buildReviewerRequest } from '../skills/llm-reviewer.js';
import { buildPullRequestSpec } from '../github/pr-opener.js';
import type { ModelResponse } from '../model/provider.js';

const FIXED_NOW = () => '2026-01-01T00:00:00.000Z';

function resp(content: string): ModelResponse {
  return { content, stopReason: 'end_turn', inputTokens: 100, outputTokens: 50 };
}

function gateAlwaysPass(name: string): Gate {
  return { name, run: async () => ({ pass: true, reason: `${name} passed` }) };
}

function gateFailsThenPasses(name: string): Gate {
  let calls = 0;
  return {
    name,
    run: async () => {
      calls += 1;
      if (calls === 1) return { pass: false, reason: `${name}: FAIL on attempt 1` };
      return { pass: true, reason: `${name} passed` };
    },
  };
}

const NOOP_RUNNER: CommandRunner = async () => ({ code: 0, stdout: '', stderr: '' });
const GATE_CTX: GateContext = { workspacePath: '/ws', run: NOOP_RUNNER };

describe('bumpkin/pipeline full-pipeline acceptance', () => {
  it('runs happy path planner → gates → reviewer → safety → ship and emits a PR spec', async () => {
    const dependencies = [{ name: 'lodash', current: '4.17.0', latest: '4.17.21' }];

    const plannerResponse = resp(
      JSON.stringify({
        order: [
          { name: 'lodash', from: '4.17.0', to: '4.17.21', rationale: 'patch', riskLevel: 'low' },
        ],
      }),
    );
    const fixerResponse = resp(JSON.stringify({ diff: '--- a\n+++ b\n', explanation: 'rename' }));
    const reviewerResponse = resp(JSON.stringify({ verdict: 'APPROVE', rationale: 'aligns with changelog' }));

    const planner = new FixtureModelProvider({
      recordings: [recordEntry(buildPlannerRequest({ dependencies }), plannerResponse)],
    });
    const fixer = new FixtureModelProvider({
      recordings: [
        recordEntry(
          buildMechanicalFixerRequest({
            failingTest: { file: 'src/foo.test.ts', name: 'failing', output: 'FAIL' },
            libraryApiDelta: { libraryName: 'lodash', fromVersion: '4.17.0', toVersion: '4.17.21', summary: 'chain api' },
            sourceSnippet: 'import _ from "lodash"; _.chain(x).value();',
          }),
          fixerResponse,
        ),
      ],
    });
    const reviewer = new FixtureModelProvider({
      recordings: [
        recordEntry(
          buildReviewerRequest({
            diff: 'see-workspace',
            failingTestOutput: 'FAIL',
            releaseNotes: 'patch release',
            libraryName: 'lodash',
            fromVersion: '4.17.0',
            toVersion: '4.17.21',
          }),
          reviewerResponse,
        ),
      ],
    });

    const gates: Gate[] = [
      gateFailsThenPasses('verify-tests'),
      gateAlwaysPass('verify-types'),
      gateAlwaysPass('verify-build'),
      gateAlwaysPass('verify-lint'),
      gateAlwaysPass('verify-preview'),
      gateAlwaysPass('verify-apisurface'),
      gateAlwaysPass('verify-bundle-size'),
    ];

    const applied: string[] = [];

    const result = await runUpgradePipeline(
      { dependencies },
      {
        planner,
        fixer,
        reviewer,
        router: {
          oss: { providerId: 'groq:qwen-3' },
          frontier: { providerId: 'anthropic:sonnet-4-6' },
        },
        gates,
        applyUpgrade: async (t) => {
          applied.push(`upgrade:${t.name}`);
        },
        applyFixDiff: async (d) => {
          applied.push(`fix:${d.length}b`);
        },
        gateContext: GATE_CTX,
        libraryApiDelta: async () => ({
          libraryName: 'lodash',
          fromVersion: '4.17.0',
          toVersion: '4.17.21',
          summary: 'chain api',
        }),
        failingTestForGate: () => ({ file: 'src/foo.test.ts', name: 'failing', output: 'FAIL' }),
        sourceSnippet: async () => 'import _ from "lodash"; _.chain(x).value();',
        releaseNotes: async () => 'patch release',
        expectedSurface: ['src/**', 'package.json', 'package-lock.json'],
        diffPaths: () => ['src/foo.ts', 'package.json'],
        diffLineCount: () => 14,
        now: FIXED_NOW,
      },
    );

    assert.equal(result.status, 'ready-to-ship');
    assert.equal(result.target.name, 'lodash');
    assert.ok(applied.includes('upgrade:lodash'));
    assert.ok(applied.some((e) => e.startsWith('fix:')), 'fix diff should be applied');

    const failedGate = result.gateOutcomes.find((g) => !g.pass);
    assert.ok(failedGate, 'expected to see the initial tests failure in gate outcomes');
    assert.equal(failedGate?.gate, 'verify-tests');

    const passedTests = result.gateOutcomes.filter((g) => g.gate === 'verify-tests' && g.pass);
    assert.equal(passedTests.length, 1, 'tests gate should pass on retry');

    assert.ok(
      result.gateOutcomes.some((g) => g.gate === 'blast-radius-check' && g.pass),
      'blast-radius-check should pass',
    );
    assert.ok(
      result.gateOutcomes.some((g) => g.gate === 'category-check' && g.pass),
      'category-check should pass',
    );

    assert.ok(result.transitions.length > 5, 'should have traversed many phases');

    const prSpec = buildPullRequestSpec(result);
    assert.equal(prSpec.title, 'Bump lodash from 4.17.0 to 4.17.21');
    assert.equal(prSpec.branchName, 'bumpkin/lodash-4.17.0-to-4.17.21');
    assert.equal(prSpec.draft, false);
    assert.match(prSpec.body, /verify-tests \| ✅/);
    assert.match(prSpec.body, /Reviewer verdict:\*\* APPROVE/);
  });

  it('escalates when category-check detects a safety-critical path', async () => {
    const dependencies = [{ name: 'passport', current: '0.5.0', latest: '0.7.0' }];
    const planner = new FixtureModelProvider({
      recordings: [
        recordEntry(
          buildPlannerRequest({ dependencies }),
          resp(
            JSON.stringify({
              order: [
                { name: 'passport', from: '0.5.0', to: '0.7.0', rationale: 'minor', riskLevel: 'medium' },
              ],
            }),
          ),
        ),
      ],
    });
    const reviewer = new FixtureModelProvider({
      recordings: [
        recordEntry(
          buildReviewerRequest({
            diff: 'see-workspace',
            failingTestOutput: 'no failure',
            releaseNotes: 'minor release',
            libraryName: 'passport',
            fromVersion: '0.5.0',
            toVersion: '0.7.0',
          }),
          resp(JSON.stringify({ verdict: 'APPROVE', rationale: 'ok' })),
        ),
      ],
    });
    const fixer = new FixtureModelProvider({ recordings: [] });

    const gates: Gate[] = Array.from({ length: 7 }, (_, i) => gateAlwaysPass(`gate-${i}`));

    const result = await runUpgradePipeline(
      { dependencies },
      {
        planner,
        fixer,
        reviewer,
        router: {
          oss: { providerId: 'groq:qwen-3' },
          frontier: { providerId: 'anthropic:sonnet-4-6' },
        },
        gates,
        applyUpgrade: async () => {},
        applyFixDiff: async () => {},
        gateContext: GATE_CTX,
        libraryApiDelta: async () => ({
          libraryName: 'passport',
          fromVersion: '0.5.0',
          toVersion: '0.7.0',
          summary: 's',
        }),
        failingTestForGate: () => ({ file: 'x', name: 'x', output: 'no failure' }),
        sourceSnippet: async () => '',
        releaseNotes: async () => 'minor release',
        expectedSurface: ['src/**', 'package.json'],
        diffPaths: () => ['src/auth/login.ts'],
        diffLineCount: () => 5,
        now: FIXED_NOW,
      },
    );

    assert.equal(result.status, 'escalated');
    assert.equal(result.escalationReason, 'safety-critical-category');
    assert.deepEqual([...result.safetyCriticalPathsTouched], ['src/auth/login.ts']);

    const prSpec = buildPullRequestSpec(result);
    assert.equal(prSpec.draft, true);
    assert.equal(prSpec.autoMerge, false);
    assert.ok(prSpec.labels.includes('safety-critical'));
    assert.match(prSpec.body, /Escalated:\*\* safety-critical-category/);
  });

  it('escalates when mechanical fixer keeps failing past maxFixAttempts', async () => {
    const dependencies = [{ name: 'react', current: '17.0.0', latest: '19.0.0' }];
    const planner = new FixtureModelProvider({
      recordings: [
        recordEntry(
          buildPlannerRequest({ dependencies }),
          resp(
            JSON.stringify({
              order: [
                { name: 'react', from: '17.0.0', to: '19.0.0', rationale: 'major', riskLevel: 'high' },
              ],
            }),
          ),
        ),
      ],
    });
    const delta = { libraryName: 'react', fromVersion: '17.0.0', toVersion: '19.0.0', summary: 'ReactDOM.render → createRoot' };
    const failingTest = { file: 'src/App.test.tsx', name: 'renders', output: 'TypeError' };
    const sourceSnippet = 'ReactDOM.render(<App/>, root);';
    const fixer = new FixtureModelProvider({
      recordings: [
        recordEntry(
          buildMechanicalFixerRequest({ failingTest, libraryApiDelta: delta, sourceSnippet }),
          resp(JSON.stringify({ diff: 'bad diff', explanation: 'wrong' })),
        ),
      ],
    });
    const reviewer = new FixtureModelProvider({ recordings: [] });

    // Tests gate always fails; fixer always generates the same bad diff, applyFixDiff always throws.
    const gates: Gate[] = [
      { name: 'verify-tests', run: async () => ({ pass: false, reason: 'still failing' }) },
      gateAlwaysPass('verify-types'),
      gateAlwaysPass('verify-build'),
      gateAlwaysPass('verify-lint'),
      gateAlwaysPass('verify-preview'),
      gateAlwaysPass('verify-apisurface'),
      gateAlwaysPass('verify-bundle-size'),
    ];

    const result = await runUpgradePipeline(
      { dependencies },
      {
        planner,
        fixer,
        reviewer,
        router: {
          oss: { providerId: 'groq:qwen-3' },
          frontier: { providerId: 'anthropic:sonnet-4-6' },
        },
        gates,
        applyUpgrade: async () => {},
        applyFixDiff: async () => {
          throw new Error('patch does not apply');
        },
        gateContext: GATE_CTX,
        libraryApiDelta: async () => delta,
        failingTestForGate: () => failingTest,
        sourceSnippet: async () => sourceSnippet,
        releaseNotes: async () => 'major release',
        expectedSurface: ['src/**'],
        diffPaths: () => ['src/App.tsx'],
        diffLineCount: () => 3,
        maxFixAttempts: 2,
        now: FIXED_NOW,
      },
    );

    assert.equal(result.status, 'escalated');
    assert.equal(result.escalationReason, 'max-fix-attempts-exceeded');

    const prSpec = buildPullRequestSpec(result);
    assert.equal(prSpec.draft, true);
    assert.match(prSpec.title, /could not auto-upgrade react/);
    assert.ok(prSpec.labels.includes('auto-fix-failed'));
  });
});
