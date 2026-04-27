import { basename, dirname, isAbsolute, normalize, resolve } from 'node:path';

const CONTEXT_PACK_BASENAME_PATTERN = /^context-\d{8}T\d{6}Z-[^/]+\.json$/i;
const CONTEXT_PACK_RELATIVE_PATH_PATTERN = /^\.omx\/context\/context-\d{8}T\d{6}Z-[^/]+\.json$/i;

export function normalizePlanningRepoRelativePath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/^`|`$/g, '').replace(/\\/g, '/');
  const withoutDotPrefix = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed;
  return normalize(withoutDotPrefix).replace(/\\/g, '/');
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

  return isCanonicalContextPackRelativePath(normalizePlanningRepoRelativePath(packPath));
}

export interface ResolvedDeclaredContextPackPath {
  normalizedPath: string;
  resolvedPath: string;
}

export function resolveDeclaredContextPackPath(
  repoRoot: string,
  rawPath: string,
): ResolvedDeclaredContextPackPath | null {
  const normalizedPath = normalizePlanningRepoRelativePath(rawPath);
  if (!isCanonicalContextPackRelativePath(normalizedPath)) {
    return null;
  }

  return {
    normalizedPath,
    resolvedPath: resolve(repoRoot, normalizedPath),
  };
}
