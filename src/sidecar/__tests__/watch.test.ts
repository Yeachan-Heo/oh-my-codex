import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runSidecarWatch } from '../index.js';
import type { SidecarSnapshot } from '../types.js';

function snapshot(): SidecarSnapshot {
  return {
    schema_version: 'omx.sidecar/v1',
    generated_at: '2026-04-27T02:01:00.000Z',
    team_name: 'demo',
    team_task: 'ship sidecar',
    phase: null,
    topology: { summary: '0 workers', nodes: ['leader'], edges: [] },
    workers: [],
    tasks: [],
    events: [],
    panes: [],
    highlights: [],
    source_warnings: [],
  };
}

describe('runSidecarWatch', () => {
  it('renders read-only frames and restores cursor when stopped', async () => {
    const writes: string[] = [];
    let sigintHandler: (() => void) | undefined;
    let collectCalls = 0;

    await runSidecarWatch('demo', { json: false, watch: true, tmux: false, intervalMs: 100 }, {}, {
      collect: async () => { collectCalls += 1; return snapshot(); },
      render: (frame, options) => `frame:${frame.team_name}:${options.width}:${options.height}`,
      writeStdout: (text) => { writes.push(text); },
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      stdoutColumns: () => 51,
      stdoutRows: () => 22,
      sleep: async () => { sigintHandler?.(); },
    });

    assert.equal(collectCalls, 1);
    assert.ok(writes.some((chunk) => chunk.includes('\x1b[?25l')), 'watch hides cursor');
    assert.ok(writes.some((chunk) => chunk.includes('\x1b[2J\x1b[H')), 'first render clears screen');
    assert.ok(writes.some((chunk) => chunk.includes('frame:demo:51:22')), 'watch writes rendered sidecar frame');
    assert.ok(writes.some((chunk) => chunk.includes('\x1b[?25h')), 'watch restores cursor');
  });
});
