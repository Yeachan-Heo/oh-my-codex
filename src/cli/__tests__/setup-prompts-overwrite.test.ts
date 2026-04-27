import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup } from '../setup.js';
import { readCatalogManifest } from '../../catalog/reader.js';
import {
  NON_NATIVE_AGENT_PROMPT_ASSETS,
  getInstallableNativeAgentNames,
} from '../../agents/policy.js';

describe('omx setup prompt/native-agent overwrite behavior', () => {
  const obsoleteNativeAgentField = ['skill', 'ref'].join('_');

  it('installs setup-owned prompts separately from active/internal native agents', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-prompts-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const promptsDir = join(wd, '.codex', 'prompts');
      const nativeAgentsDir = join(wd, '.codex', 'agents');
      const installedPrompts = new Set(await readdir(promptsDir));
      const installedNativeAgents = new Set(await readdir(nativeAgentsDir));

      assert.equal(installedPrompts.has('executor.md'), true);
      assert.equal(installedPrompts.has('team-executor.md'), true);
      assert.equal(installedPrompts.has('code-reviewer.md'), true);
      assert.equal(installedPrompts.has('code-simplifier.md'), true);

      for (const promptOnlyAgent of [
        'style-reviewer',
        'quality-reviewer',
        'api-reviewer',
        'performance-reviewer',
        'product-manager',
        'ux-researcher',
        'information-architect',
        'product-analyst',
        'qa-tester',
        'quality-strategist',
      ]) {
        assert.equal(
          installedPrompts.has(`${promptOnlyAgent}.md`),
          true,
          `expected setup to preserve prompt-only role ${promptOnlyAgent}.md`,
        );
      }

      for (const promptAsset of NON_NATIVE_AGENT_PROMPT_ASSETS) {
        assert.equal(
          installedPrompts.has(`${promptAsset}.md`),
          true,
          `expected setup to preserve explicit prompt asset ${promptAsset}.md`,
        );
      }

      const installableNativeAgents = getInstallableNativeAgentNames(readCatalogManifest());
      for (const agentName of installableNativeAgents) {
        assert.equal(
          installedNativeAgents.has(`${agentName}.toml`),
          true,
          `expected setup to install native agent ${agentName}.toml`,
        );
      }
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

      const codeReviewerToml = await readFile(join(wd, '.codex', 'agents', 'code-reviewer.toml'), 'utf-8');
      assert.match(codeReviewerToml, /^name = "code-reviewer"$/m);
      assert.match(codeReviewerToml, /developer_instructions\s*=/);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves setup-owned prompt assets and removes unknown prompts on --force', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-prompts-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const validPrompts = ['style-reviewer.md', 'quality-reviewer.md', 'sisyphus-lite.md'];
      for (const validPrompt of validPrompts) {
        assert.equal(existsSync(join(wd, '.codex', 'prompts', validPrompt)), true);
      }

      const unknownPromptPath = join(wd, '.codex', 'prompts', 'unclassified-local.md');
      await writeFile(unknownPromptPath, '# unclassified local prompt\n');
      assert.equal(existsSync(unknownPromptPath), true);

      await setup({ scope: 'project', force: true });

      for (const validPrompt of validPrompts) {
        assert.equal(existsSync(join(wd, '.codex', 'prompts', validPrompt)), true);
      }
      assert.equal(existsSync(unknownPromptPath), false);
      assert.equal(existsSync(join(wd, '.codex', 'prompts', 'executor.md')), true);
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

  it('removes generated non-installable native agents during normal setup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-prompts-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const stalePath = join(wd, '.codex', 'agents', 'style-reviewer.toml');
      await writeFile(
        stalePath,
        [
          '# oh-my-codex agent: style-reviewer',
          'name = "style-reviewer"',
          'description = "old generated merged role"',
          'developer_instructions = """old"""',
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

  it('preserves user-authored non-installable native agents during normal setup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-prompts-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const userAuthoredPath = join(wd, '.codex', 'agents', 'style-reviewer.toml');
      await writeFile(
        userAuthoredPath,
        [
          '# user-authored local agent',
          'name = "style-reviewer"',
          'description = "custom local role"',
          '',
        ].join('\n'),
      );
      assert.equal(existsSync(userAuthoredPath), true);

      await setup({ scope: 'project' });

      assert.equal(existsSync(userAuthoredPath), true);
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
