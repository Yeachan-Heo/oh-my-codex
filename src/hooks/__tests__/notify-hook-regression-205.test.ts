/**
 * Regression tests for issue #205:
 * - notify-hook.js must be the thin orchestrator (imports from sub-modules)
 * - resolveTeamStateDirForWorker must be exported from team-worker.js
 * - DEFAULT_STALL_PATTERNS must contain 'if you want'
 * - detectStallPattern must match 'if you want'
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, '..', '..', '..', 'scripts');

async function loadModule(rel: string) {
  return import(pathToFileURL(join(SCRIPTS_DIR, rel)).href);
}

// ---------------------------------------------------------------------------
// auto-nudge.js – DEFAULT_STALL_PATTERNS contains 'if you want'
// ---------------------------------------------------------------------------
describe('regression-205: DEFAULT_STALL_PATTERNS contains "if you want"', () => {
  it('DEFAULT_STALL_PATTERNS array includes "if you want"', async () => {
    const { DEFAULT_STALL_PATTERNS } = await loadModule('notify-hook/auto-nudge.js');
    assert.ok(
      Array.isArray(DEFAULT_STALL_PATTERNS),
      'DEFAULT_STALL_PATTERNS should be an array',
    );
    assert.ok(
      DEFAULT_STALL_PATTERNS.includes('if you want'),
      `Expected DEFAULT_STALL_PATTERNS to contain "if you want", got: ${JSON.stringify(DEFAULT_STALL_PATTERNS)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// auto-nudge.js – detectStallPattern matches 'if you want'
// ---------------------------------------------------------------------------
describe('regression-205: detectStallPattern matches "if you want"', () => {
  it('detects "if you want" pattern', async () => {
    const { detectStallPattern, DEFAULT_STALL_PATTERNS } = await loadModule('notify-hook/auto-nudge.js');
    assert.equal(
      detectStallPattern('If you want, I can refactor the module.', DEFAULT_STALL_PATTERNS),
      true,
    );
  });

  it('detects "if you want" case-insensitively', async () => {
    const { detectStallPattern, DEFAULT_STALL_PATTERNS } = await loadModule('notify-hook/auto-nudge.js');
    assert.equal(
      detectStallPattern('IF YOU WANT I can do more.', DEFAULT_STALL_PATTERNS),
      true,
    );
  });

  it('does not false-positive on unrelated text', async () => {
    const { detectStallPattern, DEFAULT_STALL_PATTERNS } = await loadModule('notify-hook/auto-nudge.js');
    assert.equal(
      detectStallPattern('Build succeeded. All tests pass.', DEFAULT_STALL_PATTERNS),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// team-worker.js – resolveTeamStateDirForWorker is exported
// ---------------------------------------------------------------------------
describe('regression-205: resolveTeamStateDirForWorker is exported from team-worker.js', () => {
  it('exports resolveTeamStateDirForWorker as a function', async () => {
    const mod = await loadModule('notify-hook/team-worker.js');
    assert.equal(
      typeof mod.resolveTeamStateDirForWorker,
      'function',
      'resolveTeamStateDirForWorker should be an exported function',
    );
  });

  it('uses OMX_TEAM_STATE_ROOT env var when set', async () => {
    const { resolveTeamStateDirForWorker } = await loadModule('notify-hook/team-worker.js');
    const saved = process.env.OMX_TEAM_STATE_ROOT;
    process.env.OMX_TEAM_STATE_ROOT = '/custom/state/root';
    try {
      const result = await resolveTeamStateDirForWorker(
        '/some/cwd',
        { teamName: 'fix-ts', workerName: 'worker-1' },
      );
      assert.equal(result, '/custom/state/root');
    } finally {
      if (saved === undefined) {
        delete process.env.OMX_TEAM_STATE_ROOT;
      } else {
        process.env.OMX_TEAM_STATE_ROOT = saved;
      }
    }
  });

  it('falls back to {cwd}/.omx/state when no env var and no team dir exists', async () => {
    const { resolveTeamStateDirForWorker } = await loadModule('notify-hook/team-worker.js');
    const savedRoot = process.env.OMX_TEAM_STATE_ROOT;
    const savedLeader = process.env.OMX_TEAM_LEADER_CWD;
    delete process.env.OMX_TEAM_STATE_ROOT;
    delete process.env.OMX_TEAM_LEADER_CWD;
    try {
      const cwd = '/nonexistent/cwd-that-has-no-team-dir';
      const result = await resolveTeamStateDirForWorker(
        cwd,
        { teamName: 'fix-ts', workerName: 'worker-1' },
      );
      assert.equal(result, join(cwd, '.omx', 'state'));
    } finally {
      if (savedRoot === undefined) {
        delete process.env.OMX_TEAM_STATE_ROOT;
      } else {
        process.env.OMX_TEAM_STATE_ROOT = savedRoot;
      }
      if (savedLeader === undefined) {
        delete process.env.OMX_TEAM_LEADER_CWD;
      } else {
        process.env.OMX_TEAM_LEADER_CWD = savedLeader;
      }
    }
  });
});
