import { after, before, beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ENV_KEYS = ['CODEX_HOME', 'TMUX', 'TMUX_PANE', 'PATH'] as const;

const originalFetch = globalThis.fetch;

function writeNotificationConfig(codexHome: string): void {
  writeFileSync(join(codexHome, '.omx-config.json'), JSON.stringify({
    notifications: {
      enabled: true,
      webhook: {
        enabled: true,
        url: 'https://example.com/hook',
      },
    },
  }, null, 2));
}

function writeFakeTmux(fakeBinDir: string, output: string): void {
  const tmuxPath = join(fakeBinDir, 'tmux');
  writeFileSync(tmuxPath, `#!/usr/bin/env bash
set -eu
if [[ "$1" == "list-panes" ]]; then
  printf '0 %s\\n' "$PPID"
  exit 0
fi
if [[ "$1" == "capture-pane" ]]; then
  printf '%s\\n' ${JSON.stringify(output)}
  exit 0
fi
exit 2
`);
  chmodSync(tmuxPath, 0o755);
}

describe('notifyLifecycle tmux tail auto-capture', () => {
  let originalEnv: NodeJS.ProcessEnv;
  const codexHome = mkdtempSync(join(tmpdir(), 'omx-notify-index-codex-home-'));
  const fakeBinDir = mkdtempSync(join(tmpdir(), 'omx-notify-index-fake-bin-'));

  before(() => {
    originalEnv = { ...process.env };
    process.env.CODEX_HOME = codexHome;
    process.env.PATH = `${fakeBinDir}:${originalEnv.PATH || ''}`;
    process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
    process.env.TMUX_PANE = '%42';
  });

  beforeEach(() => {
    process.env.CODEX_HOME = codexHome;
    process.env.PATH = `${fakeBinDir}:${originalEnv.PATH || ''}`;
    process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
    process.env.TMUX_PANE = '%42';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  after(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(fakeBinDir, { recursive: true, force: true });
  });

  it('does not auto-capture historical tmux tail for terminal notifications', async () => {
    writeFakeTmux(fakeBinDir, 'historical risk line');
    writeNotificationConfig(codexHome);
    const { notifyLifecycle } = await import('../index.js');

    for (const eventName of ['session-end', 'session-stop'] as const) {
      let capturedBody = '';
      globalThis.fetch = async (_input, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return new Response('', { status: 200 });
      };

      const projectPath = mkdtempSync(join(tmpdir(), `omx-notify-index-project-${eventName}-`));
      const result = await notifyLifecycle(eventName, {
        sessionId: `sess-${eventName}-${Date.now()}`,
        projectPath,
        projectName: 'project',
        reason: 'session_exit',
      });
      rmSync(projectPath, { recursive: true, force: true });

      assert.ok(result);
      assert.equal(result.anySuccess, true);
      const parsed = JSON.parse(capturedBody) as { message: string };
      assert.doesNotMatch(parsed.message, /Recent output:/);
      assert.doesNotMatch(parsed.message, /historical risk line/);
    }
  });


  it('awaits ask-user-question OpenClaw dispatch so reply routing stays on the live launch path', async () => {
    let openClawCalls = 0;
    let openClawResolved = false;

    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? String(input) : input.url;
      if (!url.includes('127.0.0.1:18789')) {
        return new Response('', { status: 200 });
      }
      openClawCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      openClawResolved = true;
      return new Response('', { status: 200 });
    };

    writeFileSync(join(codexHome, '.omx-config.json'), JSON.stringify({
      notifications: {
        enabled: true,
        verbosity: 'verbose',
        webhook: {
          enabled: true,
          url: 'https://example.com/hook',
        },
        events: {
          'ask-user-question': { enabled: true },
          'session-start': { enabled: true },
        },
        openclaw: {
          enabled: true,
          gateways: {
            local: { type: 'http', url: 'http://127.0.0.1:18789/hooks/agent' },
          },
          hooks: {
            'ask-user-question': {
              enabled: true,
              gateway: 'local',
              instruction: 'ask {{question}}',
            },
            'session-start': {
              enabled: true,
              gateway: 'local',
              instruction: 'start {{sessionId}}',
            },
          },
        },
      },
    }, null, 2));

    process.env.OMX_OPENCLAW = '1';
    const { resetOpenClawConfigCache } = await import('../../openclaw/config.js');
    resetOpenClawConfigCache();

    const projectPath = mkdtempSync(join(tmpdir(), 'omx-notify-index-project-ask-'));
    const { notifyLifecycle } = await import(`../index.js?ask-user-question-await=${Date.now()}`);

    const askStarted = Date.now();
    const askResult = await notifyLifecycle('ask-user-question', {
      sessionId: `sess-ask-${Date.now()}`,
      projectPath,
      question: 'Need approval?',
    });
    const askElapsed = Date.now() - askStarted;

    assert.ok(askResult);
    assert.equal(askResult.anySuccess, true);
    assert.equal(openClawCalls, 1);
    assert.equal(openClawResolved, true);
    assert.ok(askElapsed >= 50, `ask-user-question should await OpenClaw dispatch, got ${askElapsed}ms`);

    openClawCalls = 0;
    openClawResolved = false;
    const startResult = await notifyLifecycle('session-start', {
      sessionId: `sess-start-${Date.now()}`,
      projectPath,
    });

    assert.ok(startResult);
    assert.equal(startResult.anySuccess, true);
    assert.equal(openClawCalls, 1);
    assert.equal(openClawResolved, false, 'session-start should keep fire-and-forget OpenClaw dispatch');

    rmSync(projectPath, { recursive: true, force: true });
    delete process.env.OMX_OPENCLAW;
  });

  it('keeps auto-capturing tmux tail for live session-idle notifications', async () => {
    writeFakeTmux(fakeBinDir, 'waiting for live input');

    let capturedBody = '';
    globalThis.fetch = async (_input, init) => {
      capturedBody = typeof init?.body === 'string' ? init.body : '';
      return new Response('', { status: 200 });
    };
    writeNotificationConfig(codexHome);

    const projectPath = mkdtempSync(join(tmpdir(), 'omx-notify-index-project-idle-'));
    const { notifyLifecycle } = await import('../index.js');
    const result = await notifyLifecycle('session-idle', {
      sessionId: `sess-idle-${Date.now()}`,
      projectPath,
      projectName: 'project',
    });
    rmSync(projectPath, { recursive: true, force: true });

    assert.ok(result);
    assert.equal(result.anySuccess, true);
    const parsed = JSON.parse(capturedBody) as { message: string };
    assert.match(parsed.message, /Recent output:/);
    assert.match(parsed.message, /waiting for live input/);
  });
});
