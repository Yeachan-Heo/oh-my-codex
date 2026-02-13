import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

async function appendLine(path: string, line: object): Promise<void> {
  const prev = await readFile(path, 'utf-8');
  const content = prev + `${JSON.stringify(line)}\n`;
  await writeFile(path, content);
}

function todaySessionDir(baseHome: string): string {
  const now = new Date();
  return join(
    baseHome,
    '.codex',
    'sessions',
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0')
  );
}

async function readLines(path: string): Promise<string[]> {
  const content = await readFile(path, 'utf-8').catch(() => '');
  return content.split('\n').map(s => s.trim()).filter(Boolean);
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

describe('notify-fallback watcher', () => {
  it('one-shot mode forwards only recent task_complete events', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-once-'));
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-fallback-home-'));
    const sid = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sessionDir = todaySessionDir(tempHome);
    const rolloutPath = join(sessionDir, `rollout-test-fallback-once-${sid}.jsonl`);

    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(sessionDir, { recursive: true });

      const staleIso = new Date(Date.now() - 60_000).toISOString();
      const freshIso = new Date(Date.now() + 2_000).toISOString();
      const threadId = `thread-${sid}`;
      const staleTurn = `turn-stale-${sid}`;
      const freshTurn = `turn-fresh-${sid}`;

      const lines = [
        {
          timestamp: freshIso,
          type: 'session_meta',
          payload: { id: threadId, cwd: wd },
        },
        {
          timestamp: staleIso,
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: staleTurn,
            last_agent_message: 'stale message',
          },
        },
        {
          timestamp: freshIso,
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: freshTurn,
            last_agent_message: 'fresh message',
          },
        },
      ];
      await writeFile(rolloutPath, `${lines.map(v => JSON.stringify(v)).join('\n')}\n`);

      const watcherScript = new URL('../../../scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../scripts/notify-hook.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '50'],
        { encoding: 'utf-8', env: { ...process.env, HOME: tempHome } }
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const turnLog = join(wd, '.omx', 'logs', `turns-${new Date().toISOString().split('T')[0]}.jsonl`);
      const turnLines = await readLines(turnLog);
      assert.equal(turnLines.length, 1);
      assert.match(turnLines[0], new RegExp(freshTurn));
      assert.doesNotMatch(turnLines[0], new RegExp(staleTurn));
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(tempHome, { recursive: true, force: true });
      await rm(rolloutPath, { force: true });
    }
  });

  it('streaming mode tails from EOF and does not replay backlog', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-fallback-stream-'));
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-fallback-home-'));
    const sid = randomUUID();
    const sessionDir = todaySessionDir(tempHome);
    const rolloutPath = join(sessionDir, `rollout-test-fallback-stream-${sid}.jsonl`);

    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(sessionDir, { recursive: true });

      const nowIso = new Date().toISOString();
      const threadId = `thread-${sid}`;
      const oldTurn = `turn-old-${sid}`;
      const newTurn = `turn-new-${sid}`;

      await writeFile(
        rolloutPath,
        `${JSON.stringify({
          timestamp: nowIso,
          type: 'session_meta',
          payload: { id: threadId, cwd: wd },
        })}\n${
          JSON.stringify({
            timestamp: nowIso,
            type: 'event_msg',
            payload: {
              type: 'task_complete',
              turn_id: oldTurn,
              last_agent_message: 'old message',
            },
          })
        }\n`
      );

      const watcherScript = new URL('../../../scripts/notify-fallback-watcher.js', import.meta.url).pathname;
      const notifyHook = new URL('../../../scripts/notify-hook.js', import.meta.url).pathname;
      const child = spawn(
        process.execPath,
        [watcherScript, '--cwd', wd, '--notify-script', notifyHook, '--poll-ms', '75'],
        {
          cwd: wd,
          stdio: 'ignore',
          env: { ...process.env, HOME: tempHome },
        }
      );
      await sleep(150);

      await appendLine(rolloutPath, {
        timestamp: new Date(Date.now() + 500).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: newTurn,
          last_agent_message: 'new message',
        },
      });

      await sleep(500);
      child.kill('SIGTERM');
      await sleep(100);

      const turnLog = join(wd, '.omx', 'logs', `turns-${new Date().toISOString().split('T')[0]}.jsonl`);
      const turnLines = await readLines(turnLog);
      assert.equal(turnLines.length, 1);
      assert.match(turnLines[0], new RegExp(newTurn));
      assert.doesNotMatch(turnLines[0], new RegExp(oldTurn));
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(tempHome, { recursive: true, force: true });
      await rm(rolloutPath, { force: true });
    }
  });
});
