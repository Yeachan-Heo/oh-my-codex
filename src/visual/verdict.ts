import {
  VISUAL_NEXT_ACTIONS_LIMIT,
  VISUAL_VERDICT_STATUSES,
  type VisualVerdictStatus,
} from './constants.js';

export interface VisualVerdict {
  score: number;
  verdict: VisualVerdictStatus;
  category_match: boolean;
  differences: string[];
  suggestions: string[];
  reasoning: string;
}

export interface VisualLoopFeedback extends VisualVerdict {
  threshold: number;
  passes_threshold: boolean;
  next_actions: string[];
}

function asTrimmedStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`visual_verdict.${field} must be an array`);
  }
  return value
    .map((item) => {
      if (typeof item !== 'string') {
        throw new Error(`visual_verdict.${field} must contain strings`);
      }
      return item.trim();
    })
    .filter((item) => item.length > 0);
}

function parseVisualVerdictStatus(value: unknown): VisualVerdictStatus {
  if (typeof value !== 'string') {
    throw new Error(`visual_verdict.verdict must be one of: ${VISUAL_VERDICT_STATUSES.join('|')}`);
  }
  const normalized = value.trim().toLowerCase();
  if (!VISUAL_VERDICT_STATUSES.includes(normalized as VisualVerdictStatus)) {
    throw new Error(`visual_verdict.verdict must be one of: ${VISUAL_VERDICT_STATUSES.join('|')}`);
  }
  return normalized as VisualVerdictStatus;
}

export function parseVisualVerdict(input: unknown): VisualVerdict {
  if (!input || typeof input !== 'object') {
    throw new Error('visual_verdict must be an object');
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.score !== 'number' || !Number.isInteger(raw.score) || raw.score < 0 || raw.score > 100) {
    throw new Error('visual_verdict.score must be an integer between 0 and 100');
  }
  if (typeof raw.category_match !== 'boolean') {
    throw new Error('visual_verdict.category_match must be a boolean');
  }
  if (typeof raw.reasoning !== 'string' || raw.reasoning.trim().length === 0) {
    throw new Error('visual_verdict.reasoning must be a non-empty string');
  }

  return {
    score: raw.score,
    verdict: parseVisualVerdictStatus(raw.verdict),
    category_match: raw.category_match,
    differences: asTrimmedStringArray(raw.differences, 'differences'),
    suggestions: asTrimmedStringArray(raw.suggestions, 'suggestions'),
    reasoning: raw.reasoning.trim(),
  };
}

export function buildVisualLoopFeedback(input: unknown, threshold = 90): VisualLoopFeedback {
  const verdict = parseVisualVerdict(input);
  const next_actions = [
    ...verdict.suggestions,
    ...verdict.differences.map((difference) => `Fix: ${difference}`),
  ].slice(0, VISUAL_NEXT_ACTIONS_LIMIT);

  return {
    ...verdict,
    threshold,
    passes_threshold: verdict.score >= threshold,
    next_actions,
  };
}
