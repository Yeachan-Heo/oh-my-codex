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
  it('does not ship redundant alias-only skills as separate catalog entries', () => {
    const names = skillNames();
    assert(!names.includes('swarm'), 'swarm should be folded into team instead of shipped as an alias-only skill');
    assert.match(
      skillContent('review'),
      /Hard-deprecated/i,
      'review should remain only as a hard-deprecated compatibility shim',
    );
    assert.match(
      skillContent('ralph-init'),
      /Hard-deprecated/i,
      'ralph-init should remain only as a hard-deprecated compatibility shim',
    );
  });

  it('does not expose advisor wrappers as skills when package scripts already provide them', () => {
    const names = skillNames();
    assert(!names.includes('ask-claude'), 'ask-claude duplicates omx ask/package script behavior');
    assert(!names.includes('ask-gemini'), 'ask-gemini duplicates omx ask/package script behavior');
    assert(!names.includes('frontend-ui-ux'), 'frontend-ui-ux is a stale routing wrapper, not a workflow skill');
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
