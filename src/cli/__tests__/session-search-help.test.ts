import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runOmx(cwd: string, argv: string[]) {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'bin', 'omx.js');
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
      const mainHelp = runOmx(cwd, ['--help']);
      assert.equal(mainHelp.status, 0, mainHelp.stderr || mainHelp.stdout);
      assert.match(mainHelp.stdout, /omx resume\s+Resume a previous interactive Codex session/i);
      assert.match(mainHelp.stdout, /omx session\s+Search prior local session transcripts/i);

      const sessionHelp = runOmx(cwd, ['session', '--help']);
      assert.equal(sessionHelp.status, 0, sessionHelp.stderr || sessionHelp.stdout);
      assert.match(sessionHelp.stdout, /omx session search <query>/i);
      assert.match(sessionHelp.stdout, /--since <spec>/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
