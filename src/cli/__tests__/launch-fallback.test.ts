import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    env: {
      ...process.env,
      ...envOverrides,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || '',
  };
}

function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, `'\"'\"'`)}'`;
}

function runOmxWithTty(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');
  const command = [process.execPath, omxBin, ...argv].map(shellEscape).join(' ');
  const result = spawnSync('script', ['-qfec', command, '/dev/null'], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...envOverrides,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || '',
  };
}

function shouldSkipForSpawnPermissions(err: string): boolean {
  return typeof err === 'string' && /(EPERM|EACCES)/i.test(err);
}

describe('omx launch fallback when tmux is unavailable', () => {
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

describe('omx launcher when tmux is available', () => {
  it('launches --madmax through detached tmux so HUD bootstrap can run', async () => {
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
      await chmod(fakeTmuxPath, 0o755);

      const result = runOmxWithTty(
        wd,
        ['--madmax'],
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
      assert.match(tmuxLog, /tmux:new-session .* -s /);
      assert.match(tmuxLog, /tmux:split-window -v -l 2 .* -t /);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
