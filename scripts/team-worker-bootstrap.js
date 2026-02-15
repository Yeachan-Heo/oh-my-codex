#!/usr/bin/env node

import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { spawn } from 'child_process';

function parseArgs(argv) {
  const out = { team: '', worker: '', cwd: process.cwd(), codexArgs: [] };
  let i = 0;
  let passthrough = false;
  while (i < argv.length) {
    const arg = argv[i];
    if (passthrough) {
      out.codexArgs.push(arg);
      i += 1;
      continue;
    }
    if (arg === '--') {
      passthrough = true;
      i += 1;
      continue;
    }
    if (arg === '--team') {
      out.team = argv[i + 1] || '';
      i += 2;
      continue;
    }
    if (arg === '--worker') {
      out.worker = argv[i + 1] || '';
      i += 2;
      continue;
    }
    if (arg === '--cwd') {
      out.cwd = argv[i + 1] || out.cwd;
      i += 2;
      continue;
    }
    i += 1;
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), 'utf-8');
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.team || !parsed.worker) {
    process.exit(2);
  }

  const workerRoot = join(parsed.cwd, '.omx', 'state', 'team', parsed.team, 'workers', parsed.worker);
  const statusPath = join(workerRoot, 'status.json');
  const heartbeatPath = join(workerRoot, 'heartbeat.json');
  const signalPath = join(workerRoot, 'signal.ndjson');
  const shutdownReqPath = join(workerRoot, 'shutdown-request.json');
  const shutdownAckPath = join(workerRoot, 'shutdown-ack.json');

  await mkdir(workerRoot, { recursive: true });
  if (!existsSync(signalPath)) await writeFile(signalPath, '', 'utf-8');

  let turnCount = 0;
  let alive = true;
  let processedSignalLines = 0;

  const codexBin = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  const codex = spawn(codexBin, parsed.codexArgs, {
    cwd: parsed.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OMX_TEAM_WORKER: `${parsed.team}/${parsed.worker}`,
    },
  });

  async function writeHeartbeat() {
    await writeJson(heartbeatPath, {
      pid: codex.pid ?? process.pid,
      last_turn_at: new Date().toISOString(),
      turn_count: turnCount,
      alive,
    });
  }

  async function writeStatus(state, reason = undefined) {
    await writeJson(statusPath, {
      state,
      pid: codex.pid ?? process.pid,
      reason,
      updated_at: new Date().toISOString(),
    });
  }

  await writeStatus('idle');
  await writeHeartbeat();

  codex.stdout.on('data', async () => {
    turnCount += 1;
    await writeHeartbeat();
  });
  codex.stderr.on('data', async () => {
    turnCount += 1;
    await writeHeartbeat();
  });

  codex.on('exit', async (code) => {
    alive = false;
    await writeStatus(code === 0 ? 'done' : 'failed', code === 0 ? undefined : `exit_${code ?? 'unknown'}`);
    await writeHeartbeat();
    process.exit(0);
  });

  const stop = async () => {
    alive = false;
    try {
      codex.kill('SIGTERM');
    } catch {
      // ignore
    }
    await writeStatus('done');
    await writeHeartbeat();
    process.exit(0);
  };

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  while (alive) {
    const shutdownReq = await readJson(shutdownReqPath);
    if (shutdownReq) {
      await writeJson(shutdownAckPath, {
        status: 'accept',
        reason: 'worker_shutdown_requested',
        updated_at: new Date().toISOString(),
      });
      await stop();
      return;
    }

    try {
      const raw = await readFile(signalPath, 'utf-8');
      const lines = raw.split(/\r?\n/).filter(Boolean);
      const next = lines.slice(processedSignalLines);
      if (next.length > 0) {
        await writeStatus('working');
      }
      for (const line of next) {
        let payload;
        try {
          payload = JSON.parse(line);
        } catch {
          continue;
        }
        const message = typeof payload.message === 'string' ? payload.message.trim() : '';
        if (!message) continue;
        codex.stdin.write(`${message}\n`);
        codex.stdin.write('\n');
        turnCount += 1;
      }
      processedSignalLines = lines.length;
      if (next.length > 0) {
        await writeStatus('idle');
        await writeHeartbeat();
      }
    } catch {
      // ignore signal parsing issues
    }

    await sleep(400);
  }
}

main().catch(() => process.exit(1));
