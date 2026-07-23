import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { compress as xzCompress } from '@napi-rs/lzma/xz';
import * as tar from 'tar-stream';
import * as yazl from 'yazl';
import {
  hydrateNativeBinary,
  inferNativeAssetLibc,
  inspectManagedNativeBinary,
  isRepositoryCheckout,
  resolveCachedNativeBinaryCandidatePaths,
  resolveCachedNativeBinaryPath,
  type NativeReleaseManifest,
  resolveNativeReleaseAssetCandidates,
  resolveNativeReleaseBaseUrl,
} from '../native-assets.js';
import {
  assertSafeNativeArchiveEntries,
  normalizeNativeArchivePath,
  validateNativeReleaseManifest,
} from '../../native-assets/policy.js';
import { inspectNativeArchive, selectNativeArchiveBinary } from '../../native-assets/archive.js';

async function startStaticServer(root: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const filePath = join(root, url.pathname.replace(/^\//, ''));
    try {
      const body = await readFile(filePath);
      res.writeHead(200);
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('missing');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function makeTar(entries: Array<{ name: string; data?: Buffer; type?: tar.Headers['type']; linkname?: string }>, format: 'tar.gz' | 'tar.xz' = 'tar.gz'): Promise<Buffer> {
  const archive = tar.pack();
  for (const item of entries) {
    const type = item.type ?? 'file';
    const header: tar.Headers = { name: item.name, type, size: type === 'file' ? item.data?.length ?? 0 : 0, linkname: item.linkname };
    if (type === 'file') archive.entry(header, item.data ?? Buffer.alloc(0));
    else archive.entry(header);
  }
  archive.finalize();
  const raw = await collect(archive);
  return format === 'tar.gz' ? gzipSync(raw) : await xzCompress(raw);
}

async function makeZip(entries: Array<{ name: string; data?: Buffer }>): Promise<Buffer> {
  const archive = new yazl.ZipFile();
  for (const item of entries) {
    if (item.name.endsWith('/')) archive.addEmptyDirectory(item.name);
    else archive.addBuffer(item.data ?? Buffer.alloc(0), item.name);
  }
  archive.end();
  return collect(archive.outputStream);
}


async function writeManagedBinary(binaryPath: string, contents = 'native-binary'): Promise<void> {
  await mkdir(dirname(binaryPath), { recursive: true });
  await writeFile(binaryPath, contents);
}

async function writeManagedSidecar(binaryPath: string, contents: string): Promise<void> {
  await mkdir(dirname(binaryPath), { recursive: true });
  await writeFile(`${binaryPath}.sha256`, contents);
}


describe('repository checkout detection', () => {
  it('does not treat an installed npm package that ships src/scripts as a source checkout', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-native-installed-'));
    try {
      const packageRoot = join(wd, 'node_modules', 'oh-my-codex');
      await mkdir(join(packageRoot, 'src', 'scripts'), { recursive: true });
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'oh-my-codex' }));

      assert.equal(isRepositoryCheckout(packageRoot), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('recognizes a git working tree as a source checkout', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-native-checkout-'));
    try {
      await mkdir(join(wd, '.git'), { recursive: true });
      await mkdir(join(wd, 'src'), { recursive: true });

      assert.equal(isRepositoryCheckout(wd), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('native asset helpers', () => {
  it('infers Linux libc variants from manifest metadata', () => {
    assert.equal(inferNativeAssetLibc({
      archive: 'omx-sparkshell-x86_64-unknown-linux-musl.tar.gz',
      target: 'x86_64-unknown-linux-musl',
      libc: undefined,
    }), 'musl');
    assert.equal(inferNativeAssetLibc({
      archive: 'omx-sparkshell-x86_64-unknown-linux-gnu.tar.gz',
      target: 'x86_64-unknown-linux-gnu',
      libc: undefined,
    }), 'glibc');
  });

  it('prefers musl cache paths before glibc and legacy Linux cache paths', () => {
    const cacheRoot = join(tmpdir(), 'omx-native-cache');
    assert.deepEqual(
      resolveCachedNativeBinaryCandidatePaths('omx-sparkshell', '0.8.15', 'linux', 'x64', {
        OMX_NATIVE_CACHE_DIR: cacheRoot,
      }, {
        linuxLibcPreference: ['musl', 'glibc'],
      }),
      [
        join(cacheRoot, '0.8.15', 'linux-x64-musl', 'omx-sparkshell', 'omx-sparkshell'),
        join(cacheRoot, '0.8.15', 'linux-x64-glibc', 'omx-sparkshell', 'omx-sparkshell'),
        join(cacheRoot, '0.8.15', 'linux-x64', 'omx-sparkshell', 'omx-sparkshell'),
      ],
    );
  });

  it('orders manifest assets musl-first for Linux hydration', () => {
    const manifest: NativeReleaseManifest = {
      version: '0.8.15',
      assets: [
        {
          product: 'omx-sparkshell',
          version: '0.8.15',
          platform: 'linux',
          arch: 'x64',
          target: 'x86_64-unknown-linux-gnu',
          libc: 'glibc',
          archive: 'omx-sparkshell-x86_64-unknown-linux-gnu.tar.gz',
          binary: 'omx-sparkshell',
          binary_path: 'omx-sparkshell',
          sha256: 'glibc',
          download_url: 'https://example.invalid/glibc',
        },
        {
          product: 'omx-sparkshell',
          version: '0.8.15',
          platform: 'linux',
          arch: 'x64',
          target: 'x86_64-unknown-linux-musl',
          libc: 'musl',
          archive: 'omx-sparkshell-x86_64-unknown-linux-musl.tar.gz',
          binary: 'omx-sparkshell',
          binary_path: 'omx-sparkshell',
          sha256: 'musl',
          download_url: 'https://example.invalid/musl',
        },
      ],
    };

    const ordered = resolveNativeReleaseAssetCandidates(manifest, 'omx-sparkshell', '0.8.15', 'linux', 'x64', {
      linuxLibcPreference: ['musl', 'glibc'],
    });
    assert.deepEqual(
      ordered.map((asset) => asset.archive),
      [
        'omx-sparkshell-x86_64-unknown-linux-musl.tar.gz',
        'omx-sparkshell-x86_64-unknown-linux-gnu.tar.gz',
      ],
    );
  });

  it('derives GitHub release base url from package.json repository + version', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-native-base-'));
    try {
      await writeFile(join(wd, 'package.json'), JSON.stringify({
        version: '0.8.15',
        repository: { url: 'git+https://github.com/Yeachan-Heo/oh-my-codex.git' },
      }));
      const base = await resolveNativeReleaseBaseUrl(wd, undefined, {});
      assert.equal(base, 'https://github.com/Yeachan-Heo/oh-my-codex/releases/download/v0.8.15');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('hydrates a native binary from the release manifest into the cache', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-native-hydrate-'));
    const cacheDir = join(wd, 'cache');
    const assetRoot = join(wd, 'assets');
    try {
      await mkdir(assetRoot, { recursive: true });
      await writeFile(join(wd, 'package.json'), JSON.stringify({
        version: '0.8.15',
        repository: { url: 'git+https://github.com/Yeachan-Heo/oh-my-codex.git' },
      }));

      const stagingDir = join(wd, 'staging');
      await mkdir(stagingDir, { recursive: true });
      const binaryPath = join(stagingDir, 'omx-sparkshell');
      await writeFile(binaryPath, '#!/bin/sh\necho hydrated\n');
      await chmod(binaryPath, 0o755);

      const archivePath = join(assetRoot, 'omx-sparkshell-x86_64-unknown-linux-musl.tar.gz');
      await writeFile(archivePath, await makeTar([{ name: 'omx-sparkshell', data: Buffer.from('#!/bin/sh\necho hydrated\n') }]));
      const archiveBuffer = await readFile(archivePath);

      const manifest = {
        manifest_version: 1,
        version: '0.8.15',
        tag: 'v0.8.15',
        assets: [
          {
            product: 'omx-sparkshell',
            version: '0.8.15',
            platform: 'linux',
            arch: 'x64',
            target: 'x86_64-unknown-linux-musl',
            libc: 'musl',
            archive: 'omx-sparkshell-x86_64-unknown-linux-musl.tar.gz',
            binary: 'omx-sparkshell',
            binary_path: 'omx-sparkshell',
            sha256: sha256(archiveBuffer),
            size: archiveBuffer.length,
            download_url: '',
          },
        ],
      };

      const server = await startStaticServer(assetRoot);
      try {
        manifest.assets[0].download_url = `${server.baseUrl}/${manifest.assets[0].archive}`;
        await writeFile(join(assetRoot, 'native-release-manifest.json'), JSON.stringify(manifest, null, 2));

        const hydrated = await hydrateNativeBinary('omx-sparkshell', {
          packageRoot: wd,
          env: {
            OMX_NATIVE_MANIFEST_URL: `${server.baseUrl}/native-release-manifest.json`,
            OMX_NATIVE_CACHE_DIR: cacheDir,
          },
          platform: 'linux',
          arch: 'x64',
        });

        assert.equal(hydrated, resolveCachedNativeBinaryPath('omx-sparkshell', '0.8.15', 'linux', 'x64', {
          OMX_NATIVE_CACHE_DIR: cacheDir,
        }, 'musl'));
        assert.equal(await readFile(hydrated!, 'utf-8'), '#!/bin/sh\necho hydrated\n');
      } finally {
        await server.close();
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('hydrates a native binary when the archive wraps files in a top-level directory', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-native-hydrate-nested-'));
    const cacheDir = join(wd, 'cache');
    const assetRoot = join(wd, 'assets');
    try {
      await mkdir(assetRoot, { recursive: true });
      await writeFile(join(wd, 'package.json'), JSON.stringify({
        version: '0.8.15',
        repository: { url: 'git+https://github.com/Yeachan-Heo/oh-my-codex.git' },
      }));

      const stagingDir = join(wd, 'staging', 'omx-sparkshell-x86_64-unknown-linux-musl');
      await mkdir(stagingDir, { recursive: true });
      const binaryPath = join(stagingDir, 'omx-sparkshell');
      await writeFile(binaryPath, '#!/bin/sh\necho hydrated-nested\n');
      await chmod(binaryPath, 0o755);

      const archivePath = join(assetRoot, 'omx-sparkshell-x86_64-unknown-linux-musl.tar.gz');
      await writeFile(archivePath, await makeTar([
        { name: 'omx-sparkshell-x86_64-unknown-linux-musl/', type: 'directory' },
        { name: 'omx-sparkshell-x86_64-unknown-linux-musl/omx-sparkshell', data: Buffer.from('#!/bin/sh\necho hydrated-nested\n') },
      ]));
      const archiveBuffer = await readFile(archivePath);

      const manifest = {
        manifest_version: 1,
        version: '0.8.15',
        tag: 'v0.8.15',
        assets: [
          {
            product: 'omx-sparkshell',
            version: '0.8.15',
            platform: 'linux',
            arch: 'x64',
            target: 'x86_64-unknown-linux-musl',
            libc: 'musl',
            archive: 'omx-sparkshell-x86_64-unknown-linux-musl.tar.gz',
            binary: 'omx-sparkshell',
            binary_path: 'omx-sparkshell',
            sha256: sha256(archiveBuffer),
            size: archiveBuffer.length,
            download_url: '',
          },
        ],
      };

      const server = await startStaticServer(assetRoot);
      try {
        manifest.assets[0].download_url = `${server.baseUrl}/${manifest.assets[0].archive}`;
        await writeFile(join(assetRoot, 'native-release-manifest.json'), JSON.stringify(manifest, null, 2));

        const hydrated = await hydrateNativeBinary('omx-sparkshell', {
          packageRoot: wd,
          env: {
            OMX_NATIVE_MANIFEST_URL: `${server.baseUrl}/native-release-manifest.json`,
            OMX_NATIVE_CACHE_DIR: cacheDir,
          },
          platform: 'linux',
          arch: 'x64',
        });

        assert.equal(hydrated, resolveCachedNativeBinaryPath('omx-sparkshell', '0.8.15', 'linux', 'x64', {
          OMX_NATIVE_CACHE_DIR: cacheDir,
        }, 'musl'));
        assert.equal(await readFile(hydrated!, 'utf-8'), '#!/bin/sh\necho hydrated-nested\n');
      } finally {
        await server.close();
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('returns undefined when the native release manifest is unavailable', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-native-hydrate-missing-manifest-'));
    try {
      await writeFile(join(wd, 'package.json'), JSON.stringify({
        version: '0.8.15',
        repository: { url: 'git+https://github.com/Yeachan-Heo/oh-my-codex.git' },
      }));

      const missingRoot = join(wd, 'missing-assets');
      await mkdir(missingRoot, { recursive: true });
      const server = await startStaticServer(missingRoot);
      try {
        const hydrated = await hydrateNativeBinary('omx-sparkshell', {
          packageRoot: wd,
          env: {
            OMX_NATIVE_MANIFEST_URL: `${server.baseUrl}/native-release-manifest.json`,
            OMX_NATIVE_CACHE_DIR: join(wd, 'cache'),
          },
          platform: 'linux',
          arch: 'x64',
        });
        assert.equal(hydrated, undefined);
      } finally {
        await server.close();
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('managed native binary inspection', () => {
  it('classifies B/S/L protocol states without accepting unverified cache files', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-native-inspect-'));
    const cacheDir = join(wd, 'cache');
    const env = { OMX_NATIVE_CACHE_DIR: cacheDir };
    const binaryPath = resolveCachedNativeBinaryPath('omx-sparkshell', '0.8.15', 'linux', 'x64', env);
    const lockPath = `${binaryPath}.hydrate.lock`;
    const cases: Array<{
      name: string;
      expected: string;
      setup: () => Promise<void>;
      expectedLock?: string;
    }> = [
      {
        name: 'missing B/S/L',
        expected: 'missing',
        setup: async () => undefined,
      },
      {
        name: 'legacy B without S',
        expected: 'legacy-unverified',
        setup: () => writeManagedBinary(binaryPath),
      },
      {
        name: 'verified B and exact S',
        expected: 'verified',
        setup: async () => {
          await writeManagedBinary(binaryPath);
          await writeManagedSidecar(binaryPath, `${sha256(Buffer.from('native-binary'))}\n`);
        },
      },
      {
        name: 'truncated S',
        expected: 'checksum-malformed',
        setup: async () => {
          await writeManagedBinary(binaryPath);
          await writeManagedSidecar(binaryPath, 'a'.repeat(64));
        },
      },
      {
        name: 'malformed S',
        expected: 'checksum-malformed',
        setup: async () => {
          await writeManagedBinary(binaryPath);
          await writeManagedSidecar(binaryPath, `${'z'.repeat(64)}\n`);
        },
      },
      {
        name: 'mismatched S',
        expected: 'checksum-mismatch',
        setup: async () => {
          await writeManagedBinary(binaryPath);
          await writeManagedSidecar(binaryPath, `${'0'.repeat(64)}\n`);
        },
      },
      {
        name: 'orphan S without B',
        expected: 'orphan-checksum',
        setup: () => writeManagedSidecar(binaryPath, `${'0'.repeat(64)}\n`),
      },
      {
        name: 'empty B',
        expected: 'binary-empty',
        setup: () => writeManagedBinary(binaryPath, ''),
      },
      {
        name: 'nonregular B',
        expected: 'binary-unsafe',
        setup: async () => { await mkdir(binaryPath, { recursive: true }); },
      },
      {
        name: 'valid L without B',
        expected: 'publication-in-progress',
        expectedLock: 'valid-owner-record',
        setup: async () => {
          await mkdir(dirname(binaryPath), { recursive: true });
          await writeFile(lockPath, `${JSON.stringify({
            version: 1,
            token: '00000000-0000-4000-8000-000000000000',
            pid: 1,
            hostname: 'test-host',
            started_at: '2026-01-01T00:00:00.000Z',
            binary_path: binaryPath,
          })}\n`);
        },
      },
    ];
    cases.push({
      name: 'hardlinked B',
      expected: 'binary-unsafe',
      setup: async () => {
        const source = join(wd, 'linked-source');
        await writeFile(source, 'native-binary');
        await mkdir(dirname(binaryPath), { recursive: true });
        await link(source, binaryPath);
      },
    });
    if (process.platform !== 'win32') {
      cases.push({
        name: 'symlinked B',
        expected: 'binary-unsafe',
        setup: async () => {
          const source = join(wd, 'symlink-source');
          await writeFile(source, 'native-binary');
          await mkdir(dirname(binaryPath), { recursive: true });
          await symlink(source, binaryPath);
        },
      });
    }
    try {
      for (const testCase of cases) {
        await rm(cacheDir, { recursive: true, force: true });
        await testCase.setup();
        const inspected = await inspectManagedNativeBinary(binaryPath, env);
        assert.equal(inspected.state, testCase.expected, testCase.name);
        if (testCase.expected === 'verified') assert.equal(inspected.path, await realpath(binaryPath));
        if (testCase.expectedLock) {
          assert.equal(inspected.lock?.classification, testCase.expectedLock, testCase.name);
          assert.equal(inspected.lock?.owner?.binary_path, binaryPath, testCase.name);
        }
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

describe('managed native binary lock diagnostics', () => {
  it('keeps a verified binary authoritative when the lock is unsafe', async () => {
    if (process.platform === 'win32') return;
    const wd = await mkdtemp(join(tmpdir(), 'omx-native-lock-diagnostic-'));
    const env = { OMX_NATIVE_CACHE_DIR: join(wd, 'cache') };
    const binaryPath = resolveCachedNativeBinaryPath('omx-sparkshell', '0.8.15', 'linux', 'x64', env);
    try {
      await writeManagedBinary(binaryPath);
      await writeManagedSidecar(binaryPath, `${sha256(Buffer.from('native-binary'))}\n`);
      await symlink(join(wd, 'missing-lock-target'), `${binaryPath}.hydrate.lock`);
      const inspected = await inspectManagedNativeBinary(binaryPath, env);
      assert.equal(inspected.state, 'verified');
      assert.equal(inspected.lock?.classification, 'lock-unsafe');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('treats an unsafe checksum entry as orphaned when the binary is absent', async () => {
    if (process.platform === 'win32') return;
    const wd = await mkdtemp(join(tmpdir(), 'omx-native-orphan-sidecar-'));
    const env = { OMX_NATIVE_CACHE_DIR: join(wd, 'cache') };
    const binaryPath = resolveCachedNativeBinaryPath('omx-sparkshell', '0.8.15', 'linux', 'x64', env);
    try {
      await mkdir(dirname(binaryPath), { recursive: true });
      await symlink(join(wd, 'missing-sidecar-target'), `${binaryPath}.sha256`);
      assert.equal((await inspectManagedNativeBinary(binaryPath, env)).state, 'orphan-checksum');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
});

describe('native archive policy', () => {
  it('rejects unsafe paths, duplicate logical manifest keys, and path collisions', () => {
    for (const path of ['../binary', '/binary', 'C:/binary', '//server/binary', 'dir\\binary', 'dir//binary']) {
      assert.throws(() => normalizeNativeArchivePath(path, 'file'));
    }
    assert.throws(() => assertSafeNativeArchiveEntries([
      { path: 'binary', type: 'file' },
      { path: 'binary/config', type: 'file' },
    ]));
    assert.throws(() => validateNativeReleaseManifest({
      version: '0.8.15',
      assets: [
        { product: 'omx-api', version: '0.8.15', platform: 'linux', arch: 'x64', target: 'x86_64-unknown-linux-musl', libc: 'musl', archive: 'one.tar.gz', binary: 'omx-api', binary_path: 'omx-api', sha256: 'a'.repeat(64), download_url: 'https://example.invalid/one' },
        { product: 'omx-api', version: '0.8.15', platform: 'linux', arch: 'x64', target: 'x86_64-unknown-linux-musl', libc: 'musl', archive: 'two.tar.gz', binary: 'omx-api', binary_path: 'omx-api', sha256: 'b'.repeat(64), download_url: 'https://example.invalid/two' },
      ],
    }));
  });

  it('inspects tar.xz, tar.gz, and zip archives before selecting a unique non-empty binary', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-native-archive-policy-'));
    try {
      const archives = new Map<string, Buffer>([
        ['tar.gz', await makeTar([{ name: 'wrapper/', type: 'directory' }, { name: 'wrapper/omx-api', data: Buffer.from('binary') }], 'tar.gz')],
        ['tar.xz', await makeTar([{ name: 'wrapper/', type: 'directory' }, { name: 'wrapper/omx-api', data: Buffer.from('binary') }], 'tar.xz')],
        ['zip', await makeZip([{ name: 'wrapper/' }, { name: 'wrapper/omx-api', data: Buffer.from('binary') }])],
      ]);
      for (const [suffix, bytes] of archives) {
        const archivePath = join(wd, `asset.${suffix}`);
        await writeFile(archivePath, bytes);
        const entries = await inspectNativeArchive(archivePath);
        assert.equal(selectNativeArchiveBinary(entries, 'omx-api').path, 'wrapper/omx-api');
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed for links, ambiguous matches, and zero-byte selected members', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-native-archive-adversarial-'));
    try {
      const archive = join(wd, 'unsafe.tar.gz');
      await writeFile(archive, await makeTar([
        { name: 'link', type: 'symlink', linkname: '/etc/passwd' },
      ]));
      await assert.rejects(() => inspectNativeArchive(archive));
      assert.throws(() => selectNativeArchiveBinary([
        { rawName: 'one/omx-api', normalizedName: 'one/omx-api', path: 'one/omx-api', type: 'file', size: 1 },
        { rawName: 'two/omx-api', normalizedName: 'two/omx-api', path: 'two/omx-api', type: 'file', size: 1 },
      ], 'omx-api'));
      assert.throws(() => selectNativeArchiveBinary([{ rawName: 'omx-api', normalizedName: 'omx-api', path: 'omx-api', type: 'file', size: 0 }], 'omx-api'));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
