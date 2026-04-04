import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { appendFile, mkdir, readFile } from 'fs/promises';
import { join, resolve } from 'path';

import { codexHome } from '../utils/paths.js';

const WORKSPACE_INDEX_RELATIVE_PATH = join('workspaces', 'index.json');
const SHARED_GUIDE_RELATIVE_PATHS = [
  ['company', join('instructions', 'company', 'GUIDE.md')],
  ['user', join('instructions', 'user', 'GUIDE.md')],
  ['local', join('instructions', 'local', 'GUIDE.md')],
] as const;

export interface StrictMemoryConfig {
  strictMode: boolean;
  memoryRoot: string;
}

export interface FormalMemoryContext {
  source: 'formal-memory';
  strictMode: boolean;
  memoryRoot: string;
  workspace: {
    registered: boolean;
    key?: string;
    root?: string;
    memoryHome?: string;
  };
  repoGuide: string;
  workspaceMemory: string;
  activeContext: string;
  sharedGuides: Record<string, string>;
}

function defaultExternalMemoryRoot(): string {
  return join(codexHome(), 'memory');
}

function normalizeLookupPath(value: string): string {
  return resolve(value).replace(/\\/g, '/').toLowerCase();
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

function summarizeSnippet(value: string, maxChars = 240): string {
  const normalized = value
    .replace(/^#+\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

export function parseBooleanFlag(value: unknown): boolean | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

export function resolveStrictMemoryConfig(
  env: Record<string, string | undefined> = process.env,
): StrictMemoryConfig {
  return {
    strictMode: parseBooleanFlag(env.OMX_STRICT_MEMORY_MODE) ?? false,
    memoryRoot: resolve(env.OMX_EXTERNAL_MEMORY_ROOT || defaultExternalMemoryRoot()),
  };
}

export async function loadWorkspaceIndex(memoryRoot: string): Promise<Record<string, unknown> | null> {
  const indexPath = join(memoryRoot, WORKSPACE_INDEX_RELATIVE_PATH);
  if (!existsSync(indexPath)) return null;
  return JSON.parse(await readFile(indexPath, 'utf-8')) as Record<string, unknown>;
}

export async function resolveFormalWorkspaceNode(
  cwd: string,
  memoryRoot: string,
): Promise<{ key: string; root: string; memoryHome: string } | null> {
  const index = await loadWorkspaceIndex(memoryRoot);
  const workspaces = index?.workspaces as Record<string, { key?: string; path?: string }> | undefined;
  if (!workspaces || typeof workspaces !== 'object') return null;

  const lookupCwd = normalizeLookupPath(cwd);
  let bestMatch: { key: string; root: string; memoryHome: string; lookupPath: string } | null = null;

  for (const [storedPath, entry] of Object.entries(workspaces)) {
    if (!entry || typeof entry !== 'object' || typeof entry.key !== 'string') continue;
    const registeredPath = typeof entry.path === 'string' ? entry.path : storedPath;
    const candidatePath = normalizeLookupPath(registeredPath);
    if (lookupCwd !== candidatePath && !lookupCwd.startsWith(`${candidatePath}/`)) {
      continue;
    }

    if (!bestMatch || candidatePath.length > bestMatch.lookupPath.length) {
      bestMatch = {
        key: entry.key,
        root: resolve(registeredPath),
        memoryHome: join(memoryRoot, 'workspaces', entry.key),
        lookupPath: candidatePath,
      };
    }
  }

  if (!bestMatch) return null;
  return {
    key: bestMatch.key,
    root: bestMatch.root,
    memoryHome: bestMatch.memoryHome,
  };
}

export async function readFormalMemoryContext(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<FormalMemoryContext> {
  const config = resolveStrictMemoryConfig(env);
  const workspace = await resolveFormalWorkspaceNode(cwd, config.memoryRoot);
  const sharedGuides = Object.fromEntries(
    await Promise.all(
      SHARED_GUIDE_RELATIVE_PATHS.map(async ([key, relativePath]) => [
        key,
        await readTextIfExists(join(config.memoryRoot, relativePath)),
      ]),
    ),
  );

  if (!workspace) {
    return {
      source: 'formal-memory',
      strictMode: config.strictMode,
      memoryRoot: config.memoryRoot,
      workspace: {
        registered: false,
      },
      repoGuide: '',
      workspaceMemory: '',
      activeContext: '',
      sharedGuides,
    };
  }

  const repoGuidePath = join(workspace.memoryHome, 'instructions', 'repo', 'GUIDE.md');
  const workspaceMemoryPath = join(workspace.memoryHome, 'memories', 'MEMORY.md');
  const activeContextPath = join(workspace.memoryHome, 'runtime', 'active_context.md');

  const [repoGuide, workspaceMemory, activeContext] = await Promise.all([
    readTextIfExists(repoGuidePath),
    readTextIfExists(workspaceMemoryPath),
    readTextIfExists(activeContextPath),
  ]);

  return {
    source: 'formal-memory',
    strictMode: config.strictMode,
    memoryRoot: config.memoryRoot,
    workspace: {
      registered: true,
      key: workspace.key,
      root: workspace.root,
      memoryHome: workspace.memoryHome,
    },
    repoGuide,
    workspaceMemory,
    activeContext,
    sharedGuides,
  };
}

export function buildFormalProjectMemorySummary(context: FormalMemoryContext): string {
  const parts: string[] = [];

  if (context.activeContext) {
    parts.push(`- Active Context: ${summarizeSnippet(context.activeContext)}`);
  }
  if (context.workspaceMemory) {
    parts.push(`- Workspace Memory: ${summarizeSnippet(context.workspaceMemory)}`);
  }
  if (context.repoGuide) {
    parts.push(`- Repo Guide: ${summarizeSnippet(context.repoGuide)}`);
  }

  if (parts.length === 0) {
    for (const [key, value] of Object.entries(context.sharedGuides)) {
      if (!value) continue;
      parts.push(`- Shared Guide (${key}): ${summarizeSnippet(value)}`);
    }
  }

  return parts.join('\n');
}

export function buildFormalProjectMemoryView(
  context: FormalMemoryContext,
  section?: string,
): Record<string, unknown> {
  const view = {
    source: 'formal-memory',
    strictMode: context.strictMode,
    workspace: context.workspace,
    summary: buildFormalProjectMemorySummary(context),
    sections: {
      activeContext: context.activeContext,
      workspaceMemory: context.workspaceMemory,
      repoGuide: context.repoGuide,
      sharedGuides: context.sharedGuides,
    },
  };

  if (section && section !== 'all') {
    return {
      ...view,
      requestedSection: section,
      message:
        'Strict integration mode exposes a formal summary view instead of legacy .omx/project-memory.json sections.',
    };
  }

  return view;
}

function buildIntakeEntryId(payload: Record<string, unknown>): string {
  const hash = createHash('sha1')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 12);
  return `intake-${hash}`;
}

export async function appendMemoryIntakeEntry({
  cwd,
  kind,
  content,
  metadata = {},
  source,
}: {
  cwd: string;
  kind: string;
  content: string;
  metadata?: Record<string, unknown>;
  source: string;
}): Promise<{ path: string; entry: Record<string, unknown> }> {
  const createdAt = new Date().toISOString();
  const entry = {
    id: buildIntakeEntryId({
      kind,
      content,
      metadata,
      source,
      createdAt,
    }),
    kind,
    content,
    metadata,
    source,
    created_at: createdAt,
  };
  const intakePath = join(cwd, '.omx', 'memory-intake.jsonl');
  await mkdir(join(cwd, '.omx'), { recursive: true });
  await appendFile(intakePath, `${JSON.stringify(entry)}\n`, 'utf-8');
  return {
    path: intakePath,
    entry,
  };
}
