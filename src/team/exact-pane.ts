import { spawnPlatformCommand, spawnPlatformCommandSync } from '../utils/platform-command.js';

export type ExactPaneProof =
  | { status: 'live'; paneId: string; pid: number }
  | { status: 'gone'; paneId: string; reason: 'absent' | 'dead' }
  | {
    status: 'unavailable';
    paneId: string;
    reason: 'invalid_pane_id' | 'query_failed' | 'malformed_snapshot' | 'pane_pid_changed' | 'pane_proof_lost_during_process_teardown' | 'process_identity_unavailable';
    detail?: string;
  };

const EXACT_PANE_ID_PATTERN = /^%[0-9]+$/;
const PANE_PID_PATTERN = /^[0-9]+$/;
const LIST_PANES_ARGS = ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_dead}\t#{pane_pid}'];

function unavailable(
  paneId: string,
  reason: Extract<ExactPaneProof, { status: 'unavailable' }>['reason'],
  detail?: string,
): ExactPaneProof {
  return detail === undefined
    ? { status: 'unavailable', paneId, reason }
    : { status: 'unavailable', paneId, reason, detail };
}

function parsePositiveSafeInteger(value: string): number | null {
  if (!PANE_PID_PATTERN.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseExactPaneProof(paneId: string, stdout: string): ExactPaneProof {
  if (!EXACT_PANE_ID_PATTERN.test(paneId)) {
    return unavailable(paneId, 'invalid_pane_id');
  }

  const lines = stdout.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const paneIds = new Set<string>();
  let matched: { paneDead: string; pid: string } | null = null;

  for (const line of lines) {
    const fields = line.split('\t');
    if (fields.length !== 3) return unavailable(paneId, 'malformed_snapshot');

    const [snapshotPaneId, paneDead, pid] = fields;
    if (!EXACT_PANE_ID_PATTERN.test(snapshotPaneId) || paneIds.has(snapshotPaneId)) {
      return unavailable(paneId, 'malformed_snapshot');
    }
    if (paneDead !== '0' && paneDead !== '1') {
      return unavailable(paneId, 'malformed_snapshot');
    }
    if (pid === '' && snapshotPaneId !== paneId) {
      // tmux empty panes may have no first-process PID. They do not weaken
      // authority for a different exact target.
    } else if (parsePositiveSafeInteger(pid) === null) {
      return unavailable(paneId, 'malformed_snapshot');
    }

    paneIds.add(snapshotPaneId);
    if (snapshotPaneId === paneId) matched = { paneDead, pid };
  }

  if (matched === null) return { status: 'gone', paneId, reason: 'absent' };
  const pid = parsePositiveSafeInteger(matched.pid);
  if (pid === null) return unavailable(paneId, 'malformed_snapshot');
  if (matched.paneDead !== '0') return { status: 'gone', paneId, reason: 'dead' };
  return { status: 'live', paneId, pid };
}

export function readExactPaneProofSync(paneId: string): ExactPaneProof {
  if (!EXACT_PANE_ID_PATTERN.test(paneId)) {
    return unavailable(paneId, 'invalid_pane_id');
  }

  const { result } = spawnPlatformCommandSync('tmux', LIST_PANES_ARGS, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return unavailable(paneId, 'query_failed', result.error.message);
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    return unavailable(paneId, 'query_failed', stderr || `tmux exited ${result.status ?? 'unknown'}`);
  }

  return parseExactPaneProof(paneId, typeof result.stdout === 'string' ? result.stdout : '');
}

/**
 * Read one global tmux pane snapshot and prove every requested exact pane from
 * that same observation. Callers use this before topology-changing batches so
 * one later target cannot invalidate an earlier authorization.
 */
export function readExactPaneProofsSync(paneIds: readonly string[]): ExactPaneProof[] {
  if (paneIds.length === 0) return [];
  const invalidProofs = paneIds.map((paneId) => (
    EXACT_PANE_ID_PATTERN.test(paneId) ? null : unavailable(paneId, 'invalid_pane_id')
  ));
  if (invalidProofs.some((proof) => proof !== null)) {
    return invalidProofs.map((proof, index) => proof ?? unavailable(paneIds[index]!, 'query_failed'));
  }

  const { result } = spawnPlatformCommandSync('tmux', LIST_PANES_ARGS, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message
      ?? ((typeof result.stderr === 'string' ? result.stderr.trim() : '') || `tmux exited ${result.status ?? 'unknown'}`);
    return paneIds.map((paneId) => unavailable(paneId, 'query_failed', detail));
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  return paneIds.map((paneId) => parseExactPaneProof(paneId, stdout));
}

export function readExactPaneProof(paneId: string): Promise<ExactPaneProof> {
  if (!EXACT_PANE_ID_PATTERN.test(paneId)) {
    return Promise.resolve(unavailable(paneId, 'invalid_pane_id'));
  }

  const { child } = spawnPlatformCommand('tmux', LIST_PANES_ARGS, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (proof: ExactPaneProof): void => {
      if (settled) return;
      settled = true;
      resolve(proof);
    };

    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error: Error) => {
      finish(unavailable(paneId, 'query_failed', error.message));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        finish(unavailable(paneId, 'query_failed', stderr.trim() || `tmux exited ${code ?? 'unknown'}`));
        return;
      }
      finish(parseExactPaneProof(paneId, stdout));
    });
  });
}
