import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProcess } from '../../scripts/notify-hook/process-runner.js';
import {
  currentMuxPaneTarget,
  currentMuxSessionTarget,
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
      translateTmuxArgvForCmux(['display-message', '-p', '-t', 'surface:abc', '#{pane_in_mode}']),
      ['display-message', '-p', '0'],
    );
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
