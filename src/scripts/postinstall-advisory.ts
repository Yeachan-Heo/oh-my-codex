import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { omxUserInstallStampPath } from '../utils/paths.js';

export interface UserInstallStamp {
  installed_version: string;
  setup_completed_version?: string;
  install_channel?: 'stable' | 'dev';
  install_source?: string;
  install_revision?: string;
  dev_base_version?: string;
  package_manager?: 'npm' | 'bun';
  updated_at: string;
}

function stripLeadingV(version: string): string {
  return version.trim().replace(/^v/i, '');
}

export async function readUserInstallStamp(
  path = omxUserInstallStampPath(),
): Promise<UserInstallStamp | null> {
  if (!existsSync(path)) return null;
  try {
    const content = await readFile(path, 'utf-8');
    const parsed = JSON.parse(content) as Partial<UserInstallStamp>;
    if (typeof parsed.installed_version !== 'string' || typeof parsed.updated_at !== 'string') {
      return null;
    }
    return {
      installed_version: parsed.installed_version,
      ...(typeof parsed.setup_completed_version === 'string'
        ? { setup_completed_version: parsed.setup_completed_version }
        : {}),
      ...(parsed.install_channel === 'stable' || parsed.install_channel === 'dev'
        ? { install_channel: parsed.install_channel }
        : {}),
      ...(typeof parsed.install_source === 'string' ? { install_source: parsed.install_source } : {}),
      ...(typeof parsed.install_revision === 'string' ? { install_revision: parsed.install_revision } : {}),
      ...(typeof parsed.dev_base_version === 'string' ? { dev_base_version: parsed.dev_base_version } : {}),
      ...(parsed.package_manager === 'npm' || parsed.package_manager === 'bun'
        ? { package_manager: parsed.package_manager }
        : {}),
      updated_at: parsed.updated_at,
    };
  } catch {
    return null;
  }
}

export async function writeUserInstallStamp(
  stamp: UserInstallStamp,
  path = omxUserInstallStampPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(stamp, null, 2));
}

export function isInstallVersionBump(
  currentVersion: string | null | undefined,
  stamp: UserInstallStamp | null,
): boolean {
  if (!currentVersion) return false;
  if (!stamp?.installed_version) return true;
  return stripLeadingV(currentVersion) !== stripLeadingV(stamp.installed_version);
}
