import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { VISUAL_NEXT_ACTIONS_LIMIT } from '../../visual/constants.js';

describe('notify-hook session-scoped iteration updates', () => {
  it('increments iteration for active session-scoped mode states', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-test-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess1';
      const sessionScopedDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionScopedDir, { recursive: true });

      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(sessionScopedDir, 'team-state.json'), JSON.stringify({ active: true, iteration: 0 }));

      const payload = {
        cwd: wd,
        type: 'agent-turn-complete',
        thread_id: 'th',
        turn_id: 'tu',
        input_messages: [],
        last_assistant_message: 'ok',
      };

      const testDir = dirname(fileURLToPath(import.meta.url));
      const repoRoot = join(testDir, '..', '..', '..');
      const result = spawnSync(process.execPath, ['scripts/notify-hook.js', JSON.stringify(payload)], {
        cwd: repoRoot,
        encoding: 'utf-8',
        env: {
          ...process.env,
          OMX_TEAM_WORKER: '',
          TMUX: '',
          TMUX_PANE: '',
        },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const updated = JSON.parse(await readFile(join(sessionScopedDir, 'team-state.json'), 'utf-8'));
      assert.equal(updated.iteration, 1);
      assert.ok(typeof updated.last_turn_at === 'string' && updated.last_turn_at.length > 0);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('marks active mode state complete when max_iterations is reached', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-test-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess1';
      const sessionScopedDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionScopedDir, { recursive: true });

      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(
        join(sessionScopedDir, 'ralph-state.json'),
        JSON.stringify({
          active: true,
          iteration: 1,
          max_iterations: 2,
          current_phase: 'executing',
        })
      );

      const payload = {
        cwd: wd,
        type: 'agent-turn-complete',
        thread_id: 'th2',
        turn_id: 'tu2',
        input_messages: [],
        last_assistant_message: 'ok',
      };

      const testDir = dirname(fileURLToPath(import.meta.url));
      const repoRoot = join(testDir, '..', '..', '..');
      const result = spawnSync(process.execPath, ['scripts/notify-hook.js', JSON.stringify(payload)], {
        cwd: repoRoot,
        encoding: 'utf-8',
        env: {
          ...process.env,
          OMX_TEAM_WORKER: '',
          TMUX: '',
          TMUX_PANE: '',
        },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const updated = JSON.parse(await readFile(join(sessionScopedDir, 'ralph-state.json'), 'utf-8'));
      assert.equal(updated.iteration, 2);
      assert.equal(updated.active, false);
      assert.equal(updated.current_phase, 'complete');
      assert.equal(updated.stop_reason, 'max_iterations_reached');
      assert.ok(typeof updated.completed_at === 'string' && updated.completed_at.length > 0);
      assert.ok(typeof updated.last_turn_at === 'string' && updated.last_turn_at.length > 0);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('persists visual-verdict feedback from runtime assistant output', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-visual-'));
    try {
      const sessionId = 'sessVisual';
      const payload = {
        cwd: wd,
        session_id: sessionId,
        type: 'agent-turn-complete',
        thread_id: 'th-visual',
        turn_id: 'tu-visual',
        input_messages: [],
        last_assistant_message: [
          'Visual verdict ready:',
          '```json',
          JSON.stringify({
            score: 84,
            verdict: 'revise',
            category_match: true,
            differences: [
              'Primary CTA is 3px too low',
              'Card corner radius is too round',
            ],
            suggestions: [
              'Move primary CTA up by 3px',
              'Set card border-radius to 8px',
            ],
            reasoning: 'Core layout is close, but CTA alignment and shape still differ.',
          }, null, 2),
          '```',
        ].join('\n'),
      };

      const testDir = dirname(fileURLToPath(import.meta.url));
      const repoRoot = join(testDir, '..', '..', '..');
      const result = spawnSync(process.execPath, ['scripts/notify-hook.js', JSON.stringify(payload)], {
        cwd: repoRoot,
        encoding: 'utf-8',
        env: {
          ...process.env,
          OMX_TEAM_WORKER: '',
          TMUX: '',
          TMUX_PANE: '',
        },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const progressPath = join(wd, '.omx', 'state', 'sessions', sessionId, 'ralph-progress.json');
      assert.equal(existsSync(progressPath), true);
      const progress = JSON.parse(await readFile(progressPath, 'utf-8')) as {
        visual_feedback?: Array<{
          score: number;
          verdict: string;
          qualitative_feedback?: { next_actions?: string[] };
        }>;
      };

      assert.equal(Array.isArray(progress.visual_feedback), true);
      assert.equal(progress.visual_feedback?.length, 1);
      assert.equal(progress.visual_feedback?.[0]?.score, 84);
      assert.equal(progress.visual_feedback?.[0]?.verdict, 'revise');
      assert.equal(
        (progress.visual_feedback?.[0]?.qualitative_feedback?.next_actions?.length || 0) <= VISUAL_NEXT_ACTIONS_LIMIT,
        true,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
