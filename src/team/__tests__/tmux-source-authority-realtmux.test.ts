import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { runSourceAuthorizedSplit, runSourceAuthorizedTmux, type SourcePaneAuthority } from '../tmux-session.js';
import { isRealTmuxAvailable, type TempTmuxSessionFixture, withTempTmuxSession } from './tmux-test-fixture.js';

const SOURCE_AUTHORITY_FORMAT = '#{session_name}\t#{session_id}\t#{session_created}\t#{window_index}\t#{window_id}\t#{pane_id}\t#{pane_pid}';
const PANE_READY_TIMEOUT_MS = 1_000;
const PANE_READY_INTERVAL_MS = 50;

function skipUnlessPrivateRealTmux(t: TestContext): boolean {
  if (isRealTmuxAvailable()) return true;
  assert.equal(process.env.CI, undefined, 'CI must provide tmux for the private-server source-authority regression');
  t.skip('tmux is not installed');
  return false;
}

function quoteTmuxString(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sourceAuthorityPredicate(source: SourcePaneAuthority): string {
  return [
    '#{==:#{pane_dead},0}',
    `#{==:#{pane_id},${source.paneId}}`,
    `#{==:#{pane_pid},${source.panePid}}`,
    `#{==:#{session_id},${source.sessionId}}`,
    `#{==:#{session_created},${source.sessionCreated}}`,
    `#{==:#{window_id},${source.windowId}}`,
    ...(source.teamPaneOwnerId ? [`#{==:#{@omx_team_pane_owner_id},${source.teamPaneOwnerId}}`] : []),
  ].reduce((combined, condition) => `#{&&:${combined},${condition}}`);
}

function parseShimTmuxArgv(contents: string): string[][] {
  return contents
    .split('tmux argv:\n')
    .slice(1)
    .map((record) => record.split('\nend tmux argv')[0]!.split('\n').filter(Boolean));
}

function captureSourceAuthority(fixture: TempTmuxSessionFixture, paneId: string): SourcePaneAuthority {
  const fields = fixture.run(['display-message', '-p', '-t', paneId, SOURCE_AUTHORITY_FORMAT]).split('\t');
  assert.equal(fields.length, 7, 'fixture must provide a complete source authority frame');
  const [sessionName, sessionId, sessionCreated, windowIndex, windowId, capturedPaneId, panePid] = fields;
  assert.equal(capturedPaneId, paneId, 'fixture source frame must belong to the tested pane');
  assert.ok(sessionName && sessionId && sessionCreated && windowIndex && windowId && panePid, 'fixture source frame must not contain empty required fields');
  const parsedPanePid = Number(panePid);
  assert.ok(Number.isSafeInteger(parsedPanePid) && parsedPanePid > 0, 'fixture pane pid must be a positive safe integer');
  return {
    paneId,
    panePid: parsedPanePid,
    sessionName,
    sessionId,
    sessionCreated,
    windowIndex,
    windowId,
    teamPaneOwnerId: null,
  };
}

async function waitForPaneReady(fixture: TempTmuxSessionFixture, paneId: string): Promise<void> {
  const deadline = Date.now() + PANE_READY_TIMEOUT_MS;
  let lastState = '';
  while (Date.now() < deadline) {
    lastState = fixture.run(['display-message', '-p', '-t', paneId, '#{pane_dead}']);
    if (lastState === '0') return;
    await new Promise((resolve) => setTimeout(resolve, PANE_READY_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for private tmux pane readiness: ${paneId} (${lastState})`);
}

function expectedIfShellArgv(source: SourcePaneAuthority, effect: string, receipt: string): string[] {
  return [
    'if-shell',
    '-F',
    '-t',
    source.paneId,
    sourceAuthorityPredicate(source),
    `${effect} ; display-message -p ${quoteTmuxString(receipt.replaceAll('#', '##'))}`,
    "display-message -p ''",
  ];
}

describe('runSourceAuthorizedTmux real private-server argv boundary', () => {
  it('uses a real tmux parser for guarded effects and records the exact product argv', async (t) => {
    if (!skipUnlessPrivateRealTmux(t)) return;

    const workDir = await mkdtemp(join(tmpdir(), 'omx-source-authority-realtmux-'));
    const bin = join(workDir, 'bin');
    const shimLogPath = join(workDir, 'tmux-argv.log');
    const previousPath = process.env.PATH;
    try {
      await mkdir(bin, { recursive: true });
      await withTempTmuxSession({ serverLog: true }, async (fixture) => {
        await fixture.createPathShim(bin, shimLogPath);
        process.env.PATH = `${bin}:${previousPath ?? ''}`;
        try {
          await waitForPaneReady(fixture, fixture.leaderPaneId);
          const source = captureSourceAuthority(fixture, fixture.leaderPaneId);
          const expectedTransactions: string[][] = [];

          const setOptionEffect = `set-option -p -t ${source.paneId} @omx_probe_3459 ${quoteTmuxString('ok')}`;
          const setOptionReceipt = 'omx_source_set_option_3459';
          expectedTransactions.push(expectedIfShellArgv(source, setOptionEffect, setOptionReceipt));
          assert.equal(runSourceAuthorizedTmux(source, setOptionEffect, setOptionReceipt), setOptionReceipt);
          assert.equal(fixture.run(['show-options', '-pv', '-t', source.paneId, '@omx_probe_3459']), 'ok');

          const workerPaneId = fixture.run(['split-window', '-d', '-h', '-P', '-F', '#{pane_id}', '-t', source.windowId]);
          assert.match(workerPaneId, /^%[0-9]+$/, 'private fixture must create a second pane for layout coverage');
          const selectLayoutEffect = `select-layout -t ${source.windowId} even-horizontal`;
          const selectLayoutReceipt = 'omx_source_select_layout_3459';
          expectedTransactions.push(expectedIfShellArgv(source, selectLayoutEffect, selectLayoutReceipt));
          assert.equal(runSourceAuthorizedTmux(source, selectLayoutEffect, selectLayoutReceipt), selectLayoutReceipt);
          const paneHeights = fixture.run(['list-panes', '-t', source.windowId, '-F', '#{pane_height}']).split('\n');
          assert.equal(paneHeights.length, 2, 'layout coverage requires both private fixture panes');
          assert.equal(new Set(paneHeights).size, 1, 'even-horizontal must assign equal heights');

          const sendKeysEffect = `send-keys -t ${source.paneId} C-l`;
          const sendKeysReceipt = 'omx_source_send_keys_3459';
          expectedTransactions.push(expectedIfShellArgv(source, sendKeysEffect, sendKeysReceipt));
          assert.equal(runSourceAuthorizedTmux(source, sendKeysEffect, sendKeysReceipt), sendKeysReceipt);

          const guardedSplitPaneId = runSourceAuthorizedSplit(
            source,
            (receipt) => `split-window -d -h -P -F '#{pane_id}' -t ${source.windowId} ${quoteTmuxString(`sleep 60 # ${receipt}`)}`,
          );
          assert.match(guardedSplitPaneId, /^%[0-9]+$/, 'guarded split must parse the exact pane/receipt frame');
          assert.equal(
            fixture.run(['display-message', '-p', '-t', guardedSplitPaneId, '#{window_id}']),
            source.windowId,
            'guarded split must create the pane in the authorized source window',
          );
          const guardedSplitTransaction = parseShimTmuxArgv(await readFile(shimLogPath, 'utf-8'))
            .filter((argv) => argv[0] === 'if-shell')
            .at(-1);
          assert.ok(guardedSplitTransaction, 'PATH shim must record the guarded split transaction');
          assert.match(
            guardedSplitTransaction[5] ?? '',
            /split-window .* -F '#\{pane_id\}:omx_source_[A-Za-z0-9_]+'/,
            'product argv must use a literal tmux-safe separator before the exact split receipt',
          );
          assert.doesNotMatch(guardedSplitTransaction[5] ?? '', /#\{pane_id\}\\t/, 'product argv must not depend on tmux expanding backslash-t');
          expectedTransactions.push(guardedSplitTransaction);

          const hostileValue = "literal; no-command 'still literal'";
          const hostileReceipt = `omx_source_hostile'; kill-session -t ${source.sessionName}; # #{pane_id} ##`;
          const hostileEffect = `set-option -p -t ${source.paneId} @omx_hostile_3459 ${quoteTmuxString(hostileValue)}`;
          expectedTransactions.push(expectedIfShellArgv(source, hostileEffect, hostileReceipt));
          assert.equal(runSourceAuthorizedTmux(source, hostileEffect, hostileReceipt), hostileReceipt);
          assert.equal(fixture.run(['show-options', '-pv', '-t', source.paneId, '@omx_hostile_3459']), hostileValue);
          assert.equal(fixture.sessionExists(), true, 'hostile receipt text must not execute a second tmux command');

          const staleEffect = `set-option -p -t ${source.paneId} @omx_stale_3459 ${quoteTmuxString('unexpected')}`;
          const staleReceipt = 'omx_source_stale_3459';
          const staleSource = { ...source, panePid: source.panePid + 1 };
          expectedTransactions.push(expectedIfShellArgv(staleSource, staleEffect, staleReceipt));
          assert.throws(
            () => runSourceAuthorizedTmux(staleSource, staleEffect, staleReceipt),
            /tmux source authority changed before effect/,
          );
          assert.equal(
            fixture.runResult(['show-options', '-pv', '-t', source.paneId, '@omx_stale_3459']).stdout.trim(),
            '',
            'failed authority must not apply the guarded effect',
          );

          const ifShellTransactions = parseShimTmuxArgv(await readFile(shimLogPath, 'utf-8'))
            .filter((argv) => argv[0] === 'if-shell');
          assert.deepEqual(ifShellTransactions, expectedTransactions, 'PATH shim must record exactly the product if-shell argv routed to the private server');
          assert.doesNotMatch(await fixture.readServerLog(), /too many arguments/i, 'real tmux must not fold the receipt command into the effect argv');
        } finally {
          if (typeof previousPath === 'string') process.env.PATH = previousPath;
          else delete process.env.PATH;
        }
      });
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
