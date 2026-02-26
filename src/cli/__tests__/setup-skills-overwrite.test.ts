import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup } from '../setup.js';

describe('omx setup skills overwrite behavior', () => {
  it('preserves existing skill files unless --force is set', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-skills-'));
    const previousCwd = process.cwd();
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      process.chdir(wd);

      await setup({ scope: 'project' });

      const skillPath = join(wd, '.agents', 'skills', 'help', 'SKILL.md');
      assert.equal(existsSync(skillPath), true);

      const installed = await readFile(skillPath, 'utf-8');
      const customized = `${installed}\n\n# local customization\n`;
      await writeFile(skillPath, customized);

      await setup({ scope: 'project' });
      assert.equal(await readFile(skillPath, 'utf-8'), customized);

      await setup({ scope: 'project', force: true });
      assert.equal(await readFile(skillPath, 'utf-8'), installed);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });
});
