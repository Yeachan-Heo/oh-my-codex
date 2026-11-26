import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUPERVISION_CHECKS,
  applyDedupe,
  buildIssueDraft,
  classifyProcess,
  computeCpuPercent,
  evaluateChecks,
  findDuplicateIssue,
  fingerprintFor,
  planAnalysisLanes,
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
  type ProcSample,
  type SessionCandidate,
  type SupervisionDeps,
  type SupervisionOptions,
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
    fail: () => snapshot({ state: { ...snapshot().state, modes: [mode('deep-interview', { active: true })] }, selection: { selected: candidate(), mode: 'active', reason: 't', candidates: [] } }),
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

  it('hud-authority-churn accepts synthesized ultraqa and canonical-skill-only modes, and the canonical phase', () => {
    const base = snapshot().state;
    const synthesized = snapshot({
      state: { ...base, modes: [mode('autopilot', { active: true, current_phase: 'ultraqa' })] },
      hud: { modes: { autopilot: { phase: 'ultraqa' }, ultraqa: { phase: 'ultraqa' } }, staleAutopilot: false },
    });
    assert.equal(result('hud-authority-churn', synthesized).status, 'pass');
    const canonicalOnly = snapshot({ state: { ...base, canonicalSkills: [{ skill: 'ralph', phase: 'executing' }] }, hud: { modes: { ralph: { phase: 'executing' } }, staleAutopilot: false } });
    assert.equal(result('hud-authority-churn', canonicalOnly).status, 'pass');
    const canonicalPhase = snapshot({
      state: { ...base, modes: [mode('ralplan', { active: true, current_phase: 'draft' })], canonicalSkills: [{ skill: 'ralplan', phase: 'review' }] },
      hud: { modes: { ralplan: { phase: 'review' } }, staleAutopilot: false },
    });
    assert.equal(result('hud-authority-churn', canonicalPhase).status, 'pass');
    const phantom = snapshot({ state: base, hud: { modes: { ultraqa: { phase: 'x' } }, staleAutopilot: false } });
    assert.equal(result('hud-authority-churn', phantom).status, 'fail');
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
});
