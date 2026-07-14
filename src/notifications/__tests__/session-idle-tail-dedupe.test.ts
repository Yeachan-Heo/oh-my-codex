import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const NOTIFICATION_RECEIPT_CHILD = String.raw`
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, notificationModulePath] = process.argv.slice(1);
const root = process.env.OMX_NOTIFICATION_RECEIPT_ROOT;
const codexHome = process.env.CODEX_HOME;
if ((mode !== 'suppressed' && mode !== 'default') || !root || !codexHome || !notificationModulePath) {
  throw new Error('invalid notification receipt child invocation');
}

const projectPath = join(root, 'project');
await mkdir(codexHome, { recursive: true });
await mkdir(projectPath, { recursive: true });
await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
  notifications: {
    enabled: true,
    telegram: {
      enabled: true,
      botToken: '123456:receipt-test-token',
      chatId: 'receipt-test-chat',
    },
  },
}, null, 2));

const deliveries = [];
globalThis.fetch = async (_url, init) => {
  deliveries.push(JSON.parse(String(init?.body || '{}')));
  return new Response(JSON.stringify({
    ok: true,
    result: { message_id: 'message-' + deliveries.length },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { notifyLifecycle } = await import(pathToFileURL(notificationModulePath).href);
const persistScopedReceipts = mode === 'default';
const lifecycleSessionId = 'receipt-lifecycle';
const idleSessionId = 'receipt-idle';
const lifecyclePath = join(
  projectPath,
  '.omx',
  'state',
  'sessions',
  lifecycleSessionId,
  'lifecycle-notif-state.json',
);
const idleStatePath = join(
  projectPath,
  '.omx',
  'state',
  'sessions',
  idleSessionId,
  'idle-notif-cooldown.json',
);
const idleLifecyclePath = join(
  projectPath,
  '.omx',
  'state',
  'sessions',
  idleSessionId,
  'lifecycle-notif-state.json',
);
const registryPath = join(process.env.HOME, '.omx', 'state', 'reply-session-registry.jsonl');
const registryLockPath = join(process.env.HOME, '.omx', 'state', 'reply-session-registry.lock');

const firstLifecycle = await notifyLifecycle('session-start', {
  sessionId: lifecycleSessionId,
  projectPath,
}, undefined, { persistScopedReceipts });
const secondLifecycle = await notifyLifecycle('session-start', {
  sessionId: lifecycleSessionId,
  projectPath,
}, undefined, { persistScopedReceipts });
const lifecycleDeliveryCount = deliveries.length;
const idleMessageId = 'message-' + (lifecycleDeliveryCount + 1);
const idleResult = await notifyLifecycle('session-idle', {
  sessionId: idleSessionId,
  projectPath,
  tmuxPaneId: '%receipt-pane',
  tmuxSession: 'receipt-session',
  tmuxTail: 'fresh receipt tail',
}, undefined, { persistScopedReceipts });
const registryContents = existsSync(registryPath)
  ? await readFile(registryPath, 'utf-8')
  : '';

process.stdout.write(JSON.stringify({
  schema: 'omx.notification-receipt-child.v1',
  mode,
  lifecycle: {
    firstSuccess: firstLifecycle?.anySuccess === true,
    secondSuccess: secondLifecycle?.anySuccess === true,
    deliveryCount: lifecycleDeliveryCount,
    secondResultCount: secondLifecycle?.results.length ?? -1,
    receiptExists: existsSync(lifecyclePath),
  },
  idle: {
    success: idleResult?.anySuccess === true,
    deliveryCount: deliveries.length - lifecycleDeliveryCount,
    hasMessageId: idleResult?.results.some((result) => result.messageId === idleMessageId) === true,
    receiptExists: existsSync(idleStatePath),
    lifecycleReceiptExists: existsSync(idleLifecyclePath),
    registryExists: existsSync(registryPath),
    registryLockExists: existsSync(registryLockPath),
    registryHasMapping: registryContents.includes(idleMessageId) && registryContents.includes(idleSessionId),
  },
}) + '\n');
`;

interface ReceiptChildResult {
  schema: string;
  mode: 'suppressed' | 'default';
  lifecycle: {
    firstSuccess: boolean;
    secondSuccess: boolean;
    deliveryCount: number;
    secondResultCount: number;
    receiptExists: boolean;
  };
  idle: {
    success: boolean;
    deliveryCount: number;
    hasMessageId: boolean;
    receiptExists: boolean;
    lifecycleReceiptExists: boolean;
    registryExists: boolean;
    registryLockExists: boolean;
    registryHasMapping: boolean;
  };
}

function runNotificationReceiptChild(mode: ReceiptChildResult['mode']): ReceiptChildResult {
  const root = mkdtempSync(join(tmpdir(), `omx-notification-receipts-${mode}-`));
  const notificationModulePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
  const home = join(root, 'home');
  const codexHome = join(home, '.codex');
  const project = join(root, 'project');

  try {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', NOTIFICATION_RECEIPT_CHILD, mode, notificationModulePath],
      {
        cwd: root,
        encoding: 'utf-8',
        env: {
          ...process.env,
          HOME: home,
          CODEX_HOME: codexHome,
          OMX_ROOT: project,
          OMX_NOTIFICATION_RECEIPT_ROOT: root,
          OMX_OPENCLAW: '',
          OMX_NOTIFY_TEMP: '',
          OMX_NOTIFY_TEMP_CONTRACT: '',
          OMX_SESSION_ID: '',
          TMUX: '',
          TMUX_PANE: '',
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout) as ReceiptChildResult;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('notification scoped receipt persistence', () => {
  it('uses child HOME before import to keep suppressed and default receipt behavior isolated', () => {
    const suppressed = runNotificationReceiptChild('suppressed');
    const defaultResult = runNotificationReceiptChild('default');

    assert.equal(suppressed.schema, 'omx.notification-receipt-child.v1');
    assert.equal(suppressed.mode, 'suppressed');
    assert.equal(suppressed.lifecycle.firstSuccess, true);
    assert.equal(suppressed.lifecycle.secondSuccess, true);
    assert.equal(suppressed.lifecycle.deliveryCount, 2);
    assert.equal(suppressed.lifecycle.secondResultCount, 1);
    assert.equal(suppressed.lifecycle.receiptExists, false);
    assert.equal(suppressed.idle.success, true);
    assert.equal(suppressed.idle.deliveryCount, 1);
    assert.equal(suppressed.idle.hasMessageId, true);
    assert.equal(suppressed.idle.receiptExists, false);
    assert.equal(suppressed.idle.lifecycleReceiptExists, false);
    assert.equal(suppressed.idle.registryExists, false);
    assert.equal(suppressed.idle.registryLockExists, false);
    assert.equal(suppressed.idle.registryHasMapping, false);

    assert.equal(defaultResult.schema, 'omx.notification-receipt-child.v1');
    assert.equal(defaultResult.mode, 'default');
    assert.equal(defaultResult.lifecycle.firstSuccess, true);
    assert.equal(defaultResult.lifecycle.secondSuccess, true);
    assert.equal(defaultResult.lifecycle.deliveryCount, 1);
    assert.equal(defaultResult.lifecycle.secondResultCount, 0);
    assert.equal(defaultResult.lifecycle.receiptExists, true);
    assert.equal(defaultResult.idle.success, true);
    assert.equal(defaultResult.idle.deliveryCount, 1);
    assert.equal(defaultResult.idle.hasMessageId, true);
    assert.equal(defaultResult.idle.receiptExists, true);
    assert.equal(defaultResult.idle.lifecycleReceiptExists, false);
    assert.equal(defaultResult.idle.registryExists, true);
    assert.equal(defaultResult.idle.registryLockExists, false);
    assert.equal(defaultResult.idle.registryHasMapping, true);
  });
});
