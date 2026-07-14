import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { recordSkillActivation } from '../../hooks/keyword-detector.js';
import {
  listActiveSkills,
  readVisibleSkillActiveStateForStateDir,
} from '../../state/skill-active.js';
import { dispatchCodexNativeHook } from '../codex-native-hook.js';

describe('code-review workflow event chain', () => {
  it('preserves active ralplan canonical state and Stop blocking across a code-review overlay', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-code-review-overlay-e2e-'));
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'sess-code-review-overlay-e2e';
    const threadId = 'thread-code-review-overlay-e2e';

    try {
      await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: '$ralplan review the implementation plan',
        sessionId,
        threadId,
        turnId: 'turn-ralplan',
        nowIso: '2026-07-14T00:00:00.000Z',
      });
      await recordSkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: '$code-review inspect the current diff',
        sessionId,
        threadId,
        turnId: 'turn-code-review',
        nowIso: '2026-07-14T00:01:00.000Z',
      });

      const canonical = await readVisibleSkillActiveStateForStateDir(stateDir, sessionId);
      const ralplanDetail = JSON.parse(await readFile(
        join(stateDir, 'sessions', sessionId, 'ralplan-state.json'),
        'utf-8',
      )) as { active?: unknown };
      const stop = await dispatchCodexNativeHook({
        hook_event_name: 'Stop',
        cwd,
        session_id: sessionId,
        thread_id: threadId,
        turn_id: 'turn-stop',
      }, { cwd });

      assert.deepEqual({
        canonicalEntries: listActiveSkills(canonical).map((entry) => entry.skill),
        ralplanDetailActive: ralplanDetail.active,
        stopDecision: stop.outputJson?.decision ?? null,
      }, {
        canonicalEntries: ['ralplan', 'code-review'],
        ralplanDetailActive: true,
        stopDecision: 'block',
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
