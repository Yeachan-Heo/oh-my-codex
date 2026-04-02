/**
 * Provider abstraction for oh-my-codex
 *
 * Defines the contract each AI coding tool must fulfill so that OMX
 * can install prompts, skills, agents, and config into the right
 * locations with the right format.
 */

import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Provider type
// ---------------------------------------------------------------------------

export const PROVIDERS = ["codex", "claude", "cursor"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface ProviderConfig {
  /** Human-readable display name */
  displayName: string;

  /** CLI command used to launch the tool (null if IDE-only) */
  cliCommand: string | null;

  /** User-level home directory (e.g. ~/.codex, ~/.claude) */
  homeDir: string;

  /** Config file path relative to homeDir */
  configFile: string;

  /** Config file format */
  configFormat: "toml" | "json";

  /** Directory name used for project-local config (e.g. .codex, .claude) */
  projectDirName: string;

  /** How prompts/instructions are injected */
  promptInjection: PromptInjectionMethod;

  /** Approval-bypass flag, if any */
  bypassFlag: string | null;
}

export type PromptInjectionMethod =
  | { type: "config-key"; key: string }
  | { type: "markdown-file"; filename: string }
  | { type: "rules-file"; filename: string };

// ---------------------------------------------------------------------------
// Provider definitions
// ---------------------------------------------------------------------------

const PROVIDER_CONFIGS: Record<ProviderName, ProviderConfig> = {
  codex: {
    displayName: "OpenAI Codex CLI",
    cliCommand: "codex",
    homeDir: join(homedir(), ".codex"),
    configFile: "config.toml",
    configFormat: "toml",
    projectDirName: ".codex",
    promptInjection: { type: "config-key", key: "developer_instructions" },
    bypassFlag: "--dangerously-bypass-approvals-and-sandbox",
  },

  claude: {
    displayName: "Claude Code",
    cliCommand: "claude",
    homeDir: join(homedir(), ".claude"),
    configFile: "settings.json",
    configFormat: "json",
    projectDirName: ".claude",
    promptInjection: { type: "markdown-file", filename: "CLAUDE.md" },
    bypassFlag: "--dangerously-skip-permissions",
  },

  cursor: {
    displayName: "Cursor",
    cliCommand: null,
    homeDir: join(homedir(), ".cursor"),
    configFile: "settings.json",
    configFormat: "json",
    projectDirName: ".cursor",
    promptInjection: { type: "rules-file", filename: ".cursorrules" },
    bypassFlag: null,
  },
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const PROVIDER_ENV_KEY = "OMX_PROVIDER";

let _activeProvider: ProviderName | undefined;

/** Set the active provider for this process (called once from CLI parsing). */
export function setActiveProvider(name: ProviderName): void {
  _activeProvider = name;
}

/** Resolve the active provider from explicit set, env var, or default. */
export function getActiveProvider(): ProviderName {
  if (_activeProvider) return _activeProvider;
  const envValue = process.env[PROVIDER_ENV_KEY];
  if (envValue && isProviderName(envValue)) return envValue;
  return "codex";
}

/** Get config for a specific provider. */
export function getProviderConfig(name?: ProviderName): ProviderConfig {
  return PROVIDER_CONFIGS[name ?? getActiveProvider()];
}

/** Type guard */
export function isProviderName(value: string): value is ProviderName {
  return PROVIDERS.includes(value as ProviderName);
}

// ---------------------------------------------------------------------------
// Convenience path helpers (provider-aware replacements for paths.ts funcs)
// ---------------------------------------------------------------------------

/** Provider home directory (e.g. ~/.codex, ~/.claude, ~/.cursor) */
export function providerHome(provider?: ProviderName): string {
  return getProviderConfig(provider).homeDir;
}

/** Provider config file path */
export function providerConfigPath(provider?: ProviderName): string {
  const cfg = getProviderConfig(provider);
  return join(cfg.homeDir, cfg.configFile);
}

/** Provider prompts directory */
export function providerPromptsDir(provider?: ProviderName): string {
  return join(providerHome(provider), "prompts");
}

/** Provider skills directory */
export function providerSkillsDir(provider?: ProviderName): string {
  return join(providerHome(provider), "skills");
}

/** Provider agents directory */
export function providerAgentsDir(provider?: ProviderName): string {
  return join(providerHome(provider), "agents");
}

/** Project-level provider directory */
export function projectProviderDir(
  provider?: ProviderName,
  projectRoot?: string,
): string {
  const cfg = getProviderConfig(provider);
  return join(projectRoot ?? process.cwd(), cfg.projectDirName);
}
