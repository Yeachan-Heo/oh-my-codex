import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { buildHookEvent } from '../hooks/extensibility/events.js';
import { dispatchHookEvent } from '../hooks/extensibility/dispatcher.js';
import { discoverHookPlugins, isHookPluginsEnabled } from '../hooks/extensibility/loader.js';
import type { HookPluginDescriptor } from '../hooks/extensibility/types.js';

const HELP = `
Usage:
  omx hooks init       Create .omx/hooks/sample-plugin.mjs scaffold
  omx hooks status     Show plugin directory + discovered plugins
  omx hooks validate   Validate plugin exports/signatures
  omx hooks test       Dispatch synthetic turn-complete event to plugins

Notes:
  - This command is additive. Existing \`omx tmux-hook\` behavior is unchanged.
  - Plugins are disabled by default. Enable with OMX_HOOK_PLUGINS=1.
`;

const SAMPLE_PLUGIN = `export async function onHookEvent(event, sdk) {
  if (event.event !== 'turn-complete') return;

  const current = Number((await sdk.state.read('sample-seen-count')) ?? 0);
  const next = Number.isFinite(current) ? current + 1 : 1;
  await sdk.state.write('sample-seen-count', next);

  await sdk.log.info('sample-plugin observed turn-complete', {
    turn_id: event.turn_id,
    seen_count: next,
  });
}
`;

function hooksDir(cwd = process.cwd()): string {
  return join(cwd, '.omx', 'hooks');
}

function samplePluginPath(cwd = process.cwd()): string {
  return join(hooksDir(cwd), 'sample-plugin.mjs');
}

interface HookPluginValidationResult {
  valid: boolean;
  reason?: string;
}

async function validateHookPluginExport(filePath: string): Promise<HookPluginValidationResult> {
  try {
    const moduleUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}`;
    const mod = await import(moduleUrl) as { onHookEvent?: unknown };
    if (typeof mod.onHookEvent !== 'function') {
      return { valid: false, reason: 'missing export `onHookEvent(event, sdk)`' };
    }
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : 'failed to import plugin',
    };
  }
}

export async function hooksCommand(args: string[]): Promise<void> {
  const subcommand = args[0] || 'status';
  switch (subcommand) {
    case 'init':
      await initHooks();
      return;
    case 'status':
      await statusHooks();
      return;
    case 'validate':
      await validateHooks();
      return;
    case 'test':
      await testHooks();
      return;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      throw new Error(`Unknown hooks subcommand: ${subcommand}`);
  }
}

async function initHooks(): Promise<void> {
  const cwd = process.cwd();
  const dir = hooksDir(cwd);
  const samplePath = samplePluginPath(cwd);
  await mkdir(dir, { recursive: true });

  if (existsSync(samplePath)) {
    console.log(`hooks scaffold already exists: ${samplePath}`);
    return;
  }

  await writeFile(samplePath, SAMPLE_PLUGIN);
  console.log(`Created ${samplePath}`);
  console.log('Enable plugins with: OMX_HOOK_PLUGINS=1');
}

async function statusHooks(): Promise<void> {
  const cwd = process.cwd();
  const dir = hooksDir(cwd);
  const plugins = await discoverHookPlugins(cwd);

  console.log('hooks status');
  console.log('-----------');
  console.log(`Directory: ${dir}`);
  console.log(`Plugins enabled: ${isHookPluginsEnabled(process.env) ? 'yes' : 'no (set OMX_HOOK_PLUGINS=1)'}`);
  console.log(`Discovered plugins: ${plugins.length}`);
  for (const plugin of plugins) {
    console.log(`- ${plugin.fileName}`);
  }
}

async function validateHooks(): Promise<void> {
  const cwd = process.cwd();
  const plugins = await discoverHookPlugins(cwd);
  if (plugins.length === 0) {
    console.log('No plugins found. Run: omx hooks init');
    return;
  }

  let failed = 0;
  for (const plugin of plugins) {
    const result = await validateHookPluginExport(plugin.filePath);
    if (result.valid) {
      console.log(`✓ ${plugin.fileName}`);
    } else {
      failed += 1;
      console.log(`✗ ${plugin.fileName}: ${result.reason || 'invalid export'}`);
    }
  }

  if (failed > 0) {
    throw new Error(`hooks validation failed (${failed} plugin${failed === 1 ? '' : 's'})`);
  }
}

function normalizeDispatchResult(result: unknown): {
  enabled: boolean;
  reason: string;
  results: Record<string, unknown>[];
} {
  if (!result || typeof result !== 'object') {
    return { enabled: false, reason: 'invalid_result', results: [] };
  }

  const obj = result as Record<string, unknown>;
  const results = Array.isArray(obj.results)
    ? obj.results.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : [];

  return {
    enabled: obj.enabled !== false,
    reason: typeof obj.reason === 'string' ? obj.reason : 'ok',
    results,
  };
}

function pluginLabelFromResult(result: Record<string, unknown>): string {
  if (typeof result.plugin_id === 'string' && result.plugin_id) return result.plugin_id;
  if (typeof result.plugin === 'string' && result.plugin) return result.plugin;
  if (typeof result.file === 'string' && result.file) return result.file;
  return 'unknown-plugin';
}

function pluginStatusFromResult(result: Record<string, unknown>): string {
  if (typeof result.status === 'string' && result.status) return result.status;
  if (typeof result.reason === 'string' && result.reason) return result.reason;
  if (typeof result.ok === 'boolean') return result.ok ? 'ok' : 'error';
  return 'unknown';
}

async function testHooks(): Promise<void> {
  const cwd = process.cwd();
  const discovered = await discoverHookPlugins(cwd);

  const event = buildHookEvent('turn-complete', {
    source: 'native',
    context: {
      reason: 'omx-hooks-test',
    },
    session_id: 'omx-hooks-test',
    thread_id: `thread-${Date.now()}`,
    turn_id: `turn-${Date.now()}`,
  });

  const rawResult = await dispatchHookEvent(event, {
    cwd,
    event,
    env: {
      ...process.env,
      OMX_HOOK_PLUGINS: '1',
    },
    allowInTeamWorker: false,
  } as never);
  const result = normalizeDispatchResult(rawResult);

  console.log('hooks test dispatch complete');
  console.log(`plugins discovered: ${discovered.length}`);
  console.log(`plugins enabled: ${result.enabled ? 'yes' : 'no'}`);
  console.log(`dispatch reason: ${result.reason}`);

  for (const pluginResult of result.results) {
    const label = pluginLabelFromResult(pluginResult);
    const status = pluginStatusFromResult(pluginResult);
    const error = typeof pluginResult.error === 'string' ? pluginResult.error : '';
    console.log(error ? `${label}: ${status} (${error})` : `${label}: ${status}`);
  }

  const logPath = join(cwd, '.omx', 'logs', `hooks-${new Date().toISOString().split('T')[0]}.jsonl`);
  if (existsSync(logPath)) {
    const content = await readFile(logPath, 'utf-8').catch(() => '');
    if (content.trim()) {
      console.log(`log file: ${logPath}`);
    }
  }
}

export function formatHooksStatusLine(plugin: HookPluginDescriptor): string {
  return plugin.fileName;
}
