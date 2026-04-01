import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function runOmx(cwd: string, argv: string[]) {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');
  return spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      OMX_AUTO_UPDATE: '0',
      OMX_NOTIFY_FALLBACK: '0',
      OMX_HOOK_DERIVED_SIGNALS: '0',
    },
  });
}

describe('nested help routing', () => {
  for (const [argv, expectedUsage] of [
    [['ask', '--help'], /Usage:\s*omx ask <claude\|gemini\|qwen> <question or task>/i],
    [['autoresearch', '--help'], /Usage:[\s\S]*omx autoresearch <mission-dir>/i],
    [['hud', '--help'], /Usage:\s*\n\s*omx hud\s+Show current HUD state/i],
    [['hooks', '--help'], /Usage:\s*\n\s*omx hooks init/i],
    [['tmux-hook', '--help'], /Usage:\s*\n\s*omx tmux-hook init/i],
    [['ralph', '--help'], /omx ralph - Launch Codex with ralph persistence mode active/i],
  ] satisfies Array<[string[], RegExp]>) {
    it(`routes ${argv.join(' ')} to command-local help`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-nested-help-'));
      try {
        const result = runOmx(cwd, argv);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, expectedUsage);
        assert.doesNotMatch(result.stdout, /oh-my-codex \(omx\) - Multi-agent orchestration for Codex CLI/i);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }
});
