import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUD_RESIZE_RECONCILE_DELAY_SECONDS, HUD_TMUX_HEIGHT_LINES } from '../../hud/constants.js';
import { DETACHED_TMUX_HISTORY_LIMIT } from '../index.js';
import {
  closeLaunchSessionBindingOnce,
  establishLaunchSessionBinding,
  finalizeBoundOnce,
  writeSessionStart,
  type LaunchSessionBinding,
} from '../../hooks/session.js';
import { isRealTmuxAvailable, withTempTmuxSession } from '../../team/__tests__/tmux-test-fixture.js';

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

function shouldSkipForSpawnPermissions(_err: string): false {
  // These integration fixtures are contractual: EPERM/EACCES is a failure,
  // not a pass. Node's test runner has no portable dynamic skip here.
  return false;
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
async function wrapFakeTmuxWithDetachedLeader(fakeTmuxPath: string): Promise<void> {
  const implementationPath = `${fakeTmuxPath}.impl`;
  await rename(fakeTmuxPath, implementationPath);
  await writeExecutable(fakeTmuxPath, `#!/bin/sh
if [ "$1" = "display-message" ] && [ "$2" = "-p" ] && [ "$3" = "-t" ] && case "$5" in *'#{session_created}'*'#{window_id}'*'#{pane_pid}'*) true;; *) false;; esac; then
  session=$(cat /tmp/omx-test-detached-session-name 2>/dev/null || printf omx-test)
  printf '%s\t$1\t1\t0\t@1\t%s\t123\n' "$session" "$4"
  exit 0
fi
if [ "$1" = "set-option" ] && [ "$2" = "-t" ] && [ "$4" = "@omx_instance_id" ]; then
  printf '%s' "$5" > /tmp/omx-test-detached-owner-id
fi
if [ "$1" = "list-panes" ] && case "$*" in *'#{session_created}'*'#{@omx_instance_id}'*) true;; *) false;; esac; then
  ${JSON.stringify(implementationPath)} "$@" >/dev/null 2>&1 || true
  session=$(cat /tmp/omx-test-detached-session-name 2>/dev/null || printf omx-test)
  owner=$(cat /tmp/omx-test-detached-owner-id 2>/dev/null || printf '')
  printf '%%12\t0\t123\t%s\t$1\t1\t%s\n' "$session" "$owner"
  exit 0
fi
if [ "$1" = "if-shell" ] && [ "$2" = "-F" ] && [ "$3" = "-t" ]; then
  if [ -f "$0.detached-recycled" ] && [ "$4" = "%99" ]; then ${JSON.stringify(implementationPath)} __nested_hud_guard_denied__ %99 999 '$2' @2; exit 0; fi
  ${JSON.stringify(implementationPath)} "$@" >/dev/null 2>&1 || true
  success="$6"
  receipt=$(printf '%s' "$success" | sed -n 's/.*\\(omx_detached_[A-Za-z0-9-]*\\).*/\\1/p')
  case "\${OMX_TEST_DETACHED_RECYCLE:-}" in
    split) case "$success" in *split-window*) exit 0;; esac ;;
    finalization) case "$*" in
      *split-window*) : > "$0.detached-split-seen" ;;
      *"if-shell -F -t '%99'"*) if [ -f "$0.detached-split-seen" ]; then
        ${JSON.stringify(implementationPath)} __recycled__ %99 999 '$2' @2
        : > "$0.detached-recycled"
        eval "set -- $success"
        "$0" "$@" >/dev/null
      fi ;;
    esac ;;
  esac
  [ -n "$receipt" ] || exit 1
  case "$success" in
    *split-window*) printf '%%99\t456\t$1\t@1\t%s\n' "$receipt" ;;
    *) printf '%s\n' "$receipt" ;;
  esac
  exit 0
fi
output=$(${JSON.stringify(implementationPath)} "$@")
status=$?
printf '%s' "$output"
if [ "$status" -eq 0 ] && [ "$1" = "new-session" ]; then
  previous=''
  for arg in "$@"; do
    if [ "$previous" = '-s' ]; then printf '%s' "$arg" > /tmp/omx-test-detached-session-name; break; fi
    previous="$arg"
  done
  for last_arg do :; done
  pane=$(printf '%s' "$output" | sed -n '1p')
  TMUX=/tmp/omx-test-tmux,1,0 TMUX_PANE="$pane" nohup /bin/sh -c "$last_arg" </dev/null >/tmp/omx-test-detached-leader.log 2>&1 &
  leader_pid=$!
  (while kill -0 "$leader_pid" 2>/dev/null; do sleep 0.02; done; printf done > ${JSON.stringify(`${fakeTmuxPath}.leader-done`)}) </dev/null >/dev/null 2>&1 &
fi
exit "$status"
`);
}

async function createLaunchFixture(
  wd: string,
  tmuxScript: (tmuxLogPath: string) => string,
): Promise<{ env: Record<string, string>; tmuxLogPath: string; leaderDonePath: string }> {
  const home = join(wd, 'home');
  const fakeBin = join(wd, 'bin');
  const tmuxLogPath = join(wd, 'tmux.log');
  const leaderDonePath = join(wd, 'leader-done');

  await mkdir(home, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeExecutable(
    join(fakeBin, 'codex'),
    '#!/bin/sh\nprintf \'fake-codex:%s\\n\' "$*"\nsleep 1\n',
  );
  await writeExecutable(join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n');
  const tmuxImpl = join(fakeBin, 'tmux-impl');
  await writeExecutable(tmuxImpl, tmuxScript(tmuxLogPath));
  await writeExecutable(join(fakeBin, 'tmux'), `#!/bin/sh
if [ "$1" = "display-message" ] && [ "$2" = "-p" ] && [ "$3" = "-t" ] && case "$5" in *'#{session_created}'*'#{window_id}'*'#{pane_pid}'*) true;; *) false;; esac; then
  session=$(cat /tmp/omx-test-detached-session-name 2>/dev/null || printf omx-test)
  printf '%s\t$1\t1\t0\t@1\t%s\t123\n' "$session" "$4"
  exit 0
fi
if [ "$1" = "set-option" ] && [ "$2" = "-t" ] && [ "$4" = "@omx_instance_id" ]; then
  printf '%s' "$5" > /tmp/omx-test-detached-owner-id
fi
if [ "$1" = "list-panes" ] && case "$*" in *'#{session_created}'*'#{@omx_instance_id}'*) true;; *) false;; esac; then
  ${JSON.stringify(tmuxImpl)} "$@" >/dev/null 2>&1 || true
  session=$(cat /tmp/omx-test-detached-session-name 2>/dev/null || printf omx-test)
  owner=$(cat /tmp/omx-test-detached-owner-id 2>/dev/null || printf '')
  printf '%%12\t0\t123\t%s\t$1\t1\t%s\n' "$session" "$owner"
  exit 0
fi
if [ "$1" = "if-shell" ] && [ "$2" = "-F" ] && [ "$3" = "-t" ]; then
  if [ -f "$0.detached-recycled" ] && [ "$4" = "%99" ]; then ${JSON.stringify(tmuxImpl)} __nested_hud_guard_denied__ %99 999 '$2' @2; exit 0; fi
  ${JSON.stringify(tmuxImpl)} "$@" >/dev/null 2>&1 || true
  success="$6"
  receipt=$(printf '%s' "$success" | sed -n 's/.*\\(omx_detached_[A-Za-z0-9-]*\\).*/\\1/p')
  case "\${OMX_TEST_DETACHED_RECYCLE:-}" in
    split) case "$success" in *split-window*) exit 0;; esac ;;
    finalization) case "$*" in
      *split-window*) : > "$0.detached-split-seen" ;;
      *"if-shell -F -t '%99'"*) if [ -f "$0.detached-split-seen" ]; then
        ${JSON.stringify(tmuxImpl)} __recycled__ %99 999 '$2' @2
        : > "$0.detached-recycled"
        eval "set -- $success"
        "$0" "$@" >/dev/null
      fi ;;
    esac ;;
  esac
  [ -n "$receipt" ] || exit 1
  case "$success" in
    *split-window*) printf '%%99\t456\t$1\t@1\t%s\n' "$receipt" ;;
    *) printf '%s\n' "$receipt" ;;
  esac
  exit 0
fi
output=$(${JSON.stringify(tmuxImpl)} "$@")
status=$?
printf '%s' "$output"
if [ "$status" -eq 0 ] && [ "$1" = "new-session" ]; then
  previous=''
  for arg in "$@"; do
    if [ "$previous" = '-s' ]; then printf '%s' "$arg" > /tmp/omx-test-detached-session-name; break; fi
    previous="$arg"
  done
  for last_arg do :; done
  pane=$(printf '%s' "$output" | sed -n '1p')
  TMUX=/tmp/omx-test-tmux,1,0 TMUX_PANE="$pane" nohup /bin/sh -c "$last_arg" </dev/null >/tmp/omx-test-detached-leader.log 2>&1 &
  leader_pid=$!
  (while kill -0 "$leader_pid" 2>/dev/null; do sleep 0.02; done; printf done > ${JSON.stringify(join(wd, 'leader-done'))}) </dev/null >/dev/null 2>&1 &
fi
exit "$status"
`);

  return {
    tmuxLogPath,
    leaderDonePath,
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

function startHeldOmx(
  cwd: string,
  envOverrides: Record<string, string>,
): ReturnType<typeof spawn> {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  return spawn(process.execPath, [join(repoRoot, 'dist', 'cli', 'omx.js'), '--direct', '--version'], {
    cwd,
    env: buildRunOmxEnv(envOverrides),
    stdio: 'inherit',
  });
}

async function waitForPath(path: string, expectedLines: number = 1): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (existsSync(path)) {
      const contents = await readFile(path, 'utf-8').catch(() => '');
      if (contents.trim().split('\n').filter(Boolean).length >= expectedLines) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function parseShimTmuxArgv(contents: string): string[][] {
  return contents
    .split('tmux argv:\n')
    .slice(1)
    .map((record) => record.split('\nend tmux argv')[0]!.split('\n').filter(Boolean));
}

async function assertShimLogQuiescent(path: string, quietPeriodMs: number, message: string): Promise<void> {
  const before = await readFile(path, 'utf-8').catch(() => '');
  await new Promise((resolve) => setTimeout(resolve, quietPeriodMs));
  assert.equal(await readFile(path, 'utf-8').catch(() => ''), before, message);
}

async function stopHeldOmx(child: ReturnType<typeof spawn>, releasePath: string): Promise<void> {
  await rm(releasePath, { force: true });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}

async function createHeldCodexFixture(wd: string): Promise<{
  env: Record<string, string>;
  releasePath: string;
  rootsPath: string;
}> {
  const home = join(wd, 'home');
  const fakeBin = join(wd, 'bin');
  const releasePath = join(wd, 'hold');
  const rootsPath = join(wd, 'roots.log');
  await mkdir(home, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(releasePath, 'hold\n');
  await writeExecutable(
    join(fakeBin, 'codex'),
    `#!/bin/sh
printf '%s\\n' "$OMX_ROOT" >> "${rootsPath}"
while [ -f "${releasePath}" ]; do sleep 1; done
`,
  );
  await writeExecutable(join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n');
  return {
    releasePath,
    rootsPath,
    env: {
      HOME: home,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      OMX_AUTO_UPDATE: '0',
      OMX_NOTIFY_FALLBACK: '0',
      OMX_HOOK_DERIVED_SIGNALS: '0',
      OMX_ROOT: '',
      OMX_STATE_ROOT: '',
      TMUX: '',
      TMUX_PANE: '',
    },
  };
}

function skipUnlessPrivateRealTmux(t: TestContext): boolean {
  if (isRealTmuxAvailable()) return true;
  assert.equal(process.env.CI, undefined, 'CI must provide tmux for the private-server detached launch regression');
  t.skip('tmux is not installed');
  return false;
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
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it('passes literal max and ultra after -- with raw config args to Codex launch unchanged', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-reasoning-passthrough-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const fakeCapturePath = join(wd, 'fake-codex-argv.json');
      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        fakeCodexPath,
        [
          '#!/bin/sh',
          `exec "$NODE_BINARY" -e 'require("node:fs").writeFileSync(process.env.OMX_FAKE_CODEX_CAPTURE_PATH, JSON.stringify(process.argv.slice(1)))' -- "$@"`,
          '',
        ].join('\n'),
      );
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(
        wd,
        [
          '--direct',
          '-c',
          'model_reasoning_effort=MAX',
          '--',
          '--max',
          '--ultra',
          '-c',
          'model_reasoning_effort="ultra"',
          '-c',
          'model_reasoning_effort=future',
          'suffix argument with spaces',
          '',
          '--',
          'after second marker',
        ],
        {
          HOME: home,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          NODE_OPTIONS: '',
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
          NODE_BINARY: process.execPath,
          OMX_FAKE_CODEX_CAPTURE_PATH: fakeCapturePath,
          TMUX: '',
          TMUX_PANE: '',
        },
      );

      if (shouldSkipForSpawnPermissions(result.error)) return;
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      const capturedArgv = JSON.parse(await readFile(fakeCapturePath, 'utf-8')) as string[];
      const firstMarkerIndex = capturedArgv.indexOf('--');
      assert.equal(firstMarkerIndex, 4);
      const modelInstructionsArg = capturedArgv[firstMarkerIndex - 1];
      assert.match(modelInstructionsArg, /^model_instructions_file="[^"\n]+"$/);
      assert.match(modelInstructionsArg, /\.omx\/state\/sessions\/omx-[^"]+\/AGENTS\.md"$/);
      assert.equal(capturedArgv.filter((arg) => arg.startsWith('model_instructions_file=')).length, 1);
      assert.deepEqual(capturedArgv, [
        '-c',
        'model_reasoning_effort=MAX',
        '-c',
        modelInstructionsArg,
        '--',
        '--max',
        '--ultra',
        '-c',
        'model_reasoning_effort="ultra"',
        '-c',
        'model_reasoning_effort=future',
        'suffix argument with spaces',
        '',
        '--',
        'after second marker',
      ]);
    } finally {
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it('treats image values as variadic when detecting resume launches', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-image-resume-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCapturePath = join(wd, 'fake-codex.json');
      await mkdir(join(wd, '.omx'), { recursive: true });
      await mkdir(join(wd, '.codex'), { recursive: true });
      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await writeFile(join(wd, '.codex', 'state_5.sqlite'), 'resume-only-sentinel');
      await writeExecutable(
        join(fakeBin, 'codex'),
        `#!/bin/sh
exec "$NODE_BINARY" -e 'const fs = require("node:fs"); const path = require("node:path"); fs.writeFileSync(process.env.OMX_FAKE_CODEX_CAPTURE_PATH, JSON.stringify({ argv: process.argv.slice(1), hasResumeSqlite: fs.existsSync(path.join(process.env.CODEX_HOME, "state_5.sqlite")) }))' -- "$@"
`,
      );

      const cases: Array<{ args: string[]; resumes: boolean }> = [
        { args: ['-i', 'resume'], resumes: false },
        { args: ['--image', 'resume'], resumes: false },
        { args: ['--image=resume'], resumes: false },
        { args: ['-iresume'], resumes: false },
        { args: ['-i=resume'], resumes: false },
        { args: ['-i', 'screenshot.png', 'resume'], resumes: false },
        { args: ['--image', 'screenshot.png', 'resume'], resumes: false },
        { args: ['--image=screenshot.png', 'resume'], resumes: true },
        { args: ['-iscreenshot.png', 'resume'], resumes: true },
        { args: ['-i=screenshot.png', 'resume'], resumes: true },
        { args: ['-i', 'one.png', '-i', 'two.png', 'resume'], resumes: false },
        { args: ['--image', 'one.png', '--image', 'two.png', 'resume'], resumes: false },
        { args: ['-i', 'one.png,two.png', 'resume'], resumes: false },
        { args: ['--image', 'one.png,two.png', 'resume'], resumes: false },
        { args: ['--image', 'one.png', '--model', 'gpt-review', 'resume'], resumes: true },
        { args: ['--image=one.png', '--model=gpt-review', 'resume'], resumes: true },
      ];

      for (const testCase of cases) {
        const result = runOmx(
          wd,
          ['--direct', ...testCase.args],
          {
            HOME: home,
            PATH: `${fakeBin}:/usr/bin:/bin`,
            NODE_BINARY: process.execPath,
            OMX_AUTO_UPDATE: '0',
            OMX_BYPASS_DEFAULT_SYSTEM_PROMPT: '0',
            OMX_HOOK_DERIVED_SIGNALS: '0',
            OMX_NOTIFY_FALLBACK: '0',
            OMX_FAKE_CODEX_CAPTURE_PATH: fakeCapturePath,
          },
        );

        if (shouldSkipForSpawnPermissions(result.error)) return;
        assert.equal(result.status, 0, `${JSON.stringify(testCase.args)}: ${result.error || result.stderr || result.stdout}`);
        const captured = JSON.parse(await readFile(fakeCapturePath, 'utf-8')) as {
          argv: string[];
          hasResumeSqlite: boolean;
        };
        assert.deepEqual(captured.argv, testCase.args);
        assert.equal(captured.hasResumeSqlite, testCase.resumes, JSON.stringify(testCase.args));
      }
    } finally {
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
});

describe('ordinary launch root collision guidance', () => {
  it('keeps the cwd default for the first launch and fails the second and third launches closed with explicit-root guidance', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-root-conflict-'));
    let binding: LaunchSessionBinding | undefined;
    try {
      execFileSync('git', ['init'], { cwd: wd, stdio: 'ignore' });
      const fixture = await createHeldCodexFixture(wd);
      const established = await establishLaunchSessionBinding(wd, 'first-standard-launch', { pid: process.pid });
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;

      const second = runOmx(wd, ['--direct', '--version'], fixture.env);
      const third = runOmx(wd, ['--direct', '--version'], fixture.env);
      if (shouldSkipForSpawnPermissions(second.error) || shouldSkipForSpawnPermissions(third.error)) return;
      for (const result of [second, third]) {
        assert.notEqual(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stderr, /session_pointer_owner_conflict/);
        assert.match(result.stderr, /concurrent conversations in this checkout require distinct user-specified OMX_ROOT values/);
        assert.match(result.stderr, /POSIX: OMX_ROOT="\$HOME\/\.omx\/instances\/second-conversation" omx/);
        assert.match(result.stderr, /PowerShell: \$env:OMX_ROOT = "\$HOME\/\.omx\/instances\/second-conversation"; omx/);
        assert.match(result.stderr, /cmd\.exe: set "OMX_ROOT=%USERPROFILE%\\\.omx\\instances\\second-conversation" && omx/);
        assert.match(result.stderr, /OMX does not reroute or allocate one automatically/);
      }
      const resume = runOmx(wd, ['--direct', 'resume'], fixture.env);
      if (!shouldSkipForSpawnPermissions(resume.error)) {
        assert.notEqual(resume.status, 0, resume.stderr || resume.stdout);
        assert.match(resume.stderr, /session_pointer_owner_conflict/);
        assert.doesNotMatch(resume.stderr, /concurrent conversations in this checkout require distinct user-specified OMX_ROOT values/);
      }
      await finalizeBoundOnce(binding, 'test');
    } finally {
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it('keeps explicit roots literal: distinct roots launch independently while a shared root remains fatal without reroute guidance', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-explicit-roots-'));
    execFileSync('git', ['init'], { cwd: wd, stdio: 'ignore' });
    let first: ReturnType<typeof spawn> | undefined;
    let second: ReturnType<typeof spawn> | undefined;
    try {
      const fixture = await createHeldCodexFixture(wd);
      const firstRoot = join(wd, 'first-root');
      const secondRoot = join(wd, 'second-root');
      first = startHeldOmx(wd, { ...fixture.env, OMX_ROOT: firstRoot });
      second = startHeldOmx(wd, { ...fixture.env, OMX_ROOT: secondRoot });
      await waitForPath(fixture.rootsPath, 2);
      assert.deepEqual(
        new Set((await readFile(fixture.rootsPath, 'utf-8')).trim().split('\n')),
        new Set([firstRoot, secondRoot]),
      );

      const collision = runOmx(wd, ['--direct', '--version'], { ...fixture.env, OMX_ROOT: firstRoot });
      if (shouldSkipForSpawnPermissions(collision.error)) return;
      assert.notEqual(collision.status, 0, collision.stderr || collision.stdout);
      assert.match(collision.stderr, /session_pointer_owner_conflict/);
      assert.doesNotMatch(collision.stderr, /concurrent conversations in this checkout require distinct user-specified OMX_ROOT values/);
      assert.doesNotMatch(collision.stderr, /reroute or allocate one automatically/);

      await stopHeldOmx(first, fixture.releasePath);
      first = undefined;
      if (second.exitCode === null) {
        await new Promise<void>((resolve) => second!.once('exit', () => resolve()));
      }
      second = undefined;
    } finally {
      if (first) first.kill('SIGKILL');
      if (second) second.kill('SIGKILL');
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it('keeps different checkout defaults independent and fails closed on stale default-pointer evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-root-stale-'));
    let firstBinding: LaunchSessionBinding | undefined;
    let secondBinding: LaunchSessionBinding | undefined;
    try {
      const firstCheckout = join(wd, 'first-checkout');
      const secondCheckout = join(wd, 'second-checkout');
      await mkdir(firstCheckout, { recursive: true });
      await mkdir(secondCheckout, { recursive: true });
      execFileSync('git', ['init'], { cwd: firstCheckout, stdio: 'ignore' });
      execFileSync('git', ['init'], { cwd: secondCheckout, stdio: 'ignore' });

      const firstEstablished = await establishLaunchSessionBinding(firstCheckout, 'first-checkout-owner', { pid: process.pid });
      const secondEstablished = await establishLaunchSessionBinding(secondCheckout, 'second-checkout-owner', { pid: process.pid });
      assert.equal(firstEstablished.kind, 'committed-released');
      assert.equal(secondEstablished.kind, 'committed-released');
      if (firstEstablished.kind !== 'committed-released' || secondEstablished.kind !== 'committed-released') return;
      firstBinding = firstEstablished.binding;
      secondBinding = secondEstablished.binding;
      assert.match(await readFile(join(firstCheckout, '.omx', 'state', 'session.json'), 'utf-8'), /first-checkout-owner/);
      assert.match(await readFile(join(secondCheckout, '.omx', 'state', 'session.json'), 'utf-8'), /second-checkout-owner/);
      await finalizeBoundOnce(firstBinding, 'test');
      await finalizeBoundOnce(secondBinding, 'test');

      await writeSessionStart(firstCheckout, 'stale-owner', { pid: 2_147_483_647 });
      const fixture = await createHeldCodexFixture(wd);
      await rm(fixture.releasePath, { force: true });
      const relaunch = runOmx(firstCheckout, ['--direct', '--version'], fixture.env);
      if (shouldSkipForSpawnPermissions(relaunch.error)) return;
      assert.notEqual(relaunch.status, 0, relaunch.error || relaunch.stderr || relaunch.stdout);
      assert.match(relaunch.stderr, /session_pointer_unusable|stale-dead/);
      assert.match(await readFile(join(firstCheckout, '.omx', 'state', 'session.json'), 'utf-8'), /stale-owner/);
    } finally {
      if (firstBinding) await closeLaunchSessionBindingOnce(firstBinding).catch(() => {});
      if (secondBinding) await closeLaunchSessionBindingOnce(secondBinding).catch(() => {});
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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
      assert.match(tmuxLog, /tmux:if-shell -F -t %12 .*split-window/);
      assert.doesNotMatch(tmuxLog, /tmux:attach-session/);
      assert.doesNotMatch(result.stderr, /failed to attach detached tmux session/);
    } finally {
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
});

describe('omx launcher when tmux is available', () => {
  it('captures the compiled detached parser transport and stored hook on a private tmux server', async (t) => {
    if (!skipUnlessPrivateRealTmux(t)) return;
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-private-real-tmux-'));
    try {
      await withTempTmuxSession(async (fixture) => {
        const home = join(wd, 'home');
        const bin = join(wd, 'bin');
        const foreignSession = 'foreign-control';
        await mkdir(home, { recursive: true });
        await mkdir(bin, { recursive: true });
        await writeExecutable(join(bin, 'codex'), '#!/bin/sh\nsleep 300\n');
        const shimLogPath = join(wd, 'private-tmux-shim.log');
        await fixture.createPathShim(bin, shimLogPath);
        fixture.run(['new-session', '-d', '-s', foreignSession, 'sleep 300']);
        const foreignBefore = fixture.run(['list-panes', '-t', foreignSession, '-F', '#{pane_id}\t#{pane_pid}\t#{pane_height}']);

        const result = runOmx(wd, ['--madmax', '--tmux'], {
          HOME: home,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
          OMX_HERMES_MCP_BRIDGE: '1',
          OMX_LAUNCH_POLICY: 'direct',
          TMUX: '',
          TMUX_PANE: '',
        });
        assert.equal(result.status, 0, result.error || result.stderr || result.stdout);

        const launchedSession = fixture.run(['list-sessions', '-F', '#{session_name}'])
          .split('\n')
          .find((name) => name.startsWith('omx-') && name !== fixture.sessionName);
        assert.ok(launchedSession, 'compiled launcher must create its detached session on the private server');
        const panes = fixture.run(['list-panes', '-t', launchedSession, '-F', '#{pane_id}\t#{pane_height}\t#{pane_start_command}'])
          .split('\n')
          .map((line) => line.split('\t'));
        const hud = panes.find(([, , command]) => command.includes('OMX_DETACHED_HUD_OPERATION='));
        assert.ok(hud, 'HUD split must carry its operation marker');
        assert.equal(Number(hud[1]), HUD_TMUX_HEIGHT_LINES, 'authorized direct reconciliation must resize the HUD');
        assert.equal(
          fixture.run(['show-options', '-v', '-t', launchedSession, 'history-limit']),
          String(DETACHED_TMUX_HISTORY_LIMIT),
          'direct leader mutation must receive its receipt and set session history',
        );

        const hooks = fixture.run(['show-hooks', '-t', launchedSession]);
        assert.match(hooks, /client-resized\[[0-9]+\].*run-shell -b/);
        assert.match(hooks, /tmux if-shell -F -t/);
        assert.match(hooks, /OMX_DETACHED_HUD_OPERATION=/);
        const storedPaneFormat = hooks.match(/##\{pane_id\}\\t##\{pane_dead\}\\t##\{pane_pid\}/)?.[0] ?? '';
        assert.equal(storedPaneFormat, '##{pane_id}\\t##{pane_dead}\\t##{pane_pid}', 'stored hook display must retain one outer format escape and encode TAB bytes');
        const executablePaneFormat = storedPaneFormat.replaceAll('##{', '#{').replaceAll('\\t', '\t');
        assert.equal(executablePaneFormat, '#{pane_id}\t#{pane_dead}\t#{pane_pid}', 'one outer tmux format pass must decode the stored format into the executable nested argv');

        const clientAttachedHookSlots = [...hooks.matchAll(/client-attached\[[0-9]+\]/g)].map(([slot]) => slot);
        for (const hookSlot of clientAttachedHookSlots) {
          fixture.run(['set-hook', '-u', '-t', launchedSession, hookSlot]);
        }
        const installedHooks = fixture.run(['show-hooks', '-t', launchedSession]);
        const storedResizeHookSlots = [...installedHooks.matchAll(/client-resized\[[0-9]+\]/g)].map(([slot]) => slot);
        assert.equal(storedResizeHookSlots.length, 1, 'exactly one installed client-resized hook must remain for the natural resize trigger');
        assert.match(installedHooks, /client-resized\[[0-9]+\].*run-shell -b/);
        assert.doesNotMatch(installedHooks, /client-attached\[[0-9]+\]/, 'the resize trigger must not be conflated with client-attached hook execution');

        await new Promise((resolve) => setTimeout(resolve, (HUD_RESIZE_RECONCILE_DELAY_SECONDS * 1_000) + 250));
        const launchPaneSnapshots = parseShimTmuxArgv(await readFile(shimLogPath, 'utf-8'))
          .filter((argv) => argv[0] === 'list-panes' && argv[1] === '-a');
        assert.ok(
          launchPaneSnapshots.length >= 2,
          'the direct and delayed launch reconciliations must both complete before the stored-hook baseline is cleared',
        );
        await assertShimLogQuiescent(
          shimLogPath,
          250,
          'launch and delayed reconciliation must settle before clearing the stored-hook baseline',
        );
        await writeFile(shimLogPath, '');
        assert.equal(await readFile(shimLogPath, 'utf-8'), '', 'the shim baseline must start after launch and reconciliation activity settles');

        fixture.triggerClientResize(launchedSession);
        await new Promise((resolve) => setTimeout(resolve, (HUD_RESIZE_RECONCILE_DELAY_SECONDS * 1_000) + 250));
        await assertShimLogQuiescent(
          shimLogPath,
          250,
          'the stored client-resized hook must finish both its immediate and delayed passes before assertions',
        );

        const nestedArgv = parseShimTmuxArgv(await readFile(shimLogPath, 'utf-8'));
        const paneSnapshots = nestedArgv.filter((argv) => argv[0] === 'list-panes' && argv[1] === '-a');
        assert.equal(
          paneSnapshots.length,
          2,
          'only the explicitly triggered stored client-resized hook may produce the post-baseline immediate and delayed pane snapshots',
        );
        for (const argv of paneSnapshots) {
          assert.deepEqual(
            argv,
            ['list-panes', '-a', '-F', executablePaneFormat],
            'post-baseline stored client-resized hook execution must preserve the exact executable TAB-delimited nested argv',
          );
        }

        fixture.run(['set-option', '-t', launchedSession, '@omx_instance_id', 'foreign-owner']);
        assert.equal(Number(fixture.run(['display-message', '-p', '-t', hud[0]!, '#{pane_height}'])), HUD_TMUX_HEIGHT_LINES, 'foreign owner must not receive a deferred mutation without an authority receipt');
        assert.equal(fixture.run(['list-panes', '-t', foreignSession, '-F', '#{pane_id}\t#{pane_pid}\t#{pane_height}']), foreignBefore);
      });
    } finally {
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it('does not let the outer launcher fabricate leader-owned active records', async () => {
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
  list-panes)
    session=$(cat "${activeMarker}")
    instance=$(cat "${instanceMarker}")
    printf '%%12\t0\t4242\t%s\t$1\t100\t%s\n' "$session" "$instance"
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
      assert.match(second.stderr, /madmax detached launch already active for this context/);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal((tmuxLog.match(/tmux:new-session/g) || []).length, 1);
      assert.equal((tmuxLog.match(/tmux:has-session/g) || []).length, 0);
      assert.ok((tmuxLog.match(/tmux:list-panes/g) || []).length >= 2);
      assert.equal((tmuxLog.match(/tmux:attach-session/g) || []).length, 2);
      const activeRecord = await readFile(join(runs, 'active-detached', 'boxed-context-under-test.json'), 'utf-8');
      assert.match(activeRecord, /"tmux_session_name"/);
      assert.match(activeRecord, /"session_id"/);
      assert.match(activeRecord, /"tmux_pane_id": "%12"/);
      assert.match(activeRecord, /"leader_pid"/);
      assert.match(activeRecord, /"base_state_root"/);
      assert.match(activeRecord, /"lifecycle_phase": "ready"/);
    } finally {
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it('records boxed runtime identity in the leader-owned active record', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-madmax-worktree-detached-'));
    try {
      const repo = await createGitRepo(wd);
      const runs = join(wd, 'runs');
      const instanceMarker = join(wd, 'active-instance');
      const sessionMarker = join(wd, 'active-session-name');

      const { env, tmuxLogPath, leaderDonePath } = await createLaunchFixture(
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
    prev=''
    for arg in "$@"; do
      if [ "$prev" = '-s' ]; then printf '%s' "$arg" > "${sessionMarker}"; fi
      prev="$arg"
    done
    printf '%%77\n'
    exit 0
    ;;

  split-window)
    printf '%%78\n'
    exit 0
    ;;
  list-panes)
    instance=$(cat "${instanceMarker}")
    printf '%%77\t0\t4242\t%s\t$1\t100\t%s\n' "$(cat "${sessionMarker}")" "$instance"
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
      const activeRecord = JSON.parse(await readFile(join(runs, 'active-detached', activeFiles[0]!), 'utf-8')) as { source_cwd: string; worktree_cwd?: string; leader_pid?: number; lifecycle_phase?: string };
      const worktreePath = join(dirname(repo), `${basename(repo)}.omx-worktrees`, 'launch-detached');
      assert.equal(normalizeDarwinTmpPath(activeRecord.source_cwd), normalizeDarwinTmpPath(worktreePath));
      assert.equal(typeof activeRecord.leader_pid, 'number');
      assert.equal(activeRecord.lifecycle_phase, 'ready');
      const tmuxLog = normalizeDarwinTmpPath(await readFile(tmuxLogPath, 'utf-8'));
      assert.match(tmuxLog, /__detached-session-leader/);
      assert.match(tmuxLog, /-e OMXBOX_ACTIVE=1/);
      assert.match(tmuxLog, new RegExp(`-e OMX_SOURCE_CWD=${escapeRegExp(normalizeDarwinTmpPath(repo))}`));
      await waitForPath(leaderDonePath);
    } finally {
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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
      const { env, tmuxLogPath, leaderDonePath } = await createLaunchFixture(
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
      await waitForPath(leaderDonePath);
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(tmuxLog, /tmux:set-option .* -t user-owned-session .*history-limit/);
      assert.doesNotMatch(tmuxLog, /tmux:clear-history .*user-owned-session|tmux:clear-history .*%99/);
      assert.match(tmuxLog, /tmux:new-session /);
    } finally {
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it('does not reuse the same active-detached lock for independent --madmax --high launches', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-madmax-independent-high-'));
    try {
      const runs = join(wd, 'runs');
      const sessionMarker = join(wd, 'independent-session');
      const instanceMarker = join(wd, 'independent-instance');

      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (logPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${logPath}"
case "$1" in
  -V) printf 'tmux 3.4\n'; exit 0 ;;
  has-session) exit 1 ;;
  new-session) prev=''; for arg in "$@"; do if [ "$prev" = '-s' ]; then printf '%s' "$arg" > "${sessionMarker}"; fi; prev="$arg"; done; printf '%%12\n'; exit 0 ;;

  split-window) printf 'hud-pane\n'; exit 0 ;;
  display-message) if [ "$2" = '-p' ] && [ "$3" = '#{socket_path}' ]; then printf '/tmp/tmux-test.sock\n'; else printf '0\n'; fi; exit 0 ;;
  list-panes) printf '%%12\t0\t4242\t%s\t$1\t100\t%s\n' "$(cat "${sessionMarker}")" "$(cat "${instanceMarker}")"; exit 0 ;;
  show-options) printf 'off\n'; exit 0 ;;
  set-option) if [ "$4" = '@omx_instance_id' ]; then printf '%s' "$5" > "${instanceMarker}"; fi; exit 0 ;;
  set-hook|attach-session|kill-session|run-shell|resize-pane) exit 0 ;;
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
      const activeDetachedEntries = await readdir(join(runs, 'active-detached'));
      assert.equal(activeDetachedEntries.filter((entry) => entry.endsWith('.json')).length, 2);
      assert.equal(activeDetachedEntries.filter((entry) => entry.endsWith('.lock')).length, 0);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal((tmuxLog.match(/tmux:new-session/g) || []).length, 2);
    } finally {
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it('denies detached HUD finalization when the receipted pane id is recycled', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-detached-hud-recycle-'));
    try {
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (logPath) => `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "${logPath}"
case "$1" in
  -V) printf 'tmux 3.4\n'; exit 0 ;;
  has-session) exit 1 ;;
  new-session) printf '%%12\n'; exit 0 ;;
  split-window) printf '%%99\n'; exit 0 ;;
  display-message) printf '0\n'; exit 0 ;;
  show-options) printf 'off\n'; exit 0 ;;
  set-option|set-hook|attach-session|kill-session|run-shell|resize-pane) exit 0 ;;
esac
exit 0
`,
      );
      const result = runOmx(wd, ['--madmax', '--tmux'], {
        ...env,
        OMX_LAUNCH_POLICY: 'direct',
        OMX_TEST_DETACHED_RECYCLE: 'finalization',
        TMUX: '',
        TMUX_PANE: '',
      });
      if (shouldSkipForSpawnPermissions(result.error)) return;

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /tmux:if-shell -F -t %12 .*OMX_DETACHED_HUD_OPERATION=/);
      assert.match(tmuxLog, /if-shell -F -t '%99' .*456.*\$1.*@1.*OMX_DETACHED_HUD_OPERATION=/);
      assert.match(tmuxLog, /^tmux:__nested_hud_guard_denied__ %99 999 \$2 @2$/m);
      assert.doesNotMatch(tmuxLog, /run-shell -b ['"]run-shell -b /);
      assert.doesNotMatch(tmuxLog, /^tmux:resize-pane .*%99/m);
    } finally {
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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
      await wrapFakeTmuxWithDetachedLeader(fakeTmuxPath);

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
      assert.match(tmuxLog, new RegExp(`tmux:if-shell -F -t %12 .*set-option.*history-limit.*${DETACHED_TMUX_HISTORY_LIMIT}`));
      assert.match(tmuxLog, new RegExp(`tmux:if-shell -F -t %12 .*set-option.*-pq.*%12.*history-limit.*${DETACHED_TMUX_HISTORY_LIMIT}`));
      assert.match(
        tmuxLog,
        /tmux:if-shell -F -t %12 .*set-hook.*client-detached\[[0-9]+\].*clear-history -t %12/,
      );
      assert.match(tmuxLog, new RegExp(`tmux:if-shell -F -t %12 .*split-window.*-v.*-l.*${HUD_TMUX_HEIGHT_LINES}.*-t.*%12`));
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      await waitForPath(`${fakeTmuxPath}.leader-done`);
    } finally {
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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
      nohup /bin/sh -c "$last" </dev/null >/tmp/omx-test-provider-leader.log 2>&1 &
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
      await wrapFakeTmuxWithDetachedLeader(join(fakeBin, 'tmux'));

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
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /__detached-session-leader/);
      assert.doesNotMatch(tmuxLog, /fake-provider-key|CUSTOM_LLM_API_KEY=/);
    } finally {
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it('fails closed on an incomplete synthetic HUD split source inside tmux', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-inside-tmux-managed-'));
    try {
      const { env, tmuxLogPath } = await createLaunchFixture(
        wd,
        (tmuxLogPath) => `#!/bin/sh
state="${tmuxLogPath}.hud-created"
proof="${tmuxLogPath}.hud-proof"
marker="${tmuxLogPath}.hud-marker"
printf 'tmux:%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  list-panes)
    case "$*" in
      *'#{pane_id}'*'#{pane_start_command}'*)
        if [ -f "$state" ]; then printf '%%1\tcodex\n%%2\tOMX_TMUX_SPLIT_OPERATION_MARKER='\''%s'\''; export OMX_TMUX_SPLIT_OPERATION_MARKER; exec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='\''%%1'\'' node hud\n' "$(cat "$marker")"; else printf '%%1\tcodex\n'; fi
        ;;
      *'#{pane_id}\t#{pane_dead}\t#{pane_pid}'*)
        printf '%%1\t0\t101\n%%2\t0\t202\n'
        ;;
      *'#{pane_id}'*)
        if [ -f "$state" ]; then printf '%%1\n%%2\n'; else printf '%%1\n'; fi
        ;;
    esac
    exit 0
    ;;
  split-window)
    printf '%%2\n'
    exit 0
    ;;
  if-shell)
    [ "$2" = '-F' ] && [ "$3" = '-t' ] && [ "$4" = '%1' ] || exit 1
    case "$5" in *'#{pane_pid},101'*'#{session_id},$7'*'#{window_id},@1'*) ;; *) exit 1 ;; esac
    success="$6"
    receipt=\${success##*display-message -p }
    receipt=\${receipt%% *}
    split_marker=$(printf '%s' "$success" | sed -n "s/.*OMX_TMUX_SPLIT_OPERATION_MARKER='\\([^']*\\)'.*/\\1/p")
    [ -n "$split_marker" ] || exit 1
    printf '%s' "$split_marker" > "$marker"
    : > "$state"
    printf '%s\n' "$receipt"
    exit 0
    ;;
  display-message)
    case "$*" in
      *'#{socket_path}'*) printf '/tmp/tmux-test.sock\n' ;;
      *'#{pane_id}'*'#{pane_dead}'*'#{pane_pid}'*'#{session_id}'*'#{window_id}'*) printf '%%1\t0\t101\t$7\t@1\n' ;;
      *'#{session_id}'*'#{window_id}'*) printf '$7\t@1\n' ;;
      *'#S'*) printf 'managed-session\n' ;;
      *) printf '0\n' ;;
    esac
    exit 0
    ;;
  show-options)
    if [ "$2" = '-g' ] && [ "$3" = '-v' ]; then cat "$proof" 2>/dev/null || true; else printf 'off\n'; fi
    exit 0
    ;;
  set-option)
    if [ "$2" = '-g' ]; then printf '%s\n' "$4" > "$proof"; fi
    exit 0
    ;;
  kill-pane)
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
      assert.doesNotMatch(tmuxLog, /tmux:if-shell -F -t %1 .*split-window/);
      assert.match(tmuxLog, /tmux:set-option -t managed-session mouse on/);
      assert.match(tmuxLog, /tmux:set-option -sq extended-keys always/);
    } finally {
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it('does not probe an existing tmux server before detached tmux startup', async () => {

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
  set-option|set-hook|attach-session|kill-session|run-shell|resize-pane|select-pane)
    exit 0
    ;;
esac
exit 0
`,
      );
      await chmod(fakeTmuxPath, 0o755);
      await wrapFakeTmuxWithDetachedLeader(fakeTmuxPath);

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
      assert.doesNotMatch(tmuxLog, /tmux:list-sessions/);

      assert.match(tmuxLog, /tmux:new-session .* -s /);
      assert.doesNotMatch(result.stderr, /server\/socket is unusable/);
    } finally {
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it('does not fall back directly when a later detached tmux operation fails', async () => {

    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-tmux-stale-socket-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const fakeTmuxPath = join(fakeBin, 'tmux');
      const tmuxLogPath = join(wd, 'tmux.log');
      const runsPath = join(wd, 'runs');


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
    printf 'tmux:d0-runs:%s\n' "$(test -e "${runsPath}" && printf present || printf missing)" >> "${tmuxLogPath}"

    printf 'tmux 3.6a\n'
    exit 0
    ;;
  new-session)
    printf 'unsafe-tmux-handle-secret\n' >&2
    exit 1
    ;;

esac
printf 'unexpected tmux command: %s\n' "$*" >&2
exit 1
`,
      );
      await chmod(fakeTmuxPath, 0o755);
      await wrapFakeTmuxWithDetachedLeader(fakeTmuxPath);

      const result = runOmx(
        wd,
        ['--madmax', '--tmux'],
        {
          HOME: home,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
          OMX_RUNS_DIR: runsPath,

          TMUX: '',
          TMUX_PANE: '',
        },
      );

      if (shouldSkipForSpawnPermissions(result.error)) return;

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal(result.status, 1, result.error || result.stderr || result.stdout);
      assert.match(result.stderr, /detached launch safety failure during inert-session/);
      assert.doesNotMatch(result.stderr, /unsafe-tmux-handle-secret/);
      assert.doesNotMatch(result.stdout, /fake-codex/);
      assert.match(tmuxLog, /tmux:-V/);
      assert.match(tmuxLog, /tmux:d0-runs:missing/);
      assert.match(tmuxLog, /tmux:new-session/);
      assert.doesNotMatch(tmuxLog, /tmux:list-sessions|attach-session/);
    } finally {
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it('preserves detached ownership when attaching the released tmux session fails', async () => {
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
      await wrapFakeTmuxWithDetachedLeader(fakeTmuxPath);

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
      await waitForPath(`${fakeTmuxPath}.leader-done`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal(result.status, 1, result.error || result.stderr || result.stdout);
      assert.match(result.stderr, /detached launch safety failure during post-release-attach/);
      assert.match(tmuxLog, /tmux:attach-session -t /);
      assert.doesNotMatch(tmuxLog, /tmux:kill-session -t /);
    } finally {
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it('does not probe or fall back after a released WSL attach returns immediately', async () => {
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
      assert.doesNotMatch(result.stderr, /Falling back to direct Codex launch|attach-session returned immediately/);
      assert.match(tmuxLog, /tmux:attach-session -t /);
      assert.doesNotMatch(tmuxLog, /tmux:display-message -p -t .* #\{session_attached\}|tmux:kill-session -t/);
    } finally {
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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
    printf '%%12\n'
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
      await wrapFakeTmuxWithDetachedLeader(fakeTmuxPath);

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
      await waitForPath(`${fakeTmuxPath}.leader-done`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /\/bin\/sh/);
      assert.match(tmuxLog, /__detached-session-leader/);
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
    } finally {
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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
    printf '%%12\n'
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
      await wrapFakeTmuxWithDetachedLeader(fakeTmuxPath);

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
      assert.match(tmuxLog, /\/bin\/sh/);
      assert.doesNotMatch(tmuxLog, /not-a-real-shell/);
      assert.match(tmuxLog, /__detached-session-leader/);
      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      await waitForPath(`${fakeTmuxPath}.leader-done`);
    } finally {
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });


  it('keeps finalization authority in the real detached leader process through child exit', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-detached-leader-process-'));
    const home = join(wd, 'home');
    const fakeChild = join(wd, 'fake-codex.sh');
    const childReady = join(wd, 'child-ready');
    const childRelease = join(wd, 'child-release');
    const childEnv = join(wd, 'child-env');
    const descendantPidPath = join(wd, 'descendant-pid');
    const readyPath = join(wd, '.omx', 'runtime', 'detached-release', 'ready');
    const omxBin = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'cli', 'omx.js');
    const sessionId = 'omx-detached-leader-process';
    try {
      await mkdir(home, { recursive: true });
      await writeExecutable(fakeChild, `#!/bin/sh\nprintf '%s' "$OMX_NOTIFY_TEMP_CONTRACT" > ${JSON.stringify(childEnv)}\n(sh -c 'trap "" TERM; while :; do sleep 1; done') &\nprintf '%s' "$!" > ${JSON.stringify(descendantPidPath)}\nprintf ready > ${JSON.stringify(childReady)}\nwhile [ ! -f ${JSON.stringify(childRelease)} ]; do sleep 0.02; done\nexit 0\n`);
      const payload = Buffer.from(JSON.stringify({
        cwd: wd,
        sessionName: 'omx-detached-leader-process',
        sessionId,
        codexCmd: fakeChild,
        readyPath,
        preLaunchOptions: {
          notifyTempContract: {
            active: true,
            selectors: ['custom:test-provider'],
            canonicalSelectors: ['custom:test-provider'],
            warnings: [],
            source: 'cli',
          },
          enableNotifyFallbackAuthority: false,
          worktreeDirty: false,
        },
      })).toString('base64url');
      const leader = spawn(process.execPath, [omxBin, '__detached-session-leader', payload], {
        cwd: wd,
        env: buildRunOmxEnv({
          HOME: home,
          TMUX: '/tmp/fake-tmux,1,0',
          TMUX_PANE: '%3202',
          OMX_AUTO_UPDATE: '0',
          OMX_NOTIFY_FALLBACK: '0',
          OMX_HOOK_DERIVED_SIGNALS: '0',
        }),
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      await waitForPath(readyPath);
      const ready = JSON.parse(await readFile(readyPath, 'utf-8')) as { nonce: string; sessionId: string; sessionName: string; leaderPid: number };
      await writeFile(`${readyPath}.release`, `${JSON.stringify({ version: 1, kind: 'release', nonce: `${ready.nonce}-foreign`, sessionId: ready.sessionId, sessionName: ready.sessionName, leaderPid: ready.leaderPid })}\n`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      assert.equal(existsSync(childReady), false);
      await writeFile(`${readyPath}.release`, `${JSON.stringify({ version: 1, kind: 'release', nonce: ready.nonce, sessionId: ready.sessionId, sessionName: ready.sessionName, leaderPid: ready.leaderPid })}\n`);
      await waitForPath(childReady);
      assert.match(await readFile(childEnv, 'utf-8'), /custom:test-provider/);
      await waitForPath(descendantPidPath);
      const descendantPid = Number.parseInt((await readFile(descendantPidPath, 'utf-8')).trim(), 10);
      assert.equal(Number.isSafeInteger(descendantPid) && descendantPid > 0, true);
      assert.equal(existsSync(readyPath), true);
      assert.equal(existsSync(join(wd, '.omx', 'state', 'session.json')), true);
      assert.equal(existsSync(join(wd, '.omx', 'state', 'detached-active-record.json')), true);
      await writeFile(childRelease, 'release\n');
      const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
        leader.once('error', rejectExit);
        leader.once('exit', resolveExit);
      });
      assert.equal(exitCode, 0);
      assert.throws(() => process.kill(descendantPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
      const terminalReport = JSON.parse(await readFile(readyPath, 'utf-8')) as {
        version: number;
        kind: string;
        nonce: string;
        sessionId: string;
        sessionName: string;
        paneId: string;
        leaderPid: number;
        finalized: boolean;
      };
      assert.deepEqual(terminalReport, {
        version: 1,
        kind: 'terminal',
        nonce: ready.nonce,
        sessionId: ready.sessionId,
        sessionName: ready.sessionName,
        leaderPid: ready.leaderPid,
        paneId: '%3202',
        finalized: true,
        exitStatus: 0,
      });
      assert.equal(existsSync(join(wd, '.omx', 'state', 'session.json')), false);
      assert.equal(existsSync(join(wd, '.omx', 'state', 'detached-active-record.json')), false);
      assert.equal(existsSync(readyPath), true);
      await rm(readyPath, { force: true });
      assert.match(await readFile(join(wd, '.omx', 'logs', 'session-history.jsonl'), 'utf-8'), new RegExp(sessionId));
    } finally {
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it('returns the attached client to the shell with the child status after a normal detached child exit', async (t) => {
    if (!skipUnlessPrivateRealTmux(t)) return;
    if (process.platform === 'win32') { t.skip('PTY launch harness requires posix script(1)'); return; }
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-detached-e2e-'));
    try {
      await withTempTmuxSession(async (fixture) => {
        const home = join(wd, 'home');
        const bin = join(wd, 'bin');
        await mkdir(home, { recursive: true });
        await mkdir(bin, { recursive: true });
        // The PTY is required for detached attach behavior, but it would also
        // trigger OMX's unrelated one-time interactive star prompt. Mark it
        // handled so this harness deterministically exercises only launch exit.
        await mkdir(join(home, '.omx', 'state'), { recursive: true });
        await writeFile(join(home, '.omx', 'state', 'star-prompt.json'), '{"prompted_at":"2026-01-01T00:00:00.000Z"}\n');
        await fixture.createPathShim(bin);
        const omxBin = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'cli', 'omx.js');
        const runPtyLaunch = (childExitStatus: number, remainOnExit: string): { status: number | null; output: string } => {
          writeFileSync(join(bin, 'codex'), `#!/bin/sh\nsleep 1\nexit ${childExitStatus}\n`, { mode: 0o755 });
          // Simulate a user tmux config that would retain the dead leader pane.
          fixture.run(['set-option', '-g', 'remain-on-exit', remainOnExit]);
          const envPrefix = [
            `HOME=${JSON.stringify(home)}`,
            `PATH=${JSON.stringify(bin)}:$PATH`,
            'OMX_AUTO_UPDATE=0',
            'OMX_NOTIFY_FALLBACK=0',
            'OMX_HOOK_DERIVED_SIGNALS=0',
            'TERM=xterm-256color',
          ].map((kv) => `export ${kv}`).join('; ');
          const result = spawnSync(
            'script',
            ['-q', '-e', '-c', `${envPrefix}; cd ${JSON.stringify(wd)} && exec ${JSON.stringify(process.execPath)} ${JSON.stringify(omxBin)} --tmux ${JSON.stringify('e2e prompt')}`, '/dev/null'],
            {
              encoding: 'utf-8',
              timeout: 120_000,
              killSignal: 'SIGKILL',
              env: buildRunOmxEnv({ TMUX: '', TMUX_PANE: '' }),
            },
          );
          return { status: result.status, output: `${result.stdout || ''}\n${result.stderr || ''}` };
        };
        const listOmxSessions = (): string[] => fixture.run(['list-sessions', '-F', '#{session_name}'])
          .split('\n')
          .filter((name) => name.startsWith('omx-') && name !== fixture.sessionName);

        const zero = runPtyLaunch(0, 'on');
        assert.equal(zero.status, 0, `zero-status attached launch must return to the shell successfully:\n${zero.output}`);
        assert.deepEqual(listOmxSessions(), [], 'zero-status exit must destroy the owned detached session despite remain-on-exit=on');

        const seven = runPtyLaunch(7, 'failed');
        assert.equal(seven.status, 7, `nonzero child status must propagate to the invoking shell:\n${seven.output}`);
        assert.deepEqual(listOmxSessions(), [], 'nonzero exit must destroy the owned detached session despite remain-on-exit=failed');
      });
    } finally {
      await rm(wd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
});
