import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSinceSpec, searchSessionHistory } from '../search.js';

async function writeRollout(
  codexHomeDir: string,
  isoDate: string,
  fileName: string,
  lines: Array<Record<string, unknown>>,
): Promise<string> {
  const [year, month, day] = isoDate.slice(0, 10).split('-');
  const dir = join(codexHomeDir, 'sessions', year, month, day);
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf-8');
  return path;
}

describe('parseSinceSpec', () => {
  it('parses duration and date forms', () => {
    const now = Date.parse('2026-03-10T12:00:00.000Z');
    assert.equal(parseSinceSpec('24h', now), now - 24 * 3_600_000);
    assert.equal(parseSinceSpec('2026-03-09', now), Date.parse('2026-03-09'));
  });
});

describe('searchSessionHistory', () => {
  it('returns structured matches with snippets from rollout transcripts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-search-'));
    const codexHomeDir = join(cwd, '.codex-home');
    try {
      await writeRollout(codexHomeDir, '2026-03-10T12:00:00.000Z', 'rollout-2026-03-10T12-00-00-session-a.jsonl', [
        {
          type: 'session_meta',
          payload: {
            id: 'session-a',
            timestamp: '2026-03-10T12:00:00.000Z',
            cwd: '/tmp/project-a',
          },
        },
        {
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'Please investigate the worker inbox path issue in team mode.',
          },
        },
      ]);

      const report = await searchSessionHistory({
        query: 'worker inbox path',
        codexHomeDir,
        cwd,
      });

      assert.equal(report.results.length, 1);
      assert.equal(report.matched_sessions, 1);
      assert.equal(report.results[0].session_id, 'session-a');
      assert.equal(report.results[0].record_type, 'event_msg:user_message');
      assert.match(report.results[0].snippet, /worker inbox path issue/i);
      assert.equal(report.results[0].transcript_path_relative, 'sessions/2026/03/10/rollout-2026-03-10T12-00-00-session-a.jsonl');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('supports session, project, and limit filters', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-search-'));
    const codexHomeDir = join(cwd, '.codex-home');
    try {
      await writeRollout(codexHomeDir, '2026-03-10T12:00:00.000Z', 'rollout-2026-03-10T12-00-00-session-a.jsonl', [
        {
          type: 'session_meta',
          payload: {
            id: 'session-a',
            timestamp: '2026-03-10T12:00:00.000Z',
            cwd: '/repo/current',
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            output: 'all_workers_idle fired after startup evidence was missing',
          },
        },
      ]);
      await writeRollout(codexHomeDir, '2026-03-09T12:00:00.000Z', 'rollout-2026-03-09T12-00-00-session-b.jsonl', [
        {
          type: 'session_meta',
          payload: {
            id: 'session-b',
            timestamp: '2026-03-09T12:00:00.000Z',
            cwd: '/repo/other',
          },
        },
        {
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            message: 'all_workers_idle should remain searchable in older sessions too',
          },
        },
      ]);

      const projectReport = await searchSessionHistory({
        query: 'all_workers_idle',
        project: '/repo/current',
        session: 'session-a',
        limit: 1,
        codexHomeDir,
        cwd,
      });
      assert.equal(projectReport.results.length, 1);
      assert.equal(projectReport.results[0].session_id, 'session-a');

      const sinceReport = await searchSessionHistory({
        query: 'all_workers_idle',
        since: '12h',
        now: Date.parse('2026-03-10T18:00:00.000Z'),
        codexHomeDir,
        cwd,
      });
      assert.equal(sinceReport.results.length, 1);
      assert.equal(sinceReport.results[0].session_id, 'session-a');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns no results cleanly when nothing matches', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-search-'));
    const codexHomeDir = join(cwd, '.codex-home');
    try {
      await writeRollout(codexHomeDir, '2026-03-10T12:00:00.000Z', 'rollout-2026-03-10T12-00-00-session-a.jsonl', [
        {
          type: 'session_meta',
          payload: {
            id: 'session-a',
            timestamp: '2026-03-10T12:00:00.000Z',
            cwd: '/tmp/project-a',
          },
        },
      ]);

      const report = await searchSessionHistory({
        query: 'startup evidence',
        codexHomeDir,
        cwd,
      });

      assert.deepEqual(report.results, []);
      assert.equal(report.matched_sessions, 0);
      assert.equal(report.searched_files, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
