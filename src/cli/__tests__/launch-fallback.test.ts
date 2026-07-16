import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUD_TMUX_HEIGHT_LINES } from '../../hud/constants.js';
import { DETACHED_TMUX_HISTORY_LIMIT } from '../index.js';

const CLI_SPAWN_TIMEOUT_MS = 60_000;

function buildRunOmxEnv(envOverrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('OMX_') ||
      key.startsWith('CODEX_') ||
      key === 'TMUX' ||
      key === 'TMUX_PANE' ||
      key === 'NODE_OPTIONS' ||
      key === 'NODE_TEST_CONTEXT'
    ) {
      delete env[key];
    }
  }
  return {
    ...env,
    ...envOverrides,
  };
}

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');
  const result = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    timeout: CLI_SPAWN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: buildRunOmxEnv(envOverrides),
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || '',
  };
}


function normalizeDarwinTmpPath(value: string): string {
  return process.platform === 'darwin' ? value.replaceAll('/private/var/', '/var/') : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shouldSkipForSpawnPermissions(err: string): boolean {
  return typeof err === 'string' && /(EPERM|EACCES)/i.test(err);
}


async function createGitRepo(wd: string): Promise<string> {
  const repo = join(wd, 'repo');
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' });
  await writeFile(join(repo, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

async function createLaunchFixture(
  wd: string,
  tmuxScript: (tmuxLogPath: string) => string,
): Promise<{ env: Record<string, string>; tmuxLogPath: string }> {
  const home = join(wd, 'home');
  const fakeBin = join(wd, 'bin');
  const tmuxLogPath = join(wd, 'tmux.log');

  await mkdir(home, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeExecutable(
    join(fakeBin, 'codex'),
    '#!/bin/sh\nprintf \'fake-codex:%s\\n\' "$*"\n',
  );
  await writeExecutable(join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n');
  await writeExecutable(join(fakeBin, 'tmux'), tmuxScript(tmuxLogPath));

  return {
    tmuxLogPath,
    env: {
      HOME: home,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      OMX_AUTO_UPDATE: '0',
      OMX_NOTIFY_FALLBACK: '0',
      OMX_HOOK_DERIVED_SIGNALS: '0',
      OMX_ROOT: '',
      OMX_STATE_ROOT: '',
      OMXBOX_ACTIVE: '',
      OMX_SOURCE_CWD: '',
      OMX_MADMAX_DETACHED_CONTEXT: '',
    },
  };
}

describe('omx launch fallback when tmux is unavailable', () => {
  it('surfaces direct Codex startup stderr and preserves the child exit code', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-child-error-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeExecutable(
        join(fakeBin, 'codex'),
        `#!/bin/sh
printf 'codex-startup-boom\\n' >&2
exit 42
`,
      );
      await writeExecutable(join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n');

      const result = runOmx(wd, ['--direct', '--version'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
        TMUX: '',
        TMUX_PANE: '',
      });

      if (shouldSkipForSpawnPermissions(result.error)) return;

      assert.equal(result.status, 42, result.error || result.stderr || result.stdout);
      assert.match(result.stderr, /codex-startup-boom/);
      assert.match(result.stderr, /\[omx\] codex exited with code 42/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('reports a missing Codex executable instead of exiting silently', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-missing-codex-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeExecutable(join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n');

      const result = runOmx(wd, ['--direct', '--version'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
        TMUX: '',
        TMUX_PANE: '',
      });

      if (shouldSkipForSpawnPermissions(result.error)) return;

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /failed to launch codex: executable not found in PATH/);
      assert.notEqual(result.stderr.trim(), '');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('launches codex directly without tmux ENOENT noise', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-fallback-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        fakeCodexPath,
        '#!/bin/sh\nprintf \'fake-codex:%s\\n\' \"$*\"\n',
      );
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(
        wd,
        ['--xhigh', '--madmax'],
        {
          HOME: home,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
        },
      );

      if (shouldSkipForSpawnPermissions(result.error)) return;

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:.*--dangerously-bypass-approvals-and-sandbox/);
      assert.match(result.stdout, /fake-codex:.*model_reasoning_effort="xhigh"/);
      assert.doesNotMatch(result.stderr, /spawnSync tmux ENOENT/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('omx --worktree disposable state root', () => {
  it('keeps launch worktree state under the source repo root by default', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-worktree-state-'));
    try {
      const repo = await createGitRepo(wd);
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeExecutable(
        join(fakeBin, 'codex'),
        `#!/bin/sh
printf 'fake-codex-omx-root:%s\n' "$OMX_ROOT"
printf 'fake-codex:%s\n' "$*"
`,
      );
      await writeExecutable(join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n');

      const result = runOmx(repo, ['--direct', '--worktree', '--version'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
        OMX_ROOT: '',
        OMX_STATE_ROOT: '',
        TMUX: '',
        TMUX_PANE: '',
      });

      if (shouldSkipForSpawnPermissions(result.error)) return;

      const worktreePath = join(dirname(repo), `${basename(repo)}.omx-worktrees`, 'launch-detached');
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(
        normalizeDarwinTmpPath(result.stdout),
        new RegExp(`fake-codex-omx-root:${escapeRegExp(normalizeDarwinTmpPath(repo))}`),
      );
      assert.equal(existsSync(join(repo, '.omx', 'state')), true);
      assert.equal(existsSync(join(worktreePath, '.omx')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves explicit OMX_ROOT for launch worktree state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-worktree-explicit-root-'));
    try {
      const repo = await createGitRepo(wd);
      const explicitRoot = join(wd, 'explicit-root');
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeExecutable(
        join(fakeBin, 'codex'),
        `#!/bin/sh
printf 'fake-codex-omx-root:%s\n' "$OMX_ROOT"
printf 'fake-codex:%s\n' "$*"
`,
      );
      await writeExecutable(join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n');

      const result = runOmx(repo, ['--direct', '--worktree', '--version'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
        OMX_ROOT: explicitRoot,
        OMX_STATE_ROOT: '',
        TMUX: '',
        TMUX_PANE: '',
      });

      if (shouldSkipForSpawnPermissions(result.error)) return;

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, new RegExp(`fake-codex-omx-root:${escapeRegExp(explicitRoot)}`));
      assert.equal(existsSync(join(explicitRoot, '.omx', 'state')), true);
      assert.equal(existsSync(join(repo, '.omx')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps direct madmax worktree launches bound to the boxed run root', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-madmax-worktree-root-'));
    try {
      const repo = await createGitRepo(wd);
      const runs = join(wd, 'runs');
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeExecutable(
        join(fakeBin, 'codex'),
        `#!/bin/sh
printf 'fake-codex-pwd:%s\n' "$PWD"
printf 'fake-codex-omx-root:%s\n' "$OMX_ROOT"
printf 'fake-codex-box:%s\n' "$OMXBOX_ACTIVE"
printf 'fake-codex-source:%s\n' "$OMX_SOURCE_CWD"
printf 'fake-codex-context:%s\n' "$OMX_MADMAX_DETACHED_CONTEXT"
printf 'fake-codex:%s\n' "$*"
`,
      );
      await writeExecutable(join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n');

      const result = runOmx(repo, ['--direct', '--madmax', '--worktree', '--version'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
        OMX_RUNS_DIR: runs,
        OMX_ROOT: '',
        OMX_STATE_ROOT: '',
        TMUX: '',
        TMUX_PANE: '',
      });

      if (shouldSkipForSpawnPermissions(result.error)) return;

      const worktreePath = join(dirname(repo), `${basename(repo)}.omx-worktrees`, 'launch-detached');
      const normalizedStdout = normalizeDarwinTmpPath(result.stdout);
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(
        normalizedStdout,
        new RegExp(`fake-codex-pwd:${escapeRegExp(normalizeDarwinTmpPath(worktreePath))}`),
      );
      const rootMatch = normalizedStdout.match(/fake-codex-omx-root:(.*)/);
      assert.ok(rootMatch, normalizedStdout);
      const boxedRoot = rootMatch[1];
      assert.match(boxedRoot, new RegExp(`^${escapeRegExp(normalizeDarwinTmpPath(runs))}/run-`));
      assert.notEqual(boxedRoot, normalizeDarwinTmpPath(repo));
      assert.notEqual(boxedRoot, normalizeDarwinTmpPath(worktreePath));
      assert.match(normalizedStdout, /fake-codex-box:1/);
      assert.match(
        normalizedStdout,
        new RegExp(`fake-codex-source:${escapeRegExp(normalizeDarwinTmpPath(repo))}`),
      );
      assert.match(normalizedStdout, /fake-codex-context:[0-9a-f]{32}/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('Hermes MCP tmux bridge launch', () => {
  it('creates a detached tmux session without attach-session under OMX_HERMES_MCP_BRIDGE', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-hermes-bridge-'));
    try {
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (logPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${logPath}"
case "$1" in
  -V|list-sessions)
    printf 'tmux 3.4\n'
    exit 0
    ;;
  has-session)
    exit 1
    ;;
  new-session)
    printf '%%12\n'
    exit 0
    ;;
  split-window)
    printf 'hud-pane\n'
    exit 0
    ;;
  display-message)
    if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\n'
    else
      printf '0\n'
    fi
    exit 0
    ;;
  show-options)
    printf 'off\n'
    exit 0
    ;;
  set-option|set-hook|kill-session|run-shell|resize-pane)
    exit 0
    ;;
  attach-session)
    printf 'attach must not be called for Hermes MCP bridge\n' >&2
    exit 99
    ;;
esac
exit 0
`,
      );

      const result = runOmx(wd, ['--tmux', 'bridge prompt'], {
        ...env,
        OMX_HERMES_MCP_BRIDGE: '1',
        TMUX: '',
        TMUX_PANE: '',
      });

      if (shouldSkipForSpawnPermissions(result.error)) return;

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(tmuxLog, /tmux:new-session /);
      assert.match(tmuxLog, /tmux:split-window /);
      assert.doesNotMatch(tmuxLog, /tmux:attach-session/);
      assert.doesNotMatch(result.stderr, /failed to attach detached tmux session/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('omx launcher when tmux is available', () => {
  it('reuses the same boxed madmax detached launch context instead of spawning duplicate tmux sessions', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-madmax-reuse-'));
    try {
      const runs = join(wd, 'runs');
      const activeMarker = join(wd, 'active-session');
      const instanceMarker = join(wd, 'active-instance');
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (logPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${logPath}"
case "$1" in
  -V)
    printf 'tmux 3.4\n'
    exit 0
    ;;
  has-session)
    test -f "${activeMarker}"
    exit $?
    ;;
  new-session)
    prev=''
    for arg in "$@"; do
      if [ "$prev" = '-s' ]; then printf '%s\n' "$arg" > "${activeMarker}"; fi
      prev="$arg"
    done
    printf '%%12\n'
    exit 0
    ;;
  split-window)
    printf 'hud-pane\n'
    exit 0
    ;;
  display-message)
    if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\n'
    elif [ "$2" = '-p' ] && [ "$5" = '#{session_name}' ]; then
      cat "${activeMarker}"
    elif [ "$2" = '-p' ] && [ "$5" = '#{session_attached}' ]; then
      printf '1\n'
    else
      printf '0\n'
    fi
    exit 0
    ;;
  show-options)
    if [ "$5" = '@omx_instance_id' ]; then
      cat "${instanceMarker}"
      exit 0
    fi
    printf 'off\n'
    exit 0
    ;;
  set-option)
    if [ "$4" = '@omx_instance_id' ]; then
      printf '%s\n' "$5" > "${instanceMarker}"
    fi
    exit 0
    ;;
  set-hook|attach-session|kill-session|run-shell|resize-pane)
    exit 0
    ;;
esac
exit 0
`,
      );

      const baseEnv = {
        ...env,
        OMX_RUNS_DIR: runs,
        OMXBOX_ACTIVE: '1',
        OMX_MADMAX_DETACHED_CONTEXT: 'boxed-context-under-test',
        OMX_LAUNCH_POLICY: 'direct',
        TMUX: '',
        TMUX_PANE: '',
      };
      const first = runOmx(wd, ['--madmax', '--tmux'], baseEnv);
      if (shouldSkipForSpawnPermissions(first.error)) return;
      assert.equal(first.status, 0, first.error || first.stderr || first.stdout);

      const second = runOmx(wd, ['--madmax', '--tmux'], baseEnv);
      if (shouldSkipForSpawnPermissions(second.error)) return;
      assert.equal(second.status, 0, second.error || second.stderr || second.stdout);
      assert.match(
        second.stderr,
        /madmax detached launch already active for this context; attaching .* instead of starting a duplicate/,
      );

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal((tmuxLog.match(/tmux:new-session/g) || []).length, 1);
      assert.equal((tmuxLog.match(/tmux:has-session/g) || []).length, 1);
      assert.equal((tmuxLog.match(/tmux:attach-session/g) || []).length, 2);
      const activeRecords = await readFile(
        join(runs, 'active-detached', 'boxed-context-under-test.json'),
        'utf-8',
      );
      assert.match(activeRecords, /"tmux_session_name"/);
      assert.match(activeRecords, /"session_id"/);
      assert.match(activeRecords, /"tmux_pane_id": "%12"/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('records boxed runtime identity for detached madmax worktree launches', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-madmax-worktree-detached-'));
    try {
      const repo = await createGitRepo(wd);
      const runs = join(wd, 'runs');
      const instanceMarker = join(wd, 'active-instance');
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (logPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${logPath}"
case "$1" in
  -V)
    printf 'tmux 3.4\n'
    exit 0
    ;;
  has-session)
    exit 1
    ;;
  new-session)
    printf '%%77\n'
    exit 0
    ;;
  split-window)
    printf '%%78\n'
    exit 0
    ;;
  display-message)
    if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\n'
    elif [ "$2" = '-p' ] && [ "$5" = '#{session_name}' ]; then
      printf 'detached-session\n'
    elif [ "$2" = '-p' ] && [ "$5" = '#{session_attached}' ]; then
      printf '1\n'
    else
      printf '0\n'
    fi
    exit 0
    ;;
  show-options)
    if [ "$5" = '@omx_instance_id' ] && [ -f "${instanceMarker}" ]; then
      cat "${instanceMarker}"
      exit 0
    fi
    printf 'off\n'
    exit 0
    ;;
  set-option)
    if [ "$4" = '@omx_instance_id' ]; then
      printf '%s\n' "$5" > "${instanceMarker}"
    fi
    exit 0
    ;;
  set-hook|attach-session|kill-session|run-shell|resize-pane)
    exit 0
    ;;
esac
exit 0
`,
      );

      const result = runOmx(repo, ['--madmax', '--worktree', '--tmux'], {
        ...env,
        OMX_RUNS_DIR: runs,
        TMUX: '',
        TMUX_PANE: '',
      });
      if (shouldSkipForSpawnPermissions(result.error)) return;
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);

      const activeFiles = await readdir(join(runs, 'active-detached'));
      assert.equal(activeFiles.length, 1);
      const activeRecord = JSON.parse(await readFile(join(runs, 'active-detached', activeFiles[0]), 'utf-8'));
      const worktreePath = join(dirname(repo), `${basename(repo)}.omx-worktrees`, 'launch-detached');
      assert.match(activeRecord.run_dir, new RegExp(`^${escapeRegExp(normalizeDarwinTmpPath(runs))}/run-`));
      assert.equal(normalizeDarwinTmpPath(activeRecord.source_cwd), normalizeDarwinTmpPath(repo));
      assert.equal(normalizeDarwinTmpPath(activeRecord.worktree_cwd), normalizeDarwinTmpPath(worktreePath));
      assert.equal(activeRecord.session_id.startsWith('omx-'), true);
      assert.equal(activeRecord.tmux_pane_id, '%77');

      const tmuxLog = normalizeDarwinTmpPath(await readFile(tmuxLogPath, 'utf-8'));
      assert.match(tmuxLog, new RegExp(`-e OMX_ROOT=${escapeRegExp(normalizeDarwinTmpPath(activeRecord.run_dir))}`));
      assert.match(tmuxLog, /-e OMXBOX_ACTIVE=1/);
      assert.match(tmuxLog, new RegExp(`-e OMX_SOURCE_CWD=${escapeRegExp(normalizeDarwinTmpPath(repo))}`));
      assert.match(tmuxLog, new RegExp(`-e OMX_MADMAX_DETACHED_CONTEXT=${escapeRegExp(activeRecord.context_key)}`));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not mutate a stale active-detached tmux session without OMX ownership proof', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-madmax-stale-active-'));
    try {
      const runs = join(wd, 'runs');
      const activeDir = join(runs, 'active-detached');
      await mkdir(activeDir, { recursive: true });
      await writeFile(
        join(activeDir, 'boxed-context-under-test.json'),
        `${JSON.stringify({
          version: 1,
          context_key: 'boxed-context-under-test',
          created_at: new Date().toISOString(),
          source_cwd: wd,
          argv: ['--madmax', '--tmux'],
          run_dir: wd,
          tmux_session_name: 'user-owned-session',
          session_id: 'expected-omx-session-id',
          tmux_pane_id: '%99',
        })}\n`,
      );
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (logPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${logPath}"
case "$1" in
  -V)
    printf 'tmux 3.4\n'
    exit 0
    ;;
  has-session)
    exit 0
    ;;
  new-session)
    printf '%%12\n'
    exit 0
    ;;
  split-window)
    printf 'hud-pane\n'
    exit 0
    ;;
  display-message)
    if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\n'
    elif [ "$2" = '-p' ] && [ "$5" = '#{session_name}' ]; then
      printf 'user-owned-session\n'
    else
      printf '0\n'
    fi
    exit 0
    ;;
  show-options)
    if [ "$5" = '@omx_instance_id' ]; then
      printf 'different-session-id\n'
      exit 0
    fi
    printf 'off\n'
    exit 0
    ;;
  set-option|set-hook|attach-session|kill-session|run-shell|resize-pane)
    exit 0
    ;;
esac
exit 0
`,
      );

      const result = runOmx(wd, ['--madmax', '--tmux'], {
        ...env,
        OMX_RUNS_DIR: runs,
        OMXBOX_ACTIVE: '1',
        OMX_MADMAX_DETACHED_CONTEXT: 'boxed-context-under-test',
        OMX_LAUNCH_POLICY: 'direct',
        TMUX: '',
        TMUX_PANE: '',
      });

      if (shouldSkipForSpawnPermissions(result.error)) return;
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(tmuxLog, /tmux:set-option .* -t user-owned-session .*history-limit/);
      assert.doesNotMatch(tmuxLog, /tmux:clear-history .*user-owned-session|tmux:clear-history .*%99/);
      assert.match(tmuxLog, /tmux:new-session /);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not reuse the same active-detached lock for independent --madmax --high launches', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-madmax-independent-high-'));
    try {
      const runs = join(wd, 'runs');
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (logPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${logPath}"
case "$1" in
  -V) printf 'tmux 3.4\n'; exit 0 ;;
  has-session) exit 1 ;;
  new-session) printf '%%12\n'; exit 0 ;;
  split-window) printf 'hud-pane\n'; exit 0 ;;
  display-message) if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then printf '/tmp/tmux-test.sock\n'; else printf '0\n'; fi; exit 0 ;;
  show-options) printf 'off\n'; exit 0 ;;
  set-option|set-hook|attach-session|kill-session|run-shell|resize-pane) exit 0 ;;
esac
exit 0
`,
      );
      const baseEnv = {
        ...env,
        OMX_RUNS_DIR: runs,
        OMX_LAUNCH_POLICY: 'direct',
        TMUX: '',
        TMUX_PANE: '',
      };

      const first = runOmx(wd, ['--madmax', '--high', '--tmux'], baseEnv);
      const second = runOmx(wd, ['--madmax', '--high', '--tmux'], baseEnv);
      if (shouldSkipForSpawnPermissions(first.error) || shouldSkipForSpawnPermissions(second.error)) return;
      assert.equal(first.status, 0, first.error || first.stderr || first.stdout);
      assert.equal(second.status, 0, second.error || second.stderr || second.stdout);
      assert.doesNotMatch(first.stderr + second.stderr, /timed out waiting for madmax detached launch context lock/);
      assert.doesNotMatch(second.stderr, /madmax detached launch already active for this context/);

      const registryEntries = (await readFile(join(runs, 'registry.jsonl'), 'utf-8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { detached_launch_context: string });
      assert.equal(registryEntries.length, 2);
      assert.notEqual(
        registryEntries[0]!.detached_launch_context,
        registryEntries[1]!.detached_launch_context,
        'independent launches must get distinct active-detached lock identities',
      );
      assert.equal(
        existsSync(join(runs, 'active-detached', `${registryEntries[0]!.detached_launch_context}.json`)),
        true,
      );
      assert.equal(
        existsSync(join(runs, 'active-detached', `${registryEntries[1]!.detached_launch_context}.json`)),
        true,
      );

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal((tmuxLog.match(/tmux:new-session/g) || []).length, 2);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows distinct madmax detached launch contexts to create separate sessions', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-madmax-distinct-'));
    try {
      const runs = join(wd, 'runs');
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (logPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${logPath}"
case "$1" in
  -V) printf 'tmux 3.4\n'; exit 0 ;;
  has-session) exit 1 ;;
  new-session) printf '%%12\n'; exit 0 ;;
  split-window) printf 'hud-pane\n'; exit 0 ;;
  display-message) if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then printf '/tmp/tmux-test.sock\n'; else printf '0\n'; fi; exit 0 ;;
  show-options) printf 'off\n'; exit 0 ;;
  set-option|set-hook|attach-session|kill-session|run-shell|resize-pane) exit 0 ;;
esac
exit 0
`,
      );
      const baseEnv = {
        ...env,
        OMX_RUNS_DIR: runs,
        OMX_LAUNCH_POLICY: 'direct',
        TMUX: '',
        TMUX_PANE: '',
      };
      const first = runOmx(wd, ['--madmax', '--tmux'], baseEnv);
      const second = runOmx(wd, ['--madmax', '--xhigh', '--tmux'], baseEnv);
      if (shouldSkipForSpawnPermissions(first.error) || shouldSkipForSpawnPermissions(second.error)) return;
      assert.equal(first.status, 0, first.error || first.stderr || first.stdout);
      assert.equal(second.status, 0, second.error || second.stderr || second.stdout);
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal((tmuxLog.match(/tmux:new-session/g) || []).length, 2);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('launches --madmax through explicitly requested detached tmux so HUD bootstrap can run', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-tmux-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const fakeTmuxPath = join(fakeBin, 'tmux');
      const tmuxLogPath = join(wd, 'tmux.log');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        fakeCodexPath,
        '#!/bin/sh\nprintf \'fake-codex:%s\\n\' \"$*\"\n',
      );
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);
      await writeFile(
        fakeTmuxPath,
        `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    printf 'tmux 3.4\\n'
    exit 0
    ;;
  new-session)
    printf '%%12\n'
    exit 0
    ;;
  split-window)
    printf 'hud-pane\\n'
    exit 0
    ;;
  display-message)
    if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\\n'
    else
      printf '0\\n'
    fi
    exit 0
    ;;
  show-options)
    printf 'off\\n'
    exit 0
    ;;
  set-option|set-hook|attach-session|kill-session|run-shell|resize-pane)
    exit 0
    ;;
esac
exit 0
`,
      );
      await chmod(fakeTmuxPath, 0o755);

      const result = runOmx(
        wd,
        ['--madmax', '--tmux'],
        {
          HOME: home,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
          OMX_LAUNCH_POLICY: 'direct',
          TMUX: '',
          TMUX_PANE: '',
        },
      );

      if (shouldSkipForSpawnPermissions(result.error)) return;

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(tmuxLog, /tmux:show-options -gv history-limit/);
      assert.doesNotMatch(tmuxLog, /tmux:set-option -g[q ]+history-limit/);
      assert.match(tmuxLog, /tmux:new-session .* -s /);
      assert.match(tmuxLog, new RegExp(`tmux:set-option -q -t .* history-limit ${DETACHED_TMUX_HISTORY_LIMIT}`));
      assert.match(tmuxLog, new RegExp(`tmux:set-option -pq -t %12 history-limit ${DETACHED_TMUX_HISTORY_LIMIT}`));
      assert.match(
        tmuxLog,
        /tmux:set-hook -t .* client-detached\[[0-9]+\] if-shell -F '#\{==:#\{session_attached\},0\}' 'run-shell -b "tmux clear-history -t %12 >\/dev\/null 2>&1 \|\| true"'/,
      );
      assert.match(tmuxLog, new RegExp(`tmux:split-window -v -l ${HUD_TMUX_HEIGHT_LINES} .* -t `));
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves parent provider env without replaying terminal state over an OMX-created tmux pane', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-tmux-parent-env-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const envLogPath = join(wd, 'codex-env.log');
      const tmuxLogPath = join(wd, 'tmux.log');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeExecutable(
        join(fakeBin, 'codex'),
        `#!/bin/sh
{
  printf 'custom=%s\n' "$CUSTOM_LLM_API_KEY"
  printf 'marker=%s\n' "$IS_GAJAE_SLOP_GENERATOR"
  printf 'term=%s\n' "$TERM"
  printf 'term_program=%s\n' "$TERM_PROGRAM"
  printf 'term_program_version=%s\n' "$TERM_PROGRAM_VERSION"
  printf 'colorterm=%s\n' "$COLORTERM"
  printf 'tmux=%s\n' "$TMUX"
  printf 'tmux_pane=%s\n' "$TMUX_PANE"
  printf 'columns=%s\n' "\${COLUMNS-unset}"
  printf 'lines=%s\n' "\${LINES-unset}"
  printf 'terminfo=%s\n' "\${TERMINFO-unset}"
  printf 'terminfo_dirs=%s\n' "\${TERMINFO_DIRS-unset}"
  printf 'termcap=%s\n' "\${TERMCAP-unset}"
} > "${envLogPath}"
exit 130
`,
      );
      await writeExecutable(join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n');
      await writeExecutable(
        join(fakeBin, 'tmux'),
        `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    printf 'tmux 3.4\\n'
    exit 0
    ;;
  new-session)
    last=''
    for arg in "$@"; do last="$arg"; done
    env -u COLORTERM \
      TERM=tmux-256color \
      TERM_PROGRAM=tmux \
      TERM_PROGRAM_VERSION=3.4 \
      TMUX=/tmp/tmux-test.sock,123,0 \
      TMUX_PANE=%12 \
      COLUMNS=211 \
      LINES=77 \
      TERMINFO=/tmp/server-terminfo \
      TERMINFO_DIRS=/tmp/server-terminfo-dirs \
      TERMCAP=server-termcap \
      sh -c "$last" >/dev/null 2>&1 || true
    printf 'leader-pane\\n'
    exit 0
    ;;
  split-window)
    printf 'hud-pane\\n'
    exit 0
    ;;
  display-message)
    if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\\n'
    else
      printf '0\\n'
    fi
    exit 0
    ;;
  show-options)
    printf 'off\\n'
    exit 0
    ;;
  set-option|set-hook|attach-session|kill-session|run-shell|resize-pane)
    exit 0
    ;;
esac
exit 0
`,
      );

      const result = runOmx(
        wd,
        ['--tmux', '--madmax'],
        {
          HOME: home,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
          TERM: 'xterm-256color',
          TERM_PROGRAM: 'WarpTerminal',
          TERM_PROGRAM_VERSION: 'outer-terminal-version',
          TERMINFO: '/tmp/outer-terminfo',
          TERMINFO_DIRS: '/tmp/outer-terminfo-dirs',
          TERMCAP: 'outer-termcap',
          COLORTERM: 'truecolor',
          COLUMNS: '200',
          LINES: '60',
          TMUX: '',
          TMUX_PANE: '',
          CUSTOM_LLM_API_KEY: 'fake-provider-key',
          IS_GAJAE_SLOP_GENERATOR: '1',
        },
      );

      if (shouldSkipForSpawnPermissions(result.error)) return;

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.equal(
        await readFile(envLogPath, 'utf-8'),
        [
          'custom=fake-provider-key',
          'marker=1',
          'term=tmux-256color',
          'term_program=tmux',
          'term_program_version=3.4',
          'colorterm=truecolor',
          'tmux=/tmp/tmux-test.sock,123,0',
          'tmux_pane=%12',
          'columns=211',
          'lines=77',
          'terminfo=/tmp/outer-terminfo',
          'terminfo_dirs=/tmp/outer-terminfo-dirs',
          'termcap=outer-termcap',
          '',
        ].join('\n'),
      );
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(tmuxLog, /fake-provider-key/);
      assert.doesNotMatch(tmuxLog, /CUSTOM_LLM_API_KEY=/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('launches directly with --direct and skips detached tmux bootstrap', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-direct-'));
    try {
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (tmuxLogPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V|list-sessions)
    exit 0
    ;;
esac
exit 0
`,
      );

      const result = runOmx(
        wd,
        ['--direct', '--madmax'],
        {
          ...env,
          TMUX: '',
          TMUX_PANE: '',
        },
      );

      if (shouldSkipForSpawnPermissions(result.error)) return;

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:.*--dangerously-bypass-approvals-and-sandbox/);
      assert.doesNotMatch(tmuxLog, /new-session|split-window|attach-session/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('launches directly from OMX_LAUNCH_POLICY=direct and skips detached tmux bootstrap', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-env-direct-'));
    try {
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (tmuxLogPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
exit 0
`,
      );

      const result = runOmx(
        wd,
        ['--madmax'],
        {
          ...env,
          OMX_LAUNCH_POLICY: 'direct',
          TMUX: '',
          TMUX_PANE: '',
        },
      );

      if (shouldSkipForSpawnPermissions(result.error)) return;

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:.*--dangerously-bypass-approvals-and-sandbox/);
      assert.doesNotMatch(tmuxLog, /new-session|split-window|attach-session/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('launches directly inside tmux with --direct and skips HUD/mouse/extended-key tmux calls', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-inside-tmux-direct-'));
    try {
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (tmuxLogPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
exit 0
`,
      );

      const result = runOmx(
        wd,
        ['--direct', '--madmax'],
        {
          ...env,
          TMUX: '/tmp/tmux-1000/default,123,0',
          TMUX_PANE: '%1',
        },
      );

      if (shouldSkipForSpawnPermissions(result.error)) return;

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:.*--dangerously-bypass-approvals-and-sandbox/);
      assert.doesNotMatch(tmuxLog, /split-window|show-options|extended-keys|mouse on/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves HUD split behavior inside tmux when no direct override is present', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-inside-tmux-managed-'));
    try {
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (tmuxLogPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  list-panes)
    exit 0
    ;;
  split-window)
    printf '%s\n' '%hud'
    exit 0
    ;;
  display-message)
    case "$*" in
      *'#{socket_path}'*) printf '/tmp/tmux-test.sock\n' ;;
      *'#S'*) printf 'managed-session\n' ;;
      *) printf '0\n' ;;
    esac
    exit 0
    ;;
  show-options)
    printf 'off\n'
    exit 0
    ;;
  set-option|kill-pane)
    exit 0
    ;;
esac
exit 0
`,
      );

      const result = runOmx(
        wd,
        ['--madmax'],
        {
          ...env,
          TMUX: '/tmp/tmux-1000/default,123,0',
          TMUX_PANE: '%1',
        },
      );

      if (shouldSkipForSpawnPermissions(result.error)) return;

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:.*--dangerously-bypass-approvals-and-sandbox/);
      assert.match(tmuxLog, new RegExp(`tmux:split-window -v -l ${HUD_TMUX_HEIGHT_LINES}`));
      assert.match(tmuxLog, /tmux:set-option -t managed-session mouse on/);
      assert.match(tmuxLog, /tmux:set-option -sq extended-keys always/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('treats a missing tmux server socket as safe for detached tmux startup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-tmux-missing-socket-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const fakeTmuxPath = join(fakeBin, 'tmux');
      const tmuxLogPath = join(wd, 'tmux.log');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        fakeCodexPath,
        '#!/bin/sh\nprintf \'fake-codex:%s\\n\' "$*"\n',
      );
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);
      await writeFile(
        fakeTmuxPath,
        `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    printf 'tmux 3.6a\n'
    exit 0
    ;;
  list-sessions)
    printf 'error connecting to /private/tmp/tmux-501/default (No such file or directory)\n' >&2
    exit 1
    ;;
  new-session)
    printf 'leader-pane\n'
    exit 0
    ;;
  split-window)
    printf 'hud-pane\n'
    exit 0
    ;;
  display-message)
    if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\n'
    else
      printf '0\n'
    fi
    exit 0
    ;;
  show-options)
    printf 'off\n'
    exit 0
    ;;
  set-option|set-hook|attach-session|kill-session|run-shell|resize-pane|select-pane)
    exit 0
    ;;
esac
exit 0
`,
      );
      await chmod(fakeTmuxPath, 0o755);

      const result = runOmx(
        wd,
        ['--madmax', '--tmux'],
        {
          HOME: home,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
          TMUX: '',
          TMUX_PANE: '',
        },
      );

      if (shouldSkipForSpawnPermissions(result.error)) return;

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(tmuxLog, /tmux:list-sessions/);
      assert.match(tmuxLog, /tmux:new-session .* -s /);
      assert.doesNotMatch(result.stderr, /server\/socket is unusable/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('falls back directly when tmux is installed but the server socket is unusable', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-tmux-stale-socket-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const fakeTmuxPath = join(fakeBin, 'tmux');
      const tmuxLogPath = join(wd, 'tmux.log');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        fakeCodexPath,
        '#!/bin/sh\nprintf \'fake-codex:%s\\n\' "$*"\n',
      );
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);
      await writeFile(
        fakeTmuxPath,
        `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    printf 'tmux 3.6a\n'
    exit 0
    ;;
  list-sessions)
    printf 'error connecting to /tmp/tmux-1000/default (Operation not permitted)\n' >&2
    exit 1
    ;;
esac
printf 'unexpected tmux command: %s\n' "$*" >&2
exit 1
`,
      );
      await chmod(fakeTmuxPath, 0o755);

      const result = runOmx(
        wd,
        ['--madmax', '--tmux'],
        {
          HOME: home,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
          TMUX: '',
          TMUX_PANE: '',
        },
      );

      if (shouldSkipForSpawnPermissions(result.error)) return;

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:.*--dangerously-bypass-approvals-and-sandbox/);
      assert.match(result.stderr, /server\/socket is unusable/);
      assert.doesNotMatch(tmuxLog, /new-session|attach-session/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rolls back and falls back directly when attaching the detached tmux session fails', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-tmux-attach-fail-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const fakeTmuxPath = join(fakeBin, 'tmux');
      const tmuxLogPath = join(wd, 'tmux.log');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        fakeCodexPath,
        '#!/bin/sh\nprintf \'fake-codex:%s\\n\' "$*"\n',
      );
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);
      await writeFile(
        fakeTmuxPath,
        `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V|list-sessions)
    exit 0
    ;;
  new-session)
    printf 'leader-pane\n'
    exit 0
    ;;
  split-window)
    printf 'hud-pane\n'
    exit 0
    ;;
  display-message)
    if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\n'
    else
      printf '0\n'
    fi
    exit 0
    ;;
  show-options)
    printf 'off\n'
    exit 0
    ;;
  attach-session)
    printf 'error connecting to /tmp/tmux-1000/default (Operation not permitted)\n' >&2
    exit 1
    ;;
  set-option|set-hook|kill-session|run-shell|resize-pane|select-pane)
    exit 0
    ;;
esac
exit 0
`,
      );
      await chmod(fakeTmuxPath, 0o755);

      const result = runOmx(
        wd,
        ['--madmax', '--tmux'],
        {
          HOME: home,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
          TMUX: '',
          TMUX_PANE: '',
        },
      );

      if (shouldSkipForSpawnPermissions(result.error)) return;

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:.*--dangerously-bypass-approvals-and-sandbox/);
      assert.match(tmuxLog, /tmux:attach-session -t /);
      assert.match(tmuxLog, /tmux:kill-session -t /);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rolls back with guidance when WSL Windows Terminal attach exits without attaching', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-tmux-attach-noop-'));
    try {
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (tmuxLogPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V|list-sessions)
    exit 0
    ;;
  new-session)
    printf 'leader-pane\n'
    exit 0
    ;;
  split-window)
    printf 'hud-pane\n'
    exit 0
    ;;
  display-message)
    if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\n'
    else
      printf '0\n'
    fi
    exit 0
    ;;
  show-options)
    printf 'off\n'
    exit 0
    ;;
  set-option|set-hook|attach-session|kill-session|run-shell|resize-pane|select-pane)
    exit 0
    ;;
esac
exit 0
`,
      );

      const result = runOmx(
        wd,
        ['--madmax', '--tmux'],
        {
          ...env,
          TMUX: '',
          TMUX_PANE: '',
          WSL_DISTRO_NAME: 'Ubuntu',
          WSL_INTEROP: '/run/WSL/1_interop',
          WT_SESSION: 'windows-terminal-session',
        },
      );

      if (shouldSkipForSpawnPermissions(result.error)) return;

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:.*--dangerously-bypass-approvals-and-sandbox/);
      assert.match(result.stderr, /attach-session returned immediately without attaching a client/i);
      assert.match(result.stderr, /Falling back to direct Codex launch/i);
      assert.match(tmuxLog, /tmux:attach-session -t /);
      assert.match(tmuxLog, /tmux:display-message -p -t .* #\{session_attached\}/);
      assert.match(tmuxLog, /tmux:kill-session -t /);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves the requested cwd through detached tmux launch when an unsupported SHELL value falls back away from rc-driven cwd drift', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-tmux-cwd-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const fakeTmuxPath = join(fakeBin, 'tmux');
      const tmuxLogPath = join(wd, 'tmux.log');
      const codexLogPath = join(wd, 'codex.log');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(join(home, '.profile'), 'cd ..\n');
      await writeFile(join(home, '.zshrc'), 'cd ..\n');
      await writeFile(join(home, '.bashrc'), 'cd ..\n');
      await writeFile(
        fakeCodexPath,
        `#!/bin/sh
printf 'codex:%s\\n' "$*" >> "${codexLogPath}"
printf 'codex-pwd:%s\\n' "$(pwd)" >> "${codexLogPath}"
exit 0
`,
      );
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);
      await writeFile(
        fakeTmuxPath,
        `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
cmd="$1"
shift || true
case "$cmd" in
  -V)
    printf 'tmux 3.4\\n'
    exit 0
    ;;
  new-session)
    for last; do :; done
    if [ -n "\${last:-}" ]; then
      /bin/sh -c "$last"
    fi
    printf 'leader-pane\\n'
    exit 0
    ;;
  split-window)
    printf 'hud-pane\\n'
    exit 0
    ;;
  display-message)
    if [ "$1" = '-p' ] && [ "$2" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\\n'
    else
      printf '0\\n'
    fi
    exit 0
    ;;
  show-options)
    printf 'off\\n'
    exit 0
    ;;
  set-option|set-hook|attach-session|kill-session|run-shell|resize-pane|select-pane)
    exit 0
    ;;
esac
exit 0
`,
      );
      await chmod(fakeTmuxPath, 0o755);

      const result = runOmx(
        wd,
        ['--madmax', '--tmux'],
        {
          HOME: home,
          SHELL: '/definitely/missing-shell',
          PATH: `${fakeBin}:/usr/bin:/bin`,
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
          TMUX: '',
          TMUX_PANE: '',
        },
      );

      if (shouldSkipForSpawnPermissions(result.error)) return;

      const codexLog = normalizeDarwinTmpPath(await readFile(codexLogPath, 'utf-8'));
      assert.match(codexLog, /codex:.*--dangerously-bypass-approvals-and-sandbox/);
      assert.match(codexLog, new RegExp(`codex-pwd:${escapeRegExp(normalizeDarwinTmpPath(wd))}`));
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('falls back to /bin/sh for detached tmux launch when SHELL drifts to an unsupported path', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-tmux-shell-fallback-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const fakeTmuxPath = join(fakeBin, 'tmux');
      const tmuxLogPath = join(wd, 'tmux.log');
      const codexLogPath = join(wd, 'codex.log');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(join(home, '.profile'), 'cd ..\n');
      await writeFile(
        fakeCodexPath,
        `#!/bin/sh
printf 'codex:%s\\n' "$*" >> "${codexLogPath}"
printf 'codex-pwd:%s\\n' "$(pwd)" >> "${codexLogPath}"
exit 0
`,
      );
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);
      await writeFile(
        fakeTmuxPath,
        `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
cmd="$1"
shift || true
case "$cmd" in
  -V)
    printf 'tmux 3.4\\n'
    exit 0
    ;;
  new-session)
    for last; do :; done
    if [ -n "\${last:-}" ]; then
      /bin/sh -c "$last"
    fi
    printf 'leader-pane\\n'
    exit 0
    ;;
  split-window)
    printf 'hud-pane\\n'
    exit 0
    ;;
  display-message)
    if [ "$1" = '-p' ] && [ "$2" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\\n'
    else
      printf '0\\n'
    fi
    exit 0
    ;;
  show-options)
    printf 'off\\n'
    exit 0
    ;;
  set-option|set-hook|attach-session|kill-session|run-shell|resize-pane|select-pane)
    exit 0
    ;;
esac
exit 0
`,
      );
      await chmod(fakeTmuxPath, 0o755);

      const result = runOmx(
        wd,
        ['--madmax', '--tmux'],
        {
          HOME: home,
          SHELL: '/bin/not-a-real-shell',
          PATH: `${fakeBin}:/usr/bin:/bin`,
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
          TMUX: '',
          TMUX_PANE: '',
        },
      );

      if (shouldSkipForSpawnPermissions(result.error)) return;

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      const codexLog = normalizeDarwinTmpPath(await readFile(codexLogPath, 'utf-8'));
      assert.match(tmuxLog, /\/bin\/sh/);
      assert.doesNotMatch(tmuxLog, /not-a-real-shell/);
      assert.match(codexLog, /codex:.*--dangerously-bypass-approvals-and-sandbox/);
      assert.match(codexLog, new RegExp(`codex-pwd:${escapeRegExp(normalizeDarwinTmpPath(wd))}`));
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

});
