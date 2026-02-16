import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { loadNotificationConfig, notify } from '../notifier.js';
import type { NotificationConfig, NotificationPayload } from '../notifier.js';

describe('loadNotificationConfig', () => {
  it('returns null when config file does not exist', async () => {
    const fakePath = join(tmpdir(), `omx-test-${randomUUID()}`);
    const config = await loadNotificationConfig(fakePath);
    assert.equal(config, null);
  });

  it('returns parsed config when file exists', async () => {
    const tmpDir = join(tmpdir(), `omx-test-${randomUUID()}`);
    const omxDir = join(tmpDir, '.omx');
    mkdirSync(omxDir, { recursive: true });

    const configData: NotificationConfig = {
      desktop: true,
      discord: { webhookUrl: 'https://discord.com/api/webhooks/test' },
      telegram: { botToken: '123:abc', chatId: '456' },
    };
    writeFileSync(join(omxDir, 'notifications.json'), JSON.stringify(configData));

    try {
      const config = await loadNotificationConfig(tmpDir);
      assert.ok(config);
      assert.equal(config.desktop, true);
      assert.equal(config.discord?.webhookUrl, 'https://discord.com/api/webhooks/test');
      assert.equal(config.telegram?.botToken, '123:abc');
      assert.equal(config.telegram?.chatId, '456');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns null for invalid JSON', async () => {
    const tmpDir = join(tmpdir(), `omx-test-${randomUUID()}`);
    const omxDir = join(tmpDir, '.omx');
    mkdirSync(omxDir, { recursive: true });
    writeFileSync(join(omxDir, 'notifications.json'), 'not-json');

    try {
      const config = await loadNotificationConfig(tmpDir);
      assert.equal(config, null);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('notify', () => {
  const basePayload: NotificationPayload = {
    title: 'Test',
    message: 'Test message',
    type: 'info',
    mode: 'test',
  };

  it('does nothing when config is null', async () => {
    // Should not throw
    await notify(basePayload, null);
  });

  it('does nothing when all channels are disabled', async () => {
    const config: NotificationConfig = {};
    // Should not throw
    await notify(basePayload, config);
  });

  it('accepts all notification types', async () => {
    const types = ['info', 'success', 'warning', 'error'] as const;
    for (const type of types) {
      // Should not throw
      await notify({ ...basePayload, type }, {});
    }
  });
});

describe('NotificationPayload type', () => {
  it('requires title, message, and type', () => {
    const payload: NotificationPayload = {
      title: 'Test Title',
      message: 'Test message body',
      type: 'success',
    };
    assert.equal(payload.title, 'Test Title');
    assert.equal(payload.message, 'Test message body');
    assert.equal(payload.type, 'success');
  });

  it('supports optional mode', () => {
    const payload: NotificationPayload = {
      title: 'Test',
      message: 'msg',
      type: 'info',
      mode: 'ralph',
    };
    assert.equal(payload.mode, 'ralph');
  });

  it('supports optional projectPath', () => {
    const payload: NotificationPayload = {
      title: 'Test',
      message: 'msg',
      type: 'warning',
      projectPath: '/home/user/project',
    };
    assert.equal(payload.projectPath, '/home/user/project');
  });
});
