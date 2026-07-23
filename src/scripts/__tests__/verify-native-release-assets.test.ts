import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { compress as xzCompress } from '@napi-rs/lzma/xz';
import * as tar from 'tar-stream';
import * as yazl from 'yazl';
import { fileURLToPath } from 'node:url';

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function verify(manifest: string, artifacts: string) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('../verify-native-release-assets.js', import.meta.url)), '--manifest', manifest, '--artifacts-dir', artifacts], { encoding: 'utf-8' });
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const output: Buffer[] = [];
  for await (const chunk of stream) output.push(Buffer.from(chunk));
  return Buffer.concat(output);
}

async function tarArchive(entries: Array<{ name: string; data?: Buffer; type?: tar.Headers['type']; linkname?: string }>, format: 'tar.gz' | 'tar.xz'): Promise<Buffer> {
  const archive = tar.pack();
  for (const item of entries) {
    const header: tar.Headers = { name: item.name, type: item.type ?? 'file', size: item.data?.length ?? 0, linkname: item.linkname };
    if ((item.type ?? 'file') === 'file') archive.entry(header, item.data ?? Buffer.alloc(0));
    else archive.entry(header);
  }
  archive.finalize();
  const raw = await collect(archive);
  return format === 'tar.gz' ? gzipSync(raw) : xzCompress(raw);
}

async function zipArchive(entries: Array<{ name: string; data?: Buffer }>): Promise<Buffer> {
  const archive = new yazl.ZipFile();
  for (const item of entries) {
    if (item.name.endsWith('/')) archive.addEmptyDirectory(item.name);
    else archive.addBuffer(item.data ?? Buffer.alloc(0), item.name);
  }
  archive.end();
  return collect(archive.outputStream);
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (-(crc & 1) & 0xedb88320);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function rawZip(name: string, mode: number, dosAttributes = 0, data = Buffer.alloc(0)): Buffer {
  const fileName = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt32LE((((mode & 0xffff) << 16) | dosAttributes) >>> 0, 38);

  const directoryOffset = local.length + fileName.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(directoryOffset, 16);
  return Buffer.concat([local, fileName, data, central, fileName, end]);
}

function manifestFor(archive: string, content: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    manifest_version: 1,
    version: '0.8.15',
    tag: 'v0.8.15',
    assets: [{
      product: 'omx-api', version: '0.8.15', platform: 'linux', arch: 'x64', target: 'x86_64-unknown-linux-musl', libc: 'musl',
      archive, binary: 'omx-api', binary_path: 'omx-api', sha256: sha256(content), size: content.length,
      download_url: `https://example.invalid/${archive}`,
      ...overrides,
    }],
  };
}

async function verifyArchive(root: string, archive: string, content: Buffer, overrides: Record<string, unknown> = {}, manifestOverrides: Record<string, unknown> = {}) {
  await writeFile(join(root, archive), content);
  const manifest = join(root, `${archive}.manifest.json`);
  await writeFile(manifest, JSON.stringify({ ...manifestFor(archive, content, overrides), ...manifestOverrides }));
  return verify(manifest, root);
}

describe('verify-native-release-assets', () => {
  it('accepts tar.gz, tar.xz, and zip archives with one wrapped regular binary', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-verify-native-release-'));
    try {
      for (const format of ['tar.gz', 'tar.xz', 'zip'] as const) {
        const artifacts = join(wd, format.replace('.', '-'));
        await mkdir(artifacts, { recursive: true });
        const archive = `omx-api-x86_64-unknown-linux-musl.${format}`;
        const content = format === 'zip'
          ? await zipArchive([{ name: 'wrapper/', data: Buffer.alloc(0) }, { name: 'wrapper/omx-api', data: Buffer.from('x') }])
          : await tarArchive([{ name: 'wrapper/', type: 'directory' }, { name: 'wrapper/omx-api', data: Buffer.from('x') }], format);
        assert.equal((await verifyArchive(artifacts, archive, content)).status, 0, format);
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects unsafe unrelated paths and links before selecting a binary', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-verify-native-release-unsafe-'));
    try {
      for (const [index, unsafe] of ['../escape', '/absolute', 'C:/drive', 'dir\\backslash'].entries()) {
        const archive = `unsafe-${index}.tar.gz`;
        const content = await tarArchive([{ name: 'omx-api', data: Buffer.from('x') }, { name: unsafe, data: Buffer.from('x') }], 'tar.gz');
        assert.notEqual((await verifyArchive(wd, archive, content)).status, 0, unsafe);
      }
      const linked = await tarArchive([{ name: 'omx-api', data: Buffer.from('x') }, { name: 'link', type: 'symlink', linkname: 'omx-api' }], 'tar.gz');
      assert.notEqual((await verifyArchive(wd, 'linked.tar.gz', linked)).status, 0);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects ZIP entries with contradictory Unix types and directory markers', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-verify-native-release-zip-types-'));
    try {
      const malformed = [
        rawZip('regular/', 0o100644),
        rawZip('regular', 0o100644, 0x10),
        rawZip('directory', 0o040755),
      ];
      for (const [index, content] of malformed.entries()) {
        assert.notEqual((await verifyArchive(wd, `zip-types-${index}.zip`, content)).status, 0);
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous, colliding, and zero-byte selected members', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-verify-native-release-selection-'));
    try {
      const cases = [
        await tarArchive([{ name: 'one/omx-api', data: Buffer.from('x') }, { name: 'two/omx-api', data: Buffer.from('x') }], 'tar.gz'),
        await tarArchive([{ name: 'omx-api', data: Buffer.from('x') }, { name: 'omx-api/config', data: Buffer.from('x') }], 'tar.gz'),
        await tarArchive([{ name: 'omx-api', data: Buffer.alloc(0) }], 'tar.gz'),
      ];
      for (const [index, content] of cases.entries()) {
        assert.notEqual((await verifyArchive(wd, `selection-${index}.tar.gz`, content)).status, 0);
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('enforces manifest version, target, libc, and basename coherence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-verify-native-release-manifest-'));
    try {
      const content = await tarArchive([{ name: 'omx-api', data: Buffer.from('x') }], 'tar.gz');
      const invalid = [
        [{}, { manifest_version: undefined }],
        [{}, { version: 'v0.8.15', tag: 'vv0.8.15' }],
        [{}, { tag: 'v0.8.16' }],
        [{ platform: 'darwin', arch: 'x64', target: 'x86_64-apple-darwin', libc: 'musl' }, {}],
        [{ product: 'omx-unknown' }, {}],
        [{ binary: 'omx-api.exe' }, {}],
        [{ binary_path: '../omx-api' }, {}],
        [{ archive: 'nested/omx-api-x86_64-unknown-linux-musl.tar.gz' }, {}],
        [{ archive: 'omx-api-x86_64-unknown-linux-musl.tar.bz2' }, {}],
        [{ archive: 'omx-api-x86_64-unknown-linux-gnu.tar.gz' }, {}],
        [{ archive: 'omx-api-aarch64-unknown-linux-musl.tar.gz' }, {}],
      ] as const;
      for (const [index, [assetOverrides, documentOverrides]] of invalid.entries()) {
        assert.notEqual((await verifyArchive(wd, `manifest-${index}.tar.gz`, content, assetOverrides, documentOverrides)).status, 0);
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
