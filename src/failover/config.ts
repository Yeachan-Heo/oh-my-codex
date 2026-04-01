/**
 * Failover configuration loader.
 *
 * Reads failover settings from .omx-config.json and environment variables.
 * Environment variables override config file values.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { codexHome } from '../utils/paths.js';
import type { FailoverConfig, FailoverProvider } from './types.js';
import { DEFAULT_FAILOVER_CONFIG } from './types.js';

const OMX_FAILOVER_ENABLED_ENV = 'OMX_FAILOVER_ENABLED';
const OMX_FAILOVER_ORDER_ENV = 'OMX_FAILOVER_ORDER';
const OMX_FAILOVER_COOLDOWN_MS_ENV = 'OMX_FAILOVER_COOLDOWN_MS';
const OMX_FAILOVER_MAX_RETRIES_ENV = 'OMX_FAILOVER_MAX_RETRIES';

const VALID_PROVIDERS = new Set<string>(['codex', 'claude', 'gemini', 'qwen', 'grok']);

function isValidProvider(value: string): value is FailoverProvider {
  return VALID_PROVIDERS.has(value);
}

interface OmxConfigFile {
  failover?: Partial<{
    enabled: boolean;
    order: string[];
    cooldownMs: number;
    maxRetries: number;
  }>;
}

function readOmxConfigFile(codexHomeOverride?: string): OmxConfigFile | null {
  const configPath = join(codexHomeOverride ?? codexHome(), '.omx-config.json');
  if (!existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw as OmxConfigFile;
  } catch {
    return null;
  }
}

/**
 * Load failover configuration from config file and environment variables.
 * Priority: env vars > config file > defaults.
 */
export function loadFailoverConfig(
  env: NodeJS.ProcessEnv = process.env,
  codexHomeOverride?: string,
): FailoverConfig {
  const fileConfig = readOmxConfigFile(codexHomeOverride)?.failover;

  // Resolve enabled
  let enabled = DEFAULT_FAILOVER_CONFIG.enabled;
  if (fileConfig && typeof fileConfig.enabled === 'boolean') {
    enabled = fileConfig.enabled;
  }
  const envEnabled = env[OMX_FAILOVER_ENABLED_ENV]?.trim().toLowerCase();
  if (envEnabled === '0' || envEnabled === 'false' || envEnabled === 'no' || envEnabled === 'off') {
    enabled = false;
  } else if (envEnabled === '1' || envEnabled === 'true' || envEnabled === 'yes' || envEnabled === 'on') {
    enabled = true;
  }

  // Resolve order
  let order = DEFAULT_FAILOVER_CONFIG.order;
  if (fileConfig?.order && Array.isArray(fileConfig.order)) {
    const validOrder = fileConfig.order
      .map((p) => String(p).trim().toLowerCase())
      .filter(isValidProvider);
    if (validOrder.length > 0) order = validOrder;
  }
  const envOrder = env[OMX_FAILOVER_ORDER_ENV]?.trim();
  if (envOrder) {
    const parsedOrder = envOrder
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(isValidProvider);
    if (parsedOrder.length > 0) order = parsedOrder;
  }

  // Resolve cooldownMs
  let cooldownMs = DEFAULT_FAILOVER_CONFIG.cooldownMs;
  if (fileConfig && typeof fileConfig.cooldownMs === 'number' && fileConfig.cooldownMs > 0) {
    cooldownMs = fileConfig.cooldownMs;
  }
  const envCooldown = Number.parseInt(env[OMX_FAILOVER_COOLDOWN_MS_ENV] ?? '', 10);
  if (Number.isFinite(envCooldown) && envCooldown > 0) cooldownMs = envCooldown;

  // Resolve maxRetries
  let maxRetries = DEFAULT_FAILOVER_CONFIG.maxRetries;
  if (fileConfig && typeof fileConfig.maxRetries === 'number' && fileConfig.maxRetries >= 0) {
    maxRetries = fileConfig.maxRetries;
  }
  const envRetries = Number.parseInt(env[OMX_FAILOVER_MAX_RETRIES_ENV] ?? '', 10);
  if (Number.isFinite(envRetries) && envRetries >= 0) maxRetries = envRetries;

  return { enabled, order, cooldownMs, maxRetries };
}
