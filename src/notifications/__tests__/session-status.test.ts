import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
      assert.match(status, new RegExp(`Project: ${escapeRegExp(basename(wd))}`));
      assert.match(status, /State: running \(ralph\/executing\)/);
      assert.match(status, /Started: /);
      assert.match(status, /Tmux: omx-session \/ %9/);
      assert.match(status, new RegExp(`History: ${escapeRegExp(join('.omx', 'logs', 'session-history.jsonl'))}`));
      assert.match(status, /Updated: 2026-03-20T00:04:30.000Z/);
      assert.match(status, /Freshness: Fresh/);
      assert.match(status, /Subagents: 4 active \(a1b2c3, d4e5f6, g7h8i9, \+1 more\)/);
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
      assert.match(status, new RegExp(`Project: ${escapeRegExp(basename(wd))}`));
      assert.match(status, /State: ended/);
      assert.match(status, /Started: 2026-03-20T00:00:00.000Z/);
      assert.match(status, new RegExp(`History: ${escapeRegExp(join('.omx', 'logs', 'session-history.jsonl'))}`));
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
      assert.doesNotMatch(status, /Project:/);
      assert.match(status, /State: ended/);
      assert.match(status, /Native: native-orphaned/);
      assert.match(status, /Started: 2026-03-20T00:00:00.000Z/);
      assert.doesNotMatch(status, /PID:/);
      assert.doesNotMatch(status, /History:/);
      assert.match(status, /Freshness: May be stale \(last updated 2026-03-20T00:01:00.000Z\)/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not render project-derived detail lines when only tracker-style evidence exists', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-session-status-tracker-only-'));
    try {
      let tracking = createSubagentTrackingState();
      tracking = recordSubagentTurn(tracking, {
        sessionId: 'sess-tracker-only',
        threadId: 'a1b2c3-thread',
        turnId: 'turn-1',
        timestamp: '2026-03-20T00:04:00.000Z',
        mode: 'ralph',
      });
      await writeSubagentTrackingState(wd, tracking);

      const status = await buildDiscordSessionStatusReply(createMapping(wd, 'sess-tracker-only'), {
        now: '2026-03-20T00:05:00.000Z',
        readSessionStateImpl: async () => null,
        readUsableSessionStateImpl: async () => null,
      });

      assert.match(status, /Session: sess-tracker-only/);
      assert.doesNotMatch(status, /Project:/);
      assert.doesNotMatch(status, /Started:/);
      assert.doesNotMatch(status, /History:/);
      assert.match(status, /Subagents: 0 active|Subagents: unknown/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('returns the existing bounded failure when the mapping has no project path', async () => {
    const status = await buildDiscordSessionStatusReply({
      ...createMapping('/tmp/unused', 'sess-missing-path'),
      projectPath: undefined,
    });
    assert.equal(status, STATUS_DATA_UNAVAILABLE_MESSAGE);
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
});
