#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inspectNativeArchive, selectNativeArchiveBinary } from '../native-assets/archive.js';
import {
  validateNativeReleaseManifest,
  type NativeReleaseManifestPolicyInput,
} from '../native-assets/policy.js';

function usage(): never {
  console.error('Usage: node scripts/verify-native-release-assets.mjs --manifest <path> --artifacts-dir <dir>');
  process.exit(1);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function basenameIndex(files: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const file of files) {
    const name = file.split(/[\\/]/).at(-1)!;
    if (result.has(name)) throw new Error(`duplicate artifact basename: ${name}`);
    result.set(name, file);
  }
  return result;
}

const manifestPath = arg('--manifest');
const artifactsDir = arg('--artifacts-dir');
if (!manifestPath || !artifactsDir) usage();

const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf-8')) as NativeReleaseManifestPolicyInput;
if (manifest.tag !== `v${manifest.version}`) throw new Error('manifest tag/version mismatch');
validateNativeReleaseManifest(manifest);
if (manifest.assets.length === 0) throw new Error('release manifest must declare at least one native archive');
const byName = basenameIndex(walk(resolve(artifactsDir)));
const manifestArchives = new Set<string>();
for (const asset of manifest.assets) {
  if (!/\.(?:tar\.xz|tar\.gz|zip)$/i.test(asset.archive)) throw new Error(`unsupported native archive format: ${asset.archive}`);
  if (manifestArchives.has(asset.archive)) throw new Error(`duplicate manifest archive: ${asset.archive}`);
  manifestArchives.add(asset.archive);
  const archivePath = byName.get(asset.archive);
  if (!archivePath) throw new Error(`missing archive ${asset.archive}`);
  const expectedSize = asset.size;
  if (!Number.isSafeInteger(expectedSize) || expectedSize === undefined || expectedSize <= 0 || statSync(archivePath).size !== expectedSize) {
    throw new Error(`size mismatch for ${asset.archive}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(asset.sha256) || sha256(archivePath) !== asset.sha256.toLowerCase()) {
    throw new Error(`checksum mismatch for ${asset.archive}`);
  }
  const entries = await inspectNativeArchive(archivePath);
  selectNativeArchiveBinary(entries, asset.binary_path);
}

const archiveFiles = [...byName.keys()].filter((name) => /\.(?:tar\.xz|tar\.gz|zip)$/i.test(name));
for (const archive of archiveFiles) {
  if (!manifestArchives.has(archive)) throw new Error(`archive is not declared by manifest: ${archive}`);
}
console.log(`[native-release-assets] verified ${manifest.assets.length} assets`);
