import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSessionFrictionReport } from '../friction.js';

async function writeRollout(
  codexHomeDir: string,
  isoDate: string,
  fileName: string,
  lines: Array<Record<string, unknown> | string>,
): Promise<void> {
  const [year, month, day] = isoDate.slice(0, 10).split('-');
  const dir = join(codexHomeDir, 'sessions', year, month, day);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, fileName),
    `${lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n')}\n`,
    'utf-8',
  );
}

describe('buildSessionFrictionReport', () => {
  it('summarizes metadata-only friction signals without raw transcript payloads', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-friction-'));
    const codexHomeDir = join(cwd, '.codex-home');
    try {
      await writeRollout(codexHomeDir, '2026-06-24T09:00:00.000Z', 'rollout-safe-session.jsonl', [
        {
          type: 'session_meta',
          timestamp: '2026-06-24T09:00:00.000Z',
          payload: { id: 'safe-session', timestamp: '2026-06-24T09:00:00.000Z', cwd },
        },
        {
          type: 'event_msg',
          timestamp: '2026-06-24T09:01:00.000Z',
          payload: { type: 'user_message', message: 'secret prompt must not be emitted sk-test-secret' },
        },
        {
          type: 'response_item',
          timestamp: '2026-06-24T09:02:00.000Z',
          payload: { type: 'function_call', name: 'read', arguments: '{"path":"private.txt"}' },
        },
        {
          type: 'response_item',
          timestamp: '2026-06-24T12:10:00.000Z',
          payload: { type: 'function_call_output', output: 'private output must not be emitted' },
        },
        '{not-json',
      ]);

      const report = await buildSessionFrictionReport({
        cwd,
        codexHomeDirs: [codexHomeDir],
        now: Date.parse('2026-06-25T12:10:00.000Z'),
        since: '7d',
      });

      assert.equal(report.privacy.mode, 'metadata-only');
      assert.ok(report.privacy.excludes.includes('raw_prompts'));
      assert.equal(report.sessions.length, 1);
      const session = report.sessions[0];
      assert.equal(session.session_id, 'safe-session');
      assert.equal(session.cwd_basename, cwd.split('/').at(-1));
      assert.match(session.cwd_hash ?? '', /^[a-f0-9]{12}$/);
      assert.equal(session.counters.records, 5);
      assert.equal(session.counters.malformed_records, 1);
      assert.equal(session.counters.user_turns, 1);
      assert.equal(session.counters.tool_calls, 1);
      assert.equal(session.counters.tool_outputs, 1);
      assert.equal(session.idle_gaps.gaps_over_2h, 1);
      assert.deepEqual(session.tool_names, [{ name: 'read', count: 1 }]);
      assert.ok(session.risks.some((risk) => risk.code === 'stale_session'));
      assert.ok(session.risks.some((risk) => risk.code === 'large_idle_gap'));
      assert.ok(session.risks.some((risk) => risk.code === 'parse_gaps'));

      assert.match(session.source.transcript_ref, /^[a-f0-9]{12}$/);

      const serialized = JSON.stringify(report);
      assert.doesNotMatch(serialized, /secret prompt/);
      assert.doesNotMatch(serialized, /sk-test-secret/);
      assert.doesNotMatch(serialized, /private output/);
      assert.doesNotMatch(serialized, /private\.txt/);
      assert.doesNotMatch(serialized, /\.codex-home/);
      assert.doesNotMatch(serialized, /sessions\//);
      assert.doesNotMatch(serialized, /rollout-safe-session/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('defaults to current-project recent sessions and safe source labels', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-friction-current-'));
    const otherCwd = await mkdtemp(join(tmpdir(), 'omx-session-friction-other-'));
    const codexHomeDir = join(cwd, '.codex-home');
    try {
      await writeRollout(codexHomeDir, '2026-06-24T09:00:00.000Z', 'rollout-current.jsonl', [
        { type: 'session_meta', timestamp: '2026-06-24T09:00:00.000Z', payload: { id: 'current-session', timestamp: '2026-06-24T09:00:00.000Z', cwd } },
      ]);
      await writeRollout(codexHomeDir, '2026-06-24T10:00:00.000Z', 'rollout-other.jsonl', [
        { type: 'session_meta', timestamp: '2026-06-24T10:00:00.000Z', payload: { id: 'other-session', timestamp: '2026-06-24T10:00:00.000Z', cwd: otherCwd } },
      ]);

      const report = await buildSessionFrictionReport({
        cwd,
        codexHomeDir,
        now: Date.parse('2026-06-24T11:00:00.000Z'),
        since: '7d',
      });

      assert.deepEqual(report.sessions.map((session) => session.session_id), ['current-session']);
      assert.equal(report.sources[0].codex_home, 'explicit-codex-home');
      assert.equal(report.sources[0].codex_home.includes(codexHomeDir), false);
      assert.equal(report.sessions[0].source.codex_home, 'explicit-codex-home');
      assert.match(report.sessions[0].source.transcript_ref, /^[a-f0-9]{12}$/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(otherCwd, { recursive: true, force: true });
    }
  });
});
