export interface BlastRadiusInput {
  expectedSurface: readonly string[];
  diffPaths: readonly string[];
  diffLineCount: number;
  maxFiles?: number;
  maxLines?: number;
}

export interface BlastRadiusVerdict {
  pass: boolean;
  reason: string;
  outOfSurface: readonly string[];
  fileCount: number;
  lineCount: number;
}

const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_LINES = 500;

export function matchesSurface(path: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith('/**')) {
      if (path.startsWith(pattern.slice(0, -3))) return true;
    } else if (pattern.endsWith('*')) {
      if (path.startsWith(pattern.slice(0, -1))) return true;
    } else if (pattern === path) {
      return true;
    }
  }
  return false;
}

export function checkBlastRadius(input: BlastRadiusInput): BlastRadiusVerdict {
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
  const maxLines = input.maxLines ?? DEFAULT_MAX_LINES;
  const outOfSurface = input.diffPaths.filter((p) => !matchesSurface(p, input.expectedSurface));

  if (outOfSurface.length > 0) {
    return {
      pass: false,
      reason: `diff touches ${outOfSurface.length} file(s) outside expected surface: ${outOfSurface.slice(0, 3).join(', ')}${outOfSurface.length > 3 ? '...' : ''}`,
      outOfSurface,
      fileCount: input.diffPaths.length,
      lineCount: input.diffLineCount,
    };
  }

  if (input.diffPaths.length > maxFiles) {
    return {
      pass: false,
      reason: `diff touches ${input.diffPaths.length} files (>${maxFiles} max)`,
      outOfSurface: [],
      fileCount: input.diffPaths.length,
      lineCount: input.diffLineCount,
    };
  }

  if (input.diffLineCount > maxLines) {
    return {
      pass: false,
      reason: `diff is ${input.diffLineCount} lines (>${maxLines} max)`,
      outOfSurface: [],
      fileCount: input.diffPaths.length,
      lineCount: input.diffLineCount,
    };
  }

  return {
    pass: true,
    reason: `diff fits within blast radius (${input.diffPaths.length} files, ${input.diffLineCount} lines)`,
    outOfSurface: [],
    fileCount: input.diffPaths.length,
    lineCount: input.diffLineCount,
  };
}
