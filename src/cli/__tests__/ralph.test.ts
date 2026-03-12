import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { extractRalphTaskDescription, normalizeRalphCliArgs, filterRalphCodexArgs } from '../ralph.js';

describe('extractRalphTaskDescription', () => {
  it('returns plain task text from positional args', () => {
    assert.equal(extractRalphTaskDescription(['fix', 'the', 'bug']), 'fix the bug');
  });
  it('returns default when args are empty', () => {
    assert.equal(extractRalphTaskDescription([]), 'ralph-cli-launch');
  });
  it('excludes --model value from task text', () => {
    assert.equal(extractRalphTaskDescription(['--model', 'gpt-5', 'fix', 'the', 'bug']), 'fix the bug');
  });
  it('supports -- separator', () => {
    assert.equal(extractRalphTaskDescription(['--model', 'gpt-5', '--', 'fix', '--weird-name']), 'fix --weird-name');
  });
});

describe('normalizeRalphCliArgs', () => {
  it('converts --prd value into positional task text', () => {
    assert.deepEqual(normalizeRalphCliArgs(['--prd', 'ship release checklist']), ['ship release checklist']);
  });
  it('converts --prd=value into positional task text', () => {
    assert.deepEqual(normalizeRalphCliArgs(['--prd=fix the bug']), ['fix the bug']);
  });
  it('preserves other flags and args', () => {
    assert.deepEqual(normalizeRalphCliArgs(['--model', 'gpt-5', '--prd', 'fix it']), ['--model', 'gpt-5', 'fix it']);
  });
});

describe('filterRalphCodexArgs', () => {
  it('consumes --prd so it is not forwarded to codex', () => {
    assert.deepEqual(filterRalphCodexArgs(['--prd', 'build', 'todo', 'app']), ['build', 'todo', 'app']);
  });
  it('consumes --PRD case-insensitively', () => {
    assert.deepEqual(filterRalphCodexArgs(['--PRD', '--model', 'gpt-5']), ['--model', 'gpt-5']);
  });
  it('preserves non-omx flags', () => {
    assert.deepEqual(filterRalphCodexArgs(['--model', 'gpt-5', '--yolo', 'fix', 'it']), ['--model', 'gpt-5', '--yolo', 'fix', 'it']);
  });
});
