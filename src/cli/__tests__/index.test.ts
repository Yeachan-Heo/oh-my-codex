import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCodexLaunchArgs,
  buildTmuxSessionName,
  readTopLevelTomlString,
  upsertTopLevelTomlString,
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
