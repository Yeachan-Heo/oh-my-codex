/**
 * OMX Team Runner MCP Server
 * Provides omx_run_team_* tools for spawning and managing tmux CLI worker teams.
 * Storage: ~/.omx/team-jobs/
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile } from 'fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { homedir } from 'os';
import { z } from 'zod';
import { killWorkerPanes } from '../team/tmux-session.js';
import { NudgeTracker } from '../team/idle-nudge.js';
import { shouldAutoStartMcpServer } from './bootstrap.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const startSchema = z.object({
  teamName: z.string().min(1),
  agentTypes: z.array(z.string()).min(1),
  tasks: z.array(z.object({ subject: z.string(), description: z.string() })).min(1),
  cwd: z.string().min(1),
});

const jobIdSchema = z.string().regex(/^omx-[a-z0-9]{1,12}$/);

const statusSchema = z.object({ job_id: jobIdSchema });

const waitSchema = z.object({
  job_id: jobIdSchema,
  timeout_ms: z.number().max(3_600_000).optional().default(300_000),
  nudge_delay_ms: z.number().optional(),
  nudge_max_count: z.number().optional(),
  nudge_message: z.string().optional(),
});

const cleanupSchema = z.object({
  job_id: jobIdSchema,
  grace_ms: z.number().optional().default(10_000),
});

// ---------------------------------------------------------------------------
// Job state: in-memory Map + file backup (survives MCP restart)
// ---------------------------------------------------------------------------

interface OmxTeamJob {
  status: 'running' | 'completed' | 'failed' | 'timeout';
  result?: string;
  stderr?: string;
  startedAt: number;
  pid?: number;
  paneIds?: string[];
  leaderPaneId?: string;
  teamName?: string;
  cwd?: string;
  cleanedUpAt?: string;
}

const omxTeamJobs = new Map<string, OmxTeamJob>();
const OMX_JOBS_DIR = join(homedir(), '.omx', 'team-jobs');

function persistJob(jobId: string, job: OmxTeamJob): void {
  try {
    if (!existsSync(OMX_JOBS_DIR)) mkdirSync(OMX_JOBS_DIR, { recursive: true });
    writeFileSync(join(OMX_JOBS_DIR, `${jobId}.json`), JSON.stringify(job), 'utf-8');
  } catch { /* best-effort */ }
}

function loadJobFromDisk(jobId: string): OmxTeamJob | undefined {
  try {
    return JSON.parse(readFileSync(join(OMX_JOBS_DIR, `${jobId}.json`), 'utf-8')) as OmxTeamJob;
  } catch { return undefined; }
}

async function loadPaneIds(jobId: string): Promise<{ paneIds: string[]; leaderPaneId: string } | null> {
  try { return JSON.parse(await readFile(join(OMX_JOBS_DIR, `${jobId}-panes.json`), 'utf-8')); }
  catch { return null; }
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'omx-team-server', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'omx_run_team_start',
      description: 'Spawn tmux CLI workers (codex/claude) in the background. Returns jobId immediately. Poll with omx_run_team_status.',
      inputSchema: {
        type: 'object',
        properties: {
          teamName: { type: 'string', description: 'Slug name for the team' },
          agentTypes: { type: 'array', items: { type: 'string' }, description: '"codex" or "claude" per worker' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                subject: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['subject', 'description'],
            },
            description: 'Tasks to distribute to workers',
          },
          cwd: { type: 'string', description: 'Working directory (absolute path)' },
        },
        required: ['teamName', 'agentTypes', 'tasks', 'cwd'],
      },
    },
    {
      name: 'omx_run_team_status',
      description: 'Non-blocking status check for a background omx_run_team job. Returns status and result when done.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Job ID returned by omx_run_team_start' },
        },
        required: ['job_id'],
      },
    },
    {
      name: 'omx_run_team_wait',
      description: 'Block (poll internally) until a background omx_run_team job reaches a terminal state (completed or failed). Returns the result when done. One call instead of N polling calls. Uses exponential backoff (500ms to 2000ms). Auto-nudges idle teammate panes via tmux send-keys. If this wait call times out, workers are left running -- call omx_run_team_wait again to keep waiting, or omx_run_team_cleanup to stop them explicitly.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Job ID returned by omx_run_team_start' },
          timeout_ms: { type: 'number', description: 'Maximum wait time in ms (default: 300000, max: 3600000)' },
          nudge_delay_ms: { type: 'number', description: 'Milliseconds a pane must be idle before nudging (default: 30000)' },
          nudge_max_count: { type: 'number', description: 'Maximum nudges per pane (default: 3)' },
          nudge_message: { type: 'string', description: 'Message sent as nudge (default: "Continue working on your assigned task.")' },
        },
        required: ['job_id'],
      },
    },
    {
      name: 'omx_run_team_cleanup',
      description: 'Explicitly clean up worker panes when you want to stop workers. Kills all worker panes recorded for the job without touching the leader pane or the user session.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Job ID returned by omx_run_team_start' },
          grace_ms: { type: 'number', description: 'Grace period in ms before force-killing panes (default: 10000)' },
        },
        required: ['job_id'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args || {}) as Record<string, unknown>;

  try {
    switch (name) {
      case 'omx_run_team_start': {
        const { teamName, agentTypes, tasks, cwd: inputCwd } = startSchema.parse(a);

        const jobId = `omx-${Date.now().toString(36)}`;
        const runtimeCliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'team', 'runtime-cli.js');

        const job: OmxTeamJob = { status: 'running', startedAt: Date.now(), teamName, cwd: inputCwd };
        omxTeamJobs.set(jobId, job);

        const child = spawn('node', [runtimeCliPath], {
          env: { ...process.env, OMX_JOB_ID: jobId, OMX_JOBS_DIR },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        job.pid = child.pid;
        persistJob(jobId, job);

        child.stdin.write(JSON.stringify({ teamName, agentTypes, tasks, cwd: inputCwd }));
        child.stdin.end();

        const outChunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        child.stdout.on('data', (c: Buffer) => outChunks.push(c));
        child.stderr.on('data', (c: Buffer) => errChunks.push(c));

        child.on('close', (code) => {
          const stdout = Buffer.concat(outChunks).toString('utf-8').trim();
          const stderr = Buffer.concat(errChunks).toString('utf-8').trim();
          if (stdout) {
            try {
              const parsed = JSON.parse(stdout) as { status?: string };
              const s = parsed.status;
              if (job.status === 'running') {
                job.status = (s === 'completed' || s === 'failed') ? s : 'failed';
              }
            } catch {
              if (job.status === 'running') job.status = 'failed';
            }
            job.result = stdout;
          }
          if (job.status === 'running') {
            if (code === 0) job.status = 'completed';
            else job.status = 'failed';
          }
          if (stderr) job.stderr = stderr;
          persistJob(jobId, job);
        });

        child.on('error', (err: Error) => {
          job.status = 'failed';
          job.stderr = `spawn error: ${err.message}`;
          persistJob(jobId, job);
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ jobId, pid: job.pid, message: 'Team started. Poll with omx_run_team_status.' }) }],
        };
      }

      case 'omx_run_team_status': {
        const { job_id: jobId } = statusSchema.parse(a);
        const job = omxTeamJobs.get(jobId) ?? loadJobFromDisk(jobId);
        if (!job) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `No job found: ${jobId}` }) }] };
        }
        const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);
        const out: Record<string, unknown> = { jobId, status: job.status, elapsedSeconds: elapsed };
        if (job.result) { try { out.result = JSON.parse(job.result) as unknown; } catch { out.result = job.result; } }
        if (job.stderr) out.stderr = job.stderr;
        return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
      }

      case 'omx_run_team_wait': {
        const { job_id: jobId, timeout_ms: timeoutMs, nudge_delay_ms: nudgeDelayMs, nudge_max_count: nudgeMaxCount, nudge_message: nudgeMessage } = waitSchema.parse(a);

        const deadline = Date.now() + Math.min(timeoutMs, 3_600_000);
        let pollDelay = 500;

        const nudgeTracker = new NudgeTracker({
          ...(nudgeDelayMs != null ? { delayMs: nudgeDelayMs } : {}),
          ...(nudgeMaxCount != null ? { maxCount: nudgeMaxCount } : {}),
          ...(nudgeMessage != null ? { message: nudgeMessage } : {}),
        });

        while (Date.now() < deadline) {
          const job = omxTeamJobs.get(jobId) ?? loadJobFromDisk(jobId);
          if (!job) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `No job found: ${jobId}` }) }] };
          }
          // Detect orphan PIDs: if job is 'running' but the process is dead,
          // mark it failed immediately rather than polling forever.
          if (job.status === 'running' && job.pid != null) {
            try {
              process.kill(job.pid, 0);
            } catch (e: unknown) {
              if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
                job.status = 'failed';
                if (!job.result) job.result = JSON.stringify({ error: 'Process no longer alive (MCP restart?)' });
                persistJob(jobId, job);
                const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);
                return { content: [{ type: 'text' as const, text: JSON.stringify({ jobId, status: 'failed', elapsedSeconds: elapsed, error: 'Process no longer alive (MCP restart?)' }) }] };
              }
            }
          }
          if (job.status !== 'running') {
            const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);
            const out: Record<string, unknown> = { jobId, status: job.status, elapsedSeconds: elapsed };
            if (job.result) { try { out.result = JSON.parse(job.result) as unknown; } catch { out.result = job.result; } }
            if (job.stderr) out.stderr = job.stderr;
            if (nudgeTracker.totalNudges > 0) out.nudges = nudgeTracker.getSummary();
            return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
          }
          // Yield to Node.js event loop -- lets child.on('close', ...) fire between polls.
          await new Promise<void>(r => setTimeout(r, pollDelay));
          pollDelay = Math.min(Math.floor(pollDelay * 1.5), 2000);

          // Auto-nudge idle panes
          try {
            const panes = await loadPaneIds(jobId);
            if (panes?.paneIds?.length) {
              await nudgeTracker.checkAndNudge(
                panes.paneIds,
                panes.leaderPaneId,
                job.teamName ?? '',
              );
            }
          } catch { /* nudge is best-effort */ }
        }

        // Timeout: leave workers running
        const elapsed = ((Date.now() - (omxTeamJobs.get(jobId)?.startedAt ?? Date.now())) / 1000).toFixed(1);
        const timeoutOut: Record<string, unknown> = {
          error: `Timed out waiting for job ${jobId} after ${(timeoutMs / 1000).toFixed(0)}s -- workers are still running; call omx_run_team_wait again to keep waiting or omx_run_team_cleanup to stop them`,
          jobId,
          status: 'running',
          elapsedSeconds: elapsed,
        };
        if (nudgeTracker.totalNudges > 0) timeoutOut.nudges = nudgeTracker.getSummary();
        return { content: [{ type: 'text' as const, text: JSON.stringify(timeoutOut) }] };
      }

      case 'omx_run_team_cleanup': {
        const { job_id: jobId, grace_ms: graceMs } = cleanupSchema.parse(a);
        const job = omxTeamJobs.get(jobId) ?? loadJobFromDisk(jobId);
        if (!job) return { content: [{ type: 'text' as const, text: `Job ${jobId} not found` }] };
        const panes = await loadPaneIds(jobId);
        if (!panes?.paneIds?.length) {
          return { content: [{ type: 'text' as const, text: 'No pane IDs recorded for this job -- nothing to clean up.' }] };
        }
        await killWorkerPanes(panes.paneIds, panes.leaderPaneId, graceMs);
        job.cleanedUpAt = new Date().toISOString();
        persistJob(jobId, job);
        return { content: [{ type: 'text' as const, text: `Cleaned up ${panes.paneIds.length} worker pane(s).` }] };
      }

      default:
        return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: (error as Error).message }) }],
      isError: true,
    };
  }
});

if (shouldAutoStartMcpServer('team')) {
  const transport = new StdioServerTransport();
  server.connect(transport).catch(console.error);
}
