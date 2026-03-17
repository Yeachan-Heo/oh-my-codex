import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startMode, updateModeState, readModeState } from '../modes/base.js';
import { captureTmuxPaneFromEnv } from '../state/mode-state-context.js';
import { launchWithHud } from './index.js';
import { canonicalRalphthonPrdPath, createRalphthonPrd, readRalphthonPrd, resolveExistingRalphthonPrdPath, writeRalphthonPrd } from '../ralphthon/prd.js';
import { bootstrapRalphthonPrdFromExistingArtifacts } from '../ralphthon/bootstrap.js';
import { canonicalRalphthonRuntimePath, createRalphthonRuntimeState, readRalphthonRuntimeState, writeRalphthonRuntimeState } from '../ralphthon/runtime.js';
import { isTmuxAvailable } from '../team/tmux-session.js';

export const RALPHTHON_HELP = `omx ralphthon - Autonomous hackathon lifecycle mode

Usage:
  omx ralphthon [task text...]
  omx ralphthon --resume [codex-args...]
  omx ralphthon --skip-interview [task text...]
  omx ralphthon [--max-waves N] [--poll-interval SEC] [codex-args...] [task text...]

Options:
  --help, -h             Show this help message
  --resume               Resume from existing ralphthon PRD/runtime state
  --skip-interview       Skip deep-interview bootstrap and use an existing PRD/spec if available
  --max-waves <N>        Limit hardening waves before forced completion
  --poll-interval <SEC>  Override injector poll interval in seconds
`;

const VALUE_TAKING_FLAGS = new Set(['--model', '--provider', '--config', '-c', '-i', '--images-dir', '--max-waves', '--poll-interval']);
const RALPHTHON_APPEND_ENV = 'OMX_RALPHTHON_APPEND_INSTRUCTIONS_FILE';

export interface ParsedRalphthonArgs {
  resume: boolean;
  skipInterview: boolean;
  maxWaves: number | null;
  pollIntervalSec: number | null;
  passthroughArgs: string[];
  taskDescription: string;
}

function requirePositiveInteger(raw: string, flag: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  return parsed;
}

export function extractRalphthonTaskDescription(args: readonly string[]): string {
  const words: string[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i] || '';
    if (token === '--') {
      for (let j = i + 1; j < args.length; j += 1) words.push(args[j] || '');
      break;
    }
    if (token.startsWith('--') && token.includes('=')) {
      i += 1;
      continue;
    }
    if (token.startsWith('-') && VALUE_TAKING_FLAGS.has(token)) {
      i += 2;
      continue;
    }
    if (token.startsWith('-')) {
      i += 1;
      continue;
    }
    words.push(token);
    i += 1;
  }
  return words.join(' ').trim() || 'ralphthon-mode';
}

export function parseRalphthonArgs(args: readonly string[]): ParsedRalphthonArgs {
  let resume = false;
  let skipInterview = false;
  let maxWaves: number | null = null;
  let pollIntervalSec: number | null = null;
  const passthroughArgs: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] || '';
    if (token === '--resume') {
      resume = true;
      continue;
    }
    if (token === '--skip-interview') {
      skipInterview = true;
      continue;
    }
    if (token === '--max-waves') {
      const next = args[i + 1];
      if (!next) throw new Error('--max-waves requires a value.');
      maxWaves = requirePositiveInteger(next, '--max-waves');
      i += 1;
      continue;
    }
    if (token.startsWith('--max-waves=')) {
      maxWaves = requirePositiveInteger(token.slice('--max-waves='.length), '--max-waves');
      continue;
    }
    if (token === '--poll-interval') {
      const next = args[i + 1];
      if (!next) throw new Error('--poll-interval requires a value.');
      pollIntervalSec = requirePositiveInteger(next, '--poll-interval');
      i += 1;
      continue;
    }
    if (token.startsWith('--poll-interval=')) {
      pollIntervalSec = requirePositiveInteger(token.slice('--poll-interval='.length), '--poll-interval');
      continue;
    }
    passthroughArgs.push(token);
  }

  return {
    resume,
    skipInterview,
    maxWaves,
    pollIntervalSec,
    passthroughArgs,
    taskDescription: extractRalphthonTaskDescription(passthroughArgs),
  };
}

export function filterRalphthonCodexArgs(args: readonly string[]): string[] {
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] || '';
    if (token === '--resume' || token === '--skip-interview') continue;
    if (token === '--max-waves' || token === '--poll-interval') {
      i += 1;
      continue;
    }
    if (token.startsWith('--max-waves=') || token.startsWith('--poll-interval=')) continue;
    filtered.push(token);
  }
  return filtered;
}

function buildAppendInstructions(parsed: ParsedRalphthonArgs, prdPath: string): string {
  const interviewDirective = parsed.skipInterview
    ? 'Skip deep-interview unless the PRD is missing or unusably incomplete.'
    : 'If the PRD is missing, start with deep-interview and then materialize the PRD.';
  const maxWavesLine = parsed.maxWaves == null ? 'No explicit hardening-wave cap is configured.' : `Stop hardening after ${parsed.maxWaves} waves even if no explicit completion marker was emitted.`;
  const pollLine = parsed.pollIntervalSec == null ? 'Use the default 120-second injector poll cadence.' : `The injector poll cadence is ${parsed.pollIntervalSec} seconds.`;
  return [
    '<ralphthon_mode>',
    'You are in OMX ralphthon mode. Maintain `.omx/ralphthon/prd.json` as the source of truth for task status.',
    interviewDirective,
    `PRD path: \`${prdPath}\``,
    pollLine,
    maxWavesLine,
    'Parallelism:',
    '- Prefer Codex native subagents for independent parallel subtasks inside the leader session.',
    '- Treat `.omx/state/subagent-tracking.json` as the native subagent activity ledger used by the Ralphthon watchdog.',
    '- Do not emit task-complete or hardening-complete markers until any active native subagent threads for the current session have finished.',
    'Protocol:',
    '1. When bootstrapping or refreshing the PRD, emit `[RALPHTHON_PRD_READY]` once the PRD exists and is valid JSON.',
    '2. Before starting a task, emit `[RALPHTHON_TASK_START] id=<task-id>`.',
    '3. On success, update the PRD task status to done and emit `[RALPHTHON_TASK_DONE] id=<task-id>` only after active native subagent threads for that work are finished.',
    '4. On failure, update the PRD task status/retry info and emit `[RALPHTHON_TASK_FAILED] id=<task-id> reason=<short-kebab-reason>`.',
    '5. During hardening, add any new hardening tasks into the PRD and emit `[RALPHTHON_HARDENING_GENERATED] wave=<n> count=<k>` once subagent-assisted checks are complete.',
    '</ralphthon_mode>',
  ].join('\n');
}

async function writeAppendInstructionsFile(cwd: string, parsed: ParsedRalphthonArgs, prdPath: string): Promise<string> {
  const dir = join(cwd, '.omx', 'ralphthon');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'session-instructions.md');
  await writeFile(path, `${buildAppendInstructions(parsed, prdPath)}\n`);
  return path;
}

async function ensureInitialRalphthonArtifacts(cwd: string, parsed: ParsedRalphthonArgs): Promise<{ prdPath: string; runtimePath: string }> {
  let prd = await readRalphthonPrd(cwd);
  if (!prd) {
    if (parsed.resume) {
      throw new Error('Cannot resume ralphthon: no existing `.omx/ralphthon/prd.json` (or compatible legacy `.omx/prd.json`) found.');
    }
    prd = await bootstrapRalphthonPrdFromExistingArtifacts(cwd, parsed.taskDescription);
  }
  if (!prd) {
    prd = await bootstrapRalphthonPrdFromExistingArtifacts(cwd, parsed.taskDescription) ?? createRalphthonPrd({
      project: parsed.taskDescription,
      config: {
        ...(parsed.maxWaves == null ? {} : { maxHardeningWaves: parsed.maxWaves }),
        ...(parsed.pollIntervalSec == null ? {} : { pollIntervalSec: parsed.pollIntervalSec }),
      },
    });
  } else {
    prd = {
      ...prd,
      config: {
        ...prd.config,
        ...(parsed.maxWaves == null ? {} : { maxHardeningWaves: parsed.maxWaves }),
        ...(parsed.pollIntervalSec == null ? {} : { pollIntervalSec: parsed.pollIntervalSec }),
      },
    };
  }

  const prdPath = await writeRalphthonPrd(cwd, prd);
  const runtime = (await readRalphthonRuntimeState(cwd)) ?? createRalphthonRuntimeState(captureTmuxPaneFromEnv() ?? '');
  const runtimePath = await writeRalphthonRuntimeState(cwd, runtime);
  return { prdPath, runtimePath };
}

export async function ralphthonCommand(args: string[]): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    console.log(RALPHTHON_HELP);
    return;
  }

  const cwd = process.cwd();
  if (!process.env.TMUX && !isTmuxAvailable()) {
    throw new Error('ralphthon requires tmux (inside tmux or available on PATH) so the injector can monitor the leader pane.');
  }
  const parsed = parseRalphthonArgs(args);
  const { prdPath, runtimePath } = await ensureInitialRalphthonArtifacts(cwd, parsed);

  const existingState = await readModeState('ralphthon', cwd);
  if (!existingState || existingState.active !== true) {
    await startMode('ralphthon', parsed.taskDescription, 10_000, cwd);
  }
  await updateModeState('ralphthon', {
    current_phase: parsed.resume ? 'resuming' : 'bootstrapping',
    task_description: parsed.taskDescription,
    canonical_prd_path: prdPath,
    runtime_path: runtimePath,
    skip_interview: parsed.skipInterview,
    max_hardening_waves: parsed.maxWaves,
    poll_interval_sec: parsed.pollIntervalSec,
    ...(captureTmuxPaneFromEnv() ? { leader_pane_id: captureTmuxPaneFromEnv() } : {}),
  }, cwd);

  const appendixPath = await writeAppendInstructionsFile(cwd, parsed, prdPath);
  const previousAppendixEnv = process.env[RALPHTHON_APPEND_ENV];
  process.env[RALPHTHON_APPEND_ENV] = appendixPath;
  console.log(`[ralphthon] active_prd: ${resolveExistingRalphthonPrdPath(cwd) ?? canonicalRalphthonPrdPath(cwd)}`);
  console.log(`[ralphthon] runtime_state: ${canonicalRalphthonRuntimePath(cwd)}`);
  console.log('[ralphthon] Launching Codex with autonomous injector/watchdog support...');
  try {
    await launchWithHud(filterRalphthonCodexArgs(args));
  } finally {
    if (typeof previousAppendixEnv === 'string') process.env[RALPHTHON_APPEND_ENV] = previousAppendixEnv;
    else delete process.env[RALPHTHON_APPEND_ENV];
  }
}
