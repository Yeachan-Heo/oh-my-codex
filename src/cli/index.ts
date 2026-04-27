/**
 * oh-my-codex CLI
 * Multi-agent orchestration for OpenAI Codex CLI
 */

import { execFileSync, spawn } from "child_process";
import { basename, dirname, join } from "path";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { constants as osConstants } from "os";
import { setup, SETUP_SCOPES, type SetupInstallMode, type SetupScope } from "./setup.js";
import { uninstall } from "./uninstall.js";
import { version } from "./version.js";
import { tmuxHookCommand } from "./tmux-hook.js";
import { hooksCommand } from "./hooks.js";
import { hudCommand } from "../hud/index.js";
import { sidecarCommand } from "../sidecar/index.js";
import { teamCommand } from "./team.js";
import { ralphCommand } from "./ralph.js";
import { askCommand } from "./ask.js";
import { questionCommand } from "./question.js";
import { stateCommand } from "./state.js";
import {
  cleanupCommand,
  cleanupOmxMcpProcesses,
  findLaunchSafeCleanupCandidates,
  type CleanupDependencies,
  type CleanupResult,
} from "./cleanup.js";
import { exploreCommand } from "./explore.js";
import { sparkshellCommand } from "./sparkshell.js";
import { agentsInitCommand } from "./agents-init.js";
import { agentsCommand } from "./agents.js";
import { sessionCommand } from "./session-search.js";
import { autoresearchCommand } from "./autoresearch.js";
import { mcpParityCommand } from "./mcp-parity.js";
import { mcpServeCommand } from "./mcp-serve.js";
import { adaptCommand } from "./adapt.js";
import { listCommand } from "./list.js";
import {
  MADMAX_FLAG,
  CODEX_BYPASS_FLAG,
  HIGH_REASONING_FLAG,
  XHIGH_REASONING_FLAG,
  SPARK_FLAG,
  MADMAX_SPARK_FLAG,
  CONFIG_FLAG,
  LONG_CONFIG_FLAG,
} from "./constants.js";
import {
  getBaseStateDir,
  getStateDir,
  listModeStateFilesWithScopePreference,
} from "../mcp/state-paths.js";
import {
  resolveCodexConfigPathForLaunch,
  resolveCodexHomeForLaunch,
} from "./codex-home.js";

export {
  readPersistedSetupPreferences,
  readPersistedSetupScope,
  resolveCodexConfigPathForLaunch,
  resolveCodexHomeForLaunch,
} from "./codex-home.js";
import { SKILL_ACTIVE_STATE_MODE, syncCanonicalSkillStateForMode } from "../state/skill-active.js";
import { isTrackedWorkflowMode } from "../state/workflow-transition.js";
import { maybeCheckAndPromptUpdate, runImmediateUpdate } from "./update.js";
import { maybePromptGithubStar } from "./star-prompt.js";
import {
  generateOverlay,
  removeSessionModelInstructionsFile,
  resolveSessionOrchestrationMode,
  sessionModelInstructionsPath,
  writeSessionModelInstructionsFile,
} from "../hooks/agents-overlay.js";
import {
  readSessionState,
  writeSessionStart,
  writeSessionEnd,
  resetSessionMetrics,
} from "../hooks/session.js";
import {
  buildClientAttachedReconcileHookName,
  buildReconcileHudResizeArgs,
  buildRegisterClientAttachedReconcileArgs,
  buildRegisterResizeHookArgs,
  buildResizeHookName,
  buildResizeHookTarget,
  buildScheduleDelayedHudResizeArgs,
  buildUnregisterClientAttachedReconcileArgs,
  buildUnregisterResizeHookArgs,
  enableMouseScrolling,
  isMsysOrGitBash,
  isNativeWindows,
  isTmuxAvailable,
  mitigateCopyModeUnderlineArtifacts,
} from "../team/tmux-session.js";
import { getPackageRoot } from "../utils/package.js";
import { codexConfigPath, rememberOmxLaunchContext, resolveOmxEntryPath } from "../utils/paths.js";
import { repairConfigIfNeeded } from "../config/generator.js";
import { HUD_TMUX_HEIGHT_LINES } from "../hud/constants.js";
import {
  createHudWatchPane as createSharedHudWatchPane,
  killTmuxPane as killSharedTmuxPane,
  listCurrentWindowHudPaneIds,
  parsePaneIdFromTmuxOutput,
} from "../hud/tmux.js";

export { parseTmuxPaneSnapshot, isHudWatchPane, findHudWatchPaneIds } from "../hud/tmux.js";

rememberOmxLaunchContext();
import {
  classifySpawnError,
  resolveTmuxBinaryForPlatform,
  spawnPlatformCommandSync,
} from "../utils/platform-command.js";
import { buildHookEvent } from "../hooks/extensibility/events.js";
import { dispatchHookEvent } from "../hooks/extensibility/dispatcher.js";
import {
  collectInheritableTeamWorkerArgs as collectInheritableTeamWorkerArgsShared,
  resolveTeamWorkerLaunchArgs,
  resolveTeamLowComplexityDefaultModel,
} from "../team/model-contract.js";
import {
  parseWorktreeMode,
  planWorktreeTarget,
  ensureWorktree,
} from "../team/worktree.js";
import { ensureReusableNodeModules } from "../utils/repo-deps.js";
import {
  OMX_NOTIFY_TEMP_CONTRACT_ENV,
  parseNotifyTempContractFromArgs,
  serializeNotifyTempContract,
  type NotifyTempContract,
  type ParseNotifyTempContractResult,
} from "../notifications/temp-contract.js";

export function resolveNotifyFallbackWatcherScript(pkgRoot = getPackageRoot()): string {
  return resolveDistScript(pkgRoot, "notify-fallback-watcher.js");
}

export function resolveHookDerivedWatcherScript(pkgRoot = getPackageRoot()): string {
  return resolveDistScript(pkgRoot, "hook-derived-watcher.js");
}

export function resolveNotifyHookScript(pkgRoot = getPackageRoot()): string {
  return resolveDistScript(pkgRoot, "notify-hook.js");
}

function resolveDistScript(pkgRoot: string, scriptName: string): string {
  return join(pkgRoot, "dist", "scripts", scriptName);
}

export const HELP = `
oh-my-codex (omx) - Multi-agent orchestration for Codex CLI

Usage:
  omx           Launch Codex CLI (HUD auto-attaches only when already inside tmux)
  omx exec      Run codex exec non-interactively with OMX AGENTS/overlay injection
  omx setup     Install skills, prompts, MCP servers, and scope-specific AGENTS.md
                (user scope prompts for legacy vs plugin skill delivery when needed)
  omx update    Check npm now, update the global install immediately, then refresh setup
  omx uninstall Remove OMX configuration and clean up installed artifacts
  omx doctor    Check installation health
  omx list      List packaged OMX skills and native agent prompts (--json)
  omx cleanup   Kill orphaned OMX MCP server processes and remove stale OMX /tmp directories
  omx doctor --team  Check team/swarm runtime health diagnostics
  omx ask       Ask local provider CLI (claude|gemini) and write artifact output
  omx question  OMX-owned blocking question UI entrypoint for agent-invoked user questions
  omx adapt     Scaffold OMX-owned adapter foundations for persistent external targets
  omx resume    Resume a previous interactive Codex session
  omx explore   Default read-only exploration entrypoint (may adaptively use sparkshell backend)
  omx session   Search prior local session transcripts and history artifacts
  omx agents-init [path]
                Bootstrap lightweight AGENTS.md files for a repo/subtree
  omx agents    Manage Codex native agent TOML files
  omx deepinit [path]
                Alias for agents-init (lightweight AGENTS bootstrap only)
  omx team      Spawn parallel worker panes in tmux and bootstrap inbox/task state
  omx ralph     Launch Codex with ralph persistence mode active
  omx autoresearch [DEPRECATED] Use $autoresearch; direct CLI launch removed
  omx version   Show version information
  omx tmux-hook Manage tmux prompt injection workaround (init|status|validate|test)
  omx hooks     Manage hook plugins (init|status|validate|test)
  omx hud       Show HUD statusline (--watch, --json, --preset=NAME)
  omx sidecar   Show read-only team/multi-agent visualization (--watch, --json, --tmux)
  omx state     Read/write/list OMX mode state via CLI parity surface
  omx notepad   CLI parity for OMX notepad MCP tools
  omx project-memory
                CLI parity for OMX project-memory MCP tools
  omx trace     CLI parity for OMX trace MCP tools
  omx code-intel
                CLI parity for OMX code-intel MCP tools
  omx wiki      CLI parity for OMX wiki MCP tools
  omx mcp-serve Launch an OMX stdio MCP server target (plugin/runtime use)
  omx sparkshell <command> [args...]
  omx sparkshell --tmux-pane <pane-id> [--tail-lines <100-1000>]
                Run native sparkshell sidecar for direct command execution or explicit tmux-pane summarization
                (also used as an adaptive backend for qualifying read-only explore tasks)
  omx help      Show this help message
  omx status    Show active modes and state
  omx cancel    Cancel active execution modes
  omx reasoning Show or set model reasoning effort (low|medium|high|xhigh)

Options:
  --yolo        Launch Codex in yolo mode (shorthand for: omx launch --yolo)
  --high        Launch Codex with high reasoning effort
                (shorthand for: -c model_reasoning_effort="high")
  --xhigh       Launch Codex with xhigh reasoning effort
                (shorthand for: -c model_reasoning_effort="xhigh")
  --madmax      DANGEROUS: bypass Codex approvals and sandbox
                (alias for --dangerously-bypass-approvals-and-sandbox)
  --spark       Use the Codex spark model (~1.3x faster) for team workers only
                Workers get the configured low-complexity team model; leader model unchanged
  --madmax-spark  spark model for workers + bypass approvals for leader and workers
                (shorthand for: --spark --madmax)
  --notify-temp  Enable temporary notification routing for this run/session only
  --tmux         Launch the interactive leader session in detached tmux
  --discord      Select Discord provider for temporary notification mode
  --slack        Select Slack provider for temporary notification mode
  --telegram     Select Telegram provider for temporary notification mode
  --custom <name>
                Select custom/OpenClaw gateway name for temporary notification mode
  -w, --worktree[=<name>]
                Launch Codex in a git worktree (detached when no name is given)
  --force       Force reinstall (overwrite existing files)
  --merge-agents
                Merge OMX-managed AGENTS.md sections into an existing AGENTS.md
                instead of overwriting user-authored content
  --dry-run     Show what would be done without doing it
  --plugin      Use Codex plugin delivery for omx setup and remove legacy OMX-managed user/project components
  --keep-config Skip config.toml cleanup during uninstall
  --purge       Remove .omx/ cache directory during uninstall
  --verbose     Show detailed output
  --scope       Setup scope for "omx setup" only:
                user | project
`;

const REASONING_KEY = "model_reasoning_effort";
const MODEL_INSTRUCTIONS_FILE_KEY = "model_instructions_file";
const TEAM_WORKER_LAUNCH_ARGS_ENV = "OMX_TEAM_WORKER_LAUNCH_ARGS";
const TEAM_INHERIT_LEADER_FLAGS_ENV = "OMX_TEAM_INHERIT_LEADER_FLAGS";
const OMX_BYPASS_DEFAULT_SYSTEM_PROMPT_ENV = "OMX_BYPASS_DEFAULT_SYSTEM_PROMPT";
const OMX_MODEL_INSTRUCTIONS_FILE_ENV = "OMX_MODEL_INSTRUCTIONS_FILE";
const OMX_RALPH_APPEND_INSTRUCTIONS_FILE_ENV =
  "OMX_RALPH_APPEND_INSTRUCTIONS_FILE";
const OMX_AUTORESEARCH_APPEND_INSTRUCTIONS_FILE_ENV =
  "OMX_AUTORESEARCH_APPEND_INSTRUCTIONS_FILE";
const REASONING_MODES = ["low", "medium", "high", "xhigh"] as const;
type ReasoningMode = (typeof REASONING_MODES)[number];
const REASONING_MODE_SET = new Set<string>(REASONING_MODES);
const REASONING_USAGE = "Usage: omx reasoning <low|medium|high|xhigh>";
const ALLOWED_SHELLS = new Set([
  "/bin/sh",
  "/bin/bash",
  "/bin/zsh",
  "/bin/dash",
  "/bin/fish",
  "/usr/bin/sh",
  "/usr/bin/bash",
  "/usr/bin/zsh",
  "/usr/bin/dash",
  "/usr/bin/fish",
  "/usr/local/bin/bash",
  "/usr/local/bin/zsh",
  "/usr/local/bin/fish",
  "/opt/local/bin/zsh",
  "/opt/homebrew/bin/zsh",
]);
const WINDOWS_DETACHED_BOOTSTRAP_DELAY_MS = 2500;
const CODEX_VERSION_FLAGS = new Set(["--version", "-V"]);
const TMUX_EXTENDED_KEYS_MODE = "always";
const TMUX_EXTENDED_KEYS_FALLBACK_MODE = "off";
const TMUX_EXTENDED_KEYS_LEASE_DIR = "tmux-extended-keys";
const TMUX_EXTENDED_KEYS_LOCK_RETRY_MS = 20;
const TMUX_EXTENDED_KEYS_LOCK_MAX_ATTEMPTS = 100;
const TMUX_EXTENDED_KEYS_LOCK_STALE_MS = 30_000;

type CliCommand =
  | "launch"
  | "exec"
  | "setup"
  | "update"
  | "list"
  | "agents"
  | "agents-init"
  | "deepinit"
  | "uninstall"
  | "doctor"
  | "cleanup"
  | "ask"
  | "question"
  | "adapt"
  | "explore"
  | "sparkshell"
  | "team"
  | "session"
  | "resume"
  | "version"
  | "tmux-hook"
  | "hooks"
  | "hud"
  | "sidecar"
  | "state"
  | "wiki"
  | "mcp-serve"
  | "status"
  | "cancel"
  | "help"
  | "reasoning"
  | string;

const NESTED_HELP_COMMANDS = new Set<CliCommand>([
  "ask",
  "question",
  "cleanup",
  "adapt",
  "autoresearch",
  "agents",
  "agents-init",
  "deepinit",
  "exec",
  "hooks",
  "list",
  "hud",
  "sidecar",
  "state",
  "wiki",
  "mcp-serve",
  "ralph",
  "resume",
  "session",
  "sparkshell",
  "team",
  "tmux-hook",
]);

export interface ResolvedCliInvocation {
  command: CliCommand;
  launchArgs: string[];
}

export function resolveSetupInstallModeArg(args: string[]): SetupInstallMode | undefined {
  if (args.includes("--plugin")) return "plugin";
  return undefined;
}

export function resolveSetupScopeArg(args: string[]): SetupScope | undefined {
  let value: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--scope") {
      const next = args[index + 1];
      if (!next || next.startsWith("-")) {
        throw new Error(
          `Missing setup scope value after --scope. Expected one of: ${SETUP_SCOPES.join(", ")}`,
        );
      }
      value = next;
      index += 1;
      continue;
    }
    if (arg.startsWith("--scope=")) {
      value = arg.slice("--scope=".length);
    }
  }
  if (!value) return undefined;
  if (SETUP_SCOPES.includes(value as SetupScope)) {
    return value as SetupScope;
  }
  throw new Error(
    `Invalid setup scope: ${value}. Expected one of: ${SETUP_SCOPES.join(", ")}`,
  );
}

export function resolveCliInvocation(args: string[]): ResolvedCliInvocation {
  const firstArg = args[0];
  if (firstArg === "--help" || firstArg === "-h") {
    return { command: "help", launchArgs: [] };
  }
  if (firstArg === "--version" || firstArg === "-v") {
    return { command: "version", launchArgs: [] };
  }
  if (!firstArg || firstArg.startsWith("--")) {
    return { command: "launch", launchArgs: firstArg ? args : [] };
  }
  if (firstArg === "launch") {
    return { command: "launch", launchArgs: args.slice(1) };
  }
  if (firstArg === "exec") {
    return { command: "exec", launchArgs: args.slice(1) };
  }
  if (firstArg === "resume") {
    return { command: "resume", launchArgs: args.slice(1) };
  }
  return { command: firstArg, launchArgs: [] };
}

export function resolveNotifyTempContract(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): ParseNotifyTempContractResult {
  return parseNotifyTempContractFromArgs(args, env);
}

export function commandOwnsLocalHelp(command: CliCommand): boolean {
  return NESTED_HELP_COMMANDS.has(command);
}

export type CodexLaunchPolicy = "inside-tmux" | "detached-tmux" | "direct";

function splitLeaderLaunchPolicyArgs(args: string[]): {
  explicitPolicy?: CodexLaunchPolicy;
  remainingArgs: string[];
} {
  const remainingArgs: string[] = [];
  let explicitPolicy: CodexLaunchPolicy | undefined;
  let passthroughOnly = false;

  for (const arg of args) {
    if (passthroughOnly) {
      remainingArgs.push(arg);
      continue;
    }

    if (arg === "--") {
      passthroughOnly = true;
      remainingArgs.push(arg);
      continue;
    }

    if (arg === "--tmux") {
      explicitPolicy = "detached-tmux";
      continue;
    }

    remainingArgs.push(arg);
  }

  return { explicitPolicy, remainingArgs };
}

export function resolveLeaderLaunchPolicyOverride(
  args: string[],
): CodexLaunchPolicy | undefined {
  return splitLeaderLaunchPolicyArgs(args).explicitPolicy;
}

export function resolveCodexLaunchPolicy(
  env: NodeJS.ProcessEnv = process.env,
  _platform: NodeJS.Platform = process.platform,
  tmuxAvailable: boolean = isTmuxAvailable(),
  nativeWindows: boolean = isNativeWindows(),
  stdinIsTTY: boolean = Boolean(process.stdin.isTTY),
  stdoutIsTTY: boolean = Boolean(process.stdout.isTTY),
  explicitPolicy?: CodexLaunchPolicy,
): CodexLaunchPolicy {
  if (env.TMUX) return "inside-tmux";
  if (explicitPolicy === "detached-tmux") return tmuxAvailable ? "detached-tmux" : "direct";
  if (explicitPolicy === "direct") return "direct";
  if (_platform === "win32") return "direct";
  if (nativeWindows) return "direct";
  if (!stdinIsTTY || !stdoutIsTTY) return "direct";
  return tmuxAvailable ? "detached-tmux" : "direct";
}

type ExecFileSyncFailure = NodeJS.ErrnoException & {
  status?: number | null;
  signal?: NodeJS.Signals | null;
};

function resolveTmuxExecutableForLaunch(): string {
  return resolveTmuxBinaryForPlatform() || "tmux";
}

function execTmuxFileSync(
  args: string[],
  options?: Parameters<typeof execFileSync>[2],
): string {
  return execFileSync(resolveTmuxExecutableForLaunch(), args, {
    ...(options ?? {}),
    ...(process.platform === "win32" ? { windowsHide: true } : {}),
  }) as string;
}

function hasErrnoCode(error: unknown, code: string): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code,
  );
}


function isMissingTmuxLaunchNoise(error: unknown): boolean {
  return error instanceof Error && /spawnSync tmux ENOENT/i.test(error.message);
}

function logCliOperationFailure(error: unknown): void {
  if (isMissingTmuxLaunchNoise(error)) return;
  process.stderr.write(`[cli/index] operation failed: ${error}
`);
}

function tmuxFailureMessage(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const err = error as ExecFileSyncFailure & {
    stdout?: Buffer | string;
    stderr?: Buffer | string;
  };
  const stderr =
    typeof err.stderr === "string" ? err.stderr : err.stderr?.toString();
  const stdout =
    typeof err.stdout === "string" ? err.stdout : err.stdout?.toString();
  const detail = (stderr || stdout || err.message || String(error)).trim();
  return detail.replace(/\s+/g, " ");
}

function isBenignMissingTmuxServerMessage(message: string): boolean {
  return /no server running/i.test(message);
}

export interface TmuxLaunchHealth {
  usable: boolean;
  reason?: string;
}

export function checkDetachedTmuxLaunchHealth(): TmuxLaunchHealth {
  try {
    execTmuxFileSync(["list-sessions"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    return { usable: true };
  } catch (err) {
    const reason = tmuxFailureMessage(err);
    if (isBenignMissingTmuxServerMessage(reason)) {
      return { usable: true };
    }
    return { usable: false, reason };
  }
}

function warnDetachedTmuxFallback(reason?: string): void {
  const suffix = reason ? ` (${reason})` : "";
  console.warn(
    `[omx] warning: tmux is installed but its server/socket is unusable${suffix}. Falling back to direct Codex launch.`,
  );
}

function resolveTmuxAwareLaunchPolicy(
  explicitLaunchPolicy: CodexLaunchPolicy | undefined,
  nativeWindows: boolean,
): {
  launchPolicy: CodexLaunchPolicy;
  effectiveExplicitLaunchPolicy: CodexLaunchPolicy | undefined;
} {
  const launchPolicy = resolveCodexLaunchPolicy(
    process.env,
    process.platform,
    undefined,
    nativeWindows,
    undefined,
    undefined,
    explicitLaunchPolicy,
  );

  if (launchPolicy !== "detached-tmux") {
    return { launchPolicy, effectiveExplicitLaunchPolicy: explicitLaunchPolicy };
  }

  const tmuxHealth = checkDetachedTmuxLaunchHealth();
  if (tmuxHealth.usable) {
    return { launchPolicy, effectiveExplicitLaunchPolicy: explicitLaunchPolicy };
  }

  warnDetachedTmuxFallback(tmuxHealth.reason);
  return { launchPolicy: "direct", effectiveExplicitLaunchPolicy: "direct" };
}

export interface CodexExecFailureClassification {
  kind: "exit" | "launch-error";
  code?: string;
  message: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
}

export function resolveSignalExitCode(
  signal: NodeJS.Signals | null | undefined,
): number {
  if (!signal) return 1;
  const signalNumber = osConstants.signals[signal];
  if (typeof signalNumber === "number" && Number.isFinite(signalNumber)) {
    return 128 + signalNumber;
  }
  return 1;
}

export function classifyCodexExecFailure(
  error: unknown,
): CodexExecFailureClassification {
  if (!error || typeof error !== "object") {
    return {
      kind: "launch-error",
      message: String(error),
    };
  }

  const err = error as ExecFileSyncFailure;
  const code = typeof err.code === "string" ? err.code : undefined;
  const message =
    typeof err.message === "string" && err.message.length > 0
      ? err.message
      : "unknown codex launch failure";
  const hasExitStatus = typeof err.status === "number";
  const hasSignal = typeof err.signal === "string" && err.signal.length > 0;

  if (hasExitStatus || hasSignal) {
    return {
      kind: "exit",
      code,
      message,
      exitCode: hasExitStatus
        ? (err.status as number)
        : resolveSignalExitCode(err.signal),
      signal: hasSignal ? (err.signal as NodeJS.Signals) : undefined,
    };
  }

  return {
    kind: "launch-error",
    code,
    message,
  };
}

function runCodexBlocking(
  cwd: string,
  launchArgs: string[],
  codexEnv: NodeJS.ProcessEnv,
): void {
  const { result } = spawnPlatformCommandSync("codex", launchArgs, {
    cwd,
    stdio: "inherit",
    env: codexEnv,
    encoding: "utf-8",
  });

  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException;
    const kind = classifySpawnError(errno);
    if (kind === "missing") {
      console.error(
        "[omx] failed to launch codex: executable not found in PATH",
      );
    } else if (kind === "blocked") {
      console.error(
        `[omx] failed to launch codex: executable is present but blocked in the current environment (${errno.code || "blocked"})`,
      );
    } else {
      console.error(`[omx] failed to launch codex: ${errno.message}`);
    }
    throw result.error;
  }

  if (result.status !== 0) {
    process.exitCode =
      typeof result.status === "number"
        ? result.status
        : resolveSignalExitCode(result.signal);
    if (result.signal) {
      console.error(`[omx] codex exited due to signal ${result.signal}`);
    }
  }
}

export interface DetachedSessionTmuxStep {
  name: string;
  args: string[];
}

export function buildHudPaneCleanupTargets(
  existingPaneIds: string[],
  createdPaneId: string | null,
  leaderPaneId?: string,
): string[] {
  const targets = new Set<string>(
    existingPaneIds.filter((id) => id.startsWith("%")),
  );
  if (createdPaneId && createdPaneId.startsWith("%")) {
    targets.add(createdPaneId);
  }
  // Guard: never kill the leader's own pane under any circumstances.
  if (leaderPaneId && leaderPaneId.startsWith("%")) {
    targets.delete(leaderPaneId);
  }
  return [...targets];
}

export async function main(args: string[]): Promise<void> {
  const knownCommands = new Set([
    "launch",
    "exec",
    "setup",
    "update",
    "list",
    "agents",
    "agents-init",
    "deepinit",
    "uninstall",
    "doctor",
    "cleanup",
    "ask",
    "question",
    "autoresearch",
    "explore",
    "sparkshell",
    "team",
    "ralph",
    "session",
    "resume",
    "version",
    "tmux-hook",
    "hooks",
    "hud",
    "sidecar",
    "state",
    "mcp-serve",
    "status",
    "cancel",
    "help",
    "--help",
    "-h",
  ]);
  const firstArg = args[0];
  const { command, launchArgs } = resolveCliInvocation(args);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const options = {
    force: flags.has("--force"),
    mergeAgents: flags.has("--merge-agents"),
    dryRun: flags.has("--dry-run"),
    verbose: flags.has("--verbose"),
    team: flags.has("--team"),
  };

  if (flags.has("--help") && !commandOwnsLocalHelp(command)) {
    console.log(HELP);
    return;
  }

  try {
    switch (command) {
      case "launch":
        await launchWithHud(launchArgs);
        break;
      case "resume":
        await launchWithHud(["resume", ...launchArgs]);
        break;
      case "setup":
        await setup({
          force: options.force,
          mergeAgents: options.mergeAgents,
          dryRun: options.dryRun,
          verbose: options.verbose,
          scope: resolveSetupScopeArg(args.slice(1)),
          installMode: resolveSetupInstallModeArg(args.slice(1)),
        });
        break;
      case "update":
        await runImmediateUpdate(process.cwd());
        break;
      case "list":
        await listCommand(args.slice(1));
        break;
      case "agents":
        await agentsCommand(args.slice(1));
        break;
      case "agents-init":
        await agentsInitCommand(args.slice(1));
        break;
      case "deepinit":
        await agentsInitCommand(args.slice(1));
        break;
      case "uninstall":
        await uninstall({
          dryRun: options.dryRun,
          keepConfig: flags.has("--keep-config"),
          verbose: options.verbose,
          purge: flags.has("--purge"),
          scope: resolveSetupScopeArg(args.slice(1)),
        });
        break;
      case "doctor": {
        const { doctor } = await import("./doctor.js");
        await doctor(options);
        break;
      }
      case "ask":
        await askCommand(args.slice(1));
        break;
      case "question":
        await questionCommand(args.slice(1));
        break;
      case "adapt":
        await adaptCommand(args.slice(1));
        break;
      case "cleanup":
        await cleanupCommand(args.slice(1));
        break;
      case "autoresearch":
        await autoresearchCommand(args.slice(1));
        break;
      case "explore":
        await exploreCommand(args.slice(1));
        break;
      case "exec":
        await execWithOverlay(launchArgs);
        break;
      case "sparkshell":
        await sparkshellCommand(args.slice(1));
        break;
      case "team":
        await teamCommand(args.slice(1), options);
        break;
      case "session":
        await sessionCommand(args.slice(1));
        break;
      case "ralph":
        await ralphCommand(args.slice(1));
        break;
      case "version":
        version();
        break;
      case "hud":
        await hudCommand(args.slice(1));
        break;
      case "sidecar":
        await sidecarCommand(args.slice(1));
        break;
      case "state":
        await stateCommand(args.slice(1));
        break;
      case "notepad":
        await mcpParityCommand("notepad", args.slice(1));
        break;
      case "project-memory":
        await mcpParityCommand("project-memory", args.slice(1));
        break;
      case "trace":
        await mcpParityCommand("trace", args.slice(1));
        break;
      case "code-intel":
        await mcpParityCommand("code-intel", args.slice(1));
        break;
      case "wiki":
        await mcpParityCommand("wiki", args.slice(1));
        break;
      case "mcp-serve":
        await mcpServeCommand(args.slice(1));
        break;
      case "tmux-hook":
        await tmuxHookCommand(args.slice(1));
        break;
      case "hooks":
        await hooksCommand(args.slice(1));
        break;
      case "status":
        await showStatus();
        break;
      case "cancel":
        await cancelModes();
        break;
      case "reasoning":
        await reasoningCommand(args.slice(1));
        break;
      case "help":
      case "--help":
      case "-h":
        console.log(HELP);
        break;
      default:
        if (
          firstArg &&
          firstArg.startsWith("-") &&
          !knownCommands.has(firstArg)
        ) {
          await launchWithHud(args);
          break;
        }
        console.error(`Unknown command: ${command}`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

async function showStatus(): Promise<void> {
  const { readFile } = await import("fs/promises");
  const cwd = process.cwd();
  try {
    const refs = await listModeStateFilesWithScopePreference(cwd);
    const states = refs.map((ref) => ref.path);
    if (states.length === 0) {
      console.log("No active modes.");
      return;
    }
    for (const path of states) {
      const content = await readFile(path, "utf-8");
      let state: Record<string, unknown>;
      try {
        state = JSON.parse(content) as Record<string, unknown>;
      } catch (err) {
        logCliOperationFailure(err);
        continue;
      }
      const file = basename(path);
      const mode = file.replace("-state.json", "");
      console.log(
        `${mode}: ${state.active === true ? "ACTIVE" : "inactive"} (phase: ${String(state.current_phase || "n/a")})`,
      );
    }
  } catch (err) {
    logCliOperationFailure(err);
    console.log("No active modes.");
  }
}

async function reasoningCommand(args: string[]): Promise<void> {
  const mode = args[0];
  const configPath = codexConfigPath();

  if (!mode) {
    if (!existsSync(configPath)) {
      console.log(
        `model_reasoning_effort is not set (${configPath} does not exist).`,
      );
      console.log(REASONING_USAGE);
      return;
    }

    const { readFile } = await import("fs/promises");
    const content = await readFile(configPath, "utf-8");
    const current = readTopLevelTomlString(content, REASONING_KEY);
    if (current) {
      console.log(`Current ${REASONING_KEY}: ${current}`);
      return;
    }

    console.log(`${REASONING_KEY} is not set in ${configPath}.`);
    console.log(REASONING_USAGE);
    return;
  }

  if (!REASONING_MODE_SET.has(mode)) {
    throw new Error(
      `Invalid reasoning mode "${mode}". Expected one of: ${REASONING_MODES.join(", ")}.\n${REASONING_USAGE}`,
    );
  }

  const { mkdir, readFile, writeFile } = await import("fs/promises");
  await mkdir(dirname(configPath), { recursive: true });

  const existing = existsSync(configPath)
    ? await readFile(configPath, "utf-8")
    : "";
  const updated = upsertTopLevelTomlString(existing, REASONING_KEY, mode);
  await writeFile(configPath, updated);
  console.log(`Set ${REASONING_KEY}="${mode}" in ${configPath}`);
}

export async function launchWithHud(args: string[]): Promise<void> {
  if (isNativeWindows()) {
    const { result } = spawnPlatformCommandSync("tmux", ["-V"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.error) {
      const errno = result.error as NodeJS.ErrnoException;
      const kind = classifySpawnError(errno);
      if (kind === "missing") {
        console.warn(
          "[omx] warning: tmux was not found on native Windows. Continuing without tmux/HUD.\n" +
            "[omx] To enable tmux-backed features, install psmux:\n" +
            "[omx]   winget install psmux\n" +
            "[omx] See: https://github.com/marlocarlo/psmux",
        );
      } else {
        console.warn(
          `[omx] warning: tmux probe failed on native Windows (${errno.code || errno.message}). Continuing without tmux/HUD.`,
        );
      }
    } else if (result.status !== 0 && !isTmuxAvailable()) {
      const stderr = (result.stderr || "").trim();
      console.warn(
        `[omx] warning: tmux reported an error on native Windows${stderr ? ` (${stderr})` : ""}. Continuing without tmux/HUD.`,
      );
    }
  }

  const launchCwd = process.cwd();
  const parsedWorktree = parseWorktreeMode(args);
  const notifyTempResult = resolveNotifyTempContract(
    parsedWorktree.remainingArgs,
    process.env,
  );
  const explicitLaunchPolicy = resolveLeaderLaunchPolicyOverride(
    notifyTempResult.passthroughArgs,
  );
  const codexHomeOverride = resolveCodexHomeForLaunch(launchCwd, process.env);
  const { launchPolicy, effectiveExplicitLaunchPolicy } =
    resolveTmuxAwareLaunchPolicy(explicitLaunchPolicy, isNativeWindows());
  const enableNotifyFallbackAuthority = launchPolicy === "direct";
  const workerSparkModel = resolveWorkerSparkModel(
    notifyTempResult.passthroughArgs,
    codexHomeOverride,
  );
  const normalizedArgs = normalizeCodexLaunchArgs(
    notifyTempResult.passthroughArgs,
  );
  let cwd = launchCwd;
  let worktreeDirty = false;
  if (parsedWorktree.mode.enabled) {
    const planned = planWorktreeTarget({
      cwd: launchCwd,
      scope: "launch",
      mode: parsedWorktree.mode,
    });
    const ensured = ensureWorktree(planned, { allowDirtyReuse: true });
    if (ensured.enabled) {
      cwd = ensured.worktreePath;
      if (ensured.dirty) {
        worktreeDirty = true;
        process.stderr.write(
          `[omx] Caution: worktree at ${cwd} has uncommitted changes.\n` +
          `  The session will launch as-is. Resolve the dirty state with OMX after launch, then proceed with your task.\n`,
        );
      }
      const depBootstrap = ensureReusableNodeModules(cwd);
      if (depBootstrap.strategy === "symlink") {
        console.log(`[omx] Reusing node_modules from ${depBootstrap.sourceNodeModulesPath}`);
      } else if (depBootstrap.strategy === "missing" && depBootstrap.warning) {
        console.warn(`[omx] ${depBootstrap.warning}`);
      }
    }
  }
  const sessionId = `omx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await maybeCheckAndPromptUpdate(cwd);
  } catch (err) {
    logCliOperationFailure(err);
    // Non-fatal: update checks must never block launch
  }

  try {
    await maybePromptGithubStar();
  } catch (err) {
    logCliOperationFailure(err);
    // Non-fatal: star prompt must never block launch
  }

  // ── Phase 0.5: config repair ────────────────────────────────────────────
  // After an omx version upgrade the OLD setup code (still in memory) may
  // have written a config.toml with duplicate [tui] sections.  Codex CLI's
  // TOML parser rejects duplicates, so we repair before spawning the CLI.
  try {
    const repaired = await repairConfigIfNeeded(
      resolveCodexConfigPathForLaunch(launchCwd, process.env),
      getPackageRoot(),
    );
    if (repaired) {
      console.log("[omx] Repaired managed config.toml compatibility issue.");
    }
  } catch {
    // Non-fatal: repair failure must not block launch
  }

  // ── Phase 1: preLaunch ──────────────────────────────────────────────────
  try {
    await preLaunch(cwd, sessionId, notifyTempResult.contract, codexHomeOverride, enableNotifyFallbackAuthority, worktreeDirty);
  } catch (err) {
    // preLaunch errors must NOT prevent Codex from starting
    console.error(
      `[omx] preLaunch warning: ${err instanceof Error ? err.message : err}`,
    );
  }

  // ── Phase 2: run ────────────────────────────────────────────────────────
  try {
    const notifyTempContractRaw = notifyTempResult.contract.active
      ? serializeNotifyTempContract(notifyTempResult.contract)
      : null;
    runCodex(
      cwd,
      normalizedArgs,
      sessionId,
      workerSparkModel,
      codexHomeOverride,
      notifyTempContractRaw,
      effectiveExplicitLaunchPolicy,
    );
  } finally {
    // ── Phase 3: postLaunch ─────────────────────────────────────────────
    await postLaunch(cwd, sessionId, codexHomeOverride, enableNotifyFallbackAuthority);
  }
}

export async function execWithOverlay(args: string[]): Promise<void> {
  const launchCwd = process.cwd();
  const parsedWorktree = parseWorktreeMode(args);
  const notifyTempResult = resolveNotifyTempContract(
    parsedWorktree.remainingArgs,
    process.env,
  );
  const codexHomeOverride = resolveCodexHomeForLaunch(launchCwd, process.env);
  const normalizedArgs = normalizeCodexLaunchArgs(
    notifyTempResult.passthroughArgs,
  );
  let cwd = launchCwd;
  let worktreeDirty = false;

  if (parsedWorktree.mode.enabled) {
    const planned = planWorktreeTarget({
      cwd: launchCwd,
      scope: "launch",
      mode: parsedWorktree.mode,
    });
    const ensured = ensureWorktree(planned, { allowDirtyReuse: true });
    if (ensured.enabled) {
      cwd = ensured.worktreePath;
      if (ensured.dirty) {
        worktreeDirty = true;
        process.stderr.write(
          `[omx] Caution: worktree at ${cwd} has uncommitted changes.\n` +
          `  The session will launch as-is. Resolve the dirty state with OMX after launch, then proceed with your task.\n`,
        );
      }
      const depBootstrap = ensureReusableNodeModules(cwd);
      if (depBootstrap.strategy === "symlink") {
        console.log(`[omx] Reusing node_modules from ${depBootstrap.sourceNodeModulesPath}`);
      } else if (depBootstrap.strategy === "missing" && depBootstrap.warning) {
        console.warn(`[omx] ${depBootstrap.warning}`);
      }
    }
  }

  const sessionId = `omx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await maybeCheckAndPromptUpdate(cwd);
  } catch (err) {
    logCliOperationFailure(err);
  }

  try {
    await maybePromptGithubStar();
  } catch (err) {
    logCliOperationFailure(err);
  }

  try {
    const repaired = await repairConfigIfNeeded(
      resolveCodexConfigPathForLaunch(launchCwd, process.env),
      getPackageRoot(),
    );
    if (repaired) {
      console.log("[omx] Repaired managed config.toml compatibility issue.");
    }
  } catch {
    // Non-fatal
  }

  try {
    await preLaunch(cwd, sessionId, notifyTempResult.contract, codexHomeOverride, true, worktreeDirty);
  } catch (err) {
    console.error(
      `[omx] preLaunch warning: ${err instanceof Error ? err.message : err}`,
    );
  }

  try {
    const notifyTempContractRaw = notifyTempResult.contract.active
      ? serializeNotifyTempContract(notifyTempResult.contract)
      : null;
    const codexArgs = injectModelInstructionsBypassArgs(
      cwd,
      ["exec", ...normalizedArgs],
      process.env,
      sessionModelInstructionsPath(cwd, sessionId),
    );
    const codexEnvBase = codexHomeOverride
      ? { ...process.env, CODEX_HOME: codexHomeOverride }
      : process.env;
    const codexEnv = notifyTempContractRaw
      ? {
          ...codexEnvBase,
          [OMX_NOTIFY_TEMP_CONTRACT_ENV]: notifyTempContractRaw,
        }
      : codexEnvBase;
    runCodexBlocking(cwd, codexArgs, codexEnv);
  } finally {
    await postLaunch(cwd, sessionId, codexHomeOverride, true);
  }
}

export function normalizeCodexLaunchArgs(args: string[]): string[] {
  const parsed = parseWorktreeMode(args);
  const launchPolicyParsed = splitLeaderLaunchPolicyArgs(parsed.remainingArgs);
  const normalized: string[] = [];
  let wantsBypass = false;
  let hasBypass = false;
  let reasoningMode: ReasoningMode | null = null;

  for (const arg of launchPolicyParsed.remainingArgs) {
    if (arg === MADMAX_FLAG) {
      wantsBypass = true;
      continue;
    }

    if (arg === CODEX_BYPASS_FLAG) {
      wantsBypass = true;
      if (!hasBypass) {
        normalized.push(arg);
        hasBypass = true;
      }
      continue;
    }

    if (arg === HIGH_REASONING_FLAG) {
      reasoningMode = "high";
      continue;
    }

    if (arg === XHIGH_REASONING_FLAG) {
      reasoningMode = "xhigh";
      continue;
    }

    if (arg === SPARK_FLAG) {
      // Spark model is injected into worker env only (not the leader). Consume flag.
      continue;
    }

    if (arg === MADMAX_SPARK_FLAG) {
      // Bypass applies to leader; spark model goes to workers only. Consume flag.
      wantsBypass = true;
      continue;
    }

    normalized.push(arg);
  }

  if (wantsBypass && !hasBypass) {
    normalized.push(CODEX_BYPASS_FLAG);
  }

  if (reasoningMode) {
    normalized.push(CONFIG_FLAG, `${REASONING_KEY}="${reasoningMode}"`);
  }

  return normalized;
}

/**
 * Returns the spark model string if --spark or --madmax-spark appears in the
 * raw (pre-normalize) args, or undefined if neither flag is present.
 * Used to route the spark model to team workers without affecting the leader.
 */
export function resolveWorkerSparkModel(
  args: string[],
  codexHomeOverride?: string,
): string | undefined {
  for (const arg of args) {
    if (arg === SPARK_FLAG || arg === MADMAX_SPARK_FLAG) {
      return resolveTeamLowComplexityDefaultModel(codexHomeOverride);
    }
  }
  return undefined;
}

function isModelInstructionsOverride(value: string): boolean {
  return new RegExp(`^${MODEL_INSTRUCTIONS_FILE_KEY}\\s*=`).test(value.trim());
}

function hasModelInstructionsOverride(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === CONFIG_FLAG || arg === LONG_CONFIG_FLAG) {
      const maybeValue = args[i + 1];
      if (
        typeof maybeValue === "string" &&
        isModelInstructionsOverride(maybeValue)
      ) {
        return true;
      }
      continue;
    }

    if (arg.startsWith(`${LONG_CONFIG_FLAG}=`)) {
      const inlineValue = arg.slice(`${LONG_CONFIG_FLAG}=`.length);
      if (isModelInstructionsOverride(inlineValue)) return true;
    }
  }
  return false;
}

function shouldBypassDefaultSystemPrompt(env: NodeJS.ProcessEnv): boolean {
  return env[OMX_BYPASS_DEFAULT_SYSTEM_PROMPT_ENV] !== "0";
}

function buildModelInstructionsOverride(
  cwd: string,
  env: NodeJS.ProcessEnv,
  defaultFilePath?: string,
): string {
  const filePath =
    env[OMX_MODEL_INSTRUCTIONS_FILE_ENV] ||
    defaultFilePath ||
    join(cwd, "AGENTS.md");
  return `${MODEL_INSTRUCTIONS_FILE_KEY}="${escapeTomlString(filePath)}"`;
}

function tryReadGitValue(cwd: string, args: string[]): string | undefined {
  try {
    const value = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function extractIssueNumber(text: string): number | undefined {
  const explicit = text.match(/\bissue\s*#(\d+)\b/i);
  if (explicit) return Number.parseInt(explicit[1], 10);
  const generic = text.match(/(^|[^\w/])#(\d+)\b/);
  return generic ? Number.parseInt(generic[2], 10) : undefined;
}

export function resolveNativeSessionName(
  cwd: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.TMUX) {
    try {
      const tmuxPaneTarget = env.TMUX_PANE?.trim();
      const displayArgs = tmuxPaneTarget
        ? ["display-message", "-p", "-t", tmuxPaneTarget, "#S"]
        : ["display-message", "-p", "#S"];
      const tmuxSession = execTmuxFileSync(
        displayArgs,
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2000,
        },
      ).trim();
      if (tmuxSession) return tmuxSession;
    } catch {
      // best effort only
    }
  }
  return buildTmuxSessionName(cwd, sessionId);
}

function buildNativeHookBaseContext(
  cwd: string,
  sessionId: string,
  normalizedEvent:
    | "started"
    | "blocked"
    | "run.heartbeat"
    | "run.blocked_on_user"
    | "run.blocked_on_system"
    | "finished"
    | "failed",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const repoPath =
    tryReadGitValue(cwd, ["rev-parse", "--show-toplevel"]) || cwd;
  const branch = tryReadGitValue(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const issueNumber = extractIssueNumber(
    [branch, basename(cwd)].filter(Boolean).join(" "),
  );

  return {
    normalized_event: normalizedEvent,
    session_name: resolveNativeSessionName(cwd, sessionId),
    repo_path: repoPath,
    repo_name: basename(repoPath),
    worktree_path: cwd,
    ...(branch ? { branch } : {}),
    ...(issueNumber !== undefined ? { issue_number: issueNumber } : {}),
    ...extra,
  };
}

export function injectModelInstructionsBypassArgs(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  defaultFilePath?: string,
): string[] {
  if (!shouldBypassDefaultSystemPrompt(env)) return [...args];
  if (hasModelInstructionsOverride(args)) return [...args];
  return [
    ...args,
    CONFIG_FLAG,
    buildModelInstructionsOverride(cwd, env, defaultFilePath),
  ];
}

export function collectInheritableTeamWorkerArgs(
  codexArgs: string[],
): string[] {
  return collectInheritableTeamWorkerArgsShared(codexArgs);
}

export function resolveTeamWorkerLaunchArgsEnv(
  existingRaw: string | undefined,
  codexArgs: string[],
  inheritLeaderFlags = true,
  defaultModel?: string,
): string | null {
  const inheritedArgs = inheritLeaderFlags
    ? collectInheritableTeamWorkerArgs(codexArgs)
    : [];
  const normalized = resolveTeamWorkerLaunchArgs({
    existingRaw,
    inheritedArgs,
    fallbackModel: defaultModel,
  });
  if (normalized.length === 0) return null;
  return normalized.join(" ");
}

export function readTopLevelTomlString(
  content: string,
  key: string,
): string | null {
  let inTopLevel = true;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^\[[^[\]]+\]\s*(#.*)?$/.test(trimmed)) {
      inTopLevel = false;
      continue;
    }
    if (!inTopLevel) continue;
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (!match || match[1] !== key) continue;
    return parseTomlStringValue(match[2]);
  }
  return null;
}

export function upsertTopLevelTomlString(
  content: string,
  key: string,
  value: string,
): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const assignment = `${key} = "${escapeTomlString(value)}"`;

  if (!content.trim()) {
    return assignment + eol;
  }

  const lines = content.split(/\r?\n/);
  let replaced = false;
  let inTopLevel = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^\[[^[\]]+\]\s*(#.*)?$/.test(trimmed)) {
      inTopLevel = false;
      continue;
    }
    if (!inTopLevel) continue;
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
    if (match && match[1] === key) {
      lines[i] = assignment;
      replaced = true;
      break;
    }
  }

  if (!replaced) {
    const firstTableIndex = lines.findIndex((line) =>
      /^\s*\[[^[\]]+\]\s*(#.*)?$/.test(line.trim()),
    );
    if (firstTableIndex >= 0) {
      lines.splice(firstTableIndex, 0, assignment);
    } else {
      lines.push(assignment);
    }
  }

  let out = lines.join(eol);
  if (!out.endsWith(eol)) out += eol;
  return out;
}

function parseTomlStringValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sanitizeTmuxToken(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}

export function buildTmuxSessionName(cwd: string, sessionId: string): string {
  const parentPath = dirname(cwd);
  const parentDir = basename(parentPath);
  const dirName = basename(cwd);
  const grandparentPath = dirname(parentPath);
  const grandparentDir = basename(grandparentPath);
  const repoDir = parentDir.endsWith(".omx-worktrees")
    ? parentDir.slice(0, -".omx-worktrees".length)
    : parentDir === "worktrees" && grandparentDir === ".omx"
      ? basename(dirname(grandparentPath))
      : null;
  const dirToken = repoDir
    ? sanitizeTmuxToken(`${repoDir}-${dirName}`)
    : sanitizeTmuxToken(dirName);
  let branchToken = "detached";
  const branch = tryReadGitValue(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch) branchToken = sanitizeTmuxToken(branch);
  const sessionToken = sanitizeTmuxToken(sessionId.replace(/^omx-/, ""));
  const prefix = `omx-${dirToken}-${branchToken}`;
  const name = `${prefix}-${sessionToken}`;
  if (name.length <= 120) return name;
  const prefixBudget = Math.max(4, 120 - sessionToken.length - 1);
  const trimmedPrefix = prefix.slice(0, prefixBudget).replace(/-+$/g, "");
  return `${trimmedPrefix}-${sessionToken}`.slice(0, 120);
}

export function buildDetachedTmuxSessionName(
  cwd: string,
  sessionId: string,
): string {
  return buildTmuxSessionName(cwd, sessionId);
}

function parseWindowIndexFromTmuxOutput(rawOutput: string): string | null {
  const windowIndex = rawOutput.split("\n")[0]?.trim() || "";
  return /^[0-9]+$/.test(windowIndex) ? windowIndex : null;
}

export function detectDetachedSessionWindowIndex(sessionName: string): string | null {
  try {
    const output = execTmuxFileSync(
      ["display-message", "-p", "-t", sessionName, "#{window_index}"],
      { encoding: "utf-8" },
    );
    return parseWindowIndexFromTmuxOutput(output);
  } catch (err) {
    logCliOperationFailure(err);
    return null;
  }
}

function escapeShellDoubleQuotedValue(value: string): string {
  return value.replace(/["\\$`]/g, "\\$&");
}

interface TmuxExtendedKeysLeaseHolderRecord {
  id: string;
  pid: number;
  platform?: NodeJS.Platform;
  linuxStartTicks?: number;
}

type TmuxExtendedKeysLeaseHolder = string | TmuxExtendedKeysLeaseHolderRecord;

interface TmuxExtendedKeysLeaseState {
  originalMode: string;
  holders: TmuxExtendedKeysLeaseHolder[];
}

function sanitizeTmuxLeaseKey(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "default";
}

function blockMs(ms: number): void {
  const delay = Math.max(1, Math.floor(ms));
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, delay);
}

function tmuxExtendedKeysLeaseRoot(cwd: string): string {
  return join(cwd, ".omx", "state", TMUX_EXTENDED_KEYS_LEASE_DIR);
}

function resolveTmuxSocketPath(
  execFileSyncImpl: TmuxExecSync = (file, tmuxArgs) =>
    execFileSync(file, tmuxArgs, {
      encoding: "utf-8",
    }) as string,
): string {
  return (
    execTmuxSync(["display-message", "-p", "#{socket_path}"], execFileSyncImpl) ||
    "default"
  );
}

function tmuxExtendedKeysLeasePath(cwd: string, socketPath: string): string {
  return join(
    tmuxExtendedKeysLeaseRoot(cwd),
    `${sanitizeTmuxLeaseKey(socketPath)}.json`,
  );
}

function isTmuxExtendedKeysLeaseHolderRecord(
  holder: unknown,
): holder is TmuxExtendedKeysLeaseHolderRecord {
  if (!holder || typeof holder !== "object") return false;
  const record = holder as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim()) return false;
  if (!Number.isSafeInteger(record.pid) || Number(record.pid) <= 0) return false;
  if (record.platform !== undefined && typeof record.platform !== "string") return false;
  if (
    record.linuxStartTicks !== undefined &&
    !Number.isSafeInteger(record.linuxStartTicks)
  ) return false;
  return true;
}

function isTmuxExtendedKeysLeaseHolder(
  holder: unknown,
): holder is TmuxExtendedKeysLeaseHolder {
  return typeof holder === "string" || isTmuxExtendedKeysLeaseHolderRecord(holder);
}

function readTmuxExtendedKeysLeaseState(
  leasePath: string,
): TmuxExtendedKeysLeaseState | null {
  if (!existsSync(leasePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(leasePath, "utf-8")) as {
      originalMode?: unknown;
      holders?: unknown;
    };
    if (
      typeof parsed.originalMode !== "string" ||
      !Array.isArray(parsed.holders) ||
      !parsed.holders.every(isTmuxExtendedKeysLeaseHolder)
    ) {
      return null;
    }
    return {
      originalMode: parsed.originalMode,
      holders: [...parsed.holders],
    };
  } catch {
    return null;
  }
}

function writeTmuxExtendedKeysLeaseState(
  leasePath: string,
  state: TmuxExtendedKeysLeaseState,
): void {
  mkdirSync(dirname(leasePath), { recursive: true });
  writeFileSync(leasePath, JSON.stringify(state, null, 2));
}

function parseTmuxExtendedKeysLeaseHolderPid(holder: string): number | null {
  const match = /^([1-9]\d*)-/.exec(holder);
  if (!match) return null;
  const pid = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function getTmuxExtendedKeysLeaseHolderId(holder: TmuxExtendedKeysLeaseHolder): string {
  return typeof holder === "string" ? holder : holder.id;
}

function getTmuxExtendedKeysLeaseHolderPid(holder: TmuxExtendedKeysLeaseHolder): number | null {
  if (typeof holder === "string") return parseTmuxExtendedKeysLeaseHolderPid(holder);
  return Number.isSafeInteger(holder.pid) && holder.pid > 0 ? holder.pid : null;
}

function parseLinuxProcStartTicks(statContent: string): number | null {
  const commandEnd = statContent.lastIndexOf(")");
  if (commandEnd === -1) return null;

  const remainder = statContent.slice(commandEnd + 1).trim();
  const fields = remainder.split(/\s+/);
  if (fields.length <= 19) return null;

  const startTicks = Number(fields[19]);
  return Number.isSafeInteger(startTicks) ? startTicks : null;
}

function readLinuxProcessStartTicks(pid: number): number | null {
  try {
    return parseLinuxProcStartTicks(readFileSync(`/proc/${pid}/stat`, "utf-8"));
  } catch {
    return null;
  }
}

function createTmuxExtendedKeysLeaseHolder(
  id: string,
  pid: number,
): TmuxExtendedKeysLeaseHolderRecord {
  const linuxStartTicks = process.platform === "linux"
    ? readLinuxProcessStartTicks(pid) ?? undefined
    : undefined;
  return {
    id,
    pid,
    platform: process.platform,
    ...(linuxStartTicks !== undefined ? { linuxStartTicks } : {}),
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as NodeJS.ErrnoException).code)
        : "";
    return code === "EPERM";
  }
}

function isTmuxExtendedKeysLeaseHolderAlive(
  holder: TmuxExtendedKeysLeaseHolder,
): boolean {
  const pid = getTmuxExtendedKeysLeaseHolderPid(holder);
  if (pid === null || !isProcessAlive(pid)) return false;

  if (typeof holder === "string") return true;
  if (holder.platform !== "linux" || process.platform !== "linux") return true;
  if (holder.linuxStartTicks === undefined) return true;

  return readLinuxProcessStartTicks(pid) === holder.linuxStartTicks;
}

function reapDeadTmuxExtendedKeysLeaseHolders(
  state: TmuxExtendedKeysLeaseState,
): TmuxExtendedKeysLeaseState {
  return {
    originalMode: state.originalMode,
    holders: state.holders.filter(isTmuxExtendedKeysLeaseHolderAlive),
  };
}

function withTmuxExtendedKeysLeaseLock<T>(
  cwd: string,
  socketPath: string,
  run: () => T,
): T {
  const leaseRoot = tmuxExtendedKeysLeaseRoot(cwd);
  mkdirSync(leaseRoot, { recursive: true });
  const lockPath = join(
    leaseRoot,
    `${sanitizeTmuxLeaseKey(socketPath)}.lock`,
  );
  for (let attempt = 0; attempt < TMUX_EXTENDED_KEYS_LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      mkdirSync(lockPath);
      try {
        writeFileSync(join(lockPath, "pid"), String(process.pid));
        return run();
      } finally {
        rmSync(lockPath, { recursive: true, force: true });
      }
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as NodeJS.ErrnoException).code)
          : "";
      if (code !== "EEXIST") throw err;
      const lockStat = statSync(lockPath, { throwIfNoEntry: false });
      if (lockStat && Date.now() - lockStat.mtimeMs > TMUX_EXTENDED_KEYS_LOCK_STALE_MS) {
        let holderAlive = false;
        try {
          const holderPid = Number.parseInt(readFileSync(join(lockPath, "pid"), "utf-8").trim(), 10);
          if (Number.isFinite(holderPid) && holderPid > 0) {
            process.kill(holderPid, 0);
            holderAlive = true;
          }
        } catch {
          // PID file missing/unreadable or process dead (ESRCH) — treat as stale
        }
        if (!holderAlive) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      }
      blockMs(TMUX_EXTENDED_KEYS_LOCK_RETRY_MS);
    }
  }
  throw new Error(`timed out waiting for tmux extended-keys lease lock: ${lockPath}`);
}

function buildDetachedSessionLeaderCommand(
  cwd: string,
  sessionName: string,
  codexCmd: string,
): string {
  const wrapped = [
    buildTmuxExtendedKeysAcquireShellSnippet(cwd),
    'exec 3<&0;',
    'omx_codex_pid="";',
    "omx_detached_session_cleanup() {",
    "status=$?;",
    "trap - 0 INT TERM HUP;",
    'if [ -n "$omx_codex_pid" ] && kill -0 "$omx_codex_pid" 2>/dev/null; then',
    'kill -TERM "$omx_codex_pid" 2>/dev/null || true;',
    'wait "$omx_codex_pid" 2>/dev/null || true;',
    "fi;",
    'exec 3<&- 2>/dev/null || true;',
    buildTmuxExtendedKeysReleaseShellSnippet(cwd),
    'if [ "$status" -lt 128 ]; then',
    `tmux kill-session -t "${escapeShellDoubleQuotedValue(sessionName)}" >/dev/null 2>&1 || true;`,
    "fi;",
    "exit $status;",
    "};",
    "trap omx_detached_session_cleanup 0 INT TERM HUP;",
    `${codexCmd} <&3 &`,
    "omx_codex_pid=$!;",
    'wait "$omx_codex_pid";',
  ].join(" ");
  return `/bin/sh -c ${quoteShellArg(wrapped)}`;
}

type TmuxExecSync = (file: string, args: readonly string[]) => string;

function execTmuxSync(
  args: readonly string[],
  execFileSyncImpl: TmuxExecSync = (file, tmuxArgs) =>
    execFileSync(file, tmuxArgs, {
      encoding: "utf-8",
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
    }) as string,
): string {
  return execFileSyncImpl(resolveTmuxExecutableForLaunch(), [...args]).trim();
}

export function acquireTmuxExtendedKeysLease(
  cwd: string,
  execFileSyncImpl: TmuxExecSync = (file, tmuxArgs) =>
    execFileSync(file, tmuxArgs, {
      encoding: "utf-8",
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
    }) as string,
  ownerPid = process.pid,
): string | null {
  try {
    const socketPath = resolveTmuxSocketPath(execFileSyncImpl);
    const leasePath = tmuxExtendedKeysLeasePath(cwd, socketPath);
    const holderPid =
      Number.isSafeInteger(ownerPid) && ownerPid > 0 ? ownerPid : process.pid;
    const leaseId = `${holderPid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    withTmuxExtendedKeysLeaseLock(cwd, socketPath, () => {
      const stateRaw = readTmuxExtendedKeysLeaseState(leasePath);
      const state = stateRaw ? reapDeadTmuxExtendedKeysLeaseHolders(stateRaw) : null;
      if (stateRaw && state?.holders.length === 0) {
        execTmuxSync(
          ["set-option", "-sq", "extended-keys", state.originalMode],
          execFileSyncImpl,
        );
        rmSync(leasePath, { force: true });
      }
      if (!state || state.holders.length === 0) {
        const previousMode =
          execTmuxSync(["show-options", "-sv", "extended-keys"], execFileSyncImpl) ||
          TMUX_EXTENDED_KEYS_FALLBACK_MODE;
        execTmuxSync(
          ["set-option", "-sq", "extended-keys", TMUX_EXTENDED_KEYS_MODE],
          execFileSyncImpl,
        );
        writeTmuxExtendedKeysLeaseState(leasePath, {
          originalMode: previousMode,
          holders: [createTmuxExtendedKeysLeaseHolder(leaseId, holderPid)],
        });
        return;
      }

      state.holders.push(createTmuxExtendedKeysLeaseHolder(leaseId, holderPid));
      writeTmuxExtendedKeysLeaseState(leasePath, state);
    });
    return `${socketPath}\t${leaseId}`;
  } catch (err) {
    logCliOperationFailure(err);
    return null;
  }
}

export function releaseTmuxExtendedKeysLease(
  cwd: string,
  leaseHandle: string,
  execFileSyncImpl: TmuxExecSync = (file, tmuxArgs) =>
    execFileSync(file, tmuxArgs, {
      encoding: "utf-8",
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
    }) as string,
): void {
  if (!leaseHandle.trim()) return;
  const [socketPathRaw = "", leaseId = ""] = leaseHandle.split("\t");
  const socketPath = socketPathRaw.trim() || "default";
  if (!leaseId) return;

  try {
    const leasePath = tmuxExtendedKeysLeasePath(cwd, socketPath);
    withTmuxExtendedKeysLeaseLock(cwd, socketPath, () => {
      const stateRaw = readTmuxExtendedKeysLeaseState(leasePath);
      const state = stateRaw ? reapDeadTmuxExtendedKeysLeaseHolders(stateRaw) : null;
      if (!state || state.holders.length === 0) {
        if (stateRaw) {
          execTmuxSync(
            ["set-option", "-sq", "extended-keys", stateRaw.originalMode],
            execFileSyncImpl,
          );
        }
        rmSync(leasePath, { force: true });
        return;
      }

      const holders = state.holders.filter(
        (holder) => getTmuxExtendedKeysLeaseHolderId(holder) !== leaseId,
      );
      if (holders.length > 0) {
        writeTmuxExtendedKeysLeaseState(leasePath, {
          originalMode: state.originalMode,
          holders,
        });
        return;
      }

      execTmuxSync(
        ["set-option", "-sq", "extended-keys", state.originalMode],
        execFileSyncImpl,
      );
      rmSync(leasePath, { force: true });
    });
  } catch (err) {
    logCliOperationFailure(err);
  }
}

function buildTmuxExtendedKeysHelperCommand(
  cwd: string,
  operation: "acquire" | "release",
): string {
  const cwdLiteral = JSON.stringify(cwd);
  const moduleUrlLiteral = JSON.stringify(import.meta.url);
  const script =
    operation === "acquire"
      ? `const mod = await import(${moduleUrlLiteral}); const ownerPid = Number.parseInt(process.argv[1] ?? "", 10); const lease = mod.acquireTmuxExtendedKeysLease(${cwdLiteral}, undefined, Number.isSafeInteger(ownerPid) && ownerPid > 0 ? ownerPid : undefined); if (lease) process.stdout.write(lease);`
      : `const mod = await import(${moduleUrlLiteral}); mod.releaseTmuxExtendedKeysLease(${cwdLiteral}, process.argv[1] ?? "");`;
  return `${quoteShellArg(process.execPath)} --input-type=module -e ${quoteShellArg(script)}`;
}

function buildTmuxExtendedKeysAcquireShellSnippet(cwd: string): string {
  return `OMX_TMUX_EXTENDED_KEYS_LEASE=$(${buildTmuxExtendedKeysHelperCommand(cwd, "acquire")} "$$" 2>/dev/null || true);`;
}

function buildTmuxExtendedKeysReleaseShellSnippet(cwd: string): string {
  return `if [ -n "\${OMX_TMUX_EXTENDED_KEYS_LEASE:-}" ]; then ${buildTmuxExtendedKeysHelperCommand(cwd, "release")} "\${OMX_TMUX_EXTENDED_KEYS_LEASE}" >/dev/null 2>&1 || true; fi;`;
}

export function withTmuxExtendedKeys<T>(
  cwd: string,
  run: () => T,
  execFileSyncImpl: TmuxExecSync = (file, tmuxArgs) =>
    execFileSync(file, tmuxArgs, {
      encoding: "utf-8",
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
    }) as string,
): T {
  const leaseHandle = acquireTmuxExtendedKeysLease(cwd, execFileSyncImpl);
  try {
    return run();
  } finally {
    if (leaseHandle) releaseTmuxExtendedKeysLease(cwd, leaseHandle, execFileSyncImpl);
  }
}

export function buildDetachedSessionBootstrapSteps(
  sessionName: string,
  cwd: string,
  codexCmd: string,
  hudCmd: string,
  workerLaunchArgs: string | null,
  codexHomeOverride?: string,
  notifyTempContractRaw?: string | null,
  nativeWindows = false,
  sessionId?: string,
): DetachedSessionTmuxStep[] {
  const detachedLeaderCmd = nativeWindows
    ? "powershell.exe"
    : buildDetachedSessionLeaderCommand(cwd, sessionName, codexCmd);
  const newSessionArgs: string[] = [
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-s",
    sessionName,
    "-c",
    cwd,
    ...(workerLaunchArgs
      ? ["-e", `${TEAM_WORKER_LAUNCH_ARGS_ENV}=${workerLaunchArgs}`]
      : []),
    ...(sessionId ? ["-e", `OMX_SESSION_ID=${sessionId}`] : []),
    ...(codexHomeOverride ? ["-e", `CODEX_HOME=${codexHomeOverride}`] : []),
    ...(notifyTempContractRaw
      ? ["-e", `${OMX_NOTIFY_TEMP_CONTRACT_ENV}=${notifyTempContractRaw}`]
      : []),
    detachedLeaderCmd,
  ];
  const splitCaptureArgs: string[] = [
    "split-window",
    "-v",
    "-l",
    String(HUD_TMUX_HEIGHT_LINES),
    "-d",
    "-t",
    sessionName,
    "-c",
    cwd,
    "-P",
    "-F",
    "#{pane_id}",
    hudCmd,
  ];
  return [
    { name: "new-session", args: newSessionArgs },
    { name: "split-and-capture-hud-pane", args: splitCaptureArgs },
  ];
}

async function readLaunchAppendInstructions(): Promise<string> {
  const appendixCandidates = [
    process.env[OMX_RALPH_APPEND_INSTRUCTIONS_FILE_ENV]?.trim(),
    process.env[OMX_AUTORESEARCH_APPEND_INSTRUCTIONS_FILE_ENV]?.trim(),
  ].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (appendixCandidates.length === 0) return "";
  const appendixPath = appendixCandidates[0];
  if (!existsSync(appendixPath)) {
    throw new Error(`launch instructions file not found: ${appendixPath}`);
  }
  const { readFile } = await import("fs/promises");
  return (await readFile(appendixPath, "utf-8")).trim();
}

export function buildDetachedSessionFinalizeSteps(
  sessionName: string,
  hudPaneId: string | null,
  hookWindowIndex: string | null,
  enableMouse: boolean,
  nativeWindows = false,
): DetachedSessionTmuxStep[] {
  const steps: DetachedSessionTmuxStep[] = [];
  if (!nativeWindows && hudPaneId && hookWindowIndex) {
    const hookTarget = buildResizeHookTarget(sessionName, hookWindowIndex);
    const hookName = buildResizeHookName(
      "launch",
      sessionName,
      hookWindowIndex,
      hudPaneId,
    );
    const clientAttachedHookName = buildClientAttachedReconcileHookName(
      "launch",
      sessionName,
      hookWindowIndex,
      hudPaneId,
    );
    steps.push({
      name: "register-resize-hook",
      args: buildRegisterResizeHookArgs(
        hookTarget,
        hookName,
        hudPaneId,
        HUD_TMUX_HEIGHT_LINES,
      ),
    });
    steps.push({
      name: "register-client-attached-reconcile",
      args: buildRegisterClientAttachedReconcileArgs(
        hookTarget,
        clientAttachedHookName,
        hudPaneId,
        HUD_TMUX_HEIGHT_LINES,
      ),
    });
    steps.push({
      name: "schedule-delayed-resize",
      args: buildScheduleDelayedHudResizeArgs(
        hudPaneId,
        undefined,
        HUD_TMUX_HEIGHT_LINES,
      ),
    });
    steps.push({
      name: "reconcile-hud-resize",
      args: buildReconcileHudResizeArgs(hudPaneId, HUD_TMUX_HEIGHT_LINES),
    });
  }

  if (enableMouse) {
    steps.push({
      name: "set-mouse",
      args: ["set-option", "-t", sessionName, "mouse", "on"],
    });
    steps.push({
      name: "sanitize-copy-mode-style",
      args: [],
    });
  }
  steps.push({
    name: "attach-session",
    args: ["attach-session", "-t", sessionName],
  });
  return steps;
}

export function buildDetachedSessionRollbackSteps(
  sessionName: string,
  hookTarget: string | null,
  hookName: string | null,
  clientAttachedHookName: string | null,
): DetachedSessionTmuxStep[] {
  const steps: DetachedSessionTmuxStep[] = [];
  if (hookTarget && clientAttachedHookName) {
    steps.push({
      name: "unregister-client-attached-reconcile",
      args: buildUnregisterClientAttachedReconcileArgs(
        hookTarget,
        clientAttachedHookName,
      ),
    });
  }
  if (hookTarget && hookName) {
    steps.push({
      name: "unregister-resize-hook",
      args: buildUnregisterResizeHookArgs(hookTarget, hookName),
    });
  }
  steps.push({
    name: "kill-session",
    args: ["kill-session", "-t", sessionName],
  });
  return steps;
}

export function buildNotifyTempStartupMessages(
  contract: NotifyTempContract,
  hasValidProviders: boolean,
): { infoLines: string[]; warningLines: string[] } {
  const providers =
    contract.canonicalSelectors.length > 0
      ? contract.canonicalSelectors.join(",")
      : "none";
  const infoLines = [
    `notify temp: active | providers=${providers} | persistent-routing=bypassed`,
  ];
  const warningLines = [...contract.warnings];
  if (!hasValidProviders) {
    warningLines.push(
      "notify temp: no valid providers resolved; notifications skipped",
    );
  }
  return { infoLines, warningLines };
}

export function buildNotifyFallbackWatcherEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    codexHomeOverride?: string;
    enableAuthority?: boolean;
    sessionId?: string;
  } = {},
): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  delete nextEnv.TMUX;
  delete nextEnv.TMUX_PANE;
  return {
    ...nextEnv,
    ...(options.codexHomeOverride ? { CODEX_HOME: options.codexHomeOverride } : {}),
    ...(options.sessionId ? { OMX_SESSION_ID: options.sessionId } : {}),
    OMX_HUD_AUTHORITY: options.enableAuthority ? "1" : "0",
  };
}

export function shouldEnableNotifyFallbackWatcher(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const toggle = String(env.OMX_NOTIFY_FALLBACK ?? "").trim();
  if (platform === "win32") {
    return toggle === "1";
  }
  return toggle !== "0";
}

export async function cleanupLaunchOrphanedMcpProcesses(
  dependencies: CleanupDependencies = {},
): Promise<CleanupResult> {
  return cleanupOmxMcpProcesses([], {
    ...dependencies,
    selectCandidates: dependencies.selectCandidates ?? findLaunchSafeCleanupCandidates,
    writeLine: dependencies.writeLine ?? (() => {}),
  });
}

interface PostLaunchCleanupDependencies {
  cleanup?: () => Promise<CleanupResult>;
  writeInfo?: (line: string) => void;
  writeWarn?: (line: string) => void;
  writeError?: (line: string) => void;
}

interface PostLaunchModeCleanupDependencies {
  readdir?: typeof import("fs/promises").readdir;
  readFile?: typeof import("fs/promises").readFile;
  writeFile?: typeof import("fs/promises").writeFile;
  sleep?: (ms: number) => Promise<void>;
  writeWarn?: (line: string) => void;
  now?: () => Date;
}

type PostLaunchModeStateReadResult =
  | { kind: "ok"; state: Record<string, unknown> }
  | { kind: "missing" | "recoverable" }
  | { kind: "malformed"; message: string };

const POST_LAUNCH_MODE_STATE_RETRY_DELAY_MS = 10;
const POST_LAUNCH_MODE_STATE_MAX_READ_ATTEMPTS = 2;

function isLikelyTransientModeStateParseFailure(raw: string, err: unknown): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return true;
  if (!(err instanceof SyntaxError)) return false;
  if (!trimmed.startsWith("{") || trimmed.endsWith("}")) return false;
  return (
    /Unexpected end of JSON input/.test(err.message) ||
    /Unterminated string in JSON/.test(err.message) ||
    /Expected double-quoted property name in JSON/.test(err.message) ||
    /Expected property name or '}' in JSON/.test(err.message) ||
    /Expected ':' after property name in JSON/.test(err.message) ||
    /Expected ',' or '}' after property value in JSON/.test(err.message)
  );
}

async function readPostLaunchModeStateFile(
  path: string,
  dependencies: Pick<PostLaunchModeCleanupDependencies, "readFile" | "sleep"> = {},
): Promise<PostLaunchModeStateReadResult> {
  const readFile =
    dependencies.readFile ?? (await import("fs/promises")).readFile;
  const sleep =
    dependencies.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; attempt <= POST_LAUNCH_MODE_STATE_MAX_READ_ATTEMPTS; attempt += 1) {
    try {
      const raw = await readFile(path, "utf-8");
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        if (attempt < POST_LAUNCH_MODE_STATE_MAX_READ_ATTEMPTS) {
          await sleep(POST_LAUNCH_MODE_STATE_RETRY_DELAY_MS);
          continue;
        }
        return { kind: "recoverable" };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (err) {
        if (isLikelyTransientModeStateParseFailure(raw, err)) {
          if (attempt < POST_LAUNCH_MODE_STATE_MAX_READ_ATTEMPTS) {
            await sleep(POST_LAUNCH_MODE_STATE_RETRY_DELAY_MS);
            continue;
          }
          return { kind: "recoverable" };
        }
        return {
          kind: "malformed",
          message: err instanceof Error ? err.message : String(err),
        };
      }

      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        return { kind: "malformed", message: "mode state must be a JSON object" };
      }
      return { kind: "ok", state: parsed as Record<string, unknown> };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error?.code === "ENOENT") return { kind: "missing" };
      return {
        kind: "malformed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { kind: "recoverable" };
}

function buildRecoveredPostLaunchModeState(
  mode: string,
  completedAt: string,
): Record<string, unknown> {
  return {
    active: false,
    mode,
    current_phase: "cancelled",
    completed_at: completedAt,
    last_turn_at: completedAt,
  };
}

function buildRecoveredPostLaunchSkillActiveState(
  completedAt: string,
): Record<string, unknown> {
  return {
    version: 1,
    active: false,
    skill: "",
    phase: "complete",
    updated_at: completedAt,
    active_skills: [],
  };
}

export async function cleanupPostLaunchModeStateFiles(
  cwd: string,
  sessionId: string,
  dependencies: PostLaunchModeCleanupDependencies = {},
): Promise<void> {
  const readdir =
    dependencies.readdir ?? (await import("fs/promises")).readdir;
  const writeFile =
    dependencies.writeFile ?? (await import("fs/promises")).writeFile;
  const writeWarn = dependencies.writeWarn ?? console.warn;
  const now = dependencies.now ?? (() => new Date());
  const scopedDirs = [getBaseStateDir(cwd), getStateDir(cwd, sessionId)];

  for (const stateDir of scopedDirs) {
    const files = await readdir(stateDir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith("-state.json") || file === "session.json") continue;
      const path = join(stateDir, file);
      const mode = file.slice(0, -"-state.json".length);
      const result = await readPostLaunchModeStateFile(path, dependencies);
      if (result.kind !== "ok") {
        if (result.kind === "recoverable") {
          try {
            const completedAt = now().toISOString();
            await writeFile(
              path,
              JSON.stringify(
                mode === SKILL_ACTIVE_STATE_MODE
                  ? buildRecoveredPostLaunchSkillActiveState(completedAt)
                  : buildRecoveredPostLaunchModeState(mode, completedAt),
                null,
                2,
              ),
            );
            if (isTrackedWorkflowMode(mode)) {
              await syncCanonicalSkillStateForMode({
                cwd,
                mode,
                active: false,
                currentPhase: "cancelled",
                sessionId: stateDir === getStateDir(cwd, sessionId) ? sessionId : undefined,
                nowIso: completedAt,
                source: "postLaunchCleanup",
              });
            }
          } catch (err) {
            writeWarn(
              `[omx] postLaunch: failed to recover mode state ${path}: ${err instanceof Error ? err.message : err}`,
            );
          }
        } else if (result.kind === "malformed") {
          writeWarn(
            `[omx] postLaunch: skipped malformed mode state ${path}: ${result.message}`,
          );
        }
        continue;
      }
      const skillStateStillVisible = mode === SKILL_ACTIVE_STATE_MODE
        && Array.isArray(result.state.active_skills)
        && result.state.active_skills.length > 0;
      if (result.state.active !== true && !skillStateStillVisible) continue;

      try {
        const completedAt = now().toISOString();
        if (mode === SKILL_ACTIVE_STATE_MODE) {
          result.state.active = false;
          result.state.phase = "complete";
          result.state.updated_at = completedAt;
          result.state.active_skills = [];
          await writeFile(path, JSON.stringify(result.state, null, 2));
          continue;
        }
        result.state.active = false;
        result.state.current_phase = "cancelled";
        result.state.completed_at = completedAt;
        await writeFile(path, JSON.stringify(result.state, null, 2));
        if (isTrackedWorkflowMode(mode)) {
          await syncCanonicalSkillStateForMode({
            cwd,
            mode,
            active: false,
            currentPhase: "cancelled",
            sessionId: stateDir === getStateDir(cwd, sessionId) ? sessionId : undefined,
            nowIso: completedAt,
            source: "postLaunchCleanup",
          });
        }
      } catch (err) {
        writeWarn(
          `[omx] postLaunch: failed to update mode state ${path}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}

export async function reapPostLaunchOrphanedMcpProcesses(
  dependencies: PostLaunchCleanupDependencies = {},
): Promise<void> {
  const cleanup = dependencies.cleanup ?? cleanupLaunchOrphanedMcpProcesses;
  const writeInfo = dependencies.writeInfo ?? console.log;
  const writeWarn = dependencies.writeWarn ?? console.warn;
  const writeError =
    dependencies.writeError ?? ((line: string) => process.stderr.write(line));

  try {
    const result = await cleanup();
    if (result.terminatedCount > 0) {
      writeInfo(
        `[omx] postLaunch: reaped ${result.terminatedCount} orphaned OMX MCP process(es).`,
      );
    }
    if (result.failedPids.length > 0) {
      writeWarn(
        `[omx] postLaunch: failed to reap ${result.failedPids.length} orphaned OMX MCP process(es); continuing cleanup.`,
      );
    }
  } catch (err) {
    writeError(`[cli/index] postLaunch MCP cleanup failed: ${err}\n`);
  }
}

/**
 * preLaunch: Prepare environment before Codex starts.
 * 1. Best-effort launch-safe orphan cleanup for detached OMX MCP processes
 * 2. Generate runtime overlay + write session-scoped model instructions file
 * 3. Write session.json
 *
 * Automatic broad stale-session cleanup remains disabled here. Only detached
 * OMX MCP processes without a live Codex ancestor are reaped so new launches
 * do not accumulate stale processes from prior crashed/closed sessions.
 */
async function preLaunch(
  cwd: string,
  sessionId: string,
  notifyTempContract?: NotifyTempContract,
  codexHomeOverride?: string,
  enableNotifyFallbackAuthority: boolean = false,
  worktreeDirty: boolean = false,
): Promise<void> {
  // 1. Best-effort launch-safe orphan cleanup
  try {
    const cleanup = await cleanupLaunchOrphanedMcpProcesses();
    if (cleanup.terminatedCount > 0) {
      console.log(
        `[omx] Reaped ${cleanup.terminatedCount} orphaned OMX MCP process(es) before launch.`,
      );
    }
    if (cleanup.failedPids.length > 0) {
      console.warn(
        `[omx] Failed to reap ${cleanup.failedPids.length} orphaned OMX MCP process(es); continuing launch.`,
      );
    }
  } catch (err) {
    logCliOperationFailure(err);
    // Non-fatal
  }

  // 2. Generate runtime overlay + write session-scoped model instructions file
  const orchestrationMode = await resolveSessionOrchestrationMode(
    cwd,
    sessionId,
  );
  const overlay = await generateOverlay(cwd, sessionId, { orchestrationMode });
  const launchAppendix = await readLaunchAppendInstructions();
  const dirtyWorktreeGuidance = worktreeDirty
    ? `\n\n## Session start: dirty worktree detected\n\nThis worktree has uncommitted changes that were present when the session launched.\nBefore executing the requested task, resolve the dirty state first:\n1. Review uncommitted changes with \`git status\` and \`git diff\`.\n2. Commit, stash, or discard changes as appropriate.\n3. Then proceed with the original task.`
    : "";
  const sessionInstructions =
    launchAppendix.trim().length > 0
      ? `${overlay}

${launchAppendix}${dirtyWorktreeGuidance}`
      : `${overlay}${dirtyWorktreeGuidance}`;
  await writeSessionModelInstructionsFile(cwd, sessionId, sessionInstructions);

  // 3. Write session state
  await resetSessionMetrics(cwd, sessionId);
  await writeSessionStart(cwd, sessionId);

  // 4. Start notify fallback watcher (best effort)
  try {
    await startNotifyFallbackWatcher(cwd, { codexHomeOverride, enableAuthority: enableNotifyFallbackAuthority, sessionId });
  } catch (err) {
    logCliOperationFailure(err);
    // Non-fatal
  }

  // 5. Start derived watcher (best effort, opt-in)
  try {
    await startHookDerivedWatcher(cwd);
  } catch (err) {
    logCliOperationFailure(err);
    // Non-fatal
  }

  // 6. Emit temp notification startup summary + warnings, then send session-start lifecycle notification (best effort)
  try {
    if (notifyTempContract?.active) {
      process.env[OMX_NOTIFY_TEMP_CONTRACT_ENV] =
        serializeNotifyTempContract(notifyTempContract);
      const { getNotificationConfig } =
        await import("../notifications/config.js");
      const resolved = getNotificationConfig();
      const startup = buildNotifyTempStartupMessages(
        notifyTempContract,
        Boolean(resolved?.enabled),
      );
      for (const info of startup.infoLines) {
        console.log(`[omx] ${info}`);
      }
      for (const warning of startup.warningLines) {
        console.warn(`[omx] ${warning}`);
      }
    } else {
      delete process.env[OMX_NOTIFY_TEMP_CONTRACT_ENV];
    }
    const { notifyLifecycle } = await import("../notifications/index.js");
    await notifyLifecycle("session-start", {
      sessionId,
      projectPath: cwd,
      projectName: basename(cwd),
    });
  } catch (err) {
    logCliOperationFailure(err);
    // Non-fatal: notification failures must never block launch
  }

  // 7. Dispatch native hook event (best effort)
  try {
    await emitNativeHookEvent(cwd, "session-start", {
      session_id: sessionId,
      context: buildNativeHookBaseContext(cwd, sessionId, "started", {
        project_path: cwd,
        project_name: basename(cwd),
        status: "started",
      }),
    });
  } catch (err) {
    logCliOperationFailure(err);
    // Non-fatal
  }
}

/**
 * runCodex: Launch Codex CLI (blocks until exit).
 * All 3 paths (new tmux, existing tmux, no tmux) block via execSync/execFileSync.
 */
function runCodex(
  cwd: string,
  args: string[],
  sessionId: string,
  workerDefaultModel?: string,
  codexHomeOverride?: string,
  notifyTempContractRaw?: string | null,
  explicitLaunchPolicy?: CodexLaunchPolicy,
): void {
  const launchArgs = injectModelInstructionsBypassArgs(
    cwd,
    args,
    process.env,
    sessionModelInstructionsPath(cwd, sessionId),
  );
  const nativeWindows = isNativeWindows();
  const omxBin = resolveOmxEntryPath();
  if (!omxBin) {
    throw new Error("Unable to resolve OMX launcher path for tmux HUD bootstrap");
  }
  const hudCmd = nativeWindows
    ? buildWindowsPromptCommand("node", [omxBin, "hud", "--watch"])
    : buildTmuxPaneCommand("env", [`OMX_SESSION_ID=${sessionId}`, "node", omxBin, "hud", "--watch"]);
  const inheritLeaderFlags = process.env[TEAM_INHERIT_LEADER_FLAGS_ENV] !== "0";
  const workerLaunchArgs = resolveTeamWorkerLaunchArgsEnv(
    process.env[TEAM_WORKER_LAUNCH_ARGS_ENV],
    launchArgs,
    inheritLeaderFlags,
    workerDefaultModel,
  );
  const codexBaseEnv = codexHomeOverride
    ? { ...process.env, CODEX_HOME: codexHomeOverride }
    : process.env;
  const codexEnvWithSession = { ...codexBaseEnv, OMX_SESSION_ID: sessionId };
  const codexEnv = workerLaunchArgs
    ? { ...codexEnvWithSession, [TEAM_WORKER_LAUNCH_ARGS_ENV]: workerLaunchArgs }
    : codexEnvWithSession;
  const codexEnvWithNotify = notifyTempContractRaw
    ? { ...codexEnv, [OMX_NOTIFY_TEMP_CONTRACT_ENV]: notifyTempContractRaw }
    : codexEnv;

  const { launchPolicy } = resolveTmuxAwareLaunchPolicy(
    explicitLaunchPolicy,
    nativeWindows,
  );

  if (isCodexVersionRequest(launchArgs)) {
    runCodexBlocking(cwd, launchArgs, codexEnvWithNotify);
    return;
  }

  if (launchPolicy === "inside-tmux") {
    // Already in tmux: launch codex in current pane, HUD in bottom split
    const currentPaneId = process.env.TMUX_PANE;
    const staleHudPaneIds = listHudWatchPaneIdsInCurrentWindow(currentPaneId);
    for (const paneId of staleHudPaneIds) {
      killTmuxPane(paneId);
    }

    let hudPaneId: string | null = null;
    try {
      hudPaneId = createHudWatchPane(cwd, hudCmd);
    } catch (err) {
      logCliOperationFailure(err);
      // HUD split failed, continue without it
    }

    // Enable mouse scrolling at session start so scroll works before team
    // expansion. Previously this was only called from createTeamSession().
    // Opt-out: set OMX_MOUSE=0. (closes #128)
    if (process.env.OMX_MOUSE !== "0") {
      try {
        const tmuxPaneTarget = process.env.TMUX_PANE;
        const displayArgs = tmuxPaneTarget
          ? ["display-message", "-p", "-t", tmuxPaneTarget, "#S"]
          : ["display-message", "-p", "#S"];
        const tmuxSession = execTmuxFileSync(displayArgs, {
          encoding: "utf-8",
        }).trim();
        if (tmuxSession) enableMouseScrolling(tmuxSession);
      } catch (err) {
        logCliOperationFailure(err);
        // Non-fatal: mouse scrolling is a convenience feature
      }
    }

    const activePaneId = process.env.TMUX_PANE?.trim();
    if (activePaneId) {
      try {
        execTmuxFileSync(["display-message", "-p", "-t", activePaneId, "#S"], {
          encoding: "utf-8",
        });
      } catch {}
    }

    try {
      withTmuxExtendedKeys(cwd, () => {
        runCodexBlocking(cwd, launchArgs, codexEnvWithNotify);
      });
    } finally {
      const cleanupPaneIds = buildHudPaneCleanupTargets(
        listHudWatchPaneIdsInCurrentWindow(currentPaneId),
        hudPaneId,
        currentPaneId,
      );
      for (const paneId of cleanupPaneIds) {
        killTmuxPane(paneId);
      }
    }
  } else if (launchPolicy === "direct") {
    // Detached HUD sessions require tmux. Skip the bootstrap entirely when the
    // binary is unavailable so direct launches do not emit noisy ENOENT logs.
    runCodexBlocking(cwd, launchArgs, codexEnvWithNotify);
  } else {
    // Not in tmux: create a new tmux session with codex + HUD pane
    const codexCmd = buildTmuxPaneCommand("codex", launchArgs);
    const detachedWindowsCodexCmd = nativeWindows
      ? buildWindowsPromptCommand("codex", launchArgs)
      : null;
    const sessionName = buildDetachedTmuxSessionName(cwd, sessionId);
    let createdDetachedSession = false;
    let registeredHookTarget: string | null = null;
    let registeredHookName: string | null = null;
    let registeredClientAttachedHookName: string | null = null;
    try {
      const bootstrapSteps = buildDetachedSessionBootstrapSteps(
        sessionName,
        cwd,
        codexCmd,
        hudCmd,
        workerLaunchArgs,
        codexHomeOverride,
        notifyTempContractRaw,
        nativeWindows,
        sessionId,
      );
      for (const step of bootstrapSteps) {
        const output = execTmuxFileSync(step.args, {
          stdio: "pipe",
          encoding: "utf-8",
        });
        if (step.name === "new-session") {
          createdDetachedSession = true;
          parsePaneIdFromTmuxOutput(output || "");
        }
        if (step.name === "split-and-capture-hud-pane") {
          const hudPaneId = parsePaneIdFromTmuxOutput(output || "");
          const hookWindowIndex = hudPaneId
            ? detectDetachedSessionWindowIndex(sessionName)
            : null;
          const hookTarget =
            hudPaneId && hookWindowIndex
              ? buildResizeHookTarget(sessionName, hookWindowIndex)
              : null;
          const hookName =
            hudPaneId && hookWindowIndex
              ? buildResizeHookName(
                  "launch",
                  sessionName,
                  hookWindowIndex,
                  hudPaneId,
                )
              : null;
          const clientAttachedHookName =
            hudPaneId && hookWindowIndex
              ? buildClientAttachedReconcileHookName(
                  "launch",
                  sessionName,
                  hookWindowIndex,
                  hudPaneId,
                )
              : null;
          const finalizeSteps = buildDetachedSessionFinalizeSteps(
            sessionName,
            hudPaneId,
            hookWindowIndex,
            process.env.OMX_MOUSE !== "0",
            nativeWindows,
          );
          if (nativeWindows && detachedWindowsCodexCmd) {
            scheduleDetachedWindowsCodexLaunch(
              sessionName,
              detachedWindowsCodexCmd,
            );
          }
          for (const finalizeStep of finalizeSteps) {
            if (finalizeStep.name === "sanitize-copy-mode-style") {
              try {
                mitigateCopyModeUnderlineArtifacts(sessionName);
              } catch (err) {
                logCliOperationFailure(err);
              }
              continue;
            }
            const stdio =
              finalizeStep.name === "attach-session" ? "inherit" : "ignore";
            try {
              execTmuxFileSync(finalizeStep.args, { stdio });
            } catch (err) {
              logCliOperationFailure(err);
              if (finalizeStep.name === "attach-session")
                throw new Error("failed to attach detached tmux session");
              continue;
            }
            if (
              finalizeStep.name === "register-resize-hook" &&
              hookTarget &&
              hookName
            ) {
              registeredHookTarget = hookTarget;
              registeredHookName = hookName;
            }
            if (
              finalizeStep.name === "register-client-attached-reconcile" &&
              clientAttachedHookName
            ) {
              registeredClientAttachedHookName = clientAttachedHookName;
            }
          }
        }
      }
    } catch (err) {
      logCliOperationFailure(err);
      if (createdDetachedSession) {
        const rollbackSteps = buildDetachedSessionRollbackSteps(
          sessionName,
          registeredHookTarget,
          registeredHookName,
          registeredClientAttachedHookName,
        );
        for (const rollbackStep of rollbackSteps) {
          try {
            execTmuxFileSync(rollbackStep.args, { stdio: "ignore" });
          } catch (err) {
            logCliOperationFailure(err);
            // best-effort rollback only
          }
        }
      }
      // tmux not available or failed, just run codex directly
      runCodexBlocking(cwd, launchArgs, codexEnvWithNotify);
    }
  }
}

function listHudWatchPaneIdsInCurrentWindow(currentPaneId?: string): string[] {
  try {
    return listCurrentWindowHudPaneIds(currentPaneId);
  } catch (err) {
    logCliOperationFailure(err);
    return [];
  }
}

function createHudWatchPane(cwd: string, hudCmd: string): string | null {
  return createSharedHudWatchPane(cwd, hudCmd, { heightLines: HUD_TMUX_HEIGHT_LINES });
}

function killTmuxPane(paneId: string): void {
  if (!paneId.startsWith("%")) return;
  try {
    killSharedTmuxPane(paneId);
  } catch (err) {
    logCliOperationFailure(err);
    // Pane may already be gone; ignore.
  }
}

export function buildTmuxShellCommand(command: string, args: string[]): string {
  return [quoteShellArg(command), ...args.map(quoteShellArg)].join(" ");
}

function encodePowerShellCommand(commandText: string): string {
  return Buffer.from(commandText, "utf16le").toString("base64");
}

function isCodexVersionRequest(args: string[]): boolean {
  return args.some((arg) => CODEX_VERSION_FLAGS.has(arg));
}

export function buildWindowsPromptCommand(
  command: string,
  args: string[],
): string {
  const invocation = [
    "&",
    quotePowerShellArg(command),
    ...args.map(quotePowerShellArg),
  ].join(" ");
  const wrappedCommand = [
    "$ErrorActionPreference = 'Stop'",
    `& { ${invocation} }`,
  ].join("; ");
  return `powershell.exe -NoLogo -NoExit -EncodedCommand ${encodePowerShellCommand(wrappedCommand)}`;
}

/**
 * Wrap a command for tmux pane execution while preserving the tmux pane cwd.
 * tmux already starts the pane at `-c <cwd>`; using a login shell here can
 * reset that cwd back to the shell's startup directory on some setups.
 * Source zsh/bash rc files explicitly when needed, then exec the target.
 */
export function buildTmuxPaneCommand(
  command: string,
  args: string[],
  shellPath: string | undefined = process.env.SHELL,
): string {
  const bareCmd = buildTmuxShellCommand(command, args);
  let rcSource = "";
  if (shellPath && /\/zsh$/i.test(shellPath)) {
    rcSource = "if [ -f ~/.zshrc ]; then source ~/.zshrc; fi; ";
  } else if (shellPath && /\/bash$/i.test(shellPath)) {
    rcSource = "if [ -f ~/.bashrc ]; then source ~/.bashrc; fi; ";
  }
  const rawShell =
    shellPath && shellPath.trim() !== "" ? shellPath.trim() : "/bin/sh";
  const shellBin = ALLOWED_SHELLS.has(rawShell) ? rawShell : "/bin/sh";
  const inner = `${rcSource}exec ${bareCmd}`;
  return `${quoteShellArg(shellBin)} -c ${quoteShellArg(inner)}`;
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function quotePowerShellArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildDetachedWindowsBootstrapScript(
  sessionName: string,
  commandText: string,
  delayMs: number = WINDOWS_DETACHED_BOOTSTRAP_DELAY_MS,
  tmuxCommand: string = resolveTmuxExecutableForLaunch(),
): string {
  const delay =
    Number.isFinite(delayMs) && delayMs > 0
      ? Math.floor(delayMs)
      : WINDOWS_DETACHED_BOOTSTRAP_DELAY_MS;
  const targetLiteral = JSON.stringify(`${sessionName}:0.0`);
  const commandLiteral = JSON.stringify(commandText);
  const tmuxCommandLiteral = JSON.stringify(tmuxCommand);

  return [
    "const { execFileSync } = require('child_process');",
    `const tmuxCommand = ${tmuxCommandLiteral};`,
    `setTimeout(() => {`,
    `try { execFileSync(tmuxCommand, ['send-keys', '-t', ${targetLiteral}, '-l', '--', ${commandLiteral}], { stdio: 'ignore' }); } catch {}`,
    `try { execFileSync(tmuxCommand, ['send-keys', '-t', ${targetLiteral}, 'C-m'], { stdio: 'ignore' }); } catch {}`,
    `}, ${delay});`,
  ].join("");
}

function scheduleDetachedWindowsCodexLaunch(
  sessionName: string,
  commandText: string,
): void {
  const child = spawn(
    process.execPath,
    ["-e", buildDetachedWindowsBootstrapScript(sessionName, commandText)],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
}

/**
 * postLaunch: Clean up after Codex exits.
 * Each step is independently fault-tolerant (try/catch per step).
 */
async function postLaunch(
  cwd: string,
  sessionId: string,
  codexHomeOverride?: string,
  enableNotifyFallbackAuthority: boolean = false,
): Promise<void> {
  // Capture session start time before cleanup (writeSessionEnd deletes session.json)
  let sessionStartedAt: string | undefined;
  try {
    const sessionState = await readSessionState(cwd);
    sessionStartedAt = sessionState?.started_at;
  } catch (err) {
    logCliOperationFailure(err);
    // Non-fatal
  }

  // 0. Reap MCP orphans left behind by the session that just exited.
  await reapPostLaunchOrphanedMcpProcesses();

  // 0. Flush fallback watcher once to reduce race with fast codex exit.
  try {
    await flushNotifyFallbackOnce(cwd, { codexHomeOverride, enableAuthority: enableNotifyFallbackAuthority, sessionId });
  } catch (err) {
    logCliOperationFailure(err);
    // Non-fatal
  }

  // 0. Stop notify fallback watcher first.
  try {
    await stopNotifyFallbackWatcher(cwd);
  } catch (err) {
    logCliOperationFailure(err);
    // Non-fatal
  }

  // 0. Flush derived watcher once on shutdown (opt-in, best effort).
  try {
    await flushHookDerivedWatcherOnce(cwd);
  } catch (err) {
    logCliOperationFailure(err);
    // Non-fatal
  }

  // 0.1 Stop derived watcher first (opt-in, best effort).
  try {
    await stopHookDerivedWatcher(cwd);
  } catch (err) {
    logCliOperationFailure(err);
    // Non-fatal
  }

  // 1. Remove session-scoped model instructions file
  try {
    await removeSessionModelInstructionsFile(cwd, sessionId);
  } catch (err) {
    console.error(
      `[omx] postLaunch: model instructions cleanup failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  // 2. Archive session (write history, delete session.json)
  try {
    await writeSessionEnd(cwd, sessionId);
  } catch (err) {
    console.error(
      `[omx] postLaunch: session archive failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  // 2.5. Best-effort wiki session capture
  try {
    const { onSessionEnd } = await import("../wiki/lifecycle.js");
    onSessionEnd({ cwd, session_id: sessionId });
  } catch (err) {
    logCliOperationFailure(err);
    // Non-fatal: wiki capture must never block session cleanup
  }

  // 3. Cancel any still-active modes
  try {
    await cleanupPostLaunchModeStateFiles(cwd, sessionId);
  } catch (err) {
    console.error(
      `[omx] postLaunch: mode cleanup failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  // 4. Send session-end lifecycle notification (best effort)
  try {
    const { notifyLifecycle } = await import("../notifications/index.js");
    const durationMs = sessionStartedAt
      ? Date.now() - new Date(sessionStartedAt).getTime()
      : undefined;
    await notifyLifecycle("session-end", {
      sessionId,
      projectPath: cwd,
      projectName: basename(cwd),
      durationMs,
      reason: "session_exit",
    });
  } catch (err) {
    logCliOperationFailure(err);
    // Non-fatal: notification failures must never block session cleanup
  }

  // 4.5. Persist team leader attention when an active leader session exits.
  try {
    const { markOwnedTeamsLeaderSessionStopped } = await import("../team/state.js");
    await markOwnedTeamsLeaderSessionStopped(cwd, sessionId);
  } catch (err) {
    logCliOperationFailure(err);
    // Non-fatal
  }

  // 5. Dispatch native hook event (best effort)
  try {
    const durationMs = sessionStartedAt
      ? Date.now() - new Date(sessionStartedAt).getTime()
      : undefined;
    const normalizedEvent =
      process.exitCode && process.exitCode !== 0 ? "failed" : "finished";
    const errorSummary =
      normalizedEvent === "failed"
        ? `codex exited with code ${process.exitCode}`
        : undefined;
    await emitNativeHookEvent(cwd, "session-end", {
      session_id: sessionId,
      context: buildNativeHookBaseContext(cwd, sessionId, normalizedEvent, {
        project_path: cwd,
        project_name: basename(cwd),
        duration_ms: durationMs,
        reason: "session_exit",
        status: normalizedEvent === "failed" ? "failed" : "finished",
        ...(process.exitCode !== undefined
          ? { exit_code: process.exitCode }
          : {}),
        ...(errorSummary ? { error_summary: errorSummary } : {}),
      }),
    });
  } catch (err) {
    logCliOperationFailure(err);
    // Non-fatal
  }
}

async function emitNativeHookEvent(
  cwd: string,
  event: "session-start" | "session-end" | "session-idle" | "turn-complete",
  opts: {
    session_id?: string;
    thread_id?: string;
    turn_id?: string;
    mode?: string;
    context?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const payload = buildHookEvent(event, {
    source: "native",
    context: opts.context || {},
    session_id: opts.session_id,
    thread_id: opts.thread_id,
    turn_id: opts.turn_id,
    mode: opts.mode,
  });
  await dispatchHookEvent(payload, {
    cwd,
    enabled: true,
  });
}

function notifyFallbackPidPath(cwd: string): string {
  return join(cwd, ".omx", "state", "notify-fallback.pid");
}

function hookDerivedWatcherPidPath(cwd: string): string {
  return join(cwd, ".omx", "state", "hook-derived-watcher.pid");
}

export function shouldDetachBackgroundHelper(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  // The long-running watcher/helper itself must stay detached so it can
  // survive parent loss. Windows Git Bash/MSYS uses a short hidden bootstrap
  // process so the detached helper is created without stealing focus.
  void env;
  void platform;
  return true;
}

export type BackgroundHelperLaunchMode =
  | "direct-detached"
  | "windows-msys-bootstrap";

export function resolveBackgroundHelperLaunchMode(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): BackgroundHelperLaunchMode {
  return platform === "win32" && isMsysOrGitBash(env, platform)
    ? "windows-msys-bootstrap"
    : "direct-detached";
}

export function buildWindowsMsysBackgroundHelperBootstrapScript(
  helperArgs: readonly string[],
  cwd: string,
): string {
  const helperArgsLiteral = JSON.stringify(helperArgs);
  const cwdLiteral = JSON.stringify(cwd);
  return [
    "const { spawn } = require('child_process');",
    `const child = spawn(process.execPath, ${helperArgsLiteral}, { cwd: ${cwdLiteral}, detached: true, stdio: 'ignore', windowsHide: true, env: process.env });`,
    "if (!child.pid) process.exit(1);",
    "process.stdout.write(String(child.pid));",
    "child.unref();",
  ].join("");
}

async function launchBackgroundHelper(
  helperArgs: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<number | undefined> {
  const launchMode = resolveBackgroundHelperLaunchMode(
    options.env,
    process.platform,
  );

  if (launchMode === "windows-msys-bootstrap") {
    const { spawnSync } = await import("child_process");
    const bootstrap = spawnSync(
      process.execPath,
      [
        "-e",
        buildWindowsMsysBackgroundHelperBootstrapScript(
          helperArgs,
          options.cwd,
        ),
      ],
      {
        cwd: options.cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: options.env,
      },
    );

    if (bootstrap.error) {
      throw bootstrap.error;
    }

    if (bootstrap.status !== 0) {
      const detail = (bootstrap.stderr || bootstrap.stdout || "").trim();
      throw new Error(
        detail || `background helper bootstrap exited ${bootstrap.status}`,
      );
    }

    const helperPid = Number.parseInt((bootstrap.stdout || "").trim(), 10);
    return Number.isFinite(helperPid) && helperPid > 0
      ? helperPid
      : undefined;
  }

  const child = spawn(process.execPath, helperArgs, {
    cwd: options.cwd,
    detached: shouldDetachBackgroundHelper(options.env, process.platform),
    stdio: "ignore",
    windowsHide: true,
    env: options.env,
  });
  child.unref();
  return child.pid;
}

function parseWatcherPidFile(content: string): number | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "number") {
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    const pid =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { pid?: unknown }).pid
        : undefined;
    return typeof pid === "number" && Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    const pid = Number.parseInt(trimmed, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  }
}

interface WatcherPidRecord {
  pid: number;
  startedAt: string | null;
}

function parseWatcherPidRecord(content: string): WatcherPidRecord | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const { pid, started_at: startedAtRaw } = parsed as {
        pid?: unknown;
        started_at?: unknown;
      };
      if (typeof pid === "number" && Number.isFinite(pid) && pid > 0) {
        return {
          pid,
          startedAt: typeof startedAtRaw === "string" ? startedAtRaw : null,
        };
      }
    }
  } catch {
  }

  const pid = parseWatcherPidFile(trimmed);
  return pid ? { pid, startedAt: null } : null;
}

function isLikelyOmxWatcherProcess(
  pid: number,
  execFileSyncFn: typeof execFileSync = execFileSync,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") {
    // ps is unavailable on native Windows; fall back to unconditional reap
    // to preserve the pre-identity-check behavior on opted-in Windows hosts.
    return true;
  }
  try {
    const cmd = execFileSyncFn("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 2000,
      windowsHide: true,
    }) as string;
    return cmd.includes("notify-fallback-watcher") || cmd.includes("hook-derived-watcher");
  } catch {
    return false;
  }
}

export async function reapStaleNotifyFallbackWatcher(
  pidPath: string,
  deps: {
    exists?: (path: string) => boolean;
    readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
    tryKillPid?: (pid: number, signal?: NodeJS.Signals) => boolean;
    hasErrnoCode?: (error: unknown, code: string) => boolean;
    warn?: (message?: unknown, ...optionalParams: unknown[]) => void;
    isWatcherProcess?: (pid: number) => boolean;
  } = {},
): Promise<void> {
  const exists = deps.exists ?? existsSync;
  if (!exists(pidPath)) return;

  const { readFile } = await import("fs/promises");
  const readFileImpl = deps.readFile ?? readFile;
  const tryKillPidImpl = deps.tryKillPid ?? tryKillPid;
  const hasErrnoCodeImpl = deps.hasErrnoCode ?? hasErrnoCode;
  const warn = deps.warn ?? console.warn;
  const isWatcherProcessImpl = deps.isWatcherProcess ?? isLikelyOmxWatcherProcess;

  try {
    const record = parseWatcherPidRecord(await readFileImpl(pidPath, "utf-8"));
    if (record && isWatcherProcessImpl(record.pid)) {
      tryKillPidImpl(record.pid, "SIGTERM");
    }
  } catch (error: unknown) {
    if (!hasErrnoCodeImpl(error, "ESRCH")) {
      warn(
        "[omx] warning: failed to stop stale notify fallback watcher",
        {
          path: pidPath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
}

function tryKillPid(pid: number, signal: NodeJS.Signals = "SIGTERM"): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    throw error;
  }
}

async function startNotifyFallbackWatcher(
  cwd: string,
  options: { codexHomeOverride?: string; enableAuthority?: boolean; sessionId?: string } = {},
): Promise<void> {
  const { mkdir, writeFile } = await import("fs/promises");
  const pidPath = notifyFallbackPidPath(cwd);
  await reapStaleNotifyFallbackWatcher(pidPath);

  if (!shouldEnableNotifyFallbackWatcher(process.env, process.platform)) return;

  const pkgRoot = getPackageRoot();
  const watcherScript = resolveNotifyFallbackWatcherScript(pkgRoot);
  const notifyScript = resolveNotifyHookScript(pkgRoot);
  if (!existsSync(watcherScript) || !existsSync(notifyScript)) return;

  await mkdir(join(cwd, ".omx", "state"), { recursive: true }).catch(
    (error: unknown) => {
      console.warn(
        "[omx] warning: failed to create notify fallback watcher state directory",
        {
          cwd,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    },
  );
  const watcherEnv = buildNotifyFallbackWatcherEnv(process.env, {
    codexHomeOverride: options.codexHomeOverride,
    enableAuthority: options.enableAuthority === true,
    sessionId: options.sessionId,
  });
  let watcherPid: number | undefined;
  try {
    watcherPid = await launchBackgroundHelper(
      [
        watcherScript,
        "--cwd",
        cwd,
        "--notify-script",
        notifyScript,
        "--pid-file",
        pidPath,
        "--parent-pid",
        String(process.pid),
        ...(process.env.OMX_NOTIFY_FALLBACK_MAX_LIFETIME_MS
          ? [
            "--max-lifetime-ms",
            process.env.OMX_NOTIFY_FALLBACK_MAX_LIFETIME_MS,
          ]
          : []),
      ],
      {
        cwd,
        env: watcherEnv,
      },
    );
  } catch (error: unknown) {
    console.warn("[omx] warning: failed to launch notify fallback watcher", {
      cwd,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (!watcherPid) return;

  await writeFile(
    pidPath,
    JSON.stringify(
      { pid: watcherPid, started_at: new Date().toISOString() },
      null,
      2,
    ),
  ).catch((error: unknown) => {
    console.warn(
      "[omx] warning: failed to write notify fallback watcher pid file",
      {
        path: pidPath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  });
}

async function startHookDerivedWatcher(cwd: string): Promise<void> {
  if (process.env.OMX_HOOK_DERIVED_SIGNALS !== "1") return;

  const { mkdir, writeFile, readFile } = await import("fs/promises");
  const pidPath = hookDerivedWatcherPidPath(cwd);
  const pkgRoot = getPackageRoot();
  const watcherScript = resolveHookDerivedWatcherScript(pkgRoot);
  if (!existsSync(watcherScript)) return;

  if (existsSync(pidPath)) {
    try {
      const prev = JSON.parse(await readFile(pidPath, "utf-8")) as {
        pid?: number;
      };
      if (prev && typeof prev.pid === "number") {
        process.kill(prev.pid, "SIGTERM");
      }
    } catch (error: unknown) {
      console.warn("[omx] warning: failed to stop stale hook-derived watcher", {
        path: pidPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await mkdir(join(cwd, ".omx", "state"), { recursive: true }).catch(
    (error: unknown) => {
      console.warn(
        "[omx] warning: failed to create hook-derived watcher state directory",
        {
          cwd,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    },
  );
  let watcherPid: number | undefined;
  try {
    watcherPid = await launchBackgroundHelper([watcherScript, "--cwd", cwd], {
      cwd,
      env: process.env,
    });
  } catch (error: unknown) {
    console.warn("[omx] warning: failed to launch hook-derived watcher", {
      cwd,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (!watcherPid) return;

  await writeFile(
    pidPath,
    JSON.stringify(
      { pid: watcherPid, started_at: new Date().toISOString() },
      null,
      2,
    ),
  ).catch((error: unknown) => {
    console.warn(
      "[omx] warning: failed to write hook-derived watcher pid file",
      {
        path: pidPath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  });
}

async function stopNotifyFallbackWatcher(cwd: string): Promise<void> {
  const { readFile, unlink } = await import("fs/promises");
  const pidPath = notifyFallbackPidPath(cwd);
  if (!existsSync(pidPath)) return;

  try {
    const pid = parseWatcherPidFile(await readFile(pidPath, "utf-8"));
    if (pid) {
      tryKillPid(pid, "SIGTERM");
    }
  } catch (error: unknown) {
    if (!hasErrnoCode(error, "ESRCH")) {
      console.warn(
        "[omx] warning: failed to stop notify fallback watcher process",
        {
          path: pidPath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  await unlink(pidPath).catch((error: unknown) => {
    console.warn(
      "[omx] warning: failed to remove notify fallback watcher pid file",
      {
        path: pidPath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  });
}

async function stopHookDerivedWatcher(cwd: string): Promise<void> {
  const { readFile, unlink } = await import("fs/promises");
  const pidPath = hookDerivedWatcherPidPath(cwd);
  if (!existsSync(pidPath)) return;

  try {
    const parsed = JSON.parse(await readFile(pidPath, "utf-8")) as {
      pid?: number;
    };
    if (parsed && typeof parsed.pid === "number") {
      process.kill(parsed.pid, "SIGTERM");
    }
  } catch (error: unknown) {
    console.warn("[omx] warning: failed to stop hook-derived watcher process", {
      path: pidPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await unlink(pidPath).catch((error: unknown) => {
    console.warn(
      "[omx] warning: failed to remove hook-derived watcher pid file",
      {
        path: pidPath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  });
}

async function flushNotifyFallbackOnce(
  cwd: string,
  options: { codexHomeOverride?: string; enableAuthority?: boolean; sessionId?: string } = {},
): Promise<void> {
  if (!shouldEnableNotifyFallbackWatcher(process.env, process.platform)) return;
  const { spawnSync } = await import("child_process");
  const pkgRoot = getPackageRoot();
  const watcherScript = resolveNotifyFallbackWatcherScript(pkgRoot);
  const notifyScript = resolveNotifyHookScript(pkgRoot);
  if (!existsSync(watcherScript) || !existsSync(notifyScript)) return;
  spawnSync(
    process.execPath,
    [watcherScript, "--once", "--cwd", cwd, "--notify-script", notifyScript],
    {
      cwd,
      stdio: "ignore",
      timeout: 3000,
      windowsHide: true,
      env: buildNotifyFallbackWatcherEnv(process.env, {
        codexHomeOverride: options.codexHomeOverride,
        enableAuthority: options.enableAuthority === true,
        sessionId: options.sessionId,
      }),
    },
  );
}

async function flushHookDerivedWatcherOnce(cwd: string): Promise<void> {
  if (process.env.OMX_HOOK_DERIVED_SIGNALS !== "1") return;
  const { spawnSync } = await import("child_process");
  const pkgRoot = getPackageRoot();
  const watcherScript = resolveHookDerivedWatcherScript(pkgRoot);
  if (!existsSync(watcherScript)) return;
  spawnSync(process.execPath, [watcherScript, "--once", "--cwd", cwd], {
    cwd,
    stdio: "ignore",
    timeout: 3000,
    windowsHide: true,
    env: {
      ...process.env,
      OMX_HOOK_DERIVED_SIGNALS: "1",
    },
  });
}

async function cancelModes(): Promise<void> {
  const { writeFile, readFile } = await import("fs/promises");
  const cwd = process.cwd();
  const nowIso = new Date().toISOString();
  try {
    const refs = await listModeStateFilesWithScopePreference(cwd);
    const states = new Map<
      string,
      {
        path: string;
        scope: "root" | "session";
        state: Record<string, unknown>;
      }
    >();

    for (const ref of refs) {
      const content = await readFile(ref.path, "utf-8");
      let parsedState: Record<string, unknown>;
      try {
        parsedState = JSON.parse(content) as Record<string, unknown>;
      } catch (err) {
        logCliOperationFailure(err);
        continue;
      }
      states.set(ref.mode, {
        path: ref.path,
        scope: ref.scope,
        state: parsedState,
      });
    }

    const changed = new Set<string>();
    const reported = new Set<string>();

    const cancelMode = (
      mode: string,
      phase: string = "cancelled",
      reportIfWasActive: boolean = true,
    ): void => {
      const entry = states.get(mode);
      if (!entry) return;
      const wasActive = entry.state.active === true;
      const needsChange =
        entry.state.active !== false ||
        entry.state.current_phase !== phase ||
        typeof entry.state.completed_at !== "string" ||
        String(entry.state.completed_at).trim() === "";
      if (!needsChange) return;
      entry.state.active = false;
      entry.state.current_phase = phase;
      entry.state.completed_at = nowIso;
      entry.state.last_turn_at = nowIso;
      changed.add(mode);
      if (reportIfWasActive && wasActive) reported.add(mode);
    };

    const ralphLinksUltrawork = (state: Record<string, unknown>): boolean =>
      state.linked_ultrawork === true || state.linked_mode === "ultrawork";

    const ralph = states.get("ralph");
    const hadActiveRalph = !!(ralph && ralph.state.active === true);
    if (ralph && ralph.state.active === true) {
      cancelMode("ralph", "cancelled", true);
      if (ralphLinksUltrawork(ralph.state))
        cancelMode("ultrawork", "cancelled", true);
    }

    if (!hadActiveRalph) {
      for (const [mode, entry] of states.entries()) {
        if (entry.state.active === true) cancelMode(mode, "cancelled", true);
      }
    }

    for (const [mode, entry] of states.entries()) {
      if (!changed.has(mode)) continue;
      await writeFile(entry.path, JSON.stringify(entry.state, null, 2));
    }

    for (const mode of reported) {
      console.log(`Cancelled: ${mode}`);
    }

    if (reported.size === 0) {
      console.log("No active modes to cancel.");
    }
  } catch (err) {
    logCliOperationFailure(err);
    console.log("No active modes to cancel.");
  }
}
