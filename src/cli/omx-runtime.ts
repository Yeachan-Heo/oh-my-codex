#!/usr/bin/env node

import { existsSync, realpathSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  getPackageVersion,
  hydrateNativeBinary,
  resolveCachedNativeBinaryCandidatePaths,
} from './native-assets.js';
import { getPackageRoot } from '../utils/package.js';

const PRODUCT = 'omx-runtime';
const SELF_PATH = fileURLToPath(import.meta.url);

function binaryName(): string {
  return platform() === 'win32' ? `${PRODUCT}.exe` : PRODUCT;
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((candidate) => existsSync(candidate));
}

function isSelfReference(candidate: string): boolean {
  if (candidate === PRODUCT) return true;
  if (!existsSync(candidate)) return false;
  try {
    return realpathSync(candidate) === realpathSync(SELF_PATH);
  } catch {
    return resolve(candidate) === resolve(SELF_PATH);
  }
}

async function resolveRuntimeBinary(): Promise<string | undefined> {
  const override = process.env.OMX_RUNTIME_BINARY?.trim();
  if (override && !isSelfReference(override)) return override;

  const packageRoot = getPackageRoot();
  const name = binaryName();
  const version = await getPackageVersion(packageRoot).catch(() => undefined);
  if (version) {
    const cached = firstExisting(
      resolveCachedNativeBinaryCandidatePaths(PRODUCT, version, platform(), arch(), process.env),
    );
    if (cached) return cached;
  }

  const packaged = firstExisting([
    join(packageRoot, 'bin', 'native', `${platform()}-${arch()}`, name),
    join(packageRoot, 'target', 'release', name),
    join(packageRoot, 'crates', PRODUCT, 'target', 'release', name),
  ]);
  if (packaged) return packaged;

  return await hydrateNativeBinary(PRODUCT, { packageRoot });
}

const runtimeBinary = await resolveRuntimeBinary();
if (!runtimeBinary) {
  console.error(
    [
      '[omx-runtime] Native runtime binary is not installed for this platform.',
      '[omx-runtime] Try: omx update',
      '[omx-runtime] Or set OMX_RUNTIME_BINARY to a compatible omx-runtime binary.',
    ].join('\n'),
  );
  process.exit(127);
}

const child = spawnSync(runtimeBinary, process.argv.slice(2), {
  stdio: 'inherit',
  windowsHide: true,
});

if (child.error) {
  console.error(`[omx-runtime] Failed to launch ${runtimeBinary}: ${child.error.message}`);
  process.exit(127);
}

process.exit(child.status ?? 1);
