import { execFileSync, spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { ensureWorktree, planWorktreeTarget } from '../team/worktree.js';
import { loadAutoresearchMissionContract } from '../autoresearch/contracts.js';
import {
  countTrailingAutoresearchNoops,
  finalizeAutoresearchRunState,
  loadAutoresearchRunManifest,
  materializeAutoresearchMissionToWorktree,
  prepareAutoresearchRuntime,
  processAutoresearchCandidate,
  resumeAutoresearchRuntime,
  buildAutoresearchRunTag,
} from '../autoresearch/runtime.js';
import { assertModeStartAllowed } from '../modes/base.js';
import { CODEX_BYPASS_FLAG, MADMAX_FLAG } from './constants.js';

export const AUTORESEARCH_HELP = `omx autoresearch - Launch OMX autoresearch with thin-supervisor parity semantics

Usage:
  omx autoresearch <mission-dir> [codex-args...]
  omx autoresearch --resume <run-id> [codex-args...]

Arguments:
  <mission-dir>    Directory inside a git repository containing mission.md and sandbox.md
  <run-id>         Existing autoresearch run id from .omx/logs/autoresearch/<run-id>/manifest.json

Behavior:
  - validates mission.md and sandbox.md
  - requires sandbox.md YAML frontmatter with evaluator.command and evaluator.format=json
  - fresh launch creates a run-tagged autoresearch/<slug>/<run-tag> lane
  - supervisor records baseline, candidate, keep/discard/reset, and results artifacts under .omx/logs/autoresearch/
  - --resume loads the authoritative per-run manifest and continues from the last kept commit
`;

const AUTORESEARCH_APPEND_INSTRUCTIONS_ENV = 'OMX_AUTORESEARCH_APPEND_INSTRUCTIONS_FILE';
const AUTORESEARCH_MAX_CONSECUTIVE_NOOPS = 3;

export function normalizeAutoresearchCodexArgs(codexArgs: readonly string[]): string[] {
  const normalized: string[] = [];
  let hasBypass = false;

  for (const arg of codexArgs) {
    if (arg === MADMAX_FLAG) {
      if (!hasBypass) {
        normalized.push(CODEX_BYPASS_FLAG);
        hasBypass = true;
      }
      continue;
    }
    if (arg === CODEX_BYPASS_FLAG) {
      if (!hasBypass) {
        normalized.push(arg);
        hasBypass = true;
      }
      continue;
    }
    normalized.push(arg);
  }

  if (!hasBypass) {
    normalized.push(CODEX_BYPASS_FLAG);
  }

  return normalized;
}

function runAutoresearchTurn(worktreePath: string, instructionsFile: string, codexArgs: string[]): void {
  const prompt = readFileSync(instructionsFile, 'utf-8');
  const launchArgs = ['exec', ...normalizeAutoresearchCodexArgs(codexArgs), '-'];
  const result = spawnSync('codex', launchArgs, {
    cwd: worktreePath,
    stdio: ['pipe', 'inherit', 'inherit'],
    input: prompt,
    encoding: 'utf-8',
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = typeof result.status === 'number' ? result.status : 1;
    throw new Error(`autoresearch_codex_exec_failed:${result.status ?? 'unknown'}`);
  }
}

export interface ParsedAutoresearchArgs {
  missionDir: string | null;
  runId: string | null;
  codexArgs: string[];
}

function resolveRepoRoot(cwd: string): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function parseAutoresearchArgs(args: readonly string[]): ParsedAutoresearchArgs {
  const values = [...args];
  if (values.length === 0) {
    throw new Error(`mission-dir is required.\n${AUTORESEARCH_HELP}`);
  }
  const first = values[0];
  if (first === '--help' || first === '-h' || first === 'help') {
    return { missionDir: '--help', runId: null, codexArgs: [] };
  }
  if (first === '--resume') {
    const runId = values[1]?.trim();
    if (!runId) {
      throw new Error(`--resume requires <run-id>.\n${AUTORESEARCH_HELP}`);
    }
    return { missionDir: null, runId, codexArgs: values.slice(2) };
  }
  if (first.startsWith('--resume=')) {
    const runId = first.slice('--resume='.length).trim();
    if (!runId) {
      throw new Error(`--resume requires <run-id>.\n${AUTORESEARCH_HELP}`);
    }
    return { missionDir: null, runId, codexArgs: values.slice(1) };
  }
  if (first.startsWith('-')) {
    throw new Error(`mission-dir must be the first positional argument unless using --resume.\n${AUTORESEARCH_HELP}`);
  }
  return { missionDir: first, runId: null, codexArgs: values.slice(1) };
}

async function runAutoresearchLoop(
  codexArgs: string[],
  runtime: {
    instructionsFile: string;
    manifestFile: string;
    repoRoot: string;
    worktreePath: string;
  },
  missionDir: string,
): Promise<void> {
  const previousInstructionsFile = process.env[AUTORESEARCH_APPEND_INSTRUCTIONS_ENV];
  const originalCwd = process.cwd();
  process.env[AUTORESEARCH_APPEND_INSTRUCTIONS_ENV] = runtime.instructionsFile;

  try {
    while (true) {
      runAutoresearchTurn(runtime.worktreePath, runtime.instructionsFile, codexArgs);

      const contract = await loadAutoresearchMissionContract(missionDir);
      const manifest = await loadAutoresearchRunManifest(runtime.repoRoot, JSON.parse(execFileSync('cat', [runtime.manifestFile], { encoding: 'utf-8' })).run_id);
      const decision = await processAutoresearchCandidate(contract, manifest, runtime.repoRoot);
      if (decision === 'abort' || decision === 'error') {
        return;
      }
      if (decision === 'noop') {
        const trailingNoops = await countTrailingAutoresearchNoops(manifest.ledger_file);
        if (trailingNoops >= AUTORESEARCH_MAX_CONSECUTIVE_NOOPS) {
          await finalizeAutoresearchRunState(runtime.repoRoot, manifest.run_id, {
            status: 'stopped',
            stopReason: `repeated noop limit reached (${AUTORESEARCH_MAX_CONSECUTIVE_NOOPS})`,
          });
          return;
        }
      }
      process.env[AUTORESEARCH_APPEND_INSTRUCTIONS_ENV] = runtime.instructionsFile;
    }
  } finally {
    process.chdir(originalCwd);
    if (typeof previousInstructionsFile === 'string') {
      process.env[AUTORESEARCH_APPEND_INSTRUCTIONS_ENV] = previousInstructionsFile;
    } else {
      delete process.env[AUTORESEARCH_APPEND_INSTRUCTIONS_ENV];
    }
  }
}

export async function autoresearchCommand(args: string[]): Promise<void> {
  const parsed = parseAutoresearchArgs(args);
  if (parsed.missionDir === '--help') {
    console.log(AUTORESEARCH_HELP);
    return;
  }

  if (parsed.runId) {
    const repoRoot = resolveRepoRoot(process.cwd());
    await assertModeStartAllowed('autoresearch', repoRoot);
    const manifest = await loadAutoresearchRunManifest(repoRoot, parsed.runId);
    const runtime = await resumeAutoresearchRuntime(repoRoot, parsed.runId);
    await runAutoresearchLoop(parsed.codexArgs, runtime, manifest.mission_dir);
    return;
  }

  const contract = await loadAutoresearchMissionContract(parsed.missionDir as string);
  await assertModeStartAllowed('autoresearch', contract.repoRoot);
  const runTag = buildAutoresearchRunTag();
  const plan = planWorktreeTarget({
    cwd: contract.repoRoot,
    scope: 'autoresearch',
    mode: { enabled: true, detached: false, name: contract.missionSlug },
    worktreeTag: runTag,
  });
  const ensured = ensureWorktree(plan);
  if (!ensured.enabled) {
    throw new Error('autoresearch worktree planning unexpectedly disabled');
  }

  const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, ensured.worktreePath);
  const runtime = await prepareAutoresearchRuntime(worktreeContract, contract.repoRoot, ensured.worktreePath, { runTag });
  await runAutoresearchLoop(parsed.codexArgs, runtime, worktreeContract.missionDir);
}
