import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { safeString } from './utils.js';
import { runProcess } from './process-runner.js';
import { resolvePaneTarget } from './tmux-injection.js';
import { buildPaneInModeArgv, buildSendKeysArgv } from '../tmux-hook-engine.js';

function readJson(path, fallback) {
  return readFile(path, 'utf8')
    .then((raw) => JSON.parse(raw))
    .catch(() => fallback);
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}

const DISPATCH_LOCK_STALE_MS = 10_000;

async function withDispatchLock(teamDirPath, fn) {
  const lockDir = join(teamDirPath, 'dispatch', '.lock');
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + 5_000;
  await mkdir(dirname(lockDir), { recursive: true });

  while (true) {
    try {
      await mkdir(lockDir, { recursive: false });
      try {
        await writeFile(ownerPath, ownerToken, 'utf8');
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > DISPATCH_LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // best effort
      }
      if (Date.now() > deadline) throw new Error(`Timed out acquiring dispatch lock for ${teamDirPath}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {
      // best effort
    }
  }
}

function defaultInjectTarget(request, config) {
  if (request.pane_id) return { type: 'pane', value: request.pane_id };
  if (typeof request.worker_index === 'number' && Array.isArray(config?.workers)) {
    const worker = config.workers.find((candidate) => Number(candidate?.index) === request.worker_index);
    if (worker?.pane_id) return { type: 'pane', value: worker.pane_id };
  }
  if (typeof request.worker_index === 'number' && config.tmux_session) {
    return { type: 'pane', value: `${config.tmux_session}:${request.worker_index}` };
  }
  if (config.tmux_session) return { type: 'session', value: config.tmux_session };
  return null;
}

async function injectDispatchRequest(request, config, cwd) {
  const target = defaultInjectTarget(request, config);
  if (!target) {
    return { ok: false, reason: 'missing_tmux_target' };
  }
  const resolution = await resolvePaneTarget(target, '', cwd, '');
  if (!resolution.paneTarget) {
    return { ok: false, reason: `target_resolution_failed:${resolution.reason}` };
  }
  try {
    const inMode = await runProcess('tmux', buildPaneInModeArgv(resolution.paneTarget), 1000);
    if (safeString(inMode.stdout).trim() === '1') {
      return { ok: false, reason: 'scroll_active' };
    }
  } catch {
    // best effort
  }

  const argv = buildSendKeysArgv({
    paneTarget: resolution.paneTarget,
    prompt: request.trigger_message,
    dryRun: false,
  });
  await runProcess('tmux', argv.typeArgv, 3000);
  for (const submit of argv.submitArgv) {
    await runProcess('tmux', submit, 3000);
  }
  return { ok: true, reason: 'tmux_send_keys_sent', pane: resolution.paneTarget };
}

function shouldSkipRequest(request) {
  if (request.status !== 'pending') return true;
  return request.transport_preference !== 'hook_preferred_with_fallback';
}

async function updateMailboxNotified(cwd, teamName, workerName, messageId) {
  const mailboxPath = join(cwd, '.omx', 'state', 'team', teamName, 'mailbox', `${workerName}.json`);
  const mailbox = await readJson(mailboxPath, { worker: workerName, messages: [] });
  if (!mailbox || !Array.isArray(mailbox.messages)) return false;
  const msg = mailbox.messages.find((candidate) => candidate?.message_id === messageId);
  if (!msg) return false;
  if (!msg.notified_at) msg.notified_at = new Date().toISOString();
  await writeJson(mailboxPath, mailbox);
  return true;
}

async function appendDispatchLog(logsDir, event) {
  const path = join(logsDir, `team-dispatch-${new Date().toISOString().slice(0, 10)}.jsonl`);
  await appendFile(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`).catch(() => {});
}

export async function drainPendingTeamDispatch({
  cwd,
  stateDir = join(cwd, '.omx', 'state'),
  logsDir = join(cwd, '.omx', 'logs'),
  maxPerTick = 5,
  injector = injectDispatchRequest,
} = {}) {
  if (safeString(process.env.OMX_TEAM_WORKER)) {
    return { processed: 0, skipped: 0, failed: 0, reason: 'worker_context' };
  }
  const teamRoot = join(stateDir, 'team');
  if (!existsSync(teamRoot)) return { processed: 0, skipped: 0, failed: 0 };

  const teams = await readdir(teamRoot).catch(() => []);

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const teamName of teams) {
    if (processed >= maxPerTick) break;
    const teamDirPath = join(teamRoot, teamName);
    const manifestPath = join(teamDirPath, 'manifest.v2.json');
    const configPath = join(teamDirPath, 'config.json');
    const requestsPath = join(teamDirPath, 'dispatch', 'requests.json');
    if (!existsSync(requestsPath)) continue;

    const config = await readJson(existsSync(manifestPath) ? manifestPath : configPath, {});
    await withDispatchLock(teamDirPath, async () => {
      const requests = await readJson(requestsPath, []);
      if (!Array.isArray(requests)) return;

      let mutated = false;
      for (const request of requests) {
        if (processed >= maxPerTick) break;
        if (!request || typeof request !== 'object') continue;
        if (shouldSkipRequest(request)) {
          skipped += 1;
          continue;
        }

        const result = await injector(request, config, resolve(cwd));
        const nowIso = new Date().toISOString();
        request.attempt_count = Number.isFinite(request.attempt_count) ? Math.max(0, request.attempt_count + 1) : 1;
        request.updated_at = nowIso;

        if (result.ok) {
          request.status = 'notified';
          request.notified_at = nowIso;
          request.last_reason = result.reason;
          if (request.kind === 'mailbox' && request.message_id) {
            await updateMailboxNotified(cwd, teamName, request.to_worker, request.message_id).catch(() => {});
          }
          processed += 1;
          mutated = true;
          await appendDispatchLog(logsDir, {
            type: 'dispatch_notified',
            team: teamName,
            request_id: request.request_id,
            worker: request.to_worker,
            message_id: request.message_id || null,
            reason: result.reason,
          });
        } else {
          request.status = 'failed';
          request.failed_at = nowIso;
          request.last_reason = result.reason;
          processed += 1;
          failed += 1;
          mutated = true;
          await appendDispatchLog(logsDir, {
            type: 'dispatch_failed',
            team: teamName,
            request_id: request.request_id,
            worker: request.to_worker,
            message_id: request.message_id || null,
            reason: result.reason,
          });
        }
      }

      if (mutated) {
        await writeJsonAtomic(requestsPath, requests);
      }
    });
  }

  return { processed, skipped, failed };
}
