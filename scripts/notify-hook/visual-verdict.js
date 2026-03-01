/**
 * Visual verdict extraction and persistence.
 *
 * Parses PASS / FAIL / INCOMPLETE verdicts from verifier agent output
 * and persists them to stateDir/verdicts/latest-verdict.json.
 *
 * All failures are logged with structured context (issue #421) rather
 * than silently swallowed.
 */

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { logNotifyHookEvent } from './log.js';
import { safeString } from './utils.js';

/** Structured patterns that reliably indicate a verification verdict. */
const VERDICT_PATTERNS = [
  /\*\*Status\*\*:\s*(PASS|FAIL|INCOMPLETE)/i,
  /\bVerdict:\s*(PASS|FAIL|INCOMPLETE)\b/i,
];

/**
 * Heuristic: output contains verdict-like markers but no structured match.
 * Used to emit a debug-level log for candidate parse failures.
 */
const VERDICT_CANDIDATE_RE = /(?:\*\*Status\*\*\s*:|Verdict\s*:)/i;

/**
 * Attempt to extract a structured verdict from free-form text.
 * Returns `{ verdict, raw }` on success, `null` otherwise.
 */
export function parseVisualVerdict(text) {
  if (!text || typeof text !== 'string') return null;
  for (const pattern of VERDICT_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return { verdict: match[1].toUpperCase(), raw: match[0] };
    }
  }
  return null;
}

/**
 * Parse a visual verdict from the agent payload output and persist it.
 *
 * Logs structured warnings/debug events instead of silently swallowing
 * errors (addresses issue #421):
 *   - debug: candidate markers found but no structured verdict matched
 *   - warn:  verdict file write failure (with turn/session context)
 *
 * Module import failure is handled by the caller in notify-hook.js.
 */
export async function maybePersistVisualVerdict({ payload, stateDir, logsDir, sessionId, turnId }) {
  const output = safeString(
    payload?.['last-assistant-message'] || payload?.last_assistant_message || '',
  );
  if (!output) return;

  const parsed = parseVisualVerdict(output);

  if (!parsed) {
    // Debug level: verdict-like markers present but no structured match
    if (VERDICT_CANDIDATE_RE.test(output)) {
      await logNotifyHookEvent(logsDir, {
        timestamp: new Date().toISOString(),
        level: 'debug',
        type: 'visual_verdict_parse_no_match',
        session_id: sessionId,
        turn_id: turnId,
      });
    }
    return;
  }

  // Persist the extracted verdict
  try {
    const verdictDir = join(stateDir, 'verdicts');
    await mkdir(verdictDir, { recursive: true });

    const entry = {
      timestamp: new Date().toISOString(),
      verdict: parsed.verdict,
      raw_match: parsed.raw,
      session_id: sessionId,
      turn_id: turnId,
    };

    await writeFile(
      join(verdictDir, 'latest-verdict.json'),
      JSON.stringify(entry, null, 2),
    );

    await logNotifyHookEvent(logsDir, {
      ...entry,
      level: 'info',
      type: 'visual_verdict_persisted',
    });
  } catch (err) {
    // Warn level: persistence write failure with turn/session context
    await logNotifyHookEvent(logsDir, {
      timestamp: new Date().toISOString(),
      level: 'warn',
      type: 'visual_verdict_write_failure',
      error: err?.message || String(err),
      session_id: sessionId,
      turn_id: turnId,
    });
  }
}
