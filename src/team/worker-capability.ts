import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { link, open, readFile, unlink } from 'fs/promises';
import { join } from 'path';

export const TEAM_WORKER_CAPABILITY_ENV = 'OMX_TEAM_WORKER_CAPABILITY';

export interface TeamWorkerRuntimeCapability {
  version: 1;
  team_name: string;
  worker_name: string;
  leader_session_id: string;
  leader_cwd: string;
  team_state_root: string;
  worker_cwd: string;
  team_created_at: string;
  issued_at: string;
  token_sha256: string;
}

export interface IssuedTeamWorkerRuntimeCapability {
  token: string;
  metadata: TeamWorkerRuntimeCapability;
}

export interface TeamWorkerNativeSessionBinding {
  version: 1;
  team_name: string;
  worker_name: string;
  native_session_id: string;
  leader_session_id: string;
  team_created_at: string;
  worker_cwd: string;
  team_state_root: string;
  capability_sha256: string;
  bound_at: string;
}

export function teamWorkerNativeSessionBindingPath(stateRoot: string, teamName: string, workerName: string): string {
  return join(stateRoot, 'team', teamName, 'workers', workerName, 'native-session-binding.json');
}

export async function readTeamWorkerNativeSessionBinding(
  stateRoot: string,
  teamName: string,
  workerName: string,
): Promise<TeamWorkerNativeSessionBinding | null> {
  try {
    const parsed = JSON.parse(await readFile(
      teamWorkerNativeSessionBindingPath(stateRoot, teamName, workerName),
      'utf8',
    )) as TeamWorkerNativeSessionBinding;
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export async function bindTeamWorkerNativeSession(
  stateRoot: string,
  binding: TeamWorkerNativeSessionBinding,
): Promise<TeamWorkerNativeSessionBinding | null> {
  const bindingPath = teamWorkerNativeSessionBindingPath(stateRoot, binding.team_name, binding.worker_name);
  const temporaryPath = `${bindingPath}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(binding, null, 2), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, bindingPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code !== 'EEXIST') throw error;
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
  return await readTeamWorkerNativeSessionBinding(stateRoot, binding.team_name, binding.worker_name);
}

export function digestTeamWorkerCapabilityToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function issueTeamWorkerRuntimeCapability(input: {
  teamName: string;
  workerName: string;
  leaderSessionId: string;
  leaderCwd: string;
  teamStateRoot: string;
  workerCwd: string;
  teamCreatedAt: string;
}): IssuedTeamWorkerRuntimeCapability {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    metadata: {
      version: 1,
      team_name: input.teamName,
      worker_name: input.workerName,
      leader_session_id: input.leaderSessionId,
      leader_cwd: input.leaderCwd,
      team_state_root: input.teamStateRoot,
      worker_cwd: input.workerCwd,
      team_created_at: input.teamCreatedAt,
      issued_at: new Date().toISOString(),
      token_sha256: digestTeamWorkerCapabilityToken(token),
    },
  };
}

export function capabilityTokenMatches(token: string, expectedSha256: string): boolean {
  const normalizedToken = token.trim();
  const normalizedExpected = expectedSha256.trim().toLowerCase();
  if (!normalizedToken || !/^[a-f0-9]{64}$/.test(normalizedExpected)) return false;
  const actual = Buffer.from(digestTeamWorkerCapabilityToken(normalizedToken), 'hex');
  const expected = Buffer.from(normalizedExpected, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
