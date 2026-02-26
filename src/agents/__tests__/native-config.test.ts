import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentDefinition } from '../definitions.js';
import { generateAgentToml, installNativeAgentConfigs } from '../native-config.js';

describe('agents/native-config', () => {
  it('generates TOML with stripped frontmatter and escaped triple quotes', () => {
    const agent: AgentDefinition = {
      name: 'executor',
      description: 'Code implementation',
      model: 'sonnet',
      tools: 'execution',
      category: 'build',
    };

    const prompt = `---\ntitle: demo\n---\n\nInstruction line\n\"\"\"danger\"\"\"`;
    const toml = generateAgentToml(agent, prompt);

    assert.match(toml, /# oh-my-codex agent: executor/);
    assert.match(toml, /model_reasoning_effort = "medium"/);
    assert.ok(!toml.includes('title: demo'));
    assert.ok(toml.includes('Instruction line'));

    const tripleQuoteBlocks = toml.match(/"""/g) || [];
    assert.equal(tripleQuoteBlocks.length, 2, 'only TOML delimiters should remain as raw triple quotes');
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
