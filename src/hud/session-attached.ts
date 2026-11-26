import { execFileSync } from 'node:child_process';
import { resolveTmuxBinaryForPlatform } from '../utils/platform-command.js';

export interface IsHudWatchSessionAttachedDeps {
  env?: NodeJS.ProcessEnv;
  execTmuxSync?: (args: string[]) => string;
}

/**
 * Reports whether any tmux client is attached to the session this HUD pane
 * belongs to. Used by watch mode to avoid render-only work (state reads, git
 * subprocess spawns, tmux reconciliation, stdout writes) while nobody is
 * looking at the pane. (closes #3577)
 *
 * Returns true (assume attached) whenever the answer is unknown, so the HUD
 * keeps rendering on non-tmux terminals, when tmux is unavailable, or on any
 * query failure — detached suppression only happens on a trusted "0".
 */
export function isHudWatchSessionAttached(
  deps: IsHudWatchSessionAttachedDeps = {},
): boolean {
  const env = deps.env ?? process.env;
  if (!env.TMUX) return true;

  const exec = deps.execTmuxSync ?? ((args: string[]) => {
    const binary = resolveTmuxBinaryForPlatform() || 'tmux';
    return execFileSync(binary, args, {
      encoding: 'utf-8',
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    });
  });

  const query = (paneId: string): boolean => {
    const output = exec(['display-message', '-p', '-t', paneId, '#{session_attached}']).trim();
    return output !== '0';
  };

  const paneId = env.TMUX_PANE?.trim();
  if (paneId) {
    try {
      return query(paneId);
    } catch {
      return true;
    }
  }

  // No pane id in env (unusual for a real HUD pane); fall back to the active
  // pane of the server described by $TMUX, which is the same session in the
  // single-session layouts OMX launches.
  try {
    return query('');
  } catch {
    return true;
  }
}

/**
 * Cache state for the attachment check.
 */
interface AttachmentCacheEntry {
  result: boolean;
  expiresAtMs: number;
  paneId: string;
  tmuxSocket: string;
}

/**
 * Creates a cached version of isHudWatchSessionAttached that reuses results
 * for a bounded TTL (default 3 seconds). This avoids the expensive synchronous
 * tmux subprocess call on every render tick.
 *
 * Cache is keyed by (tmux socket, pane id) to handle multi-session layouts.
 * Expiration is wall-clock based, so TTL is approximate but always respected.
 */
export function createCachedIsHudWatchSessionAttached(
  ttlMs: number = 3000,
): (deps?: IsHudWatchSessionAttachedDeps) => boolean {
  const cache = new Map<string, AttachmentCacheEntry>();

  return function isHudWatchSessionAttachedCached(
    deps: IsHudWatchSessionAttachedDeps = {},
  ): boolean {
    const env = deps.env ?? process.env;

    // Extract cache key from environment
    const tmuxSocket = env.TMUX?.split(',')[0] ?? '';
    const paneId = env.TMUX_PANE?.trim() ?? '';
    const cacheKey = `${tmuxSocket}:${paneId}`;

    // Check cache
    const now = Date.now();
    const cached = cache.get(cacheKey);
    if (cached && now < cached.expiresAtMs) {
      return cached.result;
    }

    // Cache miss or expired: query and store
    const result = isHudWatchSessionAttached(deps);
    cache.set(cacheKey, {
      result,
      expiresAtMs: now + ttlMs,
      paneId,
      tmuxSocket,
    });

    // Clean up expired entries to prevent unbounded memory growth
    if (cache.size > 100) {
      for (const [key, entry] of cache.entries()) {
        if (now >= entry.expiresAtMs) {
          cache.delete(key);
        }
      }
    }

    return result;
  };
}
