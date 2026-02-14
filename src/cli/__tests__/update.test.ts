import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPromptForUpdate } from '../update.js';

describe('shouldPromptForUpdate', () => {
  it('is false by default', () => {
    const prev = process.env.OMX_AUTO_UPDATE_PROMPT;
    delete process.env.OMX_AUTO_UPDATE_PROMPT;
    try {
      assert.equal(shouldPromptForUpdate(), false);
    } finally {
      if (prev === undefined) delete process.env.OMX_AUTO_UPDATE_PROMPT;
      else process.env.OMX_AUTO_UPDATE_PROMPT = prev;
    }
  });

  it('is true when OMX_AUTO_UPDATE_PROMPT=1', () => {
    const prev = process.env.OMX_AUTO_UPDATE_PROMPT;
    process.env.OMX_AUTO_UPDATE_PROMPT = '1';
    try {
      assert.equal(shouldPromptForUpdate(), true);
    } finally {
      if (prev === undefined) delete process.env.OMX_AUTO_UPDATE_PROMPT;
      else process.env.OMX_AUTO_UPDATE_PROMPT = prev;
    }
  });
});

