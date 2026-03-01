import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractRalphTaskDescription } from '../ralph.js';

describe('extractRalphTaskDescription', () => {
  it('returns plain task text from positional args', () => {
    assert.equal(
      extractRalphTaskDescription(['fix', 'the', 'bug']),
      'fix the bug'
    );
  });

  it('returns default when args are empty', () => {
    assert.equal(
      extractRalphTaskDescription([]),
      'ralph-cli-launch'
    );
  });

  it('returns default when args contain only flags', () => {
    assert.equal(
      extractRalphTaskDescription(['--model', 'gpt-5', '--yolo']),
      'ralph-cli-launch'
    );
  });

  it('excludes --model value from task text', () => {
    assert.equal(
      extractRalphTaskDescription(['--model', 'gpt-5', 'fix', 'the', 'bug']),
      'fix the bug'
    );
  });

  it('excludes --flag=value from task text', () => {
    assert.equal(
      extractRalphTaskDescription(['--model=gpt-5', 'fix', 'the', 'bug']),
      'fix the bug'
    );
  });

  it('excludes -c value from task text', () => {
    assert.equal(
      extractRalphTaskDescription(['-c', 'model_reasoning_effort="high"', 'refactor', 'auth']),
      'refactor auth'
    );
  });

  it('excludes -i (images-dir short) value from task text', () => {
    assert.equal(
      extractRalphTaskDescription(['-i', '/tmp/images', 'describe', 'screenshot']),
      'describe screenshot'
    );
  });

  it('excludes --images-dir value from task text', () => {
    assert.equal(
      extractRalphTaskDescription(['--images-dir', '/tmp/images', 'describe', 'screenshot']),
      'describe screenshot'
    );
  });

  it('excludes --provider value from task text', () => {
    assert.equal(
      extractRalphTaskDescription(['--provider', 'openai', 'fix', 'tests']),
      'fix tests'
    );
  });

  it('excludes --config value from task text', () => {
    assert.equal(
      extractRalphTaskDescription(['--config', '/path/to/config.toml', 'deploy']),
      'deploy'
    );
  });

  it('skips unknown boolean flags', () => {
    assert.equal(
      extractRalphTaskDescription(['--yolo', '--madmax', 'fix', 'it']),
      'fix it'
    );
  });

  it('handles mixed flags and task text', () => {
    assert.equal(
      extractRalphTaskDescription([
        '--model', 'gpt-5', '--yolo', '-c', 'model_reasoning_effort="xhigh"',
        'implement', 'feature', 'X'
      ]),
      'implement feature X'
    );
  });

  it('supports -- separator: everything after is task text', () => {
    assert.equal(
      extractRalphTaskDescription(['--model', 'gpt-5', '--', 'fix', '--weird-name', 'thing']),
      'fix --weird-name thing'
    );
  });

  it('-- separator with no following args returns default', () => {
    assert.equal(
      extractRalphTaskDescription(['--model', 'gpt-5', '--']),
      'ralph-cli-launch'
    );
  });

  it('handles --flag=value mixed with positional args', () => {
    assert.equal(
      extractRalphTaskDescription(['--model=gpt-5', '--config=/tmp/c.toml', 'add', 'tests']),
      'add tests'
    );
  });

  it('value-taking flag at end of args does not crash (value missing)', () => {
    // --model at the end with no following value — treated as consumed, no crash
    assert.equal(
      extractRalphTaskDescription(['fix', 'bug', '--model']),
      'fix bug'
    );
  });

  it('task text before and after flags is collected', () => {
    assert.equal(
      extractRalphTaskDescription(['fix', '--model', 'gpt-5', 'the', 'bug']),
      'fix the bug'
    );
  });

  it('single-dash -c=value form does not leak value into task text', () => {
    assert.equal(
      extractRalphTaskDescription(['-c=model_reasoning_effort="high"', 'fix', 'bug']),
      'fix bug'
    );
  });
});
