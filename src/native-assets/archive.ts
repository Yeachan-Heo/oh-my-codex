import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { decompress } from '@napi-rs/lzma/xz';
import * as tar from 'tar-stream';
import * as yauzl from 'yauzl';
import {
  assertSafeNativeArchiveEntries,
  normalizeNativeArchivePath,
  type NativeArchiveEntryType,
} from './policy.js';

export interface NativeArchiveEntry {
  /** Original archive member name, retained for diagnostics and exact extraction. */
  rawName: string;
  /** Safe, separator-normalized logical member name. */
  normalizedName: string;
  /** @deprecated Use normalizedName. */
  path: string;
  type: NativeArchiveEntryType;
  size: number;
}

function archiveError(code: string, detail: string): Error {
  return new Error(`[native-assets] ${code}: ${detail}`);
}

function archiveFormat(archivePath: string): 'tar.xz' | 'tar.gz' | 'zip' {
  if (/\.tar\.xz$/i.test(archivePath)) return 'tar.xz';
  if (/\.tar\.gz$/i.test(archivePath)) return 'tar.gz';
  if (/\.zip$/i.test(archivePath)) return 'zip';
  throw archiveError('archive_format_unsupported', archivePath);
}

function entry(rawName: string, type: NativeArchiveEntryType, size: number): NativeArchiveEntry {
  if (!Number.isSafeInteger(size) || size < 0) throw archiveError('archive_inspection_failed', `invalid entry size: ${rawName}`);
  const normalizedName = normalizeNativeArchivePath(rawName, type);
  return { rawName, normalizedName, path: normalizedName, type, size };
}

async function tarInput(archivePath: string, format: 'tar.xz' | 'tar.gz'): Promise<Readable> {
  try {
    const archive = readFileSync(archivePath);
    return Readable.from(format === 'tar.gz' ? gunzipSync(archive) : await decompress(archive));
  } catch (error) {
    throw archiveError('archive_inspection_failed', error instanceof Error ? error.message : archivePath);
  }
}

async function inspectTar(archivePath: string, format: 'tar.xz' | 'tar.gz'): Promise<NativeArchiveEntry[]> {
  const entries: NativeArchiveEntry[] = [];
  const extractor = tar.extract();
  extractor.on('entry', (header, source, next) => {
    try {
      if (header.type !== 'file' && header.type !== 'directory') throw archiveError('archive_entry_unsupported', header.name);
      entries.push(entry(header.name, header.type, header.size ?? 0));
      source.resume();
      source.once('end', next);
    } catch (error) {
      source.resume();
      next(error);
    }
  });
  try {
    await pipeline(await tarInput(archivePath, format), extractor);
  } catch (error) {
    throw archiveError('archive_inspection_failed', error instanceof Error ? error.message : archivePath);
  }
  assertSafeNativeArchiveEntries(entries);
  return entries;
}

function openZip(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { autoClose: false, lazyEntries: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) reject(archiveError('archive_inspection_failed', error?.message || archivePath));
      else resolve(zip);
    });
  });
}

function zipEntryType(candidate: yauzl.Entry): NativeArchiveEntryType {
  const modeType = (candidate.externalFileAttributes >>> 16) & 0o170000;
  const trailingSlash = candidate.fileName.endsWith('/');
  const dosDirectory = (candidate.externalFileAttributes & 0x10) !== 0;
  const unixModeIsExplicit = (candidate.versionMadeBy >>> 8) === 3 && modeType !== 0;

  if (unixModeIsExplicit) {
    if (modeType === 0o100000) {
      if (trailingSlash || dosDirectory) throw archiveError('archive_entry_unsupported', candidate.fileName);
      return 'file';
    }
    if (modeType === 0o040000) {
      if (!trailingSlash) throw archiveError('archive_entry_unsupported', candidate.fileName);
      return 'directory';
    }
    throw archiveError('archive_entry_unsupported', candidate.fileName);
  }

  if (modeType !== 0 && modeType !== 0o100000 && modeType !== 0o040000) {
    throw archiveError('archive_entry_unsupported', candidate.fileName);
  }
  if (trailingSlash !== dosDirectory) throw archiveError('archive_entry_unsupported', candidate.fileName);
  return trailingSlash ? 'directory' : 'file';
}

async function inspectZip(archivePath: string): Promise<NativeArchiveEntry[]> {
  const zip = await openZip(archivePath);
  const entries: NativeArchiveEntry[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      zip.once('error', reject);
      zip.on('entry', (candidate: yauzl.Entry) => {
        try {
          entries.push(entry(candidate.fileName, zipEntryType(candidate), candidate.uncompressedSize));
          zip.readEntry();
        } catch (error) {
          reject(error);
        }
      });
      zip.once('end', resolve);
      zip.readEntry();
    });
  } catch (error) {
    throw archiveError('archive_inspection_failed', error instanceof Error ? error.message : archivePath);
  } finally {
    zip.close();
  }
  assertSafeNativeArchiveEntries(entries);
  return entries;
}

export async function inspectNativeArchive(archivePath: string): Promise<NativeArchiveEntry[]> {
  const format = archiveFormat(archivePath);
  return format === 'zip' ? inspectZip(archivePath) : inspectTar(archivePath, format);
}

export function selectNativeArchiveBinary(entries: readonly NativeArchiveEntry[], binaryPath: string): NativeArchiveEntry {
  const expected = normalizeNativeArchivePath(binaryPath, 'file');
  const exact = entries.filter((candidate) => candidate.type === 'file' && candidate.normalizedName === expected);
  const wrapped = entries.filter((candidate) => candidate.type === 'file'
    && candidate.normalizedName.endsWith(`/${expected}`)
    && candidate.normalizedName.split('/').length === expected.split('/').length + 1);
  const candidates = [...exact, ...wrapped];
  if (candidates.length !== 1) throw archiveError('archive_binary_ambiguous', expected);
  if (candidates[0]!.size <= 0) throw archiveError('archive_binary_empty', candidates[0]!.normalizedName);
  return candidates[0]!;
}

async function streamTarMember(archivePath: string, format: 'tar.xz' | 'tar.gz', rawName: string): Promise<Readable> {
  const output = new PassThrough();
  const extractor = tar.extract();
  let found = false;
  extractor.on('entry', (header, source, next) => {
    if (header.name !== rawName) {
      source.resume();
      source.once('end', next);
      return;
    }
    found = true;
    source.once('error', next);
    source.once('end', next);
    source.pipe(output, { end: false });
  });
  void pipeline(await tarInput(archivePath, format), extractor).then(() => {
    if (!found) output.destroy(archiveError('archive_binary_missing', rawName));
    else output.end();
  }, (error) => output.destroy(archiveError('archive_stream_failed', error instanceof Error ? error.message : rawName)));
  return output;
}

async function streamZipMember(archivePath: string, rawName: string): Promise<Readable> {
  const zip = await openZip(archivePath);
  let selected: yauzl.Entry | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.once('error', reject);
      zip.on('entry', (candidate: yauzl.Entry) => {
        if (candidate.fileName === rawName) selected = candidate;
        zip.readEntry();
      });
      zip.once('end', resolve);
      zip.readEntry();
    });
    if (!selected) throw archiveError('archive_binary_missing', rawName);
    return await new Promise<Readable>((resolve, reject) => {
      zip.openReadStream(selected!, (error, source) => {
        if (error || !source) reject(archiveError('archive_stream_failed', error?.message || rawName));
        else {
          source.once('end', () => zip.close());
          source.once('error', () => zip.close());
          resolve(source);
        }
      });
    });
  } catch (error) {
    zip.close();
    throw error;
  }
}

export async function streamSelectedNativeArchiveMember(archivePath: string, memberPath: string): Promise<Readable> {
  const entries = await inspectNativeArchive(archivePath);
  const member = normalizeNativeArchivePath(memberPath, 'file');
  const selected = entries.find((candidate) => candidate.type === 'file' && candidate.normalizedName === member);
  if (!selected) throw archiveError('archive_binary_missing', member);
  if (selected.size <= 0) throw archiveError('archive_binary_empty', member);
  const format = archiveFormat(archivePath);
  return format === 'zip' ? streamZipMember(archivePath, selected.rawName) : streamTarMember(archivePath, format, selected.rawName);
}

export async function writeSelectedNativeArchiveMember(archivePath: string, memberPath: string, destinationPath: string): Promise<number> {
  const entries = await inspectNativeArchive(archivePath);
  const member = normalizeNativeArchivePath(memberPath, 'file');
  const selected = entries.find((candidate) => candidate.type === 'file' && candidate.normalizedName === member);
  if (!selected) throw archiveError('archive_binary_missing', member);
  if (selected.size <= 0) throw archiveError('archive_binary_empty', member);
  const source = await streamSelectedNativeArchiveMember(archivePath, member);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    const bytes = Buffer.from(chunk);
    chunks.push(bytes);
    size += bytes.length;
  }
  await mkdir(dirname(destinationPath), { recursive: true });
  try {
    if (size !== selected.size) throw archiveError('archive_binary_size_mismatch', member);
    await writeFile(destinationPath, Buffer.concat(chunks), { flag: 'wx' });
    return size;
  } catch (error) {
    await rm(destinationPath, { force: true, maxRetries: 5, retryDelay: 50 });
    throw error;
  }
}
