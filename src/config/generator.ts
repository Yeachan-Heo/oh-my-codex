/**
 * Config.toml generator/merger for oh-my-codex
 * Merges OMX MCP server entries and feature flags into existing config.toml
 *
 * TOML structure reminder: bare key=value pairs after a [table] header belong
 * to that table.  Top-level (root-table) keys MUST appear before the first
 * [table] header.  This generator therefore splits its output into:
 *   1. Top-level keys  (notify, model_reasoning_effort, developer_instructions)
 *   2. [features] flags
 *   3. [table] sections (shell_environment_policy.set, mcp_servers, tui)
 */

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";
import TOML from "@iarna/toml";
import { DEFAULT_FRONTIER_MODEL } from "./models.js";
import type { UnifiedMcpRegistryServer } from "./mcp-registry.js";
import {
  DEFAULT_CODEX_HOOK_FEATURE_FLAG,
  CODEX_HOOK_FEATURE_FLAGS,
  CODEX_PLUGIN_SCOPED_HOOKS_FEATURE_FLAG,
  formatCodexHookFeatureFlagLine,
  normalizeCodexHookFeatureFlag,
  type CodexHookFeatureFlag,
} from "./codex-feature-flags.js";
import {
  OMX_FIRST_PARTY_MCP_SERVER_NAMES,
  getOmxFirstPartySetupMcpServers,
} from "./omx-first-party-mcp.js";
import {
  buildManagedCodexHookTrustState,
  escapeTomlBasicString,
  ManagedCodexHooksPlanError,
  scanManagedCodexHookTrustStateFromContent,
  type CodexHooksJsonTrustStateEntry,
  type ManagedCodexHookTrustState,
  type ManagedCodexHookOptions,
} from "./codex-hooks.js";

import type { HudPreset } from "../hud/types.js";

interface MergeOptions {
  includeTui?: boolean;
  codexHooksFile?: string;
  codexHomeDir?: string;
  hookCommandPlatform?: ManagedCodexHookOptions["platform"];
  codexHooksContent?: string | null;
  /** Trust keys scanned from the already-planned final hooks.json content. */
  managedHookTrustState?: Record<string, ManagedCodexHookTrustState>;
  /** Trust keys scanned from the prior hooks.json content for proof-based cleanup. */
  priorManagedHookTrustState?: Record<string, ManagedCodexHookTrustState>;
  /** Exact historical hooks.json state extracted by a strict hooks plan. */
  legacyHookTrustState?: Record<string, CodexHooksJsonTrustStateEntry>;
  codexHookFeatureFlag?: CodexHookFeatureFlag;
  modelOverride?: string;
  sharedMcpServers?: UnifiedMcpRegistryServer[];
  sharedMcpRegistrySource?: string;
  verbose?: boolean;
  statusLinePreset?: HudPreset;
  forceStatusLinePreset?: boolean;
  notifyCommand?: string[] | false;
  includeFirstPartyMcp?: boolean;
  preserveExistingFirstPartyMcp?: boolean;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Top-level OMX keys (must live before any [table] header)
// ---------------------------------------------------------------------------

/** Keys we own at the TOML root level. Used for upsert + strip. */
const OMX_TOP_LEVEL_KEYS = [
  "notify",
  "model_reasoning_effort",
  "developer_instructions",
] as const;

export const DEFAULT_SETUP_MODEL = DEFAULT_FRONTIER_MODEL;

const LEGACY_SEEDED_MODEL_CONTEXT_WINDOW = 250000;
const LEGACY_SEEDED_MODEL_AUTO_COMPACT_TOKEN_LIMIT = 200000;
const OMX_SEEDED_BEHAVIORAL_DEFAULTS_START_MARKER =
  "# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)";
const OMX_SEEDED_BEHAVIORAL_DEFAULTS_END_MARKER =
  "# End oh-my-codex seeded behavioral defaults";

export const OMX_DEVELOPER_INSTRUCTIONS =
  "You have oh-my-codex installed. AGENTS.md is the orchestration brain and main control surface. Follow AGENTS.md for skill/keyword routing, $name workflow invocation, and role-specialized subagents; when the native surface exposes `agent_type` role routing, set `agent_type` to an installed role and never omit it for OMX work. When it does not (`role_routing_unavailable`, for example a Codex App `spawn_agent` surface exposing only `task_name`, `message`, and `fork_turns`), do not fabricate `agent_type`; follow the OMX adapted role-pass protocol by recording a pre-validated role intent in the OMX subagent ledger, and never fake the role via a prompt label. Use outcome-first, concise progress updates: state the target result, constraints, validation evidence, and stop condition before adding process detail. Native subagents live in .codex/agents and may handle independent parallel subtasks within one Codex session or team pane. Skills load from .codex/skills, not native-agent TOMLs. Treat installed prompts as narrower execution surfaces under AGENTS.md authority.";
export const OMX_PLUGIN_DEVELOPER_INSTRUCTIONS =
  '<omx version="1">You have oh-my-codex installed through Codex plugin mode. AGENTS.md is the orchestration brain and main control surface. Follow AGENTS.md for skill/keyword routing and $name workflow invocation. When the native surface exposes `agent_type` role routing, set `agent_type` to an installed role and never omit it for OMX work. When it does not (`role_routing_unavailable`, for example a Codex App `spawn_agent` surface exposing only `task_name`, `message`, and `fork_turns`), do not fabricate `agent_type`; follow the OMX adapted role-pass protocol by recording a pre-validated role intent in the OMX subagent ledger, and never fake the role via a prompt label. Registered Codex plugin marketplace surfaces supply OMX workflows and plugin-scoped companion resources when the plugin is installed; native agent roles are installed as setup-owned Codex agent TOML files in plugin mode so agent_type routing works. User-installed skills may still live under ~/.codex/skills. Use outcome-first, concise progress updates: state the target result, constraints, validation evidence, and stop condition before adding process detail.</omx>';
const SHARED_MCP_REGISTRY_MARKER = "oh-my-codex (OMX) Shared MCP Registry Sync";
const SHARED_MCP_REGISTRY_END_MARKER =
  "# End oh-my-codex shared MCP registry sync";

export type LegacyMultiAgentKey =
  | "features.multi_agent"
  | "agents.max_threads"
  | "agents.max_depth";

export type LegacyKeyState =
  | "absent"
  | "retained-legacy"
  | "custom"
  | "invalid/duplicate";

export type LegacyReasonCode =
  | "key-absent"
  | "exact-legacy-value"
  | "custom-value"
  | "toml-parse-error"
  | "toml-duplicate-key";

export interface LegacyKeyAssessment {
  key: LegacyMultiAgentKey;
  state: LegacyKeyState;
  reasonCode: LegacyReasonCode;
  value?: unknown;
}

export interface LegacyMultiAgentAnalysis {
  assessments: Record<LegacyMultiAgentKey, LegacyKeyAssessment>;
}

const LEGACY_MULTI_AGENT_KEYS: readonly LegacyMultiAgentKey[] = [
  "features.multi_agent",
  "agents.max_threads",
  "agents.max_depth",
];

const LEGACY_MULTI_AGENT_VALUES: Record<LegacyMultiAgentKey, unknown> = {
  "features.multi_agent": true,
  "agents.max_threads": 6,
  "agents.max_depth": 2,
};

export function analyzeLegacyMultiAgentConfig(
  configText: string,
): LegacyMultiAgentAnalysis {
  let parsed: Record<string, unknown>;
  try {
    parsed = TOML.parse(configText) as Record<string, unknown>;
  } catch (error) {
    const reasonCode: LegacyReasonCode =
      /duplicate|redefine|already defined/i.test(String(error))
        ? "toml-duplicate-key"
        : "toml-parse-error";
    return {
      assessments: Object.fromEntries(
        LEGACY_MULTI_AGENT_KEYS.map((key) => [
          key,
          { key, state: "invalid/duplicate", reasonCode },
        ]),
      ) as Record<LegacyMultiAgentKey, LegacyKeyAssessment>,
    };
  }

  return {
    assessments: Object.fromEntries(
      LEGACY_MULTI_AGENT_KEYS.map((key) => {
        const [table, entry] = key.split(".");
        const value = isRecord(parsed[table]) ? parsed[table][entry] : undefined;
        if (value === undefined) {
          return [key, { key, state: "absent", reasonCode: "key-absent" }];
        }
        if (value === LEGACY_MULTI_AGENT_VALUES[key]) {
          return [
            key,
            {
              key,
              state: "retained-legacy",
              reasonCode: "exact-legacy-value",
              value,
            },
          ];
        }
        return [
          key,
          { key, state: "custom", reasonCode: "custom-value", value },
        ];
      }),
    ) as Record<LegacyMultiAgentKey, LegacyKeyAssessment>,
  };
}

const OMX_EXPLORE_ROUTING_DEFAULT = "0";
const OMX_EXPLORE_CMD_ENV = "USE_OMX_EXPLORE_CMD";
const DEFAULT_LAUNCHER_MCP_STARTUP_TIMEOUT_SEC = 15;
const STATUS_LINE_FOCUSED_FIELDS: readonly string[] = [
  "model-with-reasoning",
  "git-branch",
  "context-remaining",
  "total-input-tokens",
  "total-output-tokens",
  "five-hour-limit",
  "weekly-limit",
];

// `full` is currently identical to `focused`. It is reserved for future
// expansion as Codex CLI adds support for additional status_line fields.
export const STATUS_LINE_PRESETS: Record<HudPreset, readonly string[]> = {
  minimal: ["model-with-reasoning", "git-branch"],
  focused: STATUS_LINE_FOCUSED_FIELDS,
  full: STATUS_LINE_FOCUSED_FIELDS,
};

export const DEFAULT_STATUS_LINE_PRESET: HudPreset = "focused";

export function statusLineForPreset(
  preset: HudPreset = DEFAULT_STATUS_LINE_PRESET,
): string {
  const fields =
    STATUS_LINE_PRESETS[preset] ??
    STATUS_LINE_PRESETS[DEFAULT_STATUS_LINE_PRESET];
  return `status_line = [${fields.map((field) => `"${field}"`).join(", ")}]`;
}

// Marker comment OMX emits immediately above any status_line it owns. New writes
// always include it; the customized-section detector keys on this marker so a
// user-edited status_line that happens to byte-match a preset literal (e.g.
// `["model-with-reasoning", "git-branch"]` matching the `minimal` preset) is
// still recognized as a user customization and preserved.
const OMX_MANAGED_STATUS_LINE_MARKER = "# omx:managed-status-line";

// Pre-marker installs only ever shipped the seven-field `focused` array.
// Treat that exact value as OMX-managed for backward compatibility so
// upgrades/preset switches still strip the legacy line. Any other preset
// literal without the marker is assumed user-written.
const LEGACY_OMX_STATUS_LINE = statusLineForPreset(
  DEFAULT_STATUS_LINE_PRESET,
);

// Set of every status_line literal OMX itself can emit today. Used together
// with the marker comment: if a status_line is preceded by the marker AND
// its value is a known OMX preset, it is OMX-managed. If the marker is
// present but the value is something else, the user edited the value (and
// left the marker untouched) — treat as a user customization and preserve.
const OMX_PRESET_STATUS_LINE_VALUES: ReadonlySet<string> = new Set(
  (Object.keys(STATUS_LINE_PRESETS) as HudPreset[]).map((preset) =>
    statusLineForPreset(preset),
  ),
);
const LEGACY_OMX_TEAM_RUN_TABLE_PATTERN =
  /^\s*\[mcp_servers\.(?:"omx_team_run"|omx_team_run)\]\s*$/m;
const OMX_CONFIG_MARKER = "oh-my-codex (OMX) Configuration";
const OMX_CONFIG_START_MARKER = `# ${OMX_CONFIG_MARKER}`;
const OMX_CONFIG_END_MARKER = "# End oh-my-codex";

const CODEX_MODEL_AVAILABILITY_NUX_TABLE_PATTERN = /^\s*\[tui\.model_availability_nux\]\s*(?:#.*)?$/;
const TOML_TABLE_HEADER_PATTERN = /^\s*\[\[?[^\]]+\]?\]\s*(?:#.*)?$/;

export function stripCodexModelAvailabilityNux(config: string): string {
  const lines = config.split(/\r?\n/);
  const result: string[] = [];
  let removed = false;

  for (let i = 0; i < lines.length;) {
    if (CODEX_MODEL_AVAILABILITY_NUX_TABLE_PATTERN.test(lines[i])) {
      removed = true;
      i += 1;
      while (i < lines.length && !TOML_TABLE_HEADER_PATTERN.test(lines[i])) {
        i += 1;
      }
      continue;
    }

    result.push(lines[i]);
    i += 1;
  }

  return removed ? result.join("\n") : config;
}

export async function cleanCodexModelAvailabilityNuxIfNeeded(
  configPath: string,
): Promise<boolean> {
  if (!existsSync(configPath)) return false;

  const content = await readFile(configPath, "utf-8");
  const cleaned = stripCodexModelAvailabilityNux(content);
  if (cleaned === content) return false;

  await writeFile(configPath, cleaned);
  return true;
}

export function hasLegacyOmxTeamRunTable(config: string): boolean {
  return LEGACY_OMX_TEAM_RUN_TABLE_PATTERN.test(config);
}

function unwrapTomlString(value: string | undefined): string | undefined {
  return value?.match(/^"(.*)"$/)?.[1];
}

export function getRootModelName(config: string): string | undefined {
  return unwrapTomlString(parseRootKeyValues(config).get("model"));
}

const ROOT_TABLE_HEADER_PATTERN = /^\s*\[\[?[^\]]+\]?\]\s*$/;
const ROOT_KEY_ASSIGNMENT_PATTERN = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/;

type RootLevelEntry = {
  key?: string;
  lines: string[];
};

function parseStandaloneToml(snippet: string): boolean {
  try {
    TOML.parse(snippet);
    return true;
  } catch {
    return false;
  }
}

function splitRootLevelEntries(config: string): {
  entries: RootLevelEntry[];
  remainder: string[];
} {
  const lines = config.split(/\r?\n/);
  const entries: RootLevelEntry[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (ROOT_TABLE_HEADER_PATTERN.test(line)) break;

    const match = line.match(ROOT_KEY_ASSIGNMENT_PATTERN);
    if (!match) {
      entries.push({ lines: [line] });
      index += 1;
      continue;
    }

    const entryLines = [line];
    while (
      !parseStandaloneToml(entryLines.join("\n")) &&
      index + entryLines.length < lines.length
    ) {
      entryLines.push(lines[index + entryLines.length]);
    }

    entries.push({ key: match[1], lines: entryLines });
    index += entryLines.length;
  }

  return { entries, remainder: lines.slice(index) };
}

function parseRootKeyValues(config: string): Map<string, string> {
  const values = new Map<string, string>();
  const { entries } = splitRootLevelEntries(config);

  for (const entry of entries) {
    if (!entry.key) continue;
    const [firstLine, ...rest] = entry.lines;
    const match = firstLine.match(ROOT_KEY_ASSIGNMENT_PATTERN);
    if (!match) continue;
    const value = [match[2], ...rest].join("\n").trim();
    values.set(entry.key, value);
  }

  return values;
}

function getDefaultNotifyCommand(pkgRoot: string): string[] {
  return ["node", join(pkgRoot, "dist", "scripts", "notify-hook.js")];
}

export function formatTomlStringArray(values: readonly string[]): string {
  return `[${values.map((value) => `"${escapeTomlString(value)}"`).join(", ")}]`;
}

export function getRootTomlArray(config: string, key: string): string[] | null {
  const raw = parseRootKeyValues(config).get(key);
  if (!raw) return null;
  try {
    const parsed = TOML.parse(`${key} = ${raw}`) as Record<string, unknown>;
    const value = parsed[key];
    if (
      !Array.isArray(value) ||
      !value.every((item) => typeof item === "string")
    ) {
      return null;
    }
    return value as string[];
  } catch {
    return null;
  }
}

function resolveNotifyEntrypoint(command: readonly string[]): string | undefined {
  if (!/(?:^|[\\/])node(?:\.exe)?$/i.test(command[0] ?? "")) {
    return command[0];
  }
  return command.slice(1).find((arg) => !arg.startsWith("-"));
}

function getPreviousNotifyWrapperValue(
  command: readonly string[],
): string | undefined {
  for (let index = 0; index < command.length; index += 1) {
    const part = command[index];
    if (part === "--previous-notify") {
      return command[index + 1];
    }
    if (part.startsWith("--previous-notify=")) {
      return part.slice("--previous-notify=".length);
    }
  }
  return undefined;
}

function isOmxDispatcherMetadataCommand(command: readonly string[] | null | undefined): boolean {
  if (!command) return false;
  const entrypoint = resolveNotifyEntrypoint(command);
  if (!entrypoint || !/(?:^|[\\/])notify-dispatcher\.js$/.test(entrypoint)) {
    return false;
  }
  const metadataIndex = command.indexOf("--metadata");
  const metadataPath = metadataIndex >= 0 ? command[metadataIndex + 1] : undefined;
  return typeof metadataPath === "string" && /(?:^|[\\/])(?:\.omx[\\/])?notify-dispatch\.json$/.test(metadataPath);
}

function isOmxManagedPayloadText(value: string): boolean {
  const containsManagedPackageNotify =
    /(?:^|[\\/])notify-(?:hook|dispatcher)\.js(?:\s|$|["'])/.test(
      value,
    ) && /(?:^|[\\/])oh-my-codex(?:[\\/]|$)/.test(value);
  const containsDispatcherMetadataNotify =
    /(?:^|[\\/])notify-dispatcher\.js(?:\s|$|["'])/.test(value) &&
    /--metadata(?:\s|=)/.test(value) &&
    /(?:^|[\\/])(?:\.omx[\\/])?notify-dispatch\.json(?:\s|$|["'])/.test(value);
  return containsManagedPackageNotify || containsDispatcherMetadataNotify;
}

function parseJsonString(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const first = trimmed[0];
  if (first !== "[" && first !== "{" && first !== '"') return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function containsOmxManagedNotifyPayload(
  value: unknown,
  pkgRoot: string | undefined,
  depth = 0,
): boolean {
  if (depth > 8 || value == null) return false;
  if (typeof value === "string") {
    const parsed = parseJsonString(value);
    if (parsed !== undefined && parsed !== value) {
      return containsOmxManagedNotifyPayload(parsed, pkgRoot, depth + 1);
    }
    return isOmxManagedPayloadText(value);
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      const nestedCommand = value as string[];
      return (
        isOmxManagedNotifyCommand(nestedCommand, pkgRoot) ||
        isOmxDispatcherMetadataCommand(nestedCommand) ||
        isOmxManagedPreviousNotifyWrapper(nestedCommand, pkgRoot)
      );
    }
    return value.some((item) =>
      containsOmxManagedNotifyPayload(item, pkgRoot, depth + 1),
    );
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [
      record.previousNotify,
      record.previous_notify,
      record.notify,
      record.command,
      record.argv,
      record.args,
    ].some((item) => containsOmxManagedNotifyPayload(item, pkgRoot, depth + 1));
  }
  return false;
}

function isOmxManagedPreviousNotifyWrapper(
  command: readonly string[] | null | undefined,
  pkgRoot?: string,
): boolean {
  if (!command) return false;
  if (!command.some((part) => part === "turn-ended")) return false;
  const previousNotify = getPreviousNotifyWrapperValue(command);
  if (!previousNotify) return false;

  return containsOmxManagedNotifyPayload(previousNotify, pkgRoot);
}

export function isOmxManagedNotifyCommand(
  command: readonly string[] | null | undefined,
  pkgRoot?: string,
): boolean {
  if (!command) return false;
  if (isOmxDispatcherMetadataCommand(command)) return true;
  const entrypoint = resolveNotifyEntrypoint(command);
  if (!entrypoint) return false;
  if (!/(?:^|[\\/])notify-(?:hook|dispatcher)\.js$/.test(entrypoint)) {
    return false;
  }
  const managedScripts = pkgRoot
    ? new Set([
        resolve(pkgRoot, "dist", "scripts", "notify-hook.js"),
        resolve(pkgRoot, "dist", "scripts", "notify-dispatcher.js"),
      ])
    : new Set<string>();
  if (pkgRoot && managedScripts.has(resolve(entrypoint))) return true;
  return /(?:^|[\\/])oh-my-codex(?:[\\/]|$)/.test(entrypoint);
}

export function sanitizePreviousNotifyCommand(
  command: readonly string[] | null | undefined,
  pkgRoot?: string,
): string[] | null {
  if (!command || command.length === 0) return null;
  if (isOmxManagedNotifyCommand(command, pkgRoot)) return null;
  if (isOmxManagedPreviousNotifyWrapper(command, pkgRoot)) return null;
  return [...command];
}

function getOmxTopLevelLines(
  pkgRoot: string,
  existingConfig = "",
  modelOverride?: string,
  notifyCommand: string[] | false = getDefaultNotifyCommand(pkgRoot),
): string[] {
  const rootValues = parseRootKeyValues(existingConfig);

  const lines = [
    "# oh-my-codex top-level settings (must be before any [table])",
    ...(notifyCommand === false
      ? []
      : [`notify = ${formatTomlStringArray(notifyCommand)}`]),
    'model_reasoning_effort = "medium"',
    `developer_instructions = "${escapeTomlString(OMX_DEVELOPER_INSTRUCTIONS)}"`,
  ];

  const existingModel = rootValues.get("model");
  const selectedModel =
    modelOverride ?? unwrapTomlString(existingModel) ?? DEFAULT_SETUP_MODEL;

  if (modelOverride || !existingModel) {
    lines.push(`model = "${selectedModel}"`);
  }

  return lines;
}

type SeededBehavioralDefaultsState =
  | "absent"
  | "exact-pair"
  | "exact-context-singleton"
  | "exact-auto-singleton"
  | "bounded-nonremovable"
  | "malformed-or-ambiguous";

type SourceSpan = Readonly<{ start: number; end: number }>;
type SourceLine = Readonly<{ content: string; start: number; end: number }>;

interface SeededBehavioralDefaultsAnalysis {
  state: SeededBehavioralDefaultsState;
  spans: readonly SourceSpan[];
}

function sourceLines(config: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < config.length; index += 1) {
    if (config[index] !== "\n") continue;
    lines.push({
      content: config.slice(start, index - (index > start && config[index - 1] === "\r" ? 1 : 0)),
      start,
      end: index + 1,
    });
    start = index + 1;
  }
  if (start < config.length) lines.push({ content: config.slice(start), start, end: config.length });
  return lines;
}

function analyzeOmxSeededBehavioralDefaults(config: string): SeededBehavioralDefaultsAnalysis {
  const lines = sourceLines(config);
  const firstTable = lines.findIndex((line) => TOML_TABLE_HEADER_PATTERN.test(line.content));
  const boundary = firstTable < 0 ? lines.length : firstTable;
  const starts = lines.map((line, index) => ({ line, index }))
    .filter(({ line }) => line.content === OMX_SEEDED_BEHAVIORAL_DEFAULTS_START_MARKER);
  const ends = lines.map((line, index) => ({ line, index }))
    .filter(({ line }) => line.content === OMX_SEEDED_BEHAVIORAL_DEFAULTS_END_MARKER);
  if (starts.length === 0 && ends.length === 0) return { state: "absent", spans: [] };
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) {
    return { state: "malformed-or-ambiguous", spans: [] };
  }

  const rootText = lines.slice(0, boundary).map((line) => line.content).join("\n");
  let entryStart = 0;
  const rootEntries = splitRootLevelEntries(rootText).entries.map((entry) => {
    const indexed = { entry, start: entryStart, end: entryStart + entry.lines.length };
    entryStart = indexed.end;
    return indexed;
  });
  const isStandaloneRootMarker = (index: number): boolean =>
    index < boundary && rootEntries.some(({ entry, start, end }) =>
      !entry.key && start === index && end === index + 1,
    );

  const start = starts[0];
  const end = ends[0];
  if (!isStandaloneRootMarker(start.index) || !isStandaloneRootMarker(end.index)) {
    return { state: "malformed-or-ambiguous", spans: [] };
  }

  const block = lines.slice(start.index, end.index + 1);
  const exact = (body: readonly string[]): boolean =>
    block.length === body.length + 2 &&
    block[0].content === OMX_SEEDED_BEHAVIORAL_DEFAULTS_START_MARKER &&
    block.at(-1)?.content === OMX_SEEDED_BEHAVIORAL_DEFAULTS_END_MARKER &&
    body.every((line, index) => block[index + 1].content === line);
  const blockSpan = [{ start: start.line.start, end: end.line.end }];
  const markerSpans = [
    { start: start.line.start, end: start.line.end },
    { start: end.line.start, end: end.line.end },
  ];
  if (exact([
    `model_context_window = ${LEGACY_SEEDED_MODEL_CONTEXT_WINDOW}`,
    `model_auto_compact_token_limit = ${LEGACY_SEEDED_MODEL_AUTO_COMPACT_TOKEN_LIMIT}`,
  ])) {
    const hasOutsideDuplicate = rootEntries.some(({ entry, start: entryStart, end: entryEnd }) =>
      (entryEnd <= start.index || entryStart > end.index) &&
      (entry.key === "model_context_window" || entry.key === "model_auto_compact_token_limit"),
    );
    return hasOutsideDuplicate
      ? { state: "malformed-or-ambiguous", spans: [] }
      : { state: "exact-pair", spans: blockSpan };
  }
  type SingletonState =
    | "exact"
    | "bounded-nonremovable"
    | "malformed-or-ambiguous";

  const singletonState = (singletonKey: string, siblingKey: string): SingletonState => {
    let singletonDuplicates = 0;
    let siblingCount = 0;
    let invalidSibling = false;
    for (const { entry, start: entryStart, end: entryEnd } of rootEntries) {
      const outside = entryEnd <= start.index || entryStart > end.index;
      if (outside && entry.key === singletonKey) singletonDuplicates += 1;
      if (outside && entry.key === siblingKey) {
        siblingCount += 1;
        invalidSibling ||= !parseStandaloneToml(entry.lines.join("\n"));
      }
    }
    if (singletonDuplicates > 0 || siblingCount > 1 || invalidSibling) return "malformed-or-ambiguous";
    return siblingCount === 1 ? "exact" : "bounded-nonremovable";
  };
  if (exact([`model_context_window = ${LEGACY_SEEDED_MODEL_CONTEXT_WINDOW}`])) {
    const state = singletonState("model_context_window", "model_auto_compact_token_limit");
    return state === "exact"
      ? { state: "exact-context-singleton", spans: blockSpan }
      : state === "bounded-nonremovable"
        ? { state, spans: markerSpans }
        : { state, spans: [] };
  }
  if (exact([`model_auto_compact_token_limit = ${LEGACY_SEEDED_MODEL_AUTO_COMPACT_TOKEN_LIMIT}`])) {
    const state = singletonState("model_auto_compact_token_limit", "model_context_window");
    return state === "exact"
      ? { state: "exact-auto-singleton", spans: blockSpan }
      : state === "bounded-nonremovable"
        ? { state, spans: markerSpans }
        : { state, spans: [] };
  }
  return { state: "bounded-nonremovable", spans: markerSpans };
}

export function hasExactOmxSeededBehavioralDefaultsPair(config: string): boolean {
  return analyzeOmxSeededBehavioralDefaults(config).state === "exact-pair";
}

export function stripOmxSeededBehavioralDefaults(config: string): string {
  return [...analyzeOmxSeededBehavioralDefaults(config).spans]
    .sort((left, right) => right.start - left.start)
    .reduce((result, span) => result.slice(0, span.start) + result.slice(span.end), config);
}

function stripRootLevelKeys(config: string, keys: readonly string[]): string {
  const { entries, remainder } = splitRootLevelEntries(config);

  const filteredEntries = entries.filter((entry) => {
    if (
      keys.some((key) =>
        OMX_TOP_LEVEL_KEYS.includes(key as (typeof OMX_TOP_LEVEL_KEYS)[number]),
      ) &&
      entry.lines.length === 1 &&
      entry.lines[0].trim() ===
        "# oh-my-codex top-level settings (must be before any [table])"
    ) {
      return false;
    }

    return !entry.key || !keys.includes(entry.key);
  });

  const result = [
    ...filteredEntries.flatMap((entry) => entry.lines),
    ...remainder,
  ];

  if (result.length === 0) {
    return "";
  }

  return result.join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripOrphanedManagedNotify(config: string, pkgRoot: string): string {
  const rootNotify = getRootTomlArray(config, "notify");
  if (
    rootNotify &&
    !isOmxManagedNotifyCommand(rootNotify, pkgRoot)
  ) {
    return config;
  }
  const managedHookPath = escapeRegExp(resolve(pkgRoot, "dist", "scripts", "notify-hook.js"));
  return config
    .replace(
      new RegExp(`^\\s*notify\\s*=\\s*\\["node",\\s*"${managedHookPath}"\\]\\s*$(\\n)?`, "gm"),
      "",
    )
    .replace(
      /^\s*notify\s*=\s*\["node",\s*".*notify-hook\.js"\]\s*$(\n)?/gm,
      "",
    )
    .replace(
      /\n?\s*"node",\s*\n\s*".*notify-hook\.js",\s*\n\s*\]\s*(?=\n|$)/g,
      "",
    );
}

/**
 * Remove any existing OMX-owned top-level keys so we can re-insert them
 * cleanly. Also removes the comment line that precedes them.
 */
export function stripOmxTopLevelKeys(config: string): string {
  return stripRootLevelKeys(config, OMX_TOP_LEVEL_KEYS);
}

// ---------------------------------------------------------------------------
// [features] upsert
// ---------------------------------------------------------------------------

function isFeatureFlagLine(line: string, featureFlag: string): boolean {
  return new RegExp(`^\\s*${featureFlag}\\s*=`).test(line);
}

function isAnyCodexHookFeatureFlagLine(line: string): boolean {
  return CODEX_HOOK_FEATURE_FLAGS.some((flag) => isFeatureFlagLine(line, flag));
}

function isAnyPluginModeHookFeatureFlagLine(line: string): boolean {
  return isAnyCodexHookFeatureFlagLine(line)
    || isFeatureFlagLine(line, CODEX_PLUGIN_SCOPED_HOOKS_FEATURE_FLAG);
}

function upsertFeatureFlagLineInSection(
  lines: string[],
  featuresStart: number,
  sectionEnd: number,
  featureFlag: string,
  aliases: (line: string) => boolean,
): { sectionEnd: number; featureFlagIndex: number } {
  let featureFlagIdx = -1;
  let fallbackAliasIdx = -1;

  for (let i = featuresStart + 1; i < sectionEnd; i++) {
    if (isFeatureFlagLine(lines[i], featureFlag)) {
      featureFlagIdx = i;
    } else if (aliases(lines[i]) && fallbackAliasIdx < 0) {
      fallbackAliasIdx = i;
    }
  }

  if (featureFlagIdx < 0 && fallbackAliasIdx >= 0) {
    featureFlagIdx = fallbackAliasIdx;
  }

  if (featureFlagIdx >= 0) {
    lines[featureFlagIdx] = `${featureFlag} = true`;
  } else {
    lines.splice(sectionEnd, 0, `${featureFlag} = true`);
    featureFlagIdx = sectionEnd;
    sectionEnd += 1;
  }

  for (let i = sectionEnd - 1; i > featuresStart; i--) {
    if (i !== featureFlagIdx && aliases(lines[i])) {
      lines.splice(i, 1);
      sectionEnd -= 1;
      if (featureFlagIdx > i) featureFlagIdx -= 1;
    }
  }

  return { sectionEnd, featureFlagIndex: featureFlagIdx };
}

function upsertCodexHookFeatureFlagInSection(
  lines: string[],
  featuresStart: number,
  sectionEnd: number,
  codexHookFeatureFlag: CodexHookFeatureFlag,
): { sectionEnd: number; featureFlagIndex: number } {
  const featureFlag = normalizeCodexHookFeatureFlag(codexHookFeatureFlag);
  return upsertFeatureFlagLineInSection(
    lines,
    featuresStart,
    sectionEnd,
    featureFlag,
    isAnyCodexHookFeatureFlagLine,
  );
}

function upsertPluginScopedHookFeatureFlagInSection(
  lines: string[],
  featuresStart: number,
  sectionEnd: number,
): { sectionEnd: number; featureFlagIndex: number } {
  return upsertFeatureFlagLineInSection(
    lines,
    featuresStart,
    sectionEnd,
    CODEX_PLUGIN_SCOPED_HOOKS_FEATURE_FLAG,
    isAnyPluginModeHookFeatureFlagLine,
  );
}

function upsertFeatureFlags(
  config: string,
  codexHookFeatureFlag: CodexHookFeatureFlag = DEFAULT_CODEX_HOOK_FEATURE_FLAG,
): string {
  const lines = config.split(/\r?\n/);
  const featuresStart = lines.findIndex((line) =>
    /^\s*\[features\]\s*$/.test(line),
  );
  const hookFeatureFlagLine = formatCodexHookFeatureFlagLine(
    codexHookFeatureFlag,
  );

  if (featuresStart < 0) {
    const base = config.trimEnd();
    const featureBlock = [
      "[features]",
      "child_agents_md = true",
      hookFeatureFlagLine,
      "goals = true",
      "",
    ].join("\n");
    if (base.length === 0) {
      return featureBlock;
    }
    return `${base}\n${featureBlock}`;
  }

  let sectionEnd = lines.length;
  for (let i = featuresStart + 1; i < lines.length; i++) {
    if (/^\s*\[\[?[^\]]+\]?\]\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  // Remove deprecated collab and unreleased singular goal flags.
  for (let i = sectionEnd - 1; i > featuresStart; i--) {
    if (/^\s*(?:collab|goal)\s*=/.test(lines[i])) {
      lines.splice(i, 1);
      sectionEnd -= 1;
    }
  }

  let childAgentsIdx = -1;
  for (let i = featuresStart + 1; i < sectionEnd; i++) {
    if (/^\s*child_agents_md\s*=/.test(lines[i])) {
      childAgentsIdx = i;
    }
  }

  if (childAgentsIdx >= 0) {
    lines[childAgentsIdx] = "child_agents_md = true";
  } else {
    lines.splice(sectionEnd, 0, "child_agents_md = true");
    sectionEnd += 1;
  }

  ({ sectionEnd } = upsertCodexHookFeatureFlagInSection(
    lines,
    featuresStart,
    sectionEnd,
    codexHookFeatureFlag,
  ));

  let goalsIdx = -1;
  for (let i = featuresStart + 1; i < sectionEnd; i++) {
    if (/^\s*goals\s*=/.test(lines[i])) {
      goalsIdx = i;
    }
  }
  if (goalsIdx >= 0) {
    lines[goalsIdx] = "goals = true";
  } else {
    lines.splice(sectionEnd, 0, "goals = true");
  }

  return lines.join("\n");
}

const OMX_HOOK_TRUST_START_MARKER = "# OMX-owned Codex hook trust state";
const OMX_HOOK_TRUST_END_MARKER = "# End OMX-owned Codex hook trust state";
const OMX_PROJECT_TRUST_START_MARKER =
  "# OMX-synced Codex project trust state (from runtime CODEX_HOME)";
const OMX_PROJECT_TRUST_END_MARKER =
  "# End OMX-synced Codex project trust state";

function extractMarkerBlockContent(
  config: string,
  startMarker: string,
  endMarker: string,
): string | undefined {
  const lines = config.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== startMarker) continue;

    const nextEndIdx = lines.findIndex(
      (line, index) => index > i && line.trim() === endMarker,
    );
    const nextStartIdx = lines.findIndex(
      (line, index) => index > i && line.trim() === startMarker,
    );
    if (nextEndIdx === -1 || (nextStartIdx !== -1 && nextStartIdx < nextEndIdx)) {
      return undefined;
    }

    return lines.slice(i + 1, nextEndIdx).join("\n").trim();
  }
  return undefined;
}

function stripMarkerBlock(
  config: string,
  startMarker: string,
  endMarker: string,
): string {
  const lines = config.split(/\r?\n/);
  const kept: string[] = [];

  for (let i = 0; i < lines.length;) {
    if (lines[i].trim() !== startMarker) {
      kept.push(lines[i]);
      i += 1;
      continue;
    }

    const nextEndIdx = lines.findIndex(
      (line, index) => index > i && line.trim() === endMarker,
    );
    const nextStartIdx = lines.findIndex(
      (line, index) => index > i && line.trim() === startMarker,
    );
    if (nextEndIdx === -1 || (nextStartIdx !== -1 && nextStartIdx < nextEndIdx)) {
      kept.push(lines[i]);
      i += 1;
      continue;
    }
    i = nextEndIdx + 1;
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function isPlainTomlRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function safeParseToml(content: string): Record<string, unknown> | undefined {
  try {
    const parsed = TOML.parse(content);
    return isPlainTomlRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function collectProjectHookTrustStateKeys(config: string): Set<string> {
  const keys = new Set<string>();
  const parsed = safeParseToml(config);
  const hooksTable = isPlainTomlRecord(parsed) ? parsed.hooks : undefined;
  const hooksState = isPlainTomlRecord(hooksTable) ? hooksTable.state : undefined;
  if (!isPlainTomlRecord(hooksState)) return keys;
  for (const [key, entry] of Object.entries(hooksState)) {
    if (!isPlainTomlRecord(entry)) continue;
    keys.add(key);
  }
  return keys;
}

/**
 * Repairs project configs from the 0.18.3 relaunch regression where a
 * project-synced trust block could duplicate setup-owned hook trust tables and
 * make the next runtime CODEX_HOME config.toml invalid before Codex started.
 */
export function repairProjectScopeTrustStateForLaunch(
  projectConfig: string,
  projectHooksPath: string,
): string {
  const syncedTrustBlock = extractMarkerBlockContent(
    projectConfig,
    OMX_PROJECT_TRUST_START_MARKER,
    OMX_PROJECT_TRUST_END_MARKER,
  );
  if (!syncedTrustBlock) return projectConfig;

  const stripped = stripMarkerBlock(
    projectConfig,
    OMX_PROJECT_TRUST_START_MARKER,
    OMX_PROJECT_TRUST_END_MARKER,
  );
  const repaired = syncProjectScopeTrustStateFromRuntime(
    stripped,
    syncedTrustBlock,
    projectHooksPath,
  );
  return repaired === stripped ? projectConfig : repaired;
}

/**
 * Project-scope launches mirror the durable project config.toml into an
 * ephemeral runtime CODEX_HOME. Codex writes its workspace-trust ledger and
 * hook trust ledger into the runtime config.toml during the session. Without
 * persistence, those entries die with the runtime, so Codex prompts to trust
 * the workspace and hooks on every launch (issue #2470).
 *
 * This function extracts only trust-state tables (`[projects."<cwd>"]` and
 * `[hooks.state."<projectHooksPath>:..."]`) from the runtime config.toml and
 * upserts them into the durable project config.toml inside a marker-fenced
 * block, preserving any surrounding user-managed content and comments and
 * ignoring Codex's NUX counters or other ephemeral runtime-only writes.
 */
export function syncProjectScopeTrustStateFromRuntime(
  projectConfig: string,
  runtimeConfig: string,
  projectHooksPath: string,
): string {
  const parsed = safeParseToml(runtimeConfig);
  if (!parsed) return projectConfig;

  const stripped = stripMarkerBlock(
    projectConfig,
    OMX_PROJECT_TRUST_START_MARKER,
    OMX_PROJECT_TRUST_END_MARKER,
  );
  const existingHookTrustStateKeys = collectProjectHookTrustStateKeys(stripped);
  const trustBlockLines: string[] = [];

  const projectsTable = parsed.projects;
  if (isPlainTomlRecord(projectsTable)) {
    for (const [projectKey, entry] of Object.entries(projectsTable).sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      if (!isPlainTomlRecord(entry)) continue;
      const serialized = TOML.stringify({ [projectKey]: entry } as TOML.JsonMap);
      const renderedHeader = `[projects."${escapeTomlBasicString(projectKey)}"]`;
      const body = serialized
        .split(/\r?\n/)
        .filter((line) => !/^\s*\[/.test(line) && line.trim() !== "")
        .join("\n");
      if (body.length === 0) continue;
      trustBlockLines.push(renderedHeader, body, "");
    }
  }

  const hooksTable = parsed.hooks;
  const hooksState = isPlainTomlRecord(hooksTable) ? hooksTable.state : undefined;
  if (isPlainTomlRecord(hooksState)) {
    for (const [stateKey, entry] of Object.entries(hooksState).sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      if (!isPlainTomlRecord(entry)) continue;
      if (!stateKey.startsWith(`${projectHooksPath}:`)) continue;
      if (existingHookTrustStateKeys.has(stateKey)) continue;
      const trusted = entry.trusted_hash;
      if (typeof trusted !== "string" || trusted.length === 0) continue;
      trustBlockLines.push(
        `[hooks.state."${escapeTomlBasicString(stateKey)}"]`,
        `trusted_hash = "${escapeTomlBasicString(trusted)}"`,
        "",
      );
    }
  }

  if (trustBlockLines.length === 0) {
    return stripped.length === 0 ? "" : `${stripped}\n`;
  }

  const block = [
    OMX_PROJECT_TRUST_START_MARKER,
    ...trustBlockLines,
    OMX_PROJECT_TRUST_END_MARKER,
    "",
  ].join("\n");

  if (stripped.length === 0) return block;
  return `${stripped}\n\n${block}`;
}

type ManagedCodexHookTrustStateMap = Record<string, ManagedCodexHookTrustState>;

interface HookTrustStateStripResult {
  config: string;
  preservedConflictKeys: Set<string>;
}

type ManagedHookTrustStateExpectations = ReadonlyMap<string, ReadonlySet<string>>;

type TomlSourceStringMode =
  | "basic"
  | "literal"
  | "multiline-basic"
  | "multiline-literal";

interface TomlSourceLexicalAnalysis {
  lines: string[];
  lineStartsOutsideMultiline: boolean[];
  lineHasTomlComment: boolean[];
  isUnambiguous: boolean;
}

function isMultilineTomlString(mode: TomlSourceStringMode | undefined): boolean {
  return mode === "multiline-basic" || mode === "multiline-literal";
}

/**
 * Tracks only lexical boundaries needed to safely associate source lines with
 * TOML statements. TOML's parser gives us semantics; this prevents source
 * repair from treating table-like text in a multiline value as syntax.
 */
function analyzeTomlSource(config: string): TomlSourceLexicalAnalysis {
  const lines = config.split(/\r?\n/);
  const lineStartsOutsideMultiline: boolean[] = [];
  const lineHasTomlComment: boolean[] = [];
  let mode: TomlSourceStringMode | undefined;
  let isUnambiguous = true;

  for (const line of lines) {
    lineStartsOutsideMultiline.push(!isMultilineTomlString(mode));
    let hasComment = false;

    for (let index = 0; index < line.length; index += 1) {
      const character = line[index]!;
      if (mode === "basic") {
        if (character === "\\") {
          index += 1;
        } else if (character === "\"") {
          mode = undefined;
        }
        continue;
      }
      if (mode === "literal") {
        if (character === "'") mode = undefined;
        continue;
      }
      if (mode === "multiline-basic" || mode === "multiline-literal") {
        const delimiter = mode === "multiline-basic" ? "\"" : "'";
        if (mode === "multiline-basic" && character === "\\") {
          index += 1;
          continue;
        }
        if (character !== delimiter) continue;

        let runEnd = index + 1;
        while (line[runEnd] === delimiter) runEnd += 1;
        if (runEnd - index >= 3) {
          // TOML permits one or two delimiter characters immediately before
          // the closing triple delimiter as string content.
          mode = undefined;
          index = runEnd - 1;
        }
        continue;
      }

      if (character === "#") {
        hasComment = true;
        break;
      }
      if (character !== "\"" && character !== "'") continue;

      const isMultiline =
        line[index + 1] === character && line[index + 2] === character;
      if (isMultiline) {
        mode = character === "\"" ? "multiline-basic" : "multiline-literal";
        index += 2;
      } else {
        mode = character === "\"" ? "basic" : "literal";
      }
    }

    lineHasTomlComment.push(hasComment);
    if (mode === "basic" || mode === "literal") isUnambiguous = false;
  }

  if (isMultilineTomlString(mode)) isUnambiguous = false;
  return { lines, lineStartsOutsideMultiline, lineHasTomlComment, isUnambiguous };
}

interface TomlSourceKeySegment {
  key?: string;
  end: number;
  incomplete: boolean;
}

function skipTomlSourceWhitespace(line: string, index: number): number {
  let cursor = index;
  while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
  return cursor;
}

function parseTomlSourceKeySegment(
  line: string,
  index: number,
): TomlSourceKeySegment | undefined {
  const start = skipTomlSourceWhitespace(line, index);
  const first = line[start];
  if (!first) return undefined;
  if (first !== '"' && first !== "'") {
    const match = /^[A-Za-z0-9_-]+/.exec(line.slice(start));
    if (!match) return undefined;
    return { key: match[0], end: start + match[0].length, incomplete: false };
  }

  let cursor = start + 1;
  let escaped = false;
  for (; cursor < line.length; cursor += 1) {
    const character = line[cursor]!;
    if (first === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (first === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (character !== first) continue;
    const token = line.slice(start, cursor + 1);
    const parsed = safeParseToml(`${token} = true`);
    const keys = parsed ? Object.keys(parsed) : [];
    const hasKey = keys.length === 1;
    return {
      ...(hasKey ? { key: keys[0] } : {}),
      end: cursor + 1,
      incomplete: !hasKey,
    };
  }
  return { end: line.length, incomplete: true };
}

function isTomlSourceKey(segment: TomlSourceKeySegment, key: string): boolean {
  return segment.key === key;
}

function findTomlSourceAssignmentSeparator(line: string): number | undefined {
  let segment = parseTomlSourceKeySegment(line, 0);
  if (!segment || segment.incomplete) return undefined;
  let cursor = skipTomlSourceWhitespace(line, segment.end);
  while (line[cursor] === ".") {
    segment = parseTomlSourceKeySegment(line, cursor + 1);
    if (!segment || segment.incomplete) return undefined;
    cursor = skipTomlSourceWhitespace(line, segment.end);
  }
  return line[cursor] === "=" ? cursor : undefined;
}

function advancePastInlineTomlValue(line: string, index: number): number {
  let braces = 0;
  let brackets = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let cursor = index; cursor < line.length; cursor += 1) {
    const character = line[cursor]!;
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") return line.length;
    if (character === "{") {
      braces += 1;
      continue;
    }
    if (character === "}") {
      if (braces === 0 && brackets === 0) return cursor;
      braces = Math.max(0, braces - 1);
      continue;
    }
    if (character === "[") {
      brackets += 1;
      continue;
    }
    if (character === "]") {
      brackets = Math.max(0, brackets - 1);
      continue;
    }
    if (character === "," && braces === 0 && brackets === 0) return cursor + 1;
  }
  return line.length;
}

function inlineTomlTableMaySpellStateKey(line: string, index: number): boolean {
  let cursor = index;
  while (cursor < line.length) {
    cursor = skipTomlSourceWhitespace(line, cursor);
    // A comment cannot close the surrounding inline table.
    if (line[cursor] === "#") return true;
    if (line[cursor] === "}") return false;
    const segment = parseTomlSourceKeySegment(line, cursor);
    if (!segment) return true;
    if (segment.incomplete || isTomlSourceKey(segment, "state")) return true;
    cursor = skipTomlSourceWhitespace(line, segment.end);
    if (line[cursor] !== "=") return true;
    cursor = advancePastInlineTomlValue(line, cursor + 1);
    if (line[cursor] === "}") return false;
  }
  // The unclosed inline table can acquire a state member on a following
  // unparsed line, so it is not safe to strip the containing marker block.
  return true;
}

function lineMaySpellHooksState(line: string): boolean {
  let cursor = skipTomlSourceWhitespace(line, 0);
  if (line[cursor] === "[") {
    if (line[cursor + 1] === "[") {
      cursor = skipTomlSourceWhitespace(line, cursor + 2);
    } else {
      cursor = skipTomlSourceWhitespace(line, cursor + 1);
    }
  }
  const hooks = parseTomlSourceKeySegment(line, cursor);
  if (!hooks || !isTomlSourceKey(hooks, "hooks")) return false;
  cursor = skipTomlSourceWhitespace(line, hooks.end);
  if (line[cursor] === ".") {
    const state = parseTomlSourceKeySegment(line, cursor + 1);
    // A dangling dot can be completed by a following unparsed state key.
    return state === undefined || state.incomplete || isTomlSourceKey(state, "state");
  }
  if (line[cursor] !== "=") return false;
  cursor = skipTomlSourceWhitespace(line, cursor + 1);
  // A bare assignment or comment cannot prove that a following unparsed line
  // does not continue an inline hooks table with a state member.
  if (cursor >= line.length || line[cursor] === "#") return true;
  return line[cursor] === "{" && inlineTomlTableMaySpellStateKey(line, cursor + 1);
}

interface TomlSourceArrayTableOpener {
  firstKey: TomlSourceKeySegment | undefined;
  openerOnly: boolean;
}

/**
 * Detects a potential array-table opener without accepting malformed spacing
 * or extra opening brackets as TOML syntax. Array tables rooted at `hooks`
 * have no proof-owned representation, so their first key segment is enough
 * to retain a managed marker block rather than strip it.
 */
function parseTomlSourceArrayTableOpener(
  line: string,
): TomlSourceArrayTableOpener | undefined {
  let cursor = skipTomlSourceWhitespace(line, 0);
  if (line[cursor] !== "[") return undefined;

  const hasExactAdjacentOpener = line[cursor + 1] === "[";
  if (hasExactAdjacentOpener) {
    cursor += 2;
  } else {
    cursor = skipTomlSourceWhitespace(line, cursor + 1);
    if (line[cursor] !== "[") return undefined;
    cursor += 1;
  }

  cursor = skipTomlSourceWhitespace(line, cursor);
  while (line[cursor] === "[") {
    cursor = skipTomlSourceWhitespace(line, cursor + 1);
  }

  const firstKey = parseTomlSourceKeySegment(line, cursor);
  return {
    firstKey,
    openerOnly:
      firstKey === undefined &&
      (cursor >= line.length || line[cursor] === "#"),
  };
}

function hasIncompleteTomlSourceHooksKeyPrefix(line: string): boolean {
  let cursor = skipTomlSourceWhitespace(line, 0);
  let tableHeader = false;
  let arrayTableHeader = false;
  if (line[cursor] === "[") {
    tableHeader = true;
    if (line[cursor + 1] === "[") {
      arrayTableHeader = true;
      cursor = skipTomlSourceWhitespace(line, cursor + 2);
    } else {
      cursor = skipTomlSourceWhitespace(line, cursor + 1);
    }
  }
  const hooks = parseTomlSourceKeySegment(line, cursor);
  if (!hooks || !isTomlSourceKey(hooks, "hooks")) return false;
  cursor = skipTomlSourceWhitespace(line, hooks.end);
  if (!tableHeader) return cursor >= line.length || line[cursor] === "#";
  if (line[cursor] !== "]" || (arrayTableHeader && line[cursor + 1] !== "]")) {
    return true;
  }
  const suffix = line.slice(cursor + (arrayTableHeader ? 2 : 1)).trimStart();
  return suffix.length > 0 && !suffix.startsWith("#");
}

function isTomlSourceHooksKeyContinuationSeparator(line: string): boolean {
  const cursor = skipTomlSourceWhitespace(line, 0);
  return line[cursor] === "." || line[cursor] === "=" || line[cursor] === "[";
}

function isTomlSourceBlankOrComment(line: string): boolean {
  return /^\s*(?:#.*)?$/.test(line);
}

function isTomlSourceStandaloneOpeningBracket(line: string): boolean {
  const cursor = skipTomlSourceWhitespace(line, 0);
  if (line[cursor] !== "[") return false;
  const next = skipTomlSourceWhitespace(line, cursor + 1);
  return next >= line.length || line[next] === "#";
}

function firstTomlSourceKeyFollowingOpeningBrackets(
  line: string,
): TomlSourceKeySegment | undefined {
  let cursor = skipTomlSourceWhitespace(line, 0);
  while (line[cursor] === "[") {
    cursor = skipTomlSourceWhitespace(line, cursor + 1);
  }
  return parseTomlSourceKeySegment(line, cursor);
}

function lineMaySpellStateKey(line: string): boolean {
  const state = parseTomlSourceKeySegment(line, 0);
  return state !== undefined && (state.incomplete || isTomlSourceKey(state, "state"));
}

function isTomlSourceHooksTableHeader(
  parsed: Record<string, unknown> | undefined,
): boolean {
  const hooks = parsed?.hooks;
  return parsed !== undefined &&
    Object.keys(parsed).length === 1 &&
    isPlainTomlRecord(hooks) &&
    Object.keys(hooks).length === 0;
}

function hasUnprovenManagedMarkerHooksStateSyntax(
  source: TomlSourceLexicalAnalysis,
  managedMarkerRanges: readonly SourceSpan[],
  parsedStatementSpans: readonly SourceSpan[],
  parsedAssignmentSpans: readonly SourceSpan[],
): boolean {
  const parsedLines = new Set<number>();
  const parsedStatementStartLines = new Set<number>();
  for (const span of parsedStatementSpans) {
    parsedStatementStartLines.add(span.start);
    for (let index = span.start; index < span.end; index += 1) parsedLines.add(index);
  }
  const parsedAssignmentLines = new Set<number>();
  for (const span of parsedAssignmentSpans) {
    for (let index = span.start; index < span.end; index += 1) {
      parsedAssignmentLines.add(index);
    }
  }
  const managedContentLines = new Set<number>();
  for (const range of managedMarkerRanges) {
    for (let index = range.start + 1; index < range.end; index += 1) {
      managedContentLines.add(index);
    }
  }

  let insideHooksTable = false;
  let hasIncompleteHooksKeyPrefix = false;
  let hasIncompleteHooksArrayTableOpener = false;
  for (let index = 0; index < source.lines.length; index += 1) {
    if (!source.lineStartsOutsideMultiline[index]) {
      hasIncompleteHooksKeyPrefix = false;
      hasIncompleteHooksArrayTableOpener = false;
      continue;
    }
    const line = source.lines[index] ?? "";
    const isParsedAssignmentLine = parsedAssignmentLines.has(index);
    if (!isParsedAssignmentLine) {
      const header = parseTomlSourceTableHeader(line);
      if (header?.parsed) {
        insideHooksTable = isTomlSourceHooksTableHeader(header.parsed);
      }
    }
    if (!managedContentLines.has(index)) {
      hasIncompleteHooksKeyPrefix = false;
      hasIncompleteHooksArrayTableOpener = false;
      continue;
    }
    const isParsedStatementLine = parsedLines.has(index);
    const isParsedStatementStartLine = parsedStatementStartLines.has(index);
    if (hasIncompleteHooksKeyPrefix) {
      if (isTomlSourceBlankOrComment(line)) continue;
      if (isTomlSourceHooksKeyContinuationSeparator(line)) return true;
      hasIncompleteHooksKeyPrefix = false;
    }
    // Parsed statements can contain nested arrays whose standalone brackets and
    // quoted "hooks" values must not contribute to malformed-header tracking.
    if (hasIncompleteHooksArrayTableOpener && !isParsedStatementLine) {
      if (isTomlSourceBlankOrComment(line)) continue;
      const firstKey = firstTomlSourceKeyFollowingOpeningBrackets(line);
      if (firstKey) {
        if (isTomlSourceKey(firstKey, "hooks")) return true;
        hasIncompleteHooksArrayTableOpener = false;
      }
    }
    const arrayTableOpener = !isParsedStatementLine || isParsedStatementStartLine
      ? parseTomlSourceArrayTableOpener(line)
      : undefined;
    if (arrayTableOpener?.firstKey && isTomlSourceKey(arrayTableOpener.firstKey, "hooks")) {
      return true;
    }
    if (arrayTableOpener?.openerOnly && !isParsedStatementLine) {
      hasIncompleteHooksArrayTableOpener = true;
    }
    if (!isParsedStatementLine && isTomlSourceStandaloneOpeningBracket(line)) {
      hasIncompleteHooksArrayTableOpener = true;
    }
    if (isParsedStatementLine) continue;
    if (lineMaySpellHooksState(line) || (insideHooksTable && lineMaySpellStateKey(line))) {
      return true;
    }
    const hasIncompleteHooksPrefix = hasIncompleteTomlSourceHooksKeyPrefix(line);
    if (hasIncompleteHooksPrefix && /^\s*\[\[?/.test(line)) return true;
    hasIncompleteHooksKeyPrefix = hasIncompleteHooksPrefix;
  }
  return false;
}

interface TomlSourceTableHeader {
  parsed: Record<string, unknown> | undefined;
}

interface TomlSourceTableScope {
  parsed: Record<string, unknown> | undefined;
  hasComment: boolean;
}

interface ManagedHookTrustStateSourceRepresentation {
  start: number;
  end: number;
  stateEntryCount: number;
  value: unknown;
  hasComment: boolean;
  hasExactSemanticScope: boolean;
  insideManagedMarkerBlock: boolean;
}

function managedHookTrustStateExpectations(
  ...states: Array<ManagedCodexHookTrustStateMap | undefined>
): ManagedHookTrustStateExpectations {
  const expectations = new Map<string, Set<string>>();
  for (const state of states) {
    if (!state) continue;
    for (const [key, entry] of Object.entries(state)) {
      const hashes = expectations.get(key) ?? new Set<string>();
      hashes.add(entry.trusted_hash);
      expectations.set(key, hashes);
    }
  }
  return expectations;
}

function managedHookTrustCoordinateFamily(key: string): string | undefined {
  const match = /^(.*):([a-z_]+):\d+:\d+$/.exec(key);
  return match ? `${match[1]}:${match[2]}` : undefined;
}

function expectedManagedHookTrustHashes(
  expectations: ManagedHookTrustStateExpectations,
  key: string,
  allowCoordinateDrift: boolean,
): ReadonlySet<string> | undefined {
  const exact = expectations.get(key);
  if (exact || !allowCoordinateDrift) return exact;
  const family = managedHookTrustCoordinateFamily(key);
  if (!family) return undefined;
  const hashes = new Set<string>();
  for (const [expectedKey, expectedHashes] of expectations) {
    if (managedHookTrustCoordinateFamily(expectedKey) !== family) continue;
    for (const hash of expectedHashes) hashes.add(hash);
  }
  return hashes.size > 0 ? hashes : undefined;
}

function tomlHooksStateValue(
  parsed: Record<string, unknown> | undefined,
): unknown {
  if (!parsed) return undefined;
  const hooks = parsed.hooks;
  if (!isPlainTomlRecord(hooks) || !Object.hasOwn(hooks, "state")) {
    return undefined;
  }
  return hooks.state;
}

function tomlHooksStateEntries(
  parsed: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const state = tomlHooksStateValue(parsed);
  return isPlainTomlRecord(state) ? state : undefined;
}

function hasOnlyManagedHookTrustStateField(
  parsed: Record<string, unknown> | undefined,
  key: string,
): boolean {
  if (!parsed || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, "hooks")) {
    return false;
  }
  const hooks = parsed.hooks;
  if (!isPlainTomlRecord(hooks) || Object.keys(hooks).length !== 1 || !Object.hasOwn(hooks, "state")) {
    return false;
  }
  const state = hooks.state;
  return isPlainTomlRecord(state) &&
    Object.keys(state).length === 1 &&
    Object.hasOwn(state, key);
}

function parseTomlSourceTableHeader(line: string): TomlSourceTableHeader | undefined {
  const start = line.search(/\S/);
  if (start === -1 || line[start] !== "[") return undefined;

  const array = line[start + 1] === "[";
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  for (let index = start + (array ? 2 : 1); index < line.length; index += 1) {
    const character = line[index]!;
    if (quote === "\"") {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (quote === "'") {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character !== "]") continue;

    const end = array ? index + 2 : index + 1;
    if (array && line[index + 1] !== "]") return undefined;
    const suffix = line.slice(end).trimStart();
    if (suffix.length > 0 && !suffix.startsWith("#")) return undefined;
    return { parsed: safeParseToml(line.slice(start, end)) };
  }
  return undefined;
}

function sourceRangeHasTomlComment(
  source: TomlSourceLexicalAnalysis,
  start: number,
  end: number,
): boolean {
  for (let index = start; index < end; index += 1) {
    if (source.lineHasTomlComment[index]) return true;
  }
  return false;
}

function collectMarkerRanges(
  source: TomlSourceLexicalAnalysis,
  startMarker: string,
  endMarker: string,
  includeUnterminatedRange = false,
  inertAssignmentSpans: readonly SourceSpan[] = [],
): SourceSpan[] {
  const isInsideInertAssignment = (line: number): boolean =>
    inertAssignmentSpans.some((span) => span.start <= line && line < span.end);
  const ranges: SourceSpan[] = [];
  for (let start = 0; start < source.lines.length; start += 1) {
    if (
      !source.lineStartsOutsideMultiline[start] ||
      isInsideInertAssignment(start) ||
      source.lines[start]?.trim() !== startMarker
    ) continue;
    const end = source.lines.findIndex(
      (line, index) =>
        index > start &&
        source.lineStartsOutsideMultiline[index] &&
        !isInsideInertAssignment(index) &&
        line.trim() === endMarker,
    );
    const nestedStart = source.lines.findIndex(
      (line, index) =>
        index > start &&
        source.lineStartsOutsideMultiline[index] &&
        !isInsideInertAssignment(index) &&
        line.trim() === startMarker,
    );
    if (end === -1 || (nestedStart !== -1 && nestedStart < end)) {
      if (includeUnterminatedRange) ranges.push({ start, end: source.lines.length });
      continue;
    }
    ranges.push({ start, end });
    start = end;
  }
  return ranges;
}

function recordManagedMarkerHooksStateSourceSpan(
  spans: SourceSpan[],
  invalidSpans: SourceSpan[],
  start: number,
  end: number,
  parsed: Record<string, unknown> | undefined,
  insideManagedMarkerBlock: boolean,
): void {
  if (!insideManagedMarkerBlock) return;
  const state = tomlHooksStateValue(parsed);
  if (state === undefined) return;
  const span = { start, end };
  spans.push(span);
  if (!isPlainTomlRecord(state) || Object.keys(state).length === 0) {
    invalidSpans.push(span);
  }
}

function addManagedHookTrustStateSourceRepresentations(
  representations: Map<string, ManagedHookTrustStateSourceRepresentation[]>,
  markerContainedHooksStateSpans: SourceSpan[],
  invalidMarkerContainedHooksStateSpans: SourceSpan[],
  source: TomlSourceLexicalAnalysis,
  start: number,
  end: number,
  parsed: Record<string, unknown> | undefined,
  insideManagedMarkerBlock: boolean,
  containingTableScope?: TomlSourceTableScope,
  fallbackKeys: readonly string[] = [],
): void {
  recordManagedMarkerHooksStateSourceSpan(
    markerContainedHooksStateSpans,
    invalidMarkerContainedHooksStateSpans,
    start,
    end,
    parsed,
    insideManagedMarkerBlock,
  );
  const state = tomlHooksStateEntries(parsed);
  const hasComment = sourceRangeHasTomlComment(source, start, end);
  if (state) {
    const stateEntryCount = Object.keys(state).length;
    for (const [key, value] of Object.entries(state)) {
      const hasExactSemanticScope = hasOnlyManagedHookTrustStateField(parsed, key) &&
        (!containingTableScope ||
          (!containingTableScope.hasComment &&
            hasOnlyManagedHookTrustStateField(containingTableScope.parsed, key)));
      const entries = representations.get(key) ?? [];
      entries.push({
        start,
        end,
        stateEntryCount,
        value,
        hasComment,
        hasExactSemanticScope,
        insideManagedMarkerBlock,
      });
      representations.set(key, entries);
    }
    return;
  }

  for (const key of fallbackKeys) {
    const entries = representations.get(key) ?? [];
    entries.push({
      start,
      end,
      stateEntryCount: 0,
      value: undefined,
      hasComment,
      hasExactSemanticScope: false,
      insideManagedMarkerBlock,
    });
    representations.set(key, entries);
  }
}

function collectManagedHookTrustStateSourceRepresentations(
  config: string,
): {
  source: TomlSourceLexicalAnalysis;
  representations: Map<string, ManagedHookTrustStateSourceRepresentation[]>;
  managedMarkerRanges: SourceSpan[];
  markerContainedHooksStateSpans: SourceSpan[];
  invalidMarkerContainedHooksStateSpans: SourceSpan[];
  parsedStatementSpans: SourceSpan[];
  parsedAssignmentSpans: SourceSpan[];
} {

  const source = analyzeTomlSource(config);
  const { lines } = source;
  const parsedAssignmentSpans: SourceSpan[] = [];
  for (let cursor = 0; cursor < lines.length; cursor += 1) {
    if (!source.lineStartsOutsideMultiline[cursor]) continue;
    const line = lines[cursor] ?? "";
    if (findTomlSourceAssignmentSeparator(line) === undefined) continue;

    for (let statementEnd = cursor + 1; statementEnd <= lines.length; statementEnd += 1) {
      if (!safeParseToml(lines.slice(cursor, statementEnd).join("\n"))) continue;
      parsedAssignmentSpans.push({ start: cursor, end: statementEnd });
      cursor = statementEnd - 1;
      break;
    }
  }
  const headers: Array<{ index: number; header: TomlSourceTableHeader }> = [];
  for (const [index, line] of lines.entries()) {
    if (!source.lineStartsOutsideMultiline[index]) continue;
    const header = parseTomlSourceTableHeader(line);
    if (parsedAssignmentSpans.some((span) => span.start < index && index < span.end)) continue;
    if (header) headers.push({ index, header });
  }

  const boundaries = new Set<number>(headers.map(({ index }) => index));
  for (const [index, line] of lines.entries()) {
    if (
      source.lineStartsOutsideMultiline[index] &&
      (line.trim() === OMX_HOOK_TRUST_END_MARKER ||
        line.trim() === OMX_CONFIG_END_MARKER)
    ) {
      boundaries.add(index);
    }
  }
  const sortedBoundaries = [...boundaries].sort((left, right) => left - right);
  const representations = new Map<string, ManagedHookTrustStateSourceRepresentation[]>();
  const markerContainedHooksStateSpans: SourceSpan[] = [];
  const invalidMarkerContainedHooksStateSpans: SourceSpan[] = [];
  const parsedStatementSpans: SourceSpan[] = [];

  const managedMarkerRanges = [
    ...collectMarkerRanges(
      source,
      OMX_HOOK_TRUST_START_MARKER,
      OMX_HOOK_TRUST_END_MARKER,
      false,
      parsedAssignmentSpans,
    ),
    ...collectMarkerRanges(
      source,
      OMX_CONFIG_START_MARKER,
      OMX_CONFIG_END_MARKER,
      true,
      parsedAssignmentSpans,
    ),
  ];
  const isInsideManagedMarkerBlock = (start: number, end: number): boolean =>
    managedMarkerRanges.some((range) => start > range.start && end <= range.end);
  const collectAssignments = (
    start: number,
    end: number,
    prefix: string | undefined,
    containingTableScope?: TomlSourceTableScope,
  ): void => {
    for (let cursor = start; cursor < end;) {
      const line = lines[cursor] ?? "";
      if (
        !source.lineStartsOutsideMultiline[cursor] ||
        line.trim().length === 0 ||
        line.trim() === OMX_HOOK_TRUST_START_MARKER ||
        line.trim() === OMX_CONFIG_START_MARKER
      ) {
        cursor += 1;
        continue;
      }

      let parsed: Record<string, unknown> | undefined;
      let statementEnd = cursor + 1;
      for (; statementEnd <= end; statementEnd += 1) {
        const statement = lines.slice(cursor, statementEnd).join("\n");
        parsed = safeParseToml(prefix ? `${prefix}\n${statement}` : statement);
        if (parsed) break;
      }
      if (!parsed) {
        cursor += 1;
        continue;
      }
      parsedStatementSpans.push({ start: cursor, end: statementEnd });
      addManagedHookTrustStateSourceRepresentations(
        representations,
        markerContainedHooksStateSpans,
        invalidMarkerContainedHooksStateSpans,
        source,
        cursor,
        statementEnd,
        parsed,
        isInsideManagedMarkerBlock(cursor, statementEnd),
        containingTableScope,
      );
      cursor = statementEnd;
    }
  };

  const rootEnd = sortedBoundaries[0] ?? lines.length;
  collectAssignments(0, rootEnd, undefined);
  for (const { index, header } of headers) {
    const boundaryIndex = sortedBoundaries.findIndex((boundary) => boundary === index);
    const end = boundaryIndex === -1
      ? lines.length
      : (sortedBoundaries[boundaryIndex + 1] ?? lines.length);
    const tableScope = {
      parsed: safeParseToml(lines.slice(index, end).join("\n")),
      hasComment: sourceRangeHasTomlComment(source, index, end),
    };
    if (tableScope.parsed) parsedStatementSpans.push({ start: index, end });
    const insideManagedMarkerBlock = isInsideManagedMarkerBlock(index, end);
    recordManagedMarkerHooksStateSourceSpan(
      markerContainedHooksStateSpans,
      invalidMarkerContainedHooksStateSpans,
      index,
      end,
      tableScope.parsed,
      insideManagedMarkerBlock,
    );
    const headerState = tomlHooksStateEntries(header.parsed);
    const directKeys = Object.keys(headerState ?? {});
    if (directKeys.length > 0) {
      addManagedHookTrustStateSourceRepresentations(
        representations,
        markerContainedHooksStateSpans,
        invalidMarkerContainedHooksStateSpans,
        source,
        index,
        end,
        tableScope.parsed,
        insideManagedMarkerBlock,
        undefined,
        directKeys,
      );
      continue;
    }
    collectAssignments(index + 1, end, lines[index], tableScope);
  }

  return {
    source,
    representations,
    managedMarkerRanges,
    markerContainedHooksStateSpans,
    invalidMarkerContainedHooksStateSpans,
    parsedStatementSpans,
    parsedAssignmentSpans,
  };
}

function isExactlyManagedHookTrustStateValue(
  value: unknown,
  expectedHashes: ReadonlySet<string>,
): boolean {
  return isPlainTomlRecord(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, "trusted_hash") &&
    typeof value.trusted_hash === "string" &&
    expectedHashes.has(value.trusted_hash);
}

function managedMarkerTrustStateConflicts(
  source: TomlSourceLexicalAnalysis,
  representations: ReadonlyMap<string, readonly ManagedHookTrustStateSourceRepresentation[]>,
  managedMarkerRanges: readonly SourceSpan[],
  markerContainedHooksStateSpans: readonly SourceSpan[],
  invalidMarkerContainedHooksStateSpans: readonly SourceSpan[],
  parsedStatementSpans: readonly SourceSpan[],
  parsedAssignmentSpans: readonly SourceSpan[],
  expectations: ManagedHookTrustStateExpectations,
): Set<string> {
  const conflicts = new Set<string>();
  const isInsideManagedMarkerRange = (span: SourceSpan): boolean =>
    managedMarkerRanges.some((range) => span.start > range.start && span.end <= range.end);
  if (invalidMarkerContainedHooksStateSpans.some(isInsideManagedMarkerRange) ||
    hasUnprovenManagedMarkerHooksStateSyntax(
      source,
      managedMarkerRanges,
      [...markerContainedHooksStateSpans, ...parsedStatementSpans],
      parsedAssignmentSpans,
    )) {
    conflicts.add("marker-contained hooks.state");
  }

  for (const [key, sourceRepresentations] of representations) {
    for (const representation of sourceRepresentations) {
      if (!isInsideManagedMarkerRange(representation)) continue;
      const expectedHashes = expectedManagedHookTrustHashes(
        expectations,
        key,
        true,
      );
      const isExactOwnedRepresentation = expectedHashes !== undefined &&
        representation.stateEntryCount === 1 &&
        !representation.hasComment &&
        representation.hasExactSemanticScope &&
        isExactlyManagedHookTrustStateValue(representation.value, expectedHashes);
      if (!source.isUnambiguous || !isExactOwnedRepresentation) conflicts.add(key);
    }
  }
  return conflicts;
}

function removeEmptyManagedHookTrustStateMarkerBlocks(
  source: TomlSourceLexicalAnalysis,
  removed: Set<number>,
): void {
  const { lines } = source;
  for (let start = 0; start < lines.length; start += 1) {
    if (
      !source.lineStartsOutsideMultiline[start] ||
      lines[start]?.trim() !== OMX_HOOK_TRUST_START_MARKER
    ) continue;
    const end = lines.findIndex(
      (line, index) =>
        index > start &&
        source.lineStartsOutsideMultiline[index] &&
        line.trim() === OMX_HOOK_TRUST_END_MARKER,
    );
    const nestedStart = lines.findIndex(
      (line, index) =>
        index > start &&
        source.lineStartsOutsideMultiline[index] &&
        line.trim() === OMX_HOOK_TRUST_START_MARKER,
    );
    if (end === -1 || (nestedStart !== -1 && nestedStart < end)) continue;

    let onlyOwnedMarkerContent = true;
    for (let index = start + 1; index < end; index += 1) {
      const trimmed = lines[index]!.trim();
      if (
        removed.has(index) ||
        trimmed.length === 0 ||
        trimmed === "# Trusts only setup-managed native hook wrappers."
      ) continue;
      onlyOwnedMarkerContent = false;
      break;
    }
    if (!onlyOwnedMarkerContent) continue;

    removed.add(start);
    removed.add(end);
    for (let index = start + 1; index < end; index += 1) {
      if (lines[index]?.trim() === "# Trusts only setup-managed native hook wrappers.") {
        removed.add(index);
      }
    }
    start = end;
  }
}

function stripProofManagedCodexHookTrustStateTables(
  config: string,
  expectations: ManagedHookTrustStateExpectations,
): HookTrustStateStripResult {
  const {
    source,
    representations,
    managedMarkerRanges,
    markerContainedHooksStateSpans,
    invalidMarkerContainedHooksStateSpans,
    parsedStatementSpans,
    parsedAssignmentSpans,
  } = collectManagedHookTrustStateSourceRepresentations(config);
  const preservedConflictKeys = managedMarkerTrustStateConflicts(
    source,
    representations,
    managedMarkerRanges,
    markerContainedHooksStateSpans,
    invalidMarkerContainedHooksStateSpans,
    parsedStatementSpans,
    parsedAssignmentSpans,
    expectations,
  );
  if (!source.isUnambiguous) {
    return { config, preservedConflictKeys };
  }
  const { lines } = source;
  const removals = new Map<string, SourceSpan>();
  const parsedConfigState = tomlHooksStateEntries(safeParseToml(config));

  for (const key of Object.keys(parsedConfigState ?? {})) {
    if (expectations.has(key) && !representations.has(key)) {
      preservedConflictKeys.add(key);
    }
  }

  for (const [key, sourceRepresentations] of representations) {
    const isExactOwnedRepresentation = (
      representation: ManagedHookTrustStateSourceRepresentation,
    ): boolean => {
      const expectedHashes = expectedManagedHookTrustHashes(
        expectations,
        key,
        representation.insideManagedMarkerBlock,
      );
      return expectedHashes !== undefined &&
        representation.stateEntryCount === 1 &&
        !representation.hasComment &&
        representation.hasExactSemanticScope &&
        isExactlyManagedHookTrustStateValue(representation.value, expectedHashes);
    };
    if (!sourceRepresentations.some((representation) =>
      expectedManagedHookTrustHashes(
        expectations,
        key,
        representation.insideManagedMarkerBlock,
      ) !== undefined
    )) continue;
    const mayRemoveAll = sourceRepresentations.length === 1
      ? isExactOwnedRepresentation(sourceRepresentations[0]!)
      : sourceRepresentations.every(
        (representation) =>
          representation.insideManagedMarkerBlock &&
          isExactOwnedRepresentation(representation),
      );
    if (!mayRemoveAll) {
      preservedConflictKeys.add(key);
      continue;
    }
    for (const representation of sourceRepresentations) {
      removals.set(`${representation.start}:${representation.end}`, {
        start: representation.start,
        end: representation.end,
      });
    }
  }

  if (removals.size === 0) {
    return { config, preservedConflictKeys };
  }

  const removed = new Set<number>();
  for (const range of removals.values()) {
    for (let index = range.start; index < range.end; index += 1) {
      removed.add(index);
    }
  }
  removeEmptyManagedHookTrustStateMarkerBlocks(source, removed);
  return {
    config: lines.filter((_, index) => !removed.has(index)).join("\n").trimEnd(),
    preservedConflictKeys,
  };
}

function stripManagedCodexHookTrustStateForRefresh(
  config: string,
  priorManagedTrustState: ManagedCodexHookTrustStateMap | undefined,
  finalManagedTrustState: ManagedCodexHookTrustStateMap,
): HookTrustStateStripResult {
  return stripProofManagedCodexHookTrustStateTables(
    config,
    managedHookTrustStateExpectations(priorManagedTrustState, finalManagedTrustState),
  );
}

function rejectManagedCodexHookTrustStateConflicts(
  conflicts: ReadonlySet<string>,
): void {
  if (conflicts.size === 0) return;

  const keys = [...conflicts].sort((left, right) => left.localeCompare(right));
  throw new ManagedCodexHooksPlanError(
    "managed_trust_key_conflict",
    `Refusing to replace existing Codex hook trust state for ${keys.join(", ")}. Remove or reconcile the conflicting [hooks.state] entry before running setup.`,
    { keys },
  );
}

export function stripManagedCodexHookTrustState(
  config: string,
  options: {
    managedTrustState?: ManagedCodexHookTrustStateMap;
    priorManagedHookTrustState?: ManagedCodexHookTrustStateMap;
  } = {},
): string {
  const stripped = stripManagedCodexHookTrustStateForRefresh(
    config,
    options.priorManagedHookTrustState,
    options.managedTrustState ?? {},
  );
  rejectManagedCodexHookTrustStateConflicts(stripped.preservedConflictKeys);
  return stripped.config;
}

function renderManagedCodexHookTrustToml(
  managedTrustState: ManagedCodexHookTrustStateMap,
): string {
  return Object.entries(managedTrustState)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, hookState]) => [
      `[hooks.state."${escapeTomlBasicString(key)}"]`,
      `trusted_hash = "${escapeTomlBasicString(hookState.trusted_hash)}"`,
      "",
    ])
    .join("\n")
    .trimEnd();
}

function identicalLegacyHookTrustStateEntry(
  existing: unknown,
  expected: CodexHooksJsonTrustStateEntry,
): boolean {
  if (!isPlainTomlRecord(existing)) return false;
  if (
    !Object.hasOwn(existing, "trusted_hash") ||
    typeof existing.trusted_hash !== "string" ||
    existing.trusted_hash !== expected.trusted_hash ||
    Object.keys(existing).some((key) => key !== "trusted_hash" && key !== "enabled")
  ) {
    return false;
  }
  return Object.hasOwn(existing, "enabled") === Object.hasOwn(expected, "enabled") &&
    existing.enabled === expected.enabled;
}

function legacyHookTrustStateConflict(keys: readonly string[], reason?: string): never {
  throw new ManagedCodexHooksPlanError(
    "managed_trust_key_conflict",
    `Refusing to migrate legacy Codex hook trust state into conflicting config.toml entries for ${keys.join(", ")}.`,
    { keys: [...keys], ...(reason ? { reason } : {}) },
  );
}

function appendLegacyHookTrustState(
  config: string,
  legacyTrustState: Record<string, CodexHooksJsonTrustStateEntry> | undefined,
): string {
  if (!legacyTrustState || Object.keys(legacyTrustState).length === 0) {
    return config;
  }

  const parsed = safeParseToml(config);
  const keys = Object.keys(legacyTrustState).sort((left, right) => left.localeCompare(right));
  if (!parsed) legacyHookTrustStateConflict(keys, "config_parse_failure");
  const hooks = parsed.hooks;
  if (hooks !== undefined && !isPlainTomlRecord(hooks)) {
    legacyHookTrustStateConflict(keys, "hooks_table_invalid");
  }
  const hookState = isPlainTomlRecord(hooks) ? hooks.state : undefined;
  if (hookState !== undefined && !isPlainTomlRecord(hookState)) {
    legacyHookTrustStateConflict(keys, "hooks_state_table_invalid");
  }
  const existingTrustState = isPlainTomlRecord(hookState) ? hookState : {};
  const entriesToAppend = Object.entries(legacyTrustState)
    .filter(([key]) => !Object.hasOwn(existingTrustState, key));
  const conflictingKeys = Object.entries(legacyTrustState)
    .filter(([key, expected]) =>
      Object.hasOwn(existingTrustState, key) &&
      !identicalLegacyHookTrustStateEntry(existingTrustState[key], expected)
    )
    .map(([key]) => key)
    .sort((left, right) => left.localeCompare(right));
  if (conflictingKeys.length > 0) legacyHookTrustStateConflict(conflictingKeys);
  const trustToml = entriesToAppend
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, state]) => [
      `[hooks.state."${escapeTomlBasicString(key)}"]`,
      `trusted_hash = "${escapeTomlBasicString(state.trusted_hash)}"`,
      ...(typeof state.enabled === "boolean" ? [`enabled = ${state.enabled}`] : []),
      "",
    ])
    .join("\n")
    .trimEnd();
  if (!trustToml) return config;

  const base = config.trimEnd();
  return [
    base,
    base ? "" : null,
    "# Migrated from legacy hooks.json state; kept in Codex config.toml because Codex 0.140 rejects top-level hooks.json state.",
    trustToml,
    "",
  ].filter((line): line is string => line !== null).join("\n");
}

function managedCodexHookOptionsFromMergeOptions(
  options: MergeOptions,
): ManagedCodexHookOptions {
  return {
    codexHomeDir: options.codexHomeDir,
    platform: options.hookCommandPlatform,
    hooksContent: options.codexHooksContent,
  };
}

function buildManagedCodexHookTrustStateForConfig(
  codexHooksFile: string | undefined,
  pkgRoot: string,
  options: ManagedCodexHookOptions = {},
  precomputedTrustState?: ManagedCodexHookTrustStateMap,
): ManagedCodexHookTrustStateMap {
  if (precomputedTrustState) return precomputedTrustState;
  if (!codexHooksFile) return {};
  return buildManagedCodexHookTrustState(codexHooksFile, pkgRoot, options);
}

export function upsertManagedCodexHookTrustState(
  config: string,
  pkgRoot: string,
  codexHooksFile: string | undefined,
  options: ManagedCodexHookOptions & {
    managedTrustState?: ManagedCodexHookTrustStateMap;
    priorManagedHookTrustState?: ManagedCodexHookTrustStateMap;
    legacyHookTrustState?: Record<string, CodexHooksJsonTrustStateEntry>;
  } = {},
): string {
  const managedTrustState = buildManagedCodexHookTrustStateForConfig(
    codexHooksFile,
    pkgRoot,
    options,
    options.managedTrustState,
  );
  const strippedResult = stripManagedCodexHookTrustStateForRefresh(
    config,
    options.priorManagedHookTrustState,
    managedTrustState,
  );
  rejectManagedCodexHookTrustStateConflicts(
    strippedResult.preservedConflictKeys,
  );
  const stripped = strippedResult.config.trimEnd();
  const hookTrustToml = renderManagedCodexHookTrustToml(managedTrustState);
  if (!hookTrustToml) {
    return appendLegacyHookTrustState(
      `${stripped}\n`,
      options.legacyHookTrustState,
    );
  }
  return appendLegacyHookTrustState(
    [
      stripped,
      "",
      OMX_HOOK_TRUST_START_MARKER,
      "# Trusts only setup-managed native hook wrappers.",
      hookTrustToml,
      OMX_HOOK_TRUST_END_MARKER,
      "",
    ].filter((line, index) => index !== 0 || line.length > 0).join("\n"),
    options.legacyHookTrustState,
  );
}

export function upsertPluginModeRuntimeFeatureFlags(
  config: string,
  codexHookFeatureFlag: CodexHookFeatureFlag = DEFAULT_CODEX_HOOK_FEATURE_FLAG,
  options: { pluginScopedHooks?: boolean; preserveNativeHooks?: boolean } = {},
): string {
  const lines = config.split(/\r?\n/);
  const featuresStart = lines.findIndex((line) =>
    /^\s*\[features\]\s*$/.test(line),
  );
  const hookFeatureFlagLine = options.pluginScopedHooks
    ? `${CODEX_PLUGIN_SCOPED_HOOKS_FEATURE_FLAG} = true`
    : formatCodexHookFeatureFlagLine(codexHookFeatureFlag);

  if (featuresStart < 0) {
    const base = config.trimEnd();
    const featureBlock = [
      "[features]",
      hookFeatureFlagLine,
      ...(options.pluginScopedHooks && options.preserveNativeHooks
        ? [formatCodexHookFeatureFlagLine(codexHookFeatureFlag)]
        : []),
      "goals = true",
      "",
    ].join("\n");
    if (base.length === 0) {
      return featureBlock;
    }
    return `${base}\n${featureBlock}`;
  }

  let sectionEnd = lines.length;
  for (let i = featuresStart + 1; i < lines.length; i++) {
    if (/^\s*\[\[?[^\]]+\]?\]\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  // Remove the misspelled singular flag from unreleased PR builds before
  // upserting the supported plural Codex feature flag.
  for (let i = sectionEnd - 1; i > featuresStart; i--) {
    if (/^\s*goal\s*=/.test(lines[i])) {
      lines.splice(i, 1);
      sectionEnd -= 1;
    }
  }

  if (options.pluginScopedHooks) {
    ({ sectionEnd } = upsertPluginScopedHookFeatureFlagInSection(
      lines,
      featuresStart,
      sectionEnd,
    ));
    if (options.preserveNativeHooks) {
      ({ sectionEnd } = upsertCodexHookFeatureFlagInSection(
        lines,
        featuresStart,
        sectionEnd,
        codexHookFeatureFlag,
      ));
    }
  } else {
    ({ sectionEnd } = upsertCodexHookFeatureFlagInSection(
      lines,
      featuresStart,
      sectionEnd,
      codexHookFeatureFlag,
    ));
  }

  let goalsIdx = -1;
  for (let i = featuresStart + 1; i < sectionEnd; i++) {
    if (/^\s*goals\s*=/.test(lines[i])) {
      goalsIdx = i;
    }
  }
  if (goalsIdx >= 0) {
    lines[goalsIdx] = "goals = true";
  } else {
    lines.splice(sectionEnd, 0, "goals = true");
  }

  return lines.join("\n");
}
interface TomlTableRange {
  start: number;
  end: number;
}

function findTomlTableRange(
  lines: string[],
  headerPattern: RegExp,
): TomlTableRange | undefined {
  const start = lines.findIndex((line) => headerPattern.test(line));
  if (start < 0) return undefined;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[\[?[^\]]+\]?\]\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }

  return { start, end };
}

function tomlAssignmentKey(line: string): string | undefined {
  return line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
}

interface TomlTableEntryRange {
  key?: string;
  start: number;
  end: number;
}

function findTomlTableEntryRanges(
  lines: string[],
  start: number,
  end: number,
): TomlTableEntryRange[] {
  const ranges: TomlTableEntryRange[] = [];
  let index = start;

  while (index < end) {
    const key = tomlAssignmentKey(lines[index]);
    if (key === undefined) {
      ranges.push({ start: index, end: index + 1 });
      index += 1;
      continue;
    }

    let entryEnd = index + 1;
    while (
      !parseStandaloneToml(lines.slice(index, entryEnd).join("\n")) &&
      entryEnd < end
    ) {
      entryEnd += 1;
    }

    ranges.push({ key, start: index, end: entryEnd });
    index = entryEnd;
  }

  return ranges;
}

function collectTomlTableKeyEntries(
  lines: string[],
  range: TomlTableRange,
): { key: string; lines: string[] }[] {
  return findTomlTableEntryRanges(lines, range.start + 1, range.end)
    .filter(
      (
        entry,
      ): entry is TomlTableEntryRange & { key: string } =>
        entry.key !== undefined,
    )
    .map((entry) => ({
      key: entry.key,
      lines: lines.slice(entry.start, entry.end),
    }));
}

function stripTomlTableKey(
  lines: string[],
  headerPattern: RegExp,
  keyName: string,
): string[] {
  const range = findTomlTableRange(lines, headerPattern);
  if (!range) return lines;

  const filtered = [...lines];
  const entries = findTomlTableEntryRanges(
    filtered,
    range.start + 1,
    range.end,
  );
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.key === keyName) {
      filtered.splice(entry.start, entry.end - entry.start);
    }
  }

  const newRange = findTomlTableRange(filtered, headerPattern);
  if (!newRange) return filtered;

  const sectionContent = filtered.slice(newRange.start + 1, newRange.end);
  if (sectionContent.every((line) => line.trim() === "")) {
    filtered.splice(newRange.start, newRange.end - newRange.start);
  }

  return filtered;
}

function upsertEnvSettings(config: string): string {
  const lines = config.split(/\r?\n/);
  const legacyEnvRange = findTomlTableRange(lines, /^\s*\[env\]\s*$/);
  const legacyEnvEntries =
    legacyEnvRange === undefined
      ? []
      : collectTomlTableKeyEntries(lines, legacyEnvRange);

  if (legacyEnvRange !== undefined) {
    lines.splice(
      legacyEnvRange.start,
      legacyEnvRange.end - legacyEnvRange.start,
    );
  }

  const shellEnvSetRange = findTomlTableRange(
    lines,
    /^\s*\[shell_environment_policy\.set\]\s*$/,
  );
  if (shellEnvSetRange === undefined) {
    const base = lines.join("\n").trimEnd();
    const envLines = legacyEnvEntries.flatMap((entry) => entry.lines);
    if (
      legacyEnvEntries.every(
        (entry) => entry.key !== OMX_EXPLORE_CMD_ENV,
      )
    ) {
      envLines.push(
        `${OMX_EXPLORE_CMD_ENV} = "${OMX_EXPLORE_ROUTING_DEFAULT}"`,
      );
    }
    const envBlock = [
      "[shell_environment_policy.set]",
      ...envLines,
      "",
    ].join("\n");
    if (base.length === 0) return envBlock;
    return `${base}\n\n${envBlock}`;
  }

  const shellEnvKeys = new Set<string>();
  for (let i = shellEnvSetRange.start + 1; i < shellEnvSetRange.end; i++) {
    const key = tomlAssignmentKey(lines[i]);
    if (key !== undefined) shellEnvKeys.add(key);
  }

  const linesToInsert: string[] = [];
  for (const entry of legacyEnvEntries) {
    if (!shellEnvKeys.has(entry.key)) {
      linesToInsert.push(...entry.lines);
      shellEnvKeys.add(entry.key);
    }
  }

  if (!shellEnvKeys.has(OMX_EXPLORE_CMD_ENV)) {
    linesToInsert.push(
      `${OMX_EXPLORE_CMD_ENV} = "${OMX_EXPLORE_ROUTING_DEFAULT}"`,
    );
  }

  if (linesToInsert.length > 0) {
    lines.splice(shellEnvSetRange.end, 0, ...linesToInsert);
  }

  return lines.join("\n");
}

/**
 * Remove OMX-owned feature flags from the [features] section.
 * If `preserveMultiAgent` is set, retain multi_agent unchanged.
 * If the section becomes empty after removal, remove the section header too.
 */
export function stripOmxFeatureFlags(
  config: string,
  options: { preserveMultiAgent?: boolean } = {},
): string {
  const lines = config.split(/\r?\n/);
  const featuresStart = lines.findIndex((line) =>
    /^\s*\[features\]\s*$/.test(line),
  );

  if (featuresStart < 0) return config;

  let sectionEnd = lines.length;
  for (let i = featuresStart + 1; i < lines.length; i++) {
    if (/^\s*\[\[?[^\]]+\]?\]\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  const omxFlags = [
    ...(options.preserveMultiAgent ? [] : ["multi_agent"]),
    "child_agents_md",
    "hooks",
    "codex_hooks",
    "goals",
    "goal",
    "collab",
  ];
  const filtered: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > featuresStart && i < sectionEnd) {
      const isOmxFlag = omxFlags.some((f) =>
        new RegExp(`^\\s*${f}\\s*=`).test(lines[i]),
      );
      if (isOmxFlag) continue;
    }
    filtered.push(lines[i]);
  }

  // If [features] section is now empty, remove the header too
  const newFeaturesStart = filtered.findIndex((l) =>
    /^\s*\[features\]\s*$/.test(l),
  );
  if (newFeaturesStart >= 0) {
    let newSectionEnd = filtered.length;
    for (let i = newFeaturesStart + 1; i < filtered.length; i++) {
      if (/^\s*\[\[?[^\]]+\]?\]\s*$/.test(filtered[i])) {
        newSectionEnd = i;
        break;
      }
    }
    const sectionContent = filtered.slice(newFeaturesStart + 1, newSectionEnd);
    if (sectionContent.every((l) => l.trim() === "")) {
      filtered.splice(newFeaturesStart, newSectionEnd - newFeaturesStart);
    }
  }

  return filtered.join("\n");
}

/**
 * Preserve native Codex hook enablement without re-adding other OMX feature
 * flags. Used by uninstall when user-owned hooks remain in hooks.json.
 */
export function upsertCodexHooksFeatureFlag(
  config: string,
  codexHookFeatureFlag: CodexHookFeatureFlag = DEFAULT_CODEX_HOOK_FEATURE_FLAG,
): string {
  const lines = config.split(/\r?\n/);
  const featuresStart = lines.findIndex((line) =>
    /^\s*\[features\]\s*$/.test(line),
  );
  const hookFeatureFlagLine = formatCodexHookFeatureFlagLine(
    codexHookFeatureFlag,
  );

  if (featuresStart < 0) {
    const base = config.trimEnd();
    const featureBlock = ["[features]", hookFeatureFlagLine, ""].join("\n");
    return base.length === 0 ? featureBlock : `${base}\n${featureBlock}`;
  }

  let sectionEnd = lines.length;
  for (let i = featuresStart + 1; i < lines.length; i++) {
    if (/^\s*\[\[?[^\]]+\]?\]\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  upsertCodexHookFeatureFlagInSection(
    lines,
    featuresStart,
    sectionEnd,
    codexHookFeatureFlag,
  );

  return lines.join("\n");
}

export function stripOmxEnvSettings(config: string): string {
  let lines = config.split(/\r?\n/);
  lines = stripTomlTableKey(lines, /^\s*\[env\]\s*$/, OMX_EXPLORE_CMD_ENV);
  lines = stripTomlTableKey(
    lines,
    /^\s*\[shell_environment_policy\.set\]\s*$/,
    OMX_EXPLORE_CMD_ENV,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Orphaned OMX table sections (no marker block)
// ---------------------------------------------------------------------------

function isOmxFirstPartyMcpSection(tableName: string): boolean {
  const match = tableName.match(/^mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))$/);
  const name = match?.[1] ?? match?.[2];
  return Boolean(
    name &&
      ((OMX_FIRST_PARTY_MCP_SERVER_NAMES as readonly string[]).includes(name) ||
        name === "omx_team_run"),
  );
}


/**
 * Strip first-party OMX MCP table sections that exist outside the marker block.
 * This covers legacy configs that were written before markers were added,
 * or configs where the marker was accidentally removed.
 */
function stripOrphanedOmxSections(config: string): string {
  const lines = config.split(/\r?\n/);
  const result: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const tableMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);

    if (tableMatch) {
      const tableName = tableMatch[1];
      // Note: [tui] is NOT stripped here because it could be user-owned.
      // The marker-based stripExistingOmxBlocks already handles [tui]
      // when it lives inside the OMX marker block.
      const isOmxSection = isOmxFirstPartyMcpSection(tableName);

      if (isOmxSection) {
        // Remove preceding OMX comment lines and blank lines
        while (result.length > 0) {
          const last = result[result.length - 1];
          if (last.trim() === "" || /^#\s*(OMX|oh-my-codex)/i.test(last)) {
            result.pop();
          } else {
            break;
          }
        }

        // Skip table header + all key=value / comment / blank lines until next section
        i++;
        while (i < lines.length && !/^\s*\[/.test(lines[i])) {
          i++;
        }
        continue;
      }
    }

    result.push(line);
    i++;
  }

  return result.join("\n");
}

export function hasFirstPartyOmxMcpRegistrations(config: string): boolean {
  const firstPartyNames = new Set<string>([
    ...OMX_FIRST_PARTY_MCP_SERVER_NAMES,
    "omx_team_run",
  ]);
  for (const line of config.split(/\r?\n/)) {
    const match = line.match(/^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/);
    const name = match?.[1] ?? match?.[2];
    if (name && firstPartyNames.has(name)) return true;
  }
  return false;
}

export function extractFirstPartyOmxMcpSections(config: string): string {
  const lines = config.split(/\r?\n/);
  const sections: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const tableMatch = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
    if (!tableMatch || !isOmxFirstPartyMcpSection(tableMatch[1])) {
      i += 1;
      continue;
    }

    const sectionLines: string[] = [];
    sectionLines.push(lines[i]);
    i += 1;
    while (i < lines.length && !/^\s*\[/.test(lines[i])) {
      sectionLines.push(lines[i]);
      i += 1;
    }
    sections.push(sectionLines.join("\n").trimEnd());
  }

  return sections.filter(Boolean).join("\n\n");
}

export function stripFirstPartyOmxMcpSections(config: string): string {
  const lines = config.split(/\r?\n/);
  const result: string[] = [];

  for (let index = 0; index < lines.length; ) {
    const tableMatch = lines[index].match(/^\s*\[([^\]]+)\]\s*$/);
    if (tableMatch && isOmxFirstPartyMcpSection(tableMatch[1])) {
      index += 1;
      while (index < lines.length && !/^\s*\[/.test(lines[index])) {
        index += 1;
      }
      continue;
    }

    result.push(lines[index]);
    index += 1;
  }

  return result.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function extractCustomizedTuiSectionsFromOmxBlocks(config: string): string[] {
  const sections: string[] = [];
  let searchStart = 0;

  while (true) {
    const markerIdx = config.indexOf(OMX_CONFIG_MARKER, searchStart);
    if (markerIdx < 0) break;

    const endIdx = config.indexOf(OMX_CONFIG_END_MARKER, markerIdx);
    if (endIdx < 0) break;

    const blockLines = config.slice(markerIdx, endIdx).split(/\r?\n/);

    for (let i = 0; i < blockLines.length; i++) {
      if (!/^\s*\[tui\]\s*$/.test(blockLines[i])) continue;

      const tuiLines = [blockLines[i].trim()];
      let hasCustomizedStatusLine = false;
      let lastNonBlankBeforeStatusLine: string | undefined;

      for (let j = i + 1; j < blockLines.length; j++) {
        if (/^\s*\[\[?[^\]]+\]?\]\s*$/.test(blockLines[j])) break;

        const trimmed = blockLines[j].trim();
        if (!trimmed) continue;

        tuiLines.push(trimmed);
        if (/^status_line\s*=/.test(trimmed)) {
          // OMX-managed when:
          //   1. Preceded by the managed-status-line marker AND the value is
          //      a known OMX preset literal (post-marker installs). If the
          //      marker is present but the value isn't a preset, the user
          //      edited the value and left the marker — treat as customized.
          //   2. No marker but the value byte-matches the legacy seven-field
          //      default (pre-marker installs only ever shipped focused).
          // Anything else inside an OMX-marker block is treated as a user
          // customization and preserved across rebuild.
          const hasMarker =
            lastNonBlankBeforeStatusLine === OMX_MANAGED_STATUS_LINE_MARKER;
          const matchesPreset = OMX_PRESET_STATUS_LINE_VALUES.has(trimmed);
          const isManagedByMarker = hasMarker && matchesPreset;
          const isManagedByLegacyValue =
            !hasMarker && trimmed === LEGACY_OMX_STATUS_LINE;
          if (!isManagedByMarker && !isManagedByLegacyValue) {
            hasCustomizedStatusLine = true;
          }
        }
        lastNonBlankBeforeStatusLine = trimmed;
      }

      if (hasCustomizedStatusLine) {
        sections.push(tuiLines.join("\n"));
      }
    }

    searchStart = endIdx + OMX_CONFIG_END_MARKER.length;
  }

  return sections;
}

function upsertTuiStatusLine(
  config: string,
  preset: HudPreset = DEFAULT_STATUS_LINE_PRESET,
  options: { forceStatusLinePreset?: boolean } = {},
): {
  cleaned: string;
  hadExistingTui: boolean;
} {
  const lines = config.split(/\r?\n/);
  const sections: Array<{ start: number; end: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\[tui\]\s*$/.test(lines[i])) continue;

    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*\[\[?[^\]]+\]?\]\s*$/.test(lines[j])) {
        end = j;
        break;
      }
    }
    sections.push({ start: i, end });
    i = end - 1;
  }

  if (sections.length === 0) {
    return { cleaned: config, hadExistingTui: false };
  }

  const preservedKeyLines: string[] = [];
  const seenKeys = new Set<string>();
  let preservedStatusLine: string | undefined;

  for (const section of sections) {
    let lastNonBlankBeforeStatusLine: string | undefined;

    for (let i = section.start + 1; i < section.end; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("#")) {
        lastNonBlankBeforeStatusLine = trimmed;
        continue;
      }

      const keyMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*=/);
      if (!keyMatch) {
        lastNonBlankBeforeStatusLine = trimmed;
        continue;
      }

      const key = keyMatch[1];
      if (key === "status_line") {
        const entryLines = [trimmed];
        while (
          !parseStandaloneToml(entryLines.join("\n")) &&
          i + 1 < section.end
        ) {
          i += 1;
          entryLines.push(lines[i].trim());
        }
        const statusLineEntry = entryLines.join("\n");
        const hasMarker =
          lastNonBlankBeforeStatusLine === OMX_MANAGED_STATUS_LINE_MARKER;
        const isManagedByMarker =
          hasMarker && OMX_PRESET_STATUS_LINE_VALUES.has(statusLineEntry);
        const isManagedByLegacyValue =
          !hasMarker && statusLineEntry === LEGACY_OMX_STATUS_LINE;
        const isOmxManagedStatusLine =
          isManagedByMarker || isManagedByLegacyValue;

        if (!options.forceStatusLinePreset || !isOmxManagedStatusLine) {
          preservedStatusLine ??= statusLineEntry;
        }
        lastNonBlankBeforeStatusLine = statusLineEntry;
        continue;
      }
      if (seenKeys.has(key)) {
        lastNonBlankBeforeStatusLine = trimmed;
        continue;
      }
      seenKeys.add(key);
      preservedKeyLines.push(trimmed);
      lastNonBlankBeforeStatusLine = trimmed;
    }
  }

  // When OMX is supplying the status_line (no user-preserved value),
  // emit the managed-status-line marker comment alongside it so the
  // customized-section detector can unambiguously tell our writes apart
  // from a user edit on the next merge.
  const mergedSection = preservedStatusLine
    ? ["[tui]", ...preservedKeyLines, preservedStatusLine]
    : [
        "[tui]",
        ...preservedKeyLines,
        OMX_MANAGED_STATUS_LINE_MARKER,
        statusLineForPreset(preset),
      ];
  const firstStart = sections[0].start;
  const rebuilt: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const section = sections.find((candidate) => candidate.start === i);
    if (section) {
      if (i === firstStart) {
        if (rebuilt.length > 0 && rebuilt[rebuilt.length - 1].trim() !== "") {
          rebuilt.push("");
        }
        rebuilt.push(...mergedSection, "");
      }

      i = section.end - 1;
      continue;
    }

    rebuilt.push(lines[i]);
  }

  return {
    cleaned: rebuilt.join("\n").replace(/\n{3,}/g, "\n\n"),
    hadExistingTui: true,
  };
}

// ---------------------------------------------------------------------------
// OMX [table] sections block (appended at end of file)
// ---------------------------------------------------------------------------

export function stripExistingOmxBlocks(
  config: string,
  options: {
    managedTrustState?: ManagedCodexHookTrustStateMap;
    priorManagedHookTrustState?: ManagedCodexHookTrustStateMap;
  } = {},
): {
  cleaned: string;
  removed: number;
} {
  const inventory = collectManagedHookTrustStateSourceRepresentations(config);
  const { source } = inventory;
  const markerRanges = collectMarkerRanges(
    source,
    OMX_CONFIG_START_MARKER,
    OMX_CONFIG_END_MARKER,
    false,
    inventory.parsedAssignmentSpans,
  );
  if (markerRanges.length === 0) return { cleaned: config, removed: 0 };
  const conflicts = managedMarkerTrustStateConflicts(
    source,
    inventory.representations,
    markerRanges,
    inventory.markerContainedHooksStateSpans,
    inventory.invalidMarkerContainedHooksStateSpans,
    inventory.parsedStatementSpans,
    inventory.parsedAssignmentSpans,
    managedHookTrustStateExpectations(
      options.priorManagedHookTrustState,
      options.managedTrustState,
    ),
  );
  rejectManagedCodexHookTrustStateConflicts(conflicts);
  if (!source.isUnambiguous) return { cleaned: config, removed: 0 };

  const lines = sourceLines(config);
  if (markerRanges.some((range) => !lines[range.start] || !lines[range.end])) {
    return { cleaned: config, removed: 0 };
  }
  const removalRanges = markerRanges.map((range) => {
    const startLine = lines[range.start]!;
    const endLine = lines[range.end]!;
    const previousLine = lines[range.start - 1];
    const start = previousLine && /^# =+$/.test(previousLine.content.trim())
      ? previousLine.start
      : startLine.start;
    return { start, end: endLine.end };
  });

  const segments: string[] = [];
  let cursor = 0;
  for (const range of removalRanges) {
    segments.push(config.slice(cursor, range.start));
    cursor = range.end;
  }
  segments.push(config.slice(cursor));

  const cleaned = segments
    .map((segment, index) =>
      index === 0
        ? segment.trimEnd()
        : index === segments.length - 1
        ? segment.trimStart()
        : segment.trim()
    )
    .filter(Boolean)
    .join("\n\n");
  return { cleaned, removed: markerRanges.length };
}

export function stripExistingSharedMcpRegistryBlock(config: string): {
  cleaned: string;
  removed: number;
} {
  let cleaned = config;
  let removed = 0;

  while (true) {
    const markerIdx = cleaned.indexOf(SHARED_MCP_REGISTRY_MARKER);
    if (markerIdx < 0) break;

    let blockStart = cleaned.lastIndexOf("\n", markerIdx);
    blockStart = blockStart >= 0 ? blockStart + 1 : 0;

    const previousLineEnd = blockStart - 1;
    if (previousLineEnd >= 0) {
      const previousLineStart = cleaned.lastIndexOf("\n", previousLineEnd - 1);
      const previousLine = cleaned.slice(
        previousLineStart + 1,
        previousLineEnd,
      );
      if (/^# =+$/.test(previousLine.trim())) {
        blockStart = previousLineStart >= 0 ? previousLineStart + 1 : 0;
      }
    }

    let blockEnd = cleaned.length;
    const endIdx = cleaned.indexOf(SHARED_MCP_REGISTRY_END_MARKER, markerIdx);
    if (endIdx >= 0) {
      const endLineBreak = cleaned.indexOf("\n", endIdx);
      blockEnd = endLineBreak >= 0 ? endLineBreak + 1 : cleaned.length;
    }

    const before = cleaned.slice(0, blockStart).trimEnd();
    const after = cleaned.slice(blockEnd).trimStart();
    cleaned = [before, after].filter(Boolean).join("\n\n");
    removed += 1;
  }

  return { cleaned, removed };
}

function getExistingSharedMcpRegistryBlocks(config: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;

  while (cursor < config.length) {
    const markerIdx = config.indexOf(SHARED_MCP_REGISTRY_MARKER, cursor);
    if (markerIdx < 0) break;

    let blockStart = config.lastIndexOf("\n", markerIdx);
    blockStart = blockStart >= 0 ? blockStart + 1 : 0;

    const previousLineEnd = blockStart - 1;
    if (previousLineEnd >= 0) {
      const previousLineStart = config.lastIndexOf("\n", previousLineEnd - 1);
      const previousLine = config.slice(previousLineStart + 1, previousLineEnd);
      if (/^# =+$/.test(previousLine.trim())) {
        blockStart = previousLineStart >= 0 ? previousLineStart + 1 : 0;
      }
    }

    let blockEnd = config.length;
    const endIdx = config.indexOf(SHARED_MCP_REGISTRY_END_MARKER, markerIdx);
    if (endIdx >= 0) {
      const endLineBreak = config.indexOf("\n", endIdx);
      blockEnd = endLineBreak >= 0 ? endLineBreak + 1 : config.length;
    }

    blocks.push(config.slice(blockStart, blockEnd));
    cursor = blockEnd;
  }

  return blocks;
}

export function extractSharedMcpRegistryServersFromConfig(config: string): {
  servers: UnifiedMcpRegistryServer[];
  sourcePath?: string;
} {
  const servers: UnifiedMcpRegistryServer[] = [];
  let sourcePath: string | undefined;

  for (const block of getExistingSharedMcpRegistryBlocks(config)) {
    sourcePath ??= block.match(/^# Source:\s*(.+?)\s*$/m)?.[1];

    let parsed: unknown;
    try {
      parsed = TOML.parse(block);
    } catch {
      continue;
    }

    if (!isRecord(parsed) || !isRecord(parsed.mcp_servers)) continue;

    for (const [name, value] of Object.entries(parsed.mcp_servers)) {
      if (!isRecord(value) || typeof value.command !== "string") continue;
      const args = Array.isArray(value.args)
        ? value.args.filter((arg): arg is string => typeof arg === "string")
        : [];
      const enabled =
        typeof value.enabled === "boolean" ? value.enabled : true;
      const timeoutCandidate =
        typeof value.startup_timeout_sec === "number"
          ? value.startup_timeout_sec
          : value.startupTimeoutSec;
      const startupTimeoutSec =
        typeof timeoutCandidate === "number" && Number.isFinite(timeoutCandidate)
          ? timeoutCandidate
          : undefined;

      servers.push({
        name,
        command: value.command,
        args,
        enabled,
        ...(startupTimeoutSec !== undefined ? { startupTimeoutSec } : {}),
      });
    }
  }

  return { servers, sourcePath };
}

function toMcpServerTableKey(name: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(name)) {
    return `mcp_servers.${name}`;
  }
  return `mcp_servers."${escapeTomlString(name)}"`;
}

function configHasMcpServer(config: string, name: string): boolean {
  const tableName = toMcpServerTableKey(name).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  return new RegExp(`^\\s*\\[${tableName}\\]\\s*$`, "m").test(config);
}

function launcherCommandBasename(command: string): string {
  return (
    command.replace(/\\/g, "/").trim().split("/").pop()?.toLowerCase() ?? ""
  );
}

function isLauncherBackedMcpCommand(
  command: string,
  args: readonly string[],
): boolean {
  const base = launcherCommandBasename(command);
  if (base === "npx" || base === "uvx") {
    return true;
  }

  return base === "npm" && args[0]?.toLowerCase() === "exec";
}

interface LauncherTimeoutRepairTarget {
  insertAt: number;
}

function findLauncherTimeoutRepairTargets(
  config: string,
): LauncherTimeoutRepairTarget[] {
  const lines = config.split(/\r?\n/);
  const targets: LauncherTimeoutRepairTarget[] = [];

  for (let start = 0; start < lines.length; start += 1) {
    const isMcpSection = /^\s*\[mcp_servers\./.test(lines[start] ?? "");
    if (!isMcpSection) continue;

    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^\s*\[\[?[^\]]+\]?\]\s*$/.test(lines[i] ?? "")) {
        end = i;
        break;
      }
    }

    let parsed: unknown;
    try {
      parsed = TOML.parse(lines.slice(start, end).join("\n"));
    } catch {
      start = end - 1;
      continue;
    }

    const mcpServers = (parsed as { mcp_servers?: Record<string, unknown> })
      .mcp_servers;
    const [name, value] = Object.entries(mcpServers ?? {})[0] ?? [];
    if (
      !name ||
      name.startsWith("omx_") ||
      typeof value !== "object" ||
      !value
    ) {
      start = end - 1;
      continue;
    }

    const section = value as Record<string, unknown>;
    const command =
      typeof section.command === "string" ? section.command : undefined;
    const args =
      Array.isArray(section.args) &&
      section.args.every((item) => typeof item === "string")
        ? (section.args as string[])
        : [];
    const hasStartupTimeout =
      (typeof section.startup_timeout_sec === "number" &&
        Number.isFinite(section.startup_timeout_sec)) ||
      (typeof section.startupTimeoutSec === "number" &&
        Number.isFinite(section.startupTimeoutSec));

    if (
      !command ||
      hasStartupTimeout ||
      !isLauncherBackedMcpCommand(command, args)
    ) {
      start = end - 1;
      continue;
    }

    let insertAt = end;
    while (insertAt > start + 1 && (lines[insertAt - 1] ?? "").trim() === "") {
      insertAt -= 1;
    }

    targets.push({ insertAt });
    start = end - 1;
  }

  return targets;
}

function addDefaultLauncherMcpStartupTimeouts(config: string): string {
  const targets = findLauncherTimeoutRepairTargets(config);
  if (targets.length === 0) return config;

  const lines = config.split(/\r?\n/);
  for (const target of [...targets].reverse()) {
    lines.splice(
      target.insertAt,
      0,
      `startup_timeout_sec = ${DEFAULT_LAUNCHER_MCP_STARTUP_TIMEOUT_SEC}`,
    );
  }

  return lines.join("\n");
}

function getSharedMcpRegistryBlock(
  servers: UnifiedMcpRegistryServer[],
  sourcePath: string | undefined,
  existingConfig: string,
): string {
  if (servers.length === 0) return "";
  const deduped = servers.filter(
    (server) => !configHasMcpServer(existingConfig, server.name),
  );
  if (deduped.length === 0) return "";

  const lines = [
    "# ============================================================",
    `# ${SHARED_MCP_REGISTRY_MARKER}`,
    "# Managed by omx setup - edit the registry file instead",
  ];
  if (sourcePath) {
    lines.push(`# Source: ${sourcePath}`);
  }
  lines.push(
    "# ============================================================",
    "",
  );

  for (const server of deduped) {
    lines.push(`# Shared MCP Server: ${server.name}`);
    lines.push(`[${toMcpServerTableKey(server.name)}]`);
    lines.push(`command = "${escapeTomlString(server.command)}"`);
    lines.push(
      `args = [${server.args
        .map((arg) => `"${escapeTomlString(arg)}"`)
        .join(", ")}]`,
    );
    lines.push(`enabled = ${server.enabled ? "true" : "false"}`);
    if (typeof server.startupTimeoutSec === "number") {
      lines.push(`startup_timeout_sec = ${server.startupTimeoutSec}`);
    }
    lines.push("");
  }

  lines.push("# ============================================================");
  lines.push(SHARED_MCP_REGISTRY_END_MARKER);
  return lines.join("\n");
}

export function mergeSharedMcpRegistryBlock(
  config: string,
  servers: UnifiedMcpRegistryServer[],
  sourcePath?: string,
): string {
  const stripped = stripExistingSharedMcpRegistryBlock(config);
  const existing = stripped.cleaned;
  const sharedRegistryBlock = getSharedMcpRegistryBlock(
    servers,
    sourcePath,
    existing,
  );
  const body = existing.trimEnd();
  const merged = sharedRegistryBlock
    ? body
      ? `${body}\n\n${sharedRegistryBlock}\n`
      : `${sharedRegistryBlock}\n`
    : body
      ? `${body}\n`
      : "";
  return addDefaultLauncherMcpStartupTimeouts(merged);
}

/**
 * OMX table-section block (MCP servers, TUI).
 * Contains ONLY [table] sections — no bare keys.
 */
function getOmxTablesBlock(
  pkgRoot: string,
  includeTui = true,
  statusLinePreset: HudPreset = DEFAULT_STATUS_LINE_PRESET,
  codexHooksFile?: string,
  hookOptions: ManagedCodexHookOptions = {},
  managedHookTrustState?: ManagedCodexHookTrustStateMap,
  includeFirstPartyMcp = false,
): string {
  const lines = [
    "",
    "# ============================================================",
    "# oh-my-codex (OMX) Configuration",
    "# Managed by omx setup - manual edits preserved on next setup",
    "# ============================================================",
  ];

  if (includeFirstPartyMcp) {
    for (const server of getOmxFirstPartySetupMcpServers(pkgRoot)) {
      lines.push("");
      lines.push(server.title);
      lines.push(`[mcp_servers.${server.name}]`);
      lines.push(`command = "${escapeTomlString(server.command)}"`);
      lines.push(
        `args = [${server.args
          .map((arg) => `"${escapeTomlString(arg)}"`)
          .join(", ")}]`,
      );
      lines.push(`enabled = ${server.enabled ? "true" : "false"}`);
      if (typeof server.startupTimeoutSec === "number") {
        lines.push(`startup_timeout_sec = ${server.startupTimeoutSec}`);
      }
    }
  }

  const hookTrustToml = renderManagedCodexHookTrustToml(
    buildManagedCodexHookTrustStateForConfig(
      codexHooksFile,
      pkgRoot,
      hookOptions,
      managedHookTrustState,
    ),
  );
  if (hookTrustToml) {
    lines.push("");
    lines.push("# OMX-owned Codex hook trust state");
    lines.push("# Trusts only setup-managed native hook wrappers.");
    lines.push(hookTrustToml);
    lines.push("# End OMX-owned Codex hook trust state");
  }

  lines.push(
    ...(includeTui
      ? [
          "",
          "# OMX TUI StatusLine (Codex CLI v0.101.0+)",
          "[tui]",
          OMX_MANAGED_STATUS_LINE_MARKER,
          statusLineForPreset(statusLinePreset),
          "",
        ]
      : [""]),
  );
  lines.push("# ============================================================");
  lines.push("# End oh-my-codex");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merge OMX config into existing config.toml
 * Preserves existing user settings, appends OMX block if not present.
 *
 * Layout:
 *   1. OMX top-level keys (notify, model_reasoning_effort, developer_instructions)
 *   2. [features] with child_agents_md + hooks + goals
 *   3. [shell_environment_policy.set] with defaulted deprecated explore-routing opt-out
 *   4. … user sections …
 *   5. OMX [table] sections (mcp_servers, tui)
 */
export function buildMergedConfig(
  existingConfig: string,
  pkgRoot: string,
  options: MergeOptions = {},
): string {
  let existing = stripOmxSeededBehavioralDefaults(existingConfig);
  const hookOptions = managedCodexHookOptionsFromMergeOptions(options);
  const managedTrustState = buildManagedCodexHookTrustStateForConfig(
    options.codexHooksFile,
    pkgRoot,
    hookOptions,
    options.managedHookTrustState,
  );
  const preflightHookTrustStrip = stripManagedCodexHookTrustStateForRefresh(
    existing,
    options.priorManagedHookTrustState,
    managedTrustState,
  );
  rejectManagedCodexHookTrustStateConflicts(
    preflightHookTrustStrip.preservedConflictKeys,
  );
  const preservedFirstPartyMcpSections =
    options.preserveExistingFirstPartyMcp === true &&
    options.includeFirstPartyMcp !== true
      ? extractFirstPartyOmxMcpSections(existing)
      : "";
  const includeTui = options.includeTui !== false;
  const statusLinePreset =
    options.statusLinePreset ?? DEFAULT_STATUS_LINE_PRESET;
  const customizedManagedTuiSections =
    extractCustomizedTuiSectionsFromOmxBlocks(existing);

  if (existing.includes(OMX_CONFIG_MARKER)) {
    const stripped = stripExistingOmxBlocks(existing, {
      managedTrustState,
      priorManagedHookTrustState: options.priorManagedHookTrustState,
    });
    existing = stripped.cleaned;
    if (customizedManagedTuiSections.length > 0) {
      existing = `${existing.trimEnd()}\n\n${customizedManagedTuiSections.join("\n\n")}\n`;
    }
  }
  if (existing.includes(SHARED_MCP_REGISTRY_MARKER)) {
    const stripped = stripExistingSharedMcpRegistryBlock(existing);
    existing = stripped.cleaned;
  }

  const userNotifyToPreserve =
    options.notifyCommand === false &&
    !isOmxManagedNotifyCommand(getRootTomlArray(existing, "notify"), pkgRoot)
      ? getRootTomlArray(existing, "notify")
      : null;
  existing = stripOmxTopLevelKeys(existing).trimStart();
  if (userNotifyToPreserve) {
    existing = `${`notify = ${formatTomlStringArray(userNotifyToPreserve)}`}\n${existing.trimStart()}`;
  }
  existing = stripOrphanedManagedNotify(existing, pkgRoot).trimStart();
  const hookTrustStrip = stripManagedCodexHookTrustStateForRefresh(
    existing,
    options.priorManagedHookTrustState,
    managedTrustState,
  );
  rejectManagedCodexHookTrustStateConflicts(
    hookTrustStrip.preservedConflictKeys,
  );
  existing = hookTrustStrip.config;
  if (options.modelOverride) {
    existing = stripRootLevelKeys(existing, ["model"]);
  }
  existing = stripOrphanedOmxSections(existing);
  if (preservedFirstPartyMcpSections) {
    existing = `${existing.trimEnd()}\n\n${preservedFirstPartyMcpSections}\n`;
  }
  existing = upsertFeatureFlags(existing, options.codexHookFeatureFlag);
  existing = upsertEnvSettings(existing);
  const tuiUpsert = includeTui
    ? upsertTuiStatusLine(existing, statusLinePreset, {
        forceStatusLinePreset: options.forceStatusLinePreset,
      })
    : { cleaned: existing, hadExistingTui: false };
  existing = tuiUpsert.cleaned;

  const topLines = getOmxTopLevelLines(
    pkgRoot,
    existing,
    options.modelOverride,
    options.notifyCommand === undefined
      ? getDefaultNotifyCommand(pkgRoot)
      : options.notifyCommand,
  );
  const tablesBlock = getOmxTablesBlock(
    pkgRoot,
    includeTui && !tuiUpsert.hadExistingTui,
    statusLinePreset,
    options.codexHooksFile,
    hookOptions,
    managedTrustState,
    options.includeFirstPartyMcp === true,
  );
  const sharedRegistryBlock = getSharedMcpRegistryBlock(
    options.sharedMcpServers ?? [],
    options.sharedMcpRegistrySource,
    existing,
  );

  let body = existing.trim();
  if (sharedRegistryBlock) {
    body = body ? `${body}\n\n${sharedRegistryBlock}` : sharedRegistryBlock;
  }
  const bodySeparator = body.length > 0 && !/^\s*\[/.test(body) ? "\n" : "\n\n";

  const merged = addDefaultLauncherMcpStartupTimeouts(
    topLines.join("\n") + bodySeparator + body + "\n" + tablesBlock,
  );
  return appendLegacyHookTrustState(merged, options.legacyHookTrustState);
}

/**
 * Detect and repair upgrade-era managed config incompatibilities in config.toml.
 *
 * After an omx version upgrade the OLD setup code (still loaded in memory)
 * may leave a config with duplicate [tui] sections or the retired
 * [mcp_servers.omx_team_run] table. Codex rejects duplicate tables and newer
 * OMX builds no longer ship the team MCP entrypoint, so we repair both before
 * the CLI is spawned.
 *
 * Returns `true` if a repair was performed.
 */
function managedHookTrustProofRequiredForRepair(config: string): boolean {
  const inventory = collectManagedHookTrustStateSourceRepresentations(config);
  return managedMarkerTrustStateConflicts(
    inventory.source,
    inventory.representations,
    inventory.managedMarkerRanges,
    inventory.markerContainedHooksStateSpans,
    inventory.invalidMarkerContainedHooksStateSpans,
    inventory.parsedStatementSpans,
    inventory.parsedAssignmentSpans,
    managedHookTrustStateExpectations(),
  ).size > 0;
}

async function launchRepairOptionsWithManagedHookTrustProof(
  configPath: string,
  config: string,
  options: MergeOptions,
): Promise<MergeOptions> {
  if (!managedHookTrustProofRequiredForRepair(config)) {

    return options;
  }

  const hooksPath = options.codexHooksFile ?? resolve(configPath, "..", "hooks.json");
  let hooksContent: string;
  try {
    hooksContent = await readFile(hooksPath, "utf-8");
  } catch (error) {
    throw new ManagedCodexHooksPlanError(
      "invalid_document",
      `Cannot safely repair config.toml because the current hooks artifact at ${hooksPath} could not be read.`,
      { cause: String(error), hooksPath },
    );
  }

  const trustScan = scanManagedCodexHookTrustStateFromContent(
    hooksContent,
    hooksPath,
    managedCodexHookOptionsFromMergeOptions(options),
  );
  if (!trustScan.ok) throw trustScan.error;

  return {
    ...options,
    codexHooksFile: hooksPath,
    codexHooksContent: hooksContent,
    managedHookTrustState: trustScan.trustState,
    priorManagedHookTrustState: trustScan.trustState,
  };
}

export async function repairConfigIfNeeded(
  configPath: string,
  pkgRoot: string,
  options: MergeOptions = {},
): Promise<boolean> {
  if (!existsSync(configPath)) return false;

  const content = await readFile(configPath, "utf-8");
  const tuiCount = (content.match(/^\s*\[tui\]\s*$/gm) || []).length;
  const hasLegacyTeamRunTable = hasLegacyOmxTeamRunTable(content);
  const hasLauncherTimeoutGap =
    findLauncherTimeoutRepairTargets(content).length > 0;
  if (tuiCount <= 1 && !hasLegacyTeamRunTable && !hasLauncherTimeoutGap)
    return false;

  // Managed config compatibility issue detected — derive proof from the current
  // hooks artifact before any marker stripping can replace managed trust state.
  const repairOptions = await launchRepairOptionsWithManagedHookTrustProof(
    configPath,
    content,
    options,
  );
  const repaired = buildMergedConfig(content, pkgRoot, repairOptions);
  if (repaired === content) return false;
  await writeFile(configPath, repaired);
  return true;
}

export async function mergeConfig(
  configPath: string,
  pkgRoot: string,
  options: MergeOptions = {},
): Promise<void> {
  let existing = "";

  if (existsSync(configPath)) {
    existing = await readFile(configPath, "utf-8");
  }


  const finalConfig = buildMergedConfig(existing, pkgRoot, options);

  await writeFile(configPath, finalConfig);
  if (options.verbose) {
    console.log(`  Written to ${configPath}`);
  }
}
