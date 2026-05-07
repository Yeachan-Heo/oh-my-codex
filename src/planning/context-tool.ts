import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  readContextPackHandoffStatus,
  resolveContextPackRepoRoot,
} from './context-packs.js';
import {
  isCanonicalContextPackPath,
  normalizePlanningRepoRelativePath,
} from './path-utils.js';

const HELP = `
Usage:
  node dist/planning/context-tool.js status <pack.json> [--json]

Notes:
  The tool is internal to planning/execution workflows.
  \`status\` is read-only: it reports the canonical handoff state for a pack path.
`.trim();

function findNearestOmxRoot(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, '.omx'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveWorkspaceRootForPack(cwd: string): string {
  const ancestorOmxRoot = findNearestOmxRoot(cwd);
  return ancestorOmxRoot ? resolve(ancestorOmxRoot) : resolve(cwd);
}

function resolvePackPathFromWorkspaceRoot(workspaceRoot: string, rawPath: string): string {
  if (isAbsolute(rawPath)) {
    if (!isCanonicalContextPackPath(rawPath)) {
      throw new Error('Context pack path must be .omx/context/context-<timestamp>-<slug>.json.');
    }
    return resolve(rawPath);
  }

  const normalizedPath = normalizePlanningRepoRelativePath(rawPath);
  const slashNormalizedRawPath = rawPath.trim().replace(/^`|`$/g, '').replace(/\\/g, '/');
  const canonicalRawPath = slashNormalizedRawPath.startsWith('./')
    ? slashNormalizedRawPath.slice(2)
    : slashNormalizedRawPath;
  if (
    normalizedPath !== canonicalRawPath
    || normalizedPath === null
    || !isCanonicalContextPackPath(normalizedPath)
  ) {
    throw new Error('Context pack path must be .omx/context/context-<timestamp>-<slug>.json.');
  }
  return join(workspaceRoot, normalizedPath);
}

function buildStatusText(status: ReturnType<typeof readContextPackHandoffStatus>): string {
  const lines = [
    'Context pack status:',
    `- pack: ${status.packPath}`,
    `- slug: ${status.slug ?? '(unknown)'}`,
    `- handoff: ${status.handoffState}`,
    `- baseline: ${status.baselineState}`,
    `- outcome: ${status.outcomeState}`,
    `- pack-state: ${status.packState}`,
    `- roles: ${status.roleCoverage}`,
    `- basis: ${status.basisState}`,
  ];
  if (status.prdPath) {
    lines.push(`- prd: ${status.prdPath}`);
  }
  if (status.declaredPackPath) {
    lines.push(`- declared-pack: ${status.declaredPackPath}`);
  }
  lines.push(`- test-specs: ${status.testSpecPaths.length}`);
  if (status.missingRequiredContextPackRoles.length > 0) {
    lines.push(`- missing roles: ${status.missingRequiredContextPackRoles.join(', ')}`);
  }
  if (status.issues.length > 0) {
    lines.push('- issues:');
    for (const issue of status.issues) {
      lines.push(`  - ${issue}`);
    }
  }
  return lines.join('\n');
}

async function runStatus(cwd: string, args: readonly string[]): Promise<void> {
  const [rawPackPath, ...rest] = args;
  if (!rawPackPath) {
    throw new Error('status requires <pack.json>.');
  }
  const json = rest.includes('--json');
  const unknown = rest.find((token) => token !== '--json');
  if (unknown) {
    throw new Error(`Unknown status option: ${unknown}`);
  }

  const workspaceRoot = resolveWorkspaceRootForPack(cwd);
  const packPath = resolvePackPathFromWorkspaceRoot(workspaceRoot, rawPackPath);
  const repoRoot = resolveContextPackRepoRoot(packPath, workspaceRoot);
  const status = readContextPackHandoffStatus(repoRoot, packPath);
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(buildStatusText(status));
}

export async function contextToolMain(
  args: readonly string[],
  cwd: string = process.cwd(),
): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP);
    return;
  }

  switch (command) {
    case 'status':
      await runStatus(cwd, rest);
      return;
    default:
      throw new Error(`Unknown context-tool command: ${command}`);
  }
}

const isEntrypoint = (() => {
  const currentPath = fileURLToPath(import.meta.url);
  const invokedPath = process.argv[1];
  return typeof invokedPath === 'string' && currentPath === invokedPath;
})();

if (isEntrypoint) {
  contextToolMain(process.argv.slice(2)).catch((error) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
