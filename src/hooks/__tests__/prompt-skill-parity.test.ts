/**
 * Parity test: ensures prompts/*.md and skills/<name>/SKILL.md stay aligned.
 *
 * During the transition from custom prompts to skills, both surfaces coexist.
 * This test guarantees the body content (everything after YAML frontmatter)
 * is identical between the prompt file and its corresponding skill file.
 *
 * Once the runtime migration (PR 2) is complete and prompts/ is retired,
 * this test can be removed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const PROMPTS_DIR = join(REPO_ROOT, 'prompts');
const SKILLS_DIR = join(REPO_ROOT, 'skills');

/** Strip YAML frontmatter (between --- markers) and return trimmed body. */
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (match) return content.slice(match[0].length).trim();
  return content.trim();
}

/** Extract description from YAML frontmatter. */
function extractDescription(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const descMatch = match[1].match(/description:\s*"([^"]+)"/);
  return descMatch ? descMatch[1] : null;
}

const promptFiles = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith('.md'));

// git-master is intentionally different: the skill has custom routing content
const SKIP_PARITY = new Set(['git-master']);

describe('prompt ↔ skill parity', () => {
  for (const file of promptFiles) {
    const name = file.slice(0, -3); // strip .md
    if (SKIP_PARITY.has(name)) continue;

    it(`${name}: skill body matches prompt body`, () => {
      const skillPath = join(SKILLS_DIR, name, 'SKILL.md');
      assert.ok(existsSync(skillPath), `missing skills/${name}/SKILL.md`);

      const promptContent = readFileSync(join(PROMPTS_DIR, file), 'utf-8');
      const skillContent = readFileSync(skillPath, 'utf-8');

      const promptBody = stripFrontmatter(promptContent);
      const skillBody = stripFrontmatter(skillContent);

      assert.equal(skillBody, promptBody, `body mismatch for ${name}`);
    });

    it(`${name}: skill description matches prompt description`, () => {
      const skillPath = join(SKILLS_DIR, name, 'SKILL.md');
      if (!existsSync(skillPath)) return; // covered by body test above

      const promptContent = readFileSync(join(PROMPTS_DIR, file), 'utf-8');
      const skillContent = readFileSync(skillPath, 'utf-8');

      const promptDesc = extractDescription(promptContent);
      const skillDesc = extractDescription(skillContent);

      // team-orchestrator has no frontmatter in the prompt
      if (promptDesc === null) return;

      assert.equal(skillDesc, promptDesc, `description mismatch for ${name}`);
    });
  }

  it('every prompt has a corresponding skill directory', () => {
    const missing: string[] = [];
    for (const file of promptFiles) {
      const name = file.slice(0, -3);
      if (SKIP_PARITY.has(name)) continue;
      if (!existsSync(join(SKILLS_DIR, name, 'SKILL.md'))) {
        missing.push(name);
      }
    }
    assert.deepEqual(missing, [], `missing skill directories: ${missing.join(', ')}`);
  });
});
