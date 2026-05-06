import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getScopedStatePath,
  readScopedJsonIfExists,
  resolveScopedStateDir,
  writeScopedJson,
} from '../notify-hook/state-io.js';

describe('notify-hook state I/O session authority', () => {
  it('uses an explicit session id before the current session pointer', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-state-io-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(join(stateDir, 'sessions', 'sess-current'), { recursive: true });
      await mkdir(join(stateDir, 'sessions', 'sess-explicit'), { recursive: true });
      await writeFile(
        join(stateDir, 'session.json'),
        JSON.stringify({ session_id: 'sess-current', cwd: wd }, null, 2),
        'utf-8',
      );

      assert.equal(
        await resolveScopedStateDir(stateDir, 'sess-explicit'),
        join(stateDir, 'sessions', 'sess-explicit'),
      );
      assert.equal(
        await getScopedStatePath(stateDir, 'hud-state.json', 'sess-explicit'),
        join(stateDir, 'sessions', 'sess-explicit', 'hud-state.json'),
      );

      await writeScopedJson(stateDir, 'hud-state.json', 'sess-explicit', { turn_count: 3 });
      const explicitHud = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-explicit', 'hud-state.json'), 'utf-8'),
      ) as { turn_count?: unknown };
      assert.equal(explicitHud.turn_count, 3);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not read current-session data when an explicit session has no state file', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-state-io-missing-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(join(stateDir, 'sessions', 'sess-current'), { recursive: true });
      await writeFile(
        join(stateDir, 'session.json'),
        JSON.stringify({ session_id: 'sess-current', cwd: wd }, null, 2),
        'utf-8',
      );
      await writeFile(
        join(stateDir, 'sessions', 'sess-current', 'auto-nudge-state.json'),
        JSON.stringify({ count: 9 }, null, 2),
        'utf-8',
      );

      const value = await readScopedJsonIfExists(
        stateDir,
        'auto-nudge-state.json',
        'sess-explicit',
        null,
      );
      assert.equal(value, null);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
