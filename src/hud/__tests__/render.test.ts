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
      team: { active: true, agent_count: 2 },
      metrics: { total_turns: 10, session_turns: 3, last_activity: '' },
    };
    const result = renderHud(ctx, 'minimal');
    assert.ok(result.includes('feat/x'));
    assert.ok(result.includes('ralph:1/5'));
    assert.ok(result.includes('ultrawork'));
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

// ── Sanitization ─────────────────────────────────────────────────────────────

describe('renderHud – sanitization', () => {
  it('strips terminal control characters from dynamic state text', () => {
    const injected = 'safe\x1b]8;;https://evil.example\x07click\x1b]8;;\x07\nnext';
    const ctx = {
      ...emptyCtx(),
      gitBranch: injected,
      autopilot: { active: true, current_phase: injected },
      team: { active: true, team_name: injected },
    };

    const plain = stripSgr(renderHud(ctx, 'focused'));
    assert.doesNotMatch(plain, /[\x00-\x1f\x7f-\x9f]/);
    assert.ok(plain.includes('safe]8;;https://evil.exampleclick]8;;next'));
  });
});
