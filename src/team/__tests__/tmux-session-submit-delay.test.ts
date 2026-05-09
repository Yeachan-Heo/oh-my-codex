import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sendToWorker } from '../tmux-session.js';

const READY_CODEX_CAPTURE = `OpenAI Codex
model: test
directory: /tmp/demo

› Write tests for @filename`;

async function withFakeTmux(
  run: (ctx: { logPath: string }) => Promise<void>,
): Promise<void> {
  const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-tmux-submit-delay-'));
  const previousPath = process.env.PATH;
  const logPath = join(fakeBinDir, 'tmux.log');

  try {
    await writeFile(join(fakeBinDir, 'tmux'), `#!/bin/sh
set -eu
text_sent_file="${fakeBinDir}/text-sent"
printf '%s\\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    if [ -f "$text_sent_file" ]; then
      printf 'initialized in .\\n\\n◦ Waiting for background terminal (1s…)\\n'
    else
      cat <<'EOF'
${READY_CODEX_CAPTURE}
EOF
    fi
    ;;
  send-keys)
    if [ "\${4:-}" = "-l" ] && [ "\${6:-}" = "check inbox" ]; then
      : > "$text_sent_file"
    fi
    ;;
esac
`);
    await chmod(join(fakeBinDir, 'tmux'), 0o755);
    process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
    await run({ logPath });
  } finally {
    if (typeof previousPath === 'string') process.env.PATH = previousPath;
    else delete process.env.PATH;
    await rm(fakeBinDir, { recursive: true, force: true });
  }
}

describe('sendToWorker tmux submit timing', () => {
  it('preserves the legacy 150ms first-submit settle fallback when config is absent', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-tmux-submit-delay-home-'));
    const previousCodexHome = process.env.CODEX_HOME;
    const sleeps: number[] = [];

    try {
      process.env.CODEX_HOME = codexHome;

      await withFakeTmux(async () => {
        await sendToWorker('omx-team-x', 1, 'check inbox', undefined, undefined, {
          sleepImpl: async (ms) => { sleeps.push(ms); },
        });

        assert.deepEqual(sleeps.slice(0, 3), [150, 100, 100]);
      });
    } finally {
      if (typeof previousCodexHome === 'string') process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('uses configured settle and repeat delays without waiting on wall-clock time', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-tmux-submit-delay-home-'));
    const previousCodexHome = process.env.CODEX_HOME;
    const sleeps: number[] = [];

    try {
      await writeFile(
        join(codexHome, 'config.toml'),
        '[omx]\ntmux_submit_settle_ms = 600\ntmux_submit_repeat_delay_ms = 10\n',
      );
      process.env.CODEX_HOME = codexHome;

      await withFakeTmux(async ({ logPath }) => {
        await sendToWorker('omx-team-x', 1, 'check inbox', undefined, undefined, {
          sleepImpl: async (ms) => { sleeps.push(ms); },
        });

        const log = await readFile(logPath, 'utf-8');
        assert.deepEqual(sleeps.slice(0, 3), [600, 10, 10]);
        assert.match(log, /send-keys -t omx-team-x:1 -l -- check inbox/);
        assert.match(log, /send-keys -t omx-team-x:1 C-m/);
      });
    } finally {
      if (typeof previousCodexHome === 'string') process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});
