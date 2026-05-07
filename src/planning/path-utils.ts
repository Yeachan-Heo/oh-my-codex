import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

const CONTEXT_PACK_BASENAME_PATTERN = /^context-\d{8}T\d{6}Z-(?<slug>[^/]+)\.json$/i;
const CONTEXT_PACK_RELATIVE_PATH_PATTERN = /^\.omx\/context\/context-\d{8}T\d{6}Z-(?<slug>[^/]+)\.json$/i;

export function normalizePlanningRepoRelativePath(rawPath: string): string | null {
  const trimmed = rawPath.trim().replace(/^`|`$/g, '').replaceAll('\\', '/');
  if (!trimmed) {
    return null;
  }
  const withoutLeadingDot = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed;
  if (
    !withoutLeadingDot
    || withoutLeadingDot.startsWith('/')
    || /^[A-Za-z]:/.test(withoutLeadingDot)
  ) {
    return null;
  }
  const segments = withoutLeadingDot
    .split('/')
    .filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.includes('..')) {
    return null;
  }
  return segments.join('/');
}

function isCanonicalContextPackRelativePath(normalizedPath: string): boolean {
  return CONTEXT_PACK_RELATIVE_PATH_PATTERN.test(normalizedPath);
}

export function isCanonicalContextPackPath(packPath: string): boolean {
  if (isAbsolute(packPath)) {
    return CONTEXT_PACK_BASENAME_PATTERN.test(basename(packPath))
      && basename(dirname(packPath)) === 'context'
      && basename(dirname(dirname(packPath))) === '.omx';
  }

  const normalizedPath = normalizePlanningRepoRelativePath(packPath);
  return normalizedPath !== null && isCanonicalContextPackRelativePath(normalizedPath);
}

export interface ResolvedDeclaredContextPackPath {
  normalizedPath: string;
  resolvedPath: string;
  slug: string;
}

export function resolveDeclaredContextPackPath(
  repoRoot: string,
  rawPath: string,
): ResolvedDeclaredContextPackPath | null {
  const normalizedPath = normalizePlanningRepoRelativePath(rawPath);
  const match = normalizedPath?.match(CONTEXT_PACK_RELATIVE_PATH_PATTERN);
  if (!normalizedPath || !match?.groups?.slug) {
    return null;
  }

  const resolvedPath = resolve(repoRoot, normalizedPath);
  const roundTripPath = normalizePlanningRepoRelativePath(relative(repoRoot, resolvedPath));
  if (roundTripPath !== normalizedPath) {
    return null;
  }

  return {
    normalizedPath,
    resolvedPath,
    slug: match.groups.slug,
  };
}
