import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, chmod, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { initTeamState, readTeamConfig, saveTeamConfig } from '../../team/state.js';

const OMX_JOBS_DIR = join(homedir(), '.omx', 'team-jobs');

async function writeJobFiles(
  jobId: string,
  job: Record<string, unknown>,
  panes: { paneIds: string[]; leaderPaneId: string },
): Promise<void> {
  await mkdir(OMX_JOBS_DIR, { recursive: true });
  await writeFile(join(OMX_JOBS_DIR, `${jobId}.json`), JSON.stringify(job));
  await writeFile(join(OMX_JOBS_DIR, `${jobId}-panes.json`), JSON.stringify(panes));
}

async function cleanupJobFiles(jobId: string): Promise<void> {
  await rm(join(OMX_JOBS_DIR, `${jobId}.json`), { force: true });
  await rm(join(OMX_JOBS_DIR, `${jobId}-panes.json`), { force: true });
}

async function loadTeamServer() {
  process.env.OMX_TEAM_SERVER_DISABLE_AUTO_START = '1';
  return await import('../team-server.js');
}

describe('team-server cleanup hardening', () => {
  it('intersects live-session candidates with team config + panes file identities before kill', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-cleanup-identity-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-team-cleanup-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    const jobId = `omx-${Date.now().toString(36)}`;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
if [ "$1" = "list-panes" ]; then
  printf '%s\\n' "%2" "%3" "%999"
  exit 0
fi
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState('cleanup-team', 'cleanup', 'executor', 2, cwd);
      const config = await readTeamConfig('cleanup-team', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-cleanup-team';
      config.workers[0]!.pane_id = '%2';
      config.workers[1]!.pane_id = '%3';
      config.leader_pane_id = '%1';
      config.hud_pane_id = '%9';
      await saveTeamConfig(config, cwd);

      await writeJobFiles(jobId, {
        status: 'running',
        startedAt: Date.now(),
        teamName: 'cleanup-team',
        cwd,
      }, {
        paneIds: ['%2', '%7'],
        leaderPaneId: '%1',
      });

      const { handleTeamToolCall } = await loadTeamServer();
      const response = await handleTeamToolCall({
        params: {
          name: 'omx_run_team_cleanup',
          arguments: { job_id: jobId, grace_ms: 10 },
        },
      });

      const legacy = response.content[0]?.text ?? '';
      const summary = JSON.parse(response.content[1]?.text ?? '{}') as {
        targets?: { from_live_session?: number; deduped_total?: number };
      };

      assert.equal(legacy, 'Cleaned up 3 worker pane(s).');
      assert.equal(summary.targets?.from_live_session, 2);
      assert.equal(summary.targets?.deduped_total, 3);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /kill-pane -t %2/);
      assert.match(tmuxLog, /kill-pane -t %3/);
      assert.match(tmuxLog, /kill-pane -t %7/);
      assert.doesNotMatch(tmuxLog, /kill-pane -t %999/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await cleanupJobFiles(jobId);
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('does not broad-sweep session panes during cleanup target selection', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-cleanup-sweep-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-team-cleanup-sweep-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    const jobId = `omx-${Date.now().toString(36)}`;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
if [ "$1" = "list-panes" ]; then
  printf '%s\\n' "%2" "%999" "%1000"
  exit 0
fi
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState('cleanup-sweep', 'cleanup', 'executor', 1, cwd);
      const config = await readTeamConfig('cleanup-sweep', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-cleanup-sweep';
      config.workers[0]!.pane_id = '%2';
      await saveTeamConfig(config, cwd);

      await writeJobFiles(jobId, {
        status: 'running',
        startedAt: Date.now(),
        teamName: 'cleanup-sweep',
        cwd,
      }, {
        paneIds: ['%2'],
        leaderPaneId: '',
      });

      const { handleTeamToolCall } = await loadTeamServer();
      await handleTeamToolCall({
        params: {
          name: 'omx_run_team_cleanup',
          arguments: { job_id: jobId, grace_ms: 10 },
        },
      });

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /kill-pane -t %2/);
      assert.doesNotMatch(tmuxLog, /kill-pane -t %999/);
      assert.doesNotMatch(tmuxLog, /kill-pane -t %1000/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await cleanupJobFiles(jobId);
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('returns unchanged legacy content[0].text plus additive structured JSON in content[1].text', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-cleanup-legacy-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-team-cleanup-legacy-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    const jobId = `omx-${Date.now().toString(36)}`;

    try {
      await writeFile(tmuxStubPath, '#!/bin/sh\nexit 0\n');
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await writeJobFiles(jobId, {
        status: 'running',
        startedAt: Date.now(),
      }, {
        paneIds: ['%21', '%21', '%22'],
        leaderPaneId: '%1',
      });

      const { handleTeamToolCall } = await loadTeamServer();
      const response = await handleTeamToolCall({
        params: {
          name: 'omx_run_team_cleanup',
          arguments: { job_id: jobId, grace_ms: 10 },
        },
      });

      assert.equal(response.content[0]?.text, 'Cleaned up 2 worker pane(s).');
      const summary = JSON.parse(response.content[1]?.text ?? '{}') as {
        job_id?: string;
        status?: string;
        targets?: { deduped_total?: number };
        excluded?: { leader?: number; hud?: number; invalid?: number };
        kill?: { attempted?: number; succeeded?: number; failed?: number };
        grace_ms?: number;
        cleaned_up_at?: string;
      };
      assert.equal(summary.job_id, jobId);
      assert.equal(summary.status, 'cleaned');
      assert.equal(summary.targets?.deduped_total, 2);
      assert.equal(typeof summary.cleaned_up_at, 'string');
      assert.equal(summary.grace_ms, 10);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await cleanupJobFiles(jobId);
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('returns deterministic noop summary when no killable panes remain', async () => {
    const jobId = `omx-${Date.now().toString(36)}`;
    try {
      await mkdir(OMX_JOBS_DIR, { recursive: true });
      await writeFile(join(OMX_JOBS_DIR, `${jobId}.json`), JSON.stringify({
        status: 'running',
        startedAt: Date.now(),
      }));
      await writeFile(join(OMX_JOBS_DIR, `${jobId}-panes.json`), JSON.stringify({
        paneIds: [],
        leaderPaneId: '',
      }));

      const { handleTeamToolCall } = await loadTeamServer();
      const response = await handleTeamToolCall({
        params: {
          name: 'omx_run_team_cleanup',
          arguments: { job_id: jobId, grace_ms: 10 },
        },
      });

      assert.equal(response.content[0]?.text, 'No pane IDs recorded for this job -- nothing to clean up.');
      const summary = JSON.parse(response.content[1]?.text ?? '{}') as {
        status?: string;
        targets?: { deduped_total?: number };
        kill?: { attempted?: number; succeeded?: number; failed?: number };
      };
      assert.equal(summary.status, 'noop');
      assert.equal(summary.targets?.deduped_total, 0);
      assert.deepEqual(summary.kill, { attempted: 0, succeeded: 0, failed: 0 });
    } finally {
      await cleanupJobFiles(jobId);
    }
  });
});
