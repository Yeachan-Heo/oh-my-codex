import { writeSync } from 'fs';
import { basename } from 'path';
import { pathToFileURL } from 'url';
import { createHookPluginSdk } from './sdk.js';
import { readStdin } from './plugin-runner-stdin.js';
import type { HookEventEnvelope, HookPluginModule } from './types.js';

interface RunnerRequest {
  cwd: string;
  pluginId?: string;
  pluginPath: string;
  event: HookEventEnvelope;
  sideEffectsEnabled?: boolean;
}

interface RunnerResult {
  ok: boolean;
  plugin: string;
  reason: string;
  error?: string;
}

const RESULT_PREFIX = '__OMX_PLUGIN_RESULT__ ';

function emitResult(result: RunnerResult): void {
  writeSync(process.stdout.fd, `${RESULT_PREFIX}${JSON.stringify(result)}\n`);
}

function finish(result: RunnerResult, exitCode: number): void {
  process.exitCode = exitCode;
  emitResult(result);
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw) {
    finish({ ok: false, plugin: 'unknown', reason: 'empty_request' }, 1);
    return;
  }

  let request: RunnerRequest;
  try {
    request = JSON.parse(raw) as RunnerRequest;
  } catch {
    finish({ ok: false, plugin: 'unknown', reason: 'invalid_json' }, 1);
    return;
  }

  const pluginId = (request.pluginId || basename(request.pluginPath || 'unknown')).trim() || 'unknown';

  try {
    const moduleUrl = `${pathToFileURL(request.pluginPath).href}?t=${Date.now()}`;
    const loaded = await import(moduleUrl) as HookPluginModule;
    if (typeof loaded.onHookEvent !== 'function') {
      finish({ ok: false, plugin: pluginId, reason: 'invalid_export' }, 1);
      return;
    }

    const sdk = createHookPluginSdk({
      cwd: request.cwd,
      pluginName: pluginId,
      event: request.event,
      sideEffectsEnabled: request.sideEffectsEnabled !== false,
    });

    await Promise.resolve(loaded.onHookEvent(request.event, sdk));
    finish({ ok: true, plugin: pluginId, reason: 'ok' }, 0);
  } catch (error) {
    finish({
      ok: false,
      plugin: pluginId,
      reason: 'runner_error',
      error: error instanceof Error ? error.message : String(error),
    }, 1);
  }
}

await main().catch((error) => {
  finish({
    ok: false,
    plugin: 'unknown',
    reason: 'runner_error',
    error: error instanceof Error ? error.message : String(error),
  }, 1);
});
