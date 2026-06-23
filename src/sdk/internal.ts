import { dirname, isAbsolute, relative, resolve } from 'node:path';

export function normalizeLoopbackHost(host: string): string {
  const normalized = host.toLowerCase();
  return normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeLoopbackHost(host);
  if (normalized === 'localhost' || normalized === '::1') return true;
  const octets = normalized.split('.');
  if (octets.length !== 4 || octets[0] !== '127') return false;
  return octets.every((octet) => {
    if (!/^\d+$/.test(octet)) return false;
    const value = Number(octet);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

export function daemonBaseUrl(host: string, port: number): string {
  const normalized = normalizeLoopbackHost(host);
  const hostForUrl = normalized.includes(':') ? `[${normalized}]` : normalized;
  return `http://${hostForUrl}:${port}`;
}

export function daemonHostsMatch(left: string, right: string): boolean {
  return normalizeLoopbackHost(left) === normalizeLoopbackHost(right);
}

export function tokenPathAllowedForState(tokenPath: string, stateFile: string): boolean {
  const stateDir = resolve(dirname(stateFile));
  const resolvedStateFile = resolve(stateFile);
  const resolvedTokenPath = resolve(tokenPath);
  if (resolvedTokenPath === resolvedStateFile) return false;
  const relativeTokenPath = relative(stateDir, resolvedTokenPath);
  return relativeTokenPath !== ''
    && !relativeTokenPath.startsWith('..')
    && !isAbsolute(relativeTokenPath);
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}
