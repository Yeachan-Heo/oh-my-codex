/**
 * Pure utility helpers shared across notify-hook modules.
 * No I/O, no side effects.
 */

export function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function safeString(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  return String(value);
}

export function clampPct(value) {
  if (!Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value <= 1) return Math.round(value * 100);
  if (value > 100) return 100;
  return Math.round(value);
}

export function isTerminalPhase(phase) {
  return phase === 'complete' || phase === 'failed' || phase === 'cancelled';
}
