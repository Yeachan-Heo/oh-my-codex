import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import type { AgentDefinition } from '../definitions.js';
import { generateAgentToml, generateSkillAgentToml, installNativeAgentConfigs } from '../native-config.js';

describe('agents/native-config', () => {
  it('generates TOML with stripped frontmatter and escaped triple quotes', () => {
    const agent: AgentDefinition = {
      name: 'executor',
      description: 'Code implementation',
      reasoningEffort: 'medium',
      posture: 'deep-worker',
      modelClass: 'standard',
      routingRole: 'executor',
      tools: 'execution',
      category: 'build',
    };

    const prompt = `---\ntitle: demo\n---\n\nInstruction line\n\"\"\"danger\"\"\"`;
    const toml = generateAgentToml(agent, prompt);

    assert.match(toml, /# oh-my-codex agent: executor/);
    assert.match(toml, /model_reasoning_effort = "medium"/);
    assert.ok(!toml.includes('title: demo'));
    assert.ok(toml.includes('Instruction line'));
    assert.ok(toml.includes('You are operating in the deep-worker posture.'));
    assert.ok(toml.includes('- posture: deep-worker'));

    const tripleQuoteBlocks = toml.match(/"""/g) || [];
    assert.equal(tripleQuoteBlocks.length, 2, 'only TOML delimiters should remain as raw triple quotes');
  });


  it('generates lightweight skill bridge TOML with skill_ref and no embedded instructions', () => {
    const toml = generateSkillAgentToml('plan', 'Strategic planning with optional interview workflow');

    assert.match(toml, /# oh-my-codex skill bridge agent: plan/);
    assert.match(toml, /^name = "plan"$/m);
    assert.match(toml, /^description = "Strategic planning with optional interview workflow"$/m);
    assert.match(toml, /^skill_ref = "plan"$/m);
    assert.doesNotMatch(toml, /developer_instructions\s*=/);
  });

  it('installs only agents with prompt files and skips existing files without force', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-native-config-'));
    const promptsDir = join(root, 'prompts');
    const outDir = join(root, 'agents-out');

    try {
      await mkdir(promptsDir, { recursive: true });
      await writeFile(join(promptsDir, 'executor.md'), 'executor prompt');
      await writeFile(join(promptsDir, 'planner.md'), 'planner prompt');

      const created = await installNativeAgentConfigs(root, { agentsDir: outDir });
      assert.equal(created, 2);
      assert.equal(existsSync(join(outDir, 'executor.toml')), true);
      assert.equal(existsSync(join(outDir, 'planner.toml')), true);

      const executorToml = await readFile(join(outDir, 'executor.toml'), 'utf8');
      assert.match(executorToml, /model_reasoning_effort = "medium"/);

      const skipped = await installNativeAgentConfigs(root, { agentsDir: outDir });
      assert.equal(skipped, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
