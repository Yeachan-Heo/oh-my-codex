import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
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
      CODEX_SQLITE_HOME: '',
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
      const canonicalProjectCodexHome = join(await realpath(wd), '.codex');
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
      assert.match(result.stdout, new RegExp(`sqlite-home:${canonicalProjectCodexHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(result.stdout, /codex-home:.*\.omx\/runtime\/codex-home\//);
      assert.match(result.stdout, /state-present=yes/);
      assert.match(result.stdout, /wal-present=yes/);
      assert.match(result.stdout, /rollout-present=yes/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('persists project-scope runtime Codex transcripts after cleanup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-project-history-cleanup-'));
    try {
      const home = join(wd, 'home');
      const projectCodexHome = join(wd, '.codex');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(join(wd, '.omx'), { recursive: true });
      await mkdir(projectCodexHome, { recursive: true });
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await writeFile(join(projectCodexHome, 'config.toml'), 'model = "gpt-5.5"\n');

      await writeFile(fakeCodexPath, `#!/bin/sh
mkdir -p "$CODEX_HOME/sessions/2026/06/16"
printf '{"type":"session_meta","payload":{"id":"session-2835"}}\n' > "$CODEX_HOME/sessions/2026/06/16/rollout-session-2835.jsonl"
printf '{"session_id":"session-2835"}\n' > "$CODEX_HOME/history.jsonl"
printf '{"id":"session-2835"}\n' > "$CODEX_HOME/session_index.jsonl"
printf 'fake-codex:%s\n' "$*"
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
      assert.equal(
        await readFile(join(projectCodexHome, 'sessions', '2026', '06', '16', 'rollout-session-2835.jsonl'), 'utf-8'),
        '{"type":"session_meta","payload":{"id":"session-2835"}}\n',
      );
      assert.equal(await readFile(join(projectCodexHome, 'history.jsonl'), 'utf-8'), '{"session_id":"session-2835"}\n');
      assert.equal(await readFile(join(projectCodexHome, 'session_index.jsonl'), 'utf-8'), '{"id":"session-2835"}\n');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('includes generated project runtime Codex home sessions for plain resume', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-generated-runtime-'));
    try {
      const home = join(wd, 'home');
      const projectCodexHome = join(wd, '.codex');
      const runtimeCodexHome = join(wd, '.omx', 'runtime', 'codex-home', 'omx-existing-runtime');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const runtimeRolloutPath = join(runtimeCodexHome, 'sessions', '2026', '06', '17', 'rollout-runtime-session.jsonl');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(join(wd, '.omx'), { recursive: true });
      await mkdir(projectCodexHome, { recursive: true });
      await mkdir(dirname(runtimeRolloutPath), { recursive: true });
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await writeFile(join(projectCodexHome, 'config.toml'), 'model = "gpt-5.5"\n');
      await writeFile(runtimeRolloutPath, '{"type":"session_meta","payload":{"id":"runtime-session"}}\n');

      await writeFile(fakeCodexPath, `#!/bin/sh
printf 'fake-codex:%s\n' "$*"
printf 'codex-home:%s\n' "$CODEX_HOME"
if [ -f "$CODEX_HOME/sessions/2026/06/17/rollout-runtime-session.jsonl" ]; then echo runtime-rollout-present=yes; else echo runtime-rollout-present=no; fi
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
      assert.match(result.stdout, /codex-home:.*\.omx\/runtime\/codex-home\//);
      assert.match(result.stdout, /runtime-rollout-present=yes/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not duplicate generated runtime history across repeated plain resume cleanup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-runtime-history-dedupe-'));
    try {
      const home = join(wd, 'home');
      const projectCodexHome = join(wd, '.codex');
      const runtimeCodexHome = join(wd, '.omx', 'runtime', 'codex-home', 'omx-existing-runtime');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const runtimeRolloutPath = join(runtimeCodexHome, 'sessions', '2026', '06', '17', 'rollout-runtime-session.jsonl');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(join(wd, '.omx'), { recursive: true });
      await mkdir(projectCodexHome, { recursive: true });
      await mkdir(dirname(runtimeRolloutPath), { recursive: true });
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await writeFile(join(projectCodexHome, 'config.toml'), 'model = "gpt-5.5"\n');
      await writeFile(join(projectCodexHome, 'history.jsonl'), '{"session_id":"project-session"}\n');
      await writeFile(join(projectCodexHome, 'session_index.jsonl'), '{"id":"project-session"}\n');
      await writeFile(runtimeRolloutPath, '{"type":"session_meta","payload":{"id":"runtime-session"}}\n');
      await writeFile(join(runtimeCodexHome, 'history.jsonl'), '{"session_id":"runtime-session"}\n');
      await writeFile(join(runtimeCodexHome, 'session_index.jsonl'), '{"id":"runtime-session"}\n');

      await writeFile(fakeCodexPath, `#!/bin/sh
printf 'fake-codex:%s\n' "$*"
`);
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const env = {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      };

      const first = runOmx(wd, ['resume'], env);
      assert.equal(first.status, 0, first.error || first.stderr || first.stdout);
      const second = runOmx(wd, ['resume'], env);
      assert.equal(second.status, 0, second.error || second.stderr || second.stdout);

      assert.equal(
        await readFile(join(projectCodexHome, 'history.jsonl'), 'utf-8'),
        '{"session_id":"project-session"}\n{"session_id":"runtime-session"}\n',
      );
      assert.equal(
        await readFile(join(projectCodexHome, 'session_index.jsonl'), 'utf-8'),
        '{"id":"project-session"}\n{"id":"runtime-session"}\n',
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('uses --codex-home as an explicit resume escape hatch', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-codex-home-'));
    try {
      const home = join(wd, 'home');
      const explicitCodexHome = join(wd, 'explicit-codex-home');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const rolloutPath = join(explicitCodexHome, 'sessions', '2026', '06', '17', 'rollout-explicit-session.jsonl');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(dirname(rolloutPath), { recursive: true });
      await writeFile(rolloutPath, '{"type":"session_meta","payload":{"id":"explicit-session"}}\n');
      await writeFile(fakeCodexPath, `#!/bin/sh
printf 'fake-codex:%s\n' "$*"
printf 'codex-home:%s\n' "$CODEX_HOME"
if [ -f "$CODEX_HOME/sessions/2026/06/17/rollout-explicit-session.jsonl" ]; then echo explicit-rollout-present=yes; else echo explicit-rollout-present=no; fi
`);
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['resume', '--codex-home', explicitCodexHome, '--last'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume --last\b/);
      assert.match(result.stdout, new RegExp(`codex-home:${explicitCodexHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(result.stdout, /explicit-rollout-present=yes/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('filters resume to generated project runtime homes with --project', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-project-filter-'));
    try {
      const home = join(wd, 'home');
      const projectCodexHome = join(wd, '.codex');
      const runtimeCodexHome = join(wd, '.omx', 'runtime', 'codex-home', 'omx-existing-runtime');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const projectRolloutPath = join(projectCodexHome, 'sessions', '2026', '06', '17', 'rollout-project-session.jsonl');
      const runtimeRolloutPath = join(runtimeCodexHome, 'sessions', '2026', '06', '17', 'rollout-runtime-session.jsonl');

      await mkdir(home, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(dirname(projectRolloutPath), { recursive: true });
      await mkdir(dirname(runtimeRolloutPath), { recursive: true });
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await writeFile(projectRolloutPath, '{"type":"session_meta","payload":{"id":"project-session"}}\n');
      await writeFile(runtimeRolloutPath, '{"type":"session_meta","payload":{"id":"runtime-session"}}\n');
      await writeFile(fakeCodexPath, `#!/bin/sh
printf 'fake-codex:%s\n' "$*"
if [ -f "$CODEX_HOME/sessions/2026/06/17/rollout-runtime-session.jsonl" ]; then echo runtime-rollout-present=yes; else echo runtime-rollout-present=no; fi
if [ -f "$CODEX_HOME/sessions/2026/06/17/rollout-project-session.jsonl" ]; then echo project-rollout-present=yes; else echo project-rollout-present=no; fi
mkdir -p "$CODEX_HOME/sessions/2026/06/18"
printf '{"type":"session_meta","payload":{"id":"new-project-resume"}}\n' > "$CODEX_HOME/sessions/2026/06/18/rollout-new-project-resume.jsonl"
`);
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['resume', '--project'], {
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });

      assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume\b/);
      assert.match(result.stdout, /runtime-rollout-present=yes/);
      assert.match(result.stdout, /project-rollout-present=no/);
      const runtimeDirs = await readdir(join(wd, '.omx', 'runtime', 'codex-home'));
      const persistedNewTranscript = await Promise.all(runtimeDirs.map(async (dir) => {
        const transcript = join(wd, '.omx', 'runtime', 'codex-home', dir, 'sessions', '2026', '06', '18', 'rollout-new-project-resume.jsonl');
        return readFile(transcript, 'utf-8').catch(() => '');
      }));
      assert.ok(persistedNewTranscript.some((content) => content.includes('new-project-resume')));
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

  it('resumes unified CLI entries through codex resume in the original identity', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-unified-cli-'));
    try {
      const home = join(wd, 'home');
      const codexHome = join(home, '.codex');
      const authDir = join(home, '.omx', 'auth');
      const fakeBin = join(wd, 'bin');
      const fakeCodexPath = join(fakeBin, 'codex');
      const fakePsPath = join(fakeBin, 'ps');
      const rolloutPath = join(codexHome, 'sessions', '2026', '06', '13', 'rollout-session-unified.jsonl');
      await mkdir(dirname(rolloutPath), { recursive: true });
      await mkdir(authDir, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(join(codexHome, 'auth.json'), '{"access_token":"old"}\n');
      await writeFile(join(authDir, 'main.json'), '{"access_token":"main-secret"}\n');
      await writeFile(join(authDir, 'slots.json'), JSON.stringify({ version: 1, currentSlot: 'main', slots: [
        { slot: 'main', createdAt: 'now', updatedAt: 'now', kind: 'chatgpt' }
      ] }));
      await writeFile(rolloutPath, '{"type":"session_meta","payload":{"id":"session-unified","cwd":"/repo","timestamp":"2026-06-13T00:00:00.000Z"}}\n');
      await writeFile(fakeCodexPath, '#!/bin/sh\nprintf \'fake-codex:%s\\n\' "$*"\nprintf \'auth:%s\\n\' "$(cat "$CODEX_HOME/auth.json")"\n');
      await chmod(fakeCodexPath, 0o755);
      await writeFile(fakePsPath, '#!/bin/sh\nexit 0\n');
      await chmod(fakePsPath, 0o755);

      const result = runOmx(wd, ['resume', '--unified', 'session-unified'], {
        HOME: home,
        CODEX_HOME: codexHome,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /fake-codex:resume session-unified/);
      assert.match(result.stdout, /main-secret/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('opens unified App entries at their original read-only cache target', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-resume-unified-app-'));
    try {
      const home = join(wd, 'home');
      const appDir = join(home, 'Library', 'Application Support', 'com.openai.chat', 'codex-taskItems-v2-default-user');
      await mkdir(appDir, { recursive: true });
      const result = runOmx(wd, ['resume', '--unified', 'taskItems'], {
        HOME: home,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Open original Codex App session source/);
      assert.match(result.stdout, /codex-taskItems-v2-default-user/);
      assert.match(result.stdout, /read-only metadata/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
