import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { isRealTmuxAvailable, withTempTmuxSession } from '../../team/__tests__/tmux-test-fixture.js';
import { registerHudResizeHook } from '../tmux.js';

it('keeps a live 20-worker roster bounded after window shrink and grows it back', async t => {
  if (!isRealTmuxAvailable()) { t.skip('tmux is not installed'); return; }
  const dir = await mkdtemp(join(tmpdir(), 'omx-roster-height-'));
  try {
    const script = join(dir, 'watch.mjs');
    await writeFile(script, `
      import { runWatchMode } from ${JSON.stringify(new URL('../index.js', import.meta.url).href)};
      process.env.OMX_TMUX_HUD_OWNER = '1';
      process.env.OMX_TMUX_HUD_LEADER_PANE = process.argv[2];
      await runWatchMode(${JSON.stringify(dir)}, { watch: true, preset: 'focused' }, {
        readAllStateFn: async () => ({ team: { active: true, team_name: 'checkout', agent_count: 20,
          workers: Array.from({ length: 20 }, (_, i) => ({ name: 'worker-' + (i + 1), state: 'working' })) } }),
        readHudConfigFn: async () => ({ preset: 'focused' }),
        runAuthorityTickFn: async () => {}, reconcileTmuxHudFn: async () => {},
        registerHudResizeHookFn: () => true, isSessionAttachedFn: () => true,
      });
    `);
    await withTempTmuxSession({ useAmbientServer: false }, async fixture => {
      fixture.run(['set-option', '-g', 'status', 'off']);
      fixture.run(['resize-window', '-t', fixture.windowTarget, '-x', '90', '-y', '70']);
      const hud = fixture.run(['split-window', '-d', '-v', '-l', '2', '-P', '-F', '#{pane_id}',
        '-t', fixture.leaderPaneId, process.execPath, script, fixture.leaderPaneId]);
      const height = (pane: string) => Number(fixture.run(['display-message', '-p', '-t', pane, '#{pane_height}']));
      const waitForFrame = async (expectedHeight: number, text: string) => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (height(hud) === expectedHeight && fixture.run(['capture-pane', '-p', '-t', hud]).includes(text)) return;
          await sleep(100);
        }
        assert.fail(`Expected ${expectedHeight} rows with ${text}: ${fixture.run(['capture-pane', '-p', '-t', hud])}`);
      };
      await waitForFrame(22, 'worker-20');
      const pidsBefore = fixture.run(['list-panes', '-t', fixture.windowTarget, '-F', '#{pane_id} #{pane_pid}']);
      // A layout change may shrink only the HUD while its desired budget stays 22.
      fixture.run(['resize-pane', '-t', hud, '-y', '14']);
      await waitForFrame(22, 'worker-20');

      // Register only the resize hook: layout reconciliation is tested separately.
      assert.equal(registerHudResizeHook(hud, fixture.leaderPaneId, 22, { cwd: dir, env: fixture.env }, args => {
        if (args[0] === 'set-hook' && !args.some(arg => arg.startsWith('client-resized['))) return '';
        return fixture.run(args) + '\n';
      }), true);
      fixture.run(['resize-window', '-t', fixture.windowTarget, '-y', '24']);
      fixture.run(['set-hook', '-R', '-t', fixture.sessionName, 'client-resized']);
      await waitForFrame(11, '+11 workers');
      // The delayed resize-hook retry must not restore the old 22-row height.
      await sleep(2200);
      assert.equal(height(hud), 11);
      assert.ok(height(fixture.leaderPaneId) >= 12);
      fixture.run(['resize-window', '-t', fixture.windowTarget, '-y', '70']);
      await waitForFrame(22, 'worker-20');
      assert.equal(fixture.run(['list-panes', '-t', fixture.windowTarget, '-F', '#{pane_id} #{pane_pid}']), pidsBefore);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
