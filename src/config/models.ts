/**
 * Model Configuration
 *
 * Reads per-mode model overrides from .omx-config.json under the "models" key.
 *
 * Config format:
 * {
 *   "models": {
 *     "default": "o4-mini",
 *     "team": "gpt-4.1"
 *   }
 * }
 *
 * Resolution: mode-specific > "default" key > 'gpt-5.3-codex' (hardcoded fallback)
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { codexHome } from '../utils/paths.js';

export interface ModelsConfig {
  [mode: string]: string | undefined;
}

function readModelsBlock(): ModelsConfig | null {
  const configPath = join(codexHome(), '.omx-config.json');
  if (!existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (raw && typeof raw.models === 'object' && raw.models !== null && !Array.isArray(raw.models)) {
      return raw.models as ModelsConfig;
    }
    return null;
  } catch {
    return null;
  }
}

const HARDCODED_DEFAULT_MODEL = 'gpt-5.3-codex';

/**
 * Get the configured model for a specific mode.
 * Resolution: mode-specific override > "default" key > 'gpt-5.3-codex'
 */
export function getModelForMode(mode: string): string {
  const models = readModelsBlock();
  if (!models) return HARDCODED_DEFAULT_MODEL;

  const modeValue = models[mode];
  if (typeof modeValue === 'string' && modeValue.trim() !== '') {
    return modeValue.trim();
  }

  const defaultValue = models['default'];
  if (typeof defaultValue === 'string' && defaultValue.trim() !== '') {
    return defaultValue.trim();
  }

  return HARDCODED_DEFAULT_MODEL;
}
