import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  hasSparkShellFallbackBanner,
  prepareLocalHydrationAssetDirectory,
  rewriteManifestDownloadUrls,
} from '../smoke-packed-install.mjs';

test('detects the sparkshell GLIBC fallback banner', () => {
  assert.equal(
    hasSparkShellFallbackBanner('[sparkshell] GLIBC-incompatible native sidecar detected; falling back to raw command execution without summary support.\n'),
    true,
  );
  assert.equal(hasSparkShellFallbackBanner('node v20.0.0\n'), false);
});

test('rewrites copied native manifest download urls to the local smoke server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-packed-install-'));
  try {
    const sourceDir = join(root, 'source-release-assets');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'omx-explore-harness-x86_64-unknown-linux-musl.tar.xz'), 'explore');
    await writeFile(join(sourceDir, 'omx-sparkshell-x86_64-unknown-linux-musl.tar.xz'), 'sparkshell');
    await writeFile(join(sourceDir, 'native-release-manifest.json'), JSON.stringify({
      version: '0.9.0',
      assets: [
        {
          product: 'omx-explore-harness',
          archive: 'omx-explore-harness-x86_64-unknown-linux-musl.tar.xz',
          download_url: 'https://github.com/example/omx-explore-harness-x86_64-unknown-linux-musl.tar.xz',
        },
        {
          product: 'omx-sparkshell',
          archive: 'omx-sparkshell-x86_64-unknown-linux-musl.tar.xz',
          download_url: 'https://github.com/example/omx-sparkshell-x86_64-unknown-linux-musl.tar.xz',
        },
      ],
    }, null, 2));

    const copiedDir = prepareLocalHydrationAssetDirectory(sourceDir, root);
    rewriteManifestDownloadUrls(join(copiedDir, 'native-release-manifest.json'), 'http://127.0.0.1:43123');

    const originalManifest = JSON.parse(await readFile(join(sourceDir, 'native-release-manifest.json'), 'utf-8'));
    const copiedManifest = JSON.parse(await readFile(join(copiedDir, 'native-release-manifest.json'), 'utf-8'));

    assert.match(originalManifest.assets[0].download_url, /^https:\/\/github\.com\//);
    assert.deepEqual(
      copiedManifest.assets.map((asset) => asset.download_url),
      [
        'http://127.0.0.1:43123/omx-explore-harness-x86_64-unknown-linux-musl.tar.xz',
        'http://127.0.0.1:43123/omx-sparkshell-x86_64-unknown-linux-musl.tar.xz',
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
