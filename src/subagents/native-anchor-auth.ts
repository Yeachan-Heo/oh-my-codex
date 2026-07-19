import { createHmac, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY_BYTES = 32;
const HEX_SHA256 = /^[a-f0-9]{64}$/;

export function nativeAnchorAuthKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  return join(codexHome, '.omx', 'native-anchor-auth.key');
}

function readNativeAnchorKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  try {
    const path = nativeAnchorAuthKeyPath(env);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== KEY_BYTES) return null;
    const key = readFileSync(path);
    return key.length === KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

function sign(parts: string[], env: NodeJS.ProcessEnv = process.env): string | null {
  const key = readNativeAnchorKey(env);
  return key ? createHmac('sha256', key).update(parts.join('\0')).digest('hex') : null;
}

function verify(signature: string | undefined, expected: string | null): boolean {
  if (!signature || !expected || !HEX_SHA256.test(signature) || !HEX_SHA256.test(expected)) return false;
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
}

export function signNativeLaunchClaim(launchId: string, sessionId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return sign(['launch-claim-v1', launchId, sessionId], env);
}

export function verifyNativeLaunchClaim(launchId: string, sessionId: string, signature: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return verify(signature, signNativeLaunchClaim(launchId, sessionId, env));
}

export function signNativeLeaderAttestation(sessionId: string, leaderThreadId: string, attestedAt: string, source: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return sign(['leader-attestation-v1', sessionId, leaderThreadId, attestedAt, source], env);
}

export function verifyNativeLeaderAttestation(sessionId: string, leaderThreadId: string, attestedAt: string, source: string, signature: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return verify(signature, signNativeLeaderAttestation(sessionId, leaderThreadId, attestedAt, source, env));
}
