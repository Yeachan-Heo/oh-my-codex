import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTmuxSessionName } from '../../cli/index.js';
import {
  resolveManagedPaneFromAnchor,
  resolveManagedSessionContext,
  resolveManagedSessionPane,
  verifyManagedPaneTarget,
} from '../../scripts/notify-hook/managed-tmux.js';
import { writeSessionStart } from '../session.js';

function readLinuxStartTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd === -1) return null;
    const remainder = stat.slice(commandEnd + 1).trim();
    const fields = remainder.split(/\s+/);
    if (fields.length <= 19) return null;
    const startTicks = Number(fields[19]);
    return Number.isFinite(startTicks) ? startTicks : null;
  } catch {
    return null;
  }
}

function readLinuxCmdline(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`);
    const text = raw.toString('utf-8').replace(/\0+/g, ' ').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

describe('notify-hook managed tmux windows fallback', () => {
  async function withFakeTmux(cwd: string, script: string, run: () => Promise<void>): Promise<void> {
    const fakeBinDir = join(cwd, 'fake-bin');
    const fakeTmuxPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(fakeTmuxPath, script);
    await chmod(fakeTmuxPath, 0o755);
    process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;
    try {
      await run();
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
    }
  }

  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalTmux = process.env.TMUX;
  const originalTmuxPane = process.env.TMUX_PANE;
  const originalTeamWorker = process.env.OMX_TEAM_WORKER;

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    if (originalTmux !== undefined) process.env.TMUX = originalTmux;
    else delete process.env.TMUX;
    if (originalTmuxPane !== undefined) process.env.TMUX_PANE = originalTmuxPane;
    else delete process.env.TMUX_PANE;
    if (originalTeamWorker !== undefined) process.env.OMX_TEAM_WORKER = originalTeamWorker;
    else delete process.env.OMX_TEAM_WORKER;
  });

  it('does not rely on ps ancestry checks on native Windows', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-managed-tmux-win32-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      const sessionId = 'omx-test-session';
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        started_at: new Date().toISOString(),
        cwd,
        pid: 999999,
        platform: 'win32',
      }, null, 2));

      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      delete process.env.TMUX;
      delete process.env.TMUX_PANE;
      process.env.OMX_TEAM_WORKER = '';

      const result = await resolveManagedSessionContext(cwd, { session_id: sessionId }, { allowTeamWorker: false });
      assert.equal(result.managed, false);
      assert.equal(result.reason, 'stale_session');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('accepts native payload session ids when session state stores a separate native_session_id', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-managed-tmux-native-session-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeSessionStart(cwd, 'omx-canonical-session');
      const current = JSON.parse(await readFile(join(stateDir, 'session.json'), 'utf-8'));
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        ...current,
        native_session_id: 'codex-native-session',
      }, null, 2));

      delete process.env.TMUX;
      delete process.env.TMUX_PANE;
      process.env.OMX_TEAM_WORKER = '';

      const result = await resolveManagedSessionContext(cwd, { session_id: 'codex-native-session' }, { allowTeamWorker: false });
      assert.equal(result.managed, true);
      assert.equal(result.invocationSessionId, 'codex-native-session');
      assert.equal(result.canonicalSessionId, 'omx-canonical-session');
      assert.equal(result.nativeSessionId, 'codex-native-session');
      assert.match(result.expectedTmuxSessionName, /omx-canonical-session|canonical-session/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses authoritative tmux session metadata before recomputing branch-based names', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-managed-tmux-authoritative-'));
    try {
      const sessionId = 'omx-authoritative-session';
      const tmuxSessionName = 'omx-authoritative-without-git';
      await writeSessionStart(cwd, sessionId, { tmuxSessionName });

      await withFakeTmux(cwd, `#!/usr/bin/env bash
if [[ "$1" == "display-message" ]]; then
  echo "${tmuxSessionName}"
  exit 0
fi
exit 1
`, async () => {
        process.env.TMUX = '1';
        delete process.env.TMUX_PANE;
        process.env.OMX_TEAM_WORKER = '';

        const result = await resolveManagedSessionContext(cwd, { session_id: sessionId }, { allowTeamWorker: false });
        assert.equal(result.managed, true);
        assert.equal(result.reason, 'tmux_session_match');
        assert.equal(result.expectedTmuxSessionName, tmuxSessionName);
        assert.equal(result.currentTmuxSessionName, tmuxSessionName);
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed when authoritative tmux metadata disagrees with the active tmux session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-managed-tmux-authoritative-mismatch-'));
    try {
      const sessionId = 'omx-authoritative-session';
      await writeSessionStart(cwd, sessionId, { tmuxSessionName: 'omx-expected-session' });

      await withFakeTmux(cwd, `#!/usr/bin/env bash
if [[ "$1" == "display-message" ]]; then
  echo "omx-other-session"
  exit 0
fi
exit 1
`, async () => {
        process.env.TMUX = '1';
        delete process.env.TMUX_PANE;
        process.env.OMX_TEAM_WORKER = '';

        const result = await resolveManagedSessionContext(cwd, { session_id: sessionId }, { allowTeamWorker: false });
        assert.equal(result.managed, false);
        assert.equal(result.reason, 'tmux_session_mismatch');
        assert.equal(result.expectedTmuxSessionName, 'omx-expected-session');
        assert.equal(result.currentTmuxSessionName, 'omx-other-session');
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('accepts symlinked cwd aliases for the same managed session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-managed-tmux-cwd-alias-'));
    const aliasCwd = `${cwd}-alias`;
    try {
      await symlink(cwd, aliasCwd, process.platform === 'win32' ? 'junction' : 'dir');
      await writeSessionStart(cwd, 'omx-alias-session');

      delete process.env.TMUX;
      delete process.env.TMUX_PANE;
      process.env.OMX_TEAM_WORKER = '';

      const result = await resolveManagedSessionContext(aliasCwd, { session_id: 'omx-alias-session' }, { allowTeamWorker: false });
      assert.equal(result.managed, true);
      assert.match(result.reason, /ancestry_match$/);
      assert.equal(result.canonicalSessionId, 'omx-alias-session');
      assert.equal(result.expectedTmuxSessionName, buildTmuxSessionName(cwd, 'omx-alias-session'));
    } finally {
      await rm(aliasCwd, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('verifies managed pane targets when invoked from a cwd alias for the same session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-managed-tmux-pane-alias-'));
    const aliasCwd = `${cwd}-alias`;
    const sessionId = 'omx-alias-session';
    try {
      await symlink(cwd, aliasCwd, process.platform === 'win32' ? 'junction' : 'dir');
      await writeSessionStart(cwd, sessionId);

      delete process.env.TMUX;
      delete process.env.TMUX_PANE;
      process.env.OMX_TEAM_WORKER = '';

      const managedSessionName = buildTmuxSessionName(cwd, sessionId);
      await withFakeTmux(cwd, `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ "$target" == "%42" && "$format" == "#S" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
fi
echo "unsupported tmux call: $cmd $*" >&2
exit 1
`, async () => {
        const verdict = await verifyManagedPaneTarget('%42', aliasCwd, { session_id: sessionId }, { allowTeamWorker: false });
        assert.equal(verdict.ok, true);
        assert.equal(verdict.reason, 'ok');
        assert.equal(verdict.paneSessionName, managedSessionName);
        assert.equal(verdict.managedContext.expectedTmuxSessionName, managedSessionName);
      });
    } finally {
      await rm(aliasCwd, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps the verified anchor pane instead of rebinding to the active codex pane in the session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-managed-anchor-pane-'));
    const originalPath = process.env.PATH;
    try {
      const stateDir = join(cwd, '.omx', 'state');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const sessionId = 'omx-anchor-pane';
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);

      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        started_at: new Date().toISOString(),
        cwd,
        pid: process.pid,
        platform: process.platform,
        pid_start_ticks: readLinuxStartTicks(process.pid),
        pid_cmdline: readLinuxCmdline(process.pid),
      }, null, 2));

      const fakeTmux = `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ -z "$target" && "$format" == "#S" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%42" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%42" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%42" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  echo "unsupported display target: $target / $format" >&2
  exit 1
fi
if [[ "$cmd" == "list-panes" ]]; then
  target=""
  while (($#)); do
    case "$1" in
      -s) shift ;;
      -t) target="$2"; shift 2 ;;
      -F) shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ "$target" == "${managedSessionName}" ]]; then
    printf "%%42\\t0\\tcodex\\tcodex\\n%%55\\t1\\tcodex\\tcodex\\n"
    exit 0
  fi
  echo "unexpected list-panes target: $target" >&2
  exit 1
fi
echo "unsupported cmd: $cmd" >&2
exit 1
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      process.env.PATH = `${fakeBinDir}:${originalPath || ''}`;
      process.env.TMUX = '1';
      delete process.env.TMUX_PANE;
      process.env.OMX_TEAM_WORKER = '';

      const paneId = await resolveManagedPaneFromAnchor('%42', cwd, { session_id: sessionId }, { allowTeamWorker: false });
      assert.equal(paneId, '%42');
    } finally {
      process.env.PATH = originalPath;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rebinds a node shell anchor to the live codex pane in the managed session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-managed-node-shell-anchor-'));
    const originalPath = process.env.PATH;
    try {
      const stateDir = join(cwd, '.omx', 'state');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const sessionId = 'omx-node-shell-anchor';
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);

      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        started_at: new Date().toISOString(),
        cwd,
        pid: process.pid,
        platform: process.platform,
        pid_start_ticks: readLinuxStartTicks(process.pid),
        pid_cmdline: readLinuxCmdline(process.pid),
      }, null, 2));

      const fakeTmux = `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ -z "$target" && "$format" == "#S" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%42" ]]; then
    echo "node"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%42" ]]; then
    echo "bash"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%42" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  echo "unsupported display target: $target / $format" >&2
  exit 1
fi
if [[ "$cmd" == "list-panes" ]]; then
  target=""
  while (($#)); do
    case "$1" in
      -s) shift ;;
      -t) target="$2"; shift 2 ;;
      -F) shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ "$target" == "${managedSessionName}" ]]; then
    printf "%%42\\t0\\tnode\\tbash\\n%%55\\t1\\tcodex\\tcodex\\n"
    exit 0
  fi
  echo "unexpected list-panes target: $target" >&2
  exit 1
fi
echo "unsupported cmd: $cmd" >&2
exit 1
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      process.env.PATH = `${fakeBinDir}:${originalPath || ''}`;
      process.env.TMUX = '1';
      delete process.env.TMUX_PANE;
      process.env.OMX_TEAM_WORKER = '';

      const paneId = await resolveManagedPaneFromAnchor('%42', cwd, { session_id: sessionId }, { allowTeamWorker: false });
      assert.equal(paneId, '%55');
    } finally {
      process.env.PATH = originalPath;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed for anchorless managed-session recovery when only a wrapper-launched node pane exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-managed-wrapper-node-session-pane-'));
    const originalPath = process.env.PATH;
    try {
      const stateDir = join(cwd, '.omx', 'state');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const sessionId = 'omx-wrapper-node-session-pane';
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);

      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        started_at: new Date().toISOString(),
        cwd,
        pid: process.pid,
        platform: process.platform,
        pid_start_ticks: readLinuxStartTicks(process.pid),
        pid_cmdline: readLinuxCmdline(process.pid),
      }, null, 2));

      const fakeTmux = `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ -z "$target" && "$format" == "#S" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  echo "unsupported display target: $target / $format" >&2
  exit 1
fi
if [[ "$cmd" == "list-panes" ]]; then
  target=""
  while (($#)); do
    case "$1" in
      -s) shift ;;
      -t) target="$2"; shift 2 ;;
      -F) shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ "$target" == "${managedSessionName}" ]]; then
    printf "%%42\\t1\\tnode\\tbash\\n"
    exit 0
  fi
  echo "unexpected list-panes target: $target" >&2
  exit 1
fi
echo "unsupported cmd: $cmd" >&2
exit 1
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      process.env.PATH = `${fakeBinDir}:${originalPath || ''}`;
      process.env.TMUX = '1';
      delete process.env.TMUX_PANE;
      process.env.OMX_TEAM_WORKER = '';

      const paneId = await resolveManagedSessionPane(cwd, { session_id: sessionId });
      assert.equal(paneId, '');
    } finally {
      process.env.PATH = originalPath;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps a wrapper-launched node anchor when detached anchor fallback has no stricter codex candidate', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-managed-wrapper-node-anchor-'));
    const originalPath = process.env.PATH;
    try {
      const stateDir = join(cwd, '.omx', 'state');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const sessionId = 'omx-wrapper-node-anchor';
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);

      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        started_at: new Date().toISOString(),
        cwd,
        pid: process.pid,
        platform: process.platform,
        pid_start_ticks: readLinuxStartTicks(process.pid),
        pid_cmdline: readLinuxCmdline(process.pid),
      }, null, 2));

      const fakeTmux = `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ -z "$target" && "$format" == "#S" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%42" ]]; then
    echo "node"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%42" ]]; then
    echo "bash"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%42" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  echo "unsupported display target: $target / $format" >&2
  exit 1
fi
if [[ "$cmd" == "list-panes" ]]; then
  target=""
  while (($#)); do
    case "$1" in
      -s) shift ;;
      -t) target="$2"; shift 2 ;;
      -F) shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ "$target" == "${managedSessionName}" ]]; then
    printf "%%42\\t1\\tnode\\tbash\\n"
    exit 0
  fi
  echo "unexpected list-panes target: $target" >&2
  exit 1
fi
echo "unsupported cmd: $cmd" >&2
exit 1
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      process.env.PATH = `${fakeBinDir}:${originalPath || ''}`;
      process.env.TMUX = '1';
      delete process.env.TMUX_PANE;
      process.env.OMX_TEAM_WORKER = '';

      const paneId = await resolveManagedPaneFromAnchor('%42', cwd, { session_id: sessionId }, { allowTeamWorker: false });
      assert.equal(paneId, '%42');
    } finally {
      process.env.PATH = originalPath;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed for a shell-degraded codex anchor when only a detached wrapper fallback exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-managed-degraded-codex-wrapper-only-'));
    const originalPath = process.env.PATH;
    try {
      const stateDir = join(cwd, '.omx', 'state');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const sessionId = 'omx-degraded-codex-wrapper-only';
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);

      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        started_at: new Date().toISOString(),
        cwd,
        pid: process.pid,
        platform: process.platform,
        pid_start_ticks: readLinuxStartTicks(process.pid),
        pid_cmdline: readLinuxCmdline(process.pid),
      }, null, 2));

      const fakeTmux = `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ -z "$target" && "$format" == "#S" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%42" ]]; then
    echo "bash"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%42" ]]; then
    echo "codex --model gpt-5"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%42" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  echo "unsupported display target: $target / $format" >&2
  exit 1
fi
if [[ "$cmd" == "list-panes" ]]; then
  target=""
  while (($#)); do
    case "$1" in
      -s) shift ;;
      -t) target="$2"; shift 2 ;;
      -F) shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ "$target" == "${managedSessionName}" ]]; then
    printf "%%42\\t0\\tbash\\tcodex --model gpt-5\\n%%55\\t1\\tnode\\tbash\\n"
    exit 0
  fi
  echo "unexpected list-panes target: $target" >&2
  exit 1
fi
echo "unsupported cmd: $cmd" >&2
exit 1
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      process.env.PATH = `${fakeBinDir}:${originalPath || ''}`;
      process.env.TMUX = '1';
      delete process.env.TMUX_PANE;
      process.env.OMX_TEAM_WORKER = '';

      const paneId = await resolveManagedPaneFromAnchor('%42', cwd, { session_id: sessionId }, { allowTeamWorker: false });
      assert.equal(paneId, '');
    } finally {
      process.env.PATH = originalPath;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rebinds a shell-degraded codex anchor to the live codex pane in the managed session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-managed-degraded-codex-anchor-'));
    const originalPath = process.env.PATH;
    try {
      const stateDir = join(cwd, '.omx', 'state');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const sessionId = 'omx-degraded-codex-anchor';
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);

      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        started_at: new Date().toISOString(),
        cwd,
        pid: process.pid,
        platform: process.platform,
        pid_start_ticks: readLinuxStartTicks(process.pid),
        pid_cmdline: readLinuxCmdline(process.pid),
      }, null, 2));

      const fakeTmux = `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ -z "$target" && "$format" == "#S" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%42" ]]; then
    echo "bash"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%42" ]]; then
    echo "codex --model gpt-5"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%42" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  echo "unsupported display target: $target / $format" >&2
  exit 1
fi
if [[ "$cmd" == "list-panes" ]]; then
  target=""
  while (($#)); do
    case "$1" in
      -s) shift ;;
      -t) target="$2"; shift 2 ;;
      -F) shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ "$target" == "${managedSessionName}" ]]; then
    printf "%%42\\t0\\tbash\\tcodex --model gpt-5\\n%%55\\t1\\tcodex\\tcodex\\n"
    exit 0
  fi
  echo "unexpected list-panes target: $target" >&2
  exit 1
fi
echo "unsupported cmd: $cmd" >&2
exit 1
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      process.env.PATH = `${fakeBinDir}:${originalPath || ''}`;
      process.env.TMUX = '1';
      delete process.env.TMUX_PANE;
      process.env.OMX_TEAM_WORKER = '';

      const paneId = await resolveManagedPaneFromAnchor('%42', cwd, { session_id: sessionId }, { allowTeamWorker: false });
      assert.equal(paneId, '%55');
    } finally {
      process.env.PATH = originalPath;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('ignores an active shell-degraded codex pane when selecting the live managed replacement', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-managed-active-degraded-codex-anchor-'));
    const originalPath = process.env.PATH;
    try {
      const stateDir = join(cwd, '.omx', 'state');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const sessionId = 'omx-active-degraded-codex-anchor';
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);

      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        started_at: new Date().toISOString(),
        cwd,
        pid: process.pid,
        platform: process.platform,
        pid_start_ticks: readLinuxStartTicks(process.pid),
        pid_cmdline: readLinuxCmdline(process.pid),
      }, null, 2));

      const fakeTmux = `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ -z "$target" && "$format" == "#S" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%42" ]]; then
    echo "zsh"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%42" ]]; then
    echo "codex --model gpt-5"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%42" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  echo "unsupported display target: $target / $format" >&2
  exit 1
fi
if [[ "$cmd" == "list-panes" ]]; then
  target=""
  while (($#)); do
    case "$1" in
      -s) shift ;;
      -t) target="$2"; shift 2 ;;
      -F) shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ "$target" == "${managedSessionName}" ]]; then
    printf "%%42\\t1\\tzsh\\tcodex --model gpt-5\\n%%55\\t0\\tcodex\\tcodex\\n"
    exit 0
  fi
  echo "unexpected list-panes target: $target" >&2
  exit 1
fi
echo "unsupported cmd: $cmd" >&2
exit 1
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      process.env.PATH = `${fakeBinDir}:${originalPath || ''}`;
      process.env.TMUX = '1';
      delete process.env.TMUX_PANE;
      process.env.OMX_TEAM_WORKER = '';

      const paneId = await resolveManagedPaneFromAnchor('%42', cwd, { session_id: sessionId }, { allowTeamWorker: false });
      assert.equal(paneId, '%55');
    } finally {
      process.env.PATH = originalPath;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rebinds a degraded anchor using the verified session name when a follow-up #S lookup would fail', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-managed-degraded-anchor-session-reuse-'));
    const originalPath = process.env.PATH;
    try {
      const stateDir = join(cwd, '.omx', 'state');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const sessionId = 'omx-degraded-anchor-session-reuse';
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);
      const sessionLookupCountPath = join(cwd, 'session-lookup-count');

      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        started_at: new Date().toISOString(),
        cwd,
        pid: process.pid,
        platform: process.platform,
        pid_start_ticks: readLinuxStartTicks(process.pid),
        pid_cmdline: readLinuxCmdline(process.pid),
      }, null, 2));

      const fakeTmux = `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ -z "$target" && "$format" == "#S" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%42" ]]; then
    echo "bash"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%42" ]]; then
    echo "codex --model gpt-5"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%42" ]]; then
    count=0
    if [[ -f "${sessionLookupCountPath}" ]]; then
      count="$(cat "${sessionLookupCountPath}")"
    fi
    count=$((count + 1))
    printf '%s' "$count" > "${sessionLookupCountPath}"
    if [[ "$count" -gt 1 ]]; then
      echo "session lookup should not repeat" >&2
      exit 1
    fi
    echo "${managedSessionName}"
    exit 0
  fi
  echo "unsupported display target: $target / $format" >&2
  exit 1
fi
if [[ "$cmd" == "list-panes" ]]; then
  target=""
  while (($#)); do
    case "$1" in
      -s) shift ;;
      -t) target="$2"; shift 2 ;;
      -F) shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ "$target" == "${managedSessionName}" ]]; then
    printf "%%42\\t1\\tbash\\tcodex --model gpt-5\\n%%55\\t0\\tcodex\\tcodex\\n"
    exit 0
  fi
  echo "unexpected list-panes target: $target" >&2
  exit 1
fi
echo "unsupported cmd: $cmd" >&2
exit 1
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      process.env.PATH = `${fakeBinDir}:${originalPath || ''}`;
      process.env.TMUX = '1';
      delete process.env.TMUX_PANE;
      process.env.OMX_TEAM_WORKER = '';

      const paneId = await resolveManagedPaneFromAnchor('%42', cwd, { session_id: sessionId }, { allowTeamWorker: false });
      assert.equal(paneId, '%55');
    } finally {
      process.env.PATH = originalPath;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed when a degraded anchor has no live codex sibling in the managed session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-managed-degraded-anchor-no-live-sibling-'));
    const originalPath = process.env.PATH;
    try {
      const stateDir = join(cwd, '.omx', 'state');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const sessionId = 'omx-degraded-anchor-no-live-sibling';
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);

      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        started_at: new Date().toISOString(),
        cwd,
        pid: process.pid,
        platform: process.platform,
        pid_start_ticks: readLinuxStartTicks(process.pid),
        pid_cmdline: readLinuxCmdline(process.pid),
      }, null, 2));

      const fakeTmux = `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ -z "$target" && "$format" == "#S" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%42" ]]; then
    echo "bash"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%42" ]]; then
    echo "codex --model gpt-5"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%42" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  echo "unsupported display target: $target / $format" >&2
  exit 1
fi
if [[ "$cmd" == "list-panes" ]]; then
  target=""
  while (($#)); do
    case "$1" in
      -s) shift ;;
      -t) target="$2"; shift 2 ;;
      -F) shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ "$target" == "${managedSessionName}" ]]; then
    printf "%%42\\t1\\tbash\\tcodex --model gpt-5\\n%%55\\t0\\tbash\\tbash\\n"
    exit 0
  fi
  echo "unexpected list-panes target: $target" >&2
  exit 1
fi
echo "unsupported cmd: $cmd" >&2
exit 1
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      process.env.PATH = `${fakeBinDir}:${originalPath || ''}`;
      process.env.TMUX = '1';
      delete process.env.TMUX_PANE;
      process.env.OMX_TEAM_WORKER = '';

      const paneId = await resolveManagedPaneFromAnchor('%42', cwd, { session_id: sessionId }, { allowTeamWorker: false });
      assert.equal(paneId, '');
    } finally {
      process.env.PATH = originalPath;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps a verified live anchor when command-state lookup fails and another codex pane is active', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-managed-anchor-lookup-failure-'));
    const originalPath = process.env.PATH;
    try {
      const stateDir = join(cwd, '.omx', 'state');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const sessionId = 'omx-anchor-lookup-failure';
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);

      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        started_at: new Date().toISOString(),
        cwd,
        pid: process.pid,
        platform: process.platform,
        pid_start_ticks: readLinuxStartTicks(process.pid),
        pid_cmdline: readLinuxCmdline(process.pid),
      }, null, 2));

      const fakeTmux = `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ -z "$target" && "$format" == "#S" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%42" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  if [[ "$target" == "%42" && ( "$format" == "#{pane_current_command}" || "$format" == "#{pane_start_command}" ) ]]; then
    echo "transient lookup failure" >&2
    exit 1
  fi
  echo "unsupported display target: $target / $format" >&2
  exit 1
fi
if [[ "$cmd" == "list-panes" ]]; then
  target=""
  while (($#)); do
    case "$1" in
      -s) shift ;;
      -t) target="$2"; shift 2 ;;
      -F) shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ "$target" == "${managedSessionName}" ]]; then
    printf "%%42\\t0\\tcodex\\tcodex\\n%%55\\t1\\tcodex\\tcodex\\n"
    exit 0
  fi
  echo "unexpected list-panes target: $target" >&2
  exit 1
fi
echo "unsupported cmd: $cmd" >&2
exit 1
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      process.env.PATH = `${fakeBinDir}:${originalPath || ''}`;
      process.env.TMUX = '1';
      delete process.env.TMUX_PANE;
      process.env.OMX_TEAM_WORKER = '';

      const paneId = await resolveManagedPaneFromAnchor('%42', cwd, { session_id: sessionId }, { allowTeamWorker: false });
      assert.equal(paneId, '%42');
    } finally {
      process.env.PATH = originalPath;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
