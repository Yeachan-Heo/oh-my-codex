import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HERDR_TEAM_WORKSPACE_LABEL_PREFIX,
  captureHerdrWorkerPane,
  createHerdrTeam,
  destroyHerdrTeam,
  ensureHerdrServer,
  isHerdrBinaryCallable,
  isHerdrWorkerAlive,
  listHerdrTeams,
  resolveHerdrBinary,
  teardownHerdrWorker,
} from '../herdr-session.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Integration test against a real `herdr` binary (v0.9.x), mirroring the
 * real-tmux suites: self-skipping when herdr is not installed. Starting a
 * `codex` agent launches the real Codex TUI idle — no API traffic.
 */
describe('herdr team session (real herdr)', () => {
  it('creates a team, proves liveness, captures, and tears down', async () => {
    if (!(await isHerdrBinaryCallable())) return; // skip: herdr not installed

    const dir = mkdtempSync(join(tmpdir(), 'omx-herdr-itest-'));
    const serverState = await ensureHerdrServer();
    let teamWorkspaceId: string | null = null;
    try {
      const uniqueTeam = `omxitest${Date.now().toString(36)}`;
      const team = await createHerdrTeam(uniqueTeam, dir, [
        { kind: 'codex', agentArgs: [], env: { OMX_HERDR_ITEST: '1' }, cwd: dir },
      ]);

      assert.equal(team.name, `herdr-${uniqueTeam}`);
      teamWorkspaceId = team.workspaceId;
      assert.equal(team.workspaceLabel, `omx-team-${uniqueTeam}`);
      assert.equal(team.workers.length, 1);
      const worker = team.workers[0];
      assert.match(worker.paneId, /^w[0-9a-z]+:p[0-9a-z]+$/i);
      assert.match(worker.agentName, /^omx-/);

      assert.equal(await isHerdrWorkerAlive(worker.paneId), true);
      const captured = await captureHerdrWorkerPane(worker.paneId, 40);
      assert.ok(typeof captured === 'string');

      const listed = await listHerdrTeams();
      assert.ok(listed.some((t) => t.workspaceId === team.workspaceId));

      await teardownHerdrWorker(worker.paneId);
      assert.equal(await isHerdrWorkerAlive(worker.paneId), false);
      await destroyHerdrTeam(team.workspaceId);
      const listedAfter = await listHerdrTeams();
      assert.ok(!listedAfter.some((t) => t.workspaceId === team.workspaceId));
    } finally {
      if (teamWorkspaceId) {
        try { await destroyHerdrTeam(teamWorkspaceId); } catch { /* best-effort */ }
      }
      rmSync(dir, { recursive: true, force: true });
      if (serverState === 'started') {
        // We spawned the headless server for this test; stop it again so the
        // user's machine is left as we found it. `server stop` prints no JSON,
        // so this bypasses the envelope parser.
        const bin = resolveHerdrBinary();
        if (bin) { try { await execFileAsync(bin, ['server', 'stop']); } catch { /* best-effort */ } }
      }
    }
  });
});
