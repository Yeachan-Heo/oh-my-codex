import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGitBranch } from '../state.js';

describe('readGitBranch', () => {
  it('returns null in a non-git directory without printing git fatal noise', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-state-'));
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);

    const patchedWrite = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void), callback?: (err?: Error | null) => void) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      stderrChunks.push(text);
      if (typeof encodingOrCallback === 'function') encodingOrCallback(null);
      if (typeof callback === 'function') callback(null);
      return true;
    }) as typeof process.stderr.write;

    process.stderr.write = patchedWrite;

    try {
      assert.equal(readGitBranch(cwd), null);
    } finally {
      process.stderr.write = originalWrite;
      await rm(cwd, { recursive: true, force: true });
    }

    assert.equal(stderrChunks.join('').includes('not a git repository'), false);
  });
});
