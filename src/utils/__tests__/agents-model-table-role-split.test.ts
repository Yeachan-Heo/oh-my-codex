import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAgentsModelTable } from '../agents-model-table.js';

describe('agents model table role split', () => {
  it('renders frontier, mini, and spark recommendations from the explicit role split', () => {
    const table = buildAgentsModelTable({
      frontierModel: 'gpt-5.4',
      miniModel: 'gpt-5-mini',
      sparkModel: 'gpt-5.3-codex-spark',
      subagentDefaultModel: 'gpt-5.4',
    } as Parameters<typeof buildAgentsModelTable>[0]);

    assert.match(table, /\| Mini \(mid-weight execution\) \| `gpt-5-mini` \| medium \|/);
    assert.match(table, /\| `architect` \| `gpt-5\.4` \| high \|/);
    assert.match(table, /\| `writer` \| `gpt-5-mini` \| low \|/);
    assert.match(table, /\| `executor` \| `gpt-5-mini` \| medium \|/);
    assert.match(table, /\| `explore` \| `gpt-5\.3-codex-spark` \| low \|/);
  });
});
