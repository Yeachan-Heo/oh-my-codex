import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { checkSparkRouting } from '../doctor.js';

const SPARK_DEFAULT = 'gpt-6-luna';

const SPARK_ENV_KEYS = [
  'OMX_DEFAULT_SPARK_MODEL',
  'OMX_SPARK_MODEL',
  'OMX_DEFAULT_STANDARD_MODEL',
  'OMX_DEFAULT_FRONTIER_MODEL',
] as const;

const saved = new Map<string, string | undefined>();

function makePaths(codexHomeDir: string) {
  const agentsDir = join(codexHomeDir, 'agents');
  return {
    codexHomeDir,
    configPath: join(codexHomeDir, 'config.toml'),
    hooksPath: join(codexHomeDir, 'hooks'),
    promptsDir: join(codexHomeDir, 'prompts'),
    skillsDir: join(codexHomeDir, 'skills'),
    agentsDir,
    stateDir: join(codexHomeDir, 'state'),
  };
}

let workDir: string;

beforeEach(() => {
  for (const key of SPARK_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  workDir = mkdtempSync(join(tmpdir(), 'omx-doctor-spark-'));
  mkdirSync(join(workDir, 'agents'), { recursive: true });
});

afterEach(() => {
  for (const key of SPARK_ENV_KEYS) {
    const value = saved.get(key);
    if (typeof value === 'string') process.env[key] = value;
    else delete process.env[key];
  }
  rmSync(workDir, { recursive: true, force: true });
});

/** Writes explore.toml and the other Spark-lane agent (vision.toml); vision mirrors explore's model unless given. */
function writeExploreToml(body: string, visionModel?: string): void {
  writeFileSync(join(workDir, 'agents', 'explore.toml'), body);
  const exploreModel = body.match(/^model = "([^"]+)"$/m)?.[1];
  const model = visionModel ?? exploreModel;
  writeFileSync(
    join(workDir, 'agents', 'vision.toml'),
    model ? `name = "vision"\nmodel = "${model}"\n` : 'name = "vision"\n',
  );
}

describe('checkSparkRouting', () => {
  it('passes and names the resolved Spark model when the lane is wired correctly', () => {
    writeExploreToml(
      `name = "explore"\nmodel = "${SPARK_DEFAULT}"\n`,
    );
    const result = checkSparkRouting(makePaths(workDir));
    assert.equal(result.status, 'pass');
    assert.match(result.message, new RegExp(SPARK_DEFAULT));
    assert.match(result.message, /wired/);
    assert.match(result.message, /spark=/);
  });

  it('reports .omx-config.json as the source for its Spark env override', () => {
    writeFileSync(join(workDir, '.omx-config.json'), JSON.stringify({
      env: { OMX_DEFAULT_SPARK_MODEL: 'spark-from-omx-config' },
    }));
    writeExploreToml('name = "explore"\nmodel = "spark-from-omx-config"\n');

    const result = checkSparkRouting(makePaths(workDir));
    assert.match(result.message, /source: \.omx-config\.json env/);
  });

  it('reports models.team_low_complexity as the source for a low-complexity Spark override', () => {
    writeFileSync(join(workDir, '.omx-config.json'), JSON.stringify({
      models: { team_low_complexity: 'custom-spark' },
    }));
    writeExploreToml('name = "explore"\nmodel = "custom-spark"\n');

    const result = checkSparkRouting(makePaths(workDir));
    assert.match(result.message, /source: \.omx-config\.json models\.team_low_complexity/);
  });

  it('warns when the Spark-lane agent toml is missing', () => {
    const result = checkSparkRouting(makePaths(workDir));
    assert.equal(result.status, 'warn');
    assert.match(result.message, /explore\.toml is missing/);
    assert.match(result.message, /omx setup --force/);
  });

  it('warns when the installed model diverges from the resolved Spark model', () => {
    writeExploreToml(`name = "explore"\nmodel = "gpt-5.6-terra"\n`);
    const result = checkSparkRouting(makePaths(workDir));
    assert.equal(result.status, 'warn');
    assert.match(result.message, /gpt-5\.6-terra/);
    assert.match(result.message, /stale install/);
  });

  it('passes and reports intentional explore model override instead of stale spark guidance', () => {
    writeFileSync(join(workDir, '.omx-config.json'), JSON.stringify({
      agentModels: {
        explore: 'gpt-5.6-sol-explore',
      },
    }));
    writeExploreToml('name = "explore"\nmodel = "gpt-5.6-sol-explore"\n', SPARK_DEFAULT);

    const result = checkSparkRouting(makePaths(workDir));

    assert.equal(result.status, 'pass');
    assert.match(result.message, /agentModels override/);
    assert.match(result.message, /gpt-5\.6-sol-explore/);
    assert.doesNotMatch(result.message, /stale install/);
  });

  it('warns when the Spark-lane agent routes through a non-default provider', () => {
    writeExploreToml(
      `name = "explore"\nmodel = "${SPARK_DEFAULT}"\nmodel_provider = "my-proxy"\n`,
    );
    const result = checkSparkRouting(makePaths(workDir));
    assert.equal(result.status, 'warn');
    assert.match(result.message, /non-default model_provider/);
    assert.match(result.message, /my-proxy/);
  });

  it('passes when the Spark-lane agent TOML has no model field and no agentModels override (runtime inheritance)', () => {
    // This reproduces #3822: since 0.21.18, generator doesn't write model field
    // for agents without explicit specs; they inherit from config.toml at runtime.
    // Doctor should accept this as correct, not flag it as stale.
    writeExploreToml(
      `name = "explore"\ndescription = "Explore with lightweight synthesis"\n`,
    );
    const result = checkSparkRouting(makePaths(workDir));
    assert.equal(result.status, 'pass', `expected pass but got ${result.status}: ${result.message}`);
    assert.match(result.message, /wired/);
    assert.doesNotMatch(result.message, /stale install/);
  });

  it('warns when the Spark-lane agent TOML has no model field but config has an explicit agentModels override', () => {
    // Mismatch: override configured but not written to TOML -> stale
    writeFileSync(join(workDir, '.omx-config.json'), JSON.stringify({
      agentModels: {
        explore: 'gpt-5.6-sol-explore',
      },
    }));
    writeExploreToml(
      `name = "explore"\ndescription = "Explore with lightweight synthesis"\n`,
    );
    const result = checkSparkRouting(makePaths(workDir));
    assert.equal(result.status, 'warn');
    assert.match(result.message, /stale install/);
    assert.match(result.message, /gpt-5\.6-sol-explore/);
  });
});
