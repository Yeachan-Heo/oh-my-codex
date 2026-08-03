import { createHash, randomBytes, timingSafeEqual } from 'crypto';

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
