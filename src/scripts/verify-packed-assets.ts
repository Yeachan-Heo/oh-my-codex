#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_PACKED_ASSETS = [
  '.agents/plugins/marketplace.json',
  'Cargo.lock',
  'Cargo.toml',
  'crates/omx-explore/Cargo.toml',
  'dist/cli/__tests__/mcp-parity.test.js',
  'dist/cli/__tests__/nested-help-routing.test.js',
  'dist/cli/omx.js',
  'dist/scripts/__tests__/smoke-packed-install.test.js',
  'dist/scripts/__tests__/code-review-installed-contract.test.js',
  'dist/scripts/codex-native-hook.js',
  'dist/scripts/run-compiled-ci.js',
  'dist/scripts/run-release-gates.js',
  'dist/scripts/run-test-files.js',
  'dist/scripts/sync-plugin-mirror.js',
  'dist/scripts/verify-native-agents.js',
  'package.json',
  'plugins/oh-my-codex/.codex-plugin/plugin.json',
  'plugins/oh-my-codex/.mcp.json',
  'prompts/architect.md',
  'prompts/code-reviewer.md',
  'skills/code-review/SKILL.md',
  'skills/ralph/SKILL.md',
  'src/scripts/ask-claude.sh',
  'src/scripts/ask-gemini.sh',
  'src/scripts/prepare-build.js',
  'templates/catalog-manifest.json',
] as const;

export interface NpmPackFile {
  path: string;
}

export interface NpmPackResult {
  filename?: string;
  files?: NpmPackFile[];
}

export function parseNpmPackManifest(stdout: string): NpmPackResult[] {
  const start = stdout.lastIndexOf('\n[');
  const jsonText = (start >= 0 ? stdout.slice(start + 1) : stdout).trim();
  if (!jsonText.startsWith('[')) throw new Error('PACKED_ASSET_MANIFEST_INVALID');
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('PACKED_ASSET_MANIFEST_INVALID');
  }
  if (!Array.isArray(parsed)) throw new Error('PACKED_ASSET_MANIFEST_INVALID');
  return parsed as NpmPackResult[];
}

export function verifyPackedAssetPaths(
  paths: readonly string[],
  required: readonly string[] = REQUIRED_PACKED_ASSETS,
): void {
  const present = new Set(paths);
  for (const path of required) {
    if (!present.has(path)) throw new Error(`PACKED_ASSET_MISSING: ${path}`);
  }
}

export function verifyPackedAssetManifest(results: readonly NpmPackResult[]): void {
  const files = results[0]?.files;
  if (!Array.isArray(files) || files.some((file) => typeof file?.path !== 'string')) {
    throw new Error('PACKED_ASSET_MANIFEST_INVALID');
  }
  verifyPackedAssetPaths(files.map((file) => file.path));
}

export function verifyPackedAssetsDryRun(packageRoot = process.cwd()): void {
  const root = resolve(packageRoot);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_update_notifier: 'false',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`PACKED_ASSET_MANIFEST_FAILED: ${result.stderr.trim()}`);
  verifyPackedAssetManifest(parseNpmPackManifest(result.stdout));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    verifyPackedAssetsDryRun();
    console.log('packed asset verification: PASS');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
