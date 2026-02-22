import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { join } from 'path';

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
  it('schema enum contains exactly 8 event types including team_leader_nudge', async () => {
    const src = await readFile(join(process.cwd(), 'src/mcp/state-server.ts'), 'utf8');

    // Find the enum array for the team_append_event type field
    const match = src.match(/name:\s*'team_append_event'[\s\S]*?enum:\s*\[([^\]]+)\]/);
    assert.ok(match, 'Expected to find team_append_event enum in state-server.ts');

    const enumValues = match[1]
      .split(',')
      .map((s: string) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);

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
