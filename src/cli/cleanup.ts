import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'child_process';
import { resolveOmxFirstPartyMcpEntrypointForPluginTarget } from '../config/omx-first-party-mcp.js';

const HELP = [
  'Usage: omx cleanup [--dry-run]',
  '',
  'Kill orphaned OMX MCP server processes. Temporary directories are preserved.',
  '',
  'Options:',
  '  --dry-run  List matching orphaned processes without terminating them',
  '  --help     Show this help message',
].join('\n');

const PROCESS_EXIT_POLL_MS = 100;
const SIGTERM_GRACE_MS = 5_000;
const OMX_MCP_ENTRYPOINT_PATTERN = /(?:^|[\\/])dist[\\/]mcp[\\/]((?:state|memory|code-intel|trace|wiki)-server\.(?:[cm]?js|ts))\b/i;
const OMX_MCP_SERVE_TARGET_PATTERN = /(?:^|\s)mcp-serve\s+([^\s]+)/i;
const CODEX_PROCESS_PATTERN = /(?:^|[\\/\s])codex(?:\.js)?(?:\s|$)|@openai[\\/]codex/i;
const OMX_LAUNCH_PROCESS_PATTERN = /(?:^|[\\/\s])omx(?:\.js)?(?:\s|$)|(?:^|[\\/])(?:bin|dist[\\/]cli)[\\/]omx\.js(?:\s|$)|oh-my-codex[\\/]dist[\\/]cli[\\/]omx\.js/i;
const PROCESS_LIST_COMMAND_OPTIONS: ExecFileSyncOptionsWithStringEncoding = {
  encoding: 'utf-8',
  windowsHide: true,
};
const WINDOWS_PROCESS_DISCOVERY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Get-CimInstance Win32_Process | ForEach-Object {',
  '  [PSCustomObject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; command = $_.CommandLine } | ConvertTo-Json -Compress',
  '}',
].join('; ');

export interface ProcessEntry {
  pid: number;
  ppid: number;
  command: string;
}

export interface CleanupCandidate extends ProcessEntry {
  reason: 'ppid=1' | 'outside-current-session' | 'duplicate-sibling';
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
  selectCandidates?: (
    processes: readonly ProcessEntry[],
    currentPid: number,
  ) => CleanupCandidate[];
  isPidAlive?: (pid: number) => boolean;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  writeLine?: (line: string) => void;
}

export interface CleanupCommandDependencies {
  cleanupProcesses?: (args: readonly string[]) => Promise<CleanupResult>;
}

type ProcessListCommandRunner = (
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
) => string;

const defaultProcessListCommandRunner: ProcessListCommandRunner = (file, args, options) =>
  execFileSync(file, [...args], options);

function normalizeCommand(command: string): string {
  return command.replace(/\\+/g, '/').trim();
}

export function isOmxMcpProcess(command: string): boolean {
  return extractOmxMcpEntrypoint(command) !== null;
}

export function extractOmxMcpEntrypoint(command: string): string | null {
  const normalized = normalizeCommand(command);
  const directEntrypoint = normalized.match(OMX_MCP_ENTRYPOINT_PATTERN)?.[1]?.toLowerCase();
  if (directEntrypoint) return directEntrypoint;

  const mcpServeTarget = normalized.match(OMX_MCP_SERVE_TARGET_PATTERN)?.[1];
  return resolveOmxFirstPartyMcpEntrypointForPluginTarget(mcpServeTarget);
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

function parseIntegerField(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return null;
}

function parseWindowsProcessOutput(output: string): ProcessEntry[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return null;
      }

      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      const pid = parseIntegerField(record.pid);
      const ppid = parseIntegerField(record.ppid);
      const command = typeof record.command === 'string'
        ? record.command.trim()
        : '';
      if (!Number.isInteger(pid) || pid === null || pid <= 0) return null;
      if (!Number.isInteger(ppid) || ppid === null || ppid < 0) return null;
      if (!command) return null;
      return { pid, ppid, command } satisfies ProcessEntry;
    })
    .filter((entry): entry is ProcessEntry => entry !== null);
}

function listWindowsOmxProcesses(
  runCommand: ProcessListCommandRunner,
): ProcessEntry[] {
  const output = runCommand(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-Command', WINDOWS_PROCESS_DISCOVERY_SCRIPT],
    PROCESS_LIST_COMMAND_OPTIONS,
  );
  return parseWindowsProcessOutput(output);
}

function isBusyBoxPsCommandFieldError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /bad -o argument ['"]command['"]|unsupported arguments:.*\bargs\b/i.test(error.message);
}

export function listOmxProcesses(
  runCommand: ProcessListCommandRunner = defaultProcessListCommandRunner,
): ProcessEntry[] {
  if (process.platform === 'win32') return listWindowsOmxProcesses(runCommand);

  try {
    const output = runCommand('ps', ['axww', '-o', 'pid=,ppid=,command='], PROCESS_LIST_COMMAND_OPTIONS);
    return parsePsOutput(output);
  } catch (err) {
    if (!isBusyBoxPsCommandFieldError(err)) throw err;
    // BusyBox ps (Alpine's default) rejects the procps `command` field name
    // but accepts the equivalent `args` field. Retry only that exact
    // incompatibility so unrelated ps failures still surface normally.
    const output = runCommand('ps', ['axww', '-o', 'pid=,ppid=,args='], PROCESS_LIST_COMMAND_OPTIONS);
    return parsePsOutput(output);
  }
}

function isCodexSessionProcess(command: string): boolean {
  return CODEX_PROCESS_PATTERN.test(normalizeCommand(command));
}

function isOmxLaunchProcess(command: string): boolean {
  return OMX_LAUNCH_PROCESS_PATTERN.test(normalizeCommand(command));
}

function hasAncestorMatching(
  processByPid: ReadonlyMap<number, ProcessEntry>,
  pid: number,
  predicate: (command: string) => boolean,
): boolean {
  const seen = new Set<number>();
  let currentPid = processByPid.get(pid)?.ppid;

  while (typeof currentPid === 'number' && currentPid > 0 && !seen.has(currentPid)) {
    seen.add(currentPid);
    const parent = processByPid.get(currentPid);
    if (!parent) return false;
    if (predicate(parent.command)) return true;
    currentPid = parent.ppid;
  }

  return false;
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

export function findDuplicateSiblingCleanupCandidates(
  processes: readonly ProcessEntry[],
): CleanupCandidate[] {
  const groups = new Map<string, ProcessEntry[]>();

  for (const processEntry of processes) {
    const entrypoint = extractOmxMcpEntrypoint(processEntry.command);
    if (!entrypoint) continue;
    const key = `${processEntry.ppid}:${entrypoint}`;
    const group = groups.get(key) ?? [];
    group.push(processEntry);
    groups.set(key, group);
  }

  const candidates: CleanupCandidate[] = [];
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const sorted = [...group].sort((left, right) => left.pid - right.pid);
    for (const processEntry of sorted.slice(0, -1)) {
      candidates.push({
        ...processEntry,
        reason: 'duplicate-sibling',
      });
    }
  }

  return candidates.sort((left, right) => left.pid - right.pid);
}

export function findCleanupCandidates(
  processes: readonly ProcessEntry[],
  currentPid: number,
): CleanupCandidate[] {
  const protectedPids = buildProtectedPidSet(processes, currentPid);
  const duplicateCandidates = findDuplicateSiblingCleanupCandidates(processes)
    .filter((processEntry) => processEntry.pid !== currentPid);
  const duplicateCandidatePids = new Set(duplicateCandidates.map((candidate) => candidate.pid));

  const orphanCandidates = processes
    .filter((processEntry) => processEntry.pid !== currentPid)
    .filter((processEntry) => isOmxMcpProcess(processEntry.command))
    .filter((processEntry) => !duplicateCandidatePids.has(processEntry.pid))
    .filter((processEntry) => !protectedPids.has(processEntry.pid))
    .map((processEntry) => ({
      ...processEntry,
      reason: processEntry.ppid <= 1 ? 'ppid=1' : 'outside-current-session',
    }) satisfies CleanupCandidate);

  return [...duplicateCandidates, ...orphanCandidates]
    .sort((left, right) => left.pid - right.pid);
}

export function findLaunchSafeCleanupCandidates(
  processes: readonly ProcessEntry[],
  currentPid: number,
): CleanupCandidate[] {
  const processByPid = new Map(
    processes.map((processEntry) => [processEntry.pid, processEntry] as const),
  );

  return findCleanupCandidates(processes, currentPid).filter((candidate) => {
    if (candidate.ppid <= 1) return true;

    // Launch-safe cleanup runs automatically before starting Codex/OMX work.
    // Preserve every MCP process still attached to a live Codex or OMX launch
    // ancestor, including older same-parent duplicate siblings. Destructive
    // duplicate-sibling reaping remains available through manual cleanup via
    // findCleanupCandidates/default cleanupOmxMcpProcesses selection.
    return (
      !hasAncestorMatching(processByPid, candidate.pid, isCodexSessionProcess) &&
      !hasAncestorMatching(processByPid, candidate.pid, isOmxLaunchProcess)
    );
  });
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
  const selectCandidates = dependencies.selectCandidates ?? findCleanupCandidates;
  const isPidAlive = dependencies.isPidAlive ?? defaultIsPidAlive;
  const sendSignal = dependencies.sendSignal ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now ?? Date.now;

  const candidates = selectCandidates(listProcessesImpl(), currentPid);
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

export async function cleanupCommand(
  args: string[],
  dependencies: CleanupCommandDependencies = {},
): Promise<void> {
  const cleanupProcesses = dependencies.cleanupProcesses ?? cleanupOmxMcpProcesses;
  await cleanupProcesses(args);
}
