/**
 * Pure utility helpers shared across notify-hook modules.
 * No I/O, no side effects.
 */

export function asNumber(value: any): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function safeString(value: any, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  return String(value);
}

export function clampPct(value: any): number | null {
  if (!Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value <= 1) return Math.round(value * 100);
  if (value > 100) return 100;
  return Math.round(value);
}

export function isTerminalPhase(phase: string): boolean {
  return phase === 'complete' || phase === 'failed' || phase === 'cancelled';
}
