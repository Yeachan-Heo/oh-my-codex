import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildRunningTeamAppendInstructions,
  ensureRunningTeamTmuxHookAllowed,
  extractRunningTeamTaskDescription,
  filterRunningTeamCodexArgs,
  runningTeamCommand,
} from '../runningteam.js';
import { writeCriticVerdict, writeFinalSynthesis } from '../../runningteam/runtime.js';

async function withIsolatedOmxState<T>(fn: () => Promise<T>): Promise<T> {
  const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
  const previousOmxRoot = process.env.OMX_ROOT;
  const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
  delete process.env.OMX_TEAM_STATE_ROOT;
  delete process.env.OMX_ROOT;
  delete process.env.OMX_STATE_ROOT;
  try {
    return await fn();
  } finally {
    if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
    else delete process.env.OMX_TEAM_STATE_ROOT;
    if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
    else delete process.env.OMX_ROOT;
    if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
    else delete process.env.OMX_STATE_ROOT;
  }
}

async function captureRunningTeam(args: string[], cwd: string): Promise<string[]> {
  const logs: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (...values: unknown[]) => logs.push(values.map(String).join(' '));
    await withIsolatedOmxState(() => runningTeamCommand(args, cwd));
    return logs;
  } finally {
    console.log = originalLog;
  }
}

describe('runningteam CLI', () => {


  it('extracts task text while preserving Codex launch args for interactive profile mode', () => {
    assert.equal(extractRunningTeamTaskDescription(['--madmax', '--model', 'gpt-5.5', 'ship', 'feature']), 'ship feature');
    assert.deepEqual(filterRunningTeamCodexArgs(['--launch', '--json', '--madmax', 'ship']), ['--madmax', 'ship']);
  });

  it('builds launch instructions with dynamic planning contract', () => {
    const instructions = buildRunningTeamAppendInstructions('ship feature', { sessionId: 'runningteam-demo' });
    assert.match(instructions, /OMX RunningTeam mode/);
    assert.match(instructions, /first-class dynamic planning system/);
    assert.match(instructions, /Plan vN -> team batch -> evidence collection -> Critic review -> Planner revision/);
    assert.match(instructions, /final synthesis/);
  });

  it('does not leak omx-only flags into Codex launch args', () => {
    assert.deepEqual(filterRunningTeamCodexArgs(['--json', '--launch', '--no-launch', '--model', 'gpt-5.5', 'ship']), ['--model', 'gpt-5.5', 'ship']);
  });

  it('creates launch-mode state and instructions without spawning when --no-launch is set', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runningteam-launch-state-'));
    try {
      const logs = await captureRunningTeam(['--no-launch', 'ship', 'feature'], cwd);
      assert.match(logs.join('\n'), /RunningTeam session created: runningteam-/);
      const instructions = await readFile(join(cwd, '.omx', 'runningteam', 'session-instructions.md'), 'utf-8').catch(() => '');
      assert.equal(instructions, '', '--no-launch create-only mode must not write launch instructions');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('creates a direct first-class session without invoking team or ralplan commands', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runningteam-cli-'));
    try {
      const logs = await captureRunningTeam(['create', 'two', 'lane', 'fixture'], cwd);
      assert.match(logs.join('\n'), /RunningTeam session created: runningteam-/);
      const status = await captureRunningTeam(['status', '--json'], cwd);
      const parsed = JSON.parse(status.join('\n')) as { sessions: Array<{ status: string; plan_version: number }> };
      assert.equal(parsed.sessions.length, 1);
      assert.equal(parsed.sessions[0]?.status, 'planning');
      assert.equal(parsed.sessions[0]?.plan_version, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('adds runningteam to existing tmux-hook allowed modes during launch setup', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runningteam-tmux-hook-'));
    try {
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'tmux-hook.json'), JSON.stringify({
        enabled: true,
        target: { type: 'pane', value: '%9' },
        allowed_modes: ['ralph', 'team'],
      }, null, 2));
      const changed = await ensureRunningTeamTmuxHookAllowed(cwd);
      assert.equal(changed, true);
      const config = JSON.parse(await readFile(join(cwd, '.omx', 'tmux-hook.json'), 'utf-8')) as { allowed_modes: string[] };
      assert.deepEqual(config.allowed_modes, ['ralph', 'team', 'runningteam']);

      const unchanged = await ensureRunningTeamTmuxHookAllowed(cwd);
      assert.equal(unchanged, false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('refuses finalize until final-synthesis.md exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runningteam-finalize-'));
    try {
      await withIsolatedOmxState(async () => {
        const logs = await captureRunningTeam(['create', 'finalize fixture'], cwd);
        const sessionId = /RunningTeam session created: (\S+)/.exec(logs.join('\n'))?.[1];
        assert.ok(sessionId);
        await assert.rejects(captureRunningTeam(['finalize', sessionId], cwd), /final-synthesis\.md/);
        await writeFinalSynthesis(cwd, sessionId, '# Final synthesis\n\nReady.');
        await assert.rejects(captureRunningTeam(['finalize', sessionId], cwd), /FINAL_SYNTHESIS_READY/);
        await writeCriticVerdict(cwd, sessionId, {
          iteration: 0,
          verdict: 'FINAL_SYNTHESIS_READY',
          acceptance_criteria_evidence: { ready: ['final synthesis'] },
          created_at: new Date().toISOString(),
        });
        const finalized = await captureRunningTeam(['finalize', sessionId], cwd);
        assert.match(finalized.join('\n'), /RunningTeam complete/);
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
