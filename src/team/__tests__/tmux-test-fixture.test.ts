import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { buildPtyScriptCommand, isRealTmuxAvailable, tmuxSessionExists, withTempTmuxSession } from './tmux-test-fixture.js';

function skipUnlessTmux(t: TestContext): void {
  if (!isRealTmuxAvailable()) {
    t.skip('tmux is not available in this environment');
  }
}

function runAmbientTmux(args: string[]): string {
  return execFileSync('tmux', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TMUX: undefined,
      TMUX_PANE: undefined,
    },
  }).trim();
}

function ambientSessionExists(sessionName: string): boolean {
  try {
    runAmbientTmux(['has-session', '-t', sessionName]);
    return true;
  } catch {
    return false;
  }
}

function uniqueAmbientSessionName(): string {
  return `omx-ambient-test-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('withTempTmuxSession', () => {
  it('provides isolated tmux env and cleans up on success', async (t) => {
    skipUnlessTmux(t);
    const ambientTmux = process.env.TMUX;
    const ambientTmuxPane = process.env.TMUX_PANE;
    let sessionName = '';
    let serverName = '';

    await withTempTmuxSession(async (fixture) => {
      sessionName = fixture.sessionName;
      serverName = fixture.serverName;
      assert.match(fixture.sessionName, /^omx-test-/);
      assert.equal(fixture.serverKind, 'synthetic');
      assert.match(fixture.serverName, /^omx-fixture-/);
      assert.equal(process.env.TMUX, fixture.env.TMUX);
      assert.equal(process.env.TMUX_PANE, fixture.leaderPaneId);
      assert.equal(fixture.sessionExists(), true);
      assert.equal(
        tmuxSessionExists(fixture.sessionName),
        false,
        'fixture session must not be visible on the maintainer default tmux server',
      );
      if (ambientTmux) {
        assert.notEqual(
          fixture.env.TMUX,
          ambientTmux,
          'synthetic fixture must use a different tmux socket/env tuple than the ambient session',
        );
      }
      if (ambientTmuxPane) {
        assert.equal(
          fixture.leaderPaneId.startsWith('%'),
          true,
          'fixture should still expose a pane id even when pane ids are recycled across tmux servers',
        );
      }
    });

    assert.equal(tmuxSessionExists(sessionName, serverName), false);
    assert.equal(process.env.TMUX, ambientTmux);
    assert.equal(process.env.TMUX_PANE, ambientTmuxPane);
  });

  it('cleans up when the callback throws', async (t) => {
    skipUnlessTmux(t);
    let sessionName = '';
    let serverName = '';

    await assert.rejects(
      () => withTempTmuxSession(async (fixture) => {
        sessionName = fixture.sessionName;
        serverName = fixture.serverName;
        throw new Error('fixture boom');
      }),
      /fixture boom/,
    );

    assert.equal(tmuxSessionExists(sessionName, serverName), false);
  });

  it('keeps ambient default-server sessions untouched by default', async (t) => {
    skipUnlessTmux(t);
    const ambientSessionName = uniqueAmbientSessionName();
    const created = runAmbientTmux([
      'new-session',
      '-d',
      '-P',
      '-F',
      '#{session_name}',
      '-s',
      ambientSessionName,
      'sleep 300',
    ]);
    assert.equal(created, ambientSessionName);

    try {
      await withTempTmuxSession(async (fixture) => {
        assert.equal(fixture.serverKind, 'synthetic');
        assert.equal(fixture.sessionExists(ambientSessionName), false);
        assert.equal(ambientSessionExists(ambientSessionName), true);
      });

      assert.equal(ambientSessionExists(ambientSessionName), true);
    } finally {
      try {
        runAmbientTmux(['kill-session', '-t', ambientSessionName]);
      } catch {}
    }
  });

  it('only uses the ambient server when a test explicitly opts in', async (t) => {
    skipUnlessTmux(t);
    let sessionName = '';

    await withTempTmuxSession({ useAmbientServer: true }, async (fixture) => {
      sessionName = fixture.sessionName;
      assert.equal(fixture.serverKind, 'ambient');
      assert.equal(fixture.serverName, '');
      assert.equal(ambientSessionExists(fixture.sessionName), true);
      assert.equal(fixture.sessionExists(), true);
    });

    assert.equal(ambientSessionExists(sessionName), false);
  });

  it('rejects private server logging on the ambient server', async (t) => {
    skipUnlessTmux(t);
    await assert.rejects(
      withTempTmuxSession({ useAmbientServer: true, serverLog: true }, async () => undefined),
      /server logging requires a private synthetic tmux server/,
    );
  });

  it('exposes a private server log only when logging is enabled', async (t) => {
    skipUnlessTmux(t);
    await withTempTmuxSession(async (fixture) => {
      assert.equal(fixture.serverLogPath, null);
      await assert.rejects(fixture.readServerLog(), /server logging was not enabled/);
    });

    await withTempTmuxSession({ serverLog: true }, async (fixture) => {
      assert.match(fixture.serverLogPath ?? '', /tmux-server-[0-9]+\.log$/);
      assert.equal(typeof (await fixture.readServerLog()), 'string');
    });
  });

  it('rejects out-of-range client resize geometry before attaching', async (t) => {
    skipUnlessTmux(t);
    await withTempTmuxSession(async (fixture) => {
      assert.throws(() => fixture.triggerClientResize(fixture.sessionName, { rows: 3 }), /invalid trigger rows: 3/);
      assert.throws(() => fixture.triggerClientResize(fixture.sessionName, { rows: 501 }), /invalid trigger rows: 501/);
      assert.throws(() => fixture.triggerClientResize(fixture.sessionName, { rows: 40.5 }), /invalid trigger rows: 40.5/);
      assert.throws(() => fixture.triggerClientResize(fixture.sessionName, { cols: 19 }), /invalid trigger cols: 19/);
      assert.throws(() => fixture.triggerClientResize(fixture.sessionName, { cols: 501 }), /invalid trigger cols: 501/);
    });
  });

  it('triggers client resize when GNU timeout is absent from PATH', async (t) => {
    if (!isRealTmuxAvailable()) {
      t.skip('tmux is not available in this environment');
      return;
    }
    const commandPaths = new Map(
      ['script', 'sleep', 'stty'].map((command) => [
        command,
        execFileSync('/bin/sh', ['-c', `command -v ${command}`], { encoding: 'utf-8' }).trim(),
      ]),
    );

    await withTempTmuxSession(async (fixture) => {
      const isolatedPath = await mkdtemp(join(tmpdir(), 'omx-no-timeout-path-'));
      const originalPath = process.env.PATH;
      try {
        for (const [command, executable] of commandPaths) {
          await symlink(executable, join(isolatedPath, command));
        }
        process.env.PATH = isolatedPath;
        fixture.triggerClientResize(fixture.sessionName, { rows: 41, cols: 121 });
      } finally {
        process.env.PATH = originalPath;
        await rm(isolatedPath, { recursive: true, force: true });
      }
    });
  });

  it('preserves an early attach failure instead of reporting a timeout', async (t) => {
    if (!isRealTmuxAvailable()) {
      t.skip('tmux is not available in this environment');
      return;
    }

    await withTempTmuxSession(async (fixture) => {
      let error: Error | undefined;
      try {
        fixture.triggerClientResize('missing-session');
      } catch (caught) {
        if (!(caught instanceof Error)) throw caught;
        error = caught;
      }
      assert.ok(error);
      assert.match(error.message, /"status":1/);
      assert.doesNotMatch(error.message, /"status":124/);
    });
  });
});
describe('buildPtyScriptCommand', () => {
  it('builds the util-linux Linux contract: script -q -e -c <command> /dev/null', () => {
    assert.deepEqual(buildPtyScriptCommand('echo hi', 'linux'), {
      executable: 'script',
      args: ['-q', '-e', '-c', 'echo hi', '/dev/null'],
    });
  });

  it('builds the BSD/macOS Darwin contract: script -q /dev/null /bin/sh -c <command>', () => {
    assert.deepEqual(buildPtyScriptCommand('echo hi', 'darwin'), {
      executable: 'script',
      args: ['-q', '/dev/null', '/bin/sh', '-c', 'echo hi'],
    });
  });

  it('falls back to the Linux/util-linux contract on other non-Darwin platforms', () => {
    assert.deepEqual(buildPtyScriptCommand('echo hi', 'freebsd'), {
      executable: 'script',
      args: ['-q', '-e', '-c', 'echo hi', '/dev/null'],
    });
  });

  it('keeps a multi-token shell command as exactly one argv element on both platforms', () => {
    const command = `a=1; b="two three"; echo "$a $b" && exit 7`;
    const linux = buildPtyScriptCommand(command, 'linux');
    assert.equal(linux.args.filter((arg) => arg === command).length, 1);
    assert.equal(linux.args.length, 5);
    const darwin = buildPtyScriptCommand(command, 'darwin');
    assert.equal(darwin.args.filter((arg) => arg === command).length, 1);
    assert.equal(darwin.args.length, 5);
  });

  it('defaults to the current host platform when none is supplied', () => {
    const result = buildPtyScriptCommand('echo hi');
    const expected = process.platform === 'darwin'
      ? { executable: 'script', args: ['-q', '/dev/null', '/bin/sh', '-c', 'echo hi'] }
      : { executable: 'script', args: ['-q', '-e', '-c', 'echo hi', '/dev/null'] };
    assert.deepEqual(result, expected);
  });
});
