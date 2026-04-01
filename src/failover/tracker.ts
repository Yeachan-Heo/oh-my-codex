/**
 * Token usage tracker with rate limit detection and cooldown management.
 *
 * Tracks per-provider token consumption, detects rate limit / quota errors
 * from stderr patterns, maintains failover priority order, and manages cooldowns.
 */

import type {
  FailoverProvider,
  FailoverConfig,
  ProviderTokenUsage,
  ProviderStatus,
  FailoverEvent,
} from './types.js';
import { DEFAULT_FAILOVER_CONFIG, RATE_LIMIT_PATTERNS } from './types.js';

export class ProviderTracker {
  private usage: Map<FailoverProvider, ProviderTokenUsage> = new Map();
  private events: FailoverEvent[] = [];
  private config: FailoverConfig;

  constructor(config: Partial<FailoverConfig> = {}) {
    this.config = { ...DEFAULT_FAILOVER_CONFIG, ...config };
    for (const provider of this.config.order) {
      this.usage.set(provider, createEmptyUsage(provider));
    }
  }

  /** Record token usage for a provider. */
  recordUsage(
    provider: FailoverProvider,
    inputTokens: number,
    outputTokens: number,
  ): void {
    const entry = this.getOrCreateUsage(provider);
    entry.inputTokens += inputTokens;
    entry.outputTokens += outputTokens;
    entry.totalTokens += inputTokens + outputTokens;
    entry.requestCount += 1;
    entry.lastUsedAt = new Date().toISOString();
  }

  /** Record an error for a provider and detect rate limiting. */
  recordError(provider: FailoverProvider, errorMessage: string): void {
    const entry = this.getOrCreateUsage(provider);
    entry.errorCount += 1;
    entry.lastErrorAt = new Date().toISOString();

    if (isRateLimitError(errorMessage)) {
      entry.rateLimited = true;
      entry.cooldownUntil = new Date(Date.now() + this.config.cooldownMs).toISOString();
    }
  }

  /** Record a failover event when switching providers. */
  recordFailover(from: FailoverProvider, to: FailoverProvider, reason: string, attempt: number): void {
    this.events.push({
      timestamp: new Date().toISOString(),
      fromProvider: from,
      toProvider: to,
      reason,
      attempt,
    });
  }

  /** Check whether a provider is currently available (not rate-limited or in cooldown). */
  isProviderAvailable(provider: FailoverProvider): boolean {
    const entry = this.usage.get(provider);
    if (!entry) return true;
    if (!entry.rateLimited) return true;
    if (!entry.cooldownUntil) return true;
    const cooldownEnd = new Date(entry.cooldownUntil).getTime();
    if (Date.now() >= cooldownEnd) {
      entry.rateLimited = false;
      entry.cooldownUntil = null;
      return true;
    }
    return false;
  }

  /** Get the next available provider in priority order, skipping the excluded provider. */
  getNextAvailableProvider(exclude?: FailoverProvider): FailoverProvider | null {
    for (const provider of this.config.order) {
      if (provider === exclude) continue;
      if (this.isProviderAvailable(provider)) return provider;
    }
    return null;
  }

  /** Get usage data for a specific provider. */
  getUsage(provider: FailoverProvider): ProviderTokenUsage {
    return this.getOrCreateUsage(provider);
  }

  /** Get status for all providers. */
  getAllStatuses(): ProviderStatus[] {
    return this.config.order.map((provider, index) => {
      const entry = this.getOrCreateUsage(provider);
      const available = this.isProviderAvailable(provider);
      const cooldownRemaining = entry.cooldownUntil
        ? Math.max(0, new Date(entry.cooldownUntil).getTime() - Date.now())
        : 0;
      return {
        provider,
        available,
        rateLimited: entry.rateLimited,
        cooldownRemaining,
        usage: { ...entry },
        priority: index + 1,
      };
    });
  }

  /** Get all failover events. */
  getEvents(): FailoverEvent[] {
    return [...this.events];
  }

  /** Get the failover config. */
  getConfig(): FailoverConfig {
    return { ...this.config };
  }

  /** Reset cooldown for a specific provider. */
  resetCooldown(provider: FailoverProvider): void {
    const entry = this.usage.get(provider);
    if (entry) {
      entry.rateLimited = false;
      entry.cooldownUntil = null;
    }
  }

  /** Reset all state. */
  reset(): void {
    this.usage.clear();
    this.events = [];
    for (const provider of this.config.order) {
      this.usage.set(provider, createEmptyUsage(provider));
    }
  }

  private getOrCreateUsage(provider: FailoverProvider): ProviderTokenUsage {
    let entry = this.usage.get(provider);
    if (!entry) {
      entry = createEmptyUsage(provider);
      this.usage.set(provider, entry);
    }
    return entry;
  }
}

function createEmptyUsage(provider: FailoverProvider): ProviderTokenUsage {
  return {
    provider,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requestCount: 0,
    errorCount: 0,
    lastUsedAt: null,
    lastErrorAt: null,
    rateLimited: false,
    cooldownUntil: null,
  };
}

/** Detect rate limit / quota errors from an error message string. */
export function isRateLimitError(message: string): boolean {
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}
