import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initTeamState, readTeamManifestV2, writeTeamManifestV2 } from '../../team/state.js';

async function files(root: string, dir = root): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, await files(root, path));
    else result[relative(root, path)] = (await readFile(path)).toString('base64');
  }
  return result;
}

it('reads named and inferred team status under an actual read-only filesystem', async (t) => {
  if (process.platform !== 'linux') return t.skip('requires Linux mount namespaces');
  const cwd = await mkdtemp(join(tmpdir(), 'omx-status-rofs-'));
  try {
    const prefix = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--chdir', cwd];
    const probe = spawnSync('bwrap', [...prefix, process.execPath, '-e', "require('fs').writeFileSync('probe','x')"], { encoding: 'utf8' });
    if (probe.error || !probe.stderr.includes('EROFS')) return t.skip('read-only bwrap mount namespace unavailable');
    await initTeamState('readonly-team', 'inspect', 'executor', 1, cwd);
    const manifest = await readTeamManifestV2('readonly-team', cwd);
    assert.ok(manifest);
    manifest.leader.session_id = 'readonly-leader';
    await writeTeamManifestV2(manifest, cwd);
    const before = await files(cwd);
    const bin = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'cli', 'omx.js');
    const env: NodeJS.ProcessEnv = { ...process.env, OMX_ROOT: cwd, OMX_AUTO_UPDATE: '0' };
    for (const key of ['OMX_STATE_ROOT', 'OMX_SESSION_ID', 'OMX_TEAM_WORKER', 'OMX_TEAM_INTERNAL_WORKER', 'OMX_TEAM_STATE_ROOT', 'OMX_TEAM_LEADER_CWD', 'TMUX', 'TMUX_PANE']) delete env[key];
    env.OMX_SESSION_ID = 'readonly-leader';
    for (const args of [['--json'], ['readonly-team', '--json'], ['--tail-lines', '600', '--json'], ['--json', '--tail-lines', '600', 'readonly-team'], ['--tail-lines=550', '--json']]) {
      const result = spawnSync('bwrap', [...prefix, process.execPath, bin, 'team', 'status', ...args], {
        env, encoding: 'utf8', timeout: 15000,
      });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      const payload = JSON.parse(result.stdout) as { team_name: string; tail_lines: number };
      assert.equal(payload.team_name, 'readonly-team');
      if (args.includes('600')) assert.equal(payload.tail_lines, 600);
      if (args.includes('--tail-lines=550')) assert.equal(payload.tail_lines, 550);
      assert.deepEqual(await files(cwd), before);
    }
    env.OMX_SESSION_ID = 'foreign-leader';
    const foreign = spawnSync('bwrap', [...prefix, process.execPath, bin, 'team', 'status', '--json'], {
      env, encoding: 'utf8', timeout: 15000,
    });
    assert.notEqual(foreign.status, 0, 'unnamed status must not infer a foreign team');
    assert.match(foreign.stderr, /Usage: omx team status/);
    assert.deepEqual(await files(cwd), before);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
