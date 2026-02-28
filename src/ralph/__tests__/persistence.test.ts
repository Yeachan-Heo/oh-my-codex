import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCanonicalRalphArtifacts, recordRalphVisualFeedback } from '../persistence.js';
import { VISUAL_NEXT_ACTIONS_LIMIT } from '../../visual/constants.js';

describe('ensureCanonicalRalphArtifacts', () => {
  it('keeps canonical files authoritative when they already exist', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-canonical-'));
    try {
      const canonicalPrd = join(cwd, '.omx', 'plans', 'prd-existing.md');
      const canonicalProgress = join(cwd, '.omx', 'state', 'ralph-progress.json');
      await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeFile(canonicalPrd, '# Existing canonical PRD\n');
      await writeFile(canonicalProgress, JSON.stringify({ canonical: true }, null, 2));
      await writeFile(join(cwd, '.omx', 'prd.json'), JSON.stringify({ project: 'legacy-project' }));
      await writeFile(join(cwd, '.omx', 'progress.txt'), 'legacy line\n');

      const result = await ensureCanonicalRalphArtifacts(cwd);
      assert.equal(result.migratedPrd, false);
      assert.equal(result.migratedProgress, false);
      assert.equal(result.canonicalPrdPath, canonicalPrd);
      assert.equal(result.canonicalProgressPath, canonicalProgress);

      const prd = await readFile(canonicalPrd, 'utf-8');
      const progress = JSON.parse(await readFile(canonicalProgress, 'utf-8'));
      assert.match(prd, /Existing canonical PRD/);
      assert.equal(progress.canonical, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('migrates legacy PRD/progress files one-way when canonical artifacts are absent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-migrate-'));
    try {
      const legacyPrdPath = join(cwd, '.omx', 'prd.json');
      const legacyProgressPath = join(cwd, '.omx', 'progress.txt');
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(legacyPrdPath, JSON.stringify({
        project: 'Legacy Ralph Project',
        description: 'Legacy PRD payload',
        userStories: [{ id: 'US-1', title: 'Story', acceptanceCriteria: ['A', 'B'] }],
      }, null, 2));
      await writeFile(legacyProgressPath, 'line one\nline two\n');

      const legacyPrdBefore = await readFile(legacyPrdPath, 'utf-8');
      const legacyProgressBefore = await readFile(legacyProgressPath, 'utf-8');

      const result = await ensureCanonicalRalphArtifacts(cwd, 'sessMigrate');
      assert.equal(result.migratedPrd, true);
      assert.equal(result.migratedProgress, true);
      assert.ok(result.canonicalPrdPath);
      assert.equal(existsSync(result.canonicalPrdPath!), true);
      assert.equal(existsSync(result.canonicalProgressPath), true);

      const canonicalPrd = await readFile(result.canonicalPrdPath!, 'utf-8');
      const canonicalProgress = JSON.parse(await readFile(result.canonicalProgressPath, 'utf-8'));
      assert.match(canonicalPrd, /Migrated from legacy `.omx\/prd\.json`/);
      assert.equal(canonicalProgress.source, '.omx/progress.txt');
      assert.equal(Array.isArray(canonicalProgress.entries), true);
      assert.equal(canonicalProgress.entries.length, 2);
      assert.equal(Array.isArray(canonicalProgress.visual_feedback), true);

      // Legacy artifacts remain untouched for compatibility window.
      assert.equal(await readFile(legacyPrdPath, 'utf-8'), legacyPrdBefore);
      assert.equal(await readFile(legacyProgressPath, 'utf-8'), legacyProgressBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('records visual feedback with numeric and qualitative guidance for the next iteration', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-visual-feedback-'));
    try {
      const artifacts = await ensureCanonicalRalphArtifacts(cwd, 'sessVisual');
      await recordRalphVisualFeedback(cwd, {
        score: 82,
        verdict: 'revise',
        category_match: true,
        differences: ['CTA alignment drifts by 4px'],
        suggestions: ['Align CTA to the same baseline as reference card'],
        reasoning: 'Layout is close but CTA still misaligned.',
      }, 'sessVisual');

      const progress = JSON.parse(await readFile(artifacts.canonicalProgressPath, 'utf-8'));
      assert.equal(Array.isArray(progress.visual_feedback), true);
      assert.equal(progress.visual_feedback.length, 1);
      assert.equal(progress.visual_feedback[0].score, 82);
      assert.equal(progress.visual_feedback[0].qualitative_feedback.summary, 'Layout is close but CTA still misaligned.');
      assert.equal(Array.isArray(progress.visual_feedback[0].qualitative_feedback.next_actions), true);
      assert.equal(progress.visual_feedback[0].qualitative_feedback.next_actions.length > 0, true);
      assert.equal(progress.visual_feedback[0].next_actions.length <= VISUAL_NEXT_ACTIONS_LIMIT, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
