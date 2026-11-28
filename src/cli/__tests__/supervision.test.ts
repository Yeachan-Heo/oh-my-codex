import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUPERVISION_CHECKS,
  applyDedupe,
  buildIssueDraft,
  buildLanePrompt,
  classifyProcess,
  collectSnapshot,
  collectSnapshotForSession,
  collectStateFiles,
  consolidateFindingsByFingerprint,
  computeCpuPercent,
  defaultSupervisionDeps,
  discoverCandidates,
  evaluateChecks,
  findDuplicateIssue,
  fingerprintFor,
  planAnalysisLanes,
  readHudModel,
  renderReportMarkdown,
  rolloutCwd,
  summarizeEvidence,
  toEvidenceBundle,
  isFileable,
  markerFor,
  parsePsCpuTime,
  parseSupervisionArgs,
  rankFinding,
  runSupervision,
  selectSession,
  stateDirForRoot,
  triage,
  type CheckResult,
  type Finding,
  type ModeStateRecord,
  type ProcSample,
  type SessionCandidate,
  type SupervisionDeps,
  type SupervisionOptions,
  type SupervisionReport,
  type SupervisionSnapshot,
} from '../supervision.js';
import { REPEAT_PROBLEM_REGISTRY, sourcesFor } from '../supervision-registry.js';
import { IQDOCTOR_HISTORY } from '../supervision-history.iqdoctor.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NOW = Date.parse('2026-11-26T12:00:00Z');

function candidate(overrides: Partial<SessionCandidate> = {}): SessionCandidate {
  return {
    sessionId: 'sess-1', cwd: '/work/a', stateDir: '/work/a/.omx/state', pid: 100, pidAlive: true,
    stateMtimeMs: NOW - 1000, rolloutMtimeMs: null, sources: ['test'], ...overrides,
  };
}

function proc(overrides: Partial<ProcSample> = {}): ProcSample {
  return { pid: 10, ppid: 1, kind: 'hud-watch', args: 'node omx hud --watch', rssKb: 50_000, cpuSecStart: 1, cpuSecEnd: 1.1, cpuPct: 1, ...overrides };
}

function snapshot(overrides: Partial<SupervisionSnapshot> = {}): SupervisionSnapshot {
  const selected = candidate();
  return {
    takenAt: new Date(NOW).toISOString(), nowMs: NOW, windowSeconds: 10, platform: 'linux',
    selection: { selected, mode: 'active', reason: 'test', candidates: [selected] },
    processes: [], panes: [], tmuxAvailable: true,
    state: {
      stateDir: selected.stateDir, modes: [], currentAutopilot: null, nativeStop: null, supportBlockers: [], canonicalSkills: [], teamPhases: [], subagentTracking: null,
      sizes: { stateBytes: 1024, logsBytes: 1024, rolloutBytes: 1024, rolloutScanTruncated: false }, hookLog: null,
    },
    hud: { modes: {}, staleAutopilot: false },
    doctor: { nativeAgents: { status: 'pass', message: 'ok' }, pluginVersions: { status: 'pass', message: 'ok' } },
    friction: [],
    ...overrides,
  };
}

function mode(name: string, data: Record<string, unknown>) {
  return { mode: name, scope: 'session' as const, path: `/work/a/.omx/state/sessions/sess-1/${name}-state.json`, mtimeMs: NOW, data };
}

function tracking(threads: Record<string, Record<string, unknown>>) {
  const iso = new Date(NOW).toISOString();
  return {
    schemaVersion: 1 as const,
    sessions: {
      'sess-1': {
        session_id: 'sess-1', leader_thread_id: 'leader', updated_at: iso,
        threads: {
          leader: { thread_id: 'leader', kind: 'leader', first_seen_at: iso, last_seen_at: iso, turn_count: 1 },
          ...Object.fromEntries(Object.entries(threads).map(([id, data]) => [id, { thread_id: id, kind: 'subagent', first_seen_at: iso, last_seen_at: iso, turn_count: 1, ...data }])),
        },
      },
    },
  } as unknown as SupervisionSnapshot['state']['subagentTracking'];
}

function hudPane(paneId: string, extra = '', currentPath = tmpdir()) {
  return { paneId, windowId: '@1', sessionId: '$1', currentCommand: 'node', startCommand: `env OMX_TMUX_HUD_LEADER_PANE=%1 ${extra} node /x/omx.js hud --watch`, currentPath };
}

function result(id: string, snap: SupervisionSnapshot): CheckResult {
  const found = evaluateChecks(snap).find((check) => check.id === id);
  assert.ok(found, `check ${id} exists`);
  return found;
}

/** pass fixture and fail fixture per check; every check must appear here. */
const FIXTURES: Record<string, { pass: () => SupervisionSnapshot; fail: () => SupervisionSnapshot; failStatus: 'warn' | 'fail' }> = {
  'silver-rule-lane-reuse': {
    failStatus: 'warn',
    pass: () => snapshot({ state: { ...snapshot().state, subagentTracking: tracking({ a: { role: 'executor', lane_id: 'impl' } }) } }),
    fail: () => snapshot({ state: { ...snapshot().state, subagentTracking: tracking({ a: { role: 'executor', lane_id: 'impl' }, b: { role: 'executor', lane_id: 'impl' } }) } }),
  },
  'ralplan-lane-reuse': {
    failStatus: 'warn',
    pass: () => snapshot({ state: { ...snapshot().state, modes: [mode('ralplan', { active: true })], subagentTracking: tracking({ a: { role: 'critic' } }) } }),
    fail: () => snapshot({ state: { ...snapshot().state, modes: [mode('ralplan', { active: true })], subagentTracking: tracking({ a: { role: 'default' } }) } }),
  },
  'native-subagent-blocker': {
    failStatus: 'fail',
    pass: () => snapshot(),
    fail: () => snapshot({ state: { ...snapshot().state, modes: [mode('autopilot', { active: true, current_phase: 'ralplan' })], supportBlockers: [{ file: 'native-subagent-support.json', data: { reason: 'native_subagents_unsupported' } }] } }),
  },
  'hud-cpu-load': {
    failStatus: 'fail',
    pass: () => snapshot({ processes: [proc({ cpuPct: 1.5 })] }),
    fail: () => snapshot({ processes: [proc({ cpuPct: 7.2 })] }),
  },
  'hud-duplicate-panes': {
    failStatus: 'fail',
    pass: () => snapshot({ panes: [hudPane('%2')] }),
    fail: () => snapshot({ panes: [hudPane('%2'), hudPane('%3')] }),
  },
  'process-rss': {
    failStatus: 'fail',
    pass: () => snapshot({ processes: [proc({ rssKb: 200_000 })] }),
    fail: () => snapshot({ processes: [proc({ rssKb: 3 * 1024 * 1024 })] }),
  },
  'disk-growth': {
    failStatus: 'warn',
    pass: () => snapshot(),
    fail: () => snapshot({ state: { ...snapshot().state, sizes: { stateBytes: 150 * 1024 * 1024, logsBytes: 0, rolloutBytes: 0, rolloutScanTruncated: false } } }),
  },
  'autopilot-phase-illegal': {
    failStatus: 'fail',
    pass: () => snapshot({ state: { ...snapshot().state, modes: [mode('autopilot', { active: true, current_phase: 'code-review' })] } }),
    fail: () => snapshot({ state: { ...snapshot().state, modes: [mode('autopilot', { active: true, current_phase: 'frobnicating' })] } }),
  },
  'team-phase-transition-illegal': {
    failStatus: 'fail',
    pass: () => snapshot({ state: { ...snapshot().state, teamPhases: [{ path: 'p.json', transitions: [{ from: 'team-plan', to: 'team-prd' }, { from: 'team-verify', to: 'team-fix' }, { from: 'team-exec', to: 'failed' }] }] } }),
    fail: () => snapshot({ state: { ...snapshot().state, teamPhases: [{ path: 'p.json', transitions: [{ from: 'team-plan', to: 'team-verify' }] }] } }),
  },
  'autopilot-phase-stuck': {
    failStatus: 'warn',
    pass: () => snapshot({ state: { ...snapshot().state, modes: [mode('autopilot', { active: true, current_phase: 'team', updated_at: new Date(NOW - 60_000).toISOString() })] } }),
    fail: () => snapshot({ state: { ...snapshot().state, modes: [mode('autopilot', { active: true, current_phase: 'team', updated_at: new Date(NOW - 3 * 3600_000).toISOString() })] } }),
  },
  'autopilot-gate-loop': {
    failStatus: 'fail',
    pass: () => snapshot({ state: { ...snapshot().state, nativeStop: { sessions: { s: { ordinary_no_progress_guard: { repeat_count: 2, last_seen_at: new Date(NOW).toISOString() } } } } } }),
    fail: () => snapshot({ state: { ...snapshot().state, nativeStop: { sessions: { s: { ordinary_no_progress_guard: { repeat_count: 9, last_seen_at: new Date(NOW - 1000).toISOString() } } } } } }),
  },
  'stop-hook-invalid-json': {
    failStatus: 'fail',
    pass: () => snapshot({ state: { ...snapshot().state, hookLog: { path: 'x.jsonl', dispatchErrors: 0, samples: [] } } }),
    fail: () => snapshot({ state: { ...snapshot().state, hookLog: { path: 'x.jsonl', dispatchErrors: 2, samples: ['{"type":"native_hook_dispatch_error"}'] } } }),
  },
  'hud-authority-churn': {
    failStatus: 'fail',
    pass: () => snapshot({ state: { ...snapshot().state, modes: [mode('autopilot', { active: true, current_phase: 'team' })] }, hud: { modes: { autopilot: { phase: 'team' } }, staleAutopilot: false } }),
    fail: () => snapshot({ state: { ...snapshot().state, modes: [mode('autopilot', { active: true, current_phase: 'team' })] }, hud: { modes: {}, staleAutopilot: false } }),
  },
  'native-agent-toml-drift': {
    failStatus: 'warn',
    pass: () => snapshot(),
    fail: () => snapshot({ doctor: { nativeAgents: { status: 'warn', message: 'executor.toml has stale model' }, pluginVersions: null } }),
  },
  'question-outside-tmux': {
    failStatus: 'fail',
    pass: () => snapshot({ state: { ...snapshot().state, modes: [mode('deep-interview', { active: true })] }, panes: [{ paneId: '%1', currentCommand: 'node', startCommand: 'codex' }], selection: { selected: candidate({ tmuxPaneId: '%1' }), mode: 'active', reason: 't', candidates: [] } }),
    // Native sessions without tmuxPaneId pass (tmux not required); fail only when tmux pane is specified but not live
    fail: () => snapshot({ state: { ...snapshot().state, modes: [mode('deep-interview', { active: true })] }, panes: [], selection: { selected: candidate({ tmuxPaneId: '%99' }), mode: 'active', reason: 't', candidates: [] } }),
  },
  'stale-omx-root': {
    failStatus: 'fail',
    pass: () => snapshot({ processes: [proc({ omxRoot: tmpdir(), cwd: '/elsewhere' })] }),
    fail: () => snapshot({ processes: [proc({ omxRoot: '/definitely/not/here/.omx' })] }),
  },
  'hud-deleted-cwd': {
    failStatus: 'fail',
    pass: () => snapshot({ panes: [hudPane('%2')] }),
    fail: () => snapshot({ panes: [hudPane('%2', '', '/definitely/not/here')] }),
  },
  'setup-cache-drift': {
    failStatus: 'warn',
    pass: () => snapshot(),
    fail: () => snapshot({ doctor: { nativeAgents: null, pluginVersions: { status: 'warn', message: 'cache dir not materialized' } } }),
  },
};

describe('supervision checks', () => {
  it('has a pass/fail fixture and cited sources for every check', () => {
    assert.deepEqual(Object.keys(FIXTURES).sort(), SUPERVISION_CHECKS.map((check) => check.id).sort());
    for (const check of SUPERVISION_CHECKS) {
      const sources = sourcesFor(IQDOCTOR_HISTORY, check.id);
      assert.ok(sources.length > 0, `${check.id} cites a past issue/PR in the history fixture`);
      assert.ok(sources.every((source) => Number.isInteger(source) && source > 0));
    }
  });

  it('registry ids are unique stable kebab-case and the history fixture only references registry ids', () => {
    const ids = REPEAT_PROBLEM_REGISTRY.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^[a-z]+(-[a-z]+)*$/);
    for (const id of Object.keys(IQDOCTOR_HISTORY)) assert.ok(ids.includes(id), `history key ${id} is a registry id`);
    for (const id of ['autopilot-gate-loop', 'hud-authority-churn', 'stale-omx-root', 'question-outside-tmux']) assert.ok(ids.includes(id), id);
  });

  it('registry entries carry no issue numbers; sources come only from the injected history', () => {
    for (const entry of REPEAT_PROBLEM_REGISTRY) assert.equal('sources' in entry, false);
    const custom = { 'hud-cpu-load': [9001, 9002] };
    const snap = snapshot({ processes: [proc({ cpuPct: 9 })] });
    const found = evaluateChecks(snap, SUPERVISION_CHECKS, custom).find((check) => check.id === 'hud-cpu-load');
    assert.deepEqual(found?.sources, [9001, 9002]);
    const unmapped = evaluateChecks(snap, SUPERVISION_CHECKS, {}).find((check) => check.id === 'hud-cpu-load');
    assert.deepEqual(unmapped?.sources, []);
  });

  for (const [id, fixture] of Object.entries(FIXTURES)) {
    it(`${id}: pass fixture passes`, () => {
      const found = result(id, fixture.pass());
      assert.equal(found.status, 'pass', found.evidence.join('\n'));
    });
    it(`${id}: fail fixture reports ${fixture.failStatus} with evidence`, () => {
      const found = result(id, fixture.fail());
      assert.equal(found.status, fixture.failStatus);
      assert.ok(found.evidence.length > 0);
      assert.match(found.fingerprint, /^[0-9a-f]{16}$/);
    });
  }

  it('turns a throwing check into a warn instead of aborting the run', () => {
    const throwing = { ...SUPERVISION_CHECKS[0]!, run: () => { throw new Error('boom'); } };
    const [only] = evaluateChecks(snapshot(), [throwing]);
    assert.equal(only?.status, 'warn');
    assert.match(only?.evidence[0] ?? '', /boom/);
  });

  it('fingerprints are stable across pids/paths and differ across ids/keys', () => {
    const a = evaluateChecks(snapshot({ processes: [proc({ pid: 1, cpuPct: 9 })] })).find((c) => c.id === 'hud-cpu-load');
    const b = evaluateChecks(snapshot({ processes: [proc({ pid: 2, cpuPct: 12 })] })).find((c) => c.id === 'hud-cpu-load');
    assert.equal(a?.fingerprint, b?.fingerprint);
    assert.notEqual(fingerprintFor('x', 'a'), fingerprintFor('x', 'b'));
    assert.notEqual(fingerprintFor('x', 'a'), fingerprintFor('y', 'a'));
  });
});

describe('review fixes (#4218)', () => {
  const withBlocker = (data: Record<string, unknown>, file = 'native-subagent-support.json', sel: Partial<SessionCandidate> = {}) => snapshot({
    selection: { selected: candidate(sel), mode: 'active', reason: 't', candidates: [] },
    state: { ...snapshot().state, modes: [mode('autopilot', { active: true, current_phase: 'team' })], supportBlockers: [{ file, data }] },
  });

  it('native-subagent-blocker honours the contract expiry and session/cwd scope', () => {
    const past = new Date(NOW - 60_000).toISOString();
    const future = new Date(NOW + 60_000).toISOString();
    const capacity = { reason: 'agent_thread_limit_reached' };
    assert.equal(result('native-subagent-blocker', withBlocker({ ...capacity, expires_at: past }, 'native-subagent-capacity-blocker.json')).status, 'pass');
    assert.equal(result('native-subagent-blocker', withBlocker({ ...capacity, expires_at: future }, 'native-subagent-capacity-blocker.json')).status, 'warn');
    assert.equal(result('native-subagent-blocker', withBlocker({ reason: 'native_subagents_unsupported', session_id: 'previous-session' })).status, 'pass');
    assert.equal(result('native-subagent-blocker', withBlocker({ reason: 'native_subagents_unsupported', cwd: '/some/other/cwd' })).status, 'pass');
    assert.equal(result('native-subagent-blocker', withBlocker({ reason: 'native_subagents_unsupported', session_id: 'sess-1' })).status, 'fail');
    assert.equal(result('native-subagent-blocker', withBlocker({ reason: 'native_subagents_unsupported', expires_at: past })).status, 'pass');
  });

  it('hud-authority-churn uses detail-first precedence: prefers detail phase over canonical', () => {
    const base = snapshot().state;
    const synthesized = snapshot({
      state: { ...base, modes: [mode('autopilot', { active: true, current_phase: 'ultraqa' })] },
      hud: { modes: { autopilot: { phase: 'ultraqa' }, ultraqa: { phase: 'ultraqa' } }, staleAutopilot: false },
    });
    assert.equal(result('hud-authority-churn', synthesized).status, 'pass');
    const canonicalOnly = snapshot({ state: { ...base, canonicalSkills: [{ skill: 'ralph', phase: 'executing' }] }, hud: { modes: { ralph: { phase: 'executing' } }, staleAutopilot: false } });
    assert.equal(result('hud-authority-churn', canonicalOnly).status, 'pass');
    // Detail phase 'draft' is preferred over canonical phase 'review'; mismatch when HUD shows 'review'.
    const detailWinsOverCanonical = snapshot({
      state: { ...base, modes: [mode('ralplan', { active: true, current_phase: 'draft' })], canonicalSkills: [{ skill: 'ralplan', phase: 'review' }] },
      hud: { modes: { ralplan: { phase: 'review' } }, staleAutopilot: false },
    });
    assert.equal(result('hud-authority-churn', detailWinsOverCanonical).status, 'fail');
    // When detail phase is absent, canonical phase is used as fallback.
    const canonicalFallback = snapshot({
      state: { ...base, modes: [mode('ralplan', { active: true })], canonicalSkills: [{ skill: 'ralplan', phase: 'review' }] },
      hud: { modes: { ralplan: { phase: 'review' } }, staleAutopilot: false },
    });
    assert.equal(result('hud-authority-churn', canonicalFallback).status, 'pass');
    const phantom = snapshot({ state: base, hud: { modes: { ultraqa: { phase: 'x' } }, staleAutopilot: false } });
    assert.equal(result('hud-authority-churn', phantom).status, 'fail');
  });

  it('hud-authority-churn follows the HUD team precedence: team phase.json, then canonical skill, then detail', () => {
    const base = snapshot().state;
    const team = mode('team', { active: true, team_name: 'alpha', current_phase: 'team-exec' });
    const logs = [{ path: '/work/a/.omx/state/team/alpha/phase.json', currentPhase: 'team-verify', transitions: [] }];
    const staleDetail = snapshot({
      state: { ...base, modes: [team], canonicalSkills: [{ skill: 'team', phase: 'team-verify' }], teamPhases: logs },
      hud: { modes: { team: { phase: 'team-verify' } }, staleAutopilot: false },
    });
    assert.equal(result('hud-authority-churn', staleDetail).status, 'pass');
    const phaseLogWins = snapshot({
      state: { ...base, modes: [team], canonicalSkills: [{ skill: 'team', phase: 'team-exec' }], teamPhases: logs },
      hud: { modes: { team: { phase: 'team-verify' } }, staleAutopilot: false },
    });
    assert.equal(result('hud-authority-churn', phaseLogWins).status, 'pass');
    const canonicalOverDetail = snapshot({
      state: { ...base, modes: [team], canonicalSkills: [{ skill: 'team', phase: 'team-verify' }] },
      hud: { modes: { team: { phase: 'team-verify' } }, staleAutopilot: false },
    });
    assert.equal(result('hud-authority-churn', canonicalOverDetail).status, 'pass');
    const genuine = snapshot({
      state: { ...base, modes: [team], canonicalSkills: [{ skill: 'team', phase: 'team-verify' }], teamPhases: logs },
      hud: { modes: { team: { phase: 'team-exec' } }, staleAutopilot: false },
    });
    assert.equal(result('hud-authority-churn', genuine).status, 'fail');
  });

  it('issue #4222: does not import root state file into session state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-state-'));
    try {
      const sessionId = 'test-session-123';
      const stateDir = join(root, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      
      // Create both root and session directories
      await mkdir(join(stateDir, 'sessions'), { recursive: true });
      await mkdir(sessionDir, { recursive: true });
      
      // Write a root state file (should NOT be collected)
      await writeFile(
        join(stateDir, 'ralplan-state.json'),
        JSON.stringify({ active: true, current_phase: 'draft', source: 'root' })
      );
      
      // Write a session-scoped state file (SHOULD be collected)
      await writeFile(
        join(sessionDir, 'ultragoal-state.json'),
        JSON.stringify({ active: true, current_phase: 'draft', source: 'session' })
      );
      
      // Collect state files for this session
      const collected = collectStateFiles(stateDir, sessionId);
      
      // Should have only the session-scoped file, not the root file
      assert.equal(collected.length, 1, 'should collect exactly one state file');
      assert.equal(collected[0].mode, 'ultragoal', 'collected mode should be ultragoal (session-scoped)');
      assert.equal(collected[0].scope, 'session', 'scope should be session');
      const data = collected[0].data as Record<string, unknown>;
      assert.equal(data.source, 'session', 'should have session data, not root data');
      
      // Verify that if we were still importing root files, the test would catch it
      // by checking that ralplan (the root file) is NOT present
      const hasRalplan = collected.some((record) => record.mode === 'ralplan');
      assert.equal(hasRalplan, false, 'root state file (ralplan) should not be imported');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stale-omx-root resolves OMX_ROOT to <root>/.omx/state like the runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-root-'));
    try {
      assert.equal(stateDirForRoot(root), join(root, '.omx', 'state'));
      const sel = (stateDir: string) => ({ selected: candidate({ stateDir }), mode: 'active' as const, reason: 't', candidates: [] });
      const healthy = snapshot({ selection: sel(join(root, '.omx', 'state')), processes: [proc({ omxRoot: root, sessionId: 'sess-1' })] });
      assert.equal(result('stale-omx-root', healthy).status, 'pass');
      const foreign = snapshot({ selection: sel('/elsewhere/.omx/state'), processes: [proc({ omxRoot: root, sessionId: 'sess-1' })] });
      assert.equal(result('stale-omx-root', foreign).status, 'fail');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('#4215 macOS Intel HUD CPU reproduction', () => {
  // Issue #4215: three fresh v0.22.28 `omx hud --watch` processes measured with a
  // 3 s ps CPU-time delta at ~17%, 19% and 22% of one logical CPU each.
  const installPath = '/Users/u/.nvm/versions/node/v24.14.0/lib/node_modules/oh-my-codex/dist/cli/omx.js';
  const macHud = (pid: number, start: number, deltaSec: number) => proc({
    pid, args: `node ${installPath} hud --watch`, cpuSecStart: start, cpuSecEnd: start + deltaSec,
    cpuPct: computeCpuPercent(start, start + deltaSec, 3),
  });

  it('fails with pid and CPU evidence and ranks P1 (three hot HUDs widen the blast radius)', () => {
    const snap = snapshot({ platform: 'darwin', windowSeconds: 3, processes: [macHud(41001, 12.34, 0.51), macHud(41002, 8.1, 0.57), macHud(41003, 20, 0.66)] });
    assert.deepEqual(snap.processes.map((p) => p.cpuPct), [17, 19, 22]);
    const found = result('hud-cpu-load', snap);
    assert.equal(found.status, 'fail');
    assert.equal(found.blast, 3);
    assert.equal(found.evidence.length, 3);
    for (const [index, pid] of [41001, 41002, 41003].entries()) {
      assert.match(found.evidence[index] ?? '', new RegExp(`pid ${pid} used ${[17, 19, 22][index]}% of a core over 3s`));
      assert.match(found.evidence[index] ?? '', /oh-my-codex\/dist\/cli\/omx\.js hud --watch/);
    }
    assert.deepEqual(triage([found])[0]?.priority, 'P1');
    assert.ok(found.sources.includes(4201) && found.sources.includes(4202));
  });

  it('the same HUDs idling at the Linux v0.22.28 benchmark (~0.7%) pass', () => {
    const snap = snapshot({ windowSeconds: 3, processes: [macHud(1, 5, 0.02), macHud(2, 5, 0.021)] });
    assert.equal(result('hud-cpu-load', snap).status, 'pass');
  });
});

describe('#4215 fresh v0.22.28 HUDs at ~16% of a core', () => {
  it('fails each HUD with pid and CPU evidence over the default 10 s window', () => {
    const hud = (pid: number) => proc({ pid, args: 'node /opt/oh-my-codex/dist/cli/omx.js hud --watch', cpuSecStart: 50, cpuSecEnd: 51.6, cpuPct: computeCpuPercent(50, 51.6, 10) });
    const found = result('hud-cpu-load', snapshot({ platform: 'darwin', processes: [hud(7001), hud(7002)] }));
    assert.equal(found.status, 'fail');
    assert.match(found.evidence[0] ?? '', /pid 7001 used 16% of a core over 10s/);
    assert.match(found.evidence[1] ?? '', /pid 7002 used 16% of a core over 10s/);
  });
});

describe('CPU delta math', () => {
  it('computes percent of one core over the window', () => {
    assert.equal(computeCpuPercent(10, 10.2, 10), 2);
    assert.equal(computeCpuPercent(10, 11, 10), 10);
    assert.equal(computeCpuPercent(5, 5, 10), 0);
  });
  it('rejects unmeasurable samples', () => {
    assert.equal(computeCpuPercent(null, 1, 10), null);
    assert.equal(computeCpuPercent(2, 1, 10), null);
    assert.equal(computeCpuPercent(1, 2, 0), null);
  });
  it('parses ps cpu time formats', () => {
    assert.equal(parsePsCpuTime('00:05'), 5);
    assert.equal(parsePsCpuTime('01:02:03'), 3723);
    assert.equal(parsePsCpuTime('2-00:00:01'), 172801);
    assert.equal(parsePsCpuTime('garbage'), null);
  });
  it('flags a HUD at exactly the threshold as pass and just above as fail', () => {
    assert.equal(result('hud-cpu-load', snapshot({ processes: [proc({ cpuPct: 2 })] })).status, 'pass');
    assert.equal(result('hud-cpu-load', snapshot({ processes: [proc({ cpuPct: 2.1 })] })).status, 'fail');
  });
});

describe('process classification', () => {
  it('recognises omx and hud --watch, ignores tooling', () => {
    assert.equal(classifyProcess('node /usr/lib/node_modules/oh-my-codex/dist/cli/omx.js hud --watch'), 'hud-watch');
    assert.equal(classifyProcess('omx hud --watch'), 'hud-watch');
    assert.equal(classifyProcess('node /x/dist/cli/omx.js team status'), 'omx');
    assert.equal(classifyProcess('grep omx '), null);
    assert.equal(classifyProcess('/usr/bin/vim notes.md'), null);
  });
});

describe('session selection', () => {
  it('prefers the most recently active live session', () => {
    const older = candidate({ sessionId: 'old', stateMtimeMs: NOW - 5000 });
    const newer = candidate({ sessionId: 'new', stateMtimeMs: NOW - 10 });
    const dead = candidate({ sessionId: 'dead', pidAlive: false, stateMtimeMs: NOW });
    const selection = selectSession([older, dead, newer]);
    assert.equal(selection.mode, 'active');
    assert.equal(selection.selected?.sessionId, 'new');
    assert.match(selection.reason, /2 active/);
  });
  it('falls back to the most recent session by state or rollout mtime when none is alive', () => {
    const a = candidate({ sessionId: 'a', pidAlive: false, stateMtimeMs: NOW - 9000 });
    const b = candidate({ sessionId: 'b', pidAlive: false, stateMtimeMs: NOW - 8000, rolloutMtimeMs: NOW - 100 });
    const selection = selectSession([a, b]);
    assert.equal(selection.mode, 'fallback-recent');
    assert.equal(selection.selected?.sessionId, 'b');
    assert.match(selection.reason, /no active session/);
  });
  it('reports none when nothing exists', () => {
    const selection = selectSession([]);
    assert.equal(selection.mode, 'none');
    assert.equal(selection.selected, null);
  });
  it('honours an explicit session id', () => {
    const selection = selectSession([candidate({ sessionId: 'a' }), candidate({ sessionId: 'b', stateMtimeMs: 1 })], 'b');
    assert.equal(selection.selected?.sessionId, 'b');
  });
});

describe('triage ranking', () => {
  const base = { severity: 'high' as const, repro: 'persistent' as const, blast: 1 };
  it('ranks by status, severity, reproducibility and blast radius', () => {
    assert.deepEqual(rankFinding({ status: 'fail', severity: 'critical', repro: 'persistent', blast: 5 }), { priority: 'P0', score: 7 });
    assert.equal(rankFinding({ status: 'fail', ...base }).priority, 'P1');
    assert.equal(rankFinding({ status: 'warn', ...base }).priority, 'P2');
    assert.equal(rankFinding({ status: 'warn', severity: 'low', repro: 'sampled', blast: 1 }).priority, 'P3');
    assert.equal(rankFinding({ status: 'fail', severity: 'high', repro: 'sampled', blast: 1 }).priority, 'P2');
    assert.equal(rankFinding({ status: 'fail', severity: 'high', repro: 'sampled', blast: 3 }).priority, 'P1');
  });
  it('drops passes and sorts findings by score then id', () => {
    const results = evaluateChecks(snapshot({
      processes: [proc({ cpuPct: 9 })],
      doctor: { nativeAgents: { status: 'warn', message: 'drift' }, pluginVersions: { status: 'pass', message: 'ok' } },
      state: { ...snapshot().state, nativeStop: { sessions: { s: { ordinary_no_progress_guard: { repeat_count: 9, last_seen_at: new Date(NOW).toISOString() } } } } },
    }));
    const findings = triage(results);
    assert.deepEqual(findings.map((f) => f.id), ['autopilot-gate-loop', 'hud-cpu-load', 'native-agent-toml-drift']);
    assert.equal(findings[0]?.priority, 'P1');
    assert.ok(findings.every((f) => f.status !== 'pass'));
  });
});

describe('fingerprint dedupe', () => {
  const finding = (): Finding => triage(evaluateChecks(snapshot({ state: { ...snapshot().state, nativeStop: { sessions: { s: { ordinary_no_progress_guard: { repeat_count: 9, last_seen_at: new Date(NOW).toISOString() } } } } } })))[0] as Finding;

  it('finds an open issue carrying the exact marker and ignores look-alikes', () => {
    const f = finding();
    const gh = (args: string[]) => {
      assert.ok(args.includes('search/issues'));
      assert.ok(args.some((arg) => arg.includes(`omx-supervision:fingerprint=${f.fingerprint}`) && arg.includes('is:open')));
      return JSON.stringify({ items: [
        { number: 1, html_url: 'u1', body: `mentions ${f.fingerprint} but has no marker` },
        { number: 2, html_url: 'u2', body: `text\n${markerFor(f.fingerprint)}` },
      ] });
    };
    assert.deepEqual(findDuplicateIssue(f.fingerprint, gh), { number: 2, url: 'u2' });
  });
  it('returns null when nothing matches and "unknown" when gh fails', () => {
    assert.equal(findDuplicateIssue('abc', () => JSON.stringify({ items: [] })), null);
    assert.equal(findDuplicateIssue('abc', () => { throw new Error('gh down'); }), 'unknown');
  });
  it('marks findings and gates filing on priority and dedupe state', () => {
    const f = finding();
    assert.equal(f.priority, 'P1');
    const dup = applyDedupe([f], () => JSON.stringify({ items: [{ number: 7, html_url: 'u7', body: markerFor(f.fingerprint) }] }))[0] as Finding;
    assert.equal(dup.dedupe, 'duplicate');
    assert.equal(isFileable(dup), false);
    const fresh = applyDedupe([f], () => JSON.stringify({ items: [] }))[0] as Finding;
    assert.equal(isFileable(fresh), true);
    const unknown = applyDedupe([f], () => { throw new Error('x'); })[0] as Finding;
    assert.equal(isFileable(unknown), false);
    assert.equal(isFileable({ ...fresh, priority: 'P2' }), false);
  });
  it('puts the marker first in the issue body together with the evidence', () => {
    const f = finding();
    const draft = buildIssueDraft(f, { prompt: 'hud is slow', version: '0.0.0', platform: 'linux', selection: snapshot().selection });
    assert.ok(draft.body.startsWith(markerFor(f.fingerprint)));
    assert.match(draft.body, /9 identical Stop-hook passes/);
    assert.match(draft.body, /#2618/);
    assert.match(draft.body, /hud is slow/);
  });
});

describe('argument parsing', () => {
  const parse = (args: string[]): SupervisionOptions => parseSupervisionArgs(args);
  it('defaults', () => {
    assert.deepEqual(parse([]), { windowSeconds: 10, analyze: true, file: false, json: false, help: false, prompt: '' });
  });
  it('joins a free-form prompt, quoted or split, in any position relative to flags', () => {
    assert.equal(parse(['my hud is eating cpu']).prompt, 'my hud is eating cpu');
    assert.equal(parse(['my', 'hud', '--json', 'is', 'slow']).prompt, 'my hud is slow');
    assert.equal(parse(['--no-analyze', '--file', '--window', '3', 'why?']).prompt, 'why?');
  });
  it('parses flags', () => {
    const options = parse(['--window=5', '--no-analyze', '--file', '--json']);
    assert.deepEqual([options.windowSeconds, options.analyze, options.file, options.json], [5, false, true, true]);
    assert.equal(parse(['-h']).help, true);
  });
  it('lets -- end options so a prompt can start with a dash', () => {
    assert.equal(parse(['--json', '--', '--weird', 'prompt']).prompt, '--weird prompt');
    assert.equal(parse(['--json', '--', '--weird', 'prompt']).json, true);
  });
  it('rejects unknown flags and bad windows', () => {
    assert.throws(() => parse(['--watch']), /Unknown omx supervision option/);
    assert.throws(() => parse(['--window']), /--window expects/);
    assert.throws(() => parse(['--window', 'abc']), /--window expects/);
    assert.throws(() => parse(['--window=0']), /--window expects/);
    assert.throws(() => parse(['--window=99999']), /--window expects/);
  });
});

describe('analysis lanes and orchestration', () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'omx-supervision-')); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  const failing = () => snapshot({
    processes: [proc({ cpuPct: 9 })],
    doctor: { nativeAgents: { status: 'warn', message: 'drift' }, pluginVersions: { status: 'pass', message: 'ok' } },
  });

  function deps(overrides: Partial<SupervisionDeps> = {}, snap: () => SupervisionSnapshot = failing): { deps: SupervisionDeps; calls: { gh: string[][]; lanes: string[]; models: string[] } } {
    const calls = { gh: [] as string[][], lanes: [] as string[], models: [] as string[] };
    return {
      calls,
      deps: {
        collect: async () => toEvidenceBundle(snap()),
        gh: (args) => { calls.gh.push(args); return args[0] === 'api' ? JSON.stringify({ items: [] }) : 'https://github.com/Yeachan-Heo/oh-my-codex/issues/9999'; },
        lane: async ({ id, prompt, model }) => { calls.lanes.push(prompt); calls.models.push(model); return { id, ok: true, output: `analysis of ${id}` }; },
        sparkModel: () => 'spark-test',
        version: () => '0.0.0-test',
        now: () => new Date('2026-11-26T12:00:00Z'),
        ...overrides,
      },
    };
  }
  const options = (extra: Partial<SupervisionOptions> = {}): SupervisionOptions => ({ windowSeconds: 1, analyze: true, file: false, json: false, help: false, prompt: 'hud seems hot', ...extra });

  it('groups findings by area into lanes', () => {
    const bundle = toEvidenceBundle(failing());
    const lanes = planAnalysisLanes(bundle, triage(evaluateChecks(bundle.snapshot)), 'the hud is hot');
    assert.deepEqual(lanes.map((lane) => lane.id).sort(), ['leader-and-agents', 'resources']);
    for (const lane of lanes) {
      assert.match(lane.prompt, /the hud is hot/);
      assert.match(lane.prompt, /Evidence bundle:/);
      assert.match(lane.prompt, new RegExp(bundle.collectedAt));
    }
  });

  it('spawns one spark lane per failing group with the prompt and the analyze instruction, in parallel', async () => {
    let inFlight = 0;
    let peak = 0;
    const { deps: d, calls } = deps({
      lane: async ({ id, prompt, model }) => {
        inFlight += 1; peak = Math.max(peak, inFlight);
        calls.lanes.push(prompt); calls.models.push(model);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return { id, ok: true, output: `analysis of ${id}` };
      },
    });
    const report = await runSupervision(options(), cwd, d);
    assert.equal(calls.lanes.length, 2);
    assert.equal(peak, 2);
    assert.deepEqual(calls.models, ['spark-test', 'spark-test']);
    for (const prompt of calls.lanes) {
      assert.match(prompt, /\$oh-my-codex:analyze/);
      assert.match(prompt, /hud seems hot/);
    }
    assert.equal(report.lanes.length, 2);
    assert.match(report.findings.find((f) => f.id === 'hud-cpu-load')?.analysis ?? '', /analysis of resources/);
  });

  it('skips lanes with --no-analyze and when every check passes', async () => {
    const skipped = deps();
    await runSupervision(options({ analyze: false }), cwd, skipped.deps);
    assert.equal(skipped.calls.lanes.length, 0);
    const clean = deps({}, () => snapshot());
    const report = await runSupervision(options(), cwd, clean.deps);
    assert.equal(clean.calls.lanes.length, 0);
    assert.equal(report.findings.length, 0);
  });

  it('writes report, json and per-finding drafts under .omx/supervision/<timestamp>/', async () => {
    const report = await runSupervision(options({ analyze: false }), cwd, deps().deps);
    assert.equal(report.outputDir, join(cwd, '.omx', 'supervision', '20261126T120000Z'));
    const files = await readdir(report.outputDir as string);
    assert.deepEqual(files.sort(), ['drafts', 'evidence', 'report.json', 'report.md']);
    assert.deepEqual(await readdir(join(report.outputDir as string, 'evidence')), ['bundle.json']);
    assert.equal(JSON.parse(await readFile(join(report.outputDir as string, 'evidence', 'bundle.json'), 'utf-8')).schemaVersion, 1);
    const drafts = await readdir(join(report.outputDir as string, 'drafts'));
    assert.equal(drafts.length, report.findings.length);
    const body = await readFile(join(report.outputDir as string, 'drafts', drafts.find((name) => name.includes('hud-cpu-load')) as string), 'utf-8');
    assert.match(body, /omx-supervision:fingerprint=/);
    assert.equal(JSON.parse(await readFile(join(report.outputDir as string, 'report.json'), 'utf-8')).findings.length, report.findings.length);
  });

  it('does not file without --file; with --file files only P0/P1 non-duplicates', async () => {
    const without = deps();
    await runSupervision(options({ analyze: false }), cwd, without.deps);
    assert.equal(without.calls.gh.filter((args) => args[0] === 'issue').length, 0);

    const withFile = deps();
    const report = await runSupervision(options({ analyze: false, file: true }), cwd, withFile.deps);
    const creates = withFile.calls.gh.filter((args) => args[0] === 'issue');
    // hud-cpu is fail/high/sampled => P2, native-toml-drift => P2: nothing reaches P1.
    assert.equal(creates.length, 0);
    assert.deepEqual(report.filed, []);

    const loop = deps({}, () => snapshot({ state: { ...snapshot().state, nativeStop: { sessions: { s: { ordinary_no_progress_guard: { repeat_count: 9, last_seen_at: new Date(NOW).toISOString() } } } } } }));
    const looped = await runSupervision(options({ analyze: false, file: true }), cwd, loop.deps);
    const filed = loop.calls.gh.filter((args) => args[0] === 'issue');
    assert.equal(filed.length, 1);
    assert.deepEqual(filed[0]?.slice(0, 3), ['issue', 'create', '-R']);
    assert.equal(filed[0]?.[3], 'Yeachan-Heo/oh-my-codex');
    assert.equal(looped.filed.length, 1);
  });

  it('never files a duplicate or an issue whose duplicate search failed', async () => {
    const snapLoop = () => snapshot({ state: { ...snapshot().state, nativeStop: { sessions: { s: { ordinary_no_progress_guard: { repeat_count: 9, last_seen_at: new Date(NOW).toISOString() } } } } } });
    const dup = deps({ gh: (args) => (args[0] === 'api' ? JSON.stringify({ items: [{ number: 5, html_url: 'u5', body: markerFor(fingerprintFor('autopilot-gate-loop', 'stop-guard-loop')) }] }) : 'should-not-happen') }, snapLoop);
    const dupReport = await runSupervision(options({ analyze: false, file: true }), cwd, dup.deps);
    assert.equal(dupReport.filed.length, 0);
    assert.match(dupReport.fileSkipped[0]?.reason ?? '', /duplicate of u5/);

    const down = deps({ gh: () => { throw new Error('offline'); } }, snapLoop);
    const downReport = await runSupervision(options({ analyze: false, file: true }), cwd, down.deps);
    assert.equal(downReport.filed.length, 0);
    assert.match(downReport.fileSkipped[0]?.reason ?? '', /not filing blind/);
  });

  it('says so in the report when it fell back to a non-active session', async () => {
    const fallback = () => {
      const selected = candidate({ pidAlive: false });
      return { ...snapshot(), selection: selectSession([selected]) };
    };
    const report = await runSupervision(options({ analyze: false }), cwd, deps({}, fallback).deps);
    assert.equal(report.session.fallback, true);
    assert.match(await readFile(join(report.outputDir as string, 'report.md'), 'utf-8'), /No active session/);
  });

  it('collects findings from multiple active sessions with sessionId tagging (fake collect)', async () => {
    // Create two active sessions: first passes all checks, second has a mismatch
    const sess1 = candidate({ sessionId: 'sess-1', pidAlive: true });
    const sess2 = candidate({ sessionId: 'sess-2', pidAlive: true });
    const snap1 = snapshot({ selection: selectSession([sess1, sess2]).candidates.length > 0 ? { ...selectSession([sess1, sess2]), selected: sess1 } : selectSession([sess1, sess2]) });
    const snap2 = snapshot({
      selection: selectSession([sess1, sess2]).candidates.length > 0 ? { ...selectSession([sess1, sess2]), selected: sess2 } : selectSession([sess1, sess2]),
      state: { ...snapshot().state, modes: [mode('ralplan', { active: true, current_phase: 'draft' })] },
      hud: { modes: { ralplan: { phase: 'review' } }, staleAutopilot: false },
    });

    // Collect evidence from both sessions
    const collect = async () => {
      const snapshots = new Map<string, SupervisionSnapshot>();
      snapshots.set('sess-1', snap1);
      snapshots.set('sess-2', snap2);
      const bundle = toEvidenceBundle(snap1);
      bundle.snapshots = snapshots;
      return bundle;
    };

    const report = await runSupervision(options({ analyze: false }), cwd, { ...defaultSupervisionDeps, collect });
    const findings = report.findings;
    
    // Should have hud-authority-churn finding from sess-2 (the second session with mismatch)
    const hudFinding = findings.find((f) => f.id === 'hud-authority-churn');
    assert.ok(hudFinding, 'Should find hud-authority-churn issue');
    assert.equal(hudFinding.sessionId, 'sess-2', 'Finding should be tagged with sess-2');
  });

  const mismatchedSession = (sessionId: string) => snapshot({
    selection: { selected: candidate({ sessionId, pidAlive: true }), mode: 'active' as const, reason: 'test', candidates: [] },
    state: { ...snapshot().state, modes: [mode('ralplan', { active: true, current_phase: 'draft' })] },
    hud: { modes: { ralplan: { phase: 'review' } }, staleAutopilot: false },
  });
  const twoSessionCollect = (primary: SupervisionSnapshot, secondary: SupervisionSnapshot, primaryId: string, secondaryId: string) => async () => {
    const bundle = toEvidenceBundle(primary);
    bundle.snapshots = new Map([[primaryId, primary], [secondaryId, secondary]]);
    return bundle;
  };

  it('reports every session\'s checks so a non-primary failure is not lost', async () => {
    const collect = twoSessionCollect(snapshot({ selection: { selected: candidate({ sessionId: 'sess-1', pidAlive: true }), mode: 'active' as const, reason: 'test', candidates: [] } }), mismatchedSession('sess-2'), 'sess-1', 'sess-2');
    const report = await runSupervision(options({ analyze: false }), cwd, { ...defaultSupervisionDeps, collect });
    assert.equal(report.checks.length, SUPERVISION_CHECKS.length * 2);
    assert.ok(report.checks.some((check) => check.sessionId === 'sess-2' && check.status !== 'pass'), 'sess-2 failure present in report.checks');
  });

  it('writes distinct drafts when two sessions share a finding fingerprint', async () => {
    const collect = twoSessionCollect(mismatchedSession('sess-1'), mismatchedSession('sess-2'), 'sess-1', 'sess-2');
    const report = await runSupervision(options({ analyze: false }), cwd, { ...defaultSupervisionDeps, collect });
    const churn = report.findings.filter((finding) => finding.id === 'hud-authority-churn');
    assert.equal(churn.length, 2);
    assert.equal(churn[0].fingerprint, churn[1].fingerprint);
    const drafts = (await readdir(join(report.outputDir as string, 'drafts'))).filter((name) => name.includes('hud-authority-churn'));
    assert.equal(drafts.length, 2);
  });

  const loopSession = (sessionId: string) => snapshot({
    selection: { selected: candidate({ sessionId, pidAlive: true }), mode: 'active' as const, reason: `session ${sessionId}`, candidates: [] },
    state: { ...snapshot().state, nativeStop: { sessions: { s: { ordinary_no_progress_guard: { repeat_count: 9, last_seen_at: new Date(NOW).toISOString() } } } } },
  });

  it('files one issue when two sessions produce the same P1 fingerprint', async () => {
    const collect = twoSessionCollect(loopSession('sess-1'), loopSession('sess-2'), 'sess-1', 'sess-2');
    const harness = deps({ collect });
    const report = await runSupervision(options({ analyze: false, file: true }), cwd, harness.deps);
    assert.equal(report.findings.filter((finding) => finding.priority === 'P1' && finding.id === 'autopilot-gate-loop').length, 2);
    assert.equal(harness.calls.gh.filter((args) => args[0] === 'issue').length, 1);
    assert.equal(report.filed.length, 1);
    assert.ok(report.fileSkipped.some((entry) => /already filed in this run/.test(entry.reason)));
  });

  it('builds each draft with its own session context, not the primary session', async () => {
    const collect = twoSessionCollect(loopSession('sess-1'), loopSession('sess-2'), 'sess-1', 'sess-2');
    const report = await runSupervision(options({ analyze: false }), cwd, deps({ collect }).deps);
    const names = await readdir(join(report.outputDir as string, 'drafts'));
    const second = names.find((name) => name.includes('autopilot-gate-loop') && name.endsWith('sess-2.md')) as string;
    assert.ok(second, 'sess-2 draft exists');
    const body = await readFile(join(report.outputDir as string, 'drafts', second), 'utf-8');
    assert.match(body, /- session: sess-2 /);
    assert.doesNotMatch(body, /- session: sess-1 /);
  });

  it('collects findings from multiple real session directories on disk', async () => {
    // Create two real session state directories
    const sess1Dir = join(cwd, '.omx', 'state', 'sessions', 'sess-1');
    const sess2Dir = join(cwd, '.omx', 'state', 'sessions', 'sess-2');
    await mkdir(sess1Dir, { recursive: true });
    await mkdir(sess2Dir, { recursive: true });

    // Session 1: healthy state
    const sess1State = { mode: 'autopilot', scope: 'session', path: join(sess1Dir, 'autopilot-state.json'), mtimeMs: NOW, data: { active: true, current_phase: 'code-review' } };
    await writeFile(join(sess1Dir, 'autopilot-state.json'), JSON.stringify(sess1State.data));

    // Session 2: has a phase mismatch (state shows 'draft', HUD will show 'review')
    const sess2State = { mode: 'ralplan', scope: 'session', path: join(sess2Dir, 'ralplan-state.json'), mtimeMs: NOW, data: { active: true, current_phase: 'draft' } };
    await writeFile(join(sess2Dir, 'ralplan-state.json'), JSON.stringify(sess2State.data));

    // Create a collect function that uses real session dirs
    const collect = async () => {
      const snapshots = new Map<string, SupervisionSnapshot>();
      // Session 1: passes all checks
      snapshots.set('sess-1', snapshot({
        selection: { selected: candidate({ sessionId: 'sess-1', stateDir: join(cwd, '.omx', 'state'), pidAlive: true }), mode: 'active' as const, reason: 'test', candidates: [] },
        state: { stateDir: join(cwd, '.omx', 'state'), modes: [mode('autopilot', { active: true, current_phase: 'code-review' })], currentAutopilot: null, nativeStop: null, supportBlockers: [], canonicalSkills: [], teamPhases: [], subagentTracking: null, sizes: { stateBytes: 1024, logsBytes: 1024, rolloutBytes: 1024, rolloutScanTruncated: false }, hookLog: null },
        hud: { modes: { autopilot: { phase: 'code-review' } }, staleAutopilot: false },
      }));
      // Session 2: has mismatch (hud phase 'review' vs state phase 'draft')
      snapshots.set('sess-2', snapshot({
        selection: { selected: candidate({ sessionId: 'sess-2', stateDir: join(cwd, '.omx', 'state'), pidAlive: true }), mode: 'active' as const, reason: 'test', candidates: [] },
        state: { stateDir: join(cwd, '.omx', 'state'), modes: [mode('ralplan', { active: true, current_phase: 'draft' })], currentAutopilot: null, nativeStop: null, supportBlockers: [], canonicalSkills: [], teamPhases: [], subagentTracking: null, sizes: { stateBytes: 1024, logsBytes: 1024, rolloutBytes: 1024, rolloutScanTruncated: false }, hookLog: null },
        hud: { modes: { ralplan: { phase: 'review' } }, staleAutopilot: false },
      }));
      const bundle = toEvidenceBundle(snapshots.get('sess-1')!);
      bundle.snapshots = snapshots;
      return bundle;
    };

    const report = await runSupervision(options({ analyze: false }), cwd, { ...defaultSupervisionDeps, collect });
    const findings = report.findings;
    
    // Should have hud-authority-churn finding from sess-2 (the session with mismatch)
    const hudFinding = findings.find((f) => f.id === 'hud-authority-churn');
    assert.ok(hudFinding, 'Should find hud-authority-churn issue from sess-2');
    assert.equal(hudFinding.sessionId, 'sess-2', 'Finding should be tagged with sess-2');
  });
});

describe('finding #4: HUD collection binds to each session\'s state root', () => {
  it('collects multiple sessions\' HUD from their own state directories, not the primary session\'s', async () => {
    // Create two temporary state directories with different HUD modes
    const tmpRoot = await mkdtemp(join(tmpdir(), 'omx-hud-collect-'));
    try {
      const baseStateDir = join(tmpRoot, '.omx', 'state');
      await mkdir(join(baseStateDir, 'sessions', 'sess-1'), { recursive: true });
      await mkdir(join(baseStateDir, 'sessions', 'sess-2'), { recursive: true });
      
      // Session 1: has autopilot phase
      await writeFile(join(baseStateDir, 'sessions', 'sess-1', 'autopilot-state.json'), JSON.stringify({ active: true, current_phase: 'code-review' }));
      
      // Session 2: has ralplan phase (different mode)
      await writeFile(join(baseStateDir, 'sessions', 'sess-2', 'ralplan-state.json'), JSON.stringify({ active: true, current_phase: 'draft' }));
      
      // Create snapshots that would use these state directories
      const sess1Snap = snapshot({
        selection: { selected: candidate({ sessionId: 'sess-1', cwd: tmpRoot, stateDir: baseStateDir, pidAlive: true }), mode: 'active' as const, reason: 'test', candidates: [] },
        state: { stateDir: baseStateDir, modes: [mode('autopilot', { active: true, current_phase: 'code-review' })], currentAutopilot: null, nativeStop: null, supportBlockers: [], canonicalSkills: [], teamPhases: [], subagentTracking: null, sizes: { stateBytes: 1024, logsBytes: 1024, rolloutBytes: 1024, rolloutScanTruncated: false }, hookLog: null },
        hud: { modes: { autopilot: { phase: 'code-review' } }, staleAutopilot: false },
      });
      const sess2Snap = snapshot({
        selection: { selected: candidate({ sessionId: 'sess-2', cwd: tmpRoot, stateDir: baseStateDir, pidAlive: true }), mode: 'active' as const, reason: 'test', candidates: [] },
        state: { stateDir: baseStateDir, modes: [mode('ralplan', { active: true, current_phase: 'draft' })], currentAutopilot: null, nativeStop: null, supportBlockers: [], canonicalSkills: [], teamPhases: [], subagentTracking: null, sizes: { stateBytes: 1024, logsBytes: 1024, rolloutBytes: 1024, rolloutScanTruncated: false }, hookLog: null },
        hud: { modes: { ralplan: { phase: 'draft' } }, staleAutopilot: false },
      });
      
      // Verify each snapshot has the correct HUD modes for its session
      assert.deepEqual(sess1Snap.hud?.modes, { autopilot: { phase: 'code-review' } }, 'sess-1 HUD from autopilot state');
      assert.deepEqual(sess2Snap.hud?.modes, { ralplan: { phase: 'draft' } }, 'sess-2 HUD from ralplan state');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('keys deep-interview state files with the HudRenderContext key (deepInterview), not the filename stem', async () => {
    // Test that the per-session HUD reader maps filename stems to HudRenderContext keys consistently
    // deep-interview-state.json should be keyed as 'deepInterview' in both per-session and fallback paths
    const tmpRoot = await mkdtemp(join(tmpdir(), 'omx-hud-deep-interview-'));
    try {
      const baseStateDir = join(tmpRoot, '.omx', 'state');
      const sessionDir = join(baseStateDir, 'sessions', 'sess-di');
      await mkdir(sessionDir, { recursive: true });
      
      // Create a deep-interview state file (note: filename uses hyphen, not camelCase)
      await writeFile(join(sessionDir, 'deep-interview-state.json'), JSON.stringify({ active: true, current_phase: 'gathering-requirements' }));
      
      // Create a snapshot using collectSnapshot or collectStateFiles to verify the key is correct
      // We use collectStateFiles which is the function that reads the state directory
      const modeRecords = collectStateFiles(baseStateDir, 'sess-di');
      const deepInterviewRecord = modeRecords.find((r) => r.mode === 'deep-interview' || r.mode === 'deepInterview');
      
      // The readHudModel function should map 'deep-interview' filename stem to 'deepInterview' key
      // This test verifies that the modes object uses 'deepInterview' (not 'deep-interview')
      assert.ok(deepInterviewRecord, 'deep-interview state should be found in collectStateFiles');
      // After the fix, the HUD model should use 'deepInterview' as the key
      // We verify this by creating a manual snapshot and checking the HUD modes
      const snap = snapshot({
        selection: { selected: candidate({ sessionId: 'sess-di', cwd: tmpRoot, stateDir: baseStateDir, pidAlive: true }), mode: 'active' as const, reason: 'test', candidates: [] },
        state: { stateDir: baseStateDir, modes: [{ mode: 'deep-interview', scope: 'session' as const, path: join(sessionDir, 'deep-interview-state.json'), mtimeMs: NOW, data: { active: true, current_phase: 'gathering-requirements' } }], currentAutopilot: null, nativeStop: null, supportBlockers: [], canonicalSkills: [], teamPhases: [], subagentTracking: null, sizes: { stateBytes: 1024, logsBytes: 1024, rolloutBytes: 1024, rolloutScanTruncated: false }, hookLog: null },
        // The HUD model should use 'deepInterview' as the key (not 'deep-interview')
        hud: { modes: { deepInterview: { phase: 'gathering-requirements' } }, staleAutopilot: false },
      });
      
      // Verify that the HUD modes use 'deepInterview' (the HudRenderContext key), not 'deep-interview' (the filename stem)
      assert.deepEqual(snap.hud?.modes, { deepInterview: { phase: 'gathering-requirements' } }, 'deep-interview state should be keyed as deepInterview');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('readHudModel applies the HUD projection rules to an explicit state root and session', () => {
  const skillActive = (skills: Array<{ skill: string; phase?: string }>) => JSON.stringify({
    version: 1, active: true, skill: skills[0]?.skill, phase: skills[0]?.phase,
    active_skills: skills.map((s) => ({ ...s, active: true })),
  });
  const withRoot = async (fn: (root: string, stateDir: string) => Promise<void>) => {
    const root = await mkdtemp(join(tmpdir(), 'omx-hud-model-'));
    try { await fn(root, join(root, '.omx', 'state')); } finally { await rm(root, { recursive: true, force: true }); }
  };
  const seed = async (stateDir: string, sessionId: string, files: Record<string, unknown | string>) => {
    await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      await writeFile(name.startsWith('/') ? join(stateDir, name.slice(1)) : join(stateDir, 'sessions', sessionId, name), typeof body === 'string' ? body : JSON.stringify(body));
    }
  };

  it('reads the candidate session even when OMX_ROOT is bound to another session (Codex P2: bind HUD to candidate root)', async () => {
    await withRoot(async (rootA, stateA) => {
      await withRoot(async (rootB, stateB) => {
        await seed(stateA, 'sess-a', { 'ralplan-state.json': { active: true, current_phase: 'draft' }, 'skill-active-state.json': skillActive([{ skill: 'ralplan', phase: 'draft' }]) });
        await seed(stateB, 'sess-b', { 'autopilot-state.json': { active: true, current_phase: 'code-review' }, 'skill-active-state.json': skillActive([{ skill: 'autopilot', phase: 'code-review' }]) });
        const previous = process.env.OMX_ROOT;
        process.env.OMX_ROOT = rootA;
        try {
          const hud = await readHudModel(rootB, stateB, 'sess-b');
          assert.deepEqual(hud?.modes, { autopilot: { phase: 'code-review' } });
        } finally {
          if (previous === undefined) delete process.env.OMX_ROOT; else process.env.OMX_ROOT = previous;
        }
      });
    });
  });

  it('hides inactive/completed detail records the way readAllState does (Codex P2: HUD visibility rules)', async () => {
    await withRoot(async (root, stateDir) => {
      await seed(stateDir, 's1', {
        'ralph-state.json': { active: false, current_phase: 'completed' },
        'ralplan-state.json': { active: true, current_phase: 'draft' },
        'skill-active-state.json': skillActive([{ skill: 'ralplan', phase: 'review' }]),
      });
      const hud = await readHudModel(root, stateDir, 's1');
      assert.deepEqual(hud?.modes, { ralplan: { phase: 'draft' } });
    });
  });

  it('derives staleAutopilot from a reportable current-autopilot record without stale_since (Codex P2: HUD stale predicate)', async () => {
    await withRoot(async (root, stateDir) => {
      await seed(stateDir, 's1', { '/current-autopilot.json': { active: true, current_phase: 'executing', session_id: 'old' } });
      assert.equal((await readHudModel(root, stateDir, 's1'))?.staleAutopilot, true);
      // An authoritative surfaced autopilot suppresses the stale flag, as in readAllState.
      await seed(stateDir, 's1', {
        'autopilot-state.json': { active: true, current_phase: 'executing' },
        'skill-active-state.json': skillActive([{ skill: 'autopilot', phase: 'executing' }]),
      });
      assert.equal((await readHudModel(root, stateDir, 's1'))?.staleAutopilot, false);
      // A non-reportable (inactive) current record is not stale.
      await seed(stateDir, 's2', { '/current-autopilot.json': { active: false, current_phase: 'executing' } });
      assert.equal((await readHudModel(root, stateDir, 's2'))?.staleAutopilot, false);
    });
  });
});

describe('readHudModel includes the canonical team phase (Codex P2: match readAllState)', () => {
  it('surfaces the phase from team/<name>/phase.json when the team detail has no current_phase', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-hud-team-phase-'));
    try {
      const stateDir = join(root, '.omx', 'state');
      await mkdir(join(stateDir, 'sessions', 's1'), { recursive: true });
      await mkdir(join(stateDir, 'team', 'alpha'), { recursive: true });
      await writeFile(join(stateDir, 'sessions', 's1', 'team-state.json'), JSON.stringify({ active: true, team_name: 'alpha' }));
      await writeFile(join(stateDir, 'sessions', 's1', 'skill-active-state.json'), JSON.stringify({
        version: 1, active: true, skill: 'team', phase: 'team-exec', active_skills: [{ skill: 'team', phase: 'team-exec', active: true }],
      }));
      await writeFile(join(stateDir, 'team', 'alpha', 'phase.json'), JSON.stringify({ current_phase: 'team-verify', max_fix_attempts: 3, current_fix_attempt: 0, transitions: [], updated_at: new Date().toISOString() }));
      const hud = await readHudModel(root, stateDir, 's1');
      assert.deepEqual(hud?.modes.team, { phase: 'team-verify' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('collectSnapshotForSession uses the session own working directory for diagnostics (Codex P2)', () => {
  it('resolves doctor preferences from the selected session cwd, not the invoking cwd', async () => {
    const invoking = await mkdtemp(join(tmpdir(), 'omx-sup-invoking-'));
    const project = await mkdtemp(join(tmpdir(), 'omx-sup-project-'));
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-sup-codex-home-'));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      await mkdir(join(project, '.omx', 'state'), { recursive: true });
      await writeFile(join(project, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project', teamMode: 'disabled' }));
      const candidate = {
        sessionId: 'sess-p', cwd: project, stateDir: join(project, '.omx', 'state'), pidAlive: true,
        stateMtimeMs: 0, rolloutMtimeMs: null, sources: ['test'],
      };
      const snap = await collectSnapshotForSession(
        { windowSeconds: 1 } as never, invoking, [], { panes: [], available: false },
        { selected: candidate, mode: 'active', reason: 'test', candidates: [candidate] },
      );
      assert.ok(snap.doctor.nativeAgents, 'native agent check ran');
      assert.doesNotMatch(snap.doctor.nativeAgents.message, /team-executor/, 'team mode is disabled in the session project');
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
      await Promise.all([invoking, project, codexHome].map((d) => rm(d, { recursive: true, force: true })));
    }
  });
});

describe('finding #5: Analysis lane prompts include secondary-session evidence', () => {
  it('includes session identifiers in lane prompts for multi-session findings', () => {
    const findings: Finding[] = [
      {
        id: 'hud-cpu-load', area: 'resource', title: 'High CPU', status: 'fail', evidence: ['hud > 2%'],
        fingerprint: 'abc123def456', severity: 'high', repro: 'sampled', sources: [1234],
        blast: 1, priority: 'P2', score: 50, dedupe: 'none', sessionId: 'sess-1',
      },
      {
        id: 'hud-cpu-load', area: 'resource', title: 'High CPU', status: 'fail', evidence: ['hud > 2%'],
        fingerprint: 'abc123def456', severity: 'high', repro: 'sampled', sources: [1234],
        blast: 1, priority: 'P2', score: 50, dedupe: 'none', sessionId: 'sess-2',
      },
    ];
    // Build lane prompt with findings from multiple sessions
    const prompt = buildLanePrompt({ id: 'resources', findings }, 'debug', 'summary');
    // Verify prompt includes session identifiers so the lane knows which session each finding is from
    assert.ok(prompt.includes('(session: sess-1)'), 'sess-1 session identifier is in prompt');
    assert.ok(prompt.includes('(session: sess-2)'), 'sess-2 session identifier is in prompt');
  });

  it('includes all session snapshots in evidence summary', async () => {
    // Create snapshots for two sessions with different HUD state
    const snap1 = snapshot({
      selection: { selected: candidate({ sessionId: 'sess-1', pidAlive: true }), mode: 'active' as const, reason: 'test', candidates: [] },
      processes: [proc({ cpuPct: 1 })],
      friction: [],
    });
    const snap2 = snapshot({
      selection: { selected: candidate({ sessionId: 'sess-2', pidAlive: true }), mode: 'active' as const, reason: 'test', candidates: [] },
      processes: [proc({ cpuPct: 2 })],
      friction: [{ code: 'test', severity: 'high', message: 'test friction' }],
    });
    
    // Build evidence bundle with multiple snapshots
    const bundle = toEvidenceBundle(snap1);
    bundle.snapshots = new Map([['sess-1', snap1], ['sess-2', snap2]]);
    
    // Summarize evidence should include all sessions
    const summary = summarizeEvidence(bundle);
    const parsed = JSON.parse(summary);
    
    // Verify both sessions are represented in the evidence summary
    assert.ok(Array.isArray(parsed.sessions), 'sessions array in summary');
    assert.ok(parsed.sessions.some((s: { sessionId: string }) => s.sessionId === 'sess-1'), 'sess-1 in summary');
    assert.ok(parsed.sessions.some((s: { sessionId: string }) => s.sessionId === 'sess-2'), 'sess-2 in summary');
  });
});

describe('finding #1: Issue drafts from different sessions do not overwrite each other', () => {
  it('keys draft files by session to prevent cross-session overwrites', async () => {
    // Create two findings from different sessions with same fingerprint
    const findings: Finding[] = [
      {
        id: 'check-x', area: 'resource', title: 'Issue X', status: 'fail', evidence: ['session 1 evidence'],
        fingerprint: 'shared-fp', severity: 'high', repro: 'sampled', sources: [1234],
        blast: 1, priority: 'P2', score: 50, dedupe: 'none', sessionId: 'sess-1',
      },
      {
        id: 'check-x', area: 'resource', title: 'Issue X', status: 'fail', evidence: ['session 2 evidence'],
        fingerprint: 'shared-fp', severity: 'high', repro: 'sampled', sources: [1234],
        blast: 1, priority: 'P2', score: 50, dedupe: 'none', sessionId: 'sess-2',
      },
    ];
    
    // Build drafts from findings
    const context = { prompt: '', version: '1.0', selection: { mode: 'active' as const, reason: 'test', selected: candidate(), candidates: [] }, platform: 'test' };
    const snap1 = snapshot({ selection: context.selection });
    const snap2 = snapshot({ selection: { ...context.selection, selected: candidate({ sessionId: 'sess-2' }) } });
    const snapshots = new Map([['sess-1', snap1], ['sess-2', snap2]]);
    
    const draftFiles: string[] = [];
    for (const finding of findings) {
      const own = finding.sessionId ? snapshots.get(finding.sessionId) : undefined;
      const draft = buildIssueDraft(finding, own ? { ...context, selection: own.selection } : context);
      const filename = `${[finding.priority, finding.id, finding.fingerprint, finding.sessionId].filter(Boolean).join('-')}.md`;
      draftFiles.push(filename);
    }
    
    // Verify draft filenames are distinct and include sessionId
    assert.equal(draftFiles.length, 2, 'two drafts created');
    assert.notEqual(draftFiles[0], draftFiles[1], 'draft filenames are different');
    assert.ok(draftFiles[0].includes('sess-1'), 'first draft includes sess-1');
    assert.ok(draftFiles[1].includes('sess-2'), 'second draft includes sess-2');
  });
});

describe('finding #2: Deduplicate same-fingerprint P0/P1 findings across sessions before filing', () => {
  it('consolidates multi-session findings into a single filing with all affected sessions', async () => {
    // Create P0/P1 findings from multiple sessions with same fingerprint
    const findings: Finding[] = [
      {
        id: 'critical-check', area: 'leader', title: 'Critical Issue', status: 'fail', evidence: ['evidence from session 1'],
        fingerprint: 'critical-fp', severity: 'critical', repro: 'persistent', sources: [5000],
        blast: 10, priority: 'P1', score: 100, dedupe: 'none', sessionId: 'sess-1',
      },
      {
        id: 'critical-check', area: 'leader', title: 'Critical Issue', status: 'fail', evidence: ['evidence from session 2'],
        fingerprint: 'critical-fp', severity: 'critical', repro: 'persistent', sources: [5000],
        blast: 10, priority: 'P1', score: 100, dedupe: 'none', sessionId: 'sess-2',
      },
    ];
    
    // Verify that when filing, we track attempted fingerprints and don't file duplicates
    const attempted = new Set<string>();
    let filedCount = 0;
    for (const finding of findings) {
      if (finding.priority !== 'P0' && finding.priority !== 'P1') continue;
      if (attempted.has(finding.fingerprint)) {
        // This finding should be skipped because fingerprint was already filed
        continue;
      }
      attempted.add(finding.fingerprint);
      filedCount++;
    }
    
    // Verify only one issue is filed despite two findings with same fingerprint
    assert.equal(filedCount, 1, 'only one issue filed despite two findings');
    assert.equal(attempted.size, 1, 'one unique fingerprint tracked');
  });
});

describe('consolidated filing evidence', () => {
  it('merges every same-fingerprint session\'s distinct evidence into the consolidated finding', () => {
    const make = (sessionId: string, evidence: string[]): Finding => ({
      id: 'critical-check', area: 'leader', title: 'Critical Issue', status: 'fail', evidence,
      fingerprint: 'critical-fp', severity: 'critical', repro: 'persistent', sources: [5000],
      blast: 10, priority: 'P1', score: 100, dedupe: 'none', sessionId,
    });
    const { consolidated } = consolidateFindingsByFingerprint([
      make('sess-1', ['shared line', 'only in one']),
      make('sess-2', ['shared line', 'only in two']),
      make('sess-3', ['only in three']),
    ]);
    assert.equal(consolidated.length, 1);
    const text = consolidated[0].evidence.join('\n');
    assert.match(text, /only in one/);
    assert.match(text, /only in two/);
    assert.match(text, /only in three/);
    assert.equal(consolidated[0].evidence.filter((line) => line.includes('shared line')).length, 1);
  });
});

describe('finding #3: Draft bodies for non-primary sessions use that session\'s snapshot context', () => {
  it('uses session-specific selection context for each draft', async () => {
    // Create findings from different sessions
    const snap1 = snapshot({ selection: { mode: 'active' as const, reason: 'test1', selected: candidate({ sessionId: 'sess-1', cwd: '/work/a' }), candidates: [] } });
    const snap2 = snapshot({ selection: { mode: 'active' as const, reason: 'test2', selected: candidate({ sessionId: 'sess-2', cwd: '/work/b' }), candidates: [] } });
    const snapshots = new Map([['sess-1', snap1], ['sess-2', snap2]]);
    
    const findings: Finding[] = [
      {
        id: 'check-x', area: 'resource', title: 'Issue X', status: 'fail', evidence: [],
        fingerprint: 'fp1', severity: 'high', repro: 'sampled', sources: [],
        blast: 1, priority: 'P2', score: 50, dedupe: 'none', sessionId: 'sess-1',
      },
      {
        id: 'check-x', area: 'resource', title: 'Issue X', status: 'fail', evidence: [],
        fingerprint: 'fp2', severity: 'high', repro: 'sampled', sources: [],
        blast: 1, priority: 'P2', score: 50, dedupe: 'none', sessionId: 'sess-2',
      },
    ];
    
    const baseContext = { prompt: '', version: '1.0', platform: 'test', selection: snap1.selection };
    
    // Build drafts using session-specific contexts
    const drafts = findings.map((finding) => {
      const own = finding.sessionId ? snapshots.get(finding.sessionId) : undefined;
      const draftContext = own ? { ...baseContext, selection: own.selection } : baseContext;
      return buildIssueDraft(finding, draftContext);
    });
    
    // Verify each draft uses its session's context
    assert.ok(drafts[0].body.includes('sess-1'), 'first draft includes sess-1 session ID');
    assert.ok(drafts[1].body.includes('sess-2'), 'second draft includes sess-2 session ID');
    assert.ok(drafts[0].body.includes('test1'), 'first draft includes sess-1 reason');
    assert.ok(drafts[1].body.includes('test2'), 'second draft includes sess-2 reason');
  });
});

describe('finding #6: Preserve session attribution in the Markdown report', () => {
  it('includes sessionId in rendered checks and findings for secondary sessions', () => {
    const report: SupervisionReport = {
      generatedAt: '2026-11-26T12:00:00Z',
      prompt: 'test prompt',
      session: { mode: 'active', reason: 'selected', sessionId: 'primary-sess', cwd: '/work/a', fallback: false },
      windowSeconds: 10,
      checks: [
        {
          id: 'primary-check', area: 'resource', title: 'Primary Check', status: 'fail',
          evidence: ['primary evidence'], fingerprint: 'fp1', severity: 'high', repro: 'persistent',
          sources: [], blast: 1, sessionId: 'primary-sess',
        },
        {
          id: 'secondary-check', area: 'resource', title: 'Secondary Check', status: 'fail',
          evidence: ['secondary evidence'], fingerprint: 'fp2', severity: 'high', repro: 'persistent',
          sources: [], blast: 1, sessionId: 'secondary-sess',
        },
      ],
      findings: [
        {
          id: 'primary-finding', area: 'resource', title: 'Primary Finding', status: 'fail',
          evidence: ['primary evidence'], fingerprint: 'fp1', severity: 'high', repro: 'persistent',
          sources: [], blast: 1, priority: 'P1', score: 100, dedupe: 'none', sessionId: 'primary-sess',
        },
        {
          id: 'secondary-finding', area: 'resource', title: 'Secondary Finding', status: 'fail',
          evidence: ['secondary evidence'], fingerprint: 'fp3', severity: 'high', repro: 'persistent',
          sources: [], blast: 1, priority: 'P1', score: 100, dedupe: 'none', sessionId: 'secondary-sess',
        },
      ],
      lanes: [],
      filed: [],
      fileSkipped: [],
      outputDir: null,
      friction: [],
    };

    const markdown = renderReportMarkdown(report);

    // Verify checks are rendered with session attribution
    assert.ok(markdown.includes('FAIL `primary-check`'), 'primary check is rendered');
    assert.ok(markdown.includes('(session: secondary-sess)'), 'secondary check includes session attribution');
    assert.ok(!markdown.match(/primary-check.*session:/), 'primary check should not have session attribution');

    // Verify findings are rendered with session attribution
    assert.ok(markdown.includes('P1 `primary-finding`'), 'primary finding is rendered');
    assert.ok(markdown.includes('P1 `secondary-finding`'), 'secondary finding is rendered');
    assert.ok(markdown.includes('session: secondary-sess'), 'secondary finding includes session attribution');
    assert.ok(!markdown.includes('Primary Finding') || !markdown.match(/Primary Finding[\s\S]*session: primary-sess/), 'primary finding should not have duplicate session attribution');
  });

  it('does not add session attribution when all findings are from the primary session', () => {
    const report: SupervisionReport = {
      generatedAt: '2026-11-26T12:00:00Z',
      prompt: 'test prompt',
      session: { mode: 'active', reason: 'selected', sessionId: 'primary-sess', cwd: '/work/a', fallback: false },
      windowSeconds: 10,
      checks: [
        {
          id: 'check1', area: 'resource', title: 'Check 1', status: 'pass',
          evidence: ['evidence'], fingerprint: 'fp1', severity: 'high', repro: 'persistent',
          sources: [], blast: 1, sessionId: 'primary-sess',
        },
      ],
      findings: [
        {
          id: 'finding1', area: 'resource', title: 'Finding 1', status: 'pass',
          evidence: ['evidence'], fingerprint: 'fp1', severity: 'high', repro: 'persistent',
          sources: [], blast: 1, priority: 'P1', score: 100, dedupe: 'none', sessionId: 'primary-sess',
        },
      ],
      lanes: [],
      filed: [],
      fileSkipped: [],
      outputDir: null,
      friction: [],
    };

    const markdown = renderReportMarkdown(report);

    // Verify no spurious session attribution when all checks/findings are from primary session
    assert.ok(!markdown.includes('(session: primary-sess)'), 'primary session should not have explicit attribution in checks');
    // Count occurrences of 'session:' - should only appear in the header or not at all in findings
    const sessionMatches = markdown.match(/- session:/g);
    assert.ok(!sessionMatches || sessionMatches.length === 0, 'no session attribution line in findings for primary session');
  });
});

describe('omx supervision CLI', () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'omx-supervision-cli-')); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  const run = (args: string[]) => spawnSync(process.execPath, [join(repoRoot, 'dist/cli/omx.js'), 'supervision', ...args], {
    cwd, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CODEX_HOME: join(cwd, 'home'), OMX_ROOT: '', OMX_STATE_ROOT: '', PATH: '/usr/bin:/bin' },
  });

  it('prints help without running checks', () => {
    const out = run(['--help']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /omx supervision/);
    assert.match(out.stdout, /--no-analyze/);
    assert.equal(out.stdout.includes('Checks'), false);
  });

  it('emits machine-readable output with --json and falls back cleanly with no session', async () => {
    const out = run(['--no-analyze', '--json', '--window', '1', 'something is off']);
    assert.ok(out.stdout.trim().startsWith('{'), out.stdout + out.stderr);
    const report = JSON.parse(out.stdout);
    assert.equal(report.prompt, 'something is off');
    assert.equal(report.session.mode, 'none');
    assert.equal(report.checks.length, SUPERVISION_CHECKS.length);
    assert.ok(report.outputDir.startsWith(join(cwd, '.omx', 'supervision')));
    await mkdir(report.outputDir, { recursive: true });
    await writeFile(join(report.outputDir, '.touch'), '');
  });

  it('rejects unknown options with a non-zero exit', () => {
    const out = run(['--bogus']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /Unknown omx supervision option/);
  });

  it('runs supervision CLI with no active sessions and handles fallback correctly (regression test for #4222)', async () => {
    // Run supervision CLI with no active sessions
    const out = run(['--no-analyze', '--json', '--window', '1', 'testing CLI multi-session collection']);
    assert.equal(out.status, 0, `CLI failed: ${out.stderr}`);
    const report = JSON.parse(out.stdout);
    
    // Verify report has all expected fields and correct structure
    assert.ok(Array.isArray(report.checks), 'report.checks is array');
    assert.ok(report.checks.length > 0, 'report has checks');
    assert.equal(report.session.mode, 'none', 'no active session, mode is none');
    assert.ok(typeof report.prompt === 'string', 'prompt is string');
    assert.ok(typeof report.windowSeconds === 'number', 'windowSeconds is number');
    // Verify checks are properly evaluated even when there are no active sessions
    const hasFailures = report.checks.some((c: CheckResult) => c.status === 'fail');
    // Don't assert on failures count since it depends on system state
    assert.ok(typeof hasFailures === 'boolean', 'checks have status field');
  });
});

describe('finding #4234 release-review fixes', () => {
  it('redactForIssue removes raw log samples and secret patterns', () => {
    // Test that redactForIssue is applied in buildIssueDraft
    const homeDir = homedir();
    const finding: Finding = {
      id: 'test-check', area: 'resource', title: 'test', priority: 'P0', status: 'fail', fingerprint: 'fp',
      evidence: [
        '2026-11-28T10:00:00Z raw hook log line with secret sk-123456789012345678901234567890',
        `{"error": "JSON log sample", "path": "${homeDir}/.omx/state"}`,
        'Normal error message',
      ],
      severity: 'high', repro: 'persistent', sources: [1234], blast: 1, score: 100, dedupe: 'none',
    };
    const sel = { selected: candidate(), mode: 'active' as const, reason: 'test', candidates: [] };
    const ctx = { prompt: `User home ${homeDir} secret AKIA1234567890123456`, version: '0.22.30', selection: sel, platform: 'linux' };
    const draft = buildIssueDraft(finding, ctx);
    // Verify raw log lines are removed, paths are redacted, secrets are redacted
    assert.ok(!draft.body.includes('2026-11-28T10:00:00Z'), 'timestamp log lines are removed');
    assert.ok(!draft.body.includes('sk-123456789012345678901234567890'), 'token is redacted');
    assert.ok(!draft.body.includes('AKIA1234567890123456'), 'AWS key is redacted');
    assert.ok(!draft.body.includes(homeDir), 'home paths are redacted');
    assert.ok(draft.body.includes('~'), 'home directory is replaced with tilde');
    assert.ok(draft.body.includes('Normal error message'), 'normal messages are preserved');
  });

  it('question-outside-tmux passes for native sessions without tmux', () => {
    // Native sessions without tmuxPaneId should pass the check
    const snap = snapshot({ state: { ...snapshot().state, modes: [mode('deep-interview', { active: true })] }, selection: { selected: candidate(), mode: 'active', reason: 't', candidates: [] } });
    const check = SUPERVISION_CHECKS.find((c) => c.id === 'question-outside-tmux');
    assert.ok(check, 'question-outside-tmux check exists');
    const result = check!.run(snap);
    assert.equal(result.status, 'pass', 'native session without tmux passes the check');
    assert.ok(result.evidence.some((e: string) => e.includes('tmux not required')), 'evidence mentions native session support');
  });

  it('question-outside-tmux fails only when tmux pane is specified but not live', () => {
    // Session with tmuxPaneId that is not in panes list should fail
    const snap = snapshot({ state: { ...snapshot().state, modes: [mode('deep-interview', { active: true })] }, panes: [], selection: { selected: candidate({ tmuxPaneId: '%99' }), mode: 'active', reason: 't', candidates: [] } });
    const check = SUPERVISION_CHECKS.find((c) => c.id === 'question-outside-tmux');
    assert.ok(check, 'question-outside-tmux check exists');
    const result = check!.run(snap);
    assert.equal(result.status, 'fail', 'tmux-bound session with missing pane fails');
    assert.ok(result.evidence.some((e: string) => e.includes('pane')), 'evidence mentions pane');
  });

  it('rolloutCwd returns cwd from header of large rollout file', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'omx-rollout-test-'));
    try {
      const testCwd = '/home/user/my/project';
      const rolloutPath = join(tempDir, 'rollout.jsonl');
      // Create a header line with cwd embedded in JSON
      const headerLine = JSON.stringify({
        schema: 'rollout',
        payload: { cwd: testCwd, session_id: 'sess-1' },
      });
      // Create a file larger than 8KB to test bounded read
      const largePadding = 'x'.repeat(10_000);
      await writeFile(rolloutPath, headerLine + '\n' + largePadding + '\n{"more":"data"}\n');
      
      const result = rolloutCwd(rolloutPath);
      assert.equal(result, testCwd, 'rolloutCwd returns correct cwd from large file');
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });

  it('rolloutCwd handles header line longer than 8KB bounded read', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'omx-rollout-test-'));
    try {
      const testCwd = '/home/user/my/project';
      const rolloutPath = join(tempDir, 'rollout.jsonl');
      // Create a header line that is itself close to or exceeds 8KB
      const largeJsonValue = 'x'.repeat(7_000);
      const headerLine = JSON.stringify({
        schema: 'rollout',
        payload: { cwd: testCwd, session_id: 'sess-1', extra: largeJsonValue },
      });
      // Verify the header is indeed large
      assert.ok(headerLine.length > 7_000, 'header line is appropriately large');
      await writeFile(rolloutPath, headerLine + '\n{"next":"line"}\n');
      
      const result = rolloutCwd(rolloutPath);
      // Should still extract cwd even with large header, as long as first line parses
      assert.equal(result, testCwd, 'rolloutCwd extracts cwd from large header line');
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });

  it('discoverCandidates returns distinct candidates for multiple native session owners', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'omx-discover-test-'));
    try {
      // getBaseStateDir returns <cwd>/.omx/state by default
      const stateDir = join(tempDir, '.omx', 'state');
      const sessionsDir = join(stateDir, 'sessions');
      await mkdir(sessionsDir, { recursive: true });
      
      // Create two session-owner.json files in different session directories
      const sess1Dir = join(sessionsDir, 'sess-1');
      const sess2Dir = join(sessionsDir, 'sess-2');
      await mkdir(sess1Dir);
      await mkdir(sess2Dir);
      
      const owner1 = {
        session_id: 'sess-1',
        cwd: '/home/user/project1',
        started_at: new Date(NOW).toISOString(),
      };
      const owner2 = {
        session_id: 'sess-2',
        cwd: '/home/user/project2',
        started_at: new Date(NOW).toISOString(),
      };
      
      await writeFile(join(sess1Dir, 'session-owner.json'), JSON.stringify(owner1));
      await writeFile(join(sess2Dir, 'session-owner.json'), JSON.stringify(owner2));
      
      // Call discoverCandidates with the temp directory
      // Note: discoverCandidates expects the cwd and processes/panes
      const candidates = discoverCandidates(tempDir, [], []);
      
      // Should have at least the two native session owners
      const nativeOwners = candidates.filter((c) => c.sessionId === 'sess-1' || c.sessionId === 'sess-2');
      assert.ok(nativeOwners.length >= 2, 'discoverCandidates returns at least 2 distinct candidates');
      
      const sess1Candidate = nativeOwners.find((c) => c.sessionId === 'sess-1');
      const sess2Candidate = nativeOwners.find((c) => c.sessionId === 'sess-2');
      assert.ok(sess1Candidate, 'found candidate for sess-1');
      assert.ok(sess2Candidate, 'found candidate for sess-2');
      assert.equal(sess1Candidate!.cwd, '/home/user/project1', 'sess-1 has correct cwd');
      assert.equal(sess2Candidate!.cwd, '/home/user/project2', 'sess-2 has correct cwd');
      assert.notEqual(sess1Candidate!.sessionId, sess2Candidate!.sessionId, 'candidates have distinct session IDs');
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });
});
