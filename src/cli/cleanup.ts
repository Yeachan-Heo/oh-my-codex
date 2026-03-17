import { execFileSync } from 'child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HELP = [
  'Usage: omx cleanup [--dry-run]',
  '',
  'Kill orphaned OMX MCP server processes and remove stale OMX /tmp directories left behind by previous Codex App sessions.',
  '',
  'Options:',
  '  --dry-run  List matching orphaned processes and stale /tmp directories without removing them',
  '  --help     Show this help message',
].join('\n');

const PROCESS_EXIT_POLL_MS = 100;
const SIGTERM_GRACE_MS = 5_000;
const STALE_TMP_MAX_AGE_MS = 60 * 60 * 1000;
const OMX_MCP_SERVER_PATTERN = /(?:^|[\\/])dist[\\/]mcp[\\/](?:state|memory|code-intel|trace|team)-server\.(?:[cm]?js|ts)\b/i;
const CODEX_PROCESS_PATTERN = /(?:^|[\\/\s])codex(?:\.js)?(?:\s|$)|@openai[\\/]codex/i;
const OMX_TMP_DIRECTORY_PATTERN = /^(omc|omx|oh-my-codex)-/;

export interface ProcessEntry {
  pid: number;
  ppid: number;
  command: string;
}

export interface CleanupCandidate extends ProcessEntry {
  reason: 'ppid=1' | 'outside-current-session';
}

export interface CleanupResult {
  dryRun: boolean;
  candidates: CleanupCandidate[];
  terminatedCount: number;
  forceKilledCount: number;
  failedPids: number[];
}

export interface CleanupDependencies {
  currentPid?: number;
  listProcesses?: () => ProcessEntry[];
  isPidAlive?: (pid: number) => boolean;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  writeLine?: (line: string) => void;
}

interface TmpDirectoryEntry {
  name: string;
  isDirectory(): boolean;
}

export interface TmpCleanupDependencies {
  tmpRoot?: string;
  listTmpEntries?: (tmpRoot: string) => Promise<TmpDirectoryEntry[]>;
  statPath?: (path: string) => Promise<{ mtimeMs: number }>;
  removePath?: (path: string) => Promise<void>;
  now?: () => number;
  writeLine?: (line: string) => void;
}

export interface CleanupCommandDependencies {
  cleanupProcesses?: (args: readonly string[]) => Promise<CleanupResult>;
  cleanupTmpDirectories?: (args: readonly string[]) => Promise<number>;
}

function normalizeCommand(command: string): string {
  return command.replace(/\\+/g, '/').trim();
}

function formatPlural(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function isOmxMcpProcess(command: string): boolean {
  const normalized = normalizeCommand(command);
  return normalized.includes('oh-my-codex/dist/mcp') || OMX_MCP_SERVER_PATTERN.test(normalized);
}

export function parsePsOutput(output: string): ProcessEntry[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      const pid = Number.parseInt(match[1], 10);
      const ppid = Number.parseInt(match[2], 10);
      const command = match[3]?.trim();
      if (!Number.isInteger(pid) || pid <= 0) return null;
      if (!Number.isInteger(ppid) || ppid < 0) return null;
      if (!command) return null;
      return { pid, ppid, command } satisfies ProcessEntry;
    })
    .filter((entry): entry is ProcessEntry => entry !== null);
}

export function listOmxProcesses(): ProcessEntry[] {
  const output = execFileSync('ps', ['axww', '-o', 'pid=,ppid=,command='], {
    encoding: 'utf-8',
  });
  return parsePsOutput(output);
}

function isCodexSessionProcess(command: string): boolean {
  return CODEX_PROCESS_PATTERN.test(normalizeCommand(command));
}

function resolveProtectedRootPid(
  processes: readonly ProcessEntry[],
  currentPid: number,
): number {
  const parentByPid = new Map<number, number>();
  const commandByPid = new Map<number, string>();

  for (const processEntry of processes) {
    parentByPid.set(processEntry.pid, processEntry.ppid);
    commandByPid.set(processEntry.pid, processEntry.command);
  }

  let pid: number | undefined = currentPid;
  while (typeof pid === 'number' && pid > 1) {
    const command = commandByPid.get(pid);
    if (command && isCodexSessionProcess(command)) return pid;
    const parentPid = parentByPid.get(pid);
    if (typeof parentPid !== 'number' || parentPid <= 0 || parentPid === pid) break;
    pid = parentPid;
  }

  return currentPid;
}

export function buildProtectedPidSet(
  processes: readonly ProcessEntry[],
  currentPid: number,
): Set<number> {
  const childrenByPid = new Map<number, number[]>();

  for (const processEntry of processes) {
    const siblings = childrenByPid.get(processEntry.ppid) ?? [];
    siblings.push(processEntry.pid);
    childrenByPid.set(processEntry.ppid, siblings);
  }

  const protectedRootPid = resolveProtectedRootPid(processes, currentPid);
  const protectedPids = new Set<number>();
  const descendants = [protectedRootPid];

  while (descendants.length > 0) {
    const pid = descendants.pop()!;
    if (protectedPids.has(pid)) continue;
    protectedPids.add(pid);
    for (const childPid of childrenByPid.get(pid) ?? []) {
      if (!protectedPids.has(childPid)) descendants.push(childPid);
    }
  }

  return protectedPids;
}

export function findCleanupCandidates(
  processes: readonly ProcessEntry[],
  currentPid: number,
): CleanupCandidate[] {
  const protectedPids = buildProtectedPidSet(processes, currentPid);

  return processes
    .filter((processEntry) => processEntry.pid !== currentPid)
    .filter((processEntry) => isOmxMcpProcess(processEntry.command))
    .filter((processEntry) => !protectedPids.has(processEntry.pid))
    .sort((left, right) => left.pid - right.pid)
    .map((processEntry) => ({
      ...processEntry,
      reason: processEntry.ppid <= 1 ? 'ppid=1' : 'outside-current-session',
    }));
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
}

async function waitForPidsToExit(
  pids: readonly number[],
  timeoutMs: number,
  isPidAlive: (pid: number) => boolean,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<Set<number>> {
  const remaining = new Set(
    pids.filter((pid) => Number.isFinite(pid) && pid > 0 && isPidAlive(pid)),
  );
  if (remaining.size === 0) return remaining;

  const deadline = now() + Math.max(0, timeoutMs);
  while (now() < deadline && remaining.size > 0) {
    await sleep(PROCESS_EXIT_POLL_MS);
    for (const pid of [...remaining]) {
      if (!isPidAlive(pid)) remaining.delete(pid);
    }
  }

  for (const pid of [...remaining]) {
    if (!isPidAlive(pid)) remaining.delete(pid);
  }

  return remaining;
}

function formatCandidate(candidate: CleanupCandidate): string {
  return `PID ${candidate.pid} (PPID ${candidate.ppid}, ${candidate.reason}) ${candidate.command}`;
}

export async function cleanupOmxMcpProcesses(
  args: readonly string[],
  dependencies: CleanupDependencies = {},
): Promise<CleanupResult> {
  if (args.includes('--help') || args.includes('-h')) {
    dependencies.writeLine?.(HELP) ?? console.log(HELP);
    return {
      dryRun: true,
      candidates: [],
      terminatedCount: 0,
      forceKilledCount: 0,
      failedPids: [],
    };
  }

  const dryRun = args.includes('--dry-run');
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));
  const currentPid = dependencies.currentPid ?? process.pid;
  const listProcessesImpl = dependencies.listProcesses ?? listOmxProcesses;
  const isPidAlive = dependencies.isPidAlive ?? defaultIsPidAlive;
  const sendSignal = dependencies.sendSignal ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now ?? Date.now;

  const candidates = findCleanupCandidates(listProcessesImpl(), currentPid);
  if (candidates.length === 0) {
    writeLine(dryRun
      ? 'Dry run: no orphaned OMX MCP server processes found.'
      : 'No orphaned OMX MCP server processes found.');
    return {
      dryRun,
      candidates,
      terminatedCount: 0,
      forceKilledCount: 0,
      failedPids: [],
    };
  }

  if (dryRun) {
    writeLine(`Dry run: would terminate ${candidates.length} orphaned OMX MCP server process(es):`);
    for (const candidate of candidates) writeLine(`  ${formatCandidate(candidate)}`);
    return {
      dryRun: true,
      candidates,
      terminatedCount: 0,
      forceKilledCount: 0,
      failedPids: [],
    };
  }

  writeLine(`Found ${candidates.length} orphaned OMX MCP server process(es). Sending SIGTERM...`);
  for (const candidate of candidates) {
    try {
      sendSignal(candidate.pid, 'SIGTERM');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw err;
      }
    }
  }

  const remainingAfterTerm = await waitForPidsToExit(
    candidates.map((candidate) => candidate.pid),
    SIGTERM_GRACE_MS,
    isPidAlive,
    sleep,
    now,
  );
  const stillRunning = candidates.filter((candidate) =>
    remainingAfterTerm.has(candidate.pid),
  );
  let terminatedCount = candidates.length - stillRunning.length;

  let forceKilledCount = 0;
  const failedPids: number[] = [];
  if (stillRunning.length > 0) {
    writeLine(`Escalating to SIGKILL for ${stillRunning.length} process(es) still alive after ${SIGTERM_GRACE_MS / 1000}s.`);
    for (const candidate of stillRunning) {
      try {
        sendSignal(candidate.pid, 'SIGKILL');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw err;
        }
      }
    }

    const remainingAfterKill = await waitForPidsToExit(
      stillRunning.map((candidate) => candidate.pid),
      PROCESS_EXIT_POLL_MS,
      isPidAlive,
      sleep,
      now,
    );
    forceKilledCount = stillRunning.length - remainingAfterKill.size;
    terminatedCount += forceKilledCount;
    failedPids.push(...remainingAfterKill);
  }

  writeLine(`Killed ${terminatedCount} orphaned OMX MCP server process(es)${forceKilledCount > 0 ? ` (${forceKilledCount} required SIGKILL)` : ''}.`);
  if (failedPids.length > 0) {
    writeLine(`Warning: ${failedPids.length} process(es) still appear alive: ${failedPids.join(', ')}`);
  }

  return {
    dryRun: false,
    candidates,
    terminatedCount,
    forceKilledCount,
    failedPids,
  };
}

export async function cleanupStaleTmpDirectories(
  args: readonly string[],
  dependencies: TmpCleanupDependencies = {},
): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const tmpRoot = dependencies.tmpRoot ?? tmpdir();
  const listTmpEntries = dependencies.listTmpEntries ?? ((root: string) => readdir(root, { withFileTypes: true }));
  const statPath = dependencies.statPath ?? stat;
  const removePath = dependencies.removePath ?? ((path: string) => rm(path, { recursive: true, force: true }));
  const now = dependencies.now ?? Date.now;
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));

  const staleDirectories: string[] = [];
  for (const entry of await listTmpEntries(tmpRoot)) {
    if (!entry.isDirectory() || !OMX_TMP_DIRECTORY_PATTERN.test(entry.name)) continue;

    const entryPath = join(tmpRoot, entry.name);
    let entryStat: { mtimeMs: number };
    try {
      entryStat = await statPath(entryPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }

    if (now() - entryStat.mtimeMs <= STALE_TMP_MAX_AGE_MS) continue;
    staleDirectories.push(entryPath);
  }
  staleDirectories.sort((left, right) => left.localeCompare(right));

  if (staleDirectories.length === 0) {
    writeLine(dryRun
      ? 'Dry run: no stale OMX /tmp directories found.'
      : 'No stale OMX /tmp directories found.');
    return 0;
  }

  const summaryTarget = formatPlural(
    staleDirectories.length,
    'stale OMX /tmp directory',
    'stale OMX /tmp directories',
  );
  if (dryRun) {
    writeLine(`Dry run: would remove ${summaryTarget}:`);
    for (const directoryPath of staleDirectories) {
      writeLine(`  ${directoryPath}`);
    }
    return 0;
  }

  let removedCount = 0;
  for (const directoryPath of staleDirectories) {
    try {
      await removePath(directoryPath);
      removedCount += 1;
      writeLine(`Removed stale /tmp directory: ${directoryPath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }

  writeLine(
    `Removed ${formatPlural(
      removedCount,
      'stale OMX /tmp directory',
      'stale OMX /tmp directories',
    )}.`,
  );
  return removedCount;
}

export async function cleanupCommand(
  args: string[],
  dependencies: CleanupCommandDependencies = {},
): Promise<void> {
  const cleanupProcesses = dependencies.cleanupProcesses ?? cleanupOmxMcpProcesses;
  const cleanupTmpDirectories = dependencies.cleanupTmpDirectories ?? cleanupStaleTmpDirectories;

  await cleanupProcesses(args);
  if (args.includes('--help') || args.includes('-h')) return;
  await cleanupTmpDirectories(args);
}
