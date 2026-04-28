import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  buildContextPackBasis,
  CONTEXT_PACK_ROLES,
  describeContextPackBasisResolutionIssues,
  filterContextPackEntries,
  findMissingContextPackRoles,
  formatRelationPath,
  materializeContextPackRefs,
  normalizeContextPackCompactToken,
  normalizeContextPackLabel,
  normalizeContextPackSourcePath,
  readContextPackDocument,
  REQUIRED_CONTEXT_PACK_ROLES,
  resolveContextPackRepoRoot,
  upsertContextPackEntries,
  validateContextPackManifest,
  writeContextPackDocument,
  type ContextPackRelationStep,
  type ContextPackSelector,
  type ContextPackRole,
} from './context-packs.js';
import { isCanonicalContextPackPath, normalizePlanningRepoRelativePath } from './path-utils.js';
import { readContextPackHandoffStatus, type ContextPackHandoffStatusSnapshot } from './artifacts.js';

const HELP = `
Usage:
  node dist/planning/context-tool.js add <pack.json> <repo/path> [--label <label>] [--role <role>]... [--tag <tag>]... [--heading <heading>] [--max-words <n>] [--lines <start:end>] [--relation <tag>:<target>] [--json]
  node dist/planning/context-tool.js sync <pack.json> [--json]
  node dist/planning/context-tool.js status <pack.json> [--json]
  node dist/planning/context-tool.js query <pack.json> [--role <role>]... [--path <repo/path>]... [--tag <tag>]... [--label <label>]... [--json]
  node dist/planning/context-tool.js view <pack.json> [--role <role>]... [--path <repo/path>]... [--tag <tag>]... [--label <label>]... [--json]

Notes:
  The tool is internal to planning/execution workflows. It generates canonical JSON packs and a markdown index sibling.
  \`add\` creates the pack when absent and infers defaults for omitted label/relation-path data. When no role is supplied, it defaults to \`build\`.
  \`sync\` is the handoff-ready check: it refreshes the pack index and approved PRD/test-spec basis after the approved handoff files exist, and it fails until the pack covers \`scope\`, \`build\`, and \`verify\`.
  \`status\` is read-only: it reports the canonical lifecycle handoff state without refreshing basis, indexes, or excerpts.
  The markdown sibling is tool-generated scaffold. If planners add concise notes in its \`View Notes\` block, later tool writes preserve that block.
  \`query\` returns matching normalized refs without materializing excerpt files.
  \`view\` materializes matching entries into excerpts or direct file refs using the pack's selectors, roles, and tags.
`.trim();

interface ParsedAddArgs {
  packPath: string;
  sourcePath: string;
  label?: string;
  roles: ContextPackRole[];
  tags: string[];
  selector?: ContextPackSelector;
  relationPath?: ContextPackRelationStep[];
  json: boolean;
}

interface ParsedViewArgs {
  packPath: string;
  roles: ContextPackRole[];
  paths: string[];
  tags: string[];
  labels: string[];
  json: boolean;
}

function readGitWorkspaceRoot(cwd: string): string | null {
  try {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return repoRoot || null;
  } catch {
    return null;
  }
}

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

function relativePathExists(root: string, rawPath: string | undefined): boolean {
  if (!rawPath || isAbsolute(rawPath)) {
    return false;
  }
  return existsSync(join(root, rawPath));
}

function resolvePackPathFromWorkspaceRoot(workspaceRoot: string, rawPath: string): string {
  if (isAbsolute(rawPath)) {
    if (!isCanonicalContextPackPath(rawPath)) {
      throw new Error('Context pack path must be .omx/context/context-<timestamp>-<slug>.json.');
    }
    return rawPath;
  }

  const normalizedPath = normalizePlanningRepoRelativePath(rawPath);
  const slashNormalizedRawPath = rawPath.trim().replace(/^`|`$/g, '').replace(/\\/g, '/');
  const canonicalRawPath = slashNormalizedRawPath.startsWith('./')
    ? slashNormalizedRawPath.slice(2)
    : slashNormalizedRawPath;
  if (normalizedPath !== canonicalRawPath || !isCanonicalContextPackPath(normalizedPath)) {
    throw new Error('Context pack path must be .omx/context/context-<timestamp>-<slug>.json.');
  }
  return join(workspaceRoot, normalizedPath);
}

function resolveWorkspaceRootForAdd(cwd: string, rawSourcePath: string): string {
  const gitRoot = readGitWorkspaceRoot(cwd);
  if (gitRoot) {
    return resolve(gitRoot);
  }
  const ancestorOmxRoot = findNearestOmxRoot(cwd);
  const resolvedCwd = resolve(cwd);
  if (!ancestorOmxRoot) {
    return resolvedCwd;
  }
  if (ancestorOmxRoot === resolvedCwd) {
    return resolvedCwd;
  }
  if (relativePathExists(ancestorOmxRoot, rawSourcePath)) {
    return resolve(ancestorOmxRoot);
  }
  return resolvedCwd;
}

function resolveWorkspaceRootForPack(cwd: string, rawPackPath: string): string {
  const gitRoot = readGitWorkspaceRoot(cwd);
  if (gitRoot) {
    return resolve(gitRoot);
  }
  const ancestorOmxRoot = findNearestOmxRoot(cwd);
  const resolvedCwd = resolve(cwd);
  if (!ancestorOmxRoot) {
    return resolvedCwd;
  }
  if (ancestorOmxRoot === resolvedCwd) {
    return resolvedCwd;
  }
  if (relativePathExists(ancestorOmxRoot, rawPackPath)) {
    return resolve(ancestorOmxRoot);
  }
  return resolvedCwd;
}

function parseLinesRange(raw: string): { start: number; end: number } {
  const match = raw.match(/^(?<start>\d+):(?<end>\d+)$/);
  if (!match?.groups) {
    throw new Error(`Invalid line range "${raw}". Use start:end.`);
  }
  const start = Number.parseInt(match.groups.start, 10);
  const end = Number.parseInt(match.groups.end, 10);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new Error(`Invalid line range "${raw}". Use 1-based inclusive start:end.`);
  }
  return { start, end };
}

function parseRelation(raw: string): ContextPackRelationStep {
  const index = raw.indexOf(':');
  if (index <= 0 || index === raw.length - 1) {
    throw new Error(`Invalid relation "${raw}". Use tag:target.`);
  }
  return {
    tag: raw.slice(0, index),
    target: raw.slice(index + 1),
  };
}

function parseRole(raw: string): ContextPackRole {
  const normalized = raw.trim().toLowerCase();
  if (CONTEXT_PACK_ROLES.includes(normalized as ContextPackRole)) {
    return normalized as ContextPackRole;
  }
  throw new Error(`Invalid role "${raw}". Use one of: ${CONTEXT_PACK_ROLES.join(', ')}.`);
}

function parseAddArgs(args: readonly string[]): ParsedAddArgs {
  if (args.length < 2) {
    throw new Error('add requires <pack.json> and <repo/path>.');
  }

  const [packPath, sourcePath, ...rest] = args;
  const roles: ContextPackRole[] = [];
  const tags: string[] = [];
  const relations: ContextPackRelationStep[] = [];
  let label: string | undefined;
  let heading: string | undefined;
  let maxWords: number | undefined;
  let lines: { start: number; end: number } | undefined;
  let json = false;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === '--json') {
      json = true;
      continue;
    }
    const next = rest[index + 1];
    if (token === '--label') {
      if (!next) throw new Error('--label requires a value.');
      label = next;
      index += 1;
      continue;
    }
    if (token === '--role') {
      if (!next) throw new Error('--role requires a value.');
      roles.push(parseRole(next));
      index += 1;
      continue;
    }
    if (token === '--tag') {
      if (!next) throw new Error('--tag requires a value.');
      tags.push(next);
      index += 1;
      continue;
    }
    if (token === '--heading') {
      if (!next) throw new Error('--heading requires a value.');
      heading = next;
      index += 1;
      continue;
    }
    if (token === '--max-words') {
      if (!next) throw new Error('--max-words requires a value.');
      maxWords = Number.parseInt(next, 10);
      if (!Number.isInteger(maxWords)) {
        throw new Error(`Invalid max word count "${next}".`);
      }
      index += 1;
      continue;
    }
    if (token === '--lines') {
      if (!next) throw new Error('--lines requires a value.');
      lines = parseLinesRange(next);
      index += 1;
      continue;
    }
    if (token === '--relation') {
      if (!next) throw new Error('--relation requires a value.');
      relations.push(parseRelation(next));
      index += 1;
      continue;
    }
    throw new Error(`Unknown add option: ${token}`);
  }

  if (heading && lines) {
    throw new Error('Use either --heading or --lines, not both.');
  }
  if (maxWords != null && !heading) {
    throw new Error('--max-words only applies with --heading.');
  }

  const selector = heading
    ? {
      type: 'heading' as const,
      value: heading,
      ...(maxWords != null ? { maxWords } : {}),
    }
    : lines
      ? {
        type: 'lines' as const,
        start: lines.start,
        end: lines.end,
      }
      : undefined;

  return {
    packPath,
    sourcePath,
    label,
    roles,
    tags,
    selector,
    relationPath: relations.length > 0 ? relations : undefined,
    json,
  };
}

function parseFilterArgs(command: 'query' | 'view', args: readonly string[]): ParsedViewArgs {
  if (args.length < 1) {
    throw new Error(`${command} requires <pack.json>.`);
  }

  const [packPath, ...rest] = args;
  const roles: ContextPackRole[] = [];
  const paths: string[] = [];
  const tags: string[] = [];
  const labels: string[] = [];
  let json = false;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === '--json') {
      json = true;
      continue;
    }
    const next = rest[index + 1];
    if (token === '--role') {
      if (!next) throw new Error('--role requires a value.');
      roles.push(parseRole(next));
      index += 1;
      continue;
    }
    if (token === '--tag') {
      if (!next) throw new Error('--tag requires a value.');
      tags.push(normalizeContextPackCompactToken(next, 'Context pack tag filters must use compact values.'));
      index += 1;
      continue;
    }
    if (token === '--path') {
      if (!next) throw new Error('--path requires a value.');
      paths.push(normalizeContextPackSourcePath(next, 'Context pack path filters must use repo-relative paths.'));
      index += 1;
      continue;
    }
    if (token === '--label') {
      if (!next) throw new Error('--label requires a value.');
      labels.push(normalizeContextPackLabel(next, 'Context pack label filters must use compact values.'));
      index += 1;
      continue;
    }
    throw new Error(`Unknown ${command} option: ${token}`);
  }

  return {
    packPath,
    roles,
    paths,
    tags,
    labels,
    json,
  };
}

function buildAddText(result: ReturnType<typeof upsertContextPackEntries>): string {
  const lines = [
    'Context pack updated:',
    `- pack: ${result.packPath}`,
    `- index: ${result.indexPath}`,
    `- slug: ${result.slug}`,
  ];
  if (result.addedLabels.length > 0) {
    lines.push(`- added: ${result.addedLabels.join(', ')}`);
  }
  if (result.updatedLabels.length > 0) {
    lines.push(`- updated: ${result.updatedLabels.join(', ')}`);
  }
  return lines.join('\n');
}

function buildViewText(params: {
  packPath: string;
  slug: string;
  roles: readonly string[];
  paths: readonly string[];
  tags: readonly string[];
  labels: readonly string[];
  refs: ReturnType<typeof materializeContextPackRefs>['refs'];
}): string {
  const lines = [
    'Context pack view:',
    `- pack: ${params.packPath}`,
    `- slug: ${params.slug}`,
  ];
  if (params.roles.length > 0) {
    lines.push(`- roles: ${params.roles.join(', ')}`);
  }
  if (params.paths.length > 0) {
    lines.push(`- paths: ${params.paths.join(', ')}`);
  }
  if (params.tags.length > 0) {
    lines.push(`- tags: ${params.tags.join(', ')}`);
  }
  if (params.labels.length > 0) {
    lines.push(`- labels: ${params.labels.join(', ')}`);
  }
  for (const ref of params.refs) {
    const details = [ref.path, `label=${ref.label}`, `[${ref.delivery}]`];
    if (ref.tags.length > 0) {
      details.push(`tags=${ref.tags.join(', ')}`);
    }
    lines.push(`- ${details.join(' ')}`);
    lines.push(`  source: ${ref.sourcePath}`);
    lines.push(`  relation-path: ${formatRelationPath(ref.relationPath)}`);
  }
  return lines.join('\n');
}

function buildQueryText(params: {
  packPath: string;
  slug: string;
  roles: readonly string[];
  paths: readonly string[];
  tags: readonly string[];
  labels: readonly string[];
  entries: Array<{
    label: string;
    path: string;
    roles: string[];
    tags: string[];
    selector?: ContextPackSelector;
    relationPath: ContextPackRelationStep[];
  }>;
}): string {
  const lines = [
    'Context pack query:',
    `- pack: ${params.packPath}`,
    `- slug: ${params.slug}`,
  ];
  if (params.roles.length > 0) {
    lines.push(`- roles: ${params.roles.join(', ')}`);
  }
  if (params.paths.length > 0) {
    lines.push(`- paths: ${params.paths.join(', ')}`);
  }
  if (params.tags.length > 0) {
    lines.push(`- tags: ${params.tags.join(', ')}`);
  }
  if (params.labels.length > 0) {
    lines.push(`- labels: ${params.labels.join(', ')}`);
  }
  for (const entry of params.entries) {
    const details = [entry.path, `label=${entry.label}`, `roles=${entry.roles.join(', ')}`];
    if (entry.tags.length > 0) {
      details.push(`tags=${entry.tags.join(', ')}`);
    }
    lines.push(`- ${details.join(' ')}`);
    if (entry.selector) {
      lines.push(`  selector: ${entry.selector.type === 'heading' ? entry.selector.value : `${entry.selector.start}-${entry.selector.end}`}`);
    }
    lines.push(`  relation-path: ${formatRelationPath(entry.relationPath)}`);
  }
  return lines.join('\n');
}

function ensurePackExists(packPath: string): void {
  if (!existsSync(packPath)) {
    throw new Error(`Context pack not found: ${packPath}`);
  }
}

function buildSyncText(params: {
  packPath: string;
  indexPath: string;
  slug: string;
  basisCount: number;
}): string {
  return [
    'Context pack synced:',
    `- pack: ${params.packPath}`,
    `- index: ${params.indexPath}`,
    `- slug: ${params.slug}`,
    `- basis objects: ${params.basisCount}`,
  ].join('\n');
}

function buildStatusText(status: ContextPackHandoffStatusSnapshot): string {
  const lines = [
    'Context pack status:',
    `- pack: ${status.packPath}`,
    `- index: ${status.indexPath}`,
    `- slug: ${status.slug ?? '(unknown)'}`,
    `- handoff: ${status.handoffState}`,
    `- baseline: ${status.baselineState}`,
    `- outcome: ${status.outcomeState}`,
    `- pack-state: ${status.packState}`,
    `- roles: ${status.roleCoverage}`,
    `- basis: ${status.basisState}`,
    `- generated-index: ${status.indexState}`,
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

async function runAdd(cwd: string, args: readonly string[]): Promise<void> {
  const parsed = parseAddArgs(args);
  const workspaceRoot = resolveWorkspaceRootForAdd(cwd, parsed.sourcePath);
  const packPath = resolvePackPathFromWorkspaceRoot(workspaceRoot, parsed.packPath);
  const repoRoot = resolveContextPackRepoRoot(packPath, workspaceRoot);
  const result = upsertContextPackEntries(
    packPath,
    [{
      path: parsed.sourcePath,
      ...(parsed.label ? { label: parsed.label } : {}),
      ...(parsed.roles.length > 0 ? { roles: parsed.roles } : {}),
      ...(parsed.tags.length > 0 ? { tags: parsed.tags } : {}),
      ...(parsed.selector ? { selector: parsed.selector } : {}),
      ...(parsed.relationPath ? { relationPath: parsed.relationPath } : {}),
    }],
    { repoRoot, refreshBasis: true },
  );

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(buildAddText(result));
}

async function runSync(cwd: string, args: readonly string[]): Promise<void> {
  const [rawPackPath, ...rest] = args;
  if (!rawPackPath) {
    throw new Error('sync requires <pack.json>.');
  }
  const json = rest.includes('--json');
  const unknown = rest.find((token) => token !== '--json');
  if (unknown) {
    throw new Error(`Unknown sync option: ${unknown}`);
  }

  const workspaceRoot = resolveWorkspaceRootForPack(cwd, rawPackPath);
  const packPath = resolvePackPathFromWorkspaceRoot(workspaceRoot, rawPackPath);
  ensurePackExists(packPath);
  const document = readContextPackDocument(packPath);
  if (!document) {
    throw new Error(`Could not read context pack: ${packPath}`);
  }
  const repoRoot = resolveContextPackRepoRoot(packPath, workspaceRoot);
  const basis = buildContextPackBasis(repoRoot, document.slug);
  if (!basis) {
    const basisIssues = describeContextPackBasisResolutionIssues(repoRoot, document.slug);
    throw new Error(
      basisIssues.length > 0
        ? `Could not resolve approved PRD/test-spec basis for slug ${document.slug}. ${basisIssues.join(' ')}`
        : `Could not resolve approved PRD/test-spec basis for slug ${document.slug}. Save the approved prd-* and matching test-spec-* files first.`,
    );
  }
  const missingRoles = findMissingContextPackRoles(document, REQUIRED_CONTEXT_PACK_ROLES);
  if (missingRoles.length > 0) {
    throw new Error(`Context pack is not handoff-ready: missing required roles ${missingRoles.join(', ')}.`);
  }
  const synced = writeContextPackDocument(packPath, document, { repoRoot, refreshBasis: true });
  const validationIssues = validateContextPackManifest({
    packPath,
    expectedSlug: synced.slug,
    repoRoot,
    requireFreshBasis: true,
    requireGeneratedIndex: true,
  });
  if (validationIssues.length > 0) {
    throw new Error(`Context pack is not handoff-ready: ${validationIssues.join(' | ')}`);
  }
  const result = {
    packPath,
    indexPath: packPath.replace(/\.json$/i, '.md'),
    slug: synced.slug,
    basis: synced.basis,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(buildSyncText({
    packPath: result.packPath,
    indexPath: result.indexPath,
    slug: result.slug,
    basisCount: 1 + (result.basis?.testSpecs.length ?? 0),
  }));
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

  const workspaceRoot = resolveWorkspaceRootForPack(cwd, rawPackPath);
  const packPath = resolvePackPathFromWorkspaceRoot(workspaceRoot, rawPackPath);
  const repoRoot = resolveContextPackRepoRoot(packPath, workspaceRoot);
  const status = readContextPackHandoffStatus(repoRoot, packPath);
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(buildStatusText(status));
}

async function runView(cwd: string, args: readonly string[]): Promise<void> {
  const parsed = parseFilterArgs('view', args);
  const workspaceRoot = resolveWorkspaceRootForPack(cwd, parsed.packPath);
  const packPath = resolvePackPathFromWorkspaceRoot(workspaceRoot, parsed.packPath);
  ensurePackExists(packPath);
  const document = readContextPackDocument(packPath);
  if (!document) {
      throw new Error(`Could not read context pack: ${packPath}`);
  }
  const repoRoot = resolveContextPackRepoRoot(packPath, workspaceRoot);

  const resolution = materializeContextPackRefs({
    packPath,
    expectedSlug: document.slug,
    repoRoot,
    ...(parsed.roles.length > 0 ? { roles: parsed.roles } : {}),
    ...(parsed.paths.length > 0 ? { paths: parsed.paths } : {}),
    ...(parsed.tags.length > 0 ? { tags: parsed.tags } : {}),
    ...(parsed.labels.length > 0 ? { labels: parsed.labels } : {}),
  });
  if (resolution.issues.length > 0) {
    throw new Error(resolution.issues.join(' | '));
  }

  if (parsed.json) {
    console.log(JSON.stringify({
      packPath,
      slug: document.slug,
      roles: parsed.roles,
      paths: parsed.paths,
      tags: parsed.tags,
      labels: parsed.labels,
      refs: resolution.refs,
    }, null, 2));
    return;
  }

  console.log(buildViewText({
    packPath,
    slug: document.slug,
    roles: parsed.roles,
    paths: parsed.paths,
    tags: parsed.tags,
    labels: parsed.labels,
    refs: resolution.refs,
  }));
}

async function runQuery(cwd: string, args: readonly string[]): Promise<void> {
  const parsed = parseFilterArgs('query', args);
  const workspaceRoot = resolveWorkspaceRootForPack(cwd, parsed.packPath);
  const packPath = resolvePackPathFromWorkspaceRoot(workspaceRoot, parsed.packPath);
  ensurePackExists(packPath);
  const document = readContextPackDocument(packPath);
  if (!document) {
    throw new Error(`Could not read context pack: ${packPath}`);
  }

  const entries = filterContextPackEntries(document, {
    roles: parsed.roles,
    paths: parsed.paths,
    labels: parsed.labels,
    tags: parsed.tags,
  });

  if (parsed.json) {
    console.log(JSON.stringify({
      packPath,
      slug: document.slug,
      roles: parsed.roles,
      paths: parsed.paths,
      tags: parsed.tags,
      labels: parsed.labels,
      entries,
    }, null, 2));
    return;
  }

  console.log(buildQueryText({
    packPath,
    slug: document.slug,
    roles: parsed.roles,
    paths: parsed.paths,
    tags: parsed.tags,
    labels: parsed.labels,
    entries,
  }));
}

export async function contextToolMain(args: readonly string[], cwd: string = process.cwd()): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP);
    return;
  }

  switch (command) {
    case 'add':
      await runAdd(cwd, rest);
      return;
    case 'sync':
      await runSync(cwd, rest);
      return;
    case 'status':
      await runStatus(cwd, rest);
      return;
    case 'query':
      await runQuery(cwd, rest);
      return;
    case 'view':
      await runView(cwd, rest);
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
