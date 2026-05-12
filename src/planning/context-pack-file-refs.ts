import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import {
  readReadyContextPackPrivateEntryReadModel,
  type ContextPackPrivateSelector,
  type ContextPackRole,
} from './context-pack-status.js';

const CONTEXT_PACK_LABEL_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}-]*$/u;
const MAX_CONTEXT_PACK_LABEL_LENGTH = 80;

export interface ContextPackFileRef {
  readonly roles: readonly ContextPackRole[];
  readonly label: string;
  readonly path: string;
  readonly sourcePath: string;
  readonly delivery: 'file';
}

export interface ContextPackFileRefResolution {
  readonly refs: readonly ContextPackFileRef[];
  readonly issues: readonly string[];
}

function normalizeLabelToken(raw: string): string | null {
  const normalized = Array.from(
    raw
      .normalize('NFKC')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
      .replace(/^-+|-+$/g, ''),
  )
    .slice(0, MAX_CONTEXT_PACK_LABEL_LENGTH)
    .join('')
    .replace(/-+$/g, '');
  return CONTEXT_PACK_LABEL_PATTERN.test(normalized) ? normalized : null;
}

function deriveBaseLabel(path: string): string {
  const stem = basename(path, extname(path)).trim();
  const fallback = basename(path).trim();
  return normalizeLabelToken(stem)
    ?? normalizeLabelToken(fallback)
    ?? 'context-file';
}

function deriveSelectorSuffix(selector: ContextPackPrivateSelector | null): string | null {
  if (!selector) {
    return null;
  }
  if (selector.type === 'lines') {
    return normalizeLabelToken(`lines-${selector.start}-${selector.end}`);
  }
  return normalizeLabelToken(selector.value) ?? 'heading';
}

function derivePathSuffixes(path: string): string[] {
  const parent = dirname(path).replaceAll('\\', '/');
  if (parent === '' || parent === '.') {
    return [];
  }

  const suffixes: string[] = [];
  let current = '';
  for (const segment of parent.split('/').filter(Boolean).reverse()) {
    const normalizedSegment = normalizeLabelToken(segment);
    if (!normalizedSegment) {
      continue;
    }
    current = current === ''
      ? normalizedSegment
      : `${current}-${normalizedSegment}`;
    suffixes.push(current);
  }
  return suffixes;
}

function deriveRoleSuffix(roles: readonly ContextPackRole[]): string | null {
  return roles.length > 0
    ? normalizeLabelToken([...roles].sort().join('-'))
    : null;
}

function buildLabelCandidate(
  base: string,
  suffixes: readonly string[],
): string {
  return normalizeLabelToken([base, ...suffixes].join('-')) ?? 'context-file';
}

function buildNumberedLabelCandidate(
  base: string,
  suffixes: readonly string[],
  counter: number,
): string {
  const prefix = buildLabelCandidate(base, suffixes);
  const counterToken = String(counter);
  const maxPrefixLength = MAX_CONTEXT_PACK_LABEL_LENGTH - counterToken.length - 1;
  const trimmedPrefix = maxPrefixLength > 0
    ? Array.from(prefix)
      .slice(0, maxPrefixLength)
      .join('')
      .replace(/-+$/g, '')
    : '';
  return normalizeLabelToken(`${trimmedPrefix || 'context-file'}-${counterToken}`)
    ?? 'context-file';
}

function resolveUniqueLabel(
  base: string,
  selectorSuffix: string | null,
  pathSuffixes: readonly string[],
  roleSuffix: string | null,
  used: Set<string>,
): string {
  let candidate = buildLabelCandidate(base, []);
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }

  const uniquenessSuffixes = [
    ...(selectorSuffix ? [selectorSuffix] : []),
    ...pathSuffixes,
    ...(roleSuffix ? [roleSuffix] : []),
  ].filter((suffix) => suffix !== base);

  const accumulated: string[] = [];
  for (const suffix of uniquenessSuffixes) {
    accumulated.push(suffix);
    candidate = buildLabelCandidate(base, accumulated);
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }

  for (let counter = 2; ; counter += 1) {
    candidate = buildNumberedLabelCandidate(base, accumulated, counter);
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

export function readReadyContextPackFileRefs(
  packPath: string,
  repoRoot: string,
): ContextPackFileRefResolution {
  if (!isAbsolute(repoRoot)) {
    return {
      refs: [],
      issues: [`Could not resolve an absolute repo root for ${basename(packPath)}.`],
    };
  }

  const privateEntries = readReadyContextPackPrivateEntryReadModel(packPath);
  if (!privateEntries) {
    return {
      refs: [],
      issues: [`Could not read ready private context-pack entry metadata from ${basename(packPath)}.`],
    };
  }

  const usedLabels = new Set<string>();
  const refs = privateEntries.map((entry) => {
    const baseLabel = entry.label ?? deriveBaseLabel(entry.path);
    const label = resolveUniqueLabel(
      baseLabel,
      deriveSelectorSuffix(entry.selector),
      derivePathSuffixes(entry.path),
      deriveRoleSuffix(entry.roles),
      usedLabels,
    );
    const sourcePath = resolve(repoRoot, entry.path);
    return {
      roles: [...entry.roles],
      label,
      path: sourcePath,
      sourcePath,
      delivery: 'file' as const,
    };
  });

  return { refs, issues: [] };
}

export function groupContextPackFileRefsByRole(
  refs: readonly ContextPackFileRef[],
): Partial<Record<ContextPackRole, ContextPackFileRef[]>> {
  const grouped: Partial<Record<ContextPackRole, ContextPackFileRef[]>> = {};
  for (const ref of refs) {
    for (const role of ref.roles) {
      if (!grouped[role]) {
        grouped[role] = [];
      }
      grouped[role]!.push(ref);
    }
  }
  return grouped;
}
