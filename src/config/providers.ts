/**
 * Known Codex model providers.
 *
 * Codex routes model traffic through the active `model_provider` selected in
 * `config.toml` (`model_provider = "<name>"`), with each named provider
 * described by a `[model_providers.<name>]` table. OMX does not own that table
 * (Codex does), but it can expose first-class launch shorthands for providers
 * it knows about, so users can select a named provider without hand-editing
 * `config.toml`.
 *
 * This registry intentionally stays small: it only lists providers OMX ships
 * a first-class `--provider` shorthand for. Any other provider name is an
 * opaque passthrough value and carries no OMX-specific routing meaning.
 */

export interface KnownProviderInfo {
  /** Provider name used in `config.toml` `model_provider = "<name>"`. */
  name: string;
  /** Short human-readable label for `omx help` and diagnostics. */
  label: string;
  /** Environment key that holds the provider API key, when one is expected. */
  envKey?: string;
  /** Base URL for OpenAI-compatible providers, when OMX knows it. */
  baseUrl?: string;
  /** Optional note shown by `omx providers` for this provider. */
  description?: string;
}

export const ORCAROUTER_PROVIDER_NAME = "orcarouter";

export const ORCAROUTER_PROVIDER_INFO: KnownProviderInfo = {
  name: ORCAROUTER_PROVIDER_NAME,
  label: "OrcaRouter",
  envKey: "ORCAROUTER_API_KEY",
  baseUrl: "https://api.orcarouter.ai/v1",
  description:
    "OpenAI-compatible gateway for models and agents: adaptive routing, automatic failover, zero-markup inference, observability, guardrails, and gateway-level agent-tool governance.",
};

export const KNOWN_PROVIDERS: readonly KnownProviderInfo[] = [
  {
    name: "openai",
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    name: "openai-chatgpt",
    label: "OpenAI ChatGPT (subscription)",
  },
  ORCAROUTER_PROVIDER_INFO,
];

const KNOWN_PROVIDER_BY_NAME = new Map<string, KnownProviderInfo>(
  KNOWN_PROVIDERS.map((provider) => [provider.name, provider]),
);

/** Returns metadata for a provider OMX ships a first-class shorthand for. */
export function getKnownProvider(
  name: string | undefined,
): KnownProviderInfo | undefined {
  if (!name) return undefined;
  const normalized = name.trim();
  return normalized ? KNOWN_PROVIDER_BY_NAME.get(normalized) : undefined;
}

/** True when `name` is a provider OMX exposes a first-class shorthand for. */
export function isKnownProvider(name: string | undefined): boolean {
  return getKnownProvider(name) !== undefined;
}
