import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import { loadSurface } from './prompt-guidance-test-helpers.js';

const PROMPTS_DIR = join(process.cwd(), 'prompts');
const promptFiles = readdirSync(PROMPTS_DIR).filter((name) => name.endsWith('.md'));

const FORBIDDEN_PROMPT_PATTERNS: Array<[label: string, pattern: RegExp]> = [
  ['direct handoff heading', /Hand off to:|##\s+Hand Off To\b/i],
  ['child request-agent phrasing', /Request\s+\*\*[^*]+\*\*\s+agent/i],
  ['child spawn-agent phrasing', /Spawn\s+the\s+`explore`\s+agent|spawn\s+explore\s+agent/i],
  ['direct delegate-to-agent phrasing', /delegate to specialized agents|delegate to\s+[a-z-]+\s+agent/i],
  ['soft explore-agent routing', /use explore agent|via explore agent/i],
  ['soft next-agent chain phrasing', /next agent in the chain|next agent \(researcher|next agent \(analyst|next agent \(.*planner/i],
  ['soft delegated-checklist phrasing', /delegated to test-engineer/i],
  ['legacy explore-high escalation', /explore-high/i],
  ['external AI routing', /Use an external AI assistant|Use an external long-context AI assistant/i],
];

describe('prompt orchestration boundary', () => {
  for (const file of promptFiles) {
    it(`${file} avoids recursive orchestration language`, () => {
      const content = readFileSync(join(PROMPTS_DIR, file), 'utf-8');
      for (const [label, pattern] of FORBIDDEN_PROMPT_PATTERNS) {
        assert.doesNotMatch(content, pattern, `${file} should not include ${label}`);
      }
    });
  }

  it('root AGENTS contract states that child prompts report handoffs upward', () => {
    assert.match(loadSurface('AGENTS.md'), /report recommended handoffs upward/i);
    assert.match(loadSurface('templates/AGENTS.md'), /report recommended handoffs upward/i);
  });

  it('guidance schema documents upward-only handoff limits for role prompts', () => {
    assert.match(loadSurface('docs/guidance-schema.md'), /report upward, do not recursively orchestrate/i);
    assert.match(loadSurface('docs/guidance-schema.md'), /recommend handoffs upward to the orchestrator/i);
  });
});
