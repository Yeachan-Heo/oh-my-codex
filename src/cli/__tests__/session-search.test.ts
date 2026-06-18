import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
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
): Promise<string> {
  const [year, month, day] = isoDate.slice(0, 10).split('-');
  const dir = join(codexHomeDir, 'sessions', year, month, day);
  const filePath = join(dir, fileName);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf-8');
  return filePath;
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

  it('lists and searches unified CLI and App metadata without mutating App cache', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-unified-cli-'));
    const home = join(cwd, 'home');
    const codexHomeDir = join(home, '.codex');
    const appSupport = join(home, 'Library', 'Application Support', 'com.openai.chat');
    try {
      await mkdir(codexHomeDir, { recursive: true });
      await writeFile(join(codexHomeDir, 'auth.json'), '{"auth_mode":"apikey","OPENAI_API_KEY":"secret"}\n');
      await writeRollout(codexHomeDir, '2026-03-10T12:00:00.000Z', 'rollout-session-unified.jsonl', [
        { type: 'session_meta', payload: { id: 'session-unified', timestamp: '2026-03-10T12:00:00.000Z', cwd } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'hidden deep transcript marker sk-supersecret999' } },
      ]);
      await writeRollout(codexHomeDir, '2026-03-11T12:00:00.000Z', 'rollout-session-late.jsonl', [
        { type: 'session_meta', payload: { id: 'session-late', timestamp: '2026-03-11T12:00:00.000Z', cwd } },
        ...Array.from({ length: 90 }, (_value, index) => ({
          type: 'event_msg',
          payload: { type: 'user_message', message: `deep filler line ${index}` },
        })),
        { type: 'event_msg', payload: { type: 'user_message', message: 'late unified deep transcript marker' } },
      ]);
      const appDir = join(appSupport, 'codex-taskDetails-v1-user');
      await mkdir(appDir, { recursive: true });

      const list = runOmx(cwd, ['session', 'list', '--unified', '--json'], {
        HOME: home,
        CODEX_HOME: codexHomeDir,
      });
      assert.equal(list.status, 0, list.stderr || list.stdout);
      const parsed = JSON.parse(list.stdout) as { entries: Array<{ sessionId: string; source: string; authMode?: string }> };
      assert.equal(parsed.entries.some((entry) => entry.sessionId === 'session-unified' && entry.source === 'cli' && entry.authMode === undefined), true);
      assert.equal(parsed.entries.some((entry) => entry.sessionId === 'codex-taskDetails-v1-user' && entry.source === 'app'), true);
      const ledger = await readFile(join(home, '.omx', 'state', 'session-ledger.jsonl'), 'utf-8');
      assert.match(ledger, /session-unified/);
      assert.doesNotMatch(ledger, /secret/);

      const search = runOmx(cwd, ['session', 'search', 'taskDetails', '--unified', '--json'], {
        HOME: home,
        CODEX_HOME: codexHomeDir,
      });
      assert.equal(search.status, 0, search.stderr || search.stdout);
      assert.match(search.stdout, /codex-taskDetails-v1-user/);

      const shallowSearch = runOmx(cwd, ['session', 'search', 'hidden deep transcript', '--unified', '--json'], {
        HOME: home,
        CODEX_HOME: codexHomeDir,
      });
      assert.equal(shallowSearch.status, 0, shallowSearch.stderr || shallowSearch.stdout);
      assert.equal((JSON.parse(shallowSearch.stdout) as { entries: unknown[] }).entries.length, 0);

      const deepSearch = runOmx(cwd, ['session', 'search', 'hidden deep transcript', '--unified', '--deep', '--json'], {
        HOME: home,
        CODEX_HOME: codexHomeDir,
      });
      assert.equal(deepSearch.status, 0, deepSearch.stderr || deepSearch.stdout);
      assert.match(deepSearch.stdout, /session-unified/);
      assert.doesNotMatch(deepSearch.stdout, /sk-supersecret999/);

      const lateDeepSearch = runOmx(cwd, ['session', 'search', 'late unified deep transcript marker', '--unified', '--deep', '--json'], {
        HOME: home,
        CODEX_HOME: codexHomeDir,
      });
      assert.equal(lateDeepSearch.status, 0, lateDeepSearch.stderr || lateDeepSearch.stdout);
      assert.match(lateDeepSearch.stdout, /session-late/);
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

  it('searches generated project runtime Codex homes in unified mode', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-search-unified-runtime-'));
    const home = join(cwd, 'home');
    const defaultCodexHome = join(home, '.codex');
    const runtimeCodexHome = join(cwd, '.omx', 'runtime', 'codex-home', 'omx-runtime-a');
    try {
      await writeRollout(defaultCodexHome, '2026-03-10T12:00:00.000Z', 'rollout-default.jsonl', [
        {
          type: 'session_meta',
          payload: { id: 'default-unified-session', timestamp: '2026-03-10T12:00:00.000Z', cwd },
        },
      ]);
      await writeRollout(runtimeCodexHome, '2026-03-11T12:00:00.000Z', 'rollout-runtime.jsonl', [
        {
          type: 'session_meta',
          payload: { id: 'runtime-unified-session', timestamp: '2026-03-11T12:00:00.000Z', cwd },
        },
      ]);

      const result = runOmx(cwd, ['session', 'search', 'unified-session', '--unified', '--json'], {
        HOME: home,
        CODEX_HOME: '',
        OMX_ROOT: '',
        OMX_STATE_ROOT: '',
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const expectedRuntimeCodexHome = await realpath(runtimeCodexHome);
      const parsed = JSON.parse(result.stdout) as { entries: Array<{ sessionId: string; codexHome?: string }> };
      assert.deepEqual(parsed.entries.map((entry) => entry.sessionId).sort(), ['default-unified-session', 'runtime-unified-session']);
      assert.ok(parsed.entries.some((entry) => entry.codexHome === defaultCodexHome));
      assert.ok(parsed.entries.some((entry) => entry.codexHome === runtimeCodexHome || entry.codexHome === expectedRuntimeCodexHome));
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

  it('applies parsed filters to unified searches', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-search-unified-filters-'));
    const home = join(cwd, 'home');
    const defaultCodexHome = join(home, '.codex');
    const explicitCodexHome = join(cwd, 'explicit-codex-home');
    const chosenProject = join(cwd, 'chosen-project');
    const otherProject = join(cwd, 'other-project');
    try {
      await writeRollout(defaultCodexHome, '2026-03-12T12:00:00.000Z', 'rollout-target-default.jsonl', [
        { type: 'session_meta', payload: { id: 'target-default', timestamp: '2026-03-12T12:00:00.000Z', cwd: chosenProject } },
      ]);
      const oldPath = await writeRollout(explicitCodexHome, '2026-03-09T12:00:00.000Z', 'rollout-target-explicit-old.jsonl', [
        { type: 'session_meta', payload: { id: 'target-explicit-old', timestamp: '2026-03-09T12:00:00.000Z', cwd: chosenProject } },
      ]);
      await utimes(oldPath, new Date('2026-03-09T12:00:00.000Z'), new Date('2026-03-09T12:00:00.000Z'));
      await writeRollout(explicitCodexHome, '2026-03-12T12:00:00.000Z', 'rollout-target-explicit-other-project.jsonl', [
        { type: 'session_meta', payload: { id: 'target-explicit-other-project', timestamp: '2026-03-12T12:00:00.000Z', cwd: otherProject } },
      ]);
      await writeRollout(explicitCodexHome, '2026-03-12T12:00:00.000Z', 'rollout-target-explicit-new.jsonl', [
        { type: 'session_meta', payload: { id: 'target-explicit-new', timestamp: '2026-03-12T12:00:00.000Z', cwd: chosenProject } },
      ]);

      const result = runOmx(cwd, [
        'session',
        'search',
        'target',
        '--unified',
        '--codex-home',
        explicitCodexHome,
        '--session',
        'explicit',
        '--project',
        'chosen-project',
        '--since',
        '2026-03-10',
        '--json',
      ], {
        HOME: home,
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout) as { entries: Array<{ sessionId: string; codexHome?: string }> };
      assert.deepEqual(parsed.entries.map((entry) => entry.sessionId), ['target-explicit-new']);
      assert.equal(parsed.entries[0]?.codexHome, explicitCodexHome);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses updated times for unified recency filters', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-search-unified-updated-'));
    const home = join(cwd, 'home');
    const codexHome = join(home, '.codex');
    try {
      const resumedPath = await writeRollout(codexHome, '2026-03-09T12:00:00.000Z', 'rollout-target-resumed.jsonl', [
        { type: 'session_meta', payload: { id: 'target-resumed', timestamp: '2026-03-09T12:00:00.000Z', cwd } },
      ]);
      await utimes(resumedPath, new Date('2026-03-12T12:00:00.000Z'), new Date('2026-03-12T12:00:00.000Z'));

      const result = runOmx(cwd, ['session', 'search', 'target', '--unified', '--since', '2026-03-10', '--json'], {
        HOME: home,
        CODEX_HOME: '',
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout) as { entries: Array<{ sessionId: string }> };
      assert.deepEqual(parsed.entries.map((entry) => entry.sessionId), ['target-resumed']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
