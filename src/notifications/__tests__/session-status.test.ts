import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  createSubagentTrackingState,
  recordSubagentTurn,
  writeSubagentTrackingState,
} from '../../subagents/tracker.js';
import { writeSessionStart } from '../../hooks/session.js';
import type { SessionMapping } from '../session-registry.js';
import {
  STATUS_DATA_UNAVAILABLE_MESSAGE,
  buildDiscordSessionStatusReply,
  isDiscordStatusCommand,
} from '../session-status.js';

function createMapping(projectPath: string, sessionId = 'sess-1'): SessionMapping {
  return {
    platform: 'discord-bot',
    messageId: 'orig-discord-msg',
    sessionId,
    tmuxPaneId: '%9',
    tmuxSessionName: 'omx-session',
    event: 'session-idle',
    createdAt: '2026-03-20T00:00:00.000Z',
    projectPath,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

describe('session-status helper', () => {
  it('accepts exact-match status commands after trim/case normalization', () => {
    assert.equal(isDiscordStatusCommand('status'), true);
    assert.equal(isDiscordStatusCommand('  STATUS  '), true);
    assert.equal(isDiscordStatusCommand('status now'), false);
    assert.equal(isDiscordStatusCommand('status?'), false);
  });

  it('renders a bounded running summary with active subagent details', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-session-status-'));
    try {
      await writeSessionStart(wd, 'sess-1', { nativeSessionId: 'native-1' });
      await writeJson(join(wd, '.omx', 'state', 'sessions', 'sess-1', 'skill-active-state.json'), {
        active: true,
        skill: 'ralph',
        phase: 'executing',
        updated_at: '2026-03-20T00:04:30.000Z',
        session_id: 'sess-1',
      });
      await writeJson(join(wd, '.omx', 'state', 'sessions', 'sess-1', 'run-state.json'), {
        version: 1,
        mode: 'ralph',
        active: true,
        outcome: 'continue',
        current_phase: 'executing',
        updated_at: '2026-03-20T00:04:30.000Z',
      });

      let tracking = createSubagentTrackingState();
      for (const [threadId, turnId] of [
        ['leader-thread', 'turn-1'],
        ['a1b2c3-thread', 'turn-2'],
        ['d4e5f6-thread', 'turn-3'],
        ['g7h8i9-thread', 'turn-4'],
        ['j0k1l2-thread', 'turn-5'],
      ] as const) {
        tracking = recordSubagentTurn(tracking, {
          sessionId: 'sess-1',
          threadId,
          turnId,
          timestamp: '2026-03-20T00:04:00.000Z',
          mode: 'ralph',
        });
      }
      await writeSubagentTrackingState(wd, tracking);

      const status = await buildDiscordSessionStatusReply(createMapping(wd), {
        now: '2026-03-20T00:05:00.000Z',
      });

      assert.match(status, /^Tracked OMX session status/m);
      assert.match(status, /Session: sess-1/);
      assert.match(status, /Native: native-1/);
      assert.match(status, /State: running \(ralph\/executing\)/);
      assert.match(status, /Tmux: omx-session \/ %9/);
      assert.match(status, /Updated: 2026-03-20T00:04:30.000Z/);
      assert.match(status, /Freshness: Fresh/);
      assert.match(status, /Subagents: 4 active \(a1b2c3, d4e5f6, g7h8i9, \+1 more\)/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not report prompt-seeded ralph skill-active state as running without a live run-state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-session-status-prompt-seeded-'));
    try {
      await writeSessionStart(wd, 'sess-seeded', { nativeSessionId: 'native-seeded' });
      await writeJson(join(wd, '.omx', 'state', 'sessions', 'sess-seeded', 'skill-active-state.json'), {
        active: true,
        skill: 'ralph',
        phase: 'planning',
        updated_at: '2026-03-20T00:04:30.000Z',
        session_id: 'sess-seeded',
      });

      const status = await buildDiscordSessionStatusReply(createMapping(wd, 'sess-seeded'), {
        now: '2026-03-20T00:05:00.000Z',
      });

      assert.match(status, /Session: sess-seeded/);
      assert.match(status, /Native: native-seeded/);
      assert.match(status, /State: running$/m);
      assert.doesNotMatch(status, /ralph\/planning/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('renders stale partial summaries with explicit unknown fields', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-session-status-stale-'));
    try {
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'logs', 'session-history.jsonl'),
        `${JSON.stringify({
          session_id: 'sess-old',
          started_at: '2026-03-20T00:00:00.000Z',
          ended_at: '2026-03-20T00:01:00.000Z',
          cwd: wd,
          pid: 999,
        })}\n`,
        'utf-8',
      );

      const status = await buildDiscordSessionStatusReply(createMapping(wd, 'sess-old'), {
        now: '2026-03-20T00:10:00.000Z',
      });

      assert.match(status, /Session: sess-old/);
      assert.match(status, /Native: unknown/);
      assert.match(status, /State: ended/);
      assert.match(status, /Updated: 2026-03-20T00:01:00.000Z/);
      assert.match(status, /Freshness: May be stale \(last updated 2026-03-20T00:01:00.000Z\)/);
      assert.match(status, /Subagents: unknown/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not report a stale tracked session as running when only raw session.json remains', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-session-status-orphaned-'));
    try {
      await writeJson(join(wd, '.omx', 'state', 'session.json'), {
        session_id: 'sess-orphaned',
        native_session_id: 'native-orphaned',
        started_at: '2026-03-20T00:00:00.000Z',
        cwd: wd,
        pid: 4242,
        pid_start_ticks: 11,
        pid_cmdline: 'node omx',
      });
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'logs', 'session-history.jsonl'),
        `${JSON.stringify({
          session_id: 'sess-orphaned',
          native_session_id: 'native-orphaned',
          started_at: '2026-03-20T00:00:00.000Z',
          ended_at: '2026-03-20T00:01:00.000Z',
        })}\n`,
        'utf-8',
      );

      const status = await buildDiscordSessionStatusReply(createMapping(wd, 'sess-orphaned'), {
        now: '2026-03-20T00:10:00.000Z',
        readSessionStateImpl: async (projectPath) => {
          assert.equal(projectPath, wd);
          return {
            session_id: 'sess-orphaned',
            native_session_id: 'native-orphaned',
            started_at: '2026-03-20T00:00:00.000Z',
            cwd: wd,
            pid: 4242,
            pid_start_ticks: 11,
            pid_cmdline: 'node omx',
          };
        },
        readUsableSessionStateImpl: async (projectPath) => {
          assert.equal(projectPath, wd);
          return null;
        },
      });

      assert.doesNotMatch(status, /State: running/);
      assert.match(status, /State: ended/);
      assert.match(status, /Native: native-orphaned/);
      assert.match(status, /Freshness: May be stale \(last updated 2026-03-20T00:01:00.000Z\)/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('returns a bounded failure message when correlated state cannot be resolved', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-session-status-empty-'));
    try {
      const status = await buildDiscordSessionStatusReply(createMapping(wd));
      assert.equal(status, STATUS_DATA_UNAVAILABLE_MESSAGE);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('filters root skill-active fallback to entries visible to the requested session', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-session-status-foreign-root-'));
    try {
      await writeJson(join(wd, '.omx', 'state', 'skill-active-state.json'), {
        active: true,
        skill: 'team',
        phase: 'running',
        updated_at: '2026-03-20T00:04:30.000Z',
        active_skills: [
          {
            skill: 'ralph',
            phase: 'executing',
            active: true,
            session_id: 'sess-foreign',
            updated_at: '2026-03-20T00:04:30.000Z',
          },
          {
            skill: 'team',
            phase: 'running',
            active: true,
            updated_at: '2026-03-20T00:04:30.000Z',
          },
        ],
      });

      const status = await buildDiscordSessionStatusReply(createMapping(wd, 'sess-main'), {
        now: '2026-03-20T00:05:00.000Z',
      });

      assert.match(status, /State: team\/running/);
      assert.doesNotMatch(status, /ralph\/executing/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('ignores root skill-active fallback when all active entries belong to another session', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-session-status-root-only-foreign-'));
    try {
      await writeJson(join(wd, '.omx', 'state', 'skill-active-state.json'), {
        active: true,
        skill: 'ralph',
        phase: 'executing',
        updated_at: '2026-03-20T00:04:30.000Z',
        active_skills: [{
          skill: 'ralph',
          phase: 'executing',
          active: true,
          session_id: 'sess-foreign',
          updated_at: '2026-03-20T00:04:30.000Z',
        }],
      });

      const status = await buildDiscordSessionStatusReply(createMapping(wd, 'sess-main'), {
        now: '2026-03-20T00:05:00.000Z',
      });

      assert.equal(status, STATUS_DATA_UNAVAILABLE_MESSAGE);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

});
