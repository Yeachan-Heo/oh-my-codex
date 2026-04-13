import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertRequiredRalphPrdJson,
  buildRalphAppendInstructions,
  buildRalphChangedFilesSeedContents,
  extractRalphTaskDescription,
  filterRalphCodexArgs,
  isRalphPrdMode,
  normalizeRalphCliArgs,
} from '../ralph.js';
import type { ApprovedExecutionLaunchHint } from '../../planning/artifacts.js';

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
    assert.match(instructions, /Carry forward the approved deep-interview requirements/i);
  });

  it('seeds the changed-files artifact with bounded-scope guidance', () => {
    const seed = buildRalphChangedFilesSeedContents();
    assert.match(seed, /mandatory final ai-slop-cleaner pass/i);
    assert.match(seed, /one repo-relative path per line/i);
    assert.match(seed, /strictly scoped/i);
  });
});
