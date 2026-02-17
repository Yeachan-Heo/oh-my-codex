import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCodexLaunchArgs,
  buildTmuxShellCommand,
  buildTmuxSessionName,
  resolveCliInvocation,
  resolveCodexLaunchPolicy,
  parseTmuxPaneSnapshot,
  findHudWatchPaneIds,
  buildHudPaneCleanupTargets,
  readTopLevelTomlString,
  upsertTopLevelTomlString,
  collectInheritableTeamWorkerArgs,
  resolveTeamWorkerLaunchArgsEnv,
  injectModelInstructionsBypassArgs,
} from '../index.js';

describe('normalizeCodexLaunchArgs', () => {
  it('maps --madmax to codex bypass flag', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(['--madmax']),
      ['--dangerously-bypass-approvals-and-sandbox']
    );
  });

  it('does not forward --madmax and preserves other args', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(['--model', 'gpt-5', '--madmax', '--yolo']),
      ['--model', 'gpt-5', '--yolo', '--dangerously-bypass-approvals-and-sandbox']
    );
  });

  it('avoids duplicate bypass flags when both are present', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs([
        '--dangerously-bypass-approvals-and-sandbox',
        '--madmax',
      ]),
      ['--dangerously-bypass-approvals-and-sandbox']
    );
  });

  it('deduplicates repeated bypass-related flags', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs([
        '--madmax',
        '--dangerously-bypass-approvals-and-sandbox',
        '--madmax',
        '--dangerously-bypass-approvals-and-sandbox',
      ]),
      ['--dangerously-bypass-approvals-and-sandbox']
    );
  });

  it('leaves unrelated args unchanged', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(['--model', 'gpt-5', '--yolo']),
      ['--model', 'gpt-5', '--yolo']
    );
  });

  it('maps --high to reasoning override', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(['--high']),
      ['-c', 'model_reasoning_effort="high"']
    );
  });

  it('maps --xhigh to reasoning override', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(['--xhigh']),
      ['-c', 'model_reasoning_effort="xhigh"']
    );
  });

  it('uses the last reasoning shorthand when both are present', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(['--high', '--xhigh']),
      ['-c', 'model_reasoning_effort="xhigh"']
    );
  });

  it('maps --xhigh --madmax to codex-native flags only', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(['--xhigh', '--madmax']),
      ['--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort="xhigh"']
    );
  });
});

describe('resolveCliInvocation', () => {
  it('resolves hooks to hooks command', () => {
    assert.deepEqual(resolveCliInvocation(['hooks']), {
      command: 'hooks',
      launchArgs: [],
    });
  });

  it('resolves --help to the help command instead of launch', () => {
    assert.deepEqual(resolveCliInvocation(['--help']), {
      command: 'help',
      launchArgs: [],
    });
  });

  it('keeps unknown long flags as launch passthrough args', () => {
    assert.deepEqual(resolveCliInvocation(['--model', 'gpt-5']), {
      command: 'launch',
      launchArgs: ['--model', 'gpt-5'],
    });
  });
});

describe('resolveCodexLaunchPolicy', () => {
  it('launches directly when outside tmux', () => {
    assert.equal(resolveCodexLaunchPolicy({}), 'direct');
  });

  it('uses tmux-aware launch path when already inside tmux', () => {
    assert.equal(resolveCodexLaunchPolicy({ TMUX: '/tmp/tmux-1000/default,123,0' }), 'inside-tmux');
  });
});

describe('tmux HUD pane helpers', () => {
  it('findHudWatchPaneIds detects stale HUD watch panes and excludes current pane', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tzsh\tzsh',
        '%2\tnode\tnode /tmp/bin/omx.js hud --watch',
        '%3\tnode\tnode /tmp/bin/omx.js hud --watch',
        '%4\tcodex\tcodex --model gpt-5',
      ].join('\n')
    );
    assert.deepEqual(findHudWatchPaneIds(panes, '%2'), ['%3']);
  });

  it('buildHudPaneCleanupTargets de-dupes pane ids and includes created pane', () => {
    assert.deepEqual(buildHudPaneCleanupTargets(['%3', '%3', 'invalid'], '%4'), ['%3', '%4']);
  });
});

describe('buildTmuxShellCommand', () => {
  it('preserves quoted config values for tmux shell-command execution', () => {
    assert.equal(
      buildTmuxShellCommand('codex', ['--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort="xhigh"']),
      `'codex' '--dangerously-bypass-approvals-and-sandbox' '-c' 'model_reasoning_effort="xhigh"'`
    );
  });
});

describe('buildTmuxSessionName', () => {
  it('uses omx-directory-branch-session format', () => {
    const name = buildTmuxSessionName('/tmp/My Repo', 'omx-1770992424158-abc123');
    assert.match(name, /^omx-my-repo-[a-z0-9-]+-1770992424158-abc123$/);
  });

  it('sanitizes invalid characters', () => {
    const name = buildTmuxSessionName('/tmp/@#$', 'omx-+++');
    assert.match(name, /^omx-(unknown|[a-z0-9-]+)-[a-z0-9-]+-(unknown|[a-z0-9-]+)$/);
    assert.equal(name.includes('_'), false);
    assert.equal(name.includes(' '), false);
  });
});

describe('team worker launch arg inheritance helpers', () => {
  it('collectInheritableTeamWorkerArgs extracts bypass, reasoning, and model overrides', () => {
    assert.deepEqual(
      collectInheritableTeamWorkerArgs(['--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort="xhigh"', '--model', 'gpt-5']),
      ['--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort="xhigh"', '--model', 'gpt-5']
    );
  });

  it('collectInheritableTeamWorkerArgs supports --model=<value> syntax', () => {
    assert.deepEqual(
      collectInheritableTeamWorkerArgs(['--model=gpt-5.3-codex']),
      ['--model', 'gpt-5.3-codex']
    );
  });

  it('resolveTeamWorkerLaunchArgsEnv merges and normalizes with de-dupe + last reasoning/model wins', () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        '--dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort="high" --model old-a --no-alt-screen --model=old-b',
        ['-c', 'model_reasoning_effort="xhigh"', '--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5'],
        true
      ),
      '--no-alt-screen --dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort="xhigh" --model old-b'
    );
  });

  it('resolveTeamWorkerLaunchArgsEnv can opt out of leader inheritance', () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        '--no-alt-screen',
        ['--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort="xhigh"'],
        false
      ),
      '--no-alt-screen'
    );
  });

  it('resolveTeamWorkerLaunchArgsEnv uses inherited model when env model is absent', () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        '--no-alt-screen',
        ['--model=gpt-5.3-codex'],
        true
      ),
      '--no-alt-screen --model gpt-5.3-codex'
    );
  });

  it('resolveTeamWorkerLaunchArgsEnv uses default model when env and inherited models are absent', () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        '--no-alt-screen',
        ['--dangerously-bypass-approvals-and-sandbox'],
        true,
        'gpt-5.3-codex'
      ),
      '--no-alt-screen --dangerously-bypass-approvals-and-sandbox --model gpt-5.3-codex'
    );
  });

  it('resolveTeamWorkerLaunchArgsEnv keeps exactly one final model with precedence env > inherited > default', () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        '--model env-model --model=env-model-final',
        ['--model', 'inherited-model'],
        true,
        'fallback-model'
      ),
      '--model env-model-final'
    );
  });

  it('resolveTeamWorkerLaunchArgsEnv prefers inherited model over default when env model is absent', () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        '--no-alt-screen',
        ['--model', 'inherited-model'],
        true,
        'fallback-model'
      ),
      '--no-alt-screen --model inherited-model'
    );
  });
});

describe('readTopLevelTomlString', () => {
  it('reads a top-level string value', () => {
    const value = readTopLevelTomlString(
      'model_reasoning_effort = "high"\n[mcp_servers.test]\nmodel_reasoning_effort = "low"\n',
      'model_reasoning_effort'
    );
    assert.equal(value, 'high');
  });

  it('ignores table-local values', () => {
    const value = readTopLevelTomlString(
      '[mcp_servers.test]\nmodel_reasoning_effort = "xhigh"\n',
      'model_reasoning_effort'
    );
    assert.equal(value, null);
  });
});

describe('injectModelInstructionsBypassArgs', () => {
  it('appends model_instructions_file override by default', () => {
    const args = injectModelInstructionsBypassArgs('/tmp/my-project', ['--model', 'gpt-5'], {});
    assert.deepEqual(
      args,
      ['--model', 'gpt-5', '-c', 'model_instructions_file="/tmp/my-project/AGENTS.md"']
    );
  });

  it('does not append when bypass is disabled via env', () => {
    const args = injectModelInstructionsBypassArgs(
      '/tmp/my-project',
      ['--model', 'gpt-5'],
      { OMX_BYPASS_DEFAULT_SYSTEM_PROMPT: '0' }
    );
    assert.deepEqual(args, ['--model', 'gpt-5']);
  });

  it('does not append when model_instructions_file is already set', () => {
    const args = injectModelInstructionsBypassArgs(
      '/tmp/my-project',
      ['-c', 'model_instructions_file="/tmp/custom.md"'],
      {}
    );
    assert.deepEqual(args, ['-c', 'model_instructions_file="/tmp/custom.md"']);
  });

  it('respects OMX_MODEL_INSTRUCTIONS_FILE env override', () => {
    const args = injectModelInstructionsBypassArgs(
      '/tmp/my-project',
      [],
      { OMX_MODEL_INSTRUCTIONS_FILE: '/tmp/alt instructions.md' }
    );
    assert.deepEqual(
      args,
      ['-c', 'model_instructions_file="/tmp/alt instructions.md"']
    );
  });

  it('uses session-scoped default model_instructions_file when provided', () => {
    const args = injectModelInstructionsBypassArgs(
      '/tmp/my-project',
      ['--model', 'gpt-5'],
      {},
      '/tmp/my-project/.omx/state/sessions/session-1/AGENTS.md'
    );
    assert.deepEqual(
      args,
      ['--model', 'gpt-5', '-c', 'model_instructions_file="/tmp/my-project/.omx/state/sessions/session-1/AGENTS.md"']
    );
  });
});

describe('upsertTopLevelTomlString', () => {
  it('replaces an existing top-level key', () => {
    const updated = upsertTopLevelTomlString(
      'model_reasoning_effort = "low"\n[tui]\nstatus_line = []\n',
      'model_reasoning_effort',
      'high'
    );
    assert.match(updated, /^model_reasoning_effort = "high"$/m);
    assert.doesNotMatch(updated, /^model_reasoning_effort = "low"$/m);
  });

  it('inserts before the first table when key is missing', () => {
    const updated = upsertTopLevelTomlString(
      '[tui]\nstatus_line = []\n',
      'model_reasoning_effort',
      'xhigh'
    );
    assert.equal(updated, 'model_reasoning_effort = "xhigh"\n[tui]\nstatus_line = []\n');
  });
});
