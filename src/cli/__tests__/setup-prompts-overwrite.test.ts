import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup } from '../setup.js';

describe('omx setup prompt/native-agent overwrite behavior', () => {
  const obsoleteNativeAgentField = ['skill', 'ref'].join('_');

  it('installs only active/internal catalog native agents', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-prompts-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const nativeAgentsDir = join(wd, '.codex', 'agents');
      const installedNativeAgents = new Set(await readdir(nativeAgentsDir));

      assert.equal(installedNativeAgents.has('executor.toml'), true);
      assert.equal(installedNativeAgents.has('team-executor.toml'), true);
      assert.equal(installedNativeAgents.has('code-reviewer.toml'), true);
      assert.equal(installedNativeAgents.has('code-review.toml'), false);
      assert.equal(installedNativeAgents.has('plan.toml'), false);
      assert.equal(installedNativeAgents.has('style-reviewer.toml'), false);
      assert.equal(installedNativeAgents.has('quality-reviewer.toml'), false);
      assert.equal(installedNativeAgents.has('api-reviewer.toml'), false);
      assert.equal(installedNativeAgents.has('performance-reviewer.toml'), false);
      assert.equal(installedNativeAgents.has('product-manager.toml'), false);
      assert.equal(installedNativeAgents.has('ux-researcher.toml'), false);
      assert.equal(installedNativeAgents.has('information-architect.toml'), false);
      assert.equal(installedNativeAgents.has('product-analyst.toml'), false);
      assert.equal(installedNativeAgents.has('code-simplifier.toml'), true);

      const codeReviewerToml = await readFile(join(wd, '.codex', 'agents', 'code-reviewer.toml'), 'utf-8');
      assert.match(codeReviewerToml, /^name = "code-reviewer"$/m);
      assert.match(codeReviewerToml, /developer_instructions\s*=/);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('removes stale merged native agents on --force', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-prompts-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const staleAgents = ['style-reviewer.toml', 'quality-reviewer.toml'];
      for (const staleAgent of staleAgents) {
        const stalePath = join(wd, '.codex', 'agents', staleAgent);
        await writeFile(stalePath, '# stale native agent\n');
        assert.equal(existsSync(stalePath), true);
      }

      await setup({ scope: 'project', force: true });

      for (const staleAgent of staleAgents) {
        assert.equal(existsSync(join(wd, '.codex', 'agents', staleAgent)), false);
      }
      assert.equal(existsSync(join(wd, '.codex', 'agents', 'executor.toml')), true);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes stale native agents with the obsolete bridge field during normal setup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-prompts-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const stalePath = join(wd, '.codex', 'agents', 'legacy-skill-agent.toml');
      await writeFile(
        stalePath,
        [
          'name = "legacy-skill-agent"',
          'description = "obsolete generated bridge agent"',
          `${obsoleteNativeAgentField} = "skills/legacy"`,
          '',
        ].join('\n'),
      );
      assert.equal(existsSync(stalePath), true);

      await setup({ scope: 'project' });

      assert.equal(existsSync(stalePath), false);
      assert.equal(existsSync(join(wd, '.codex', 'agents', 'executor.toml')), true);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

});
