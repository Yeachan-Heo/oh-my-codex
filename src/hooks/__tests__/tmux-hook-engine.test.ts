import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ALLOWED_MODES,
  DEFAULT_MARKER,
  normalizeTmuxHookConfig,
  pickActiveMode,
  evaluateInjectionGuards,
  buildSendKeysArgv,
} from '../../../scripts/tmux-hook-engine.js';

describe('normalizeTmuxHookConfig', () => {
  it('returns safe disabled defaults for missing config', () => {
    const config = normalizeTmuxHookConfig(null);
    assert.equal(config.enabled, false);
    assert.equal(config.valid, false);
    assert.equal(config.reason, 'missing_config');
    assert.equal(config.target, null);
    assert.deepEqual(config.allowed_modes, DEFAULT_ALLOWED_MODES);
    assert.equal(config.marker, DEFAULT_MARKER);
  });

  it('normalizes valid config', () => {
    const config = normalizeTmuxHookConfig({
      enabled: true,
      target: { type: 'session', value: 'omx-work' },
      allowed_modes: ['team'],
      cooldown_ms: 2000,
      max_injections_per_session: 4,
      prompt_template: 'Resume mode {{mode}}',
      marker: '[X]',
      dry_run: true,
      log_level: 'debug',
    });
    assert.equal(config.enabled, true);
    assert.equal(config.valid, true);
    assert.deepEqual(config.target, { type: 'session', value: 'omx-work' });
    assert.deepEqual(config.allowed_modes, ['team']);
    assert.equal(config.cooldown_ms, 2000);
    assert.equal(config.max_injections_per_session, 4);
    assert.equal(config.marker, '[X]');
    assert.equal(config.dry_run, true);
    assert.equal(config.log_level, 'debug');
  });

  it('treats placeholder/unset target values as invalid', () => {
    const placeholderConfig = normalizeTmuxHookConfig({
      enabled: true,
      target: { type: 'pane', value: 'replace-with-tmux-pane-id' },
    });
    assert.equal(placeholderConfig.enabled, true);
    assert.equal(placeholderConfig.valid, false);
    assert.equal(placeholderConfig.reason, 'invalid_target');
    assert.equal(placeholderConfig.target, null);

    const unsetConfig = normalizeTmuxHookConfig({
      enabled: true,
      target: { type: 'session', value: 'unset' },
    });
    assert.equal(unsetConfig.enabled, true);
    assert.equal(unsetConfig.valid, false);
    assert.equal(unsetConfig.reason, 'invalid_target');
    assert.equal(unsetConfig.target, null);
  });
});

describe('pickActiveMode', () => {
  it('chooses by allowed mode order', () => {
    const mode = pickActiveMode(['team', 'ralph'], ['ralph', 'team']);
    assert.equal(mode, 'ralph');
  });

  it('returns null when no allowed mode is active', () => {
    const mode = pickActiveMode(['autopilot'], ['ralph', 'team']);
    assert.equal(mode, null);
  });
});

describe('evaluateInjectionGuards', () => {
  const validConfig = normalizeTmuxHookConfig({
    enabled: true,
    target: { type: 'session', value: 'omx' },
    allowed_modes: ['ralph'],
    cooldown_ms: 1000,
    max_injections_per_session: 2,
    prompt_template: 'Continue [OMX_TMUX_INJECT]',
    marker: '[OMX_TMUX_INJECT]',
    dry_run: false,
    log_level: 'info',
  });

  it('blocks when disabled', () => {
    const cfg = { ...validConfig, enabled: false };
    const guard = evaluateInjectionGuards({
      config: cfg,
      mode: 'ralph',
      sourceText: '',
      assistantMessage: '',
      threadId: 'th',
      turnId: 'tu',
      sessionKey: 'th',
      now: 1000,
      state: {},
    });
    assert.equal(guard.allow, false);
    assert.equal(guard.reason, 'disabled');
  });

  it('blocks input marker loop', () => {
    const guard = evaluateInjectionGuards({
      config: validConfig,
      mode: 'ralph',
      sourceText: `continue ${validConfig.marker}`,
      assistantMessage: '',
      threadId: 'th',
      turnId: 'tu',
      sessionKey: 'th',
      now: 1000,
      state: {},
    });
    assert.equal(guard.allow, false);
    assert.equal(guard.reason, 'loop_guard_input_marker');
  });

  it('blocks with invalid_config when enabled target is placeholder/unset', () => {
    const guard = evaluateInjectionGuards({
      config: normalizeTmuxHookConfig({
        enabled: true,
        target: { type: 'pane', value: 'replace-with-tmux-pane-id' },
      }),
      mode: 'ralph',
      sourceText: '',
      assistantMessage: '',
      threadId: 'th',
      turnId: 'tu',
      sessionKey: 'th',
      now: 1000,
      state: {},
    });
    assert.equal(guard.allow, false);
    assert.equal(guard.reason, 'invalid_config');
  });

  it('blocks duplicates and cooldown and session cap', () => {
    const initial = evaluateInjectionGuards({
      config: validConfig,
      mode: 'ralph',
      sourceText: 'hello',
      assistantMessage: '',
      threadId: 'th',
      turnId: 'tu',
      sessionKey: 'th',
      now: 5000,
      state: {},
    });
    assert.equal(initial.allow, true);
    assert.ok(initial.dedupeKey);

    const duplicate = evaluateInjectionGuards({
      config: validConfig,
      mode: 'ralph',
      sourceText: 'hello',
      assistantMessage: '',
      threadId: 'th',
      turnId: 'tu',
      sessionKey: 'th',
      now: 5001,
      state: { recent_keys: { [initial.dedupeKey!]: 5000 } },
    });
    assert.equal(duplicate.allow, false);
    assert.equal(duplicate.reason, 'duplicate_event');

    const cooldown = evaluateInjectionGuards({
      config: validConfig,
      mode: 'ralph',
      sourceText: 'hello2',
      assistantMessage: '',
      threadId: 'th',
      turnId: 'tu2',
      sessionKey: 'th',
      paneKey: '%1',
      now: 5500,
      state: { last_injection_ts: 5000, session_counts: { th: 1 } },
    });
    assert.equal(cooldown.allow, false);
    assert.equal(cooldown.reason, 'cooldown_active');

    const sessionCap = evaluateInjectionGuards({
      config: validConfig,
      mode: 'ralph',
      sourceText: 'hello3',
      assistantMessage: '',
      threadId: 'th',
      turnId: 'tu3',
      paneKey: '%1',
      now: 8000,
      state: { pane_counts: { '%1': 2 }, last_injection_ts: 1000 },
    });
    assert.equal(sessionCap.allow, false);
    assert.equal(sessionCap.reason, 'pane_cap_reached');
  });

  it('supports legacy session_counts when pane_counts is absent', () => {
    const legacyCap = evaluateInjectionGuards({
      config: validConfig,
      mode: 'ralph',
      sourceText: 'legacy',
      assistantMessage: '',
      threadId: 'th',
      turnId: 'legacy-turn',
      sessionKey: 'th',
      paneKey: '%legacy',
      now: 9000,
      state: { session_counts: { th: 2 }, last_injection_ts: 1000 },
    });
    assert.equal(legacyCap.allow, false);
    assert.equal(legacyCap.reason, 'pane_cap_reached');
  });
});

describe('buildSendKeysArgv', () => {
  it('builds argv safely and supports dry-run', () => {
    assert.deepEqual(buildSendKeysArgv({
      paneTarget: '%3',
      prompt: 'continue',
      dryRun: false,
    }), {
      typeArgv: ['send-keys', '-t', '%3', '-l', 'continue'],
      submitArgv: [
        ['send-keys', '-t', '%3', 'C-m'],
        ['send-keys', '-t', '%3', 'C-m'],
      ],
    });

    assert.deepEqual(buildSendKeysArgv({
      paneTarget: '%7',
      prompt: 'continue',
      dryRun: false,
      submitKeyPresses: 1,
    }), {
      typeArgv: ['send-keys', '-t', '%7', '-l', 'continue'],
      submitArgv: [
        ['send-keys', '-t', '%7', 'C-m'],
      ],
    });

    assert.equal(buildSendKeysArgv({
      paneTarget: '%3',
      prompt: 'continue',
      dryRun: true,
    }), null);
  });
});
