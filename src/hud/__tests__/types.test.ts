import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HUD_CONFIG } from '../types.js';

describe('DEFAULT_HUD_CONFIG', () => {
  it('has preset set to "focused"', () => {
    assert.equal(DEFAULT_HUD_CONFIG.preset, 'focused');
  });

  it('is an object with a preset property', () => {
    assert.equal(typeof DEFAULT_HUD_CONFIG, 'object');
    assert.ok('preset' in DEFAULT_HUD_CONFIG);
  });

  it('preset is a valid HudPreset value', () => {
    const validPresets = ['minimal', 'focused', 'full'];
    assert.ok(validPresets.includes(DEFAULT_HUD_CONFIG.preset));
  });
});
