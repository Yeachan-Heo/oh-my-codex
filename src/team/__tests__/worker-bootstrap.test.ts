import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  generateWorkerOverlay,
  applyWorkerOverlay,
  stripWorkerOverlay,
  generateInitialInbox,
  generateTaskAssignmentInbox,
  generateShutdownInbox,
  generateTriggerMessage,
  generateMailboxTriggerMessage,
} from '../worker-bootstrap.js';
import type { TeamTask } from '../state.js';

describe('worker bootstrap', () => {
  it('generateWorkerOverlay produces markdown with correct start/end markers', () => {
    const overlay = generateWorkerOverlay('alpha-team');

    assert.match(overlay, /<!-- OMX:TEAM:WORKER:START -->/);
    assert.match(overlay, /<!-- OMX:TEAM:WORKER:END -->/);
  });

  it('generateWorkerOverlay includes the team name', () => {
    const overlay = generateWorkerOverlay('my-team');
    assert.match(overlay, /team "my-team"/);
    assert.match(overlay, /\.omx\/state\/team\/my-team\/tasks/);
    assert.match(overlay, /tasks\/task-<id>\.json/);
    assert.match(overlay, /task_id: "<id>"/);
    assert.doesNotMatch(overlay, /tasks\/\{id\}\.json/);
  });

  it('applyWorkerOverlay appends to existing AGENTS.md content', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-worker-bootstrap-'));
    try {
      const agentsMdPath = join(cwd, 'AGENTS.md');
      await writeFile(agentsMdPath, '# Base AGENTS\n\nBase content.\n', 'utf8');

      const overlay = generateWorkerOverlay('team-a');
      await applyWorkerOverlay(agentsMdPath, overlay);

      const content = await readFile(agentsMdPath, 'utf8');
      assert.match(content, /# Base AGENTS/);
      assert.match(content, /Base content\./);
      assert.match(content, /<!-- OMX:TEAM:WORKER:START -->/);
      assert.match(content, /<!-- OMX:TEAM:WORKER:END -->/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('applyWorkerOverlay is idempotent (calling twice doesn\'t duplicate)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-worker-bootstrap-'));
    try {
      const agentsMdPath = join(cwd, 'AGENTS.md');
      await writeFile(agentsMdPath, '# Base\n', 'utf8');

      const overlay = generateWorkerOverlay('team-idempotent');
      await applyWorkerOverlay(agentsMdPath, overlay);
      await applyWorkerOverlay(agentsMdPath, overlay);

      const content = await readFile(agentsMdPath, 'utf8');
      const starts = content.match(/<!-- OMX:TEAM:WORKER:START -->/g) ?? [];
      const ends = content.match(/<!-- OMX:TEAM:WORKER:END -->/g) ?? [];

      assert.equal(starts.length, 1);
      assert.equal(ends.length, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('stripWorkerOverlay removes the overlay section', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-worker-bootstrap-'));
    try {
      const agentsMdPath = join(cwd, 'AGENTS.md');
      const base = '# Base\n\nKeep me.\n';
      const overlay = generateWorkerOverlay('team-strip');

      await writeFile(agentsMdPath, `${base}\n${overlay}\n`, 'utf8');
      await stripWorkerOverlay(agentsMdPath);

      const content = await readFile(agentsMdPath, 'utf8');
      assert.match(content, /# Base/);
      assert.match(content, /Keep me\./);
      assert.doesNotMatch(content, /<!-- OMX:TEAM:WORKER:START -->/);
      assert.doesNotMatch(content, /<!-- OMX:TEAM:WORKER:END -->/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('stripWorkerOverlay is idempotent (calling on already-stripped is no-op)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-worker-bootstrap-'));
    try {
      const agentsMdPath = join(cwd, 'AGENTS.md');
      await writeFile(agentsMdPath, '# Base only\n', 'utf8');

      const before = await readFile(agentsMdPath, 'utf8');
      await stripWorkerOverlay(agentsMdPath);
      const afterFirst = await readFile(agentsMdPath, 'utf8');
      await stripWorkerOverlay(agentsMdPath);
      const afterSecond = await readFile(agentsMdPath, 'utf8');

      assert.equal(afterFirst, before);
      assert.equal(afterSecond, before);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('applyWorkerOverlay works on non-existent file (creates it)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-worker-bootstrap-'));
    try {
      const agentsMdPath = join(cwd, 'AGENTS.md');
      const overlay = generateWorkerOverlay('new-team');

      await applyWorkerOverlay(agentsMdPath, overlay);

      const content = await readFile(agentsMdPath, 'utf8');
      assert.match(content, /<!-- OMX:TEAM:WORKER:START -->/);
      assert.match(content, /team "new-team"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('applyWorkerOverlay reaps stale AGENTS lock directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-worker-bootstrap-'));
    try {
      const agentsMdPath = join(cwd, 'AGENTS.md');
      const lockPath = join(cwd, '.omx', 'state', 'agents-md.lock');
      await mkdir(lockPath, { recursive: true });
      await writeFile(
        join(lockPath, 'owner.json'),
        JSON.stringify({ pid: 999_999_999, ts: Date.now() - 60_000 }),
        'utf8',
      );

      await writeFile(agentsMdPath, '# Base\n', 'utf8');
      const overlay = generateWorkerOverlay('team-stale-lock');
      await applyWorkerOverlay(agentsMdPath, overlay);

      const content = await readFile(agentsMdPath, 'utf8');
      assert.match(content, /team "team-stale-lock"/);
      await assert.rejects(readFile(join(lockPath, 'owner.json'), 'utf8'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('generateInitialInbox includes worker name, team name, and all tasks', () => {
    const tasks: TeamTask[] = [
      {
        id: '1',
        subject: 'First task',
        description: 'Do first thing',
        status: 'pending',
        created_at: new Date().toISOString(),
      },
      {
        id: '2',
        subject: 'Second task',
        description: 'Do second thing',
        status: 'in_progress',
        created_at: new Date().toISOString(),
      },
    ];

    const inbox = generateInitialInbox('worker-1', 'team-inbox', 'executor', tasks);

    assert.match(inbox, /# Worker Assignment: worker-1/);
    assert.match(inbox, /\*\*Team:\*\* team-inbox/);
    assert.match(inbox, /\*\*Role:\*\* executor/);
    assert.match(inbox, /\*\*Task 1\*\*: First task/);
    assert.match(inbox, /\*\*Task 2\*\*: Second task/);
  });

  it('generateInitialInbox shows blocked_by info for blocked tasks', () => {
    const tasks: TeamTask[] = [
      {
        id: '3',
        subject: 'Blocked task',
        description: 'Wait on dependencies',
        status: 'pending',
        blocked_by: ['1', '2'],
        created_at: new Date().toISOString(),
      },
    ];

    const inbox = generateInitialInbox('worker-2', 'team-blocked', 'executor', tasks);
    assert.match(inbox, /Blocked by: 1, 2/);
  });

  it('generateTaskAssignmentInbox includes task ID and description', () => {
    const inbox = generateTaskAssignmentInbox('worker-3', 'team-followup', '42', 'Implement parser update');

    assert.match(inbox, /\*\*Task ID:\*\* 42/);
    assert.match(inbox, /Implement parser update/);
    assert.match(inbox, /\.omx\/state\/team\/team-followup\/tasks\/task-42\.json/);
  });

  it('generateShutdownInbox contains exit instruction and concrete ack path', () => {
    const inbox = generateShutdownInbox('team-x', 'worker-1');

    assert.match(inbox, /Shutdown Request/);
    assert.match(inbox, /\.omx\/state\/team\/team-x\/workers\/worker-1\/shutdown-ack\.json/);
    assert.match(inbox, /Type `exit` or press Ctrl\+C/);
  });

  it('generateTriggerMessage is always < 200 characters', () => {
    const message = generateTriggerMessage('worker-very-long-name', 'team-with-a-reasonably-long-name');
    assert.ok(message.length < 200);
  });

  it('generateTriggerMessage does not contain [OMX_TMUX_INJECT]', () => {
    const message = generateTriggerMessage('worker-1', 'team-safe');
    assert.equal(message.includes('[OMX_TMUX_INJECT]'), false);
  });

  it('generateTriggerMessage contains the inbox path', () => {
    const message = generateTriggerMessage('worker-9', 'team-path');
    assert.match(message, /\.omx\/state\/team\/team-path\/workers\/worker-9\/inbox\.md/);
  });

  it('generateMailboxTriggerMessage is always < 200 characters', () => {
    const message = generateMailboxTriggerMessage('worker-long-name', 'team-with-long-name', 42);
    assert.ok(message.length < 200);
  });

  it('generateMailboxTriggerMessage contains mailbox path and count', () => {
    const message = generateMailboxTriggerMessage('worker-2', 'team-mail', 3);
    assert.match(message, /3 new message/);
    assert.match(message, /\.omx\/state\/team\/team-mail\/mailbox\/worker-2\.json/);
  });
});
