import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('state-server Ralph phase contract', () => {
  it('normalizes legacy Ralph phase aliases on state_write', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-phase-'));
    try {
      const response = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'ralph',
            active: true,
            current_phase: 'execution',
            started_at: '2026-02-22T00:00:00.000Z',
          },
        },
      });
      assert.equal(response.isError, undefined);

      const file = join(wd, '.omx', 'state', 'ralph-state.json');
      const state = JSON.parse(await readFile(file, 'utf-8'));
      assert.equal(state.current_phase, 'executing');
      assert.equal(state.ralph_phase_normalized_from, 'execution');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects unknown Ralph phases on state_write', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-phase-'));
    try {
      const response = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'ralph',
            active: true,
            current_phase: 'bananas',
          },
        },
      });
      assert.equal(response.isError, true);
      const body = JSON.parse(response.content[0]?.text || '{}') as { error?: string };
      assert.match(body.error || '', /Invalid Ralph phase|must be one of/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects terminal Ralph phase when active=true', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-phase-'));
    try {
      const response = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'ralph',
            active: true,
            current_phase: 'complete',
          },
        },
      });
      assert.equal(response.isError, true);
      const body = JSON.parse(response.content[0]?.text || '{}') as { error?: string };
      assert.match(body.error || '', /terminal Ralph phases require active=false/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects fractional iteration values for Ralph state', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-phase-'));
    try {
      const response = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'ralph',
            active: true,
            current_phase: 'executing',
            iteration: 0.25,
            max_iterations: 10.5,
          },
        },
      });
      assert.equal(response.isError, true);
      const body = JSON.parse(response.content[0]?.text || '{}') as { error?: string };
      assert.match(body.error || '', /finite integer/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
