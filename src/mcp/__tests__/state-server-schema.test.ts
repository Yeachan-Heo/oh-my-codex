import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { TEAM_EVENT_TYPES } from '../../team/contracts.js';

describe('team_append_event schema validation', () => {
  it('schema enum is sourced from shared TEAM_EVENT_TYPES contract and contains expected values', async () => {
    const src = await readFile(join(process.cwd(), 'src/mcp/state-server.ts'), 'utf8');

    const enumRefMatch = src.match(/name:\s*'team_append_event'[\s\S]*?enum:\s*\[\.\.\.TEAM_EVENT_TYPES\]/);
    assert.ok(enumRefMatch, 'Expected team_append_event schema to reference TEAM_EVENT_TYPES');

    const enumValues = [...TEAM_EVENT_TYPES];

    assert.ok(
      enumValues.length > 0,
      `Expected at least one enum value, got ${enumValues.length}`
    );

    // Verify every value in the contract is a non-empty string
    for (const eventType of enumValues) {
      assert.equal(typeof eventType, 'string', `Expected string, got ${typeof eventType}`);
      assert.ok(eventType.length > 0, 'Expected non-empty event type string');
    }

    // Verify no duplicates
    const unique = new Set(enumValues);
    assert.equal(
      unique.size,
      enumValues.length,
      `Found duplicate event types: ${enumValues.join(', ')}`
    );
  });
});
