import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runOmx(cwd: string, argv: string[], env: NodeJS.ProcessEnv = process.env) {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');
  return spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env,
  });
}

describe('omx session help', () => {
  it('documents the session search command in help output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-help-'));
    try {
      const lockRoot = join(cwd, '.omx', 'state');
      const lockPath = join(lockRoot, 'session.json.lock');
      const pointerPath = join(lockRoot, 'session.json');
      await mkdir(lockPath, { recursive: true });
      await writeFile(pointerPath, '{"session":"pointer-evidence"}\n', 'utf-8');
      await writeFile(join(lockPath, 'owner.json.tmp-stalled'), '{"incomplete":true}\n', 'utf-8');
      const pointerBefore = await readFile(pointerPath, 'utf-8');
      const lockBefore = await readFile(join(lockPath, 'owner.json.tmp-stalled'), 'utf-8');

      const mainHelp = runOmx(cwd, ['--help']);
      assert.equal(mainHelp.status, 0, mainHelp.stderr || mainHelp.stdout);
      assert.match(mainHelp.stdout, /omx resume\s+Resume Codex sessions \(supports --project and --codex-home <path>\)/i);
      assert.match(mainHelp.stdout, /omx autoresearch\s+\[DEPRECATED\] Use \$autoresearch; direct CLI launch removed/i);
      assert.match(mainHelp.stdout, /omx session\s+Search and summarize local session history \(--codex-home <path> escape hatch\)/i);

      const sessionHelp = runOmx(cwd, ['session', '--help']);
      assert.equal(sessionHelp.status, 0, sessionHelp.stderr || sessionHelp.stdout);
      assert.match(sessionHelp.stdout, /omx session search <query>/i);
      assert.match(sessionHelp.stdout, /omx session friction \[options\]/i);
      assert.match(sessionHelp.stdout, /Options for friction:/i);
      assert.match(sessionHelp.stdout, /--since <spec>/i);
      assert.match(sessionHelp.stdout, /--codex-home <path>/i);


      const lockHelp = runOmx(cwd, ['session', 'lock', '--help']);
      assert.equal(lockHelp.status, 0, lockHelp.stderr || lockHelp.stdout);
      assert.match(lockHelp.stdout, /omx session lock <inspect\|recover>/i);
      const pointerHelp = runOmx(cwd, ['session', 'pointer', '--help']);
      assert.equal(pointerHelp.status, 0, pointerHelp.stderr || pointerHelp.stdout);
      assert.match(pointerHelp.stdout, /omx session pointer recover/i);

      const inspection = runOmx(cwd, ['session', 'lock', 'inspect', '--cwd', cwd, '--json']);
      assert.equal(inspection.status, 0, inspection.stderr || inspection.stdout);
      const inspected = JSON.parse(inspection.stdout) as { lockPath: string; safeToRecover: boolean };
      assert.equal(inspected.lockPath, lockPath);
      assert.equal(typeof inspected.safeToRecover, 'boolean');
      assert.equal(await readFile(pointerPath, 'utf-8'), pointerBefore);
      assert.equal(await readFile(join(lockPath, 'owner.json.tmp-stalled'), 'utf-8'), lockBefore);

      const blockedRecovery = runOmx(cwd, ['session', 'lock', 'recover', '--cwd', cwd, '--json']);
      assert.equal(blockedRecovery.status, 1, blockedRecovery.stderr || blockedRecovery.stdout);
      const recovery = JSON.parse(blockedRecovery.stdout) as { action: string; recovered: boolean; reason: string };
      assert.equal(recovery.action, 'none');
      assert.equal(recovery.recovered, false);
      assert.match(recovery.reason, /not safe to recover/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('recovers a verified-dead pointer with deterministic JSON and human output', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'omx-session-pointer-cli-')));
    try {
      const stateRoot = join(cwd, '.omx', 'state');
      const pointerPath = join(stateRoot, 'session.json');
      const runtime = join(cwd, 'runtime-no-replace.cjs');
      const pointerBody = JSON.stringify({
        session_id: 'dead-cli-owner',
        started_at: '2026-08-14T00:00:00.000Z',
        cwd,
        state_root: stateRoot,
        pid: 8388607,
      });
      await mkdir(stateRoot, { recursive: true });
      await writeFile(pointerPath, pointerBody, 'utf-8');
      await writeFile(runtime, [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'const [, , command, from, to] = process.argv;',
        'if (command !== "fs-rename-no-replace") process.exit(2);',
        'if (fs.existsSync(to)) console.log(JSON.stringify({ outcome: "not-moved" }));',
        'else { fs.renameSync(from, to); console.log(JSON.stringify({ outcome: "moved" })); }',
      ].join('\n'), 'utf-8');
      await chmod(runtime, 0o755);
      const env = { ...process.env, OMX_RUNTIME_BINARY: runtime };

      const recovered = runOmx(cwd, ['session', 'pointer', 'recover', '--json'], env);
      assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
      const result = JSON.parse(recovered.stdout) as {
        status: string;
        pointerPath: string;
        recovered: boolean;
        action: string;
        reason: string;
        sessionId: string;
        quarantinePath: string;
      };
      assert.deepEqual({
        status: result.status,
        pointerPath: result.pointerPath,
        recovered: result.recovered,
        action: result.action,
        reason: result.reason,
        sessionId: result.sessionId,
      }, {
        status: 'recovered',
        pointerPath,
        recovered: true,
        action: 'quarantined',
        reason: 'Verified-dead selected session pointer quarantined with exact forensic bytes preserved.',
        sessionId: 'dead-cli-owner',
      });
      assert.equal(await readFile(result.quarantinePath, 'utf-8'), pointerBody);

      const repeated = runOmx(cwd, ['session', 'pointer', 'recover'], env);
      assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
      assert.equal(repeated.stdout, [
        'status: absent',
        `pointer: ${pointerPath}`,
        'action: none',
        'recovered: no',
        'reason: No selected session pointer exists.',
        '',
      ].join('\n'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
