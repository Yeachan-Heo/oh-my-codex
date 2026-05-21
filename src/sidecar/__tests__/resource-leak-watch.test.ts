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

describe('sidecar watch resource cleanup', () => {
  it('unregisters SIGINT handlers when watch mode exits to avoid listener leaks', async () => {
    let sigintHandler: (() => void) | undefined;
    let unregisterCalls = 0;

    await runSidecarWatch('demo', { json: false, watch: true, tmux: false, intervalMs: 100 }, {}, {
      collect: async () => snapshot(),
      render: (frame) => `frame:${frame.team_name}`,
      writeStdout: () => {},
      writeStderr: () => {},
      registerSigint: (handler) => {
        sigintHandler = handler;
        return () => { unregisterCalls += 1; };
      },
      sleep: async () => { sigintHandler?.(); },
    });

    assert.equal(unregisterCalls, 1);
  });
});
