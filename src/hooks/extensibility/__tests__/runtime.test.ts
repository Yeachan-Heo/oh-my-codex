import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { dispatchHookEventRuntime } from '../runtime.js';
import { buildHookEvent } from '../events.js';
import { initTeamState, readTeamLeaderAttention, readTeamManifestV2, writeTeamLeaderAttention, writeTeamManifestV2 } from '../../../team/state.js';

describe('dispatchHookEventRuntime', () => {
  it('dispatches native events even when plugins env var is not set', async () => {
    const originalEnv = process.env.OMX_HOOK_PLUGINS;
    try {
      delete process.env.OMX_HOOK_PLUGINS;

      const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
      try {
        const event = buildHookEvent('session-start');
        const result = await dispatchHookEventRuntime({ cwd, event });

        assert.equal(result.dispatched, true);
        assert.equal(result.reason, 'ok');
        assert.equal(result.result.enabled, true);
        assert.equal(result.result.plugin_count, 0);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    } finally {
      if (originalEnv !== undefined) {
        process.env.OMX_HOOK_PLUGINS = originalEnv;
      } else {
        delete process.env.OMX_HOOK_PLUGINS;
      }
    }
  });

  it('dispatches when plugins are enabled', async () => {
    const originalEnv = process.env.OMX_HOOK_PLUGINS;
    try {
      process.env.OMX_HOOK_PLUGINS = '1';

      const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
      try {
        const dir = join(cwd, '.omx', 'hooks');
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, 'rt-test.mjs'),
          'export async function onHookEvent() {}',
        );

        const event = buildHookEvent('session-start');
        const result = await dispatchHookEventRuntime({ cwd, event });

        assert.equal(result.dispatched, true);
        assert.equal(result.reason, 'ok');
        assert.equal(result.result.enabled, true);
        assert.equal(result.result.plugin_count, 1);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    } finally {
      if (originalEnv !== undefined) {
        process.env.OMX_HOOK_PLUGINS = originalEnv;
      } else {
        delete process.env.OMX_HOOK_PLUGINS;
      }
    }
  });

  it('passes allowTeamWorkerSideEffects through to dispatcher', async () => {
    const originalEnv = process.env.OMX_HOOK_PLUGINS;
    try {
      process.env.OMX_HOOK_PLUGINS = '1';

      const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
      try {
        const event = buildHookEvent('turn-complete');
        const result = await dispatchHookEventRuntime({
          cwd,
          event,
          allowTeamWorkerSideEffects: true,
        });

        assert.equal(result.dispatched, true);
        assert.equal(result.result.enabled, true);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    } finally {
      if (originalEnv !== undefined) {
        process.env.OMX_HOOK_PLUGINS = originalEnv;
      } else {
        delete process.env.OMX_HOOK_PLUGINS;
      }
    }
  });

  it('returns event name and source in result', async () => {
    const originalEnv = process.env.OMX_HOOK_PLUGINS;
    try {
      delete process.env.OMX_HOOK_PLUGINS;

      const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
      try {
        const event = buildHookEvent('needs-input');
        const result = await dispatchHookEventRuntime({ cwd, event });

        assert.equal(result.result.event, 'needs-input');
        assert.equal(result.result.source, 'derived');
        assert.equal(result.result.enabled, true);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    } finally {
      if (originalEnv !== undefined) {
        process.env.OMX_HOOK_PLUGINS = originalEnv;
      } else {
        delete process.env.OMX_HOOK_PLUGINS;
      }
    }
  });

  it('marks active leader-owned teams when a native stop event is dispatched without inventing leader attention', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-stop-team-'));
    try {
      await initTeamState('stop-owned-team', 'stop test', 'executor', 1, cwd);
      const manifest = await readTeamManifestV2('stop-owned-team', cwd);
      assert.ok(manifest);
      await writeTeamManifestV2({
        ...manifest!,
        leader: {
          ...manifest!.leader,
          session_id: 'leader-session-stop',
        },
      }, cwd);
      await writeTeamLeaderAttention('stop-owned-team', {
        team_name: 'stop-owned-team',
        updated_at: '2026-03-10T10:00:00.000Z',
        source: 'notify_hook',
        leader_decision_state: 'still_actionable',
        leader_attention_pending: false,
        leader_attention_reason: null,
        attention_reasons: [],
        leader_stale: false,
        leader_session_active: true,
        leader_session_id: 'leader-session-stop',
        leader_session_stopped_at: null,
        unread_leader_message_count: 0,
        work_remaining: true,
        stalled_for_ms: null,
      }, cwd);

      const event = buildHookEvent('stop', {
        source: 'native',
        session_id: 'leader-session-stop',
      });
      const result = await dispatchHookEventRuntime({ cwd, event });
      const attention = await readTeamLeaderAttention('stop-owned-team', cwd);

      assert.equal(result.dispatched, true);
      assert.equal(attention?.source, 'native_stop');
      assert.equal(attention?.leader_session_active, false);
      assert.equal(attention?.leader_attention_pending, false);
      assert.equal(attention?.leader_decision_state, 'still_actionable');
      assert.equal(attention?.work_remaining, true);
      assert.equal(attention?.leader_attention_reason, null);
      assert.deepEqual(attention?.attention_reasons, []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
