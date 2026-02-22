import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { loadNotificationConfig, notify, _buildDesktopArgs } from '../notifier.js';
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

describe('_buildDesktopArgs - command injection prevention', () => {
  const injectionTitle = 'Title"; rm -rf / #';
  const injectionMessage = 'Msg$(evil)&bad`cmd`';

  it('linux: passes title and message as separate array elements, not in a shell string', () => {
    const result = _buildDesktopArgs(injectionTitle, injectionMessage, 'linux');
    assert.ok(result);
    const [cmd, args] = result;
    assert.equal(cmd, 'notify-send');
    // Args must be the raw strings at distinct positions — no shell concatenation
    assert.equal(args[0], injectionTitle);
    assert.equal(args[1], injectionMessage);
    assert.equal(args.length, 2);
  });

  it('darwin: double-quotes in title/message are escaped for AppleScript context', () => {
    const result = _buildDesktopArgs('Say "hi"', 'Do "this"', 'darwin');
    assert.ok(result);
    const [cmd, args] = result;
    assert.equal(cmd, 'osascript');
    // The -e script must have escaped quotes, not raw ones that would break AppleScript
    assert.ok(args[1].includes('\\"hi\\"'), 'double-quote in title should be escaped');
    assert.ok(args[1].includes('\\"this\\"'), 'double-quote in message should be escaped');
  });

  it('darwin: shell metacharacters in title/message remain in the -e argument, not the command', () => {
    const result = _buildDesktopArgs(injectionTitle, injectionMessage, 'darwin');
    assert.ok(result);
    const [cmd, args] = result;
    assert.equal(cmd, 'osascript');
    assert.equal(args[0], '-e');
    // The injection payload must be inside the single -e string argument
    assert.ok(args[1].includes('rm -rf'), 'injection payload present as data inside the arg');
    // There must be no additional args (no shell splitting occurred)
    assert.equal(args.length, 2);
  });

  it('win32: single-quotes in title/message are doubled for PowerShell single-quoted context', () => {
    const result = _buildDesktopArgs("O'Brien", "It's done", 'win32');
    assert.ok(result);
    const [cmd, args] = result;
    assert.equal(cmd, 'powershell');
    assert.equal(args[0], '-Command');
    assert.ok(args[1].includes("O''Brien"), "single-quote in title should be escaped as ''");
    assert.ok(args[1].includes("It''s done"), "single-quote in message should be escaped as ''");
  });

  it('returns null for unsupported platforms', () => {
    const result = _buildDesktopArgs('title', 'message', 'freebsd');
    assert.equal(result, null);
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
