import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSessionTimelineArgs } from '../session-timeline.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('parseSessionTimelineArgs', () => {
  it('accepts separated and equals flags with strict numeric values', () => {
    assert.deepEqual(parseSessionTimelineArgs(['abc']), { options: { session: 'abc' }, json: false });
    assert.deepEqual(parseSessionTimelineArgs([
      'abc', '--kind=tools', '--tool', 'exec', '--namespace=mcp__filesystem', '--status=failed', '--sort', 'duration',
      '--min-duration=200', '--offset', '1', '--limit=5', '--codex-home', '/home', '--json', '--output=report.json',
    ]), {
      options: { session: 'abc', kind: 'tools', tool: 'exec', namespace: 'mcp__filesystem', status: 'failed', sort: 'duration', minDurationMs: 200, offset: 1, limit: 5, codexHomeDir: '/home' },
      json: true, output: 'report.json',
    });
  });

  for (const args of [
    [], [' '], ['abc', 'def'], ['abc', '--unknown'], ['abc', '--json=true'], ['abc', '--kind=messages'],
    ['abc', '--status=success'], ['abc', '--sort=recent'], ['abc', '--limit=0'], ['abc', '--limit=10001'],
    ['abc', '--limit=1.5'], ['abc', '--limit=2oops'], ['abc', '--offset=-1'], ['abc', '--min-duration=NaN'],
    ['abc', '--offset=9007199254740992'], ['abc', '--tool='], ['abc', '--namespace='], ['abc', '--output'],
    ['abc', '--codex-home', '--json'], ['abc', '--min-duration=1e3'],
  ]) {
    it(`rejects ${JSON.stringify(args)}`, () => { assert.throws(() => parseSessionTimelineArgs(args)); });
  }
});

describe('omx session timeline', () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'omx-timeline-cli-')); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  function run(args: string[]) {
    return spawnSync(process.execPath, [join(repoRoot, 'dist/cli/omx.js'), 'session', ...args], {
      cwd, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CODEX_HOME: join(cwd, 'home'), OMX_ROOT: '', OMX_STATE_ROOT: '' },
    });
  }

  async function fixture(count = 1, name = 'exec', namespace?: string): Promise<string> {
    const root = join(cwd, 'home', 'sessions');
    await mkdir(root, { recursive: true });
    const path = join(root, 'rollout-cli-session.jsonl');
    const rows: unknown[] = [{ type: 'session_meta', payload: { id: 'cli-session', cwd, timestamp: '2026-10-14T10:00:00Z' } }];
    for (let i = 0; i < count; i++) {
      rows.push(
        { type: 'response_item', timestamp: '2026-10-14T10:00:01Z', payload: { type: 'function_call', call_id: `call-${i}`, name, ...(namespace === undefined ? {} : { namespace }), arguments: 'PRIVATE_ARGUMENTS' } },
        { type: 'response_item', timestamp: '2026-10-14T10:00:03Z', payload: { type: 'function_call_output', call_id: `call-${i}`, output: { exit_code: 1, output: 'PRIVATE_OUTPUT' } } },
      );
    }
    await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    return path;
  }

  it('dispatches human output without modifying transcripts or session state', async () => {
    const path = await fixture();
    const before = await readFile(path, 'utf-8');
    const state = join(cwd, '.omx', 'state');
    await mkdir(join(state, 'session.json.lock'), { recursive: true });
    await writeFile(join(state, 'session.json'), 'leave this pointer alone');
    const result = run(['timeline', 'cli-']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Session timeline: cli-session/);
    assert.match(result.stdout, /exec failed duration=2000ms call=call-0 result=L3 exit=1/);
    assert.doesNotMatch(result.stdout, /PRIVATE_/);
    assert.equal(result.stderr, '');
    assert.equal(await readFile(path, 'utf-8'), before);
    assert.equal(await readFile(join(state, 'session.json'), 'utf-8'), 'leave this pointer alone');
    assert.equal((await stat(join(state, 'session.json.lock'))).isDirectory(), true);
  });

  it('emits complete JSON through a pipe with filters and whole-session summaries', async () => {
    await fixture(1000);
    const result = run(['timeline', 'cli-session', '--json', '--status=failed', '--sort=duration', '--limit=1000']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.events.length, 1000);
    assert.equal(report.summary.failed, 1000);
    assert.equal(report.selection.has_more, false);
    assert.equal(report.events[999].call_id, 'call-999');
    assert.doesNotMatch(result.stdout, /PRIVATE_/);
  });

  it('offers pagination and empty-filter guidance', async () => {
    await fixture(3);
    const page = run(['timeline', 'cli-session', '--limit=1']);
    assert.equal(page.status, 0, page.stderr);
    assert.match(page.stdout, /1 shown, 3 match\(es\)/);
    assert.match(page.stdout, /use --offset 1/);
    const empty = run(['timeline', 'cli-session', '--tool=missing']);
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /No events matched this page/);
    assert.match(empty.stdout, /3 tool call\(s\)/);
  });

  it('filters and displays a namespaced tool without merging its identity', async () => {
    await fixture(2, 'read', 'mcp__filesystem');
    const args = ['timeline', 'cli-session', '--tool', 'read', '--namespace', 'mcp__filesystem'];
    const human = run(args);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /read namespace=mcp__filesystem failed/);

    const json = run([...args, '--json']);
    assert.equal(json.status, 0, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.equal(report.selection.namespace, 'mcp__filesystem');
    assert.equal(report.events.length, 2);
    assert.ok(report.events.every((event: { namespace: string }) => event.namespace === 'mcp__filesystem'));
  });

  it('writes private output files and refuses to overwrite a report or its source', async () => {
    const source = await fixture();
    const output = join(cwd, 'report with spaces.json');
    const result = run(['timeline', 'cli-session', '--json', '--output', output]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Saved session timeline/);
    assert.equal(JSON.parse(await readFile(output, 'utf-8')).schema_version, 1);
    if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
    for (const destination of [source, output]) {
      const before = await readFile(destination, 'utf-8');
      const overwrite = run(['timeline', 'cli-session', '--output', destination]);
      assert.notEqual(overwrite.status, 0);
      assert.match(overwrite.stderr, /EEXIST/);
      assert.equal(await readFile(destination, 'utf-8'), before);
    }
  });

  it('refuses symlink output destinations', { skip: process.platform === 'win32' }, async () => {
    const source = await fixture();
    const output = join(cwd, 'link');
    const before = await readFile(source, 'utf-8');
    await symlink(source, output);
    assert.notEqual(run(['timeline', 'cli-session', '--output', output]).status, 0);
    assert.equal(await readFile(source, 'utf-8'), before);
  });

  it('strips terminal control characters from tool names in human output', async () => {
    await fixture(1, 'exec\u001b[31m\nforged-line');
    const result = run(['timeline', 'cli-session']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /\u001b|\nforged-line/);
  });

  it('rejects bad options or missing sessions before creating output', async () => {
    await fixture();
    const output = join(cwd, 'absent.json');
    for (const args of [['missing'], ['cli-session', '--limit=1oops']]) {
      const result = run(['timeline', ...args, '--output', output]);
      assert.notEqual(result.status, 0);
      await assert.rejects(stat(output), { code: 'ENOENT' });
    }
  });

  it('exposes session and timeline help without opening a history', () => {
    const sessionHelp = run(['--help']).stdout;
    assert.match(sessionHelp, /omx session timeline <session-id>/);
    assert.match(sessionHelp, /--namespace <name>/);
    const help = run(['timeline', '--help', '--codex-home', '/does-not-exist']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--min-duration/);
    assert.match(help.stdout, /--status/);
    assert.match(help.stdout, /Summary counts cover the whole session/);
  });
});
