import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { getPackageRoot } from './package.js';
import { omxUserInstallStampPath } from './paths.js';

interface PackageVersionMetadata {
  version?: string;
}

interface InstallVersionMetadata {
  installed_version?: string;
  setup_completed_version?: string;
  install_channel?: string;
  install_revision?: string;
  dev_base_version?: string;
}

function stripLeadingV(version: string): string {
  return version.trim().replace(/^v/i, '');
}

function shortRevision(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!/^[0-9a-f]{7,40}$/i.test(normalized)) return null;
  return normalized.slice(0, 12);
}

function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function readPackageVersion(packageRoot = getPackageRoot()): string | null {
  const pkg = readJsonFile(join(packageRoot, 'package.json')) as PackageVersionMetadata | null;
  return typeof pkg?.version === 'string' && pkg.version.trim() !== ''
    ? stripLeadingV(pkg.version)
    : null;
}

function readInstallVersionMetadata(stampPath = omxUserInstallStampPath()): InstallVersionMetadata | null {
  return readJsonFile(stampPath) as InstallVersionMetadata | null;
}

function readGitRevision(packageRoot: string): string | null {
  try {
    return shortRevision(execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: packageRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }));
  } catch {
    return null;
  }
}

export function resolveOmxDisplayVersionSync(options: {
  packageRoot?: string;
  stampPath?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string | null {
  const packageRoot = options.packageRoot ?? getPackageRoot();
  const version = readPackageVersion(packageRoot);
  if (!version) return null;

  const env = options.env ?? process.env;
  const explicitRevision = shortRevision(env.OMX_VERSION_REVISION || env.OMX_GIT_REVISION);
  const stamp = readInstallVersionMetadata(options.stampPath);
  const stampVersion = typeof stamp?.setup_completed_version === 'string'
    ? stripLeadingV(stamp.setup_completed_version)
    : typeof stamp?.installed_version === 'string'
      ? stripLeadingV(stamp.installed_version)
      : '';
  const devBaseVersion = typeof stamp?.dev_base_version === 'string'
    ? stripLeadingV(stamp.dev_base_version)
    : '';
  const isCurrentDevInstall = stamp?.install_channel === 'dev'
    && stampVersion === version;
  if (isCurrentDevInstall) {
    const displayVersion = devBaseVersion || version;
    const revision = shortRevision(stamp.install_revision) ?? explicitRevision ?? readGitRevision(packageRoot);
    return revision ? `v${displayVersion}-dev-${revision}` : `v${displayVersion}-dev`;
  }

  return `v${version}`;
}
