import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isDerivedEventName, buildHookEvent, buildNativeHookEvent, buildDerivedHookEvent } from '../events.js';

describe('isDerivedEventName', () => {
  it('returns true for derived events', () => {
    assert.equal(isDerivedEventName('needs-input'), true);
    assert.equal(isDerivedEventName('pre-tool-use'), true);
    assert.equal(isDerivedEventName('post-tool-use'), true);
  });

  it('returns false for native events', () => {
    assert.equal(isDerivedEventName('session-start'), false);
    assert.equal(isDerivedEventName('session-end'), false);
    assert.equal(isDerivedEventName('turn-complete'), false);
  });

  it('returns false for unknown events', () => {
    assert.equal(isDerivedEventName('custom-event'), false);
    assert.equal(isDerivedEventName(''), false);
  });
});

describe('buildHookEvent', () => {
  it('creates envelope with required fields', () => {
    const envelope = buildHookEvent('session-start');
    assert.equal(envelope.schema_version, '1');
    assert.equal(envelope.event, 'session-start');
    assert.equal(envelope.source, 'native');
    assert.ok(envelope.timestamp);
    assert.deepEqual(envelope.context, {});
  });

  it('auto-detects derived source for derived events', () => {
    const envelope = buildHookEvent('needs-input');
    assert.equal(envelope.source, 'derived');
    assert.equal(typeof envelope.confidence, 'number');
  });

  it('uses explicit source when provided', () => {
    const envelope = buildHookEvent('needs-input', { source: 'native' });
    assert.equal(envelope.source, 'native');
  });

  it('includes optional fields when provided', () => {
    const envelope = buildHookEvent('session-start', {
      session_id: 's1',
      thread_id: 't1',
      turn_id: 'u1',
      mode: 'autopilot',
      context: { foo: 'bar' },
      timestamp: '2026-01-01T00:00:00Z',
    });
    assert.equal(envelope.session_id, 's1');
    assert.equal(envelope.thread_id, 't1');
    assert.equal(envelope.turn_id, 'u1');
    assert.equal(envelope.mode, 'autopilot');
    assert.deepEqual(envelope.context, { foo: 'bar' });
    assert.equal(envelope.timestamp, '2026-01-01T00:00:00Z');
  });

  it('clamps confidence to [0, 1] range', () => {
    const low = buildHookEvent('needs-input', { confidence: -5 });
    assert.equal(low.confidence, 0);

    const high = buildHookEvent('needs-input', { confidence: 99 });
    assert.equal(high.confidence, 1);

    const normal = buildHookEvent('needs-input', { confidence: 0.75 });
    assert.equal(normal.confidence, 0.75);
  });

  it('uses default confidence 0.5 for derived events without explicit confidence', () => {
    const envelope = buildHookEvent('pre-tool-use');
    assert.equal(envelope.confidence, 0.5);
  });

  it('ignores non-finite confidence values', () => {
    const envelope = buildHookEvent('needs-input', { confidence: NaN });
    assert.equal(envelope.confidence, 0.5);
  });

  it('includes parser_reason for derived events', () => {
    const envelope = buildHookEvent('needs-input', {
      parser_reason: 'stall detected',
    });
    assert.equal(envelope.parser_reason, 'stall detected');
  });

  it('treats non-object context as empty object', () => {
    const envelope = buildHookEvent('session-start', {
      context: null as unknown as Record<string, unknown>,
    });
    assert.deepEqual(envelope.context, {});
  });
});

describe('buildNativeHookEvent', () => {
  it('always sets source to native', () => {
    const envelope = buildNativeHookEvent('needs-input', { key: 'val' });
    assert.equal(envelope.source, 'native');
    assert.deepEqual(envelope.context, { key: 'val' });
  });

  it('does not include confidence for native events', () => {
    const envelope = buildNativeHookEvent('session-start');
    assert.equal(envelope.confidence, undefined);
  });

  it('passes through optional fields', () => {
    const envelope = buildNativeHookEvent('session-start', {}, {
      session_id: 'abc',
    });
    assert.equal(envelope.session_id, 'abc');
  });
});

describe('buildDerivedHookEvent', () => {
  it('always sets source to derived', () => {
    const envelope = buildDerivedHookEvent('session-start', { x: 1 });
    assert.equal(envelope.source, 'derived');
    assert.deepEqual(envelope.context, { x: 1 });
  });

  it('includes default confidence of 0.5', () => {
    const envelope = buildDerivedHookEvent('custom-event');
    assert.equal(envelope.confidence, 0.5);
  });

  it('allows custom confidence', () => {
    const envelope = buildDerivedHookEvent('custom-event', {}, {
      confidence: 0.9,
    });
    assert.equal(envelope.confidence, 0.9);
  });
});
