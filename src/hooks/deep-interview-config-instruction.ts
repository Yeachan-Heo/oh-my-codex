import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getBaseStateDir } from '../mcp/state-paths.js';
import type { SkillActiveState } from './keyword-detector.js';

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function resolveInitializedStatePath(cwd: string, statePath: string): string {
  if (statePath.startsWith('/')) return statePath;
  const normalized = statePath.replace(/\\/g, '/');
  const statePrefix = '.omx/state/';
  if (normalized.startsWith(statePrefix)) {
    return join(getBaseStateDir(cwd), normalized.slice(statePrefix.length));
  }
  return resolve(cwd, statePath);
}

export function buildDeepInterviewConfigInstruction(cwd: string, skillState?: SkillActiveState | null): string | null {
  if (skillState?.initialized_mode !== 'deep-interview' || !skillState.initialized_state_path) return null;
  const statePath = resolveInitializedStatePath(cwd, skillState.initialized_state_path);
  try {
    if (!existsSync(statePath)) return null;
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    const nested = parsed.deep_interview_config && typeof parsed.deep_interview_config === 'object'
      ? parsed.deep_interview_config as Record<string, unknown>
      : {};
    const profile = safeString(parsed.profile ?? nested.profile).trim();
    const sourcePath = safeString(parsed.config_source ?? nested.sourcePath).trim();
    const threshold = typeof parsed.threshold === 'number' ? parsed.threshold : nested.threshold;
    const maxRounds = typeof parsed.max_rounds === 'number' ? parsed.max_rounds : nested.maxRounds;
    const enableChallengeModes = typeof parsed.enable_challenge_modes === 'boolean'
      ? parsed.enable_challenge_modes
      : nested.enableChallengeModes;
    if (!profile || typeof threshold !== 'number' || typeof maxRounds !== 'number') return null;
    return [
      `Deep-interview config override active${sourcePath ? ` from ${sourcePath}` : ''}:`,
      `profile=${profile}, threshold=${threshold}, max_rounds=${maxRounds}, enableChallengeModes=${enableChallengeModes !== false}.`,
      'Use these values instead of SKILL.md defaults for ambiguity scoring, challenge-mode gating, and round caps.',
    ].join(' ');
  } catch {
    return null;
  }
}
