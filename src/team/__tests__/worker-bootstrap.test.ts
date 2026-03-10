import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  generateWorkerOverlay,
  applyWorkerOverlay,
  stripWorkerOverlay,
  writeTeamWorkerInstructionsFile,
  writeWorkerRoleInstructionsFile,
  removeTeamWorkerInstructionsFile,
  generateInitialInbox,
  generateTaskAssignmentInbox,
  generateShutdownInbox,
  generateTriggerMessage,
  generateMailboxTriggerMessage,
} from '../worker-bootstrap.js';
import type { TeamTask } from '../state.js';

describe('worker bootstrap', () => {
  it('worker skill lifecycle instructions are claim-safe (issue #448)', async () => {
    const workerSkill = await readFile(join(process.cwd(), 'skills', 'worker', 'SKILL.md'), 'utf8');

    assert.match(workerSkill, /omx team api claim-task/);
    assert.match(workerSkill, /omx team api transition-task-status/);
    assert.match(workerSkill, /omx team api release-task-claim/);
    assert.match(workerSkill, /\$\{CODEX_HOME:-~\/\.codex\}\/skills\/worker\/SKILL\.md/);
    assert.doesNotMatch(workerSkill, /Write completion to the task file/i);
    assert.doesNotMatch(workerSkill, /`?\{"status":"completed","result":"\.\.\."\}`?/);
    assert.doesNotMatch(workerSkill, /`?\{"status":"failed","error":"\.\.\."\}`?/);
  });

  it('generateWorkerOverlay produces markdown with correct start/end markers', () => {
    const overlay = generateWorkerOverlay('alpha-team');

    assert.match(overlay, /<!-- OMX:TEAM:WORKER:START -->/);
    assert.match(overlay, /<!-- OMX:TEAM:WORKER:END -->/);
  });

  it('generateWorkerOverlay includes the team name', () => {
    const overlay = generateWorkerOverlay('my-team');
    assert.match(overlay, /team "my-team"/);
    assert.match(overlay, /\$\{CODEX_HOME:-~\/\.codex\}\/skills\/worker\/SKILL\.md/);
    assert.match(overlay, /~\/\.agents\/skills\/worker\/SKILL\.md/);
    assert.match(overlay, /Resolve canonical team state root/i);
    assert.match(overlay, /<team_state_root>\/team\/my-team\/tasks/);
    assert.match(overlay, /tasks\/task-<id>\.json/);
    assert.match(overlay, /task_id: "<id>"/);
    assert.match(overlay, /omx team api claim-task/);
    assert.match(overlay, /omx team api transition-task-status/);
    assert.match(overlay, /omx team api release-task-claim/);
    assert.doesNotMatch(overlay, /On completion: write \{"status": "completed"/);
    assert.match(overlay, /Do NOT spawn sub-agents/);
    assert.match(overlay, /do not pass workingDirectory unless the lead explicitly tells you to/);
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
    assert.match(inbox, /Resolve canonical team state root/);
    assert.match(inbox, /<team_state_root>\/team\/team-inbox\/tasks\/task-<id>\.json/);
    assert.match(inbox, /omx team api claim-task/);
    assert.match(inbox, /omx team api transition-task-status/);
    assert.match(inbox, /omx team api release-task-claim/);
    assert.match(inbox, /\$\{CODEX_HOME:-~\/\.codex\}\/skills\/worker\/SKILL\.md/);
    assert.match(inbox, /~\/\.agents\/skills\/worker\/SKILL\.md/);
    assert.match(inbox, /ACK: worker-1 initialized/);
    assert.match(inbox, /Mailbox Delivery Protocol \(Required\)/);
    assert.match(inbox, /mailbox-mark-delivered/);
    assert.doesNotMatch(inbox, /Write `\{"status": "completed", "result": "brief summary"\}` to the task file/);
    assert.match(inbox, /Verification Requirements/);
    assert.match(inbox, /Fix-Verify Loop/);
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

  it('generateInitialInbox uses workerRole when provided', () => {
    const tasks: TeamTask[] = [
      { id: '1', subject: 'Test task', description: 'Write tests', status: 'pending', created_at: new Date().toISOString() },
    ];
    const inbox = generateInitialInbox('worker-1', 'team-role', 'executor', tasks, {
      workerRole: 'test-engineer',
    });
    assert.match(inbox, /\*\*Role:\*\* test-engineer/);
    assert.doesNotMatch(inbox, /\*\*Role:\*\* executor/);
  });

  it('generateInitialInbox includes specialization section when rolePromptContent provided', () => {
    const tasks: TeamTask[] = [
      { id: '1', subject: 'Design UI', description: 'Build component', status: 'pending', created_at: new Date().toISOString() },
    ];
    const inbox = generateInitialInbox('worker-2', 'team-spec', 'executor', tasks, {
      workerRole: 'designer',
      rolePromptContent: 'You focus on UI/UX design and component architecture.',
    });
    assert.match(inbox, /## Your Specialization/);
    assert.match(inbox, /\*\*designer\*\* agent/);
    assert.match(inbox, /UI\/UX design and component architecture/);
  });

  it('generateInitialInbox omits specialization section when no rolePromptContent', () => {
    const tasks: TeamTask[] = [
      { id: '1', subject: 'Task', description: 'Do work', status: 'pending', created_at: new Date().toISOString() },
    ];
    const inbox = generateInitialInbox('worker-1', 'team-no-spec', 'executor', tasks, {
      workerRole: 'executor',
    });
    assert.doesNotMatch(inbox, /## Your Specialization/);
  });

  it('generateInitialInbox shows task role in task list', () => {
    const tasks: TeamTask[] = [
      { id: '1', subject: 'Test task', description: 'Write tests', status: 'pending', role: 'test-engineer', created_at: new Date().toISOString() },
    ];
    const inbox = generateInitialInbox('worker-1', 'team-task-role', 'executor', tasks);
    assert.match(inbox, /Role: test-engineer/);
  });

  it('generateTaskAssignmentInbox includes task ID and description', () => {
    const inbox = generateTaskAssignmentInbox('worker-3', 'team-followup', '42', 'Implement parser update');

    assert.match(inbox, /\*\*Task ID:\*\* 42/);
    assert.match(inbox, /Implement parser update/);
    assert.match(inbox, /team_state_root/);
    assert.match(inbox, /team\/team-followup\/tasks\/task-42\.json/);
    assert.match(inbox, /omx team api claim-task/);
    assert.match(inbox, /omx team api transition-task-status/);
    assert.match(inbox, /omx team api release-task-claim/);
    assert.doesNotMatch(inbox, /Write `\{"status": "completed", "result": "brief summary"\}` when done/);
    assert.match(inbox, /Verification Requirements/);
    assert.match(inbox, /PASS\/FAIL/);
  });

  it('generateShutdownInbox contains exit instruction and concrete ack path', () => {
    const inbox = generateShutdownInbox('team-x', 'worker-1');

    assert.match(inbox, /Shutdown Request/);
    assert.match(inbox, /team_state_root/);
    assert.match(inbox, /team\/team-x\/workers\/worker-1\/shutdown-ack\.json/);
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
    assert.match(message, /start work now/i);
    assert.match(message, /concrete progress/i);
    assert.match(message, /ACK-only/);
  });

  it('generateTriggerMessage uses provided state-root reference for worktree workers', () => {
    const message = generateTriggerMessage('worker-9', 'team-path', '$OMX_TEAM_STATE_ROOT');
    assert.match(message, /\$OMX_TEAM_STATE_ROOT\/team\/team-path\/workers\/worker-9\/inbox\.md/);
    assert.match(message, /work now/i);
    assert.match(message, /report progress/i);
    assert.ok(message.length < 200);
  });

  it('generateMailboxTriggerMessage is always < 200 characters', () => {
    const message = generateMailboxTriggerMessage('worker-long-name', 'team-with-long-name', 42);
    assert.ok(message.length < 200);
  });

  it('generateMailboxTriggerMessage contains mailbox path and count', () => {
    const message = generateMailboxTriggerMessage('worker-2', 'team-mail', 3);
    assert.match(message, /3 new message/);
    assert.match(message, /\.omx\/state\/team\/team-mail\/mailbox\/worker-2\.json/);
    assert.match(message, /act now/i);
    assert.match(message, /concrete progress/i);
    assert.match(message, /ACK-only/);
  });

  it('generateMailboxTriggerMessage uses provided state-root reference for worktree workers', () => {
    const message = generateMailboxTriggerMessage('worker-2', 'team-mail', 3, '$OMX_TEAM_STATE_ROOT');
    assert.match(message, /3 new msg/);
    assert.match(message, /\$OMX_TEAM_STATE_ROOT\/team\/team-mail\/mailbox\/worker-2\.json/);
    assert.match(message, /act/i);
    assert.match(message, /report progress/i);
    assert.ok(message.length < 200);
  });

  it('writeTeamWorkerInstructionsFile composes base AGENTS.md with overlay', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-worker-bootstrap-'));
    try {
      await writeFile(join(cwd, 'AGENTS.md'), '# Project Instructions\n\nDo good work.\n', 'utf8');

      const overlay = generateWorkerOverlay('compose-team');
      const outPath = await writeTeamWorkerInstructionsFile('compose-team', cwd, overlay);

      const content = await readFile(outPath, 'utf8');
      assert.match(content, /# Project Instructions/);
      assert.match(content, /Do good work/);
      assert.match(content, /<!-- OMX:TEAM:WORKER:START -->/);
      assert.match(content, /<!-- OMX:TEAM:WORKER:END -->/);

      // Verify project AGENTS.md was NOT modified
      const projectContent = await readFile(join(cwd, 'AGENTS.md'), 'utf8');
      assert.doesNotMatch(projectContent, /<!-- OMX:TEAM:WORKER:START -->/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('writeWorkerRoleInstructionsFile layers role prompt on top of team worker instructions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-worker-bootstrap-'));
    try {
      const overlay = generateWorkerOverlay('role-team');
      const basePath = await writeTeamWorkerInstructionsFile('role-team', cwd, overlay);
      const outPath = await writeWorkerRoleInstructionsFile(
        'role-team',
        'worker-2',
        cwd,
        basePath,
        'writer',
        '<identity>Writer role prompt</identity>',
      );

      const content = await readFile(outPath, 'utf8');
      assert.match(content, /team "role-team"/);
      assert.match(content, /<!-- OMX:TEAM:ROLE:START -->/);
      assert.match(content, /\*\*writer\*\* role/);
      assert.match(content, /<identity>Writer role prompt<\/identity>/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writeTeamWorkerInstructionsFile works without project AGENTS.md', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-worker-bootstrap-'));
    try {
      const overlay = generateWorkerOverlay('no-agents-team');
      const outPath = await writeTeamWorkerInstructionsFile('no-agents-team', cwd, overlay);

      const content = await readFile(outPath, 'utf8');
      assert.match(content, /<!-- OMX:TEAM:WORKER:START -->/);
      assert.match(content, /team "no-agents-team"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('removeTeamWorkerInstructionsFile cleans up the file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-worker-bootstrap-'));
    try {
      const overlay = generateWorkerOverlay('cleanup-team');
      await writeTeamWorkerInstructionsFile('cleanup-team', cwd, overlay);
      await removeTeamWorkerInstructionsFile('cleanup-team', cwd);

      const { existsSync } = await import('fs');
      const outPath = join(cwd, '.omx', 'state', 'team', 'cleanup-team', 'worker-agents.md');
      assert.equal(existsSync(outPath), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('removeTeamWorkerInstructionsFile is safe to call when file does not exist', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-worker-bootstrap-'));
    try {
      // Should not throw
      await removeTeamWorkerInstructionsFile('nonexistent-team', cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
