import type { HookEventEnvelope, HookEventName, HookEventSource } from './types.js';

const DERIVED_EVENTS = new Set<string>(['needs-input', 'pre-tool-use', 'post-tool-use']);

interface BuildHookEventOptions {
  source?: HookEventSource;
  timestamp?: string;
  context?: Record<string, unknown>;
  session_id?: string;
  thread_id?: string;
  turn_id?: string;
  mode?: string;
  confidence?: number;
  parser_reason?: string;
}

function clampConfidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function isDerivedEventName(event: string): boolean {
  return DERIVED_EVENTS.has(event);
}

export function buildHookEvent(
  event: HookEventName | string,
  options: BuildHookEventOptions = {},
): HookEventEnvelope {
  const source = options.source || (isDerivedEventName(event) ? 'derived' : 'native');
  const confidence = clampConfidence(options.confidence);

  const envelope: HookEventEnvelope = {
    schema_version: '1',
    event,
    timestamp: options.timestamp || new Date().toISOString(),
    source,
    context: options.context && typeof options.context === 'object' ? options.context : {},
  };

  if (options.session_id) envelope.session_id = options.session_id;
  if (options.thread_id) envelope.thread_id = options.thread_id;
  if (options.turn_id) envelope.turn_id = options.turn_id;
  if (options.mode) envelope.mode = options.mode;

  if (source === 'derived') {
    envelope.confidence = confidence ?? 0.5;
    if (options.parser_reason) envelope.parser_reason = options.parser_reason;
  }

  return envelope;
}

export function buildNativeHookEvent(
  event: HookEventName | string,
  context: Record<string, unknown> = {},
  options: Omit<BuildHookEventOptions, 'source' | 'confidence' | 'parser_reason' | 'context'> = {},
): HookEventEnvelope {
  return buildHookEvent(event, {
    ...options,
    source: 'native',
    context,
  });
}

export function buildDerivedHookEvent(
  event: HookEventName | string,
  context: Record<string, unknown> = {},
  options: Omit<BuildHookEventOptions, 'source' | 'context'> = {},
): HookEventEnvelope {
  return buildHookEvent(event, {
    ...options,
    source: 'derived',
    context,
  });
}
