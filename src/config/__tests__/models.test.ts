import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { getModelForMode, getTeamLowComplexityModel } from '../models.js';

describe('getModelForMode', () => {
  let tempDir: string;
  let originalCodexHome: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'omx-models-'));
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tempDir;
  });

  afterEach(async () => {
    if (typeof originalCodexHome === 'string') {
      process.env.CODEX_HOME = originalCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(config: Record<string, unknown>): Promise<void> {
    await writeFile(join(tempDir, '.omx-config.json'), JSON.stringify(config));
  }

  it('returns hardcoded default when config file does not exist', () => {
    assert.equal(getModelForMode('team'), 'gpt-5.3-codex');
  });

  it('returns hardcoded default when config has no models section', async () => {
    await writeConfig({ notifications: { enabled: false } });
    assert.equal(getModelForMode('team'), 'gpt-5.3-codex');
  });

  it('returns mode-specific model when configured', async () => {
    await writeConfig({ models: { team: 'gpt-4.1', default: 'o4-mini' } });
    assert.equal(getModelForMode('team'), 'gpt-4.1');
  });

  it('falls back to default when mode-specific model is not set', async () => {
    await writeConfig({ models: { default: 'o4-mini' } });
    assert.equal(getModelForMode('team'), 'o4-mini');
  });

  it('returns hardcoded default when models section is empty', async () => {
    await writeConfig({ models: {} });
    assert.equal(getModelForMode('team'), 'gpt-5.3-codex');
  });

  it('ignores empty string values and falls back to default', async () => {
    await writeConfig({ models: { team: '', default: 'o4-mini' } });
    assert.equal(getModelForMode('team'), 'o4-mini');
  });

  it('trims whitespace from model values', async () => {
    await writeConfig({ models: { team: '  gpt-4.1  ' } });
    assert.equal(getModelForMode('team'), 'gpt-4.1');
  });

  it('resolves different modes independently', async () => {
    await writeConfig({ models: { team: 'gpt-4.1', autopilot: 'o4-mini', ralph: 'gpt-5' } });
    assert.equal(getModelForMode('team'), 'gpt-4.1');
    assert.equal(getModelForMode('autopilot'), 'o4-mini');
    assert.equal(getModelForMode('ralph'), 'gpt-5');
  });

  it('returns hardcoded default for invalid models section (array)', async () => {
    await writeConfig({ models: ['not', 'valid'] });
    assert.equal(getModelForMode('team'), 'gpt-5.3-codex');
  });

  it('returns hardcoded default for malformed JSON', async () => {
    await writeFile(join(tempDir, '.omx-config.json'), 'not-json');
    assert.equal(getModelForMode('team'), 'gpt-5.3-codex');
  });

  it('returns low-complexity team model when configured', async () => {
    await writeConfig({ models: { team_low_complexity: 'gpt-4.1-mini' } });
    assert.equal(getTeamLowComplexityModel(), 'gpt-4.1-mini');
  });

  it('returns hardcoded low-complexity fallback when not configured', async () => {
    await writeConfig({ models: { team: 'gpt-4.1' } });
    assert.equal(getTeamLowComplexityModel(), 'gpt-5.3-codex-spark');
  });
});
