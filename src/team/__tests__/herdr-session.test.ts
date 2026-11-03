import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HerdrError,
  HERDR_TEAM_WORKSPACE_LABEL_PREFIX,
  buildAgentGetArgs,
  buildAgentPromptArgs,
  buildAgentSendKeysArgs,
  buildAgentStartArgs,
  buildHerdrAgentName,
  buildPaneReadArgs,
  buildTabCloseArgs,
  buildTabCreateArgs,
  buildWorkspaceCloseArgs,
  buildWorkspaceCreateArgs,
  captureHerdrWorkerPane,
  createHerdrTeam,
  herdrWorkspaceIdFromPaneId,
  interruptHerdrWorker,
  listHerdrTeams,
  parseHerdrEnvelope,
  resolveHerdrBinary,
  submitToHerdrWorker,
  teardownHerdrWorker,
} from '../herdr-session.js';

function envelope(id: string, result: unknown): string {
  return JSON.stringify({ id, result });
}

/** Fake execFile implementation scripting replies by argv inspection. */
function fakeExec(
  script: (args: string[]) => { stdout?: string; stderr?: string; fail?: Error & { stderr?: string } },
) {
  const calls: string[][] = [];
  const fn = (_bin: string, args: string[]) => {
    calls.push(args);
    const reply = script(args);
    if (reply.fail) return Promise.reject(reply.fail);
    return Promise.resolve({ stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' });
  };
  return { fn: fn as never, calls };
}

describe('herdr argv builders', () => {
  it('workspace create pins cwd, label, and focus', () => {
    assert.deepEqual(buildWorkspaceCreateArgs('/repo', 'omx-team-alpha'), [
      'workspace', 'create', '--cwd', '/repo', '--label', 'omx-team-alpha', '--no-focus',
    ]);
  });

  it('tab create always pins the workspace (E2E lesson: never the focused one)', () => {
    assert.deepEqual(buildTabCreateArgs('w5', '/repo', 'worker-1'), [
      'tab', 'create', '--workspace', 'w5', '--cwd', '/repo', '--label', 'worker-1', '--no-focus',
    ]);
  });

  it('tab create forwards worker env as KEY=VALUE flags', () => {
    assert.deepEqual(buildTabCreateArgs('w5', '/repo', 'worker-1', { OMX_TEAM_WORKER: 'alpha/worker-1', B: 'x=1' }), [
      'tab', 'create', '--workspace', 'w5', '--cwd', '/repo', '--label', 'worker-1',
      '--env', 'OMX_TEAM_WORKER=alpha/worker-1',
      '--env', 'B=x=1',
      '--no-focus',
    ]);
  });

  it('agent start passes kind, pane, timeout, and native args after --', () => {
    assert.deepEqual(
      buildAgentStartArgs('omx-alpha-1234-w1', 'codex', 'w5:p2', ['-m', 'gpt-5.4'], 45000),
      ['agent', 'start', 'omx-alpha-1234-w1', '--kind', 'codex', '--pane', 'w5:p2', '--timeout', '45000', '--', '-m', 'gpt-5.4'],
    );
    assert.deepEqual(
      buildAgentStartArgs('omx-alpha-1234-w1', 'claude', 'w5:p3'),
      ['agent', 'start', 'omx-alpha-1234-w1', '--kind', 'claude', '--pane', 'w5:p3', '--timeout', '60000'],
    );
  });

  it('prompt, read, send-keys, and close builders are stable', () => {
    assert.deepEqual(buildAgentPromptArgs('omx-a-1-w1', 'do the thing'), ['agent', 'prompt', 'omx-a-1-w1', 'do the thing']);
    assert.deepEqual(buildPaneReadArgs('w5:p2', 120), ['pane', 'read', 'w5:p2', '--source', 'recent-unwrapped', '--lines', '120']);
    assert.deepEqual(buildAgentSendKeysArgs('omx-a-1-w1', 'ctrl+c'), ['agent', 'send-keys', 'omx-a-1-w1', 'ctrl+c']);
    assert.deepEqual(buildAgentGetArgs('omx-a-1-w1'), ['agent', 'get', 'omx-a-1-w1']);
    assert.deepEqual(buildTabCloseArgs('w5:t2'), ['tab', 'close', 'w5:t2']);
    assert.deepEqual(buildWorkspaceCloseArgs('w5'), ['workspace', 'close', 'w5']);
  });
});

describe('herdr agent naming', () => {
  it('derives names matching the herdr pattern', () => {
    for (const team of ['alpha', 'My Very Long Team Name 2026', 'team-with-кириллица', 'x']) {
      const name = buildHerdrAgentName(team, 12);
      assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/, `name for "${team}"`);
    }
  });

  it('is deterministic and distinct per team and worker', () => {
    assert.equal(buildHerdrAgentName('alpha', 1), buildHerdrAgentName('alpha', 1));
    assert.notEqual(buildHerdrAgentName('alpha', 1), buildHerdrAgentName('alpha', 2));
    assert.notEqual(buildHerdrAgentName('alpha-team-long-prefix-one', 1), buildHerdrAgentName('alpha-team-long-prefix-two', 1));
  });
});

describe('herdr pane id parsing', () => {
  it('extracts the workspace id from w5:p2', () => {
    assert.equal(herdrWorkspaceIdFromPaneId('w5:p2'), 'w5');
  });

  it('rejects non-herdr pane ids (tmux %N must never reach teardown)', () => {
    assert.throws(() => herdrWorkspaceIdFromPaneId('%12'), HerdrError);
    assert.throws(() => herdrWorkspaceIdFromPaneId('w5:'), HerdrError);
    assert.throws(() => herdrWorkspaceIdFromPaneId(''), HerdrError);
  });
});

describe('parseHerdrEnvelope', () => {
  it('parses success envelopes', () => {
    const parsed = parseHerdrEnvelope('{"id":"cli:agent:list","result":{"agents":[]}}');
    assert.deepEqual(parsed.result, { agents: [] });
  });

  it('parses error envelopes without throwing', () => {
    const parsed = parseHerdrEnvelope('{"id":"cli:agent:list","error":{"code":"server_not_running","message":"down"}}');
    assert.equal(parsed.error?.code, 'server_not_running');
  });

  it('rejects empty and non-JSON output', () => {
    assert.throws(() => parseHerdrEnvelope(''), HerdrError);
    assert.throws(() => parseHerdrEnvelope('not json'), HerdrError);
  });
});

describe('resolveHerdrBinary', () => {
  it('trust-pins HERDR_BIN_PATH when it is an absolute path to a real file', () => {
    const pinned = join(tmpdir(), 'herdr-bin-test');
    writeFileSync(pinned, '#!/bin/sh\n');
    assert.equal(resolveHerdrBinary({ HERDR_BIN_PATH: pinned }), pinned);
    rmSync(pinned, { force: true });
  });

  it('falls back to PATH herdr when the pin is not an existing absolute file', () => {
    assert.equal(resolveHerdrBinary({}), 'herdr');
    assert.equal(resolveHerdrBinary({ HERDR_BIN_PATH: '/opt/herdr/does-not-exist' }), 'herdr');
    assert.equal(resolveHerdrBinary({ HERDR_BIN_PATH: 'relative/herdr' }), 'herdr');
  });
});

describe('createHerdrTeam', () => {
  it('creates workspace, per-worker tabs, and agents, then submits initial prompts', async () => {
    const fake = fakeExec((args) => {
      if (args[0] === 'workspace' && args[1] === 'create') {
        return { stdout: envelope('cli:workspace:create', { workspace: { workspace_id: 'w9' }, root_pane: { pane_id: 'w9:p1' } }) };
      }
      if (args[0] === 'tab' && args[1] === 'create') {
        return { stdout: envelope('cli:tab:create', { tab: { tab_id: 'w9:t2' }, root_pane: { pane_id: 'w9:p2' } }) };
      }
      if (args[0] === 'agent' && args[1] === 'start') {
        return { stdout: envelope('cli:agent:start', { agent: { name: args[2], agent_status: 'idle' } }) };
      }
      if (args[0] === 'agent' && args[1] === 'prompt') {
        return { stdout: envelope('cli:agent:prompt', { agent: {} }) };
      }
      if (args[0] === 'agent' && args[1] === 'list') {
        return { stdout: envelope('cli:agent:list', { agents: [] }) };
      }
      return { stdout: envelope('cli:unknown', { type: 'ok' }) };
    });

    const team = await createHerdrTeam('alpha', '/repo', [
      { kind: 'codex', agentArgs: ['-m', 'gpt-5.4'], env: { OMX_TEAM_WORKER: 'alpha/worker-1' }, cwd: '/repo/w1', initialPrompt: 'start' },
      { kind: 'claude', agentArgs: [], env: {}, cwd: '/repo/w2' },
    ], { env: {}, execFn: fake.fn });

    assert.equal(team.name, 'herdr-alpha');
    assert.equal(team.workspaceId, 'w9');
    assert.equal(team.workspaceLabel, `${HERDR_TEAM_WORKSPACE_LABEL_PREFIX}alpha`);
    assert.equal(team.workers.length, 2);
    assert.equal(team.workers[0].paneId, 'w9:p2');
    assert.equal(team.workers[0].tabId, 'w9:t2');
    assert.notEqual(team.workers[0].agentName, team.workers[1].agentName);

    const flat = fake.calls.map((c) => c.slice(0, 2).join(' '));
    assert.ok(flat.filter((c) => c === 'workspace create').length === 1);
    assert.ok(flat.filter((c) => c === 'tab create').length === 2);
    assert.ok(flat.filter((c) => c === 'agent start').length === 2);
    assert.ok(flat.filter((c) => c === 'agent prompt').length === 1, 'only worker-1 had an initial prompt');

    const tabCreate = fake.calls.find((c) => c[0] === 'tab' && c[1] === 'create')!;
    assert.ok(tabCreate.includes('--workspace'), 'tab create pins workspace');
    assert.ok(tabCreate.includes('OMX_TEAM_WORKER=alpha/worker-1'), 'worker env forwarded');

    const agentStart = fake.calls.find((c) => c[0] === 'agent' && c[1] === 'start')!;
    assert.ok(agentStart.includes('--kind'), 'kind passed');
    assert.ok(agentStart.includes('gpt-5.4'), 'native args passed after --');
  });

  it('rolls back created tabs and workspace when a worker fails', async () => {
    let tabCount = 0;
    const fake = fakeExec((args) => {
      if (args[0] === 'workspace' && args[1] === 'create') {
        return { stdout: envelope('cli:workspace:create', { workspace: { workspace_id: 'w7' }, root_pane: { pane_id: 'w7:p1' } }) };
      }
      if (args[0] === 'tab' && args[1] === 'create') {
        tabCount += 1;
        return { stdout: envelope('cli:tab:create', { tab: { tab_id: `w7:t${tabCount + 1}` }, root_pane: { pane_id: `w7:p${tabCount + 1}` } }) };
      }
      if (args[0] === 'agent' && args[1] === 'start') {
        return tabCount >= 2
          ? { fail: Object.assign(new Error('agent_not_ready'), { stderr: JSON.stringify({ error: { code: 'agent_not_ready', message: 'blocked at startup' } }) }) }
          : { stdout: envelope('cli:agent:start', { agent: {} }) };
      }
      if (args[0] === 'agent' && args[1] === 'list') {
        return { stdout: envelope('cli:agent:list', { agents: [] }) };
      }
      return { stdout: envelope('cli:ok', { type: 'ok' }) };
    });

    await assert.rejects(
      createHerdrTeam('beta', '/repo', [
        { kind: 'codex', agentArgs: [], env: {}, cwd: '/repo' },
        { kind: 'codex', agentArgs: [], env: {}, cwd: '/repo' },
      ], { env: {}, execFn: fake.fn }),
      /agent_not_ready/,
    );

    const flat = fake.calls.map((c) => c.slice(0, 2).join(' '));
    assert.ok(flat.includes('tab close'), 'failed tabs are closed');
    assert.ok(flat.includes('workspace close'), 'workspace is closed on rollback');
  });
});

describe('worker operations', () => {
  it('submit uses agent prompt with the raw text', async () => {
    const fake = fakeExec(() => ({ stdout: envelope('cli:agent:prompt', { agent: {} }) }));
    await submitToHerdrWorker('omx-a-1-w1', 'ship it', { env: {}, execFn: fake.fn });
    assert.deepEqual(fake.calls[0], ['agent', 'prompt', 'omx-a-1-w1', 'ship it']);
  });

  it('interrupt sends ctrl+c', async () => {
    const fake = fakeExec(() => ({ stdout: envelope('cli:agent:send-keys', {}) }));
    await interruptHerdrWorker('omx-a-1-w1', { env: {}, execFn: fake.fn });
    assert.deepEqual(fake.calls[0], ['agent', 'send-keys', 'omx-a-1-w1', 'ctrl+c']);
  });

  it('capture returns the raw pane text (pane read prints plain text on the CLI)', async () => {
    const fake = fakeExec(() => ({ stdout: 'line1\nline2' }));
    const text = await captureHerdrWorkerPane('w5:p2', 80, { env: {}, execFn: fake.fn });
    assert.equal(text, 'line1\nline2');
    assert.deepEqual(fake.calls[0], ['pane', 'read', 'w5:p2', '--source', 'recent-unwrapped', '--lines', '80']);
  });

  it('teardown closes the pane directly (tab ids are not derivable)', async () => {
    const fake = fakeExec(() => ({ stdout: envelope('cli:pane:close', { type: 'ok' }) }));
    await teardownHerdrWorker('w5:p2', { env: {}, execFn: fake.fn });
    assert.deepEqual(fake.calls[0], ['pane', 'close', 'w5:p2']);
  });

  it('listHerdrTeams filters by label prefix', async () => {
    const fake = fakeExec(() => ({
      stdout: envelope('cli:workspace:list', {
        workspaces: [
          { workspace_id: 'w1', label: 'user-own' },
          { workspace_id: 'w2', label: `${HERDR_TEAM_WORKSPACE_LABEL_PREFIX}alpha` },
        ],
      }),
    }));
    const teams = await listHerdrTeams({ env: {}, execFn: fake.fn });
    assert.deepEqual(teams, [{ workspaceId: 'w2', teamName: 'alpha', label: 'omx-team-alpha' }]);
  });
});

describe('worker launch mode interplay (resolver flip)', () => {
  it('resolveTeamWorkerLaunchMode flips interactive to herdr when multiplexer selects herdr', async () => {
    const { resolveTeamWorkerLaunchMode } = await import('../tmux-session.js');
    assert.equal(
      resolveTeamWorkerLaunchMode({ OMX_MULTIPLEXER: 'herdr' } as NodeJS.ProcessEnv),
      'herdr',
    );
    assert.equal(resolveTeamWorkerLaunchMode({} as NodeJS.ProcessEnv), 'interactive');
    assert.equal(
      resolveTeamWorkerLaunchMode({ OMX_TEAM_WORKER_LAUNCH_MODE: 'herdr' } as NodeJS.ProcessEnv),
      'herdr',
    );
    // Explicit prompt wins over the multiplexer setting.
    assert.equal(
      resolveTeamWorkerLaunchMode({
        OMX_TEAM_WORKER_LAUNCH_MODE: 'prompt',
        OMX_MULTIPLEXER: 'herdr',
      } as NodeJS.ProcessEnv),
      'prompt',
    );
  });

  it('normalizeTeamPolicy preserves herdr as a persisted worker launch mode', async () => {
    const state = await import('../state.js');
    const policy = state.normalizeTeamPolicy(
      { worker_launch_mode: 'herdr' } as Parameters<typeof state.normalizeTeamPolicy>[0],
    );
    assert.equal(policy.worker_launch_mode, 'herdr');
  });
});
