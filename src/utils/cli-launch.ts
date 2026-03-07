import { spawnSync, type SpawnSyncOptions } from 'child_process';
import { readFileSync } from 'fs';

export interface CliLaunchSpec {
  command: string;
  args: string[];
}

export function isWslEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    return true;
  }
  try {
    const version = readFileSync('/proc/version', 'utf-8');
    return /microsoft/i.test(version);
  } catch {
    return false;
  }
}

export function isWindowsShellWrapped(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && !isWslEnvironment(env);
}

export function buildCliLaunchSpec(
  binary: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CliLaunchSpec {
  if (isWindowsShellWrapped(env, platform)) {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', binary, ...args],
    };
  }
  return { command: binary, args };
}

export function spawnBinarySync(
  binary: string,
  args: string[] = [],
  options: SpawnSyncOptions = {},
) {
  const spec = buildCliLaunchSpec(binary, args, options.env);
  return spawnSync(spec.command, spec.args, options);
}

export function resolveBinaryOnPath(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const locator = platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [binary], {
    encoding: 'utf-8',
    timeout: 5000,
    env,
  });
  if (result.status === 0) {
    const resolved = (result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (resolved) return resolved;
  }
  return binary;
}
