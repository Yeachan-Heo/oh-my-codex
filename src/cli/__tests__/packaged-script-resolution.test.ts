import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('packaged script resolution contract', () => {
  it('does not reference nonexistent top-level scripts/*.js watcher entrypoints from runtime code', () => {
    const cliIndex = readFileSync(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf-8');
    assert.doesNotMatch(
      cliIndex,
      /join\(pkgRoot,\s*["']scripts["'],\s*["']notify-fallback-watcher\.js["']\)/,
    );
    assert.doesNotMatch(
      cliIndex,
      /join\(pkgRoot,\s*["']scripts["'],\s*["']hook-derived-watcher\.js["']\)/,
    );
  });

  it('resolves watcher and notify entrypoints from dist/scripts', () => {
    const cliIndex = readFileSync(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf-8');
    assert.match(cliIndex, /function resolveDistScript\(pkgRoot: string,\s*scriptName: string\): string \{\s*return join\(pkgRoot,\s*"dist",\s*"scripts",\s*scriptName\);/s);
    assert.match(cliIndex, /resolveNotifyFallbackWatcherScript[\s\S]*resolveDistScript\(pkgRoot,\s*"notify-fallback-watcher\.js"\)/);
    assert.match(cliIndex, /resolveHookDerivedWatcherScript[\s\S]*resolveDistScript\(pkgRoot,\s*"hook-derived-watcher\.js"\)/);
    assert.match(cliIndex, /resolveNotifyHookScript[\s\S]*resolveDistScript\(pkgRoot,\s*"notify-hook\.js"\)/);
  });
});
