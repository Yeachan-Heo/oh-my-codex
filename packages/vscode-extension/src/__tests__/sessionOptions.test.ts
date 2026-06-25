import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildLaunchPreviewArgs,
  normalizePrompt,
  resolveOmxCommand,
} from '../sessionOptions';

describe('sessionOptions', () => {
  it('normalizes optional prompts', () => {
    assert.equal(normalizePrompt(undefined), undefined);
    assert.equal(normalizePrompt('   '), undefined);
    assert.equal(normalizePrompt('  ship it  '), 'ship it');
  });

  it('builds preview args without mutating configured defaults', () => {
    const defaults = ['--model', 'gpt-5'];
    const preview = buildLaunchPreviewArgs(defaults, '  review logs  ');

    assert.deepEqual(preview, ['--model', 'gpt-5', 'review logs']);
    assert.deepEqual(defaults, ['--model', 'gpt-5']);
    assert.notEqual(preview, defaults);
  });

  it('resolves configured command before workspace fallback', () => {
    assert.equal(resolveOmxCommand('/repo', '  /bin/omx  '), '/bin/omx');
    assert.equal(resolveOmxCommand('/__omx_missing_workspace__', ''), 'omx');
  });
});
