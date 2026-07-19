import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ralplanCommand, type RalplanCommandDependencies } from '../ralplan.js';

async function invoke(args: string[], deps: RalplanCommandDependencies = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previous = process.exitCode;
  try {
    process.exitCode = undefined;
    await ralplanCommand(args, { ...deps, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    process.exitCode = previous;
  }
}

async function captureStateFiles(paths: string[]): Promise<Array<string | null>> {
  return Promise.all(paths.map(async (path) => {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return `symlink:${await readlink(path)}`;
      return `file:${(await readFile(path)).toString('base64')}`;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }));
}

describe('#3212 ralplan documented-leader surface', () => {
  it('fails preflight closed without reading or writing every hostile state fixture', async () => {
    const fixtures = [
      {
        name: 'keyword-seeded',
        skill: '{"active":true,"skill":"ralplan","phase":"planning","source":"keyword-detector"}\n',
        mode: '{"active":true,"mode":"ralplan","current_phase":"planning"}\n',
      },
      { name: 'substantive', skill: '{"active":true,"skill":"ralplan","plan_path":".omx/plans/prd.md"}\n', mode: '{"active":true,"mode":"ralplan","current_phase":"review"}\n' },
      { name: 'foreign', skill: '{"active":true,"session_id":"foreign-session"}\n', mode: '{"active":true,"session_id":"foreign-session"}\n' },
      { name: 'stale', skill: '{"active":true,"updated_at":"1970-01-01T00:00:00.000Z"}\n', mode: '{"active":true,"updated_at":"1970-01-01T00:00:00.000Z"}\n' },
      { name: 'malformed', skill: '{not-json\n', mode: '[not-json\n' },
      { name: 'symlinked', skill: '{"active":true,"source":"symlink-target"}\n', mode: '{"active":true}\n', symlinkSkill: true },
      { name: 'oversized', skill: 'x'.repeat(16 * 1024 + 1), mode: 'y'.repeat(16 * 1024 + 1) },
      { name: 'absent' },
      { name: 'already-neutralized', skill: '{"active":false,"skill":"ralplan","phase":"blocked"}\n', mode: '{"active":false,"mode":"ralplan","current_phase":"blocked"}\n' },
    ];

    for (const fixture of fixtures) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-ralplan-preflight-${fixture.name}-`));
      const stateDir = join(cwd, '.omx', 'state', 'sessions', 'hostile-session');
      const skillPath = join(stateDir, 'skill-active-state.json');
      const modePath = join(stateDir, 'ralplan-state.json');
      const linkedSkillTargetPath = join(stateDir, 'foreign-skill-state.json');
      try {
        await mkdir(stateDir, { recursive: true });
        if (fixture.skill !== undefined) await writeFile(skillPath, fixture.skill);
        if (fixture.mode !== undefined) await writeFile(modePath, fixture.mode);
        if (fixture.symlinkSkill) {
          await writeFile(linkedSkillTargetPath, fixture.skill!);
          await rm(skillPath);
          await symlink(linkedSkillTargetPath, skillPath);
        }
        const before = await captureStateFiles([skillPath, modePath, linkedSkillTargetPath]);

        const result = await invoke(['preflight', '--json'], {
          cwd: () => { throw new Error('preflight must not inspect state'); },
        });

        assert.equal(result.exitCode, 1, fixture.name);
        assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unsupported_documented_leader_proof' }, fixture.name);
        assert.deepEqual(await captureStateFiles([skillPath, modePath, linkedSkillTargetPath]), before, fixture.name);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('validates malformed arguments before resolving a role', async () => {
    let resolved = false;
    await assert.rejects(() => invoke(['role-intent', 'write', '--role', 'architect', '--json'], {
      resolveInstalledRoleName: () => { resolved = true; return 'architect'; },
    }), /Missing --parent-thread/);
    assert.equal(resolved, false);
  });

  it('keeps unknown-role precedence without consulting an authority state source', async () => {
    const result = await invoke(['role-intent', 'write', '--role', 'synthetic-unknown', '--parent-thread', 'forged-parent', '--json'], {
      resolveInstalledRoleName: () => null,
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unknown_role' });
  });

  it('denies an installed role without consulting forgeable authority state', async () => {
    const result = await invoke(['role-intent', 'write', '--role', 'architect', '--parent-thread', 'forged-parent', '--session', 'forged-session', '--ttl-ms', '1', '--json'], {
      resolveInstalledRoleName: (role) => role === 'architect' ? role : null,
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unsupported_documented_leader_proof' });
  });
});
