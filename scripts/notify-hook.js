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

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getSessionTokenUsage(payload) {
  const usage = payload.usage || payload['usage'] || payload.token_usage || payload['token-usage'] || {};

  const input = asNumber(
    usage.session_input_tokens
    ?? usage.input_tokens
    ?? usage.total_input_tokens
    ?? payload.session_input_tokens
    ?? payload.input_tokens
    ?? payload.total_input_tokens
  );
  const output = asNumber(
    usage.session_output_tokens
    ?? usage.output_tokens
    ?? usage.total_output_tokens
    ?? payload.session_output_tokens
    ?? payload.output_tokens
    ?? payload.total_output_tokens
  );
  const total = asNumber(
    usage.session_total_tokens
    ?? usage.total_tokens
    ?? payload.session_total_tokens
    ?? payload.total_tokens
  );

  if (input === null && output === null && total === null) return null;

  return {
    input,
    output,
    total: total ?? ((input ?? 0) + (output ?? 0)),
  };
}

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
    let metrics = {
      total_turns: 0,
      session_turns: 0,
      last_activity: '',
      session_input_tokens: 0,
      session_output_tokens: 0,
      session_total_tokens: 0,
    };
    if (existsSync(metricsPath)) {
      metrics = { ...metrics, ...JSON.parse(await readFile(metricsPath, 'utf-8')) };
    }

    const tokenUsage = getSessionTokenUsage(payload);

    metrics.total_turns++;
    metrics.session_turns++;
    metrics.last_activity = new Date().toISOString();

    if (tokenUsage) {
      if (tokenUsage.input !== null) metrics.session_input_tokens = tokenUsage.input;
      if (tokenUsage.output !== null) metrics.session_output_tokens = tokenUsage.output;
      if (tokenUsage.total !== null) {
        metrics.session_total_tokens = tokenUsage.total;
      } else {
        metrics.session_total_tokens = (metrics.session_input_tokens || 0) + (metrics.session_output_tokens || 0);
      }
    } else {
      metrics.session_total_tokens = (metrics.session_input_tokens || 0) + (metrics.session_output_tokens || 0);
    }

    await writeFile(metricsPath, JSON.stringify(metrics, null, 2));
  } catch {
    // Non-critical
  }

  // 4. Write HUD state summary for `omx hud`
  const hudStatePath = join(stateDir, 'hud-state.json');
  try {
    let hudState = { last_turn_at: '', turn_count: 0 };
    if (existsSync(hudStatePath)) {
      hudState = JSON.parse(await readFile(hudStatePath, 'utf-8'));
    }
    hudState.last_turn_at = new Date().toISOString();
    hudState.turn_count = (hudState.turn_count || 0) + 1;
    hudState.last_agent_output = (payload['last-assistant-message'] || payload.last_assistant_message || '')
      .slice(0, 100);
    await writeFile(hudStatePath, JSON.stringify(hudState, null, 2));
  } catch {
    // Non-critical
  }
}

async function readdir(dir) {
  const { readdir: rd } = await import('fs/promises');
  return rd(dir);
}

main().catch(() => process.exit(0));
