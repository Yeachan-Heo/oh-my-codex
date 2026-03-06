import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enterpriseCommand, parseEnterpriseStartArgs } from '../enterprise.js';

describe('parseEnterpriseStartArgs', () => {
  it('parses task plus repeated division flags', () => {
    const parsed = parseEnterpriseStartArgs([
      '--division', 'Research:investigate reuse',
      '--division', 'Execution:build runtime shell',
      '--subordinate', 'division-1:Verifier:verify runtime shell',
      '--subordinates-per-lead', '4',
      'issue', '590',
    ]);

    assert.equal(parsed.task, 'issue 590');
    assert.equal(parsed.divisions.length, 2);
    assert.equal(parsed.subordinates.length, 1);
    assert.equal(parsed.divisions[0]?.label, 'Research');
    assert.equal(parsed.divisions[1]?.scope, 'build runtime shell');
    assert.equal(parsed.options.policy?.max_subordinates_per_lead, 4);
  });

  it('throws when task is missing', () => {
    assert.throws(() => parseEnterpriseStartArgs(['--division', 'Research:scope']), /Usage: omx enterprise/);
  });
});

describe('enterpriseCommand', () => {
  it('prints enterprise-specific help', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await enterpriseCommand(['help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx enterprise/);
      assert.match(logs[0] ?? '', /nudge <node-id>/);
      assert.match(logs[0] ?? '', /inspect <subordinate/);
    } finally {
      console.log = originalLog;
    }
  });

  it('prints status for an active enterprise runtime', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-cli-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(cwd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await enterpriseCommand(['issue', '590']);
      logs.length = 0;
      await enterpriseCommand(['status']);
      assert.ok(logs.some((line) => line.includes('Enterprise mode: ACTIVE')));
      assert.ok(logs.some((line) => line.includes('Divisions: 1')));
      assert.ok(logs.some((line) => line.includes('Division summaries:')));
    } finally {
      process.chdir(previousCwd);
      console.log = originalLog;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('prints live-start status after bootstrapping live runtime', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-cli-'));
    const previousCwd = process.cwd();
    const previousTmux = process.env.TMUX;
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(cwd);
      process.env.TMUX = 'leader-session';
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await enterpriseCommand(['issue', '590']);

      const tmuxAdapter = await import('../../enterprise/tmux-adapter.js');
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'isTmuxAvailable', async () => true);
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'createTmuxSession', async () => ({
        name: 'leader:1', workerCount: 1, cwd, workerPaneIds: ['%101'], leaderPaneId: '%100', hudPaneId: null, resizeHookName: null, resizeHookTarget: null,
      }));
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'buildWorkerStartupCommand', async (_team: string, idx: number) => `codex --worker ${idx}`);
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'spawnPane', async () => '%102');

      logs.length = 0;
      await enterpriseCommand(['live-start']);
      assert.ok(logs.some((line) => line.includes('Enterprise live runtime started.')));
      assert.ok(logs.some((line) => line.includes('Live tmux session: leader:1')));
    } finally {
      mock.restoreAll();
      process.chdir(previousCwd);
      console.log = originalLog;
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux; else delete process.env.TMUX;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shuts down the live runtime through the CLI', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-cli-'));
    const previousCwd = process.cwd();
    const previousTmux = process.env.TMUX;
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(cwd);
      process.env.TMUX = 'leader-session';
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await enterpriseCommand(['issue', '590']);

      const tmuxAdapter = await import('../../enterprise/tmux-adapter.js');
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'isTmuxAvailable', async () => true);
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'createTmuxSession', async () => ({
        name: 'leader:1', workerCount: 1, cwd, workerPaneIds: ['%101'], leaderPaneId: '%100', hudPaneId: null, resizeHookName: null, resizeHookTarget: null,
      }));
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'buildWorkerStartupCommand', async (_team: string, idx: number) => `codex --worker ${idx}`);
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'spawnPane', async () => '%102');
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'destroyTmuxSession', async () => {});
      await enterpriseCommand(['live-start']);

      logs.length = 0;
      await enterpriseCommand(['shutdown']);
      assert.ok(logs.some((line) => line.includes('Enterprise live runtime shutdown complete.')));
    } finally {
      mock.restoreAll();
      process.chdir(previousCwd);
      console.log = originalLog;
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux; else delete process.env.TMUX;
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('shows chairman rollup counts in inspect chairman', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-cli-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(cwd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await enterpriseCommand(['issue', '590']);
      logs.length = 0;
      await enterpriseCommand(['inspect', 'chairman']);
      assert.ok(logs.some((line) => line.includes('assignmentCount')));
      assert.ok(logs.some((line) => line.includes('escalationCount')));
      assert.ok(logs.some((line) => line.includes('workerCount')));
      assert.ok(logs.some((line) => line.includes('workerHealth')));
    } finally {
      process.chdir(previousCwd);
      console.log = originalLog;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shows division rollup details in inspect division', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-cli-'));
    const previousCwd = process.cwd();
    const previousTmux = process.env.TMUX;
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(cwd);
      process.env.TMUX = 'leader-session';
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await enterpriseCommand(['issue', '590']);

      const tmuxAdapter = await import('../../enterprise/tmux-adapter.js');
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'isTmuxAvailable', async () => true);
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'createTmuxSession', async () => ({
        name: 'leader:1', workerCount: 1, cwd, workerPaneIds: ['%101'], leaderPaneId: '%100', hudPaneId: null, resizeHookName: null, resizeHookTarget: null,
      }));
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'buildWorkerStartupCommand', async (_team: string, idx: number) => `codex --worker ${idx}`);
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'spawnPane', async () => '%102');
      await enterpriseCommand(['live-start']);
      await enterpriseCommand(['assign', 'division-1', 'Verifier:verify runtime shell']);

      logs.length = 0;
      await enterpriseCommand(['inspect', 'division', 'division-1']);
      assert.ok(logs.some((line) => line.includes('subordinateHealth')));
      assert.ok(logs.some((line) => line.includes('assignments')));
      assert.ok(logs.some((line) => line.includes('escalations')));
    } finally {
      mock.restoreAll();
      process.chdir(previousCwd);
      console.log = originalLog;
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux; else delete process.env.TMUX;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('creates an assignment and exposes it via inspect', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-cli-'));
    const previousCwd = process.cwd();
    const previousTmux = process.env.TMUX;
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(cwd);
      process.env.TMUX = 'leader-session';
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await enterpriseCommand(['issue', '590']);

      const tmuxAdapter = await import('../../enterprise/tmux-adapter.js');
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'isTmuxAvailable', async () => true);
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'createTmuxSession', async () => ({
        name: 'leader:1', workerCount: 1, cwd, workerPaneIds: ['%101'], leaderPaneId: '%100', hudPaneId: null, resizeHookName: null, resizeHookTarget: null,
      }));
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'buildWorkerStartupCommand', async (_team: string, idx: number) => `codex --worker ${idx}`);
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'spawnPane', async () => '%102');
      await enterpriseCommand(['live-start']);

      logs.length = 0;
      await enterpriseCommand(['assign', 'division-1', 'Verifier:verify runtime shell']);
      assert.ok(logs.some((line) => line.includes('Enterprise assignment created:')));
      logs.length = 0;
      await enterpriseCommand(['inspect', 'assignments']);
      assert.ok(logs.some((line) => line.includes('assignment-')));
      logs.length = 0;
      await enterpriseCommand(['inspect', 'subordinate', 'subordinate-verifier']);
      assert.ok(logs.some((line) => line.includes('workerIdentity')));
      assert.ok(logs.some((line) => line.includes('workerState')));
    } finally {
      mock.restoreAll();
      process.chdir(previousCwd);
      console.log = originalLog;
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux; else delete process.env.TMUX;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('creates escalation records and exposes them via inspect', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-cli-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(cwd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await enterpriseCommand(['issue', '590']);
      logs.length = 0;
      await enterpriseCommand(['escalate', 'subordinate-1', 'needs chairman review', '--details', 'shared file conflict']);
      assert.ok(logs.some((line) => line.includes('Enterprise escalation created:')));
      logs.length = 0;
      await enterpriseCommand(['inspect', 'escalations']);
      assert.ok(logs.some((line) => line.includes('needs chairman review')));
    } finally {
      process.chdir(previousCwd);
      console.log = originalLog;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shuts down a single live worker through the CLI', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-cli-'));
    const previousCwd = process.cwd();
    const previousTmux = process.env.TMUX;
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(cwd);
      process.env.TMUX = 'leader-session';
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await enterpriseCommand(['issue', '590']);

      const tmuxAdapter = await import('../../enterprise/tmux-adapter.js');
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'isTmuxAvailable', async () => true);
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'createTmuxSession', async () => ({
        name: 'leader:1', workerCount: 1, cwd, workerPaneIds: ['%101'], leaderPaneId: '%100', hudPaneId: null, resizeHookName: null, resizeHookTarget: null,
      }));
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'buildWorkerStartupCommand', async (_team: string, idx: number) => `codex --worker ${idx}`);
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'spawnPane', async () => '%102');
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'killPane', async () => {});
      await enterpriseCommand(['live-start']);

      logs.length = 0;
      await enterpriseCommand(['shutdown-node', 'subordinate-1']);
      assert.ok(logs.some((line) => line.includes('Enterprise live worker shutdown complete: subordinate-1')));
    } finally {
      mock.restoreAll();
      process.chdir(previousCwd);
      console.log = originalLog;
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux; else delete process.env.TMUX;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('cascades division-lead shutdown through the CLI', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-cli-'));
    const previousCwd = process.cwd();
    const previousTmux = process.env.TMUX;
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(cwd);
      process.env.TMUX = 'leader-session';
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await enterpriseCommand(['issue', '590']);

      const tmuxAdapter = await import('../../enterprise/tmux-adapter.js');
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'isTmuxAvailable', async () => true);
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'createTmuxSession', async () => ({
        name: 'leader:1', workerCount: 1, cwd, workerPaneIds: ['%101'], leaderPaneId: '%100', hudPaneId: null, resizeHookName: null, resizeHookTarget: null,
      }));
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'buildWorkerStartupCommand', async (_team: string, idx: number) => `codex --worker ${idx}`);
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'spawnPane', async () => '%102');
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'killPane', async () => {});
      await enterpriseCommand(['live-start']);

      logs.length = 0;
      await enterpriseCommand(['shutdown-node', 'division-1']);
      assert.ok(logs.some((line) => line.includes('Enterprise live worker shutdown complete: division-1')));
    } finally {
      mock.restoreAll();
      process.chdir(previousCwd);
      console.log = originalLog;
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux; else delete process.env.TMUX;
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('updates a node heartbeat through the CLI', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-cli-'));
    const previousCwd = process.cwd();
    const previousTmux = process.env.TMUX;
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(cwd);
      process.env.TMUX = 'leader-session';
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await enterpriseCommand(['issue', '590']);

      const tmuxAdapter = await import('../../enterprise/tmux-adapter.js');
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'isTmuxAvailable', async () => true);
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'createTmuxSession', async () => ({
        name: 'leader:1', workerCount: 1, cwd, workerPaneIds: ['%101'], leaderPaneId: '%100', hudPaneId: null, resizeHookName: null, resizeHookTarget: null,
      }));
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'buildWorkerStartupCommand', async (_team: string, idx: number) => `codex --worker ${idx}`);
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'spawnPane', async () => '%102');
      await enterpriseCommand(['live-start']);

      logs.length = 0;
      await enterpriseCommand(['heartbeat', 'subordinate-1']);
      assert.ok(logs.some((line) => line.includes('Enterprise heartbeat updated: subordinate-1')));
    } finally {
      mock.restoreAll();
      process.chdir(previousCwd);
      console.log = originalLog;
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux; else delete process.env.TMUX;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('sends mailbox messages and supports acknowledgement', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-cli-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(cwd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await enterpriseCommand(['issue', '590']);
      logs.length = 0;
      await enterpriseCommand(['message', 'subordinate-1', 'division-1', 'verification complete']);
      assert.ok(logs.some((line) => line.includes('Enterprise message sent:')));
      const messageLine = logs.find((line) => line.includes('Enterprise message sent:')) ?? '';
      const messageId = messageLine.split(': ').at(-1) ?? '';
      logs.length = 0;
      await enterpriseCommand(['mailbox', 'division-1']);
      assert.ok(logs.some((line) => line.includes('verification complete')));
      logs.length = 0;
      await enterpriseCommand(['ack-message', 'division-1', messageId]);
      assert.ok(logs.some((line) => line.includes('Enterprise message acknowledged:')));
    } finally {
      process.chdir(previousCwd);
      console.log = originalLog;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('inspects persisted worker identities and states after live-start', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-cli-'));
    const previousCwd = process.cwd();
    const previousTmux = process.env.TMUX;
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(cwd);
      process.env.TMUX = 'leader-session';
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await enterpriseCommand(['issue', '590']);

      const tmuxAdapter = await import('../../enterprise/tmux-adapter.js');
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'isTmuxAvailable', async () => true);
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'createTmuxSession', async () => ({
        name: 'leader:1', workerCount: 1, cwd, workerPaneIds: ['%101'], leaderPaneId: '%100', hudPaneId: null, resizeHookName: null, resizeHookTarget: null,
      }));
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'buildWorkerStartupCommand', async (_team: string, idx: number) => `codex --worker ${idx}`);
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'spawnPane', async () => '%102');
      await enterpriseCommand(['live-start']);

      logs.length = 0;
      await enterpriseCommand(['inspect', 'workers']);
      assert.ok(logs.some((line) => line.includes('workerState')));
      assert.ok(logs.some((line) => line.includes('workerHeartbeat')));
      assert.ok(logs.some((line) => line.includes('workerHealth')));
      assert.ok(logs.some((line) => line.includes('healthy')));
    } finally {
      mock.restoreAll();
      process.chdir(previousCwd);
      console.log = originalLog;
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux; else delete process.env.TMUX;
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('prints worker health summary in enterprise status after live-start', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-cli-'));
    const previousCwd = process.cwd();
    const previousTmux = process.env.TMUX;
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(cwd);
      process.env.TMUX = 'leader-session';
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await enterpriseCommand(['issue', '590']);

      const tmuxAdapter = await import('../../enterprise/tmux-adapter.js');
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'isTmuxAvailable', async () => true);
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'createTmuxSession', async () => ({
        name: 'leader:1', workerCount: 1, cwd, workerPaneIds: ['%101'], leaderPaneId: '%100', hudPaneId: null, resizeHookName: null, resizeHookTarget: null,
      }));
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'buildWorkerStartupCommand', async (_team: string, idx: number) => `codex --worker ${idx}`);
      mock.method(tmuxAdapter.enterpriseTmuxAdapter, 'spawnPane', async () => '%102');
      await enterpriseCommand(['live-start']);

      logs.length = 0;
      await enterpriseCommand(['status']);
      assert.ok(logs.some((line) => line.includes('Worker health: healthy=')));
    } finally {
      mock.restoreAll();
      process.chdir(previousCwd);
      console.log = originalLog;
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux; else delete process.env.TMUX;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('applies updates through the CLI and shows rolled-up status', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-cli-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(cwd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await enterpriseCommand(['issue', '590']);
      logs.length = 0;
      await enterpriseCommand(['update', 'subordinate-1', 'completed', 'runtime shell implemented']);
      assert.ok(logs.some((line) => line.includes('Enterprise update applied.')));
      assert.ok(logs.some((line) => line.includes('Chairman state: completed')));
    } finally {
      process.chdir(previousCwd);
      console.log = originalLog;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
