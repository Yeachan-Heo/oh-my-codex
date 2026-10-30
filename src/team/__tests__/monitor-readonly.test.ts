import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { initTeamState, createTask } from '../state.js';
import { monitorTeam } from '../runtime.js';

async function snapshot(root: string, dir = root): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, await snapshot(root, path));
    else files[relative(root, path)] = (await readFile(path)).toString('base64');
  }
  return files;
}

it('observes expired claims without mutating files or reporting a successful reclaim', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-monitor-readonly-'));
  try {
    await initTeamState('readonly-proof', 'inspect', 'executor', 1, cwd);
    const task = await createTask('readonly-proof', {
      subject: 'expired work', description: 'keep original claim',
      status: 'in_progress', owner: 'worker-1',
    }, cwd);
    const path = join(cwd, '.omx', 'state', 'team', 'readonly-proof', 'tasks', `task-${task.id}.json`);
    await writeFile(path, JSON.stringify({ ...task, claim: {
      owner: 'worker-1', token: 'readonly-test', leased_until: '2000-01-01T00:00:00.000Z',
    } }));
    const before = await snapshot(cwd);
    const result = await monitorTeam('readonly-proof', cwd, { readOnly: true });
    assert.ok(result);
    assert.deepEqual(await snapshot(cwd), before);
    assert.ok(result.recommendations.some((message) => message.includes('remains unreclaimed')));
    assert.ok(result.recommendations.every((message) => !message.startsWith('Reclaimed')));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('retains snapshot persistence for ordinary monitoring', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-monitor-mutable-'));
  try {
    await initTeamState('mutable-proof', 'inspect', 'executor', 1, cwd);
    const before = await snapshot(cwd);
    assert.ok(await monitorTeam('mutable-proof', cwd));
    assert.notDeepEqual(await snapshot(cwd), before);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
