import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { collectSidecarSnapshot, readTailText } from '../collector.js';

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function snapshotFiles(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        result.set(relative(root, path), await readFile(path, 'utf-8'));
      }
    }
  }
  await visit(root);
  return result;
}

async function withFixture(test: (cwd: string, teamRoot: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-sidecar-'));
  try {
    const teamRoot = join(cwd, '.omx', 'state', 'team', 'demo');
    await mkdir(teamRoot, { recursive: true });
    await test(cwd, teamRoot);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('collectSidecarSnapshot', () => {
  it('normalizes existing team state without migrating legacy config or mutating files', async () => {
    await withFixture(async (cwd, teamRoot) => {
      await writeJson(join(teamRoot, 'config.json'), {
        name: 'demo',
        task: 'ship sidecar',
        worker_count: 2,
        tmux_session: 'omx-demo',
        leader_pane_id: '%1',
        hud_pane_id: '%2',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: ['1'], pane_id: '%3' },
          { name: 'worker-2', index: 2, role: 'verifier', assigned_tasks: ['2'], pane_id: '%4' },
        ],
      });
      await writeJson(join(teamRoot, 'tasks', 'task-1.json'), {
        id: '1', subject: 'Implement collector', status: 'in_progress', owner: 'worker-1', version: 3,
        claim: { owner: 'worker-1', token: 'secret-claim-token', leased_until: '2026-04-27T02:10:00.000Z' },
      });
      await writeJson(join(teamRoot, 'tasks', 'task-2.json'), {
        id: '2', subject: 'Blocked verification', status: 'blocked', owner: 'worker-2', blocked_by: ['1'], version: 1,
      });
      await writeJson(join(teamRoot, 'tasks', 'task-3.json'), {
        id: '3', subject: 'Failed smoke', status: 'failed', owner: 'worker-2', error: 'smoke failed', version: 1,
      });
      await writeJson(join(teamRoot, 'workers', 'worker-1', 'status.json'), {
        state: 'working', current_task_id: '1', updated_at: '2026-04-27T02:00:00.000Z',
      });
      await writeJson(join(teamRoot, 'workers', 'worker-1', 'heartbeat.json'), {
        pid: 123, alive: true, turn_count: 8, last_turn_at: '2026-04-27T02:00:01.000Z',
      });
      await writeJson(join(teamRoot, 'workers', 'worker-2', 'status.json'), {
        state: 'blocked', reason: 'needs plan approval', current_task_id: '2', updated_at: '2026-04-27T02:00:02.000Z',
      });
      await writeJson(join(teamRoot, 'workers', 'worker-2', 'heartbeat.json'), {
        pid: 456, alive: false, turn_count: 2, last_turn_at: '2026-04-27T01:59:00.000Z',
      });
      await writeJson(join(teamRoot, 'phase.json'), { current_phase: 'team-exec' });
      await writeJson(join(teamRoot, 'monitor-snapshot.json'), {
        workerTurnCountByName: { 'worker-1': 1 },
        workerTaskIdByName: { 'worker-1': '1' },
      });
      await mkdir(join(teamRoot, 'events'), { recursive: true });
      await writeFile(join(teamRoot, 'events', 'events.ndjson'), [
        JSON.stringify({ event_id: 'e1', team: 'demo', type: 'worker_idle', worker: 'worker-2', reason: 'waiting', created_at: '2026-04-27T02:00:03.000Z' }),
        JSON.stringify({ event_id: 'e2', team: 'demo', type: 'task_failed', worker: 'worker-2', task_id: '3', reason: 'smoke failed', created_at: '2026-04-27T02:00:04.000Z' }),
      ].join('\n'));
      await writeJson(join(teamRoot, 'mailbox', 'worker-1.json'), { messages: ['must remain unchanged'] });

      const before = await snapshotFiles(teamRoot);
      const snapshot = await collectSidecarSnapshot('demo', { cwd, now: new Date('2026-04-27T02:01:00.000Z') });
      const after = await snapshotFiles(teamRoot);

      assert.deepEqual(after, before, 'sidecar collector must be read-only over team state');
      assert.ok(!after.has('manifest.v2.json'), 'legacy config must not be migrated into a v2 manifest');
      assert.ok(snapshot);
      assert.equal(snapshot.schema_version, 'omx.sidecar/v1');
      assert.ok(!JSON.stringify(snapshot).includes('secret-claim-token'), 'claim tokens must never be exposed in sidecar snapshots');
      assert.deepEqual(snapshot.tasks.find((task) => task.id === '1')?.claim, { owner: 'worker-1', leased_until: '2026-04-27T02:10:00.000Z' });
      assert.equal(snapshot.phase, 'team-exec');
      assert.equal(snapshot.workers.length, 2);
      assert.equal(snapshot.events[0]?.type, 'worker_state_changed');
      assert.equal(snapshot.events[0]?.source_type, 'worker_idle');
      assert.deepEqual(snapshot.panes.map((pane) => pane.pane_id), ['%1', '%2', '%3', '%4']);
      assert.ok(snapshot.highlights.some((highlight) => highlight.kind === 'blocked-worker' && highlight.target === 'worker-2'));
      assert.ok(snapshot.highlights.some((highlight) => highlight.kind === 'dead-worker' && highlight.target === 'worker-2'));
      assert.ok(snapshot.highlights.some((highlight) => highlight.kind === 'non-reporting-worker' && highlight.target === 'worker-1'));
      assert.ok(snapshot.highlights.some((highlight) => highlight.kind === 'blocked-task' && highlight.target === 'task-2'));
      assert.ok(snapshot.highlights.some((highlight) => highlight.kind === 'failed-task' && highlight.target === 'task-3'));
      assert.match(snapshot.topology.summary, /2 workers/);
    });
  });

  it('rejects unsafe team names before reading state', async () => {
    await assert.rejects(() => collectSidecarSnapshot('../demo', { cwd: '/tmp' }), /Invalid team name/);
  });

  it('skips unsafe worker names before resolving worker state paths', async () => {
    await withFixture(async (cwd, teamRoot) => {
      await writeJson(join(teamRoot, 'config.json'), {
        name: 'demo',
        task: 'ship sidecar',
        tmux_session: 'omx-demo',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor' },
          { name: '../escape', index: 2, role: 'executor' },
        ],
      });
      await writeJson(join(teamRoot, 'workers', 'worker-1', 'status.json'), { state: 'idle' });
      await writeJson(join(teamRoot, 'escape', 'status.json'), { state: 'working', current_task_id: 'escaped-status' });

      const snapshot = await collectSidecarSnapshot('demo', { cwd, now: new Date('2026-04-27T02:01:00.000Z') });

      assert.ok(snapshot);
      assert.deepEqual(snapshot.workers.map((worker) => worker.name), ['worker-1']);
      assert.ok(snapshot.source_warnings.some((warning) => warning.includes('skipped unsafe worker name: ../escape')));
      assert.ok(!JSON.stringify(snapshot).includes('escaped-status'));
    });
  });

  it('returns recent events from a bounded tail window', async () => {
    await withFixture(async (cwd, teamRoot) => {
      await writeJson(join(teamRoot, 'config.json'), {
        name: 'demo',
        task: 'ship sidecar',
        tmux_session: 'omx-demo',
        workers: [{ name: 'worker-1', index: 1, role: 'executor' }],
      });
      await mkdir(join(teamRoot, 'events'), { recursive: true });
      const eventPath = join(teamRoot, 'events', 'events.ndjson');
      const lines = [
        '{invalid-json',
        ...Array.from({ length: 30 }, (_, index) => JSON.stringify({
          event_id: `e${index + 1}`,
          team: 'demo',
          type: 'worker_state_changed',
          worker: 'worker-1',
          state: 'idle',
          created_at: `2026-04-27T02:${String(index).padStart(2, '0')}:00.000Z`,
        })),
      ];
      await writeFile(eventPath, `${lines.join('\n')}\n`);

      const tail = await readTailText(eventPath, 80);
      assert.ok(tail);
      assert.ok(Buffer.byteLength(tail) <= 80);

      const snapshot = await collectSidecarSnapshot('demo', { cwd, eventLimit: 3, now: new Date('2026-04-27T02:31:00.000Z') });

      assert.ok(snapshot);
      assert.deepEqual(snapshot.events.map((event) => event.event_id), ['e28', 'e29', 'e30']);
    });
  });
});
