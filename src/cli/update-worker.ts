import { appendFile, readFile, realpath, rm } from 'node:fs/promises';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { isAbsolute, join, relative } from 'node:path';
import { runNpmCommand, type PackageManagerOwnership } from './package-manager-ownership.js';

type DeferredUpdatePayload = {
  cwd: string;
  logPath: string;
  parentPid: number;
  ownership: PackageManagerOwnership;
  setupArgs: string[];
};

const PACKAGE_NAME = 'oh-my-codex';
const installSource = `${PACKAGE_NAME}@latest`;
const installOptions: SpawnSyncOptions = {
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 120000,
  windowsHide: true,
};

function within(root: string, path: string): boolean {
  const relation = relative(root, path);
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation);
}

function stableInstallArgs(ownership: PackageManagerOwnership): string[] {
  return ['install', '--global', '--ignore-scripts', '--no-audit', '--no-progress', '--prefix', ownership.npmPrefix!, installSource];
}

function output(result: ReturnType<typeof spawnSync>): string | null {
  return result.error || result.status !== 0 ? null : String(result.stdout || '').trim() || null;
}

function waitForParent(parentPid: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        clearInterval(timer);
        resolve();
      }
    }, 1000);
  });
}

async function validatePackage(ownership: PackageManagerOwnership): Promise<string | null> {
  if (!ownership.packageRoot) return null;
  const packageRoot = await realpath(join(ownership.globalInstallRoot, PACKAGE_NAME));
  if (packageRoot !== ownership.packageRoot) return null;
  let bin: string | undefined;
  try {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf-8')) as {
      bin?: string | Record<string, string>;
    };
    bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.omx;
  } catch {
    bin = join('dist', 'cli', 'omx.js');
  }
  if (typeof bin !== 'string' || bin.trim() === '' || isAbsolute(bin)) return null;
  const entry = await realpath(join(packageRoot, bin));
  return within(packageRoot, entry) ? entry : null;
}

async function validateManager(ownership: PackageManagerOwnership): Promise<boolean> {
  if (ownership.manager === 'npm') {
    const root = output(runNpmCommand(ownership.npmCommand!, ['root', '-g'], { ...installOptions, env: ownership.environment }));
    const prefix = output(runNpmCommand(ownership.npmCommand!, ['prefix', '-g'], { ...installOptions, env: ownership.environment }));
    return root === ownership.globalInstallRoot && prefix === ownership.npmPrefix;
  }
  const bin = output(spawnSync(ownership.bunCommand, ['pm', 'bin', '-g'], { ...installOptions, env: ownership.environment }));
  if (!bin) return false;
  try {
    return await realpath(bin) === ownership.bunGlobalBin;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  if (!payloadPath) process.exitCode = 1;
  if (!payloadPath) return;
  let payload: DeferredUpdatePayload | null = null;
  try {
    payload = JSON.parse(await readFile(payloadPath, 'utf-8')) as DeferredUpdatePayload;
    await waitForParent(payload.parentPid);
    if (!payload.ownership.npmPrefix || !payload.ownership.packageRoot || !payload.ownership.environment || (payload.ownership.manager === 'npm' && !payload.ownership.npmCommand)) throw new Error('Frozen transaction payload is incomplete.');
    if (!await validateManager(payload.ownership)) throw new Error('Frozen package-manager command, root, or prefix no longer validates.');
    if (!await validatePackage(payload.ownership)) throw new Error('Frozen installed package/bin validation failed before update.');
    const result = payload.ownership.manager === 'npm'
      ? runNpmCommand(payload.ownership.npmCommand!, stableInstallArgs(payload.ownership), { ...installOptions, env: payload.ownership.environment! })
      : spawnSync(payload.ownership.bunCommand, stableInstallArgs(payload.ownership), { ...installOptions, env: payload.ownership.environment! });
    if (result.error || result.status !== 0) throw new Error(String(result.stderr || result.error?.message || 'controller install failed'));
    const cliEntry = await validatePackage(payload.ownership);
    if (!cliEntry) throw new Error('Installed package/bin validation failed after update.');
    const setup = spawnSync(process.execPath, [cliEntry, ...payload.setupArgs], {
      cwd: payload.cwd, env: payload.ownership.environment!, stdio: 'inherit', windowsHide: true,
    });
    if (setup.error || setup.status !== 0) throw new Error(setup.error?.message || `setup exited ${setup.status}`);
  } catch (error) {
    if (payload) await appendFile(payload.logPath, `[omx] Deferred update failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await rm(payloadPath, { force: true }).catch(() => undefined);
  }
}

void main();
