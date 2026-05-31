#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hookDir = dirname(fileURLToPath(import.meta.url));
const MAX_WRAPPER_STDIN_BYTES = 1024 * 1024;
const RAW_EVENT_SCAN_BYTES = 64 * 1024;
const CODEX_HOOK_EVENT_NAMES = new Set([
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PreCompact',
  'PostCompact',
  'Stop',
]);

function skipJsonWhitespace(raw, index) {
  while (index < raw.length && /\s/.test(raw[index] ?? '')) index += 1;
  return index;
}

function readJsonStringLiteral(raw, quoteIndex) {
  if (raw[quoteIndex] !== '"') return null;
  let value = '';
  for (let index = quoteIndex + 1; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"') return { value, endIndex: index + 1 };
    if (char !== '\\') {
      value += char;
      continue;
    }

    index += 1;
    if (index >= raw.length) return null;
    const escaped = raw[index];
    switch (escaped) {
      case '"':
      case '\\':
      case '/':
        value += escaped;
        break;
      case 'b':
        value += '\b';
        break;
      case 'f':
        value += '\f';
        break;
      case 'n':
        value += '\n';
        break;
      case 'r':
        value += '\r';
        break;
      case 't':
        value += '\t';
        break;
      case 'u': {
        const hex = raw.slice(index + 1, index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
        break;
      }
      default:
        return null;
    }
  }
  return null;
}

function extractTopLevelHookEventName(rawInput) {
  const raw = rawInput.slice(0, RAW_EVENT_SCAN_BYTES);
  const wanted = new Set(['hook_event_name', 'hookEventName', 'event', 'name']);
  let depth = 0;
  let index = 0;

  while (index < raw.length) {
    const char = raw[index];
    if (char === '"') {
      const key = readJsonStringLiteral(raw, index);
      if (!key) return null;
      index = key.endIndex;
      const afterKey = skipJsonWhitespace(raw, index);
      if (depth === 1 && raw[afterKey] === ':' && wanted.has(key.value)) {
        const valueStart = skipJsonWhitespace(raw, afterKey + 1);
        const value = readJsonStringLiteral(raw, valueStart);
        const eventName = value?.value ?? null;
        return CODEX_HOOK_EVENT_NAMES.has(eventName) ? eventName : null;
      }
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') depth = Math.max(0, depth - 1);
    index += 1;
  }

  return null;
}

function detectStopHookInput(input) {
  const text = input.toString('utf8');
  try {
    const parsed = JSON.parse(text);
    const eventName = parsed?.hook_event_name ?? parsed?.hookEventName ?? parsed?.event ?? parsed?.name;
    return eventName === 'Stop';
  } catch {
    return extractTopLevelHookEventName(text) === 'Stop';
  }
}

async function readBoundedStdin() {
  const chunks = [];
  let totalBytes = 0;
  for await (const rawChunk of process.stdin) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    totalBytes += chunk.length;
    if (totalBytes > MAX_WRAPPER_STDIN_BYTES) {
      const remaining = MAX_WRAPPER_STDIN_BYTES - Buffer.concat(chunks).length;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      return { input: Buffer.concat(chunks), oversized: true, totalBytes };
    }
    chunks.push(chunk);
  }
  return { input: Buffer.concat(chunks), oversized: false, totalBytes };
}

function stopFallbackOutput(stopReason, detail) {
  const reason = 'OMX plugin Stop hook launcher failed before valid native Stop JSON could be produced. Continue once, preserve runtime state, inspect hook launcher diagnostics, and retry.';
  return {
    decision: 'block',
    reason,
    stopReason,
    systemMessage: detail ? `${reason} Failure: ${detail}` : reason,
  };
}

function writeStopFallback(stopReason, detail) {
  process.stdout.write(`${JSON.stringify(stopFallbackOutput(stopReason, detail))}\n`);
  process.exitCode = 0;
}

function failLauncher(error, isStop, stopReason = 'plugin_stop_hook_launcher_failure') {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[oh-my-codex] ${detail}`);
  if (isStop) {
    writeStopFallback(stopReason, detail);
    return;
  }
  process.exitCode = 1;
}

function readPinnedLauncher() {
  const launcherPath = join(hookDir, 'omx-command.json');
  try {
    const raw = JSON.parse(readFileSync(launcherPath, 'utf8'));
    if (typeof raw.command !== 'string' || raw.command.trim() === '') {
      throw new Error('missing non-empty command');
    }
    const argsPrefix = Array.isArray(raw.argsPrefix) ? raw.argsPrefix : [];
    if (!argsPrefix.every((arg) => typeof arg === 'string')) {
      throw new Error('argsPrefix must contain only strings');
    }
    return { command: raw.command, argsPrefix };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`invalid plugin hook launcher ${launcherPath}: ${error.message}`);
  }
}

function readConfiguredLauncher() {
  if (process.env.OMX_NATIVE_HOOK_COMMAND) {
    return { command: process.env.OMX_NATIVE_HOOK_COMMAND, argsPrefix: [] };
  }
  return readPinnedLauncher() ?? { command: 'omx', argsPrefix: [] };
}

async function main() {
  const { input, oversized, totalBytes } = await readBoundedStdin();
  const isStop = detectStopHookInput(input);

  if (oversized) {
    const message = `plugin hook stdin exceeded ${MAX_WRAPPER_STDIN_BYTES} bytes before launcher delegation; totalBytes>${totalBytes}`;
    if (isStop) {
      console.error(`[oh-my-codex] ${message}`);
      writeStopFallback('plugin_stop_hook_stdin_oversized', message);
      return;
    }
    console.error(`[oh-my-codex] ${message}`);
    process.exitCode = 1;
    return;
  }

  let launcher;
  try {
    launcher = readConfiguredLauncher();
  } catch (error) {
    failLauncher(error, isStop);
    return;
  }

  const { command, argsPrefix } = launcher;
  const child = spawn(command, [...argsPrefix, 'codex-native-hook'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    shell: process.platform === 'win32',
  });

  let stdoutBytes = 0;
  let childSpawnError = null;
  let childStdinError = null;

  child.stdout.on('data', (chunk) => {
    stdoutBytes += Buffer.byteLength(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.pipe(process.stderr);
  child.stdin.on('error', (error) => {
    childStdinError = error;
  });
  child.on('error', (error) => {
    childSpawnError = error;
  });
  child.on('close', (code, signal) => {
    if (isStop && stdoutBytes === 0) {
      if (childSpawnError) {
        writeStopFallback('plugin_stop_hook_launcher_spawn_error', `failed to launch ${command} codex-native-hook: ${childSpawnError.message}`);
        return;
      }
      if (signal) {
        writeStopFallback('plugin_stop_hook_launcher_signal', `codex-native-hook terminated by ${signal}`);
        return;
      }
      if (code && code !== 0) {
        if (childStdinError) {
          writeStopFallback('plugin_stop_hook_launcher_stdin_error', `codex-native-hook stdin failed: ${childStdinError.message}`);
          return;
        }
        writeStopFallback('plugin_stop_hook_launcher_exit', `codex-native-hook exited with code ${code}`);
        return;
      }
      writeStopFallback('plugin_stop_hook_launcher_empty_stdout', 'codex-native-hook exited successfully without producing Stop hook JSON');
      return;
    }

    if (childSpawnError) {
      console.error(`[oh-my-codex] failed to launch ${command} codex-native-hook: ${childSpawnError.message}`);
      process.exitCode = 1;
      return;
    }
    if (signal) {
      console.error(`[oh-my-codex] codex-native-hook terminated by ${signal}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 0;
  });

  child.stdin.end(input);
}

main().catch((error) => {
  console.error(`[oh-my-codex] plugin hook launcher failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
