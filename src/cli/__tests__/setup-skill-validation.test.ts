import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installSkills, parseSkillFrontmatter } from '../setup.js';

describe('skill frontmatter validation', () => {
  it('accepts valid SKILL.md frontmatter with quoted values and nested metadata', () => {
    const content = `---\nname: ask\ndescription: "Guide on using oh-my-codex plugin"\nmetadata:\n  short-description: Quick help\n---\n\n# Help\n`;

    assert.deepEqual(parseSkillFrontmatter(content), {
      name: 'ask',
      description: 'Guide on using oh-my-codex plugin',
    });
  });

  it('rejects SKILL.md frontmatter without a description', () => {
    const content = `---\nname: ask\n---\n\n# Help\n`;

    assert.throws(
      () => parseSkillFrontmatter(content, '/tmp/ask/SKILL.md'),
      /missing a non-empty frontmatter "description"/i,
    );
  });

  it('rejects SKILL.md frontmatter with unterminated quoted strings', () => {
    const content = `---\nname: ask\ndescription: "broken\n---\n\n# Help\n`;

    assert.throws(
      () => parseSkillFrontmatter(content, '/tmp/ask/SKILL.md'),
      /unterminated quoted string/i,
    );
  });
});

describe('omx setup skill validation', () => {
  it('fails before installing a malformed shipped-style SKILL.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-setup-skill-validation-'));
    const srcDir = join(root, 'src-skills');
    const dstDir = join(root, 'dst-skills');
    const skillDir = join(srcDir, 'ask');

    try {
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ask\ndescription: "broken\n---\n\n# Help\n`);
      await writeFile(join(skillDir, 'notes.md'), 'extra file\n');

      await assert.rejects(
        () => installSkills(
          srcDir,
          dstDir,
          { backupRoot: join(root, 'backups'), baseRoot: root },
          { force: false, dryRun: false, verbose: false },
        ),
        /src-skills\/ask\/SKILL\.md.*unterminated quoted string/i,
      );

      assert.equal(existsSync(join(dstDir, 'ask', 'SKILL.md')), false);
      assert.equal(existsSync(join(dstDir, 'ask', 'notes.md')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
