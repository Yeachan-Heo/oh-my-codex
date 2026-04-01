/**
 * Shared types for the multi-provider failover system.
 */

export type FailoverProvider = 'codex' | 'claude' | 'gemini' | 'qwen' | 'grok';

export interface FailoverConfig {
  enabled: boolean;
  order: FailoverProvider[];
  cooldownMs: number;
  maxRetries: number;
}

export interface ProviderTokenUsage {
  provider: FailoverProvider;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
  errorCount: number;
  lastUsedAt: string | null;
  lastErrorAt: string | null;
  rateLimited: boolean;
  cooldownUntil: string | null;
}

export interface FailoverEvent {
  timestamp: string;
  fromProvider: FailoverProvider;
  toProvider: FailoverProvider;
  reason: string;
  attempt: number;
}

export interface ProviderStatus {
  provider: FailoverProvider;
  available: boolean;
  rateLimited: boolean;
  cooldownRemaining: number;
  usage: ProviderTokenUsage;
  priority: number;
}

export const DEFAULT_FAILOVER_CONFIG: FailoverConfig = {
  enabled: true,
  order: ['codex', 'claude', 'gemini', 'qwen', 'grok'],
  cooldownMs: 60_000,
  maxRetries: 3,
};

export const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /429/,
  /quota.?exceeded/i,
  /insufficient.?quota/i,
  /too.?many.?requests/i,
  /resource.?exhausted/i,
  /capacity/i,
  /throttl/i,
];
