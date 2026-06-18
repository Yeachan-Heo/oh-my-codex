import { existsSync, realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { omxRoot } from '../utils/paths.js';

export interface ProjectRuntimeCodexHome {
  path: string;
  sessionCountHint: number;
  source: 'project' | 'madmax-run';
  publicLabel?: string;
}

interface MadmaxRunMetadata {
  source_cwd?: unknown;
  run_dir?: unknown;
  cwd?: unknown;
}

export async function discoverProjectRuntimeCodexHomes(cwd: string): Promise<ProjectRuntimeCodexHome[]> {
  const localHomes = await discoverLocalProjectRuntimeCodexHomes(cwd);
  const madmaxHomes = await discoverAssociatedMadmaxRuntimeCodexHomes(cwd);
  return [...localHomes, ...madmaxHomes].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'project' ? -1 : 1;
    return b.path.localeCompare(a.path);
  });
}

async function discoverLocalProjectRuntimeCodexHomes(cwd: string): Promise<ProjectRuntimeCodexHome[]> {
  const root = join(omxRoot(cwd), 'runtime', 'codex-home');
  if (!existsSync(root)) return [];

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const homes: ProjectRuntimeCodexHome[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('omx-')) continue;
    const home = join(root, entry.name);
    const sessions = join(home, 'sessions');
    if (!existsSync(sessions)) continue;
    const sessionCountHint = await countImmediateSessionEntries(sessions);
    homes.push({ path: home, sessionCountHint, source: 'project' });
  }

  return homes;
}

async function discoverAssociatedMadmaxRuntimeCodexHomes(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectRuntimeCodexHome[]> {
  const runsRoot = resolveMadmaxRunsRoot(env);
  if (!existsSync(runsRoot)) return [];

  const associatedRunDirs = await discoverAssociatedMadmaxRunDirs(cwd, runsRoot);
  const homes: ProjectRuntimeCodexHome[] = [];
  for (const runDir of associatedRunDirs) {
    const codexHomeRoot = join(runDir, '.omx', 'runtime', 'codex-home');
    const entries = await readdir(codexHomeRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('omx-')) continue;
      const home = join(codexHomeRoot, entry.name);
      const sessions = join(home, 'sessions');
      if (!existsSync(sessions)) continue;
      homes.push({
        path: home,
        sessionCountHint: await countImmediateSessionEntries(sessions),
        source: 'madmax-run',
        publicLabel: `madmax:${entry.name}`,
      });
    }
  }
  return homes;
}

async function discoverAssociatedMadmaxRunDirs(cwd: string, runsRoot: string): Promise<string[]> {
  const canonicalCwd = canonicalizeComparableProjectPath(cwd);
  const canonicalRunsRoot = resolve(runsRoot);
  const seen = new Set<string>();
  const runDirs: string[] = [];

  const addMetadata = (raw: unknown): void => {
    const metadata = parseMadmaxRunMetadata(raw);
    if (!metadata) return;
    if (canonicalizeComparableProjectPath(metadata.sourceCwd) !== canonicalCwd) return;
    const runDir = resolve(metadata.runDir);
    if (!isPathWithin(runDir, canonicalRunsRoot)) return;
    if (!existsSync(runDir) || seen.has(runDir)) return;
    seen.add(runDir);
    runDirs.push(runDir);
  };

  const registryPath = join(runsRoot, 'registry.jsonl');
  const rawRegistry = await readFile(registryPath, 'utf-8').catch(() => '');
  for (const line of rawRegistry.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      addMetadata(JSON.parse(trimmed));
    } catch {}
  }

  const entries = await readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue;
    const metadataPath = join(runsRoot, entry.name, '.omxbox-run.json');
    try {
      addMetadata(JSON.parse(await readFile(metadataPath, 'utf-8')));
    } catch {}
  }

  return runDirs.sort((a, b) => b.localeCompare(a));
}

function resolveMadmaxRunsRoot(env: NodeJS.ProcessEnv): string {
  return resolve(env.OMX_RUNS_DIR || join(homedir(), '.omx-runs'));
}

function parseMadmaxRunMetadata(raw: unknown): { sourceCwd: string; runDir: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as MadmaxRunMetadata;
  const sourceCwd = typeof record.source_cwd === 'string' ? record.source_cwd.trim() : '';
  const runDir = typeof record.run_dir === 'string'
    ? record.run_dir.trim()
    : typeof record.cwd === 'string'
      ? record.cwd.trim()
      : '';
  if (!sourceCwd || !runDir) return null;
  return { sourceCwd, runDir };
}

function canonicalizeComparableProjectPath(rawPath: string): string {
  const resolved = resolve(rawPath);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isPathWithin(candidatePath: string, rootPath: string): boolean {
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}

async function countImmediateSessionEntries(sessionsDir: string): Promise<number> {
  const years = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  return years.filter((entry) => entry.isDirectory()).length;
}
