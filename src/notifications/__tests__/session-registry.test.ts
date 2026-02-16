import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import type { SessionMapping } from '../session-registry.js';

// The session-registry module uses hardcoded paths under ~/.omx/state/.
// We test the data shapes and logic patterns rather than filesystem integration
// to avoid polluting the real state directory.

function createMockMapping(overrides?: Partial<SessionMapping>): SessionMapping {
  return {
    platform: 'discord-bot',
    messageId: randomUUID(),
    sessionId: randomUUID(),
    tmuxPaneId: '%0',
    tmuxSessionName: 'test-session',
    event: 'session-idle',
    createdAt: new Date().toISOString(),
    projectPath: '/tmp/test',
    ...overrides,
  };
}

describe('SessionMapping shape', () => {
  it('creates valid mapping with all required fields', () => {
    const mapping = createMockMapping();
    assert.ok(mapping.platform);
    assert.ok(mapping.messageId);
    assert.ok(mapping.sessionId);
    assert.ok(mapping.tmuxPaneId);
    assert.ok(mapping.tmuxSessionName !== undefined);
    assert.ok(mapping.event);
    assert.ok(mapping.createdAt);
  });

  it('supports discord-bot platform', () => {
    const mapping = createMockMapping({ platform: 'discord-bot' });
    assert.equal(mapping.platform, 'discord-bot');
  });

  it('supports telegram platform', () => {
    const mapping = createMockMapping({ platform: 'telegram' });
    assert.equal(mapping.platform, 'telegram');
  });

  it('serializes to valid JSON', () => {
    const mapping = createMockMapping();
    const json = JSON.stringify(mapping);
    const parsed = JSON.parse(json) as SessionMapping;
    assert.equal(parsed.platform, mapping.platform);
    assert.equal(parsed.messageId, mapping.messageId);
    assert.equal(parsed.sessionId, mapping.sessionId);
  });

  it('supports optional projectPath', () => {
    const withPath = createMockMapping({ projectPath: '/test/path' });
    assert.equal(withPath.projectPath, '/test/path');

    const withoutPath = createMockMapping();
    delete (withoutPath as any).projectPath;
    const json = JSON.stringify(withoutPath);
    const parsed = JSON.parse(json);
    assert.equal(parsed.projectPath, undefined);
  });
});

describe('JSONL format', () => {
  it('produces valid JSONL lines from mappings', () => {
    const mappings = [
      createMockMapping({ messageId: 'msg-1' }),
      createMockMapping({ messageId: 'msg-2' }),
      createMockMapping({ messageId: 'msg-3' }),
    ];

    const jsonl = mappings.map(m => JSON.stringify(m)).join('\n') + '\n';
    const lines = jsonl.split('\n').filter(line => line.trim());
    assert.equal(lines.length, 3);

    for (const line of lines) {
      const parsed = JSON.parse(line) as SessionMapping;
      assert.ok(parsed.messageId);
      assert.ok(parsed.platform);
    }
  });

  it('can lookup mapping by messageId from parsed JSONL', () => {
    const target = createMockMapping({ messageId: 'target-msg', platform: 'telegram' });
    const mappings = [
      createMockMapping({ messageId: 'other-1' }),
      target,
      createMockMapping({ messageId: 'other-2' }),
    ];

    const found = mappings.find(m => m.platform === 'telegram' && m.messageId === 'target-msg');
    assert.ok(found);
    assert.equal(found.messageId, 'target-msg');
    assert.equal(found.platform, 'telegram');
  });

  it('can filter mappings by sessionId', () => {
    const sessionId = 'session-to-remove';
    const mappings = [
      createMockMapping({ sessionId }),
      createMockMapping({ sessionId: 'other-session' }),
      createMockMapping({ sessionId }),
    ];

    const filtered = mappings.filter(m => m.sessionId !== sessionId);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].sessionId, 'other-session');
  });

  it('can filter mappings by paneId', () => {
    const mappings = [
      createMockMapping({ tmuxPaneId: '%0' }),
      createMockMapping({ tmuxPaneId: '%1' }),
      createMockMapping({ tmuxPaneId: '%0' }),
    ];

    const filtered = mappings.filter(m => m.tmuxPaneId !== '%0');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].tmuxPaneId, '%1');
  });

  it('can prune stale entries by age', () => {
    const now = Date.now();
    const maxAgeMs = 24 * 60 * 60 * 1000;

    const mappings = [
      createMockMapping({ createdAt: new Date(now - maxAgeMs - 1000).toISOString() }), // stale
      createMockMapping({ createdAt: new Date(now - 1000).toISOString() }), // fresh
      createMockMapping({ createdAt: new Date(now - maxAgeMs + 60000).toISOString() }), // just within
    ];

    const filtered = mappings.filter(m => {
      const age = now - new Date(m.createdAt).getTime();
      return age < maxAgeMs;
    });

    assert.equal(filtered.length, 2);
  });
});

describe('session-registry module exports', () => {
  it('exports registerMessage function', async () => {
    const mod = await import('../session-registry.js');
    assert.equal(typeof mod.registerMessage, 'function');
  });

  it('exports loadAllMappings function', async () => {
    const mod = await import('../session-registry.js');
    assert.equal(typeof mod.loadAllMappings, 'function');
  });

  it('exports lookupByMessageId function', async () => {
    const mod = await import('../session-registry.js');
    assert.equal(typeof mod.lookupByMessageId, 'function');
  });

  it('exports removeSession function', async () => {
    const mod = await import('../session-registry.js');
    assert.equal(typeof mod.removeSession, 'function');
  });

  it('exports removeMessagesByPane function', async () => {
    const mod = await import('../session-registry.js');
    assert.equal(typeof mod.removeMessagesByPane, 'function');
  });

  it('exports pruneStale function', async () => {
    const mod = await import('../session-registry.js');
    assert.equal(typeof mod.pruneStale, 'function');
  });
});
