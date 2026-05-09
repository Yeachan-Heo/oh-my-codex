import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = new URL('../../..', import.meta.url).pathname;
const skillsRoot = join(repoRoot, 'skills');

function skillContent(name: string): string {
  return readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf8');
}

function skillNames(): string[] {
  return readdirSync(skillsRoot)
    .filter((name) => statSync(join(skillsRoot, name)).isDirectory())
    .sort();
}

describe('skill catalog hygiene', () => {
  it('keeps deprecated public compatibility shims non-routing', () => {
    const names = skillNames();
    const shims = [
      { name: 'swarm', canonical: /\$team|omx team/i },
      { name: 'ask-claude', canonical: /\$ask claude|omx ask claude/i },
      { name: 'ask-gemini', canonical: /\$ask gemini|omx ask gemini/i },
      { name: 'frontend-ui-ux', canonical: /designer/i },
      { name: 'review', canonical: /\$code-review|code review/i },
      { name: 'ralph-init', canonical: /\$ralph|PRD\/test-spec/i },
    ];

    for (const { name, canonical } of shims) {
      assert(names.includes(name), `${name} should remain as a public compatibility shim`);
      const content = skillContent(name);
      assert.match(
        content,
        /Hard-deprecated/i,
        `${name} should remain only as a hard-deprecated compatibility shim`,
      );
      assert.match(
        content,
        /Do not invoke or route this skill/i,
        `${name} should be non-routing compatibility guidance`,
      );
      assert.match(
        content,
        canonical,
        `${name} should point to its canonical replacement surface`,
      );
    }
  });

  it('keeps the cleanup subset free of obsolete prompt/tool boilerplate', () => {
    const cleanupSubset = ['analyze', 'deep-interview', 'ecomode', 'git-master', 'plan', 'tdd', 'ultraqa', 'ultrawork', 'web-clone'];
    const obsolete = [
      /ToolSearch\(/,
      /mcp__[^\s`]+/,
      /GPT-5\.4 Guidance Alignment/,
      /Task:\s*\{\{ARGUMENTS\}\}/,
      /delegate\(role=/,
    ];

    const offenders = cleanupSubset.flatMap((name) => {
      const content = skillContent(name);
      return obsolete
        .filter((pattern) => pattern.test(content))
        .map((pattern) => `${name}: ${pattern}`);
    });

    assert.deepEqual(offenders, []);
  });
});
