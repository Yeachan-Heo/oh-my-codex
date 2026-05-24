import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderHud } from '../render.js';
import type { HudRenderContext } from '../types.js';
import { setColorEnabled } from '../colors.js';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

function stripSgr(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

afterEach(() => {
  mock.restoreAll();
  setColorEnabled(true);
});

function emptyCtx(): HudRenderContext {
  return {
    version: null,
    gitBranch: null,
    ralph: null,
    ultrawork: null,
    autopilot: null,
    ralplan: null,
    deepInterview: null,
    autoresearch: null,
    ultraqa: null,
    team: null,
    metrics: null,
    hudNotify: null,
    session: null,
  };
}

// ── Empty context ─────────────────────────────────────────────────────────────

describe('renderHud – empty context', () => {
  it('shows "No active modes." when nothing is active', () => {
    const result = renderHud(emptyCtx(), 'focused');
    assert.ok(result.includes('No active modes.'));
  });

  it('includes the [OMX] label', () => {
    const result = renderHud(emptyCtx(), 'focused');
    assert.ok(result.includes('[OMX]'));
  });

  it('renders plain text with no ANSI escapes when colors are disabled', () => {
    setColorEnabled(false);
    const result = renderHud(emptyCtx(), 'focused');
    assert.equal(/\x1b\[[0-9;]*m/.test(result), false);
    assert.equal(result.includes('[OMX]'), true);
  });
});

// ── Version ───────────────────────────────────────────────────────────────────

describe('renderHud – version', () => {
  it('strips the "v" prefix from a semver version', () => {
    const ctx = { ...emptyCtx(), version: 'v1.2.3' };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('[OMX#1.2.3]'));
  });

  it('keeps a plain version number as-is', () => {
    const ctx = { ...emptyCtx(), version: '2.0.0' };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('[OMX#2.0.0]'));
  });

  it('omits hash suffix when version is null', () => {
    const result = renderHud(emptyCtx(), 'focused');
    assert.ok(result.includes('[OMX]'));
    assert.ok(!result.includes('[OMX#'));
  });
});

// ── Git branch ────────────────────────────────────────────────────────────────

describe('renderHud – gitBranch', () => {
  it('renders the branch name wrapped in cyan', () => {
    const ctx = { ...emptyCtx(), gitBranch: 'main' };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes(`${CYAN}main${RESET}`));
  });

  it('omits the branch element when null', () => {
    const result = renderHud(emptyCtx(), 'focused');
    assert.ok(!result.includes('main'));
  });
});

// ── Ralph ─────────────────────────────────────────────────────────────────────

describe('renderHud – ralph', () => {
  it('renders ralph iteration info', () => {
    const ctx = { ...emptyCtx(), ralph: { active: true, iteration: 3, max_iterations: 10 } };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('ralph:3/10'));
  });

  it('falls back to a bare label when Ralph counters are unavailable', () => {
    const ctx = { ...emptyCtx(), ralph: { active: true } };
    const result = stripSgr(renderHud(ctx, 'focused'));
    assert.ok(result.includes('ralph'));
    assert.equal(result.includes('ralph:'), false);
  });

  it('omits ralph when null', () => {
    const result = renderHud(emptyCtx(), 'focused');
    assert.ok(!result.includes('ralph'));
  });
});

// ── Ultrawork ─────────────────────────────────────────────────────────────────

describe('renderHud – ultrawork', () => {
  it('renders "ultrawork" in cyan', () => {
    const ctx = { ...emptyCtx(), ultrawork: { active: true } };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes(`${CYAN}ultrawork${RESET}`));
  });

  it('omits ultrawork when null', () => {
    const result = renderHud(emptyCtx(), 'focused');
    assert.ok(!result.includes('ultrawork'));
  });
});

// ── Autopilot ─────────────────────────────────────────────────────────────────

describe('renderHud – autopilot', () => {
  it('renders autopilot with the current phase', () => {
    const ctx = { ...emptyCtx(), autopilot: { active: true, current_phase: 'planning' } };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes(`${YELLOW}autopilot:planning${RESET}`));
  });

  it('defaults phase to "active" when not set', () => {
    const ctx = { ...emptyCtx(), autopilot: { active: true } };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('autopilot:active'));
  });

  it('omits autopilot when null', () => {
    const result = renderHud(emptyCtx(), 'focused');
    assert.ok(!result.includes('autopilot'));
  });
});

// ── Ralplan ───────────────────────────────────────────────────────────────────

describe('renderHud – ralplan', () => {
  it('renders ralplan with the current phase', () => {
    const ctx = { ...emptyCtx(), ralplan: { active: true, current_phase: 'review' } };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes(`${CYAN}ralplan:review${RESET}`));
  });

  it('renders iteration display when ralplan iteration is present', () => {
    const ctx = { ...emptyCtx(), ralplan: { active: true, iteration: 2, planning_complete: false } };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes(`${CYAN}ralplan:2/?${RESET}`));
  });
});

// ── Deep interview ────────────────────────────────────────────────────────────

describe('renderHud – deepInterview', () => {
  it('renders interview with the current phase', () => {
    const ctx = { ...emptyCtx(), deepInterview: { active: true, current_phase: 'intent-first' } };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes(`${YELLOW}interview:intent-first${RESET}`));
  });

  it('shows a lock suffix when input lock is active', () => {
    const ctx = { ...emptyCtx(), deepInterview: { active: true, current_phase: 'deep-interview', input_lock_active: true } };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('interview:deep-interview:lock'));
  });
});

// ── Autoresearch ──────────────────────────────────────────────────────────────

describe('renderHud – autoresearch', () => {
  it('renders research with the current phase', () => {
    const ctx = { ...emptyCtx(), autoresearch: { active: true, current_phase: 'running' } };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes(`${CYAN}research:running${RESET}`));
  });
});

// ── Ultraqa ───────────────────────────────────────────────────────────────────

describe('renderHud – ultraqa', () => {
  it('renders qa with the current phase', () => {
    const ctx = { ...emptyCtx(), ultraqa: { active: true, current_phase: 'diagnose' } };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes(`${GREEN}qa:diagnose${RESET}`));
  });
});

// ── Team ──────────────────────────────────────────────────────────────────────

describe('renderHud – team', () => {
  it('renders agent count when count > 0', () => {
    const ctx = { ...emptyCtx(), team: { active: true, agent_count: 3 } };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes(`${GREEN}team:3 workers${RESET}`));
  });

  it('renders team name when count is absent', () => {
    const ctx = { ...emptyCtx(), team: { active: true, team_name: 'my-team' } };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes(`${GREEN}team:my-team${RESET}`));
  });

  it('renders bare "team" when neither count nor name is set', () => {
    const ctx = { ...emptyCtx(), team: { active: true } };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes(`${GREEN}team${RESET}`));
  });

  it('skips the count branch when agent_count is 0', () => {
    const ctx = { ...emptyCtx(), team: { active: true, agent_count: 0 } };
    const result = renderHud(ctx, 'focused');
    assert.ok(!result.includes('workers'));
    // Falls through to bare "team"
    assert.ok(result.includes(`${GREEN}team${RESET}`));
  });

  it('omits team when null', () => {
    const result = renderHud(emptyCtx(), 'focused');
    assert.ok(!result.includes('team'));
  });
});

// ── Ultragoal ────────────────────────────────────────────────────────────────

describe('renderHud – ultragoal', () => {
  it('renders active ultragoal progress and objective in English', () => {
    const ctx = {
      ...emptyCtx(),
      ultragoal: {
        active: true,
        status: 'in_progress',
        total: 5,
        complete: 2,
        pending: 2,
        inProgress: 1,
        failed: 0,
        reviewBlocked: 0,
        needsUserDecision: 0,
        progressTotal: 5,
        activeGoal: {
          id: 'G003-tests',
          title: 'HUD progress display',
          objective: 'show active ultragoal objective in OMX HUD',
          status: 'in_progress',
          index: 3,
        },
      },
      metrics: { total_turns: 12, session_turns: 12, last_activity: '' },
    };

    const result = stripSgr(renderHud(ctx, 'focused'));

    assert.ok(result.includes('ultragoal 2/5 ▶ G003-tests: HUD progress display'));
    assert.ok(result.includes('objective: show active ultragoal objective in OMX HUD'));
    assert.ok(!result.includes('목표'));
  });

  it('omits ultragoal when null', () => {
    const result = renderHud(emptyCtx(), 'focused');
    assert.ok(!result.includes('ultragoal'));
  });

  it('omits completed ultragoal plans instead of showing stale progress', () => {
    const ctx = {
      ...emptyCtx(),
      ultragoal: {
        active: false,
        status: 'complete',
        total: 2,
        complete: 2,
        pending: 0,
        inProgress: 0,
        failed: 0,
        reviewBlocked: 0,
        needsUserDecision: 0,
        progressTotal: 2,
      },
    };

    const result = renderHud(ctx, 'focused');
    assert.ok(!result.includes('ultragoal'));
  });

  it('truncates long ultragoal objectives', () => {
    const longObjective = 'show active ultragoal objective in OMX HUD '.repeat(8);
    const ctx = {
      ...emptyCtx(),
      ultragoal: {
        active: true,
        status: 'in_progress',
        total: 1,
        complete: 0,
        pending: 0,
        inProgress: 1,
        failed: 0,
        reviewBlocked: 0,
        needsUserDecision: 0,
        progressTotal: 1,
        activeGoal: {
          id: 'G001-long',
          title: 'Long objective',
          objective: longObjective,
          status: 'in_progress',
          index: 1,
        },
      },
    };

    const result = stripSgr(renderHud(ctx, 'focused'));
    assert.ok(result.includes('objective: show active ultragoal objective in OMX HUD'));
    assert.ok(result.includes('…'));
    assert.ok(!result.includes(longObjective));
  });
});

// ── Metrics – turns ───────────────────────────────────────────────────────────

describe('renderHud – metrics (turns)', () => {
  it('renders session turn count', () => {
    const ctx = {
      ...emptyCtx(),
      metrics: { total_turns: 100, session_turns: 5, last_activity: '' },
    };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('turns:5'));
  });

  it('omits turns when metrics is null', () => {
    const result = renderHud(emptyCtx(), 'focused');
    assert.ok(!result.includes('turns'));
  });

  it('does not render stale metrics (last_activity before session start)', () => {
    const ctx = {
      ...emptyCtx(),
      session: { session_id: 's1', started_at: '2024-06-01T10:00:00Z' },
      metrics: {
        total_turns: 50,
        session_turns: 3,
        last_activity: '2024-06-01T09:00:00Z',  // before session start
      },
    };
    const result = renderHud(ctx, 'focused');
    assert.ok(!result.includes('turns:3'));
  });
});

// ── Metrics – tokens ──────────────────────────────────────────────────────────

describe('renderHud – metrics (tokens)', () => {
  it('renders session_total_tokens formatted as "k"', () => {
    const ctx = {
      ...emptyCtx(),
      metrics: { total_turns: 10, session_turns: 3, last_activity: '', session_total_tokens: 5000 },
    };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('tokens:5.0k'));
  });

  it('sums input and output tokens when session_total_tokens is absent', () => {
    const ctx = {
      ...emptyCtx(),
      metrics: {
        total_turns: 10,
        session_turns: 3,
        last_activity: '',
        session_input_tokens: 2000,
        session_output_tokens: 3000,
      },
    };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('tokens:5.0k'));
  });

  it('formats values in millions', () => {
    const ctx = {
      ...emptyCtx(),
      metrics: { total_turns: 10, session_turns: 3, last_activity: '', session_total_tokens: 2_500_000 },
    };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('tokens:2.5M'));
  });

  it('formats small values without suffix', () => {
    const ctx = {
      ...emptyCtx(),
      metrics: { total_turns: 10, session_turns: 3, last_activity: '', session_total_tokens: 500 },
    };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('tokens:500'));
  });

  it('omits tokens when total is 0', () => {
    const ctx = {
      ...emptyCtx(),
      metrics: { total_turns: 10, session_turns: 3, last_activity: '', session_total_tokens: 0 },
    };
    const result = renderHud(ctx, 'focused');
    assert.ok(!result.includes('tokens'));
  });
});

// ── Metrics – quota ───────────────────────────────────────────────────────────

describe('renderHud – metrics (quota)', () => {
  it('renders both 5-hour and weekly limits', () => {
    const ctx = {
      ...emptyCtx(),
      metrics: {
        total_turns: 10,
        session_turns: 3,
        last_activity: '',
        five_hour_limit_pct: 42.7,
        weekly_limit_pct: 15.3,
      },
    };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('quota:5h:43%,wk:15%'));
  });

  it('renders only 5-hour limit when weekly is absent', () => {
    const ctx = {
      ...emptyCtx(),
      metrics: {
        total_turns: 10,
        session_turns: 3,
        last_activity: '',
        five_hour_limit_pct: 60,
      },
    };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('quota:5h:60%'));
    assert.ok(!result.includes('wk:'));
  });

  it('omits quota when both limits are absent', () => {
    const ctx = {
      ...emptyCtx(),
      metrics: { total_turns: 10, session_turns: 3, last_activity: '' },
    };
    const result = renderHud(ctx, 'focused');
    assert.ok(!result.includes('quota'));
  });

  it('omits quota when both limits are 0', () => {
    const ctx = {
      ...emptyCtx(),
      metrics: {
        total_turns: 10,
        session_turns: 3,
        last_activity: '',
        five_hour_limit_pct: 0,
        weekly_limit_pct: 0,
      },
    };
    const result = renderHud(ctx, 'focused');
    assert.ok(!result.includes('quota'));
  });
});

// ── HudNotify – last activity ─────────────────────────────────────────────────

describe('renderHud – hudNotify (last activity)', () => {
  it('renders last activity in seconds', () => {
    const fixedNow = 1_700_000_030_000;
    const lastTurnAt = new Date(fixedNow - 30_000).toISOString();
    mock.method(Date, 'now', () => fixedNow);

    const ctx = { ...emptyCtx(), hudNotify: { last_turn_at: lastTurnAt, turn_count: 5 } };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('last:30s ago'));
  });

  it('renders last activity in minutes', () => {
    const fixedNow = 1_700_000_120_000;
    const lastTurnAt = new Date(fixedNow - 120_000).toISOString();
    mock.method(Date, 'now', () => fixedNow);

    const ctx = { ...emptyCtx(), hudNotify: { last_turn_at: lastTurnAt, turn_count: 5 } };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('last:2m ago'));
  });

  it('omits last activity when hudNotify is null', () => {
    const result = renderHud(emptyCtx(), 'focused');
    assert.ok(!result.includes('last:'));
  });

  it('omits last activity when timestamp is invalid', () => {
    const ctx = { ...emptyCtx(), hudNotify: { last_turn_at: 'not-a-date', turn_count: 5 } };
    const result = renderHud(ctx, 'focused');
    assert.ok(!result.includes('last:'));
  });

  it('clamps future last activity timestamps to zero seconds', () => {
    const fixedNow = 1_700_000_000_000;
    const lastTurnAt = new Date(fixedNow + 120_000).toISOString();
    mock.method(Date, 'now', () => fixedNow);

    const ctx = { ...emptyCtx(), hudNotify: { last_turn_at: lastTurnAt, turn_count: 5 } };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('last:0s ago'));
  });
});

// ── Session duration ──────────────────────────────────────────────────────────

describe('renderHud – session duration', () => {
  it('renders session duration in seconds', () => {
    const fixedNow = 1_700_000_030_000;
    const startedAt = new Date(fixedNow - 30_000).toISOString();
    mock.method(Date, 'now', () => fixedNow);

    const ctx = { ...emptyCtx(), session: { session_id: 's1', started_at: startedAt } };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('session:30s'));
  });

  it('renders session duration in minutes', () => {
    const fixedNow = 1_700_000_300_000;
    const startedAt = new Date(fixedNow - 300_000).toISOString();  // 5 minutes
    mock.method(Date, 'now', () => fixedNow);

    const ctx = { ...emptyCtx(), session: { session_id: 's1', started_at: startedAt } };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('session:5m'));
  });

  it('renders session duration in hours and minutes', () => {
    const fixedNow = 1_700_010_920_000;
    const startedAt = new Date(fixedNow - 7_320_000).toISOString();  // 2h 2m
    mock.method(Date, 'now', () => fixedNow);

    const ctx = { ...emptyCtx(), session: { session_id: 's1', started_at: startedAt } };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('session:2h2m'));
  });

  it('omits session duration when session is null', () => {
    const result = renderHud(emptyCtx(), 'focused');
    assert.ok(!result.includes('session:'));
  });

  it('omits session duration when started_at is invalid', () => {
    const ctx = { ...emptyCtx(), session: { session_id: 's1', started_at: 'invalid-iso' } };
    const result = renderHud(ctx, 'focused');
    assert.ok(!result.includes('session:'));
  });

  it('clamps future started_at to zero seconds', () => {
    const fixedNow = 1_700_000_000_000;
    const startedAt = new Date(fixedNow + 120_000).toISOString();
    mock.method(Date, 'now', () => fixedNow);

    const ctx = { ...emptyCtx(), session: { session_id: 's1', started_at: startedAt } };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('session:0s'));
  });
});

// ── Total turns ───────────────────────────────────────────────────────────────

describe('renderHud – total turns (full preset)', () => {
  it('renders total-turns in full preset', () => {
    const ctx = {
      ...emptyCtx(),
      metrics: { total_turns: 200, session_turns: 5, last_activity: '' },
    };
    const result = renderHud(ctx, 'full');
    assert.ok(result.includes('total-turns:200'));
  });

  it('omits total-turns in focused preset', () => {
    const ctx = {
      ...emptyCtx(),
      metrics: { total_turns: 200, session_turns: 5, last_activity: '' },
    };
    const result = renderHud(ctx, 'focused');
    assert.ok(!result.includes('total-turns'));
  });

  it('omits total-turns when total_turns is 0', () => {
    const ctx = {
      ...emptyCtx(),
      metrics: { total_turns: 0, session_turns: 5, last_activity: '' },
    };
    const result = renderHud(ctx, 'full');
    assert.ok(!result.includes('total-turns'));
  });
});

// ── Presets ───────────────────────────────────────────────────────────────────

describe('renderHud – presets', () => {
  it('minimal preset includes gitBranch, ralph, ultrawork, team, turns', () => {
    const ctx = {
      ...emptyCtx(),
      gitBranch: 'feat/x',
      ralph: { active: true, iteration: 1, max_iterations: 5 },
      ultrawork: { active: true },
      ralplan: { active: true, current_phase: 'draft' },
      deepInterview: { active: true, current_phase: 'intent-first' },
      autoresearch: { active: true, current_phase: 'running' },
      ultraqa: { active: true, current_phase: 'qa' },
      team: { active: true, agent_count: 2 },
      metrics: { total_turns: 10, session_turns: 3, last_activity: '' },
    };
    const result = renderHud(ctx, 'minimal');
    assert.ok(result.includes('feat/x'));
    assert.ok(result.includes('ralph:1/5'));
    assert.ok(result.includes('ultrawork'));
    assert.ok(result.includes('ralplan:draft'));
    assert.ok(result.includes('interview:intent-first'));
    assert.ok(result.includes('research:running'));
    assert.ok(result.includes('qa:qa'));
    assert.ok(result.includes('workers'));
    assert.ok(result.includes('turns:3'));
  });

  it('minimal preset excludes autopilot and quota', () => {
    const ctx = {
      ...emptyCtx(),
      autopilot: { active: true, current_phase: 'exec' },
      metrics: {
        total_turns: 10,
        session_turns: 3,
        last_activity: '',
        five_hour_limit_pct: 50,
      },
    };
    const result = renderHud(ctx, 'minimal');
    assert.ok(!result.includes('autopilot'));
    assert.ok(!result.includes('quota'));
  });

  it('full preset includes all elements including total-turns', () => {
    const ctx = {
      ...emptyCtx(),
      metrics: { total_turns: 99, session_turns: 5, last_activity: '' },
    };
    const result = renderHud(ctx, 'full');
    assert.ok(result.includes('total-turns:99'));
  });

  it('focused preset is the default for unrecognised preset values', () => {
    // TypeScript prevents invalid values, but we can test the focused default
    const ctx = { ...emptyCtx(), autopilot: { active: true, current_phase: 'exec' } };
    // focused includes autopilot; minimal does not
    assert.ok(renderHud(ctx, 'focused').includes('autopilot'));
    assert.ok(!renderHud(ctx, 'minimal').includes('autopilot'));
  });
});

// ── Separator ─────────────────────────────────────────────────────────────────

describe('renderHud – separator', () => {
  it('joins multiple elements with a dim pipe separator', () => {
    const ctx = {
      ...emptyCtx(),
      gitBranch: 'main',
      ralph: { active: true, iteration: 2, max_iterations: 10 },
    };
    const result = renderHud(ctx, 'focused');
    // SEP = dim(' | ') = '\x1b[2m | \x1b[0m'
    assert.ok(result.includes(`${DIM} | ${RESET}`));
  });

  it('does not include the separator when only one element is present', () => {
    const ctx = { ...emptyCtx(), gitBranch: 'solo' };
    const result = renderHud(ctx, 'focused');
    assert.ok(!result.includes(' | '));
  });
});

describe('renderHud – wrapping', () => {
  it('wraps long HUD output across multiple lines when width is constrained', () => {
    const ctx = {
      ...emptyCtx(),
      gitBranch: 'feature/very-long-branch-name',
      ralph: { active: true, iteration: 3, max_iterations: 10 },
      ultrawork: { active: true },
      metrics: { session_turns: 12, total_turns: 12, last_activity: new Date().toISOString() },
      session: { session_id: 'sess-wrap-1', started_at: new Date().toISOString() },
      hudNotify: { last_turn_at: new Date().toISOString(), turn_count: 12 },
    };
    const result = stripSgr(renderHud(ctx, 'focused', { maxWidth: 32, maxLines: 5 }));
    assert.ok(result.includes('\n'));
    assert.ok(result.split('\n').length <= 5);
  });

  it('caps wrapped HUD output at the requested max line count', () => {
    const ctx = {
      ...emptyCtx(),
      gitBranch: 'feature/very-long-branch-name',
      ralph: { active: true, iteration: 3, max_iterations: 10 },
      ultrawork: { active: true },
      autopilot: { active: true, current_phase: 'planning' },
      ralplan: { active: true, current_phase: 'review' },
      deepInterview: { active: true, current_phase: 'intent-first' },
      autoresearch: { active: true, current_phase: 'running' },
      ultraqa: { active: true, current_phase: 'diagnose' },
      team: { active: true, agent_count: 3 },
      metrics: {
        session_turns: 12,
        total_turns: 12,
        last_activity: new Date().toISOString(),
        session_total_tokens: 10_000,
        five_hour_limit_pct: 80,
        weekly_limit_pct: 40,
      },
      session: { session_id: 'sess-wrap-2', started_at: new Date().toISOString() },
      hudNotify: { last_turn_at: new Date().toISOString(), turn_count: 12 },
    };
    const result = stripSgr(renderHud(ctx, 'full', { maxWidth: 22, maxLines: 3 }));
    assert.equal(result.split('\n').length, 3);
    assert.ok(result.includes('…'));
  });
});

// ── Sanitization ─────────────────────────────────────────────────────────────

describe('renderHud – sanitization', () => {
  it('strips terminal control characters from dynamic state text', () => {
    const injected = 'safe\x1b]8;;https://evil.example\x07click\x1b]8;;\x07\nnext';
    const ctx = {
      ...emptyCtx(),
      gitBranch: injected,
      autopilot: { active: true, current_phase: injected },
      ralplan: { active: true, current_phase: injected },
      deepInterview: { active: true, current_phase: injected, input_lock_active: true },
      autoresearch: { active: true, current_phase: injected },
      ultraqa: { active: true, current_phase: injected },
      team: { active: true, team_name: injected },
    };

    const plain = stripSgr(renderHud(ctx, 'focused'));
    assert.doesNotMatch(plain, /[\x00-\x1f\x7f-\x9f]/);
    assert.ok(plain.includes('safe]8;;https://evil.exampleclick]8;;next'));
  });
});
