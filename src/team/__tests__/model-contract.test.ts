import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectInheritableTeamWorkerArgs,
  isLowComplexityAgentType,
  resolveAgentDefaultModel,
  resolveAgentReasoningEffort,
  resolveTeamWorkerLaunchArgs,
  TEAM_LOW_COMPLEXITY_DEFAULT_MODEL,
  resolveTeamLowComplexityDefaultModel,
} from '../model-contract.js';

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
        '--model=gpt-5.3',
      ]),
      [
        '--dangerously-bypass-approvals-and-sandbox',
        '-c',
        'model_reasoning_effort="xhigh"',
        '--model',
        'gpt-5.3',
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
        'gpt-5.5',
      ]),
      ['-c', 'model_provider="cheapRouter"', '--model', 'gpt-5.5'],
    );
  });

  it('keeps exactly one model_provider override with precedence env > inherited', () => {
    assert.deepEqual(
      resolveTeamWorkerLaunchArgs({
        existingRaw: '-c model_provider="envRouter" --no-alt-screen',
        inheritedArgs: ['-c', 'model_provider="leaderRouter"', '--model', 'gpt-5.5'],
      }),
      ['--no-alt-screen', '-c', 'model_provider="envRouter"', '--model', 'gpt-5.5'],
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
    assert.equal(resolveAgentReasoningEffort('architect'), 'high');
    assert.equal(resolveAgentReasoningEffort('does-not-exist'), undefined);
  });

  it('maps worker roles through configured per-agent reasoning overrides', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-model-contract-reasoning-'));
    try {
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
        agentReasoning: {
          architect: 'xhigh',
        },
      }));

      assert.equal(resolveAgentReasoningEffort('architect', codexHome), 'xhigh');
      assert.equal(resolveAgentReasoningEffort('critic', codexHome), 'high');
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('maps worker roles to configured default model lanes', () => {
    withIsolatedDefaultModelEnv(() => {
      assert.equal(resolveAgentDefaultModel('explore'), expectedLowComplexityModel());
      assert.equal(resolveAgentDefaultModel('writer'), 'gpt-5.5');
      assert.equal(resolveAgentDefaultModel('executor'), 'gpt-5.5');
      assert.equal(resolveAgentDefaultModel('architect'), 'gpt-5.5');
      assert.equal(resolveAgentDefaultModel('does-not-exist'), undefined);
    });
  });

  it('keeps assigned worker roles as their own runtime identity', () => {
    withIsolatedDefaultModelEnv(() => {
      assert.equal(resolveAgentDefaultModel('explore'), expectedLowComplexityModel());
      assert.equal(resolveAgentReasoningEffort('explore'), 'low');
      assert.equal(resolveAgentDefaultModel('style-reviewer'), expectedLowComplexityModel());
      assert.equal(resolveAgentReasoningEffort('style-reviewer'), 'low');
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

  it('does not inject thinking when model is explicit but reasoning is omitted', () => {
    const result = resolveTeamWorkerLaunchArgs({
      existingRaw: '--model claude-opus-4',
    });
    const joined = result.join(' ');
    assert.ok(!joined.includes('model_reasoning_effort'), `Expected no reasoning in: ${joined}`);
  });
});
