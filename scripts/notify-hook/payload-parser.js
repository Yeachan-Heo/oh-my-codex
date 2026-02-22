/**
 * Payload field extraction for notify-hook.
 */

import { asNumber, safeString, clampPct } from './utils.js';

export function extractLimitPct(limit) {
  if (limit == null) return null;
  if (typeof limit === 'number' || typeof limit === 'string') return clampPct(asNumber(limit));
  if (typeof limit !== 'object') return null;

  const directPct = clampPct(asNumber(limit.percent ?? limit.pct ?? limit.usage_percent ?? limit.usagePct));
  if (directPct !== null) return directPct;

  const used = asNumber(limit.used ?? limit.usage ?? limit.current);
  const max = asNumber(limit.limit ?? limit.max ?? limit.total);
  if (used !== null && max !== null && max > 0) {
    return clampPct((used / max) * 100);
  }

  const remaining = asNumber(limit.remaining ?? limit.left);
  if (remaining !== null && max !== null && max > 0) {
    return clampPct(((max - remaining) / max) * 100);
  }

  return null;
}

export function getSessionTokenUsage(payload) {
  const usage = payload.usage || payload['usage'] || payload.token_usage || payload['token-usage'] || {};

  function firstTokenMatch(candidates) {
    for (const [raw, cumulative] of candidates) {
      const value = asNumber(raw);
      if (value !== null) return { value, cumulative };
    }
    return { value: null, cumulative: false };
  }

  const inputMatch = firstTokenMatch([
    [usage.session_input_tokens, true],
    [usage.input_tokens, false],
    [usage.total_input_tokens, true],
    [usage.prompt_tokens, false],
    [usage.promptTokens, false],
    [payload.session_input_tokens, true],
    [payload.input_tokens, false],
    [payload.total_input_tokens, true],
    [payload.prompt_tokens, false],
    [payload.promptTokens, false],
  ]);
  const outputMatch = firstTokenMatch([
    [usage.session_output_tokens, true],
    [usage.output_tokens, false],
    [usage.total_output_tokens, true],
    [usage.completion_tokens, false],
    [usage.completionTokens, false],
    [payload.session_output_tokens, true],
    [payload.output_tokens, false],
    [payload.total_output_tokens, true],
    [payload.completion_tokens, false],
    [payload.completionTokens, false],
  ]);
  const totalMatch = firstTokenMatch([
    [usage.session_total_tokens, true],
    [usage.total_tokens, true],
    [payload.session_total_tokens, true],
    [payload.total_tokens, true],
  ]);

  const input = inputMatch.value;
  const output = outputMatch.value;
  const total = totalMatch.value;

  if (input === null && output === null && total === null) return null;

  return {
    input,
    inputCumulative: inputMatch.cumulative,
    output,
    outputCumulative: outputMatch.cumulative,
    total,
    totalCumulative: totalMatch.cumulative,
  };
}

export function getQuotaUsage(payload) {
  const usage = payload.usage || payload['usage'] || payload.token_usage || payload['token-usage'] || {};

  const fiveHourRaw =
    usage.five_hour_limit
    ?? usage.fiveHourLimit
    ?? usage['5h_limit']
    ?? payload.five_hour_limit
    ?? payload.fiveHourLimit
    ?? payload['5h_limit'];
  const weeklyRaw =
    usage.weekly_limit
    ?? usage.weeklyLimit
    ?? payload.weekly_limit
    ?? payload.weeklyLimit;

  const fiveHourLimitPct = extractLimitPct(fiveHourRaw);
  const weeklyLimitPct = extractLimitPct(weeklyRaw);

  if (fiveHourLimitPct === null && weeklyLimitPct === null) return null;
  return { fiveHourLimitPct, weeklyLimitPct };
}

export function normalizeInputMessages(payload) {
  const items = payload['input-messages'] || payload.input_messages || [];
  if (!Array.isArray(items)) return [];
  return items.map(item => safeString(item));
}

export function renderPrompt(template, context) {
  return safeString(template)
    .replaceAll('{{mode}}', context.mode)
    .replaceAll('{{thread_id}}', context.threadId)
    .replaceAll('{{turn_id}}', context.turnId)
    .replaceAll('{{timestamp}}', context.timestamp);
}
