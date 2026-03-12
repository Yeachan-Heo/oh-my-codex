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
});
