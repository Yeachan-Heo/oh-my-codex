/**
 * Regression tests for issue #205:
 * - notify-hook.js must be the thin orchestrator (imports from sub-modules)
 * - resolveTeamStateDirForWorker must be exported from team-worker.js
 * - DEFAULT_STALL_PATTERNS must contain 'if you want'
 * - detectStallPattern must match 'if you want'
 * - notify-hook end-to-end keeps 'if you want' stall detection, but default injection now waits for a real stall window
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { writeSessionStart } from '../session.js';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, '..', '..', '..', 'dist', 'scripts');
const NOTIFY_HOOK_SCRIPT = new URL('../../../dist/scripts/notify-hook.js', import.meta.url);

async function loadModule(rel: string) {
  return import(pathToFileURL(join(SCRIPTS_DIR, rel)).href);
}

async function withTempWorkingDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-regression-205-'));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2));
}

function buildFakeTmux(tmuxLogPath: string): string {
  return `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "capture-pane" ]]; then
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%99" ]]; then
    echo "node"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%99" ]]; then
    echo "codex --model gpt-5"
    exit 0
  fi
  if [[ "$format" == "#S" ]]; then
    echo "devsess"
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  echo "%1 12345"
  exit 0
fi
exit 0
`;
}

function runNotifyHook(
  cwd: string,
  fakeBinDir: string,
  codexHome: string,
  payloadOverrides: Record<string, unknown> = {},
) {
  const payload = {
    cwd,
    type: 'agent-turn-complete',
    'thread-id': 'thread-test',
    'turn-id': `turn-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    'session-id': 'sess-managed-regression',
    'input-messages': ['test'],
    'last-assistant-message': 'done',
    ...payloadOverrides,
  };

  return spawnSync(process.execPath, [NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      CODEX_HOME: codexHome,
      OMX_SESSION_ID: 'sess-managed-regression',
      TMUX_PANE: '%99',
      TMUX: '1',
      OMX_TEAM_WORKER: '',
      OMX_TEAM_LEADER_NUDGE_MS: '9999999',
      OMX_TEAM_LEADER_STALE_MS: '9999999',
    },
  });
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
    assert.ok(DEFAULT_STALL_PATTERNS.includes('i\'m ready to'));
    assert.ok(DEFAULT_STALL_PATTERNS.includes('keep going'));
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

  it('ignores OMX injection-marker lines when matching patterns', async () => {
    const { detectStallPattern, DEFAULT_STALL_PATTERNS } = await loadModule('notify-hook/auto-nudge.js');
    assert.equal(
      detectStallPattern('keep going [OMX_TMUX_INJECT]', DEFAULT_STALL_PATTERNS),
      false,
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
// notify-hook.js – "if you want" still marks a stall candidate, but default
// injection now waits for the stall window instead of firing immediately.
// ---------------------------------------------------------------------------
describe('regression-205: notify-hook records pending stall state on "if you want" by default', () => {
  let originalTeamWorker: string | undefined;
  let originalTeamStateRoot: string | undefined;

  before(() => {
    originalTeamWorker = process.env.OMX_TEAM_WORKER;
    originalTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    delete process.env.OMX_TEAM_WORKER;
    delete process.env.OMX_TEAM_STATE_ROOT;
  });

  after(() => {
    if (originalTeamWorker === undefined) delete process.env.OMX_TEAM_WORKER;
    else process.env.OMX_TEAM_WORKER = originalTeamWorker;
    if (originalTeamStateRoot === undefined) delete process.env.OMX_TEAM_STATE_ROOT;
    else process.env.OMX_TEAM_STATE_ROOT = originalTeamStateRoot;
  });

  it('records pending stall state instead of injecting immediately', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const logsDir = join(cwd, '.omx', 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(stateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0 },
      });
      await writeSessionStart(cwd, 'sess-managed-regression');

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'I checked the files. If you want, I can keep going and apply the fix.',
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);
      assert.ok(existsSync(tmuxLogPath), 'expected tmux to be called');

      const tmuxLog = await readFile(tmuxLogPath, 'utf8');
      assert.doesNotMatch(
        tmuxLog,
        /send-keys -t %99 -l yes, proceed \[OMX_TMUX_INJECT\]/,
        'default notify-hook path should not inject before the real stall window elapses',
      );

      const nudgeState = JSON.parse(await readFile(join(stateDir, 'auto-nudge-state.json'), 'utf-8'));
      assert.equal(nudgeState.nudgeCount, 0);
      assert.ok(nudgeState.pendingSignature, 'expected pending stall signature to be recorded');
      assert.ok(nudgeState.pendingSince, 'expected pending stall timestamp to be recorded');
    });
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
