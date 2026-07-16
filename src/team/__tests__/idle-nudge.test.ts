import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_NUDGE_CONFIG, NudgeTracker, capturePane, isPaneIdle } from '../idle-nudge.js';

const WORKER_TARGET = '';

function buildFakeTmux(tmuxLogPath: string): string {
  return `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
cmd="\${1:-}"
if [[ $# -gt 0 ]]; then
  shift
fi

if [[ "\$cmd" == "capture-pane" ]]; then
  if [[ "\${OMX_FAIL_CAPTURE:-0}" == "1" ]]; then
    exit 1
  fi

  token=""
  if [[ -n "\${OMX_CAPTURE_SEQ_FILE:-}" && -f "\${OMX_CAPTURE_SEQ_FILE}" ]]; then
    token="\$(head -n 1 "\${OMX_CAPTURE_SEQ_FILE}" || true)"
    if [[ -n "\$token" ]]; then
      tail -n +2 "\${OMX_CAPTURE_SEQ_FILE}" > "\${OMX_CAPTURE_SEQ_FILE}.tmp" || true
      mv "\${OMX_CAPTURE_SEQ_FILE}.tmp" "\${OMX_CAPTURE_SEQ_FILE}"
    fi
  fi
  if [[ -z "\$token" ]]; then
    token="\${OMX_CAPTURE_TOKEN:-IDLE}"
  fi

  case "\$token" in
    IDLE)
      printf '› \\n'
      ;;
    ACTIVE)
      printf '› \\n• Doing work (3s • esc to interrupt)\\n'
      ;;
    EMPTY)
      ;;
    RAW:*)
      printf '%s\\n' "\${token#RAW:}"
      ;;
    *)
      printf '%s\\n' "\$token"
      ;;
  esac
  exit 0
fi

if [[ "$cmd" == "show-option" ]]; then
  printf '%s\n' "\${OMX_TEAM_OWNER:-omx-team-a-owner}"
  exit 0
fi

if [[ "\$cmd" == "send-keys" ]]; then
  if [[ "\${OMX_FAIL_SEND_KEYS:-0}" == "1" ]]; then
    exit 1
  fi
  exit 0
fi

if [[ "\$cmd" == "list-panes" ]]; then
  if [[ "$#" -eq 3 && "$1" == "-a" && "$2" == "-F" && "$3" == "#{pane_id}\t#{pane_dead}\t#{pane_pid}" ]]; then
    printf '%%2\t0\t12345\n'
  else
    printf '0 12345\\n'
  fi
  exit 0
fi

exit 0
`;
}

async function withFakeTmux(run: (ctx: {
  tmuxLogPath: string;
  setCaptureSequence: (tokens: string[]) => Promise<void>;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'omx-idle-nudge-test-'));
  const binDir = join(root, 'bin');
  const tmuxPath = join(binDir, 'tmux');
  const tmuxLogPath = join(root, 'tmux.log');
  const captureSeqPath = join(root, 'capture-seq.txt');

  const prevPath = process.env.PATH;
  const prevCaptureSeq = process.env.OMX_CAPTURE_SEQ_FILE;
  const prevCaptureToken = process.env.OMX_CAPTURE_TOKEN;
  const prevFailSendKeys = process.env.OMX_FAIL_SEND_KEYS;
  const prevFailCapture = process.env.OMX_FAIL_CAPTURE;

  try {
    await mkdir(binDir, { recursive: true });
    await writeFile(tmuxPath, buildFakeTmux(tmuxLogPath));
    await chmod(tmuxPath, 0o755);

    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    process.env.OMX_CAPTURE_SEQ_FILE = captureSeqPath;
    process.env.OMX_CAPTURE_TOKEN = 'IDLE';
    delete process.env.OMX_FAIL_SEND_KEYS;
    delete process.env.OMX_FAIL_CAPTURE;

    await run({
      tmuxLogPath,
      setCaptureSequence: async (tokens: string[]) => {
        await writeFile(captureSeqPath, tokens.join('\n'));
      },
    });
  } finally {
    if (typeof prevPath === 'string') process.env.PATH = prevPath;
    else delete process.env.PATH;

    if (typeof prevCaptureSeq === 'string') process.env.OMX_CAPTURE_SEQ_FILE = prevCaptureSeq;
    else delete process.env.OMX_CAPTURE_SEQ_FILE;

    if (typeof prevCaptureToken === 'string') process.env.OMX_CAPTURE_TOKEN = prevCaptureToken;
    else delete process.env.OMX_CAPTURE_TOKEN;

    if (typeof prevFailSendKeys === 'string') process.env.OMX_FAIL_SEND_KEYS = prevFailSendKeys;
    else delete process.env.OMX_FAIL_SEND_KEYS;

    if (typeof prevFailCapture === 'string') process.env.OMX_FAIL_CAPTURE = prevFailCapture;
    else delete process.env.OMX_FAIL_CAPTURE;

    await rm(root, { recursive: true, force: true });
  }
}

async function withMockedNow(
  initialNow: number,
  run: (setNow: (nextNow: number) => void) => Promise<void>,
): Promise<void> {
  const originalNow = Date.now;
  let currentNow = initialNow;
  Date.now = () => currentNow;
  try {
    await run((nextNow: number) => {
      currentNow = nextNow;
    });
  } finally {
    Date.now = originalNow;
  }
}

describe('idle-nudge', () => {
  it('uses an explicit next-action default nudge message', () => {
    assert.equal(
      DEFAULT_NUDGE_CONFIG.message,
      'Next: read your inbox/mailbox, continue your assigned task now, and if blocked send the leader a concrete status update.',
    );
    const tracker = new NudgeTracker();
    assert.equal(tracker.totalNudges, 0);
  });

  it('throttles scans that happen too soon after the previous scan', async () => {
    await withFakeTmux(async ({ tmuxLogPath }) => {
      await withMockedNow(10_000, async (setNow) => {
        const tracker = new NudgeTracker({ delayMs: 0, maxCount: 3, message: 'nudge' });

        const first = await tracker.checkAndNudge([WORKER_TARGET], undefined, 'omx-team-a');
        assert.deepEqual(first, [WORKER_TARGET]);
        const firstLog = await readFile(tmuxLogPath, 'utf-8');
        const firstCommands = firstLog.trim().split('\n').filter(Boolean);
        const nudgeEffectIndex = firstCommands.findIndex((command) => command.startsWith('send-keys -t omx-team-a:0 '));
        assert.ok(nudgeEffectIndex >= 0, 'expected nudge send-keys target effect');

        setNow(11_000); // < 5000ms scan interval
        const second = await tracker.checkAndNudge([WORKER_TARGET], undefined, 'omx-team-a');
        assert.deepEqual(second, []);

        const secondLog = await readFile(tmuxLogPath, 'utf-8');
        assert.equal(secondLog, firstLog);
      });
    });
  });

  it('never nudges the leader pane', async () => {
    await withFakeTmux(async ({ tmuxLogPath }) => {
      const tracker = new NudgeTracker({ delayMs: 0, maxCount: 3, message: 'nudge' });
      const nudged = await tracker.checkAndNudge(['%1'], '%1', 'omx-team-a');
      assert.deepEqual(nudged, []);

      assert.equal(existsSync(tmuxLogPath), false);
      assert.equal(tracker.totalNudges, 0);
      assert.deepEqual(tracker.getSummary(), {});
    });
  });

  it('respects maxCount and does not scan again once pane reached nudge limit', async () => {
    await withFakeTmux(async ({ tmuxLogPath }) => {
      await withMockedNow(10_000, async (setNow) => {
        const tracker = new NudgeTracker({ delayMs: 0, maxCount: 1, message: 'nudge' });

        const first = await tracker.checkAndNudge([WORKER_TARGET], undefined, 'omx-team-a');
        assert.deepEqual(first, [WORKER_TARGET]);
        const firstLog = await readFile(tmuxLogPath, 'utf-8');

        setNow(16_000); // > 5000ms scan interval
        const second = await tracker.checkAndNudge([WORKER_TARGET], undefined, 'omx-team-a');
        assert.deepEqual(second, []);

        const secondLog = await readFile(tmuxLogPath, 'utf-8');
        assert.equal(secondLog, firstLog);
        assert.equal(tracker.totalNudges, 1);
        assert.deepEqual(tracker.getSummary(), {
          [WORKER_TARGET]: {
            nudgeCount: 1,
            lastNudgeAt: 10_000,
          },
        });
      });
    });
  });

  it('resets idle timer when pane becomes active before delay elapses', async () => {
    await withFakeTmux(async ({ setCaptureSequence }) => {
      await setCaptureSequence(['IDLE', 'IDLE', 'ACTIVE', 'IDLE', 'IDLE']);

      await withMockedNow(10_000, async (setNow) => {
        const tracker = new NudgeTracker({ delayMs: 10_000, maxCount: 3, message: 'nudge' });

        const r1 = await tracker.checkAndNudge([WORKER_TARGET], undefined, 'omx-team-a');
        assert.deepEqual(r1, []);

        setNow(16_000);
        const r2 = await tracker.checkAndNudge([WORKER_TARGET], undefined, 'omx-team-a');
        assert.deepEqual(r2, []);

        setNow(22_000);
        const r3 = await tracker.checkAndNudge([WORKER_TARGET], undefined, 'omx-team-a');
        assert.deepEqual(r3, []);

        setNow(28_000);
        const r4 = await tracker.checkAndNudge([WORKER_TARGET], undefined, 'omx-team-a');
        assert.deepEqual(r4, []);

        setNow(39_000);
        const r5 = await tracker.checkAndNudge([WORKER_TARGET], undefined, 'omx-team-a');
        assert.deepEqual(r5, [WORKER_TARGET]);
        assert.equal(tracker.totalNudges, 1);
      });
    });
  });

  it('does not count nudges when sendToWorker fails', async () => {
    await withFakeTmux(async () => {
      process.env.OMX_FAIL_SEND_KEYS = '1';

      await withMockedNow(10_000, async () => {
        const tracker = new NudgeTracker({ delayMs: 0, maxCount: 3, message: 'nudge' });
        const nudged = await tracker.checkAndNudge([WORKER_TARGET], undefined, 'omx-team-a');
        assert.deepEqual(nudged, []);
        assert.equal(tracker.totalNudges, 0);
        assert.deepEqual(tracker.getSummary(), {});
      });
    });
  });

  it('returns empty capture and non-idle when capture-pane command fails', async () => {
    await withFakeTmux(async () => {
      process.env.OMX_FAIL_CAPTURE = '1';
      const captured = await capturePane('%2');
      assert.equal(captured, '');

      const idle = await isPaneIdle('%2');
      assert.equal(idle, false);
    });
  });

  it('fails closed for replacement, owner drift, and HUD nudge targets', async () => {
    await withFakeTmux(async ({ tmuxLogPath }) => {
      await withMockedNow(10_000, async () => {
        const targets = [
          { paneId: '%2', workerIndex: 1, panePid: 999, teamOwnerId: 'omx-team-a-owner' },
          { paneId: '%2', workerIndex: 1, panePid: 12345, teamOwnerId: 'foreign-owner' },
          { paneId: '%2', workerIndex: 1, panePid: 12345, teamOwnerId: 'omx-team-a-owner', hudPaneId: '%2' },
        ];
        for (const target of targets) {
          const tracker = new NudgeTracker({ delayMs: 0, maxCount: 1, message: 'nudge' });
          assert.deepEqual(await tracker.checkAndNudge([target], undefined, 'omx-team-a'), []);
        }
        const log = existsSync(tmuxLogPath) ? await readFile(tmuxLogPath, 'utf-8') : '';
        assert.doesNotMatch(log, /send-keys/);
      });
    });
  });
});
