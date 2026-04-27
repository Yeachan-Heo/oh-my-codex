import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

async function withAmbientTmuxEnv<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const previousTmux = process.env.TMUX;
  const previousTmuxPane = process.env.TMUX_PANE;
  const previousPath = process.env.PATH;

  if (typeof env.TMUX === 'string') process.env.TMUX = env.TMUX;
  else delete process.env.TMUX;
  if (typeof env.TMUX_PANE === 'string') process.env.TMUX_PANE = env.TMUX_PANE;
  else delete process.env.TMUX_PANE;
  if (typeof env.PATH === 'string') process.env.PATH = env.PATH;
  else if ('PATH' in env) delete process.env.PATH;

  try {
    return await run();
  } finally {
    if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
    else delete process.env.TMUX;
    if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
    else delete process.env.TMUX_PANE;
    if (typeof previousPath === 'string') process.env.PATH = previousPath;
    else delete process.env.PATH;
  }
}

async function createFakeTmuxBin(wd: string): Promise<string> {
  const fakeBin = join(wd, 'bin');
  await mkdir(fakeBin, { recursive: true });
  const tmuxPath = join(fakeBin, 'tmux');
  await writeFile(
    tmuxPath,
    `#!/usr/bin/env bash
set -eu
cmd="\${1:-}"
shift || true
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
  if [[ -z "$target" && "$format" == "#{pane_id}" ]]; then
    echo "%777"
    exit 0
  fi
  if [[ -z "$target" && "$format" == "#S" ]]; then
    echo "maintainer-default"
    exit 0
  fi
  if [[ "$target" == "%777" && "$format" == "#{pane_id}" ]]; then
    echo "%777"
    exit 0
  fi
  if [[ "$target" == "%777" && "$format" == "#S" ]]; then
    echo "maintainer-default"
    exit 0
  fi
fi
if [[ "$cmd" == "list-sessions" ]]; then
  echo "maintainer-default"
  exit 0
fi
exit 1
`,
  );
  await chmod(tmuxPath, 0o755);
  return fakeBin;
}

describe('state-server directory initialization', () => {
  it('creates .omx/state for state tools without setup', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-test-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const tmuxHookConfig = join(wd, '.omx', 'tmux-hook.json');
      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);

      const response = await handleStateToolCall({
        params: {
          name: 'state_list_active',
          arguments: { workingDirectory: wd },
        },
      });

      assert.equal(existsSync(stateDir), true);
      assert.equal(existsSync(tmuxHookConfig), true);
      assert.deepEqual(
        JSON.parse(response.content[0]?.text || '{}'),
        { active_modes: [] },
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('bootstraps state-tool tmux-hook from the current tmux pane when available', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-test-live-'));
    try {
      const tmuxHookConfig = join(wd, '.omx', 'tmux-hook.json');
      const fakeBin = await createFakeTmuxBin(wd);

      await withAmbientTmuxEnv(
        {
          TMUX: '/tmp/maintainer-default,123,0',
          TMUX_PANE: '%777',
          PATH: `${fakeBin}:${process.env.PATH || ''}`,
        },
        async () => {
          const response = await handleStateToolCall({
            params: {
              name: 'state_list_active',
              arguments: { workingDirectory: wd },
            },
          });
          assert.deepEqual(JSON.parse(response.content[0]?.text || '{}'), { active_modes: [] });
        },
      );

      const tmuxConfig = JSON.parse(await readFile(tmuxHookConfig, 'utf-8')) as {
        target?: { type?: string; value?: string };
      };
      assert.deepEqual(tmuxConfig.target, { type: 'pane', value: '%777' });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('writes and reads deep-interview state', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-test-'));
    try {
      const writeResponse = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'deep-interview',
            active: true,
            current_phase: 'deep-interview',
            state: {
              current_focus: 'intent',
              threshold: 0.2,
            },
          },
        },
      });

      assert.equal(writeResponse.isError, undefined);
      assert.deepEqual(
        JSON.parse(writeResponse.content[0]?.text || '{}'),
        {
          success: true,
          mode: 'deep-interview',
          path: join(wd, '.omx', 'state', 'deep-interview-state.json'),
        },
      );

      const readResponse = await handleStateToolCall({
        params: {
          name: 'state_read',
          arguments: {
            workingDirectory: wd,
            mode: 'deep-interview',
          },
        },
      });

      assert.equal(readResponse.isError, undefined);
      const readBody = JSON.parse(readResponse.content[0]?.text || '{}') as Record<string, unknown>;
      assert.equal(readBody.active, true);
      assert.equal(readBody.current_phase, 'deep-interview');
      assert.equal(readBody.current_focus, 'intent');
      assert.equal(readBody.threshold, 0.2);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('accepts canonical lifecycle_outcome and backfills compatibility run_outcome', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-lifecycle-'));
    try {
      const writeResponse = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'deep-interview',
            active: false,
            lifecycle_outcome: 'askuserQuestion',
            state: {
              current_focus: 'intent',
            },
          },
        },
      });

      assert.equal(writeResponse.isError, undefined);

      const readResponse = await handleStateToolCall({
        params: {
          name: 'state_read',
          arguments: {
            workingDirectory: wd,
            mode: 'deep-interview',
          },
        },
      });

      const readBody = JSON.parse(readResponse.content[0]?.text || '{}') as Record<string, unknown>;
      assert.equal(readBody.lifecycle_outcome, 'askuserQuestion');
      assert.equal(readBody.run_outcome, 'blocked_on_user');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('derives canonical lifecycle_outcome from legacy run_outcome when needed', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-run-outcome-'));
    try {
      await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'team',
            active: false,
            run_outcome: 'cancelled',
          },
        },
      });

      const readResponse = await handleStateToolCall({
        params: {
          name: 'state_read',
          arguments: {
            workingDirectory: wd,
            mode: 'team',
          },
        },
      });

      const readBody = JSON.parse(readResponse.content[0]?.text || '{}') as Record<string, unknown>;
      assert.equal(readBody.lifecycle_outcome, 'userinterlude');
      assert.equal(readBody.run_outcome, 'cancelled');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('creates session-scoped state directory when session_id is provided', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-test-'));
    try {
      const sessionDir = join(wd, '.omx', 'state', 'sessions', 'sess1');
      assert.equal(existsSync(sessionDir), false);

      const response = await handleStateToolCall({
        params: {
          name: 'state_get_status',
          arguments: { workingDirectory: wd, session_id: 'sess1' },
        },
      });

      assert.equal(existsSync(sessionDir), true);
      assert.deepEqual(
        JSON.parse(response.content[0]?.text || '{}'),
        { statuses: {} },
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('state_write accepts canonical lifecycle_outcome while preserving compatibility run_outcome', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-lifecycle-'));
    try {
      const response = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'autopilot',
            active: false,
            current_phase: 'waiting-for-user-answer',
            lifecycle_outcome: 'askuserQuestion',
          },
        },
      });

      assert.equal(response.isError, undefined);
      const state = JSON.parse(await readFile(join(wd, '.omx', 'state', 'autopilot-state.json'), 'utf-8')) as {
        active?: boolean;
        lifecycle_outcome?: string;
        terminal_outcome?: string;
        run_outcome?: string;
        completed_at?: string;
      };
      assert.equal(state.active, false);
      assert.equal(state.lifecycle_outcome, 'askuserQuestion');
      assert.equal(state.terminal_outcome, undefined);
      assert.equal(state.run_outcome, 'blocked_on_user');
      assert.ok(state.completed_at);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('state_write lets canonical lifecycle_outcome take precedence over legacy run_outcome', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-lifecycle-precedence-'));
    try {
      const response = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'autopilot',
            active: false,
            current_phase: 'user-stopped',
            run_outcome: 'failed',
            lifecycle_outcome: 'userinterlude',
          },
        },
      });

      assert.equal(response.isError, undefined);
      const state = JSON.parse(await readFile(join(wd, '.omx', 'state', 'autopilot-state.json'), 'utf-8')) as {
        lifecycle_outcome?: string;
        run_outcome?: string;
      };
      assert.equal(state.lifecycle_outcome, 'userinterlude');
      assert.equal(state.run_outcome, 'cancelled');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('serializes concurrent state_write calls per mode file and preserves merged fields', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-test-'));
    try {
      const writes = Array.from({ length: 16 }, (_, i) => handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'team',
            state: { [`k${i}`]: i },
          },
        },
      }));

      const responses = await Promise.all(writes);
      for (const response of responses) {
        assert.equal(response.isError, undefined);
      }

      const filePath = join(wd, '.omx', 'state', 'team-state.json');
      const state = JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
      for (let i = 0; i < 16; i++) {
        assert.equal(state[`k${i}`], i);
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('syncs canonical skill-active state for tracked mode writes and clears', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-canonical-'));
    try {
      await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-sync',
            mode: 'ralph',
            active: true,
            iteration: 1,
            max_iterations: 3,
            current_phase: 'executing',
          },
        },
      });

      const canonicalPath = join(wd, '.omx', 'state', 'sessions', 'sess-sync', 'skill-active-state.json');
      const canonical = JSON.parse(await readFile(canonicalPath, 'utf-8')) as {
        active_skills?: Array<{ skill: string; session_id?: string; activated_at?: string; updated_at?: string }>;
      };
      assert.deepEqual(canonical.active_skills, [{
        skill: 'ralph',
        phase: 'executing',
        active: true,
        activated_at: canonical.active_skills?.[0]?.activated_at,
        updated_at: canonical.active_skills?.[0]?.updated_at,
        session_id: 'sess-sync',
      }]);

      await handleStateToolCall({
        params: {
          name: 'state_clear',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-sync',
            mode: 'ralph',
          },
        },
      });

      const clearedCanonical = JSON.parse(await readFile(canonicalPath, 'utf-8')) as {
        active: boolean;
        active_skills?: unknown[];
      };
      assert.equal(clearedCanonical.active, false);
      assert.deepEqual(clearedCanonical.active_skills, []);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('writes a session-scoped inactive tombstone when clearing a mode under an active session', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-clear-root-fallback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-clear';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(
        join(stateDir, 'deep-interview-state.json'),
        JSON.stringify({ active: true, mode: 'deep-interview', current_phase: 'legacy-root' }, null, 2),
      );
      await writeFile(
        join(sessionDir, 'deep-interview-state.json'),
        JSON.stringify({ active: true, mode: 'deep-interview', current_phase: 'session-active' }, null, 2),
      );

      await handleStateToolCall({
        params: {
          name: 'state_clear',
          arguments: {
            workingDirectory: wd,
            mode: 'deep-interview',
          },
        },
      });

      const sessionState = JSON.parse(
        await readFile(join(sessionDir, 'deep-interview-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(sessionState.active, false);
      assert.equal(sessionState.current_phase, 'cleared');
      assert.equal(sessionState.session_id, sessionId);

      const listResponse = await handleStateToolCall({
        params: {
          name: 'state_list_active',
          arguments: {
            workingDirectory: wd,
          },
        },
      });
      assert.deepEqual(JSON.parse(listResponse.content[0]?.text || '{}'), { active_modes: [] });

      const readResponse = await handleStateToolCall({
        params: {
          name: 'state_read',
          arguments: {
            workingDirectory: wd,
            mode: 'deep-interview',
          },
        },
      });
      const readBody = JSON.parse(readResponse.content[0]?.text || '{}') as Record<string, unknown>;
      assert.equal(readBody.active, false);
      assert.equal(readBody.current_phase, 'cleared');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows approved overlaps and preserves the remaining canonical state on clear', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-overlap-'));
    try {
      await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-overlap',
            mode: 'team',
            active: true,
            current_phase: 'running',
          },
        },
      });
      await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-overlap',
            mode: 'ralph',
            active: true,
            iteration: 1,
            max_iterations: 3,
            current_phase: 'executing',
          },
        },
      });

      const canonicalPath = join(wd, '.omx', 'state', 'sessions', 'sess-overlap', 'skill-active-state.json');
      const canonical = JSON.parse(await readFile(canonicalPath, 'utf-8')) as {
        active_skills?: Array<{ skill: string }>;
      };
      assert.deepEqual(canonical.active_skills?.map((entry) => entry.skill), ['team', 'ralph']);

      await handleStateToolCall({
        params: {
          name: 'state_clear',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-overlap',
            mode: 'team',
          },
        },
      });

      const clearedCanonical = JSON.parse(await readFile(canonicalPath, 'utf-8')) as {
        active: boolean;
        skill: string;
        active_skills?: Array<{ skill: string }>;
      };
      assert.equal(clearedCanonical.active, true);
      assert.equal(clearedCanonical.skill, 'ralph');
      assert.deepEqual(clearedCanonical.active_skills?.map((entry) => entry.skill), ['ralph']);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies unsupported overlaps without writing the requested mode state', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-deny-'));
    try {
      await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-deny',
            mode: 'team',
            active: true,
            current_phase: 'running',
          },
        },
      });

      const denied = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-deny',
            mode: 'autopilot',
            active: true,
            current_phase: 'planning',
          },
        },
      });

      assert.equal(denied.isError, true);
      assert.match(denied.content[0]?.text || '', /Unsupported workflow overlap: team \+ autopilot\./);
      assert.equal(existsSync(join(wd, '.omx', 'state', 'sessions', 'sess-deny', 'autopilot-state.json')), false);

      const canonical = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'sessions', 'sess-deny', 'skill-active-state.json'), 'utf-8'),
      ) as { active_skills?: Array<{ skill: string }> };
      assert.deepEqual(canonical.active_skills?.map((entry) => entry.skill), ['team']);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows ultrawork when canonical session state is stricter than mode files', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-canonical-prevalidate-'));
    try {
      await mkdir(join(wd, '.omx', 'state', 'sessions', 'sess-canonical-deny'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'state', 'team-state.json'),
        JSON.stringify({ active: true, mode: 'team', current_phase: 'running' }, null, 2),
      );
      await writeFile(
        join(wd, '.omx', 'state', 'skill-active-state.json'),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'team',
          active_skills: [{ skill: 'team', phase: 'running', active: true }],
        }, null, 2),
      );
      await writeFile(
        join(wd, '.omx', 'state', 'sessions', 'sess-canonical-deny', 'skill-active-state.json'),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'team',
          session_id: 'sess-canonical-deny',
          active_skills: [
            { skill: 'team', phase: 'running', active: true },
            { skill: 'ralph', phase: 'executing', active: true, session_id: 'sess-canonical-deny' },
          ],
        }, null, 2),
      );

      const allowed = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-canonical-deny',
            mode: 'ultrawork',
            active: true,
            current_phase: 'planning',
          },
        },
      });

      assert.equal(allowed.isError, undefined);
      assert.equal(
        existsSync(join(wd, '.omx', 'state', 'sessions', 'sess-canonical-deny', 'ultrawork-state.json')),
        true,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes tracked workflows from canonical skill-active state on all_sessions clear', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-canonical-clear-all-'));
    try {
      await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'team',
            active: true,
            current_phase: 'running',
          },
        },
      });

      await handleStateToolCall({
        params: {
          name: 'state_clear',
          arguments: {
            workingDirectory: wd,
            mode: 'team',
            all_sessions: true,
          },
        },
      });

      const canonicalPath = join(wd, '.omx', 'state', 'skill-active-state.json');
      const canonical = JSON.parse(await readFile(canonicalPath, 'utf-8')) as {
        active: boolean;
        active_skills?: unknown[];
      };
      assert.equal(canonical.active, false);
      assert.deepEqual(canonical.active_skills, []);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('propagates root clears into inherited session canonical copies', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-root-clear-propagate-'));
    try {
      await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'team',
            active: true,
            current_phase: 'running',
          },
        },
      });
      await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-root-clear',
            mode: 'ralph',
            active: true,
            iteration: 1,
            max_iterations: 3,
            current_phase: 'executing',
          },
        },
      });

      await handleStateToolCall({
        params: {
          name: 'state_clear',
          arguments: {
            workingDirectory: wd,
            mode: 'team',
          },
        },
      });

      const sessionCanonical = JSON.parse(
        await readFile(
          join(wd, '.omx', 'state', 'sessions', 'sess-root-clear', 'skill-active-state.json'),
          'utf-8',
        ),
      ) as { active_skills?: Array<{ skill: string }> };
      assert.deepEqual(sessionCanonical.active_skills?.map((entry) => entry.skill), ['ralph']);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves root-scoped team state when session-scoped ralph is added via state_write', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-team-ralph-'));
    try {
      const teamWrite = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'team',
            active: true,
            current_phase: 'running',
          },
        },
      });
      assert.equal(teamWrite.isError, undefined);

      const ralphWrite = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-team-ralph',
            mode: 'ralph',
            active: true,
            iteration: 1,
            max_iterations: 5,
            current_phase: 'executing',
          },
        },
      });
      assert.equal(ralphWrite.isError, undefined);

      const rootCanonical = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'skill-active-state.json'), 'utf-8'),
      ) as { active_skills?: Array<{ skill: string; phase?: string; session_id?: string }> };
      assert.deepEqual(
        rootCanonical.active_skills?.map(({ skill, phase, session_id }) => ({
          skill,
          phase,
          session_id,
        })),
        [{ skill: 'team', phase: 'running', session_id: undefined }],
      );

      const sessionCanonical = JSON.parse(
        await readFile(
          join(wd, '.omx', 'state', 'sessions', 'sess-team-ralph', 'skill-active-state.json'),
          'utf-8',
        ),
      ) as { active_skills?: Array<{ skill: string; phase?: string; session_id?: string }> };
      assert.deepEqual(
        sessionCanonical.active_skills?.map(({ skill, phase, session_id }) => ({
          skill,
          phase,
          session_id,
        })),
        [
          { skill: 'team', phase: 'running', session_id: undefined },
          { skill: 'ralph', phase: 'executing', session_id: 'sess-team-ralph' },
        ],
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects standalone overlaps without mutating canonical state', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-standalone-overlap-'));
    try {
      const autopilotWrite = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-standalone',
            mode: 'autopilot',
            active: true,
            current_phase: 'planning',
          },
        },
      });
      assert.equal(autopilotWrite.isError, undefined);

      const invalidTeamWrite = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-standalone',
            mode: 'team',
            active: true,
            current_phase: 'starting',
          },
        },
      });

      assert.equal(invalidTeamWrite.isError, true);
      const body = JSON.parse(invalidTeamWrite.content[0]?.text || '{}') as { error?: string };
      assert.match(body.error || '', /omx state/i);
      assert.match(body.error || '', /omx_state\.\*/i);

      const canonical = JSON.parse(
        await readFile(
          join(wd, '.omx', 'state', 'sessions', 'sess-standalone', 'skill-active-state.json'),
          'utf-8',
        ),
      ) as { active_skills?: Array<{ skill: string; phase?: string; session_id?: string }> };
      assert.deepEqual(
        canonical.active_skills?.map(({ skill, phase, session_id }) => ({
          skill,
          phase,
          session_id,
        })),
        [{ skill: 'autopilot', phase: 'planning', session_id: 'sess-standalone' }],
      );
      assert.equal(existsSync(join(wd, '.omx', 'state', 'sessions', 'sess-standalone', 'team-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('auto-completes deep-interview when starting ralplan and returns transition messaging', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-handoff-interview-'));
    try {
      await mkdir(join(wd, '.omx', 'state', 'sessions', 'sess-handoff'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'state', 'sessions', 'sess-handoff', 'deep-interview-state.json'),
        JSON.stringify({ active: true, mode: 'deep-interview', current_phase: 'intent-first' }, null, 2),
      );

      const response = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-handoff',
            mode: 'ralplan',
            active: true,
            current_phase: 'planning',
          },
        },
      });

      assert.equal(response.isError, undefined);
      const body = JSON.parse(response.content[0]?.text || '{}') as { transition?: string };
      assert.equal(body.transition, 'mode transiting: deep-interview -> ralplan');

      const completed = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'sessions', 'sess-handoff', 'deep-interview-state.json'), 'utf-8'),
      ) as {
        active?: boolean;
        current_phase?: string;
        completed_at?: string;
        auto_completed_reason?: string;
        run_outcome?: string;
      };
      assert.equal(completed.active, false);
      assert.equal(completed.current_phase, 'completed');
      assert.equal(typeof completed.completed_at, 'string');
      assert.equal(completed.run_outcome, 'finish');
      assert.match(completed.auto_completed_reason || '', /mode transiting: deep-interview -> ralplan/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects execution-to-planning rollback with clear-first guidance', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-rollback-'));
    try {
      await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-rollback',
            mode: 'autopilot',
            active: true,
            current_phase: 'planning',
          },
        },
      });

      const denied = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-rollback',
            mode: 'ralplan',
            active: true,
            current_phase: 'planning',
          },
        },
      });

      assert.equal(denied.isError, true);
      const body = JSON.parse(denied.content[0]?.text || '{}') as { error?: string };
      assert.match(body.error || '', /Execution-to-planning rollback auto-complete is not allowed/i);
      assert.match(body.error || '', /First clear current state first and retry if this action is intended/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not auto-complete existing workflow state when tracked write validation fails', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-validate-before-transition-'));
    try {
      await mkdir(join(wd, '.omx', 'state', 'sessions', 'sess-invalid'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'state', 'sessions', 'sess-invalid', 'ralplan-state.json'),
        JSON.stringify({ active: true, mode: 'ralplan', current_phase: 'planning' }, null, 2),
      );

      const denied = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-invalid',
            mode: 'ralph',
            active: true,
            current_phase: 'definitely-invalid',
          },
        },
      });

      assert.equal(denied.isError, true);
      const body = JSON.parse(denied.content[0]?.text || '{}') as { error?: string };
      assert.match(body.error || '', /ralph\.current_phase/i);

      const ralplanState = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'sessions', 'sess-invalid', 'ralplan-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(ralplanState.active, true);
      assert.equal(ralplanState.current_phase, 'planning');
      assert.equal(existsSync(join(wd, '.omx', 'state', 'sessions', 'sess-invalid', 'ralph-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows ultrawork overlap with any tracked mode', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-ultrawork-any-'));
    try {
      const first = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-ulw',
            mode: 'autopilot',
            active: true,
            current_phase: 'planning',
          },
        },
      });
      assert.equal(first.isError, undefined);

      const second = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-ulw',
            mode: 'ultrawork',
            active: true,
            current_phase: 'planning',
          },
        },
      });
      assert.equal(second.isError, undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
