#!/usr/bin/env node

import { existsSync } from 'fs';
import { appendFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'fs/promises';
import { spawnSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { drainPendingTeamDispatch } from './notify-hook/team-dispatch.js';

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeString(v) {
  return typeof v === 'string' ? v : '';
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === 'object' && error.code === 'EPERM';
  }
}

const cwd = resolve(argValue('--cwd', process.cwd()));
const notifyScript = resolve(argValue('--notify-script', join(cwd, 'scripts', 'notify-hook.js')));
const runOnce = process.argv.includes('--once');
const pollMs = Math.max(50, asNumber(argValue('--poll-ms', '700'), 700));
const parentPid = Math.trunc(asNumber(argValue('--parent-pid', String(process.ppid || 0)), process.ppid || 0));
const startedAt = Date.now();
const fileWindowMs = runOnce ? 15000 : 30000;
const defaultMaxLifetimeMs = 6 * 60 * 60 * 1000;
const maxLifetimeMs = runOnce
  ? 0
  : Math.max(
    pollMs,
    asNumber(
      argValue('--max-lifetime-ms', process.env.OMX_NOTIFY_FALLBACK_MAX_LIFETIME_MS || String(defaultMaxLifetimeMs)),
      defaultMaxLifetimeMs
    )
  );

const omxDir = join(cwd, '.omx');
const logsDir = join(omxDir, 'logs');
const stateDir = join(omxDir, 'state');
const statePath = join(stateDir, 'notify-fallback-state.json');
const pidFilePath = resolve(argValue('--pid-file', join(stateDir, 'notify-fallback.pid')));
const logPath = join(logsDir, `notify-fallback-${new Date().toISOString().split('T')[0]}.jsonl`);

const fileState = new Map();
const seenTurnKeys = new Set();
let stopping = false;
let shutdownPromise = null;
const dispatchTickMax = Math.max(1, asNumber(argValue('--dispatch-max-per-tick', '5'), 5));
let dispatchDrainRuns = 0;
let lastDispatchDrain = {
  leader_only: safeString(process.env.OMX_TEAM_WORKER || '').trim() === '',
  last_tick_at: null,
  last_result: null,
  last_error: null,
};

function eventLog(event) {
  return appendFile(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`).catch(() => {});
}

async function readPidFilePid(path) {
  const raw = await readFile(path, 'utf-8');
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return Number.isFinite(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    const pid = Number.parseInt(trimmed, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  }
}

async function registerPidFile() {
  if (runOnce) return;
  await mkdir(dirname(pidFilePath), { recursive: true }).catch(() => {});

  const existingPid = await readPidFilePid(pidFilePath).catch(() => null);
  if (existingPid && existingPid !== process.pid && isPidAlive(existingPid)) {
    try {
      process.kill(existingPid, 'SIGTERM');
      await eventLog({
        type: 'watcher_stale_pid_reaped',
        stale_pid: existingPid,
        pid_file: pidFilePath,
      });
    } catch (error) {
      await eventLog({
        type: 'watcher_stale_pid_reap_failed',
        stale_pid: existingPid,
        pid_file: pidFilePath,
        error: error instanceof Error ? error.message : safeString(error),
      });
    }
  }

  await writeFile(pidFilePath, JSON.stringify({
    pid: process.pid,
    parent_pid: parentPid,
    cwd,
    started_at: new Date(startedAt).toISOString(),
    max_lifetime_ms: maxLifetimeMs,
  }, null, 2)).catch(() => {});
}

async function removePidFileIfOwned() {
  if (runOnce) return;
  const existingPid = await readPidFilePid(pidFilePath).catch(() => null);
  if (existingPid !== process.pid) return;
  await unlink(pidFilePath).catch(() => {});
}

function parentIsGone() {
  if (!Number.isFinite(parentPid) || parentPid <= 0) return false;
  if (parentPid === process.pid) return false;
  return !isPidAlive(parentPid);
}

async function writeState(extra = {}) {
  await mkdir(stateDir, { recursive: true }).catch(() => {});
  const state = {
    pid: process.pid,
    parent_pid: parentPid,
    started_at: new Date(startedAt).toISOString(),
    cwd,
    notify_script: notifyScript,
    poll_ms: pollMs,
    pid_file: runOnce ? null : pidFilePath,
    max_lifetime_ms: maxLifetimeMs,
    tracked_files: fileState.size,
    seen_turns: seenTurnKeys.size,
    dispatch_drain: {
      enabled: true,
      max_per_tick: dispatchTickMax,
      run_count: dispatchDrainRuns,
      ...lastDispatchDrain,
    },
    ...extra,
  };
  await writeFile(statePath, JSON.stringify(state, null, 2)).catch(() => {});
}

async function requestShutdown(reason, signal = null) {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownPromise = (async () => {
    await writeState({ stop_reason: reason, stop_signal: signal, stopping: true });
    await eventLog({
      type: 'watcher_stop',
      signal,
      reason,
      parent_pid: parentPid,
      pid_file: runOnce ? null : pidFilePath,
    });
    await removePidFileIfOwned();
    process.exit(0);
  })();
  return shutdownPromise;
}

async function enforceLifecycleGuards() {
  if (runOnce) return false;
  if (parentIsGone()) {
    await requestShutdown('parent_gone');
    return true;
  }
  if (maxLifetimeMs > 0 && Date.now() - startedAt >= maxLifetimeMs) {
    await requestShutdown('max_lifetime_exceeded');
    return true;
  }
  return false;
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
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || parsed.type !== 'session_meta' || !parsed.payload) return null;
  const payload = parsed.payload;
  if (safeString(payload.cwd) !== cwd) return null;
  const threadId = safeString(payload.id);
  return threadId || null;
}

async function discoverRolloutFiles() {
  const discovered = [];
  for (const dir of sessionDirs()) {
    if (!existsSync(dir)) continue;
    const names = await readdir(dir).catch(() => []);
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      const st = await stat(path).catch(() => null);
      if (!st) continue;
      if (st.mtimeMs < startedAt - fileWindowMs) continue;
      discovered.push(path);
    }
  }
  discovered.sort();
  return discovered;
}

function turnKey(threadId, turnId) {
  return `${threadId || 'no-thread'}|${turnId || 'no-turn'}`;
}

function buildNotifyPayload(threadId, turnId, lastMessage) {
  return {
    type: 'agent-turn-complete',
    cwd,
    'thread-id': threadId,
    'turn-id': turnId,
    'input-messages': ['[notify-fallback] synthesized from rollout task_complete'],
    'last-assistant-message': lastMessage || '',
    source: 'notify-fallback-watcher',
  };
}

async function invokeNotifyHook(payload, filePath) {
  const result = spawnSync(process.execPath, [notifyScript, JSON.stringify(payload)], {
    cwd,
    encoding: 'utf-8',
  });
  const ok = result.status === 0;
  await eventLog({
    type: 'fallback_notify',
    ok,
    thread_id: payload['thread-id'],
    turn_id: payload['turn-id'],
    file: filePath,
    reason: ok ? 'sent' : 'notify_hook_failed',
    error: ok ? undefined : (result.stderr || result.stdout || '').trim().slice(0, 240),
  });
}

async function processLine(meta, line, filePath) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }

  if (!parsed || parsed.type !== 'event_msg' || !parsed.payload) return;
  if (parsed.payload.type !== 'task_complete') return;

  const turnId = safeString(parsed.payload.turn_id);
  if (!turnId) return;

  const evtTs = Date.parse(safeString(parsed.timestamp));
  if (Number.isFinite(evtTs) && evtTs < startedAt - 3000) return;

  const key = turnKey(meta.threadId, turnId);
  if (seenTurnKeys.has(key)) return;
  seenTurnKeys.add(key);

  const payload = buildNotifyPayload(
    meta.threadId,
    turnId,
    safeString(parsed.payload.last_agent_message)
  );
  await invokeNotifyHook(payload, filePath);
}

async function ensureTrackedFiles() {
  const files = await discoverRolloutFiles();
  for (const path of files) {
    if (fileState.has(path)) continue;
    const line = await readFirstLine(path).catch(() => '');
    const threadId = shouldTrackSessionMeta(line);
    if (!threadId) continue;
    const size = (await stat(path).catch(() => ({ size: 0 }))).size || 0;
    const offset = runOnce ? 0 : size;
    fileState.set(path, { threadId, offset, size, partial: '' });
  }
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
      await processLine(meta, line, path);
    }
  }
}

async function runDispatchDrainTick() {
  const startedIso = new Date().toISOString();
  try {
    const result = await drainPendingTeamDispatch({ cwd, stateDir, logsDir, maxPerTick: dispatchTickMax });
    dispatchDrainRuns += 1;
    lastDispatchDrain = {
      leader_only: safeString(process.env.OMX_TEAM_WORKER || '').trim() === '',
      last_tick_at: startedIso,
      last_result: result,
      last_error: null,
    };
    await eventLog({
      type: 'dispatch_drain_tick',
      leader_only: lastDispatchDrain.leader_only,
      dispatch_max_per_tick: dispatchTickMax,
      run_count: dispatchDrainRuns,
      ...(result && typeof result === 'object' ? result : {}),
    });
  } catch (err) {
    dispatchDrainRuns += 1;
    lastDispatchDrain = {
      leader_only: safeString(process.env.OMX_TEAM_WORKER || '').trim() === '',
      last_tick_at: startedIso,
      last_result: null,
      last_error: err instanceof Error ? err.message : safeString(err),
    };
    await eventLog({
      type: 'dispatch_drain_tick',
      leader_only: lastDispatchDrain.leader_only,
      dispatch_max_per_tick: dispatchTickMax,
      run_count: dispatchDrainRuns,
      reason: 'dispatch_drain_failed',
      error: lastDispatchDrain.last_error,
    });
  }
}

async function tick() {
  if (stopping) return;
  if (await enforceLifecycleGuards()) return;
  await ensureTrackedFiles();
  await pollFiles();
  await runDispatchDrainTick();
  await writeState();
  if (await enforceLifecycleGuards()) return;
  setTimeout(() => {
    void tick();
  }, pollMs);
}

function shutdown(signal) {
  void requestShutdown('signal', signal);
}

async function main() {
  await mkdir(logsDir, { recursive: true }).catch(() => {});
  await mkdir(stateDir, { recursive: true }).catch(() => {});
  if (!existsSync(notifyScript)) {
    await eventLog({ type: 'watcher_error', reason: 'notify_script_missing', notify_script: notifyScript });
    process.exit(1);
  }

  await registerPidFile();
  await eventLog({
    type: 'watcher_start',
    cwd,
    notify_script: notifyScript,
    poll_ms: pollMs,
    once: runOnce,
    parent_pid: parentPid,
    pid_file: runOnce ? null : pidFilePath,
    max_lifetime_ms: maxLifetimeMs,
  });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  if (await enforceLifecycleGuards()) return;

  if (runOnce) {
    await ensureTrackedFiles();
    await pollFiles();
    await runDispatchDrainTick();
    await writeState();
    await eventLog({ type: 'watcher_once_complete', seen_turns: seenTurnKeys.size });
    process.exit(0);
  }

  await tick();
}

main().catch(async (err) => {
  await mkdir(dirname(logPath), { recursive: true }).catch(() => {});
  await eventLog({
    type: 'watcher_error',
    reason: 'fatal',
    error: err instanceof Error ? err.message : safeString(err),
  });
  process.exit(1);
});
