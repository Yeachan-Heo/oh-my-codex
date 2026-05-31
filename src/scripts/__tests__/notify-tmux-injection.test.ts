import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readVisibleAllowedModes } from '../notify-hook/tmux-injection.js';

describe('notify-hook tmux injection canonical skill gating', () => {
  it('reads canonical skill-active state from authoritative team state root', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-tmux-team-root-'));
    try {
      const teamStateRoot = join(wd, 'team-state-root');
      const sessionId = 'sess-team-root';
      await mkdir(join(teamStateRoot, 'sessions', sessionId), { recursive: true });
      await writeFile(
        join(teamStateRoot, 'session.json'),
        JSON.stringify({ session_id: sessionId, cwd: join(wd, 'source-repo') }, null, 2),
        'utf-8',
      );
      await writeFile(
        join(teamStateRoot, 'sessions', sessionId, 'skill-active-state.json'),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'ralplan',
          phase: 'draft',
          session_id: sessionId,
          active_skills: [{ skill: 'ralplan', active: true, phase: 'draft', session_id: sessionId }],
        }, null, 2),
        'utf-8',
      );

      const visible = await readVisibleAllowedModes(
        join(wd, 'source-repo'),
        teamStateRoot,
        {},
        ['ralplan', 'deep-interview'],
      );

      assert.equal(visible.canonicalPresent, true);
      assert.equal(visible.preferredMode, 'ralplan');
      assert.deepEqual([...visible.allowedSet ?? []], ['ralplan']);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
