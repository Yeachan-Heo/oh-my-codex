import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProcess } from '../../scripts/notify-hook/process-runner.js';
import {
  CMUX_METADATA_UNAVAILABLE_CURRENT_PATH,
  CMUX_METADATA_UNAVAILABLE_START_COMMAND,
  currentMuxPaneTarget,
  currentMuxSessionTarget,
  normalizeMuxStdout,
  resolveMuxInvocation,
  resolveMuxKind,
  translateTmuxArgvForCmux,
} from '../../scripts/notify-hook/mux-adapter.js';

describe('mux adapter selection', () => {
  it('defaults to tmux unless cmux is requested or detected', () => {
    assert.equal(resolveMuxKind({}), 'tmux');
    assert.equal(resolveMuxKind({ OMX_MUX: 'tmux', CMUX_SURFACE_ID: 'surface:abc' }), 'tmux');
    assert.equal(resolveMuxKind({ OMX_MUX: 'cmux' }), 'cmux');
    assert.equal(resolveMuxKind({ CMUX_SURFACE_ID: 'surface:abc' }), 'tmux');
    assert.equal(resolveMuxKind({ OMX_MUX: 'auto', CMUX_WORKSPACE_ID: 'workspace:abc' }), 'cmux');
    assert.equal(resolveMuxKind({ CMUX_SOCKET_PATH: '/tmp/cmux.sock' }), 'tmux');
  });

  it('resolves pane and session targets with legacy tmux fallback', () => {
    assert.equal(currentMuxPaneTarget({ OMX_MUX: 'cmux', CMUX_SURFACE_ID: 'surface:abc', TMUX_PANE: '%1' }), 'surface:abc');
    assert.equal(currentMuxPaneTarget({ OMX_MUX: 'cmux', TMUX_PANE: '%1' }), '%1');
    assert.equal(currentMuxPaneTarget({ CMUX_SURFACE_ID: 'surface:abc' }), '');
    assert.equal(currentMuxSessionTarget({ OMX_MUX: 'cmux', CMUX_WORKSPACE_ID: 'workspace:abc', TMUX: 'tmux-session' }), 'workspace:abc');
    assert.equal(currentMuxSessionTarget({ TMUX: 'tmux-session', CMUX_WORKSPACE_ID: 'workspace:abc' }), 'tmux-session');
    assert.equal(currentMuxSessionTarget({ OMX_MUX: 'tmux', TMUX: 'tmux-session', CMUX_WORKSPACE_ID: 'workspace:abc' }), 'tmux-session');
  });

  it('translates the tmux injection argv subset to cmux argv', () => {
    assert.deepEqual(
      translateTmuxArgvForCmux(['send-keys', '-t', 'surface:abc', '-l', 'hello bridge']),
      ['send', '--surface', 'surface:abc', 'hello bridge'],
    );
    assert.deepEqual(
      translateTmuxArgvForCmux(['send-keys', '-t', 'surface:abc', 'C-m']),
      ['send-key', '--surface', 'surface:abc', 'Enter'],
    );
    assert.deepEqual(
      translateTmuxArgvForCmux(['capture-pane', '-t', 'surface:abc', '-p', '-S', '-80']),
      ['capture-pane', '--surface', 'surface:abc', '--scrollback', '--lines', '80'],
    );
    assert.deepEqual(
      translateTmuxArgvForCmux(
        ['display-message', '-p', '-t', 'surface:abc', '#{pane_in_mode}'],
        { OMX_MUX: 'cmux', CMUX_WORKSPACE_ID: 'workspace:abc' },
      ),
      ['surface-health', '--workspace', 'workspace:abc'],
    );
    assert.deepEqual(
      translateTmuxArgvForCmux(
        ['display-message', '-p', '-t', 'surface:abc', '#{pane_current_command}'],
        { OMX_MUX: 'cmux', CMUX_WORKSPACE_ID: 'workspace:abc' },
      ),
      ['identify', '--workspace', 'workspace:abc', '--surface', 'surface:abc'],
    );
  });

  it('normalizes cmux list-pane output back to the tmux -F contract', () => {
    const env = {
      OMX_MUX: 'cmux',
      CMUX_SURFACE_ID: 'surface:current',
      CMUX_WORKSPACE_ID: 'workspace:abc',
    };
    const invocation = resolveMuxInvocation(
      'tmux',
      ['list-panes', '-t', 'workspace:abc', '-F', '#{pane_id}\t#{pane_active}\t#{pane_current_command}\t#{pane_start_command}'],
      env,
    );

    assert.deepEqual(invocation.args, ['list-pane-surfaces', '--workspace', 'workspace:abc']);
    assert.equal(
      normalizeMuxStdout(invocation, 'surface:other\nsurface:current\n', env),
      'surface:other\t0\t\t\nsurface:current\t1\tcodex\tcodex\n',
    );
  });

  it('normalizes cmux surface-health output for the tmux pane_in_mode guard', () => {
    const env = {
      OMX_MUX: 'cmux',
      CMUX_SURFACE_ID: 'surface:abc',
      CMUX_WORKSPACE_ID: 'workspace:abc',
    };
    const invocation = resolveMuxInvocation(
      'tmux',
      ['display-message', '-p', '-t', 'surface:abc', '#{pane_in_mode}'],
      env,
    );

    assert.deepEqual(invocation.args, ['surface-health', '--workspace', 'workspace:abc']);
    assert.equal(normalizeMuxStdout(invocation, 'surface:abc scroll_active=true\n', env), '1\n');
    assert.equal(normalizeMuxStdout(invocation, 'surface:abc scroll_active=false\n', env), '0\n');
  });

  it('normalizes target-aware cmux display metadata probes', () => {
    const env = {
      OMX_MUX: 'cmux',
      CMUX_SURFACE_ID: 'surface:abc',
      CMUX_WORKSPACE_ID: 'workspace:abc',
    };
    const currentCommand = resolveMuxInvocation(
      'tmux',
      ['display-message', '-p', '-t', 'surface:abc', '#{pane_current_command}'],
      env,
    );
    const startCommand = resolveMuxInvocation(
      'tmux',
      ['display-message', '-p', '-t', 'surface:abc', '#{pane_start_command}'],
      env,
    );
    const currentPath = resolveMuxInvocation(
      'tmux',
      ['display-message', '-p', '-t', 'surface:abc', '#{pane_current_path}'],
      env,
    );
    const metadata = JSON.stringify({
      surface_id: 'surface:abc',
      current_command: 'node',
      start_command: 'codex --model gpt-5',
      cwd: '/repo',
    });

    assert.deepEqual(currentCommand.args, ['identify', '--workspace', 'workspace:abc', '--surface', 'surface:abc']);
    assert.equal(normalizeMuxStdout(currentCommand, metadata, env), 'node\n');
    assert.equal(normalizeMuxStdout(startCommand, metadata, env), 'codex --model gpt-5\n');
    assert.equal(normalizeMuxStdout(currentPath, metadata, env), '/repo\n');
  });

  it('returns conservative metadata sentinels when cmux display metadata is unavailable', () => {
    const env = {
      OMX_MUX: 'cmux',
      CMUX_SURFACE_ID: 'surface:abc',
      CMUX_WORKSPACE_ID: 'workspace:abc',
    };
    const startCommand = resolveMuxInvocation(
      'tmux',
      ['display-message', '-p', '-t', 'surface:abc', '#{pane_start_command}'],
      env,
    );
    const currentPath = resolveMuxInvocation(
      'tmux',
      ['display-message', '-p', '-t', 'surface:abc', '#{pane_current_path}'],
      env,
    );

    assert.equal(normalizeMuxStdout(startCommand, '', env), `${CMUX_METADATA_UNAVAILABLE_START_COMMAND}\n`);
    assert.equal(normalizeMuxStdout(currentPath, '', env), `${CMUX_METADATA_UNAVAILABLE_CURRENT_PATH}\n`);
  });

  it('runs cmux mock binary when the legacy tmux call path is selected for cmux', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mux-adapter-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const cmuxPath = join(fakeBinDir, 'cmux');
    const logPath = join(cwd, 'cmux.log');
    const previous = {
      OMX_MUX: process.env.OMX_MUX,
      OMX_TEST_CMUX_BIN: process.env.OMX_TEST_CMUX_BIN,
      CMUX_SURFACE_ID: process.env.CMUX_SURFACE_ID,
    };

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(
        cmuxPath,
        `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');
`,
      );
      await chmod(cmuxPath, 0o755);

      process.env.OMX_MUX = 'cmux';
      process.env.OMX_TEST_CMUX_BIN = cmuxPath;
      process.env.CMUX_SURFACE_ID = 'surface:abc';

      await runProcess('tmux', ['send-keys', '-t', 'surface:abc', '-l', 'hello bridge']);
      await runProcess('tmux', ['send-keys', '-t', 'surface:abc', 'C-m']);

      const log = await readFile(logPath, 'utf-8');
      const lines = log.trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(lines[0], ['send', '--surface', 'surface:abc', 'hello bridge']);
      assert.deepEqual(lines[1], ['send-key', '--surface', 'surface:abc', 'Enter']);
    } finally {
      if (typeof previous.OMX_MUX === 'string') process.env.OMX_MUX = previous.OMX_MUX;
      else delete process.env.OMX_MUX;
      if (typeof previous.OMX_TEST_CMUX_BIN === 'string') process.env.OMX_TEST_CMUX_BIN = previous.OMX_TEST_CMUX_BIN;
      else delete process.env.OMX_TEST_CMUX_BIN;
      if (typeof previous.CMUX_SURFACE_ID === 'string') process.env.CMUX_SURFACE_ID = previous.CMUX_SURFACE_ID;
      else delete process.env.CMUX_SURFACE_ID;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
