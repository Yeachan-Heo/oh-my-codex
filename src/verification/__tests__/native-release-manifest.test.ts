import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar-stream';
import * as yazl from 'yazl';
import { validateNativeReleaseManifest } from '../../native-assets/policy.js';


async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function makeTarGz(binaryName: string, contents: string): Promise<Buffer> {
  const archive = tar.pack();
  archive.entry({ name: binaryName, type: 'file', size: Buffer.byteLength(contents) }, Buffer.from(contents));
  archive.finalize();
  return gzipSync(await collect(archive));
}
async function makeZip(binaryName: string, contents: string): Promise<Buffer> {
  const archive = new yazl.ZipFile();
  archive.addBuffer(Buffer.from(contents), binaryName);
  archive.end();
  return collect(archive.outputStream);
}


describe('native release manifest generator', () => {
  it('annotates Linux libc variants and sorts musl assets before glibc fallbacks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-native-release-manifest-'));
    try {
      const artifactsDir = join(root, 'artifacts');
      await mkdir(artifactsDir, { recursive: true });

      const muslArchive = 'omx-sparkshell-x86_64-unknown-linux-musl.tar.gz';
      const glibcArchive = 'omx-sparkshell-x86_64-unknown-linux-gnu.tar.gz';
      const muslBytes = await makeTarGz('omx-sparkshell', 'musl');
      const glibcBytes = await makeTarGz('omx-sparkshell', 'glibc');
      await writeFile(join(artifactsDir, muslArchive), muslBytes);
      await writeFile(join(artifactsDir, `${muslArchive}.sha256`), `${createHash('sha256').update(muslBytes).digest('hex')}  ${muslArchive}\n`);
      await writeFile(join(artifactsDir, glibcArchive), glibcBytes);
      await writeFile(join(artifactsDir, `${glibcArchive}.sha256`), `${createHash('sha256').update(glibcBytes).digest('hex')}  ${glibcArchive}\n`);

      const planPath = join(root, 'dist-plan.json');
      await writeFile(planPath, JSON.stringify({
        announcement_tag: 'v0.10.2',
        releases: [
          { app_name: 'omx-sparkshell', app_version: '0.10.2' },
        ],
        artifacts: {
          linuxGlibc: {
            kind: 'executable-zip',
            name: glibcArchive,
            checksum: `${glibcArchive}.sha256`,
            target_triples: ['x86_64-unknown-linux-gnu'],
            assets: [
              {
                kind: 'executable',
                name: 'omx-sparkshell',
                path: 'omx-sparkshell',
              },
            ],
          },
          linuxMusl: {
            kind: 'executable-zip',
            name: muslArchive,
            checksum: `${muslArchive}.sha256`,
            target_triples: ['x86_64-unknown-linux-musl'],
            assets: [
              {
                kind: 'executable',
                name: 'omx-sparkshell',
                path: 'omx-sparkshell',
              },
            ],
          },
        },
      }, null, 2));

      const outputPath = join(root, 'native-release-manifest.json');
      const result = spawnSync(process.execPath, [
        join(process.cwd(), 'dist', 'scripts', 'generate-native-release-manifest.js'),
        '--plan',
        planPath,
        '--artifacts-dir',
        artifactsDir,
        '--out',
        outputPath,
        '--release-base-url',
        'https://github.com/example/releases/download/v0.10.2',
      ], {
        cwd: process.cwd(),
        encoding: 'utf-8',
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const manifest = JSON.parse(await readFile(outputPath, 'utf-8')) as {
        assets: Array<{ archive: string; libc?: string; target?: string }>;
      };
      assert.deepEqual(
        manifest.assets.map((asset) => asset.archive),
        [muslArchive, glibcArchive],
      );
      assert.deepEqual(
        manifest.assets.map((asset) => asset.libc),
        ['musl', 'glibc'],
      );
      assert.deepEqual(
        manifest.assets.map((asset) => asset.target),
        ['x86_64-unknown-linux-musl', 'x86_64-unknown-linux-gnu'],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the executable path basename for Windows cargo-dist assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-native-release-manifest-windows-'));
    try {
      const artifactsDir = join(root, 'artifacts');
      await mkdir(artifactsDir, { recursive: true });
      const archiveName = 'omx-api-x86_64-pc-windows-msvc.zip';
      const archiveBytes = await makeZip('omx-api.exe', 'windows');
      await writeFile(join(artifactsDir, archiveName), archiveBytes);
      await writeFile(join(artifactsDir, `${archiveName}.sha256`), `${createHash('sha256').update(archiveBytes).digest('hex')}  ${archiveName}\n`);
      const planPath = join(root, 'dist-plan.json');
      await writeFile(planPath, JSON.stringify({
        announcement_tag: 'v0.10.2',
        releases: [{ app_name: 'omx-api', app_version: '0.10.2' }],
        artifacts: {
          windows: {
            kind: 'executable-zip',
            name: archiveName,
            checksum: `${archiveName}.sha256`,
            target_triples: ['x86_64-pc-windows-msvc'],
            assets: [{ kind: 'executable', id: 'omx-api-exe-x86_64-pc-windows-msvc', name: 'omx-api', path: 'omx-api.exe' }],
          },
        },
      }));
      const outputPath = join(root, 'native-release-manifest.json');
      const result = spawnSync(process.execPath, [
        join(process.cwd(), 'dist', 'scripts', 'generate-native-release-manifest.js'),
        '--plan', planPath,
        '--artifacts-dir', artifactsDir,
        '--out', outputPath,
        '--release-base-url', 'https://github.com/example/releases/download/v0.10.2',
      ], { cwd: process.cwd(), encoding: 'utf-8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const manifest = JSON.parse(await readFile(outputPath, 'utf-8')) as { assets: Array<Record<string, unknown>> };
      const asset = manifest.assets[0]!;
      assert.equal(asset.product, 'omx-api');
      assert.equal(asset.binary, 'omx-api');
      assert.equal(asset.binary_path, 'omx-api.exe');
      assert.equal(asset.target, 'x86_64-pc-windows-msvc');
      assert.equal(asset.platform, 'win32');
      assert.equal(asset.arch, 'x64');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('generates and verifies a complete cargo-dist release manifest, including non-hydratable omx-runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-native-release-manifest-full-'));
    try {
      const artifactsDir = join(root, 'artifacts');
      await mkdir(artifactsDir, { recursive: true });
      const artifacts = [
        { key: 'apiWindows', product: 'omx-api', target: 'x86_64-pc-windows-msvc', archive: 'omx-api-x86_64-pc-windows-msvc.zip', binaryPath: 'omx-api.exe', format: 'zip' as const },
        { key: 'exploreLinux', product: 'omx-explore-harness', target: 'x86_64-unknown-linux-musl', archive: 'omx-explore-harness-x86_64-unknown-linux-musl.tar.gz', binaryPath: 'omx-explore-harness', format: 'tar.gz' as const },
        { key: 'runtimeLinux', product: 'omx-runtime', target: 'x86_64-unknown-linux-musl', archive: 'omx-runtime-x86_64-unknown-linux-musl.tar.gz', binaryPath: 'omx-runtime', format: 'tar.gz' as const },
        { key: 'sparkshellLinux', product: 'omx-sparkshell', target: 'x86_64-unknown-linux-musl', archive: 'omx-sparkshell-x86_64-unknown-linux-musl.tar.gz', binaryPath: 'omx-sparkshell', format: 'tar.gz' as const },
      ];
      for (const artifact of artifacts) {
        const bytes = artifact.format === 'zip'
          ? await makeZip(artifact.binaryPath, artifact.product)
          : await makeTarGz(artifact.binaryPath, artifact.product);
        await writeFile(join(artifactsDir, artifact.archive), bytes);
        await writeFile(join(artifactsDir, `${artifact.archive}.sha256`), `${createHash('sha256').update(bytes).digest('hex')}  ${artifact.archive}\n`);
      }
      const planPath = join(root, 'dist-plan.json');
      await writeFile(planPath, JSON.stringify({
        announcement_tag: 'v0.20.3',
        releases: artifacts.map(({ product }) => ({ app_name: product, app_version: '0.20.3' })),
        artifacts: Object.fromEntries(artifacts.map((artifact) => [artifact.key, {
          kind: 'executable-zip',
          name: artifact.archive,
          checksum: `${artifact.archive}.sha256`,
          target_triples: [artifact.target],
          assets: [{ kind: 'executable', name: artifact.product, path: artifact.binaryPath }],
        }])),
      }));
      const outputPath = join(root, 'native-release-manifest.json');
      const generated = spawnSync(process.execPath, [
        join(process.cwd(), 'dist', 'scripts', 'generate-native-release-manifest.js'),
        '--plan', planPath,
        '--artifacts-dir', artifactsDir,
        '--out', outputPath,
        '--release-base-url', 'https://github.com/example/releases/download/v0.20.3',
        '--require-products', 'omx-api,omx-explore-harness,omx-sparkshell',
      ], { cwd: process.cwd(), encoding: 'utf-8' });
      assert.equal(generated.status, 0, generated.stderr || generated.stdout);
      const manifest = JSON.parse(await readFile(outputPath, 'utf-8')) as { assets: Array<{ product: string; binary: string; binary_path: string }> };
      assert.deepEqual(new Set(manifest.assets.map((asset) => asset.product)), new Set(artifacts.map((artifact) => artifact.product)));
      const windowsApi = manifest.assets.find((asset) => asset.product === 'omx-api');
      assert.equal(windowsApi?.binary, 'omx-api');
      assert.equal(windowsApi?.binary_path, 'omx-api.exe');
      const verified = spawnSync(process.execPath, [
        join(process.cwd(), 'dist', 'scripts', 'verify-native-release-assets.js'),
        '--manifest', outputPath,
        '--artifacts-dir', artifactsDir,
      ], { cwd: process.cwd(), encoding: 'utf-8' });
      assert.equal(verified.status, 0, verified.stderr || verified.stdout);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects the same closed-product, binary, path, suffix, and archive-hint violations as release verification', () => {
    const asset = {
      product: 'omx-api', version: '0.8.15', platform: 'linux', arch: 'x64', target: 'x86_64-unknown-linux-musl', libc: 'musl',
      archive: 'omx-api-x86_64-unknown-linux-musl.tar.gz', binary: 'omx-api', binary_path: 'omx-api', sha256: 'a'.repeat(64), size: 1,
      download_url: 'https://example.invalid/omx-api-x86_64-unknown-linux-musl.tar.gz',
    };
    const assertInvalid = (assetOverrides: Record<string, unknown> = {}, documentOverrides: Record<string, unknown> = {}) => {
      assert.throws(() => validateNativeReleaseManifest({
        manifest_version: 1,
        version: '0.8.15',
        tag: 'v0.8.15',
        assets: [{ ...asset, ...assetOverrides }],
        ...documentOverrides,
      } as never));
    };

    assertInvalid({}, { manifest_version: undefined });
    assertInvalid({}, { version: 'v0.8.15', tag: 'vv0.8.15' });
    assertInvalid({}, { tag: 'v0.8.16' });
    assertInvalid({ platform: 'darwin', arch: 'x64', target: 'x86_64-apple-darwin', libc: 'musl' });
    assertInvalid({ product: 'omx-unknown' });
    assertInvalid({ binary: 'omx-api.exe' });
    assertInvalid({ binary_path: '../omx-api' });
    assertInvalid({ archive: 'nested/omx-api-x86_64-unknown-linux-musl.tar.gz' });
    assertInvalid({ archive: 'omx-api-x86_64-unknown-linux-musl.tar.bz2' });
    assertInvalid({ archive: 'omx-api-x86_64-unknown-linux-gnu.tar.gz' });
    assertInvalid({ archive: 'omx-api-aarch64-unknown-linux-musl.tar.gz' });
  });
});
