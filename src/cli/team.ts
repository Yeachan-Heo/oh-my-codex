import { updateModeState, startMode, readModeState } from '../modes/base.js';
import { monitorTeam, resumeTeam, shutdownTeam, startTeam, type TeamRuntime } from '../team/runtime.js';
import { sanitizeTeamName } from '../team/tmux-session.js';
import { parseWorktreeMode, type WorktreeMode } from '../team/worktree.js';

interface TeamCliOptions {
  verbose?: boolean;
}

interface ParsedTeamArgs {
  workerCount: number;
  agentType: string;
  task: string;
  teamName: string;
  ralph: boolean;
}

export interface ParsedTeamStartArgs {
  parsed: ParsedTeamArgs;
  worktreeMode: WorktreeMode;
}

function slugifyTask(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30) || 'team-task';
}

function parseTeamArgs(args: string[]): ParsedTeamArgs {
  const tokens = [...args];
  let ralph = false;
  let workerCount = 3;
  let agentType = 'executor';

  if (tokens[0]?.toLowerCase() === 'ralph') {
    ralph = true;
    tokens.shift();
  }

  const first = tokens[0] || '';
  const match = first.match(/^(\d+)(?::([a-z][a-z0-9-]*))?$/i);
  if (match) {
    const count = Number.parseInt(match[1], 10);
    if (!Number.isFinite(count) || count < 1 || count > 20) {
      throw new Error(`Invalid worker count "${match[1]}". Expected 1-20.`);
    }
    workerCount = count;
    if (match[2]) agentType = match[2];
    tokens.shift();
  }

  const task = tokens.join(' ').trim();
  if (!task) {
    throw new Error('Usage: omx team [ralph] [N:agent-type] "<task description>"');
  }

  const teamName = sanitizeTeamName(slugifyTask(task));
  return { workerCount, agentType, task, teamName, ralph };
}

export function parseTeamStartArgs(args: string[]): ParsedTeamStartArgs {
  const parsedWorktree = parseWorktreeMode(args);
  return {
    parsed: parseTeamArgs(parsedWorktree.remainingArgs),
    worktreeMode: parsedWorktree.mode,
  };
}

function buildBootstrapTasks(workerCount: number, task: string): Array<{ subject: string; description: string; owner: string }> {
  return Array.from({ length: workerCount }, (_, i) => ({
    subject: `Worker ${i + 1} bootstrap`,
    description: `Coordinate on: ${task}\n\nReport findings/results back to the lead and keep task updates current.`,
    owner: `worker-${i + 1}`,
  }));
}

async function ensureTeamModeState(parsed: ParsedTeamArgs): Promise<void> {
  const existing = await readModeState('team');
  if (existing?.active) {
    await updateModeState('team', {
      task_description: parsed.task,
      current_phase: 'team-exec',
      linked_ralph: parsed.ralph,
      team_name: parsed.teamName,
      agent_count: parsed.workerCount,
      agent_types: parsed.agentType,
    });
    return;
  }

  await startMode('team', parsed.task, 50);
  await updateModeState('team', {
    current_phase: 'team-exec',
    linked_ralph: parsed.ralph,
    team_name: parsed.teamName,
    agent_count: parsed.workerCount,
    agent_types: parsed.agentType,
  });
}

async function renderStartSummary(runtime: TeamRuntime): Promise<void> {
  console.log(`Team started: ${runtime.teamName}`);
  console.log(`tmux target: ${runtime.sessionName}`);
  console.log(`workers: ${runtime.config.worker_count}`);
  console.log(`agent_type: ${runtime.config.agent_type}`);

  const snapshot = await monitorTeam(runtime.teamName, runtime.cwd);
  if (!snapshot) {
    console.log('warning: team snapshot unavailable immediately after startup');
    return;
  }
  console.log(`tasks: total=${snapshot.tasks.total} pending=${snapshot.tasks.pending} in_progress=${snapshot.tasks.in_progress} completed=${snapshot.tasks.completed} failed=${snapshot.tasks.failed}`);
}

export async function teamCommand(args: string[], options: TeamCliOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const parsedWorktree = parseWorktreeMode(args);
  const teamArgs = parsedWorktree.remainingArgs;
  const [subcommandRaw] = teamArgs;
  const subcommand = (subcommandRaw || '').toLowerCase();

  if (subcommand === 'status') {
    const name = teamArgs[1];
    if (!name) throw new Error('Usage: omx team status <team-name>');
    const snapshot = await monitorTeam(name, cwd);
    if (!snapshot) {
      console.log(`No team state found for ${name}`);
      return;
    }
    console.log(`team=${snapshot.teamName} phase=${snapshot.phase}`);
    console.log(`workers: total=${snapshot.workers.length} dead=${snapshot.deadWorkers.length} non_reporting=${snapshot.nonReportingWorkers.length}`);
    console.log(`tasks: total=${snapshot.tasks.total} pending=${snapshot.tasks.pending} in_progress=${snapshot.tasks.in_progress} completed=${snapshot.tasks.completed} failed=${snapshot.tasks.failed}`);
    return;
  }

  if (subcommand === 'resume') {
    const name = teamArgs[1];
    if (!name) throw new Error('Usage: omx team resume <team-name>');
    const runtime = await resumeTeam(name, cwd);
    if (!runtime) {
      console.log(`No resumable team found for ${name}`);
      return;
    }
    await ensureTeamModeState({
      task: runtime.config.task,
      workerCount: runtime.config.worker_count,
      agentType: runtime.config.agent_type,
      teamName: runtime.teamName,
      ralph: false,
    });
    await renderStartSummary(runtime);
    return;
  }

  if (subcommand === 'shutdown') {
    const name = teamArgs[1];
    if (!name) throw new Error('Usage: omx team shutdown <team-name>');
    await shutdownTeam(name, cwd, { force: false });
    await updateModeState('team', {
      active: false,
      current_phase: 'cancelled',
      completed_at: new Date().toISOString(),
    }).catch(() => {});
    console.log(`Team shutdown complete: ${name}`);
    return;
  }

  const parsed = parseTeamArgs(teamArgs);
  const tasks = buildBootstrapTasks(parsed.workerCount, parsed.task);
  const runtime = await startTeam(
    parsed.teamName,
    parsed.task,
    parsed.agentType,
    parsed.workerCount,
    tasks,
    cwd,
    { worktreeMode: parsedWorktree.mode },
  );

  await ensureTeamModeState(parsed);
  if (options.verbose) {
    console.log(`linked_ralph=${parsed.ralph}`);
  }
  await renderStartSummary(runtime);
}
