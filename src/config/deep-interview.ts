import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import { findGitLayout } from '../utils/git-layout.js';

export type DeepInterviewProfile = 'quick' | 'standard' | 'deep';

export interface DeepInterviewConfigOptions {
  cwd: string;
  text?: string;
  homeDir?: string;
}

export interface DeepInterviewConfigCandidate {
  path: string;
  precedence: 'project-omx' | 'project-root' | 'user';
}

export interface DeepInterviewRuntimeConfig {
  profile: DeepInterviewProfile;
  threshold: number;
  maxRounds: number;
  enableChallengeModes: boolean;
  sourcePath: string;
}

interface DeepInterviewConfigTable {
  defaultProfile?: unknown;
  quickThreshold?: unknown;
  standardThreshold?: unknown;
  deepThreshold?: unknown;
  quickMaxRounds?: unknown;
  standardMaxRounds?: unknown;
  deepMaxRounds?: unknown;
  enableChallengeModes?: unknown;
}

interface DeepInterviewProfileSpec {
  thresholdKey: keyof DeepInterviewConfigTable;
  maxRoundsKey: keyof DeepInterviewConfigTable;
  defaults: {
    threshold: number;
    maxRounds: number;
  };
}

type DeepInterviewConfigReadResult =
  | { status: 'missing' }
  | { status: 'malformed' }
  | { status: 'no-table' }
  | { status: 'table'; table: DeepInterviewConfigTable };

const DEFAULT_PROFILE: DeepInterviewProfile = 'standard';
const DEFAULT_ENABLE_CHALLENGE_MODES = true;

const PROFILE_SPECS: Record<DeepInterviewProfile, DeepInterviewProfileSpec> = {
  quick: {
    thresholdKey: 'quickThreshold',
    maxRoundsKey: 'quickMaxRounds',
    defaults: { threshold: 0.30, maxRounds: 5 },
  },
  standard: {
    thresholdKey: 'standardThreshold',
    maxRoundsKey: 'standardMaxRounds',
    defaults: { threshold: 0.20, maxRounds: 12 },
  },
  deep: {
    thresholdKey: 'deepThreshold',
    maxRoundsKey: 'deepMaxRounds',
    defaults: { threshold: 0.15, maxRounds: 20 },
  },
};

const DEEP_INTERVIEW_INVOCATION_PATTERN = /(?:^|\s)(?:\$(?:[A-Za-z0-9_-]+:)?deep-interview|deep[-\s]interview)(?=\s|$)/i;
const PROFILE_FLAG_TOKEN_PATTERN = /^--(quick|standard|deep)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeProfile(value: unknown): DeepInterviewProfile | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase();
  return normalized === 'quick' || normalized === 'standard' || normalized === 'deep'
    ? normalized
    : undefined;
}

function normalizeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeThreshold(value: unknown): number | undefined {
  const normalized = normalizeFiniteNumber(value);
  return normalized !== undefined && normalized > 0 && normalized <= 1 ? normalized : undefined;
}

function normalizeMaxRounds(value: unknown): number | undefined {
  const normalized = normalizeFiniteNumber(value);
  return normalized !== undefined && Number.isInteger(normalized) && normalized > 0 ? normalized : undefined;
}

function warnMalformedConfig(configPath: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[omx] warning: ignoring malformed deep-interview config at ${configPath}: ${message}`);
}

function extractDeepInterviewTable(parsed: unknown): DeepInterviewConfigTable | null {
  if (!isRecord(parsed) || !isRecord(parsed.omx) || !isRecord(parsed.omx.deepInterview)) return null;
  return parsed.omx.deepInterview as DeepInterviewConfigTable;
}

function readDeepInterviewConfigTable(configPath: string): DeepInterviewConfigReadResult {
  if (!existsSync(configPath)) return { status: 'missing' };

  try {
    const table = extractDeepInterviewTable(parseToml(readFileSync(configPath, 'utf-8')) as unknown);
    return table ? { status: 'table', table } : { status: 'no-table' };
  } catch (error) {
    warnMalformedConfig(configPath, error);
    return { status: 'malformed' };
  }
}

function resolveProfile(table: DeepInterviewConfigTable, text: string | undefined): DeepInterviewProfile {
  return parseDeepInterviewProfileFromText(text)
    ?? normalizeProfile(table.defaultProfile)
    ?? DEFAULT_PROFILE;
}

function resolveProfileConfig(table: DeepInterviewConfigTable, profile: DeepInterviewProfile): Pick<DeepInterviewRuntimeConfig, 'threshold' | 'maxRounds'> {
  const spec = PROFILE_SPECS[profile];
  return {
    threshold: normalizeThreshold(table[spec.thresholdKey]) ?? spec.defaults.threshold,
    maxRounds: normalizeMaxRounds(table[spec.maxRoundsKey]) ?? spec.defaults.maxRounds,
  };
}

function resolveEnableChallengeModes(table: DeepInterviewConfigTable): boolean {
  return typeof table.enableChallengeModes === 'boolean'
    ? table.enableChallengeModes
    : DEFAULT_ENABLE_CHALLENGE_MODES;
}

function buildRuntimeConfig(
  candidate: DeepInterviewConfigCandidate,
  table: DeepInterviewConfigTable,
  options: Pick<DeepInterviewConfigOptions, 'text'>,
): DeepInterviewRuntimeConfig {
  const profile = resolveProfile(table, options.text);
  return {
    profile,
    ...resolveProfileConfig(table, profile),
    enableChallengeModes: resolveEnableChallengeModes(table),
    sourcePath: candidate.path,
  };
}

export function parseDeepInterviewProfileFromText(text: string | undefined): DeepInterviewProfile | undefined {
  const input = text ?? '';
  const invocationMatch = DEEP_INTERVIEW_INVOCATION_PATTERN.exec(input);
  if (!invocationMatch) return undefined;

  const afterInvocation = input.slice((invocationMatch.index ?? 0) + invocationMatch[0].length).trimStart();
  for (const token of afterInvocation.split(/\s+/)) {
    if (!token) continue;
    if (!token.startsWith('--')) return undefined;
    const profile = normalizeProfile(PROFILE_FLAG_TOKEN_PATTERN.exec(token)?.[1]);
    if (profile) return profile;
  }

  return undefined;
}

export function getDeepInterviewConfigCandidatePaths(options: Pick<DeepInterviewConfigOptions, 'cwd' | 'homeDir'>): DeepInterviewConfigCandidate[] {
  const home = options.homeDir || homedir();
  const projectRoot = findGitLayout(options.cwd)?.worktreeRoot ?? options.cwd;
  return [
    { path: join(projectRoot, '.omx', 'config.toml'), precedence: 'project-omx' },
    { path: join(projectRoot, 'omx.toml'), precedence: 'project-root' },
    { path: join(home, '.omx', 'config.toml'), precedence: 'user' },
  ];
}

export function resolveDeepInterviewRuntimeConfig(options: DeepInterviewConfigOptions): DeepInterviewRuntimeConfig | null {
  for (const candidate of getDeepInterviewConfigCandidatePaths(options)) {
    const result = readDeepInterviewConfigTable(candidate.path);
    if (result.status === 'malformed' || result.status === 'no-table') return null;
    if (result.status === 'table') return buildRuntimeConfig(candidate, result.table, options);
  }

  return null;
}

export function buildDeepInterviewConfigStateFields(
  config: DeepInterviewRuntimeConfig | null | undefined,
): Record<string, unknown> {
  if (!config) return {};

  const deepInterviewConfig = {
    profile: config.profile,
    threshold: config.threshold,
    maxRounds: config.maxRounds,
    enableChallengeModes: config.enableChallengeModes,
    sourcePath: config.sourcePath,
  };

  return {
    deep_interview_config: deepInterviewConfig,
    profile: deepInterviewConfig.profile,
    threshold: deepInterviewConfig.threshold,
    max_rounds: deepInterviewConfig.maxRounds,
    enable_challenge_modes: deepInterviewConfig.enableChallengeModes,
    config_source: deepInterviewConfig.sourcePath,
  };
}
