import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readdir, stat } from 'fs/promises';
import { basename, join } from 'path';
import { pathToFileURL } from 'url';
import type { HookPluginDescriptor } from './types.js';

export const HOOK_PLUGIN_ENABLE_ENV = 'OMX_HOOK_PLUGINS';
export const HOOK_PLUGIN_TIMEOUT_ENV = 'OMX_HOOK_PLUGIN_TIMEOUT_MS';

function sanitizePluginId(fileName: string): string {
  const stem = basename(fileName, '.mjs');
  const normalized = stem
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'plugin';
}

function shortFileHash(fileName: string): string {
  return createHash('sha256').update(fileName).digest('hex').slice(0, 8);
}

function readTimeout(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.floor(parsed);
  if (rounded < 100) return 100;
  if (rounded > 60_000) return 60_000;
  return rounded;
}

export function hooksDir(cwd: string): string {
  return join(cwd, '.omx', 'hooks');
}

export function isHookPluginsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = `${env[HOOK_PLUGIN_ENABLE_ENV] ?? ''}`.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function resolveHookPluginTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  fallback = 1500,
): number {
  return readTimeout(env[HOOK_PLUGIN_TIMEOUT_ENV], fallback);
}

export async function ensureHooksDir(cwd: string): Promise<string> {
  const dir = hooksDir(cwd);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function validatePluginExport(pluginPath: string): Promise<{ valid: boolean; reason?: string }> {
  try {
    const mod = await import(`${pathToFileURL(pluginPath).href}?v=${Date.now()}`);
    if (!mod || typeof mod.onHookEvent !== 'function') {
      return { valid: false, reason: 'missing_onHookEvent_export' };
    }
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      reason: err instanceof Error ? err.message : 'failed_to_import_plugin',
    };
  }
}

export async function validateHookPluginExport(pluginPath: string): Promise<{ valid: boolean; reason?: string }> {
  return validatePluginExport(pluginPath);
}

export async function discoverHookPlugins(cwd: string): Promise<HookPluginDescriptor[]> {
  const dir = hooksDir(cwd);
  if (!existsSync(dir)) return [];

  const names = await readdir(dir).catch(() => [] as string[]);
  const discovered: Array<{ idBase: string; file: string; path: string }> = [];

  for (const name of names) {
    if (!name.endsWith('.mjs')) continue;
    const path = join(dir, name);
    const st = await stat(path).catch(() => null);
    if (!st || !st.isFile()) continue;

    discovered.push({ idBase: sanitizePluginId(name), file: name, path });
  }

  const idCounts = new Map<string, number>();
  for (const plugin of discovered) {
    idCounts.set(plugin.idBase, (idCounts.get(plugin.idBase) ?? 0) + 1);
  }

  const plugins: HookPluginDescriptor[] = discovered.map((plugin) => {
    const hasCollision = (idCounts.get(plugin.idBase) ?? 0) > 1;
    const id = hasCollision ? `${plugin.idBase}-${shortFileHash(plugin.file)}` : plugin.idBase;
    return {
      id,
      name: id,
      file: plugin.file,
      path: plugin.path,
      filePath: plugin.path,
      fileName: plugin.file,
      valid: true,
    };
  });

  plugins.sort((a, b) => a.file.localeCompare(b.file));
  return plugins;
}

export async function loadHookPluginDescriptors(cwd: string): Promise<HookPluginDescriptor[]> {
  const discovered = await discoverHookPlugins(cwd);
  const validated: HookPluginDescriptor[] = [];
  for (const plugin of discovered) {
    const validation = await validatePluginExport(plugin.path);
    validated.push({
      ...plugin,
      valid: validation.valid,
      reason: validation.reason,
    });
  }
  return validated;
}
