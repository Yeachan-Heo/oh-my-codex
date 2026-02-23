import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  resolveWorkerSparkModel,
  resolveSetupScopeArg,
  readPersistedSetupScope,
  resolveCodexHomeForLaunch,
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

  it('--spark is stripped from leader args (model goes to workers only)', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(['--spark', '--yolo']),
      ['--yolo']
    );
  });

  it('--spark alone produces no leader args', () => {
    assert.deepEqual(normalizeCodexLaunchArgs(['--spark']), []);
  });

  it('--madmax-spark adds bypass flag to leader args and is otherwise consumed', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(['--madmax-spark']),
      ['--dangerously-bypass-approvals-and-sandbox']
    );
  });

  it('--madmax-spark deduplicates bypass when --madmax also present', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(['--madmax', '--madmax-spark']),
      ['--dangerously-bypass-approvals-and-sandbox']
    );
  });

  it('--madmax-spark does not inject spark model into leader args', () => {
    const args = normalizeCodexLaunchArgs(['--madmax-spark']);
    assert.ok(!args.includes('--model'), 'leader args must not contain --model from --madmax-spark');
    assert.ok(!args.some(a => a.includes('spark')), 'leader args must not reference spark model');
  });

  it('strips detached worktree flag from leader codex args', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(['--worktree', '--yolo']),
      ['--yolo'],
    );
  });

  it('strips named worktree flag from leader codex args', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(['--worktree=feature/demo', '--model', 'gpt-5']),
      ['--model', 'gpt-5'],
    );
  });
});

describe('resolveWorkerSparkModel', () => {
  it('returns spark model string when --spark is present', () => {
    assert.equal(resolveWorkerSparkModel(['--spark', '--yolo']), 'gpt-5.3-codex-spark');
  });

  it('returns spark model string when --madmax-spark is present', () => {
    assert.equal(resolveWorkerSparkModel(['--madmax-spark']), 'gpt-5.3-codex-spark');
  });

  it('returns undefined when neither spark flag is present', () => {
    assert.equal(resolveWorkerSparkModel(['--madmax', '--yolo', '--model', 'gpt-5']), undefined);
  });

  it('returns undefined for empty args', () => {
    assert.equal(resolveWorkerSparkModel([]), undefined);
  });
});

describe('resolveTeamWorkerLaunchArgsEnv (spark)', () => {
  it('injects spark model as worker default when no explicit env model', () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(undefined, [], true, 'gpt-5.3-codex-spark'),
      '--model gpt-5.3-codex-spark'
    );
  });

  it('explicit env model overrides spark default', () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv('--model gpt-5', [], true, 'gpt-5.3-codex-spark'),
      '--model gpt-5'
    );
  });

  it('inherited leader model overrides spark default', () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(undefined, ['--model', 'gpt-4.1'], true, 'gpt-5.3-codex-spark'),
      '--model gpt-4.1'
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

describe('resolveSetupScopeArg', () => {
  it('returns undefined when scope is omitted', () => {
    assert.equal(resolveSetupScopeArg(['--dry-run']), undefined);
  });

  it('parses --scope <value> form', () => {
    assert.equal(resolveSetupScopeArg(['--dry-run', '--scope', 'project-local']), 'project-local');
  });

  it('parses --scope=<value> form', () => {
    assert.equal(resolveSetupScopeArg(['--scope=project']), 'project');
  });

  it('throws on invalid scope value', () => {
    assert.throws(
      () => resolveSetupScopeArg(['--scope', 'workspace']),
      /Invalid setup scope: workspace/
    );
  });

  it('throws when --scope value is missing', () => {
    assert.throws(
      () => resolveSetupScopeArg(['--scope']),
      /Missing setup scope value after --scope/
    );
  });
});

describe('project-local launch scope helpers', () => {
  it('reads persisted setup scope when valid', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-scope-'));
    try {
      await mkdir(join(wd, '.omx'), { recursive: true });
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project-local' }));
      assert.equal(readPersistedSetupScope(wd), 'project-local');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('ignores malformed persisted setup scope', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-scope-'));
    try {
      await mkdir(join(wd, '.omx'), { recursive: true });
      await writeFile(join(wd, '.omx', 'setup-scope.json'), '{not-json');
      assert.equal(readPersistedSetupScope(wd), undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('uses project-local CODEX_HOME when persisted scope is project-local', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-scope-'));
    try {
      await mkdir(join(wd, '.omx'), { recursive: true });
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project-local' }));
      assert.equal(resolveCodexHomeForLaunch(wd, {}), join(wd, '.codex'));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps explicit CODEX_HOME override from env', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-launch-scope-'));
    try {
      await mkdir(join(wd, '.omx'), { recursive: true });
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project-local' }));
      assert.equal(resolveCodexHomeForLaunch(wd, { CODEX_HOME: '/tmp/explicit-codex-home' }), '/tmp/explicit-codex-home');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
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

  it('buildHudPaneCleanupTargets excludes leader pane from existing ids', () => {
    // %5 is the leader pane — it must not be included even if findHudWatchPaneIds let it through.
    assert.deepEqual(buildHudPaneCleanupTargets(['%3', '%5'], '%4', '%5'), ['%3', '%4']);
  });

  it('buildHudPaneCleanupTargets excludes leader pane even when it matches the created HUD pane id', () => {
    // Defensive edge case: if createHudWatchPane somehow returned the leader pane id, guard protects it.
    assert.deepEqual(buildHudPaneCleanupTargets(['%3'], '%5', '%5'), ['%3']);
  });

  it('buildHudPaneCleanupTargets is a no-op guard when leaderPaneId is absent', () => {
    assert.deepEqual(buildHudPaneCleanupTargets(['%3'], '%4'), ['%3', '%4']);
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
