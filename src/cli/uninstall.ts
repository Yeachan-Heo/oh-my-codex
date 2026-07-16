/**
 * omx uninstall - Remove oh-my-codex configuration and installed artifacts
 */

import { chmod, copyFile, lstat, open, readFile, readdir, rename, rm, writeFile, type FileHandle } from "fs/promises";

import { constants, existsSync } from "fs";
import { join, basename, dirname, isAbsolute, relative } from "path";
import { randomUUID } from "crypto";
import {
  clearNativeHookClaimJournal as clearNativeHookClaimJournalWithDurability,
  createNativeHookClaimJournalDurability,
  persistNativeHookClaimJournal as persistNativeHookClaimJournalWithDurability,
  recoverNativeHookClaimJournal,
  syncNativeHookClaimParent as syncNativeHookClaimParentWithDurability,
  restoreNativeHookClaimNoClobber as restoreNativeHookClaimNoClobberWithDurability,
  type NativeHookClaimJournalDurability,
} from "./native-hook-claim-journal.js";
import {
  formatTomlStringArray,
  getRootTomlArray,
  isOmxManagedNotifyCommand,
  sanitizePreviousNotifyCommand,
  stripExistingOmxBlocks,
  stripManagedCodexHookTrustState,
  stripOmxEnvSettings,
  stripOmxTopLevelKeys,
  stripOmxFeatureFlags,
  upsertCodexHooksFeatureFlag,
  stripOmxSeededBehavioralDefaults,
} from "../config/generator.js";
import {
  buildManagedCodexNativeHookWindowsShimContent,
  buildManagedCodexNativeHookWindowsShimPath,
  classifyManagedCodexNativeHookWindowsShimOwnership,
  planManagedCodexHooksRemoval,
  ManagedCodexHooksPlanError,
  type ManagedCodexHookTrustState,
  type ManagedCodexHooksPlan,
} from "../config/codex-hooks.js";
import { getPackageRoot } from "../utils/package.js";
import { AGENT_DEFINITIONS } from "../agents/definitions.js";
import { detectLegacySkillRootOverlap } from "../utils/paths.js";
import {
  decideWindowsNativeHookShimReference,
  resolveScopeDirectories,
  type SetupScope,
} from "./setup.js";

import { resolveCodexHookFeatureFlagForCli } from "./codex-feature-probe.js";
import { readPersistedSetupScope } from "./index.js";
import {
  isOmxGeneratedAgentsMd,
  OMX_MANAGED_AGENTS_END_MARKER,
  OMX_MANAGED_AGENTS_START_MARKER,
} from "../utils/agents-md.js";
import { OMX_FIRST_PARTY_MCP_SERVER_NAMES } from "../config/omx-first-party-mcp.js";
import TOML from "@iarna/toml";
import {
  emitDegradedDurabilityWarning,
  recordRegularFileSyncOutcome,
  syncRegularFile,
  type RegularFileSyncOutcome,
  type RegularFileDurabilityTracker,
} from "../utils/file-durability.js";

/** @internal Deterministic file-operation seam for uninstall transaction tests. */
export type UninstallTransactionFailureStage =
  | "before-hooks-commit"
  | "before-shim-removal"
  | "before-config-commit"
  | "before-temp-write"
  | "before-rename"
  | "after-final-rename-validation"
  | "after-rename"
  | "before-remove"
  | "after-final-remove-validation"
  | "after-remove"
  | "before-rollback"
  | "before-rollback-rename"
  | "after-final-restore-validation"
  | "before-rollback-remove"
  | "before-staged-cleanup"
  | "after-staged-cleanup"
  | "after-config-commit";

/** @internal Distinguishes each direct regular-file durability boundary. */
export type UninstallRegularFileSyncSite =
  | "replacement-temporary"
  | "installed-destination"
  | "staged-deletion";

let uninstallClaimJournalDurabilityOverride: NativeHookClaimJournalDurability | undefined;

/** @internal Test seam for deterministic claim-journal durability coverage. */
export function setUninstallClaimJournalDurabilityForTest(
  durability: NativeHookClaimJournalDurability | undefined,
): () => void {
  const previous = uninstallClaimJournalDurabilityOverride;
  uninstallClaimJournalDurabilityOverride = durability;
  return () => {
    uninstallClaimJournalDurabilityOverride = previous;
  };
}


export interface UninstallOptions {
  codexFeaturesProbe?: () => string | null;
  codexVersionProbe?: () => string | null;
  dryRun?: boolean;
  keepConfig?: boolean;
  verbose?: boolean;
  purge?: boolean;
  scope?: SetupScope;
  /** @internal */
  transactionFailureInjector?: (
    stage: UninstallTransactionFailureStage,
  ) => void | Promise<void>;
  /** @internal */
  transactionPlatform?: NodeJS.Platform;
  /** @internal */
  transactionTemporaryPath?: (
    path: string,
    purpose: "write" | "delete",
  ) => string;
  /** @internal */
  regularFileSyncForTest?: (
    site: UninstallRegularFileSyncSite,
    handle: Pick<FileHandle, "sync">,
    platform: NodeJS.Platform,
  ) => Promise<RegularFileSyncOutcome>;


}

interface UninstallSummary {
  configCleaned: boolean;
  mcpServersRemoved: string[];
  agentEntriesRemoved: number;
  tuiSectionRemoved: boolean;
  topLevelKeysRemoved: boolean;
  featureFlagsRemoved: boolean;
  hooksFileRemoved: boolean;
  promptsRemoved: number;
  skillsRemoved: number;
  agentConfigsRemoved: number;
  agentsMdRemoved: boolean;
  cacheDirectoryRemoved: boolean;
  legacySkillRootWarning: string | null;
}

function detectOmxConfigArtifacts(config: string): {
  hasMcpServers: string[];
  hasAgentEntries: number;
  hasTuiSection: boolean;
  hasTopLevelKeys: boolean;
  hasFeatureFlags: boolean;
} {
  const hasMcpServers = OMX_FIRST_PARTY_MCP_SERVER_NAMES.filter((name) =>
    new RegExp(`\\[mcp_servers\\.${name}\\]`).test(config),
  );

  const agentNames = Object.keys(AGENT_DEFINITIONS);
  let hasAgentEntries = 0;
  for (const name of agentNames) {
    const tableKey = name.includes("-") ? `agents."${name}"` : `agents.${name}`;
    if (config.includes(`[${tableKey}]`)) {
      hasAgentEntries++;
    }
  }

  const hasTuiSection =
    /^\[tui\]/m.test(config) &&
    config.includes("oh-my-codex (OMX) Configuration");

  const hasTopLevelKeys =
    /^\s*notify\s*=.*node/m.test(config) ||
    /^\s*model_reasoning_effort\s*=/m.test(config) ||
    /^\s*developer_instructions\s*=.*oh-my-codex/m.test(config);

  const hasFeatureFlags =
    /^\s*child_agents_md\s*=\s*true/m.test(config) ||
    /^\s*hooks\s*=\s*true/m.test(config) ||
    /^\s*codex_hooks\s*=\s*true/m.test(config) ||
    /^\s*goals\s*=\s*true/m.test(config) ||
    /^\s*goal\s*=\s*true/m.test(config);

  return {
    hasMcpServers,
    hasAgentEntries,
    hasTuiSection,
    hasTopLevelKeys,
    hasFeatureFlags,
  };
}

function hasNativeHooksFeatureFlag(config: string): boolean {
  const lines = config.split(/\r?\n/);
  const featuresStart = lines.findIndex((line) =>
    /^\s*\[features\]\s*$/.test(line),
  );
  if (featuresStart < 0) return false;

  let sectionEnd = lines.length;
  for (let i = featuresStart + 1; i < lines.length; i++) {
    if (/^\s*\[\[?[^\]]+\]?\]\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  return lines
    .slice(featuresStart + 1, sectionEnd)
    .some((line) => /^\s*(?:hooks|codex_hooks)\s*=\s*true/.test(line));
}

type FileIdentityScalar = number | bigint;

interface FileIdentity {
  dev: FileIdentityScalar;
  ino: FileIdentityScalar;
  size: FileIdentityScalar;
  mode: FileIdentityScalar;
  mtimeMs: FileIdentityScalar;
  ctimeMs: FileIdentityScalar;
  links: FileIdentityScalar;
}

interface DirectoryTopologyEntry {
  path: string;
  identity: Pick<FileIdentity, "dev" | "ino"> | null;
}

interface FileTopology {
  root: string;
  ancestors: DirectoryTopologyEntry[];
}

interface FileSnapshot {
  path: string;
  content: string | null;
  bytes: Buffer | null;
  mode: number | null;
  identity: FileIdentity | null;
  topology: FileTopology | null;
}

interface PlannedHooksRemoval {
  hooks: FileSnapshot;
  plan?: ManagedCodexHooksPlan;
  shim?: FileSnapshot;
  preservedShimPrecondition?: FileSnapshot;
}

function fileIdentity(stat: Awaited<ReturnType<typeof lstat>>): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    links: stat.nlink,
  };
}

function hasSameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.links === right.links;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function captureControlledTopology(
  root: string,
  path: string,
): Promise<FileTopology> {
  const parentPath = dirname(path);
  const relativeParent = relative(root, parentPath);
  if (
    isAbsolute(relativeParent) ||
    relativeParent === ".." ||
    relativeParent.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    relativeParent.startsWith("/")
  ) {
    throw new Error(`Refusing to process ${path}: it is outside controlled Codex scope ${root}.`);
  }

  const ancestors: DirectoryTopologyEntry[] = [];
  let currentPath = root;
  for (const segment of ["", ...relativeParent.split(/[\\/]/).filter(Boolean)]) {
    if (segment) currentPath = join(currentPath, segment);
    try {
      const stat = await lstat(currentPath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Refusing to process ${path}: controlled ancestor ${currentPath} must be a non-symbolic-link directory.`);
      }
      ancestors.push({
        path: currentPath,
        identity: { dev: stat.dev, ino: stat.ino },
      });
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      ancestors.push({ path: currentPath, identity: null });
      break;
    }
  }
  return { root, ancestors };
}

async function assertControlledTopologyCurrent(topology: FileTopology | null): Promise<void> {
  if (!topology) return;
  for (const ancestor of topology.ancestors) {
    try {
      const stat = await lstat(ancestor.path);
      if (
        ancestor.identity === null ||
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        stat.dev !== ancestor.identity.dev ||
        stat.ino !== ancestor.identity.ino
      ) {
        throw new Error(`Refusing uninstall because controlled ancestor ${ancestor.path} changed topology after planning.`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("changed topology")) {
        throw error;
      }
      if (isMissingPathError(error) && ancestor.identity === null) continue;
      if (isMissingPathError(error)) {
        throw new Error(`Refusing uninstall because controlled ancestor ${ancestor.path} changed topology after planning.`);
      }
      throw error;
    }
  }
}

function decodeStrictUtf8(path: string, bytes: Buffer): string {
  try {
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!Buffer.from(content, "utf-8").equals(bytes)) {
      throw new Error("decoded text did not round-trip to the original bytes");
    }
    return content;
  } catch {
    throw new ManagedCodexHooksPlanError(
      "invalid_document",
      `Refusing to process ${path}: it is not valid UTF-8.`,
      { path },
    );
  }
}

async function readFileSnapshot(
  path: string,
  options: { strictUtf8?: boolean; controlledRoot?: string } = {},
): Promise<FileSnapshot> {
  const topology = options.controlledRoot
    ? await captureControlledTopology(options.controlledRoot, path)
    : null;
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      await assertControlledTopologyCurrent(topology);
      return {
        path,
        content: null,
        bytes: null,
        mode: null,
        identity: null,
        topology,
      };
    }
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error(`Refusing to process ${path}: expected a regular file, not a symbolic link or other filesystem object.`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  await assertControlledTopologyCurrent(topology);
  if (after.isSymbolicLink() || !after.isFile() || after.nlink !== 1 || !hasSameFileIdentity(fileIdentity(before), fileIdentity(after))) {
    throw new Error(`Refusing to process ${path}: it changed while uninstall was planning.`);
  }
  return {
    path,
    content: options.strictUtf8 === false ? bytes.toString("utf-8") : decodeStrictUtf8(path, bytes),
    bytes,
    mode: after.mode & 0o7777,
    identity: fileIdentity(after),
    topology,
  };
}

async function planHooksRemoval(
  hooks: FileSnapshot,
  pkgRoot: string,
  platform: NodeJS.Platform,
  controlledRoot: string,
): Promise<PlannedHooksRemoval> {
  let plan: ManagedCodexHooksPlan | undefined;
  if (hooks.content !== null) {
    const result = planManagedCodexHooksRemoval(hooks.content, hooks.path, {
      platform,
      codexHomeDir: dirname(hooks.path),
    });
    if (!result.ok) throw result.error;
    plan = result;
  }

  if (platform !== "win32") return { hooks, plan };

  const shimPath = buildManagedCodexNativeHookWindowsShimPath(dirname(hooks.path));
  const shim = await readFileSnapshot(shimPath, {
    strictUtf8: false,
    // On non-Windows hosts the test-only platform seam intentionally produces
    // a win32 path that the host filesystem cannot place under this root.
    controlledRoot: platform === process.platform ? controlledRoot : undefined,
  });
  if (shim.bytes !== null) {
    const expectedShim = Buffer.from(
      buildManagedCodexNativeHookWindowsShimContent(pkgRoot),
      "utf-8",
    );
    if (
      classifyManagedCodexNativeHookWindowsShimOwnership(
        shim.bytes,
        expectedShim,
      ) === "modified"
    ) {
      throw new Error(
        `Refusing to remove modified native hook Windows shim at ${shim.path}.`,
      );
    }
    const shimReference = decideWindowsNativeHookShimReference(
      plan?.finalContent ?? null,
      shim.path,
    );
    if (shimReference !== "not_referenced") {
      return { hooks, plan, preservedShimPrecondition: shim };
    }

  }

  return { hooks, plan, shim };
}

function insertRootTomlKey(config: string, line: string): string {
  const lines = config.split(/\r?\n/);
  const firstTableIndex = lines.findIndex((candidate) =>
    /^\s*\[/.test(candidate),
  );
  const insertAt = firstTableIndex >= 0 ? firstTableIndex : lines.length;
  lines.splice(insertAt, 0, line);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

interface PlannedNotifyMetadata {
  snapshot: FileSnapshot;
  previousNotify: string[] | null;
}

function isManagedDispatcherNotify(config: string): boolean {
  const currentNotify = getRootTomlArray(config, "notify");
  return Boolean(
    isOmxManagedNotifyCommand(currentNotify, getPackageRoot()) &&
      currentNotify?.some((part) =>
        /(?:^|[\\/])notify-dispatcher\.js$/.test(part),
      ),
  );
}

function invalidNotifyMetadata(path: string, reason: string): ManagedCodexHooksPlanError {
  return new ManagedCodexHooksPlanError(
    "invalid_document",
    `Refusing to use notification metadata ${path}: ${reason}.`,
    { path },
  );
}

function parseNotifyMetadata(
  snapshot: FileSnapshot,
  currentNotify: readonly string[],
): PlannedNotifyMetadata {
  if (snapshot.content === null) {
    throw invalidNotifyMetadata(snapshot.path, "the managed dispatcher metadata is missing");
  }
  if (!currentNotify.includes(snapshot.path)) {
    throw invalidNotifyMetadata(snapshot.path, "the managed dispatcher does not reference the controlled metadata path");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.content);
  } catch (error) {
    throw invalidNotifyMetadata(
      snapshot.path,
      `invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidNotifyMetadata(snapshot.path, "expected a JSON object");
  }
  const metadata = parsed as Record<string, unknown>;
  if (metadata.managedBy !== "oh-my-codex" || metadata.version !== 1) {
    throw invalidNotifyMetadata(snapshot.path, "expected OMX ownership and version 1");
  }
  const validateStringArray = (value: unknown, name: string): string[] => {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw invalidNotifyMetadata(snapshot.path, `${name} must be an array of strings`);
    }
    return [...value];
  };
  const previousNotify = metadata.previousNotify;
  if (
    !Object.hasOwn(metadata, "previousNotify") ||
    (previousNotify !== null &&
      (!Array.isArray(previousNotify) ||
        !previousNotify.every((item) => typeof item === "string")))
  ) {
    throw invalidNotifyMetadata(snapshot.path, "previousNotify must be null or an array of strings");
  }
  validateStringArray(metadata.omxNotify, "omxNotify");
  const dispatcherNotify = validateStringArray(
    metadata.dispatcherNotify,
    "dispatcherNotify",
  );
  if (
    dispatcherNotify.length !== currentNotify.length ||
    dispatcherNotify.some((part, index) => part !== currentNotify[index])
  ) {
    throw invalidNotifyMetadata(snapshot.path, "dispatcherNotify does not match the managed dispatcher command");
  }
  return {
    snapshot,
    previousNotify: Array.isArray(previousNotify) ? [...previousNotify] : null,
  };
}

async function planNotifyMetadata(
  configSnapshot: FileSnapshot,
  codexHomeDir: string,
): Promise<PlannedNotifyMetadata | undefined> {
  if (configSnapshot.content === null || !isManagedDispatcherNotify(configSnapshot.content)) {
    return undefined;
  }
  const currentNotify = getRootTomlArray(configSnapshot.content, "notify");
  if (!currentNotify) {
    throw invalidNotifyMetadata(
      join(codexHomeDir, ".omx", "notify-dispatch.json"),
      "the managed dispatcher command is invalid",
    );
  }
  let snapshot: FileSnapshot;
  try {
    snapshot = await readFileSnapshot(
      join(codexHomeDir, ".omx", "notify-dispatch.json"),
      { controlledRoot: codexHomeDir },
    );
  } catch (error) {
    if (error instanceof ManagedCodexHooksPlanError) throw error;
    throw invalidNotifyMetadata(
      join(codexHomeDir, ".omx", "notify-dispatch.json"),
      `unreadable (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return parseNotifyMetadata(snapshot, currentNotify);
}

function restorePreviousNotifyIfDispatcher(
  strippedConfig: string,
  originalConfig: string,
  metadataPlan?: PlannedNotifyMetadata,
): string {
  if (!isManagedDispatcherNotify(originalConfig)) return strippedConfig;
  if (!metadataPlan) {
    throw new Error("Missing planned notification metadata for a managed dispatcher.");
  }
  const sanitizedPreviousNotify = sanitizePreviousNotifyCommand(
    metadataPlan.previousNotify,
    getPackageRoot(),
  );
  return sanitizedPreviousNotify
    ? insertRootTomlKey(
        strippedConfig,
        `notify = ${formatTomlStringArray(sanitizedPreviousNotify)}`,
      )
    : strippedConfig;
}

type ConfigCleanupSummary = Pick<
  UninstallSummary,
  | "configCleaned"
  | "mcpServersRemoved"
  | "agentEntriesRemoved"
  | "tuiSectionRemoved"
  | "topLevelKeysRemoved"
  | "featureFlagsRemoved"
>;

interface PlannedConfigCleanup {
  config: FileSnapshot;
  finalContent: string | null;
  result: ConfigCleanupSummary;
}

async function planConfigCleanup(
  configSnapshot: FileSnapshot,
  options: Pick<
    UninstallOptions,
    "codexFeaturesProbe" | "codexVersionProbe"
  > & {
    preserveHooksFeatureFlag?: boolean;
    priorHookTrustState?: Record<string, ManagedCodexHookTrustState>;
    finalHookTrustState?: Record<string, ManagedCodexHookTrustState>;
    notifyMetadata?: PlannedNotifyMetadata;
  },
): Promise<PlannedConfigCleanup> {
  const result: ConfigCleanupSummary = {
    configCleaned: false,
    mcpServersRemoved: [],
    agentEntriesRemoved: 0,
    tuiSectionRemoved: false,
    topLevelKeysRemoved: false,
    featureFlagsRemoved: false,
  };

  const original = configSnapshot.content;
  if (original === null) {
    return { config: configSnapshot, finalContent: null, result };
  }

  const detected = detectOmxConfigArtifacts(original);
  const shouldRestoreHooksFeatureFlag =
    options.preserveHooksFeatureFlag && hasNativeHooksFeatureFlag(original);

  result.mcpServersRemoved = detected.hasMcpServers;
  result.agentEntriesRemoved = detected.hasAgentEntries;
  result.tuiSectionRemoved = detected.hasTuiSection;
  result.topLevelKeysRemoved = detected.hasTopLevelKeys;
  result.featureFlagsRemoved = detected.hasFeatureFlags;

  // Verify proof ownership against the untouched source before marker stripping
  // can hide a foreign sibling in an otherwise OMX-looking trust declaration.
  stripManagedCodexHookTrustState(original, {
    priorManagedHookTrustState: options.priorHookTrustState,
    managedTrustState: options.finalHookTrustState,
  });

  // Strip OMX tables block (MCP servers, agents, tui)
  let config = original;
  const { cleaned } = stripExistingOmxBlocks(config, {
    managedTrustState: options.finalHookTrustState,
    priorManagedHookTrustState: options.priorHookTrustState,
  });
  config = cleaned;

  // Strip OMX top-level keys, then restore a pre-existing user notify when
  // setup had wrapped it in the OMX dispatcher.
  config = stripOmxTopLevelKeys(config);
  config = restorePreviousNotifyIfDispatcher(
    config,
    original,
    options.notifyMetadata,
  );

  // Strip OMX-seeded behavioral defaults only when the seeded pair is unchanged.
  config = stripOmxSeededBehavioralDefaults(config);

  // Remove only trust tables whose hashes and coordinates match the planned
  // managed hooks before their removal. User-owned conflicts remain intact.
  config = stripManagedCodexHookTrustState(config, {
    priorManagedHookTrustState: options.priorHookTrustState,
    managedTrustState: options.finalHookTrustState,
  });

  // Strip feature flags
  config = stripOmxFeatureFlags(config, { preserveMultiAgent: true });
  if (shouldRestoreHooksFeatureFlag) {
    config = upsertCodexHooksFeatureFlag(
      config,
      resolveCodexHookFeatureFlagForCli({
        codexFeaturesProbe: options.codexFeaturesProbe,
        codexVersionProbe: options.codexVersionProbe,
      }),
    );
  }

  // Strip OMX-managed env defaults
  config = stripOmxEnvSettings(config);

  // Normalize trailing whitespace
  config = config.trimEnd() + "\n";
  result.configCleaned = config !== original;

  return { config: configSnapshot, finalContent: config, result };
}

async function removeInstalledPrompts(
  promptsDir: string,
  pkgRoot: string,
  options: Pick<UninstallOptions, "dryRun" | "verbose">,
): Promise<number> {
  const srcPromptsDir = join(pkgRoot, "prompts");
  if (!existsSync(srcPromptsDir) || !existsSync(promptsDir)) return 0;

  let removed = 0;
  const sourceFiles = await readdir(srcPromptsDir);

  for (const file of sourceFiles) {
    if (!file.endsWith(".md")) continue;
    const installed = join(promptsDir, file);
    if (!existsSync(installed)) continue;

    if (!options.dryRun) {
      await rm(installed, { force: true });
    }
    if (options.verbose)
      console.log(
        `  ${options.dryRun ? "Would remove" : "Removed"} prompt: ${file}`,
      );
    removed++;
  }

  return removed;
}

async function removeInstalledSkills(
  skillsDir: string,
  pkgRoot: string,
  options: Pick<UninstallOptions, "dryRun" | "verbose">,
): Promise<number> {
  const srcSkillsDir = join(pkgRoot, "skills");
  if (!existsSync(srcSkillsDir) || !existsSync(skillsDir)) return 0;

  let removed = 0;
  const sourceEntries = await readdir(srcSkillsDir, { withFileTypes: true });

  for (const entry of sourceEntries) {
    if (!entry.isDirectory()) continue;
    const installed = join(skillsDir, entry.name);
    if (!existsSync(installed)) continue;

    if (!options.dryRun) {
      await rm(installed, { recursive: true, force: true });
    }
    if (options.verbose)
      console.log(
        `  ${options.dryRun ? "Would remove" : "Removed"} skill: ${entry.name}/`,
      );
    removed++;
  }

  return removed;
}

async function removeAgentConfigs(
  agentsDir: string,
  options: Pick<UninstallOptions, "dryRun" | "verbose">,
): Promise<number> {
  if (!existsSync(agentsDir)) return 0;

  let removed = 0;
  const agentNames = Object.keys(AGENT_DEFINITIONS);

  for (const name of agentNames) {
    const configFile = join(agentsDir, `${name}.toml`);
    if (!existsSync(configFile)) continue;

    if (!options.dryRun) {
      await rm(configFile, { force: true });
    }
    if (options.verbose)
      console.log(
        `  ${options.dryRun ? "Would remove" : "Removed"} agent config: ${name}.toml`,
      );
    removed++;
  }

  // If the agents dir is now empty, remove it too
  if (!options.dryRun && existsSync(agentsDir)) {
    try {
      const remaining = await readdir(agentsDir);
      if (remaining.length === 0) {
        await rm(agentsDir, { recursive: true, force: true });
        if (options.verbose) console.log("  Removed empty agents directory.");
      }
    } catch {
      // Ignore errors when cleaning up empty dir
    }
  }

  return removed;
}

async function removeAgentsMd(
  agentsMdPath: string,
  options: Pick<UninstallOptions, "dryRun" | "verbose">,
): Promise<boolean> {
  if (!existsSync(agentsMdPath)) return false;

  try {
    const content = await readFile(agentsMdPath, "utf-8");
    const startIndex = content.indexOf(OMX_MANAGED_AGENTS_START_MARKER);
    const endIndex = content.indexOf(OMX_MANAGED_AGENTS_END_MARKER);
    if (startIndex >= 0 && endIndex > startIndex) {
      const blockEnd = endIndex + OMX_MANAGED_AGENTS_END_MARKER.length;
      const preserved = `${content.slice(0, startIndex).trimEnd()}\n${content.slice(blockEnd).trimStart()}`.trim();
      if (preserved) {
        if (!options.dryRun) await writeFile(agentsMdPath, `${preserved}\n`, "utf-8");
        if (options.verbose) console.log("  Removed OMX-managed AGENTS.md sections and preserved user guidance.");
        return false;
      }
    }
    if (!isOmxGeneratedAgentsMd(content)) {
      if (options.verbose)
        console.log("  AGENTS.md is not OMX-generated, skipping.");
      return false;
    }
  } catch {
    return false;
  }

  if (!options.dryRun) {
    await rm(agentsMdPath, { force: true });
  }
  if (options.verbose)
    console.log(`  ${options.dryRun ? "Would remove" : "Removed"} AGENTS.md`);
  return true;
}

type UninstallArtifactKind = "hooks" | "shim" | "config";

interface PlannedFileMutation {
  kind: UninstallArtifactKind;
  snapshot: FileSnapshot;
  finalContent: string | null;
  validate?: (content: string) => void;
}

interface UninstallArtifactTransaction {
  preconditions: FileSnapshot[];
  hooks?: PlannedFileMutation;
  shim?: PlannedFileMutation;
  config?: PlannedFileMutation;
}

interface RenamedDestinationOwnership {
  path: string;
  bytes: Buffer;
  mode: number;
  identity: Pick<FileIdentity, "dev" | "ino">;
  topology: FileTopology | null;
}

interface MutationExecution {
  mutation: PlannedFileMutation;
  phase: "prepared" | "destructive" | "verified";
  appliedSnapshot?: FileSnapshot;
  renamedOwnership?: RenamedDestinationOwnership;
  stagedDeletion?: FileSnapshot;
  stagedDeletionCleaned?: boolean;
}




function assertValidHooksJson(content: string): void {
  JSON.parse(content);
}

function assertValidToml(content: string): void {
  TOML.parse(content);
}

function transactionTemporaryPath(
  path: string,
  purpose: "write" | "delete",
  options: Pick<UninstallOptions, "transactionTemporaryPath">,
): string {
  return options.transactionTemporaryPath?.(path, purpose) ?? join(
    dirname(path),
    `.${basename(path)}.omx-uninstall-${purpose}-${process.pid}-${randomUUID()}.tmp`,
  );
}

function uninstallClaimJournalDurability() {
  return uninstallClaimJournalDurabilityOverride
    ?? createNativeHookClaimJournalDurability();
}

async function clearNativeHookClaimJournal(root: string): Promise<void> {
  return clearNativeHookClaimJournalWithDurability(root, uninstallClaimJournalDurability());
}

async function persistNativeHookClaimJournal(
  root: string,
  entry: Parameters<typeof persistNativeHookClaimJournalWithDurability>[1],
): Promise<RegularFileSyncOutcome> {
  return persistNativeHookClaimJournalWithDurability(root, entry, uninstallClaimJournalDurability());
}

async function restoreNativeHookClaimNoClobber(
  claimPath: string,
  destinationPath: string,
): Promise<RegularFileSyncOutcome> {
  return restoreNativeHookClaimNoClobberWithDurability(
    claimPath,
    destinationPath,
    uninstallClaimJournalDurability(),
  );
}

async function syncNativeHookClaimParent(path: string): Promise<void> {
  return syncNativeHookClaimParentWithDurability(path, uninstallClaimJournalDurability());
}

function transactionClaimPath(path: string): string {
  return join(
    dirname(path),
    `.${basename(path)}.omx-uninstall-claim-${process.pid}-${randomUUID()}.tmp`,
  );
}

async function restoreUninstallClaim(
  claimPath: string,
  destinationPath: string,
  tracker: RegularFileDurabilityTracker,
): Promise<void> {
  recordRegularFileSyncOutcome(
    tracker,
    await restoreNativeHookClaimNoClobber(claimPath, destinationPath),
  );
}


function snapshotReadOptions(snapshot: FileSnapshot): {
  strictUtf8: false;
  controlledRoot?: string;
} {
  return {
    strictUtf8: false,
    controlledRoot: snapshot.topology?.root,
  };
}

async function captureCurrentSnapshot(reference: FileSnapshot): Promise<FileSnapshot> {
  return readFileSnapshot(reference.path, snapshotReadOptions(reference));
}

function renamedDestinationOwnership(
  snapshot: FileSnapshot,
  destinationPath: string,
  topology: FileTopology | null,
): RenamedDestinationOwnership {
  if (snapshot.bytes === null || snapshot.mode === null || snapshot.identity === null) {
    throw new Error(`Replacement temporary ${snapshot.path} was not fully captured before rename.`);
  }
  return {
    path: destinationPath,
    bytes: snapshot.bytes,
    mode: snapshot.mode,
    identity: { dev: snapshot.identity.dev, ino: snapshot.identity.ino },
    topology,
  };
}

async function captureRenamedDestinationOwnership(
  ownership: RenamedDestinationOwnership,
): Promise<FileSnapshot> {
  await assertControlledTopologyCurrent(ownership.topology);
  const current = await readFileSnapshot(ownership.path, {
    strictUtf8: false,
    controlledRoot: ownership.topology?.root,
  });
  if (
    current.bytes === null ||
    current.mode !== ownership.mode ||
    !current.bytes.equals(ownership.bytes) ||
    current.identity === null ||
    current.identity.dev !== ownership.identity.dev ||
    current.identity.ino !== ownership.identity.ino
  ) {
    throw new Error(`Uninstall replacement ownership changed for ${ownership.path}.`);
  }
  return current;
}


async function assertSnapshotCurrent(snapshot: FileSnapshot): Promise<void> {
  await assertControlledTopologyCurrent(snapshot.topology);
  const current = await captureCurrentSnapshot(snapshot);
  if (snapshot.bytes === null && current.bytes === null) return;
  if (
    snapshot.bytes !== null &&
    current.bytes !== null &&
    snapshot.identity !== null &&
    current.identity !== null &&
    snapshot.bytes.equals(current.bytes) &&
    hasSameFileIdentity(snapshot.identity, current.identity)
  ) {
    return;
  }
  throw new Error(`Refusing uninstall because planned artifact ${snapshot.path} changed, was created, or was removed after planning.`);
}

async function assertSnapshotAtPath(
  path: string,
  expected: FileSnapshot,
  context: string,
): Promise<FileSnapshot> {
  await assertControlledTopologyCurrent(expected.topology);
  const actual = await readFileSnapshot(path, snapshotReadOptions(expected));
  if (
    expected.bytes === null ||
    actual.bytes === null ||
    expected.identity === null ||
    actual.identity === null ||
    !expected.bytes.equals(actual.bytes) ||
    actual.mode !== expected.mode ||
    actual.identity.dev !== expected.identity.dev ||
    actual.identity.ino !== expected.identity.ino
  ) {
    throw new Error(`Refusing uninstall because ${context} ${path} is not the planned artifact.`);
  }
  return actual;

}


async function assertSnapshotMatchesPlannedContent(
  actual: FileSnapshot,
  expected: FileSnapshot,
  context: string,
): Promise<void> {
  await assertControlledTopologyCurrent(expected.topology);
  if (
    actual.bytes === null ||
    expected.bytes === null ||
    actual.mode !== expected.mode ||
    !actual.bytes.equals(expected.bytes)
  ) {
    throw new Error(`Uninstall ${context} mismatch for ${expected.path}.`);
  }
}

async function assertSnapshotsCurrent(snapshots: readonly FileSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) await assertSnapshotCurrent(snapshot);
}

async function removeOwnedTemporary(
  path: string,
  snapshot: FileSnapshot | undefined,
  originalError: unknown,
  description: "temporary" | "staged deletion",
  tracker: RegularFileDurabilityTracker,
): Promise<void> {

  try {
    if (!snapshot) {
      throw new Error(`${description} path was not fully captured after writing.`);
    }
    await assertSnapshotCurrent(snapshot);
    const claimPath = transactionClaimPath(path);

    await rename(path, claimPath);
    try {
      await assertSnapshotAtPath(claimPath, snapshot, `${description} cleanup claim`);
    } catch (error) {
      try {
        await restoreUninstallClaim(claimPath, path, tracker);
      } catch (recoveryError) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; preserved claim ${claimPath} for manual recovery: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        );
      }
      throw error;
    }
    await rm(claimPath);
  } catch (cleanupError) {
    const message = originalError instanceof Error
      ? originalError.message
      : String(originalError);
    throw new Error(
      `Uninstall artifact transaction failed (${message}) and preserved ${description} ${path} for manual recovery after cleanup verification failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
    );
  }
}


type UninstallDurabilityOptions = Pick<
  UninstallOptions,
  "regularFileSyncForTest" | "transactionPlatform"
> & {
  durabilityTracker: RegularFileDurabilityTracker;
};

async function syncUninstallRegularFile(
  site: UninstallRegularFileSyncSite,
  handle: Pick<FileHandle, "sync">,
  options: UninstallDurabilityOptions,
): Promise<void> {
  const platform = options.transactionPlatform ?? process.platform;
  const outcome = options.regularFileSyncForTest
    ? await options.regularFileSyncForTest(site, handle, platform)
    : await syncRegularFile(handle, platform);
  recordRegularFileSyncOutcome(options.durabilityTracker, outcome);
}

async function atomicReplaceFile(
  mutation: PlannedFileMutation,
  expectedCurrent: FileSnapshot,
  content: Buffer,
  options: Pick<UninstallOptions, "transactionFailureInjector" | "transactionTemporaryPath"> & UninstallDurabilityOptions,
  stage: "write" | "rollback",
  onRename: (ownership: RenamedDestinationOwnership) => void,

  assertApplied?: () => Promise<void>,
): Promise<FileSnapshot> {
  if (mutation.snapshot.mode === null) {
    throw new Error(`Refusing to replace ${mutation.snapshot.path}: uninstall did not plan a regular-file mode.`);
  }
  const temporaryPath = transactionTemporaryPath(mutation.snapshot.path, "write", options);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryCreated = false;
  let temporarySnapshot: FileSnapshot | undefined;
  let claimPath: string | undefined;
  let claimCreated = false;
  let journaledClaim = false;
  try {
    await options.transactionFailureInjector?.(
      stage === "write" ? "before-temp-write" : "before-rollback",
    );
    await assertApplied?.();
    await assertSnapshotCurrent(expectedCurrent);
    handle = await open(temporaryPath, "wx", mutation.snapshot.mode);
    temporaryCreated = true;
    await handle.writeFile(content);
    await chmod(temporaryPath, mutation.snapshot.mode);
    await syncUninstallRegularFile("replacement-temporary", handle, options);
    await handle.close();
    handle = undefined;
    temporarySnapshot = await readFileSnapshot(
      temporaryPath,
      snapshotReadOptions(mutation.snapshot),
    );
    if (
      temporarySnapshot.bytes === null ||
      temporarySnapshot.mode !== mutation.snapshot.mode ||
      !temporarySnapshot.bytes.equals(content)
    ) {
      throw new Error(`Read-back verification failed for replacement temporary ${temporaryPath}.`);
    }
    await options.transactionFailureInjector?.(
      stage === "write" ? "before-rename" : "before-rollback-rename",
    );
    await assertApplied?.();
    await assertControlledTopologyCurrent(mutation.snapshot.topology);
    await assertSnapshotCurrent(expectedCurrent);
    await assertSnapshotCurrent(temporarySnapshot);
    await options.transactionFailureInjector?.(
      stage === "write"
        ? "after-final-rename-validation"
        : "after-final-restore-validation",
    );
    if (!temporarySnapshot) {
      throw new Error(`Replacement temporary ${temporaryPath} was not fully captured before install.`);
    }
    claimPath = transactionClaimPath(mutation.snapshot.path);
    const controlledRoot = mutation.snapshot.topology?.root;
    if (expectedCurrent.bytes !== null && controlledRoot) {
      recordRegularFileSyncOutcome(
        options.durabilityTracker,
        await persistNativeHookClaimJournal(controlledRoot, {
          canonicalPath: mutation.snapshot.path,
          claimPath,
          before: expectedCurrent.bytes,
          after: content,
        }),
      );
      journaledClaim = true;
      await rename(mutation.snapshot.path, claimPath);
      claimCreated = true;
      await syncNativeHookClaimParent(claimPath);
      await assertSnapshotAtPath(claimPath, expectedCurrent, "replacement claim");
    }
    await copyFile(temporaryPath, mutation.snapshot.path, constants.COPYFILE_EXCL);
    await chmod(mutation.snapshot.path, mutation.snapshot.mode);
    const installedHandle = await open(mutation.snapshot.path, "r");
    try {
      await syncUninstallRegularFile("installed-destination", installedHandle, options);
    } finally {
      await installedHandle.close();
    }
    await syncNativeHookClaimParent(mutation.snapshot.path);
    const actual = await captureCurrentSnapshot(mutation.snapshot);
    if (actual.bytes === null || actual.mode !== mutation.snapshot.mode || !actual.bytes.equals(content)) {
      throw new Error(`Read-back verification failed for replacement ${mutation.snapshot.path}.`);
    }
    if (claimCreated && claimPath) {
      await rm(claimPath);
      await syncNativeHookClaimParent(claimPath);
      claimCreated = false;
    }
    if (journaledClaim && controlledRoot) {
      await clearNativeHookClaimJournal(controlledRoot);
      journaledClaim = false;
    }
    await rm(temporaryPath);
    temporaryCreated = false;
    const ownership = renamedDestinationOwnership(
      actual,
      mutation.snapshot.path,
      mutation.snapshot.topology,
    );
    onRename(ownership);

    if (stage === "write") {
      await options.transactionFailureInjector?.("after-rename");
    }

    const verified = await captureRenamedDestinationOwnership(ownership);
    if (stage === "write" && mutation.validate) {
      mutation.validate(decodeStrictUtf8(mutation.snapshot.path, verified.bytes!));
    }
    return verified;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (claimCreated && claimPath) {
      try {
        await restoreUninstallClaim(claimPath, mutation.snapshot.path, options.durabilityTracker);
        await syncNativeHookClaimParent(mutation.snapshot.path);
        claimCreated = false;
        const controlledRoot = mutation.snapshot.topology?.root;
        if (journaledClaim && controlledRoot) {
          await clearNativeHookClaimJournal(controlledRoot);
          journaledClaim = false;
        }
      } catch (recoveryError) {
        throw new Error(
          `Uninstall replacement failed (${error instanceof Error ? error.message : String(error)}) and preserved ${claimPath} for manual recovery: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        );
      }
    }
    if (temporaryCreated) {
      await removeOwnedTemporary(
        temporaryPath,
        temporarySnapshot,
        error,
        "temporary",
        options.durabilityTracker,
      );

    }
    throw error;
  }
}


async function stageAndRemoveFile(
  mutation: PlannedFileMutation,
  execution: MutationExecution,
  options: Pick<UninstallOptions, "transactionFailureInjector" | "transactionTemporaryPath"> & UninstallDurabilityOptions,
  assertApplied: () => Promise<void>,
): Promise<void> {
  if (mutation.snapshot.bytes === null || mutation.snapshot.mode === null) {
    throw new Error(`Refusing to remove ${mutation.snapshot.path}: uninstall did not plan a regular-file snapshot.`);
  }
  const stagedPath = transactionTemporaryPath(mutation.snapshot.path, "delete", options);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let stagedCreated = false;
  try {
    await options.transactionFailureInjector?.("before-temp-write");
    await assertApplied();
    await assertSnapshotCurrent(mutation.snapshot);
    handle = await open(stagedPath, "wx", mutation.snapshot.mode);
    stagedCreated = true;
    await handle.writeFile(mutation.snapshot.bytes);
    await chmod(stagedPath, mutation.snapshot.mode);
    await syncUninstallRegularFile("staged-deletion", handle, options);
    await handle.close();
    handle = undefined;
    const stagedDeletion = await readFileSnapshot(
      stagedPath,
      snapshotReadOptions(mutation.snapshot),
    );
    await assertSnapshotMatchesPlannedContent(
      stagedDeletion,
      mutation.snapshot,
      "staged deletion",
    );
    execution.stagedDeletion = stagedDeletion;

    await options.transactionFailureInjector?.("before-remove");
    await assertControlledTopologyCurrent(mutation.snapshot.topology);
    await assertSnapshotCurrent(mutation.snapshot);
    await assertSnapshotCurrent(stagedDeletion);
    await assertApplied();
    await options.transactionFailureInjector?.("after-final-remove-validation");
    await assertSnapshotCurrent(stagedDeletion);
    const claimPath = transactionClaimPath(mutation.snapshot.path);


    const controlledRoot = mutation.snapshot.topology?.root;
    if (controlledRoot && mutation.snapshot.bytes !== null) {
      recordRegularFileSyncOutcome(
        options.durabilityTracker,
        await persistNativeHookClaimJournal(controlledRoot, {
          canonicalPath: mutation.snapshot.path,
          claimPath,
          before: mutation.snapshot.bytes,
          after: null,
        }),
      );
    }
    await rename(mutation.snapshot.path, claimPath);
    if (controlledRoot) await syncNativeHookClaimParent(claimPath);
    execution.appliedSnapshot = {
      path: mutation.snapshot.path,
      content: null,
      bytes: null,
      mode: null,
      identity: null,
      topology: mutation.snapshot.topology,
    };
    execution.phase = "destructive";
    try {


      await assertSnapshotAtPath(claimPath, mutation.snapshot, "removal claim");
    } catch (error) {
      try {
        await restoreUninstallClaim(claimPath, mutation.snapshot.path, options.durabilityTracker);
        if (controlledRoot) await syncNativeHookClaimParent(mutation.snapshot.path);
        if (controlledRoot) await clearNativeHookClaimJournal(controlledRoot);
        execution.appliedSnapshot = undefined;
        execution.phase = "prepared";
      } catch (recoveryError) {
        throw new Error(
          `Uninstall removal claim failed (${error instanceof Error ? error.message : String(error)}) and preserved ${claimPath} for manual recovery: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        );
      }
      throw error;
    }
    await rm(claimPath);
    if (controlledRoot) await syncNativeHookClaimParent(claimPath);
    if (controlledRoot) await clearNativeHookClaimJournal(controlledRoot);
    await options.transactionFailureInjector?.("after-remove");
    await assertControlledTopologyCurrent(mutation.snapshot.topology);
    const absent = await captureCurrentSnapshot(mutation.snapshot);
    if (absent.bytes !== null) {
      throw new Error(`Read-back verification failed for ${mutation.snapshot.path}: expected absence.`);
    }
    execution.phase = "verified";
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (stagedCreated && execution.phase === "prepared") {
      await removeOwnedTemporary(
        stagedPath,
        execution.stagedDeletion,
        error,
        "staged deletion",
        options.durabilityTracker,
      );
    }
    throw error;
  }
}

async function applyFileMutation(
  execution: MutationExecution,
  executions: readonly MutationExecution[],
  options: Pick<UninstallOptions, "transactionFailureInjector" | "transactionTemporaryPath"> & UninstallDurabilityOptions,
): Promise<void> {
  const { mutation } = execution;
  if (mutation.finalContent === null) {
    await stageAndRemoveFile(
      mutation,
      execution,
      options,
      () => assertAppliedTransactionSnapshots(executions),
    );
    return;
  }
  const appliedSnapshot = await atomicReplaceFile(
    mutation,
    mutation.snapshot,
    Buffer.from(mutation.finalContent, "utf-8"),
    options,
    "write",
    (ownership) => {
      execution.renamedOwnership = ownership;
      execution.phase = "destructive";
    },
    () => assertAppliedTransactionSnapshots(executions),
  );
  execution.appliedSnapshot = appliedSnapshot;
  execution.renamedOwnership = undefined;
  execution.phase = "verified";
}

function mutationStage(kind: UninstallArtifactKind): UninstallTransactionFailureStage {
  switch (kind) {
    case "hooks":
      return "before-hooks-commit";
    case "shim":
      return "before-shim-removal";
    case "config":
      return "before-config-commit";
  }
}

async function captureRollbackOwnedSnapshot(
  execution: MutationExecution,
): Promise<FileSnapshot> {
  if (execution.appliedSnapshot) {
    await assertSnapshotCurrent(execution.appliedSnapshot);
    return execution.appliedSnapshot;
  }
  if (execution.renamedOwnership) {
    return captureRenamedDestinationOwnership(execution.renamedOwnership);
  }
  throw new Error(`Refusing stale rollback for ${execution.mutation.snapshot.path}: the mutation did not produce a verifiable state.`);
}

async function restoreFileSnapshot(
  execution: MutationExecution,
  options: Pick<UninstallOptions, "transactionFailureInjector" | "transactionTemporaryPath"> & UninstallDurabilityOptions,
  assertRollbackState: () => Promise<void>,
): Promise<void> {
  const { mutation } = execution;
  const appliedSnapshot = await captureRollbackOwnedSnapshot(execution);
  if (execution.stagedDeletion && !execution.stagedDeletionCleaned) {
    await assertSnapshotCurrent(execution.stagedDeletion);
  }

  if (mutation.snapshot.bytes === null) {
    await options.transactionFailureInjector?.("before-rollback");
    await options.transactionFailureInjector?.("before-rollback-remove");
    await assertRollbackState();
    await assertControlledTopologyCurrent(mutation.snapshot.topology);
    await assertSnapshotCurrent(appliedSnapshot);
    await options.transactionFailureInjector?.("after-final-restore-validation");
    const claimPath = transactionClaimPath(mutation.snapshot.path);

    await rename(mutation.snapshot.path, claimPath);
    execution.appliedSnapshot = {
      path: mutation.snapshot.path,
      content: null,
      bytes: null,
      mode: null,
      identity: null,
      topology: mutation.snapshot.topology,
    };
    execution.renamedOwnership = undefined;
    try {

      await assertSnapshotAtPath(claimPath, appliedSnapshot, "rollback removal claim");
    } catch (error) {
      try {
        await restoreUninstallClaim(claimPath, mutation.snapshot.path, options.durabilityTracker);
      } catch (recoveryError) {
        throw new Error(
          `Uninstall rollback removal claim failed (${error instanceof Error ? error.message : String(error)}) and preserved ${claimPath} for manual recovery: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        );
      }
      throw error;
    }
    await rm(claimPath);
    const absent = await captureCurrentSnapshot(mutation.snapshot);
    if (absent.bytes !== null) {
      throw new Error(`Uninstall rollback mismatch for ${mutation.snapshot.path}: expected absence.`);
    }
    return;
  }

  const restored = await atomicReplaceFile(
    mutation,
    appliedSnapshot,
    mutation.snapshot.bytes,
    options,
    "rollback",
    (ownership) => {
      execution.renamedOwnership = ownership;
    },
    assertRollbackState,
  );
  execution.appliedSnapshot = restored;
  execution.renamedOwnership = undefined;
  await assertSnapshotMatchesPlannedContent(restored, mutation.snapshot, "rollback");
}

async function cleanupStagedDeletions(
  executions: readonly MutationExecution[],
  options: Pick<UninstallOptions, "transactionFailureInjector"> & UninstallDurabilityOptions,
  stage: "commit" | "rollback",
  transaction?: UninstallArtifactTransaction,
  assertRollbackState?: () => Promise<void>,
): Promise<void> {
  for (const execution of executions) {
    if (!execution.stagedDeletion || execution.stagedDeletionCleaned) continue;
    if (stage === "rollback") {
      await options.transactionFailureInjector?.("before-rollback-remove");
    }
    await options.transactionFailureInjector?.("before-staged-cleanup");
    if (transaction) {
      await assertUnmutatedTransactionPreconditions(transaction, executions);
      await assertAppliedTransactionSnapshots(executions);
    }
    await assertRollbackState?.();

    const stagedDeletion = execution.stagedDeletion;
    await assertSnapshotCurrent(stagedDeletion);
    const claimPath = transactionClaimPath(stagedDeletion.path);
    await rename(stagedDeletion.path, claimPath);
    try {
      await assertSnapshotAtPath(claimPath, stagedDeletion, "staged deletion cleanup claim");
    } catch (error) {
      try {
        await restoreUninstallClaim(claimPath, stagedDeletion.path, options.durabilityTracker);
      } catch (recoveryError) {
        throw new Error(
          `Uninstall staged deletion cleanup claim failed (${error instanceof Error ? error.message : String(error)}) and preserved ${claimPath} for manual recovery: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        );
      }
      throw error;
    }
    await rm(claimPath);
    execution.stagedDeletionCleaned = true;
    await assertRollbackState?.();
  }
}

async function assertRollbackTransactionState(
  executions: readonly MutationExecution[],
): Promise<void> {
  for (const execution of executions) {
    if (execution.phase === "prepared") continue;
    if (execution.stagedDeletion && !execution.stagedDeletionCleaned) {
      await assertSnapshotCurrent(execution.stagedDeletion);
    }
    await captureRollbackOwnedSnapshot(execution);
  }
}

async function rollbackArtifactMutations(
  executions: readonly MutationExecution[],
  options: Pick<UninstallOptions, "transactionFailureInjector" | "transactionTemporaryPath"> & UninstallDurabilityOptions,
): Promise<void> {
  const failures: string[] = [];
  const restored: MutationExecution[] = [];
  try {
    await assertRollbackTransactionState(executions);
  } catch (error) {
    failures.push(`recovery preflight: ${String(error)}`);
  }
  if (failures.length === 0) {
    for (const execution of [...executions].reverse()) {
      if (execution.phase === "prepared") continue;
      try {
        await assertRollbackTransactionState(executions);
        await restoreFileSnapshot(
          execution,
          options,
          () => assertRollbackTransactionState(executions),
        );
        restored.push(execution);
        await assertRollbackTransactionState(executions);
      } catch (error) {
        failures.push(`${execution.mutation.kind}: ${String(error)}`);
      }
    }
  }
  if (failures.length === 0) {
    try {
      await assertRollbackTransactionState(executions);
      await cleanupStagedDeletions(
        restored,
        options,
        "rollback",
        undefined,
        () => assertRollbackTransactionState(executions),
      );
      await assertRollbackTransactionState(executions);
    } catch (error) {
      failures.push(`staged deletion cleanup: ${String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Uninstall artifact rollback failed; manual recovery is required: ${failures.join("; ")}`,
    );
  }
}

async function assertUnmutatedTransactionPreconditions(
  transaction: UninstallArtifactTransaction,
  executions: readonly MutationExecution[],
): Promise<void> {
  const mutatedPaths = new Set(
    executions
      .filter((execution) => execution.phase !== "prepared")
      .map((execution) => execution.mutation.snapshot.path),
  );
  await assertSnapshotsCurrent(
    transaction.preconditions.filter((snapshot) => !mutatedPaths.has(snapshot.path)),
  );
}

async function assertAppliedTransactionSnapshots(
  executions: readonly MutationExecution[],
): Promise<void> {
  for (const execution of executions) {
    if (execution.phase === "prepared") continue;
    if (!execution.appliedSnapshot) {
      throw new Error(`Refusing uninstall because ${execution.mutation.snapshot.path} did not register an applied snapshot.`);
    }
    await assertSnapshotCurrent(execution.appliedSnapshot);
  }
}


async function commitUninstallArtifactTransaction(
  transaction: UninstallArtifactTransaction,
  options: Pick<
    UninstallOptions,
    "transactionFailureInjector" | "transactionTemporaryPath"
  > & UninstallDurabilityOptions,
): Promise<void> {
  const mutations = [transaction.hooks, transaction.shim, transaction.config]
    .filter((mutation): mutation is PlannedFileMutation => mutation !== undefined);
  for (const mutation of mutations) {
    if (mutation.finalContent !== null) mutation.validate?.(mutation.finalContent);
  }
  await assertSnapshotsCurrent(transaction.preconditions);
  if (mutations.length === 0) return;

  const executions: MutationExecution[] = [];
  let stagedCleanupStarted = false;
  try {
    for (const mutation of mutations) {
      await options.transactionFailureInjector?.(mutationStage(mutation.kind));
      await assertUnmutatedTransactionPreconditions(transaction, executions);
      await assertAppliedTransactionSnapshots(executions);
      const execution: MutationExecution = { mutation, phase: "prepared" };
      executions.push(execution);
      await applyFileMutation(execution, executions, options);
      if (mutation.kind === "config") {
        await options.transactionFailureInjector?.("after-config-commit");
      }
      await assertUnmutatedTransactionPreconditions(transaction, executions);
      await assertAppliedTransactionSnapshots(executions);
    }
    await assertUnmutatedTransactionPreconditions(transaction, executions);
    await assertAppliedTransactionSnapshots(executions);
    stagedCleanupStarted = true;
    await cleanupStagedDeletions(executions, options, "commit", transaction);
    await options.transactionFailureInjector?.("after-staged-cleanup");
    await assertUnmutatedTransactionPreconditions(transaction, executions);
    await assertAppliedTransactionSnapshots(executions);
  } catch (error) {
    if (
      stagedCleanupStarted &&
      executions.some((execution) => execution.stagedDeletionCleaned)
    ) {
      throw new Error(
        `Uninstall artifact transaction committed but staged deletion cleanup failed during finalization: ${String(error)}`,
      );
    }
    try {
      await rollbackArtifactMutations(executions, options);
    } catch (rollbackError) {
      throw new Error(
        `Uninstall artifact transaction failed (${String(error)}); ${String(rollbackError)}`,
      );
    }
    throw error;
  }
}

async function removeCacheDirectory(
  projectRoot: string,
  options: Pick<UninstallOptions, "dryRun" | "verbose">,
): Promise<boolean> {
  const omxDir = join(projectRoot, ".omx");
  if (!existsSync(omxDir)) return false;

  if (!options.dryRun) {
    await rm(omxDir, { recursive: true, force: true });
  }
  if (options.verbose)
    console.log(`  ${options.dryRun ? "Would remove" : "Removed"} ${omxDir}`);
  return true;
}

async function detectLegacySkillRootWarning(
  scope: SetupScope,
): Promise<string | null> {
  if (scope !== "user") return null;

  const overlap = await detectLegacySkillRootOverlap();
  if (!overlap.legacyExists || overlap.sameResolvedTarget) {
    return null;
  }

  if (overlap.overlappingSkillNames.length === 0) {
    return (
      `legacy ~/.agents/skills still exists (${overlap.legacySkillCount} skills). ` +
      "omx uninstall does not remove that historical root automatically; " +
      "archive or remove ~/.agents/skills if Codex still shows stale or duplicate skills"
    );
  }

  const mismatchMessage =
    overlap.mismatchedSkillNames.length > 0
      ? `; ${overlap.mismatchedSkillNames.length} differ in SKILL.md content`
      : "";
  return (
    `${overlap.overlappingSkillNames.length} overlapping skill names remain between ` +
    `${overlap.canonicalDir} and ${overlap.legacyDir}${mismatchMessage}. ` +
    "omx uninstall only removes the active canonical skill root; " +
    "archive or remove ~/.agents/skills if Codex still shows duplicates"
  );
}

function printSummary(summary: UninstallSummary, dryRun: boolean): void {
  const prefix = dryRun ? "[dry-run] Would remove" : "Removed";

  console.log("\nUninstall summary:");

  if (summary.configCleaned) {
    console.log(`  ${prefix} OMX configuration block from config.toml`);
    if (summary.mcpServersRemoved.length > 0) {
      console.log(`    MCP servers: ${summary.mcpServersRemoved.join(", ")}`);
    }
    if (summary.agentEntriesRemoved > 0) {
      console.log(`    Agent entries: ${summary.agentEntriesRemoved}`);
    }
    if (summary.tuiSectionRemoved) {
      console.log("    TUI status line section");
    }
    if (summary.topLevelKeysRemoved) {
      console.log(
        "    Top-level keys (notify, model_reasoning_effort, developer_instructions)",
      );
    }
    if (summary.featureFlagsRemoved) {
      console.log(
        "    Feature flags (child_agents_md, goals; multi_agent and hooks are preserved when user-owned)",
      );
    }
  } else if (summary.mcpServersRemoved.length === 0) {
    console.log("  config.toml: no OMX entries found (or --keep-config used)");
  }

  if (summary.hooksFileRemoved) {
    console.log(`  ${prefix} OMX-managed entries in .codex/hooks.json`);
  }

  if (summary.promptsRemoved > 0) {
    console.log(`  ${prefix} ${summary.promptsRemoved} agent prompt(s)`);
  }
  if (summary.skillsRemoved > 0) {
    console.log(`  ${prefix} ${summary.skillsRemoved} skill(s)`);
  }
  if (summary.agentConfigsRemoved > 0) {
    console.log(
      `  ${prefix} ${summary.agentConfigsRemoved} native agent config(s)`,
    );
  }
  if (summary.agentsMdRemoved) {
    console.log(`  ${prefix} AGENTS.md`);
  }
  if (summary.cacheDirectoryRemoved) {
    console.log(`  ${prefix} .omx/ cache directory`);
  }
  if (summary.legacySkillRootWarning) {
    console.log(`  Warning: ${summary.legacySkillRootWarning}`);
  }

  const totalActions =
    (summary.configCleaned ? 1 : 0) +
    (summary.hooksFileRemoved ? 1 : 0) +
    summary.promptsRemoved +
    summary.skillsRemoved +
    summary.agentConfigsRemoved +
    (summary.agentsMdRemoved ? 1 : 0) +
    (summary.cacheDirectoryRemoved ? 1 : 0);

  if (totalActions === 0) {
    console.log(
      "  Nothing to remove. oh-my-codex does not appear to be installed.",
    );
  }
}

export async function uninstall(options: UninstallOptions = {}): Promise<void> {
  const {
    dryRun = false,
    keepConfig = false,
    verbose = false,
    purge = false,
  } = options;

  const projectRoot = process.cwd();
  const pkgRoot = getPackageRoot();

  // Resolve scope (explicit --scope overrides persisted scope)
  const scope = options.scope ?? readPersistedSetupScope(projectRoot) ?? "user";
  const scopeDirs = resolveScopeDirectories(scope, projectRoot);
  if (!dryRun) {
    const recoveryTracker: RegularFileDurabilityTracker = { degraded: false };
    const recovery = await recoverNativeHookClaimJournal(
      scopeDirs.codexHomeDir,
      uninstallClaimJournalDurabilityOverride
        ?? createNativeHookClaimJournalDurability(options.transactionPlatform ?? process.platform),
    );
    recordRegularFileSyncOutcome(recoveryTracker, recovery.outcome);
    emitDegradedDurabilityWarning("native-hook claim-journal recovery", recoveryTracker);
  }
  const transactionPlatform = options.transactionPlatform ?? process.platform;

  // Precompute and validate every artifact before the first uninstall write.
  const hooksSnapshot = await readFileSnapshot(scopeDirs.codexHooksFile, {
    controlledRoot: scopeDirs.codexHomeDir,
  });
  const configSnapshot = await readFileSnapshot(scopeDirs.codexConfigFile, {
    controlledRoot: scopeDirs.codexHomeDir,
  });
  const hooksRemoval = await planHooksRemoval(
    hooksSnapshot,
    pkgRoot,
    transactionPlatform,
    scopeDirs.codexHomeDir,
  );
  const notifyMetadata = keepConfig
    ? undefined
    : await planNotifyMetadata(configSnapshot, scopeDirs.codexHomeDir);
  const preserveHooksFeatureFlag = hooksRemoval.plan?.hasForeignHooks ?? false;
  const configCleanup = keepConfig
    ? undefined
    : await planConfigCleanup(
        configSnapshot,
        {
          preserveHooksFeatureFlag,
          priorHookTrustState: hooksRemoval.plan?.priorTrustState,
          finalHookTrustState: hooksRemoval.plan?.finalTrustState,
          notifyMetadata,
          codexFeaturesProbe: options.codexFeaturesProbe,
          codexVersionProbe: options.codexVersionProbe,
        },
      );
  const artifactTransaction: UninstallArtifactTransaction = {
    preconditions: [
      hooksRemoval.hooks,
      ...(hooksRemoval.shim
        ? [hooksRemoval.shim]
        : hooksRemoval.preservedShimPrecondition
          ? [hooksRemoval.preservedShimPrecondition]
          : []),
      configSnapshot,
      ...(notifyMetadata ? [notifyMetadata.snapshot] : []),
    ],
    ...(hooksRemoval.plan?.changed
      ? {
          hooks: {
            kind: "hooks",
            snapshot: hooksRemoval.hooks,
            finalContent: hooksRemoval.plan.finalContent,
            validate: assertValidHooksJson,
          },
        }
      : {}),
    ...(hooksRemoval.shim !== undefined && hooksRemoval.shim.bytes !== null
      ? {
          shim: {
            kind: "shim",
            snapshot: hooksRemoval.shim,
            finalContent: null,
          },
        }
      : {}),
    ...(configCleanup?.result.configCleaned && configCleanup.finalContent !== null
      ? {
          config: {
            kind: "config",
            snapshot: configCleanup.config,
            finalContent: configCleanup.finalContent,
            validate: assertValidToml,
          },
        }
      : {}),
  };

  console.log("oh-my-codex uninstall");
  console.log("=====================\n");
  if (dryRun) {
    console.log("[dry-run mode] No files will be modified.\n");
  }
  console.log(`Resolved scope: ${scope}\n`);

  const summary: UninstallSummary = {
    configCleaned: false,
    mcpServersRemoved: [],
    agentEntriesRemoved: 0,
    tuiSectionRemoved: false,
    topLevelKeysRemoved: false,
    featureFlagsRemoved: false,
    hooksFileRemoved: false,
    promptsRemoved: 0,
    skillsRemoved: 0,
    agentConfigsRemoved: 0,
    agentsMdRemoved: false,
    cacheDirectoryRemoved: false,
    legacySkillRootWarning: null,
  };

  summary.legacySkillRootWarning = await detectLegacySkillRootWarning(scope);
  summary.hooksFileRemoved =
    artifactTransaction.hooks !== undefined || artifactTransaction.shim !== undefined;
  if (configCleanup) Object.assign(summary, configCleanup.result);

  // Hooks, proof-owned shim, and config are one compensating transaction. The
  // config mutation is intentionally last so hooks never reference unwritten trust.
  console.log("[1/6] Removing native hooks artifact...");
  if (!keepConfig) console.log("[2/6] Cleaning config.toml...");
  if (!dryRun) {
    const mutationTracker: RegularFileDurabilityTracker = { degraded: false };
    await commitUninstallArtifactTransaction(artifactTransaction, {
      transactionFailureInjector: options.transactionFailureInjector,
      transactionTemporaryPath: options.transactionTemporaryPath,
      transactionPlatform,
      regularFileSyncForTest: options.regularFileSyncForTest,
      durabilityTracker: mutationTracker,
    });
    emitDegradedDurabilityWarning("native-hook uninstall", mutationTracker);
  }
  if (verbose) {
    if (artifactTransaction.hooks) {
      console.log(
        `  ${dryRun ? "Would clean" : artifactTransaction.hooks.finalContent === null ? "Removed" : "Cleaned"} ${basename(scopeDirs.codexHooksFile)}`,
      );
    }
    if (artifactTransaction.shim) {
      console.log(
        `  ${dryRun ? "Would remove" : "Removed"} ${basename(artifactTransaction.shim.snapshot.path)}`,
      );
    }
  }
  console.log(
    `  ${dryRun ? "Would clean" : "Cleaned"} ${summary.hooksFileRemoved ? 1 : 0} hooks artifact(s).`,
  );
  console.log();

  // Step 2: config cleanup is calculated before Step 1 and committed last.
  if (keepConfig) {
    console.log("[2/6] Skipping config.toml cleanup (--keep-config).");
  } else if (verbose) {
    if (configCleanup?.config.content === null) {
      console.log("  config.toml not found, skipping.");
    } else if (configCleanup?.result.configCleaned) {
      console.log(`  ${dryRun ? "Would clean" : "Cleaned"} ${scopeDirs.codexConfigFile}`);
    } else {
      console.log("  No OMX config entries found.");
    }
  }
  console.log();

  // Step 3: Remove installed prompts
  console.log("[3/6] Removing agent prompts...");
  summary.promptsRemoved = await removeInstalledPrompts(
    scopeDirs.promptsDir,
    pkgRoot,
    { dryRun, verbose },
  );
  console.log(
    `  ${dryRun ? "Would remove" : "Removed"} ${summary.promptsRemoved} prompt(s).`,
  );
  console.log();

  // Step 4: Remove native agent configs
  console.log("[4/6] Removing native agent configs...");
  summary.agentConfigsRemoved = await removeAgentConfigs(
    scopeDirs.nativeAgentsDir,
    { dryRun, verbose },
  );
  console.log(
    `  ${dryRun ? "Would remove" : "Removed"} ${summary.agentConfigsRemoved} agent config(s).`,
  );
  console.log();

  // Step 5: Remove installed skills
  console.log("[5/6] Removing skills...");
  summary.skillsRemoved = await removeInstalledSkills(
    scopeDirs.skillsDir,
    pkgRoot,
    { dryRun, verbose },
  );
  console.log(
    `  ${dryRun ? "Would remove" : "Removed"} ${summary.skillsRemoved} skill(s).`,
  );
  console.log();

  // Step 6: Remove AGENTS.md and optionally .omx/ cache directory
  console.log("[6/6] Cleaning up...");
  const agentsMdPath =
    scope === "project"
      ? join(projectRoot, "AGENTS.md")
      : join(scopeDirs.codexHomeDir, "AGENTS.md");
  summary.agentsMdRemoved = await removeAgentsMd(agentsMdPath, {
    dryRun,
    verbose,
  });
  if (purge) {
    summary.cacheDirectoryRemoved = await removeCacheDirectory(projectRoot, {
      dryRun,
      verbose,
    });
  } else {
    // Always clean up setup-scope.json and hud-config.json
    const scopeFile = join(projectRoot, ".omx", "setup-scope.json");
    const hudConfig = join(projectRoot, ".omx", "hud-config.json");
    for (const f of [scopeFile, hudConfig]) {
      if (existsSync(f)) {
        if (!dryRun) await rm(f, { force: true });
        if (verbose)
          console.log(
            `  ${dryRun ? "Would remove" : "Removed"} ${basename(f)}`,
          );
      }
    }
  }
  console.log();

  printSummary(summary, dryRun);

  if (!dryRun) {
    console.log(
      '\noh-my-codex has been uninstalled. Run "omx setup" to reinstall.',
    );
  } else {
    console.log("\nRun without --dry-run to apply changes.");
  }
}
