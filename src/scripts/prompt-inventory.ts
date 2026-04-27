#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

export interface PromptInventoryReport {
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

function walkFiles(root: string, dir: string, out: string[]): void {
  const absoluteDir = join(root, dir);
  if (!existsSync(absoluteDir)) return;
  for (const entry of readdirSync(absoluteDir)) {
    const rel = join(dir, entry);
    const absolute = join(root, rel);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      walkFiles(root, rel, out);
      continue;
    }
    if (stats.isFile() && /\.(md|ts)$/.test(entry)) {
      out.push(rel);
    }
  }
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

export function buildPromptInventory(root = process.cwd(), generatedAt = new Date().toISOString()): PromptInventoryReport {
  const resolvedRoot = root;
  const paths = listPromptSurfacePaths(resolvedRoot);
  const surfaces = paths.map((path) => inventorySurface(resolvedRoot, path));
  return {
    generatedAt,
    root: resolvedRoot,
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv.includes('--root') ? process.argv[process.argv.indexOf('--root') + 1] : process.cwd();
  const report = buildPromptInventory(root);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderPromptInventoryMarkdown(report));
  }
}
