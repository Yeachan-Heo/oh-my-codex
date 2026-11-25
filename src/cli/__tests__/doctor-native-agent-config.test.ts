import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateAgentToml, hashGeneratedDeveloperInstructions } from '../../agents/native-config.js';
import { AGENT_DEFINITIONS } from '../../agents/definitions.js';
import { checkNativeAgentConfigDrift } from '../doctor.js';

const savedTeamMode = process.env.OMX_TEAM_MODE;
let root: string;

function paths() {
  const codexHomeDir = join(root, '.codex');
  return {
    codexHomeDir,
    configPath: join(codexHomeDir, 'config.toml'),
    hooksPath: join(codexHomeDir, 'hooks.json'),
    promptsDir: join(codexHomeDir, 'prompts'),
    skillsDir: join(codexHomeDir, 'skills'),
    agentsDir: join(codexHomeDir, 'agents'),
    stateDir: join(root, '.omx', 'state'),
  };
}

function writeExecutorToml(): string {
  const prompt = readFileSync(join(process.cwd(), 'prompts', 'executor.md'), 'utf-8');
  const content = generateAgentToml(AGENT_DEFINITIONS.executor, prompt, {
    codexHomeOverride: paths().codexHomeDir,
  });
  writeFileSync(join(paths().agentsDir, 'executor.toml'), content);
  return content;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omx-doctor-agent-config-'));
  mkdirSync(paths().agentsDir, { recursive: true });
  mkdirSync(join(root, '.omx'), { recursive: true });
  writeFileSync(join(root, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project', teamMode: 'disabled' }));
});

afterEach(() => {
  if (savedTeamMode === undefined) delete process.env.OMX_TEAM_MODE;
  else process.env.OMX_TEAM_MODE = savedTeamMode;
  rmSync(root, { recursive: true, force: true });
});

describe('checkNativeAgentConfigDrift', () => {
  it('reports missing installable agent files and respects Team-disabled selection', async () => {
    const result = await checkNativeAgentConfigDrift(paths(), root);
    assert.equal(result.status, 'warn');
    assert.match(result.message, /executor\.toml is missing/);
    assert.doesNotMatch(result.message, /team-executor\.toml/);
  });

  it('compares installed model fields with generator expectations', async () => {
    const generated = writeExecutorToml();
    const tampered = generated.replace(/^model = ".*"$/m, 'model = "unsupported-manual-model"');
    writeFileSync(join(paths().agentsDir, 'executor.toml'), tampered);

    const result = await checkNativeAgentConfigDrift(paths(), root);
    assert.equal(result.status, 'warn');
    assert.match(result.message, /executor\.toml has unsupported\/stale model value/);
  });

  it('reports a customized prompt body while keeping the generated baseline digest distinct', async () => {
    const generated = writeExecutorToml();
    const prompt = (generated.match(/^developer_instructions = """\n([\s\S]*?)^"""$/m)?.[1] ?? '');
    const customized = generated.replace('<identity>', '<identity>\nUser prompt addition');
    writeFileSync(join(paths().agentsDir, 'executor.toml'), customized);
    const digest = hashGeneratedDeveloperInstructions(prompt);
    const fileHash = createHash('sha256').update(generated).digest('hex');
    mkdirSync(join(paths().agentsDir, '..', '.omx'), { recursive: true });
    writeFileSync(join(paths().agentsDir, '..', '.omx', 'native-agents.json'), JSON.stringify({
      version: 1,
      files: { 'executor.toml': { sha256: fileHash, developerInstructionsSha256: digest } },
    }));

    const result = await checkNativeAgentConfigDrift(paths(), root);
    assert.equal(result.status, 'warn');
    assert.match(result.message, /executor\.toml contains a customized user developer_instructions version/);
  });

  it('distinguishes valid but unsafe-to-edit TOML source layouts', async () => {
    const generated = writeExecutorToml();
    const unsafe = generated
      .replace(/^model = ".*"$/m, 'model = "stale-model"')
      .replace(/^description = .*$/m, 'description = """\nmodel = "text inside a string"\n"""');
    writeFileSync(join(paths().agentsDir, 'executor.toml'), unsafe);

    const result = await checkNativeAgentConfigDrift(paths(), root);
    assert.equal(result.status, 'warn');
    assert.match(result.message, /valid TOML source layout is unsafe for the needed automatic refresh/);
    assert.match(result.message, /setup preserves it/);
  });

  it('reports when a prior generated body cannot be replaced in its current valid TOML form', async () => {
    const generated = writeExecutorToml();
    const body = generated.match(/^developer_instructions = """\n([\s\S]*?)^"""$/m)?.[1];
    assert.ok(body);
    const manifestDir = join(paths().agentsDir, '..', '.omx');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, 'native-agents.json'), JSON.stringify({
      version: 1,
      files: {
        'executor.toml': {
          sha256: createHash('sha256').update(generated).digest('hex'),
          developerInstructionsSha256: hashGeneratedDeveloperInstructions(body),
        },
      },
    }));
    const compactBody = generated.replace(
      /^developer_instructions = """\n[\s\S]*?^"""$/m,
      `developer_instructions = ${JSON.stringify(body)}`,
    );
    writeFileSync(join(paths().agentsDir, 'executor.toml'), compactBody);
    writeFileSync(join(paths().codexHomeDir, '.omx-config.json'), JSON.stringify({ agentModels: { executor: 'next-model' } }));

    const result = await checkNativeAgentConfigDrift(paths(), root);
    assert.equal(result.status, 'warn');
    assert.match(result.message, /valid TOML source layout is unsafe for the needed automatic refresh/);
  });

  it('reads Team preferences from project setup-scope, not from OMX_STATE_ROOT-derived cwd', async () => {
    // Create a separate temp directory for OMX_STATE_ROOT outside the project
    const externalStateRoot = mkdtempSync(join(tmpdir(), 'omx-external-state-'));
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    try {
      process.env.OMX_STATE_ROOT = externalStateRoot;
      writeExecutorToml();
      
      // Verify setup-scope.json is in the project root with teamMode disabled
      const setupScopeContent = readFileSync(join(root, '.omx', 'setup-scope.json'), 'utf-8');
      assert.match(setupScopeContent, /"teamMode"\s*:\s*"disabled"/);

      // doctor should read Team disabled from project scope, not walk up from externalStateRoot
      const result = await checkNativeAgentConfigDrift(paths(), root);
      // team-executor.toml should not be reported as missing since Team is disabled in project scope
      // This test verifies that we successfully read Team disabled from project scope
      // even though OMX_STATE_ROOT is set to a directory outside the project
      assert.doesNotMatch(result.message, /team-executor\.toml/);
    } finally {
      if (previousOmxStateRoot === undefined) delete process.env.OMX_STATE_ROOT;
      else process.env.OMX_STATE_ROOT = previousOmxStateRoot;
      rmSync(externalStateRoot, { recursive: true, force: true });
    }
  });
});
