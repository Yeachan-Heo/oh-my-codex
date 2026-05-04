#!/usr/bin/env node

import { existsSync } from 'fs';
import { appendFile, mkdir, open, readFile, readdir, stat, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { StringDecoder } from 'string_decoder';
import {
  buildOperationalContext,
  classifyExecCommand,
  parseCommandResult,
  parseExecCommandArgs,
} from './notify-hook/operational-events.js';

function argValue(name: string, fallback = ''): string {
  const idx = process.argv.indexOf(name);
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

function asNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const cwd = resolve(argValue('--cwd', process.cwd()));
const runOnce = process.argv.includes('--once');
const pollMs = Math.max(250, asNumber(argValue('--poll-ms', process.env.OMX_HOOK_DERIVED_POLL_MS || '800'), 800));
const maxFileAgeMs = Math.max(10_000, asNumber(argValue('--file-age-ms', process.env.OMX_HOOK_DERIVED_FILE_AGE_MS || '90000'), 90000));

const runtimeRoot = resolve(process.env.OMX_ROOT || process.env.OMX_STATE_ROOT || cwd);
const omxDir = join(runtimeRoot, '.omx');
const logsDir = join(omxDir, 'logs');
const stateDir = join(omxDir, 'state');
const watcherStatePath = join(stateDir, 'hook-derived-watcher-state.json');
const logPath = join(logsDir, `hook-derived-watcher-${new Date().toISOString().split('T')[0]}.jsonl`);

interface FileMeta {
  threadId: string;
  sessionId: string;
  offset: number;
  partial: string;
  dispatched: number;
  currentTurnId: string;
  decoder: StringDecoder;
}

interface PendingCall {
  kind: string;
  callId: string;
  command: string;
  workdir: string;
  toolName: string;
  threadId: string;
  sessionId: string;
  turnId: string | undefined;
}

const fileState = new Map<string, FileMeta>();
const pendingCalls = new Map<string, PendingCall>();
let stopping = false;
let flushedOnShutdown = false;

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function collectMessageTextFragments(value: unknown, fragments: string[]): void {
  if (typeof value === 'string') {
    if (value.trim() !== '') fragments.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectMessageTextFragments(item, fragments);
    return;
  }

  if (!value || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  let usedPreferredField = false;
  for (const key of ['text', 'message', 'content']) {
    if (!(key in record)) continue;
    usedPreferredField = true;
    collectMessageTextFragments(record[key], fragments);
  }
  if (usedPreferredField) return;

  for (const child of Object.values(record)) {
    collectMessageTextFragments(child, fragments);
  }
}

function extractMessageText(payload: Record<string, unknown>): string {
  for (const candidate of [payload.text, payload.message, payload.content]) {
    if (typeof candidate === 'string') {
      if (candidate.trim() !== '') return candidate;
      continue;
    }

    const fragments: string[] = [];
    collectMessageTextFragments(candidate, fragments);
    const text = fragments.join('\n').trim();
    if (text) return text;
  }
  return '';
}

function derivedLog(entry: Record<string, unknown>): Promise<void> {
  return appendFile(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`).catch(() => {});
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sessionDirs(): string[] {
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

async function readFirstLine(path: string): Promise<string> {
  const content = await readFile(path, 'utf-8');
  const idx = content.indexOf('\n');
  return idx >= 0 ? content.slice(0, idx) : content;
}

function shouldTrackSessionMeta(line: string): { threadId: string; sessionId: string } | null {
  const parsed = parseJsonLine(line) as Record<string, unknown> | null;
  if (!parsed || parsed.type !== 'session_meta' || !parsed.payload) return null;
  const payload = parsed.payload as Record<string, unknown>;
  if (safeString(payload.cwd) !== cwd) return null;
  const threadId = safeString(payload.id);
  if (!threadId) return null;
  return {
    threadId,
    sessionId: threadId,
  };
}

async function discoverRolloutFiles(): Promise<string[]> {
  const now = Date.now();
  const discovered: string[] = [];
  for (const dir of sessionDirs()) {
    if (!existsSync(dir)) continue;
    const names = await readdir(dir).catch(() => [] as string[]);
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

function inferDerivedEvent(parsed: Record<string, unknown> | null, meta: FileMeta): Record<string, unknown> | null {
  if (!parsed || parsed.type !== 'event_msg' || !parsed.payload) return null;

  const payload = parsed.payload as Record<string, unknown>;
  const payloadType = safeString(payload.type).toLowerCase();
  const timestamp = safeString(parsed.timestamp) || new Date().toISOString();
  const turnId = safeString((payload as Record<string, unknown>).turn_id || (parsed as Record<string, unknown>).turn_id || (parsed as Record<string, unknown>).id);

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
    const message = extractMessageText(payload);
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

function updateTurnState(parsed: Record<string, unknown> | null, meta: FileMeta): void {
  if (!parsed || parsed.type !== 'event_msg' || !parsed.payload) return;
  const payloadType = safeString((parsed.payload as Record<string, unknown>).type);
  if (payloadType === 'task_started') {
    meta.currentTurnId = safeString((parsed.payload as Record<string, unknown>).turn_id);
    return;
  }
  if (payloadType === 'task_complete' || payloadType === 'turn_aborted') {
    meta.currentTurnId = '';
  }
}

interface OperationalCall {
  phase: string;
  kind: string;
  callId: string;
  timestamp: string;
  command: string;
  workdir: string;
  toolName: string;
  turnId: string | undefined;
  result?: Record<string, unknown>;
  output?: string;
}

function inferOperationalCall(parsed: Record<string, unknown> | null, meta: FileMeta): OperationalCall | null {
  if (!parsed || parsed.type !== 'response_item' || !parsed.payload) return null;
  const payload = parsed.payload as Record<string, unknown>;

  if (payload.type === 'function_call' && payload.name === 'exec_command') {
    const { command, workdir } = parseExecCommandArgs(payload.arguments as string | undefined);
    const classified = classifyExecCommand(command);
    if (!classified) return null;
    return {
      phase: 'start',
      kind: classified.kind,
      callId: safeString(payload.call_id),
      timestamp: safeString(parsed.timestamp) || new Date().toISOString(),
      command: classified.command,
      workdir: workdir || cwd,
      toolName: safeString(payload.name),
      turnId: meta.currentTurnId || undefined,
    };
  }

  if (payload.type === 'function_call_output') {
    const callId = safeString(payload.call_id);
    if (!callId || !pendingCalls.has(callId)) return null;
    const existing = pendingCalls.get(callId)!;
    return {
      ...existing,
      phase: 'finish',
      timestamp: safeString(parsed.timestamp) || new Date().toISOString(),
      result: parseCommandResult(payload.output as string | undefined),
      output: safeString(payload.output),
    };
  }

  return null;
}

async function dispatchDerivedEvent(event: Record<string, unknown>): Promise<void> {
  try {
    const { dispatchHookEvent } = await import('../hooks/extensibility/dispatcher.js');
    await dispatchHookEvent(event as unknown as Parameters<typeof dispatchHookEvent>[0], {
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

interface OperationalEventInput {
  event: string;
  workdir?: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  command?: string;
  toolName?: string;
  status?: string;
  prNumber?: number;
  prUrl?: string;
  errorSummary?: string;
  output?: string;
  parserReason?: string;
  confidence?: number;
  extra?: Record<string, unknown>;
}

async function dispatchOperationalEvent(input: OperationalEventInput): Promise<void> {
  try {
    const { buildDerivedHookEvent } = await import('../hooks/extensibility/events.js');
    const { dispatchHookEvent } = await import('../hooks/extensibility/dispatcher.js');
    const baseContext = buildOperationalContext({
      cwd: input.workdir || cwd,
      normalizedEvent: input.event,
      sessionId: input.sessionId || '',
      sessionName: input.sessionId || '',
      text: input.output || '',
      output: input.output || '',
      command: input.command || '',
      toolName: input.toolName || '',
      status: input.status || '',
      prNumber: input.prNumber,
      prUrl: input.prUrl,
      errorSummary: input.errorSummary,
      extra: input.extra || {},
    });
    const event = buildDerivedHookEvent(input.event, baseContext, {
      session_id: input.sessionId || undefined,
      thread_id: input.threadId || undefined,
      turn_id: input.turnId || undefined,
      parser_reason: input.parserReason,
      confidence: input.confidence,
    });
    await dispatchHookEvent(event, {
      cwd,
      allowTeamWorkerSideEffects: false,
    });
    await derivedLog({
      type: 'operational_event_dispatch',
      event: input.event,
      thread_id: input.threadId,
      turn_id: input.turnId,
      parser_reason: input.parserReason,
      ok: true,
    });
  } catch (err) {
    await derivedLog({
      type: 'operational_event_dispatch',
      event: input.event,
      thread_id: input.threadId,
      turn_id: input.turnId,
      parser_reason: input.parserReason,
      ok: false,
      error: err instanceof Error ? err.message : 'dispatch_failed',
    });
  }
}

async function ensureTrackedFiles(): Promise<void> {
  const files = await discoverRolloutFiles();
  for (const path of files) {
    if (fileState.has(path)) continue;
    const firstLine = await readFirstLine(path).catch(() => '');
    const meta = shouldTrackSessionMeta(firstLine);
    if (!meta) continue;
    const fileStat = await stat(path).catch(() => null);
    if (!fileStat) continue;
    const size = fileStat.size || 0;
    const offset = runOnce ? 0 : size;
    fileState.set(path, {
      ...meta,
      offset,
      partial: '',
      dispatched: 0,
      currentTurnId: '',
      decoder: new StringDecoder('utf8'),
    });
  }
}

async function processLine(meta: FileMeta, line: string): Promise<void> {
  const parsed = parseJsonLine(line);
  updateTurnState(parsed, meta);

  const operational = inferOperationalCall(parsed, meta);
  if (operational?.phase === 'start') {
    if (operational.callId) {
      pendingCalls.set(operational.callId, {
        kind: operational.kind,
        callId: operational.callId,
        command: operational.command,
        workdir: operational.workdir,
        toolName: operational.toolName,
        threadId: meta.threadId,
        sessionId: meta.sessionId,
        turnId: operational.turnId,
      });
    }
    if (operational.kind === 'test') {
      await dispatchOperationalEvent({
        event: 'test-started',
        workdir: operational.workdir,
        sessionId: meta.sessionId,
        threadId: meta.threadId,
        turnId: operational.turnId,
        command: operational.command,
        toolName: operational.toolName,
        status: 'started',
        parserReason: 'exec_command_test_start',
        confidence: 0.92,
      });
    }
  } else if (operational?.phase === 'finish') {
    if (operational.callId) pendingCalls.delete(operational.callId);
    if (operational.kind === 'test') {
      if (operational.result?.success !== true && operational.result?.success !== false) return;
      await dispatchOperationalEvent({
        event: operational.result?.success === false ? 'test-failed' : 'test-finished',
        workdir: operational.workdir,
        sessionId: meta.sessionId,
        threadId: meta.threadId,
        turnId: operational.turnId,
        command: operational.command,
        toolName: operational.toolName,
        status: operational.result?.success === false ? 'failed' : 'finished',
        errorSummary: operational.result?.error_summary as string | undefined,
        parserReason: 'exec_command_test_result',
        confidence: 0.95,
        extra: {
          ...(operational.result?.exit_code !== undefined ? { exit_code: operational.result.exit_code } : {}),
        },
      });
    }
    if (operational.kind === 'pr-create' && operational.result?.success !== false && (operational.result?.pr_number !== undefined || operational.result?.pr_url)) {
      await dispatchOperationalEvent({
        event: 'pr-created',
        workdir: operational.workdir,
        sessionId: meta.sessionId,
        threadId: meta.threadId,
        turnId: operational.turnId,
        command: operational.command,
        toolName: operational.toolName,
        status: 'finished',
        prNumber: operational.result.pr_number as number | undefined,
        prUrl: operational.result.pr_url as string | undefined,
        parserReason: 'exec_command_pr_create_result',
        confidence: 0.97,
      });
    }
  }

  const derived = inferDerivedEvent(parsed, meta);
  if (!derived) return;
  await dispatchDerivedEvent(derived);
  meta.dispatched += 1;
}

async function readFileDelta(
  path: string,
  offset: number,
  currentSize: number,
): Promise<{ bytes: Buffer; nextOffset: number }> {
  const length = currentSize - offset;
  if (length <= 0) return { bytes: Buffer.alloc(0), nextOffset: offset };
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    let totalBytesRead = 0;
    while (totalBytesRead < length) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytesRead,
        length - totalBytesRead,
        offset + totalBytesRead,
      );
      if (bytesRead === 0) break;
      totalBytesRead += bytesRead;
    }
    return {
      bytes: buffer.subarray(0, totalBytesRead),
      nextOffset: offset + totalBytesRead,
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function pollFiles(): Promise<void> {
  for (const [path, meta] of fileState.entries()) {
    const fileStat = await stat(path).catch(() => null);
    if (!fileStat) continue;
    const currentSize = fileStat.size || 0;
    if (currentSize < meta.offset) {
      meta.offset = 0;
      meta.partial = '';
      meta.decoder = new StringDecoder('utf8');
    }
    if (currentSize <= meta.offset) continue;

    const read = await readFileDelta(path, meta.offset, currentSize).catch(() => null);
    if (!read || read.bytes.length === 0) continue;
    const { bytes, nextOffset } = read;
    meta.offset = nextOffset;
    const delta = meta.decoder.write(bytes);
    if (!delta) continue;
    const merged = meta.partial + delta;
    const lines = merged.split('\n');
    meta.partial = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      await processLine(meta, line);
    }
  }
}

async function writeState(): Promise<void> {
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
    pending_calls: pendingCalls.size,
  };
  await writeFile(watcherStatePath, JSON.stringify(state, null, 2)).catch(() => {});
}

async function flushOnce(reason: string): Promise<void> {
  if (flushedOnShutdown) return;
  flushedOnShutdown = true;
  await ensureTrackedFiles();
  await pollFiles();
  await writeState();
  await derivedLog({ type: 'watcher_flush', reason });
}

async function tick(): Promise<void> {
  if (stopping) return;
  await ensureTrackedFiles();
  await pollFiles();
  await writeState();
  setTimeout(tick, pollMs);
}

function shutdown(signal: string): void {
  stopping = true;
  flushOnce(`signal:${signal}`)
    .finally(() => derivedLog({ type: 'watcher_stop', signal }))
    .finally(() => process.exit(0));
}

async function main(): Promise<void> {
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
