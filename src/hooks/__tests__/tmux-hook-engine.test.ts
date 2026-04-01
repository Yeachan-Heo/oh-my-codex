import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ALLOWED_MODES,
  DEFAULT_MARKER,
  normalizeTmuxCapture,
  normalizeTmuxHookConfig,
  pickActiveMode,
  paneHasActiveTask,
  paneIsBootstrapping,
  paneShowsCodexViewport,
  paneLooksReady,
  evaluateInjectionGuards,
  buildSendKeysArgv,
  buildPaneCurrentCommandArgv,
  isPaneRunningShell,
  resolveCodexPane,
} from '../../scripts/tmux-hook-engine.js';

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

describe('buildPaneCurrentCommandArgv', () => {
  it('builds argv to query pane_current_command', () => {
    assert.deepEqual(
      buildPaneCurrentCommandArgv('%5'),
      ['display-message', '-p', '-t', '%5', '#{pane_current_command}'],
    );
  });
});

describe('isPaneRunningShell', () => {
  it('detects common shells', () => {
    assert.equal(isPaneRunningShell('zsh'), true);
    assert.equal(isPaneRunningShell('bash'), true);
    assert.equal(isPaneRunningShell('fish'), true);
    assert.equal(isPaneRunningShell('sh'), true);
    assert.equal(isPaneRunningShell('dash'), true);
    assert.equal(isPaneRunningShell('ksh'), true);
    assert.equal(isPaneRunningShell('login'), true);
  });

  it('detects shells with path prefix', () => {
    assert.equal(isPaneRunningShell('/bin/zsh'), true);
    assert.equal(isPaneRunningShell('/usr/bin/bash'), true);
  });

  it('detects login shells with leading dash', () => {
    assert.equal(isPaneRunningShell('-zsh'), true);
    assert.equal(isPaneRunningShell('-bash'), true);
  });

  it('returns false for agent processes', () => {
    assert.equal(isPaneRunningShell('node'), false);
    assert.equal(isPaneRunningShell('codex'), false);
    assert.equal(isPaneRunningShell('claude'), false);
    assert.equal(isPaneRunningShell('python'), false);
  });

  it('returns false for non-string or empty input', () => {
    assert.equal(isPaneRunningShell(''), false);
    assert.equal(isPaneRunningShell(null as any), false);
    assert.equal(isPaneRunningShell(undefined as any), false);
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

describe('normalizeTmuxCapture', () => {
  it('collapses whitespace and trims tmux capture text', () => {
    assert.equal(normalizeTmuxCapture('  hello\r\n  world  \n'), 'hello world');
  });
});

describe('paneIsBootstrapping', () => {
  it('detects startup/loading markers', () => {
    assert.equal(paneIsBootstrapping(['model: loading']), true);
    assert.equal(paneIsBootstrapping(['Initializing workspace']), true);
    assert.equal(paneIsBootstrapping(['connecting to agent']), true);
  });

  it('returns false for ready prompt content', () => {
    assert.equal(paneIsBootstrapping(['› ready']), false);
  });
});

describe('paneLooksReady', () => {
  it('accepts explicit prompt lines', () => {
    assert.equal(paneLooksReady('some output\n› '), true);
    assert.equal(paneLooksReady('some output\n❯ '), true);
  });

  it('rejects status-only and bootstrapping captures', () => {
    assert.equal(paneLooksReady('gpt-5 50% left'), false);
    assert.equal(paneLooksReady('model: loading\n› '), false);
  });

  it('accepts Codex welcome-screen helper text', () => {
    assert.equal(paneLooksReady('How can I help you today?'), true);
  });

  it('accepts Codex welcome-screen suggestion rows with a prompt glyph', () => {
    assert.equal(paneLooksReady('› Explain this codebase'), true);
  });

  it('accepts issue-only prompts without a glyph', () => {
    assert.equal(paneLooksReady('IND-123 only...'), true);
  });

  it('keeps viewport-only Codex captures non-ready when the prompt is below the fold', () => {
    assert.equal(paneLooksReady(`╭────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.118.0)                 │
│                                            │
│ model:     gpt-5.4 high   /model to change │
│ directory: /tmp/demo                       │
╰────────────────────────────────────────────╯

⚠ MCP startup incomplete (failed: hf request)`), false);
  });
});

describe('paneShowsCodexViewport', () => {
  it('detects a live Codex viewport without requiring the prompt to remain visible', () => {
    assert.equal(paneShowsCodexViewport(`╭────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.118.0)                 │
│                                            │
│ model:     gpt-5.4 high   /model to change │
│ directory: /tmp/demo                       │
╰────────────────────────────────────────────╯

⚠ MCP startup incomplete (failed: hf request)`), true);
  });

  it('rejects status-only and bootstrapping captures', () => {
    assert.equal(paneShowsCodexViewport('gpt-5 50% left'), false);
    assert.equal(paneShowsCodexViewport(`╭────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.118.0)                 │
│                                            │
│ model: loading                             │
│ directory: /tmp/demo                       │
╰────────────────────────────────────────────╯`), false);
  });
});

describe('paneHasActiveTask', () => {
  it('detects Codex and Claude activity markers', () => {
    assert.equal(paneHasActiveTask('• Running tests (3m 12s • esc to interrupt)'), true);
    assert.equal(paneHasActiveTask('· Pollinating…'), true);
    assert.equal(paneHasActiveTask('2 background terminal running'), true);
  });

  it('returns false for idle prompts', () => {
    assert.equal(paneHasActiveTask('› ready for input'), false);
  });
});


describe('resolveCodexPane', () => {
  it('ignores HUD pane even when TMUX_PANE foreground command is node', async () => {
    const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-resolve-codex-pane-'));
    const fakeTmuxPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    const previousTmuxPane = process.env.TMUX_PANE;

    try {
      await writeFile(fakeTmuxPath, `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%2" ]]; then
    echo "node"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%2" ]]; then
    echo "node /pkg/dist/cli/omx.js hud --watch"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%2" ]]; then
    echo "devsess"
    exit 0
  fi
  echo "bad display target: $target / $format" >&2
  exit 1
fi
if [[ "$cmd" == "list-panes" ]]; then
  printf "%%2\tnode\tnode /pkg/dist/cli/omx.js hud --watch\n%%42\tnode\tcodex --model gpt-5\n"
  exit 0
fi
echo "unsupported" >&2
exit 1
`);
      await chmod(fakeTmuxPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;
      process.env.TMUX_PANE = '%2';

      assert.equal(resolveCodexPane(), '%42');
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
      else delete process.env.TMUX_PANE;
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
});
