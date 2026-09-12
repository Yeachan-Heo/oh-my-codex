#!/usr/bin/env node
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface PromptSurfaceInventory {
  path: string;
  lines: number;
  approximateTokens: number;
  absoluteDirectiveCount: number;
  markers: Record<string, number>;
}

export interface DuplicateFragmentFamily {
  text: string;
  count: number;
  paths: string[];
}

export type PromptInvariantRuleId = 'cancel-semantics' | 'state-ownership' | 'hook-boundaries' | 'team-protocol';

export interface PromptInvariantPhraseRule {
  id: PromptInvariantRuleId;
  phrase: string;
  pattern: RegExp;
}

export interface PromptInvariantDuplicate {
  ruleId: PromptInvariantRuleId;
  phrase: string;
  paths: string[];
}

export interface PromptInvariantCheckReport {
  root: string;
  checkedPaths: string[];
  duplicates: PromptInvariantDuplicate[];
  ok: boolean;
}

export interface SizeTotals {
  files: number;
  physicalLines: number;
  bytes: number;
}

export interface RepositorySizeInventory {
  schemaVersion: 1;
  groups: Record<'nonTestSource' | 'testSource' | 'rustSourceIncludingTests' | 'skillCards' | 'agentPrompts' | 'agentTemplate', SizeTotals>;
  largestNonTestFiles: Array<{ path: string; physicalLines: number; bytes: number }>;
}

export interface PromptInventoryReport {
  repositorySize: RepositorySizeInventory;
  generatedAt: string;
  root: string;
  totals: {
    files: number;
    lines: number;
    approximateTokens: number;
    absoluteDirectiveCount: number;
  };
  surfaces: PromptSurfaceInventory[];
  duplicateFragmentFamilies: DuplicateFragmentFamily[];
}

const PROMPT_SURFACE_FILES = [
  'AGENTS.md',
  'templates/AGENTS.md',
  'docs/prompt-guidance-contract.md',
  'docs/guidance-schema.md',
  'src/hooks/prompt-guidance-contract.ts',
  'src/config/generator.ts',
  'src/cli/setup.ts',
];

const PROMPT_SURFACE_DIRS = [
  'prompts',
  'skills',
  'templates/model-instructions',
  'docs/prompt-guidance-fragments',
];

const MARKERS = [
  '<!-- OMX:RUNTIME:START -->',
  '<!-- OMX:RUNTIME:END -->',
  '<!-- OMX:TEAM:WORKER:START -->',
  '<!-- OMX:TEAM:WORKER:END -->',
  '<!-- OMX:MODELS:START -->',
  '<!-- OMX:MODELS:END -->',
  '<!-- omx:generated:agents-md -->',
];

const ABSOLUTE_DIRECTIVE_PATTERN = /\b(MUST(?:\s+NOT)?|DO NOT|DON'T|NEVER|ALWAYS|REQUIRED|REQUIRE|ONLY|STOP|ASK only|AUTO-CONTINUE|KEEP GOING)\b/i;

function phrasePattern(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(escaped, 'i');
}

/**
 * Durable invariant anchors owned by templates/AGENTS.md.
 *
 * These are intentionally specific phrases rather than generic words such as
 * "state", "cancel", or "team". A phrase is allowed in the SSOT and may be
 * referenced by any number of skills, but it must not be restated by multiple
 * skill cards.
 */
export const INVARIANT_PHRASE_RULES: readonly PromptInvariantPhraseRule[] = [
  {
    id: 'cancel-semantics',
    phrase: '--force does not widen cancellation scope',
    pattern: /`?--force`?\s+does\s+not\s+widen\s+cancellation\s+scope/i,
  },
  {
    id: 'state-ownership',
    phrase: 'compatibility discovery is read-only',
    pattern: phrasePattern('compatibility discovery is read-only'),
  },
  {
    id: 'hook-boundaries',
    phrase: 'Hooks own normal skill activation',
    pattern: phrasePattern('Hooks own normal skill activation'),
  },
  {
    id: 'team-protocol',
    phrase: 'direct tmux send-keys is fallback-only',
    pattern: /`?direct\s+tmux\s+send-keys`?\s+is\s+fallback-only/i,
  },
];

const EXCLUDED_INVENTORY_DIRS = new Set(['node_modules', 'dist', 'target', 'generated']);

function walkFiles(root: string, dir: string, out: string[], extensions = /\.(md|ts)$/): void {
  const absoluteDir = join(root, dir);
  if (!existsSync(absoluteDir) || !lstatSync(absoluteDir).isDirectory()) return;
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !EXCLUDED_INVENTORY_DIRS.has(entry.name)) {
        walkFiles(root, rel, out, extensions);
      }
    } else if (entry.isFile() && extensions.test(entry.name)) {
      // Do not follow symlinks into external installations or back into this tree.
      out.push(rel);
    }
  }
}

/** Filesystem snapshot: use a clean worktree when comparing Git revisions. */
export function buildRepositorySizeInventory(root = process.cwd()): RepositorySizeInventory {
  const empty = (): SizeTotals => ({ files: 0, physicalLines: 0, bytes: 0 });
  const groups: RepositorySizeInventory['groups'] = {
    nonTestSource: empty(), testSource: empty(), rustSourceIncludingTests: empty(),
    skillCards: empty(), agentPrompts: empty(), agentTemplate: empty(),
  };
  const paths: string[] = [];
  walkFiles(root, 'src', paths, /\.(ts|js|mjs|sh)$/);
  walkFiles(root, 'crates', paths, /\.rs$/);
  walkFiles(root, 'skills', paths, /^SKILL\.md$/);
  walkFiles(root, 'prompts', paths, /\.md$/);
  if (existsSync(join(root, 'templates/AGENTS.md')) && lstatSync(join(root, 'templates/AGENTS.md')).isFile()) paths.push('templates/AGENTS.md');
  const largestNonTestFiles: RepositorySizeInventory['largestNonTestFiles'] = [];
  for (const path of paths.map((entry) => entry.replaceAll('\\', '/')).sort()) {
    let group: keyof typeof groups;
    if (path.startsWith('src/')) {
      group = /(?:\/__tests__\/|\.(?:test|spec)\.)/.test(path) ? 'testSource' : 'nonTestSource';
    } else if (path.startsWith('crates/')) group = 'rustSourceIncludingTests';
    else if (/^skills\/[^/]+\/SKILL\.md$/.test(path)) group = 'skillCards';
    else if (/^prompts\/[^/]+\.md$/.test(path)) group = 'agentPrompts';
    else if (path === 'templates/AGENTS.md') group = 'agentTemplate';
    else continue;
    const content = readFileSync(join(root, path));
    const text = content.toString('utf-8');
    const physicalLines = text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length - (/[\r\n]$/.test(text) ? 1 : 0);
    const bytes = content.byteLength;
    groups[group].files += 1;
    groups[group].physicalLines += physicalLines;
    groups[group].bytes += bytes;
    if (group === 'nonTestSource') largestNonTestFiles.push({ path, physicalLines, bytes });
  }
  largestNonTestFiles.sort((a, b) => b.physicalLines - a.physicalLines || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { schemaVersion: 1, groups, largestNonTestFiles: largestNonTestFiles.slice(0, 10) };
}

export function listPromptSurfacePaths(root = process.cwd()): string[] {
  const paths = new Set<string>();
  for (const file of PROMPT_SURFACE_FILES) {
    if (existsSync(join(root, file))) paths.add(file);
  }

  const walked: string[] = [];
  for (const dir of PROMPT_SURFACE_DIRS) walkFiles(root, dir, walked);
  for (const path of walked) paths.add(path);

  return [...paths].sort();
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

function approximateTokenCount(text: string): number {
  return text.match(/[\p{L}\p{N}_'-]+|[^\s]/gu)?.length ?? 0;
}

function countAbsoluteDirectives(text: string): number {
  return text
    .split(/\r?\n/)
    .filter((line) => ABSOLUTE_DIRECTIVE_PATTERN.test(line))
    .length;
}

function inventorySurface(root: string, path: string): PromptSurfaceInventory {
  const text = readFileSync(join(root, path), 'utf-8');
  const markers = Object.fromEntries(MARKERS.map((marker) => [marker, countOccurrences(text, marker)]));
  return {
    path,
    lines: text.length === 0 ? 0 : text.split(/\r?\n/).length,
    approximateTokens: approximateTokenCount(text),
    absoluteDirectiveCount: countAbsoluteDirectives(text),
    markers,
  };
}

function normalizeFragmentLine(line: string): string | null {
  const normalized = line.replace(/\s+/g, ' ').trim();
  if (normalized.length < 60) return null;
  if (/^[-*#>|`]+$/.test(normalized)) return null;
  return normalized;
}

function duplicateFragmentFamilies(root: string, paths: string[]): DuplicateFragmentFamily[] {
  const occurrences = new Map<string, Set<string>>();
  for (const path of paths) {
    const text = readFileSync(join(root, path), 'utf-8');
    for (const line of text.split(/\r?\n/)) {
      const normalized = normalizeFragmentLine(line);
      if (!normalized) continue;
      const pathsWithLine = occurrences.get(normalized) ?? new Set<string>();
      pathsWithLine.add(path);
      occurrences.set(normalized, pathsWithLine);
    }
  }

  return [...occurrences.entries()]
    .map(([text, pathSet]) => ({ text, count: pathSet.size, paths: [...pathSet].sort() }))
    .filter((family) => family.count > 1)
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, 50);
}

/** List only workflow skill cards. Invariant lint intentionally excludes prompts,
 * docs, generated mirrors, and the AGENTS.md SSOT itself. */
export function listSkillPromptPaths(root = process.cwd()): string[] {
  const paths: string[] = [];
  walkFiles(root, 'skills', paths);
  return paths
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => path.endsWith('/SKILL.md') || path === 'skills/SKILL.md')
    .sort();
}

/**
 * Find durable invariant rules restated by more than one skill card.
 *
 * The rule list is explicit by design: generic repeated words are inventory
 * data, not CI failures. `templates/AGENTS.md` is the authorized SSOT and is
 * deliberately not included in `checkedPaths`.
 */
export function checkPromptInvariantDuplicates(
  root = process.cwd(),
  rules: readonly PromptInvariantPhraseRule[] = INVARIANT_PHRASE_RULES,
): PromptInvariantCheckReport {
  const checkedPaths = listSkillPromptPaths(root);
  const duplicates: PromptInvariantDuplicate[] = [];

  for (const rule of rules) {
    const matchingPaths = checkedPaths.filter((path) => rule.pattern.test(readFileSync(join(root, path), 'utf-8')));
    if (matchingPaths.length > 1) {
      duplicates.push({
        ruleId: rule.id,
        phrase: rule.phrase,
        paths: matchingPaths,
      });
    }
  }

  return {
    root,
    checkedPaths,
    duplicates,
    ok: duplicates.length === 0,
  };
}

export function renderPromptInvariantCheck(report: PromptInvariantCheckReport): string {
  if (report.ok) {
    return `prompt invariant check ok (${report.checkedPaths.length} skill cards checked)`;
  }

  return [
    'prompt invariant check failed: durable invariant phrases must have one skill owner at most',
    ...report.duplicates.flatMap((duplicate) => [
      `- ${duplicate.ruleId}: ${duplicate.phrase}`,
      ...duplicate.paths.map((path) => `  - ${path}`),
    ]),
    'Move shared invariant wording to templates/AGENTS.md and keep skill cards task-focused.',
  ].join('\n');
}

export function buildPromptInventory(root = process.cwd(), generatedAt = new Date().toISOString()): PromptInventoryReport {
  const resolvedRoot = root;
  const paths = listPromptSurfacePaths(resolvedRoot);
  const surfaces = paths.map((path) => inventorySurface(resolvedRoot, path));
  return {
    generatedAt,
    root: resolvedRoot,
    repositorySize: buildRepositorySizeInventory(resolvedRoot),
    totals: {
      files: surfaces.length,
      lines: surfaces.reduce((sum, surface) => sum + surface.lines, 0),
      approximateTokens: surfaces.reduce((sum, surface) => sum + surface.approximateTokens, 0),
      absoluteDirectiveCount: surfaces.reduce((sum, surface) => sum + surface.absoluteDirectiveCount, 0),
    },
    surfaces,
    duplicateFragmentFamilies: duplicateFragmentFamilies(resolvedRoot, paths),
  };
}

export function renderPromptInventoryMarkdown(report: PromptInventoryReport): string {
  const rows = report.surfaces.map((surface) => {
    const markerHits = Object.entries(surface.markers)
      .filter(([, count]) => count > 0)
      .map(([marker, count]) => `${marker} (${count})`)
      .join('<br>');
    return `| ${surface.path} | ${surface.lines} | ${surface.approximateTokens} | ${surface.absoluteDirectiveCount} | ${markerHits || '—'} |`;
  });

  const duplicates = report.duplicateFragmentFamilies.length === 0
    ? ['- None detected.']
    : report.duplicateFragmentFamilies.map(
        (family) => `- ${family.count} files: ${family.text}\n  - ${family.paths.join(', ')}`,
      );

  return [
    '# Prompt Inventory',
    '',
    `Generated: ${report.generatedAt}`,
    `Root: ${relative(process.cwd(), report.root) || '.'}`,
    '',
    '## Totals',
    '',
    `- Files: ${report.totals.files}`,
    `- Lines: ${report.totals.lines}`,
    `- Approximate tokens: ${report.totals.approximateTokens}`,
    `- Absolute directive lines: ${report.totals.absoluteDirectiveCount}`,
    '',
    '## Repository size (physical lines; not a quality score)',
    '',
    '| Category | Files | Physical lines | Bytes |',
    '| --- | ---: | ---: | ---: |',
    ...Object.entries(report.repositorySize.groups).map(([name, group]) => `| ${name} | ${group.files} | ${group.physicalLines} | ${group.bytes} |`),
    '',
    'Token counts are lexical estimates, not actual model tokens or injected context. See docs/debloat-metrics.md for category definitions.',
    '',
    '## Surfaces',
    '',
    '| Path | Lines | Approx. tokens | Absolute directive lines | Markers |',
    '| --- | ---: | ---: | ---: | --- |',
    ...rows,
    '',
    '## Duplicated fragment families',
    '',
    ...duplicates,
    '',
  ].join('\n');
}

export function runPromptInventoryCli(argv = process.argv.slice(2), defaultRoot = process.cwd()): number {
  const checkOnly = argv.includes('--check');
  const json = argv.includes('--json');
  const rootFlagIndex = argv.indexOf('--root');
  const root = rootFlagIndex >= 0 ? argv[rootFlagIndex + 1] : defaultRoot;
  if (!root) {
    console.error('prompt inventory: --root requires a path');
    return 1;
  }

  if (checkOnly) {
    const check = checkPromptInvariantDuplicates(root);
    if (json) {
      console.log(JSON.stringify(check, null, 2));
    } else {
      console.log(renderPromptInvariantCheck(check));
    }
    return check.ok ? 0 : 1;
  }

  const report = buildPromptInventory(root);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderPromptInventoryMarkdown(report));
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = runPromptInventoryCli();
}
