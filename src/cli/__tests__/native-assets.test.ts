import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  hydrateNativeBinary,
  inferNativeAssetLibc,
  resolveCachedNativeBinaryCandidatePaths,
  resolveCachedNativeBinaryPath,
  type NativeReleaseManifest,
  resolveNativeReleaseAssetCandidates,
  resolveNativeReleaseBaseUrl,
} from '../native-assets.js';

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
    assert.deepEqual(
      resolveCachedNativeBinaryCandidatePaths('omx-sparkshell', '0.8.15', 'linux', 'x64', {
        OMX_NATIVE_CACHE_DIR: '/tmp/omx-native-cache',
      }, {
        linuxLibcPreference: ['musl', 'glibc'],
      }),
      [
        '/tmp/omx-native-cache/0.8.15/linux-x64-musl/omx-sparkshell/omx-sparkshell',
        '/tmp/omx-native-cache/0.8.15/linux-x64-glibc/omx-sparkshell/omx-sparkshell',
        '/tmp/omx-native-cache/0.8.15/linux-x64/omx-sparkshell/omx-sparkshell',
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
      const archive = spawnSync('tar', ['-czf', archivePath, '-C', stagingDir, 'omx-sparkshell'], { encoding: 'utf-8' });
      assert.equal(archive.status, 0, archive.stderr || archive.stdout);
      const archiveBuffer = await readFile(archivePath);

      const manifest = {
        version: '0.8.15',
        tag: 'v0.8.15',
        assets: [
          {
            product: 'omx-sparkshell',
            version: '0.8.15',
            platform: 'linux',
            arch: 'x64',
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
      const archive = spawnSync('tar', ['-czf', archivePath, '-C', join(wd, 'staging'), 'omx-sparkshell-x86_64-unknown-linux-musl'], { encoding: 'utf-8' });
      assert.equal(archive.status, 0, archive.stderr || archive.stdout);
      const archiveBuffer = await readFile(archivePath);

      const manifest = {
        version: '0.8.15',
        tag: 'v0.8.15',
        assets: [
          {
            product: 'omx-sparkshell',
            version: '0.8.15',
            platform: 'linux',
            arch: 'x64',
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
