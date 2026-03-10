import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile, copyFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { getPackageRoot } from '../utils/package.js';
import { readSessionState, isSessionStale } from '../hooks/session.js';

export const AGENTS_INIT_USAGE = [
  'Usage: omx agents-init [path] [--dry-run] [--force] [--verbose]',
  '       omx deepinit [path] [--dry-run] [--force] [--verbose]',
  '',
  'Bootstrap lightweight AGENTS.md files for the target directory and its direct child directories.',
  '',
  'Options:',
  '  --dry-run   Show planned file updates without writing files',
  '  --force     Overwrite existing unmanaged AGENTS.md files after taking a backup',
  '  --verbose   Print per-file actions and skip reasons',
  '  --help      Show this message',
].join('\n');

const MANAGED_MARKER = '<!-- OMX:AGENTS-INIT:MANAGED -->';
const MANUAL_START = '<!-- OMX:AGENTS-INIT:MANUAL:START -->';
const MANUAL_END = '<!-- OMX:AGENTS-INIT:MANUAL:END -->';
const DEFAULT_LIST_LIMIT = 12;
const IGNORE_DIRECTORY_NAMES = new Set([
  '.git',
  '.omx',
  '.codex',
  '.agents',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '__pycache__',
  'vendor',
  'target',
  'tmp',
  'temp',
]);

interface AgentsInitOptions {
  dryRun?: boolean;
  force?: boolean;
  verbose?: boolean;
  targetPath?: string;
}

interface AgentsInitSummary {
  updated: number;
  unchanged: number;
  skipped: number;
  backedUp: number;
}

interface ManagedFileDecision {
  action: 'updated' | 'unchanged' | 'skipped';
  reason?: string;
  backedUp: boolean;
}

interface DirectorySnapshot {
  files: string[];
  directories: string[];
}

function createEmptySummary(): AgentsInitSummary {
  return {
    updated: 0,
    unchanged: 0,
    skipped: 0,
    backedUp: 0,
  };
}

function isManagedAgentsInitFile(content: string): boolean {
  return content.includes(MANAGED_MARKER);
}

function extractManualSection(existingContent: string | undefined, fallbackBody: string): string {
  if (!existingContent) return fallbackBody.trim();
  const start = existingContent.indexOf(MANUAL_START);
  const end = existingContent.indexOf(MANUAL_END);
  if (start === -1 || end === -1 || end < start) return fallbackBody.trim();
  return existingContent.slice(start + MANUAL_START.length, end).trim() || fallbackBody.trim();
}

function wrapManagedContent(body: string, manualBody: string): string {
  return `${MANAGED_MARKER}\n${body.trimEnd()}\n\n${MANUAL_START}\n${manualBody.trim()}\n${MANUAL_END}\n`;
}

export function applyProjectScopePathRewritesToAgentsTemplate(content: string): string {
  return content
    .replaceAll('~/.codex', './.codex')
    .replaceAll('~/.agents', './.agents');
}

async function readProjectRootTemplate(): Promise<string> {
  const pkgRoot = getPackageRoot();
  const templatePath = join(pkgRoot, 'templates', 'AGENTS.md');
  return readFile(templatePath, 'utf-8');
}

export async function renderManagedProjectRootAgents(existingContent?: string): Promise<string> {
  const template = applyProjectScopePathRewritesToAgentsTemplate(await readProjectRootTemplate());
  const manual = extractManualSection(existingContent, `## Local Notes\n- Add repo-specific architecture notes, workflow conventions, and verification commands here.\n- This block is preserved by \`omx agents-init\` refreshes.`);
  return wrapManagedContent(template, manual);
}

function formatList(items: string[], suffix = '', limit = DEFAULT_LIST_LIMIT): string[] {
  if (items.length === 0) return ['- None'];
  const visible = items.slice(0, limit).map((item) => `- \`${item}${suffix}\``);
  if (items.length > limit) {
    visible.push(`- ...and ${items.length - limit} more`);
  }
  return visible;
}

async function snapshotDirectory(dir: string): Promise<DirectorySnapshot> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  const directories: string[] = [];

  for (const entry of entries) {
    if (entry.name === 'AGENTS.md') continue;
    if (entry.isDirectory()) {
      if (IGNORE_DIRECTORY_NAMES.has(entry.name)) continue;
      directories.push(entry.name);
      continue;
    }
    if (entry.isFile()) {
      files.push(entry.name);
    }
  }

  files.sort((a, b) => a.localeCompare(b));
  directories.sort((a, b) => a.localeCompare(b));
  return { files, directories };
}

function renderParentReference(dir: string, assumeParentAgents = false): string {
  const parentAgentsPath = join(dirname(dir), 'AGENTS.md');
  if (!assumeParentAgents && !existsSync(parentAgentsPath)) return '';
  const relativePath = relative(dir, parentAgentsPath).replaceAll('\\', '/');
  return `<!-- Parent: ${relativePath} -->\n`;
}

export async function renderManagedDirectoryAgents(
  dir: string,
  existingContent?: string,
  assumeParentAgents = false,
): Promise<string> {
  const snapshot = await snapshotDirectory(dir);
  const manual = extractManualSection(existingContent, `## Local Notes\n- Add subtree-specific constraints, ownership notes, and test commands here.\n- Keep notes scoped to this directory and its children.`);
  const title = basename(dir);
  const relativeDir = relative(process.cwd(), dir).replaceAll('\\', '/') || '.';
  const parentReference = renderParentReference(dir, assumeParentAgents);
  const body = `${parentReference}# ${title}\n\nThis AGENTS.md scopes guidance to \`${relativeDir}\`. Parent AGENTS guidance still applies unless this file narrows it for this subtree.\n\n## Bootstrap Guardrails\n- This is a lightweight scaffold generated by \`omx agents-init\`.\n- Refresh updates the layout summary below and preserves the manual notes block.\n- Keep only directory-specific guidance here; do not duplicate the root orchestration brain.\n\n## Current Layout\n\n### Files\n${formatList(snapshot.files).join('\n')}\n\n### Subdirectories\n${formatList(snapshot.directories, '/').join('\n')}`;
  return wrapManagedContent(body, manual);
}

async function ensureBackup(destinationPath: string, backupRoot: string, dryRun: boolean): Promise<boolean> {
  if (!existsSync(destinationPath)) return false;
  const relativePath = relative(process.cwd(), destinationPath);
  const safeRelativePath = relativePath.startsWith('..') || relativePath === ''
    ? destinationPath.replace(/^[/]+/, '')
    : relativePath;
  const backupPath = join(backupRoot, safeRelativePath);
  if (!dryRun) {
    await mkdir(dirname(backupPath), { recursive: true });
    await copyFile(destinationPath, backupPath);
  }
  return true;
}

function resolveTargetDirectories(targetDir: string): Promise<string[]> {
  return readdir(targetDir, { withFileTypes: true }).then((entries) => {
    const childDirs = entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !IGNORE_DIRECTORY_NAMES.has(entry.name))
      .map((entry) => join(targetDir, entry.name))
      .sort((a, b) => a.localeCompare(b));
    return [targetDir, ...childDirs];
  });
}

async function syncManagedAgentsFile(
  destinationPath: string,
  content: string,
  options: Required<Pick<AgentsInitOptions, 'dryRun' | 'force' | 'verbose'>>,
  summary: AgentsInitSummary,
  backupRoot: string,
  skipReason?: string,
): Promise<ManagedFileDecision> {
  const destinationExists = existsSync(destinationPath);
  const existingContent = destinationExists ? await readFile(destinationPath, 'utf-8') : undefined;

  if (skipReason) {
    summary.skipped += 1;
    return { action: 'skipped', reason: skipReason, backedUp: false };
  }

  if (!destinationExists) {
    if (!options.dryRun) {
      await mkdir(dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, content);
    }
    summary.updated += 1;
    return { action: 'updated', backedUp: false };
  }

  if (existingContent === content) {
    summary.unchanged += 1;
    return { action: 'unchanged', backedUp: false };
  }

  if (!isManagedAgentsInitFile(existingContent ?? '') && !options.force) {
    summary.skipped += 1;
    return {
      action: 'skipped',
      reason: 'existing unmanaged AGENTS.md (re-run with --force to adopt it)',
      backedUp: false,
    };
  }

  const backedUp = await ensureBackup(destinationPath, backupRoot, options.dryRun);
  if (backedUp) summary.backedUp += 1;

  if (!options.dryRun) {
    await mkdir(dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, content);
  }
  summary.updated += 1;
  return { action: 'updated', backedUp };
}

export async function agentsInit(options: AgentsInitOptions = {}): Promise<void> {
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const verbose = options.verbose === true;
  const cwd = process.cwd();
  const requestedTarget = options.targetPath ?? '.';
  const targetDir = resolve(cwd, requestedTarget);
  const relativeTarget = relative(cwd, targetDir);

  if (relativeTarget.startsWith('..')) {
    throw new Error(`agents-init target must stay inside the current working directory: ${requestedTarget}`);
  }

  const targetStat = await stat(targetDir).catch(() => null);
  if (!targetStat) throw new Error(`agents-init target not found: ${requestedTarget}`);
  if (!targetStat.isDirectory()) throw new Error(`agents-init target must be a directory: ${requestedTarget}`);

  const summary = createEmptySummary();
  const plannedDirs = await resolveTargetDirectories(targetDir);
  const backupRoot = join(cwd, '.omx', 'backups', 'agents-init', new Date().toISOString().replaceAll(':', '-'));
  const activeSession = await readSessionState(cwd);
  const rootSessionGuardActive = Boolean(activeSession && !isSessionStale(activeSession));

  console.log('oh-my-codex AGENTS bootstrap');
  console.log('===========================\n');
  console.log(`Target: ${requestedTarget}`);
  console.log(`Scope: target directory + ${Math.max(plannedDirs.length - 1, 0)} direct child director${plannedDirs.length === 2 ? 'y' : 'ies'}\n`);

  for (let index = 0; index < plannedDirs.length; index += 1) {
    const dir = plannedDirs[index];
    const destinationPath = join(dir, 'AGENTS.md');
    const existingContent = existsSync(destinationPath)
      ? await readFile(destinationPath, 'utf-8')
      : undefined;
    const isRootTarget = index === 0;
    const relativeDir = relative(cwd, dir).replaceAll('\\', '/') || '.';

    const content = isRootTarget && targetDir === cwd
      ? await renderManagedProjectRootAgents(existingContent)
      : await renderManagedDirectoryAgents(dir, existingContent, dirname(dir) === targetDir);

    const rootOverlayRisk = rootSessionGuardActive
      && dir === cwd
      && existsSync(destinationPath)
      && existingContent !== content;

    const decision = await syncManagedAgentsFile(
      destinationPath,
      content,
      { dryRun, force, verbose },
      summary,
      backupRoot,
      rootOverlayRisk ? 'active omx session detected for project root AGENTS.md' : undefined,
    );

    if (verbose || decision.action !== 'unchanged') {
      const label = decision.action === 'updated'
        ? (dryRun ? 'would update' : 'updated')
        : decision.action === 'unchanged'
          ? 'unchanged'
          : 'skipped';
      const reason = decision.reason ? ` (${decision.reason})` : '';
      console.log(`  ${label} ${relativeDir}/AGENTS.md${reason}`);
    }
  }

  console.log('\nGuardrails:');
  console.log('- Generates the target directory and its direct child directories only.');
  console.log('- Skips generated/vendor/build directories via a fixed exclusion list.');
  console.log('- Preserves manual notes only for files already managed by omx agents-init.');
  console.log('- Never overwrites unmanaged AGENTS.md files unless you pass --force.');
  console.log('- Avoids rewriting project-root AGENTS.md while an active omx session is running.\n');

  console.log('Summary:');
  console.log(`  updated=${summary.updated}, unchanged=${summary.unchanged}, backed_up=${summary.backedUp}, skipped=${summary.skipped}`);
}

export async function agentsInitCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(AGENTS_INIT_USAGE);
    return;
  }

  const allowedFlags = new Set(['--dry-run', '--force', '--verbose']);
  for (const arg of args) {
    if (!arg.startsWith('-')) continue;
    if (!allowedFlags.has(arg)) {
      throw new Error(`Unknown agents-init option: ${arg}\n${AGENTS_INIT_USAGE}`);
    }
  }

  const positionals = args.filter((arg) => !arg.startsWith('-'));
  if (positionals.length > 1) {
    throw new Error(`agents-init accepts at most one path argument.\n${AGENTS_INIT_USAGE}`);
  }

  await agentsInit({
    targetPath: positionals[0],
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
    verbose: args.includes('--verbose'),
  });
}
