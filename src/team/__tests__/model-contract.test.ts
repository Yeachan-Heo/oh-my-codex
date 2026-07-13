import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectInheritableTeamWorkerArgs,
  isLowComplexityAgentType,
  parseTeamWorkerLaunchArgs,
  resolveAgentDefaultModel,
  resolveAgentReasoningEffort,
  resolveTeamWorkerLaunchArgs,
  resolveTeamWorkerLaunchDiagnostics,
  serializeTeamWorkerLaunchArgs,
  splitWorkerLaunchArgs,
  TEAM_LOW_COMPLEXITY_DEFAULT_MODEL,
  resolveTeamLowComplexityDefaultModel,
  type TeamReasoningEffort,
} from '../model-contract.js';
import type { PerAgentReasoningEffort } from '../../config/models.js';


function expectedLowComplexityModel(): string {
  return resolveTeamLowComplexityDefaultModel();
}

function withIsolatedDefaultModelEnv<T>(run: () => T): T {
  const savedEnv = new Map<string, string | undefined>();
  for (const key of [
    'CODEX_HOME',
    'OMX_DEFAULT_FRONTIER_MODEL',
    'OMX_DEFAULT_STANDARD_MODEL',
    'OMX_DEFAULT_SPARK_MODEL',
    'OMX_SPARK_MODEL',
  ] as const) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.CODEX_HOME = join(
    tmpdir(),
    `omx-model-contract-defaults-${process.pid}-${Date.now()}`,
  );

  try {
    return run();
  } finally {
    for (const [key, value] of savedEnv.entries()) {
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
  }
}

describe('team model contract', () => {
  it('collects inheritable bypass, reasoning, and model overrides', () => {
    assert.deepEqual(
      collectInheritableTeamWorkerArgs([
        '--dangerously-bypass-approvals-and-sandbox',
        '-c',
        'model_reasoning_effort="xhigh"',
        '--model=gpt-5.5',
      ]),
      [
        '--dangerously-bypass-approvals-and-sandbox',
        '-c',
        'model_reasoning_effort="xhigh"',
        '--model',
        'gpt-5.5',
      ],
    );
  });


  it('collects only safe model_provider config overrides for worker inheritance', () => {
    assert.deepEqual(
      collectInheritableTeamWorkerArgs([
        '-c',
        'sandbox_mode="danger-full-access"',
        '-c',
        'model_provider="cheapRouter"',
        '--model',
        'gpt-5.6-sol',
      ]),
      ['-c', 'model_provider="cheapRouter"', '--model', 'gpt-5.6-sol'],
    );
  });

  it('ignores leader direct policy selectors while retaining approved inheritable overrides', () => {
    assert.deepEqual(
      collectInheritableTeamWorkerArgs([
        '--ask-for-approval',
        'on-request',
        '--sandbox=workspace-write',
        '--madmax',
        '-c',
        'model_provider="leaderRouter"',
        '-c',
        'model_reasoning_effort="high"',
        '--model=leader-model',
      ]),
      [
        '--dangerously-bypass-approvals-and-sandbox',
        '-c',
        'model_provider="leaderRouter"',
        '-c',
        'model_reasoning_effort="high"',
        '--model',
        'leader-model',
      ],
    );
  });

  it('does not validate or inherit malformed direct and config policy tokens from leader arguments', () => {
    assert.deepEqual(
      collectInheritableTeamWorkerArgs([
        '--ask-for-approval',
        '--sandbox=',
        '-a=',
        '-c',
        'approval_policy=',
        '--config=sandbox_mode=workspace-write',
        '-s',
        'leader-only-positional-token',
        '-a',
        'another-positional-token',
        '--model',
        'leader-model',
        '-c',
        'model_reasoning_effort="high"',
        '-c',
        'model_provider="leaderRouter"',
        '--madmax',
      ]),
      [
        '--dangerously-bypass-approvals-and-sandbox',
        '-c',
        'model_provider="leaderRouter"',
        '-c',
        'model_reasoning_effort="high"',
        '--model',
        'leader-model',
      ],
    );
  });

  it('keeps exactly one model_provider override with precedence env > inherited', () => {
    assert.deepEqual(
      resolveTeamWorkerLaunchArgs({
        existingRaw: '-c model_provider="envRouter" --no-alt-screen',
        inheritedArgs: ['-c', 'model_provider="leaderRouter"', '--model', 'gpt-5.6-sol'],
      }),
      ['--no-alt-screen', '-c', 'model_provider="envRouter"', '--model', 'gpt-5.6-sol'],
    );
  });

  it('keeps exactly one canonical model flag with precedence env > inherited > fallback', () => {
    assert.deepEqual(
      resolveTeamWorkerLaunchArgs({
        existingRaw: '--model env-a --model=env-b',
        inheritedArgs: ['--model', 'inherited-model'],
        fallbackModel: expectedLowComplexityModel(),
      }),
      ['--model', 'env-b'],
    );
  });

  it('uses inherited model when env model is absent', () => {
    assert.deepEqual(
      resolveTeamWorkerLaunchArgs({
        existingRaw: '--no-alt-screen',
        inheritedArgs: ['--model=inherited-model'],
      }),
      ['--no-alt-screen', '--model', 'inherited-model'],
    );
  });

  it('uses fallback model when env and inherited models are absent', () => {
    assert.deepEqual(
      resolveTeamWorkerLaunchArgs({
        existingRaw: '--no-alt-screen',
        inheritedArgs: ['--dangerously-bypass-approvals-and-sandbox'],
        fallbackModel: expectedLowComplexityModel(),
      }),
      ['--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox', '--model', expectedLowComplexityModel()],
    );
  });

  it('drops orphan --model flag and emits exactly one canonical --model', () => {
    // Orphan --model with no following value must not leak into passthrough and cause duplicate flags
    assert.deepEqual(
      resolveTeamWorkerLaunchArgs({
        existingRaw: '--model',
        inheritedArgs: ['--model', 'inherited-model'],
      }),
      ['--model', 'inherited-model'],
    );
  });

  it('drops orphan --model mixed with other flags and does not emit duplicate flags', () => {
    assert.deepEqual(
      resolveTeamWorkerLaunchArgs({
        existingRaw: '--no-alt-screen --model',
        inheritedArgs: ['--model', 'sonic-model'],
      }),
      ['--no-alt-screen', '--model', 'sonic-model'],
    );
  });

  it('drops --model= with empty value and falls back to inherited model', () => {
    assert.deepEqual(
      resolveTeamWorkerLaunchArgs({
        existingRaw: '--model=',
        inheritedArgs: ['--model', 'inherited-model'],
      }),
      ['--model', 'inherited-model'],
    );
  });

  it('detects low-complexity agent types', () => {
    assert.equal(isLowComplexityAgentType('explore'), true);
    assert.equal(isLowComplexityAgentType('writer'), false);
    assert.equal(isLowComplexityAgentType('style-reviewer'), true);
    assert.equal(isLowComplexityAgentType('executor'), false);
    assert.equal(isLowComplexityAgentType('executor-low'), true);
  });

  it('maps worker roles to default reasoning effort tiers', () => {
    assert.equal(resolveAgentReasoningEffort('explore'), 'low');
    assert.equal(resolveAgentReasoningEffort('executor'), 'medium');
    assert.equal(resolveAgentReasoningEffort('architect'), 'xhigh');
    assert.equal(resolveAgentReasoningEffort('does-not-exist'), undefined);
  });

  it('maps worker roles through configured per-agent reasoning overrides and invalid fallback', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-model-contract-reasoning-'));
    try {
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
        agentReasoning: {
          architect: 'MAX',
          critic: 'ultra',
          explore: 'future',
        },
      }));

      assert.equal(resolveAgentReasoningEffort('architect', codexHome), 'max');
      assert.equal(resolveAgentReasoningEffort('critic', codexHome), 'high');
      assert.equal(resolveAgentReasoningEffort('explore', codexHome), 'low');
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('maps worker roles to configured default model lanes', () => {
    withIsolatedDefaultModelEnv(() => {
      assert.equal(resolveAgentDefaultModel('explore'), expectedLowComplexityModel());
      assert.equal(resolveAgentDefaultModel('writer'), 'gpt-5.6-sol');
      assert.equal(resolveAgentDefaultModel('executor'), 'gpt-5.6-sol');
      assert.equal(resolveAgentDefaultModel('architect'), 'gpt-5.6-sol');
      assert.equal(resolveAgentDefaultModel('does-not-exist'), undefined);
    });
  });
  it('honors exact model pins before frontier fallback routing', () => {
    withIsolatedDefaultModelEnv(() => {
      process.env.OMX_DEFAULT_FRONTIER_MODEL = 'gpt-5.2-frontier';

      assert.equal(resolveAgentDefaultModel('planner'), 'gpt-5.6-sol');
      assert.equal(resolveAgentDefaultModel('architect'), 'gpt-5.6-sol');
      assert.equal(resolveAgentDefaultModel('researcher'), 'gpt-5.6-terra');
      assert.equal(resolveAgentDefaultModel('critic'), 'gpt-5.2-frontier');
    });
  });

  it('honors per-agent model overrides before class and spark fallback routing', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-model-contract-agent-models-'));
    try {
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
        agentModels: {
          architect: 'gpt-5.6-sol-architect',
          explore: 'gpt-5.6-sol-explore',
        },
      }));

      assert.equal(resolveAgentDefaultModel('architect', codexHome), 'gpt-5.6-sol-architect');
      assert.equal(resolveAgentDefaultModel('explore', codexHome), 'gpt-5.6-sol-explore');
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('keeps assigned worker roles as their own runtime identity', () => {
    withIsolatedDefaultModelEnv(() => {
      assert.equal(resolveAgentDefaultModel('explore'), expectedLowComplexityModel());
      assert.equal(resolveAgentReasoningEffort('explore'), 'low');
      assert.equal(resolveAgentDefaultModel('style-reviewer'), expectedLowComplexityModel());
      assert.equal(resolveAgentReasoningEffort('style-reviewer'), 'low');
    });
  });

  it('lets exact role model defaults override inherited mini leader model when requested', () => {
    withIsolatedDefaultModelEnv(() => {
      assert.deepEqual(
        resolveTeamWorkerLaunchArgs({
          inheritedArgs: ['--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5.6-terra'],
          fallbackModel: resolveAgentDefaultModel('planner'),
          preferredReasoning: 'high',
          honorExactRoleModel: true,
        }),
        [
          '--dangerously-bypass-approvals-and-sandbox',
          '-c',
          'model_reasoning_effort="high"',
          '--model',
          'gpt-5.6-sol',
        ],
      );
    });
  });
  it('preserves explicit worker model overrides before exact role defaults', () => {
    withIsolatedDefaultModelEnv(() => {
      assert.deepEqual(
        resolveTeamWorkerLaunchArgs({
          existingRaw: '--model explicit-worker-model',
          inheritedArgs: ['--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5.6-terra'],
          fallbackModel: resolveAgentDefaultModel('planner'),
          preferredReasoning: 'high',
          honorExactRoleModel: true,
        }),
        [
          '--dangerously-bypass-approvals-and-sandbox',
          '-c',
          'model_reasoning_effort="high"',
          '--model',
          'explicit-worker-model',
        ],
      );

      const diagnostics = resolveTeamWorkerLaunchDiagnostics({
        requestedAgentType: 'planner',
        existingRaw: '--model explicit-worker-model',
        inheritedArgs: ['--model', 'gpt-5.6-terra'],
        fallbackModel: resolveAgentDefaultModel('planner'),
        preferredReasoning: 'high',
        honorExactRoleModel: true,
      });

      assert.equal(diagnostics.actualModel, 'explicit-worker-model');
      assert.equal(diagnostics.modelSource, 'env');
      assert.equal(diagnostics.inheritedParentModel, false);
    });
  });

  it('preserves inherited mini leader model for roles without exact-model enforcement', () => {
    withIsolatedDefaultModelEnv(() => {
      assert.deepEqual(
        resolveTeamWorkerLaunchArgs({
          inheritedArgs: ['--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5.6-terra'],
          fallbackModel: resolveAgentDefaultModel('executor'),
          preferredReasoning: resolveAgentReasoningEffort('executor'),
        }),
        [
          '--dangerously-bypass-approvals-and-sandbox',
          '-c',
          'model_reasoning_effort="medium"',
          '--model',
          'gpt-5.6-terra',
        ],
      );
    });
  });

  it('reports requested versus actual worker launch resolution for role defaults', () => {
    withIsolatedDefaultModelEnv(() => {
      assert.deepEqual(
        resolveTeamWorkerLaunchDiagnostics({
          requestedAgentType: 'architect',
          fallbackModel: resolveAgentDefaultModel('architect'),
          preferredReasoning: resolveAgentReasoningEffort('architect'),
        }),
        {
          requestedAgentType: 'architect',
          requestedDefaultModel: 'gpt-5.6-sol',
          requestedDefaultReasoning: 'xhigh',
          actualModel: 'gpt-5.6-sol',
          actualReasoning: 'xhigh',
          modelSource: 'fallback',
          reasoningSource: 'role-default',
          inheritedParentModel: false,
          actualLaunchArgs: ['-c', 'model_reasoning_effort="xhigh"', '--model', 'gpt-5.6-sol'],
        },
      );
    });
  });

  it('reports inherited parent model separately from role default reasoning', () => {
    withIsolatedDefaultModelEnv(() => {
      const diagnostics = resolveTeamWorkerLaunchDiagnostics({
        requestedAgentType: 'explore',
        inheritedArgs: ['--model', 'parent-session-model'],
        fallbackModel: resolveAgentDefaultModel('explore'),
        preferredReasoning: resolveAgentReasoningEffort('explore'),
      });

      assert.equal(diagnostics.requestedDefaultModel, expectedLowComplexityModel());
      assert.equal(diagnostics.actualModel, 'parent-session-model');
      assert.equal(diagnostics.modelSource, 'inherited');
      assert.equal(diagnostics.reasoningSource, 'role-default');
      assert.equal(diagnostics.inheritedParentModel, true);
      assert.deepEqual(diagnostics.actualLaunchArgs, [
        '-c',
        'model_reasoning_effort="low"',
        '--model',
        'parent-session-model',
      ]);
    });
  });
});

describe('resolveTeamWorkerLaunchArgs - teammate reasoning allocation', () => {
  it('injects preferred reasoning when explicit reasoning is absent', () => {
    const result = resolveTeamWorkerLaunchArgs({
      fallbackModel: expectedLowComplexityModel(),
      preferredReasoning: 'low',
    });
    assert.deepEqual(
      result,
      ['-c', 'model_reasoning_effort="low"', '--model', expectedLowComplexityModel()],
    );
  });

  it('does not auto-inject thinking level for fallback model when no preference is provided', () => {
    const result = resolveTeamWorkerLaunchArgs({
      fallbackModel: expectedLowComplexityModel(),
    });
    const joined = result.join(' ');
    assert.ok(!joined.includes('model_reasoning_effort'), `Expected no auto-injected thinking level in: ${joined}`);
  });

  it('preserves explicit reasoning override over teammate preference', () => {
    const result = resolveTeamWorkerLaunchArgs({
      existingRaw: '-c model_reasoning_effort="high"',
      fallbackModel: expectedLowComplexityModel(),
      preferredReasoning: 'low',
    });
    const joined = result.join(' ');
    // Should contain the explicit high level
    assert.ok(joined.includes('model_reasoning_effort="high"'), `Expected explicit high level in: ${joined}`);
    // Should appear exactly once
    const matches = joined.match(/model_reasoning_effort/g) ?? [];
    assert.equal(matches.length, 1, 'reasoning override should appear exactly once');
  });

  it('preserves exact reasoning tokens while normalizing direct worker policy', () => {
    const existingRaw = `-a on-request -c 'model_reasoning_effort = "MAX"'`;

    assert.deepEqual(
      resolveTeamWorkerLaunchArgs({ existingRaw, preferredReasoning: 'low' }),
      ['--ask-for-approval', 'on-request', '-c', 'model_reasoning_effort = "MAX"'],
    );
    assert.deepEqual(
      resolveTeamWorkerLaunchArgs({
        existingRaw,
        inheritedArgs: ['-c', 'model_reasoning_effort=future-tier'],
        preferredReasoning: 'low',
      }),
      ['--ask-for-approval', 'on-request', '-c', 'model_reasoning_effort=future-tier'],
    );
  });

  it('keeps TeamReasoningEffort exactly aligned with configured per-agent reasoning', () => {
    const configuredReasoning: PerAgentReasoningEffort = 'max';
    const teamReasoning: TeamReasoningEffort = configuredReasoning;
    const exactConfiguredReasoning: PerAgentReasoningEffort = teamReasoning;
    assert.equal(exactConfiguredReasoning, 'max');

    // @ts-expect-error Team reasoning excludes unsupported configured ultra.
    const unsupportedReasoning: TeamReasoningEffort = 'ultra';
    void unsupportedReasoning;
  });

  it('applies the full frozen Team reasoning precedence and diagnostics matrix', () => {
    const cases: Array<{
      name: string;
      existingRaw?: string;
      inheritedArgs?: string[];
      preferredReasoning?: TeamReasoningEffort;
      expectedReasoningToken?: string;
      expectedSource: 'explicit' | 'role-default' | 'none';
      expectedActual?: TeamReasoningEffort;
    }> = [
      {
        name: 'no explicit or role default',
        expectedSource: 'none',
      },
      {
        name: 'configured max role default',
        preferredReasoning: 'max',
        expectedReasoningToken: 'model_reasoning_effort="max"',
        expectedSource: 'role-default',
        expectedActual: 'max',
      },
      {
        name: 'known environment explicit reasoning',
        existingRaw: '-c model_reasoning_effort=MAX',
        preferredReasoning: 'max',
        expectedReasoningToken: 'model_reasoning_effort=MAX',
        expectedSource: 'explicit',
        expectedActual: 'max',
      },
      {
        name: 'opaque environment ultra reasoning',
        existingRaw: "-c model_reasoning_effort='ultra'",
        preferredReasoning: 'max',
        expectedReasoningToken: "model_reasoning_effort='ultra'",
        expectedSource: 'explicit',
      },
      {
        name: 'known inherited explicit reasoning',
        inheritedArgs: ['-c', 'model_reasoning_effort = "MAX"'],
        preferredReasoning: 'low',
        expectedReasoningToken: 'model_reasoning_effort = "MAX"',
        expectedSource: 'explicit',
        expectedActual: 'max',
      },
      {
        name: 'opaque inherited future reasoning',
        inheritedArgs: ['-c', 'model_reasoning_effort=future-tier'],
        preferredReasoning: 'low',
        expectedReasoningToken: 'model_reasoning_effort=future-tier',
        expectedSource: 'explicit',
      },
      {
        name: 'inherited explicit reasoning over environment explicit reasoning',
        existingRaw: '-c model_reasoning_effort=low',
        inheritedArgs: ['-c', 'model_reasoning_effort=MAX'],
        preferredReasoning: 'high',
        expectedReasoningToken: 'model_reasoning_effort=MAX',
        expectedSource: 'explicit',
        expectedActual: 'max',
      },
      {
        name: 'last environment explicit reasoning',
        existingRaw: '-c model_reasoning_effort=low -c model_reasoning_effort=max',
        preferredReasoning: 'high',
        expectedReasoningToken: 'model_reasoning_effort=max',
        expectedSource: 'explicit',
        expectedActual: 'max',
      },
      {
        name: 'last inherited explicit reasoning over environment reasoning',
        existingRaw: '-c model_reasoning_effort=low',
        inheritedArgs: [
          '-c',
          'model_reasoning_effort=high',
          '-c',
          'model_reasoning_effort=future-tier',
        ],
        preferredReasoning: 'max',
        expectedReasoningToken: 'model_reasoning_effort=future-tier',
        expectedSource: 'explicit',
      },
    ];

    for (const testCase of cases) {
      const diagnostics = resolveTeamWorkerLaunchDiagnostics({
        existingRaw: testCase.existingRaw,
        inheritedArgs: testCase.inheritedArgs,
        preferredReasoning: testCase.preferredReasoning,
      });

      assert.deepEqual(
        diagnostics.actualLaunchArgs,
        testCase.expectedReasoningToken ? ['-c', testCase.expectedReasoningToken] : [],
        testCase.name,
      );
      assert.equal(diagnostics.reasoningSource, testCase.expectedSource, testCase.name);
      assert.equal(diagnostics.actualReasoning, testCase.expectedActual, testCase.name);
      assert.equal(diagnostics.requestedDefaultReasoning, testCase.preferredReasoning, testCase.name);
    }
  });
  it('does not inject thinking when model is explicit but reasoning is omitted', () => {
    const result = resolveTeamWorkerLaunchArgs({
      existingRaw: '--model claude-opus-4',
    });
    const joined = result.join(' ');
    assert.ok(!joined.includes('model_reasoning_effort'), `Expected no reasoning in: ${joined}`);
  });
});

describe('explicit team worker policy contract', () => {
  it('tokenizes quote-aware launch args and reversibly serializes empty and literal tokens', () => {
    const quotedDouble = '"double"';
    const tokens = [
      '',
      'two words',
      'ab cdef',
      'single\\backslash',
      quotedDouble,
      "single'quote",
      '$VAR',
      '\\${value}',
      '\\$(command)',
      '\\`command`',
      '*?[glob]',
      '~;|>redirect',
      '',
    ];
    const raw = [
      "''",
      '"two words"',
      'ab" cd"ef',
      "'single\\backslash'",
      `"${quotedDouble.replace(/"/g, '\\"')}"`,
      '"single\'quote"',
      '$VAR',
      '\\${value}',
      '\\$(command)',
      '\\`command`',
      '*?[glob]',
      '~;|>redirect',
      '""',
    ].join(' ');

    assert.deepEqual(splitWorkerLaunchArgs(raw), tokens);
    assert.deepEqual(splitWorkerLaunchArgs(serializeTeamWorkerLaunchArgs(tokens)), tokens);
    assert.deepEqual(splitWorkerLaunchArgs('one\u00a0two\tthree\nfour'), ['one', 'two', 'three', 'four']);
  });

  it('preserves literal Windows backslashes, including terminal backslashes, through transport', () => {
    const path = 'C:\\Users\\alice\\file.txt';
    const terminalPath = 'C:\\Users\\alice\\';
    const raw = [
      path,
      terminalPath,
      `"${path}"`,
      `'${terminalPath}'`,
    ].join(' ');
    const expected = [path, terminalPath, path, terminalPath];

    assert.deepEqual(splitWorkerLaunchArgs(raw), expected);
    assert.deepEqual(splitWorkerLaunchArgs(serializeTeamWorkerLaunchArgs(expected)), expected);
  });

  it('preserves raw UNC and device backslash runs unquoted, quoted, and serialized', () => {
    const uncPath = '\\\\server\\share\\';
    const devicePath = '\\\\?\\C:\\work';
    const expected = [uncPath, devicePath];

    assert.deepEqual(splitWorkerLaunchArgs(`${uncPath} ${devicePath}`), expected);
    assert.deepEqual(splitWorkerLaunchArgs(`'${uncPath}' "${devicePath}"`), expected);
    assert.equal(
      serializeTeamWorkerLaunchArgs(expected),
      "'\\\\server\\share\\' '\\\\?\\C:\\work'",
    );
    assert.deepEqual(splitWorkerLaunchArgs(serializeTeamWorkerLaunchArgs(expected)), expected);
  });

  it('rejects only unterminated quotes while retaining literal malformed-looking escapes', () => {
    for (const raw of ["'unterminated", '"unterminated']) {
      assert.throws(
        () => splitWorkerLaunchArgs(raw),
        /Invalid OMX_TEAM_WORKER_LAUNCH_ARGS: unterminated quote/,
      );
    }

    assert.deepEqual(
      splitWorkerLaunchArgs(['one\\q', 'two\\', '"three\\q"', '"four\\\\path"'].join(' ')),
      ['one\\q', 'two\\', 'three\\q', 'four\\\\path'],
    );
  });

  it('normalizes every long and short direct policy split and equals form', () => {
    const cases: Array<{ raw: string; expected: string[] }> = [
      { raw: '--ask-for-approval on-request', expected: ['--ask-for-approval', 'on-request'] },
      { raw: '--ask-for-approval=on-request', expected: ['--ask-for-approval', 'on-request'] },
      { raw: '-a on-request', expected: ['--ask-for-approval', 'on-request'] },
      { raw: '-a=on-request', expected: ['--ask-for-approval', 'on-request'] },
      { raw: '--sandbox workspace-write', expected: ['--sandbox', 'workspace-write'] },
      { raw: '--sandbox=workspace-write', expected: ['--sandbox', 'workspace-write'] },
      { raw: '-s workspace-write', expected: ['--sandbox', 'workspace-write'] },
      { raw: '-s=workspace-write', expected: ['--sandbox', 'workspace-write'] },
    ];
    for (const { raw, expected } of cases) {
      assert.deepEqual(resolveTeamWorkerLaunchArgs({ existingRaw: raw }), expected, raw);
    }
  });

  it('normalizes approval and sandbox config policy forms without a value allowlist', () => {
    const cases: Array<{ raw: string; expected: string[] }> = [
      { raw: '-c approval_policy=custom-approval', expected: ['--ask-for-approval', 'custom-approval'] },
      { raw: '--config "sandbox_mode = \'workspace-write\'"', expected: ['--sandbox', 'workspace-write'] },
      { raw: `-c='approval_policy = "on-request"'`, expected: ['--ask-for-approval', 'on-request'] },
      { raw: '--config=sandbox_mode=workspace-write', expected: ['--sandbox', 'workspace-write'] },
    ];

    for (const { raw, expected } of cases) {
      assert.deepEqual(resolveTeamWorkerLaunchArgs({ existingRaw: raw }), expected, raw);
      assert.equal(parseTeamWorkerLaunchArgs(splitWorkerLaunchArgs(raw)).policyKind, 'direct-policy', raw);
    }
  });

  it('preserves unrelated config overrides while extracting only canonical provider and reasoning overrides', () => {
    assert.deepEqual(
      resolveTeamWorkerLaunchArgs({
        existingRaw: '--config unrelated=one -c unrelated=two -c=unrelated=three -c model_provider="envRouter" --config model_reasoning_effort=high',
      }),
      [
        '--config', 'unrelated=one',
        '-c', 'unrelated=two',
        '-c=unrelated=three',
        '--config', 'model_reasoning_effort=high',
        '-c', 'model_provider="envRouter"',
      ],
    );
  });

  it('rejects missing, empty, and option-shaped direct or config policy values', () => {
    for (const raw of [
      '--ask-for-approval', '--sandbox', '-a', '-s',
      '--ask-for-approval=', '--sandbox=', '-a=', '-s=',
      '--ask-for-approval --model', '--sandbox=-not-a-value',
      '-c', '--config', '-c=', '--config=',
      '-c --sandbox workspace-write', '--config --ask-for-approval on-request',
      '-c=--sandbox', '--config=--ask-for-approval',
      '-c approval_policy=', '--config=sandbox_mode=',
    ]) {
      assert.throws(
        () => resolveTeamWorkerLaunchArgs({ existingRaw: raw }),
        /Invalid OMX_TEAM_WORKER_LAUNCH_ARGS: missing value for (--ask-for-approval|--sandbox|-c|--config)/,
        raw,
      );
    }
  });

  it('collapses matching direct and config policy values and rejects deterministic conflicts', () => {
    assert.deepEqual(
      resolveTeamWorkerLaunchArgs({
        existingRaw: '-a on-request --config=approval_policy="on-request" -s workspace-write -c=sandbox_mode=workspace-write',
      }),
      ['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write'],
    );
    assert.equal(parseTeamWorkerLaunchArgs(['-a', ' on-request ']).approvalValue, ' on-request ');
    assert.throws(
      () => resolveTeamWorkerLaunchArgs({ existingRaw: '-a " on-request " --ask-for-approval=on-request' }),
      /conflicting duplicate approval policy/,
    );
    assert.throws(
      () => resolveTeamWorkerLaunchArgs({ existingRaw: '-a on-request -c approval_policy=never' }),
      /conflicting duplicate approval policy/,
    );
    assert.throws(
      () => resolveTeamWorkerLaunchArgs({ existingRaw: '-c=sandbox_mode=workspace-write --sandbox danger-full-access' }),
      /conflicting duplicate sandbox policy/,
    );
  });

  it('rejects explicit bypass plus direct or config policy but suppresses inherited bypass for policy', () => {
    for (const existingRaw of [
      '--dangerously-bypass-approvals-and-sandbox -a on-request',
      '--madmax --config approval_policy=on-request',
    ]) {
      assert.throws(
        () => resolveTeamWorkerLaunchArgs({ existingRaw }),
        /Invalid OMX_TEAM_WORKER_LAUNCH_ARGS: bypass cannot be combined with direct approval or sandbox policy/,
      );
    }
    assert.deepEqual(
      resolveTeamWorkerLaunchArgs({
        existingRaw: '-s workspace-write --no-alt-screen',
        inheritedArgs: [
          '--madmax',
          '-c', 'model_provider="leader"',
          '-c', 'model_reasoning_effort="high"',
          '--model', 'leader-model',
        ],
      }),
      [
        '--no-alt-screen',
        '--sandbox', 'workspace-write',
        '-c', 'model_provider="leader"',
        '-c', 'model_reasoning_effort="high"',
        '--model', 'leader-model',
      ],
    );
  });

  it('treats -- and its suffix as positional while keeping generated options before the marker', () => {
    const suffix = [
      '--',
      '--dangerously-bypass-approvals-and-sandbox',
      '--sandbox', 'workspace-write',
      '-c', 'sandbox_mode=workspace-write',
      '--model', 'positional-model',
      '-c', 'model_reasoning_effort=high',
      '-c', 'model_provider=positional',
    ];
    assert.deepEqual(
      resolveTeamWorkerLaunchArgs({
        existingRaw: ['-a', 'on-request', ...suffix].join(' '),
      }),
      ['--ask-for-approval', 'on-request', ...suffix],
    );
    assert.deepEqual(
      resolveTeamWorkerLaunchArgs({
        existingRaw: ['--no-alt-screen', '-a', 'on-request', '-c', 'model_provider=envRouter', '--', '--model', 'positional-model'].join(' '),
        fallbackModel: 'generated-model',
        preferredReasoning: 'high',
      }),
      [
        '--no-alt-screen',
        '--ask-for-approval', 'on-request',
        '-c', 'model_provider="envRouter"',
        '-c', 'model_reasoning_effort="high"',
        '--model', 'generated-model',
        '--', '--model', 'positional-model',
      ],
    );
  });

  it('keeps bypass-only input canonical and exposes direct policy metadata', () => {
    const parsed = parseTeamWorkerLaunchArgs(['--madmax']);
    assert.equal(parsed.policyKind, 'bypass');
    assert.deepEqual(
      resolveTeamWorkerLaunchArgs({ existingRaw: '--madmax --dangerously-bypass-approvals-and-sandbox' }),
      ['--dangerously-bypass-approvals-and-sandbox'],
    );
  });
});
