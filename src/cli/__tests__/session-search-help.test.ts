import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runOmx(cwd: string, argv: string[]) {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');
  return spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: process.env,
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
});
