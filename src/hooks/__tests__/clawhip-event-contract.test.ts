import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const contractDoc = readFileSync(join(process.cwd(), 'docs', 'clawhip-event-contract.md'), 'utf-8');

describe('clawhip event contract doc', () => {
  it('documents normalized_event routing and core operational events', () => {
    assert.match(contractDoc, /normalized_event/);
    for (const eventName of [
      'started',
      'blocked',
      'run.heartbeat',
      'run.blocked_on_user',
      'run.blocked_on_system',
      'finished',
      'failed',
      'worker.assigned',
      'worker.stalled',
      'worker.recovered',
      'retry-needed',
      'pr-created',
      'test-started',
      'test-finished',
      'test-failed',
      'handoff-needed',
    ]) {
      assert.match(contractDoc, new RegExp(eventName.replace('-', '\\-')));
    }
  });

  it('documents lifecycle ownership and reduced assistant-signal noise', () => {
    assert.match(contractDoc, /native session lifecycle events are the canonical source/i);
    assert.match(contractDoc, /team\/runtime operational events add canonical worker-state signals/i);
    assert.match(contractDoc, /session_name.*stable across native and derived events/i);
    assert.match(contractDoc, /do not duplicate session completion\/failure lifecycle events/i);
  });
});
