import { appendFile, lstat, readFile, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { isAbsolute, join, relative } from 'node:path';
import { runNpmCommand, type PackageManagerOwnership } from './package-manager-ownership.js';
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
function output(result: ReturnType<typeof spawnSync>): string | null { return result.error || result.status !== 0 ? null : String(result.stdout || '').trim() || null; }
function installArgs(ownership: PackageManagerOwnership): string[] {
  return ownership.manager === 'bun'
    ? ['add', '--global', '--ignore-scripts', installSource]
    : ['install', '--global', '--ignore-scripts', '--no-audit', '--no-progress', '--prefix', ownership.npmPrefix, installSource];
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
    // The per-user temp directory and signed payload protect the Windows stage.
    return process.platform === 'win32'
      || ((stat.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || stat.uid === process.getuid()));
  } catch { return false; }
}
async function validatePackage(ownership: PackageManagerOwnership): Promise<string | null> {
  try {
    const packageRoot = await realpath(join(ownership.globalInstallRoot, PACKAGE_NAME));
    if (packageRoot !== ownership.packageRoot) return null;
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf-8')) as { bin?: string | Record<string, string> };
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.omx;
    if (typeof bin !== 'string' || !bin.trim() || isAbsolute(bin)) return null;
    const entry = await realpath(join(packageRoot, bin));
    return within(packageRoot, entry) ? entry : null;
  } catch { return null; }
}
async function validateManager(ownership: PackageManagerOwnership): Promise<boolean> {
  if (ownership.manager === 'npm') {
    const root = output(runNpmCommand(ownership.npmCommand, ['root', '-g'], { ...installOptions, env: ownership.environment }));
    const prefix = output(runNpmCommand(ownership.npmCommand, ['prefix', '-g'], { ...installOptions, env: ownership.environment }));
    try { return root !== null && prefix !== null && await realpath(root) === ownership.globalInstallRoot && await realpath(prefix) === ownership.npmPrefix; } catch { return false; }
  }
  if (!ownership.bunInstallRoot || ownership.environment.BUN_INSTALL !== ownership.bunInstallRoot) return false;
  const bin = output(spawnSync(ownership.bunCommand, ['pm', 'bin', '-g'], { ...installOptions, env: ownership.environment }));
  try {
    return bin !== null
      && await realpath(bin) === ownership.bunGlobalBin
      && await realpath(ownership.environment.BUN_INSTALL) === ownership.bunInstallRoot;
  } catch { return false; }
}
async function validateOwnership(ownership: PackageManagerOwnership): Promise<string | null> {
  if (!await validateManager(ownership)) return null;
  return validatePackage(ownership);
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
  let stagedPayload: string | null = null;
  let stagedDirectory: string | null = null;
  try {
    const expectedWorkerDigest = process.argv[4];
    if (!payloadPath || !expectedDigest || !expectedWorkerDigest) throw new Error('Frozen transaction payload is missing.');
    const workerPath = await canonicalRegularFile(process.argv[1] ?? '', await realpath(join(process.argv[1] ?? '', '..')));
    if (!workerPath || digest(await readFile(workerPath, 'utf-8')) !== expectedWorkerDigest) throw new Error('Frozen update worker identity changed before execution.');
    const stage = await realpath(join(payloadPath, '..'));
    if (!await ownerOnlyStage(stage)) throw new Error('Frozen transaction staging directory is not an owner-only stage.');
    stagedDirectory = stage;
    stagedPayload = await canonicalRegularFile(payloadPath, stage);
    if (!stagedPayload) throw new Error('Frozen transaction payload is not a regular canonical staged file.');
    const serialized = await readFile(stagedPayload, 'utf-8');
    if (digest(serialized) !== expectedDigest) throw new Error('Frozen transaction payload fingerprint changed before execution.');
    payload = JSON.parse(serialized) as DeferredUpdatePayload;
    if (!payload.ownership || !payload.ownership.packageRoot || !payload.ownership.environment) throw new Error('Frozen transaction payload is incomplete.');
    await waitForParent(payload.parentPid);
    if (!await validateOwnership(payload.ownership)) throw new Error('Frozen manager, package root, or bin ownership validation failed before update.');
    const result = payload.ownership.manager === 'npm'
      ? runNpmCommand(payload.ownership.npmCommand, installArgs(payload.ownership), { ...installOptions, env: payload.ownership.environment })
      : spawnSync(payload.ownership.bunCommand, installArgs(payload.ownership), { ...installOptions, env: payload.ownership.environment });
    if (result.error || result.status !== 0) throw new Error(String(result.stderr || result.error?.message || 'controller install failed'));
    const cliEntry = await validateOwnership(payload.ownership);
    if (!cliEntry) throw new Error('Frozen manager, package root, or bin ownership validation failed after update.');
    const setup = spawnSync(process.execPath, [cliEntry, ...payload.setupArgs], { cwd: payload.cwd, env: { ...payload.ownership.environment, [SKIP_NATIVE_AGENT_REFRESH_ENV]: '1' }, stdio: 'inherit', windowsHide: true });
    if (setup.error || setup.status !== 0) throw new Error(setup.error?.message || `setup exited ${setup.status}`);
    await finalizeSuccessfulUpdate(payload.ownership);
  } catch (error) {
    if (payload) await appendFile(payload.logPath, `[omx] Deferred update failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (stagedDirectory) await rm(stagedDirectory, { recursive: true, force: true }).catch(() => undefined);
    else if (stagedPayload) await rm(stagedPayload, { force: true }).catch(() => undefined);
  }
}
void main();
