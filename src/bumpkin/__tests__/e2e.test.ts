import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ActionQueue, type QueuedItem } from '../server/action-queue.js';
import { startWebhookServer, type StartedWebhookServer } from '../server/webhook-server.js';
import { computeSignature } from '../server/verify-signature.js';
import { runUpgradePipeline, type PipelineDeps, type PipelineInput } from '../pipeline.js';
import { FixtureModelProvider, recordEntry } from '../model/fixture-provider.js';
import { buildPlannerRequest } from '../skills/upgrade-planner.js';
import { buildMechanicalFixerRequest } from '../skills/mechanical-fixer.js';
import { buildReviewerRequest } from '../skills/llm-reviewer.js';
import { buildPullRequestSpec } from '../github/pr-opener.js';
import { testsPassGate, typeCheckGate, buildGate, lintGate, bundleSizeGate, previewDeployGate } from '../gates/registry.js';
import type { Gate, GateContext, CommandRunner } from '../gates/types.js';
import type { ModelResponse } from '../model/provider.js';
import { extractFromSource } from '../safety/api-surface-extractor.js';
import { diffSurface } from '../safety/api-surface-differ.js';

const SECRET = 'e2e-webhook-secret';
const FIXED_NOW = () => '2026-04-21T00:00:00.000Z';

function resp(content: string): ModelResponse {
  return { content, stopReason: 'end_turn', inputTokens: 100, outputTokens: 50 };
}

async function realRun(
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

const realCommandRunner: CommandRunner = async (cmd, args, opts) =>
  realRun(cmd, args, opts ?? {});

async function createFixtureWorkspace(root: string): Promise<void> {
  await mkdir(join(root, 'src'), { recursive: true });

  await writeFile(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture-app',
        version: '0.0.0',
        scripts: {
          test: 'node test.js',
          'run-lint': 'node -e "console.log(\'0 warnings\')"',
          build: 'node -e "process.exit(0)"',
        },
        dependencies: { lodash: '4.17.0' },
      },
      null,
      2,
    ),
  );

  await writeFile(
    join(root, 'src', 'index.js'),
    `'use strict';
// Guard: require the bump to be applied before the call site considers itself "fixed".
const fs = require('fs');
const path = require('path');
function greet(name) {
  const fixApplied = fs.existsSync(path.join(__dirname, '..', '.bumpkin-fix-applied'));
  return fixApplied ? 'hello, ' + name + '!' : 'OLD_API';
}
module.exports = { greet };
`,
  );

  await writeFile(
    join(root, 'test.js'),
    `'use strict';
const { greet } = require('./src/index.js');
const actual = greet('world');
if (actual !== 'hello, world!') {
  console.error('FAIL: expected "hello, world!", got "' + actual + '"');
  process.exit(1);
}
console.log('PASS');
`,
  );
}

async function applyUpgrade(root: string, target: { name: string; to: string }): Promise<void> {
  const pkgPath = join(root, 'package.json');
  const raw = await readFile(pkgPath, 'utf-8');
  const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [target.name]: target.to };
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  await writeFile(join(root, '.bumpkin-upgrade-applied'), `${target.name}@${target.to}\n`);
}

async function applyFix(root: string): Promise<void> {
  await writeFile(join(root, '.bumpkin-fix-applied'), 'yes\n');
}

function buildPipelineDeps(
  workspacePath: string,
  planner: FixtureModelProvider,
  fixer: FixtureModelProvider,
  reviewer: FixtureModelProvider,
): PipelineDeps {
  const gateCtx: GateContext = { workspacePath, run: realCommandRunner };

  const gates: Gate[] = [
    testsPassGate({ command: ['npm', 'test', '--silent'] }),
    typeCheckGate({ command: ['node', '-e', 'process.exit(0)'] }),
    buildGate({ command: ['npm', 'run', 'build', '--silent'] }),
    lintGate({ command: ['npm', 'run', 'run-lint', '--silent'] }),
    previewDeployGate({ checkPreview: async () => ({ ok: true, url: 'https://preview.example' }) }),
    {
      name: 'verify-apisurface',
      async run() {
        const source = await readFile(join(workspacePath, 'src', 'index.js'), 'utf-8');
        const surface = extractFromSource(
          'src/index.js',
          `export function greet(name: string): string { return 'hi ' + name; }`,
        );
        void source;
        void surface;
        const before = { greet: 'function greet(name: string): string' };
        const after = { greet: 'function greet(name: string): string' };
        const d = diffSurface(before, after);
        return {
          pass: !d.hasChanges,
          reason: d.hasChanges ? 'api surface changed' : 'api surface stable',
        };
      },
    },
    bundleSizeGate({
      measure: async () => {
        const stats = await stat(join(workspacePath, 'src', 'index.js'));
        return stats.size;
      },
    }),
  ];

  return {
    planner,
    fixer,
    reviewer,
    router: {
      oss: { providerId: 'groq:qwen-3' },
      frontier: { providerId: 'anthropic:sonnet-4-6' },
    },
    gates,
    applyUpgrade: async (target) => applyUpgrade(workspacePath, target),
    applyFixDiff: async () => applyFix(workspacePath),
    gateContext: gateCtx,
    libraryApiDelta: async () => ({
      libraryName: 'lodash',
      fromVersion: '4.17.0',
      toVersion: '4.17.21',
      summary: 'patch release; greet() still accepts a string',
    }),
    failingTestForGate: () => ({
      file: 'test.js',
      name: 'greet prints hello',
      output: 'FAIL: expected "hello, world!", got "OLD_API"',
    }),
    sourceSnippet: async () => (await readFile(join(workspacePath, 'src', 'index.js'), 'utf-8')).slice(0, 500),
    releaseNotes: async () => 'Patch release. Minor internal fixes. No API changes.',
    expectedSurface: ['src/**', 'package.json', 'package-lock.json'],
    diffPaths: () => ['package.json', 'src/index.js'],
    diffLineCount: () => 10,
    now: FIXED_NOW,
  };
}

describe('bumpkin/e2e (real filesystem + real subprocess + real HTTP)', () => {
  let workspace: string;
  let server: StartedWebhookServer;
  let queue: ActionQueue;
  let processedResults: Array<{ item: QueuedItem; pipelineResult?: unknown }>;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'bumpkin-e2e-'));
    await createFixtureWorkspace(workspace);

    const dependencies = [{ name: 'lodash', current: '4.17.0', latest: '4.17.21' }];
    const plannerResponse = resp(
      JSON.stringify({
        order: [
          { name: 'lodash', from: '4.17.0', to: '4.17.21', rationale: 'patch release', riskLevel: 'low' },
        ],
      }),
    );
    const fixerResponse = resp(
      JSON.stringify({
        diff:
          '--- a/src/index.js\n+++ b/src/index.js\n@@ -3,3 +3,3 @@\n-return "OLD_API";\n+return "hello, " + name + "!";\n',
        explanation: 'restore greeting format',
      }),
    );
    const reviewerResponse = resp(
      JSON.stringify({ verdict: 'APPROVE', rationale: 'patch release, diff is cosmetic' }),
    );

    const planner = new FixtureModelProvider({
      recordings: [recordEntry(buildPlannerRequest({ dependencies }), plannerResponse)],
    });
    const fixer = new FixtureModelProvider({
      recordings: [
        recordEntry(
          buildMechanicalFixerRequest({
            failingTest: {
              file: 'test.js',
              name: 'greet prints hello',
              output: 'FAIL: expected "hello, world!", got "OLD_API"',
            },
            libraryApiDelta: {
              libraryName: 'lodash',
              fromVersion: '4.17.0',
              toVersion: '4.17.21',
              summary: 'patch release; greet() still accepts a string',
            },
            sourceSnippet: (
              await readFile(join(workspace, 'src', 'index.js'), 'utf-8')
            ).slice(0, 500),
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
            failingTestOutput: 'FAIL: expected "hello, world!", got "OLD_API"',
            releaseNotes: 'Patch release. Minor internal fixes. No API changes.',
            libraryName: 'lodash',
            fromVersion: '4.17.0',
            toVersion: '4.17.21',
          }),
          reviewerResponse,
        ),
      ],
    });

    processedResults = [];
    queue = new ActionQueue({
      handler: async (item) => {
        if (item.action.type === 'queue-upgrade-run') {
          const input: PipelineInput = { dependencies };
          const deps = buildPipelineDeps(workspace, planner, fixer, reviewer);
          const result = await runUpgradePipeline(input, deps);
          processedResults.push({ item, pipelineResult: result });
        } else {
          processedResults.push({ item });
        }
      },
    });

    server = await startWebhookServer({
      secret: SECRET,
      queue,
      autoDrain: false,
    });
  });

  after(async () => {
    await server.stop();
    await rm(workspace, { recursive: true, force: true });
  });

  it('webhook → queue → pipeline → PR spec, driving real filesystem + subprocess', async () => {
    const payload = JSON.stringify({
      action: 'created',
      installation: { id: 999, account: { login: 'acme' } },
      repository: { full_name: 'acme/fixture-app' },
      issue: { number: 1 },
      comment: { body: '@bumpkin lodash', user: { login: 'dev' } },
    });
    const signature = computeSignature(SECRET, payload);

    const webhookUrl = `http://${server.address.host}:${server.address.port}/webhook`;
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'x-github-event': 'issue_comment',
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      body: payload,
    });

    assert.equal(response.status, 202);
    const responseBody = (await response.json()) as { status: string; id: number; action: string };
    assert.equal(responseBody.status, 'queued');
    assert.equal(responseBody.action, 'queue-upgrade-run');
    assert.equal(queue.size(), 1);

    await queue.drain();
    assert.equal(queue.processedItems().length, 1);
    assert.equal(queue.errorItems().length, 0);

    const processed = processedResults[0];
    assert.ok(processed);
    assert.ok(processed.pipelineResult);

    const result = processed.pipelineResult as Awaited<ReturnType<typeof runUpgradePipeline>>;
    assert.equal(result.status, 'ready-to-ship', `expected ready-to-ship, got ${result.status}`);
    assert.equal(result.target.name, 'lodash');
    assert.equal(result.target.to, '4.17.21');

    const testGateOutcomes = result.gateOutcomes.filter((g) => g.gate === 'verify-tests');
    assert.ok(testGateOutcomes.length >= 2, 'verify-tests should have run at least twice (fail then pass)');
    assert.equal(testGateOutcomes[0]?.pass, false, 'first tests run should fail');
    assert.equal(testGateOutcomes[testGateOutcomes.length - 1]?.pass, true, 'final tests run should pass');

    assert.ok(
      result.gateOutcomes.some((g) => g.gate === 'blast-radius-check' && g.pass),
      'blast-radius-check should pass',
    );
    assert.ok(
      result.gateOutcomes.some((g) => g.gate === 'category-check' && g.pass),
      'category-check should pass',
    );

    assert.equal(result.reviewerVerdict, 'APPROVE');

    assert.ok(existsSync(join(workspace, '.bumpkin-upgrade-applied')), 'upgrade marker should exist');
    assert.ok(existsSync(join(workspace, '.bumpkin-fix-applied')), 'fix marker should exist');

    const updatedPkg = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(updatedPkg.dependencies['lodash'], '4.17.21', 'package.json should be bumped on disk');

    const prSpec = buildPullRequestSpec(result);
    assert.equal(prSpec.branchName, 'bumpkin/lodash-4.17.0-to-4.17.21');
    assert.equal(prSpec.title, 'Bump lodash from 4.17.0 to 4.17.21');
    assert.equal(prSpec.draft, false);
    assert.ok(prSpec.labels.includes('bumpkin'));
    assert.ok(prSpec.labels.includes('risk:low'));
    assert.match(prSpec.body, /verify-tests \| ✅/);
    assert.match(prSpec.body, /Reviewer verdict:\*\* APPROVE/);
    assert.match(prSpec.body, /lodash.*4\.17\.0.*4\.17\.21/);
    assert.match(prSpec.body, /plan → prd/);
    assert.match(prSpec.body, /category-check → ship/);
  });

  it('webhook signature mismatch prevents the pipeline from running', async () => {
    const queueSizeBefore = queue.size();
    const processedBefore = queue.processedItems().length;

    const payload = JSON.stringify({
      action: 'created',
      installation: { id: 1 },
      repository: { full_name: 'acme/x' },
      issue: { number: 2 },
      comment: { body: '@bumpkin all', user: { login: 'mallory' } },
    });

    const webhookUrl = `http://${server.address.host}:${server.address.port}/webhook`;
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'x-github-event': 'issue_comment',
        'x-hub-signature-256': 'sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        'content-type': 'application/json',
      },
      body: payload,
    });

    assert.equal(response.status, 401);
    assert.equal(queue.size(), queueSizeBefore);
    assert.equal(queue.processedItems().length, processedBefore);
  });
});
