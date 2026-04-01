/**
 * Multi-provider failover system.
 *
 * Provides token usage tracking, rate limit detection, automatic failover
 * across providers (codex, claude, gemini, qwen, grok), and cooldown management.
 */

export { ProviderTracker, isRateLimitError } from './tracker.js';
export { executeWithFailover } from './executor.js';
export { loadFailoverConfig } from './config.js';
export type {
  FailoverProvider,
  FailoverConfig,
  ProviderTokenUsage,
  ProviderStatus,
  FailoverEvent,
} from './types.js';
export { DEFAULT_FAILOVER_CONFIG, RATE_LIMIT_PATTERNS } from './types.js';
