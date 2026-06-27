#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { extname } from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hookDir = dirname(fileURLToPath(import.meta.url));
// sync-plugin-mirror verifies this stable marker; runtime behavior is tested separately.
const OMX_PLUGIN_HOOK_LAUNCHER_CONTRACT_MARKER = 'omx-plugin-hook-launcher:v1';
const MAX_WRAPPER_STDIN_BYTES = 1024 * 1024;
const RAW_EVENT_SCAN_BYTES = 64 * 1024;
const MAX_STOP_STDOUT_BYTES = 1024 * 1024;
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

function extractTopLevelStringField(rawInput, fieldNames) {
  const raw = rawInput.slice(0, RAW_EVENT_SCAN_BYTES);
  const wanted = new Set(fieldNames);
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
        return value?.value ?? null;
      }
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') depth = Math.max(0, depth - 1);
    index += 1;
  }

  return null;
}

function extractTopLevelHookEventName(rawInput) {
  const eventName = extractTopLevelStringField(rawInput, ['hook_event_name', 'hookEventName', 'event', 'name']);
  return CODEX_HOOK_EVENT_NAMES.has(eventName) ? eventName : null;
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

function detectCompactHookInput(input) {
  const text = input.toString('utf8');
  try {
    const parsed = JSON.parse(text);
    const eventName = parsed?.hook_event_name ?? parsed?.hookEventName ?? parsed?.event ?? parsed?.name;
    return eventName === 'PreCompact' || eventName === 'PostCompact';
  } catch {
    const eventName = extractTopLevelHookEventName(text);
    return eventName === 'PreCompact' || eventName === 'PostCompact';
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

function writeOversizedStopFallback(stopReason, detail) {
  const reason =
    'OMX plugin Stop rejected oversized stdin before launcher delegation; continue once with a smaller valid Stop JSON response.';
  process.stdout.write(`${JSON.stringify({
    decision: 'block',
    reason,
    stopReason,
    systemMessage: detail ? `${reason} Failure: ${detail}` : reason,
  })}\n`);
  process.exitCode = 0;
}

function writeOversizedStopNoop() {
  process.stdout.write('{}\n');
  process.exitCode = 0;
}

function writeCompactFallback() {
  process.exitCode = 0;
}

function failLauncher(error, isStop, isCompact, stopReason = 'plugin_stop_hook_launcher_failure') {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[oh-my-codex] ${detail}`);
  if (isStop) {
    writeStopFallback(stopReason, detail);
    return;
  }
  if (isCompact) {
    writeCompactFallback();
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

function buildSpawnOptions(command) {
  const options = {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  };

  if (process.platform !== 'win32') return options;

  const extension = extname(command).toLowerCase();
  if (extension === '.exe' || extension === '.com') {
    return { ...options, windowsHide: true };
  }

  return { ...options, shell: true, windowsHide: true };
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function isTerminalOutcome(value) {
  return ['finish', 'finished', 'complete', 'completed', 'done', 'blocked', 'blocked-on-user', 'blocked_on_user', 'failed', 'fail', 'error', 'cancelled', 'canceled', 'cancel', 'aborted', 'abort', 'userinterlude', 'user-interlude', 'interrupted', 'interrupt', 'askuserquestion', 'ask-user-question', 'askuser', 'question'].includes(String(value ?? '').trim().toLowerCase());
}

function isTerminalRunStateForMode(state, mode) {
  if (!state) return false;
  const runMode = String(state.mode ?? '').trim();
  if (runMode && runMode !== mode) return false;
  return isTerminalOutcome(state.outcome)
    || isTerminalOutcome(state.run_outcome)
    || isTerminalOutcome(state.lifecycle_outcome)
    || isTerminalOutcome(state.terminal_outcome);
}

function canonicalPath(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return absolute;
  try {
    return typeof realpathSync.native === 'function' ? realpathSync.native(absolute) : realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function sameFilePath(leftPath, rightPath) {
  return canonicalPath(leftPath) === canonicalPath(rightPath);
}

function isSessionStateAuthoritativeForCwd(state, cwd) {
  if (!isSafeSessionId(state?.session_id)) return false;
  const sessionCwd = typeof state.cwd === 'string' ? state.cwd.trim() : '';
  return !sessionCwd || sameFilePath(sessionCwd, cwd);
}

function listAuthoritativeStateBaseDirs(cwd) {
  if (process.env.OMX_TEAM_STATE_ROOT?.trim()) return [process.env.OMX_TEAM_STATE_ROOT.trim()];
  if (process.env.OMX_ROOT?.trim()) return [join(process.env.OMX_ROOT.trim(), '.omx', 'state')];
  if (process.env.OMX_STATE_ROOT?.trim()) return [join(process.env.OMX_STATE_ROOT.trim(), '.omx', 'state')];
  return [join(cwd, '.omx', 'state')];
}

function isSafeSessionId(sessionId) {
  return typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(sessionId.trim());
}

function readCurrentSessionId(stateBaseDirs, cwd) {
  for (const stateDir of stateBaseDirs) {
    const session = readJsonFile(join(stateDir, 'session.json'));
    if (isSessionStateAuthoritativeForCwd(session, cwd)) return session.session_id.trim();
  }
  const envSessionId = process.env.OMX_SESSION_ID || process.env.CODEX_SESSION_ID;
  return isSafeSessionId(envSessionId) ? envSessionId.trim() : null;
}

function shouldContinueAutopilotState(state) {
  if (state?.active !== true) return false;
  return !(isTerminalOutcome(state.current_phase)
    || isTerminalOutcome(state.run_outcome)
    || isTerminalOutcome(state.lifecycle_outcome)
    || isTerminalOutcome(state.terminal_outcome)
    || isTerminalOutcome(state.outcome)
    || (typeof state.completed_at === 'string' && state.completed_at.trim() !== ''));
}

function hasActiveAutopilotStateForOversizedStop(input) {
  const text = input.toString('utf8');
  const cwd = extractTopLevelStringField(text, ['cwd']) || process.cwd();
  const stateBaseDirs = listAuthoritativeStateBaseDirs(cwd);
  const sessionId = readCurrentSessionId(stateBaseDirs, cwd);
  if (!isSafeSessionId(sessionId)) return false;

  const sessionDir = join(stateBaseDirs[0], 'sessions', sessionId.trim());
  const terminalRunState = readJsonFile(join(sessionDir, 'run-state.json'));
  if (isTerminalRunStateForMode(terminalRunState, 'autopilot')) return false;

  const sessionState = readJsonFile(join(sessionDir, 'autopilot-state.json'));
  return shouldContinueAutopilotState(sessionState);
}


function parseSingleJsonObjectOutput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function main() {
  const { input, oversized, totalBytes } = await readBoundedStdin();
  const isStop = detectStopHookInput(input);
  const isCompact = detectCompactHookInput(input);

  if (oversized) {
    const message = `plugin hook stdin exceeded ${MAX_WRAPPER_STDIN_BYTES} bytes before launcher delegation; totalBytes>${totalBytes}`;
    if (isStop) {
      if (hasActiveAutopilotStateForOversizedStop(input)) {
        console.error(`[oh-my-codex] ${message}`);
        writeOversizedStopFallback('plugin_stop_hook_stdin_oversized_active_workflow', message);
        return;
      }
      writeOversizedStopNoop();
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
    failLauncher(error, isStop, isCompact);
    return;
  }

  const { command, argsPrefix } = launcher;
  const child = spawn(command, [...argsPrefix, 'codex-native-hook'], buildSpawnOptions(command));

  const stdoutChunks = [];
  let stdoutBytes = 0;
  let bufferedStopStdoutBytes = 0;
  let stopStdoutOversized = false;
  let childSpawnError = null;
  let childStdinError = null;

  child.stdout.on('data', (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stdoutBytes += buffer.byteLength;
    if (isStop) {
      if (!stopStdoutOversized) {
        const remaining = MAX_STOP_STDOUT_BYTES - bufferedStopStdoutBytes;
        if (remaining > 0) {
          const slice = buffer.subarray(0, remaining);
          stdoutChunks.push(slice);
          bufferedStopStdoutBytes += slice.byteLength;
        }
        if (buffer.byteLength > remaining) {
          stopStdoutOversized = true;
          child.stdout.destroy();
          child.kill();
        }
      }
    } else if (!isCompact) {
      process.stdout.write(chunk);
    }
  });
  child.stderr.pipe(process.stderr);
  child.stdin.on('error', (error) => {
    childStdinError = error;
  });
  child.on('error', (error) => {
    childSpawnError = error;
  });
  child.on('close', (code, signal) => {
    if (isStop && stopStdoutOversized) {
      writeStopFallback('plugin_stop_hook_launcher_stdout_oversized', `codex-native-hook produced more than ${MAX_STOP_STDOUT_BYTES} bytes of Stop hook stdout`);
      return;
    }

    if (isStop && stdoutBytes > 0) {
      const stdoutText = Buffer.concat(stdoutChunks).toString('utf8');
      const parsed = parseSingleJsonObjectOutput(stdoutText);
      if (parsed) {
        process.stdout.write(`${JSON.stringify(parsed)}\n`);
        process.exitCode = 0;
        return;
      }
      writeStopFallback('plugin_stop_hook_launcher_invalid_stdout', `codex-native-hook produced invalid Stop hook JSON stdout (${stdoutBytes} bytes)`);
      return;
    }

    if (isCompact) {
      process.exitCode = 0;
      return;
    }

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

    if (isCompact) {
      if (childSpawnError) {
        console.error(`[oh-my-codex] failed to launch ${command} codex-native-hook: ${childSpawnError.message}`);
      } else if (signal) {
        console.error(`[oh-my-codex] codex-native-hook terminated by ${signal}`);
      } else if (code && code !== 0) {
        console.error(`[oh-my-codex] codex-native-hook exited with code ${code}`);
      }
      process.exitCode = 0;
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
