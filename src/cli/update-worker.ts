import { appendFile, lstat, readFile, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { basename, isAbsolute, join, relative } from 'node:path';

import { isCompletePackageManagerOwnership, runNpmCommand, validatePackageManagerOwnership, type PackageManagerOwnership } from './package-manager-ownership.js';
import { writeUserInstallStamp } from '../scripts/postinstall-advisory.js';
import { omxUserInstallStampPath } from '../utils/paths.js';

type DeferredUpdatePayload = { cwd: string; logPath: string; parentPid: number; ownership: PackageManagerOwnership; setupArgs: string[] };
const PACKAGE_NAME = 'oh-my-codex';
const installSource = `${PACKAGE_NAME}@latest`;
const SKIP_NATIVE_AGENT_REFRESH_ENV = 'OMX_SKIP_NATIVE_AGENT_REFRESH';
const installOptions: SpawnSyncOptions = { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, windowsHide: true };


function within(root: string, path: string): boolean {
  const relation = relative(root, path);
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation);
}
function digest(contents: string): string { return createHash('sha256').update(contents).digest('hex'); }
function installArgs(ownership: PackageManagerOwnership): string[] {
  return ownership.manager === 'bun'
    ? ['add', '--global', '--ignore-scripts', installSource]
    : ['install', '--global', '--ignore-scripts', '--no-audit', '--no-progress', '--prefix', ownership.npmPrefix, installSource];
}

function isDeferredUpdatePayload(value: unknown): value is DeferredUpdatePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.cwd === 'string'
    && Boolean(payload.cwd)
    && typeof payload.logPath === 'string'
    && Boolean(payload.logPath)
    && Number.isSafeInteger(payload.parentPid)
    && (payload.parentPid as number) > 0
    && Array.isArray(payload.setupArgs)
    && payload.setupArgs.every((arg) => typeof arg === 'string')
    && isCompletePackageManagerOwnership(payload.ownership);
}
async function waitForParent(parentPid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => { try { process.kill(parentPid, 0); } catch { clearInterval(timer); resolve(); } }, 1000);
  });
}
async function canonicalRegularFile(path: string, stage: string): Promise<string | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const canonical = await realpath(path);
    return within(stage, canonical) ? canonical : null;
  } catch { return null; }
}
async function ownerOnlyStage(stage: string): Promise<boolean> {
  try {
    const stat = await lstat(stage);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    // Windows does not expose POSIX mode/uid ownership through Node's stat data.
    // Its per-user temp location is combined with canonical stage and frozen-payload validation.
    return process.platform === 'win32'
      || ((stat.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || stat.uid === process.getuid()));
  } catch { return false; }
}

async function finalizeSuccessfulUpdate(ownership: PackageManagerOwnership): Promise<void> {
  const manifest = JSON.parse(await readFile(join(ownership.packageRoot, 'package.json'), 'utf-8')) as { version?: string };
  if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    throw new Error('Updated package version is unavailable for deferred update finalization.');
  }
  await writeUserInstallStamp({
    installed_version: manifest.version.trim().replace(/^v/i, ''),
    setup_completed_version: manifest.version.trim().replace(/^v/i, ''),
    install_channel: 'stable',
    install_source: installSource,
    package_manager: ownership.manager,
    updated_at: new Date().toISOString(),
  }, omxUserInstallStampPath(ownership.environment.CODEX_HOME));
}

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  const expectedDigest = process.argv[3];
  let payload: DeferredUpdatePayload | null = null;

  let stagedDirectory: string | null = null;
  try {
    const expectedWorkerDigest = process.argv[4];
    if (!payloadPath || !expectedDigest || !expectedWorkerDigest) throw new Error('Frozen transaction payload is missing.');
    const workerPath = await canonicalRegularFile(process.argv[1] ?? '', await realpath(join(process.argv[1] ?? '', '..')));
    if (!workerPath || digest(await readFile(workerPath, 'utf-8')) !== expectedWorkerDigest) throw new Error('Frozen update worker identity changed before execution.');
    const stage = await realpath(join(payloadPath, '..'));
    if (!await ownerOnlyStage(stage) || !basename(stage).startsWith('omx-update-')) {
      throw new Error('Frozen transaction staging directory is not an owner-only update stage.');
    }
    const stagedPayload = await canonicalRegularFile(payloadPath, stage);

    if (!stagedPayload || stagedPayload !== join(stage, 'transaction.json')) {
      throw new Error('Frozen transaction payload is not the canonical staged transaction file.');
    }
    const serialized = await readFile(stagedPayload, 'utf-8');
    if (digest(serialized) !== expectedDigest) throw new Error('Frozen transaction payload fingerprint changed before execution.');
    const parsedPayload: unknown = JSON.parse(serialized);
    if (!isDeferredUpdatePayload(parsedPayload)) throw new Error('Frozen transaction payload is incomplete.');
    payload = parsedPayload;
    stagedDirectory = stage;
    await waitForParent(payload.parentPid);
    if (!await validatePackageManagerOwnership(payload.ownership)) throw new Error('Frozen manager, package root, or bin ownership validation failed before update.');
    const result = payload.ownership.manager === 'npm'
      ? runNpmCommand(payload.ownership.npmCommand, installArgs(payload.ownership), { ...installOptions, env: payload.ownership.environment })
      : spawnSync(payload.ownership.bunCommand, installArgs(payload.ownership), { ...installOptions, env: payload.ownership.environment });
    if (result.error || result.status !== 0) throw new Error(String(result.stderr || result.error?.message || 'controller install failed'));
    const cliEntry = await validatePackageManagerOwnership(payload.ownership);
    if (!cliEntry) throw new Error('Frozen manager, package root, or bin ownership validation failed after update.');
    const setup = spawnSync(process.execPath, [cliEntry, ...payload.setupArgs], { cwd: payload.cwd, env: { ...payload.ownership.environment, [SKIP_NATIVE_AGENT_REFRESH_ENV]: '1' }, stdio: 'inherit', windowsHide: true });
    if (setup.error || setup.status !== 0) throw new Error(setup.error?.message || `setup exited ${setup.status}`);
    await finalizeSuccessfulUpdate(payload.ownership);
  } catch (error) {
    if (payload) await appendFile(payload.logPath, `[omx] Deferred update failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (stagedDirectory) await rm(stagedDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
void main();
