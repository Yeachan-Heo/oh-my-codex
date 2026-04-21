import { createHash } from 'node:crypto';

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelToolUse {
  name: string;
  input: unknown;
}

export interface ModelRequest {
  messages: ModelMessage[];
  system?: string;
  maxTokens?: number;
  tools?: ReadonlyArray<{ name: string; description?: string; schema?: unknown }>;
}

export interface ModelResponse {
  content: string;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  toolUse?: ModelToolUse[];
  inputTokens: number;
  outputTokens: number;
}

export interface ModelProvider {
  readonly id: string;
  call(req: ModelRequest): Promise<ModelResponse>;
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => [k, canonicalize(v)] as const);
  return Object.fromEntries(entries);
}

export function hashRequest(req: ModelRequest): string {
  const canonical = canonicalize({
    messages: req.messages,
    system: req.system ?? null,
    tools: req.tools ?? null,
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
