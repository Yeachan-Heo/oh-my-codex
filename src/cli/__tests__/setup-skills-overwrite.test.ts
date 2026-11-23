import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup } from '../setup.js';


/**
 * Seed a retired OMX skill the way a real install leaves it: the badged directory PLUS the install
 * receipt recording its digests. Retirement requires proof of an unmodified install, so a fixture
 * without a receipt is conservatively retained.
 */
async function seedRetiredOmxSkill(skillsDir: string, name: string, description: string): Promise<string> {
  const dir = join(skillsDir, name);
  await mkdir(dir, { recursive: true });
  const body = `---\nname: ${name}\ndescription: "[OMX] ${description}"\n---\n`;
  await writeFile(join(dir, 'SKILL.md'), body);
  await recordInstallReceipt(skillsDir, name);
  return dir;
}

/** Record real per-file digests for one skill directory into the install receipt. */
async function recordInstallReceipt(skillsDir: string, name: string): Promise<void> {
  const receiptPath = join(dirname(dirname(skillsDir)), '.omx', 'state', 'setup', 'installed-skills.json');
  let receipt: { version: 1; skills: Record<string, { files: Record<string, string> }> };
  try {
    receipt = JSON.parse(await readFile(receiptPath, 'utf-8'));
  } catch {
    receipt = { version: 1, skills: {} };
  }
  const files: Record<string, string> = {};
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full, rel); continue; }
      if (!entry.isFile()) continue;
      files[rel] = createHash('sha256').update(await readFile(full)).digest('hex');
    }
  };
  await walk(join(skillsDir, name), '');
  receipt.skills[name] = { files };
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

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
      const shippedSetupSkill = join(previousCwd, 'skills', 'omx-setup', 'SKILL.md');

      assert.ok(
        (await readFile(installedSetupSkill, 'utf-8')).includes(
          'description: "[OMX] Setup and configure oh-my-codex using current CLI behavior"',
        ),
      );
      assert.ok(
        (await readFile(shippedSetupSkill, 'utf-8')).includes(
          'description: Setup and configure oh-my-codex using current CLI behavior',
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
      assert.equal(installed.has('ecomode'), false); // removed in #3493
      assert.equal(installed.has('ultraqa'), true);
      assert.equal(installed.has('ralph-init'), false);
      assert.equal(installed.has('visual-ralph'), true);
      assert.equal(installed.has('web-clone'), false);
      assert.equal(installed.has('frontend-ui-ux'), false);
      assert.equal(installed.has('pipeline'), false, 'pipeline is a sunset stub; should not be installed');
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

  it('removes stale removed-skill installs during normal refresh', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const skillsDir = join(wd, '.codex', 'skills');
      const staleWebCloneDir = await seedRetiredOmxSkill(skillsDir, 'web-clone', 'old standalone pipeline');
      assert.equal(existsSync(staleWebCloneDir), true);

      await setup({ scope: 'project' });

      assert.equal(existsSync(staleWebCloneDir), false);
      assert.equal(existsSync(join(wd, '.codex', 'skills', 'visual-ralph', 'SKILL.md')), true);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('retires catalog-dropped OMX skills on a plain refresh while keeping user-authored skills', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      // Names removed from the catalog outright: no manifest entry and no shipped source directory.
      const skillsDir = join(wd, '.codex', 'skills');
      const retiredDirs = [] as Array<{ name: string; dir: string }>;
      for (const name of ['prometheus-strict', 'pipeline', 'scholastic']) {
        retiredDirs.push({ name, dir: await seedRetiredOmxSkill(skillsDir, name, `retired ${name}`) });
      }
      // Badged AND receipted, but the user edited the body: retirement must prove an UNMODIFIED
      // install, so this one survives even though it carries the badge.
      const editedRetiredDir = await seedRetiredOmxSkill(skillsDir, 'ecomode-retired', 'retired ecomode');
      const editedRetiredBody = '---\nname: ecomode-retired\ndescription: "[OMX] retired ecomode"\n---\n\nMy own notes.\n';
      await writeFile(join(editedRetiredDir, 'SKILL.md'), editedRetiredBody);
      // Badged but never receipted (an install predating receipts): conservatively retained.
      const unreceiptedDir = join(skillsDir, 'deepsearch');
      await mkdir(unreceiptedDir, { recursive: true });
      await writeFile(join(unreceiptedDir, 'SKILL.md'), '---\nname: deepsearch\ndescription: "[OMX] legacy install"\n---\n');
      const userSkillDir = join(wd, '.codex', 'skills', 'my-own-skill');
      await mkdir(userSkillDir, { recursive: true });
      await writeFile(join(userSkillDir, 'SKILL.md'), '---\nname: my-own-skill\ndescription: hand written\n---\n');
      const editedOmxSkillDir = join(wd, '.codex', 'skills', 'ecomode');
      await mkdir(editedOmxSkillDir, { recursive: true });
      await writeFile(join(editedOmxSkillDir, 'SKILL.md'), '---\nname: ecomode\ndescription: my edited copy\n---\n');

      // No --force: this is exactly what `omx update` runs after installing a new version.
      await setup({ scope: 'project' });

      for (const { name, dir } of retiredDirs) {
        assert.equal(existsSync(dir), false, `${name} must not survive an ordinary refresh`);
      }
      assert.equal(existsSync(userSkillDir), true, 'a user-authored skill is never OMX-owned');
      assert.equal(existsSync(editedOmxSkillDir), true, 'a badge-stripped copy is user-owned content');
      assert.equal(
        await readFile(join(editedRetiredDir, 'SKILL.md'), 'utf-8'),
        editedRetiredBody,
        'a badged retired skill the user edited must survive byte-identically, not be archived away',
      );
      assert.equal(existsSync(unreceiptedDir), true, 'a badged install with no receipt is retained conservatively');
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps a user file named __proto__ inside a receipted retired skill', async () => {
    // Generation-3 cleaner found that assigning digests into an object literal drops a `__proto__`
    // key from Object.keys(), so a directory containing such a user file compared equal to its receipt
    // and was deleted. The digest maps are prototype-less now; this pins it.
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);
      await setup({ scope: 'project' });

      const skillsDir = join(wd, '.codex', 'skills');
      const dir = await seedRetiredOmxSkill(skillsDir, 'prometheus-strict', 'retired');
      // The user drops a file whose name collides with Object.prototype AFTER the receipt was taken.
      await writeFile(join(dir, '__proto__'), 'user notes\n');

      await setup({ scope: 'project' });

      assert.equal(existsSync(dir), true, 'a directory holding an unreceipted user file must survive');
      assert.equal(await readFile(join(dir, '__proto__'), 'utf-8'), 'user notes\n');
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });


  it('preserves user files when the skills-directory receipt and badge are forged', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const skillsDir = join(wd, '.codex', 'skills');
      const dir = await seedRetiredOmxSkill(skillsDir, 'prometheus-strict', 'retired');
      const userFile = join(dir, 'user-notes.md');
      await writeFile(userFile, 'user-owned notes\n');
      // An attacker who can edit the skills directory can replace the visible badge and forge the
      // legacy receipt beside it. Cleanup must ignore both; the authoritative receipt lives under
      // .omx/state/setup, outside the skills directory.
      const forgedReceipt = {
        version: 1,
        skills: {
          'prometheus-strict': {
            files: {
              'SKILL.md': createHash('sha256').update(await readFile(join(dir, 'SKILL.md'))).digest('hex'),
              'user-notes.md': createHash('sha256').update(await readFile(userFile)).digest('hex'),
            },
          },
        },
      };
      await writeFile(join(skillsDir, '.omx-installed-skills.json'), `${JSON.stringify(forgedReceipt, null, 2)}\n`);

      await setup({ scope: 'project' });

      assert.equal(existsSync(dir), true, 'ordinary cleanup must preserve a directory with user files');
      assert.equal(await readFile(userFile, 'utf-8'), 'user-owned notes\n');
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('backs up a retired skill directory before deleting it', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const retiredDir = await seedRetiredOmxSkill(join(wd, '.codex', 'skills'), 'prometheus-strict', 'retired');

      await setup({ scope: 'project' });

      assert.equal(existsSync(retiredDir), false);
      const setupBackupRoot = join(wd, '.omx', 'backups', 'setup');
      const backupRoots = await readdir(setupBackupRoot).catch(() => [] as string[]);
      const preserved = backupRoots.some((backup) => existsSync(join(setupBackupRoot, backup, '.codex', 'skills', 'prometheus-strict', 'SKILL.md')));
      assert.equal(preserved, true, `retired skill bytes must be recoverable; backups seen: ${backupRoots.join(', ')}`);
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

      const staleSkills = ['configure-discord', 'configure-telegram', 'configure-slack', 'configure-openclaw'];
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

  it('keeps newly cataloged ultragoal skill fresh on --force', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const ultragoalPath = join(wd, '.codex', 'skills', 'ultragoal', 'SKILL.md');
      await writeFile(ultragoalPath, '# stale ultragoal\n');

      await setup({ scope: 'project', force: true });

      assert.match(await readFile(ultragoalPath, 'utf-8'), /^---\nname: ultragoal/m);
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

      await seedRetiredOmxSkill(join(wd, '.codex', 'skills'), 'swarm', 'stale swarm');

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
      await seedRetiredOmxSkill(join(wd, '.codex', 'skills'), 'swarm', 'stale swarm');
      await setup({ scope: 'project', force: true, verbose: true });

      const output = logs.join('\n');
      assert.match(output, /removed stale skill swarm\//);
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
      assert.match(output, /Migration hint: Detected 1 overlapping skill names between canonical .*\.codex\/skills and legacy .*\.agents\/skills\./);;
      assert.match(output, /Remove or archive ~\/\.agents\/skills after confirming .*\.codex\/skills is the version you want Codex to load\./);
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      if (typeof previousHome === 'string') process.env.HOME = previousHome; else delete process.env.HOME;
      if (typeof previousCodexHome === 'string') process.env.CODEX_HOME = previousCodexHome; else delete process.env.CODEX_HOME;
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('migrates legacy skill receipt on upgrade when new receipt path does not exist', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-upgrade-'));
    const previousCwd = process.cwd();
    const previousHome = process.env.HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      const home = join(wd, 'home');
      const codexHome = join(home, '.codex');
      process.env.HOME = home;
      process.env.CODEX_HOME = codexHome;
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      // Seed a retired skill with the legacy receipt location ($HOME/.omx/...)
      const legacySkillsDir = join(home, '.codex', 'skills');
      await mkdir(legacySkillsDir, { recursive: true });
      const retiredSkillDir = join(legacySkillsDir, 'retired-skill');
      await mkdir(retiredSkillDir, { recursive: true });
      await writeFile(join(retiredSkillDir, 'SKILL.md'), '---\nname: retired-skill\ndescription: "[OMX] old retired skill"\n---\n');

      // Record in the legacy receipt location
      const legacyReceiptPath = join(home, '.omx', 'state', 'setup', 'installed-skills.json');
      await mkdir(dirname(legacyReceiptPath), { recursive: true });
      const receipt: { version: 1; skills: Record<string, { files: Record<string, string> }> } = { version: 1, skills: {} };
      const files: Record<string, string> = {};
      for (const entry of await readdir(retiredSkillDir, { withFileTypes: true })) {
        if (entry.isFile()) {
          const full = join(retiredSkillDir, entry.name);
          files[entry.name] = createHash('sha256').update(await readFile(full)).digest('hex');
        }
      }
      receipt.skills['retired-skill'] = { files };
      await writeFile(legacyReceiptPath, JSON.stringify(receipt, null, 2) + '\n');

      // Verify the legacy receipt exists
      assert.equal(existsSync(legacyReceiptPath), true);

      // Verify the new receipt location does not exist yet
      const newReceiptPath = join(codexHome, '.omx', 'state', 'setup', 'installed-skills.json');
      assert.equal(existsSync(newReceiptPath), false);

      // Run setup in plugin mode to trigger cleanup
      await setup({ scope: 'user', installMode: 'plugin' });

      // The retired skill should have been cleaned up
      assert.equal(existsSync(retiredSkillDir), false, 'retired skill should be removed after cleanup');
    } finally {
      process.chdir(previousCwd);
      if (typeof previousHome === 'string') process.env.HOME = previousHome; else delete process.env.HOME;
      if (typeof previousCodexHome === 'string') process.env.CODEX_HOME = previousCodexHome; else delete process.env.CODEX_HOME;
      await rm(wd, { recursive: true, force: true });
    }
  });

});
