import { createHash } from "crypto";
import { readdir, realpath } from "fs/promises";
import { basename, join, relative, resolve, win32 } from "path";

export const MANAGED_HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "PreCompact",
  "PostCompact",
  "Stop",
] as const;

type ManagedHookEventName = (typeof MANAGED_HOOK_EVENTS)[number];

type JsonObject = Record<string, unknown>;

export interface ManagedHookEntry {
  matcher?: string;
  hooks: Array<{
    type: "command";
    command: string;
    statusMessage?: string;
    timeout?: number;
  }>;
}

export interface ManagedCodexHooksConfig {
  hooks: Record<ManagedHookEventName, ManagedHookEntry[]>;
}

interface ParsedCodexHooksConfig {
  root: JsonObject;
  hooks: JsonObject;
}

export interface RemoveManagedCodexHooksResult {
  nextContent: string | null;
  removedCount: number;
}

export interface ManagedCodexHookTrustState {
  trusted_hash: string;
}

export interface DedupedCodexHookConfigPath {
  path: string;
  reason: "unique";
}

export interface SkippedCodexHookConfigPath {
  path: string;
  reason: "runtime_codex_home_mirror" | "duplicate_realpath";
  canonicalPath?: string;
}

export interface DiscoverCodexHookConfigPathsOptions {
  maxFiles?: number;
}

const CODEX_HOOK_EVENT_LABELS: Record<ManagedHookEventName, string> = {
  SessionStart: "session_start",
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use",
  UserPromptSubmit: "user_prompt_submit",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  Stop: "stop",
};

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

type HookCommandPlatform = NodeJS.Platform;

function quoteCommandPart(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeTomlBasicString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function quoteWindowsCommandPart(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function buildManagedCodexNativeHookCommand(
  pkgRoot: string,
  platform: HookCommandPlatform = process.platform,
): string {
  const hookScript = platform === "win32"
    ? win32.join(pkgRoot, "dist", "scripts", "codex-native-hook.js")
    : join(pkgRoot, "dist", "scripts", "codex-native-hook.js");

  if (platform === "win32") {
    return `node ${quoteWindowsCommandPart(hookScript)}`;
  }

  return `${quoteCommandPart(process.execPath)} ${quoteCommandPart(hookScript)}`;
}

function buildCommandHook(
  command: string,
  options: {
    matcher?: string;
    statusMessage?: string;
    timeout?: number;
  } = {},
): ManagedHookEntry {
  const hook = {
    type: "command",
    command,
    ...(options.statusMessage ? { statusMessage: options.statusMessage } : {}),
    ...(typeof options.timeout === "number" ? { timeout: options.timeout } : {}),
  } satisfies ManagedHookEntry["hooks"][number];

  return {
    ...(options.matcher ? { matcher: options.matcher } : {}),
    hooks: [hook],
  };
}

export function buildManagedCodexHooksConfig(
  pkgRoot: string,
  options: { platform?: HookCommandPlatform } = {},
): ManagedCodexHooksConfig {
  const command = buildManagedCodexNativeHookCommand(pkgRoot, options.platform);

  return {
    hooks: {
      SessionStart: [
        buildCommandHook(command, {
          matcher: "startup|resume|clear",
        }),
      ],
      PreToolUse: [
        buildCommandHook(command, {
          matcher: "Bash",
        }),
      ],
      PostToolUse: [
        buildCommandHook(command),
      ],
      UserPromptSubmit: [
        buildCommandHook(command),
      ],
      PreCompact: [
        buildCommandHook(command),
      ],
      PostCompact: [
        buildCommandHook(command),
      ],
      Stop: [
        buildCommandHook(command, {
          timeout: 30,
        }),
      ],
    },
  };
}

export function parseCodexHooksConfig(
  content: string,
): ParsedCodexHooksConfig | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isPlainObject(parsed)) return null;

    return {
      root: cloneJson(parsed),
      hooks: isPlainObject(parsed.hooks) ? cloneJson(parsed.hooks) : {},
    };
  } catch {
    return null;
  }
}

function isOmxManagedHookCommand(command: string): boolean {
  return /(?:^|[\\/])codex-native-hook\.js(?:["'\s]|$)/.test(command);
}

function countManagedHooksInEntry(entry: unknown): number {
  if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) {
    return 0;
  }

  return entry.hooks.filter((hook) => {
    return isPlainObject(hook)
      && hook.type === "command"
      && typeof hook.command === "string"
      && isOmxManagedHookCommand(hook.command);
  }).length;
}

export function getMissingManagedCodexHookEvents(
  content: string,
): ManagedHookEventName[] | null {
  const parsed = parseCodexHooksConfig(content);
  if (!parsed) return null;

  return MANAGED_HOOK_EVENTS.filter((eventName) => {
    const entries = Array.isArray(parsed.hooks[eventName])
      ? parsed.hooks[eventName]
      : [];
    return !entries.some((entry) => countManagedHooksInEntry(entry) > 0);
  });
}

export function getManagedCodexHookCommandsForEvent(
  content: string,
  eventName: ManagedHookEventName,
): string[] | null {
  const parsed = parseCodexHooksConfig(content);
  if (!parsed) return null;

  const entries = Array.isArray(parsed.hooks[eventName])
    ? parsed.hooks[eventName]
    : [];
  const commands: string[] = [];

  for (const entry of entries) {
    if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (
        isPlainObject(hook) &&
        hook.type === "command" &&
        typeof hook.command === "string" &&
        isOmxManagedHookCommand(hook.command)
      ) {
        commands.push(hook.command);
      }
    }
  }

  return commands;
}

function stripManagedHooksFromEntry(entry: unknown): {
  entry: unknown | null;
  removedCount: number;
} {
  if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) {
    return { entry: cloneJson(entry), removedCount: 0 };
  }

  const nextHooks = entry.hooks.filter((hook) => {
    if (!isPlainObject(hook)) return true;
    return !(
      hook.type === "command" &&
      typeof hook.command === "string" &&
      isOmxManagedHookCommand(hook.command)
    );
  });

  const removedCount = entry.hooks.length - nextHooks.length;
  if (removedCount === 0) {
    return { entry: cloneJson(entry), removedCount: 0 };
  }

  if (nextHooks.length === 0) {
    return { entry: null, removedCount };
  }

  return {
    entry: {
      ...cloneJson(entry),
      hooks: nextHooks,
    },
    removedCount,
  };
}

function serializeCodexHooksConfig(root: JsonObject): string {
  return JSON.stringify(root, null, 2) + "\n";
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalJson(item));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function versionForCodexTomlIdentity(value: JsonObject): string {
  const canonical = canonicalJson(value);
  const serialized = JSON.stringify(canonical);
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

function normalizedCommandHookIdentity(
  eventName: ManagedHookEventName,
  entry: ManagedHookEntry,
  hook: ManagedHookEntry["hooks"][number],
): JsonObject {
  return {
    event_name: CODEX_HOOK_EVENT_LABELS[eventName],
    ...(entry.matcher ? { matcher: entry.matcher } : {}),
    hooks: [
      {
        type: "command",
        command: hook.command,
        timeout: Math.max(1, hook.timeout ?? 600),
        async: false,
        ...(hook.statusMessage ? { statusMessage: hook.statusMessage } : {}),
      },
    ],
  };
}

function managedHookStateKey(
  hooksPath: string,
  eventName: ManagedHookEventName,
  groupIndex: number,
  handlerIndex: number,
): string {
  return `${hooksPath}:${CODEX_HOOK_EVENT_LABELS[eventName]}:${groupIndex}:${handlerIndex}`;
}

export function buildManagedCodexHookTrustState(
  hooksPath: string,
  pkgRoot: string,
  options: { platform?: HookCommandPlatform } = {},
): Record<string, ManagedCodexHookTrustState> {
  const managedConfig = buildManagedCodexHooksConfig(pkgRoot, options);
  const state: Record<string, ManagedCodexHookTrustState> = {};

  for (const eventName of MANAGED_HOOK_EVENTS) {
    const entries = managedConfig.hooks[eventName] as ManagedHookEntry[];
    entries.forEach((entry, groupIndex) => {
      entry.hooks.forEach((hook, handlerIndex) => {
        if (hook.type !== "command" || !isOmxManagedHookCommand(hook.command)) {
          return;
        }
        const key = managedHookStateKey(
          hooksPath,
          eventName,
          groupIndex,
          handlerIndex,
        );
        state[key] = {
          trusted_hash: versionForCodexTomlIdentity(
            normalizedCommandHookIdentity(eventName, entry, hook),
          ),
        };
      });
    });
  }

  return state;
}

export function buildManagedCodexHookTrustToml(
  hooksPath: string | undefined,
  pkgRoot: string,
  options: { platform?: HookCommandPlatform } = {},
): string {
  if (!hooksPath) return "";
  const state = buildManagedCodexHookTrustState(hooksPath, pkgRoot, options);
  return Object.entries(state)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, hookState]) => [
      `[hooks.state."${escapeTomlBasicString(key)}"]`,
      `trusted_hash = "${escapeTomlBasicString(hookState.trusted_hash)}"`,
      "",
    ])
    .join("\n")
    .trimEnd();
}

function pathSegments(filePath: string): string[] {
  return filePath.split(/[\\/]+/).filter(Boolean);
}

export function isRuntimeCodexHomeMirrorPath(
  hookConfigPath: string,
  cwd: string = process.cwd(),
): boolean {
  if (basename(hookConfigPath) !== "hooks.json") return false;

  const absolutePath = resolve(cwd, hookConfigPath);
  const relativePath = relative(resolve(cwd), absolutePath);
  const segments = pathSegments(relativePath);
  if (relativePath === "" || segments[0] === "..") {
    return false;
  }

  const omxIndex = segments.indexOf(".omx");
  if (omxIndex < 0) return false;

  return (
    segments[omxIndex + 1] === "runtime" &&
    segments[omxIndex + 2] === "codex-home" &&
    segments.length > omxIndex + 4 &&
    segments[segments.length - 1] === "hooks.json"
  );
}

export async function dedupeCodexHookConfigPaths(
  hookConfigPaths: readonly string[],
  cwd: string = process.cwd(),
): Promise<{
  paths: DedupedCodexHookConfigPath[];
  skipped: SkippedCodexHookConfigPath[];
}> {
  const seenRealpaths = new Set<string>();
  const paths: DedupedCodexHookConfigPath[] = [];
  const skipped: SkippedCodexHookConfigPath[] = [];

  for (const hookConfigPath of hookConfigPaths) {
    if (isRuntimeCodexHomeMirrorPath(hookConfigPath, cwd)) {
      skipped.push({
        path: hookConfigPath,
        reason: "runtime_codex_home_mirror",
      });
      continue;
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(hookConfigPath);
    } catch {
      canonicalPath = resolve(cwd, hookConfigPath);
    }

    if (seenRealpaths.has(canonicalPath)) {
      skipped.push({
        path: hookConfigPath,
        reason: "duplicate_realpath",
        canonicalPath,
      });
      continue;
    }

    seenRealpaths.add(canonicalPath);
    paths.push({ path: hookConfigPath, reason: "unique" });
  }

  return { paths, skipped };
}

const DEFAULT_DISCOVER_HOOK_CONFIG_MAX_FILES = 5_000;
const DISCOVER_HOOK_CONFIG_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "target",
]);

export async function discoverCodexHookConfigPaths(
  cwd: string = process.cwd(),
  options: DiscoverCodexHookConfigPathsOptions = {},
): Promise<{
  paths: DedupedCodexHookConfigPath[];
  skipped: SkippedCodexHookConfigPath[];
}> {
  const root = resolve(cwd);
  const maxFiles = options.maxFiles ?? DEFAULT_DISCOVER_HOOK_CONFIG_MAX_FILES;
  const pending = [root];
  const candidates: string[] = [];
  let visitedFiles = 0;

  while (pending.length > 0 && visitedFiles < maxFiles) {
    const dir = pending.pop()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!DISCOVER_HOOK_CONFIG_EXCLUDED_DIRS.has(entry.name)) {
          pending.push(fullPath);
        }
        continue;
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      visitedFiles += 1;
      if (entry.name === "hooks.json") candidates.push(fullPath);
      if (visitedFiles >= maxFiles) break;
    }
  }

  return dedupeCodexHookConfigPaths(candidates, root);
}

export function mergeManagedCodexHooksConfig(
  existingContent: string | null | undefined,
  pkgRoot: string,
  hooksPathOrOptions?: string | { platform?: HookCommandPlatform },
  options: { platform?: HookCommandPlatform } = {},
): string {
  const hooksPath = typeof hooksPathOrOptions === "string" ? hooksPathOrOptions : undefined;
  const resolvedOptions = typeof hooksPathOrOptions === "object" && hooksPathOrOptions !== null
    ? hooksPathOrOptions
    : options;
  const managedConfig = buildManagedCodexHooksConfig(pkgRoot, resolvedOptions);
  const parsed =
    typeof existingContent === "string"
      ? parseCodexHooksConfig(existingContent)
      : null;

  const nextRoot = parsed ? cloneJson(parsed.root) : {};
  const nextHooks = parsed ? cloneJson(parsed.hooks) : {};
  const misplacedHookState = isPlainObject(nextHooks.state)
    ? cloneJson(nextHooks.state)
    : {};
  delete nextHooks.state;

  for (const eventName of MANAGED_HOOK_EVENTS) {
    const existingEntries = Array.isArray(nextHooks[eventName])
      ? nextHooks[eventName]
      : [];
    const preservedEntries: unknown[] = [];

    for (const entry of existingEntries) {
      const stripped = stripManagedHooksFromEntry(entry);
      if (stripped.entry !== null) {
        preservedEntries.push(stripped.entry);
      }
    }

    nextHooks[eventName] = [
      ...preservedEntries,
      ...managedConfig.hooks[eventName].map((entry) => cloneJson(entry)),
    ];
  }

  const existingRootState = isPlainObject(nextRoot.state)
    ? cloneJson(nextRoot.state)
    : {};
  const nextState = {
    ...misplacedHookState,
    ...existingRootState,
  };

  const managedTrustState = hooksPath
    ? buildManagedCodexHookTrustState(hooksPath, pkgRoot, resolvedOptions)
    : {};
  for (const [key, hookState] of Object.entries(managedTrustState)) {
    const existingHookState = isPlainObject(nextState[key])
      ? nextState[key]
      : {};
    nextState[key] = {
      ...existingHookState,
      trusted_hash: hookState.trusted_hash,
    };
  }
  if (Object.keys(nextState).length > 0) {
    nextRoot.state = nextState;
  } else if (isPlainObject(nextRoot.state)) {
    delete nextRoot.state;
  }

  if (Object.keys(nextHooks).length > 0) {
    nextRoot.hooks = nextHooks;
  } else {
    delete nextRoot.hooks;
  }

  return serializeCodexHooksConfig(nextRoot);
}

export function removeManagedCodexHooks(
  existingContent: string,
): RemoveManagedCodexHooksResult {
  const parsed = parseCodexHooksConfig(existingContent);
  if (!parsed) {
    return { nextContent: existingContent, removedCount: 0 };
  }

  const nextRoot = cloneJson(parsed.root);
  const nextHooks = cloneJson(parsed.hooks);
  const misplacedHookState = isPlainObject(nextHooks.state)
    ? cloneJson(nextHooks.state)
    : {};
  delete nextHooks.state;
  let removedCount = 0;

  for (const [eventName, rawEntries] of Object.entries(nextHooks)) {
    if (!Array.isArray(rawEntries)) continue;

    const preservedEntries: unknown[] = [];
    for (const entry of rawEntries) {
      const stripped = stripManagedHooksFromEntry(entry);
      removedCount += stripped.removedCount;
      if (stripped.entry !== null) {
        preservedEntries.push(stripped.entry);
      }
    }

    if (preservedEntries.length > 0) {
      nextHooks[eventName] = preservedEntries;
    } else {
      delete nextHooks[eventName];
    }
  }

  if (removedCount === 0) {
    return { nextContent: existingContent, removedCount: 0 };
  }

  const hasRemainingHookEntries = Object.keys(nextHooks).length > 0;
  if (hasRemainingHookEntries) {
    const existingRootState = isPlainObject(nextRoot.state)
      ? cloneJson(nextRoot.state)
      : {};
    const nextState = {
      ...misplacedHookState,
      ...existingRootState,
    };
    if (Object.keys(nextState).length > 0) {
      nextRoot.state = nextState;
    } else if (isPlainObject(nextRoot.state)) {
      delete nextRoot.state;
    }
  } else {
    delete nextRoot.state;
  }

  if (hasRemainingHookEntries) {
    nextRoot.hooks = nextHooks;
  } else {
    delete nextRoot.hooks;
  }

  if (Object.keys(nextRoot).length === 0) {
    return { nextContent: null, removedCount };
  }

  return {
    nextContent: serializeCodexHooksConfig(nextRoot),
    removedCount,
  };
}

export function hasCodexHookEntries(content: string): boolean {
  const parsed = parseCodexHooksConfig(content);
  if (!parsed) return false;

  return Object.entries(parsed.hooks).some(([eventName, rawEntries]) => {
    if (eventName === "state" || !Array.isArray(rawEntries)) return false;
    return rawEntries.some((entry) => {
      return isPlainObject(entry) &&
        Array.isArray(entry.hooks) &&
        entry.hooks.length > 0;
    });
  });
}

export function hasUserCodexHooksAfterManagedRemoval(
  existingContent: string,
): boolean {
  const { nextContent } = removeManagedCodexHooks(existingContent);
  return nextContent !== null && hasCodexHookEntries(nextContent);
}
