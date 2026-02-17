#!/usr/bin/env node

import { existsSync } from 'fs';
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const cwd = resolve(argValue('--cwd', process.cwd()));
const runOnce = process.argv.includes('--once');
const pollMs = Math.max(250, asNumber(argValue('--poll-ms', process.env.OMX_HOOK_DERIVED_POLL_MS || '800'), 800));
const maxFileAgeMs = Math.max(10_000, asNumber(argValue('--file-age-ms', process.env.OMX_HOOK_DERIVED_FILE_AGE_MS || '90000'), 90000));

const omxDir = join(cwd, '.omx');
const logsDir = join(omxDir, 'logs');
const stateDir = join(omxDir, 'state');
const watcherStatePath = join(stateDir, 'hook-derived-watcher-state.json');
const logPath = join(logsDir, `hook-derived-watcher-${new Date().toISOString().split('T')[0]}.jsonl`);

const fileState = new Map();
let stopping = false;
let flushedOnShutdown = false;

function safeString(value) {
  return typeof value === 'string' ? value : '';
}

function derivedLog(entry) {
  return appendFile(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`).catch(() => {});
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function sessionDirs() {
  const now = new Date();
  const today = join(
    homedir(),
    '.codex',
    'sessions',
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0')
  );
  const yesterdayDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterday = join(
    homedir(),
    '.codex',
    'sessions',
    String(yesterdayDate.getUTCFullYear()),
    String(yesterdayDate.getUTCMonth() + 1).padStart(2, '0'),
    String(yesterdayDate.getUTCDate()).padStart(2, '0')
  );
  return Array.from(new Set([today, yesterday]));
}

async function readFirstLine(path) {
  const content = await readFile(path, 'utf-8');
  const idx = content.indexOf('\n');
  return idx >= 0 ? content.slice(0, idx) : content;
}

function shouldTrackSessionMeta(line) {
  const parsed = parseJsonLine(line);
  if (!parsed || parsed.type !== 'session_meta' || !parsed.payload) return null;
  const payload = parsed.payload;
  if (safeString(payload.cwd) !== cwd) return null;
  const threadId = safeString(payload.id);
  if (!threadId) return null;
  return {
    threadId,
    sessionId: threadId,
  };
}

async function discoverRolloutFiles() {
  const now = Date.now();
  const discovered = [];
  for (const dir of sessionDirs()) {
    if (!existsSync(dir)) continue;
    const names = await readdir(dir).catch(() => []);
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      const st = await stat(path).catch(() => null);
      if (!st) continue;
      if (now - st.mtimeMs > maxFileAgeMs) continue;
      discovered.push(path);
    }
  }
  discovered.sort();
  return discovered;
}

function inferDerivedEvent(parsed, meta) {
  if (!parsed || parsed.type !== 'event_msg' || !parsed.payload) return null;

  const payload = parsed.payload;
  const payloadType = safeString(payload.type).toLowerCase();
  const timestamp = safeString(parsed.timestamp) || new Date().toISOString();
  const turnId = safeString(payload.turn_id || parsed.turn_id || parsed.id);

  const base = {
    schema_version: '1',
    timestamp,
    source: 'derived',
    context: {
      parser_reason: '',
      payload_type: payloadType || 'unknown',
    },
    session_id: meta.sessionId,
    thread_id: meta.threadId,
    turn_id: turnId || undefined,
  };

  if (['tool_call_start', 'tool_use_start', 'tool_start', 'tool_invocation_start'].includes(payloadType)) {
    return {
      ...base,
      event: 'pre-tool-use',
      confidence: 0.8,
      parser_reason: `payload_type:${payloadType}`,
      context: {
        ...base.context,
        parser_reason: `payload_type:${payloadType}`,
        tool_name: safeString(payload.tool_name || payload.tool || payload.name),
      },
    };
  }

  if (['tool_call_end', 'tool_use_end', 'tool_end', 'tool_invocation_end'].includes(payloadType)) {
    return {
      ...base,
      event: 'post-tool-use',
      confidence: 0.8,
      parser_reason: `payload_type:${payloadType}`,
      context: {
        ...base.context,
        parser_reason: `payload_type:${payloadType}`,
        tool_name: safeString(payload.tool_name || payload.tool || payload.name),
        tool_ok: payload.ok === true,
      },
    };
  }

  if (payloadType === 'assistant_message') {
    const message = safeString(payload.text || payload.message || payload.content);
    const looksLikeQuestion = /\?|\b(can you|could you|please provide|need input|what should)/i.test(message);
    if (looksLikeQuestion) {
      return {
        ...base,
        event: 'needs-input',
        confidence: 0.55,
        parser_reason: 'assistant_message_heuristic_question',
        context: {
          ...base.context,
          parser_reason: 'assistant_message_heuristic_question',
          preview: message.slice(0, 200),
        },
      };
    }
  }

  return null;
}

async function dispatchDerivedEvent(event) {
  try {
    const { dispatchHookEvent } = await import('../dist/hooks/extensibility/dispatcher.js');
    await dispatchHookEvent(event, {
      cwd,
      allowTeamWorkerSideEffects: false,
    });
    await derivedLog({
      type: 'derived_event_dispatch',
      event: event.event,
      source: event.source,
      confidence: event.confidence,
      thread_id: event.thread_id,
      turn_id: event.turn_id,
      parser_reason: event.parser_reason,
      ok: true,
    });
  } catch (err) {
    await derivedLog({
      type: 'derived_event_dispatch',
      event: event.event,
      source: event.source,
      thread_id: event.thread_id,
      turn_id: event.turn_id,
      parser_reason: event.parser_reason,
      ok: false,
      error: err instanceof Error ? err.message : 'dispatch_failed',
    });
  }
}

async function ensureTrackedFiles() {
  const files = await discoverRolloutFiles();
  for (const path of files) {
    if (fileState.has(path)) continue;
    const firstLine = await readFirstLine(path).catch(() => '');
    const meta = shouldTrackSessionMeta(firstLine);
    if (!meta) continue;
    const size = (await stat(path).catch(() => ({ size: 0 }))).size || 0;
    const offset = runOnce ? 0 : size;
    fileState.set(path, {
      ...meta,
      offset,
      partial: '',
      dispatched: 0,
    });
  }
}

async function processLine(meta, line) {
  const parsed = parseJsonLine(line);
  const derived = inferDerivedEvent(parsed, meta);
  if (!derived) return;
  await dispatchDerivedEvent(derived);
  meta.dispatched += 1;
}

async function pollFiles() {
  for (const [path, meta] of fileState.entries()) {
    const currentSize = (await stat(path).catch(() => ({ size: 0 }))).size || 0;
    if (currentSize <= meta.offset) continue;

    const content = await readFile(path, 'utf-8').catch(() => '');
    if (!content) continue;

    const delta = content.slice(meta.offset);
    meta.offset = currentSize;
    const merged = meta.partial + delta;
    const lines = merged.split('\n');
    meta.partial = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      await processLine(meta, line);
    }
  }
}

async function writeState() {
  await mkdir(stateDir, { recursive: true }).catch(() => {});
  const tracked = Array.from(fileState.values()).reduce((sum, item) => sum + item.dispatched, 0);
  const state = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    cwd,
    poll_ms: pollMs,
    max_file_age_ms: maxFileAgeMs,
    tracked_files: fileState.size,
    dispatched_events: tracked,
  };
  await writeFile(watcherStatePath, JSON.stringify(state, null, 2)).catch(() => {});
}

async function flushOnce(reason) {
  if (flushedOnShutdown) return;
  flushedOnShutdown = true;
  await ensureTrackedFiles();
  await pollFiles();
  await writeState();
  await derivedLog({ type: 'watcher_flush', reason });
}

async function tick() {
  if (stopping) return;
  await ensureTrackedFiles();
  await pollFiles();
  await writeState();
  setTimeout(tick, pollMs);
}

function shutdown(signal) {
  stopping = true;
  flushOnce(`signal:${signal}`)
    .finally(() => derivedLog({ type: 'watcher_stop', signal }))
    .finally(() => process.exit(0));
}

async function main() {
  if (process.env.OMX_HOOK_DERIVED_SIGNALS !== '1') {
    process.exit(0);
  }

  await mkdir(dirname(logPath), { recursive: true }).catch(() => {});
  await mkdir(stateDir, { recursive: true }).catch(() => {});

  await derivedLog({
    type: 'watcher_start',
    cwd,
    poll_ms: pollMs,
    max_file_age_ms: maxFileAgeMs,
    once: runOnce,
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  if (runOnce) {
    await flushOnce('once');
    await derivedLog({ type: 'watcher_once_complete' });
    process.exit(0);
  }

  await tick();
}

main().catch(async (err) => {
  await mkdir(dirname(logPath), { recursive: true }).catch(() => {});
  await derivedLog({
    type: 'watcher_error',
    reason: 'fatal',
    error: err instanceof Error ? err.message : 'unknown_error',
  });
  process.exit(1);
});
