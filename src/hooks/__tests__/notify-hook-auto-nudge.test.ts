import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOTIFY_HOOK_SCRIPT = new URL('../../../scripts/notify-hook.js', import.meta.url);

async function withTempWorkingDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-auto-nudge-'));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2));
}

/**
 * Build a fake tmux binary that logs all invocations and optionally returns
 * capture-pane content from OMX_TEST_CAPTURE_FILE.
 */
function buildFakeTmux(tmuxLogPath: string): string {
  return `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="\$1"
shift || true
if [[ "\$cmd" == "capture-pane" ]]; then
  if [[ -n "\${OMX_TEST_CAPTURE_FILE:-}" && -f "\${OMX_TEST_CAPTURE_FILE}" ]]; then
    cat "\${OMX_TEST_CAPTURE_FILE}"
  fi
  exit 0
fi
if [[ "\$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "\$cmd" == "display-message" ]]; then
  exit 0
fi
if [[ "\$cmd" == "list-panes" ]]; then
  echo "%1 12345"
  exit 0
fi
exit 0
`;
}

function runNotifyHook(
  cwd: string,
  fakeBinDir: string,
  codexHome: string,
  payloadOverrides: Record<string, unknown> = {},
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  const payload = {
    cwd,
    type: 'agent-turn-complete',
    'thread-id': 'thread-test',
    'turn-id': `turn-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    'input-messages': ['test'],
    'last-assistant-message': 'done',
    ...payloadOverrides,
  };

  return spawnSync(process.execPath, [NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      CODEX_HOME: codexHome,
      TMUX_PANE: '%99',
      TMUX: '1',
      OMX_TEAM_WORKER: '',
      OMX_TEAM_LEADER_NUDGE_MS: '9999999',
      OMX_TEAM_LEADER_STALE_MS: '9999999',
      ...extraEnv,
    },
  });
}

describe('notify-hook auto-nudge', () => {
  it('sends nudge when stall pattern detected in last-assistant-message', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      // Config: enabled, delaySec=0 for fast tests
      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0 },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'I analyzed the code. If you want me to make these changes, let me know.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      assert.ok(existsSync(tmuxLogPath), 'tmux should have been called');
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /send-keys -t %99 -l yes, proceed \[OMX_TMUX_INJECT\]/, 'should send nudge response with injection marker');
      // Codex CLI needs C-m sent twice with a delay for reliable submission
      const cmMatches = tmuxLog.match(/send-keys -t %99 C-m/g);
      assert.ok(cmMatches && cmMatches.length >= 2, `should send C-m twice, got ${cmMatches?.length ?? 0}`);
    });
  });

  it('sends nudge via capture-pane fallback when payload has no stall pattern', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const captureFile = join(cwd, 'capture-output.txt');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0 },
      });

      // capture-pane will return content with a stall pattern
      await writeFile(captureFile, 'Here are the results.\nWould you like me to continue with the implementation?\n');

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'clean output with no stall',
      }, {
        OMX_TEST_CAPTURE_FILE: captureFile,
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /capture-pane/, 'should have tried capture-pane');
      assert.match(tmuxLog, /send-keys -t %99 -l yes, proceed \[OMX_TMUX_INJECT\]/, 'should send nudge via capture-pane fallback with marker');
    });
  });

  it('does not nudge when no stall pattern is present', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0 },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'I completed the refactoring. All tests pass.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /send-keys -t %99 -l yes, proceed/, 'should NOT send nudge');
      }
    });
  });

  it('respects enabled=false configuration', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      // Explicitly disabled
      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: false, delaySec: 0 },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Would you like me to proceed?',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /send-keys -t %99 -l/, 'should NOT send nudge when disabled');
      }
    });
  });

  it('respects maxNudgesPerSession limit', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, maxNudgesPerSession: 2 },
      });

      // Pre-seed nudge state at the limit
      await writeJson(join(stateDir, 'auto-nudge-state.json'), {
        nudgeCount: 2,
        lastNudgeAt: new Date().toISOString(),
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Shall I continue with the next step?',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /send-keys -t %99 -l/, 'should NOT nudge past max');
      }
    });
  });

  it('uses custom response from config', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, response: 'continue now' },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Do you want me to implement this feature?',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /send-keys -t %99 -l continue now \[OMX_TMUX_INJECT\]/, 'should use custom response with marker');
    });
  });

  it('tracks nudge count in auto-nudge-state.json', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0 },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Ready to proceed when you are.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const nudgeStatePath = join(stateDir, 'auto-nudge-state.json');
      assert.ok(existsSync(nudgeStatePath), 'auto-nudge-state.json should be created');
      const nudgeState = JSON.parse(await readFile(nudgeStatePath, 'utf-8'));
      assert.equal(nudgeState.nudgeCount, 1, 'nudge count should be 1');
      assert.ok(nudgeState.lastNudgeAt, 'should have lastNudgeAt timestamp');
    });
  });

  it('writes skill-active-state.json when keyword activation is detected', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0 },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(join(cwd, 'tmux.log')));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'input-messages': ['please use autopilot for this task'],
        'last-assistant-message': 'Here is the plan I will follow.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const skillStatePath = join(stateDir, 'skill-active-state.json');
      assert.ok(existsSync(skillStatePath), 'skill-active-state.json should be created');
      const skillState = JSON.parse(await readFile(skillStatePath, 'utf-8')) as {
        skill: string;
        phase: string;
        active: boolean;
      };
      assert.equal(skillState.skill, 'autopilot');
      assert.equal(skillState.phase, 'planning');
      assert.equal(skillState.active, true);
    });
  });

  it('does not auto-nudge when skill-active state is in completing phase', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0 },
      });
      await writeJson(join(stateDir, 'skill-active-state.json'), {
        version: 1,
        active: false,
        skill: 'autopilot',
        keyword: 'autopilot',
        phase: 'completing',
        activated_at: '2026-02-25T00:00:00.000Z',
        updated_at: '2026-02-25T00:00:00.000Z',
        source: 'keyword-detector',
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Would you like me to continue?',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /send-keys -t %99 -l/, 'should stop auto-continuation in completing phase');
      }
    });
  });

  it('detects all default stall patterns case-insensitively', async () => {
    const patterns = [
      'If You Want me to make changes',
      'Would You Like me to continue?',
      'Shall I proceed with the implementation?',
      'Next I Can refactor the module for clarity.',
      'Do You Want Me To apply this fix?',
      'Let Me Know If you need anything else.',
      'Want Me To make those changes?',
      'Let Me Know what you think.',
      'Just Let Me Know when ready.',
      'I Can Also refactor the tests.',
      'I Could Also add more tests if needed.',
      'READY TO PROCEED with the next step.',
      'Should I go ahead and deploy?',
      'Whenever You are ready, I can start.',
      'Say Go when you are ready.',
      'Say Yes to confirm the changes.',
      'Type Continue to proceed with the next step.',
      "And I'll Continue once you confirm.",
      "And I'll Proceed with the deployment.",
      "I'll Keep Driving the implementation forward.",
      "I'll Keep Pushing on the test coverage.",
      "I'll Move Forward with the remaining items.",
      "I'll Drive Forward from here.",
      "I'll Proceed From Here with the next task.",
      "I'll Continue From this point onward.",
    ];

    for (const message of patterns) {
      await withTempWorkingDir(async (cwd) => {
        const omxDir = join(cwd, '.omx');
        const stateDir = join(omxDir, 'state');
        const logsDir = join(omxDir, 'logs');
        const codexHome = join(cwd, 'codex-home');
        const fakeBinDir = join(cwd, 'fake-bin');
        const tmuxLogPath = join(cwd, 'tmux.log');

        await mkdir(logsDir, { recursive: true });
        await mkdir(stateDir, { recursive: true });
        await mkdir(codexHome, { recursive: true });
        await mkdir(fakeBinDir, { recursive: true });

        await writeJson(join(codexHome, '.omx-config.json'), {
          autoNudge: { enabled: true, delaySec: 0 },
        });

        await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
        await chmod(join(fakeBinDir, 'tmux'), 0o755);

        const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
          'last-assistant-message': message,
        });
        assert.equal(result.status, 0, `hook failed for pattern "${message}": ${result.stderr || result.stdout}`);

        assert.ok(existsSync(tmuxLogPath), `tmux should be called for pattern: "${message}"`);
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.match(tmuxLog, /send-keys -t %99 -l yes, proceed \[OMX_TMUX_INJECT\]/, `should nudge with marker for: "${message}"`);
      });
    }
  });

  it('uses custom patterns from config', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      // Custom patterns that replace defaults
      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: {
          enabled: true,
          delaySec: 0,
          patterns: ['awaiting approval'],
        },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      // Default pattern should NOT trigger with custom config
      const result1 = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Would you like me to proceed?',
      });
      assert.equal(result1.status, 0);

      if (existsSync(tmuxLogPath)) {
        const log1 = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(log1, /send-keys -t %99 -l/, 'default pattern should not match with custom config');
      }

      // Clean tmux log for second run
      if (existsSync(tmuxLogPath)) {
        await writeFile(tmuxLogPath, '');
      }

      // Custom pattern should trigger
      const result2 = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Changes ready. Awaiting approval before applying.',
      });
      assert.equal(result2.status, 0);

      const log2 = await readFile(tmuxLogPath, 'utf-8');
      assert.match(log2, /send-keys -t %99 -l yes, proceed \[OMX_TMUX_INJECT\]/, 'custom pattern should trigger nudge with marker');
    });
  });

  it('defaults to enabled when no config file exists', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      // No .omx-config.json at all — should use defaults (enabled=true)

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'If you want, I can fix the remaining issues.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      assert.ok(existsSync(tmuxLogPath), 'tmux should be called with defaults');
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /send-keys -t %99 -l yes, proceed \[OMX_TMUX_INJECT\]/, 'should nudge with default config and marker');
    });
  });

  it('does not nudge when TMUX_PANE is not set', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0 },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Would you like me to continue?',
      }, {
        TMUX_PANE: '',  // No pane available
        TMUX: '',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /send-keys.*-l yes, proceed/, 'should not nudge without pane');
      }
    });
  });
});
