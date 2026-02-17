import { existsSync } from 'fs';
import { appendFile, mkdir } from 'fs/promises';
import { spawn } from 'child_process';
import { join } from 'path';
import { getPackageRoot } from '../../utils/package.js';
import {
  discoverHookPlugins,
  isHookPluginsEnabled,
  resolveHookPluginTimeoutMs,
  validateHookPluginExport,
} from './loader.js';
import type {
  HookDispatchOptions,
  HookDispatchResult,
  HookEventEnvelope,
  HookPluginDispatchResult,
} from './types.js';

interface RunnerResult {
  ok: boolean;
  plugin: string;
  reason: string;
  error?: string;
}

const RESULT_PREFIX = '__OMX_PLUGIN_RESULT__ ';

function hooksLogPath(cwd: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return join(cwd, '.omx', 'logs', `hooks-${day}.jsonl`);
}

async function appendHooksLog(cwd: string, payload: Record<string, unknown>): Promise<void> {
  await mkdir(join(cwd, '.omx', 'logs'), { recursive: true });
  await appendFile(hooksLogPath(cwd), `${JSON.stringify({ timestamp: new Date().toISOString(), ...payload })}\n`).catch(() => {});
}

function isTeamWorker(env: NodeJS.ProcessEnv): boolean {
  return typeof env.OMX_TEAM_WORKER === 'string' && env.OMX_TEAM_WORKER.trim() !== '';
}

async function runPluginRunner(
  plugin: { id: string; path: string; file: string },
  event: HookEventEnvelope,
  options: Required<Pick<HookDispatchOptions, 'cwd'>> & HookDispatchOptions,
  sideEffectsEnabled: boolean,
): Promise<HookPluginDispatchResult> {
  const started = Date.now();
  const runnerPath = join(getPackageRoot(), 'dist', 'hooks', 'extensibility', 'plugin-runner.js');
  const timeoutMs = options.timeoutMs ?? resolveHookPluginTimeoutMs(options.env);

  if (!existsSync(runnerPath)) {
    const duration = Date.now() - started;
    return {
      plugin: plugin.id,
      path: plugin.path,
      file: plugin.file,
      plugin_id: plugin.id,
      ok: false,
      status: 'runner_error',
      skipped: true,
      reason: 'runner_missing',
      durationMs: duration,
      duration_ms: duration,
    };
  }

  return await new Promise<HookPluginDispatchResult>((resolve) => {
    const child = spawn(process.execPath, [runnerPath], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(options.env || {}),
      },
    });

    let stdout = '';
    let stderr = '';
    let done = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const duration = Date.now() - started;
      resolve({
        plugin: plugin.id,
        path: plugin.path,
        file: plugin.file,
        plugin_id: plugin.id,
        ok: false,
        status: 'runner_error',
        reason: 'spawn_failed',
        error: error.message,
        durationMs: duration,
        duration_ms: duration,
      });
    });

    child.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const duration = Date.now() - started;

      if (timedOut) {
        resolve({
          plugin: plugin.id,
          path: plugin.path,
          file: plugin.file,
          plugin_id: plugin.id,
          ok: false,
          status: 'timeout',
          reason: 'timeout',
          durationMs: duration,
          duration_ms: duration,
        });
        return;
      }

      const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      const rawResult = [...lines].reverse().find((line) => line.startsWith(RESULT_PREFIX));
      let parsed: RunnerResult | null = null;
      if (rawResult) {
        try {
          parsed = JSON.parse(rawResult.slice(RESULT_PREFIX.length)) as RunnerResult;
        } catch {
          parsed = null;
        }
      }

      if (parsed?.ok) {
        resolve({
          plugin: plugin.id,
          path: plugin.path,
          file: plugin.file,
          plugin_id: plugin.id,
          ok: true,
          status: 'ok',
          reason: parsed.reason || 'ok',
          durationMs: duration,
          duration_ms: duration,
        });
        return;
      }

      const reason = parsed?.reason || 'plugin_error';
      resolve({
        plugin: plugin.id,
        path: plugin.path,
        file: plugin.file,
        plugin_id: plugin.id,
        ok: false,
        status: reason === 'invalid_export' ? 'invalid_export' : 'error',
        reason,
        error: parsed?.error || stderr.trim() || undefined,
        durationMs: duration,
        duration_ms: duration,
      });
    });

    child.stdin.write(JSON.stringify({
      cwd: options.cwd,
      pluginId: plugin.id,
      pluginPath: plugin.path,
      event,
      sideEffectsEnabled,
    }));
    child.stdin.end();
  });
}

export function isHookPluginFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isHookPluginsEnabled(env);
}

export async function dispatchHookEvent(
  event: HookEventEnvelope,
  options: HookDispatchOptions = {},
): Promise<HookDispatchResult> {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const enabled = options.enabled ?? isHookPluginsEnabled(env);

  const summary: HookDispatchResult = {
    enabled,
    reason: enabled ? 'ok' : 'disabled',
    event: event.event,
    source: event.source,
    plugin_count: 0,
    results: [],
  };

  if (!enabled) {
    await appendHooksLog(cwd, {
      type: 'hook_dispatch',
      event: event.event,
      source: event.source,
      enabled: false,
      reason: 'plugins_disabled',
    });
    return summary;
  }

  const plugins = await discoverHookPlugins(cwd);
  summary.plugin_count = plugins.length;

  const inTeamWorker = isTeamWorker(env);
  const allowTeamSideEffects = options.allowTeamWorkerSideEffects ?? options.allowInTeamWorker ?? false;
  const sideEffectsEnabled = options.sideEffectsEnabled ?? (!inTeamWorker || allowTeamSideEffects);

  for (const plugin of plugins) {
    const validation = await validateHookPluginExport(plugin.path);
    if (!validation.valid) {
      const invalid: HookPluginDispatchResult = {
        plugin: plugin.id,
        path: plugin.path,
        file: plugin.file,
        plugin_id: plugin.id,
        ok: false,
        status: 'invalid_export',
        reason: validation.reason || 'invalid_export',
        durationMs: 0,
        duration_ms: 0,
      };
      summary.results.push(invalid);
      await appendHooksLog(cwd, {
        type: 'hook_plugin_dispatch',
        event: event.event,
        source: event.source,
        plugin: plugin.id,
        file: plugin.file,
        ok: false,
        status: invalid.status,
        reason: invalid.reason,
      });
      continue;
    }

    const result = await runPluginRunner(plugin, event, { ...options, cwd, env }, sideEffectsEnabled);
    summary.results.push(result);

    await appendHooksLog(cwd, {
      type: 'hook_plugin_dispatch',
      event: event.event,
      source: event.source,
      plugin: plugin.id,
      file: plugin.file,
      ok: result.ok,
      status: result.status,
      reason: result.reason,
      error: result.error,
      duration_ms: result.duration_ms,
    });
  }

  return summary;
}
