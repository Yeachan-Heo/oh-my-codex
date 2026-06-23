import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from '@iarna/toml';

export interface OmxCodexProfileOptions {
  profile?: string;
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
}

export interface OmxCodexProfileResolution {
  profile?: string;
  codexHome: string;
  baseConfigPath: string;
  profileConfigPath?: string;
  config: Record<string, unknown>;
  profileConfig: Record<string, unknown> | null;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
}

export function resolveCodexHome(options: Pick<OmxCodexProfileOptions, 'codexHome' | 'env'> = {}): string {
  const env = options.env ?? process.env;
  return options.codexHome ?? (env.CODEX_HOME?.trim() || join(homedir(), '.codex'));
}

function assertSafeCodexProfileName(profileName: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profileName)) {
    throw new Error(`Invalid Codex profile name: ${profileName}`);
  }
}

export async function readCodexConfig(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = parseToml(await readFile(path, 'utf-8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function resolveCodexProfile(options: OmxCodexProfileOptions = {}): Promise<OmxCodexProfileResolution> {
  const codexHome = resolveCodexHome(options);
  const baseConfigPath = join(codexHome, 'config.toml');
  const baseConfig = await readCodexConfig(baseConfigPath) ?? {};
  const profileName = options.profile?.trim() || undefined;
  if (profileName) assertSafeCodexProfileName(profileName);
  const profileConfigPath = profileName ? join(codexHome, `${profileName}.config.toml`) : undefined;
  const profileConfig = profileConfigPath ? await readCodexConfig(profileConfigPath) : null;
  if (profileName && !profileConfig) {
    throw new Error(`Codex profile not found or invalid: ${profileName} (${profileConfigPath})`);
  }
  const config = mergeConfig(baseConfig, profileConfig ?? {});
  return {
    profile: profileName,
    codexHome,
    baseConfigPath,
    profileConfigPath,
    config,
    profileConfig,
    model: stringValue(config.model),
    modelProvider: stringValue(config.model_provider),
    reasoningEffort: stringValue(config.model_reasoning_effort),
  };
}

export function codexProfileToApiEnv(profile: OmxCodexProfileResolution): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (profile.profile) env.OMX_API_CODEX_PROFILE = profile.profile;
  if (profile.model) env.OMX_API_GENERATE_MODEL = profile.model;
  if (profile.modelProvider) env.OMX_API_CODEX_MODEL_PROVIDER = profile.modelProvider;
  if (profile.reasoningEffort) env.OMX_API_CODEX_REASONING_EFFORT = profile.reasoningEffort;
  return env;
}

function mergeConfig(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!isSafeConfigKey(key)) continue;
    result[key] = value;
  }
  for (const [key, value] of Object.entries(overlay)) {
    if (!isSafeConfigKey(key)) continue;
    const existing = result[key];
    result[key] = isRecord(existing) && isRecord(value)
      ? mergeConfig(existing, value)
      : value;
  }
  return result;
}

function isSafeConfigKey(key: string): boolean {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
