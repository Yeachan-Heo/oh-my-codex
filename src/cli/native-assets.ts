import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawnPlatformCommandSync } from '../utils/platform-command.js';
import { getPackageRoot } from '../utils/package.js';

export type NativeProduct = 'omx-explore-harness' | 'omx-sparkshell' | 'omx-api';
export type NativeLibc = 'musl' | 'glibc';

export interface NativeReleaseAsset {
  product: NativeProduct;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  target?: string;
  libc?: NativeLibc;
  archive: string;
  binary: string;
  binary_path: string;
  sha256: string;
  size?: number;
  download_url: string;
}

export interface NativeReleaseManifest {
  manifest_version?: number;
  version: string;
  tag?: string;
  generated_at?: string;
  assets: NativeReleaseAsset[];
}

export interface HydrateNativeBinaryOptions {
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
}

export interface NativeBinaryCandidateOptions {
  linuxLibcPreference?: readonly NativeLibc[];
}

export interface ResolveLinuxNativeLibcPreferenceOptions {
  env?: NodeJS.ProcessEnv;
  detectedRuntime?: NativeLibc;
}

const NATIVE_AUTO_FETCH_ENV = 'OMX_NATIVE_AUTO_FETCH';
const NATIVE_MANIFEST_URL_ENV = 'OMX_NATIVE_MANIFEST_URL';
const NATIVE_RELEASE_BASE_URL_ENV = 'OMX_NATIVE_RELEASE_BASE_URL';
const NATIVE_CACHE_DIR_ENV = 'OMX_NATIVE_CACHE_DIR';
export const EXPLORE_BIN_ENV = 'OMX_EXPLORE_BIN';
export const SPARKSHELL_BIN_ENV = 'OMX_SPARKSHELL_BIN';
export const API_BIN_ENV = 'OMX_API_BIN';

function packageJsonPath(packageRoot = getPackageRoot()): string {
  return join(packageRoot, 'package.json');
}

async function readPackageJson(packageRoot = getPackageRoot()): Promise<{ version?: string; repository?: { url?: string } | string }> {
  const raw = await readFile(packageJsonPath(packageRoot), 'utf-8');
  return JSON.parse(raw) as { version?: string; repository?: { url?: string } | string };
}

export async function getPackageVersion(packageRoot = getPackageRoot()): Promise<string> {
  const pkg = await readPackageJson(packageRoot);
  if (!pkg.version?.trim()) throw new Error('[native-assets] package.json is missing version');
  return pkg.version.trim();
}

function repositoryHttpBase(repository: { url?: string } | string | undefined): string | undefined {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (!raw?.trim()) return undefined;
  const trimmed = raw.trim().replace(/^git\+/, '').replace(/\.git$/, '');
  if (trimmed.startsWith('https://github.com/')) return trimmed;
  if (trimmed.startsWith('http://github.com/')) return trimmed.replace(/^http:/, 'https:');
  return undefined;
}

export async function resolveNativeReleaseBaseUrl(
  packageRoot = getPackageRoot(),
  version?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const override = env[NATIVE_RELEASE_BASE_URL_ENV]?.trim();
  if (override) return override.replace(/\/$/, '');
  const pkg = await readPackageJson(packageRoot);
  const repo = repositoryHttpBase(pkg.repository);
  if (!repo) throw new Error('[native-assets] unable to resolve GitHub repository URL for native release downloads');
  const resolvedVersion = version ?? await getPackageVersion(packageRoot);
  return `${repo}/releases/download/v${resolvedVersion}`;
}

export async function resolveNativeManifestUrl(
  packageRoot = getPackageRoot(),
  version?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const override = env[NATIVE_MANIFEST_URL_ENV]?.trim();
  if (override) return override;
  const baseUrl = await resolveNativeReleaseBaseUrl(packageRoot, version, env);
  return `${baseUrl}/native-release-manifest.json`;
}

export function resolveNativeCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[NATIVE_CACHE_DIR_ENV]?.trim();
  if (override) return resolve(override);
  if (process.platform === 'win32') {
    return resolve(env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local'), 'oh-my-codex', 'native');
  }
  return resolve(env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache'), 'oh-my-codex', 'native');
}

export function resolveCachedNativeBinaryPath(
  product: NativeProduct,
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env,
  libc?: NativeLibc,
): string {
  const binary = platform === 'win32' ? `${product}.exe` : product;
  const platformKey = libc ? `${platform}-${arch}-${libc}` : `${platform}-${arch}`;
  return join(resolveNativeCacheRoot(env), version, platformKey, product, binary);
}

const MUSL_LOADER_DIRS = ['/lib', '/lib64', '/usr/lib', '/usr/local/lib'];
const MUSL_LOADER_PATTERN = /^ld-musl-.*\.so(?:\.\d+)*$/i;

function inferRuntimeLibcFromText(text: string | undefined): NativeLibc | undefined {
  const normalized = String(text || '').toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes('musl')) return 'musl';
  if (normalized.includes('glibc') || normalized.includes('gnu libc')) return 'glibc';
  return undefined;
}

export function resolveLinuxNativeLibcPreference(
  options: ResolveLinuxNativeLibcPreferenceOptions = {},
): NativeLibc[] {
  const { env = process.env, detectedRuntime } = options;
  const runtime = detectedRuntime ?? detectLinuxRuntimeLibc(env);
  if (runtime === 'musl') return ['musl'];
  return ['musl', 'glibc'];
}

function detectLinuxRuntimeLibc(env: NodeJS.ProcessEnv = process.env): NativeLibc | undefined {
  if (process.platform !== 'linux') return undefined;

  const lddProbe = spawnPlatformCommandSync('ldd', ['--version'], { encoding: 'utf-8' }, process.platform, env);
  const lddRuntime = inferRuntimeLibcFromText(`${lddProbe.result.stdout || ''}\n${lddProbe.result.stderr || ''}`);
  if (lddRuntime) return lddRuntime;

  const getconfProbe = spawnPlatformCommandSync('getconf', ['GNU_LIBC_VERSION'], { encoding: 'utf-8' }, process.platform, env);
  const getconfRuntime = inferRuntimeLibcFromText(`${getconfProbe.result.stdout || ''}\n${getconfProbe.result.stderr || ''}`);
  if (getconfRuntime) return getconfRuntime;

  for (const directory of MUSL_LOADER_DIRS) {
    if (!existsSync(directory)) continue;
    try {
      if (readdirSync(directory).some((entry) => MUSL_LOADER_PATTERN.test(entry))) {
        return 'musl';
      }
    } catch {
      // Ignore unreadable loader directories.
    }
  }

  return undefined;
}

export function inferNativeAssetLibc(asset: Pick<NativeReleaseAsset, 'archive' | 'target' | 'libc'>): NativeLibc | undefined {
  if (asset.libc === 'musl' || asset.libc === 'glibc') return asset.libc;
  const hint = [asset.target, asset.archive].filter(Boolean).join(' ').toLowerCase();
  if (hint.includes('musl')) return 'musl';
  if (hint.includes('linux-gnu') || hint.includes('glibc')) return 'glibc';
  return undefined;
}

export function resolveCachedNativeBinaryCandidatePaths(
  product: NativeProduct,
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env,
  options: NativeBinaryCandidateOptions = {},
): string[] {
  const candidates: string[] = [];
  if (platform === 'linux') {
    for (const libc of options.linuxLibcPreference ?? resolveLinuxNativeLibcPreference({ env })) {
      candidates.push(resolveCachedNativeBinaryPath(product, version, platform, arch, env, libc));
    }
  }
  candidates.push(resolveCachedNativeBinaryPath(product, version, platform, arch, env));
  return [...new Set(candidates)];
}

export function resolveCachedNativeBinaryChecksumPath(binaryPath: string): string {
  return `${binaryPath}.sha256`;
}

type CachedNativeBinaryState = 'missing' | 'invalid' | 'legacy' | 'verified';

async function inspectCachedNativeBinary(binaryPath: string): Promise<CachedNativeBinaryState> {
  try {
    const binaryStat = await stat(binaryPath);
    if (!binaryStat.isFile() || binaryStat.size === 0) return 'invalid';
  } catch {
    return 'missing';
  }

  const checksumPath = resolveCachedNativeBinaryChecksumPath(binaryPath);
  if (!existsSync(checksumPath)) return 'legacy';
  try {
    const expectedDigest = (await readFile(checksumPath, 'utf-8')).trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedDigest)) return 'invalid';
    return await sha256ForFile(binaryPath) === expectedDigest ? 'verified' : 'invalid';
  } catch {
    return 'invalid';
  }
}

export async function isVerifiedCachedNativeBinary(binaryPath: string): Promise<boolean> {
  return await inspectCachedNativeBinary(binaryPath) === 'verified';
}

export function resolveNativeReleaseAssetCandidates(
  manifest: NativeReleaseManifest,
  product: NativeProduct,
  version: string,
  platform: NodeJS.Platform,
  arch: string,
  options: NativeBinaryCandidateOptions = {},
): NativeReleaseAsset[] {
  const candidates = manifest.assets.filter((asset) => asset.product === product
    && asset.version === version
    && asset.platform === platform
    && asset.arch === arch);
  if (platform !== 'linux') return candidates;

  const preference = options.linuxLibcPreference ?? resolveLinuxNativeLibcPreference();
  const preferenceIndex = new Map(preference.map((libc, index) => [libc, index]));
  return [...candidates].sort((left, right) => {
    const leftLibc = inferNativeAssetLibc(left);
    const rightLibc = inferNativeAssetLibc(right);
    const leftRank = leftLibc ? (preferenceIndex.get(leftLibc) ?? preference.length + 1) : preference.length;
    const rightRank = rightLibc ? (preferenceIndex.get(rightLibc) ?? preference.length + 1) : preference.length;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.archive.localeCompare(right.archive);
  });
}

export function isRepositoryCheckout(packageRoot = getPackageRoot()): boolean {
  return existsSync(join(packageRoot, '.git'));
}

export async function loadNativeReleaseManifest(
  packageRoot = getPackageRoot(),
  version?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NativeReleaseManifest> {
  const url = await resolveNativeManifestUrl(packageRoot, version, env);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`[native-assets] failed to fetch native release manifest (${response.status} ${response.statusText}) from ${url}`);
  }
  return await response.json() as NativeReleaseManifest;
}

function isUnavailableManifestError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\[native-assets\] failed to fetch native release manifest/i.test(error.message)
    || /fetch failed/i.test(error.message);
}

function isUnavailableArchiveError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\[native-assets\] failed to download /i.test(error.message)
    || /fetch failed/i.test(error.message);
}

async function downloadFile(url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`[native-assets] failed to download ${url} (${response.status} ${response.statusText})`);
  }
  await mkdir(dirname(destinationPath), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destinationPath));
}

async function sha256ForFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

async function extractArchive(archivePath: string, destinationDir: string): Promise<void> {
  await mkdir(destinationDir, { recursive: true });
  const ext = extname(archivePath).toLowerCase();
  if (ext === '.zip') {
    const { result } = spawnPlatformCommandSync(
      process.platform === 'win32' ? 'powershell' : 'unzip',
      process.platform === 'win32'
        ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destinationDir.replace(/'/g, "''")}' -Force`]
        : ['-oq', archivePath, '-d', destinationDir],
      { encoding: 'utf-8' },
    );
    if (result.status !== 0 || result.error) {
      throw new Error(`[native-assets] failed to extract zip archive ${archivePath}: ${(result.stderr || result.error?.message || '').trim()}`);
    }
    return;
  }

  const { result } = spawnPlatformCommandSync('tar', ['-xf', archivePath, '-C', destinationDir], { encoding: 'utf-8' });
  if (result.status !== 0 || result.error) {
    throw new Error(`[native-assets] failed to extract archive ${archivePath}: ${(result.stderr || result.error?.message || '').trim()}`);
  }
}

async function findExtractedBinaryPath(rootDir: string, binaryPath: string): Promise<string | undefined> {
  const normalizedNeedle = binaryPath.replaceAll('\\', '/');
  const exactCandidate = join(rootDir, binaryPath);
  if (existsSync(exactCandidate)) return exactCandidate;

  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      const relative = fullPath.slice(rootDir.length + 1).replaceAll('\\', '/');
      if (relative === normalizedNeedle || relative.endsWith(`/${normalizedNeedle}`)) {
        return fullPath;
      }
    }
  }

  return undefined;
}

async function publishCachedNativeBinary(
  sourcePath: string,
  destinationPath: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const destinationDir = dirname(destinationPath);
  await mkdir(destinationDir, { recursive: true });
  const tempPath = join(
    destinationDir,
    `.${basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const checksumPath = resolveCachedNativeBinaryChecksumPath(destinationPath);
  const checksumTempPath = `${tempPath}.sha256`;
  try {
    await copyFile(sourcePath, tempPath);
    if (platform !== 'win32') chmodSync(tempPath, 0o755);
    await writeFile(checksumTempPath, `${await sha256ForFile(tempPath)}\n`, { mode: 0o600 });

    for (const publishedPath of [destinationPath, checksumPath]) {
      try {
        if ((await stat(publishedPath)).isDirectory()) {
          await rm(publishedPath, { recursive: true, force: true });
        }
      } catch {
        // Missing paths and unreadable stale entries are handled by rename below.
      }
    }

    await rename(tempPath, destinationPath);
    await rename(checksumTempPath, checksumPath);
  } finally {
    await rm(tempPath, { force: true });
    await rm(checksumTempPath, { force: true });
  }
}

export async function hydrateNativeBinary(
  product: NativeProduct,
  options: HydrateNativeBinaryOptions = {},
): Promise<string | undefined> {
  const {
    packageRoot = getPackageRoot(),
    env = process.env,
    platform = process.platform,
    arch = process.arch,
  } = options;

  if (!['linux', 'darwin', 'win32'].includes(platform)) return undefined;
  if (!['x64', 'arm64'].includes(arch)) return undefined;

  const version = await getPackageVersion(packageRoot);
  let legacyCachedBinaryPath: string | undefined;
  for (const cachedBinaryPath of resolveCachedNativeBinaryCandidatePaths(product, version, platform, arch, env)) {
    const cacheState = await inspectCachedNativeBinary(cachedBinaryPath);
    if (cacheState === 'verified') return cachedBinaryPath;
    if (cacheState === 'legacy') legacyCachedBinaryPath ??= cachedBinaryPath;
  }
  if (env[NATIVE_AUTO_FETCH_ENV]?.trim() === '0') return legacyCachedBinaryPath;

  let manifest: NativeReleaseManifest;
  try {
    manifest = await loadNativeReleaseManifest(packageRoot, version, env);
  } catch (error) {
    if (isUnavailableManifestError(error)) return legacyCachedBinaryPath;
    throw error;
  }
  const assets = resolveNativeReleaseAssetCandidates(manifest, product, version, platform, arch, {
    linuxLibcPreference: platform === 'linux' ? resolveLinuxNativeLibcPreference({ env }) : undefined,
  });
  if (assets.length === 0) return legacyCachedBinaryPath;

  const tempRoot = await mkdtemp(join(tmpdir(), `${product}-${platform}-${arch}-`));
  const extractDir = join(tempRoot, 'extract');

  try {
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index]!;
      const archivePath = join(tempRoot, asset.archive);
      const cachedBinaryPath = resolveCachedNativeBinaryPath(
        product,
        version,
        platform,
        arch,
        env,
        inferNativeAssetLibc(asset),
      );
      try {
        await downloadFile(asset.download_url, archivePath);
        const archiveStat = await stat(archivePath);
        if (typeof asset.size === 'number' && asset.size > 0 && archiveStat.size !== asset.size) {
          throw new Error(`[native-assets] downloaded archive size mismatch for ${asset.archive}`);
        }
        const digest = await sha256ForFile(archivePath);
        if (digest !== asset.sha256) {
          throw new Error(`[native-assets] checksum mismatch for ${asset.archive}`);
        }

        await extractArchive(archivePath, extractDir);
        const extractedBinaryPath = await findExtractedBinaryPath(extractDir, asset.binary_path);
        if (!extractedBinaryPath) {
          throw new Error(`[native-assets] extracted archive missing expected binary ${asset.binary_path}`);
        }

        await publishCachedNativeBinary(extractedBinaryPath, cachedBinaryPath, platform);
        return cachedBinaryPath;
      } catch (error) {
        if (isUnavailableArchiveError(error)) {
          await rm(archivePath, { force: true });
          await rm(extractDir, { recursive: true, force: true });
          if (index < assets.length - 1) continue;
          if (legacyCachedBinaryPath) return legacyCachedBinaryPath;
        }
        throw error;
      }
    }
    return undefined;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
