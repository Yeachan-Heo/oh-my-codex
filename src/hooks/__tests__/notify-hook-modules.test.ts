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
// operational-events.js
// ---------------------------------------------------------------------------
describe('notify-hook/operational-events – classifyExecCommand', () => {
  it('classifies concrete test commands without matching search commands', async () => {
    const { classifyExecCommand } = await loadModule('notify-hook/operational-events.js');
    assert.deepEqual(classifyExecCommand('npm test'), { kind: 'test', command: 'npm test' });
    assert.equal(classifyExecCommand('rg "npm test" src'), null);
  });

  it('classifies gh pr create commands', async () => {
    const { classifyExecCommand } = await loadModule('notify-hook/operational-events.js');
    assert.deepEqual(classifyExecCommand('gh pr create --base dev --fill'), {
      kind: 'pr-create',
      command: 'gh pr create --base dev --fill',
    });
  });
});

describe('notify-hook/operational-events – parseCommandResult', () => {
  it('extracts exit code and PR metadata from command output', async () => {
    const { parseCommandResult } = await loadModule('notify-hook/operational-events.js');
    const parsed = parseCommandResult('Process exited with code 0\nOutput:\nhttps://github.com/acme/repo/pull/663\n');
    assert.equal(parsed.exit_code, 0);
    assert.equal(parsed.success, true);
    assert.equal(parsed.pr_number, 663);
    assert.equal(parsed.pr_url, 'https://github.com/acme/repo/pull/663');
  });

  it('extracts error summary for failed commands', async () => {
    const { parseCommandResult } = await loadModule('notify-hook/operational-events.js');
    const parsed = parseCommandResult('Process exited with code 1\nstderr:\nError: test suite failed\n');
    assert.equal(parsed.exit_code, 1);
    assert.equal(parsed.success, false);
    assert.match(parsed.error_summary || '', /failed/i);
  });
});

describe('notify-hook/operational-events – buildOperationalContext', () => {
  it('resolves a stable session_name from cwd + session id', async () => {
    const { buildOperationalContext } = await loadModule('notify-hook/operational-events.js');
    const sessionId = 'omx-issue-663-session';
    const originalTmux = process.env.TMUX;
    delete process.env.TMUX;
    try {
      const context = buildOperationalContext({
        cwd: process.cwd(),
        normalizedEvent: 'pr-created',
        sessionId,
        status: 'finished',
      });

      assert.equal(typeof context.session_name, 'string');
      assert.notEqual(context.session_name, sessionId);
      assert.match(context.session_name || '', /^omx-/);
      assert.match(context.session_name || '', /issue-663-session/);
    } finally {
      if (originalTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = originalTmux;
    }
  });
});

describe('notify-hook/operational-events – deriveAssistantSignalEvents', () => {
  it('detects handoff-needed and retry-needed from assistant text', async () => {
    const { deriveAssistantSignalEvents } = await loadModule('notify-hook/operational-events.js');
    const signals = deriveAssistantSignalEvents('If you want, next I can do one of two things: retry the flaky step or handoff the follow-up.');
    assert.equal(signals.some((signal: { event?: string }) => signal.event === 'handoff-needed'), true);
    assert.equal(signals.some((signal: { event?: string }) => signal.event === 'retry-needed'), true);
  });

  it('avoids duplicate finished/failed assistant lifecycle signals', async () => {
    const { deriveAssistantSignalEvents } = await loadModule('notify-hook/operational-events.js');
    assert.equal(
      deriveAssistantSignalEvents('Implementation completed. Final summary ready.').some((signal: { event?: string }) => signal.event === 'finished'),
      false,
    );
    assert.equal(
      deriveAssistantSignalEvents('The operation failed with error: unable to continue.').some((signal: { event?: string }) => signal.event === 'failed'),
      false,
    );
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
    assert.equal(detectStallPattern('I’M READY TO take the next step.', DEFAULT_STALL_PATTERNS), true);
    assert.equal(detectStallPattern('KEEP GOING and I will finish the patch.', DEFAULT_STALL_PATTERNS), true);
  });

  it('detects team-worker follow-up phrases like continue with and next step', async () => {
    const { detectStallPattern, DEFAULT_STALL_PATTERNS } = await loadModule('notify-hook/auto-nudge.js');
    assert.equal(detectStallPattern('I can continue with the worker follow-up from here.', DEFAULT_STALL_PATTERNS), true);
    assert.equal(detectStallPattern('The next step is to finish the worker handoff.', DEFAULT_STALL_PATTERNS), true);
    assert.equal(detectStallPattern('The NEXT STEPS would be running tests and posting the summary.', DEFAULT_STALL_PATTERNS), true);
    assert.equal(detectStallPattern('We can pick up with the cleanup after this.', DEFAULT_STALL_PATTERNS), true);
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

  it('ignores prior OMX injection lines so injected text cannot self-trigger detection', async () => {
    const { detectStallPattern, DEFAULT_STALL_PATTERNS } = await loadModule('notify-hook/auto-nudge.js');
    const text = 'Completed the change.\nyes, proceed [OMX_TMUX_INJECT]\nkeep going [OMX_TMUX_INJECT]';
    assert.equal(detectStallPattern(text, DEFAULT_STALL_PATTERNS), false);
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
// auto-nudge.js – skill-active state phase helpers
// ---------------------------------------------------------------------------
describe('notify-hook/auto-nudge – normalizeSkillActiveState', () => {
  it('returns null for invalid input', async () => {
    const { normalizeSkillActiveState } = await loadModule('notify-hook/auto-nudge.js');
    assert.equal(normalizeSkillActiveState(null), null);
    assert.equal(normalizeSkillActiveState({}), null);
  });

  it('normalizes valid skill-active state', async () => {
    const { normalizeSkillActiveState } = await loadModule('notify-hook/auto-nudge.js');
    const state = normalizeSkillActiveState({
      version: 1,
      active: true,
      skill: 'autopilot',
      keyword: 'autopilot',
      phase: 'EXECUTING',
      source: 'keyword-detector',
    });
    assert.ok(state);
    assert.equal(state.skill, 'autopilot');
    assert.equal(state.phase, 'executing');
    assert.equal(state.active, true);
  });
});

describe('notify-hook/auto-nudge – inferSkillPhaseFromText', () => {
  it('maps planning/executing/reviewing/completing signals', async () => {
    const { inferSkillPhaseFromText } = await loadModule('notify-hook/auto-nudge.js');
    assert.equal(inferSkillPhaseFromText('Here is the plan with next steps.'), 'planning');
    assert.equal(inferSkillPhaseFromText('I implemented the patch and updated files.'), 'executing');
    assert.equal(inferSkillPhaseFromText('I verified with tests and typecheck.'), 'reviewing');
    assert.equal(inferSkillPhaseFromText('All tests pass. Completed with summary.'), 'completing');
  });

  it('falls back to the current phase when no signal is present', async () => {
    const { inferSkillPhaseFromText } = await loadModule('notify-hook/auto-nudge.js');
    assert.equal(inferSkillPhaseFromText('neutral text', 'reviewing'), 'reviewing');
  });
});

describe('notify-hook/auto-nudge – blocked deep-interview auto approvals', () => {
  it('normalizes injected approval text before matching blocked inputs', async () => {
    const { normalizeBlockedAutoApprovalInput } = await loadModule('notify-hook/auto-nudge.js');
    assert.equal(normalizeBlockedAutoApprovalInput(' yes, proceed [OMX_TMUX_INJECT] '), 'yes proceed');
  });

  it('matches each blocked approval keyword or phrase', async () => {
    const { isBlockedAutoApprovalInput, DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS } = await loadModule('notify-hook/auto-nudge.js');
    for (const blocked of DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS) {
      assert.equal(isBlockedAutoApprovalInput(blocked), true, `expected blocked input ${blocked} to match`);
    }
  });

  it('blocks combined yes/proceed injection text', async () => {
    const { isBlockedAutoApprovalInput } = await loadModule('notify-hook/auto-nudge.js');
    assert.equal(isBlockedAutoApprovalInput('yes, proceed'), true);
  });

  it('treats actionable "Next I should ..." replies like continuation approval', async () => {
    const { isBlockedAutoApprovalInput } = await loadModule('notify-hook/auto-nudge.js');
    assert.equal(isBlockedAutoApprovalInput('Next I should update the focused tests.'), true);
    assert.equal(isBlockedAutoApprovalInput('Maybe next I should update the focused tests.'), false);
  });

  it('does not block unrelated responses', async () => {
    const { isBlockedAutoApprovalInput } = await loadModule('notify-hook/auto-nudge.js');
    assert.equal(isBlockedAutoApprovalInput('deep interview is active; auto-approval shortcuts are blocked until the interview finishes.'), false);
  });

  it('infers success/error/abort lock release reasons', async () => {
    const { inferDeepInterviewReleaseReason } = await loadModule('notify-hook/auto-nudge.js');
    const baseState = {
      skill: 'deep-interview',
      phase: 'planning',
      input_lock: { active: true },
    };

    assert.equal(inferDeepInterviewReleaseReason({
      skillState: { ...baseState, phase: 'completing' },
      latestUserInput: '',
      lastMessage: 'Interview summary complete.',
    }), 'success');
    assert.equal(inferDeepInterviewReleaseReason({
      skillState: baseState,
      latestUserInput: '',
      lastMessage: 'Interview failed with error: unable to continue.',
    }), 'error');
    assert.equal(inferDeepInterviewReleaseReason({
      skillState: baseState,
      latestUserInput: 'abort',
      lastMessage: 'Stopping now.',
    }), 'abort');
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

// ---------------------------------------------------------------------------
// payload-parser.js – non-Latin detection + language reminder injection
// ---------------------------------------------------------------------------
describe('notify-hook/payload-parser – language reminder injection', () => {
  it('detects non-Latin script in user input', async () => {
    const { hasNonLatinScript } = await loadModule('notify-hook/payload-parser.js');
    assert.equal(hasNonLatinScript('Привет, как дела?'), true);
    assert.equal(hasNonLatinScript('こんにちは、お願いします'), true);
    assert.equal(hasNonLatinScript('hello world'), false);
  });

  it('injects language reminder for non-Latin input', async () => {
    const { injectLanguageReminder, LANGUAGE_REMINDER_MARKER } = await loadModule('notify-hook/payload-parser.js');
    const prompt = injectLanguageReminder('Continue from current mode state. [OMX_TMUX_INJECT]', '帮我修复这个问题');
    assert.match(prompt, /\[OMX_LANG_REMINDER\]/);
    assert.match(prompt, /Continue in the user's language\./);
    assert.match(prompt, new RegExp(LANGUAGE_REMINDER_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('does not inject reminder for Latin-only text', async () => {
    const { injectLanguageReminder } = await loadModule('notify-hook/payload-parser.js');
    const prompt = injectLanguageReminder('Continue [OMX_TMUX_INJECT]', 'Please fix issue 253');
    assert.equal(prompt, 'Continue [OMX_TMUX_INJECT]');
  });
});
