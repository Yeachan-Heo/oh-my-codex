import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

describe('omx resume', () => {
  it('exposes project-local Codex history artifacts to codex resume', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-project-history-'));
    try {
      const home = join(wd, 'home');
      const projectCodexHome = join(wd, '.codex');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const rolloutPath = join(projectCodexHome, 'sessions', '2026', '06', '03', 'rollout-session-2712.jsonl');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(join(wd, '.omx'), { recursive: true });
      await mkdir(dirname(rolloutPath), { recursive: true });
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await writeFile(join(projectCodexHome, 'config.toml'), 'model = "gpt-5.5"\n');
      await writeFile(join(projectCodexHome, 'state_5.sqlite'), 'state db placeholder');
      await writeFile(join(projectCodexHome, 'state_5.sqlite-wal'), 'state db wal placeholder');
      await writeFile(rolloutPath, '{"type":"session_meta","payload":{"id":"session-2712"}}\n');

      await writeFile(fakeCodexPath, `#!/bin/sh
printf 'fake-codex:%s\n' "$*"
printf 'codex-home:%s\n' "$CODEX_HOME"
printf 'sqlite-home:%s\n' "$CODEX_SQLITE_HOME"
if [ -f "$CODEX_HOME/state_5.sqlite" ]; then echo state-present=yes; else echo state-present=no; fi
if [ -f "$CODEX_HOME/state_5.sqlite-wal" ]; then echo wal-present=yes; else echo wal-present=no; fi
if [ -f "$CODEX_HOME/sessions/2026/06/03/rollout-session-2712.jsonl" ]; then echo rollout-present=yes; else echo rollout-present=no; fi
`);
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['resume'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume\b/);
      assert.match(result.stdout, new RegExp(`sqlite-home:${projectCodexHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(result.stdout, /codex-home:.*\.omx\/runtime\/codex-home\//);
      assert.match(result.stdout, /state-present=yes/);
      assert.match(result.stdout, /wal-present=yes/);
      assert.match(result.stdout, /rollout-present=yes/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('forwards --last to codex resume through the normal launch wrapper', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-cli-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(fakeCodexPath, '#!/bin/sh\nprintf \'fake-codex:%s\\n\' \"$*\"\n');
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['resume', '--last'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume --last\b/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('passes resume --help through to codex instead of printing top-level omx help', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-cli-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(fakeCodexPath, '#!/bin/sh\nprintf \'fake-codex:%s\\n\' \"$*\"\n');
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['resume', '--help'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume --help\b/);
      assert.doesNotMatch(result.stdout, /Unknown command: resume/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
