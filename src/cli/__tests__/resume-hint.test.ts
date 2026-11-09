import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildResumeCommand, extractCodexDirectoryOverride, formatResumeBlock, resolveEffectiveSessionCwd } from '../resume-hint.js';
import { findLatestSession } from '../../session-history/search.js';

const SID = '01a1bee6-529f-7f43-bb86-e85cdc099614';

async function writeRollout(home: string, name: string, id: string, mtime: number): Promise<void> {
  const path = join(home, 'sessions', '2026', '11', '09', `rollout-${name}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ type: 'session_meta', payload: { id, timestamp: 't', cwd: '/x' } })}\n`);
  await utimes(path, mtime / 1000, mtime / 1000);
}

describe('resume block formatting', () => {
  it('plain launch uses only codex-native `resume <id>`', () => {
    const out = formatResumeBlock({ sessionId: SID, launchArgs: [], launchCwd: '/p' });
    assert.match(out, new RegExp(`Session id: ${SID}`));
    assert.match(out, new RegExp(`^  omx resume ${SID}$`, 'm'));
    assert.doesNotMatch(out, /--latest/);
  });

  it('madmax /exit prints isolated state line first, then a command that keeps --madmax/--high from the source cwd', () => {
    const out = formatResumeBlock({
      sessionId: SID,
      launchArgs: ['--madmax', '--high'],
      launchCwd: '/src/proj',
      madmaxStateDir: '/home/u/.omx-runs/run-1',
    });
    const lines = out.trimEnd().split('\n');
    assert.equal(lines[0], '[omx] madmax isolated state: /home/u/.omx-runs/run-1 (source: /src/proj)');
    assert.equal(lines.at(-1), `  cd /src/proj && omx --madmax --high resume ${SID}`);
  });

  it('worktree variant names the worktree and cds into it', () => {
    const out = formatResumeBlock({
      sessionId: SID,
      launchArgs: ['--worktree', 'feat-x'],
      launchCwd: '/repo',
      worktree: { path: '/repo.omx-worktrees/feat x', name: 'feat-x' },
    });
    assert.match(out, /\[omx\] worktree: feat-x \(\/repo\.omx-worktrees\/feat x\)/);
    assert.match(out, new RegExp(`cd '/repo\\.omx-worktrees/feat x' && omx resume ${SID}`));
  });

  it('re-emits model flag but omits project flag for durable homes', () => {
    // When projectLocalHome is false (default after cleanup), --project should not be added
    assert.equal(
      buildResumeCommand({ sessionId: SID, launchArgs: ['--model', 'gpt-5'], launchCwd: '/p', projectLocalHome: false }),
      `omx --model gpt-5 resume ${SID}`,
    );
  });

  it('includes project flag only when explicitly requested (legacy support)', () => {
    // When projectLocalHome is true, --project is added
    assert.equal(
      buildResumeCommand({ sessionId: SID, launchArgs: ['--model', 'gpt-5'], launchCwd: '/p', projectLocalHome: true }),
      `omx --model gpt-5 --project resume ${SID}`,
    );
  });

  it('without a session id says so and prints no broken resume command', () => {
    const out = formatResumeBlock({ sessionId: null, launchArgs: ['--madmax'], launchCwd: '/p' });
    assert.match(out, /No Codex session id was captured/);
    assert.doesNotMatch(out, /resume (null|undefined|'')/);
    assert.equal(buildResumeCommand({ sessionId: null, launchArgs: [], launchCwd: '/p' }), null);
  });
});

describe('findLatestSession (backs `resume --last`)', () => {
  it('returns null when no sessions exist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omx-latest-empty-'));
    try {
      assert.equal(await findLatestSession({ codexHomeDirs: [home] }), null);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('filters by cwd to avoid concurrent sessions from other launches', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omx-latest-cwd-filter-'));
    try {
      await mkdir(join(home, 'sessions', '2026', '11', '09'), { recursive: true });
      const path1 = join(home, 'sessions', '2026', '11', '09', 'rollout-1.jsonl');
      const path2 = join(home, 'sessions', '2026', '11', '09', 'rollout-2.jsonl');
      
      // Write session from /project-a with older mtime
      await writeFile(path1, `${JSON.stringify({ type: 'session_meta', payload: { id: 'session-a', timestamp: 't', cwd: '/project-a' } })}
`);
      await utimes(path1, 1000 / 1000, 1000 / 1000);
      
      // Write session from /project-b with newer mtime
      await writeFile(path2, `${JSON.stringify({ type: 'session_meta', payload: { id: 'session-b', timestamp: 't', cwd: '/project-b' } })}
`);
      await utimes(path2, 2000 / 1000, 2000 / 1000);
      
      // Without filter, should pick newest (session-b)
      const noFilter = await findLatestSession({ codexHomeDirs: [home] });
      assert.equal(noFilter?.session_id, 'session-b');
      
      // With filter for /project-a, should pick session-a even though it's older
      const withFilter = await findLatestSession({ codexHomeDirs: [home], cwdFilter: '/project-a' });
      assert.equal(withFilter?.session_id, 'session-a');
      
      // With filter for non-existent cwd, should return null
      const noMatch = await findLatestSession({ codexHomeDirs: [home], cwdFilter: '/project-c' });
      assert.equal(noMatch, null);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('extractCodexDirectoryOverride: extracts -C or --cd flags from args', () => {
    // Should extract -C flag with value
    assert.equal(extractCodexDirectoryOverride(['-C', '/other/dir', 'launch']), '/other/dir');
    
    // Should extract --cd flag with value
    assert.equal(extractCodexDirectoryOverride(['--cd', '/override', 'launch']), '/override');
    
    // Should extract --cd=value syntax
    assert.equal(extractCodexDirectoryOverride(['--cd=/path', 'launch']), '/path');
    
    // Should return undefined if no override
    assert.equal(extractCodexDirectoryOverride(['launch']), undefined);
    
    // Should return undefined if flag has no value
    assert.equal(extractCodexDirectoryOverride(['-C']), undefined);
  });

  it('resolveEffectiveSessionCwd: returns worktree path, then -C override, then launch cwd', () => {
    // When worktree is disabled and no override, should return launch cwd
    assert.equal(resolveEffectiveSessionCwd('/launch/cwd', false, undefined, undefined), '/launch/cwd');
    
    // When -C override is used but no worktree, should return override path
    assert.equal(resolveEffectiveSessionCwd('/launch/cwd', false, undefined, '/override/dir'), '/override/dir');
    
    // When worktree is enabled, should return worktree path (takes precedence over -C)
    assert.equal(resolveEffectiveSessionCwd('/launch/cwd', true, '/worktree/path', '/override/dir'), '/worktree/path');
    
    // When worktree is disabled and worktree path is undefined, should return launch cwd
    assert.equal(resolveEffectiveSessionCwd('/launch/cwd', false, undefined), '/launch/cwd');
  });

  it('worktree filter: findLatestSession picks correct session when filtering by effective cwd', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omx-worktree-effective-cwd-'));
    try {
      await mkdir(join(home, 'sessions', '2026', '11', '09'), { recursive: true });
      const path1 = join(home, 'sessions', '2026', '11', '09', 'rollout-1.jsonl');
      const path2 = join(home, 'sessions', '2026', '11', '09', 'rollout-2.jsonl');
      
      // Write session from original launch cwd with older mtime
      await writeFile(path1, `${JSON.stringify({ type: 'session_meta', payload: { id: 'session-launch', timestamp: 't', cwd: '/repo' } })}
`);
      await utimes(path1, 1000 / 1000, 1000 / 1000);
      
      // Write session from worktree cwd with newer mtime (simulates a worktree launch)
      await writeFile(path2, `${JSON.stringify({ type: 'session_meta', payload: { id: 'session-worktree', timestamp: 't', cwd: '/repo/.omx-worktrees/feat-x' } })}
`);
      await utimes(path2, 2000 / 1000, 2000 / 1000);
      
      // Critical: If code reverts to using launchCwd instead of effectiveCwdForSession,
      // it would find session-launch instead of the correct session-worktree
      const effectiveCwd = resolveEffectiveSessionCwd('/repo', true, '/repo/.omx-worktrees/feat-x');
      const found = await findLatestSession({ codexHomeDirs: [home], cwdFilter: effectiveCwd });
      assert.equal(found?.session_id, 'session-worktree', 'must find session created in worktree cwd when filtering by effective cwd');
      
      // Verify the other case: when filtering by launch cwd, find the launch session
      const launchSession = await findLatestSession({ codexHomeDirs: [home], cwdFilter: '/repo' });
      assert.equal(launchSession?.session_id, 'session-launch', 'should find session-launch when filtering by launch cwd');
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('picks the newest of several sessions across homes', async () => {
    const a = await mkdtemp(join(tmpdir(), 'omx-latest-a-'));
    const b = await mkdtemp(join(tmpdir(), 'omx-latest-b-'));
    try {
      await writeRollout(a, '1-old', 'old', 1_000_000);
      await writeRollout(a, '2-mid', 'mid', 2_000_000);
      await writeRollout(b, '3-new', 'new', 3_000_000);
      assert.equal((await findLatestSession({ codexHomeDirs: [a, b] }))?.session_id, 'new');
      assert.equal((await findLatestSession({ codexHomeDirs: [a] }))?.session_id, 'mid');
      assert.equal(await findLatestSession({ codexHomeDirs: [a, b], modifiedSinceMs: 4_000_000 }), null);
    } finally {
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  });

  it('finds session persisted from runtime home to durable home', async () => {
    const runtime = await mkdtemp(join(tmpdir(), 'omx-latest-runtime-'));
    const durable = await mkdtemp(join(tmpdir(), 'omx-latest-durable-'));
    try {
      // Write session to runtime home
      await writeRollout(runtime, 'sess1', 'sess1-id', 1_000_000);
      assert.equal((await findLatestSession({ codexHomeDirs: [runtime, durable] }))?.session_id, 'sess1-id');
      
      // Remove from runtime (simulate cleanup) and add to durable with newer mtime
      await rm(join(runtime, 'sessions'), { recursive: true, force: true });
      await writeRollout(durable, 'sess1', 'sess1-id', 2_000_000);
      
      // Should still find it in durable home
      assert.equal((await findLatestSession({ codexHomeDirs: [runtime, durable] }))?.session_id, 'sess1-id');
    } finally {
      await rm(runtime, { recursive: true, force: true });
      await rm(durable, { recursive: true, force: true });
    }
  });
});

describe('omx launch exit output (fake codex, isolated HOME)', () => {
  function run(args: string[], wd: string, fakeBin: string, extra: Record<string, string> = {}) {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    return spawnSync(process.execPath, [join(repoRoot, 'dist', 'cli', 'omx.js'), ...args], {
      cwd: wd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: join(wd, 'home'),
        CODEX_HOME: join(wd, 'home', '.codex'),
        OMX_RUNS_DIR: join(wd, 'runs'),
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
        OMX_LAUNCH_POLICY: 'direct',
        ...extra,
      },
    });
  }

  async function setup(writeSession: boolean, exitCode = 0) {
    const wd = await mkdtemp(join(tmpdir(), 'omx-exit-block-'));
    const fakeBin = join(wd, 'bin');
    await mkdir(fakeBin, { recursive: true });
    await mkdir(join(wd, 'home', '.codex'), { recursive: true });
    const script = writeSession
      ? `mkdir -p "$CODEX_HOME/sessions/2026/11/09"\nprintf '{"type":"session_meta","payload":{"id":"${SID}","cwd":"%s"}}\\n' "$PWD" > "$CODEX_HOME/sessions/2026/11/09/rollout-a.jsonl"\nexit ${exitCode}\n`
      : `exit ${exitCode}\n`;
    await writeFile(join(fakeBin, 'codex'), `#!/bin/sh\n${script}`, { mode: 0o755 });
    return { wd, fakeBin };
  }

  it('normal /exit prints the resume block', async () => {
    const { wd, fakeBin } = await setup(true);
    try {
      const r = run([], wd, fakeBin);
      assert.match(r.stderr, new RegExp(`Session id: ${SID}`), r.stderr);
      assert.match(r.stderr, new RegExp(`omx resume ${SID}`));
    } finally { await rm(wd, { recursive: true, force: true }); }
  });

  it('madmax /exit prints the block after the isolated-state line', async () => {
    const { wd, fakeBin } = await setup(true);
    try {
      const r = run(['--madmax', '--high'], wd, fakeBin);
      const stateAt = r.stderr.indexOf('[omx] madmax isolated state:');
      const blockAt = r.stderr.indexOf('Session id:');
      assert.ok(stateAt >= 0 && blockAt > stateAt, r.stderr);
      assert.match(r.stderr, new RegExp(`omx --madmax --high resume ${SID}`));
    } finally { await rm(wd, { recursive: true, force: true }); }
  });

  it('abnormal child exit still prints the block when a session id is known', async () => {
    const { wd, fakeBin } = await setup(true, 3);
    try {
      const r = run([], wd, fakeBin);
      assert.match(r.stderr, new RegExp(`omx resume ${SID}`), r.stderr);
    } finally { await rm(wd, { recursive: true, force: true }); }
  });

  it('no captured session id says so', async () => {
    const { wd, fakeBin } = await setup(false);
    try {
      const r = run([], wd, fakeBin);
      assert.match(r.stderr, /No Codex session id was captured/, r.stderr);
    } finally { await rm(wd, { recursive: true, force: true }); }
  });

  it('resume --last with no sessions errors clearly and does not launch codex', async () => {
    const { wd, fakeBin } = await setup(false);
    try {
      const r = run(['resume', '--last'], wd, fakeBin);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /no previous sessions found/, r.stderr);
    } finally { await rm(wd, { recursive: true, force: true }); }
  });

  it('exit block for project-scoped launch does not include --project flag', async () => {
    const { wd, fakeBin } = await setup(true);
    try {
      const r = run(['--project'], wd, fakeBin);
      // Should print resume block
      assert.match(r.stderr, new RegExp(`Session id: ${SID}`), r.stderr);
      // Should NOT include --project in the suggested resume command
      assert.match(r.stderr, new RegExp(`omx resume ${SID}`), r.stderr);
      assert.doesNotMatch(r.stderr, /omx.*--project.*resume/, r.stderr);
    } finally { await rm(wd, { recursive: true, force: true }); }
  });
});
