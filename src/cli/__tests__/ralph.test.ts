import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RALPH_HELP,
  assertRequiredRalphPrdJson,
  buildRalphAppendInstructions,
  buildRalphChangedFilesSeedContents,
  extractRalphTaskDescription,
  filterRalphCodexArgs,
  isRalphPrdMode,
  normalizeRalphCliArgs,
  readMatchedApprovedRalphExecutionHint,
  resolveApprovedRalphExecutionHint,
} from '../ralph.js';
import type { ApprovedExecutionLaunchHint } from '../../planning/artifacts.js';
import { writeContextPackDocument } from '../../planning/context-packs.js';

describe('extractRalphTaskDescription', () => {
  it('returns plain task text from positional args', () => {
    assert.equal(extractRalphTaskDescription(['fix', 'the', 'bug']), 'fix the bug');
  });
  it('returns default when args are empty', () => {
    assert.equal(extractRalphTaskDescription([]), 'ralph-cli-launch');
  });
  it('reuses approved launch hint task when no explicit task is supplied', () => {
    assert.equal(extractRalphTaskDescription([], 'Execute approved issue 1072 plan'), 'Execute approved issue 1072 plan');
  });
  it('excludes --model value from task text', () => {
    assert.equal(extractRalphTaskDescription(['--model', 'gpt-5', 'fix', 'the', 'bug']), 'fix the bug');
  });
  it('supports -- separator', () => {
    assert.equal(extractRalphTaskDescription(['--model', 'gpt-5', '--', 'fix', '--weird-name']), 'fix --weird-name');
  });
});

describe('resolveApprovedRalphExecutionHint', () => {
  it('reuses the approved hint for follow-up launches without explicit task text', () => {
    assert.equal(resolveApprovedRalphExecutionHint(approvedHint, 'ralph-cli-launch'), approvedHint);
  });

  it('does not reuse invalid approved hints for bare follow-up launches', () => {
    assert.equal(
      resolveApprovedRalphExecutionHint({ ...approvedHint, contextPackStatus: 'invalid' }, 'ralph-cli-launch'),
      null,
    );
    assert.equal(
      resolveApprovedRalphExecutionHint({ ...approvedHint, contextPackStatus: 'incomplete' }, 'ralph-cli-launch'),
      null,
    );
  });

  it('reuses the approved hint when the explicit task matches the approved handoff', () => {
    assert.equal(resolveApprovedRalphExecutionHint(approvedHint, 'Execute approved issue 1072 plan'), approvedHint);
  });

  it('drops the approved hint for unrelated explicit Ralph tasks', () => {
    assert.equal(resolveApprovedRalphExecutionHint(approvedHint, 'Refactor unrelated queue handling'), null);
  });

  it('does not materialize approved excerpts for unrelated explicit Ralph tasks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-approved-context-'));
    try {
      await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
      await mkdir(join(cwd, 'docs'), { recursive: true });
      await writeFile(
        join(cwd, 'docs', 'runtime.md'),
        `# Runtime\n\n## Runtime Contract\n\n${Array.from({ length: 90 }, () => 'Execution detail stays compact when excerpted.').join(' ')}\n`,
      );
      await writeFile(
        join(cwd, '.omx', 'plans', 'prd-issue-1072.md'),
        [
          '# Approved plan',
          '',
          '## Context Pack Outcome',
          '- pack: created `.omx/context/context-20260420T000000Z-issue-1072.json`',
          '',
          'Launch via omx ralph "Execute approved issue 1072 plan"',
        ].join('\n'),
      );
      await writeFile(join(cwd, '.omx', 'plans', 'test-spec-issue-1072.md'), '# Test spec\n');
      writeContextPackDocument(
        join(cwd, '.omx', 'context', 'context-20260420T000000Z-issue-1072.json'),
        {
          schema: 'omx-context-pack-v1',
          slug: 'issue-1072',
          entries: [
            {
              label: 'runtime',
              path: 'docs/runtime.md',
              roles: ['build'],
              tags: ['runtime'],
              selector: { type: 'heading', value: '## Runtime Contract', maxWords: 120 },
              relationPath: [
                { tag: 'plan', target: 'issue-1072' },
                { tag: 'implements', target: 'docs/runtime.md#runtime-contract' },
              ],
            },
          ],
        },
        { refreshBasis: true },
      );

      const hint = readMatchedApprovedRalphExecutionHint(cwd, 'Refactor unrelated queue handling');
      assert.equal(hint, null);
      assert.equal(
        existsSync(join(cwd, '.omx', 'context', 'excerpts', 'context-20260420T000000Z-issue-1072')),
        false,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('selects the matching approved PRD when an older exact Ralph task is still valid', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-approved-context-'));
    try {
      await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
      await mkdir(join(cwd, 'docs'), { recursive: true });
      await writeFile(join(cwd, 'docs', 'alpha.md'), '# Alpha\n\nAlpha context.\n');
      await writeFile(join(cwd, 'docs', 'zeta.md'), '# Zeta\n\nZeta context.\n');
      await writeFile(
        join(cwd, '.omx', 'plans', 'prd-alpha.md'),
        [
          '# Alpha',
          '',
          '## Context Pack Outcome',
          '- pack: created `.omx/context/context-20260420T000000Z-alpha.json`',
          '',
          'Launch via omx ralph "Execute alpha"',
        ].join('\n'),
      );
      await writeFile(join(cwd, '.omx', 'plans', 'test-spec-alpha.md'), '# Alpha test spec\n');
      await writeFile(
        join(cwd, '.omx', 'plans', 'prd-zeta.md'),
        [
          '# Zeta',
          '',
          '## Context Pack Outcome',
          '- pack: created `.omx/context/context-20260420T000000Z-zeta.json`',
          '',
          'Launch via omx ralph "Execute zeta"',
        ].join('\n'),
      );
      await writeFile(join(cwd, '.omx', 'plans', 'test-spec-zeta.md'), '# Zeta test spec\n');
      writeContextPackDocument(
        join(cwd, '.omx', 'context', 'context-20260420T000000Z-alpha.json'),
        {
          schema: 'omx-context-pack-v1',
          slug: 'alpha',
          entries: [
            {
              label: 'alpha',
              path: 'docs/alpha.md',
              roles: ['build', 'scope', 'verify'],
              tags: [],
              relationPath: [
                { tag: 'plan', target: 'alpha' },
                { tag: 'bounds', target: 'docs/alpha.md' },
              ],
            },
          ],
        },
        { refreshBasis: true },
      );
      writeContextPackDocument(
        join(cwd, '.omx', 'context', 'context-20260420T000000Z-zeta.json'),
        {
          schema: 'omx-context-pack-v1',
          slug: 'zeta',
          entries: [
            {
              label: 'zeta',
              path: 'docs/zeta.md',
              roles: ['build', 'scope', 'verify'],
              tags: [],
              relationPath: [
                { tag: 'plan', target: 'zeta' },
                { tag: 'bounds', target: 'docs/zeta.md' },
              ],
            },
          ],
        },
        { refreshBasis: true },
      );

      const hint = readMatchedApprovedRalphExecutionHint(cwd, 'Execute alpha');
      assert.ok(hint);
      assert.match(String(hint?.sourcePath), /prd-alpha\.md$/);
      assert.deepEqual(hint?.testSpecPaths.map((path) => path.split('/').at(-1)), ['test-spec-alpha.md']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reuses an older ready bare Ralph handoff when the latest same-task PRD is incomplete', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-approved-context-'));
    try {
      await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
      await mkdir(join(cwd, '.omx', 'context'), { recursive: true });
      await mkdir(join(cwd, 'docs'), { recursive: true });
      await writeFile(join(cwd, 'docs', 'alpha.md'), '# Alpha\n\nAlpha context.\n');
      await writeFile(join(cwd, 'docs', 'zeta.md'), '# Zeta\n\nZeta context.\n');
      await writeFile(
        join(cwd, '.omx', 'plans', 'prd-alpha-bare.md'),
        [
          '# Alpha',
          '',
          '## Context Pack Outcome',
          '- pack: created `.omx/context/context-20260420T000000Z-alpha-bare.json`',
          '',
          'Launch via omx ralph "Execute shared bare handoff"',
        ].join('\n'),
      );
      await writeFile(join(cwd, '.omx', 'plans', 'test-spec-alpha-bare.md'), '# Alpha test spec\n');
      await writeFile(
        join(cwd, '.omx', 'plans', 'prd-zeta-bare.md'),
        [
          '# Zeta',
          '',
          '## Context Pack Outcome',
          '- pack: created `.omx/context/context-20260420T000000Z-zeta-bare.json`',
          '',
          'Launch via omx ralph "Execute shared bare handoff"',
        ].join('\n'),
      );
      await writeFile(join(cwd, '.omx', 'plans', 'test-spec-zeta-bare.md'), '# Zeta test spec\n');
      writeContextPackDocument(
        join(cwd, '.omx', 'context', 'context-20260420T000000Z-alpha-bare.json'),
        {
          schema: 'omx-context-pack-v1',
          slug: 'alpha-bare',
          entries: [
            {
              label: 'alpha',
              path: 'docs/alpha.md',
              roles: ['build', 'scope', 'verify'],
              tags: [],
              relationPath: [
                { tag: 'plan', target: 'alpha-bare' },
                { tag: 'bounds', target: 'docs/alpha.md' },
              ],
            },
          ],
        },
        { refreshBasis: true },
      );
      writeContextPackDocument(
        join(cwd, '.omx', 'context', 'context-20260420T000000Z-zeta-bare.json'),
        {
          schema: 'omx-context-pack-v1',
          slug: 'zeta-bare',
          entries: [
            {
              label: 'zeta',
              path: 'docs/zeta.md',
              roles: ['scope'],
              tags: [],
              relationPath: [
                { tag: 'plan', target: 'zeta-bare' },
                { tag: 'bounds', target: 'docs/zeta.md' },
              ],
            },
          ],
        },
        { refreshBasis: true },
      );

      const hint = readMatchedApprovedRalphExecutionHint(cwd, 'ralph-cli-launch');
      assert.ok(hint);
      assert.equal(hint?.task, 'Execute shared bare handoff');
      assert.match(String(hint?.sourcePath), /prd-alpha-bare\.md$/);
      assert.equal(hint?.contextPackStatus, 'ready');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves the selected Ralph launch hint when materializing refs from a multi-hint PRD', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-approved-context-'));
    try {
      await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
      await mkdir(join(cwd, '.omx', 'context'), { recursive: true });
      await mkdir(join(cwd, 'docs'), { recursive: true });
      await writeFile(join(cwd, 'docs', 'alpha-scope.md'), '# Alpha Scope\n\nScope context.\n');
      await writeFile(join(cwd, 'docs', 'alpha-build.md'), '# Alpha Build\n\nBuild context.\n');
      await writeFile(join(cwd, 'docs', 'alpha-verify.md'), '# Alpha Verify\n\nVerify context.\n');
      writeContextPackDocument(
        join(cwd, '.omx', 'context', 'context-20260422T000000Z-issue-909.json'),
        {
          schema: 'omx-context-pack-v1',
          slug: 'issue-909',
          entries: [
            {
              label: 'scope',
              path: 'docs/alpha-scope.md',
              roles: ['scope'],
              tags: ['scope'],
              relationPath: [
                { tag: 'plan', target: 'issue-909' },
                { tag: 'bounds', target: 'docs/alpha-scope.md' },
              ],
            },
            {
              label: 'build',
              path: 'docs/alpha-build.md',
              roles: ['build'],
              tags: ['build'],
              relationPath: [
                { tag: 'plan', target: 'issue-909' },
                { tag: 'implements', target: 'docs/alpha-build.md' },
              ],
            },
            {
              label: 'verify',
              path: 'docs/alpha-verify.md',
              roles: ['verify'],
              tags: ['verify'],
              relationPath: [
                { tag: 'plan', target: 'issue-909' },
                { tag: 'verifies', target: 'docs/alpha-verify.md' },
              ],
            },
          ],
        },
        { refreshBasis: true },
      );
      await writeFile(
        join(cwd, '.omx', 'plans', 'prd-issue-909.md'),
        [
          '# PRD',
          '',
          '## Context Pack Outcome',
          '- pack: created `.omx/context/context-20260422T000000Z-issue-909.json`',
          '',
          'Launch via omx ralph "Execute alpha"',
          'Launch via omx ralph "Execute beta"',
        ].join('\n'),
      );
      await writeFile(join(cwd, '.omx', 'plans', 'test-spec-issue-909.md'), '# Test Spec\n');

      const hint = readMatchedApprovedRalphExecutionHint(cwd, 'Execute alpha');
      assert.ok(hint);
      assert.equal(hint?.task, 'Execute alpha');
      assert.equal(hint?.command, 'omx ralph "Execute alpha"');
      assert.match(String(hint?.sourcePath), /prd-issue-909\.md$/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed for bare Ralph follow-up reuse when a PRD lists multiple Ralph launch hints', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-approved-context-'));
    try {
      await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
      await mkdir(join(cwd, '.omx', 'context'), { recursive: true });
      await mkdir(join(cwd, 'docs'), { recursive: true });
      await writeFile(join(cwd, 'docs', 'alpha-build.md'), '# Alpha Build\n\nBuild context.\n');
      writeContextPackDocument(
        join(cwd, '.omx', 'context', 'context-20260422T000000Z-issue-909-bare.json'),
        {
          schema: 'omx-context-pack-v1',
          slug: 'issue-909-bare',
          entries: [
            {
              label: 'build',
              path: 'docs/alpha-build.md',
              roles: ['build', 'scope', 'verify'],
              tags: ['build'],
              relationPath: [
                { tag: 'plan', target: 'issue-909-bare' },
                { tag: 'implements', target: 'docs/alpha-build.md' },
              ],
            },
          ],
        },
        { refreshBasis: true },
      );
      await writeFile(
        join(cwd, '.omx', 'plans', 'prd-issue-909-bare.md'),
        [
          '# PRD',
          '',
          '## Context Pack Outcome',
          '- pack: created `.omx/context/context-20260422T000000Z-issue-909-bare.json`',
          '',
          'Launch via omx ralph "Execute alpha"',
          'Launch via omx ralph "Execute beta"',
        ].join('\n'),
      );
      await writeFile(join(cwd, '.omx', 'plans', 'test-spec-issue-909-bare.md'), '# Test Spec\n');

      const hint = readMatchedApprovedRalphExecutionHint(cwd, 'ralph-cli-launch');
      assert.equal(hint, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('isRalphPrdMode', () => {
  it('detects --prd flag usage', () => {
    assert.equal(isRalphPrdMode(['--prd', 'ship release checklist']), true);
  });

  it('detects --prd=value usage', () => {
    assert.equal(isRalphPrdMode(['--prd=ship release checklist']), true);
  });

  it('ignores non-prd Ralph runs', () => {
    assert.equal(isRalphPrdMode(['fix', 'the', 'bug']), false);
  });
});

describe('RALPH_HELP', () => {
  it('clarifies that prompt-side $ralph activation is separate from CLI --prd mode', () => {
    assert.match(RALPH_HELP, /Prompt-side `\$ralph` activation is separate from this CLI entrypoint/i);
    assert.match(RALPH_HELP, /does not imply `--prd` or the PRD\.json startup gate/i);
  });
});

describe('normalizeRalphCliArgs', () => {
  it('converts --prd value into positional task text', () => {
    assert.deepEqual(normalizeRalphCliArgs(['--prd', 'ship release checklist']), ['ship release checklist']);
  });
  it('converts --prd=value into positional task text', () => {
    assert.deepEqual(normalizeRalphCliArgs(['--prd=fix the bug']), ['fix the bug']);
  });
  it('preserves other flags and args', () => {
    assert.deepEqual(normalizeRalphCliArgs(['--model', 'gpt-5', '--prd', 'fix it']), ['--model', 'gpt-5', 'fix it']);
  });
});

describe('filterRalphCodexArgs', () => {
  it('consumes --prd so it is not forwarded to codex', () => {
    assert.deepEqual(filterRalphCodexArgs(['--prd', 'build', 'todo', 'app']), ['build', 'todo', 'app']);
  });
  it('consumes --PRD case-insensitively', () => {
    assert.deepEqual(filterRalphCodexArgs(['--PRD', '--model', 'gpt-5']), ['--model', 'gpt-5']);
  });
  it('preserves non-omx flags', () => {
    assert.deepEqual(filterRalphCodexArgs(['--model', 'gpt-5', '--yolo', 'fix', 'it']), ['--model', 'gpt-5', '--yolo', 'fix', 'it']);
  });
});


const approvedHint: ApprovedExecutionLaunchHint = {
  mode: 'ralph',
  command: 'omx ralph "Execute approved issue 1072 plan"',
  task: 'Execute approved issue 1072 plan',
  sourcePath: '.omx/plans/prd-issue-1072.md',
  testSpecPaths: ['.omx/plans/test-spec-issue-1072.md'],
  deepInterviewSpecPaths: ['.omx/specs/deep-interview-issue-1072.md'],
  contextPack: { path: '.omx/context/context-20260420T000000Z-issue-1072.json', action: 'created' },
  contextPackStatus: 'ready',
  missingRequiredContextPackRoles: [],
  contextPackIssues: [],
  contextRefs: [
    {
      roles: ['build'],
      label: 'runtime',
      path: '.omx/context/excerpts/context-20260420T000000Z-issue-1072/01-runtime.md',
      sourcePath: 'docs/runtime.md',
      delivery: 'excerpt',
      relationPath: [
        { tag: 'plan', target: 'issue-1072' },
        { tag: 'implements', target: 'docs/runtime.md#runtime-contract' },
      ],
      tags: ['runtime'],
    },
    {
      roles: ['verify'],
      label: 'acceptance',
      path: '.omx/context/excerpts/context-20260420T000000Z-issue-1072/02-acceptance.md',
      sourcePath: 'docs/acceptance.md',
      delivery: 'excerpt',
      relationPath: [
        { tag: 'verifies', target: 'docs/acceptance.md#gate-a' },
      ],
      tags: ['acceptance'],
    },
  ],
  contextRefIssues: [],
};

describe('assertRequiredRalphPrdJson', () => {
  it('throws when --prd mode starts without .omx/prd.json', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-prd-gate-'));
    try {
      assert.throws(
        () => assertRequiredRalphPrdJson(cwd, ['--prd', 'ship release checklist']),
        /Missing required PRD\.json at \.omx\/prd\.json/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('still requires legacy .omx/prd.json even when canonical PRD markdown exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-prd-gate-'));
    try {
      await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'plans', 'prd-existing.md'), '# Existing canonical PRD\n');

      assert.throws(
        () => assertRequiredRalphPrdJson(cwd, ['--prd', 'ship release checklist']),
        /Missing required PRD\.json at \.omx\/prd\.json/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects completed stories without architect approval', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-prd-gate-'));
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'prd.json'), JSON.stringify({
        project: 'Issue 1555',
        userStories: [{
          id: 'US-001',
          title: 'Guard story completion',
          passes: true,
        }],
      }, null, 2));

      assert.throws(
        () => assertRequiredRalphPrdJson(cwd, ['--prd', 'ship release checklist']),
        /marked passed\/completed without architect approval/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('allows completed stories with architect approval recorded', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-prd-gate-'));
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'prd.json'), JSON.stringify({
        project: 'Issue 1555',
        userStories: [{
          id: 'US-001',
          title: 'Guard story completion',
          status: 'completed',
          architect_review: { verdict: 'approve' },
        }],
      }, null, 2));

      assert.doesNotThrow(() => assertRequiredRalphPrdJson(cwd, ['--prd', 'ship release checklist']));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('allows --prd mode when .omx/prd.json exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-prd-gate-'));
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'prd.json'), JSON.stringify({
        project: 'Issue 1555',
        userStories: [],
      }, null, 2));

      assert.doesNotThrow(() => assertRequiredRalphPrdJson(cwd, ['--prd', 'ship release checklist']));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not gate non-prd Ralph runs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-prd-gate-'));
    try {
      assert.doesNotThrow(() => assertRequiredRalphPrdJson(cwd, ['fix', 'the', 'bug']));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('ralph deslop launch wiring', () => {
  it('consumes --no-deslop so it is not forwarded to codex', () => {
    assert.deepEqual(filterRalphCodexArgs(['--no-deslop', '--model', 'gpt-5', 'fix', 'it']), ['--model', 'gpt-5', 'fix', 'it']);
  });

  it('documents changed-files-only deslop guidance by default', () => {
    const instructions = buildRalphAppendInstructions('fix issue 920', {
      changedFilesPath: '.omx/ralph/changed-files.txt',
      noDeslop: false,
      approvedHint: null,
    });
    assert.match(instructions, /ai-slop-cleaner/i);
    assert.match(instructions, /changed files only/i);
    assert.match(instructions, /\.omx\/ralph\/changed-files\.txt/);
    assert.match(instructions, /standard mode/i);
    assert.match(instructions, /rerun the current tests\/build\/lint verification/i);
  });

  it('documents the --no-deslop opt-out when enabled', () => {
    const instructions = buildRalphAppendInstructions('fix issue 920', {
      changedFilesPath: '.omx/ralph/changed-files.txt',
      noDeslop: true,
      approvedHint: null,
    });
    assert.match(instructions, /--no-deslop/);
    assert.match(instructions, /skip the mandatory ai-slop-cleaner final pass/i);
    assert.match(instructions, /latest successful pre-deslop verification evidence/i);
  });



  it('includes approved plan and deep-interview handoff context when available', () => {
    const instructions = buildRalphAppendInstructions('Execute approved issue 1072 plan', {
      changedFilesPath: '.omx/ralph/changed-files.txt',
      noDeslop: false,
      approvedHint,
    });
    assert.match(instructions, /Approved planning handoff context/i);
    assert.match(instructions, /approved plan: \.omx\/plans\/prd-issue-1072\.md/i);
    assert.match(instructions, /test specs: \.omx\/plans\/test-spec-issue-1072\.md/i);
    assert.match(instructions, /deep-interview specs: \.omx\/specs\/deep-interview-issue-1072\.md/i);
    assert.match(instructions, /context pack: \.omx\/context\/context-20260420T000000Z-issue-1072\.json/i);
    assert.match(instructions, /context pack index: \.omx\/context\/context-20260420T000000Z-issue-1072\.md/i);
    assert.match(instructions, /build context refs \(read first\): runtime=\.omx\/context\/excerpts\/context-20260420T000000Z-issue-1072\/01-runtime\.md \[excerpt\]/i);
    assert.match(instructions, /verify context refs: acceptance=\.omx\/context\/excerpts\/context-20260420T000000Z-issue-1072\/02-acceptance\.md \[excerpt\]/i);
    assert.match(instructions, /open the pack index or query the canonical pack by role\/tag\/label/i);
    assert.match(instructions, /Carry forward the approved deep-interview requirements/i);
  });

  it('does not reference a missing absolute pack index in ready handoff instructions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-missing-index-'));
    try {
      const instructions = buildRalphAppendInstructions('Execute approved issue 1072 plan', {
        changedFilesPath: '.omx/ralph/changed-files.txt',
        noDeslop: false,
        approvedHint: {
          ...approvedHint,
          contextPack: {
            path: join(cwd, '.omx', 'context', 'context-20260420T000000Z-issue-1072.json'),
            action: 'created',
          },
        },
      });
      assert.doesNotMatch(instructions, /context pack index:/i);
      assert.doesNotMatch(instructions, /open the pack index/i);
      assert.match(instructions, /query the canonical pack by role\/tag\/label/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('documents the plan-only fallback when approved context packs are unavailable', () => {
    const instructions = buildRalphAppendInstructions('Execute approved legacy plan', {
      changedFilesPath: '.omx/ralph/changed-files.txt',
      noDeslop: false,
      approvedHint: {
        mode: 'ralph',
        command: 'omx ralph "Execute approved legacy plan"',
        task: 'Execute approved legacy plan',
        sourcePath: '.omx/plans/prd-legacy.md',
        testSpecPaths: ['.omx/plans/test-spec-legacy.md'],
        deepInterviewSpecPaths: [],
        contextPack: null,
        contextPackStatus: 'plan-only',
        missingRequiredContextPackRoles: [],
        contextPackIssues: [],
        contextRefs: [],
        contextRefIssues: [],
      },
    });
    assert.match(instructions, /approved plan: \.omx\/plans\/prd-legacy\.md/i);
    assert.match(instructions, /context pack: not declared in the approved plan; using the pre-context-pack plan-only handoff baseline/i);
    assert.match(instructions, /Plan-only fallback: start from the approved plan, matching test specs, and any deep-interview artifacts as repair inputs/i);
    assert.match(instructions, /create or refresh the canonical context pack and sync it before broadening context/i);
  });

  it('documents incomplete context-pack fallback as repair-only', () => {
    const instructions = buildRalphAppendInstructions('Execute approved incomplete plan', {
      changedFilesPath: '.omx/ralph/changed-files.txt',
      noDeslop: false,
      approvedHint: {
        ...approvedHint,
        contextPackStatus: 'incomplete',
        missingRequiredContextPackRoles: ['build', 'verify'],
        contextPackIssues: [],
        contextRefs: [],
        contextRefIssues: [],
      },
    });
    assert.match(instructions, /missing required context roles: build, verify/i);
    assert.match(instructions, /only as repair inputs/i);
    assert.match(instructions, /repair or recreate the canonical context pack with required role coverage, then sync it before broadening context/i);
    assert.doesNotMatch(instructions, /as the brief/i);
  });

  it('documents invalid context-pack fallback when approved packs fail validation', () => {
    const instructions = buildRalphAppendInstructions('Execute approved invalid plan', {
      changedFilesPath: '.omx/ralph/changed-files.txt',
      noDeslop: false,
      approvedHint: {
        mode: 'ralph',
        command: 'omx ralph "Execute approved invalid plan"',
        task: 'Execute approved invalid plan',
        sourcePath: '.omx/plans/prd-invalid.md',
        testSpecPaths: ['.omx/plans/test-spec-invalid.md'],
        deepInterviewSpecPaths: [],
        contextPack: null,
        contextPackStatus: 'invalid',
        missingRequiredContextPackRoles: ['build', 'verify'],
        contextPackIssues: ['context-20260420T000000Z-invalid.json must declare schema omx-context-pack-v1.'],
        contextRefs: [],
        contextRefIssues: [],
      },
    });
    assert.match(instructions, /invalid context pack issues:/i);
    assert.match(instructions, /repair or recreate the canonical context pack, then sync it before broadening context/i);
  });

  it('seeds the changed-files artifact with bounded-scope guidance', () => {
    const seed = buildRalphChangedFilesSeedContents();
    assert.match(seed, /mandatory final ai-slop-cleaner pass/i);
    assert.match(seed, /one repo-relative path per line/i);
    assert.match(seed, /strictly scoped/i);
  });
});
