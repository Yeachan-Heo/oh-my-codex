import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup } from '../setup.js';

describe('omx setup skills overwrite behavior', () => {
  it('installs only active/internal catalog skills (skips alias/merged)', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const skillsDir = join(wd, '.codex', 'skills');
      const installed = new Set(await readdir(skillsDir));

      assert.equal(installed.has('team'), true);
      assert.equal(installed.has('worker'), true);
      assert.equal(installed.has('swarm'), false);
      assert.equal(installed.has('ecomode'), false);
      assert.equal(installed.has('ultraqa'), false);
      assert.equal(installed.has('ralph-init'), false);
      assert.equal(installed.has('frontend-ui-ux'), false);
      assert.equal(installed.has('pipeline'), false);
      assert.equal(installed.has('configure-notifications'), true);
      assert.equal(installed.has('configure-discord'), false);
      assert.equal(installed.has('configure-telegram'), false);
      assert.equal(installed.has('configure-slack'), false);
      assert.equal(installed.has('configure-openclaw'), false);
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

      const staleSkills = ['swarm', 'ecomode', 'ultraqa', 'configure-discord', 'configure-telegram', 'configure-slack', 'configure-openclaw'];
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

  it('removes stale unlisted shipped skill directories on --force', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const staleSkill = 'pipeline';
      const staleDir = join(wd, '.codex', 'skills', staleSkill);
      await mkdir(staleDir, { recursive: true });
      await writeFile(join(staleDir, 'SKILL.md'), `# stale ${staleSkill}\n`);
      assert.equal(existsSync(staleDir), true);

      await setup({ scope: 'project', force: true });

      assert.equal(existsSync(join(wd, '.codex', 'skills', staleSkill)), false);
      assert.equal(existsSync(join(wd, '.codex', 'skills', 'team')), true);
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

      const skillPath = join(wd, '.codex', 'skills', 'help', 'SKILL.md');
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
      assert.match(output, /skipped swarm\/ \(status: alias\)/);
      assert.match(output, /removed stale skill swarm\/ \(status: alias\)/);
      assert.match(output, /skills: updated=/);
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });
});
