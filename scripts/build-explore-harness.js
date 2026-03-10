#!/usr/bin/env node
import { copyFile, chmod, mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');
const binDir = join(root, 'bin');
const binaryName = process.platform === 'win32' ? 'omx-explore-harness.exe' : 'omx-explore-harness';
const sourcePath = join(root, 'target', 'release', binaryName);
const outputPath = join(binDir, binaryName);
const metadataPath = join(binDir, 'omx-explore-harness.meta.json');

const build = spawnSync('cargo', ['build', '--release', '-p', 'omx-explore-harness'], {
  cwd: root,
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (typeof build.stdout === 'string' && build.stdout.length > 0) {
  process.stderr.write(build.stdout);
}
if (typeof build.stderr === 'string' && build.stderr.length > 0) {
  process.stderr.write(build.stderr);
}

if (build.error) {
  console.error(`[build-explore-harness] failed to launch cargo: ${build.error.message}`);
  process.exit(1);
}
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}
if (!existsSync(sourcePath)) {
  console.error(`[build-explore-harness] expected built binary at ${sourcePath}`);
  process.exit(1);
}

await mkdir(binDir, { recursive: true });
await copyFile(sourcePath, outputPath);
if (process.platform !== 'win32') {
  await chmod(outputPath, 0o755);
}
await writeFile(metadataPath, JSON.stringify({
  binaryName,
  platform: process.platform,
  arch: process.arch,
  builtAt: new Date().toISOString(),
  strategy: 'prepack-native',
}, null, 2) + '\n');
console.error(`[build-explore-harness] wrote ${outputPath}`);
