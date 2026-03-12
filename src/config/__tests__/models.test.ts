import { describe, it, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  DEFAULT_FRONTIER_MODEL,
  HARDCODED_TEAM_LOW_COMPLEXITY_MODEL,
  getMainDefaultModel,
  getModelForMode,
  getSparkDefaultModel,
  getTeamLowComplexityModel,
} from '../models.js';

describe('getModelForMode', () => {
  let tempDir: string;
  let originalCodexHome: string | undefined;
  let originalMainModel: string | undefined;
  let originalSparkModel: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'omx-models-'));
    originalCodexHome = process.env.CODEX_HOME;
    originalMainModel = process.env.OMX_MAIN_MODEL;
    originalSparkModel = process.env.OMX_SPARK_MODEL;
    process.env.CODEX_HOME = tempDir;
    delete process.env.OMX_MAIN_MODEL;
    delete process.env.OMX_SPARK_MODEL;
  });

  afterEach(async () => {
    if (typeof originalCodexHome === 'string') {
      process.env.CODEX_HOME = originalCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }
    if (typeof originalMainModel === 'string') {
      process.env.OMX_MAIN_MODEL = originalMainModel;
    } else {
      delete process.env.OMX_MAIN_MODEL;
    }
    if (typeof originalSparkModel === 'string') {
      process.env.OMX_SPARK_MODEL = originalSparkModel;
    } else {
      delete process.env.OMX_SPARK_MODEL;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(config: Record<string, unknown>): Promise<void> {
    await writeFile(join(tempDir, '.omx-config.json'), JSON.stringify(config));
  }

  it('returns frontier default when config file does not exist', () => {
    assert.equal(getModelForMode('team'), DEFAULT_FRONTIER_MODEL);
  });

  it('returns frontier default when config has no models section', async () => {
    await writeConfig({ notifications: { enabled: false } });
    assert.equal(getModelForMode('team'), DEFAULT_FRONTIER_MODEL);
  });

  it('returns mode-specific model when configured', async () => {
    await writeConfig({ models: { team: 'gpt-4.1', default: 'o4-mini' } });
    assert.equal(getModelForMode('team'), 'gpt-4.1');
  });

  it('falls back to default when mode-specific model is not set', async () => {
    await writeConfig({ models: { default: 'o4-mini' } });
    assert.equal(getModelForMode('team'), 'o4-mini');
  });

  it('returns frontier default when models section is empty', async () => {
    await writeConfig({ models: {} });
    assert.equal(getModelForMode('team'), DEFAULT_FRONTIER_MODEL);
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

  it('returns frontier default for invalid models section (array)', async () => {
    await writeConfig({ models: ['not', 'valid'] });
    assert.equal(getModelForMode('team'), DEFAULT_FRONTIER_MODEL);
  });

  it('returns frontier default for malformed JSON', async () => {
    await writeFile(join(tempDir, '.omx-config.json'), 'not-json');
    assert.equal(getModelForMode('team'), DEFAULT_FRONTIER_MODEL);
  });

  it('uses OMX_MAIN_MODEL when config does not provide a value', () => {
    process.env.OMX_MAIN_MODEL = 'gpt-5.4-mini';
    assert.equal(getMainDefaultModel(), 'gpt-5.4-mini');
    assert.equal(getModelForMode('team'), 'gpt-5.4-mini');
  });

  it('keeps explicit config default ahead of OMX_MAIN_MODEL', async () => {
    process.env.OMX_MAIN_MODEL = 'gpt-5.4-mini';
    await writeConfig({ models: { default: 'o4-mini' } });
    assert.equal(getModelForMode('team'), 'o4-mini');
  });

  it('keeps explicit mode config ahead of OMX_MAIN_MODEL', async () => {
    process.env.OMX_MAIN_MODEL = 'gpt-5.4-mini';
    await writeConfig({ models: { team: 'gpt-4.1', default: 'o4-mini' } });
    assert.equal(getModelForMode('team'), 'gpt-4.1');
  });

  it('returns low-complexity team model when configured', async () => {
    await writeConfig({ models: { team_low_complexity: 'gpt-4.1-mini' } });
    assert.equal(getTeamLowComplexityModel(), 'gpt-4.1-mini');
  });

  it('uses OMX_SPARK_MODEL when low-complexity config is absent', async () => {
    process.env.OMX_SPARK_MODEL = 'gpt-5.3-codex-spark-fast';
    await writeConfig({ models: { team: 'gpt-4.1' } });
    assert.equal(getSparkDefaultModel(), 'gpt-5.3-codex-spark-fast');
    assert.equal(getTeamLowComplexityModel(), 'gpt-5.3-codex-spark-fast');
  });

  it('keeps explicit low-complexity config ahead of OMX_SPARK_MODEL', async () => {
    process.env.OMX_SPARK_MODEL = 'gpt-5.3-codex-spark-fast';
    await writeConfig({ models: { team_low_complexity: 'gpt-4.1-mini' } });
    assert.equal(getTeamLowComplexityModel(), 'gpt-4.1-mini');
  });

  it('returns hardcoded low-complexity fallback when not configured', async () => {
    await writeConfig({ models: { team: 'gpt-4.1' } });
    assert.equal(getSparkDefaultModel(), HARDCODED_TEAM_LOW_COMPLEXITY_MODEL);
    assert.equal(getTeamLowComplexityModel(), HARDCODED_TEAM_LOW_COMPLEXITY_MODEL);
  });
});
