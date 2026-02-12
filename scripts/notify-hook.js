#!/usr/bin/env node

/**
 * oh-my-codex Notification Hook
 * Codex CLI fires this after each agent turn via the `notify` config.
 * Receives JSON payload as the last argv argument.
 *
 * This hook:
 * 1. Logs agent turn completions to .omx/logs/
 * 2. Updates state for active workflow modes
 * 3. Tracks subagent activity
 * 4. Triggers desktop notifications if configured
 */

import { writeFile, appendFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

async function main() {
  const rawPayload = process.argv[process.argv.length - 1];
  if (!rawPayload || rawPayload.startsWith('-')) {
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    process.exit(0);
  }

  const cwd = payload.cwd || payload['cwd'] || process.cwd();
  const omxDir = join(cwd, '.omx');
  const logsDir = join(omxDir, 'logs');
  const stateDir = join(omxDir, 'state');

  // Ensure directories exist
  await mkdir(logsDir, { recursive: true }).catch(() => {});
  await mkdir(stateDir, { recursive: true }).catch(() => {});

  // 1. Log the turn
  const logEntry = {
    timestamp: new Date().toISOString(),
    type: payload.type || 'agent-turn-complete',
    thread_id: payload['thread-id'] || payload.thread_id,
    turn_id: payload['turn-id'] || payload.turn_id,
    input_preview: (payload['input-messages'] || payload.input_messages || [])
      .map(m => m.slice(0, 100))
      .join('; '),
    output_preview: (payload['last-assistant-message'] || payload.last_assistant_message || '')
      .slice(0, 200),
  };

  const logFile = join(logsDir, `turns-${new Date().toISOString().split('T')[0]}.jsonl`);
  await appendFile(logFile, JSON.stringify(logEntry) + '\n').catch(() => {});

  // 2. Update active mode state (increment iteration)
  try {
    const stateFiles = await readdir(stateDir);
    for (const f of stateFiles) {
      if (!f.endsWith('-state.json')) continue;
      const statePath = join(stateDir, f);
      const state = JSON.parse(await readFile(statePath, 'utf-8'));
      if (state.active) {
        state.iteration = (state.iteration || 0) + 1;
        state.last_turn_at = new Date().toISOString();
        await writeFile(statePath, JSON.stringify(state, null, 2));
      }
    }
  } catch {
    // Non-critical
  }

  // 3. Track subagent metrics
  const metricsPath = join(omxDir, 'metrics.json');
  try {
    let metrics = { total_turns: 0, session_turns: 0, last_activity: '' };
    if (existsSync(metricsPath)) {
      metrics = JSON.parse(await readFile(metricsPath, 'utf-8'));
    }
    metrics.total_turns++;
    metrics.session_turns++;
    metrics.last_activity = new Date().toISOString();
    await writeFile(metricsPath, JSON.stringify(metrics, null, 2));
  } catch {
    // Non-critical
  }
}

async function readdir(dir) {
  const { readdir: rd } = await import('fs/promises');
  return rd(dir);
}

main().catch(() => process.exit(0));
