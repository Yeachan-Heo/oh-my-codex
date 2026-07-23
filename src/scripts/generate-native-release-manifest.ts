#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inspectNativeArchive, selectNativeArchiveBinary } from '../native-assets/archive.js';
import {
  nativeTargetMapping,
  validateNativeReleaseManifest,
  type NativeReleaseAssetPolicyInput,
} from '../native-assets/policy.js';

function usage(): never {
  console.error('Usage: node scripts/generate-native-release-manifest.mjs --plan <path> --artifacts-dir <dir> --out <path> --release-base-url <url> [--require-products a,b]');
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

function checksum(raw: string, artifact: string): string {
  const value = raw.trim().split(/\s+/)[0] || '';
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`invalid SHA-256 sidecar for ${artifact}`);
  return value.toLowerCase();
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

interface PlanArtifact {
  kind: string;
  name: string;
  checksum: string;
  target_triples?: string[];
  assets?: Array<{ kind: string; name: string; path: string; id?: string }>;
}

interface PlanRelease {
  app_name: string;
  app_version: string;
}

interface Plan {
  artifacts: Record<string, PlanArtifact>;
  releases: PlanRelease[];
  announcement_tag: string;
}

const planPath = arg('--plan');
const artifactsDir = arg('--artifacts-dir');
const outPath = arg('--out');
const releaseBaseUrl = arg('--release-base-url');
const requestedProducts = (arg('--require-products') || '').split(',').map((value) => value.trim()).filter(Boolean);
// A product preflight denotes a full cargo-dist release. omx-runtime is released with
// that bundle but is intentionally not a runtime-hydratable product.
const requireProducts = requestedProducts.length === 0
  ? []
  : [...new Set([...requestedProducts, 'omx-runtime'])];
if (!planPath || !artifactsDir || !outPath || !releaseBaseUrl) usage();

const plan = JSON.parse(readFileSync(resolve(planPath), 'utf-8')) as Plan;
if (!/^v[^\s/]+$/.test(plan.announcement_tag)) throw new Error('announcement tag must be a v-prefixed release version');
const version = plan.announcement_tag.slice(1);
if (!Array.isArray(plan.releases) || plan.releases.length === 0 || plan.releases.some((release) => release.app_version !== version)) {
  throw new Error(`release versions must exactly match announcement tag ${plan.announcement_tag}`);
}

const byName = basenameIndex(walk(resolve(artifactsDir)));
const assets: NativeReleaseAssetPolicyInput[] = [];
for (const artifact of Object.values(plan.artifacts)) {
  if (artifact.kind !== 'executable-zip') continue;
  if (!Array.isArray(artifact.target_triples) || artifact.target_triples.length !== 1) {
    throw new Error(`expected exactly one target triple for ${artifact.name}`);
  }
  const target = artifact.target_triples[0]!;
  const mapping = nativeTargetMapping(target);
  if (!mapping) throw new Error(`unsupported native target ${target}`);
  if (!/\.(?:tar\.xz|tar\.gz|zip)$/i.test(artifact.name)) throw new Error(`unsupported native archive format: ${artifact.name}`);
  const executable = artifact.assets?.filter((asset) => asset.kind === 'executable') ?? [];
  if (executable.length !== 1) throw new Error(`expected exactly one executable for ${artifact.name}`);
  const binary = executable[0]!;
  const archivePath = byName.get(artifact.name);
  const checksumPath = byName.get(artifact.checksum);
  if (!archivePath || !checksumPath) throw new Error(`missing artifact files for ${artifact.name}`);
  if (statSync(archivePath).size <= 0 || statSync(checksumPath).size <= 0) throw new Error(`empty artifact file for ${artifact.name}`);
  const expectedSha256 = checksum(readFileSync(checksumPath, 'utf-8'), artifact.name);
  if (sha256(archivePath) !== expectedSha256) throw new Error(`checksum mismatch for ${artifact.name}`);
  const archiveEntries = await inspectNativeArchive(archivePath);
  selectNativeArchiveBinary(archiveEntries, binary.path);
  const release = plan.releases.find((item) => item.app_name === binary.name || item.app_name === binary.id?.split('-exe-')[0]);
  if (!release || release.app_version !== version) throw new Error(`missing coherent release metadata for ${artifact.name}`);
  assets.push({
    product: release.app_name,
    version,
    platform: mapping.platform,
    arch: mapping.arch,
    target,
    ...(mapping.libc ? { libc: mapping.libc } : {}),
    archive: artifact.name,
    binary: release.app_name,
    binary_path: binary.path,
    sha256: expectedSha256,
    size: statSync(archivePath).size,
    download_url: `${releaseBaseUrl.replace(/\/$/, '')}/${artifact.name}`,
  });
}

const manifest = {
  manifest_version: 1,
  version,
  tag: plan.announcement_tag,
  generated_at: new Date().toISOString(),
  assets: assets.sort((a, b) => {
    const libcRank = (asset: NativeReleaseAssetPolicyInput): number => asset.libc === 'musl' ? 0 : asset.libc === 'glibc' ? 1 : 2;
    return a.product.localeCompare(b.product)
      || a.platform.localeCompare(b.platform)
      || a.arch.localeCompare(b.arch)
      || libcRank(a) - libcRank(b)
      || a.archive.localeCompare(b.archive);
  }),
};
if (manifest.assets.length === 0) throw new Error('release manifest must declare at least one native archive');
validateNativeReleaseManifest(manifest);
if (manifest.tag !== `v${manifest.version}`) throw new Error('manifest tag/version mismatch');
for (const product of requireProducts) {
  if (!manifest.assets.some((asset) => asset.product === product)) throw new Error(`missing required product in release manifest: ${product}`);
}
writeFileSync(resolve(outPath), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(resolve(outPath));
