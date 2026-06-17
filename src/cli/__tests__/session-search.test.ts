import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSessionSearchArgs } from '../session-search.js';

async function writeRollout(
  codexHomeDir: string,
  isoDate: string,
  fileName: string,
  lines: Array<Record<string, unknown>>,
): Promise<void> {
  const [year, month, day] = isoDate.slice(0, 10).split('-');
  const dir = join(codexHomeDir, 'sessions', year, month, day);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf-8');
}

function runOmx(cwd: string, argv: string[], envOverrides: Record<string, string> = {}) {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');
  const result = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...envOverrides },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('parseSessionSearchArgs', () => {
  it('parses query tokens and flags', () => {
    const parsed = parseSessionSearchArgs(['team', 'api', '--limit', '5', '--project=current', '--codex-home', '/tmp/codex', '--json']);
    assert.equal(parsed.options.query, 'team api');
    assert.equal(parsed.options.limit, 5);
    assert.equal(parsed.options.project, 'current');
    assert.equal(parsed.options.codexHomeDir, '/tmp/codex');
    assert.equal(parsed.json, true);
  });
});

describe('omx session search', () => {
  it('prints structured JSON results for matching transcripts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-search-cli-'));
    const codexHomeDir = join(cwd, '.codex-home');
    try {
      await writeRollout(codexHomeDir, '2026-03-10T12:00:00.000Z', 'rollout-2026-03-10T12-00-00-session-a.jsonl', [
        {
          type: 'session_meta',
          payload: {
            id: 'session-a',
            timestamp: '2026-03-10T12:00:00.000Z',
            cwd,
          },
        },
        {
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'Show previous discussions of team api in recent runs.',
          },
        },
      ]);

      const result = runOmx(cwd, ['session', 'search', 'team api', '--project', 'current', '--json'], {
        CODEX_HOME: codexHomeDir,
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout) as {
        query: string;
        results: Array<{ session_id: string; snippet: string; cwd: string }>;
      };
      assert.equal(parsed.query, 'team api');
      assert.equal(parsed.results.length, 1);
      assert.equal(parsed.results[0].session_id, 'session-a');
      assert.equal(parsed.results[0].cwd, cwd);
      assert.match(parsed.results[0].snippet, /team api/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('searches generated project runtime Codex homes in a project repo', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-search-cli-project-'));
    const home = join(cwd, 'home');
    const defaultCodexHome = join(home, '.codex');
    const runtimeCodexHome = join(cwd, '.omx', 'runtime', 'codex-home', 'omx-runtime-a');
    try {
      await writeRollout(defaultCodexHome, '2026-03-10T12:00:00.000Z', 'rollout-default.jsonl', [
        {
          type: 'session_meta',
          payload: { id: 'default-session', timestamp: '2026-03-10T12:00:00.000Z', cwd },
        },
        { type: 'event_msg', payload: { type: 'user_message', message: 'generated project search default' } },
      ]);
      await writeRollout(runtimeCodexHome, '2026-03-11T12:00:00.000Z', 'rollout-runtime.jsonl', [
        {
          type: 'session_meta',
          payload: { id: 'runtime-session', timestamp: '2026-03-11T12:00:00.000Z', cwd },
        },
        { type: 'event_msg', payload: { type: 'user_message', message: 'generated project search runtime' } },
      ]);

      const result = runOmx(cwd, ['session', 'search', 'generated project search', '--json'], {
        HOME: home,
        CODEX_HOME: '',
        OMX_ROOT: '',
        OMX_STATE_ROOT: '',
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const expectedRuntimeCodexHome = await realpath(runtimeCodexHome);
      const parsed = JSON.parse(result.stdout) as {
        results: Array<{ session_id: string }>;
        sources: Array<{ codex_home: string }>;
      };
      assert.deepEqual(parsed.results.map((result) => result.session_id).sort(), ['default-session', 'runtime-session']);
      assert.ok(parsed.sources.some((source) => source.codex_home === defaultCodexHome));
      assert.ok(parsed.sources.some((source) => source.codex_home === runtimeCodexHome || source.codex_home === expectedRuntimeCodexHome));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('searches associated madmax boxed run roots without leaking raw run paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-search-madmax-'));
    const home = join(cwd, 'home');
    const runsRoot = join(cwd, 'runs');
    const associatedCodexHome = join(runsRoot, 'run-associated', '.omx', 'runtime', 'codex-home', 'omx-madmax-a');
    const unrelatedCodexHome = join(runsRoot, 'run-unrelated', '.omx', 'runtime', 'codex-home', 'omx-madmax-b');
    const unrelatedSource = join(cwd, 'unrelated-source');
    try {
      await mkdir(unrelatedSource, { recursive: true });
      await writeRollout(associatedCodexHome, '2026-03-11T12:00:00.000Z', 'rollout-associated.jsonl', [
        { type: 'session_meta', payload: { id: 'madmax-session', timestamp: '2026-03-11T12:00:00.000Z', cwd } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'associated madmax boxed search target' } },
      ]);
      await writeRollout(unrelatedCodexHome, '2026-03-11T12:00:00.000Z', 'rollout-unrelated.jsonl', [
        { type: 'session_meta', payload: { id: 'unrelated-session', timestamp: '2026-03-11T12:00:00.000Z', cwd: unrelatedSource } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'associated madmax boxed search target unrelated' } },
      ]);
      await writeFile(join(runsRoot, 'registry.jsonl'), `${JSON.stringify({ source_cwd: cwd, run_dir: join(runsRoot, 'run-associated') })}\n${JSON.stringify({ source_cwd: unrelatedSource, run_dir: join(runsRoot, 'run-unrelated') })}\n`);

      const result = runOmx(cwd, ['session', 'search', 'associated madmax boxed search target', '--json'], {
        HOME: home,
        CODEX_HOME: '',
        OMX_RUNS_DIR: runsRoot,
        OMX_ROOT: '',
        OMX_STATE_ROOT: '',
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout) as {
        results: Array<{ session_id: string; transcript_path: string }>;
        sources: Array<{ codex_home: string }>;
      };
      assert.deepEqual(parsed.results.map((result) => result.session_id), ['madmax-session']);
      assert.ok(parsed.sources.some((source) => source.codex_home === 'madmax:omx-madmax-a'));
      assert.equal(parsed.sources.some((source) => source.codex_home.includes(runsRoot)), false);
      assert.equal(parsed.results.some((result) => result.transcript_path.includes(runsRoot)), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('searches only the explicit --codex-home path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-search-cli-codex-home-'));
    const home = join(cwd, 'home');
    const explicitCodexHome = join(cwd, 'explicit-codex-home');
    try {
      await writeRollout(join(home, '.codex'), '2026-03-10T12:00:00.000Z', 'rollout-default.jsonl', [
        { type: 'session_meta', payload: { id: 'default-session', timestamp: '2026-03-10T12:00:00.000Z', cwd } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'explicit codex home target default' } },
      ]);
      await writeRollout(explicitCodexHome, '2026-03-11T12:00:00.000Z', 'rollout-explicit.jsonl', [
        { type: 'session_meta', payload: { id: 'explicit-session', timestamp: '2026-03-11T12:00:00.000Z', cwd } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'explicit codex home target chosen' } },
      ]);

      const result = runOmx(cwd, ['session', 'search', 'explicit codex home target', '--codex-home', explicitCodexHome, '--json'], {
        HOME: home,
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout) as { results: Array<{ session_id: string }> };
      assert.deepEqual(parsed.results.map((entry) => entry.session_id), ['explicit-session']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
