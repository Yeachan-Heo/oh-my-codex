import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildSkillBridgeResolutionGuidance,
  generateSkillBridgeAgentToml,
  listInstalledSkillBridgeAgents,
} from '../skill-bridge.js';

describe('agents/skill-bridge', () => {
  it('generates lightweight bridge TOML without developer instructions', () => {
    const toml = generateSkillBridgeAgentToml({
      name: 'code-review',
      description: 'Run a comprehensive code review',
      skillRef: 'code-review',
    });

    assert.match(toml, /# oh-my-codex skill bridge agent: code-review/);
    assert.match(toml, /^skill_ref = "code-review"$/m);
    assert.doesNotMatch(toml, /developer_instructions\s*=/);
  });

  it('discovers installed skill bridge agents and emits Codex-home-first guidance', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-skill-bridge-'));
    const home = join(wd, 'home');
    const previousHome = process.env.HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = home;
    process.env.CODEX_HOME = join(home, '.codex');

    try {
      const projectAgentsDir = join(wd, '.codex', 'agents');
      const userAgentsDir = join(home, '.codex', 'agents');
      const userSkillsPath = join(home, '.codex', 'skills', 'plan');
      const legacyProjectSkillsPath = join(wd, '.agents', 'skills', 'code-review');
      await mkdir(projectAgentsDir, { recursive: true });
      await mkdir(userAgentsDir, { recursive: true });
      await mkdir(userSkillsPath, { recursive: true });
      await mkdir(legacyProjectSkillsPath, { recursive: true });
      await writeFile(join(userSkillsPath, 'SKILL.md'), '# user plan\n');
      await writeFile(join(legacyProjectSkillsPath, 'SKILL.md'), '# legacy project review\n');
      await writeFile(
        join(projectAgentsDir, 'plan.toml'),
        generateSkillBridgeAgentToml({
          name: 'plan',
          description: 'Strategic planning',
          skillRef: 'plan',
        }),
      );
      await writeFile(
        join(userAgentsDir, 'code-review.toml'),
        generateSkillBridgeAgentToml({
          name: 'code-review',
          description: 'Review code',
          skillRef: 'code-review',
        }),
      );

      const bridges = await listInstalledSkillBridgeAgents(wd);
      assert.deepEqual(bridges.map((item) => [item.scope, item.name, item.skillRef]), [
        ['project', 'plan', 'plan'],
        ['user', 'code-review', 'code-review'],
      ]);

      const guidance = await buildSkillBridgeResolutionGuidance(wd);
      assert.match(guidance, /Native Skill Bridge/);
      assert.match(guidance, new RegExp(`${join(home, '.codex', 'skills').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/<skill>/SKILL\.md`));
      assert.match(guidance, /primary Codex skills path/);
      assert.match(guidance, /legacy project fallback/);
      assert.match(guidance, /legacy compatibility fallback/);
    } finally {
      if (typeof previousHome === 'string') process.env.HOME = previousHome;
      else delete process.env.HOME;
      if (typeof previousCodexHome === 'string') process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      await rm(wd, { recursive: true, force: true });
    }
  });
});
