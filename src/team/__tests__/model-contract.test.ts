import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectInheritableTeamWorkerArgs,
  isLowComplexityAgentType,
  resolveTeamWorkerLaunchArgs,
  TEAM_LOW_COMPLEXITY_DEFAULT_MODEL,
} from '../model-contract.js';

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

  it('keeps exactly one canonical model flag with precedence env > inherited > fallback', () => {
    assert.deepEqual(
      resolveTeamWorkerLaunchArgs({
        existingRaw: '--model env-a --model=env-b',
        inheritedArgs: ['--model', 'inherited-model'],
        fallbackModel: TEAM_LOW_COMPLEXITY_DEFAULT_MODEL,
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
        fallbackModel: TEAM_LOW_COMPLEXITY_DEFAULT_MODEL,
      }),
      ['--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox', '--model', TEAM_LOW_COMPLEXITY_DEFAULT_MODEL],
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
    assert.equal(isLowComplexityAgentType('writer'), true);
    assert.equal(isLowComplexityAgentType('style-reviewer'), true);
    assert.equal(isLowComplexityAgentType('executor'), false);
    assert.equal(isLowComplexityAgentType('executor-low'), true);
  });
});
