import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarizeCatalogCounts, validateCatalogManifest } from '../schema.js';

function readSourceManifest(): unknown {
  const path = join(process.cwd(), 'src', 'catalog', 'manifest.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('catalog schema', () => {
  it('validates repository manifest', () => {
    const parsed = validateCatalogManifest(readSourceManifest());
    assert.equal(parsed.schemaVersion, 1);
    assert.ok(parsed.catalogVersion.length > 0);
    assert.ok(parsed.skills.length > 0);
    assert.ok(parsed.agents.length > 0);
  });

  it('enforces required core skills as active', () => {
    const broken = JSON.parse(JSON.stringify(readSourceManifest()));
    const idx = broken.skills.findIndex((s: { name: string }) => s.name === 'team');
    broken.skills[idx].status = 'deprecated';
    assert.throws(() => validateCatalogManifest(broken), /missing_core_skill:team/);
  });

  it('requires canonical for alias/merged skill entries', () => {
    const broken = JSON.parse(JSON.stringify(readSourceManifest()));
    const idx = broken.skills.findIndex((s: { status: string }) => s.status === 'alias');
    delete broken.skills[idx].canonical;

    assert.throws(
      () => validateCatalogManifest(broken),
      /skills\[\d+\]\.canonical/,
    );
  });

  it('requires canonical for alias/merged agent entries', () => {
    const broken = JSON.parse(JSON.stringify(readSourceManifest()));
    broken.agents.push({
      name: 'tmp-merged-agent',
      category: 'build',
      status: 'merged',
    });

    assert.throws(
      () => validateCatalogManifest(broken),
      /agents\[\d+\]\.canonical/,
    );
  });

  it('summarizes counts', () => {
    const parsed = validateCatalogManifest(readSourceManifest());
    const counts = summarizeCatalogCounts(parsed);
    assert.equal(counts.skillCount, parsed.skills.length);
    assert.equal(counts.promptCount, parsed.agents.length);
    assert.ok(counts.activeSkillCount > 0);
    assert.ok(counts.activeAgentCount > 0);
  });

  it('includes ask-claude and ask-gemini as active built-in skills', () => {
    const parsed = validateCatalogManifest(readSourceManifest());
    const askClaude = parsed.skills.find((skill) => skill.name === 'ask-claude');
    const askGemini = parsed.skills.find((skill) => skill.name === 'ask-gemini');

    assert.equal(askClaude?.status, 'active');
    assert.equal(askGemini?.status, 'active');
  });

  it('includes ai-slop-cleaner as an active built-in skill', () => {
    const parsed = validateCatalogManifest(readSourceManifest());
    const aiSlopCleaner = parsed.skills.find((skill) => skill.name === 'ai-slop-cleaner');

    assert.equal(aiSlopCleaner?.category, 'shortcut');
    assert.equal(aiSlopCleaner?.status, 'active');
  });
});
