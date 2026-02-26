/**
 * OpenClaw Configuration Reader
 *
 * Reads OpenClaw config from the notifications.openclaw key in ~/.codex/.omx-config.json.
 * Config is cached after first read (env vars don't change during process lifetime).
 * Config file path can be overridden via OMX_OPENCLAW_CONFIG env var (points to a separate file).
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { codexHome } from "../utils/paths.js";
import type { OpenClawConfig, OpenClawHookEvent, OpenClawGatewayConfig, OpenClawCommandGatewayConfig } from "./types.js";

/** Cached config (null = not yet read, undefined = read but file missing/invalid) */
let _cachedConfig: OpenClawConfig | undefined | null = null;

/**
 * Read and cache the OpenClaw configuration.
 *
 * Returns null when:
 * - OMX_OPENCLAW env var is not "1"
 * - Config file does not exist
 * - Config file is invalid JSON
 * - Config has enabled: false
 *
 * Config is read from:
 * 1. OMX_OPENCLAW_CONFIG env var path (separate file), if set
 * 2. notifications.openclaw key in ~/.codex/.omx-config.json
 */
export function getOpenClawConfig(): OpenClawConfig | null {
  // Activation gate: only active when OMX_OPENCLAW=1
  if (process.env.OMX_OPENCLAW !== "1") {
    return null;
  }

  // Return cached result
  if (_cachedConfig !== null) {
    return _cachedConfig ?? null;
  }

  try {
    const envOverride = process.env.OMX_OPENCLAW_CONFIG;

    if (envOverride) {
      // OMX_OPENCLAW_CONFIG points to a separate config file
      if (!existsSync(envOverride)) {
        _cachedConfig = undefined;
        return null;
      }
      const raw = JSON.parse(readFileSync(envOverride, "utf-8")) as OpenClawConfig;
      if (!raw.enabled || !raw.gateways || !raw.hooks) {
        _cachedConfig = undefined;
        return null;
      }
      _cachedConfig = raw;
      return raw;
    } else {
      // Primary: read from notifications.openclaw key in .omx-config.json
      const omxConfigPath = join(codexHome(), ".omx-config.json");
      if (!existsSync(omxConfigPath)) {
        _cachedConfig = undefined;
        return null;
      }
      const fullConfig = JSON.parse(readFileSync(omxConfigPath, "utf-8")) as Record<string, unknown>;
      const notifBlock = fullConfig.notifications as Record<string, unknown> | undefined;
      const raw = notifBlock?.openclaw as OpenClawConfig | undefined;
      if (!raw || !raw.enabled || !raw.gateways || !raw.hooks) {
        _cachedConfig = undefined;
        return null;
      }
      _cachedConfig = raw;
      return raw;
    }
  } catch {
    _cachedConfig = undefined;
    return null;
  }
}

/**
 * Resolve gateway config for a specific hook event.
 * Returns null if the event is not mapped or disabled.
 * Returns the gateway name alongside config to avoid O(n) reverse lookup.
 */
export function resolveGateway(
  config: OpenClawConfig,
  event: OpenClawHookEvent,
): { gatewayName: string; gateway: OpenClawGatewayConfig; instruction: string } | null {
  const mapping = config.hooks[event];
  if (!mapping || !mapping.enabled) {
    return null;
  }

  const gateway = config.gateways[mapping.gateway];
  if (!gateway) {
    return null;
  }

  // Validate based on gateway type
  if ((gateway as OpenClawCommandGatewayConfig).type === "command") {
    if (!(gateway as OpenClawCommandGatewayConfig).command) return null;
  } else {
    // HTTP gateway (default when type is absent or "http")
    if (!("url" in gateway) || !gateway.url) return null;
  }

  return { gatewayName: mapping.gateway, gateway, instruction: mapping.instruction };
}

/**
 * Reset the config cache (for testing only).
 */
export function resetOpenClawConfigCache(): void {
  _cachedConfig = null;
}
