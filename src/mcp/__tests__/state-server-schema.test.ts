import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { TEAM_EVENT_TYPES } from '../../team/contracts.js';

const ALL_EVENT_TYPES = [
  'task_completed',
  'task_failed',
  'worker_idle',
  'worker_stopped',
  'message_received',
  'shutdown_ack',
  'approval_decision',
  'team_leader_nudge',
] as const;

describe('team_append_event schema validation', () => {
  it('schema enum is sourced from shared TEAM_EVENT_TYPES contract and contains expected values', async () => {
    const src = await readFile(join(process.cwd(), 'src/mcp/state-server.ts'), 'utf8');

    const enumRefMatch = src.match(/name:\s*'team_append_event'[\s\S]*?enum:\s*\[\.\.\.TEAM_EVENT_TYPES\]/);
    assert.ok(enumRefMatch, 'Expected team_append_event schema to reference TEAM_EVENT_TYPES');

    const enumValues = [...TEAM_EVENT_TYPES];

    assert.equal(
      enumValues.length,
      8,
      `Expected 8 enum values, got ${enumValues.length}: ${enumValues.join(', ')}`
    );

    for (const eventType of ALL_EVENT_TYPES) {
      assert.ok(
        enumValues.includes(eventType),
        `Expected enum to include '${eventType}', got: ${enumValues.join(', ')}`
      );
    }
  });
});
