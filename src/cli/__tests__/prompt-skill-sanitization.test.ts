import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe('prompt/skill sanitization', () => {
  it('removes stale model aliases and spawn_sub_agent syntax from active prompts and skills', () => {
    const targets = [
      ...walkFiles(join(repoRoot, 'skills')).filter((file) => file.endsWith('SKILL.md')),
      ...walkFiles(join(repoRoot, 'prompts')).filter((file) => file.endsWith('.md')),
    ];

    const bannedPatterns: Array<{ pattern: RegExp; label: string }> = [
      { pattern: /spawn_sub_agent/, label: 'spawn_sub_agent syntax' },
      { pattern: /model="(?:haiku|sonnet|opus)"/i, label: 'legacy model literal' },
      { pattern: /\b(?:haiku|sonnet|opus) tier\b/i, label: 'legacy tier alias' },
      { pattern: /architect-medium/i, label: 'legacy architect-medium alias' },
      { pattern: /executor-low/i, label: 'legacy executor-low alias' },
      { pattern: /executor-high/i, label: 'legacy executor-high alias' },
      { pattern: /description:\s*".*\((?:Haiku|Sonnet|Opus)\).*"/i, label: 'legacy prompt description tier' },
      { pattern: /^model:\s*opus$/im, label: 'legacy model frontmatter value' },
    ];

    const violations: string[] = [];
    for (const file of targets) {
      const text = readFileSync(file, 'utf8');
      for (const { pattern, label } of bannedPatterns) {
        if (pattern.test(text)) {
          violations.push(`${file}: ${label}`);
        }
      }
    }

    assert.deepEqual(violations, []);
  });
});
