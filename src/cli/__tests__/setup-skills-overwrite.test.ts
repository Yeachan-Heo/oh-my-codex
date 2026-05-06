import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup } from '../setup.js';

describe('omx setup skills overwrite behavior', () => {
  it('installs wiki during setup even though it is omitted from the current manifest', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const wikiSkill = join(wd, '.codex', 'skills', 'wiki', 'SKILL.md');
      assert.equal(existsSync(wikiSkill), true);
      assert.ok((await readFile(wikiSkill, 'utf-8')).includes('description: "[OMX] '));
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('adds an [OMX] description badge to installed shipped skills without changing the shipped source files', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const installedSetupSkill = join(wd, '.codex', 'skills', 'omx-setup', 'SKILL.md');
      const shippedHelpSkill = join(previousCwd, 'skills', 'help', 'SKILL.md');

      assert.ok(
        (await readFile(installedSetupSkill, 'utf-8')).includes(
          'description: "[OMX] Setup and configure oh-my-codex using current CLI behavior"',
        ),
      );
      assert.ok(
        (await readFile(shippedHelpSkill, 'utf-8')).includes(
          'description: Help deprecated skill',
        ),
      );
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('installs only active/internal catalog skills (skips alias/merged/deprecated)', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const skillsDir = join(wd, '.codex', 'skills');
      const installed = new Set(await readdir(skillsDir));

      assert.equal(installed.has('analyze'), true);
      assert.equal(installed.has('team'), true);
      assert.equal(installed.has('worker'), true);
      assert.equal(installed.has('autoresearch'), true);
      assert.equal(installed.has('swarm'), false);
      assert.equal(installed.has('ecomode'), false);
      assert.equal(installed.has('ultraqa'), true);
      assert.equal(installed.has('ralph-init'), false);
      assert.equal(installed.has('visual-ralph'), true);
      assert.equal(installed.has('web-clone'), false);
      assert.equal(installed.has('frontend-ui-ux'), false);
      assert.equal(installed.has('pipeline'), true);
      assert.equal(installed.has('configure-notifications'), true);
      assert.equal(installed.has('wiki'), true);
      assert.equal(installed.has('configure-discord'), false);
      assert.equal(installed.has('configure-telegram'), false);
      assert.equal(installed.has('configure-slack'), false);
      assert.equal(installed.has('configure-openclaw'), false);
      assert.match(
        await readFile(join(skillsDir, 'analyze', 'SKILL.md'), 'utf-8'),
        /^---\nname: analyze/m,
      );
      assert.match(
        await readFile(join(skillsDir, 'autoresearch', 'SKILL.md'), 'utf-8'),
        /^---\nname: autoresearch/m,
      );
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes stale web-clone installs during normal hard-deprecation refresh', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const staleWebCloneDir = join(wd, '.codex', 'skills', 'web-clone');
      await mkdir(staleWebCloneDir, { recursive: true });
      await writeFile(
        join(staleWebCloneDir, 'SKILL.md'),
        '---\nname: web-clone\ndescription: old standalone pipeline\n---\n\nClone a target website from its URL.\n',
      );
      assert.equal(existsSync(staleWebCloneDir), true);

      await setup({ scope: 'project' });

      assert.equal(existsSync(staleWebCloneDir), false);
      assert.equal(existsSync(join(wd, '.codex', 'skills', 'visual-ralph', 'SKILL.md')), true);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes stale alias/merged skill directories on --force', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const staleSkills = ['swarm', 'ecomode', 'configure-discord', 'configure-telegram', 'configure-slack', 'configure-openclaw'];
      for (const staleSkill of staleSkills) {
        const staleDir = join(wd, '.codex', 'skills', staleSkill);
        await mkdir(staleDir, { recursive: true });
        await writeFile(join(staleDir, 'SKILL.md'), `# stale ${staleSkill}\n`);
        assert.equal(existsSync(staleDir), true);
      }

      await setup({ scope: 'project', force: true });

      for (const staleSkill of staleSkills) {
        assert.equal(existsSync(join(wd, '.codex', 'skills', staleSkill)), false);
      }
      assert.equal(existsSync(join(wd, '.codex', 'skills', 'team')), true);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps newly cataloged pipeline skill fresh on --force', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const pipelinePath = join(wd, '.codex', 'skills', 'pipeline', 'SKILL.md');
      await writeFile(pipelinePath, '# stale pipeline\n');

      await setup({ scope: 'project', force: true });

      assert.match(await readFile(pipelinePath, 'utf-8'), /^---\nname: pipeline/m);
      assert.equal(existsSync(join(wd, '.codex', 'skills', 'team')), true);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('retains wiki on --force while still removing unrelated stale alias skills', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const wikiDir = join(wd, '.codex', 'skills', 'wiki');
      const staleSwarmDir = join(wd, '.codex', 'skills', 'swarm');
      assert.equal(existsSync(wikiDir), true);

      await mkdir(staleSwarmDir, { recursive: true });
      await writeFile(join(staleSwarmDir, 'SKILL.md'), '# stale swarm\n');

      await setup({ scope: 'project', force: true });

      assert.equal(existsSync(wikiDir), true);
      assert.equal(existsSync(join(wikiDir, 'SKILL.md')), true);
      assert.equal(existsSync(staleSwarmDir), false);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('refreshes existing skill files by default and restores packaged content', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const skillPath = join(wd, '.codex', 'skills', 'omx-setup', 'SKILL.md');
      assert.equal(existsSync(skillPath), true);

      const installed = await readFile(skillPath, 'utf-8');
      const customized = `${installed}\n\n# local customization\n`;
      await writeFile(skillPath, customized);

      await setup({ scope: 'project' });
      assert.equal(await readFile(skillPath, 'utf-8'), installed);

      const backupsRoot = join(wd, '.omx', 'backups', 'setup');
      assert.equal(existsSync(backupsRoot), true);

      await setup({ scope: 'project', force: true });
      assert.equal(await readFile(skillPath, 'utf-8'), installed);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves unrelated user-authored skill directories during setup and --force refresh', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const customSkillDir = join(wd, '.codex', 'skills', 'my-custom-skill');
      const customSkillPath = join(customSkillDir, 'SKILL.md');
      await mkdir(customSkillDir, { recursive: true });
      await writeFile(customSkillPath, '---\nname: my-custom-skill\ndescription: local custom skill\n---\n');

      await setup({ scope: 'project' });
      assert.equal(await readFile(customSkillPath, 'utf-8'), '---\nname: my-custom-skill\ndescription: local custom skill\n---\n');

      await setup({ scope: 'project', force: true });
      assert.equal(await readFile(customSkillPath, 'utf-8'), '---\nname: my-custom-skill\ndescription: local custom skill\n---\n');
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not keep stacking the [OMX] description badge on repeated setup runs', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });
      await setup({ scope: 'project' });

      const installedSetupSkill = join(wd, '.codex', 'skills', 'omx-setup', 'SKILL.md');
      const content = await readFile(installedSetupSkill, 'utf-8');
      const matches = content.match(/\[OMX\] Setup and configure oh-my-codex using current CLI behavior/g) ?? [];
      assert.equal(matches.length, 1);
      assert.doesNotMatch(content, /\[OMX\] \[OMX\]/);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('logs skip/remove decisions in verbose mode', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);
      console.log = (...args: unknown[]) => {
        logs.push(args.map((arg) => String(arg)).join(' '));
      };

      await setup({ scope: 'project', verbose: true });
      await mkdir(join(wd, '.codex', 'skills', 'swarm'), { recursive: true });
      await writeFile(join(wd, '.codex', 'skills', 'swarm', 'SKILL.md'), '# stale swarm\n');
      await setup({ scope: 'project', force: true, verbose: true });

      const output = logs.join('\n');
      assert.match(output, /skipped swarm\/ \(status: deprecated\)/);
      assert.match(output, /removed stale skill swarm\/ \(status: deprecated\)/);
      assert.match(output, /skills: updated=/);
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('prints a migration hint when legacy ~/.agents/skills overlaps canonical user skills', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    const previousHome = process.env.HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      const home = join(wd, 'home');
      const codexHome = join(home, '.codex');
      process.env.HOME = home;
      process.env.CODEX_HOME = codexHome;
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(join(home, '.agents', 'skills', 'omx-setup'), { recursive: true });
      await writeFile(join(home, '.agents', 'skills', 'omx-setup', 'SKILL.md'), '# legacy omx-setup\n');
      process.chdir(wd);
      console.log = (...args: unknown[]) => {
        logs.push(args.map((arg) => String(arg)).join(' '));
      };

      await setup({ scope: 'user' });

      const output = logs.join('\n');
      assert.match(output, /Migration hint: Detected 1 overlapping skill names between canonical .*\.codex\/skills and legacy .*\.agents\/skills\./);
      assert.match(output, /Remove or archive ~\/\.agents\/skills after confirming .*\.codex\/skills is the version you want Codex to load\./);
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      if (typeof previousHome === 'string') process.env.HOME = previousHome; else delete process.env.HOME;
      if (typeof previousCodexHome === 'string') process.env.CODEX_HOME = previousCodexHome; else delete process.env.CODEX_HOME;
      await rm(wd, { recursive: true, force: true });
    }
  });

});
