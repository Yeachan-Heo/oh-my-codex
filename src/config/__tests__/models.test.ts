import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  DEFAULT_FRONTIER_MODEL,
  DEFAULT_SPARK_MODEL,
  DEFAULT_TEAM_CHILD_MODEL,
  getAgentReasoningOverride,
  getEnvConfiguredStandardDefaultModel,
  getMainDefaultModel,
  getModelForMode,
  getSparkDefaultModel,
  getStandardDefaultModel,
  getTeamChildModel,
  getTeamLowComplexityModel,
  readAgentReasoningOverrides,
  readConfiguredEnvOverrides,
} from '../models.js';

describe('getModelForMode', () => {
  let tempDir: string;
  let originalCodexHome: string | undefined;
  let originalDefaultFrontierModel: string | undefined;
  let originalDefaultStandardModel: string | undefined;
  let originalDefaultSparkModel: string | undefined;
  let originalTeamChildModel: string | undefined;
  let originalSparkModel: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'omx-models-'));
    originalCodexHome = process.env.CODEX_HOME;
    originalDefaultFrontierModel = process.env.OMX_DEFAULT_FRONTIER_MODEL;
    originalDefaultStandardModel = process.env.OMX_DEFAULT_STANDARD_MODEL;
    originalDefaultSparkModel = process.env.OMX_DEFAULT_SPARK_MODEL;
    originalTeamChildModel = process.env.OMX_TEAM_CHILD_MODEL;
    originalSparkModel = process.env.OMX_SPARK_MODEL;
    process.env.CODEX_HOME = tempDir;
    delete process.env.OMX_DEFAULT_FRONTIER_MODEL;
    delete process.env.OMX_DEFAULT_STANDARD_MODEL;
    delete process.env.OMX_DEFAULT_SPARK_MODEL;
    delete process.env.OMX_TEAM_CHILD_MODEL;
    delete process.env.OMX_SPARK_MODEL;
  });

  afterEach(async () => {
    if (typeof originalCodexHome === 'string') {
      process.env.CODEX_HOME = originalCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }
    if (typeof originalDefaultFrontierModel === 'string') {
      process.env.OMX_DEFAULT_FRONTIER_MODEL = originalDefaultFrontierModel;
    } else {
      delete process.env.OMX_DEFAULT_FRONTIER_MODEL;
    }
    if (typeof originalDefaultStandardModel === 'string') {
      process.env.OMX_DEFAULT_STANDARD_MODEL = originalDefaultStandardModel;
    } else {
      delete process.env.OMX_DEFAULT_STANDARD_MODEL;
    }
    if (typeof originalDefaultSparkModel === 'string') {
      process.env.OMX_DEFAULT_SPARK_MODEL = originalDefaultSparkModel;
    } else {
      delete process.env.OMX_DEFAULT_SPARK_MODEL;
    }
    if (typeof originalTeamChildModel === 'string') {
      process.env.OMX_TEAM_CHILD_MODEL = originalTeamChildModel;
    } else {
      delete process.env.OMX_TEAM_CHILD_MODEL;
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

  it('uses OMX_DEFAULT_FRONTIER_MODEL when config does not provide a value', () => {
    process.env.OMX_DEFAULT_FRONTIER_MODEL = 'gpt-5.4-mini';
    assert.equal(getMainDefaultModel(), 'gpt-5.4-mini');
    assert.equal(getModelForMode('team'), 'gpt-5.4-mini');
  });

  it('uses .omx-config.json env.OMX_DEFAULT_FRONTIER_MODEL when shell env is absent', async () => {
    await writeConfig({ env: { OMX_DEFAULT_FRONTIER_MODEL: 'frontier-local' } });
    assert.equal(getMainDefaultModel(), 'frontier-local');
    assert.equal(getModelForMode('team'), 'frontier-local');
  });

  it('uses config.toml root model as the main and standard default when env overrides are absent', async () => {
    await writeFile(join(tempDir, 'config.toml'), 'model = "frontier-config"\n');

    assert.equal(getMainDefaultModel(), 'frontier-config');
    assert.equal(getStandardDefaultModel(), 'frontier-config');
    assert.equal(getModelForMode('team'), 'frontier-config');
  });

  it('uses OMX_DEFAULT_STANDARD_MODEL when configured in shell env', () => {
    process.env.OMX_DEFAULT_STANDARD_MODEL = 'gpt-5.4-mini-tuned';
    assert.equal(getEnvConfiguredStandardDefaultModel(), 'gpt-5.4-mini-tuned');
    assert.equal(getStandardDefaultModel(), 'gpt-5.4-mini-tuned');
  });

  it('uses .omx-config.json env.OMX_DEFAULT_STANDARD_MODEL when shell env is absent', async () => {
    await writeConfig({ env: { OMX_DEFAULT_STANDARD_MODEL: 'standard-local' } });
    assert.equal(getEnvConfiguredStandardDefaultModel(), 'standard-local');
    assert.equal(getStandardDefaultModel(), 'standard-local');
  });

  it('prefers shell OMX_DEFAULT_FRONTIER_MODEL over .omx-config.json env override', async () => {
    process.env.OMX_DEFAULT_FRONTIER_MODEL = 'frontier-shell';
    await writeConfig({ env: { OMX_DEFAULT_FRONTIER_MODEL: 'frontier-local' } });
    assert.equal(getMainDefaultModel(), 'frontier-shell');
  });

  it('keeps explicit config default ahead of OMX_DEFAULT_FRONTIER_MODEL', async () => {
    process.env.OMX_DEFAULT_FRONTIER_MODEL = 'gpt-5.4-mini';
    await writeConfig({ models: { default: 'o4-mini' } });
    assert.equal(getModelForMode('team'), 'o4-mini');
  });

  it('keeps explicit mode config ahead of OMX_DEFAULT_FRONTIER_MODEL', async () => {
    process.env.OMX_DEFAULT_FRONTIER_MODEL = 'gpt-5.4-mini';
    await writeConfig({ models: { team: 'gpt-4.1', default: 'o4-mini' } });
    assert.equal(getModelForMode('team'), 'gpt-4.1');
  });



  it('defaults team child model to standard mini independent of frontier defaults', () => {
    process.env.OMX_DEFAULT_FRONTIER_MODEL = 'frontier-expensive';
    assert.equal(DEFAULT_TEAM_CHILD_MODEL, 'gpt-5.4-mini');
    assert.equal(getTeamChildModel(), 'gpt-5.4-mini');
  });

  it('uses OMX_TEAM_CHILD_MODEL shell override for team child model', () => {
    process.env.OMX_TEAM_CHILD_MODEL = 'team-child-custom';
    assert.equal(getTeamChildModel(), 'team-child-custom');
  });

  it('uses .omx-config.json env.OMX_TEAM_CHILD_MODEL when shell env is absent', async () => {
    await writeConfig({ env: { OMX_TEAM_CHILD_MODEL: 'team-child-local' } });
    assert.equal(getTeamChildModel(), 'team-child-local');
  });

  it('returns low-complexity team model when configured', async () => {
    await writeConfig({ models: { team_low_complexity: 'gpt-4.1-mini' } });
    assert.equal(getTeamLowComplexityModel(), 'gpt-4.1-mini');
  });

  it('uses OMX_DEFAULT_SPARK_MODEL when low-complexity config is absent', async () => {
    process.env.OMX_DEFAULT_SPARK_MODEL = 'gpt-5.3-codex-spark-fast';
    await writeConfig({ models: { team: 'gpt-4.1' } });
    assert.equal(getSparkDefaultModel(), 'gpt-5.3-codex-spark-fast');
    assert.equal(getTeamLowComplexityModel(), 'gpt-5.3-codex-spark-fast');
  });

  it('uses .omx-config.json env.OMX_DEFAULT_SPARK_MODEL when shell env is absent', async () => {
    await writeConfig({ env: { OMX_DEFAULT_SPARK_MODEL: 'spark-local' }, models: { team: 'gpt-4.1' } });
    assert.equal(getSparkDefaultModel(), 'spark-local');
  });

  it('falls back to legacy OMX_SPARK_MODEL when canonical spark env is absent', async () => {
    process.env.OMX_SPARK_MODEL = 'gpt-5.3-codex-spark-fast';
    await writeConfig({ models: { team: 'gpt-4.1' } });
    assert.equal(getSparkDefaultModel(), 'gpt-5.3-codex-spark-fast');
    assert.equal(getTeamLowComplexityModel(), 'gpt-5.3-codex-spark-fast');
  });

  it('prefers OMX_DEFAULT_SPARK_MODEL over legacy OMX_SPARK_MODEL', () => {
    process.env.OMX_DEFAULT_SPARK_MODEL = 'spark-canonical';
    process.env.OMX_SPARK_MODEL = 'spark-legacy';
    assert.equal(getSparkDefaultModel(), 'spark-canonical');
  });

  it('reads normalized env overrides from .omx-config.json', async () => {
    await writeConfig({
      env: {
        OMX_DEFAULT_FRONTIER_MODEL: ' frontier-local ',
        OMX_DEFAULT_STANDARD_MODEL: ' standard-local ',
        OMX_DEFAULT_SPARK_MODEL: ' spark-local ',
        EMPTY: '   ',
      },
    });
    assert.deepEqual(readConfiguredEnvOverrides(), {
      OMX_DEFAULT_FRONTIER_MODEL: 'frontier-local',
      OMX_DEFAULT_STANDARD_MODEL: 'standard-local',
      OMX_DEFAULT_SPARK_MODEL: 'spark-local',
    });
  });

  it('reads normalized per-agent reasoning overrides from .omx-config.json', async () => {
    await writeConfig({
      agentReasoning: {
        Architect: ' xhigh ',
        critic: 'high',
        executor: 'invalid',
        'bad role': 'low',
        empty: '   ',
      },
    });

    assert.deepEqual(readAgentReasoningOverrides(), {
      architect: 'xhigh',
      critic: 'high',
    });
    assert.equal(getAgentReasoningOverride('ARCHITECT'), 'xhigh');
    assert.equal(getAgentReasoningOverride('executor'), undefined);
  });

  it('keeps explicit low-complexity config ahead of OMX_DEFAULT_SPARK_MODEL', async () => {
    process.env.OMX_DEFAULT_SPARK_MODEL = 'gpt-5.3-codex-spark-fast';
    await writeConfig({ models: { team_low_complexity: 'gpt-4.1-mini' } });
    assert.equal(getTeamLowComplexityModel(), 'gpt-4.1-mini');
  });

  it('inherits the main default for standard agents when no standard override is configured', async () => {
    process.env.OMX_DEFAULT_FRONTIER_MODEL = 'gpt-5.5-custom';
    await writeConfig({ models: { team: 'gpt-4.1' } });
    assert.equal(getStandardDefaultModel(), 'gpt-5.5-custom');
  });

  it('returns canonical spark fallback when not configured', async () => {
    await writeConfig({ models: { team: 'gpt-4.1' } });
    assert.equal(getStandardDefaultModel(), DEFAULT_FRONTIER_MODEL);
    assert.equal(getSparkDefaultModel(), DEFAULT_SPARK_MODEL);
    assert.equal(getTeamLowComplexityModel(), DEFAULT_SPARK_MODEL);
  });
});
