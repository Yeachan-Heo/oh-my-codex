/**
 * OpenClaw Configuration Reader
 *
 * Reads OpenClaw config from the notifications.openclaw key in ~/.codex/.omx-config.json.
 * Also supports generic alias shapes under notifications.custom_cli_command
 * and notifications.custom_webhook_command, normalized to OpenClaw runtime config.
 *
 * Config is cached after first read (env vars don't change during process lifetime).
 * Config file path can be overridden via OMX_OPENCLAW_CONFIG env var (points to a separate file).
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { codexHome } from "../utils/paths.js";
import type {
  OpenClawConfig,
  OpenClawHookEvent,
  OpenClawGatewayConfig,
  OpenClawCommandGatewayConfig,
  OpenClawHookMapping,
} from "./types.js";

/** Cached config (null = not yet read, undefined = read but file missing/invalid) */
let _cachedConfig: OpenClawConfig | undefined | null = null;

const VALID_HOOK_EVENTS: OpenClawHookEvent[] = [
  "session-start",
  "session-end",
  "session-idle",
  "ask-user-question",
  "stop",
];

const DEFAULT_ALIAS_EVENTS: OpenClawHookEvent[] = ["session-end", "ask-user-question"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseEvents(value: unknown): OpenClawHookEvent[] {
  if (!Array.isArray(value)) return [...DEFAULT_ALIAS_EVENTS];
  const events = value
    .filter((entry): entry is OpenClawHookEvent =>
      typeof entry === "string" && VALID_HOOK_EVENTS.includes(entry as OpenClawHookEvent),
    );
  return events.length > 0 ? events : [...DEFAULT_ALIAS_EVENTS];
}

function parseInstruction(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeFromCustomAliases(notifications: Record<string, unknown>): OpenClawConfig | null {
  const webhookAlias = asRecord(notifications.custom_webhook_command);
  const cliAlias = asRecord(notifications.custom_cli_command);

  const webhookEnabled = webhookAlias?.enabled !== false && typeof webhookAlias?.url === "string";
  const cliEnabled = cliAlias?.enabled !== false && typeof cliAlias?.command === "string";

  if (!webhookEnabled && !cliEnabled) return null;

  const gateways: Record<string, OpenClawGatewayConfig> = {};
  const hooks: Partial<Record<OpenClawHookEvent, OpenClawHookMapping>> = {};

  const applyHooks = (events: OpenClawHookEvent[], gateway: string, instruction: string, source: string): void => {
    for (const event of events) {
      if (hooks[event]) {
        console.warn(`[openclaw] warning: ${source} overrides existing mapping for event '${event}'`);
      }
      hooks[event] = {
        enabled: true,
        gateway,
        instruction,
      };
    }
  };

  if (cliEnabled && cliAlias) {
    const gatewayName =
      typeof cliAlias.gateway === "string" && cliAlias.gateway.trim()
        ? cliAlias.gateway.trim()
        : "custom-cli";

    gateways[gatewayName] = {
      type: "command",
      command: (cliAlias.command as string).trim(),
      ...(typeof cliAlias.timeout === "number" ? { timeout: cliAlias.timeout } : {}),
    } as OpenClawCommandGatewayConfig;

    applyHooks(
      parseEvents(cliAlias.events),
      gatewayName,
      parseInstruction(
        cliAlias.instruction,
        "OMX event {{event}} for {{projectPath}}",
      ),
      "custom_cli_command",
    );
  }

  if (webhookEnabled && webhookAlias) {
    const gatewayName =
      typeof webhookAlias.gateway === "string" && webhookAlias.gateway.trim()
        ? webhookAlias.gateway.trim()
        : "custom-webhook";

    const method = webhookAlias.method === "PUT" ? "PUT" : "POST";

    gateways[gatewayName] = {
      type: "http",
      url: (webhookAlias.url as string).trim(),
      method,
      ...(typeof webhookAlias.timeout === "number" ? { timeout: webhookAlias.timeout } : {}),
      ...(asRecord(webhookAlias.headers) ? { headers: webhookAlias.headers as Record<string, string> } : {}),
    };

    applyHooks(
      parseEvents(webhookAlias.events),
      gatewayName,
      parseInstruction(
        webhookAlias.instruction,
        "OMX event {{event}} for {{projectPath}}",
      ),
      "custom_webhook_command",
    );
  }

  if (Object.keys(gateways).length === 0 || Object.keys(hooks).length === 0) return null;

  return {
    enabled: true,
    gateways,
    hooks,
  };
}

function isValidOpenClawConfig(raw: OpenClawConfig | undefined): raw is OpenClawConfig {
  return Boolean(raw?.enabled && raw.gateways && raw.hooks);
}

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
 * 3. notifications.custom_cli_command / notifications.custom_webhook_command aliases
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
      if (!isValidOpenClawConfig(raw)) {
        _cachedConfig = undefined;
        return null;
      }
      _cachedConfig = raw;
      return raw;
    }

    // Primary: read from notifications block in .omx-config.json
    const omxConfigPath = join(codexHome(), ".omx-config.json");
    if (!existsSync(omxConfigPath)) {
      _cachedConfig = undefined;
      return null;
    }

    const fullConfig = JSON.parse(readFileSync(omxConfigPath, "utf-8")) as Record<string, unknown>;
    const notifications = asRecord(fullConfig.notifications);
    if (!notifications) {
      _cachedConfig = undefined;
      return null;
    }

    const explicitOpenClaw = notifications.openclaw as OpenClawConfig | undefined;
    const aliasOpenClaw = normalizeFromCustomAliases(notifications);

    if (isValidOpenClawConfig(explicitOpenClaw)) {
      if (aliasOpenClaw) {
        console.warn(
          "[openclaw] warning: notifications.openclaw is set; ignoring custom_cli_command/custom_webhook_command aliases",
        );
      }
      _cachedConfig = explicitOpenClaw;
      return explicitOpenClaw;
    }

    if (aliasOpenClaw) {
      _cachedConfig = aliasOpenClaw;
      return aliasOpenClaw;
    }

    _cachedConfig = undefined;
    return null;
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
