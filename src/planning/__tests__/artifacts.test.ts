import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isPlanningComplete,
  readApprovedExecutionLaunchHint,
  readLatestPlanningArtifacts,
  readPlanningArtifacts,
  readTeamDagArtifactResolution,
} from '../artifacts.js';
import {
  contextPackExcerptPath,
  REQUIRED_CONTEXT_PACK_ROLES,
  contextPackIndexPath,
  readContextPackDocument,
  writeContextPackDocument,
  type ContextPackRole,
} from '../context-packs.js';
import { resolveDeclaredContextPackPath } from '../path-utils.js';
import { readTeamDagHandoffForLatestPlan } from '../../team/dag-schema.js';

let tempDir: string;
const CONTEXT_PACK_SCHEMA = 'omx-context-pack-v1';

function defaultReadFirstRef(
  slug: string,
  role: ContextPackRole,
): { label: string; path: string; relationTag: string } {
  if (role === 'scope') {
    return { label: 'boundary', path: `docs/${slug}-boundary.md`, relationTag: 'bounds' };
  }
  if (role === 'verify') {
    return { label: 'acceptance', path: `docs/${slug}-acceptance.md`, relationTag: 'verifies' };
  }
  return { label: 'implementation', path: `docs/${slug}-implementation.md`, relationTag: 'implements' };
}

async function setup(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-planning-artifacts-'));
}

async function cleanup(): Promise<void> {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function writeContextPacks(
  slug: string,
  roles: readonly ContextPackRole[] = REQUIRED_CONTEXT_PACK_ROLES,
): Promise<{ absolutePath: string; relativePath: string }> {
  const contextDir = join(tempDir, '.omx', 'context');
  await mkdir(contextDir, { recursive: true });

  for (const role of roles) {
    const readFirstRef = defaultReadFirstRef(slug, role);
    await writeRepoFile(
      readFirstRef.path,
      `# ${readFirstRef.label}\n\n${role} context for ${slug}.\n`,
    );
  }

  const relativePath = `.omx/context/context-20260420T000000Z-${slug}.json`;
  const absolutePath = join(tempDir, relativePath);
  writeContextPackDocument(absolutePath, {
    schema: CONTEXT_PACK_SCHEMA,
    slug,
    entries: roles.map((role) => {
      const readFirstRef = defaultReadFirstRef(slug, role);
      return {
        label: readFirstRef.label,
        path: readFirstRef.path,
        roles: [role],
        tags: [],
        relationPath: [
          { tag: 'plan', target: slug },
          { tag: readFirstRef.relationTag, target: readFirstRef.path },
        ],
      };
    }),
  }, { refreshBasis: true });

  return { absolutePath, relativePath };
}

async function writeRepoFile(relativePath: string, content: string): Promise<string> {
  const absolutePath = join(tempDir, relativePath);
  await mkdir(join(absolutePath, '..'), { recursive: true });
  await writeFile(absolutePath, content);
  return absolutePath;
}

function refreshContextPackBasis(packPath: string): void {
  const document = readContextPackDocument(packPath);
  assert.ok(document, `expected context pack at ${packPath}`);
  writeContextPackDocument(packPath, document, { refreshBasis: true });
}

function buildContextPackOutcome(
  relativePath: string,
  action: 'created' | 'refreshed' | 'revalidated' = 'created',
): string {
  return [
    '## Context Pack Outcome',
    `- pack: ${action} \`${relativePath}\``,
  ].join('\n');
}

describe('planning artifacts', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('requires both PRD and test spec for planning completion', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-issue-827.md'), '# PRD\n');

    const artifacts = readPlanningArtifacts(tempDir);
    assert.equal(isPlanningComplete(artifacts), false);
    assert.equal(artifacts.prdPaths.length, 1);
    assert.equal(artifacts.testSpecPaths.length, 0);
  });

  it('keeps pre-context-pack PRD/test-spec execution compatible and treats planning as execution-compatible', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-901.md'),
      '# PRD\n\nLaunch via omx ralph "Execute approved issue 901 plan"\n',
    );
    await writeFile(join(plansDir, 'test-spec-issue-901.md'), '# Test Spec\n');

    const artifacts = readPlanningArtifacts(tempDir);
    assert.equal(isPlanningComplete(artifacts), true);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.task, 'Execute approved issue 901 plan');
    assert.equal(hint?.contextPackStatus, 'plan-only');
    assert.equal(hint?.contextPack, null);
    assert.deepEqual(hint?.missingRequiredContextPackRoles, []);
    assert.deepEqual(hint?.contextPackIssues, []);
  });

  it('resolves matching Team DAG sidecar before markdown handoff', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-repo-aware.md'),
      '# PRD\n\n## Team DAG Handoff\n```json\n{"source":"markdown"}\n```\n',
    );
    await writeFile(join(plansDir, 'test-spec-repo-aware.md'), '# Test Spec\n');
    await writeFile(join(plansDir, 'team-dag-repo-aware.json'), '{"source":"sidecar"}\n');

    const resolution = readTeamDagArtifactResolution(tempDir);

    assert.equal(resolution.source, 'json-sidecar');
    assert.equal(resolution.planSlug, 'repo-aware');
    assert.equal(resolution.artifactPath, join(plansDir, 'team-dag-repo-aware.json'));
    assert.equal(resolution.content, '{"source":"sidecar"}\n');
    assert.deepEqual(resolution.warnings, []);
  });

  it('falls back to embedded Team DAG handoff when sidecar is absent', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-repo-aware.md'),
      '# PRD\n\n## Team DAG Handoff\n```json\n{"nodes":[]}\n```\n',
    );
    await writeFile(join(plansDir, 'test-spec-repo-aware.md'), '# Test Spec\n');

    const resolution = readTeamDagArtifactResolution(tempDir);

    assert.equal(resolution.source, 'markdown-handoff');
    assert.equal(resolution.planSlug, 'repo-aware');
    assert.equal(resolution.content, '{"nodes":[]}');
    assert.equal(resolution.artifactPath, undefined);
  });

  it('returns none for Team DAG resolution when planning is incomplete', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-repo-aware.md'), '# PRD\n');

    const resolution = readTeamDagArtifactResolution(tempDir);

    assert.equal(resolution.source, 'none');
    assert.equal(resolution.prdPath, join(plansDir, 'prd-repo-aware.md'));
    assert.equal(resolution.planSlug, 'repo-aware');
    assert.deepEqual(resolution.warnings, ['missing_matching_test_spec']);
  });


  it('reports launch hints without a matching test spec slug as missing baseline', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-alpha.md'), '# Alpha\n\nLaunch via omx team 2:executor "Execute alpha"\n');
    await writeFile(join(plansDir, 'test-spec-other.md'), '# Other Test Spec\n');

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team');

    assert.ok(hint);
    assert.equal(hint?.task, 'Execute alpha');
    assert.equal(hint?.contextPackStatus, 'missing-baseline');
    assert.deepEqual(hint?.testSpecPaths, []);
  });

  it('does not resolve Team DAG artifacts without a matching test spec slug', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-repo-aware.md'), '# PRD\n');
    await writeFile(join(plansDir, 'test-spec-other.md'), '# Other Test Spec\n');
    await writeFile(join(plansDir, 'team-dag-repo-aware.json'), '{"source":"sidecar"}\n');

    const resolution = readTeamDagArtifactResolution(tempDir);

    assert.equal(resolution.source, 'none');
    assert.equal(resolution.planSlug, 'repo-aware');
    assert.deepEqual(resolution.warnings, ['missing_matching_test_spec']);
  });


  it('parses $ralph aliases with single-quoted task text for approved launch hints', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-901.md'),
      "# PRD\n\nLaunch via $ralph 'Execute approved issue 901 plan'\n",
    );
    await writeFile(join(plansDir, 'test-spec-issue-901.md'), '# Test Spec\n');

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');

    assert.ok(hint);
    assert.equal(hint?.command, "$ralph 'Execute approved issue 901 plan'");
    assert.equal(hint?.task, 'Execute approved issue 901 plan');
  });

  it('prefers timestamped PRD/test-spec pairs while keeping legacy artifacts compatible', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const specsDir = join(tempDir, '.omx', 'specs');
    await mkdir(plansDir, { recursive: true });
    await mkdir(specsDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-legacy.md'),
      '# Legacy\n\nLaunch via omx ralph "Execute legacy plan"\n',
    );
    await writeFile(join(plansDir, 'test-spec-legacy.md'), '# Legacy Test Spec\n');
    await writeFile(
      join(plansDir, 'prd-20260427T153000Z-alpha.md'),
      '# Old Alpha\n\nLaunch via omx ralph "Execute old alpha plan"\n',
    );
    await writeFile(join(plansDir, 'test-spec-alpha.md'), '# Alpha Legacy Test Spec\n');
    await writeFile(
      join(plansDir, 'prd-20260427T153100Z-alpha.md'),
      '# New Alpha\n\nLaunch via omx ralph "Execute new alpha plan"\n',
    );
    await writeFile(join(plansDir, 'test-spec-20260427T153100Z-alpha.md'), '# Alpha Timestamped Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-alpha.md'), '# Alpha Legacy Deep Interview\n');
    await writeFile(join(specsDir, 'deep-interview-20260427T153100Z-alpha.md'), '# Alpha Timestamped Deep Interview\n');
    await writeFile(join(specsDir, 'deep-interview-autoresearch-20260427T153100Z-alpha.md'), '# Autoresearch Draft\n');

    const selection = readLatestPlanningArtifacts(tempDir);
    assert.equal(selection.prdPath, join(plansDir, 'prd-20260427T153100Z-alpha.md'));
    assert.deepEqual(selection.testSpecPaths, [join(plansDir, 'test-spec-20260427T153100Z-alpha.md')]);
    assert.deepEqual(selection.deepInterviewSpecPaths, [
      join(specsDir, 'deep-interview-alpha.md'),
      join(specsDir, 'deep-interview-20260427T153100Z-alpha.md'),
    ]);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.task, 'Execute new alpha plan');
    assert.deepEqual(hint?.testSpecPaths, [join(plansDir, 'test-spec-20260427T153100Z-alpha.md')]);
    assert.deepEqual(hint?.deepInterviewSpecPaths, [
      join(specsDir, 'deep-interview-alpha.md'),
      join(specsDir, 'deep-interview-20260427T153100Z-alpha.md'),
    ]);
  });

  it('uses compatibility fallback when the approved plan declares context packs but required roles are missing', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const existingContextPacks = await writeContextPacks('issue-902', ['scope']);
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-902.md'),
      [
        '# PRD',
        '',
        '## Context Pack Outcome',
        `- pack: created \`${existingContextPacks.relativePath}\``,
        '',
        'Launch via omx ralph "Execute approved issue 902 plan"',
        '',
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-issue-902.md'), '# Test Spec\n');
    refreshContextPackBasis(existingContextPacks.absolutePath);

    const artifacts = readPlanningArtifacts(tempDir);
    assert.equal(isPlanningComplete(artifacts), false);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.contextPackStatus, 'incomplete');
    assert.deepEqual(hint?.contextPack, { path: existingContextPacks.absolutePath, action: 'created' });
    assert.deepEqual(hint?.missingRequiredContextPackRoles, ['build', 'verify']);
    assert.deepEqual(hint?.contextPackIssues, [
      'Declared context pack is missing required roles: build, verify.',
    ]);
  });

  it('accepts revalidated context packs without forcing a rebuild', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('issue-904');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-904.md'),
      `# PRD\n\n${buildContextPackOutcome(contextPacks.relativePath, 'revalidated')}\n\nLaunch via omx ralph "Execute approved issue 904 plan"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-issue-904.md'), '# Test Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const artifacts = readPlanningArtifacts(tempDir);
    assert.equal(isPlanningComplete(artifacts), true);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph', { materializeContextRefs: true });
    assert.ok(hint);
    assert.equal(hint?.contextPackStatus, 'ready');
    assert.deepEqual(hint?.contextPack, { path: contextPacks.absolutePath, action: 'revalidated' });
    assert.equal(hint?.contextRefs.length, REQUIRED_CONTEXT_PACK_ROLES.length);
    assert.ok((hint?.contextRefs ?? []).every((ref) => ref.delivery === 'file'));
  });

  it('accepts Windows-style context pack declarations in plan outcomes', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('issue-1303');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-1303.md'),
      [
        '# PRD',
        '',
        '## Context Pack Outcome',
        `- pack: created \`${contextPacks.relativePath.replaceAll('/', '\\')}\``,
        '',
        'Launch via omx team 1:executor "Execute approved issue 1303 plan"',
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-issue-1303.md'), '# Test Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team');
    assert.ok(hint);
    assert.equal(hint?.contextPackStatus, 'ready');
    assert.deepEqual(hint?.contextPack, { path: contextPacks.absolutePath, action: 'created' });
  });

  it('keeps approved handoffs valid when canonical artifact and pack slugs use raw mixed-case names', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const specsDir = join(tempDir, '.omx', 'specs');
    const contextPacks = await writeContextPacks('Issue-ABC');
    await mkdir(plansDir, { recursive: true });
    await mkdir(specsDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-Issue-ABC.md'),
      `# PRD\n\n${buildContextPackOutcome(contextPacks.relativePath)}\n\nLaunch via omx ralph "Execute approved Issue-ABC plan"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-Issue-ABC.md'), '# Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-Issue-ABC.md'), '# Deep Interview Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.contextPackStatus, 'ready');
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-Issue-ABC.md'));
    assert.deepEqual(hint?.testSpecPaths, [join(plansDir, 'test-spec-Issue-ABC.md')]);
    assert.deepEqual(hint?.deepInterviewSpecPaths, [join(specsDir, 'deep-interview-Issue-ABC.md')]);
    assert.deepEqual(hint?.contextPack, { path: contextPacks.absolutePath, action: 'created' });
  });

  it('rejects duplicate Context Pack Outcome sections as ambiguous', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const firstContextPacks = await writeContextPacks('issue-1313-first');
    const secondContextPacks = await writeContextPacks('issue-1313-second');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-1313.md'),
      [
        '# PRD',
        '',
        buildContextPackOutcome(firstContextPacks.relativePath),
        '',
        'Some intervening revision notes.',
        '',
        buildContextPackOutcome(secondContextPacks.relativePath),
        '',
        'Launch via omx ralph "Execute approved issue 1313 plan"',
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-issue-1313.md'), '# Test Spec\n');
    refreshContextPackBasis(firstContextPacks.absolutePath);
    refreshContextPackBasis(secondContextPacks.absolutePath);

    const artifacts = readPlanningArtifacts(tempDir);
    assert.equal(isPlanningComplete(artifacts), false);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.contextPack, null);
    assert.equal(hint?.contextPackStatus, 'invalid');
    assert.deepEqual(hint?.missingRequiredContextPackRoles, REQUIRED_CONTEXT_PACK_ROLES);
    assert.deepEqual(hint?.contextPackIssues, ['Approved plan contains multiple Context Pack Outcome sections.']);
  });

  it('ignores Context Pack Outcome headings inside fenced code blocks', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('issue-1314');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-1314.md'),
      [
        '# PRD',
        '',
        '```md',
        '## Context Pack Outcome',
        '- pack: created `.omx/context/context-20260420T000000Z-sample.json`',
        '```',
        '',
        buildContextPackOutcome(contextPacks.relativePath),
        '',
        'Launch via omx ralph "Execute approved issue 1314 plan"',
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-issue-1314.md'), '# Test Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.contextPackStatus, 'ready');
    assert.deepEqual(hint?.contextPack, { path: contextPacks.absolutePath, action: 'created' });
    assert.deepEqual(hint?.contextPackIssues, []);
  });

  it('ignores Context Pack Outcome headings inside indented code blocks', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('issue-1314-indented');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-1314-indented.md'),
      [
        '# PRD',
        '',
        '    ## Context Pack Outcome',
        '    - pack: created `.omx/context/context-20260420T000000Z-sample.json`',
        '',
        buildContextPackOutcome(contextPacks.relativePath),
        '',
        'Launch via omx ralph "Execute approved issue 1314 indented plan"',
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-issue-1314-indented.md'), '# Test Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.contextPackStatus, 'ready');
    assert.deepEqual(hint?.contextPack, { path: contextPacks.absolutePath, action: 'created' });
    assert.deepEqual(hint?.contextPackIssues, []);
  });

  it('ignores Team launch hints inside fenced code blocks', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const task = 'Execute approved issue 1314 fenced team plan';
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-1314-fenced-team.md'),
      [
        '# PRD',
        '',
        '```sh',
        `omx team 5:reviewer ${JSON.stringify(task)}`,
        '```',
        '',
        `Launch via omx team 2:executor ${JSON.stringify(task)}`,
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-issue-1314-fenced-team.md'), '# Test Spec\n');

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team');
    assert.ok(hint);
    assert.equal(hint?.task, task);
    assert.equal(hint?.workerCount, 2);
    assert.equal(hint?.agentType, 'executor');
    assert.equal(hint?.contextPackStatus, 'plan-only');
  });

  it('ignores Ralph launch hints inside indented code blocks', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const task = 'Execute approved issue 1314 indented ralph plan';
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-1314-indented-ralph.md'),
      [
        '# PRD',
        '',
        `    omx ralph ${JSON.stringify(task)}`,
        '',
        `Launch via omx ralph ${JSON.stringify(task)}`,
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-issue-1314-indented-ralph.md'), '# Test Spec\n');

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph', { task });
    assert.ok(hint);
    assert.equal(hint?.task, task);
    assert.equal(hint?.command, `omx ralph ${JSON.stringify(task)}`);
    assert.equal(hint?.contextPackStatus, 'plan-only');
  });

  it('rejects context packs with unsupported top-level JSON keys', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('issue-904-bad-key');
    await writeFile(
      contextPacks.absolutePath,
      `${JSON.stringify({
        schema: CONTEXT_PACK_SCHEMA,
        extra: true,
        slug: 'issue-904-bad-key',
        entries: [
          {
            label: 'implementation',
            path: 'docs/issue-904-bad-key-implementation.md',
            roles: ['build'],
          },
        ],
      }, null, 2)}\n`,
    );
    await writeRepoFile(
      'docs/issue-904-bad-key-implementation.md',
      '# implementation\n\nbuild context.\n',
    );
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-904-bad-key.md'),
      `# PRD\n\n${buildContextPackOutcome(contextPacks.relativePath)}\n\nLaunch via omx ralph "Execute approved issue 904 bad key plan"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-issue-904-bad-key.md'), '# Test Spec\n');

    const artifacts = readPlanningArtifacts(tempDir);
    assert.equal(isPlanningComplete(artifacts), false);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.contextPackStatus, 'invalid');
    assert.ok(hint?.contextPackIssues.some((issue) => issue.includes('unsupported top-level key')));
  });

  it('rejects context packs that omit their canonical JSON file', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('issue-905-missing-pack');
    await rm(contextPacks.absolutePath);
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-905-missing-pack.md'),
      `# PRD\n\n${buildContextPackOutcome(contextPacks.relativePath)}\n\nLaunch via omx ralph "Execute approved issue 905 missing pack plan"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-issue-905-missing-pack.md'), '# Test Spec\n');

    const artifacts = readPlanningArtifacts(tempDir);
    assert.equal(isPlanningComplete(artifacts), false);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.contextPackStatus, 'incomplete');
    assert.deepEqual(hint?.missingRequiredContextPackRoles, [...REQUIRED_CONTEXT_PACK_ROLES]);
    assert.deepEqual(hint?.contextPackIssues, [
      'Declared context pack file is missing: .omx/context/context-20260420T000000Z-issue-905-missing-pack.json.',
    ]);
  });

  it('rejects context-pack outcome paths that escape the canonical context directory after normalization', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('issue-905-escaped-pack');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-905-escaped-pack.md'),
      [
        '# PRD',
        '',
        '## Context Pack Outcome',
        '- pack: created `.omx/context/../../tmp/context-20260420T000000Z-issue-905-escaped-pack.json`',
        '',
        'Launch via omx ralph "Execute approved issue 905 escaped pack plan"',
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-issue-905-escaped-pack.md'), '# Test Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);
    const escapedRelativePath = 'tmp/context-20260420T000000Z-issue-905-escaped-pack.json';
    await writeRepoFile(
      escapedRelativePath,
      await readFile(contextPacks.absolutePath, 'utf-8'),
    );

    const artifacts = readPlanningArtifacts(tempDir);
    assert.equal(isPlanningComplete(artifacts), false);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.contextPackStatus, 'invalid');
    assert.ok(hint?.contextPackIssues.includes('Context Pack Outcome must point to .omx/context/context-<timestamp>-<slug>.json.'));
  });

  it('accepts extra non-pack bullets once a valid context-pack declaration is present', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('issue-909-extra-bullets');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-909-extra-bullets.md'),
      [
        '# PRD',
        '',
        '## Context Pack Outcome',
        '- note: keep this pack synced before widening context',
        `- pack: created \`${contextPacks.relativePath}\``,
        '- index: `.omx/context/context-20260420T000000Z-issue-909-extra-bullets.md`',
        '',
        'Launch via omx ralph "Execute approved issue 909 extra bullets plan"',
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-issue-909-extra-bullets.md'), '# Test Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const artifacts = readPlanningArtifacts(tempDir);
    assert.equal(isPlanningComplete(artifacts), true);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.contextPackStatus, 'ready');
    assert.deepEqual(hint?.contextPack, { path: contextPacks.absolutePath, action: 'created' });
    assert.deepEqual(hint?.contextPackIssues, []);
  });

  it('resolves declared context-pack paths through the shared helper', () => {
    assert.deepEqual(
      resolveDeclaredContextPackPath(
        tempDir,
        './.omx/context/../context/context-20260420T000000Z-issue-905-helper.json',
      ),
      {
        normalizedPath: '.omx/context/context-20260420T000000Z-issue-905-helper.json',
        resolvedPath: join(tempDir, '.omx', 'context', 'context-20260420T000000Z-issue-905-helper.json'),
      },
    );
    assert.equal(
      resolveDeclaredContextPackPath(
        tempDir,
        '.omx/context/../../tmp/context-20260420T000000Z-issue-905-helper.json',
      ),
      null,
    );
  });

  it('keeps selector-backed hints read-only until launch-time materialization', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('issue-906');
    const runtimeSection = Array.from({ length: 80 }, () => 'Runtime contract detail keeps the build lane grounded.').join(' ');
    await writeRepoFile(
      'docs/runtime.md',
      `# Runtime\n\n## Runtime Contract\n\n${runtimeSection}\n\n## Deferred\n\nLater section.\n`,
    );
    const quickstartPath = await writeRepoFile(
      'docs/quickstart.md',
      '# Quickstart\n\nStart here.\n',
    );
    writeContextPackDocument(contextPacks.absolutePath, {
      schema: CONTEXT_PACK_SCHEMA,
      slug: 'issue-906',
      entries: [
        {
          label: 'boundary',
          path: defaultReadFirstRef('issue-906', 'scope').path,
          roles: ['scope'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: 'issue-906' },
            { tag: 'bounds', target: defaultReadFirstRef('issue-906', 'scope').path },
          ],
        },
        {
          label: 'runtime',
          path: 'docs/runtime.md',
          roles: ['build'],
          tags: ['runtime'],
          selector: {
            type: 'heading',
            value: '## Runtime Contract',
            maxWords: 120,
          },
          relationPath: [
            { tag: 'plan', target: 'issue-906' },
            { tag: 'implements', target: 'docs/runtime.md#runtime-contract' },
          ],
        },
        {
          label: 'quickstart',
          path: 'docs/quickstart.md',
          roles: ['build'],
          tags: ['quickstart'],
          relationPath: [
            { tag: 'plan', target: 'issue-906' },
            { tag: 'implements', target: 'docs/quickstart.md' },
          ],
        },
        {
          label: 'acceptance',
          path: defaultReadFirstRef('issue-906', 'verify').path,
          roles: ['verify'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: 'issue-906' },
            { tag: 'verifies', target: defaultReadFirstRef('issue-906', 'verify').path },
          ],
        },
      ],
    }, { refreshBasis: true });
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-906.md'),
      `# PRD\n\n${buildContextPackOutcome(contextPacks.relativePath)}\n\nLaunch via omx ralph "Execute approved issue 906 plan"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-issue-906.md'), '# Test Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const excerptDir = join(tempDir, '.omx', 'context', 'excerpts', 'context-20260420T000000Z-issue-906');
    const readOnlyHint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(readOnlyHint);
    assert.equal(readOnlyHint?.contextPackStatus, 'ready');
    assert.deepEqual(readOnlyHint?.contextRefs, []);
    assert.equal(existsSync(excerptDir), false);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph', { materializeContextRefs: true });
    assert.ok(hint);
    assert.equal(hint?.contextPackStatus, 'ready');
    const runtimeRef = hint?.contextRefs.find((ref) => ref.roles.includes('build') && ref.label === 'runtime');
    const quickstartRef = hint?.contextRefs.find((ref) => ref.roles.includes('build') && ref.label === 'quickstart');
    assert.ok(runtimeRef);
    assert.ok(quickstartRef);
    assert.equal(runtimeRef?.delivery, 'excerpt');
    assert.equal(
      runtimeRef?.path,
      contextPackExcerptPath(contextPacks.absolutePath, 0, 'runtime'),
    );
    assert.equal(quickstartRef?.delivery, 'file');
    assert.equal(quickstartRef?.path, quickstartPath);
    assert.ok(existsSync(runtimeRef!.path));
    const excerpt = await readFile(runtimeRef!.path, 'utf-8');
    assert.match(excerpt, /Context Excerpt/);
    assert.match(excerpt, /relation-path: plan: issue-906 -> implements: docs\/runtime\.md#runtime-contract/i);
    assert.match(excerpt, /Runtime Contract/);
    assert.match(excerpt, /Runtime contract detail keeps the build lane grounded\./);
    assert.match(excerpt, /\[excerpt truncated after 120 words\]/);
  });

  it('rejects manifest entries that leave long sources unexcerpted', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('issue-907');
    const longText = Array.from({ length: 90 }, () => 'This runtime file is intentionally too long to load wholesale.').join(' ');
    await writeRepoFile('docs/long-runtime.md', `# Runtime\n\n${longText}\n`);
    writeContextPackDocument(contextPacks.absolutePath, {
      schema: CONTEXT_PACK_SCHEMA,
      slug: 'issue-907',
      entries: [
        {
          label: 'boundary',
          path: defaultReadFirstRef('issue-907', 'scope').path,
          roles: ['scope'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: 'issue-907' },
            { tag: 'bounds', target: defaultReadFirstRef('issue-907', 'scope').path },
          ],
        },
        {
          label: 'runtime',
          path: 'docs/long-runtime.md',
          roles: ['build'],
          tags: ['runtime'],
          relationPath: [
            { tag: 'plan', target: 'issue-907' },
            { tag: 'implements', target: 'docs/long-runtime.md' },
          ],
        },
        {
          label: 'acceptance',
          path: defaultReadFirstRef('issue-907', 'verify').path,
          roles: ['verify'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: 'issue-907' },
            { tag: 'verifies', target: defaultReadFirstRef('issue-907', 'verify').path },
          ],
        },
      ],
    }, { refreshBasis: true });
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-907.md'),
      `# PRD\n\n${buildContextPackOutcome(contextPacks.relativePath)}\n\nLaunch via omx ralph "Execute approved issue 907 plan"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-issue-907.md'), '# Test Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const artifacts = readPlanningArtifacts(tempDir);
    assert.equal(isPlanningComplete(artifacts), false);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.contextPackStatus, 'invalid');
    assert.ok(hint?.contextPackIssues.some((issue) => issue.includes('must declare a selector')));
  });

  it('rejects invalid context pack structure for planning completeness but still exposes fallback guidance', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextDir = join(tempDir, '.omx', 'context');
    await mkdir(plansDir, { recursive: true });
    await mkdir(contextDir, { recursive: true });
    await writeFile(
      join(contextDir, 'context-20260420T000000Z-issue-905.json'),
      `${JSON.stringify({
        schema: 'wrong-schema',
        slug: 'issue-905',
        entries: [
          {
            label: 'boundary',
            path: 'docs/issue-905-boundary.md',
            roles: ['scope'],
          },
        ],
      }, null, 2)}\n`,
    );
    await writeRepoFile('docs/issue-905-boundary.md', '# boundary\n\nscope context.\n');
    await writeFile(
      join(plansDir, 'prd-issue-905.md'),
      [
        '# PRD',
        '',
        '## Context Pack Outcome',
        '- pack: created `.omx/context/context-20260420T000000Z-issue-905.json`',
        '',
        'Launch via omx ralph "Execute approved issue 905 plan"',
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-issue-905.md'), '# Test Spec\n');

    const artifacts = readPlanningArtifacts(tempDir);
    assert.equal(isPlanningComplete(artifacts), false);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.contextPackStatus, 'invalid');
    assert.ok(hint?.contextPackIssues.some((issue) => issue.includes('must declare schema')));
  });

  it('parses $ralph aliases with single-quoted task text for approved launch hints', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const specsDir = join(tempDir, '.omx', 'specs');
    const contextPacks = await writeContextPacks('issue-1072');
    await mkdir(plansDir, { recursive: true });
    await mkdir(specsDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-1072.md'),
      `# PRD\n\n${buildContextPackOutcome(contextPacks.relativePath)}\n\nLaunch via $ralph 'Execute approved issue 1072 plan'\n`,
    );
    await writeFile(join(plansDir, 'test-spec-issue-1072.md'), '# Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-issue-1072.md'), '# Deep Interview Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.command, "$ralph 'Execute approved issue 1072 plan'");
    assert.equal(hint?.task, 'Execute approved issue 1072 plan');
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-issue-1072.md'));
    assert.deepEqual(hint?.testSpecPaths, [join(plansDir, 'test-spec-issue-1072.md')]);
    assert.deepEqual(hint?.deepInterviewSpecPaths, [join(specsDir, 'deep-interview-issue-1072.md')]);
    assert.deepEqual(hint?.contextPack, { path: contextPacks.absolutePath, action: 'created' });
  });

  it('includes approved Ralph launch context with test and deep-interview artifacts', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const specsDir = join(tempDir, '.omx', 'specs');
    const contextPacks = await writeContextPacks('issue-1072');
    await mkdir(plansDir, { recursive: true });
    await mkdir(specsDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-1072.md'),
      `# PRD\n\n${buildContextPackOutcome(contextPacks.relativePath)}\n\nLaunch via omx ralph "Execute approved issue 1072 plan"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-issue-1072.md'), '# Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-issue-1072.md'), '# Deep Interview Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.task, 'Execute approved issue 1072 plan');
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-issue-1072.md'));
    assert.deepEqual(hint?.testSpecPaths, [join(plansDir, 'test-spec-issue-1072.md')]);
    assert.deepEqual(hint?.deepInterviewSpecPaths, [join(specsDir, 'deep-interview-issue-1072.md')]);
    assert.deepEqual(hint?.contextPack, { path: contextPacks.absolutePath, action: 'created' });
  });

  it('parses $team aliases with single-quoted task text for approved launch hints', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const specsDir = join(tempDir, '.omx', 'specs');
    const contextPacks = await writeContextPacks('issue-1142');
    await mkdir(plansDir, { recursive: true });
    await mkdir(specsDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-1142.md'),
      `# PRD\n\n${buildContextPackOutcome(contextPacks.relativePath)}\n\nLaunch via $team ralph 4:debugger 'Execute approved issue 1142 plan'\n`,
    );
    await writeFile(join(plansDir, 'test-spec-issue-1142.md'), '# Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-issue-1142.md'), '# Deep Interview Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team');
    assert.ok(hint);
    assert.equal(hint?.command, "$team ralph 4:debugger 'Execute approved issue 1142 plan'");
    assert.equal(hint?.task, 'Execute approved issue 1142 plan');
    assert.equal(hint?.workerCount, 4);
    assert.equal(hint?.agentType, 'debugger');
    assert.equal(hint?.linkedRalph, true);
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-issue-1142.md'));
    assert.deepEqual(hint?.testSpecPaths, [join(plansDir, 'test-spec-issue-1142.md')]);
    assert.deepEqual(hint?.deepInterviewSpecPaths, [join(specsDir, 'deep-interview-issue-1142.md')]);
    assert.deepEqual(hint?.contextPack, { path: contextPacks.absolutePath, action: 'created' });
  });

  it('includes approved team launch context with staffing and matching artifacts', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const specsDir = join(tempDir, '.omx', 'specs');
    const contextPacks = await writeContextPacks('issue-1142');
    await mkdir(plansDir, { recursive: true });
    await mkdir(specsDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-1142.md'),
      `# PRD\n\n${buildContextPackOutcome(contextPacks.relativePath)}\n\nLaunch via omx team ralph 4:debugger "Execute approved issue 1142 plan"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-issue-1142.md'), '# Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-issue-1142.md'), '# Deep Interview Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team');
    assert.ok(hint);
    assert.equal(hint?.task, 'Execute approved issue 1142 plan');
    assert.equal(hint?.workerCount, 4);
    assert.equal(hint?.agentType, 'debugger');
    assert.equal(hint?.linkedRalph, true);
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-issue-1142.md'));
    assert.deepEqual(hint?.testSpecPaths, [join(plansDir, 'test-spec-issue-1142.md')]);
    assert.deepEqual(hint?.deepInterviewSpecPaths, [join(specsDir, 'deep-interview-issue-1142.md')]);
    assert.deepEqual(hint?.contextPack, { path: contextPacks.absolutePath, action: 'created' });
  });

  it('binds approved team handoff context to the selected PRD slug in multi-plan repos', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const specsDir = join(tempDir, '.omx', 'specs');
    const alphaPacks = await writeContextPacks('alpha');
    const zetaPacks = await writeContextPacks('zeta');
    await mkdir(plansDir, { recursive: true });
    await mkdir(specsDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-alpha.md'),
      `# Alpha\n\n${buildContextPackOutcome(alphaPacks.relativePath)}\n\nLaunch via omx team 2:executor "Execute alpha"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-alpha.md'), '# Alpha Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-alpha.md'), '# Alpha Deep Interview\n');
    refreshContextPackBasis(alphaPacks.absolutePath);
    await writeFile(
      join(plansDir, 'prd-zeta.md'),
      `# Zeta\n\n${buildContextPackOutcome(zetaPacks.relativePath)}\n\nLaunch via omx team 5 "Execute zeta"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-zeta.md'), '# Zeta Deep Interview\n');
    refreshContextPackBasis(zetaPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team');
    assert.ok(hint);
    assert.equal(hint?.task, 'Execute zeta');
    assert.equal(hint?.workerCount, 5);
    assert.equal(hint?.agentType, undefined);
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-zeta.md'));
    assert.deepEqual(hint?.testSpecPaths, [join(plansDir, 'test-spec-zeta.md')]);
    assert.deepEqual(hint?.deepInterviewSpecPaths, [join(specsDir, 'deep-interview-zeta.md')]);
    assert.deepEqual(hint?.contextPack, { path: zetaPacks.absolutePath, action: 'created' });
  });

  it('finds older approved team handoff context by exact task in multi-plan repos', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const specsDir = join(tempDir, '.omx', 'specs');
    const alphaPacks = await writeContextPacks('alpha');
    const zetaPacks = await writeContextPacks('zeta');
    await mkdir(plansDir, { recursive: true });
    await mkdir(specsDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-alpha.md'),
      `# Alpha\n\n${buildContextPackOutcome(alphaPacks.relativePath)}\n\nLaunch via omx team 2:executor "Execute alpha"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-alpha.md'), '# Alpha Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-alpha.md'), '# Alpha Deep Interview\n');
    refreshContextPackBasis(alphaPacks.absolutePath);
    await writeFile(
      join(plansDir, 'prd-zeta.md'),
      `# Zeta\n\n${buildContextPackOutcome(zetaPacks.relativePath)}\n\nLaunch via omx team 5 "Execute zeta"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-zeta.md'), '# Zeta Deep Interview\n');
    refreshContextPackBasis(zetaPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team', { task: 'Execute alpha' });
    assert.ok(hint);
    assert.equal(hint?.task, 'Execute alpha');
    assert.equal(hint?.workerCount, 2);
    assert.equal(hint?.agentType, 'executor');
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-alpha.md'));
    assert.deepEqual(hint?.testSpecPaths, [join(plansDir, 'test-spec-alpha.md')]);
    assert.deepEqual(hint?.deepInterviewSpecPaths, [join(specsDir, 'deep-interview-alpha.md')]);
    assert.deepEqual(hint?.contextPack, { path: alphaPacks.absolutePath, action: 'created' });
  });

  it('binds approved handoff context to the selected PRD slug in multi-plan repos', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const specsDir = join(tempDir, '.omx', 'specs');
    const alphaPacks = await writeContextPacks('alpha');
    const zetaPacks = await writeContextPacks('zeta');
    await mkdir(plansDir, { recursive: true });
    await mkdir(specsDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-alpha.md'),
      `# Alpha\n\n${buildContextPackOutcome(alphaPacks.relativePath)}\n\nLaunch via omx ralph "Execute alpha"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-alpha.md'), '# Alpha Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-alpha.md'), '# Alpha Deep Interview\n');
    refreshContextPackBasis(alphaPacks.absolutePath);
    await writeFile(
      join(plansDir, 'prd-zeta.md'),
      `# Zeta\n\n${buildContextPackOutcome(zetaPacks.relativePath)}\n\nLaunch via omx ralph "Execute zeta"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-zeta.md'), '# Zeta Deep Interview\n');
    refreshContextPackBasis(zetaPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.task, 'Execute zeta');
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-zeta.md'));
    assert.deepEqual(hint?.testSpecPaths, [join(plansDir, 'test-spec-zeta.md')]);
    assert.deepEqual(hint?.deepInterviewSpecPaths, [join(specsDir, 'deep-interview-zeta.md')]);
    assert.deepEqual(hint?.contextPack, { path: zetaPacks.absolutePath, action: 'created' });
  });

  it('finds older approved Ralph handoff context by exact task in multi-plan repos', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const specsDir = join(tempDir, '.omx', 'specs');
    const alphaPacks = await writeContextPacks('alpha');
    const zetaPacks = await writeContextPacks('zeta');
    await mkdir(plansDir, { recursive: true });
    await mkdir(specsDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-alpha.md'),
      `# Alpha\n\n${buildContextPackOutcome(alphaPacks.relativePath)}\n\nLaunch via omx ralph "Execute alpha"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-alpha.md'), '# Alpha Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-alpha.md'), '# Alpha Deep Interview\n');
    refreshContextPackBasis(alphaPacks.absolutePath);
    await writeFile(
      join(plansDir, 'prd-zeta.md'),
      `# Zeta\n\n${buildContextPackOutcome(zetaPacks.relativePath)}\n\nLaunch via omx ralph "Execute zeta"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-zeta.md'), '# Zeta Deep Interview\n');
    refreshContextPackBasis(zetaPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph', { task: 'Execute alpha' });
    assert.ok(hint);
    assert.equal(hint?.task, 'Execute alpha');
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-alpha.md'));
    assert.deepEqual(hint?.testSpecPaths, [join(plansDir, 'test-spec-alpha.md')]);
    assert.deepEqual(hint?.deepInterviewSpecPaths, [join(specsDir, 'deep-interview-alpha.md')]);
    assert.deepEqual(hint?.contextPack, { path: alphaPacks.absolutePath, action: 'created' });
  });

  it('prefers the last reusable Ralph handoff when a newer exact-task PRD is incomplete', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const readyPacks = await writeContextPacks('alpha-shared');
    const incompletePacks = await writeContextPacks('zeta-shared', ['scope']);
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-alpha-shared.md'),
      `# Alpha\n\n${buildContextPackOutcome(readyPacks.relativePath)}\n\nLaunch via omx ralph "Execute shared handoff"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-alpha-shared.md'), '# Alpha Test Spec\n');
    refreshContextPackBasis(readyPacks.absolutePath);
    await writeFile(
      join(plansDir, 'prd-zeta-shared.md'),
      `# Zeta\n\n${buildContextPackOutcome(incompletePacks.relativePath)}\n\nLaunch via omx ralph "Execute shared handoff"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-zeta-shared.md'), '# Zeta Test Spec\n');
    refreshContextPackBasis(incompletePacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph', { task: 'Execute shared handoff' });
    assert.ok(hint);
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-alpha-shared.md'));
    assert.equal(hint?.contextPackStatus, 'ready');
  });

  it('prefers the last reusable bare Ralph handoff when the latest unique same-task PRD is incomplete', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const readyPacks = await writeContextPacks('alpha-shared-bare');
    const incompletePacks = await writeContextPacks('zeta-shared-bare', ['scope']);
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-alpha-shared-bare.md'),
      `# Alpha\n\n${buildContextPackOutcome(readyPacks.relativePath)}\n\nLaunch via omx ralph "Execute shared bare handoff"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-alpha-shared-bare.md'), '# Alpha Test Spec\n');
    refreshContextPackBasis(readyPacks.absolutePath);
    await writeFile(
      join(plansDir, 'prd-zeta-shared-bare.md'),
      `# Zeta\n\n${buildContextPackOutcome(incompletePacks.relativePath)}\n\nLaunch via omx ralph "Execute shared bare handoff"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-zeta-shared-bare.md'), '# Zeta Test Spec\n');
    refreshContextPackBasis(incompletePacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-alpha-shared-bare.md'));
    assert.equal(hint?.contextPackStatus, 'ready');
  });

  it('prefers the last reusable team handoff when a newer exact-task PRD is incomplete', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const readyPacks = await writeContextPacks('alpha-shared-team');
    const incompletePacks = await writeContextPacks('zeta-shared-team', ['scope']);
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-alpha-shared-team.md'),
      `# Alpha\n\n${buildContextPackOutcome(readyPacks.relativePath)}\n\nLaunch via omx team 2:executor "Execute shared team handoff"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-alpha-shared-team.md'), '# Alpha Test Spec\n');
    refreshContextPackBasis(readyPacks.absolutePath);
    await writeFile(
      join(plansDir, 'prd-zeta-shared-team.md'),
      `# Zeta\n\n${buildContextPackOutcome(incompletePacks.relativePath)}\n\nLaunch via omx team 2:executor "Execute shared team handoff"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-zeta-shared-team.md'), '# Zeta Test Spec\n');
    refreshContextPackBasis(incompletePacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team', { task: 'Execute shared team handoff' });
    assert.ok(hint);
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-alpha-shared-team.md'));
    assert.equal(hint?.contextPackStatus, 'ready');
    assert.equal(hint?.workerCount, 2);
    assert.equal(hint?.agentType, 'executor');
  });

  it('prefers the last reusable bare team handoff when the latest unique same-task PRD is incomplete', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const readyPacks = await writeContextPacks('alpha-shared-team-bare');
    const incompletePacks = await writeContextPacks('zeta-shared-team-bare', ['scope']);
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-alpha-shared-team-bare.md'),
      `# Alpha\n\n${buildContextPackOutcome(readyPacks.relativePath)}\n\nLaunch via omx team 2:executor "Execute shared bare team handoff"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-alpha-shared-team-bare.md'), '# Alpha Test Spec\n');
    refreshContextPackBasis(readyPacks.absolutePath);
    await writeFile(
      join(plansDir, 'prd-zeta-shared-team-bare.md'),
      `# Zeta\n\n${buildContextPackOutcome(incompletePacks.relativePath)}\n\nLaunch via omx team 2:executor "Execute shared bare team handoff"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-zeta-shared-team-bare.md'), '# Zeta Test Spec\n');
    refreshContextPackBasis(incompletePacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team');
    assert.ok(hint);
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-alpha-shared-team-bare.md'));
    assert.equal(hint?.contextPackStatus, 'ready');
    assert.equal(hint?.workerCount, 2);
    assert.equal(hint?.agentType, 'executor');
  });

  it('keeps the latest non-ready exact team hint when an older same-task PRD changes the launch signature', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const readyPacks = await writeContextPacks('alpha-shared-team-signature');
    const incompletePacks = await writeContextPacks('zeta-shared-team-signature', ['scope']);
    const task = 'Execute shared team handoff';
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-alpha-shared-team-signature.md'),
      `# Alpha\n\n${buildContextPackOutcome(readyPacks.relativePath)}\n\nLaunch via omx team 2:executor ${JSON.stringify(task)}\n`,
    );
    await writeFile(join(plansDir, 'test-spec-alpha-shared-team-signature.md'), '# Alpha Test Spec\n');
    refreshContextPackBasis(readyPacks.absolutePath);
    await writeFile(
      join(plansDir, 'prd-zeta-shared-team-signature.md'),
      `# Zeta\n\n${buildContextPackOutcome(incompletePacks.relativePath)}\n\nLaunch via omx team 5:debugger ${JSON.stringify(task)}\n`,
    );
    await writeFile(join(plansDir, 'test-spec-zeta-shared-team-signature.md'), '# Zeta Test Spec\n');
    refreshContextPackBasis(incompletePacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team', { task });
    assert.ok(hint);
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-zeta-shared-team-signature.md'));
    assert.equal(hint?.contextPackStatus, 'incomplete');
    assert.equal(hint?.workerCount, 5);
    assert.equal(hint?.agentType, 'debugger');
  });

  it('keeps the latest non-ready bare team hint when an older same-task PRD changes the launch signature', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const readyPacks = await writeContextPacks('alpha-shared-team-bare-signature');
    const incompletePacks = await writeContextPacks('zeta-shared-team-bare-signature', ['scope']);
    const task = 'Execute shared bare team handoff';
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-alpha-shared-team-bare-signature.md'),
      `# Alpha\n\n${buildContextPackOutcome(readyPacks.relativePath)}\n\nLaunch via omx team 2:executor ${JSON.stringify(task)}\n`,
    );
    await writeFile(join(plansDir, 'test-spec-alpha-shared-team-bare-signature.md'), '# Alpha Test Spec\n');
    refreshContextPackBasis(readyPacks.absolutePath);
    await writeFile(
      join(plansDir, 'prd-zeta-shared-team-bare-signature.md'),
      `# Zeta\n\n${buildContextPackOutcome(incompletePacks.relativePath)}\n\nLaunch via omx team 5:debugger ${JSON.stringify(task)}\n`,
    );
    await writeFile(join(plansDir, 'test-spec-zeta-shared-team-bare-signature.md'), '# Zeta Test Spec\n');
    refreshContextPackBasis(incompletePacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team');
    assert.ok(hint);
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-zeta-shared-team-bare-signature.md'));
    assert.equal(hint?.contextPackStatus, 'incomplete');
    assert.equal(hint?.workerCount, 5);
    assert.equal(hint?.agentType, 'debugger');
  });

  it('prefers the older exact team handoff when a same-task PRD also contains a different launch signature', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const readyPacks = await writeContextPacks('alpha-shared-team-signature-fallback');
    const incompletePacks = await writeContextPacks('zeta-shared-team-signature-fallback', ['scope']);
    const task = 'Execute shared team handoff';
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-alpha-shared-team-signature-fallback.md'),
      [
        '# Alpha',
        '',
        buildContextPackOutcome(readyPacks.relativePath),
        '',
        `Launch via omx team 5:debugger ${JSON.stringify(task)}`,
        `Launch via $team 2:executor ${JSON.stringify(task)}`,
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-alpha-shared-team-signature-fallback.md'), '# Alpha Test Spec\n');
    refreshContextPackBasis(readyPacks.absolutePath);
    await writeFile(
      join(plansDir, 'prd-zeta-shared-team-signature-fallback.md'),
      `# Zeta\n\n${buildContextPackOutcome(incompletePacks.relativePath)}\n\nLaunch via omx team 5:debugger ${JSON.stringify(task)}\n`,
    );
    await writeFile(join(plansDir, 'test-spec-zeta-shared-team-signature-fallback.md'), '# Zeta Test Spec\n');
    refreshContextPackBasis(incompletePacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team', { task });
    assert.ok(hint);
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-alpha-shared-team-signature-fallback.md'));
    assert.equal(hint?.contextPackStatus, 'ready');
    assert.equal(hint?.workerCount, 5);
    assert.equal(hint?.agentType, 'debugger');
  });

  it('prefers the older bare team handoff when a same-task PRD also contains a different launch signature', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const readyPacks = await writeContextPacks('alpha-shared-team-bare-signature-fallback');
    const incompletePacks = await writeContextPacks('zeta-shared-team-bare-signature-fallback', ['scope']);
    const task = 'Execute shared bare team handoff';
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-alpha-shared-team-bare-signature-fallback.md'),
      [
        '# Alpha',
        '',
        buildContextPackOutcome(readyPacks.relativePath),
        '',
        `Launch via omx team 5:debugger ${JSON.stringify(task)}`,
        `Launch via $team 2:executor ${JSON.stringify(task)}`,
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-alpha-shared-team-bare-signature-fallback.md'), '# Alpha Test Spec\n');
    refreshContextPackBasis(readyPacks.absolutePath);
    await writeFile(
      join(plansDir, 'prd-zeta-shared-team-bare-signature-fallback.md'),
      `# Zeta\n\n${buildContextPackOutcome(incompletePacks.relativePath)}\n\nLaunch via omx team 5:debugger ${JSON.stringify(task)}\n`,
    );
    await writeFile(join(plansDir, 'test-spec-zeta-shared-team-bare-signature-fallback.md'), '# Zeta Test Spec\n');
    refreshContextPackBasis(incompletePacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team');
    assert.ok(hint);
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-alpha-shared-team-bare-signature-fallback.md'));
    assert.equal(hint?.contextPackStatus, 'ready');
    assert.equal(hint?.workerCount, 5);
    assert.equal(hint?.agentType, 'debugger');
  });

  it('prefers the last reusable bare Ralph handoff when the latest unique same-task PRD is missing its matching test spec', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const readyPacks = await writeContextPacks('alpha-shared-bare-missing-baseline');
    const latestPacks = await writeContextPacks('zeta-shared-bare-missing-baseline');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-alpha-shared-bare-missing-baseline.md'),
      `# Alpha\n\n${buildContextPackOutcome(readyPacks.relativePath)}\n\nLaunch via omx ralph "Execute shared missing-baseline bare handoff"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-alpha-shared-bare-missing-baseline.md'), '# Alpha Test Spec\n');
    refreshContextPackBasis(readyPacks.absolutePath);
    await writeFile(
      join(plansDir, 'prd-zeta-shared-bare-missing-baseline.md'),
      `# Zeta\n\n${buildContextPackOutcome(latestPacks.relativePath)}\n\nLaunch via omx ralph "Execute shared missing-baseline bare handoff"\n`,
    );
    refreshContextPackBasis(latestPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-alpha-shared-bare-missing-baseline.md'));
    assert.equal(hint?.contextPackStatus, 'ready');
  });

  it('surfaces the latest non-ready exact team hint when the matching test spec is missing and no older reusable lineage exists', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const latestPacks = await writeContextPacks('issue-missing-baseline-exact');
    const task = 'Execute shared missing-baseline exact handoff';
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-missing-baseline-exact.md'),
      `# Latest\n\n${buildContextPackOutcome(latestPacks.relativePath)}\n\nLaunch via omx team 4:reviewer ${JSON.stringify(task)}\n`,
    );
    refreshContextPackBasis(latestPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team', { task });
    assert.ok(hint);
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-issue-missing-baseline-exact.md'));
    assert.equal(hint?.contextPackStatus, 'missing-baseline');
    assert.equal(hint?.workerCount, 4);
    assert.equal(hint?.agentType, 'reviewer');
    assert.ok(hint?.contextPackIssues.includes('Approved plan is missing a matching test spec.'));
  });

  it('surfaces the latest non-ready bare Ralph hint when the matching test spec is missing and no older reusable lineage exists', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const latestPacks = await writeContextPacks('issue-missing-baseline-bare');
    const task = 'Execute shared missing-baseline bare anchor';
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-missing-baseline-bare.md'),
      `# Latest\n\n${buildContextPackOutcome(latestPacks.relativePath)}\n\nLaunch via omx ralph ${JSON.stringify(task)}\n`,
    );
    refreshContextPackBasis(latestPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-issue-missing-baseline-bare.md'));
    assert.equal(hint?.contextPackStatus, 'missing-baseline');
    assert.equal(hint?.task, task);
    assert.ok(hint?.contextPackIssues.includes('Approved plan is missing a matching test spec.'));
  });

  it('returns the newest broken exact-task handoff when no reusable match exists', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const olderIncompletePacks = await writeContextPacks('alpha-broken', ['scope']);
    const newerIncompletePacks = await writeContextPacks('zeta-broken', ['build']);
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-alpha-broken.md'),
      `# Alpha\n\n${buildContextPackOutcome(olderIncompletePacks.relativePath)}\n\nLaunch via omx ralph "Execute broken handoff"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-alpha-broken.md'), '# Alpha Test Spec\n');
    refreshContextPackBasis(olderIncompletePacks.absolutePath);
    await writeFile(
      join(plansDir, 'prd-zeta-broken.md'),
      `# Zeta\n\n${buildContextPackOutcome(newerIncompletePacks.relativePath)}\n\nLaunch via omx ralph "Execute broken handoff"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-zeta-broken.md'), '# Zeta Test Spec\n');
    refreshContextPackBasis(newerIncompletePacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph', { task: 'Execute broken handoff' });
    assert.ok(hint);
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-zeta-broken.md'));
    assert.equal(hint?.contextPackStatus, 'incomplete');
    assert.deepEqual(hint?.missingRequiredContextPackRoles, ['scope', 'verify']);
  });

  it('honors the requested Ralph task when a single plan lists multiple Ralph launch hints', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('issue-909');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-909.md'),
      [
        '# PRD',
        '',
        buildContextPackOutcome(contextPacks.relativePath),
        '',
        'Launch via omx ralph "Execute alpha"',
        'Launch via omx ralph "Execute beta"',
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-issue-909.md'), '# Test Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph', { task: 'Execute alpha' });
    assert.ok(hint);
    assert.equal(hint?.task, 'Execute alpha');
    assert.equal(hint?.command, 'omx ralph "Execute alpha"');
  });

  it('fails closed when a single plan repeats the same Ralph task in multiple launch hints', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('issue-909-duplicate');
    const prdPath = join(plansDir, 'prd-issue-909-duplicate.md');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      prdPath,
      [
        '# PRD',
        '',
        buildContextPackOutcome(contextPacks.relativePath),
        '',
        'Launch via omx ralph "Execute alpha"',
        'Launch via $ralph "Execute alpha"',
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-issue-909-duplicate.md'), '# Test Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph', {
      prdPath,
      task: 'Execute alpha',
    });
    assert.equal(hint, null);
  });

  it('rejects non-canonical absolute PRD overrides even when the slug matches in-repo artifacts', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const externalDir = await mkdtemp(join(tmpdir(), 'omx-external-prd-'));
    const contextPacks = await writeContextPacks('issue-909-external');
    try {
      await mkdir(plansDir, { recursive: true });
      await writeFile(
        join(plansDir, 'prd-issue-909-external.md'),
        [
          '# Canonical PRD',
          '',
          buildContextPackOutcome(contextPacks.relativePath),
          '',
          'Launch via omx ralph "Execute canonical alpha"',
        ].join('\n'),
      );
      await writeFile(join(plansDir, 'test-spec-issue-909-external.md'), '# Test Spec\n');
      refreshContextPackBasis(contextPacks.absolutePath);

      const externalPrdPath = join(externalDir, 'prd-issue-909-external.md');
      await writeFile(
        externalPrdPath,
        [
          '# External PRD',
          '',
          'Launch via omx ralph "Execute external alpha"',
        ].join('\n'),
      );

      const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph', {
        prdPath: externalPrdPath,
        task: 'Execute external alpha',
      });
      assert.equal(hint, null);
    } finally {
      await rm(externalDir, { recursive: true, force: true });
    }
  });

  it('preserves the caller absolute PRD path when it matches a canonical plan by realpath', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const aliasRoot = `${tempDir}-alias`;
    try {
      await mkdir(plansDir, { recursive: true });
      const canonicalPrdPath = join(plansDir, 'prd-issue-909-aliased.md');
      await writeFile(
        canonicalPrdPath,
        [
          '# Canonical PRD',
          '',
          'Launch via omx ralph "Execute aliased alpha"',
        ].join('\n'),
      );
      await writeFile(join(plansDir, 'test-spec-issue-909-aliased.md'), '# Test Spec\n');
      await symlink(tempDir, aliasRoot);

      const aliasedPrdPath = join(aliasRoot, '.omx', 'plans', 'prd-issue-909-aliased.md');
      const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph', {
        prdPath: aliasedPrdPath,
        task: 'Execute aliased alpha',
      });
      assert.ok(hint);
      assert.equal(hint?.sourcePath, aliasedPrdPath);
    } finally {
      await rm(aliasRoot, { recursive: true, force: true });
    }
  });

  it('derives slug, test specs, and pack basis from the canonical PRD when an absolute alias has a different basename', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('issue-909-alias-basis');
    const aliasRoot = `${tempDir}-alias-basis`;
    try {
      await mkdir(plansDir, { recursive: true });
      const canonicalPrdPath = join(plansDir, 'prd-issue-909-alias-basis.md');
      await writeFile(
        canonicalPrdPath,
        [
          '# Canonical PRD',
          '',
          buildContextPackOutcome(contextPacks.relativePath),
          '',
          'Launch via omx ralph "Execute aliased basis plan"',
        ].join('\n'),
      );
      await writeFile(join(plansDir, 'test-spec-issue-909-alias-basis.md'), '# Test Spec\n');
      refreshContextPackBasis(contextPacks.absolutePath);

      await mkdir(aliasRoot, { recursive: true });
      const aliasedPrdPath = join(aliasRoot, 'custom-approved-plan.md');
      await symlink(canonicalPrdPath, aliasedPrdPath);

      const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph', {
        prdPath: aliasedPrdPath,
        task: 'Execute aliased basis plan',
      });
      assert.ok(hint);
      assert.equal(hint?.sourcePath, aliasedPrdPath);
      assert.equal(hint?.contextPackStatus, 'ready');
      assert.deepEqual(hint?.testSpecPaths, [join(plansDir, 'test-spec-issue-909-alias-basis.md')]);
      assert.deepEqual(hint?.contextPack, { path: contextPacks.absolutePath, action: 'created' });
    } finally {
      await rm(aliasRoot, { recursive: true, force: true });
    }
  });

  it('fails closed for bare Ralph lookups when a single plan lists multiple Ralph launch hints', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('issue-909-bare');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-909-bare.md'),
      [
        '# PRD',
        '',
        buildContextPackOutcome(contextPacks.relativePath),
        '',
        'Launch via omx ralph "Execute alpha"',
        'Launch via omx ralph "Execute beta"',
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-issue-909-bare.md'), '# Test Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.equal(hint, null);
  });

  it('honors the requested team task when a single plan lists multiple team launch hints', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('issue-910');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-910.md'),
      [
        '# PRD',
        '',
        buildContextPackOutcome(contextPacks.relativePath),
        '',
        'Launch via omx team 2:executor "Execute alpha"',
        'Launch via omx team 5:debugger "Execute beta"',
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-issue-910.md'), '# Test Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team', { task: 'Execute alpha' });
    assert.ok(hint);
    assert.equal(hint?.task, 'Execute alpha');
    assert.equal(hint?.workerCount, 2);
    assert.equal(hint?.agentType, 'executor');
    assert.equal(hint?.command, 'omx team 2:executor "Execute alpha"');
  });

  it('fails closed when a single plan repeats the same team task in multiple launch hints', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('issue-910-duplicate');
    const prdPath = join(plansDir, 'prd-issue-910-duplicate.md');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      prdPath,
      [
        '# PRD',
        '',
        buildContextPackOutcome(contextPacks.relativePath),
        '',
        'Launch via omx team 2:executor "Execute alpha"',
        'Launch via $team 5:debugger "Execute alpha"',
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-issue-910-duplicate.md'), '# Test Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team', {
      prdPath,
      task: 'Execute alpha',
    });
    assert.equal(hint, null);
  });

  it('fails closed when a newer same-task team PRD is ambiguous instead of reviving an older unique handoff', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const olderContextPacks = await writeContextPacks('issue-910-older');
    const newerContextPacks = await writeContextPacks('issue-910-newer');
    const sharedTask = 'Ship feature';
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-alpha-ship-feature.md'),
      [
        '# Older approved plan',
        '',
        buildContextPackOutcome(olderContextPacks.relativePath),
        '',
        `Launch via omx team 2:executor ${JSON.stringify(sharedTask)}`,
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-alpha-ship-feature.md'), '# Test Spec\n');
    refreshContextPackBasis(olderContextPacks.absolutePath);
    await writeFile(
      join(plansDir, 'prd-zeta-ship-feature.md'),
      [
        '# Newer ambiguous approved plan',
        '',
        buildContextPackOutcome(newerContextPacks.relativePath),
        '',
        `Launch via omx team 3:reviewer ${JSON.stringify(sharedTask)}`,
        `Launch via $team ralph 5:debugger ${JSON.stringify(sharedTask)}`,
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-zeta-ship-feature.md'), '# Test Spec\n');
    refreshContextPackBasis(newerContextPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team', { task: sharedTask });
    assert.equal(hint, null);
  });

  it('keeps the latest non-ready bare team hint when an older same-task PRD only differs by launch signature', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const olderContextPacks = await writeContextPacks('issue-910-older-bare-ambiguous');
    const newerContextPacks = await writeContextPacks('issue-910-newer-broken-bare');
    const sharedTask = 'Ship feature';
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-alpha-ship-feature-bare.md'),
      [
        '# Older ambiguous approved plan',
        '',
        buildContextPackOutcome(olderContextPacks.relativePath),
        '',
        `Launch via omx team 2:executor ${JSON.stringify(sharedTask)}`,
        `Launch via $team ralph 5:debugger ${JSON.stringify(sharedTask)}`,
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-alpha-ship-feature-bare.md'), '# Test Spec\n');
    refreshContextPackBasis(olderContextPacks.absolutePath);
    await rm(olderContextPacks.absolutePath, { force: true });

    await writeFile(
      join(plansDir, 'prd-zeta-ship-feature-bare.md'),
      [
        '# Newer broken approved plan',
        '',
        buildContextPackOutcome(newerContextPacks.relativePath),
        '',
        `Launch via omx team 3:reviewer ${JSON.stringify(sharedTask)}`,
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-zeta-ship-feature-bare.md'), '# Test Spec\n');
    refreshContextPackBasis(newerContextPacks.absolutePath);
    await rm(newerContextPacks.absolutePath, { force: true });

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team');
    assert.ok(hint);
    assert.equal(hint?.sourcePath, join(plansDir, 'prd-zeta-ship-feature-bare.md'));
    assert.equal(hint?.contextPackStatus, 'incomplete');
    assert.equal(hint?.workerCount, 3);
    assert.equal(hint?.agentType, 'reviewer');
  });

  it('fails closed for bare team lookups when an older same-signature lineage becomes ambiguous', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const olderContextPacks = await writeContextPacks('issue-910-older-bare-same-signature-ambiguous');
    const newerContextPacks = await writeContextPacks('issue-910-newer-broken-bare-same-signature', ['scope']);
    const sharedTask = 'Ship feature';
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-alpha-ship-feature-bare-same-signature.md'),
      [
        '# Older ambiguous approved plan',
        '',
        buildContextPackOutcome(olderContextPacks.relativePath),
        '',
        `Launch via omx team 3:reviewer ${JSON.stringify(sharedTask)}`,
        `Launch via $team 3:reviewer ${JSON.stringify(sharedTask)}`,
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-alpha-ship-feature-bare-same-signature.md'), '# Test Spec\n');
    refreshContextPackBasis(olderContextPacks.absolutePath);
    await rm(olderContextPacks.absolutePath, { force: true });

    await writeFile(
      join(plansDir, 'prd-zeta-ship-feature-bare-same-signature.md'),
      [
        '# Newer broken approved plan',
        '',
        buildContextPackOutcome(newerContextPacks.relativePath),
        '',
        `Launch via omx team 3:reviewer ${JSON.stringify(sharedTask)}`,
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-zeta-ship-feature-bare-same-signature.md'), '# Test Spec\n');
    refreshContextPackBasis(newerContextPacks.absolutePath);
    await rm(newerContextPacks.absolutePath, { force: true });

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team');
    assert.equal(hint, null);
  });

  it('rehydrates the exact team launch hint by command when one PRD repeats the same task', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('issue-910-command');
    const sharedTask = 'Ship feature';
    const primaryCommand = `omx team 2:executor ${JSON.stringify(sharedTask)}`;
    const secondaryCommand = `$team ralph 5:debugger ${JSON.stringify(sharedTask)}`;
    const prdPath = join(plansDir, 'prd-issue-910-command.md');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      prdPath,
      [
        '# Approved plan',
        '',
        buildContextPackOutcome(contextPacks.relativePath),
        '',
        `Launch via ${primaryCommand}`,
        `Launch via ${secondaryCommand}`,
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-issue-910-command.md'), '# Test Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team', {
      prdPath,
      task: sharedTask,
      command: primaryCommand,
    });
    assert.ok(hint);
    assert.equal(hint?.command, primaryCommand);
    assert.equal(hint?.workerCount, 2);
    assert.equal(hint?.agentType, 'executor');
    assert.equal(hint?.linkedRalph, false);
  });

  it('fails closed for bare team lookups when a single plan lists multiple team launch hints', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('issue-910-bare');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-910-bare.md'),
      [
        '# PRD',
        '',
        buildContextPackOutcome(contextPacks.relativePath),
        '',
        'Launch via omx team 2:executor "Execute alpha"',
        'Launch via omx team 5:debugger "Execute beta"',
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-issue-910-bare.md'), '# Test Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'team');
    assert.equal(hint, null);
  });

  it('marks approved handoffs non-ready when the generated index is missing', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('issue-911');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-911.md'),
      `# PRD\n\n${buildContextPackOutcome(contextPacks.relativePath)}\n\nLaunch via omx ralph "Execute approved issue 911 plan"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-issue-911.md'), '# Test Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);
    await rm(contextPackIndexPath(contextPacks.absolutePath));

    const artifacts = readPlanningArtifacts(tempDir);
    assert.equal(isPlanningComplete(artifacts), false);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph', { materializeContextRefs: true });
    assert.ok(hint);
    assert.equal(hint?.contextPackStatus, 'incomplete');
    assert.deepEqual(hint?.missingRequiredContextPackRoles, []);
    assert.ok(hint?.contextPackIssues.some((issue) => issue.includes('missing generated index')));
    assert.equal((hint?.contextRefs ?? []).length, 0);
  });

  it('marks approved handoffs invalid when the generated index drifts outside the scaffold contract', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const contextPacks = await writeContextPacks('issue-912-drifted-index');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-912-drifted-index.md'),
      `# PRD\n\n${buildContextPackOutcome(contextPacks.relativePath)}\n\nLaunch via omx ralph "Execute approved issue 912 drifted index plan"\n`,
    );
    await writeFile(join(plansDir, 'test-spec-issue-912-drifted-index.md'), '# Test Spec\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const driftedIndex = (await readFile(contextPackIndexPath(contextPacks.absolutePath), 'utf-8')).replace(
      '## Refs',
      '## Extra Brief\n- stale requirement\n\n## Refs',
    );
    await writeFile(contextPackIndexPath(contextPacks.absolutePath), driftedIndex);

    const artifacts = readPlanningArtifacts(tempDir);
    assert.equal(isPlanningComplete(artifacts), false);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.contextPackStatus, 'invalid');
    assert.ok(hint?.contextPackIssues.some((issue) => issue.includes('must remain scaffold-only outside View Notes')));
  });

  it('surfaces deep-interview specs and context packs for downstream traceability', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const specsDir = join(tempDir, '.omx', 'specs');
    const contextPacks = await writeContextPacks('issue-827');
    await mkdir(plansDir, { recursive: true });
    await mkdir(specsDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-827.md'),
      `# PRD\n\n${buildContextPackOutcome(contextPacks.relativePath)}\n`,
    );
    await writeFile(join(plansDir, 'test-spec-issue-827.md'), '# Test Spec\n');
    await writeFile(join(specsDir, 'deep-interview-issue-827.md'), '# Deep Interview Spec\n');
    await writeFile(join(specsDir, 'deep-interview-20260427T153000Z-issue-827.md'), '# Timestamped Deep Interview Spec\n');
    await writeFile(join(specsDir, 'deep-interview-autoresearch-20260427T153000Z-issue-827.md'), '# Autoresearch Draft\n');
    refreshContextPackBasis(contextPacks.absolutePath);

    const artifacts = readPlanningArtifacts(tempDir);
    assert.equal(isPlanningComplete(artifacts), true);
    assert.deepEqual(
      artifacts.deepInterviewSpecPaths.map((file) => file.split('/').pop()),
      [
        'deep-interview-issue-827.md',
        'deep-interview-20260427T153000Z-issue-827.md',
      ],
    );
    assert.deepEqual(
      artifacts.contextPackPaths.map((file) => file.split('/').pop()),
      ['context-20260420T000000Z-issue-827.json'],
    );
  });

  it('marks packs stale when an approved test spec changes after pack creation', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-908.md'),
      '# PRD\n\n## Context Pack Outcome\n- pack: created `.omx/context/context-20260420T000000Z-issue-908.json`\n\nLaunch via omx ralph "Execute approved issue 908 plan"\n',
    );
    await writeFile(join(plansDir, 'test-spec-issue-908.md'), '# Test Spec\n\nInitial basis.\n');
    const contextPacks = await writeContextPacks('issue-908');
    refreshContextPackBasis(contextPacks.absolutePath);
    await writeFile(join(plansDir, 'test-spec-issue-908.md'), '# Test Spec\n\nChanged basis.\n');

    const artifacts = readPlanningArtifacts(tempDir);
    assert.equal(isPlanningComplete(artifacts), false);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.contextPackStatus, 'invalid');
    assert.deepEqual(hint?.missingRequiredContextPackRoles, []);
    assert.ok(
      hint?.contextPackIssues.some((issue) => issue.includes('basis test-spec hash')),
    );
  });

  it('marks packs stale when Context Pack Outcome is added after pack sync', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const prdPath = join(plansDir, 'prd-issue-909-outcome-after-sync.md');
    await writeFile(
      prdPath,
      '# PRD\n\nLaunch via omx ralph "Execute approved outcome-after-sync plan"\n',
    );
    await writeFile(join(plansDir, 'test-spec-issue-909-outcome-after-sync.md'), '# Test Spec\n');
    const contextPacks = await writeContextPacks('issue-909-outcome-after-sync');
    refreshContextPackBasis(contextPacks.absolutePath);

    await writeFile(
      prdPath,
      [
        '# PRD',
        '',
        buildContextPackOutcome(contextPacks.relativePath),
        '',
        'Launch via omx ralph "Execute approved outcome-after-sync plan"',
        '',
      ].join('\n'),
    );

    const artifacts = readPlanningArtifacts(tempDir);
    assert.equal(isPlanningComplete(artifacts), false);

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.contextPackStatus, 'invalid');
    assert.deepEqual(hint?.missingRequiredContextPackRoles, []);
    assert.ok(
      hint?.contextPackIssues.some((issue) => issue.includes('basis prd hash')),
    );
  });

  it('loads a matching Team DAG sidecar for the latest PRD slug', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-alpha.md'), '# Alpha\n');
    await writeFile(join(plansDir, 'test-spec-alpha.md'), '# Alpha Test\n');
    await writeFile(join(plansDir, 'team-dag-alpha.json'), JSON.stringify({
      schema_version: 1,
      nodes: [{ id: 'impl', subject: 'Implement alpha', description: 'Implement alpha DAG' }],
    }));

    const result = readTeamDagHandoffForLatestPlan(tempDir);
    assert.equal(result.source, 'sidecar');
    assert.equal(result.planSlug, 'alpha');
    assert.equal(result.dag?.nodes[0]?.id, 'impl');
  });

  it('loads a Team DAG sidecar for a timestamped PRD using the canonical artifact slug', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-20260427T153100Z-alpha.md'), '# Alpha\n');
    await writeFile(join(plansDir, 'test-spec-20260427T153100Z-alpha.md'), '# Alpha Test\n');
    await writeFile(join(plansDir, 'team-dag-alpha.json'), JSON.stringify({
      schema_version: 1,
      plan_slug: 'alpha',
      source_prd: 'prd-20260427T153100Z-alpha.md',
      nodes: [{ id: 'impl', subject: 'Implement alpha', description: 'Implement timestamped alpha DAG' }],
    }));

    const artifact = readTeamDagArtifactResolution(tempDir);
    assert.equal(artifact.source, 'json-sidecar');
    assert.equal(artifact.planSlug, 'alpha');
    assert.equal(artifact.artifactPath, join(plansDir, 'team-dag-alpha.json'));

    const result = readTeamDagHandoffForLatestPlan(tempDir);
    assert.equal(result.source, 'sidecar');
    assert.equal(result.dagState, 'valid');
    assert.equal(result.planSlug, 'alpha');
    assert.equal(result.dag?.plan_slug, 'alpha');
  });

  it('does not overmatch sidecars for a different slug prefix', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-foo.md'), '# Foo\n');
    await writeFile(join(plansDir, 'test-spec-foo.md'), '# Foo Test\n');
    await writeFile(join(plansDir, 'team-dag-foobar.json'), JSON.stringify({
      schema_version: 1,
      nodes: [{ id: 'wrong', subject: 'Wrong slug', description: 'Must not match foo' }],
    }));

    const result = readTeamDagHandoffForLatestPlan(tempDir);
    assert.equal(result.source, 'none');
    assert.equal(result.planSlug, 'foo');
    assert.equal(result.dag, null);
  });

  it('prefers sidecar DAG over embedded PRD Team DAG Handoff block', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-beta.md'), '# Beta\n\n## Team DAG Handoff\n```json\n{"schema_version":1,"nodes":[{"id":"markdown","subject":"Markdown"}]}\n```\n');
    await writeFile(join(plansDir, 'test-spec-beta.md'), '# Beta Test\n');
    await writeFile(join(plansDir, 'team-dag-beta.json'), JSON.stringify({
      schema_version: 1,
      nodes: [{ id: 'sidecar', subject: 'Sidecar wins', description: 'Sidecar DAG' }],
    }));

    const result = readTeamDagHandoffForLatestPlan(tempDir);
    assert.equal(result.source, 'sidecar');
    assert.equal(result.dag?.nodes[0]?.id, 'sidecar');
  });

  it('reports multiple matching sidecars and chooses the lexicographically latest', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-gamma.md'), '# Gamma\n');
    await writeFile(join(plansDir, 'test-spec-gamma.md'), '# Gamma Test\n');
    await writeFile(join(plansDir, 'team-dag-gamma-a.json'), JSON.stringify({
      schema_version: 1,
      nodes: [{ id: 'old', subject: 'Old', description: 'Old DAG' }],
    }));
    await writeFile(join(plansDir, 'team-dag-gamma-z.json'), JSON.stringify({
      schema_version: 1,
      nodes: [{ id: 'new', subject: 'New', description: 'New DAG' }],
    }));

    const result = readTeamDagHandoffForLatestPlan(tempDir);
    assert.equal(result.warning, 'multiple_matches');
    assert.equal(result.dag?.nodes[0]?.id, 'new');
  });


  it('does not load a Team DAG handoff when the latest PRD lacks a matching test spec', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-epsilon.md'), '# Epsilon\n');
    await writeFile(join(plansDir, 'test-spec-other.md'), '# Other Test\n');
    await writeFile(join(plansDir, 'team-dag-epsilon.json'), JSON.stringify({
      schema_version: 1,
      nodes: [{ id: 'impl', subject: 'Implement epsilon', description: 'Implement epsilon DAG' }],
    }));

    const result = readTeamDagHandoffForLatestPlan(tempDir);
    assert.equal(result.source, 'none');
    assert.equal(result.dag, null);
    assert.equal(result.error, 'missing_matching_test_spec');
  });

  it('rejects a Team DAG sidecar whose declared plan_slug does not match the latest PRD', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-zeta.md'), '# Zeta\n');
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta Test\n');
    await writeFile(join(plansDir, 'team-dag-zeta.json'), JSON.stringify({
      schema_version: 1,
      plan_slug: 'other',
      nodes: [{ id: 'impl', subject: 'Implement zeta', description: 'Implement zeta DAG' }],
    }));

    const result = readTeamDagHandoffForLatestPlan(tempDir);
    assert.equal(result.source, 'sidecar');
    assert.equal(result.dag, null);
    assert.match(result.error ?? '', /does not match/);
  });

  it('fails open with explicit parse error metadata for malformed DAG sidecars', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-delta.md'), '# Delta\n');
    await writeFile(join(plansDir, 'test-spec-delta.md'), '# Delta Test\n');
    await writeFile(join(plansDir, 'team-dag-delta.json'), '{bad json');

    const result = readTeamDagHandoffForLatestPlan(tempDir);
    assert.equal(result.source, 'sidecar');
    assert.equal(result.dag, null);
    assert.match(result.error ?? '', /JSON|property/i);
  });

});
