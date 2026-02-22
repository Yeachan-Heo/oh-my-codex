/**
 * Unit tests for the layered notify-hook sub-modules.
 *
 * These tests import the extracted modules directly (no spawnSync, no tmux,
 * no file system) to verify pure logic in isolation — the main benefit of the
 * module split introduced in issue #177.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, '..', '..', '..', 'scripts');

async function loadModule(rel: string) {
  return import(pathToFileURL(join(SCRIPTS_DIR, rel)).href);
}

// ---------------------------------------------------------------------------
// utils.js
// ---------------------------------------------------------------------------
describe('notify-hook/utils – asNumber', () => {
  it('returns numeric value for a finite number', async () => {
    const { asNumber } = await loadModule('notify-hook/utils.js');
    assert.equal(asNumber(42), 42);
    assert.equal(asNumber(0), 0);
    assert.equal(asNumber(-1.5), -1.5);
  });

  it('parses numeric strings', async () => {
    const { asNumber } = await loadModule('notify-hook/utils.js');
    assert.equal(asNumber('7'), 7);
    assert.equal(asNumber('  3.14  '), 3.14);
  });

  it('returns null for non-numeric values', async () => {
    const { asNumber } = await loadModule('notify-hook/utils.js');
    assert.equal(asNumber(NaN), null);
    assert.equal(asNumber(Infinity), null);
    assert.equal(asNumber('abc'), null);
    assert.equal(asNumber(null), null);
    assert.equal(asNumber(undefined), null);
    assert.equal(asNumber(''), null);
  });
});

describe('notify-hook/utils – safeString', () => {
  it('returns the string as-is', async () => {
    const { safeString } = await loadModule('notify-hook/utils.js');
    assert.equal(safeString('hello'), 'hello');
    assert.equal(safeString(''), '');
  });

  it('returns fallback for null/undefined', async () => {
    const { safeString } = await loadModule('notify-hook/utils.js');
    assert.equal(safeString(null), '');
    assert.equal(safeString(undefined), '');
    assert.equal(safeString(null, 'n/a'), 'n/a');
  });

  it('coerces non-strings', async () => {
    const { safeString } = await loadModule('notify-hook/utils.js');
    assert.equal(safeString(42), '42');
    assert.equal(safeString(true), 'true');
  });
});

describe('notify-hook/utils – isTerminalPhase', () => {
  it('returns true for terminal phases', async () => {
    const { isTerminalPhase } = await loadModule('notify-hook/utils.js');
    assert.equal(isTerminalPhase('complete'), true);
    assert.equal(isTerminalPhase('failed'), true);
    assert.equal(isTerminalPhase('cancelled'), true);
  });

  it('returns false for non-terminal phases', async () => {
    const { isTerminalPhase } = await loadModule('notify-hook/utils.js');
    assert.equal(isTerminalPhase('running'), false);
    assert.equal(isTerminalPhase('pending'), false);
    assert.equal(isTerminalPhase(''), false);
    assert.equal(isTerminalPhase(undefined), false);
  });
});

describe('notify-hook/utils – clampPct', () => {
  it('rounds fractional values in [0,1] to percentage', async () => {
    const { clampPct } = await loadModule('notify-hook/utils.js');
    assert.equal(clampPct(0.5), 50);
    assert.equal(clampPct(1), 100);
    assert.equal(clampPct(0), 0);
  });

  it('clamps values above 100', async () => {
    const { clampPct } = await loadModule('notify-hook/utils.js');
    assert.equal(clampPct(150), 100);
  });

  it('clamps negative values to 0', async () => {
    const { clampPct } = await loadModule('notify-hook/utils.js');
    assert.equal(clampPct(-5), 0);
  });

  it('returns null for non-finite input', async () => {
    const { clampPct } = await loadModule('notify-hook/utils.js');
    assert.equal(clampPct(NaN), null);
    assert.equal(clampPct(Infinity), null);
  });
});

// ---------------------------------------------------------------------------
// auto-nudge.js – detectStallPattern
// ---------------------------------------------------------------------------
describe('notify-hook/auto-nudge – detectStallPattern', () => {
  it('detects default stall patterns case-insensitively', async () => {
    const { detectStallPattern, DEFAULT_STALL_PATTERNS } = await loadModule('notify-hook/auto-nudge.js');
    assert.equal(detectStallPattern('Would you like me to continue?', DEFAULT_STALL_PATTERNS), true);
    assert.equal(detectStallPattern('WOULD YOU LIKE me to continue?', DEFAULT_STALL_PATTERNS), true);
    assert.equal(detectStallPattern('Shall I proceed?', DEFAULT_STALL_PATTERNS), true);
    assert.equal(detectStallPattern('If you want, I can refactor.', DEFAULT_STALL_PATTERNS), true);
    assert.equal(detectStallPattern('Let me know if you need more help.', DEFAULT_STALL_PATTERNS), true);
    assert.equal(detectStallPattern('Ready to proceed whenever you are.', DEFAULT_STALL_PATTERNS), true);
  });

  it('returns false when no stall pattern present', async () => {
    const { detectStallPattern, DEFAULT_STALL_PATTERNS } = await loadModule('notify-hook/auto-nudge.js');
    assert.equal(detectStallPattern('All tests pass. Build succeeded.', DEFAULT_STALL_PATTERNS), false);
    assert.equal(detectStallPattern('Refactoring complete.', DEFAULT_STALL_PATTERNS), false);
    assert.equal(detectStallPattern('', DEFAULT_STALL_PATTERNS), false);
  });

  it('works with custom patterns', async () => {
    const { detectStallPattern } = await loadModule('notify-hook/auto-nudge.js');
    const custom = ['awaiting approval'];
    assert.equal(detectStallPattern('Changes staged. Awaiting approval.', custom), true);
    assert.equal(detectStallPattern('Would you like me to proceed?', custom), false);
  });

  it('focuses detection on the last few lines (hotZone)', async () => {
    const { detectStallPattern, DEFAULT_STALL_PATTERNS } = await loadModule('notify-hook/auto-nudge.js');
    // Stall phrase only in the last line — should detect
    const text = 'Line 1\nLine 2\nLine 3\nLine 4\nWould you like me to continue?';
    assert.equal(detectStallPattern(text, DEFAULT_STALL_PATTERNS), true);
  });

  it('handles null/non-string input gracefully', async () => {
    const { detectStallPattern, DEFAULT_STALL_PATTERNS } = await loadModule('notify-hook/auto-nudge.js');
    assert.equal(detectStallPattern(null, DEFAULT_STALL_PATTERNS), false);
    assert.equal(detectStallPattern(undefined, DEFAULT_STALL_PATTERNS), false);
    assert.equal(detectStallPattern(42, DEFAULT_STALL_PATTERNS), false);
  });
});

// ---------------------------------------------------------------------------
// auto-nudge.js – normalizeAutoNudgeConfig
// ---------------------------------------------------------------------------
describe('notify-hook/auto-nudge – normalizeAutoNudgeConfig', () => {
  it('returns defaults when called with null', async () => {
    const { normalizeAutoNudgeConfig, DEFAULT_STALL_PATTERNS } = await loadModule('notify-hook/auto-nudge.js');
    const cfg = normalizeAutoNudgeConfig(null);
    assert.equal(cfg.enabled, true);
    assert.deepEqual(cfg.patterns, DEFAULT_STALL_PATTERNS);
    assert.equal(cfg.response, 'yes, proceed');
    assert.equal(cfg.delaySec, 3);
    assert.equal(cfg.maxNudgesPerSession, Infinity);
  });

  it('respects enabled=false', async () => {
    const { normalizeAutoNudgeConfig } = await loadModule('notify-hook/auto-nudge.js');
    const cfg = normalizeAutoNudgeConfig({ enabled: false });
    assert.equal(cfg.enabled, false);
  });

  it('accepts custom response string', async () => {
    const { normalizeAutoNudgeConfig } = await loadModule('notify-hook/auto-nudge.js');
    const cfg = normalizeAutoNudgeConfig({ response: 'continue now' });
    assert.equal(cfg.response, 'continue now');
  });

  it('falls back to defaults for empty response string', async () => {
    const { normalizeAutoNudgeConfig } = await loadModule('notify-hook/auto-nudge.js');
    const cfg = normalizeAutoNudgeConfig({ response: '   ' });
    assert.equal(cfg.response, 'yes, proceed');
  });

  it('accepts valid delaySec', async () => {
    const { normalizeAutoNudgeConfig } = await loadModule('notify-hook/auto-nudge.js');
    assert.equal(normalizeAutoNudgeConfig({ delaySec: 0 }).delaySec, 0);
    assert.equal(normalizeAutoNudgeConfig({ delaySec: 5 }).delaySec, 5);
  });

  it('rejects out-of-range delaySec', async () => {
    const { normalizeAutoNudgeConfig } = await loadModule('notify-hook/auto-nudge.js');
    assert.equal(normalizeAutoNudgeConfig({ delaySec: -1 }).delaySec, 3);
    assert.equal(normalizeAutoNudgeConfig({ delaySec: 999 }).delaySec, 3);
  });

  it('accepts custom patterns array', async () => {
    const { normalizeAutoNudgeConfig } = await loadModule('notify-hook/auto-nudge.js');
    const cfg = normalizeAutoNudgeConfig({ patterns: ['awaiting input', 'ping me'] });
    assert.deepEqual(cfg.patterns, ['awaiting input', 'ping me']);
  });

  it('filters empty strings from patterns', async () => {
    const { normalizeAutoNudgeConfig, DEFAULT_STALL_PATTERNS } = await loadModule('notify-hook/auto-nudge.js');
    // Empty array → fall back to defaults
    const cfg = normalizeAutoNudgeConfig({ patterns: [] });
    assert.deepEqual(cfg.patterns, DEFAULT_STALL_PATTERNS);
  });
});

// ---------------------------------------------------------------------------
// team-worker.js – parseTeamWorkerEnv
// ---------------------------------------------------------------------------
describe('notify-hook/team-worker – parseTeamWorkerEnv', () => {
  it('parses valid team/worker strings', async () => {
    const { parseTeamWorkerEnv } = await loadModule('notify-hook/team-worker.js');
    assert.deepEqual(parseTeamWorkerEnv('fix-ts/worker-1'), { teamName: 'fix-ts', workerName: 'worker-1' });
    assert.deepEqual(parseTeamWorkerEnv('my-team/worker-99'), { teamName: 'my-team', workerName: 'worker-99' });
    assert.deepEqual(parseTeamWorkerEnv('a/worker-0'), { teamName: 'a', workerName: 'worker-0' });
  });

  it('returns null for invalid or empty values', async () => {
    const { parseTeamWorkerEnv } = await loadModule('notify-hook/team-worker.js');
    assert.equal(parseTeamWorkerEnv(''), null);
    assert.equal(parseTeamWorkerEnv(null), null);
    assert.equal(parseTeamWorkerEnv(undefined), null);
    assert.equal(parseTeamWorkerEnv('no-slash'), null);
    assert.equal(parseTeamWorkerEnv('team/not-a-worker'), null);
    assert.equal(parseTeamWorkerEnv('UPPER/worker-1'), null); // team name must be lowercase
  });

  it('rejects team names that are too long', async () => {
    const { parseTeamWorkerEnv } = await loadModule('notify-hook/team-worker.js');
    const longName = 'a'.repeat(31); // exceeds 30-char limit
    assert.equal(parseTeamWorkerEnv(`${longName}/worker-1`), null);
  });
});

// ---------------------------------------------------------------------------
// state-io.js – pruneRecentTurns / pruneRecentKeys
// ---------------------------------------------------------------------------
describe('notify-hook/state-io – pruneRecentTurns', () => {
  it('removes entries older than 24 hours', async () => {
    const { pruneRecentTurns } = await loadModule('notify-hook/state-io.js');
    const now = Date.now();
    const old = now - 25 * 60 * 60 * 1000; // 25h ago
    const recent = now - 1000;
    const result = pruneRecentTurns({ 'old-key': old, 'recent-key': recent }, now);
    assert.equal('old-key' in result, false);
    assert.equal('recent-key' in result, true);
  });

  it('returns empty object for null input', async () => {
    const { pruneRecentTurns } = await loadModule('notify-hook/state-io.js');
    assert.deepEqual(pruneRecentTurns(null, Date.now()), {});
  });

  it('caps retained entries at 2000', async () => {
    const { pruneRecentTurns } = await loadModule('notify-hook/state-io.js');
    const now = Date.now();
    const turns: Record<string, number> = {};
    for (let i = 0; i < 2500; i++) turns[`k${i}`] = now;
    const result = pruneRecentTurns(turns, now);
    assert.ok(Object.keys(result).length <= 2000);
  });
});

describe('notify-hook/state-io – normalizeNotifyState', () => {
  it('returns defaults for null input', async () => {
    const { normalizeNotifyState } = await loadModule('notify-hook/state-io.js');
    const s = normalizeNotifyState(null);
    assert.deepEqual(s.recent_turns, {});
    assert.equal(s.last_event_at, '');
  });

  it('preserves valid recent_turns', async () => {
    const { normalizeNotifyState } = await loadModule('notify-hook/state-io.js');
    const s = normalizeNotifyState({ recent_turns: { key: 123 }, last_event_at: '2025-01-01T00:00:00Z' });
    assert.deepEqual(s.recent_turns, { key: 123 });
    assert.equal(s.last_event_at, '2025-01-01T00:00:00Z');
  });
});
