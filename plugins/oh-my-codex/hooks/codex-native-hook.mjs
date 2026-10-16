#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { extname } from 'node:path';
import { closeSync, constants as fsConstants, existsSync, fstatSync, futimesSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hookDir = dirname(fileURLToPath(import.meta.url));
// sync-plugin-mirror verifies this stable marker; runtime behavior is tested separately.
const OMX_PLUGIN_HOOK_LAUNCHER_CONTRACT_MARKER = 'omx-plugin-hook-launcher:v1';
const OMX_PLUGIN_HOOK_ROUTING_ONLY_MARKER = 'omx-plugin-hook-routing-only:v1';
const MAX_WRAPPER_STDIN_BYTES = 1024 * 1024;
const RAW_EVENT_SCAN_BYTES = 64 * 1024;
const MAX_BUFFERED_HOOK_STDOUT_BYTES = 1024 * 1024;
const MAX_ROUTING_RECORD_BYTES = 4 * 1024;
const LIVE_PIN_HELPER_TIMEOUT_MS = 5_000;
const LIVE_PIN_HELPER_KILL_GRACE_MS = 250;
const LIVE_PIN_PENDING_PREFIX = '.pending-';
const LIVE_PIN_INTENT_PREFIX = '.omx-live-pin-intent-';
const LIVE_PIN_INTENT_STAGE_PREFIX = '.stage-omx-live-pin-intent-';
const LIVE_PIN_INTENT_RENEW_INTERVAL_MS = 60_000;
const LIVE_PIN_INITIALIZATION_LEASE_MS = 5 * 60 * 1000;
const CODEX_HOOK_EVENT_NAMES = new Set([
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PreCompact',
  'PostCompact',
  'SubagentStop',
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

function parseHookPayload(input) {
  try {
    const parsed = JSON.parse(input.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sanitizeLaunchId(value) {
  return String(value ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
}

function resolveLaunchRoutingPath(payload, launchId) {
  const cwd = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd : process.cwd();
  const stateRoot = typeof process.env.OMX_ROOT === 'string' && process.env.OMX_ROOT.trim()
    ? process.env.OMX_ROOT.trim()
    : join(cwd, '.omx');
  return join(stateRoot, 'state', 'plugin-hook-routing', `${sanitizeLaunchId(launchId)}.json`);
}

function hookPayloadSessionId(input, payload) {
  const candidate = payload?.session_id ?? payload?.sessionId;
  const parsedSessionId = typeof candidate === 'string' ? candidate.trim() : '';
  if (parsedSessionId) return parsedSessionId;
  return input && typeof input.toString === 'function'
    ? extractTopLevelStringField(input.toString('utf8'), ['session_id', 'sessionId'])?.trim() ?? ''
    : '';
}

function isSafeRoutingSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isChildRoutingSessionStart(payload, ownerSessionId) {
  if ((payload?.hook_event_name ?? payload?.hookEventName) !== 'SessionStart' || !ownerSessionId) return false;
  const childSessionId = hookPayloadSessionId(null, payload);
  const cwd = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd : process.cwd();
  const stateDir = listAuthoritativeStateBaseDirs(cwd)[0];
  const transcriptCandidate = payload?.transcript_path ?? payload?.transcriptPath;
  const transcriptPath = typeof transcriptCandidate === 'string' ? transcriptCandidate.trim() : '';
  if (!childSessionId || !transcriptPath) return false;
  let fd;
  try {
    fd = openSync(transcriptPath, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytes).indexOf(0x0a);
    const firstLine = buffer.subarray(0, newline >= 0 ? newline : bytes).toString('utf8').trim();
    const record = JSON.parse(firstLine);
    const metadata = record?.type === 'session_meta' && record?.payload && typeof record.payload === 'object' ? record.payload : null;
    const spawn = metadata?.source?.subagent?.thread_spawn;
    const parentThreadId = spawn && typeof spawn === 'object' ? spawn.parent_thread_id : null;
    const metadataIds = [metadata?.id, metadata?.session_id].filter((value) => value !== undefined);
    return metadataIds.length > 0
      && metadataIds.every((value) => value === childSessionId)
      && spawn && typeof spawn === 'object'
      && typeof parentThreadId === 'string'
      && (parentThreadId === ownerSessionId
        || (isSafeRoutingSessionId(parentThreadId)
          && isTrackedSubagentInSessionTree(
            readJsonFile(join(stateDir, 'subagent-tracking.json')),
            ownerSessionId,
            parentThreadId,
          )));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

function isTrackedSubagentInSessionTree(tracking, rootSessionId, targetThreadId) {
  const pendingSessionIds = [rootSessionId];
  const visitedSessionIds = new Set();
  while (pendingSessionIds.length > 0) {
    const sessionId = pendingSessionIds.pop();
    if (!sessionId || visitedSessionIds.has(sessionId)) continue;
    visitedSessionIds.add(sessionId);
    const threads = tracking?.sessions?.[sessionId]?.threads;
    if (!threads || typeof threads !== 'object' || Array.isArray(threads)) continue;
    if (threads[targetThreadId]?.kind === 'subagent') return true;
    for (const [threadId, thread] of Object.entries(threads)) {
      if (thread?.kind !== 'subagent' || !isSafeRoutingSessionId(threadId)) continue;
      if (tracking?.sessions?.[threadId] && !visitedSessionIds.has(threadId)) pendingSessionIds.push(threadId);
    }
  }
  return false;
}

function isChildRoutingSubagentStop(payload, ownerSessionId) {
  if ((payload?.hook_event_name ?? payload?.hookEventName) !== 'SubagentStop' || !ownerSessionId) return false;
  const cwd = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd : process.cwd();
  const stateDir = listAuthoritativeStateBaseDirs(cwd)[0];
  const parentSessionId = hookPayloadSessionId(null, payload);
  if (!isSafeRoutingSessionId(parentSessionId)) return false;
  const tracking = readJsonFile(join(stateDir, 'subagent-tracking.json'));
  if (isTrackedSubagentInSessionTree(tracking, ownerSessionId, parentSessionId)) return true;
  const session = readJsonFile(join(stateDir, 'session.json'));
  if (!isSessionStateAuthoritativeForCwd(session, cwd)
    || ![session.session_id, session.native_session_id, session.owner_omx_session_id, session.owner_codex_session_id, session.codex_session_id].includes(ownerSessionId)) return false;
  return isTrackedSubagentInSessionTree(tracking, session.session_id, parentSessionId);
}

function readPinnedRoutingRecord(routingPath) {
  let fd;
  try {
    const initial = lstatSync(routingPath);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size <= 0 || initial.size > MAX_ROUTING_RECORD_BYTES) return null;
    fd = openSync(routingPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== initial.size || opened.dev !== initial.dev || opened.ino !== initial.ino) return null;
    const buffer = Buffer.alloc(opened.size);
    if (readSync(fd, buffer, 0, buffer.length, 0) !== buffer.length) return null;
    const current = lstatSync(routingPath);
    const final = fstatSync(fd);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.size !== opened.size || current.dev !== opened.dev || current.ino !== opened.ino || final.nlink !== 1 || final.size !== opened.size) return null;
    const routing = JSON.parse(buffer.toString('utf8'));
    return routing && typeof routing === 'object' && !Array.isArray(routing) ? routing : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

// This is routing correlation only. It is intentionally unauthenticated and must
// never be used as authorization or proof that a session is OMX-owned.
function isPluginHookRoutingSession(input, payload) {
  const launchId = sanitizeLaunchId(process.env.OMX_CODEX_LAUNCH_ID);
  const entryPath = process.env.OMX_ENTRY_PATH?.trim();
  const sessionId = hookPayloadSessionId(input, payload);
  if (!launchId || !entryPath || !isSafeRoutingSessionId(sessionId)) return false;

  const routingPath = resolveLaunchRoutingPath(payload, launchId);
  try {
    if (existsSync(routingPath)) {
      const routing = readPinnedRoutingRecord(routingPath);
      if (!routing) return false;
      const ownerSessionId = routing.routing === OMX_PLUGIN_HOOK_ROUTING_ONLY_MARKER && isSafeRoutingSessionId(routing.ownerSessionId)
        ? routing.ownerSessionId
        : '';
      return ownerSessionId === sessionId || isChildRoutingSessionStart(payload, ownerSessionId)
        || isChildRoutingSubagentStop(payload, ownerSessionId);
    }
    mkdirSync(dirname(routingPath), { recursive: true });
    writeFileSync(routingPath, `${JSON.stringify({ routing: OMX_PLUGIN_HOOK_ROUTING_ONLY_MARKER, ownerSessionId: sessionId })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function writePlainCodexNoop(emitJson) {
  if (emitJson) process.stdout.write('{}\n');
  process.exitCode = 0;
}

async function readBoundedStdin({ drainOversized = false } = {}) {
  const chunks = [];
  let totalBytes = 0;
  let storedBytes = 0;
  let oversized = false;
  for await (const rawChunk of process.stdin) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    totalBytes += chunk.length;

    if (oversized) continue;

    const remaining = MAX_WRAPPER_STDIN_BYTES - storedBytes;
    if (chunk.length > remaining) {
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      storedBytes += Math.max(remaining, 0);
      oversized = true;
      if (!drainOversized) return { input: Buffer.concat(chunks), oversized: true, totalBytes };
      continue;
    }
    chunks.push(chunk);
    storedBytes += chunk.length;
  }
  return { input: Buffer.concat(chunks), oversized, totalBytes };
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

function writeOversizedToolHookOutput(eventName) {
  const systemMessage = 'OMX native hook rejected oversized stdin JSON before parsing; maxBytes=1048576.';
  const output = eventName === 'PreToolUse'
    ? {
      systemMessage,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: systemMessage,
      },
    }
    : {
      continue: false,
      stopReason: 'native_hook_stdin_oversized',
      systemMessage,
    };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = 0;
}
function writeCompactFallback() {
  process.exitCode = 0;
}

function failLauncher(error, isStop, isCompact, isSubagentStop, stopReason = 'plugin_stop_hook_launcher_failure') {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[oh-my-codex] ${detail}`);
  if (isStop) {
    writeStopFallback(stopReason, detail);
    return;
  }
  if (isSubagentStop) {
    writePlainCodexNoop(true);
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

function buildSpawnOptions(command, extraEnv = {}) {
  const options = {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  };

  if (process.platform !== 'win32') return options;

  const extension = extname(command).toLowerCase();
  if (extension === '.exe' || extension === '.com') {
    return { ...options, windowsHide: true };
  }

  return { ...options, shell: true, windowsHide: true };
}

function terminateHookDelegate(child, signal) {
  if (process.platform !== 'win32' || !Number.isInteger(child.pid)) {
    child.kill(signal);
    return;
  }
  let killer;
  try {
    killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    child.kill(signal);
    return;
  }
  killer.once('error', () => child.kill(signal));
  killer.once('close', (code) => {
    if (code !== 0) child.kill(signal);
  });
  killer.unref();
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function lexicalLivePinTarget(pluginRoot) {
  const absoluteRoot = resolve(pluginRoot);
  const version = basename(absoluteRoot);
  if (!version || version === '.' || version === '..' || version.includes('/') || version.includes('\\') || version.includes('\0')) return null;
  const codexHome = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  const cacheBase = join(codexHome, 'plugins', 'cache', 'oh-my-codex-local', 'oh-my-codex');
  const expectedRoot = join(cacheBase, version);
  if (!sameLexicalFilePath(absoluteRoot, expectedRoot)) return null;
  return { pluginRoot: absoluteRoot, version, cacheBase, expectedRoot };
}

function livePinTarget(pluginRoot) {
  const target = lexicalLivePinTarget(pluginRoot);
  if (!target) return null;
  const { cacheBase } = target;
  const cacheBaseStats = lstatSync(cacheBase);
  if (!cacheBaseStats.isDirectory() || cacheBaseStats.isSymbolicLink()) return null;
  return target;
}

function livePinDirectory(pluginRoot) {
  const target = livePinTarget(pluginRoot);
  if (!target) return null;
  const { pluginRoot: absoluteRoot, version, cacheBase, expectedRoot } = target;
  let rootFd = null;
  const closeRoot = () => {
    if (rootFd === null) return;
    try { closeSync(rootFd); } catch {}
    rootFd = null;
  };
  try {
    const rootStats = lstatSync(absoluteRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return null;
    if (process.platform === 'linux') {
      rootFd = openSync(absoluteRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      const openedRootStats = fstatSync(rootFd);
      if (
        !openedRootStats.isDirectory()
        || openedRootStats.isSymbolicLink()
        || openedRootStats.dev !== rootStats.dev
        || openedRootStats.ino !== rootStats.ino
      ) {
        closeRoot();
        return null;
      }
    }
    const operationRoot = rootFd === null ? absoluteRoot : `/proc/self/fd/${rootFd}`;
    const metadataDir = join(operationRoot, '.codex-plugin');
    const metadataStats = lstatSync(metadataDir);
    if (!metadataStats.isDirectory() || metadataStats.isSymbolicLink()) {
      closeRoot();
      return null;
    }
    const manifestText = readNoFollowText(join(metadataDir, 'plugin.json'), 16 * 1024)?.content;
    let manifest;
    try { manifest = manifestText ? JSON.parse(manifestText) : null; } catch { manifest = null; }
    if (manifest?.name !== 'oh-my-codex' || manifest.version !== version || !sameFilePath(absoluteRoot, expectedRoot)) {
      closeRoot();
      return null;
    }
    for (const marker of ['.omx-managed', '.omx-complete']) {
      const stats = lstatSync(join(operationRoot, marker));
      if (!stats.isFile() || stats.isSymbolicLink()) {
        closeRoot();
        return null;
      }
    }
    const pinDir = join(operationRoot, '.omx-live-pin');
    try {
      const pinDirStats = lstatSync(pinDir);
      if (!pinDirStats.isDirectory() || pinDirStats.isSymbolicLink()) {
        closeRoot();
        return null;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        closeRoot();
        return null;
      }
    }
    return { path: pinDir, pluginRoot: absoluteRoot, version, cacheBase, rootDev: rootStats.dev, rootIno: rootStats.ino, rootFd };
  } catch (error) {
    closeRoot();
    throw error;
  }
}

function livePinRootMatches(pinState) {
  try {
    // The open descriptor follows a snapshot into quarantine; the published path must still name it.
    const namedRootStats = lstatSync(pinState.pluginRoot);
    if (
      !namedRootStats.isDirectory()
      || namedRootStats.isSymbolicLink()
      || namedRootStats.dev !== pinState.rootDev
      || namedRootStats.ino !== pinState.rootIno
    ) return false;
    const currentStats = pinState.rootFd === null
      ? namedRootStats
      : fstatSync(pinState.rootFd);
    return currentStats.isDirectory()
      && !currentStats.isSymbolicLink()
      && currentStats.dev === pinState.rootDev
      && currentStats.ino === pinState.rootIno;
  } catch {
    return false;
  }
}

function closeLivePinDirectory(pinState) {
  if (!pinState || pinState.rootFd === null) return;
  try { closeSync(pinState.rootFd); } catch {}
}

function livePinRetirementGateExists(pinDir) {
  try {
    lstatSync(join(pinDir, '.omx-retiring'));
    return true;
  } catch (error) {
    return error?.code !== 'ENOENT';
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function processStartHashForPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    let identity = null;
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const close = stat.lastIndexOf(')');
      if (close >= 0) {
        const fields = stat.slice(close + 2).trim().split(/\s+/);
        const startTicks = fields[19];
        if (bootId && /^\d+$/.test(startTicks ?? '')) identity = `linux:${bootId}:${startTicks}`;
      }
    } else if (process.platform === 'darwin') {
      const value = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
      }).trim();
      if (value) identity = `darwin:${value}`;
    } else if (process.platform === 'win32') {
      const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
      const value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3_000,
        windowsHide: true,
      }).trim();
      if (/^\d+$/.test(value)) identity = `win32:${value}`;
    }
    return identity ? createHash('sha256').update(identity).digest('hex').slice(0, 24) : null;
  } catch {
    return null;
  }
}

function sameFileIdentity(left, right) {
  return Number.isInteger(left?.dev) && Number.isInteger(left?.ino)
    && Number.isInteger(right?.dev) && Number.isInteger(right?.ino)
    && left.dev === right.dev && left.ino === right.ino;
}

function readNoFollowText(path, maxBytes, { allowHardLinks = false } = {}) {
  let fd = null;
  try {
    const pathStats = lstatSync(path);
    const validLinkCount = pathStats.nlink === 1 || (allowHardLinks && pathStats.nlink === 2);
    if (!pathStats.isFile() || pathStats.isSymbolicLink() || !validLinkCount || pathStats.size <= 0 || pathStats.size > maxBytes) return null;
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const openedStats = fstatSync(fd);
    if (!openedStats.isFile() || openedStats.isSymbolicLink() || !sameFileIdentity(openedStats, pathStats) || openedStats.nlink !== pathStats.nlink) return null;
    const content = readFileSync(fd, 'utf8');
    if (Buffer.byteLength(content) > maxBytes) return null;
    const afterStats = lstatSync(path);
    if (!sameFileIdentity(afterStats, pathStats) || afterStats.nlink !== pathStats.nlink) return null;
    return { stats: openedStats, content };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
}

function livePinVersionHash(version) {
  return createHash('sha256').update(version).digest('hex').slice(0, 24);
}

function livePinMutationLockName(version) {
  const versionHash = livePinVersionHash(version);
  return `.omx-live-pin-${versionHash}.lock`;
}

function livePinIntentLockName(version) {
  const versionHash = livePinVersionHash(version);
  return `.omx-live-pin-intent-${versionHash}.lock`;
}

function readLivePinMutationLock(path) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { stats: null, content: null, record: null, regular: false };
  }
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.nlink !== 1 && stats.nlink !== 2) || stats.size <= 0 || stats.size > 256) {
    return { stats, content: null, record: null, regular: false };
  }
  const file = readNoFollowText(path, 256, { allowHardLinks: true });
  if (!file || !sameFileIdentity(file.stats, stats) || file.stats.nlink !== stats.nlink) {
    return { stats, content: null, record: null, regular: false };
  }
  let record;
  try {
    record = JSON.parse(file.content);
  } catch {
    return { stats, content: file.content, record: null, regular: true };
  }
  if (
    record?.version !== 1
    || !Number.isSafeInteger(record.pid)
    || record.pid <= 0
    || (record.operation !== 'pin' && record.operation !== 'retire')
    || typeof record.token !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.token)
  ) return { stats, content: file.content, record: null, regular: true };
  if (stats.nlink === 2) {
    const stagePath = `${path}.stage-${record.pid}-${record.token}`;
    const stage = readNoFollowText(stagePath, 256, { allowHardLinks: true });
    if (!stage || !sameFileIdentity(stage.stats, stats) || stage.content !== file.content) {
      return { stats, content: file.content, record: null, regular: false };
    }
  }
  return { stats, content: file.content, record, regular: true };
}

function removeVerifiedLockEntry(path, expectedStats, expectedContent, canRemove = () => true) {
  try {
    const current = readNoFollowText(path, 256, { allowHardLinks: true });
    if (!current || !sameFileIdentity(current.stats, expectedStats) || current.content !== expectedContent) return false;
    const quarantinePath = `${path}.reclaim-${process.pid}-${randomUUID()}`;
    renameSync(path, quarantinePath);
    const restore = () => {
      try {
        const quarantined = lstatSync(quarantinePath);
        if (!quarantined.isFile() || quarantined.isSymbolicLink() || !sameFileIdentity(quarantined, expectedStats)) return;
        linkSync(quarantinePath, path);
        const restored = lstatSync(path);
        if (sameFileIdentity(restored, expectedStats)) unlinkSync(quarantinePath);
      } catch {}
    };
    const quarantined = readNoFollowText(quarantinePath, 256, { allowHardLinks: true });
    if (!quarantined || !sameFileIdentity(quarantined.stats, expectedStats) || quarantined.content !== expectedContent || !canRemove()) {
      restore();
      return false;
    }
    const final = readNoFollowText(quarantinePath, 256, { allowHardLinks: true });
    if (!final || !sameFileIdentity(final.stats, expectedStats) || final.content !== expectedContent || !canRemove()) {
      restore();
      return false;
    }
    unlinkSync(quarantinePath);
    return true;
  } catch {
    return false;
  }
}

function removeLockStageLink(path, state) {
  if (state?.stats?.nlink === 1) return true;
  if (state?.stats?.nlink !== 2 || !state.record || !state.content) return false;
  const stagePath = `${path}.stage-${state.record.pid}-${state.record.token}`;
  if (!removeVerifiedLockEntry(stagePath, state.stats, state.content)) return false;
  const refreshed = readLivePinMutationLock(path);
  return refreshed?.content === state.content
    && refreshed.record?.pid === state.record.pid
    && sameFileIdentity(refreshed.stats, state.stats)
    && refreshed.stats.nlink === 1;
}

function removeDeadLivePinMutationLock(path, state) {
  // A live PID is never stolen by age. If PID reuse makes a dead owner look
  // live, preserving the lock is safer than racing a paused pin/removal.
  if (!state?.stats || !state.regular || !state.record || isProcessAlive(state.record.pid)) return false;
  if (!removeLockStageLink(path, state)) return false;
  const refreshed = readLivePinMutationLock(path);
  if (
    refreshed?.content !== state.content
    || !refreshed.record
    || refreshed.record.pid !== state.record.pid
    || !sameFileIdentity(refreshed.stats, state.stats)
    || refreshed.stats.nlink !== 1
    || isProcessAlive(refreshed.record.pid)
  ) return false;
  return removeVerifiedLockEntry(path, refreshed.stats, refreshed.content, () => !isProcessAlive(refreshed.record.pid));
}

function acquireLivePinMutationLock(target, operation, lockName = livePinMutationLockName(target.version)) {
  const path = join(target.cacheBase, lockName);
  const token = randomUUID();
  const content = `${JSON.stringify({ version: 1, pid: process.pid, operation, token })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = readLivePinMutationLock(path);
    if (existing) {
      if (removeDeadLivePinMutationLock(path, existing)) continue;
      return null;
    }
    const stagePath = `${path}.stage-${process.pid}-${token}`;
    let stageStats = null;
    let linked = false;
    try {
      // Link a complete staged record into place so readers cannot observe a
      // partially written lock; the record identifies the recoverable stage.
      writeFileSync(stagePath, content, { flag: 'wx', mode: 0o600 });
      stageStats = lstatSync(stagePath);
      try {
        linkSync(stagePath, path);
        linked = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      if (stageStats) removeVerifiedLockEntry(stagePath, stageStats, content);
      if (!linked) continue;
      const acquired = readLivePinMutationLock(path);
      if (acquired?.content === content && acquired.record?.pid === process.pid) {
        return { path, content, dev: acquired.stats.dev, ino: acquired.stats.ino };
      }
      if (acquired?.content === content && acquired.stats) {
        removeVerifiedLockEntry(path, acquired.stats, content, () => isProcessAlive(process.pid));
      }
      return null;
    } catch (error) {
      if (stageStats) removeVerifiedLockEntry(stagePath, stageStats, content);
      if (error?.code !== 'EEXIST') return null;
    }
  }
  return null;
}

function livePinMutationLockMatches(lock) {
  if (!lock) return false;
  const state = readLivePinMutationLock(lock.path);
  return state?.regular
    && state.content === lock.content
    && state.record?.pid === process.pid
    && state.stats.dev === lock.dev
    && state.stats.ino === lock.ino;
}

function hasLivePinMutationLock(pluginRoot) {
  let target;
  try {
    target = livePinTarget(pluginRoot);
  } catch {
    return true;
  }
  if (!target) return false;
  try {
    return readLivePinMutationLock(join(target.cacheBase, livePinMutationLockName(target.version))) !== null;
  } catch {
    return true;
  }
}

function releaseLivePinMutationLock(lock) {
  if (!livePinMutationLockMatches(lock)) return;
  const state = readLivePinMutationLock(lock.path);
  if (!state || !removeLockStageLink(lock.path, state)) return;
  const refreshed = readLivePinMutationLock(lock.path);
  if (refreshed?.content === lock.content && refreshed.record?.pid === process.pid && refreshed.stats.nlink === 1) {
    removeVerifiedLockEntry(lock.path, refreshed.stats, lock.content, () => isProcessAlive(process.pid));
  }
}

function pendingSessionIntentName(version, sessionHash) {
  return `${LIVE_PIN_INTENT_PREFIX}${livePinVersionHash(version)}-${sessionHash}.json`;
}

function leaseInvalidationObserver() {
  const listeners = new Set();
  let invalidated = false;
  return {
    invalidate() {
      if (invalidated) return;
      invalidated = true;
      for (const listener of listeners) listener();
      listeners.clear();
    },
    onInvalidated(listener) {
      if (invalidated) {
        listener();
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function readPendingSessionRegistration(pinPath, sessionHash) {
  const file = readNoFollowText(pinPath, 256, { allowHardLinks: true });
  if (!file) return null;
  let record;
  try { record = JSON.parse(file.content); } catch { return null; }
  if (
    record?.version !== 1
    || record.sessionHash !== sessionHash
    || Object.keys(record).some((key) => key !== 'version' && key !== 'sessionHash')
  ) return null;
  return { ...file, record };
}

function readPendingSessionIntent(path, version, sessionHash) {
  const file = readNoFollowText(path, 256, { allowHardLinks: true });
  if (!file) return null;
  let record;
  try { record = JSON.parse(file.content); } catch { return null; }
  if (
    record?.version !== 1
    || record.cacheVersion !== version
    || record.sessionHash !== sessionHash
    || Object.keys(record).some((key) => key !== 'version' && key !== 'cacheVersion' && key !== 'sessionHash')
  ) return null;
  return { ...file, record };
}

function hasPendingSessionRegistration(pluginRoot, sessionId) {
  let target;
  try {
    target = livePinTarget(pluginRoot);
  } catch {
    return false;
  }
  if (!target) return false;
  const sessionHash = createHash('sha256').update(sessionId.trim()).digest('hex');
  const path = join(target.cacheBase, pendingSessionIntentName(target.version, sessionHash));
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') return true;
  }
  if (stats) {
    if (!stats.isFile() || stats.isSymbolicLink() || (stats.nlink !== 1 && stats.nlink !== 2) || stats.size <= 0 || stats.size > 256) return true;
    const intent = readPendingSessionIntent(path, target.version, sessionHash);
    if (!intent || !sameFileIdentity(intent.stats, stats)) return true;
    return true;
  }

  let pinState;
  try {
    pinState = livePinDirectory(pluginRoot);
  } catch {
    return false;
  }
  if (!pinState) return false;
  try {
    const pendingPath = join(pinState.path, `${LIVE_PIN_PENDING_PREFIX}${sessionHash}.json`);
    const pending = readPendingSessionRegistration(pendingPath, sessionHash);
    // This pin-directory marker is also written by the CLI registration path.
    // Retain it after a failed SessionStart so a recent stale durable pin cannot
    // suppress the next registration attempt.
    return pending !== null;
  } finally {
    closeLivePinDirectory(pinState);
  }
}

function renewPendingFileLease(path, expectedStats) {
  let fd = null;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || (before.nlink !== 1 && before.nlink !== 2) || !sameFileIdentity(before, expectedStats)) return false;
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFileIdentity(opened, expectedStats) || opened.nlink !== before.nlink) return false;
    const now = new Date();
    futimesSync(fd, now, now);
    const after = fstatSync(fd);
    const namedAfter = lstatSync(path);
    return sameFileIdentity(after, expectedStats)
      && sameFileIdentity(namedAfter, expectedStats)
      && namedAfter.nlink === after.nlink;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
}

function pendingLeaseIsFresh(stats) {
  const ageMs = Date.now() - stats.mtimeMs;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= LIVE_PIN_INITIALIZATION_LEASE_MS;
}

function isFreshPendingSessionPin(path, expectedStats = null) {
  if (typeof path !== 'string') return false;
  const match = basename(path).match(/^\.pending-([0-9a-f]{64})\.json$/);
  if (!match) return false;
  const pending = readPendingSessionRegistration(path, match[1]);
  return Boolean(
    pending
    && (!expectedStats || sameFileIdentity(pending.stats, expectedStats))
    && pendingLeaseIsFresh(pending.stats),
  );
}

function isFreshPendingSessionIntent(pluginRoot, sessionId, expectedStats = null) {
  let target;
  try {
    target = livePinTarget(pluginRoot);
  } catch {
    return false;
  }
  if (!target || typeof sessionId !== 'string') return false;
  const sessionHash = createHash('sha256').update(sessionId.trim()).digest('hex');
  const path = join(target.cacheBase, pendingSessionIntentName(target.version, sessionHash));
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return false;
  }
  const intent = readPendingSessionIntent(path, target.version, sessionHash);
  return Boolean(
    intent
    && sameFileIdentity(intent.stats, stats)
    && (!expectedStats || sameFileIdentity(intent.stats, expectedStats))
    && pendingLeaseIsFresh(intent.stats),
  );
}

function writePendingSessionRegistration(pluginRoot, sessionId, expectedIntentStats = null) {
  let cacheBaseFd = null;
  let pinState = null;
  let stagePath = null;
  let stageStats = null;
  let stageContent = null;
  let intentLock = null;
  try {
    const target = livePinTarget(pluginRoot);
    if (!target) return false;
    intentLock = acquireLivePinMutationLock(target, 'pin', livePinIntentLockName(target.version));
    if (!intentLock) return false;
    pinState = livePinDirectory(pluginRoot);
    if (!pinState || pinState.version !== target.version || pinState.cacheBase !== target.cacheBase || !livePinRootMatches(pinState)) return false;
    const sessionHash = createHash('sha256').update(sessionId.trim()).digest('hex');
    const versionHash = livePinVersionHash(target.version);
    const baseStats = lstatSync(target.cacheBase);
    if (!baseStats.isDirectory() || baseStats.isSymbolicLink()) return false;
    let cacheBasePath = target.cacheBase;
    if (process.platform === 'linux') {
      cacheBaseFd = openSync(target.cacheBase, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      const openedBaseStats = fstatSync(cacheBaseFd);
      if (!openedBaseStats.isDirectory() || !sameFileIdentity(openedBaseStats, baseStats)) return false;
      cacheBasePath = `/proc/self/fd/${cacheBaseFd}`;
    }
    const name = pendingSessionIntentName(target.version, sessionHash);
    const pendingPath = join(cacheBasePath, name);
    const content = `${JSON.stringify({ version: 1, cacheVersion: target.version, sessionHash })}\n`;
    const cacheBaseStillNamed = () => {
      if (process.platform === 'linux') return true;
      try {
        const current = lstatSync(target.cacheBase);
        return current.isDirectory() && !current.isSymbolicLink() && sameFileIdentity(current, baseStats);
      } catch {
        return false;
      }
    };
    const rootStillNamed = () => livePinRootMatches(pinState) && livePinMutationLockMatches(intentLock);
    try {
      const existingStats = lstatSync(pendingPath);
      if (!existingStats.isFile() || existingStats.isSymbolicLink() || (existingStats.nlink !== 1 && existingStats.nlink !== 2)) return false;
      const existing = readPendingSessionIntent(pendingPath, target.version, sessionHash);
      if (!existing || existing.stats.dev !== existingStats.dev || existing.stats.ino !== existingStats.ino) return false;
      if (expectedIntentStats && !sameFileIdentity(existing.stats, expectedIntentStats)) return false;
      if (!cacheBaseStillNamed() || !rootStillNamed()) return false;
      return renewPendingFileLease(pendingPath, existingStats)
        && cacheBaseStillNamed()
        && rootStillNamed();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (expectedIntentStats) return false;
    }

    stagePath = join(cacheBasePath, `${LIVE_PIN_INTENT_STAGE_PREFIX}${versionHash}-${sessionHash}-${process.pid}-${randomUUID()}`);
    writeFileSync(stagePath, content, { flag: 'wx', mode: 0o600 });
    stageStats = lstatSync(stagePath);
    stageContent = content;
    if (!cacheBaseStillNamed() || !rootStillNamed()) {
      removeVerifiedLockEntry(stagePath, stageStats, content);
      return false;
    }
    let published = false;
    try {
      linkSync(stagePath, pendingPath);
      published = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    } finally {
      removeVerifiedLockEntry(stagePath, stageStats, content);
      stagePath = null;
      stageStats = null;
      stageContent = null;
    }
    if (!published) {
      const existing = readPendingSessionIntent(pendingPath, target.version, sessionHash);
      if (!existing || !sameFileIdentity(existing.stats, lstatSync(pendingPath))) return false;
      if (!renewPendingFileLease(pendingPath, existing.stats)) return false;
    }
    if (!cacheBaseStillNamed() || !rootStillNamed()) return false;
    // This sidecar intent survives snapshot quarantine on every platform. The
    // lock-owning CLI writer commits the durable pin and then removes the intent.
    return true;
  } catch {
    return false;
  } finally {
    if (stagePath && stageStats && stageContent !== null) removeVerifiedLockEntry(stagePath, stageStats, stageContent);
    releaseLivePinMutationLock(intentLock);
    closeLivePinDirectory(pinState);
    if (cacheBaseFd !== null) {
      try { closeSync(cacheBaseFd); } catch {}
    }
  }
}

function startPendingSessionIntentLease(pluginRoot, sessionId) {
  let target;
  try {
    target = livePinTarget(pluginRoot);
  } catch {
    return null;
  }
  if (!target || !writePendingSessionRegistration(pluginRoot, sessionId)) return null;
  const sessionHash = createHash('sha256').update(sessionId.trim()).digest('hex');
  const path = join(target.cacheBase, pendingSessionIntentName(target.version, sessionHash));
  const content = `${JSON.stringify({ version: 1, cacheVersion: target.version, sessionHash })}\n`;
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return null;
  }
  const intent = readPendingSessionIntent(path, target.version, sessionHash);
  if (!intent || !sameFileIdentity(intent.stats, stats)) return null;

  const invalidation = leaseInvalidationObserver();
  let leaseValid = true;
  const invalidate = () => {
    if (!leaseValid) return;
    leaseValid = false;
    invalidation.invalidate();
  };
  const renew = () => {
    if (!leaseValid) return;
    try {
      const current = lstatSync(path);
      if (!sameFileIdentity(current, stats) || !writePendingSessionRegistration(pluginRoot, sessionId, stats)) {
        invalidate();
      }
    } catch {
      invalidate();
    }
  };
  const timer = setInterval(renew, LIVE_PIN_INTENT_RENEW_INTERVAL_MS);
  timer.unref();
  return {
    isValid() {
      if (!leaseValid || !isFreshPendingSessionIntent(pluginRoot, sessionId, stats)) {
        invalidate();
        return false;
      }
      return true;
    },
    onInvalidated(listener) {
      return invalidation.onInvalidated(listener);
    },
    preserve() {
      clearInterval(timer);
    },
    cleanup() {
      clearInterval(timer);
      removeVerifiedLockEntry(path, stats, content);
    },
  };
}

function hasKnownLiveSessionPin(pluginRoot, sessionId) {
  const sessionHash = createHash('sha256').update(sessionId.trim()).digest('hex');
  let pinState;
  try {
    pinState = livePinDirectory(pluginRoot);
  } catch {
    return false;
  }
  if (!pinState) return false;
  try {
    for (const entry of readdirSync(pinState.path, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.startsWith('pin-')) continue;
      const pinPath = join(pinState.path, entry.name);
      const stats = lstatSync(pinPath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size <= 0 || stats.size > 4096) continue;
      const file = readNoFollowText(pinPath, 4096);
      if (!file || !sameFileIdentity(file.stats, stats)) continue;
      let record;
      try { record = JSON.parse(file.content); } catch { continue; }
      const expectedName = typeof record?.sessionHash === 'string'
        ? `pin-${record.pid}-${record.sessionHash.slice(0, 24)}-${record.processStartHash ?? 'unknown'}.json`
        : '';
      if (
        record?.version === 1
        && Number.isSafeInteger(record.pid)
        && record.pid > 0
        && (record.processStartHash === null || (typeof record.processStartHash === 'string' && /^[0-9a-f]{24}$/.test(record.processStartHash)))
        && record.sessionHash === sessionHash
        && entry.name === expectedName
        && !Object.keys(record).some((key) => !['version', 'pid', 'processStartHash', 'sessionHash'].includes(key))
        && isProcessAlive(record.pid)
        && record.processStartHash !== null
        && processStartHashForPid(record.pid) === record.processStartHash
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    closeLivePinDirectory(pinState);
  }
}

function hasLivePinForDelegate(pluginRoot) {
  let pinState;
  try {
    pinState = livePinDirectory(pluginRoot);
  } catch (error) {
    return error?.code !== 'ENOENT';
  }
  if (!pinState) {
    try {
      lstatSync(join(resolve(pluginRoot), '.omx-live-pin'));
      return true;
    } catch (error) {
      return error?.code !== 'ENOENT';
    }
  }
  try {
    for (const entry of readdirSync(pinState.path, { withFileTypes: true })) {
      if (!entry.name.startsWith('pin-')) continue;
      // Retirement treats any unreadable or malformed durable pin entry as a
      // reason to preserve the snapshot; keep an already-running delegate too.
      if (!entry.isFile() || entry.isSymbolicLink()) return true;
      const pinPath = join(pinState.path, entry.name);
      const stats = lstatSync(pinPath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size <= 0 || stats.size > 4096) return true;
      const file = readNoFollowText(pinPath, 4096);
      if (!file || !sameFileIdentity(file.stats, stats)) return true;
      let record;
      try { record = JSON.parse(file.content); } catch { return true; }
      const expectedName = typeof record?.sessionHash === 'string'
        ? `pin-${record.pid}-${record.sessionHash.slice(0, 24)}-${record.processStartHash ?? 'unknown'}.json`
        : '';
      if (
        record?.version !== 1
        || !Number.isSafeInteger(record.pid)
        || record.pid <= 0
        || (record.processStartHash !== null && (typeof record.processStartHash !== 'string' || !/^[0-9a-f]{24}$/.test(record.processStartHash)))
        || typeof record.sessionHash !== 'string'
        || !/^[0-9a-f]{64}$/.test(record.sessionHash)
        || entry.name !== expectedName
      ) return true;
      if (!isProcessAlive(record.pid)) continue;
      if (record.processStartHash === null) return true;
      const currentProcessStartHash = processStartHashForPid(record.pid);
      if (currentProcessStartHash === null || currentProcessStartHash === record.processStartHash) return true;
    }
    return false;
  } catch (error) {
    return error?.code !== 'ENOENT';
  } finally {
    closeLivePinDirectory(pinState);
  }
}

function writePendingSessionPin(pluginRoot, sessionId, stableSessionMarker = false) {
  let pinState;
  let mutationLock;
  try {
    const target = livePinTarget(pluginRoot);
    if (!target) return null;
    mutationLock = acquireLivePinMutationLock(target, 'pin');
    if (!mutationLock) return null;
    pinState = livePinDirectory(pluginRoot);
    if (!pinState || pinState.version !== target.version || pinState.cacheBase !== target.cacheBase || !livePinRootMatches(pinState)) return null;
    const pinDir = pinState.path;
    try {
      mkdirSync(pinDir, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const pinDirStats = lstatSync(pinDir);
    if (!pinDirStats.isDirectory() || pinDirStats.isSymbolicLink()) return null;
    if (livePinRetirementGateExists(pinDir) || !livePinRootMatches(pinState) || !livePinMutationLockMatches(mutationLock)) return null;
    // This is a leased bootstrap guard, not the durable session record. A unique
    // pending marker expires after a crash instead of pinning on a reused PID.
    const sessionHash = stableSessionMarker
      ? createHash('sha256').update(sessionId.trim()).digest('hex')
      : createHash('sha256').update(`${sessionId.trim()}\0${process.pid}\0${randomUUID()}`).digest('hex');
    const record = { version: 1, sessionHash };
    const content = `${JSON.stringify(record)}\n`;
    const stageName = `.stage-pending-${sessionHash}-${process.pid}-${randomUUID()}`;
    const pinName = `${LIVE_PIN_PENDING_PREFIX}${sessionHash}.json`;
    const stagePath = join(pinDir, stageName);
    const pinPath = join(pinDir, pinName);
    const cleanupPath = join(pluginRoot, '.omx-live-pin', pinName);
    try {
      writeFileSync(stagePath, content, { flag: 'wx', mode: 0o600 });
      if (livePinRetirementGateExists(pinDir) || !livePinRootMatches(pinState) || !livePinMutationLockMatches(mutationLock)) {
        removePendingSessionPin(stagePath);
        return null;
      }
      try {
        linkSync(stagePath, pinPath);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = readPendingSessionRegistration(pinPath, sessionHash);
        if (!existing) return null;
      }
      removePendingSessionPin(stagePath);
      if (livePinRetirementGateExists(pinDir) || !livePinRootMatches(pinState) || !livePinMutationLockMatches(mutationLock)) {
        removePendingSessionPin(pinPath);
        return null;
      }
      return cleanupPath;
    } catch (error) {
      try { unlinkSync(stagePath); } catch {}
      throw error;
    }
  } catch {
    return null;
  } finally {
    releaseLivePinMutationLock(mutationLock);
    closeLivePinDirectory(pinState);
  }
}

function startPendingSessionPinLease(pluginRoot, sessionId, stableSessionMarker = false) {
  const path = writePendingSessionPin(pluginRoot, sessionId, stableSessionMarker);
  if (!path) return null;
  const match = basename(path).match(/^\.pending-([0-9a-f]{64})\.json$/);
  const pending = match ? readPendingSessionRegistration(path, match[1]) : null;
  if (!pending) {
    removePendingSessionPin(path);
    return null;
  }
  const stats = pending.stats;
  const invalidation = leaseInvalidationObserver();
  let leaseValid = true;
  const invalidate = () => {
    if (!leaseValid) return;
    leaseValid = false;
    invalidation.invalidate();
  };
  const renew = () => {
    if (!leaseValid) return;
    if (!renewPendingSessionPinLease(pluginRoot, path, match[1], stats)) invalidate();
  };
  const timer = setInterval(renew, LIVE_PIN_INTENT_RENEW_INTERVAL_MS);
  timer.unref();
  return {
    path,
    isValid() {
      if (!leaseValid || !isFreshPendingSessionPin(path, stats)) {
        invalidate();
        return false;
      }
      return true;
    },
    onInvalidated(listener) {
      return invalidation.onInvalidated(listener);
    },
    preserve() {
      clearInterval(timer);
    },
    cleanup() {
      clearInterval(timer);
      removePendingSessionPin(path);
    },
  };
}

function renewPendingSessionPinLease(pluginRoot, path, sessionHash, expectedStats) {
  let pinState = null;
  let mutationLock = null;
  try {
    const target = livePinTarget(pluginRoot);
    if (!target || !sameLexicalFilePath(path, join(pluginRoot, '.omx-live-pin', basename(path)))) return false;
    mutationLock = acquireLivePinMutationLock(target, 'pin');
    if (!mutationLock) return false;
    pinState = livePinDirectory(pluginRoot);
    if (
      !pinState
      || pinState.version !== target.version
      || pinState.cacheBase !== target.cacheBase
      || !livePinRootMatches(pinState)
      || !livePinMutationLockMatches(mutationLock)
      || livePinRetirementGateExists(pinState.path)
    ) return false;
    const pinPath = join(pinState.path, basename(path));
    const pending = readPendingSessionRegistration(pinPath, sessionHash);
    if (!pending || !sameFileIdentity(pending.stats, expectedStats)) return false;
    return renewPendingFileLease(pinPath, expectedStats)
      && livePinRootMatches(pinState)
      && !livePinRetirementGateExists(pinState.path)
      && livePinMutationLockMatches(mutationLock);
  } catch {
    return false;
  } finally {
    releaseLivePinMutationLock(mutationLock);
    closeLivePinDirectory(pinState);
  }
}

function removePendingSessionPin(pinPath) {
  if (!pinPath) return;
  try {
    const pendingHash = basename(pinPath).match(/^(?:\.pending-|\.stage-pending-)([0-9a-f]{64})(?:\.json|-)/)?.[1];
    if (!pendingHash) return;
    const pending = readPendingSessionRegistration(pinPath, pendingHash);
    if (!pending) return;
    removeVerifiedLockEntry(pinPath, pending.stats, pending.content);
  } catch {}
}

function cleanupPendingSessionPin(pendingPin) {
  if (pendingPin && typeof pendingPin.cleanup === 'function') {
    pendingPin.cleanup();
    return;
  }
  removePendingSessionPin(pendingPin);
}

function finishSessionPendingPin(pluginRoot, sessionId, pendingPin) {
  if (pendingPin && sessionId && hasPendingSessionRegistration(pluginRoot, sessionId)) {
    if (typeof pendingPin.preserve === 'function') pendingPin.preserve();
    return;
  }
  cleanupPendingSessionPin(pendingPin);
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

function sameLexicalFilePath(leftPath, rightPath) {
  const left = resolve(leftPath);
  const right = resolve(rightPath);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
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


function parseJsonObjectCandidate(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isJsonObjectFragmentLine(text) {
  return text.startsWith('{') || text.endsWith('}') || /^"[^"]+"\s*:/.test(text);
}

function parseSingleJsonObjectOutput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const direct = parseJsonObjectCandidate(text);
  if (direct) return direct;

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lastLine = lines.at(-1);
  if (!lastLine || !lastLine.startsWith('{') || !lastLine.endsWith('}')) return null;
  for (const line of lines.slice(0, -1)) {
    if (parseJsonObjectCandidate(line) || isJsonObjectFragmentLine(line)) return null;
  }
  return parseJsonObjectCandidate(lastLine);
}

async function pinUnroutedSession(input, launcher, pluginRoot, pendingPin, sessionId) {
  let registered = false;
  try {
    if (!launcher) return false;
    const { command, argsPrefix } = launcher;
    const child = spawn(
      command,
      [...argsPrefix, 'codex-native-hook', '--plugin-cache-pin-only'],
      buildSpawnOptions(command, {
        OMX_PLUGIN_ROOT: pluginRoot,
        OMX_PLUGIN_CACHE_PIN_PENDING: '1',
      }),
    );
    child.stdout.resume();
    child.stderr.pipe(process.stderr);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const result = await new Promise((resolveChild) => {
      let settled = false;
      let killTimeout;
      let timedOut = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        console.error('[oh-my-codex] live plugin cache pin helper timed out; a later hook may retry');
        child.kill('SIGTERM');
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.unpipe(process.stderr);
        child.stderr.destroy();
        killTimeout = setTimeout(() => {
          if (settled) return;
          child.kill('SIGKILL');
          finish(null, 'SIGKILL');
        }, LIVE_PIN_HELPER_KILL_GRACE_MS);
      }, LIVE_PIN_HELPER_TIMEOUT_MS);
      const finish = (code, signal, error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimeout) clearTimeout(killTimeout);
        resolveChild({ code, signal, error, timedOut });
      };
      child.once('error', (error) => {
        console.error(`[oh-my-codex] unable to launch live plugin cache pin writer: ${error.message}`);
        finish(null, null, error);
      });
      child.once('close', (code, signal) => finish(code, signal));
    });
    registered = result.code === 0 && !result.signal && !result.error && !result.timedOut;
    return registered;
  } catch (error) {
    console.error(`[oh-my-codex] unable to launch live plugin cache pin writer: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    finishSessionPendingPin(pluginRoot, sessionId, pendingPin);
  }
}

async function main() {
  const pluginRoot = resolve(hookDir, '..');
  const doctorSmoke = process.env.OMX_NATIVE_HOOK_DOCTOR_SMOKE === '1';
  let managedCacheStartup = false;
  if (!doctorSmoke) {
    try {
      managedCacheStartup = lexicalLivePinTarget(pluginRoot) !== null;
    } catch {
      managedCacheStartup = true;
    }
  }
  const startupSessionId = `wrapper-${process.pid}-${randomUUID()}`;
  const startupIntentCleanup = doctorSmoke ? null : startPendingSessionIntentLease(pluginRoot, startupSessionId);
  if (startupIntentCleanup) process.once('exit', startupIntentCleanup.cleanup);
  const startupPendingPin = doctorSmoke ? null : startPendingSessionPinLease(pluginRoot, startupSessionId);
  if (startupPendingPin) process.once('exit', startupPendingPin.cleanup);

  let pinnedLauncherAtStart = null;
  let pinnedLauncherReadError = null;
  if (startupPendingPin || !hasLivePinMutationLock(pluginRoot)) {
    try {
      pinnedLauncherAtStart = readPinnedLauncher();
    } catch (error) {
      pinnedLauncherReadError = error;
    }
  }
  let configuredLauncherAtStart = null;
  let configuredLauncherError = null;
  try {
    configuredLauncherAtStart = process.env.OMX_NATIVE_HOOK_COMMAND
      ? { command: process.env.OMX_NATIVE_HOOK_COMMAND, argsPrefix: [] }
      : pinnedLauncherAtStart ?? { command: 'omx', argsPrefix: [] };
    if (!process.env.OMX_NATIVE_HOOK_COMMAND && pinnedLauncherReadError) {
      configuredLauncherError = pinnedLauncherReadError;
    }
  } catch (error) {
    configuredLauncherError = error;
  }

  const { input, oversized, totalBytes } = await readBoundedStdin({ drainOversized: true });
  const payload = parseHookPayload(input);
  const eventName = extractTopLevelHookEventName(input.toString('utf8'));
  const routedByLaunchCorrelation = isPluginHookRoutingSession(input, payload);
  const isStop = detectStopHookInput(input);
  const isSubagentStop = eventName === 'SubagentStop';
  const isCompact = detectCompactHookInput(input);
  const sessionId = payload?.session_id ?? payload?.sessionId;
  const sessionStart = (payload?.hook_event_name ?? payload?.hookEventName ?? payload?.event ?? payload?.name) === 'SessionStart';
  const validSessionId = !doctorSmoke
    && !oversized
    && typeof sessionId === 'string'
    && sessionId.trim().length > 0
    && sessionId.trim().length <= 256;
  const pendingRegistration = validSessionId && hasPendingSessionRegistration(pluginRoot, sessionId);
  let sessionIntentPublished = false;
  let sessionIntentLease = null;
  let pinRegistrationPending = false;
  let pendingPin = null;
  if (managedCacheStartup && validSessionId) {
    pinRegistrationPending = true;
    sessionIntentLease = startPendingSessionIntentLease(pluginRoot, sessionId);
    sessionIntentPublished = sessionIntentLease !== null;
    if (sessionIntentLease) process.once('exit', sessionIntentLease.preserve);
    pendingPin = startPendingSessionPinLease(pluginRoot, sessionId, true);
  }

  const startupIntentValid = startupIntentCleanup?.isValid() ?? false;
  const startupPendingPinValid = startupPendingPin?.isValid() ?? false;
  const sessionIntentValid = validSessionId
    && sessionIntentPublished
    && (sessionIntentLease?.isValid() ?? isFreshPendingSessionIntent(pluginRoot, sessionId));
  const pendingPinValid = pendingPin && typeof pendingPin.isValid === 'function'
    ? pendingPin.isValid()
    : isFreshPendingSessionPin(pendingPin);

  if (
    managedCacheStartup
    && !startupIntentValid
    && !startupPendingPinValid
    && !sessionIntentValid
    && !pendingPinValid
    && !(validSessionId && hasKnownLiveSessionPin(pluginRoot, sessionId))
  ) {
    writePlainCodexNoop(isStop || isSubagentStop);
    return;
  }

  if (!routedByLaunchCorrelation) {
    const pinLauncher = configuredLauncherAtStart;
    if (pinRegistrationPending) await pinUnroutedSession(input, pinLauncher, pluginRoot, pendingPin, sessionId);
    sessionIntentLease?.preserve();
    writePlainCodexNoop(isStop || isSubagentStop);
    return;
  }

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
    if (eventName === 'PreToolUse' || eventName === 'PostToolUse') {
      writeOversizedToolHookOutput(eventName);
      return;
    }
    if (eventName === 'SubagentStop') {
      writePlainCodexNoop(true);
      return;
    }
    console.error(`[oh-my-codex] ${message}`);
    process.exitCode = 1;
    return;
  }

  if (configuredLauncherError || !configuredLauncherAtStart) {
    finishSessionPendingPin(pluginRoot, sessionId, pendingPin);
    failLauncher(configuredLauncherError ?? new Error('plugin hook launcher is unavailable'), isStop, isCompact, isSubagentStop);
    return;
  }

  const { command, argsPrefix } = configuredLauncherAtStart;
  const extraEnv = { OMX_PLUGIN_ROOT: pluginRoot };
  if (pinRegistrationPending) {
    extraEnv.OMX_PLUGIN_CACHE_PIN_PENDING = '1';
    // Temporary leases protect only this registration attempt, never a delegated hook.
    extraEnv.OMX_PLUGIN_CACHE_PIN_REQUIRED = '1';
  }
  const child = spawn(
    command,
    [...argsPrefix, 'codex-native-hook'],
    buildSpawnOptions(command, extraEnv),
  );

  let childClosed = false;
  let protectionLost = false;
  let checkingProtection = false;
  let protectionKillTimeout = null;
  const protectionLeases = [...new Set([
    startupIntentCleanup,
    startupPendingPin,
    sessionIntentLease,
    pendingPin,
  ].filter((lease) => lease && typeof lease.isValid === 'function'))];
  const stopChildWithoutProtection = () => {
    if (childClosed || protectionLost || checkingProtection) return;
    checkingProtection = true;
    try {
      if (protectionLeases.some((lease) => lease.isValid())) return;
      if (hasLivePinForDelegate(pluginRoot)) return;
      protectionLost = true;
      console.error('[oh-my-codex] stopping native hook delegate after all live plugin cache guards were lost');
      terminateHookDelegate(child, 'SIGTERM');
      protectionKillTimeout = setTimeout(() => {
        if (!childClosed) terminateHookDelegate(child, 'SIGKILL');
      }, LIVE_PIN_HELPER_KILL_GRACE_MS);
      protectionKillTimeout.unref?.();
    } finally {
      checkingProtection = false;
    }
  };
  const removeProtectionListeners = protectionLeases
    .filter((lease) => typeof lease.onInvalidated === 'function')
    .map((lease) => lease.onInvalidated(stopChildWithoutProtection));

  const stdoutChunks = [];
  let stdoutBytes = 0;
  let bufferedHookStdoutBytes = 0;
  let hookStdoutOversized = false;
  let childSpawnError = null;
  let childStdinError = null;

  child.stdout.on('data', (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stdoutBytes += buffer.byteLength;
    if (isStop || isSubagentStop) {
      if (!hookStdoutOversized) {
        const remaining = MAX_BUFFERED_HOOK_STDOUT_BYTES - bufferedHookStdoutBytes;
        if (remaining > 0) {
          const slice = buffer.subarray(0, remaining);
          stdoutChunks.push(slice);
          bufferedHookStdoutBytes += slice.byteLength;
        }
        if (buffer.byteLength > remaining) {
          hookStdoutOversized = true;
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
    finishSessionPendingPin(pluginRoot, sessionId, pendingPin);
    sessionIntentLease?.preserve();
  });
  child.on('close', (code, signal) => {
    childClosed = true;
    if (protectionKillTimeout) clearTimeout(protectionKillTimeout);
    for (const removeListener of removeProtectionListeners) removeListener();
    finishSessionPendingPin(pluginRoot, sessionId, pendingPin);
    sessionIntentLease?.preserve();
    if (protectionLost) {
      if (isStop) {
        writeStopFallback('plugin_stop_hook_cache_pin_lease_lost', 'native hook delegate lost every live plugin cache guard before completion');
      } else if (isSubagentStop) {
        writePlainCodexNoop(true);
      } else {
        process.exitCode = 1;
      }
      return;
    }
    if (isStop && hookStdoutOversized) {
      writeStopFallback('plugin_stop_hook_launcher_stdout_oversized', `codex-native-hook produced more than ${MAX_BUFFERED_HOOK_STDOUT_BYTES} bytes of Stop hook stdout`);
      return;
    }

    if (isSubagentStop) {
      if (!hookStdoutOversized && !childSpawnError && !childStdinError && !signal && code === 0) {
        const stdoutText = Buffer.concat(stdoutChunks).toString('utf8');
        const parsed = parseSingleJsonObjectOutput(stdoutText);
        if (parsed) {
          process.stdout.write(`${JSON.stringify(parsed)}\n`);
          process.exitCode = 0;
          return;
        }
      }
      writePlainCodexNoop(true);
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
