import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOTIFY_HOOK_SCRIPT = new URL('../../../scripts/notify-hook.js', import.meta.url);

async function withTempWorkingDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-notify-team-nudge-'));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2));
}

describe('notify-hook team leader nudge', () => {
  it('nudges leader via tmux display-message when team is active and mailbox has messages', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'alpha';
      const teamDir = join(stateDir, 'team', teamName);
      const mailboxDir = join(teamDir, 'mailbox');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(mailboxDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'team-state.json'), {
        active: true,
        team_name: teamName,
        current_phase: 'team-exec',
      });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
      });
      await writeJson(join(mailboxDir, 'leader-fixed.json'), {
        worker: 'leader-fixed',
        messages: [
          {
            message_id: 'm1',
            from_worker: 'worker-1',
            to_worker: 'leader-fixed',
            body: 'ACK',
            created_at: '2026-02-14T00:00:00.000Z',
          },
        ],
      });

      const fakeTmux = `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  echo "%1 1"
  exit 0
fi
exit 0
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const payload = {
        cwd,
        type: 'agent-turn-complete',
        'thread-id': 'thread-test',
        'turn-id': 'turn-test',
        'input-messages': ['test'],
        'last-assistant-message': 'output',
      };

      const result = spawnSync(process.execPath, [NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
          OMX_TEAM_LEADER_NUDGE_MS: '10000',
        },
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /display-message/);
      assert.match(tmuxLog, /-t devsess:0/);
      assert.match(tmuxLog, /Team alpha:/);
    });
  });
});
