import { createHash } from 'node:crypto';
import { constants, createWriteStream, existsSync, readdirSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawnPlatformCommandSync } from '../utils/platform-command.js';
import { getPackageRoot } from '../utils/package.js';
import { validateNativeReleaseManifest } from '../native-assets/policy.js';
import { inspectNativeArchive, selectNativeArchiveBinary, writeSelectedNativeArchiveMember } from '../native-assets/archive.js';

export type NativeProduct = 'omx-explore-harness' | 'omx-sparkshell' | 'omx-api' | 'omx-runtime';
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
  const manifest = await response.json() as NativeReleaseManifest;
  validateNativeReleaseManifest(manifest as never);
  if (version && manifest.version !== version) throw new Error(`[native-assets] manifest version mismatch: expected ${version}, received ${manifest.version}`);
  return manifest;
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


const SIDECAR_SUFFIX = '.sha256';
const LOCK_SUFFIX = '.hydrate.lock';
const LOCK_WAIT_MS = 10_000;
const LOCK_RETRY_MS = 100;
const NATIVE_LOCK_WAIT_MS_ENV = 'OMX_NATIVE_LOCK_WAIT_MS';

const SHA256_LINE = /^[0-9a-f]{64}\n$/;

export type ManagedNativeBinaryState =
  | 'verified'
  | 'missing'
  | 'publication-in-progress'
  | 'binary-unsafe'
  | 'binary-empty'
  | 'orphan-checksum'
  | 'checksum-unsafe'
  | 'checksum-malformed'
  | 'checksum-mismatch'
  | 'legacy-unverified'
  | 'cache-descendant-unsafe'
  | 'inspection-race'
  | 'publication-lock-timeout'
  | 'cleanup-failed';

export interface NativeCacheLockDiagnostic {
  path: string;
  classification: 'valid-owner-record' | 'metadata-malformed' | 'lock-unsafe' | 'inspection-race' | 'metadata-unavailable';
  owner?: { pid: number; hostname: string; started_at: string; binary_path: string };
}

export interface ManagedNativeBinaryInspection {
  state: ManagedNativeBinaryState;
  /** Present only when opened-handle verification authorizes this exact binary. */
  path?: string;
  lock?: NativeCacheLockDiagnostic;
}

interface FileIdentity { dev: number | bigint; ino: number | bigint; size: number; }
interface OpenedFile extends FileIdentity { digest?: string; text?: string; }
interface PublicationLock { path: string; token: string; record: string; identity: FileIdentity; }

function sidecarPath(binaryPath: string): string { return `${binaryPath}${SIDECAR_SUFFIX}`; }
function lockPath(binaryPath: string): string { return `${binaryPath}${LOCK_SUFFIX}`; }
function sameFile(left: FileIdentity, right: FileIdentity): boolean { return left.dev === right.dev && left.ino === right.ino && left.size === right.size; }
function errno(error: unknown): string | undefined { return (error as NodeJS.ErrnoException).code; }
function uuid(): string { return crypto.randomUUID(); }
function absent(error: unknown): boolean { return errno(error) === 'ENOENT'; }
interface NativeAssetsTestHooks {
  beforeCreateParent?(path: string): Promise<void>;
}

let nativeAssetsTestHooks: NativeAssetsTestHooks | undefined;

/** Test-only seam for deterministic cache-parent creation races. */
export function setNativeAssetsTestHooksForTests(hooks: NativeAssetsTestHooks | undefined): () => void {
  const previousHooks = nativeAssetsTestHooks;
  nativeAssetsTestHooks = hooks;
  return () => { nativeAssetsTestHooks = previousHooks; };
}


function lockWaitMs(env: NodeJS.ProcessEnv): number {
  const configured = env[NATIVE_LOCK_WAIT_MS_ENV]?.trim();
  if (!configured) return LOCK_WAIT_MS;
  const value = Number(configured);
  return Number.isFinite(value) && value >= 0 ? value : LOCK_WAIT_MS;
}

function lockRecord(token: string, binaryPath: string): string {
  return `${JSON.stringify({
    version: 1,
    token,
    pid: process.pid,
    hostname: hostname(),
    started_at: new Date().toISOString(),
    binary_path: binaryPath,
  })}\n`;
}


function canonicalDescendantPath(path: string, configuredRoot: string, canonicalRoot: string): string {
  const resolvedPath = resolve(path);
  const canonicalRelative = relative(canonicalRoot, resolvedPath);
  if (canonicalRelative && canonicalRelative !== '..' && !canonicalRelative.startsWith(`..${sep}`)) return resolvedPath;
  const rel = relative(resolve(configuredRoot), resolvedPath);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('[native-assets] cache path escapes configured root');
  return join(canonicalRoot, rel);
}

async function canonicalCacheRoot(root: string, create: boolean): Promise<string | undefined> {
  try {
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    const entry = await lstat(root);
    if (!entry.isDirectory() && !entry.isSymbolicLink()) throw new Error('unsafe root');
    return await realpath(root); // The configured root itself is intentionally allowed to be a symlink.
  } catch (error) {
    if (!create && absent(error)) return undefined;
    throw error;
  }
}

async function validateDescendant(path: string, canonicalRoot: string, createParents: boolean): Promise<void> {
  const candidate = resolve(path);
  const rel = relative(canonicalRoot, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(canonicalRoot, rel) !== candidate) {
    throw new Error('[native-assets] cache path escapes configured root');
  }
  const parts = rel.split(sep).filter(Boolean);
  let current = canonicalRoot;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const isLeaf = index === parts.length - 1;
    try {
      const entry = await lstat(current);
      if (!isLeaf && (entry.isSymbolicLink() || !entry.isDirectory())) throw new Error(`[native-assets] cache descendant is unsafe: ${current}`);
    } catch (error) {
      if (!absent(error)) throw error;
      if (!createParents || isLeaf) continue;
      await nativeAssetsTestHooks?.beforeCreateParent?.(current);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (errno(error) !== 'EEXIST') throw error;
      }
      const created = await lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) throw new Error(`[native-assets] cache descendant is unsafe: ${current}`);
    }
  }
  try {
    const parent = await realpath(dirname(path));
    if (parent !== canonicalRoot && !parent.startsWith(`${canonicalRoot}${sep}`)) throw new Error('[native-assets] cache path escapes configured root');
  } catch (error) {
    if (!absent(error)) throw error;
  }
}

async function reInspectPath(path: string, identity: FileIdentity, requireNonEmpty: boolean): Promise<void> {
  try {
    const current = await lstat(path);
    if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1
      || (requireNonEmpty && current.size <= 0)
      || !sameFile(identity, { dev: current.dev, ino: current.ino, size: current.size })) {
      throw new Error('inspection race');
    }
  } catch (error) {
    if (absent(error)) throw new Error('inspection race');
    throw error;
  }
}

async function readOpenedFile(path: string, requireNonEmpty: boolean, hash: boolean, maxBytes?: number): Promise<OpenedFile> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) throw new Error('unsafe file');
  if (requireNonEmpty && before.size <= 0) throw new Error('empty file');
  if (maxBytes !== undefined && before.size > maxBytes) throw new Error('file too large');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    const identity = { dev: opened.dev, ino: opened.ino, size: opened.size };
    if (!opened.isFile() || opened.nlink !== 1 || (requireNonEmpty && opened.size <= 0)
      || (maxBytes !== undefined && opened.size > maxBytes)
      || !sameFile({ dev: before.dev, ino: before.ino, size: before.size }, identity)) throw new Error('inspection race');
    const chunks: Buffer[] = [];
    const digest = hash ? createHash('sha256') : undefined;
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes ?? 64 * 1024));
    let position = 0;
    while (position < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - position), position);
      if (bytesRead === 0) throw new Error('inspection race');
      const bytes = buffer.subarray(0, bytesRead);
      digest?.update(bytes);
      if (!hash) chunks.push(Buffer.from(bytes));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (!sameFile(identity, { dev: after.dev, ino: after.ino, size: after.size }) || after.nlink !== 1) throw new Error('inspection race');
    await reInspectPath(path, identity, requireNonEmpty);
    return { ...identity, digest: digest?.digest('hex'), text: hash ? undefined : Buffer.concat(chunks).toString('utf8') };
  } finally { await handle.close(); }
}

const MAX_SIDECAR_BYTES = 65;
const MAX_LOCK_RECORD_BYTES = 1024;

function validLockRecord(record: Record<string, unknown>, text: string, binaryPath: string): record is {
  version: 1; token: string; pid: number; hostname: string; started_at: string; binary_path: string;
} {
  if (record.version !== 1 || typeof record.token !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.token)
    || typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0
    || typeof record.hostname !== 'string' || !record.hostname.trim()
    || typeof record.started_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(record.started_at)
    || !Number.isFinite(Date.parse(record.started_at))
    || typeof record.binary_path !== 'string' || !record.binary_path.trim() || record.binary_path !== binaryPath) return false;
  return text === `${JSON.stringify(record)}\n`;
}

function sanitizeLockDiagnosticField(value: string): string {
  return value.replace(/[\r\n\t\0]/g, ' ').replace(/[^\x20-\x7e]/g, '?').slice(0, 512);
}


async function inspectLock(path: string, binaryPath: string): Promise<NativeCacheLockDiagnostic | undefined> {
  try {
    const file = await readOpenedFile(path, false, false, MAX_LOCK_RECORD_BYTES);
    const text = file.text || '';
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const record = {
      version: parsed.version,
      token: parsed.token,
      pid: parsed.pid,
      hostname: parsed.hostname,
      started_at: parsed.started_at,
      binary_path: parsed.binary_path,
    };
    if (!validLockRecord(record, text, binaryPath)) return { path, classification: 'metadata-malformed' };
    return {
      path,
      classification: 'valid-owner-record',
      owner: {
        pid: record.pid,
        hostname: sanitizeLockDiagnosticField(record.hostname),
        started_at: record.started_at,
        binary_path: sanitizeLockDiagnosticField(record.binary_path),
      },
    };
  } catch (error) {
    if (absent(error)) return undefined;
    const message = error instanceof Error ? error.message : '';
    return { path, classification: message.includes('race') ? 'inspection-race' : message.includes('unsafe') ? 'lock-unsafe' : error instanceof SyntaxError || message.includes('too large') ? 'metadata-malformed' : 'metadata-unavailable' };
  }
}


/** Inspects the exact B/S/L protocol. Only `verified` has a path. */
export async function inspectManagedNativeBinary(binaryPath: string, env: NodeJS.ProcessEnv = process.env): Promise<ManagedNativeBinaryInspection> {
  const configuredRoot = resolveNativeCacheRoot(env);
  let root: string | undefined;
  let effectiveBinaryPath: string;
  try {
    root = await canonicalCacheRoot(configuredRoot, false);
    if (!root) return { state: 'missing' };
    effectiveBinaryPath = canonicalDescendantPath(binaryPath, configuredRoot, root);
    await validateDescendant(effectiveBinaryPath, root, false);
    await validateDescendant(sidecarPath(effectiveBinaryPath), root, false);
    await validateDescendant(lockPath(effectiveBinaryPath), root, false);
  } catch (error) {
    return { state: error instanceof Error && error.message.includes('race') ? 'inspection-race' : 'cache-descendant-unsafe' };
  }
  const lockDiagnostic = await inspectLock(lockPath(effectiveBinaryPath!), effectiveBinaryPath!);
  try {
    await validateDescendant(effectiveBinaryPath!, root!, false);
    await validateDescendant(sidecarPath(effectiveBinaryPath!), root!, false);
    await validateDescendant(lockPath(effectiveBinaryPath!), root!, false);
  } catch {
    return { state: 'inspection-race' };
  }
  let binary: OpenedFile | undefined;
  try { binary = await readOpenedFile(effectiveBinaryPath!, true, true); } catch (error) {
    if (!absent(error)) {
      const message = error instanceof Error ? error.message : '';
      return { state: message.includes('empty') ? 'binary-empty' : message.includes('race') ? 'inspection-race' : 'binary-unsafe', lock: lockDiagnostic };
    }
    try { await lstat(sidecarPath(effectiveBinaryPath!)); return { state: 'orphan-checksum', lock: lockDiagnostic }; } catch (sidecarError) {
      if (!absent(sidecarError)) return { state: 'inspection-race', lock: lockDiagnostic };
      return { state: lockDiagnostic ? 'publication-in-progress' : 'missing', lock: lockDiagnostic };

    }
  }
  try { await validateDescendant(effectiveBinaryPath!, root!, false); } catch { return { state: 'inspection-race', lock: lockDiagnostic }; }
  let sidecar: OpenedFile;
  try { sidecar = await readOpenedFile(sidecarPath(effectiveBinaryPath!), true, false, MAX_SIDECAR_BYTES); } catch (error) {
    if (absent(error)) return { state: lockDiagnostic ? 'publication-in-progress' : 'legacy-unverified', lock: lockDiagnostic };
    return { state: error instanceof Error && error.message.includes('too large') ? 'checksum-malformed' : 'checksum-unsafe', lock: lockDiagnostic };
  }
  try { await validateDescendant(sidecarPath(effectiveBinaryPath!), root!, false); } catch { return { state: 'inspection-race', lock: lockDiagnostic }; }
  if (sidecar.size !== MAX_SIDECAR_BYTES || !SHA256_LINE.test(sidecar.text || '')) return { state: 'checksum-malformed', lock: lockDiagnostic };
  if (sidecar.text!.slice(0, 64) !== binary.digest) return { state: 'checksum-mismatch', lock: lockDiagnostic };
  return { state: 'verified', path: effectiveBinaryPath!, lock: lockDiagnostic };
}

async function acquireCacheLock(binaryPath: string, env: NodeJS.ProcessEnv): Promise<PublicationLock> {

  const path = lockPath(binaryPath);
  const started = performance.now();
  const deadline = started + lockWaitMs(env);

  for (;;) {
    const token = uuid();
    const record = lockRecord(token, binaryPath);

    const recordBytes = Buffer.from(record, 'utf8');
    try {
      const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const { bytesWritten } = await handle.write(recordBytes, 0, recordBytes.length, 0);
        if (bytesWritten !== recordBytes.length) throw new Error('[native-assets] incomplete lock write');
        const readback = Buffer.alloc(recordBytes.length);
        const { bytesRead } = await handle.read(readback, 0, readback.length, 0);
        if (bytesRead !== readback.length || !readback.equals(recordBytes)) throw new Error('[native-assets] lock readback mismatch');
        const identity = await handle.stat();
        const fileIdentity = { dev: identity.dev, ino: identity.ino, size: identity.size };
        if (!identity.isFile() || identity.nlink !== 1) throw new Error('[native-assets] unsafe publication lock');
        await reInspectPath(path, fileIdentity, true);
        return { path, token, record, identity: fileIdentity };

      } finally { await handle.close(); }
    } catch (error) {
      if (errno(error) !== 'EEXIST') throw error;
      if (performance.now() >= deadline) {
        const diagnostic = await inspectLock(path, binaryPath) ?? { path, classification: 'metadata-unavailable' as const };
        const owner = diagnostic.owner ? ` owner=${JSON.stringify(diagnostic.owner)}` : '';
        throw new Error(`[native-assets] publication-lock-timeout: ${path}; elapsed=${Math.round(performance.now() - started)}ms deadline=${lockWaitMs(env)}ms; ${diagnostic.classification}${owner}. Confirm no OMX hydration process is active for this cache key, remove only this named lock manually, then retry.`);
      }

      await new Promise<void>((done) => setTimeout(done, LOCK_RETRY_MS));
    }
  }
}

async function releaseCacheLock(lock: PublicationLock): Promise<ManagedNativeBinaryInspection | undefined> {
  try {
    const reopened = await readOpenedFile(lock.path, false, false);
    if (!sameFile(lock.identity, reopened) || reopened.text !== lock.record) return { state: 'cleanup-failed' };
    const current = await lstat(lock.path);
    if (!sameFile(lock.identity, { dev: current.dev, ino: current.ino, size: current.size }) || !current.isFile() || current.nlink !== 1) return { state: 'cleanup-failed' };
    await unlink(lock.path);
  } catch (error) { return absent(error) ? undefined : { state: 'cleanup-failed' }; }
  return undefined;
}

async function quarantineInvalid(path: string): Promise<void> {
  try {
    await lstat(path);
    await rename(path, `${path}.quarantine.${uuid()}`);
  } catch (error) { if (!absent(error)) throw error; }
}

async function publishManagedNativeBinary(source: string, destination: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const configuredRoot = resolveNativeCacheRoot(env);
  const root = await canonicalCacheRoot(configuredRoot, true);
  if (!root) throw new Error('[native-assets] unable to create cache root');
  destination = canonicalDescendantPath(destination, configuredRoot, root);
  await validateDescendant(destination, root, true);
  const lock = await acquireCacheLock(destination, env);
  const attempt = uuid();
  const tempBinary = join(dirname(destination), `.${attempt}.tmp.bin`);
  const tempSidecar = join(dirname(destination), `.${attempt}.tmp.sha256`);
  const revalidatePublicationPaths = async (): Promise<void> => {
    await validateDescendant(destination, root, false);
    await validateDescendant(sidecarPath(destination), root, false);
    await validateDescendant(lock.path, root, false);
    await validateDescendant(tempBinary, root, false);
    await validateDescendant(tempSidecar, root, false);
  };
  let primaryError: unknown;
  try {
    await revalidatePublicationPaths();
    const existing = await inspectManagedNativeBinary(destination, env);
    if (existing.state === 'verified') return existing.path;
    await copyFile(source, tempBinary, constants.COPYFILE_EXCL);
    await revalidatePublicationPaths();
    if (platform !== 'win32') await chmod(tempBinary, 0o755);
    const binary = await readOpenedFile(tempBinary, true, true);
    const sidecar = `${binary.digest}\n`;
    const handle = await open(tempSidecar, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(sidecar, 'utf8'); } finally { await handle.close(); }
    if ((await readOpenedFile(tempSidecar, true, false, MAX_SIDECAR_BYTES)).text !== sidecar) throw new Error('[native-assets] temporary checksum verification failed');
    await revalidatePublicationPaths();
    await quarantineInvalid(destination);
    await revalidatePublicationPaths();
    await quarantineInvalid(sidecarPath(destination));
    await revalidatePublicationPaths();
    await rename(tempBinary, destination);
    await revalidatePublicationPaths();
    await rename(tempSidecar, sidecarPath(destination));
    await revalidatePublicationPaths();
    const final = await inspectManagedNativeBinary(destination, env);
    await revalidatePublicationPaths();
    if (final.state !== 'verified') throw new Error(`[native-assets] cache publication verification failed: ${final.state}`);
    return final.path;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupFailures: string[] = [];
    try { await revalidatePublicationPaths(); } catch (error) {
      cleanupFailures.push(`revalidate publication paths: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const temporary of [tempBinary, tempSidecar]) {
      try { await rm(temporary, { force: true }); } catch (error) {
        cleanupFailures.push(`remove ${temporary}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const lockCleanup = await releaseCacheLock(lock);
    if (lockCleanup) cleanupFailures.push(`${lockCleanup.state}: publication lock was retained`);
    if (cleanupFailures.length > 0) {
      const evidence = `[native-assets] cleanup evidence: ${cleanupFailures.join('; ')}`;
      if (primaryError instanceof Error) primaryError.message += `\n${evidence}`;
      else throw new Error(evidence);
    }
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

  if (env[NATIVE_AUTO_FETCH_ENV]?.trim() === '0') return undefined;
  if (!['linux', 'darwin', 'win32'].includes(platform)) return undefined;
  if (!['x64', 'arm64'].includes(arch)) return undefined;

  const version = await getPackageVersion(packageRoot);
  for (const cachedBinaryPath of resolveCachedNativeBinaryCandidatePaths(product, version, platform, arch, env)) {
    const inspected = await inspectManagedNativeBinary(cachedBinaryPath, env);
    if (inspected.state === 'verified') return inspected.path!;
  }

  let manifest: NativeReleaseManifest;
  try {
    manifest = await loadNativeReleaseManifest(packageRoot, version, env);
  } catch (error) {
    if (isUnavailableManifestError(error)) return undefined;
    throw error;
  }
  const assets = resolveNativeReleaseAssetCandidates(manifest, product, version, platform, arch, {
    linuxLibcPreference: platform === 'linux' ? resolveLinuxNativeLibcPreference({ env }) : undefined,
  });
  if (assets.length === 0) return undefined;

  const tempRoot = await mkdtemp(join(tmpdir(), `${product}-${platform}-${arch}-`));
  const extractedBinaryPath = join(tempRoot, 'native-binary');

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

        const archiveEntries = await inspectNativeArchive(archivePath);
        const archiveBinary = selectNativeArchiveBinary(archiveEntries, asset.binary_path);
        await writeSelectedNativeArchiveMember(archivePath, archiveBinary.path, extractedBinaryPath);

        const published = await publishManagedNativeBinary(extractedBinaryPath, cachedBinaryPath, platform, env);
        if (published) return published;
        throw new Error(`[native-assets] cache publication verification failed for ${cachedBinaryPath}`);
      } catch (error) {
        if (index < assets.length - 1 && isUnavailableArchiveError(error)) {
          await rm(archivePath, { force: true });
          await rm(extractedBinaryPath, { force: true });
          continue;
        }
        throw error;
      }
    }
    return undefined;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
