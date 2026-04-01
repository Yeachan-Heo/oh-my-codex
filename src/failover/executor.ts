/**
 * Failover-aware execution engine.
 *
 * Wraps provider execution with automatic failover: tries the preferred provider,
 * detects rate limits / quota errors, and switches to the next available provider.
 */

import { spawnSync } from 'child_process';
import type { FailoverConfig, FailoverProvider } from './types.js';
import { DEFAULT_FAILOVER_CONFIG } from './types.js';
import { ProviderTracker, isRateLimitError } from './tracker.js';

export interface FailoverExecutionResult {
  provider: FailoverProvider;
  stdout: string;
  stderr: string;
  exitCode: number;
  failoverAttempts: number;
  failoverChain: FailoverProvider[];
}

export interface FailoverExecutionOptions {
  /** Override the binary name for a provider. */
  providerBinaries?: Partial<Record<FailoverProvider, string>>;
  /** Extra args to pass to the provider binary. */
  extraArgs?: string[];
  /** Maximum buffer size for spawnSync. */
  maxBuffer?: number;
  /** Environment variables. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_PROVIDER_BINARIES: Record<FailoverProvider, string> = {
  codex: 'codex',
  claude: 'claude',
  gemini: 'gemini',
  qwen: 'qwen',
  grok: 'grok',
};

/**
 * Execute a prompt with automatic failover across providers.
 *
 * Tries the preferred provider first. If it fails with a rate limit or quota error,
 * automatically switches to the next available provider in the failover chain.
 */
export function executeWithFailover(
  prompt: string,
  preferredProvider: FailoverProvider,
  tracker: ProviderTracker,
  config: Partial<FailoverConfig> = {},
  options: FailoverExecutionOptions = {},
): FailoverExecutionResult {
  const resolvedConfig = { ...DEFAULT_FAILOVER_CONFIG, ...config };
  const binaries = { ...DEFAULT_PROVIDER_BINARIES, ...options.providerBinaries };
  const maxRetries = resolvedConfig.maxRetries;
  const failoverChain: FailoverProvider[] = [];
  let currentProvider = preferredProvider;
  let attempt = 0;

  while (attempt <= maxRetries) {
    if (!tracker.isProviderAvailable(currentProvider)) {
      const next = tracker.getNextAvailableProvider(currentProvider);
      if (!next) {
        return {
          provider: currentProvider,
          stdout: '',
          stderr: `All providers exhausted after ${attempt} attempts. No available providers.`,
          exitCode: 1,
          failoverAttempts: attempt,
          failoverChain,
        };
      }
      tracker.recordFailover(currentProvider, next, 'provider_unavailable', attempt);
      failoverChain.push(currentProvider);
      currentProvider = next;
      continue;
    }

    const binary = binaries[currentProvider] ?? currentProvider;
    const args = ['-p', prompt, ...(options.extraArgs ?? [])];

    const result = spawnSync(binary, args, {
      encoding: 'utf8',
      maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
      env: options.env,
    });

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const exitCode = typeof result.status === 'number' ? result.status : 1;

    if (exitCode === 0) {
      tracker.recordUsage(currentProvider, prompt.length, stdout.length);
      return {
        provider: currentProvider,
        stdout,
        stderr,
        exitCode,
        failoverAttempts: attempt,
        failoverChain,
      };
    }

    const combinedOutput = `${stdout}\n${stderr}`;
    if (isRateLimitError(combinedOutput) && resolvedConfig.enabled) {
      tracker.recordError(currentProvider, combinedOutput);
      const next = tracker.getNextAvailableProvider(currentProvider);
      if (next) {
        tracker.recordFailover(currentProvider, next, 'rate_limit_detected', attempt);
        failoverChain.push(currentProvider);
        currentProvider = next;
        attempt += 1;
        continue;
      }
    } else {
      tracker.recordError(currentProvider, combinedOutput);
    }

    return {
      provider: currentProvider,
      stdout,
      stderr,
      exitCode,
      failoverAttempts: attempt,
      failoverChain,
    };
  }

  return {
    provider: currentProvider,
    stdout: '',
    stderr: `Max retries (${maxRetries}) exceeded across providers: ${failoverChain.join(' -> ')} -> ${currentProvider}`,
    exitCode: 1,
    failoverAttempts: attempt,
    failoverChain,
  };
}
