import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { initTeamState } from '../../team/state.js';
import { dispatchCodexNativeHook } from '../codex-native-hook.js';

async function withWorker(check: (cwd: string, tasks: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-worker-stop-read-'));
  const keys = ['OMX_TEAM_INTERNAL_WORKER', 'OMX_TEAM_WORKER', 'OMX_TEAM_STATE_ROOT'] as const;
  const previous = keys.map((key) => process.env[key]);
  try {
    process.env.OMX_TEAM_STATE_ROOT = join(cwd, '.omx/state');
    await initTeamState('audit', 'audit', 'executor', 1, cwd);
    process.env.OMX_TEAM_INTERNAL_WORKER = 'audit/worker-1';
    process.env.OMX_TEAM_WORKER = 'audit/worker-1';
    const root = join(cwd, '.omx/state/team/audit');
    await writeFile(join(root, 'workers/worker-1/identity.json'), JSON.stringify({ name: 'worker-1', assigned_tasks: ['1'] }));
    await writeFile(join(root, 'workers/worker-1/status.json'), JSON.stringify({ state: 'idle', current_task_id: '1' }));
    await writeFile(join(root, 'tasks/task-1.json'), JSON.stringify({ id: '1', owner: 'worker-1', status: 'completed' }));
    await check(cwd, join(root, 'tasks'));
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await rm(cwd, { recursive: true, force: true });
  }
}

async function stop(cwd: string) {
  return (await dispatchCodexNativeHook({ hook_event_name: 'Stop', cwd, session_id: 'worker-stop-audit' }, { cwd })).outputJson;
}

it('does not let an unreadable unlisted task turn a blocked Stop into an allowed Stop', async () => {
  await withWorker(async (cwd, tasks) => {
    const task = join(tasks, 'task-2.json');
    await writeFile(task, JSON.stringify({ id: '2', owner: 'worker-1', status: 'in_progress' }));
    assert.equal((await stop(cwd))?.decision, 'block');
    for (const invalid of ['{invalid', 'null', '[]', '42', '{"id":"2"}', '{"id":"2","status":"unknown"}', '{"id":"1","status":"completed"}']) {
      await writeFile(task, invalid);
      assert.equal((await stop(cwd))?.decision, 'block', invalid);
      assert.equal(await readFile(task, 'utf8'), invalid);
    }
  });
});

it('fails closed when task enumeration fails despite a readable completed assignment', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  await withWorker(async (cwd, tasks) => {
    await chmod(tasks, 0o111);
    try {
      assert.equal((await stop(cwd))?.decision, 'block');
    } finally {
      await chmod(tasks, 0o700);
    }
  });
});

it('still allows Stop when all recorded worker tasks are readable and completed', async () => {
  await withWorker(async (cwd) => assert.equal(await stop(cwd), null));
});

it('returns a blocking decision through the real native hook CLI for corrupt task JSON', async () => {
  await withWorker(async (cwd, tasks) => {
    await writeFile(join(tasks, 'task-2.json'), '{invalid');
    const output = execFileSync(process.execPath, [fileURLToPath(new URL('../codex-native-hook.js', import.meta.url))], {
      cwd, input: JSON.stringify({ hook_event_name: 'Stop', cwd, session_id: 'worker-stop-cli-audit' }),
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(JSON.parse(output).decision, 'block');
  });
});
