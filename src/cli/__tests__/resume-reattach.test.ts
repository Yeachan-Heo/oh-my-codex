import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPtyScriptCommand,
  isRealScriptAvailable,
  isRealTmuxAvailable,
  withTempTmuxSession,
} from '../../team/__tests__/tmux-test-fixture.js';

const NATIVE_SESSION_ID = '01234567-89ab-4cde-8123-0123456789ab';
const FOREIGN_NATIVE_SESSION_ID = '11234567-89ab-4cde-8123-0123456789ab';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function currentPidStartTicks(): Promise<number> {
  const raw = await readFile('/proc/self/stat', 'utf8');
  const afterComm = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/);
  const ticks = Number(afterComm[19]);
  assert.ok(Number.isSafeInteger(ticks) && ticks > 0, 'current process start ticks must be readable');
  return ticks;
}

function omxBinPath(): string {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return join(testDir, '..', '..', '..', 'dist', 'cli', 'omx.js');
}

function cleanChildEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const key of ['TMUX', 'TMUX_PANE', 'OMX_STATE_ROOT', 'OMX_SESSION_ID', 'OMX_HERMES_MCP_BRIDGE']) {
    delete env[key];
  }
  return env;
}

function runOmx(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string; error: string } {
  const result = spawnSync(process.execPath, [omxBinPath(), ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || '',
  };
}

describe('resume live-owner reattach', () => {
  it('reattaches only the explicitly matching native UUID to the verified tmux owner', async (t) => {
    if (process.platform !== 'linux') {
      t.skip('live pointer PID identity fixture currently requires Linux /proc');
      return;
    }
    if (!isRealTmuxAvailable()) {
      t.skip('tmux is not available');
      return;
    }
    if (!isRealScriptAvailable()) {
      t.skip('script(1) PTY helper is not available');
      return;
    }

    await withTempTmuxSession(async (fixture) => {
      const wd = await mkdtemp(join(tmpdir(), 'omx-resume-reattach-'));
      try {
        const fakeBin = join(wd, 'bin');
        const stateRoot = join(wd, 'state-root');
        const pointerPath = join(stateRoot, '.omx', 'state', 'session.json');
        const tmuxLog = join(wd, 'tmux.log');
        const codexMarker = join(wd, 'unexpected-codex');
        const targetSession = `${fixture.sessionName}-resume-owner`;
        const ownerSessionId = 'omx-resume-reattach-owner';

        await mkdir(fakeBin, { recursive: true });
        await mkdir(dirname(pointerPath), { recursive: true });
        await fixture.createPathShim(fakeBin, tmuxLog);
        await writeFile(
          join(fakeBin, 'codex'),
          `#!/bin/sh\nprintf '%s\\n' unexpected > ${shellQuote(codexMarker)}\nexit 99\n`,
        );
        await chmod(join(fakeBin, 'codex'), 0o755);

        const paneId = fixture.run([
          'new-session', '-d', '-P', '-F', '#{pane_id}',
          '-s', targetSession, '-c', wd, 'sleep', '300',
        ]);
        fixture.run(['set-option', '-t', targetSession, '@omx_instance_id', ownerSessionId]);

        const pointerBytes = JSON.stringify({
          session_id: ownerSessionId,
          native_session_id: NATIVE_SESSION_ID,
          cwd: wd,
          pid: process.pid,
          platform: 'linux',
          pid_start_ticks: await currentPidStartTicks(),
          tmux_session_name: targetSession,
          tmux_pane_id: paneId,
        });
        await writeFile(pointerPath, pointerBytes);
        await writeFile(tmuxLog, '');

        const env = cleanChildEnv({
          HOME: join(wd, 'home'),
          OMX_ROOT: stateRoot,
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
          TERM: 'xterm-256color',
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
        });
        const detachWatcher = [
          '(',
          'i=0;',
          'while [ "$i" -lt 100 ]; do',
          `clients=$(tmux list-clients -t ${shellQuote(targetSession)} -F '#{client_name}' 2>/dev/null || true);`,
          `if [ -n "$clients" ]; then tmux detach-client -s ${shellQuote(targetSession)} >/dev/null 2>&1; exit 0; fi;`,
          'i=$((i + 1)); sleep 0.05;',
          'done',
          ') &',
        ].join(' ');
        const omxCommand = [
          shellQuote(process.execPath),
          shellQuote(omxBinPath()),
          '--tmux',
          'resume',
          NATIVE_SESSION_ID,
        ].join(' ');
        const pty = buildPtyScriptCommand(`${detachWatcher} exec ${omxCommand}`);
        const attached = spawnSync(pty.executable, pty.args, {
          cwd: wd,
          env,
          encoding: 'utf8',
          timeout: 12_000,
          killSignal: 'SIGKILL',
        });
        const attachedOutput = `${attached.stdout || ''}\n${attached.stderr || ''}`;
        assert.equal(attached.error, undefined, attached.error?.message ?? 'PTY launch failed');
        assert.equal(attached.status, 0, attachedOutput);
        assert.match(attachedOutput, /attaching existing OMX tmux session/i);
        assert.equal(await readFile(pointerPath, 'utf8'), pointerBytes);
        const positiveTmuxLog = await readFile(tmuxLog, 'utf8');
        assert.match(positiveTmuxLog, /\nattach-session\n/);
        assert.doesNotMatch(positiveTmuxLog, /\nnew-session\n/);
        await assert.rejects(readFile(codexMarker, 'utf8'), { code: 'ENOENT' });

        for (const args of [
          ['--tmux', 'resume', FOREIGN_NATIVE_SESSION_ID],
          ['--tmux', 'resume', '--model', NATIVE_SESSION_ID],
          ['--tmux', 'resume', '--add-dir', NATIVE_SESSION_ID],
          ['--tmux', 'resume', '--profile', NATIVE_SESSION_ID],
        ]) {
          await writeFile(tmuxLog, '');
          const denied = runOmx(wd, args, env);
          const deniedOutput = `${denied.stdout}\n${denied.stderr}`;
          assert.notEqual(denied.status, 0, JSON.stringify({ args, denied }));
          assert.match(deniedOutput, /session_pointer_owner_conflict/);
          assert.doesNotMatch(deniedOutput, /attaching existing OMX tmux session/i);
          assert.equal(await readFile(pointerPath, 'utf8'), pointerBytes);
          const deniedTmuxLog = await readFile(tmuxLog, 'utf8');
          assert.doesNotMatch(deniedTmuxLog, /\nattach-session\n/);
          assert.doesNotMatch(deniedTmuxLog, /\nnew-session\n/);
          await assert.rejects(readFile(codexMarker, 'utf8'), { code: 'ENOENT' });
        }
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  });
});
