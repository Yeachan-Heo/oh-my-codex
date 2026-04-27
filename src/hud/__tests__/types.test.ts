import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHudConfig } from '../state.js';
import { DEFAULT_HUD_CONFIG } from '../types.js';

describe('DEFAULT_HUD_CONFIG', () => {
  it('has preset set to "focused"', () => {
    assert.equal(DEFAULT_HUD_CONFIG.preset, 'focused');
  });

  it('defaults git display to repo-branch', () => {
    assert.deepEqual(DEFAULT_HUD_CONFIG.git, { display: 'repo-branch' });
  });

  it('defaults statusLine preset to "focused"', () => {
    assert.equal(DEFAULT_HUD_CONFIG.statusLine.preset, 'focused');
  });
});

describe('normalizeHudConfig', () => {
  it('returns resolved defaults for nullish config', () => {
    assert.deepEqual(normalizeHudConfig(undefined), DEFAULT_HUD_CONFIG);
    assert.deepEqual(normalizeHudConfig(null), DEFAULT_HUD_CONFIG);
  });

  it('keeps legacy preset-only configs backward compatible', () => {
    assert.deepEqual(normalizeHudConfig({ preset: 'minimal' }), {
      preset: 'minimal',
      git: { display: 'repo-branch' },
      statusLine: { preset: 'focused' },
    });
  });

  it('deep-merges bounded git config', () => {
    assert.deepEqual(normalizeHudConfig({
      preset: 'full',
      git: {
        display: 'branch',
        remoteName: 'upstream',
        repoLabel: 'manual-repo',
      },
    }), {
      preset: 'full',
      git: {
        display: 'branch',
        remoteName: 'upstream',
        repoLabel: 'manual-repo',
      },
      statusLine: { preset: 'focused' },
    });
  });

  it('ignores invalid nested values quietly', () => {
    assert.deepEqual(normalizeHudConfig({
      preset: 'focused',
      git: {
        display: 'bogus' as never,
        remoteName: '   ',
        repoLabel: 123 as never,
      },
    }), DEFAULT_HUD_CONFIG);
  });

  it('accepts a valid statusLine preset', () => {
    const resolved = normalizeHudConfig({
      preset: 'focused',
      statusLine: { preset: 'minimal' },
    });
    assert.equal(resolved.statusLine.preset, 'minimal');
  });

  it('falls back to default for invalid statusLine preset', () => {
    const resolved = normalizeHudConfig({
      preset: 'focused',
      statusLine: { preset: 'bogus' as never },
    });
    assert.equal(resolved.statusLine.preset, 'focused');
  });

  it('lets statusLine.preset diverge from top-level preset', () => {
    const resolved = normalizeHudConfig({
      preset: 'minimal',
      statusLine: { preset: 'full' },
    });
    assert.equal(resolved.preset, 'minimal');
    assert.equal(resolved.statusLine.preset, 'full');
  });
});
