/**
 * Tests for the template interpolation engine.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeTemplateVariables,
  interpolateTemplate,
  validateTemplate,
  getDefaultTemplate,
} from '../template-engine.js';
import type { FullNotificationPayload } from '../types.js';

function makePayload(overrides: Partial<FullNotificationPayload> = {}): FullNotificationPayload {
  return {
    event: 'session-end',
    sessionId: 'sess-abc',
    message: '',
    timestamp: '2026-01-01T12:00:00.000Z',
    projectPath: '/home/user/my-project',
    projectName: 'my-project',
    ...overrides,
  };
}

describe('computeTemplateVariables', () => {
  it('maps raw payload fields to string values', () => {
    const vars = computeTemplateVariables(makePayload({ sessionId: 'test-123', reason: 'done' }));
    assert.equal(vars.sessionId, 'test-123');
    assert.equal(vars.reason, 'done');
  });

  it('converts undefined fields to empty string', () => {
    const vars = computeTemplateVariables(makePayload({ reason: undefined }));
    assert.equal(vars.reason, '');
  });

  it('computes projectDisplay from projectName', () => {
    const vars = computeTemplateVariables(makePayload({ projectName: 'my-project' }));
    assert.equal(vars.projectDisplay, 'my-project');
  });

  it('computes projectDisplay from projectPath when projectName absent', () => {
    const vars = computeTemplateVariables(makePayload({ projectName: undefined, projectPath: '/home/user/my-project' }));
    assert.equal(vars.projectDisplay, 'my-project');
  });

  it('computes duration from durationMs', () => {
    const vars = computeTemplateVariables(makePayload({ durationMs: 125000 }));
    assert.equal(vars.duration, '2m 5s');
  });

  it('computes iterationDisplay when both present', () => {
    const vars = computeTemplateVariables(makePayload({ iteration: 3, maxIterations: 10 }));
    assert.equal(vars.iterationDisplay, '3/10');
  });

  it('iterationDisplay is empty when iteration missing', () => {
    const vars = computeTemplateVariables(makePayload({ iteration: undefined, maxIterations: 10 }));
    assert.equal(vars.iterationDisplay, '');
  });

  it('converts incompleteTasks=0 to "0" (not empty)', () => {
    const vars = computeTemplateVariables(makePayload({ incompleteTasks: 0 }));
    assert.equal(vars.incompleteTasks, '0');
  });

  it('converts incompleteTasks=undefined to empty string', () => {
    const vars = computeTemplateVariables(makePayload({ incompleteTasks: undefined }));
    assert.equal(vars.incompleteTasks, '');
  });

  it('footer includes tmux and project when tmuxSession present', () => {
    const vars = computeTemplateVariables(makePayload({ tmuxSession: 'main', projectName: 'proj' }));
    assert.ok(vars.footer.includes('main'));
    assert.ok(vars.footer.includes('proj'));
  });

  it('footer omits tmux part when tmuxSession absent', () => {
    const vars = computeTemplateVariables(makePayload({ tmuxSession: undefined }));
    assert.ok(!vars.footer.includes('tmux'));
    assert.ok(vars.footer.includes('project'));
  });

  it('tmuxTailBlock is empty when tmuxTail absent', () => {
    const vars = computeTemplateVariables(makePayload({ tmuxTail: undefined }));
    assert.equal(vars.tmuxTailBlock, '');
  });
});

describe('validateTemplate - reply context variables', () => {
  it('accepts replyChannel, replyTarget, replyThread as known variables', () => {
    const { valid, unknownVars } = validateTemplate('{{replyChannel}} {{replyTarget}} {{replyThread}}');
    assert.equal(valid, true);
    assert.deepEqual(unknownVars, []);
  });

  it('accepts reply variables in conditionals', () => {
    const { valid } = validateTemplate('{{#if replyChannel}}channel: {{replyChannel}}{{/if}}');
    assert.equal(valid, true);
  });
});

describe('interpolateTemplate', () => {
  it('replaces {{variable}} placeholders', () => {
    const result = interpolateTemplate('Session: {{sessionId}}', makePayload({ sessionId: 'abc' }));
    assert.equal(result, 'Session: abc');
  });

  it('replaces unknown variables with empty string', () => {
    const result = interpolateTemplate('{{unknownVar}} text', makePayload());
    assert.equal(result, ' text');
  });

  it('includes {{#if}} block content when var is truthy', () => {
    const result = interpolateTemplate(
      'before{{#if reason}}\nreason: {{reason}}{{/if}}\nafter',
      makePayload({ reason: 'done' }),
    );
    assert.ok(result.includes('reason: done'));
  });

  it('removes {{#if}} block when var is falsy', () => {
    const result = interpolateTemplate(
      'before{{#if reason}}\nreason: {{reason}}{{/if}}\nafter',
      makePayload({ reason: undefined }),
    );
    assert.ok(!result.includes('reason'));
    assert.ok(result.includes('before'));
    assert.ok(result.includes('after'));
  });

  it('trims trailing whitespace', () => {
    const result = interpolateTemplate('hello   ', makePayload());
    assert.equal(result, 'hello');
  });
});

describe('validateTemplate', () => {
  it('returns valid=true for templates with known variables only', () => {
    const { valid, unknownVars } = validateTemplate('{{sessionId}} {{projectDisplay}}');
    assert.equal(valid, true);
    assert.deepEqual(unknownVars, []);
  });

  it('returns valid=false and lists unknown variables', () => {
    const { valid, unknownVars } = validateTemplate('{{fooBar}} {{sessionId}}');
    assert.equal(valid, false);
    assert.ok(unknownVars.includes('fooBar'));
    assert.ok(!unknownVars.includes('sessionId'));
  });

  it('validates {{#if var}} conditionals', () => {
    const { valid, unknownVars } = validateTemplate('{{#if unknownVar}}content{{/if}}');
    assert.equal(valid, false);
    assert.ok(unknownVars.includes('unknownVar'));
  });

  it('allows known variables in conditionals', () => {
    const { valid } = validateTemplate('{{#if reason}}{{reason}}{{/if}}');
    assert.equal(valid, true);
  });
});

describe('getDefaultTemplate', () => {
  const EVENTS = ['session-start', 'session-stop', 'session-end', 'session-idle', 'ask-user-question'] as const;

  for (const event of EVENTS) {
    it(`returns non-empty template for ${event}`, () => {
      const tmpl = getDefaultTemplate(event);
      assert.ok(typeof tmpl === 'string' && tmpl.length > 0);
    });
  }

  it('returns fallback for unknown event', () => {
    const tmpl = getDefaultTemplate('unknown-event' as never);
    assert.ok(tmpl.includes('{{event}}'));
  });

  it('session-idle template uses "Codex" not "Claude"', () => {
    const tmpl = getDefaultTemplate('session-idle');
    assert.ok(tmpl.includes('Codex'));
    assert.ok(!tmpl.includes('Claude'));
  });

  it('ask-user-question template uses "Codex" not "Claude"', () => {
    const tmpl = getDefaultTemplate('ask-user-question');
    assert.ok(tmpl.includes('Codex'));
    assert.ok(!tmpl.includes('Claude'));
  });

  it('interpolating session-end template produces expected output', () => {
    const payload = makePayload({ event: 'session-end', durationMs: 60000, reason: 'completed' });
    const result = interpolateTemplate(getDefaultTemplate('session-end'), payload);
    assert.ok(result.includes('Session Ended'));
    assert.ok(result.includes('1m 0s'));
    assert.ok(result.includes('completed'));
  });
});
