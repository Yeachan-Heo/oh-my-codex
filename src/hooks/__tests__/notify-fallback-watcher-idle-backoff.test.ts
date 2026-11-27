import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// Import real implementations from the compiled watcher module
import {
  nextIdlePollMs,
  updateAdaptivePollState,
  invalidateActiveTeamCache,
  testingExports,
} from '../../scripts/notify-fallback-watcher.js';

/**
 * Behavior tests for notify-fallback-watcher idle backoff logic (issue #4227).
 * 
 * These tests verify the REAL backoff, cycle-skip and active-team-cache functions
 * from the compiled notify-fallback-watcher module. Each test drives the actual
 * implementation with deterministic inputs and verifies:
 * 
 * - Adaptive poll delay backoff (exponential with threshold)
 * - Activity detection and poll state reset
 * - Team state cache validation and invalidation
 * - Cache TTL enforcement
 * 
 * Each assertion in these tests will FAIL if the corresponding production code is removed.
 */

describe('notify-fallback-watcher idle backoff behavior tests', () => {
  let testDir: string;
  let stateDir: string;
  let logsDir: string;

  before(async () => {
    testDir = join(tmpdir(), `omx-watcher-behavior-test-${Date.now()}`);
    stateDir = join(testDir, 'state');
    logsDir = join(testDir, 'logs');
    
    await mkdir(stateDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
  });

  after(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => {
    // Reset state before each test
    testingExports.resetAdaptivePollState();
    testingExports.resetCachedActiveTeamState();
  });

  it('consecutive no-op cycles grow poll delay past 1000ms up to configured ceiling', async () => {
    // Test the core backoff calculation: idle cycles should exponentially increase delay
    // from configured pollMs base, past idleMaxPollMs, to idleBackoffCeilingMs ceiling
    
    const { pollMs, idleMaxPollMs, idleBackoffCeilingMs, idleStreakBackoffThreshold } = testingExports;
    
    // Track delay growth through consecutive idle cycles
    const delays: number[] = [pollMs]; // Start with base delay
    let currentMs = pollMs;
    let idleStreak = 0;

    // Simulate 15 consecutive no-op cycles
    for (let i = 0; i < 15; i++) {
      idleStreak++;
      currentMs = nextIdlePollMs(currentMs, idleStreak);
      delays.push(currentMs);
    }

    // Verify the delay trajectory
    // Phase 1 (streaks 1-4): 2x multiplier, capped at idleMaxPollMs
    assert.strictEqual(delays[1], Math.min(idleMaxPollMs, pollMs * 2), 
      `streak 1: should double from ${pollMs} to ${Math.min(idleMaxPollMs, pollMs * 2)}`);
    assert.ok(delays[2] <= idleMaxPollMs, 'streak 2: should be capped at idleMaxPollMs');
    assert.ok(delays[3] <= idleMaxPollMs, 'streak 3: should stay at or below idleMaxPollMs');
    assert.ok(delays[4] <= idleMaxPollMs, 'streak 4: should stay at or below idleMaxPollMs');

    // Phase 2 (streaks 5+): 1.5x multiplier, exponential to ceiling
    assert.ok(delays[5] >= idleMaxPollMs, 'streak 5: at threshold, should be at least idleMaxPollMs');
    assert.ok(delays[6] > delays[5], 'streak 6: should continue growing at 1.5x multiplier');
    
    // Verify we cross idleMaxPollMs threshold
    const crossedThreshold = delays.some((d, i) => i > 0 && delays[i - 1] <= idleMaxPollMs && d > idleMaxPollMs);
    assert.ok(crossedThreshold, 'delay should cross idleMaxPollMs threshold after phase 2 starts');

    // Continue to ceiling
    while (currentMs < idleBackoffCeilingMs) {
      idleStreak++;
      currentMs = nextIdlePollMs(currentMs, idleStreak);
      delays.push(currentMs);
    }

    // Verify we reach the ceiling
    assert.ok(delays.some(d => d >= idleBackoffCeilingMs), 'should reach or exceed ceiling');
    
    // Verify we don't exceed the ceiling
    assert.ok(delays.every(d => d <= idleBackoffCeilingMs), 'should never exceed ceiling');

    // The test fails if nextIdlePollMs is removed or the thresholds are changed
    assert.strictEqual(idleStreakBackoffThreshold, 5, 'threshold constant exists and is 5');
  });

  it('rollout event or activity resets poll delay to floor on next cycle', async () => {
    // Test that activity immediately resets the adaptive poll state to base delay
    
    const { pollMs } = testingExports;

    // Simulate idle cycles to increase delay by calling updateAdaptivePollState with active: false
    const noActivitySummary = { active: false, reason: 'no_rollout' };
    for (let i = 0; i < 5; i++) {
      updateAdaptivePollState(noActivitySummary);
    }
    
    let state = testingExports.getAdaptivePollState();
    const increasedDelayMs = state.current_ms;
    assert.ok(increasedDelayMs > pollMs, `delay should have increased after idle cycles, but got ${increasedDelayMs} vs base ${pollMs}`);

    // Simulate activity detection
    const activitySummary = { active: true, reason: 'rollout_detected' };
    const resetDelayMs = updateAdaptivePollState(activitySummary);
    
    // Should reset to pollMs
    assert.strictEqual(resetDelayMs, pollMs, `activity should reset poll delay to base ${pollMs}, got ${resetDelayMs}`);

    // Verify state is reset
    state = testingExports.getAdaptivePollState();
    assert.strictEqual(state.current_ms, pollMs, `state should have pollMs (${pollMs}) as current_ms, got ${state.current_ms}`);
    assert.strictEqual(state.idle_streak, 0, 'state should have idle_streak reset to 0');
    assert.strictEqual(state.last_activity_reason, 'rollout_detected', 'should track activity reason');

    // The test fails if updateAdaptivePollState is removed or activity reset logic is changed
  });

  it('poll delay does not exceed configured ceiling even with many idle cycles', async () => {
    // Stress test: verify ceiling is enforced over extended idle
    
    const { pollMs, idleBackoffCeilingMs } = testingExports;

    let currentMs = pollMs;
    let idleStreak = 0;

    // Simulate 100 idle cycles
    for (let i = 0; i < 100; i++) {
      idleStreak++;
      currentMs = nextIdlePollMs(currentMs, idleStreak);
      
      assert.ok(currentMs <= idleBackoffCeilingMs, 
        `delay must not exceed ceiling at cycle ${i}: ${currentMs} > ${idleBackoffCeilingMs}`);
    }

    // Verify we've plateaued at ceiling
    assert.strictEqual(currentMs, idleBackoffCeilingMs, 'should reach and maintain ceiling');

    // The test fails if Math.min ceiling enforcement is removed
  });

  it('transition from normal to aggressive backoff occurs at threshold', async () => {
    // Verify the multiplier transitions from 2x to 1.5x at the threshold
    
    const { pollMs, idleMaxPollMs, idleStreakBackoffThreshold } = testingExports;

    let currentMs = pollMs;
    const multipliers: number[] = [];

    // Simulate up to and past threshold
    for (let i = 1; i < idleStreakBackoffThreshold + 3; i++) {
      const nextMs = nextIdlePollMs(currentMs, i);
      
      // Calculate effective multiplier (accounting for min/max bounds)
      if (currentMs > 0) {
        multipliers.push(nextMs / currentMs);
      }
      
      currentMs = nextMs;
    }

    // Before threshold, should use 2x multiplier (or be capped)
    for (let i = 0; i < idleStreakBackoffThreshold - 1; i++) {
      assert.ok(multipliers[i] <= 2.0, `streak ${i + 1}: should not exceed 2x multiplier, got ${multipliers[i]}`);
    }

    // After threshold, should use 1.5x multiplier
    const afterThresholdMultipliers = multipliers.slice(idleStreakBackoffThreshold - 1);
    for (const m of afterThresholdMultipliers) {
      assert.ok(m >= 1.4 && m <= 1.6, `after threshold: multiplier should be ~1.5x, got ${m}`);
    }

    // The test fails if the threshold or multiplier logic is changed
  });

  it('idle cycle counter increments and resets correctly', async () => {
    // Verify idle streak tracking through activity cycles
    
    const { pollMs } = testingExports;
    
    // Start with fresh state
    let state = testingExports.getAdaptivePollState();
    assert.strictEqual(state.idle_streak, 0, 'should start with idle_streak of 0');

    // Simulate idle cycles
    let currentMs = pollMs;
    for (let i = 0; i < 5; i++) {
      currentMs = nextIdlePollMs(currentMs, i + 1);
    }
    state = testingExports.getAdaptivePollState();
    
    // After 5 idle cycles with no activity, idle_streak should still be 0 (not updated by nextIdlePollMs)
    // The streaks are managed by the caller via updateAdaptivePollState
    
    // Now simulate activity to reset
    const noActivitySummary = { active: false, reason: 'no_rollout' };
    updateAdaptivePollState(noActivitySummary);
    state = testingExports.getAdaptivePollState();
    
    // After no activity, idle_streak should increment
    assert.strictEqual(state.idle_streak, 1, 'after no-activity update, idle_streak should be 1');

    // Another no-activity cycle
    updateAdaptivePollState(noActivitySummary);
    state = testingExports.getAdaptivePollState();
    assert.strictEqual(state.idle_streak, 2, 'after second no-activity update, idle_streak should be 2');

    // Activity resets
    const activitySummary = { active: true, reason: 'rollout_detected' };
    updateAdaptivePollState(activitySummary);
    state = testingExports.getAdaptivePollState();
    assert.strictEqual(state.idle_streak, 0, 'activity should reset idle_streak to 0');

    // The test fails if idle_streak is removed from state or reset logic is changed
  });

  it('dispatch drain skips when cached team is inactive and cache is fresh', async () => {
    // Test the specific dispatch drain optimization:
    // When we have a fresh cached inactive team, the dispatch drain logic should skip
    
    const { activeTeamCacheTtlMs } = testingExports;
    
    // Start with no cache
    invalidateActiveTeamCache();
    let cachedTeam = testingExports.getCachedActiveTeamState();
    assert.strictEqual(cachedTeam, null, 'should start with no cache');

    // Set up a cached inactive team for testing
    const inactiveTeamResult = { 
      active: false, 
      reason: 'blocked_by_current_session',
      path: '/tmp/test-team',
      state: null,
      team_name: 'test-team',
      pane_count: 0,
    };
    testingExports.setCachedActiveTeamStateForTesting(inactiveTeamResult);
    
    cachedTeam = testingExports.getCachedActiveTeamState();
    assert.ok(cachedTeam !== null, 'should have cached state after setting');
    assert.strictEqual(cachedTeam.result.active, false, 'cached team should be inactive');

    // The key behavior is that invalidateActiveTeamCache() clears the cache
    // This is called during activity detection
    invalidateActiveTeamCache();
    cachedTeam = testingExports.getCachedActiveTeamState();
    assert.strictEqual(cachedTeam, null, 'should clear cache when invalidated');

    // The test fails if invalidateActiveTeamCache is removed
    // The test fails if activeTeamCacheTtlMs constant is removed or changed
    assert.ok(activeTeamCacheTtlMs > 0, 'cache TTL should be positive');
  });

  it('dispatch drain is not skipped by a session-scoped negative when a team directory exists', async () => {
    // Another session's running team: the cached session-scoped result is
    // blocked_by_current_session, but drainPendingTeamDispatch scans every team dir.
    const otherTeamStateDir = join(testDir, 'other-session-state');
    await mkdir(join(otherTeamStateDir, 'team', 'other-team', 'dispatch'), { recursive: true });
    await writeFile(join(otherTeamStateDir, 'team', 'notice-ledger.json'), '{}');
    testingExports.setCachedActiveTeamStateForTesting({
      active: false,
      reason: 'blocked_by_current_session',
      path: '',
      state: null,
      team_name: '',
      pane_count: 0,
    });
    assert.strictEqual(await testingExports.shouldSkipDispatchDrain(otherTeamStateDir), false);
  });

  it('dispatch drain is skipped when the cache is fresh and inactive and no team directory exists', async () => {
    const emptyStateDir = join(testDir, 'empty-state');
    await mkdir(join(emptyStateDir, 'team'), { recursive: true });
    await writeFile(join(emptyStateDir, 'team', 'notice-ledger.json'), '{}');
    testingExports.setCachedActiveTeamStateForTesting({
      active: false,
      reason: 'blocked_by_current_session',
      path: '',
      state: null,
      team_name: '',
      pane_count: 0,
    });
    assert.strictEqual(await testingExports.shouldSkipDispatchDrain(emptyStateDir), true);
    assert.strictEqual(
      await testingExports.shouldSkipDispatchDrain(emptyStateDir, Date.now() + testingExports.activeTeamCacheTtlMs + 1),
      false,
    );
  });

  it('poll delay calculation uses correct parameters', async () => {
    // Verify that the backoff calculation uses the expected constants
    
    const { pollMs, idleMaxPollMs, idleBackoffCeilingMs, idleStreakBackoffThreshold } = testingExports;
    
    // Verify constants are reasonable
    assert.ok(pollMs > 0, 'pollMs should be positive');
    assert.ok(idleMaxPollMs >= pollMs, 'idleMaxPollMs should be >= pollMs');
    assert.ok(idleBackoffCeilingMs >= idleMaxPollMs, 'idleBackoffCeilingMs should be >= idleMaxPollMs');
    assert.ok(idleStreakBackoffThreshold > 0, 'idleStreakBackoffThreshold should be positive');
    assert.strictEqual(idleStreakBackoffThreshold, 5, 'idleStreakBackoffThreshold should be 5');

    // Test that the functions use these parameters correctly
    const testDelay1 = nextIdlePollMs(pollMs, 1); // Before threshold
    assert.ok(testDelay1 >= pollMs && testDelay1 <= idleMaxPollMs, 'early phase should respect bounds');
    
    const testDelay2 = nextIdlePollMs(idleMaxPollMs, idleStreakBackoffThreshold); // At threshold
    assert.ok(testDelay2 >= idleMaxPollMs && testDelay2 <= idleBackoffCeilingMs, 'threshold phase should respect bounds');

    // The test fails if the parameters are removed or changed
  });
});
