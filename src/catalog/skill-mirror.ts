import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export interface DirectoryMirrorMismatch {
  kind: 'missing-directory' | 'file-list' | 'content' | 'not-directory';
  path?: string;
  expected?: string[];
  actual?: string[];
}

export interface DirectoryMirrorOptions {
  expectedContent?: (relativeFile: string, content: Buffer) => Buffer | Promise<Buffer>;
}

export interface SkillMirrorMismatch {
  kind: 'skill-list' | 'unexpected-entry' | 'skill-directory';
  skillName?: string;
  message: string;
  expected?: string[];
  actual?: string[];
}

async function listRelativeFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return listRelativeFiles(fullPath, base);
    if (entry.isFile()) return [relative(base, fullPath).split(sep).join('/')];
    return [];
  }));
  return files.flat().sort();
}

export async function compareDirectoryMirror(
  expectedDir: string,
  actualDir: string,
  options: DirectoryMirrorOptions = {},
): Promise<DirectoryMirrorMismatch | null> {
  if (!existsSync(expectedDir) || !existsSync(actualDir)) {
    return { kind: 'missing-directory' };
  }

  const [expectedStat, actualStat] = await Promise.all([
    stat(expectedDir).catch(() => null),
    stat(actualDir).catch(() => null),
  ]);
  if (!expectedStat?.isDirectory() || !actualStat?.isDirectory()) {
    return { kind: 'not-directory' };
  }

  const [expectedFiles, actualFiles] = await Promise.all([
    listRelativeFiles(expectedDir),
    listRelativeFiles(actualDir),
  ]);
  if (expectedFiles.join('\n') !== actualFiles.join('\n')) {
    return { kind: 'file-list', expected: expectedFiles, actual: actualFiles };
  }

  for (const file of expectedFiles) {
    const [rawExpectedContent, actualContent] = await Promise.all([
      readFile(join(expectedDir, file)),
      readFile(join(actualDir, file)),
    ]);
    const expectedContent = options.expectedContent
      ? await options.expectedContent(file, rawExpectedContent)
      : rawExpectedContent;
    if (!expectedContent.equals(actualContent)) {
      return { kind: 'content', path: file };
    }
  }

  return null;
}

export async function compareSkillMirror(
  expectedSkillsDir: string,
  actualSkillsDir: string,
  expectedSkillNames: readonly string[],
  options: DirectoryMirrorOptions = {},
): Promise<SkillMirrorMismatch | null> {
  if (!existsSync(actualSkillsDir)) {
    return { kind: 'skill-list', message: 'actual skills directory is missing' };
  }

  const entries = await readdir(actualSkillsDir, { withFileTypes: true }).catch(() => []);
  const unexpectedEntries = entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (unexpectedEntries.length > 0) {
    return {
      kind: 'unexpected-entry',
      message: `unexpected non-directory entries: ${unexpectedEntries.join(', ')}`,
      actual: unexpectedEntries,
    };
  }

  const actualSkillNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const sortedExpectedSkillNames = [...expectedSkillNames].sort();
  if (actualSkillNames.join('\n') !== sortedExpectedSkillNames.join('\n')) {
    return {
      kind: 'skill-list',
      message: 'skill directory list differs',
      expected: sortedExpectedSkillNames,
      actual: actualSkillNames,
    };
  }

  for (const skillName of sortedExpectedSkillNames) {
    const mismatch = await compareDirectoryMirror(
      join(expectedSkillsDir, skillName),
      join(actualSkillsDir, skillName),
      options,
    );
    if (mismatch) {
      return {
        kind: 'skill-directory',
        skillName,
        message: `${skillName}: ${mismatch.kind}${mismatch.path ? ` (${mismatch.path})` : ''}`,
        expected: mismatch.expected,
        actual: mismatch.actual,
      };
    }
  }

  return null;
}

export async function assertSkillMirror(
  expectedSkillsDir: string,
  actualSkillsDir: string,
  expectedSkillNames: readonly string[],
  options: DirectoryMirrorOptions = {},
): Promise<void> {
  const mismatch = await compareSkillMirror(
    expectedSkillsDir,
    actualSkillsDir,
    expectedSkillNames,
    options,
  );
  if (!mismatch) return;

  throw new Error(
    [
      'plugin_skill_mirror_out_of_sync',
      `kind=${mismatch.kind}`,
      mismatch.skillName ? `skill=${mismatch.skillName}` : undefined,
      `message=${mismatch.message}`,
      mismatch.expected ? `expected=${JSON.stringify(mismatch.expected)}` : undefined,
      mismatch.actual ? `actual=${JSON.stringify(mismatch.actual)}` : undefined,
    ].filter(Boolean).join('\n'),
  );
}
