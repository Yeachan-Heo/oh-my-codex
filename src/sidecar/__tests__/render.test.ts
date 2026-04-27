import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderSidecar } from '../render.js';
import type { SidecarSnapshot } from '../types.js';

const SNAPSHOT: SidecarSnapshot = {
  schema_version: 'omx.sidecar/v1',
  generated_at: '2026-04-27T02:01:00.000Z',
  team_name: 'demo',
  team_task: 'ship sidecar',
  phase: 'team-exec',
  topology: {
    summary: '2 workers · 1 working · 1 blocked · 1 in progress · 0 pending',
    nodes: ['leader', 'worker-1', 'worker-2'],
    edges: [{ from: 'leader', to: 'worker-1', label: 'task-1' }],
  },
  workers: [
    {
      name: 'worker-1', index: 1, role: 'executor', assigned_tasks: ['1'], pane_id: '%3',
      status: { state: 'working', current_task_id: '1' }, heartbeat: { alive: true, turn_count: 8 }, alive: true,
      current_task: { id: '1', subject: 'Implement collector', description: '', status: 'in_progress', owner: 'worker-1' },
      turns_without_progress: 7,
    },
  ],
  tasks: [{ id: '1', subject: 'Implement collector', description: '', status: 'in_progress', owner: 'worker-1' }],
  events: [{ event_id: 'e1', team: 'demo', type: 'worker_state_changed', worker: 'worker-1', state: 'working', created_at: '2026-04-27T02:00:00.000Z' }],
  panes: [{ target: 'worker-1', pane_id: '%3', role: 'worker' }],
  highlights: [{ severity: 'warning', target: 'worker-1', kind: 'non-reporting-worker', message: 'worker-1 has 7 turns without task progress' }],
  source_warnings: [],
};

describe('renderSidecar', () => {
  it('renders stacked text panels with core visualization vocabulary', () => {
    const output = renderSidecar(SNAPSHOT, { width: 88, color: false });
    for (const label of ['OMX Sidecar · demo', 'Topology', 'Agents', 'Tasks', 'Highlights', 'Panes', 'Events']) {
      assert.match(output, new RegExp(label));
    }
    assert.match(output, /worker-1 \[working\/alive\] executor task-1 %3 Δturns=7/);
    assert.match(output, /task-1 \[in_progress\] @worker-1 Implement collector/);
    assert.match(output, /worker-1 has 7 turns without task progress/);
  });


  it('does not leak raw ANSI fragments in default colored panel content', () => {
    const output = renderSidecar({ ...SNAPSHOT, highlights: [], source_warnings: ['watch warning'] }, { width: 88 });
    assert.match(output, /no blockers detected/);
    assert.match(output, /watch warning/);
    assert.doesNotMatch(output, /(?:^|[^\x1b])\[(?:32|33|0)m/);
  });

  it('sanitizes dynamic header and panel values before terminal rendering', () => {
    const output = renderSidecar({
      ...SNAPSHOT,
      team_name: 'demo\u001b]0;owned\u0007\u001b[31m',
      phase: 'team-exec\u001b[2J\u0001',
      topology: { ...SNAPSHOT.topology, summary: 'safe\u001b[31m summary' },
      tasks: [{ ...SNAPSHOT.tasks[0]!, subject: 'task\u001b]2;owned\u0007 subject' }],
      events: [{ ...SNAPSHOT.events[0]!, reason: 'reason\u001b[2J' }],
      highlights: [{ ...SNAPSHOT.highlights[0]!, message: 'highlight\u001b[31m message' }],
    }, { width: 88, color: false });

    assert.match(output, /OMX Sidecar · demo/);
    assert.match(output, /phase=team-exec/);
    assert.doesNotMatch(output, /\x1b\]/);
    assert.doesNotMatch(output, /\x1b\[[0-?]*[ -/]*[@-~]/);
    assert.doesNotMatch(output, /owned/);
  });

  it('honors height truncation for narrow right-side panes', () => {
    const output = renderSidecar(SNAPSHOT, { width: 44, height: 5, color: false });
    assert.ok(output.split('\n').length <= 5);
    assert.match(output, /more lines/);
  });
});
