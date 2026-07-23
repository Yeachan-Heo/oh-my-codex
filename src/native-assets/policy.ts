export type NativeArchiveEntryType = 'file' | 'directory';

export interface NativeReleaseAssetPolicyInput {
  product: string;
  version: string;
  platform: string;
  arch: string;
  target: string;
  libc?: string;
  archive: string;
  binary: string;
  binary_path: string;
  sha256: string;
  size?: number;
  download_url: string;
}

export interface NativeReleaseManifestPolicyInput {
  manifest_version?: number;
  version: string;
  tag?: string;
  assets: NativeReleaseAssetPolicyInput[];
}

export interface NativeTargetMapping {
  platform: string;
  arch: string;
  libc?: string;
}

/** Products that must be accepted by release-manifest generation and verification. */
export const NATIVE_RELEASE_PRODUCTS = ['omx-explore-harness', 'omx-sparkshell', 'omx-api', 'omx-runtime'] as const;

/** Products exposed through the runtime hydration APIs. */
export const NATIVE_HYDRATABLE_PRODUCTS = ['omx-explore-harness', 'omx-sparkshell', 'omx-api'] as const;

const NATIVE_RELEASE_PRODUCT_SET = new Set<string>(NATIVE_RELEASE_PRODUCTS);
const NATIVE_ARCHIVE_SUFFIXES = ['.tar.xz', '.tar.gz', '.zip'] as const;

function nativeArchiveSuffix(basename: string): string | undefined {
  return NATIVE_ARCHIVE_SUFFIXES.find((suffix) => basename.toLowerCase().endsWith(suffix));
}

function archiveHintMismatch(asset: NativeReleaseAssetPolicyInput, basename: string): boolean {
  const stem = basename.slice(0, -nativeArchiveSuffix(basename)!.length);
  const hintedTarget = Object.keys(TARGET_MAPPINGS).find((target) => stem.includes(target));
  if (hintedTarget && hintedTarget !== asset.target) return true;

  const hasHint = (hint: string) => new RegExp(`(?:^|-)${hint}(?:-|$)`).test(stem);
  if ((hasHint('linux') && asset.platform !== 'linux')
    || (hasHint('darwin') && asset.platform !== 'darwin')
    || ((hasHint('windows') || hasHint('win32') || hasHint('msvc')) && asset.platform !== 'win32')
    || ((hasHint('x86_64') || hasHint('x64')) && asset.arch !== 'x64')
    || ((hasHint('aarch64') || hasHint('arm64')) && asset.arch !== 'arm64')
    || (hasHint('musl') && asset.libc !== 'musl')
    || ((hasHint('gnu') || hasHint('glibc')) && asset.libc !== 'glibc')) return true;
  return false;
}

export function nativeProductBinaryName(product: string): string | undefined {
  if (!NATIVE_RELEASE_PRODUCT_SET.has(product)) return undefined;
  return product;
}

export function nativeProductBinaryPath(product: string, platform: string): string | undefined {
  const binary = nativeProductBinaryName(product);
  return binary && `${binary}${platform === 'win32' ? '.exe' : ''}`;
}

const TARGET_MAPPINGS: Readonly<Record<string, NativeTargetMapping>> = {
  'x86_64-unknown-linux-gnu': { platform: 'linux', arch: 'x64', libc: 'glibc' },
  'aarch64-unknown-linux-gnu': { platform: 'linux', arch: 'arm64', libc: 'glibc' },
  'x86_64-unknown-linux-musl': { platform: 'linux', arch: 'x64', libc: 'musl' },
  'aarch64-unknown-linux-musl': { platform: 'linux', arch: 'arm64', libc: 'musl' },
  'x86_64-apple-darwin': { platform: 'darwin', arch: 'x64' },
  'aarch64-apple-darwin': { platform: 'darwin', arch: 'arm64' },
  'x86_64-pc-windows-msvc': { platform: 'win32', arch: 'x64' },
  'aarch64-pc-windows-msvc': { platform: 'win32', arch: 'arm64' },
};

function policyError(code: string, detail: string): Error {
  return new Error(`[native-assets] ${code}: ${detail}`);
}

function requiredString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

export function normalizeNativeArchivePath(path: string, type: NativeArchiveEntryType): string {
  if (typeof path !== 'string' || path.length === 0) throw policyError('archive_path_invalid', 'path is empty');
  if (/[\u0000-\u001f\u007f\u0080-\u009f\\]/.test(path)) throw policyError('archive_path_invalid', path);
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw policyError('archive_path_absolute', path);

  const terminalSlash = path.endsWith('/');
  if (type === 'file' && terminalSlash) throw policyError('archive_path_type_mismatch', path);
  const body = terminalSlash ? path.slice(0, -1) : path;
  if (!body || body.endsWith('/') || body.includes('//')) throw policyError('archive_path_invalid', path);
  const segments = body.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) throw policyError('archive_path_traversal', path);
  return body;
}

export function assertSafeNativeArchiveEntries(entries: Iterable<{ path: string; type: NativeArchiveEntryType }>): void {
  const paths = new Map<string, NativeArchiveEntryType>();
  for (const entry of entries) {
    const normalized = normalizeNativeArchivePath(entry.path, entry.type);
    if (paths.has(normalized)) throw policyError('archive_path_duplicate', normalized);
    for (const existing of paths) {
      const [existingPath, existingType] = existing;
      if ((existingType === 'file' && normalized.startsWith(`${existingPath}/`))
        || (entry.type === 'file' && existingPath.startsWith(`${normalized}/`))) {
        throw policyError('archive_path_prefix_collision', normalized);
      }
    }
    paths.set(normalized, entry.type);
  }
}

export function nativeTargetMapping(target: string): NativeTargetMapping | undefined {
  return TARGET_MAPPINGS[target];
}

export function nativeReleaseAssetLogicalKey(asset: Pick<NativeReleaseAssetPolicyInput, 'product' | 'version' | 'platform' | 'arch' | 'libc'>): string {
  return [asset.product, asset.version, asset.platform, asset.arch, asset.libc ?? ''].join('\u0000');
}

export function nativeReleaseAssetBasename(asset: Pick<NativeReleaseAssetPolicyInput, 'archive'>): string {
  return normalizeNativeArchivePath(asset.archive, 'file').split('/').at(-1)!;
}

export function validateNativeReleaseManifest(manifest: NativeReleaseManifestPolicyInput): void {
  if (!manifest || typeof manifest !== 'object' || manifest.manifest_version !== 1 || !requiredString(manifest.version)
    || manifest.version.startsWith('v') || manifest.tag !== `v${manifest.version}` || !Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw policyError('manifest_invalid', 'manifest_version, non-v version, exact tag, and assets are required');
  }

  const logicalKeys = new Set<string>();
  const basenames = new Set<string>();
  for (const asset of manifest.assets) {
    if (!asset || typeof asset !== 'object' || !requiredString(asset.version) || asset.version !== manifest.version) {
      throw policyError('manifest_version_mismatch', asset?.archive || 'unknown');
    }
    const requiredStrings: Array<keyof NativeReleaseAssetPolicyInput> = [
      'product', 'platform', 'arch', 'target', 'archive', 'binary', 'binary_path', 'sha256', 'download_url',
    ];
    if (requiredStrings.some((field) => !requiredString(asset[field]))) {
      throw policyError('manifest_invalid_asset', asset.archive || 'unknown');
    }
    const assetSize = asset.size;
    if (!/^[a-f0-9]{64}$/.test(asset.sha256) || assetSize === undefined || !Number.isSafeInteger(assetSize) || assetSize <= 0) {
      throw policyError('manifest_invalid_integrity', asset.archive);
    }
    const mapping = nativeTargetMapping(asset.target);
    if (!mapping || mapping.platform !== asset.platform || mapping.arch !== asset.arch
      || (mapping.platform === 'linux' ? asset.libc !== mapping.libc : asset.libc !== undefined)) {
      throw policyError('manifest_target_mismatch', asset.target || asset.archive);
    }
    const expectedBinary = nativeProductBinaryName(asset.product);
    const expectedBinaryPath = nativeProductBinaryPath(asset.product, asset.platform);
    if (!expectedBinary || !expectedBinaryPath || asset.binary !== expectedBinary) {
      throw policyError('manifest_binary_product_mismatch', asset.binary);
    }

    const binaryPath = normalizeNativeArchivePath(asset.binary_path, 'file');
    if (binaryPath !== asset.binary_path || binaryPath.split('/').at(-1) !== expectedBinaryPath) {
      throw policyError('manifest_binary_basename_mismatch', asset.binary_path);
    }

    const key = nativeReleaseAssetLogicalKey(asset);
    if (logicalKeys.has(key)) throw policyError('manifest_duplicate_logical_key', asset.archive);
    logicalKeys.add(key);
    const basename = nativeReleaseAssetBasename(asset);
    if (asset.archive !== basename || !nativeArchiveSuffix(basename)) {
      throw policyError('manifest_archive_invalid', asset.archive);
    }
    if (archiveHintMismatch(asset, basename)) throw policyError('manifest_archive_hint_mismatch', basename);
    if (basenames.has(basename)) throw policyError('manifest_duplicate_archive_basename', basename);
    basenames.add(basename);
    let downloadUrl: URL;
    try {
      downloadUrl = new URL(asset.download_url);
    } catch {
      throw policyError('manifest_invalid_url', asset.download_url);
    }
    if ((downloadUrl.protocol !== 'https:' && downloadUrl.protocol !== 'http:')
      || downloadUrl.pathname.split('/').at(-1) !== basename) {
      throw policyError('manifest_url_basename_mismatch', asset.download_url);
    }
  }
}
