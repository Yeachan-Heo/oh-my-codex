import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseToml } from '@iarna/toml';
import { test } from 'node:test';
import {
  assertInstalledReasoningDeclarationContract,
  assertInstalledRootReasoningHelp,
  assertInstalledRootReasoningRejection,
  assertInstalledTeamSkillContract,
} from '../smoke-packed-install.js';

const root = process.cwd();
const dist = join(root, 'dist');

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf-8');
}

test('compiled reasoning artifacts preserve exact surface-specific max contracts', async () => {
  const requiredArtifacts = [
    'dist/config/models.js',
    'dist/config/models.d.ts',
    'dist/agents/definitions.js',
    'dist/agents/definitions.d.ts',
    'dist/agents/native-config.js',
    'dist/agents/native-config.d.ts',
    'dist/team/model-contract.js',
    'dist/team/model-contract.d.ts',
    'dist/cli/index.js',
    'dist/cli/index.d.ts',
    'dist/cli/omx.js',
    'dist/cli/omx.d.ts',
  ];
  for (const relativePath of requiredArtifacts) {
    assert.equal(existsSync(join(root, relativePath)), true, `missing compiled artifact: ${relativePath}`);
  }

  const modelsDeclaration = read('dist/config/models.d.ts');
  const definitionsDeclaration = read('dist/agents/definitions.d.ts');
  const nativeDeclaration = read('dist/agents/native-config.d.ts');
  const teamDeclaration = read('dist/team/model-contract.d.ts');
  assertInstalledReasoningDeclarationContract({
    models: modelsDeclaration,
    definitions: definitionsDeclaration,
    nativeConfig: nativeDeclaration,
    team: teamDeclaration,
  });

  const models = await import(pathToFileURL(join(dist, 'config/models.js')).href);
  assert.deepEqual(models.CANONICAL_REASONING_EFFORTS, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(models.AMBIGUOUS_UNSUPPORTED_REASONING_EFFORTS, ['max', 'ultra']);
  assert.deepEqual(models.PER_AGENT_REASONING_EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(models.ROOT_REASONING_EFFORTS, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(models.ROOT_UNSUPPORTED_REASONING_EFFORTS, ['max', 'ultra']);
  assert.equal(models.isAmbiguousUnsupportedReasoningEffort('MAX'), true);
  assert.equal(models.isUnsupportedRootReasoningEffort('MAX'), true);
  assert.equal(models.isUnsupportedRootReasoningEffort('ultra'), true);
  assert.equal(models.isUnsupportedRootReasoningEffort('xhigh'), false);
  assert.equal(models.normalizeUnsupportedRootReasoningEffort(' MAX '), 'max');
  assert.equal(models.normalizeUnsupportedRootReasoningEffort('Ultra'), 'ultra');
  assert.equal(models.normalizeUnsupportedRootReasoningEffort('xhigh'), undefined);

  const nativeConfig = await import(pathToFileURL(join(dist, 'agents/native-config.js')).href);
  const definitions = await import(pathToFileURL(join(dist, 'agents/definitions.js')).href);
  const codexHome = mkdtempSync(join(tmpdir(), 'omx-artifact-max-native-'));
  try {
    writeFileSync(join(codexHome, '.omx-config.json'), JSON.stringify({
      agentReasoning: { architect: ' MAX ', critic: 'ultra' },
    }));
    const maxToml = nativeConfig.generateAgentToml(
      definitions.AGENT_DEFINITIONS.architect,
      'compiled native max contract',
      { codexHomeOverride: codexHome },
    );
    assert.match(maxToml, /model_reasoning_effort = "max"/);
    assert.doesNotMatch(maxToml, /model_reasoning_effort = "xhigh"/);
    assert.equal((parseToml(maxToml) as { model_reasoning_effort?: unknown }).model_reasoning_effort, 'max');

    const fallbackToml = nativeConfig.generateAgentToml(
      definitions.AGENT_DEFINITIONS.critic,
      'compiled native ultra fallback contract',
      { codexHomeOverride: codexHome },
    );
    assert.match(fallbackToml, /model_reasoning_effort = "high"/);
    assert.doesNotMatch(fallbackToml, /model_reasoning_effort = "ultra"/);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }

  const team = await import(pathToFileURL(join(dist, 'team/model-contract.js')).href);
  const maxArgs = team.resolveTeamWorkerLaunchArgs({ preferredReasoning: 'max' });
  assert.deepEqual(maxArgs, ['-c', 'model_reasoning_effort="max"']);
  assert.equal(maxArgs.includes('model_reasoning_effort="xhigh"'), false);
  const opaqueUltra = team.resolveTeamWorkerLaunchDiagnostics({
    existingRaw: '-c model_reasoning_effort="ultra"',
    preferredReasoning: 'max',
  });
  assert.equal(opaqueUltra.reasoningSource, 'explicit');
  assert.equal(opaqueUltra.actualReasoning, undefined);

  const canonicalSkill = readFileSync(join(root, 'skills/team/SKILL.md'));
  const pluginSkill = readFileSync(join(root, 'plugins/oh-my-codex/skills/team/SKILL.md'));
  assertInstalledTeamSkillContract(canonicalSkill, pluginSkill);
});

test('compiled root reasoning keeps four-value help and rejects max/ultra without mutation', () => {
  const omxPath = join(dist, 'cli/omx.js');
  const codexHome = mkdtempSync(join(tmpdir(), 'omx-artifact-root-reasoning-'));
  try {
    const env = { ...process.env, CODEX_HOME: codexHome };
    const configPath = join(codexHome, 'config.toml');
    const help = spawnSync(process.execPath, [omxPath, 'reasoning'], { encoding: 'utf-8', env });
    assert.equal(help.status, 0, help.stderr);
    assertInstalledRootReasoningHelp(help.stdout);
    const max = spawnSync(process.execPath, [omxPath, 'reasoning', 'max'], { encoding: 'utf-8', env });
    assertInstalledRootReasoningRejection('max', max, undefined, existsSync(configPath) ? readFileSync(configPath, 'utf-8') : undefined);

    const originalConfig = 'model = "preserve-root-config"\n';
    writeFileSync(configPath, originalConfig);
    const ultra = spawnSync(process.execPath, [omxPath, 'reasoning', 'ultra'], { encoding: 'utf-8', env });
    assertInstalledRootReasoningRejection('ultra', ultra, originalConfig, readFileSync(configPath, 'utf-8'));
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});
