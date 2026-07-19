/**
 * oh-my-codex CLI
 * Multi-agent orchestration for OpenAI Codex CLI
 */

import { execFileSync, spawn } from "child_process";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from "path";
import { chmodSync, closeSync, constants as fsConstants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { copyFile, cp, lstat, mkdir, open, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "fs/promises";
import { constants as osConstants, homedir } from "os";
import { createHash, randomUUID } from "crypto";
import {
  setup,
  SETUP_MCP_MODES,
  SETUP_SCOPES,
  SETUP_TEAM_MODES,
  type SetupInstallMode,
  type SetupMcpMode,
  type SetupScope,
  type SetupTeamMode,
} from "./setup.js";
import { uninstall } from "./uninstall.js";
import { version } from "./version.js";
import { tmuxHookCommand } from "./tmux-hook.js";
import { hooksCommand } from "./hooks.js";
import { hudCommand } from "../hud/index.js";
import { sidecarCommand } from "../sidecar/index.js";
import { teamCommand } from "./team.js";
import { ralphCommand } from "./ralph.js";
import { ralplanCommand } from "./ralplan.js";
import { ultragoalCommand } from "./ultragoal.js";
import { performanceGoalCommand } from "./performance-goal.js";
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
import { apiCommand } from "./api.js";
import { agentsInitCommand } from "./agents-init.js";
import { agentsCommand } from "./agents.js";
import { sessionCommand } from "./session-search.js";
import { urlCommand } from "./url.js";
import { autoresearchCommand } from "./autoresearch.js";
import { autoresearchGoalCommand } from "./autoresearch-goal.js";
import { mcpParityCommand } from "./mcp-parity.js";
import { mcpServeCommand } from "./mcp-serve.js";
import { adaptCommand } from "./adapt.js";
import { listCommand } from "./list.js";
import { authCommand } from "./auth.js";
import { missionCommand } from "./mission.js";
import {
  resolveCodexGlobalOptionValue,
  runAuthHotswap,
} from "../auth/hotswap.js";
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
  getBaseStateDirWithSource,
  getStateDir,
  listModeStateFilesWithScopePreference,
  resolveWritableStateScope,
  type ModeStateFileRef,
} from "../mcp/state-paths.js";
import { evaluateRalphCompletionAuditEvidence, isRalphCompletePhase } from "../ralph/completion-audit.js";
import { normalizeTerminalWorkflowState } from "../state/terminal-normalization.js";
import {
  readPersistedSetupPreferences,
  resolveCodexConfigPathForLaunch,
  resolveCodexHomeForLaunch,
  resolveProjectLocalCodexHomeForLaunch,
} from "./codex-home.js";
import { discoverProjectRuntimeCodexHomes } from "./project-runtime-codex-homes.js";
import {
  discoverOmxPluginCacheDirs,
  hasLocalOmxPluginEnablement,
  materializePackagedOmxPluginCache,
  packagedOmxPluginVersion,
  resolvePackagedOmxMarketplace,
  upsertLocalOmxMarketplaceRegistration,
  upsertLocalOmxPluginEnablement,
} from "./plugin-marketplace.js";
import { escapeTomlString, readTopLevelTomlString, upsertTopLevelTomlString } from "../utils/toml.js";
import {
  ROOT_REASONING_EFFORTS,
  isUnsupportedRootReasoningEffort,
  normalizeUnsupportedRootReasoningEffort,
} from "../config/models.js";


export {
  readPersistedSetupPreferences,
  readPersistedSetupScope,
  resolveCodexConfigPathForLaunch,
  resolveCodexHomeForLaunch,
  resolveProjectLocalCodexHomeForLaunch,
} from "./codex-home.js";
import {
  SKILL_ACTIVE_STATE_MODE,
  extractSessionIdFromInitializedStatePath,
  getSkillActiveStatePathsForStateDir,
  listActiveSkills,
  readSkillActiveState,
  syncCanonicalSkillStateForMode,
  type SkillActiveStateLike,
} from "../state/skill-active.js";
import { isTrackedWorkflowMode } from "../state/workflow-transition.js";
import { maybeCheckAndPromptUpdate, runImmediateUpdate, type UpdateChannel } from "./update.js";
import { maybePromptGithubStar } from "./star-prompt.js";
import {
  generateOverlay,
  removeSessionModelInstructionsFile,
  resolveSessionOrchestrationMode,
  sessionModelInstructionsPath,
  writeSessionModelInstructionsFile,
} from "../hooks/agents-overlay.js";
import {
  closeLaunchSessionBindingOnce,
  establishLaunchSessionBinding,
  readSessionState,
  updateDetachedSessionMetadata,
  finalizeBoundOnce,
  isSessionPointerLaunchAbort,
  normalizeSessionId,
  resetSessionMetrics,
  type LaunchSessionBinding,
  type EstablishmentCleanupEvidence,
} from "../hooks/session.js";
import { probeActualTmuxInstanceEvidence, tmuxEvidenceBindsCandidate } from "../scripts/notify-hook/managed-tmux.js";
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
import { codexConfigPath, omxRoot, rememberOmxLaunchContext, resolveOmxCliEntryPath } from "../utils/paths.js";
import { cleanCodexModelAvailabilityNuxIfNeeded, extractSharedMcpRegistryServersFromConfig, repairConfigIfNeeded, repairProjectScopeTrustStateForLaunch, syncProjectScopeTrustStateFromRuntime } from "../config/generator.js";
import type { UnifiedMcpRegistryServer } from "../config/mcp-registry.js";
import { OMX_FIRST_PARTY_MCP_SERVER_NAMES } from "../config/omx-first-party-mcp.js";
import { HUD_TMUX_HEIGHT_LINES, HUD_TMUX_MIN_LAUNCH_WINDOW_HEIGHT_LINES, isTmuxWindowTooCrampedForHudSplit } from "../hud/constants.js";
import { OMX_TMUX_HUD_OWNER_ENV } from "../hud/reconcile.js";
import { readUltragoalState } from "../hud/state.js";
import {
  createHudWatchPane as createSharedHudWatchPane,
  killTmuxPane as killSharedTmuxPane,
  listCurrentWindowHudPaneIds,
  listCurrentWindowPanes,
  buildHudRuntimeEnv,
  parsePaneIdFromTmuxOutput,
  reapDeadHudPanes,
  registerHudResizeHook,
  OMX_TMUX_HUD_LEADER_PANE_ENV,
  type RegisterHudResizeHookOptions,
  readCurrentWindowSize,
  resizeTmuxPane,
  unregisterHudResizeHook,
} from "../hud/tmux.js";

export { parseTmuxPaneSnapshot, isHudWatchPane, findHudWatchPaneIds } from "../hud/tmux.js";

rememberOmxLaunchContext({ argv1: process.argv[1], cwd: process.cwd(), env: process.env });
import {
  classifySpawnError,
  resolveTmuxBinaryForPlatform,
  spawnPlatformCommandSync,
} from "../utils/platform-command.js";
import { buildHookEvent } from "../hooks/extensibility/events.js";
import { dispatchHookEvent } from "../hooks/extensibility/dispatcher.js";
import {
  collectInheritableTeamWorkerArgs as collectInheritableTeamWorkerArgsShared,
  parseTeamWorkerLaunchArgs,
  resolveTeamWorkerLaunchArgs,
  resolveTeamLowComplexityDefaultModel,
  serializeTeamWorkerLaunchArgs,
  TEAM_WORKER_INHERITED_MODEL_ENV,
} from "../team/model-contract.js";

import {
  parseWorktreeMode,
  planWorktreeTarget,
  ensureWorktree,
} from "../team/worktree.js";
import { ensureReusableNodeModules } from "../utils/repo-deps.js";
import { resolveWorktreeToolContext, worktreeToolContextEnv } from "../utils/worktree-tool-context.js";
import {
  OMX_NOTIFY_TEMP_CONTRACT_ENV,
  parseNotifyTempContractFromArgs,
  serializeNotifyTempContract,
  type NotifyTempContract,
  type ParseNotifyTempContractResult,
} from "../notifications/temp-contract.js";
import { execInjectCommand } from "../exec/followup.js";
import { imagegenCommand } from "../imagegen/continuation.js";
import { capabilitiesCommand } from "./capabilities.js";

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
  omx           Launch Codex CLI (detached tmux by default on supported interactive terminals)
  omx exec      Run codex exec non-interactively with OMX AGENTS/overlay injection
  omx exec inject <session-id> --prompt <text>
                Queue audited follow-up instructions for a running non-interactive exec job
  omx mission <file>
                Run a prompt/checklist file sequentially through omx exec with durable summary
  omx imagegen continuation <session-id> --artifact <name>
                Queue a Stop-hook continuation for built-in image generation turns
  omx setup     Install skills, prompts, CLI-first config, and scope-specific AGENTS.md
                (user scope prompts for legacy vs plugin skill delivery when needed)
  omx update    Install the stable channel now, then refresh setup
  omx update --stable
                Install/rollback to npm stable (oh-my-codex@latest), then refresh setup
  omx update --dev
                Install the upstream dev branch, then refresh setup
  omx uninstall Remove OMX configuration and clean up installed artifacts
  omx doctor    Check installation health
  omx list      List packaged OMX skills and native agent prompts (--json)
  omx cleanup   Kill orphaned OMX MCP server processes and remove stale OMX /tmp directories
  omx doctor --team  Check team/swarm runtime health diagnostics
  omx ask       Ask local provider CLI (claude|gemini) and write artifact output
  omx auth      Manage Codex OAuth auth slots (add|list|use)
  omx question  OMX-owned blocking question UI entrypoint for agent-invoked user questions
  omx adapt     Scaffold OMX-owned adapter foundations for persistent external targets
  omx resume    Resume Codex sessions (supports --project and --codex-home <path>)
  omx explore   DEPRECATED compatibility command; use normal repo inspection or omx sparkshell
  omx api       Run native omx-api localhost gateway commands (serve|status|stop|generate)
  omx session   Search and summarize local session history (--codex-home <path> escape hatch)
                Includes session lock inspect/recover diagnostics
  omx url       Passive URL reader (read <url> --json)
  omx capabilities
                Lock/check deterministic configured tool, skill, agent, and observation surfaces
  omx agents-init [path]
                Bootstrap lightweight AGENTS.md files for a repo/subtree
  omx agents    Manage Codex native agent TOML files
  omx deepinit [path]
                Alias for agents-init (lightweight AGENTS bootstrap only)
  omx team      Spawn parallel worker panes in tmux and bootstrap inbox/task state
  omx ralph     Launch Codex with ralph persistence mode active
  omx ralplan   Record validated role intents for adapted native subagent spawns
  omx ultragoal Create, resume, and checkpoint durable multi-goal plans over Codex goal mode
  omx performance-goal
                Create, hand off, and gate evaluator-backed performance goals
  omx autoresearch-goal
                Create, hand off, and gate professor-critic research goals
  omx autoresearch [DEPRECATED] Use $autoresearch; direct CLI launch removed
  omx version   Show version information
  omx tmux-hook Manage tmux prompt injection workaround (init|status|validate|test)
  omx hooks     Manage hook plugins (init|status|validate|test)
  omx hud       Show HUD statusline (--watch, --json, --preset=NAME)
  omx sidecar   Show read-only team/multi-agent visualization (--watch, --json, --tmux)
  omx state     Read/write/list OMX mode state via CLI parity surface
  omx notepad   JSON CLI surface for OMX notepad operations
  omx project-memory
                JSON CLI surface for OMX project-memory operations
  omx trace     JSON CLI surface for OMX trace operations
  omx code-intel
                JSON CLI surface for OMX code-intel operations
  omx wiki      JSON CLI surface for OMX wiki operations
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
  --hotswap     Run a direct Codex session that rotates auth slots on 429/quota and resumes
  --direct       Launch the interactive leader directly without OMX tmux/HUD management
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
                Merge OMX-managed AGENTS.md sections and persist that explicit policy for this project root
  --no-merge-agents
                Persist an explicit non-merge policy; current non-merge behavior remains contextual
  --clear-merge-agents-policy
                Clear the persisted AGENTS merge policy for this project root
  --dry-run     Show what would be done without doing it
  --plugin      Use Codex plugin delivery for omx setup and remove legacy OMX-managed user/project components
  --legacy      Use legacy setup delivery for omx setup, overriding persisted plugin mode
  --install-mode <legacy|plugin>
                Explicit setup install mode (canonical form; --legacy/--plugin are aliases)
  --mcp <none|compat>
                Explicit setup MCP mode (default: none; compat enables first-party MCP compatibility and shared registry sync)
  --no-mcp      Alias for --mcp=none
  --with-mcp    Alias for --mcp=compat
  --disable-team
                Disable Team skill/context generation for setup (default remains enabled)
  --enable-team Re-enable Team skill/context generation for setup
  --team-mode <enabled|disabled>
                Explicit Team setup mode
  --keep-config Skip config.toml cleanup during uninstall
  --purge       Remove .omx/ cache directory during uninstall
  --verbose     Show detailed output
  --scope       Setup scope for "omx setup" only:
                user | project

Launch policy:
  OMX_LAUNCH_POLICY=auto
                Use the default policy: detached tmux when supported, direct otherwise
  OMX_LAUNCH_POLICY=direct
                Run without OMX tmux/HUD management
  OMX_LAUNCH_POLICY=tmux
                Force OMX-managed detached tmux launch
  OMX_LAUNCH_POLICY=detached-tmux
                Force OMX-managed detached tmux launch
  CLI policy flags (--direct/--tmux) override OMX_LAUNCH_POLICY; the last flag before -- wins.
  Unset or empty OMX_LAUNCH_POLICY returns to auto/default behavior.
  Config files are intentionally not used for launch policy in this release.
`;

const REASONING_KEY = "model_reasoning_effort";
const MODEL_INSTRUCTIONS_FILE_KEY = "model_instructions_file";
const TEAM_WORKER_LAUNCH_ARGS_ENV = "OMX_TEAM_WORKER_LAUNCH_ARGS";
const TEAM_INHERIT_LEADER_FLAGS_ENV = "OMX_TEAM_INHERIT_LEADER_FLAGS";
const OMX_BYPASS_DEFAULT_SYSTEM_PROMPT_ENV = "OMX_BYPASS_DEFAULT_SYSTEM_PROMPT";
const OMX_MODEL_INSTRUCTIONS_FILE_ENV = "OMX_MODEL_INSTRUCTIONS_FILE";
const OMX_INSTANCE_OPTION = "@omx_instance_id";
const OMX_RALPH_APPEND_INSTRUCTIONS_FILE_ENV =
  "OMX_RALPH_APPEND_INSTRUCTIONS_FILE";
const OMX_AUTORESEARCH_APPEND_INSTRUCTIONS_FILE_ENV =
  "OMX_AUTORESEARCH_APPEND_INSTRUCTIONS_FILE";
const REASONING_MODES = ROOT_REASONING_EFFORTS;
type ReasoningMode = (typeof REASONING_MODES)[number];
const REASONING_MODE_SET = new Set<string>(REASONING_MODES);
const REASONING_USAGE = "Usage: omx reasoning <low|medium|high|xhigh>";

function unsupportedLaunchShorthandError(flag: "--max" | "--ultra"): Error {
  const guidance = flag === "--max"
    ? 'No --max shorthand exists; use agentReasoning for per-agent "max" or pass -c model_reasoning_effort=... directly to Codex.'
    : '"ultra" is not an OMX root or per-agent reasoning value and is not an alias for "max".';
  return new Error(`Unsupported OMX launch shorthand "${flag}".\n${guidance}\nRun "omx help" for usage.`);
}

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
  | "mission"
  | "capabilities"
  | "imagegen"
  | "setup"
  | "update"
  | "list"
  | "agents"
  | "agents-init"
  | "deepinit"
  | "uninstall"
  | "doctor"
  | "cleanup"
  | "auth"
  | "ask"
  | "question"
  | "adapt"
  | "explore"
  | "api"
  | "sparkshell"
  | "team"
  | "session"
  | "url"
  | "resume"
  | "version"
  | "tmux-hook"
  | "hooks"
  | "hud"
  | "sidecar"
  | "state"
  | "notepad"
  | "project-memory"
  | "trace"
  | "code-intel"
  | "wiki"
  | "mcp-serve"
  | "status"
  | "cancel"
  | "help"
  | "reasoning"
  | "codex-native-hook"
  | string;

const RESUME_HELP = `Usage: omx resume [--project] [--codex-home <path>] [codex resume options]

Read-only help does not prepare or launch a Codex session.`;

const NESTED_HELP_COMMANDS = new Set<CliCommand>([
  "ask",
  "question",
  "cleanup",
  "auth",
  "adapt",
  "explore",
  "autoresearch",
  "autoresearch-goal",
  "agents",
  "agents-init",
  "deepinit",
  "exec",
  "capabilities",
  "mission",
  "imagegen",
  "hooks",
  "list",
  "hud",
  "sidecar",
  "state",
  "notepad",
  "project-memory",
  "trace",
  "code-intel",
  "wiki",
  "mcp-serve",
  "ralph",
  "ralplan",
  "ultragoal",
  "performance-goal",
  "resume",
  "session",
  "url",
  "api",
  "sparkshell",
  "team",
  "tmux-hook",
]);

export interface ResolvedCliInvocation {
  command: CliCommand;
  launchArgs: string[];
}

export type SetupMergeAgentsPolicyArg =
  | { kind: "set"; value: boolean }
  | { kind: "clear" }
  | undefined;

export function resolveSetupAgentsMergePolicyArg(args: string[]): SetupMergeAgentsPolicyArg {
  let policy: SetupMergeAgentsPolicyArg;
  const setPolicy = (next: Exclude<SetupMergeAgentsPolicyArg, undefined>, source: string): void => {
    if (policy && (policy.kind !== next.kind || (policy.kind === "set" && next.kind === "set" && policy.value !== next.value))) {
      throw new Error(`Conflicting setup AGENTS merge policy flags: ${source} conflicts with another merge policy selector.`);
    }
    policy = next;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--merge-agents" || arg === "--no-merge-agents" || arg === "--clear-merge-agents-policy") {
      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        throw new Error(`Setup AGENTS merge policy flags do not accept values: ${arg} ${next}`);
      }
      if (arg === "--merge-agents") {
        setPolicy({ kind: "set", value: true }, arg);
      } else if (arg === "--no-merge-agents") {
        setPolicy({ kind: "set", value: false }, arg);
      } else {
        setPolicy({ kind: "clear" }, arg);
      }
    } else if (
      arg.startsWith("--merge-agents=") ||
      arg.startsWith("--no-merge-agents=") ||
      arg.startsWith("--clear-merge-agents-policy=")
    ) {
      throw new Error(`Setup AGENTS merge policy flags do not accept values: ${arg}`);
    }
  }
  return policy;
}

export function resolveSetupMergeAgentsArg(args: string[]): boolean | undefined {
  const policy = resolveSetupAgentsMergePolicyArg(args);
  return policy?.kind === "set" ? policy.value : undefined;
}

export function resolveSetupInstallModeArg(args: string[]): SetupInstallMode | undefined {
  let value: SetupInstallMode | undefined;
  const setValue = (next: SetupInstallMode, source: string): void => {
    if (value && value !== next) {
      throw new Error(
        `Conflicting setup install mode flags: ${source} selects ${next}, but another flag already selected ${value}`,
      );
    }
    value = next;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--plugin") {
      setValue("plugin", arg);
      continue;
    }
    if (arg === "--legacy") {
      setValue("legacy", arg);
      continue;
    }
    if (arg === "--install-mode") {
      const next = args[index + 1];
      if (!next || next.startsWith("-")) {
        throw new Error(
          `Missing setup install mode value after --install-mode. Expected one of: legacy, plugin`,
        );
      }
      if (next !== "legacy" && next !== "plugin") {
        throw new Error(
          `Invalid setup install mode: ${next}. Expected one of: legacy, plugin`,
        );
      }
      setValue(next, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--install-mode=")) {
      const next = arg.slice("--install-mode=".length);
      if (next !== "legacy" && next !== "plugin") {
        throw new Error(
          `Invalid setup install mode: ${next}. Expected one of: legacy, plugin`,
        );
      }
      setValue(next, "--install-mode");
    }
  }

  return value;
}


export function resolveSetupMcpModeArg(args: string[]): SetupMcpMode | undefined {
  let value: SetupMcpMode | undefined;
  const setValue = (next: SetupMcpMode, source: string): void => {
    if (value && value !== next) {
      throw new Error(
        `Conflicting setup MCP mode flags: ${source} selects ${next}, but another flag already selected ${value}`,
      );
    }
    value = next;
  };
  const parseValue = (next: string): SetupMcpMode => {
    if (!SETUP_MCP_MODES.includes(next as SetupMcpMode)) {
      throw new Error(
        `Invalid setup MCP mode: ${next}. Expected one of: none, compat`,
      );
    }
    return next as SetupMcpMode;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--no-mcp") {
      setValue("none", arg);
      continue;
    }
    if (arg === "--with-mcp") {
      setValue("compat", arg);
      continue;
    }
    if (arg === "--mcp") {
      const next = args[index + 1];
      if (!next || next.startsWith("-")) {
        throw new Error(
          `Missing setup MCP mode value after --mcp. Expected one of: none, compat`,
        );
      }
      setValue(parseValue(next), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--mcp=")) {
      setValue(parseValue(arg.slice("--mcp=".length)), "--mcp");
    }
  }

  return value;
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

export function resolveSetupTeamModeArg(args: string[]): SetupTeamMode | undefined {
  let value: SetupTeamMode | undefined;
  const setValue = (next: SetupTeamMode, source: string): void => {
    if (value && value !== next) {
      throw new Error(
        `Conflicting setup Team mode flags: ${source} selects ${next}, but another flag already selected ${value}`,
      );
    }
    value = next;
  };
  const parseValue = (next: string): SetupTeamMode => {
    if (!SETUP_TEAM_MODES.includes(next as SetupTeamMode)) {
      throw new Error(
        `Invalid setup Team mode: ${next}. Expected one of: enabled, disabled`,
      );
    }
    return next as SetupTeamMode;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--disable-team" || arg === "--no-team") {
      setValue("disabled", arg);
      continue;
    }
    if (arg === "--enable-team" || arg === "--team") {
      setValue("enabled", arg);
      continue;
    }
    if (arg === "--team-mode") {
      const next = args[index + 1];
      if (!next || next.startsWith("-")) {
        throw new Error(
          `Missing setup Team mode value after --team-mode. Expected one of: enabled, disabled`,
        );
      }
      setValue(parseValue(next), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--team-mode=")) {
      setValue(parseValue(arg.slice("--team-mode=".length)), "--team-mode");
    }
  }

  return value;
}

function splitOmxArgsAtEndOfOptions(args: string[]): {
  omxArgs: string[];
  suffix: string[];
} {
  const endOfOptionsIndex = args.indexOf("--");
  if (endOfOptionsIndex === -1) return { omxArgs: args, suffix: [] };
  return {
    omxArgs: args.slice(0, endOfOptionsIndex),
    suffix: args.slice(endOfOptionsIndex),
  };
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
  if (firstArg === "__detached-session-leader") {
    return { command: firstArg, launchArgs: args.slice(1) };
  }
  return { command: firstArg, launchArgs: [] };
}

export function resolveUpdateChannelArg(args: string[]): UpdateChannel {
  let channel: UpdateChannel = 'stable';
  let sawStable = false;
  let sawDev = false;

  for (const arg of args) {
    if (arg === '--stable') {
      sawStable = true;
      channel = 'stable';
      continue;
    }
    if (arg === '--dev') {
      sawDev = true;
      channel = 'dev';
      continue;
    }
    throw new Error(
      `Unknown omx update option: ${arg}. Expected no flags, --stable, or --dev.`,
    );
  }

  if (sawStable && sawDev) {
    throw new Error('omx update --dev and --stable are mutually exclusive.');
  }

  return channel;
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

const OMX_LAUNCH_POLICY_ENV = "OMX_LAUNCH_POLICY";
let warnedInvalidEnvLaunchPolicy = false;

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

    if (arg === "--direct") {
      explicitPolicy = "direct";
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

export function resolveEnvLaunchPolicyOverride(
  env: NodeJS.ProcessEnv = process.env,
): CodexLaunchPolicy | undefined {
  const rawValue = env[OMX_LAUNCH_POLICY_ENV]?.trim();
  if (!rawValue) return undefined;

  const value = rawValue.toLowerCase();
  if (value === "auto") return undefined;
  if (value === "direct") return "direct";
  if (value === "tmux" || value === "detached-tmux") return "detached-tmux";

  if (!warnedInvalidEnvLaunchPolicy) {
    warnedInvalidEnvLaunchPolicy = true;
    console.warn(
      `[omx] warning: invalid ${OMX_LAUNCH_POLICY_ENV}="${rawValue}". ` +
        "Expected direct, tmux, detached-tmux, or auto. Falling back to auto/default launch policy.",
    );
  }
  return undefined;
}

export function resolveEffectiveLeaderLaunchPolicyOverride(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): CodexLaunchPolicy | undefined {
  return (
    resolveLeaderLaunchPolicyOverride(args) ?? resolveEnvLaunchPolicyOverride(env)
  );
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
  if (explicitPolicy === "direct") return "direct";
  if (env.TMUX) return "inside-tmux";
  if (explicitPolicy === "detached-tmux") return tmuxAvailable ? "detached-tmux" : "direct";
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


export interface PreparedCodexHomeForLaunch {
  codexHomeOverride?: string;
  sqliteHomeOverride?: string;
  projectLocalCodexHomeForCleanup?: string;
  runtimeCodexHomeForCleanup?: string;
}

export const CODEX_SQLITE_HOME_ENV = "CODEX_SQLITE_HOME";

export function runtimeCodexHomePath(
  cwd: string,
  sessionId: string,
): string {
  return join(omxRoot(cwd), "runtime", "codex-home", sessionId);
}

async function linkOrCopyCodexHomeEntry(source: string, destination: string): Promise<void> {
  const stat = await lstat(source);
  try {
    await symlink(source, destination, stat.isDirectory() && process.platform === "win32" ? "junction" : undefined);
  } catch {
    if (stat.isDirectory()) {
      await cp(source, destination, { recursive: true, force: true, verbatimSymlinks: true });
      return;
    }
    await copyFile(source, destination);
  }
}

async function copyFilePreservingTimestamps(source: string, destination: string): Promise<void> {
  await copyFile(source, destination);
  const sourceStat = await stat(source);
  await utimes(destination, sourceStat.atime, sourceStat.mtime);
}

function isCodexSqliteArtifact(entryName: string): boolean {
  return /^(?:state|logs)_\d+\.sqlite(?:-(?:shm|wal))?$/.test(entryName);
}

const PROJECT_LAUNCH_PERSISTED_RUNTIME_ENTRY_NAMES = new Set([
  // Codex CLI writes browser/OTP login state here when CODEX_HOME points at
  // the per-session mirror. Persist only the opaque file itself; never parse or
  // log the contents.
  "auth.json",
]);

const PROJECT_LAUNCH_DURABLE_HISTORY_ENTRY_NAMES = new Set([
  "sessions",
  "history.jsonl",
  "session_index.jsonl",
]);

// Mirroring these files into the runtime CODEX_HOME would cause Codex to load
// them as user-scope config alongside the canonical project-scope copies under
// <cwd>/.codex, duplicating every native hook and asking the user to re-trust
// hooks on every launch. See GH issue #2470.
const PROJECT_LAUNCH_RUNTIME_SKIPPED_ENTRY_NAMES = new Set(["hooks.json"]);

function shouldMirrorProjectLaunchRuntimeEntry(entryName: string, includeHistoryArtifacts: boolean): boolean {
  if (PROJECT_LAUNCH_DURABLE_HISTORY_ENTRY_NAMES.has(entryName)) return true;
  if (isCodexSqliteArtifact(entryName)) return includeHistoryArtifacts;
  return true;
}

function shouldPersistProjectLaunchRuntimeEntry(entryName: string): boolean {
  return PROJECT_LAUNCH_PERSISTED_RUNTIME_ENTRY_NAMES.has(entryName);
}

function uniqueJsonlLines(contents: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (line === "" || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

async function persistProjectLaunchRuntimeJsonlArtifact(source: string, destination: string): Promise<void> {
  const existing = existsSync(destination) ? await readFile(destination, "utf-8").catch(() => "") : "";
  const sourceContents = await readFile(source, "utf-8");
  const separator = existing === "" || existing.endsWith("\n") || sourceContents === "" ? "" : "\n";
  const lines = uniqueJsonlLines(`${existing}${separator}${sourceContents}`);
  await writeFile(destination, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf-8");
}

async function persistProjectLaunchRuntimeHistoryArtifacts(
  runtimeCodexHome: string | undefined,
  projectCodexHome: string | undefined,
): Promise<void> {
  if (!runtimeCodexHome || !projectCodexHome) return;
  if (!existsSync(runtimeCodexHome)) return;
  await mkdir(projectCodexHome, { recursive: true });

  for (const entryName of PROJECT_LAUNCH_DURABLE_HISTORY_ENTRY_NAMES) {
    const source = join(runtimeCodexHome, entryName);
    if (!existsSync(source)) continue;
    const sourceStat = await lstat(source);
    if (sourceStat.isSymbolicLink()) continue;
    const destination = join(projectCodexHome, entryName);
    if (sourceStat.isDirectory()) {
      await cp(source, destination, { recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true });
      continue;
    }
    if (entryName === "history.jsonl" || entryName === "session_index.jsonl") {
      await persistProjectLaunchRuntimeJsonlArtifact(source, destination);
      continue;
    }
    if (sourceStat.isFile()) {
      await copyFilePreservingTimestamps(source, destination);
    }
  }
}

async function ensureProjectLaunchRuntimeHistoryLinks(
  runtimeCodexHome: string,
  projectCodexHome: string,
): Promise<void> {
  await mkdir(projectCodexHome, { recursive: true });
  for (const entryName of PROJECT_LAUNCH_DURABLE_HISTORY_ENTRY_NAMES) {
    const runtimeEntry = join(runtimeCodexHome, entryName);
    if (existsSync(runtimeEntry)) continue;
    const projectEntry = join(projectCodexHome, entryName);
    if (entryName === "sessions") {
      await mkdir(projectEntry, { recursive: true });
    } else if (!existsSync(projectEntry)) {
      await writeFile(projectEntry, "");
    }
    await linkOrCopyCodexHomeEntry(projectEntry, runtimeEntry);
  }
}

async function materializeProjectLaunchRuntimeHistoryEntries(
  runtimeCodexHome: string,
  sourceCodexHome: string,
): Promise<void> {
  for (const entryName of PROJECT_LAUNCH_DURABLE_HISTORY_ENTRY_NAMES) {
    const source = join(sourceCodexHome, entryName);
    if (!existsSync(source)) continue;
    const destination = join(runtimeCodexHome, entryName);
    await rm(destination, { recursive: true, force: true });
    const sourceStat = await lstat(source);
    if (sourceStat.isDirectory()) {
      await cp(source, destination, { recursive: true, force: true, dereference: true, preserveTimestamps: true });
      continue;
    }
    await copyFilePreservingTimestamps(source, destination);
  }
}

async function mergeProjectLaunchRuntimeHistoryEntries(
  runtimeCodexHome: string,
  sourceCodexHome: string,
  mergedHistorySourceRealpaths: Set<string>,
): Promise<void> {
  for (const entryName of PROJECT_LAUNCH_DURABLE_HISTORY_ENTRY_NAMES) {
    const source = join(sourceCodexHome, entryName);
    if (!existsSync(source)) continue;
    const sourceRealpath = realpathSync(source);
    if (mergedHistorySourceRealpaths.has(sourceRealpath)) continue;
    const destination = join(runtimeCodexHome, entryName);
    const sourceStat = await stat(source);
    if (sourceStat.isDirectory()) {
      await mkdir(destination, { recursive: true });
      await cp(source, destination, { recursive: true, force: true, dereference: true, preserveTimestamps: true });
      mergedHistorySourceRealpaths.add(sourceRealpath);
      continue;
    }
    if (entryName === "sessions") continue;
    if (!sourceStat.isFile()) continue;
    if (existsSync(destination)) {
      const destinationStat = await stat(destination);
      if (!destinationStat.isFile()) {
        await rm(destination, { recursive: true, force: true });
        await copyFilePreservingTimestamps(source, destination);
        mergedHistorySourceRealpaths.add(sourceRealpath);
        continue;
      }
      const existing = await readFile(destination, "utf-8").catch(() => "");
      const addition = await readFile(source, "utf-8");
      const separator = existing === "" || existing.endsWith("\n") || addition === "" ? "" : "\n";
      await writeFile(destination, `${existing}${separator}${addition}`, "utf-8");
      mergedHistorySourceRealpaths.add(sourceRealpath);
      continue;
    }
    await copyFilePreservingTimestamps(source, destination);
    mergedHistorySourceRealpaths.add(sourceRealpath);
  }
}

export async function persistProjectLaunchRuntimeAuthState(
  runtimeCodexHome: string | undefined,
  projectCodexHome: string | undefined,
): Promise<void> {
  if (!runtimeCodexHome || !projectCodexHome) return;
  if (!existsSync(runtimeCodexHome)) return;
  await mkdir(projectCodexHome, { recursive: true });

  for (const entry of await readdir(runtimeCodexHome, { withFileTypes: true })) {
    if (!shouldPersistProjectLaunchRuntimeEntry(entry.name) || !entry.isFile()) continue;
    await copyFile(join(runtimeCodexHome, entry.name), join(projectCodexHome, entry.name));
  }
}

/**
 * Project-scope setup keeps durable Codex config under <repo>/.codex, but the
 * Codex TUI also stores model-availability NUX counters in CODEX_HOME/config.toml.
 * Launch against a session mirror so those runtime writes never dirty the
 * durable project config while preserving the project config as the launch input.
 */
export interface PrepareRuntimeCodexHomeForProjectLaunchOptions {
  includeHistoryArtifacts?: boolean;
  extraHistoryCodexHomes?: string[];
}

export async function prepareRuntimeCodexHomeForProjectLaunch(
  cwd: string,
  sessionId: string,
  projectCodexHome: string,
  options: PrepareRuntimeCodexHomeForProjectLaunchOptions = {},
): Promise<string> {
  const runtimeCodexHome = runtimeCodexHomePath(cwd, sessionId);
  await rm(runtimeCodexHome, { recursive: true, force: true });
  await mkdir(runtimeCodexHome, { recursive: true });

  if (!existsSync(projectCodexHome)) {
    await ensureProjectLaunchRuntimeHistoryLinks(runtimeCodexHome, projectCodexHome);
    return runtimeCodexHome;
  }

  for (const entry of await readdir(projectCodexHome, { withFileTypes: true })) {
    if (!shouldMirrorProjectLaunchRuntimeEntry(entry.name, options.includeHistoryArtifacts === true)) continue;
    if (PROJECT_LAUNCH_RUNTIME_SKIPPED_ENTRY_NAMES.has(entry.name)) continue;
    const source = join(projectCodexHome, entry.name);
    const destination = join(runtimeCodexHome, entry.name);
    if (entry.name === "config.toml") {
      const projectHooksPath = join(projectCodexHome, "hooks.json");
      const projectConfig = await readFile(source, "utf-8");
      const launchConfig = repairProjectScopeTrustStateForLaunch(
        projectConfig,
        projectHooksPath,
      );
      if (launchConfig !== projectConfig) {
        await writeFile(source, launchConfig, "utf-8");
      }
      await writeFile(destination, launchConfig, "utf-8");
      continue;
    }
    await linkOrCopyCodexHomeEntry(source, destination);
  }
  await ensureProjectLaunchRuntimeHistoryLinks(runtimeCodexHome, projectCodexHome);
  if (options.includeHistoryArtifacts === true && (options.extraHistoryCodexHomes?.length ?? 0) > 0) {
    const mergedHistorySourceRealpaths = new Set<string>();
    for (const entryName of PROJECT_LAUNCH_DURABLE_HISTORY_ENTRY_NAMES) {
      const source = join(projectCodexHome, entryName);
      if (existsSync(source)) mergedHistorySourceRealpaths.add(realpathSync(source));
    }
    await materializeProjectLaunchRuntimeHistoryEntries(runtimeCodexHome, projectCodexHome);
    for (const extraCodexHome of options.extraHistoryCodexHomes ?? []) {
      await mergeProjectLaunchRuntimeHistoryEntries(runtimeCodexHome, extraCodexHome, mergedHistorySourceRealpaths);
    }
  }


  return runtimeCodexHome;
}

function resolveProjectSqliteHomeForLaunch(
  projectCodexHome: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const configured = env[CODEX_SQLITE_HOME_ENV];
  if (typeof configured === "string" && configured.trim() !== "") return undefined;
  return projectCodexHome;
}

export interface PrepareCodexHomeForLaunchOptions {
  includeHistoryArtifacts?: boolean;
  extraHistoryCodexHomes?: string[];
}

export async function prepareCodexHomeForLaunch(
  cwd: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  options: PrepareCodexHomeForLaunchOptions = {},
): Promise<PreparedCodexHomeForLaunch> {
  const projectLocalCodexHomeForCleanup = resolveProjectLocalCodexHomeForLaunch(cwd, env);
  if (projectLocalCodexHomeForCleanup) {
    const runtimeCodexHome = await prepareRuntimeCodexHomeForProjectLaunch(
      cwd,
      sessionId,
      projectLocalCodexHomeForCleanup,
      { includeHistoryArtifacts: options.includeHistoryArtifacts, extraHistoryCodexHomes: options.extraHistoryCodexHomes },
    );
    return {
      codexHomeOverride: runtimeCodexHome,
      sqliteHomeOverride: resolveProjectSqliteHomeForLaunch(projectLocalCodexHomeForCleanup, env),
      projectLocalCodexHomeForCleanup,
      runtimeCodexHomeForCleanup: runtimeCodexHome,
    };
  }

  return {
    codexHomeOverride: resolveCodexHomeForLaunch(cwd, env),
    projectLocalCodexHomeForCleanup,
  };
}

export interface ResumeCodexHomeSelection {
  args: string[];
  explicitCodexHome?: string;
  projectOnly: boolean;
}

export function parseResumeCodexHomeSelection(args: string[]): ResumeCodexHomeSelection {
  const { omxArgs, suffix } = splitOmxArgsAtEndOfOptions(args);
  const nextArgs: string[] = [];
  let explicitCodexHome: string | undefined;
  let projectOnly = false;

  for (let index = 0; index < omxArgs.length; index += 1) {
    const arg = omxArgs[index];
    if (arg === "--codex-home") {
      const value = omxArgs[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("Missing value after --codex-home.");
      }
      explicitCodexHome = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--codex-home=")) {
      explicitCodexHome = arg.slice("--codex-home=".length);
      if (explicitCodexHome.trim() === "") {
        throw new Error("Missing value after --codex-home.");
      }
      continue;
    }
    if (arg === "--project") {
      projectOnly = true;
      continue;
    }
    nextArgs.push(arg);
  }

  return {
    args: [...nextArgs, ...suffix],
    explicitCodexHome,
    projectOnly,
  };
}

export interface ResumePluginPreflightResult {
  status: "unavailable" | "skipped" | "prepared";
  version?: string;
  cacheDir?: string;
  prunedStaleDirs: string[];
  configUpdated: boolean;
}

export interface ResumePluginPreflightOptions {
  projectRoot?: string;
}

async function shouldPreflightResumeOmxPluginState(
  selectedCodexHomeDir: string,
  existingConfig: string,
  options: ResumePluginPreflightOptions,
): Promise<boolean> {
  if (hasLocalOmxPluginEnablement(existingConfig)) return true;
  if (
    options.projectRoot &&
    readPersistedSetupPreferences(options.projectRoot)?.installMode === "plugin"
  ) {
    return true;
  }
  return (await discoverOmxPluginCacheDirs(selectedCodexHomeDir)).length > 0;
}

export async function preflightResumeOmxPluginState(
  codexHomeDir: string | undefined,
  pkgRoot = getPackageRoot(),
  options: ResumePluginPreflightOptions = {},
): Promise<ResumePluginPreflightResult> {
  const selectedCodexHomeDir = codexHomeDir && codexHomeDir.trim() !== ""
    ? codexHomeDir
    : join(homedir(), ".codex");
  const configPath = join(selectedCodexHomeDir, "config.toml");
  const existingConfig = existsSync(configPath) ? await readFile(configPath, "utf-8") : "";
  if (!(await shouldPreflightResumeOmxPluginState(selectedCodexHomeDir, existingConfig, options))) {
    return { status: "skipped", prunedStaleDirs: [], configUpdated: false };
  }

  const packagedMarketplace = await resolvePackagedOmxMarketplace(pkgRoot);
  if (!packagedMarketplace) {
    return { status: "unavailable", prunedStaleDirs: [], configUpdated: false };
  }

  const materialized = await materializePackagedOmxPluginCache(selectedCodexHomeDir, packagedMarketplace);
  const version = materialized.version ?? (await packagedOmxPluginVersion(packagedMarketplace)) ?? undefined;
  const currentCacheDir = materialized.cacheDir ?? (version ? join(selectedCodexHomeDir, "plugins", "cache", "oh-my-codex-local", "oh-my-codex", version) : undefined);
  const prunedStaleDirs: string[] = [];

  const nextConfig = upsertLocalOmxMarketplaceRegistration(
    upsertLocalOmxPluginEnablement(existingConfig),
    pkgRoot,
  );
  const configUpdated = nextConfig !== existingConfig;
  if (configUpdated) {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, nextConfig, "utf-8");
  }

  return {
    status: "prepared",
    version,
    cacheDir: currentCacheDir,
    prunedStaleDirs,
    configUpdated,
  };
}

export { CODEX_GLOBAL_OPTIONS_WITH_SPLIT_VALUE } from "../auth/hotswap.js";

export function isResumeCodexLaunch(args: string[]): boolean {
  const { omxArgs } = splitOmxArgsAtEndOfOptions(args);
  for (let index = 0; index < omxArgs.length; index += 1) {
    const arg = omxArgs[index];
    const optionValue = resolveCodexGlobalOptionValue(arg);
    if (optionValue?.valueArity === "single") {
      if (!optionValue.attached) index += 1;
      continue;
    }
    if (optionValue?.valueArity === "variadic") {
      if (optionValue.attached) continue;
      let nextIndex = index + 1;
      while (nextIndex < omxArgs.length && !omxArgs[nextIndex]!.startsWith("-")) {
        nextIndex += 1;
      }
      index = nextIndex - 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg === "resume";
  }
  return false;
}

async function prepareResumeCodexHomeForLaunch(
  cwd: string,
  sessionId: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ args: string[]; prepared: PreparedCodexHomeForLaunch }> {
  const selection = parseResumeCodexHomeSelection(args);
  if (selection.explicitCodexHome) {
    const codexHomeOverride = resolve(selection.explicitCodexHome);
    await preflightResumeOmxPluginState(codexHomeOverride, getPackageRoot(), { projectRoot: cwd });
    return {
      args: selection.args,
      prepared: {
        codexHomeOverride,
      },
    };
  }

  const projectHomes = await discoverProjectRuntimeCodexHomes(cwd);
  if (selection.projectOnly) {
    if (projectHomes.length === 0) {
      const emptyRuntimeCodexHome = runtimeCodexHomePath(cwd, sessionId);
      await rm(emptyRuntimeCodexHome, { recursive: true, force: true });
      await mkdir(join(emptyRuntimeCodexHome, "sessions"), { recursive: true });
      await preflightResumeOmxPluginState(emptyRuntimeCodexHome, getPackageRoot(), { projectRoot: cwd });
      return {
        args: selection.args,
        prepared: {
          codexHomeOverride: emptyRuntimeCodexHome,
          runtimeCodexHomeForCleanup: emptyRuntimeCodexHome,
        },
      };
    }
    const runtimeCodexHome = await prepareRuntimeCodexHomeForProjectLaunch(cwd, sessionId, projectHomes[0].path, {
      includeHistoryArtifacts: true,
      extraHistoryCodexHomes: projectHomes.slice(1).map((home) => home.path),
    });
    await preflightResumeOmxPluginState(runtimeCodexHome, getPackageRoot(), { projectRoot: cwd });
    return {
      args: selection.args,
      prepared: {
        codexHomeOverride: runtimeCodexHome,
      },
    };
  }

  const prepared = await prepareCodexHomeForLaunch(cwd, sessionId, env, {
    includeHistoryArtifacts: true,
    extraHistoryCodexHomes: projectHomes.map((home) => home.path),
  });
  await preflightResumeOmxPluginState(prepared.codexHomeOverride, getPackageRoot(), { projectRoot: cwd });
  return { args: selection.args, prepared };
}

export async function persistProjectLaunchRuntimeProjectTrustState(
  runtimeCodexHome: string | undefined,
  projectCodexHome: string | undefined,
): Promise<void> {
  if (!runtimeCodexHome || !projectCodexHome) return;
  const runtimeConfigPath = join(runtimeCodexHome, "config.toml");
  if (!existsSync(runtimeConfigPath)) return;
  const projectConfigPath = join(projectCodexHome, "config.toml");
  const runtimeConfig = await readFile(runtimeConfigPath, "utf-8");
  const projectConfig = existsSync(projectConfigPath)
    ? await readFile(projectConfigPath, "utf-8")
    : "";
  const projectHooksPath = join(projectCodexHome, "hooks.json");
  const nextProjectConfig = syncProjectScopeTrustStateFromRuntime(
    projectConfig,
    runtimeConfig,
    projectHooksPath,
  );
  if (nextProjectConfig !== projectConfig) {
    await mkdir(projectCodexHome, { recursive: true });
    await writeFile(projectConfigPath, nextProjectConfig, "utf-8");
  }
}

export async function cleanupRuntimeCodexHome(
  runtimeCodexHomeForCleanup?: string,
  projectCodexHomeForPersistence?: string,
): Promise<void> {
  if (!runtimeCodexHomeForCleanup) return;
  await persistProjectLaunchRuntimeAuthState(
    runtimeCodexHomeForCleanup,
    projectCodexHomeForPersistence,
  );
  await persistProjectLaunchRuntimeHistoryArtifacts(
    runtimeCodexHomeForCleanup,
    projectCodexHomeForPersistence,
  );
  await persistProjectLaunchRuntimeProjectTrustState(
    runtimeCodexHomeForCleanup,
    projectCodexHomeForPersistence,
  );
  await rm(runtimeCodexHomeForCleanup, { recursive: true, force: true });
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

function readTmuxEnvValueForTarget(targetPaneId: string): string | undefined {
  if (!targetPaneId.startsWith("%")) return undefined;
  try {
    const raw = execTmuxFileSync(
      ["display-message", "-p", "-t", targetPaneId, "#{socket_path},#{pid},#{session_id}"],
      { encoding: "utf-8" },
    ).trim();
    return raw.replace(/,\$(\d+)$/, ",$1") || undefined;
  } catch {
    return undefined;
  }
}

type HudResizeHookRegistrar = (
  hudPaneId: string,
  leaderPaneId: string | undefined,
  heightLines: number,
  options?: RegisterHudResizeHookOptions,
) => boolean;

export function buildInsideTmuxHudHookEnv(
  baseEnv: NodeJS.ProcessEnv,
  sessionId: string,
  currentPaneId: string | undefined,
  omxRootOverride?: string,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    OMX_SESSION_ID: sessionId,
    [OMX_TMUX_HUD_OWNER_ENV]: "1",
    ...(currentPaneId ? { [OMX_TMUX_HUD_LEADER_PANE_ENV]: currentPaneId } : {}),
    ...(omxRootOverride ? { OMX_ROOT: omxRootOverride } : {}),
  };
}

export function registerInsideTmuxHudResizeHook(options: {
  hudPaneId: string | null;
  currentPaneId: string | undefined;
  cwd: string;
  sessionId: string;
  omxRootOverride?: string;
  baseEnv?: NodeJS.ProcessEnv;
  register?: HudResizeHookRegistrar;
}): boolean {
  const { hudPaneId, currentPaneId } = options;
  if (!hudPaneId || !currentPaneId) return false;
  return (options.register ?? registerHudResizeHook)(
    hudPaneId,
    currentPaneId,
    HUD_TMUX_HEIGHT_LINES,
    {
      cwd: options.cwd,
      env: buildInsideTmuxHudHookEnv(
        options.baseEnv ?? process.env,
        options.sessionId,
        currentPaneId,
        options.omxRootOverride,
      ),
    },
  );
}

export function buildDetachedHudHookEnv(
  baseEnv: NodeJS.ProcessEnv,
  sessionId: string,
  detachedLeaderPaneId: string,
  tmuxEnvValue: string,
  omxBin: string,
  omxRootOverride?: string,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    TMUX: tmuxEnvValue,
    TMUX_PANE: detachedLeaderPaneId,
    OMX_SESSION_ID: sessionId,
    [OMX_TMUX_HUD_OWNER_ENV]: "1",
    ...(omxRootOverride ? { OMX_ROOT: omxRootOverride } : {}),
    OMX_ENTRY_PATH: omxBin,
  };
}

export function registerDetachedHudLayoutReconcileHook(options: {
  hudPaneId: string | null;
  detachedLeaderPaneId: string | null;
  cwd: string;
  sessionId: string;
  omxBin: string;
  omxRootOverride?: string;
  baseEnv?: NodeJS.ProcessEnv;
  readTmuxEnvValue?: (targetPaneId: string) => string | undefined;
  register?: HudResizeHookRegistrar;
}): boolean {
  const { hudPaneId, detachedLeaderPaneId } = options;
  if (!hudPaneId || !detachedLeaderPaneId) return false;
  const tmuxEnvValue = (options.readTmuxEnvValue ?? readTmuxEnvValueForTarget)(detachedLeaderPaneId);
  if (!tmuxEnvValue) return false;
  return (options.register ?? registerHudResizeHook)(
    hudPaneId,
    detachedLeaderPaneId,
    HUD_TMUX_HEIGHT_LINES,
    {
      cwd: options.cwd,
      env: buildDetachedHudHookEnv(
        options.baseEnv ?? process.env,
        options.sessionId,
        detachedLeaderPaneId,
        tmuxEnvValue,
        options.omxBin,
        options.omxRootOverride,
      ),
    },
  );
}

export const DETACHED_TMUX_HISTORY_LIMIT = 500;
const TMUX_HOOK_INDEX_MAX = 1_000_000;

function setDetachedTmuxSessionHistoryLimit(
  sessionName: string,
  leaderPaneId?: string | null,
): void {
  const boundedHistoryLimit = String(DETACHED_TMUX_HISTORY_LIMIT);
  try {
    execTmuxFileSync(
      ["set-option", "-q", "-t", sessionName, "history-limit", boundedHistoryLimit],
      { stdio: "ignore" },
    );
  } catch (err) {
    logCliOperationFailure(err);
  }
  if (!leaderPaneId) return;
  try {
    execTmuxFileSync(
      ["set-option", "-pq", "-t", leaderPaneId, "history-limit", boundedHistoryLimit],
      { stdio: "ignore" },
    );
  } catch (err) {
    logCliOperationFailure(err);
  }
}

function clearDetachedTmuxSessionHistoryIfUnattached(
  sessionName: string,
  leaderPaneId: string,
): void {
  try {
    const attached = execTmuxFileSync(
      ["display-message", "-p", "-t", sessionName, "#{session_attached}"],
      {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf-8",
      },
    ).trim();
    if (attached !== "0") return;
    execTmuxFileSync(["clear-history", "-t", leaderPaneId], {
      stdio: "ignore",
    });
  } catch (err) {
    logCliOperationFailure(err);
  }
}



function buildDetachedHistoryPruneHookCommand(leaderPaneId: string): string {
  // The leader pane can be gone by the time the hook fires (e.g. crashed
  // leader with a lingering session); suppress errors so tmux does not queue
  // "(null):0: can't find pane" for the next attaching client.
  return `if-shell -F '#{==:#{session_attached},0}' 'run-shell -b "tmux clear-history -t ${leaderPaneId} >/dev/null 2>&1 || true"'`;
}

function buildDetachedHistoryPruneHookSlot(sessionName: string, leaderPaneId: string): string {
  const key = `${sessionName}:${leaderPaneId}:omx-history-prune`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return `client-detached[${Math.abs(hash) % TMUX_HOOK_INDEX_MAX}]`;
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

function reportOrdinaryLaunchRootConflict(
  error: unknown,
  cwd: string,
  ordinaryLaunch: boolean,
): void {
  if (!ordinaryLaunch || !isSessionPointerLaunchAbort(error)
    || error.code !== "session_pointer_owner_conflict"
    || getBaseStateDirWithSource(cwd).rootSource !== "cwd-default") return;

  console.error(
    "[omx] concurrent conversations in this checkout require distinct user-specified OMX_ROOT values.\n" +
      "[omx] Choose a distinct directory and set OMX_ROOT before launching the additional conversation.\n" +
      "[omx] POSIX: OMX_ROOT=\"$HOME/.omx/instances/second-conversation\" omx\n" +
      "[omx] PowerShell: $env:OMX_ROOT = \"$HOME/.omx/instances/second-conversation\"; omx\n" +
      "[omx] cmd.exe: set \"OMX_ROOT=%USERPROFILE%\\.omx\\instances\\second-conversation\" && omx\n" +
      "[omx] The selected OMX_ROOT is used literally; OMX does not reroute or allocate one automatically.",
  );
}

function logCliOperationFailure(error: unknown): void {
  if (isMissingTmuxLaunchNoise(error)) return;
  process.stderr.write(`[cli/index] operation failed: ${error}
`);
}

function logEstablishmentCleanupEvidence(error: unknown): void {
  const cleanup = (error as { establishmentCleanup?: EstablishmentCleanupEvidence } | undefined)?.establishmentCleanup;
  if (!cleanup) return;
  process.stderr.write(`[omx] establishment cleanup evidence: ${JSON.stringify(cleanup)}\n`);
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

function isUnsupportedTmuxExtendedKeysFailure(error: unknown): boolean {
  const message = tmuxFailureMessage(error).toLowerCase();
  return (
    message.includes("extended-keys") &&
    /(?:invalid|unknown|unsupported) (?:option|flag|argument)|no such option|unknown option/.test(
      message,
    )
  );
}

function probeDetachedTmuxTransport(): void {
  const { result } = spawnPlatformCommandSync("tmux", ["-V"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new DetachedTransportUnavailable();
  }
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
    Boolean(resolveTmuxBinaryForPlatform()),
    nativeWindows,
    undefined,
    undefined,
    explicitLaunchPolicy,
  );
  return { launchPolicy, effectiveExplicitLaunchPolicy: explicitLaunchPolicy };
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

export async function resolveLaunchConfigRepairOptions(
  cwd: string,
  configPath: string,
): Promise<{
  includeFirstPartyMcp: boolean;
  sharedMcpServers?: UnifiedMcpRegistryServer[];
  sharedMcpRegistrySource?: string;
}> {
  let content: string | undefined;
  const readConfig = async (): Promise<string | undefined> => {
    if (content !== undefined) return content;
    if (!existsSync(configPath)) return undefined;
    content = await readFile(configPath, "utf-8");
    return content;
  };

  const existingContent = await readConfig();
  const sharedMcpRegistry = existingContent
    ? extractSharedMcpRegistryServersFromConfig(existingContent)
    : { servers: [] };
  const sharedMcpOptions =
    sharedMcpRegistry.servers.length > 0
      ? {
          sharedMcpServers: sharedMcpRegistry.servers,
          sharedMcpRegistrySource: sharedMcpRegistry.sourcePath,
        }
      : {};

  if (readPersistedSetupPreferences(cwd)?.mcpMode === "compat") {
    return { includeFirstPartyMcp: true, ...sharedMcpOptions };
  }

  if (existingContent) {
    const hasExistingFirstPartyMcp = OMX_FIRST_PARTY_MCP_SERVER_NAMES.some((name) =>
      new RegExp(`^\\s*\\[mcp_servers\\.${name}\\]\\s*$`, "m").test(existingContent),
    );
    if (hasExistingFirstPartyMcp || sharedMcpRegistry.servers.length > 0) {
      return { includeFirstPartyMcp: hasExistingFirstPartyMcp, ...sharedMcpOptions };
    }
  }

  return {
    includeFirstPartyMcp: false,
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
    } else if (typeof result.status === "number") {
      console.error(`[omx] codex exited with code ${result.status}`);
    }
  }
}

export function omxRuntimeCommandShimFileName(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? "omx.cmd" : "omx";
}

export function omxRuntimeCommandShimPath(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(omxRoot(cwd), "runtime", "bin", omxRuntimeCommandShimFileName(platform));
}

function ensureRuntimeShimDirectory(path: string): void {
  if (existsSync(path)) {
    const current = lstatSync(path);
    if (current.isSymbolicLink()) {
      throw new Error(`Refusing to create OMX runtime command shim through symlink directory: ${path}`);
    }
    if (!current.isDirectory()) {
      throw new Error(`Refusing to create OMX runtime command shim because path is not a directory: ${path}`);
    }
    return;
  }
  mkdirSync(path, { mode: 0o700 });
}

function buildOmxRuntimeCommandShim(
  nodePath: string,
  omxBin: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return [
      "@echo off",
      `"${nodePath}" "${omxBin}" %*`,
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    `exec ${quoteShellArg(nodePath)} ${quoteShellArg(omxBin)} "$@"`,
    "",
  ].join("\n");
}

export function ensureOmxRuntimeCommandShim(
  cwd: string,
  omxBin: string,
  nodePath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
): string {
  const shimPath = omxRuntimeCommandShimPath(cwd, platform);
  const shimDir = dirname(shimPath);
  const rootDir = omxRoot(cwd);
  const runtimeDir = dirname(shimDir);
  ensureRuntimeShimDirectory(rootDir);
  ensureRuntimeShimDirectory(runtimeDir);
  ensureRuntimeShimDirectory(shimDir);
  if (existsSync(shimPath)) {
    const current = lstatSync(shimPath);
    if (current.isDirectory()) {
      throw new Error(`Refusing to replace OMX runtime command shim directory: ${shimPath}`);
    }
    if (current.isSymbolicLink()) {
      rmSync(shimPath, { force: true });
    }
  }
  writeFileSync(shimPath, buildOmxRuntimeCommandShim(nodePath, omxBin, platform), {
    encoding: "utf-8",
    mode: 0o700,
  });
  if (platform !== "win32") {
    chmodSync(shimPath, 0o700);
  }
  return shimDir;
}

export function prependOmxRuntimeCommandShimToEnv(
  cwd: string,
  env: NodeJS.ProcessEnv,
  omxBin: string,
  nodePath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const shimDir = ensureOmxRuntimeCommandShim(cwd, omxBin, nodePath, platform);
  const pathDelimiter = platform === "win32" ? win32.delimiter : posix.delimiter;
  const result: NodeJS.ProcessEnv = { ...env };

  if (platform === "win32") {
    // Windows env var names are case-insensitive; the inherited key is usually
    // `Path`, not `PATH`. Find every case variant, preserve the existing value,
    // prepend the shim directory, and collapse to a single key so the child does
    // not see an empty `PATH` shadowing the real `Path` (which drops System32,
    // WindowsPowerShell, etc.).
    const pathVariants = Object.keys(result).filter(
      (key) => key.toLowerCase() === "path",
    );
    let pathKey = "Path";
    let currentPath = "";
    for (const variant of pathVariants) {
      const value = result[variant];
      if (typeof value === "string" && value.length > 0) {
        pathKey = variant;
        currentPath = value;
        break;
      }
    }
    for (const variant of pathVariants) {
      delete result[variant];
    }
    result[pathKey] = currentPath
      ? `${shimDir}${pathDelimiter}${currentPath}`
      : shimDir;
  } else {
    const currentPath = typeof result.PATH === "string" ? result.PATH : "";
    result.PATH = currentPath ? `${shimDir}${pathDelimiter}${currentPath}` : shimDir;
  }

  result.OMX_ENTRY_PATH = omxBin;
  result.OMX_STARTUP_CWD =
    typeof result.OMX_STARTUP_CWD === "string" && result.OMX_STARTUP_CWD.trim()
      ? result.OMX_STARTUP_CWD
      : cwd;
  return result;
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

function isCrossPlatformAbsolutePath(raw: string): boolean {
  return posix.isAbsolute(raw) || win32.isAbsolute(raw);
}

export function resolveOmxRootForLaunch(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env.OMX_ROOT || env.OMX_STATE_ROOT;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return isCrossPlatformAbsolutePath(raw) ? raw : join(cwd, raw);
}
type HudRuntimeRootSource = 'team-env' | 'omx-root-env' | 'omx-state-root-env' | 'cwd-default';

interface HudRuntimeRootForLaunch {
  omxRoot?: string;
  omxStateRoot?: string;
  omxTeamStateRoot?: string;
  rootSource: HudRuntimeRootSource;
}

function resolveLaunchPath(cwd: string, raw: string): string {
  return isCrossPlatformAbsolutePath(raw) ? raw : join(cwd, raw);
}

function resolveHudRuntimeRootSource(
  omxRootOverride: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): HudRuntimeRootSource {
  if (env.OMX_TEAM_STATE_ROOT?.trim()) return 'team-env';
  if (env.OMX_ROOT?.trim() || omxRootOverride) return 'omx-root-env';
  if (env.OMX_STATE_ROOT?.trim()) return 'omx-state-root-env';
  return 'cwd-default';
}

export function resolveHudRuntimeRootForLaunch(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): HudRuntimeRootForLaunch {
  const omxTeamStateRoot = env.OMX_TEAM_STATE_ROOT?.trim();
  if (omxTeamStateRoot) {
    return {
      omxTeamStateRoot: resolveLaunchPath(cwd, omxTeamStateRoot),
      rootSource: 'team-env',
    };
  }

  const omxRoot = env.OMX_ROOT?.trim();
  if (omxRoot) {
    return {
      omxRoot: resolveLaunchPath(cwd, omxRoot),
      rootSource: 'omx-root-env',
    };
  }

  const omxStateRoot = env.OMX_STATE_ROOT?.trim();
  if (omxStateRoot) {
    return {
      omxStateRoot: resolveLaunchPath(cwd, omxStateRoot),
      rootSource: 'omx-state-root-env',
    };
  }

  return { rootSource: 'cwd-default' };
}

function hasExplicitOmxRootEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return [env.OMX_ROOT, env.OMX_STATE_ROOT].some(
    (value) => typeof value === "string" && value.trim() !== "",
  );
}

export function resolveDisposableWorktreeOmxRootForLaunch(
  ensuredWorktree: { enabled: true; repoRoot: string } | { enabled: false } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!ensuredWorktree?.enabled) return undefined;
  if (hasExplicitOmxRootEnv(env)) return undefined;
  return ensuredWorktree.repoRoot;
}

interface MadmaxWorktreeRuntimeContext {
  omxRoot: string;
  omxStateRoot?: string;
  sourceCwd: string;
  worktreeCwd?: string;
  madmaxDetachedContext?: string;
  boxedActive?: true;
}

function buildMadmaxWorktreeRuntimeEnvOverlay(
  runtimeContext?: MadmaxWorktreeRuntimeContext,
): NodeJS.ProcessEnv {
  if (!runtimeContext) return {};
  return {
    OMX_ROOT: runtimeContext.omxRoot,
    ...(runtimeContext.omxStateRoot ? { OMX_STATE_ROOT: runtimeContext.omxStateRoot } : {}),
    ...(runtimeContext.boxedActive ? { OMXBOX_ACTIVE: "1" } : {}),
    OMX_SOURCE_CWD: runtimeContext.sourceCwd,
    ...(runtimeContext.madmaxDetachedContext
      ? { [OMX_MADMAX_DETACHED_CONTEXT_ENV]: runtimeContext.madmaxDetachedContext }
      : {}),
  };
}

export function captureMadmaxWorktreeRuntimeContext(options: {
  originalLaunchArgs: readonly string[];
  worktreeEnabled: boolean;
  sourceCwd: string;
  worktreeCwd?: string;
  env?: NodeJS.ProcessEnv;
}): MadmaxWorktreeRuntimeContext | undefined {
  const env = options.env ?? process.env;
  if (!options.worktreeEnabled) return undefined;
  if (!launchArgsRequestMadmaxIsolation(options.originalLaunchArgs)) return undefined;
  if (env.OMXBOX_ACTIVE !== "1") return undefined;

  const inheritedRoot = resolveInheritedMadmaxRoot(env);
  if (!inheritedRoot) return undefined;

  const sourceCwd = env.OMX_SOURCE_CWD?.trim() || options.sourceCwd;
  const worktreeCwd = options.worktreeCwd?.trim();
  const omxStateRoot = env.OMX_STATE_ROOT?.trim();
  const madmaxDetachedContext = env[OMX_MADMAX_DETACHED_CONTEXT_ENV]?.trim();

  return {
    omxRoot: resolveLaunchPath(options.sourceCwd, inheritedRoot),
    ...(omxStateRoot ? { omxStateRoot: resolveLaunchPath(options.sourceCwd, omxStateRoot) } : {}),
    sourceCwd,
    ...(worktreeCwd && worktreeCwd !== sourceCwd ? { worktreeCwd } : {}),
    ...(madmaxDetachedContext ? { madmaxDetachedContext } : {}),
    boxedActive: true,
  };
}

function applyDisposableWorktreeOmxRootForLaunch(
  ensuredWorktree: { enabled: true; repoRoot: string } | { enabled: false } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const omxRootOverride = resolveDisposableWorktreeOmxRootForLaunch(
    ensuredWorktree,
    env,
  );
  if (!omxRootOverride) return;
  env.OMX_ROOT = omxRootOverride;
}

function applyWorktreeToolContextForLaunch(
  cwd: string,
  ensuredWorktree: { enabled: true; repoRoot: string; worktreePath: string } | { enabled: false } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const context = resolveWorktreeToolContext({
    cwd,
    scope: "launch",
    repoRoot: ensuredWorktree?.enabled ? ensuredWorktree.repoRoot : undefined,
    worktreeRoot: ensuredWorktree?.enabled ? ensuredWorktree.worktreePath : cwd,
    env,
  });
  Object.assign(env, worktreeToolContextEnv(context));
}

function launchArgRequestsDisposableWorktree(arg: string): boolean {
  return arg === "--worktree" ||
    arg === "-w" ||
    arg.startsWith("--worktree=") ||
    // Covers both `-w=<name>` and `-w<name>`; an explicit `-w=` check would be a
    // strict subset of this clause, so it is omitted as redundant.
    (arg.startsWith("-w") && arg.length > 2);
}

function launchArgsRequestMadmaxIsolation(launchArgs: readonly string[]): boolean {
  for (const arg of launchArgs) {
    if (arg === "--") break;
    if (arg === MADMAX_FLAG || arg === MADMAX_SPARK_FLAG) return true;
  }
  return false;
}

function launchArgsRequestAuthHotswap(launchArgs: readonly string[]): boolean {
  for (const arg of launchArgs) {
    if (arg === "--") break;
    if (arg === "--hotswap") return true;
  }
  return false;
}

function launchArgsRequestDisposableWorktree(launchArgs: readonly string[]): boolean {
  for (const arg of launchArgs) {
    if (arg === "--") break;
    if (launchArgRequestsDisposableWorktree(arg)) return true;
  }
  return false;
}

function clearInheritedMadmaxRootForDisposableWorktreeLaunch(
  launchArgs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!launchArgsRequestDisposableWorktree(launchArgs)) return;
  if (env.OMXBOX_ACTIVE !== "1") return;
  delete env.OMX_ROOT;
  delete env.OMX_STATE_ROOT;
  delete env.OMXBOX_ACTIVE;
  delete env.OMX_SOURCE_CWD;
  delete env[OMX_MADMAX_DETACHED_CONTEXT_ENV];
}

export function shouldAutoIsolateMadmaxLaunch(
  command: string,
  launchArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): boolean {
  if (command !== "launch" && command !== "exec") return false;
  if (env.OMX_NO_BOX === "1") return false;
  if (!launchArgsRequestMadmaxIsolation(launchArgs)) return false;
  const inheritedContext = env[OMX_MADMAX_DETACHED_CONTEXT_ENV]?.trim();
  if (env.OMXBOX_ACTIVE === "1" && inheritedContext && !resolveInheritedMadmaxRoot(env)) {
    return false;
  }
  if (madmaxInheritedContextMatchesLaunch(cwd, launchArgs, env)) return false;
  return true;
}

function sanitizeRunIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

const MADMAX_DETACHED_ACTIVE_DIR = "active-detached";
const MADMAX_DETACHED_LOCK_STALE_MS = 30_000;
const MADMAX_DETACHED_LOCK_RETRY_MS = 50;
const MADMAX_DETACHED_LOCK_MAX_ATTEMPTS = 100;
const OMX_MADMAX_DETACHED_CONTEXT_ENV = "OMX_MADMAX_DETACHED_CONTEXT";

interface MadmaxDetachedLockRetryOptions {
  maxAttempts?: number;
  retryMs?: number;
}

interface MadmaxDetachedLockOwner {
  version: 1;
  pid: number;
  context_key: string;
  acquired_at: string;
}

interface MadmaxDetachedLockInspection {
  stale: boolean;
  diagnostic: string;
}

interface MadmaxDetachedActiveRecord {
  version: 1;
  context_key: string;
  created_at: string;
  source_cwd: string;
  worktree_cwd?: string;
  argv: string[];
  run_dir: string;
  tmux_session_name: string;
  session_id?: string;
  tmux_pane_id?: string;
  launch_nonce?: string;
  leader_pid?: number;
  base_state_root?: string;
  lifecycle_phase?: "ready" | "terminal";
  tmux_internal_session_id?: string;
  tmux_session_created?: string;
  tmux_pane_pid?: number;
}

function resolveMadmaxRunsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMX_RUNS_DIR || join(homedir(), ".omx-runs");
}

function canonicalizeLaunchCwd(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || cwd;
  } catch {
    return cwd;
  }
}

function normalizeMadmaxDetachedLaunchArgv(argv: readonly string[]): string[] {
  const passthrough: string[] = [];
  const semanticFlags = new Set<string>();
  let reasoningFlag: string | null = null;
  let afterEndOfOptions = false;

  for (const arg of argv) {
    if (afterEndOfOptions) {
      passthrough.push(arg);
      continue;
    }
    if (arg === "--") {
      afterEndOfOptions = true;
      passthrough.push(arg);
      continue;
    }
    if (arg === "--tmux" || arg === "--direct") {
      continue;
    }
    if (
      arg === MADMAX_FLAG ||
      arg === MADMAX_SPARK_FLAG
    ) {
      semanticFlags.add(arg);
      continue;
    }
    if (arg === HIGH_REASONING_FLAG || arg === XHIGH_REASONING_FLAG) {
      reasoningFlag = arg;
      continue;
    }
    passthrough.push(arg);
  }

  return [
    ...Array.from(semanticFlags).sort(),
    ...(reasoningFlag ? [reasoningFlag] : []),
    ...passthrough,
  ];
}

export function buildMadmaxDetachedLaunchContextKey(
  sourceCwd: string,
  argv: readonly string[],
  runIdentity = "",
): string {
  // The boxed run root is part of the lock identity for auto-isolated madmax
  // launches. That lets independent `omx --madmax --high` sessions share the
  // same source cwd/argv without contending on one active-detached lock, while
  // callers that intentionally reuse the same boxed context keep one key.
  const payload = JSON.stringify({
    source_cwd: canonicalizeLaunchCwd(sourceCwd),
    argv: normalizeMadmaxDetachedLaunchArgv(argv),
    run_identity: runIdentity,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function madmaxDetachedActiveRecordPath(
  runsRoot: string,
  contextKey: string,
): string {
  return join(runsRoot, MADMAX_DETACHED_ACTIVE_DIR, `${contextKey}.json`);
}

function readMadmaxDetachedActiveRecord(
  recordPath: string,
): MadmaxDetachedActiveRecord | null {
  if (!existsSync(recordPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(recordPath, "utf-8")) as Partial<MadmaxDetachedActiveRecord>;
    if (
      parsed.version !== 1 ||
      typeof parsed.context_key !== "string" ||
      typeof parsed.source_cwd !== "string" ||
      typeof parsed.run_dir !== "string" ||
      typeof parsed.tmux_session_name !== "string" ||
      !Array.isArray(parsed.argv) ||
      !parsed.argv.every((arg) => typeof arg === "string")
    ) {
      return null;
    }
    return {
      version: 1,
      context_key: parsed.context_key,
      created_at: typeof parsed.created_at === "string" ? parsed.created_at : "",
      source_cwd: parsed.source_cwd,
      argv: [...parsed.argv],
      run_dir: parsed.run_dir,
      tmux_session_name: parsed.tmux_session_name,
      ...(typeof parsed.session_id === "string" ? { session_id: parsed.session_id } : {}),
      ...(typeof parsed.tmux_pane_id === "string" ? { tmux_pane_id: parsed.tmux_pane_id } : {}),
      ...(typeof parsed.tmux_internal_session_id === "string" ? { tmux_internal_session_id: parsed.tmux_internal_session_id } : {}),
      ...(typeof parsed.tmux_session_created === "string" ? { tmux_session_created: parsed.tmux_session_created } : {}),
      ...(typeof parsed.tmux_pane_pid === "number" ? { tmux_pane_pid: parsed.tmux_pane_pid } : {}),

      ...(typeof parsed.worktree_cwd === "string" ? { worktree_cwd: parsed.worktree_cwd } : {}),
      ...(typeof parsed.launch_nonce === "string" ? { launch_nonce: parsed.launch_nonce } : {}),
      ...(typeof parsed.leader_pid === "number" && Number.isSafeInteger(parsed.leader_pid) && parsed.leader_pid > 0 ? { leader_pid: parsed.leader_pid } : {}),
      ...(typeof parsed.base_state_root === "string" ? { base_state_root: parsed.base_state_root } : {}),
      ...(parsed.lifecycle_phase === "ready" || parsed.lifecycle_phase === "terminal" ? { lifecycle_phase: parsed.lifecycle_phase } : {}),
    };
  } catch {
    return null;
  }
}


interface MadmaxDetachedRuntimeBinding {
  paneId: string;
  panePid: number;
  sessionName: string;
  internalSessionId: string;
  sessionCreated: string;
  omxInstanceId: string;
}

function queryMadmaxDetachedRuntimeBinding(record: MadmaxDetachedActiveRecord): MadmaxDetachedRuntimeBinding | null {
  if (!record.tmux_pane_id || !record.session_id) return null;
  try {
    const output = execTmuxFileSync([
      "list-panes", "-a", "-F",
      "#{pane_id}\t#{pane_dead}\t#{pane_pid}\t#{session_name}\t#{session_id}\t#{session_created}\t#{@omx_instance_id}",
    ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    let binding: MadmaxDetachedRuntimeBinding | null = null;
    const seen = new Set<string>();
    for (const line of output.split("\n").filter(Boolean)) {
      const fields = line.split("\t");
      if (fields.length !== 7) return null;
      const [paneId, dead, panePidRaw, sessionName, internalSessionId, sessionCreated, omxInstanceId] = fields;
      const panePid = Number(panePidRaw);
      if (!/^%[0-9]+$/.test(paneId) || seen.has(paneId) || (dead !== "0" && dead !== "1")
        || !Number.isSafeInteger(panePid) || panePid <= 0 || !sessionName
        || !/^\$[0-9]+$/.test(internalSessionId) || !/^[0-9]+$/.test(sessionCreated)) return null;
      seen.add(paneId);
      if (paneId !== record.tmux_pane_id) continue;
      if (dead !== "0" || sessionName !== record.tmux_session_name || omxInstanceId !== record.session_id) return null;
      binding = { paneId, panePid, sessionName, internalSessionId, sessionCreated, omxInstanceId };
    }
    return binding;
  } catch {
    return null;
  }
}

function hasMatchingMadmaxDetachedRuntimeBinding(record: MadmaxDetachedActiveRecord): boolean {
  const binding = queryMadmaxDetachedRuntimeBinding(record);
  return Boolean(binding
    && binding.panePid === record.tmux_pane_pid
    && binding.internalSessionId === record.tmux_internal_session_id
    && binding.sessionCreated === record.tmux_session_created);
}

function isReusableMadmaxDetachedActiveRecord(record: MadmaxDetachedActiveRecord): boolean {
  if (record.lifecycle_phase !== "ready" || !record.leader_pid || !record.base_state_root || !record.launch_nonce) return false;
  try { process.kill(record.leader_pid, 0); } catch { return false; }
  try { if (realpathSync(record.base_state_root) !== record.base_state_root) return false; } catch { return false; }
  return hasMatchingMadmaxDetachedRuntimeBinding(record);
}


function readMadmaxDetachedLockOwner(lockPath: string): MadmaxDetachedLockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf-8")) as Partial<MadmaxDetachedLockOwner>;
    if (
      parsed.version !== 1 ||
      typeof parsed.pid !== "number" ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.context_key !== "string" ||
      typeof parsed.acquired_at !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      pid: parsed.pid,
      context_key: parsed.context_key,
      acquired_at: parsed.acquired_at,
    };
  } catch {
    return null;
  }
}

function readMadmaxDetachedLockPid(lockPath: string): number | null {
  const owner = readMadmaxDetachedLockOwner(lockPath);
  if (owner) return owner.pid;
  try {
    const holderPid = Number.parseInt(readFileSync(join(lockPath, "pid"), "utf-8").trim(), 10);
    return Number.isSafeInteger(holderPid) && holderPid > 0 ? holderPid : null;
  } catch {
    return null;
  }
}

function inspectMadmaxDetachedContextLock(lockPath: string): MadmaxDetachedLockInspection {
  const lockStat = statSync(lockPath, { throwIfNoEntry: false });
  if (!lockStat) {
    return { stale: false, diagnostic: "lock disappeared while waiting" };
  }
  const ageMs = Math.max(0, Date.now() - lockStat.mtimeMs);
  const owner = readMadmaxDetachedLockOwner(lockPath);
  const holderPid = owner?.pid ?? readMadmaxDetachedLockPid(lockPath);
  if (holderPid) {
    if (!isProcessAlive(holderPid)) {
      return {
        stale: true,
        diagnostic: `stale holder pid ${holderPid} is not running; lock age ${Math.round(ageMs)}ms`,
      };
    }
    const ownerContext = owner ? `, owner context ${owner.context_key}` : ", legacy pid-only lock";
    const sameDirectoryGuidance =
      "Another madmax detached launch is active for this directory; close the existing madmax session or use --worktree for concurrent work. Multiple madmax sessions in one directory are unsafe";
    return {
      stale: false,
      diagnostic: `holder pid ${holderPid} is still running${ownerContext}; lock age ${Math.round(ageMs)}ms. ${sameDirectoryGuidance}`,
    };
  }
  if (ageMs > MADMAX_DETACHED_LOCK_STALE_MS) {
    return {
      stale: true,
      diagnostic: `legacy lock has no readable owner pid and is older than ${MADMAX_DETACHED_LOCK_STALE_MS}ms; lock age ${Math.round(ageMs)}ms`,
    };
  }
  return {
    stale: false,
    diagnostic: `lock has no readable owner pid yet; lock age ${Math.round(ageMs)}ms`,
  };
}

export async function withMadmaxDetachedContextLock<T>(
  runsRoot: string,
  contextKey: string,
  run: () => T | Promise<T>,
  options: MadmaxDetachedLockRetryOptions = {},
): Promise<T> {
  const lockPath = join(runsRoot, MADMAX_DETACHED_ACTIVE_DIR, `${contextKey}.lock`);
  const maxAttempts = options.maxAttempts ?? MADMAX_DETACHED_LOCK_MAX_ATTEMPTS;
  const retryMs = options.retryMs ?? MADMAX_DETACHED_LOCK_RETRY_MS;
  let lastDiagnostic = "lock was busy";
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      mkdirSync(lockPath);
      try {
        const owner: MadmaxDetachedLockOwner = {
          version: 1,
          pid: process.pid,
          context_key: contextKey,
          acquired_at: new Date().toISOString(),
        };
        writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
        writeFileSync(join(lockPath, "pid"), String(process.pid));
        return await run();
      } finally {
        rmSync(lockPath, { recursive: true, force: true });
      }
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as NodeJS.ErrnoException).code)
          : "";
      if (code !== "EEXIST") throw err;
      const inspection = inspectMadmaxDetachedContextLock(lockPath);
      lastDiagnostic = inspection.diagnostic;
      if (inspection.stale) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      blockMs(retryMs);
    }
  }
  throw new MadmaxDetachedGuardError(
    `timed out waiting for madmax detached launch context lock: ${lockPath} (${lastDiagnostic})`,
  );
}


function readMadmaxRunMetadata(
  runRoot: string,
): { cwd?: string; detached_launch_context?: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(join(runRoot, ".omxbox-run.json"), "utf-8")) as {
      cwd?: unknown;
      detached_launch_context?: unknown;
    };
    return {
      ...(typeof parsed.cwd === "string" ? { cwd: parsed.cwd } : {}),
      ...(typeof parsed.detached_launch_context === "string"
        ? { detached_launch_context: parsed.detached_launch_context }
        : {}),
    };
  } catch {
    return null;
  }
}

function resolveInheritedMadmaxRoot(env: NodeJS.ProcessEnv): string | undefined {
  const root = env.OMX_ROOT?.trim() || env.OMX_STATE_ROOT?.trim();
  return root || undefined;
}

function madmaxInheritedContextMatchesLaunch(
  cwd: string,
  launchArgs: readonly string[],
  env: NodeJS.ProcessEnv,
): boolean {
  if (env.OMXBOX_ACTIVE !== "1") return false;
  const context = env[OMX_MADMAX_DETACHED_CONTEXT_ENV]?.trim();
  if (!context) return false;
  const inheritedRoot = resolveInheritedMadmaxRoot(env);
  if (!inheritedRoot) return false;
  const metadata = readMadmaxRunMetadata(inheritedRoot);
  if (!metadata) return false;
  if (metadata.cwd && metadata.cwd !== inheritedRoot) return false;
  if (metadata.detached_launch_context !== context) return false;
  const expectedContext = buildMadmaxDetachedLaunchContextKey(cwd, [...launchArgs], inheritedRoot);
  return expectedContext === context;
}

function isMadmaxDetachedGuardEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.OMXBOX_ACTIVE === "1" && typeof env[OMX_MADMAX_DETACHED_CONTEXT_ENV] === "string";
}

function cleanupCurrentMadmaxReuseRunRoot(env: NodeJS.ProcessEnv, runsRoot: string): void {
  const runRoot = env.OMX_ROOT;
  if (!runRoot || !env.OMXBOX_ACTIVE) return;
  const normalizedRunsRoot = runsRoot.endsWith("/") ? runsRoot : `${runsRoot}/`;
  if (runRoot !== runsRoot && !runRoot.startsWith(normalizedRunsRoot)) return;
  rmSync(runRoot, { recursive: true, force: true });
}

export interface DetachedActiveRecordOwnership {
  bytes: string;
  digest: string;
  nonce: string;
}

function writeMadmaxDetachedActiveRecord(
  recordPath: string,
  record: MadmaxDetachedActiveRecord,
): DetachedActiveRecordOwnership {
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  const tempPath = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  mkdirSync(dirname(recordPath), { recursive: true, mode: 0o700 });
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeFileSync(fd, bytes, "utf-8");
    try { fsyncSync(fd); } catch (error) {
      if (!(process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM")) throw error;
    }
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, recordPath);
    const directoryFd = openSync(dirname(recordPath), "r");
    try {
      try { fsyncSync(directoryFd); } catch (error) {
        if (!(process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM")) throw error;
      }
    } finally {
      closeSync(directoryFd);
    }
    return {
      bytes,
      digest: createHash("sha256").update(bytes).digest("hex"),
      nonce: record.launch_nonce ?? "",
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tempPath); } catch {}
  }
}

export type DetachedRollbackStep =
  | "setup-finalization"
  | "rollback"
  | "lease-close"
  | "notify-watcher"
  | "derived-watcher"
  | "session-instructions"
  | "runtime-codex-home"
  | "parent-env"
  | "verified-record"
  | `session:${string}`;

export interface SafeFailure {
  step: DetachedRollbackStep;
  status: "failed";
  code: string;
}

export interface DetachedRollbackEvidence {
  attempted: DetachedRollbackStep[];
  failures: SafeFailure[];
}

export interface DetachedBootstrapReport {
  transitions: DetachedLaunchTransition[];
  rollback: DetachedRollbackEvidence;
  establishmentCleanup?: EstablishmentCleanupEvidence;
}

function detachedFailureCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === "string" && /^(?:EACCES|EAGAIN|EBUSY|ECANCELED|ECONNREFUSED|EEXIST|EINTR|EINVAL|EIO|EISDIR|EMFILE|ENFILE|ENOENT|ENOSPC|ENOTDIR|EPERM|EPIPE|EROFS|ESRCH|ETIMEDOUT)$/.test(code) ? code : "unknown";
}


export class DetachedLaunchSafetyError extends Error {
  readonly name = "DetachedLaunchSafetyError";
  constructor(
    readonly phase: "establishment" | "completion" | "inert-session" | "pane-id" | "name-metadata" | "pane-metadata" | "active-record" | "lease-close" | "barrier-release" | "post-release-attach",
    readonly cause: unknown,
    readonly report: DetachedBootstrapReport,
  ) {
    super(`detached launch safety failure during ${phase}`);
  }
}

export type DetachedLaunchTransition = "D0" | "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7" | "D9" | "D10";


export type DetachedLaunchTerminal =
  | { kind: "attached" | "returned"; released: true; report: DetachedBootstrapReport };

export interface DetachedReleaseFailureResolution {
  /** True only after the leader authenticated and completed terminal finalization. */
  acknowledged: boolean;
  nonce?: string;
  sessionId?: string;
  sessionName?: string;
  leaderPid?: number;
  kind?: "failed" | "terminal";
}


export class DetachedTransportUnavailable extends Error {
  readonly name = "DetachedTransportUnavailable";
  readonly noSideEffects = true;

  constructor(readonly reason?: string) {
    super("detached transport is unavailable before launch side effects");
  }
}

export interface DetachedPreflightAvailable {
  readonly kind: "available";
  readonly shouldAttach: boolean;
  readonly report: DetachedBootstrapReport;
}



export interface DetachedLaunchStateMachineInput {
  preflight: DetachedPreflightAvailable;
}

export interface DetachedLaunchDependencies<Binding = unknown, InertSession = unknown, Pane = string> {
  establish(): Promise<Binding>;
  complete(binding: Binding): Promise<CompletionResult>;
  createInertSession(): Promise<InertSession>;
  capturePane(session: InertSession): Promise<Pane>;
  updateNameMetadata(binding: Binding, session: InertSession): Promise<"committed-released">;
  updatePaneMetadata(binding: Binding, pane: Pane): Promise<"committed-released">;
  publishActiveRecord(session: InertSession, pane: Pane): Promise<DetachedActiveRecordOwnership>;
  // The long-lived leader retains this authority until terminal finalization.
  finalizeSetupFailure(binding: Binding): Promise<void>;
  releaseBarrier(): Promise<void>;
  /**
   * D9 failure is special: once the leader exists, only it may consume pointer
   * authority. The outer process requests an authenticated abort and must not
   * clean or kill the session unless finalization is acknowledged.
   */
  abortAndAwaitFinalization?(error: unknown): Promise<DetachedReleaseFailureResolution>;
  attachOrReturn(session: InertSession, shouldAttach: boolean): Promise<void>;
  rollback(ownedRecord: DetachedActiveRecordOwnership | undefined, report: DetachedBootstrapReport): Promise<void>;
  diagnostic?(error: unknown): void;

}

/** Internal detached-launch seam. Exported solely for deterministic CLI tests. */
export async function executeDetachedLaunchStateMachine<Binding, InertSession, Pane>(
  input: DetachedLaunchStateMachineInput,
  deps: DetachedLaunchDependencies<Binding, InertSession, Pane>,
): Promise<DetachedLaunchTerminal> {
  const report = input.preflight.report;
  const transition = (name: DetachedLaunchTransition): void => { report.transitions.push(name); };

  let binding: Binding | undefined;
  let ownedRecord: DetachedActiveRecordOwnership | undefined;
  let released = false;
  let retainedAuthority = false;
  let rollbackAuthorized = false;
  try {
    transition("D1");
    binding = await deps.establish();
    retainedAuthority = true;
    transition("D2");
    const completion = await deps.complete(binding);
    if (completion.kind === "failure") {
      const failures: unknown[] = [completion.error];
      try {
        report.rollback.attempted.push("setup-finalization");
        await deps.finalizeSetupFailure(binding);
      } catch (finalizationError) {
        report.rollback.failures.push({ step: "setup-finalization", status: "failed", code: detachedFailureCode(finalizationError) });
        failures.push(finalizationError);
      }
      throw new DetachedLaunchSafetyError("completion", new AggregateError(failures, `preLaunch ${completion.operation} failed`), report);
    }
    transition("D3");
    const inertSession = await deps.createInertSession();
    transition("D4");
    const pane = await deps.capturePane(inertSession);
    transition("D5");
    if (await deps.updateNameMetadata(binding, inertSession) !== "committed-released") {
      throw new DetachedLaunchSafetyError("name-metadata", new Error("detached name metadata did not release"), report);
    }
    transition("D6");
    if (await deps.updatePaneMetadata(binding, pane) !== "committed-released") {
      throw new DetachedLaunchSafetyError("pane-metadata", new Error("detached pane metadata did not release"), report);
    }
    transition("D7");
    ownedRecord = await deps.publishActiveRecord(inertSession, pane);
    transition("D9");
    try {
      await deps.releaseBarrier();
      released = true;
    } catch (releaseError) {
      // A failed publication must not let the outer launcher destroy the
      // leader's finalization capability. Request a nonce-bound abort and
      // preserve all artifacts on timeout, malformed, or foreign reports.
      let resolution: DetachedReleaseFailureResolution | undefined;
      try {
        resolution = await deps.abortAndAwaitFinalization?.(releaseError);
      } catch (abortError) {
        released = true;
        throw new AggregateError([releaseError, abortError], "detached release and abort publication both failed");
      }
      rollbackAuthorized = resolution?.acknowledged === true && Boolean(
        resolution.nonce && resolution.sessionId && resolution.sessionName &&
        Number.isSafeInteger(resolution.leaderPid) && resolution.kind,
      );
      if (!rollbackAuthorized) released = true;
      throw releaseError;
    }
    transition("D10");
    await deps.attachOrReturn(inertSession, input.preflight.shouldAttach);
    return { kind: input.preflight.shouldAttach ? "attached" : "returned", released: true, report };
  } catch (error) {
    deps.diagnostic?.(error);
    if (retainedAuthority && !rollbackAuthorized && !released) {
      try {
        const resolution = await deps.abortAndAwaitFinalization?.(error);
        rollbackAuthorized = resolution?.acknowledged === true && Boolean(
          resolution.nonce && resolution.sessionId && resolution.sessionName &&
          Number.isSafeInteger(resolution.leaderPid) && resolution.kind,
        );
        if (!rollbackAuthorized) released = true;
      } catch (abortError) {
        released = true;
        deps.diagnostic?.(abortError);
      }
    }
    if (!released) {
      try {
        report.rollback.attempted.push("rollback");
        await deps.rollback(ownedRecord, report);
      } catch (rollbackError) {
        report.rollback.failures.push({ step: "rollback", status: "failed", code: detachedFailureCode(rollbackError) });
        deps.diagnostic?.(rollbackError);
      }
    }
    if (error instanceof DetachedLaunchSafetyError) {
      throw new DetachedLaunchSafetyError(error.phase, error.cause, report);
    }
    const phase = report.transitions.at(-1);
    const phaseName = phase === "D1" ? "establishment"
      : phase === "D2" ? "completion"
      : phase === "D3" ? "inert-session"
      : phase === "D4" ? "pane-id"
      : phase === "D5" ? "name-metadata"
      : phase === "D6" ? "pane-metadata"
      : phase === "D7" ? "active-record"
      : phase === "D9" ? "barrier-release"
      : "post-release-attach";
    throw new DetachedLaunchSafetyError(phaseName, error, report);
  }
}


class MadmaxDetachedGuardError extends Error {
  readonly failClosed = true;
}

function preflightDetachedLaunch(): DetachedPreflightAvailable {
  // D0 must remain transport-only: `tmux -V` neither connects to nor creates a server.
  probeDetachedTmuxTransport();
  const report: DetachedBootstrapReport = { transitions: ["D0"], rollback: { attempted: [], failures: [] } };
  return Object.freeze({
    kind: "available",
    shouldAttach: shouldAttachDetachedTmuxSession(process.env),
    report,
  });
}


function handleMadmaxDetachedReuse(
  runtimeContext: MadmaxWorktreeRuntimeContext | undefined,
  preflight: DetachedPreflightAvailable,
): boolean {
  const contextKey = runtimeContext?.madmaxDetachedContext ?? process.env[OMX_MADMAX_DETACHED_CONTEXT_ENV]?.trim();
  const activeRecordPath = contextKey ? madmaxDetachedActiveRecordPath(resolveMadmaxRunsRoot(process.env), contextKey) : null;
  const activeRecord = activeRecordPath ? readMadmaxDetachedActiveRecord(activeRecordPath) : null;
  if (!activeRecord || activeRecord.context_key !== contextKey || !isReusableMadmaxDetachedActiveRecord(activeRecord)) return false;
  cleanupCurrentMadmaxReuseRunRoot(process.env, resolveMadmaxRunsRoot(process.env));
  setDetachedTmuxSessionHistoryLimit(activeRecord.tmux_session_name, activeRecord.tmux_pane_id!);
  if (!preflight.shouldAttach) {
    clearDetachedTmuxSessionHistoryIfUnattached(activeRecord.tmux_session_name, activeRecord.tmux_pane_id!);
    return true;
  }
  process.stderr.write(`[omx] madmax detached launch already active for this context; attaching ${activeRecord.tmux_session_name} instead of starting a duplicate.\n`);
  try {
    execTmuxFileSync(["attach-session", "-t", activeRecord.tmux_session_name], { stdio: "inherit" });
  } catch (error) {
    throw new DetachedLaunchSafetyError("post-release-attach", error, preflight.report);
  }
  return true;
}

export function createMadmaxIsolatedRoot(
  sourceCwd: string,
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const runsRoot = resolveMadmaxRunsRoot(env);
  mkdirSync(runsRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const suffix = Math.random().toString(16).slice(2, 6);
  const runDir = join(runsRoot, sanitizeRunIdSegment(`run-${stamp}-${suffix}`));
  mkdirSync(runDir, { recursive: false });
  const detachedLaunchContext = buildMadmaxDetachedLaunchContextKey(sourceCwd, argv, runDir);

  const metadata = {
    launcher: "omx --madmax",
    created_at: new Date().toISOString(),
    cwd: runDir,
    source_cwd: sourceCwd,
    argv,
    detached_launch_context: detachedLaunchContext,
  };
  writeFileSync(join(runDir, ".omxbox-run.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  writeFileSync(join(runsRoot, "registry.jsonl"), `${JSON.stringify(metadata)}\n`, { flag: "a" });
  env[OMX_MADMAX_DETACHED_CONTEXT_ENV] = detachedLaunchContext;
  return runDir;
}

function activateMadmaxIsolationIfNeeded(
  command: string,
  launchArgs: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!shouldAutoIsolateMadmaxLaunch(command, launchArgs, env, cwd)) return;
  const runDir = createMadmaxIsolatedRoot(cwd, launchArgs, env);
  env.OMX_ROOT = runDir;
  env.OMXBOX_ACTIVE = "1";
  env.OMX_SOURCE_CWD = cwd;
  process.stderr.write(`[omx] madmax isolated state: ${runDir} (source: ${cwd})\n`);
}

function renderDetachedLaunchSafetyReport(error: DetachedLaunchSafetyError): string {
  const establishmentCleanup = error.report.establishmentCleanup?.capability.map((entry) => ({
    role: entry.role,
    phase: entry.phase,
    status: entry.status,
    ...(entry.error ? { failureCode: detachedFailureCode(entry.error) } : {}),
  }));
  return JSON.stringify({
    phase: error.phase,
    transitions: error.report.transitions,
    ...(establishmentCleanup ? { establishmentCleanup } : {}),
    rollback: {
      attempted: error.report.rollback.attempted,
      failures: error.report.rollback.failures.map(({ step, status, code }) => ({ step, status, code })),
    },
  });
}

export async function main(args: string[]): Promise<void> {
  const knownCommands = new Set([
    "launch",
    "exec",
    "mission",
    "imagegen",
    "capabilities",
    "setup",
    "__detached-session-leader",
    "update",
    "list",
    "agents",
    "agents-init",
    "deepinit",
    "uninstall",
    "doctor",
    "cleanup",
    "auth",
    "ask",
    "question",
    "autoresearch",
  "autoresearch-goal",
    "explore",
    "api",
    "sparkshell",
    "team",
    "ralph",
    "ralplan",
    "ultragoal",
    "performance-goal",
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
  const { omxArgs } = splitOmxArgsAtEndOfOptions(args);
  const flags = new Set(omxArgs.filter((arg) => arg.startsWith("--")));
  const options = {
    force: flags.has("--force"),
    mergeAgents: undefined,
    dryRun: flags.has("--dry-run"),
    verbose: flags.has("--verbose"),
    team: flags.has("--team"),
  };

  if (flags.has("--help") && !commandOwnsLocalHelp(command)) {
    console.log(HELP);
    return;
  }

if (command !== "launch" && command !== "resume") {
  activateMadmaxIsolationIfNeeded(command, launchArgs, process.cwd(), process.env);
}
  try {
    if (command === "session") {
      await sessionCommand(args.slice(1));
      return;
    }

    if (command === "resume" && launchArgs.some((arg) => arg === "--help" || arg === "-h")) {
      console.log(RESUME_HELP);
      return;
    }


    switch (command) {
      case "__detached-session-leader": {
        const payload = decodeDetachedLeaderPayload(launchArgs[0]);
        await runDetachedSessionLeader(payload);
        break;
      }
      case "launch":
        if (launchArgsRequestAuthHotswap(launchArgs)) {
          await launchWithAuthHotswap(launchArgs);
        } else {
          await launchWithHud(launchArgs);
        }
        break;
      case "resume":
        await launchWithHud(["resume", ...launchArgs]);
        break;
      case "setup":
        await setup({
          force: options.force,
          mergeAgents: options.mergeAgents,
          mergeAgentsPolicy: resolveSetupAgentsMergePolicyArg(args.slice(1)),
          dryRun: options.dryRun,
          verbose: options.verbose,
          scope: resolveSetupScopeArg(args.slice(1)),
          installMode: resolveSetupInstallModeArg(args.slice(1)),
          mcpMode: resolveSetupMcpModeArg(args.slice(1)),
          teamMode: resolveSetupTeamModeArg(args.slice(1)),
        });
        break;
      case "update":
        await runImmediateUpdate(process.cwd(), {}, { channel: resolveUpdateChannelArg(args.slice(1)) });
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
      case "auth":
        await authCommand(args.slice(1));
        break;
      case "autoresearch":
        await autoresearchCommand(args.slice(1));
        break;
      case "autoresearch-goal":
        await autoresearchGoalCommand(args.slice(1));
        break;
      case "explore":
        await exploreCommand(args.slice(1));
        break;
      case "api":
        await apiCommand(args.slice(1));
        break;
      case "capabilities":
        await capabilitiesCommand(args.slice(1));
        break;
      case "exec":
        if (launchArgs[0] === "inject") {
          await execInjectCommand(launchArgs);
        } else {
          await execWithOverlay(launchArgs);
        }
        break;
      case "mission":
        await missionCommand(args.slice(1), {
          runTask: async (prompt, codexArgs) => {
            const priorExitCode = process.exitCode;
            process.exitCode = undefined;
            await execWithOverlay([...codexArgs, prompt]);
            const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
            process.exitCode = priorExitCode;
            return exitCode;
          },
        });
        break;
      case "imagegen":
        await imagegenCommand(args.slice(1));
        break;
      case "sparkshell":
        await sparkshellCommand(args.slice(1));
        break;
      case "team":
        await teamCommand(args.slice(1), options);
        break;
      case "url":
        await urlCommand(args.slice(1));
        break;
      case "ralph":
        await ralphCommand(args.slice(1));
        break;
      case "ralplan":
        await ralplanCommand(args.slice(1));
        break;
      case "ultragoal":
        await ultragoalCommand(args.slice(1));
        break;
      case "performance-goal":
        await performanceGoalCommand(args.slice(1));
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
        await cancelModes(args.slice(1));
        break;
      case "reasoning":
        await reasoningCommand(args.slice(1));
        break;
      case "codex-native-hook": {
        const { runCodexNativeHookCli } = await import("../scripts/codex-native-hook.js");
        await runCodexNativeHookCli();
        break;
      }
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
    if (err instanceof DetachedLaunchSafetyError) {
      console.error(`Error: ${err.message}`);
      console.error(`[omx] detached launch safety report: ${renderDetachedLaunchSafetyReport(err)}`);
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  }
}

type StaleCurrentAutopilotStatus = {
  phase: string;
};

function sanitizedStatusString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

async function readStaleCurrentAutopilotStatus(cwd: string): Promise<StaleCurrentAutopilotStatus | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(getBaseStateDir(cwd), "current-autopilot.json"), "utf-8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const state = parsed as Record<string, unknown>;
  if (state.active !== true) return null;
  const phase = sanitizedStatusString(state.current_phase) ?? sanitizedStatusString(state.currentPhase);
  const sessionId = sanitizedStatusString(state.session_id) ?? sanitizedStatusString(state.sessionId);
  const tmuxPaneId = sanitizedStatusString(state.tmux_pane_id) ?? sanitizedStatusString(state.tmuxPaneId);
  if (!phase && !sessionId && !tmuxPaneId) return null;
  return { phase: phase ?? "active" };
}

function formatDurableUltragoalStatusForCli(status: string): string {
  return status === "failed"
    ? "ultragoal: FAILED (phase: failed)"
    : `ultragoal: ACTIVE (phase: ${status})`;
}

async function showStatus(): Promise<void> {
  const { readFile } = await import("fs/promises");
  const cwd = process.cwd();
  try {
    let refs = await listModeStateFilesWithScopePreference(cwd);
    // Reconcile with hook-visible run-dir state when the worktree-scoped state
    // list reports no active workflow mode (parity with `omx cancel`). This
    // surfaces detached/madmax sessions whose state lives under the run dir.
    const hasActiveWorkflowMode = async (candidate: ModeStateFileRef[]): Promise<boolean> => {
      for (const ref of candidate) {
        const mode = basename(ref.path).replace("-state.json", "");
        if (mode === SKILL_ACTIVE_STATE_MODE) continue;
        try {
          const parsed = JSON.parse(await readFile(ref.path, "utf-8")) as Record<string, unknown>;
          if (parsed.active === true) return true;
        } catch {
          continue;
        }
      }
      return false;
    };
    let hasAuthoritativeActiveMode = await hasActiveWorkflowMode(refs);
    if (!hasAuthoritativeActiveMode) {
      const runDirRefs = await listHookVisibleRunDirStateRefs(cwd);
      if (await hasActiveWorkflowMode(runDirRefs)) {
        refs = runDirRefs;
        hasAuthoritativeActiveMode = true;
      }
    }
    const states = refs.map((ref) => ref.path);
    const ultragoalState = await readUltragoalState(cwd).catch(() => null);
    if (states.length === 0) {
      if (ultragoalState?.active) {
        console.log(formatDurableUltragoalStatusForCli(ultragoalState.status ?? "active"));
        return;
      }
      const staleAutopilot = await readStaleCurrentAutopilotStatus(cwd);
      if (staleAutopilot) {
        console.log(`autopilot: STALE (phase: ${staleAutopilot.phase})`);
        return;
      }
      console.log("No active modes.");
      return;
    }
    let hasAuthoritativeActiveUltragoalMode = false;
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
      if (mode === "ultragoal" && state.active === true) {
        hasAuthoritativeActiveUltragoalMode = true;
      }
      if (mode === "ultragoal" && ultragoalState?.active && state.active !== true) continue;
      console.log(
        `${mode}: ${state.active === true ? "ACTIVE" : "inactive"} (phase: ${String(state.current_phase || "n/a")})`,
      );
    }
    if (ultragoalState?.active && !hasAuthoritativeActiveUltragoalMode) {
      console.log(formatDurableUltragoalStatusForCli(ultragoalState.status ?? "active"));
    }
    if (!hasAuthoritativeActiveMode && !ultragoalState?.active) {
      const staleAutopilot = await readStaleCurrentAutopilotStatus(cwd);
      if (staleAutopilot) {
        console.log(`autopilot: STALE (phase: ${staleAutopilot.phase})`);
      }
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
    const unsupportedMode = isUnsupportedRootReasoningEffort(mode)
      ? normalizeUnsupportedRootReasoningEffort(mode)
      : undefined;
    const guidance = unsupportedMode === "max"
      ? `Reasoning mode "${mode}" is not supported by "omx reasoning".\nPer-agent "max" is configured with agentReasoning; direct -c model_reasoning_effort=... is passed to Codex and remains capability-dependent.\n`
      : unsupportedMode === "ultra"
        ? `Reasoning mode "${mode}" is not supported by OMX root or per-agent reasoning and is not an alias for "max".\nDirect -c model_reasoning_effort=... remains opaque Codex passthrough.\n`
        : "";
    throw new Error(
      `${guidance}Invalid reasoning mode "${mode}". Expected one of: ${REASONING_MODES.join(", ")}.\n${REASONING_USAGE}`,
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

export async function launchWithAuthHotswap(args: string[]): Promise<void> {
  const launchCwd = process.cwd();
  const { omxArgs, suffix } = splitOmxArgsAtEndOfOptions(args);
  const parsedWorktree = parseWorktreeMode(omxArgs);
  const hotswapArgs = [...parsedWorktree.remainingArgs, ...suffix];

  let cwd = launchCwd;
  let worktreeDirty = false;
  let ensuredLaunchWorktree: ReturnType<typeof ensureWorktree> | undefined;

  if (parsedWorktree.mode.enabled) {
    const planned = planWorktreeTarget({
      cwd: launchCwd,
      scope: "launch",
      mode: parsedWorktree.mode,
    });
    const ensured = ensureWorktree(planned, { allowDirtyReuse: true });
    ensuredLaunchWorktree = ensured;
    if (ensured.enabled) {
      cwd = ensured.worktreePath;
      worktreeDirty = Boolean(ensured.dirty);
      if (ensured.dirty) {
        process.stderr.write(
          `[omx] Caution: worktree at ${cwd} has uncommitted changes.\n` +
          `  The hotswap session will launch as-is.\n`,
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
  clearInheritedMadmaxRootForDisposableWorktreeLaunch(parsedWorktree.remainingArgs);
  applyDisposableWorktreeOmxRootForLaunch(ensuredLaunchWorktree);
  applyWorktreeToolContextForLaunch(cwd, ensuredLaunchWorktree);

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
    const configPath = resolveCodexConfigPathForLaunch(launchCwd, process.env);
    const repaired = await repairConfigIfNeeded(
      configPath,
      getPackageRoot(),
      await resolveLaunchConfigRepairOptions(launchCwd, configPath),
    );
    if (repaired) console.log("[omx] Repaired managed config.toml compatibility issue.");
  } catch {
    // Non-fatal: repair failure must not block launch
  }

  const status = await runAuthHotswap({
    cwd,
    argv: hotswapArgs,
    lifecycle: {
      prepareCodexHomeForLaunch,
      preLaunch: (launchPath, sessionId, notifyTempContract, codexHomeOverride, enableAuthority) =>
        preLaunch(launchPath, sessionId, notifyTempContract as NotifyTempContract, codexHomeOverride, enableAuthority, worktreeDirty),
      postLaunch,
      cleanupRuntimeCodexHome,
      normalizeCodexLaunchArgs,
      injectModelInstructionsBypassArgs,
      sessionModelInstructionsPath,
      resolveOmxRootForLaunch,
      resolveNotifyTempContract,
    },
  });
  process.exitCode = status;
}

export async function launchWithHud(args: string[]): Promise<void> {


  const launchCwd = process.cwd();
  const { omxArgs, suffix } = splitOmxArgsAtEndOfOptions(args);
  const parsedWorktree = parseWorktreeMode(omxArgs);
  const notifyTempResult = resolveNotifyTempContract(
    parsedWorktree.remainingArgs,
    process.env,
  );
  const passthroughArgs = [...notifyTempResult.passthroughArgs, ...suffix];
  const explicitLaunchPolicy = resolveEffectiveLeaderLaunchPolicyOverride(
    passthroughArgs,
    process.env,
  );
  let { launchPolicy } = resolveTmuxAwareLaunchPolicy(explicitLaunchPolicy, isNativeWindows());
  let detachedPreflight: DetachedPreflightAvailable | undefined;
  if (launchPolicy === "detached-tmux") {
    try {
      detachedPreflight = preflightDetachedLaunch();
    } catch (error) {
      if (!(error instanceof DetachedTransportUnavailable)) throw error;
      console.warn("[omx] warning: detached tmux transport is unavailable. Falling back to direct Codex launch.");
      launchPolicy = "direct";
    }
  }
  const enableNotifyFallbackAuthority = launchPolicy === "direct";
  activateMadmaxIsolationIfNeeded("launch", args, launchCwd, process.env);
  const persistentCodexHomeForLaunch = resolveCodexHomeForLaunch(launchCwd, process.env);
  const workerSparkModel = resolveWorkerSparkModel(
    passthroughArgs,
    persistentCodexHomeForLaunch,
  );
  let normalizedArgs = normalizeCodexLaunchArgs(passthroughArgs);
  let cwd = launchCwd;
  let worktreeDirty = false;
  let ensuredLaunchWorktree: ReturnType<typeof ensureWorktree> | undefined;
  if (parsedWorktree.mode.enabled) {
    const planned = planWorktreeTarget({
      cwd: launchCwd,
      scope: "launch",
      mode: parsedWorktree.mode,
    });
    const ensured = ensureWorktree(planned, { allowDirtyReuse: true });
    ensuredLaunchWorktree = ensured;
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
  const madmaxWorktreeRuntimeContext = captureMadmaxWorktreeRuntimeContext({
    originalLaunchArgs: omxArgs,
    worktreeEnabled: Boolean(parsedWorktree.mode.enabled && ensuredLaunchWorktree?.enabled),
    sourceCwd: launchCwd,
    worktreeCwd: ensuredLaunchWorktree?.enabled ? ensuredLaunchWorktree.worktreePath : undefined,
    env: process.env,
  });
  clearInheritedMadmaxRootForDisposableWorktreeLaunch(parsedWorktree.remainingArgs);
  applyDisposableWorktreeOmxRootForLaunch(ensuredLaunchWorktree);
  applyWorktreeToolContextForLaunch(cwd, ensuredLaunchWorktree);
  if (launchPolicy === "detached-tmux" && detachedPreflight && handleMadmaxDetachedReuse(madmaxWorktreeRuntimeContext, detachedPreflight)) return;



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
    const configPath = resolveCodexConfigPathForLaunch(launchCwd, process.env);
    const repaired = await repairConfigIfNeeded(
      configPath,
      getPackageRoot(),
      await resolveLaunchConfigRepairOptions(launchCwd, configPath),
    );
    if (repaired) {
      console.log("[omx] Repaired managed config.toml compatibility issue.");
    }
  } catch {
    // Non-fatal: repair failure must not block launch
  }

  const resumePrepared = isResumeCodexLaunch(normalizedArgs)
    ? await prepareResumeCodexHomeForLaunch(launchCwd, sessionId, normalizedArgs, process.env)
    : null;
  if (resumePrepared) {
    normalizedArgs = resumePrepared.args;
  }
  const preparedCodexHome = resumePrepared?.prepared ?? await prepareCodexHomeForLaunch(launchCwd, sessionId, process.env, {
    includeHistoryArtifacts: isResumeCodexLaunch(normalizedArgs),
  });
  const codexHomeOverride = preparedCodexHome.codexHomeOverride;
  const sqliteHomeOverride = preparedCodexHome.sqliteHomeOverride;
  const projectLocalCodexHomeForCleanup = preparedCodexHome.projectLocalCodexHomeForCleanup;
  let launch: PreLaunchResult | undefined;
  if (launchPolicy !== "detached-tmux") {
    try {
      launch = await preLaunch(cwd, sessionId, notifyTempResult.contract, codexHomeOverride, enableNotifyFallbackAuthority, worktreeDirty);
    } catch (err) {
      logEstablishmentCleanupEvidence(err);
      if (isSessionPointerLaunchAbort(err)) {
        console.error(`[omx] session pointer launch aborted: ${err.code}`);
        reportOrdinaryLaunchRootConflict(
          err,
          cwd,
          cwd === launchCwd && !parsedWorktree.mode.enabled && !isResumeCodexLaunch(normalizedArgs),
        );
      }
      await cleanupRuntimeCodexHome(
        preparedCodexHome.runtimeCodexHomeForCleanup,
        projectLocalCodexHomeForCleanup,
      ).catch((cleanupErr) => {
        console.error(
          `[omx] preLaunch abort cleanup warning: ${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`,
        );
      });
      throw err;
    }
  }

  let postLaunchHandledExternally = false;
  try {
    const notifyTempContractRaw = notifyTempResult.contract.active
      ? serializeNotifyTempContract(notifyTempResult.contract)
      : null;
    const launchResult = await runCodex(
      cwd,
      normalizedArgs,
      sessionId,
      workerSparkModel,
      codexHomeOverride,
      sqliteHomeOverride,
      notifyTempContractRaw,
      {
        notifyTempContract: notifyTempResult.contract,
        enableNotifyFallbackAuthority,
        worktreeDirty,
      },
      launchPolicy,
      detachedPreflight,
      projectLocalCodexHomeForCleanup,
      preparedCodexHome.runtimeCodexHomeForCleanup,
      madmaxWorktreeRuntimeContext,
    );
    postLaunchHandledExternally = launchResult.postLaunchHandledExternally;
  } catch (error) {
    if (error instanceof DetachedLaunchSafetyError) postLaunchHandledExternally = true;
    throw error;
  } finally {
    if (!postLaunchHandledExternally && launch) {
      await postLaunch(cwd, sessionId, launch.binding, codexHomeOverride, enableNotifyFallbackAuthority, projectLocalCodexHomeForCleanup);
      await cleanupRuntimeCodexHome(preparedCodexHome.runtimeCodexHomeForCleanup, projectLocalCodexHomeForCleanup).catch(logCliOperationFailure);
    }
  }
}

export async function execWithOverlay(args: string[]): Promise<void> {
  const launchCwd = process.cwd();
  const { omxArgs, suffix } = splitOmxArgsAtEndOfOptions(args);
  const parsedWorktree = parseWorktreeMode(omxArgs);
  const notifyTempResult = resolveNotifyTempContract(
    parsedWorktree.remainingArgs,
    process.env,
  );
  const passthroughArgs = [...notifyTempResult.passthroughArgs, ...suffix];
  const normalizedArgs = normalizeCodexLaunchArgs(passthroughArgs);
  let cwd = launchCwd;
  let worktreeDirty = false;
  let ensuredLaunchWorktree: ReturnType<typeof ensureWorktree> | undefined;

  if (parsedWorktree.mode.enabled) {
    const planned = planWorktreeTarget({
      cwd: launchCwd,
      scope: "launch",
      mode: parsedWorktree.mode,
    });
    const ensured = ensureWorktree(planned, { allowDirtyReuse: true });
    ensuredLaunchWorktree = ensured;
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

  clearInheritedMadmaxRootForDisposableWorktreeLaunch(parsedWorktree.remainingArgs);
  applyDisposableWorktreeOmxRootForLaunch(ensuredLaunchWorktree);
  applyWorktreeToolContextForLaunch(cwd, ensuredLaunchWorktree);

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
    const configPath = resolveCodexConfigPathForLaunch(launchCwd, process.env);
    const repaired = await repairConfigIfNeeded(
      configPath,
      getPackageRoot(),
      await resolveLaunchConfigRepairOptions(launchCwd, configPath),
    );
    if (repaired) {
      console.log("[omx] Repaired managed config.toml compatibility issue.");
    }
  } catch {
    // Non-fatal
  }

  const preparedCodexHome = await prepareCodexHomeForLaunch(launchCwd, sessionId, process.env);
  const codexHomeOverride = preparedCodexHome.codexHomeOverride;
  const sqliteHomeOverride = preparedCodexHome.sqliteHomeOverride;
  const projectLocalCodexHomeForCleanup = preparedCodexHome.projectLocalCodexHomeForCleanup;
  let launch: PreLaunchResult;

  try {
    launch = await preLaunch(cwd, sessionId, notifyTempResult.contract, codexHomeOverride, true, worktreeDirty);
  } catch (err) {
    logEstablishmentCleanupEvidence(err);
    if (isSessionPointerLaunchAbort(err)) {
      console.error(`[omx] session pointer launch aborted: ${err.code}`);
    }
    await cleanupRuntimeCodexHome(
      preparedCodexHome.runtimeCodexHomeForCleanup,
      projectLocalCodexHomeForCleanup,
    ).catch((cleanupErr) => {
      console.error(
        `[omx] preLaunch abort cleanup warning: ${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`,
      );
    });
    throw err;
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
    const omxRootOverride = resolveOmxRootForLaunch(cwd, process.env);
    const codexEnvBase = {
      ...process.env,
      ...(codexHomeOverride ? { CODEX_HOME: codexHomeOverride } : {}),
      ...(sqliteHomeOverride ? { [CODEX_SQLITE_HOME_ENV]: sqliteHomeOverride } : {}),
      ...(omxRootOverride ? { OMX_ROOT: omxRootOverride } : {}),
    };
    const codexEnv = notifyTempContractRaw
      ? {
          ...codexEnvBase,
          [OMX_NOTIFY_TEMP_CONTRACT_ENV]: notifyTempContractRaw,
        }
      : codexEnvBase;
    runCodexBlocking(cwd, codexArgs, codexEnv);
  } finally {
    await postLaunch(cwd, sessionId, launch.binding, codexHomeOverride, true, projectLocalCodexHomeForCleanup);
    await cleanupRuntimeCodexHome(preparedCodexHome.runtimeCodexHomeForCleanup, projectLocalCodexHomeForCleanup).catch(logCliOperationFailure);
  }
}

export function normalizeCodexLaunchArgs(args: string[]): string[] {
  const { omxArgs, suffix } = splitOmxArgsAtEndOfOptions(args);
  const parsed = parseWorktreeMode(omxArgs);
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

    if (arg === "--max" || arg === "--ultra") {
      throw unsupportedLaunchShorthandError(arg);
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

  return [...normalized, ...suffix];
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
    if (arg === "--") break;
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

async function resolvePreLaunchSessionPointerOptions(): Promise<{
  ownerAliasVerified?: true;
  tmuxSessionName?: string;
  tmuxPaneId?: string;
}> {
  const ownerCandidate = normalizeSessionId(process.env.OMX_SESSION_ID);
  if (!ownerCandidate) return {};

  const evidence = await probeActualTmuxInstanceEvidence(process.env.TMUX_PANE);
  if (!tmuxEvidenceBindsCandidate(evidence, ownerCandidate)) return {};

  return {
    ownerAliasVerified: true,
    ...(evidence.sessionName ? { tmuxSessionName: evidence.sessionName } : {}),
    ...(evidence.paneTarget ? { tmuxPaneId: evidence.paneTarget } : {}),
  };
}

function tagTmuxSessionWithInstance(sessionName: string, sessionId: string): void {
  const target = sessionName.trim();
  const instanceId = sessionId.trim();
  if (!target || !instanceId) return;
  execFileSync("tmux", ["set-option", "-t", target, OMX_INSTANCE_OPTION, instanceId], {
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 2000,
  });
}

function tagCurrentTmuxSessionWithInstance(sessionId: string): void {
  if (!process.env.TMUX) return;
  try {
    const tmuxPaneTarget = process.env.TMUX_PANE;
    const displayArgs = tmuxPaneTarget
      ? ["display-message", "-p", "-t", tmuxPaneTarget, "#S"]
      : ["display-message", "-p", "#S"];
    const sessionName = execFileSync("tmux", displayArgs, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    if (sessionName) tagTmuxSessionWithInstance(sessionName, sessionId);
  } catch {
    // Best effort only: launch should not fail just because tmux tagging failed.
  }
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
  const { omxArgs, suffix } = splitOmxArgsAtEndOfOptions(args);
  if (hasModelInstructionsOverride(omxArgs)) return [...args];
  return [
    ...omxArgs,
    CONFIG_FLAG,
    buildModelInstructionsOverride(cwd, env, defaultFilePath),
    ...suffix,
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
  return serializeTeamWorkerLaunchArgs(normalized);
}

export { readTopLevelTomlString, upsertTopLevelTomlString } from "../utils/toml.js";

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
  return join(omxRoot(cwd), "state", TMUX_EXTENDED_KEYS_LEASE_DIR);
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

interface DetachedLeaderPreLaunchOptions {
  notifyTempContract?: NotifyTempContract;
  enableNotifyFallbackAuthority: boolean;
  worktreeDirty: boolean;
}

function buildDetachedSessionLeaderCommand(
  cwd: string,
  sessionName: string,
  codexCmd: string,
  sessionId: string | undefined,
  codexHomeOverride: string | undefined,
  projectLocalCodexHomeForCleanup: string | undefined,
  runtimeCodexHomeForCleanup: string | undefined,
  parentEnvFilePath: string | undefined,
  readyPath: string | undefined,
  preLaunchOptions: DetachedLeaderPreLaunchOptions,
  omxBin = process.argv[1],
): string {
  const payload = Buffer.from(JSON.stringify({
    cwd, sessionName, sessionId, codexCmd, codexHomeOverride,
    projectLocalCodexHomeForCleanup, runtimeCodexHomeForCleanup, parentEnvFilePath,
    readyPath, preLaunchOptions,
  })).toString("base64url");
  return `/bin/sh -c ${quoteShellArg(`${parentEnvFilePath ? `if [ -r ${quoteShellArg(parentEnvFilePath)} ]; then . ${quoteShellArg(parentEnvFilePath)}; rm -f ${quoteShellArg(parentEnvFilePath)}; fi; ` : ""}exec ${quoteShellArg(process.execPath)} ${quoteShellArg(omxBin)} __detached-session-leader ${quoteShellArg(payload)}`)}`;
}

function buildDetachedWindowsLeaderCommand(
  cwd: string,
  sessionName: string,
  codexCmd: string,
  sessionId: string | undefined,
  codexHomeOverride: string | undefined,
  projectLocalCodexHomeForCleanup: string | undefined,
  runtimeCodexHomeForCleanup: string | undefined,
  parentEnv: NodeJS.ProcessEnv | undefined,
  readyPath: string | undefined,
  preLaunchOptions: DetachedLeaderPreLaunchOptions,
  omxBin = process.argv[1],
): string {
  const payload = Buffer.from(JSON.stringify({
    cwd, sessionName, sessionId, codexCmd, codexHomeOverride,
    projectLocalCodexHomeForCleanup, runtimeCodexHomeForCleanup,
    ...(parentEnv ? { parentEnv: detachedSessionParentEnvironment(parentEnv) } : {}),
    readyPath, preLaunchOptions,
  })).toString("base64url");
  const invocation = `& ${quotePowerShellArg(process.execPath)} ${quotePowerShellArg(omxBin)} __detached-session-leader ${quotePowerShellArg(payload)}`;
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -Command ${quotePowerShellArg(invocation)}`;
}

interface DetachedLeaderReport {
  version: 1;
  kind: "ready" | "failed" | "terminal" | "release" | "abort";

  nonce: string;
  sessionId: string;
  sessionName: string;
  paneId?: string;
  leaderPid?: number;
  error?: string;
  finalized?: boolean;
}

function writeDetachedLeaderReport(path: string, report: DetachedLeaderReport): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(report)}\n`, "utf-8");
    try { fsyncSync(fd); } catch (error) {
      if (!(process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM")) throw error;
    }
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, path);
    const directoryFd = openSync(dirname(path), "r");
    try {
      try { fsyncSync(directoryFd); } catch (error) {
        if (!(process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM")) throw error;
      }
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tempPath); } catch {}
  }
}

function readDetachedLeaderReport(path: string): DetachedLeaderReport | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object") return undefined;
    const report = value as Record<string, unknown>;
    if (report.version !== 1 || !["ready", "failed", "terminal", "release", "abort"].includes(String(report.kind)) ||

      typeof report.nonce !== "string" || typeof report.sessionId !== "string" || typeof report.sessionName !== "string") return undefined;
    if (report.paneId !== undefined && typeof report.paneId !== "string") return undefined;
    if (report.leaderPid !== undefined && (!Number.isSafeInteger(report.leaderPid) || Number(report.leaderPid) <= 0)) return undefined;
    return report as unknown as DetachedLeaderReport;
  } catch { return undefined; }
}

function publishDetachedReleaseMarker(releaseMarkerPath: string, nonce: string, sessionId: string, sessionName: string, leaderPid: number): void {
  writeDetachedLeaderReport(`${releaseMarkerPath}.release`, { version: 1, kind: "release", nonce, sessionId, sessionName, leaderPid });
}

function publishDetachedAbortMarker(releaseMarkerPath: string, nonce: string, sessionId: string, sessionName: string, leaderPid: number): void {
  writeDetachedLeaderReport(`${releaseMarkerPath}.abort`, { version: 1, kind: "abort", nonce, sessionId, sessionName, leaderPid });
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
    if (!isUnsupportedTmuxExtendedKeysFailure(err)) {
      logCliOperationFailure(err);
    }
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
    if (!isUnsupportedTmuxExtendedKeysFailure(err)) {
      logCliOperationFailure(err);
    }
  }
}



const SHELL_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DETACHED_SESSION_PANE_ENV_KEYS = new Set([
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TMUX",
  "TMUX_PANE",
  "COLUMNS",
  "LINES",
]);

function detachedSessionParentEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    if (!SHELL_ENV_NAME_PATTERN.test(key) || DETACHED_SESSION_PANE_ENV_KEYS.has(key)) continue;
    const value = env[key];
    if (typeof value === "string" && !value.includes("\0")) values[key] = value;
  }
  return values;
}

export function serializeDetachedSessionParentEnv(
  env: NodeJS.ProcessEnv,
): string {
  return `${Object.entries(detachedSessionParentEnvironment(env))
    .map(([key, value]) => `export ${key}=${quoteShellArg(value)}`)
    .join("\n")}\n`;
}

export function detachedSessionParentEnvFilePath(
  cwd: string,
  sessionId: string,
): string {
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(omxRoot(cwd), "runtime", "tmux-env", `${safeSessionId}.env`);
}

export function writeDetachedSessionParentEnvFile(
  cwd: string,
  sessionId: string,
  env: NodeJS.ProcessEnv,
): string {
  const filePath = detachedSessionParentEnvFilePath(cwd, sessionId);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, serializeDetachedSessionParentEnv(env), {
    encoding: "utf-8",
    mode: 0o600,
  });
  return filePath;
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
  projectLocalCodexHomeForCleanup?: string,
  runtimeCodexHomeForCleanup?: string,
  omxRootOverride?: string,
  env: NodeJS.ProcessEnv = process.env,
  sqliteHomeOverride?: string,
  parentEnvFilePath?: string,
  inheritedWorkerModel?: string | null,
  releaseMarkerPath?: string,
  omxBin = process.argv[1],
  preLaunchOptions: DetachedLeaderPreLaunchOptions = {
    enableNotifyFallbackAuthority: false,
    worktreeDirty: false,
  },
): DetachedSessionTmuxStep[] {
  const detachedLeaderCmd = nativeWindows
    ? buildDetachedWindowsLeaderCommand(
        cwd, sessionName, codexCmd, sessionId, codexHomeOverride,
        projectLocalCodexHomeForCleanup, runtimeCodexHomeForCleanup, env, releaseMarkerPath,
        preLaunchOptions, omxBin,
      )
    : buildDetachedSessionLeaderCommand(
        cwd, sessionName, codexCmd, sessionId, codexHomeOverride,
        projectLocalCodexHomeForCleanup, runtimeCodexHomeForCleanup, parentEnvFilePath,
        releaseMarkerPath, preLaunchOptions, omxBin,
      );
  const resolvedEnvStateRoot = env.OMX_STATE_ROOT?.trim()
    ? resolveLaunchPath(cwd, env.OMX_STATE_ROOT.trim())
    : undefined;
  const hasExplicitRootOverride = Boolean(
    env.OMX_ROOT?.trim()
      || (omxRootOverride && omxRootOverride !== resolvedEnvStateRoot),
  );
  const hudRuntimeRoot = env.OMX_TEAM_STATE_ROOT?.trim()
    ? resolveHudRuntimeRootForLaunch(cwd, env)
    : hasExplicitRootOverride
      ? {
          omxRoot: omxRootOverride,
          rootSource: resolveHudRuntimeRootSource(omxRootOverride, env),
        }
      : resolveHudRuntimeRootForLaunch(cwd, env);
  const hudRuntimeEnv = buildHudRuntimeEnv({
    sessionId,
    ...hudRuntimeRoot,
  }).env;
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
    ...(workerLaunchArgs ? ["-e", `${TEAM_WORKER_LAUNCH_ARGS_ENV}=${workerLaunchArgs}`] : []),
    ...Object.entries(hudRuntimeEnv).map(([key, value]) => ["-e", `${key}=${value}`]).flat(),
    ...(codexHomeOverride ? ["-e", `CODEX_HOME=${codexHomeOverride}`] : []),
    ...(sqliteHomeOverride ? ["-e", `${CODEX_SQLITE_HOME_ENV}=${sqliteHomeOverride}`] : []),
    ...(env.OMXBOX_ACTIVE ? ["-e", `OMXBOX_ACTIVE=${env.OMXBOX_ACTIVE}`] : []),
    ...(env.OMX_SOURCE_CWD ? ["-e", `OMX_SOURCE_CWD=${env.OMX_SOURCE_CWD}`] : []),
    ...(env[OMX_MADMAX_DETACHED_CONTEXT_ENV]
      ? ["-e", `${OMX_MADMAX_DETACHED_CONTEXT_ENV}=${env[OMX_MADMAX_DETACHED_CONTEXT_ENV]}`]
      : []),
    ...(notifyTempContractRaw
      ? ["-e", `${OMX_NOTIFY_TEMP_CONTRACT_ENV}=${notifyTempContractRaw}`]
      : []),
    ...(inheritedWorkerModel ? ["-e", `${TEAM_WORKER_INHERITED_MODEL_ENV}=${inheritedWorkerModel}`] : []),
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
    ...(sessionId
      ? [
          {
            name: "tag-session",
            args: ["set-option", "-t", sessionName, OMX_INSTANCE_OPTION, sessionId],
          },
        ]
      : []),
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

export function shouldAttachDetachedTmuxSession(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.OMX_HERMES_MCP_BRIDGE !== "1";
}

function stripHermesMcpBridgeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { OMX_HERMES_MCP_BRIDGE: _bridge, ...rest } = env;
  return rest;
}

export function buildDetachedSessionFinalizeSteps(
  sessionName: string,
  hudPaneId: string | null,
  hookWindowIndex: string | null,
  enableMouse: boolean,
  nativeWindows = false,
  attachSession = true,
  leaderPaneId: string | null = null,
): DetachedSessionTmuxStep[] {
  const steps: DetachedSessionTmuxStep[] = [];
  if (!nativeWindows && leaderPaneId) {
    steps.push({
      name: "register-detached-history-prune-hook",
      args: [
        "set-hook",
        "-t",
        sessionName,
        buildDetachedHistoryPruneHookSlot(sessionName, leaderPaneId),
        buildDetachedHistoryPruneHookCommand(leaderPaneId),
      ],
    });
  }

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
  if (attachSession) {
    steps.push({
      name: "attach-session",
      args: ["attach-session", "-t", sessionName],
    });
  }
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
    omxRootOverride?: string;
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
    ...(options.omxRootOverride ? { OMX_ROOT: options.omxRootOverride } : {}),
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

function cleanPostLaunchString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isAutopilotReviewPendingPostLaunchState(state: Record<string, unknown> | null): boolean {
  if (!state || state.active !== true) return false;
  const mode = cleanPostLaunchString(state.mode).toLowerCase();
  if (mode && mode !== "autopilot") return false;
  const phase = cleanPostLaunchString(state.current_phase ?? state.currentPhase)
    .toLowerCase()
    .replace(/_/g, "-");
  if (phase === "code-review" || phase === "review" || phase === "reviewing" || phase === "review-pending") {
    return true;
  }
  const nestedState = state.state && typeof state.state === "object"
    ? state.state as Record<string, unknown>
    : {};
  return state.review_pending === true
    || state.reviewPending === true
    || nestedState.review_pending === true
    || nestedState.reviewPending === true;
}

function postLaunchUniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

async function scrubPostLaunchRootSkillActiveForSession(
  stateDir: string,
  sessionId: string,
  nowIso: string,
  writeFileFn: typeof import("fs/promises").writeFile,
  rootStateBeforeCleanup?: SkillActiveStateLike | null,
): Promise<void> {
  const normalizedSessionId = cleanPostLaunchString(sessionId);
  if (!normalizedSessionId) return;

  const { rootPath } = getSkillActiveStatePathsForStateDir(stateDir);
  const rootState = rootStateBeforeCleanup ?? await readSkillActiveState(rootPath);
  if (!rootState) return;

  const rootSessionIds = postLaunchUniqueStrings([
    cleanPostLaunchString(rootState.session_id),
    cleanPostLaunchString(extractSessionIdFromInitializedStatePath(rootState.initialized_state_path)),
  ]);
  const rootBelongsToSession = rootSessionIds.includes(normalizedSessionId);
  const entries = listActiveSkills(rootState);
  const keptEntries = entries.filter((entry) => {
    const entrySessionId = cleanPostLaunchString(entry.session_id);
    if (entrySessionId) return entrySessionId !== normalizedSessionId;
    return !rootBelongsToSession;
  });

  if (keptEntries.length === entries.length && rootState.active !== true) return;
  if (keptEntries.length === entries.length && !rootBelongsToSession) return;

  const nextRoot = {
    ...rootState,
    active: keptEntries.length > 0,
    skill: keptEntries[0]?.skill ?? (keptEntries.length > 0 ? cleanPostLaunchString(rootState.skill) : ""),
    phase: keptEntries[0]?.phase ?? (keptEntries.length > 0 ? cleanPostLaunchString(rootState.phase) : "complete"),
    updated_at: nowIso,
    active_skills: keptEntries,
    post_launch_reconciled_at: nowIso,
    post_launch_reconciliation_reason: "terminal_session_cleanup",
  };
  await writeFileFn(rootPath, JSON.stringify(nextRoot, null, 2));
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

function markRalphCompletionAuditBlockedForPostLaunch(
  state: Record<string, unknown>,
  cwd: string,
  nowIso: string,
): boolean {
  if (!isRalphCompletePhase(state.current_phase ?? state.currentPhase)) return false;
  const audit = evaluateRalphCompletionAuditEvidence(state, cwd);
  if (audit.complete) return false;
  state.active = false;
  state.current_phase = "cancelled";
  state.completed_at = nowIso;
  state.last_turn_at = nowIso;
  state.interrupted_at = nowIso;
  state.stop_reason = `missing_completion_audit:${audit.reason}`;
  state.completion_audit_gate = "blocked";
  state.completion_audit_missing_reason = audit.reason;
  state.completion_audit_blocked_at = nowIso;
  return true;
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
  const scopedDirs = sessionId
    ? [getStateDir(cwd, sessionId)]
    : [getBaseStateDir(cwd)];
  const rootStateDir = getBaseStateDir(cwd);
  const rootSkillActiveStateBeforeCleanup = sessionId
    ? await readSkillActiveState(getSkillActiveStatePathsForStateDir(rootStateDir).rootPath)
    : null;
  let preserveSkillActiveForReviewPendingAutopilot = false;

  for (const stateDir of scopedDirs) {
    const files = await readdir(stateDir).catch(() => [] as string[]);
    const autopilotPath = join(stateDir, "autopilot-state.json");
    const autopilotPrecheck = files.includes("autopilot-state.json")
      ? await readPostLaunchModeStateFile(autopilotPath, dependencies)
      : null;
    const preserveReviewPendingAutopilot = autopilotPrecheck?.kind === "ok"
      && isAutopilotReviewPendingPostLaunchState(autopilotPrecheck.state);
    preserveSkillActiveForReviewPendingAutopilot ||= preserveReviewPendingAutopilot;

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
                baseStateDir: rootStateDir,
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
      if (result.state.active !== true && !skillStateStillVisible) {
        const completedAt = now().toISOString();
        const normalized = mode === SKILL_ACTIVE_STATE_MODE
          ? { state: result.state, changed: false }
          : normalizeTerminalWorkflowState(result.state, { mode, nowIso: completedAt });
        if (normalized.changed) {
          result.state = normalized.state;
          await writeFile(path, JSON.stringify(result.state, null, 2));
        }
        if (mode === "ralph") {
          const completedAt = now().toISOString();
          if (markRalphCompletionAuditBlockedForPostLaunch(result.state, cwd, completedAt)) {
            await writeFile(path, JSON.stringify(result.state, null, 2));
            await syncCanonicalSkillStateForMode({
              cwd,
              baseStateDir: rootStateDir,
              mode,
              active: false,
              currentPhase: "cancelled",
              sessionId: stateDir === getStateDir(cwd, sessionId) ? sessionId : undefined,
              nowIso: completedAt,
              source: "postLaunchCleanup",
            });
          }
        }
        continue;
      }
      if (
        preserveReviewPendingAutopilot
        && (mode === "autopilot" || mode === SKILL_ACTIVE_STATE_MODE)
      ) {
        continue;
      }

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
        result.state = normalizeTerminalWorkflowState(result.state, { mode, nowIso: completedAt }).state;
        if (mode === "ralph") {
          result.state.interrupted_at = completedAt;
          result.state.stop_reason = cleanPostLaunchString(result.state.stop_reason) || "session_exit";
        }
        await writeFile(path, JSON.stringify(result.state, null, 2));
        if (isTrackedWorkflowMode(mode)) {
          await syncCanonicalSkillStateForMode({
            cwd,
            baseStateDir: rootStateDir,
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

  if (sessionId) {
    try {
      if (!preserveSkillActiveForReviewPendingAutopilot) {
        await scrubPostLaunchRootSkillActiveForSession(
          rootStateDir,
          sessionId,
          now().toISOString(),
          writeFile,
          rootSkillActiveStateBeforeCleanup,
        );
      }
    } catch (err) {
      writeWarn(
        `[omx] postLaunch: failed to reconcile root skill-active state: ${err instanceof Error ? err.message : err}`,
      );
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
 * 2. Establish the canonical session pointer
 * 3. Generate session-scoped launch artifacts and start best-effort helpers
 *
 * Automatic broad stale-session cleanup remains disabled here. Only detached
 * OMX MCP processes without a live Codex ancestor are reaped so new launches
 * do not accumulate stale processes from prior crashed/closed sessions.
 */

export type DegradedSetupOperation =
  | "orphan-reaping"
  | "notify-watcher"
  | "derived-watcher"
  | "notification"
  | "native-lifecycle-event";
export type MandatorySetupOperation = "overlay" | "session-instructions" | "session-metrics";
export type CompletionResult =
  | { kind: "success"; establishmentCleanup?: EstablishmentCleanupEvidence }
  | { kind: "degraded-success"; operations: readonly DegradedSetupOperation[]; establishmentCleanup?: EstablishmentCleanupEvidence }
  | { kind: "failure"; operation: MandatorySetupOperation; error: unknown; establishmentCleanup?: EstablishmentCleanupEvidence };
export interface PreLaunchResult {
  readonly binding: LaunchSessionBinding;
  readonly completion: CompletionResult;
}

interface EstablishedPreLaunchBinding {
  readonly binding: LaunchSessionBinding;
  readonly cleanup: EstablishmentCleanupEvidence;
}

async function establishPreLaunchBinding(cwd: string, sessionId: string): Promise<EstablishedPreLaunchBinding> {
  const established = await establishLaunchSessionBinding(cwd, sessionId, await resolvePreLaunchSessionPointerOptions());
  if (established.kind === "committed-released") return { binding: established.binding, cleanup: established.cleanup };
  const error = established.kind === "precommit-aborted" ? established.abort : established.error;
  Object.assign(error, { establishmentCleanup: established.cleanup });
  throw error;
}

async function failPreLaunchSetup(binding: LaunchSessionBinding): Promise<void> {
  const failures: unknown[] = [];
  try {
    await finalizeBoundOnce(binding, "setup-failure");
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      const close = await closeLaunchSessionBindingOnce(binding);
      if (close.status === "failed") failures.push(close.error ?? new Error("bound session close failed"));
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "preLaunch setup finalization failed");
}

async function completePreLaunchSetup(
  cwd: string,
  sessionId: string,
  notifyTempContract: NotifyTempContract | undefined,
  codexHomeOverride: string | undefined,
  enableNotifyFallbackAuthority: boolean,
  worktreeDirty: boolean,
): Promise<CompletionResult> {
  const degraded: DegradedSetupOperation[] = [];
  try {
    const cleanup = await cleanupLaunchOrphanedMcpProcesses();
    if (cleanup.terminatedCount > 0) console.log(`[omx] Reaped ${cleanup.terminatedCount} orphaned OMX MCP process(es) before launch.`);
    if (cleanup.failedPids.length > 0) console.warn(`[omx] Failed to reap ${cleanup.failedPids.length} orphaned OMX MCP process(es); continuing launch.`);
  } catch (error) {
    degraded.push("orphan-reaping");
    logCliOperationFailure(error);
  }

  let instructions: string;
  try {
    const orchestrationMode = await resolveSessionOrchestrationMode(cwd, sessionId);
    const overlay = await generateOverlay(cwd, sessionId, { orchestrationMode });
    const launchAppendix = await readLaunchAppendInstructions();
    const dirtyWorktreeGuidance = worktreeDirty
      ? `\n\n## Session start: dirty worktree detected\n\nThis worktree has uncommitted changes that were present when the session launched.\nBefore executing the requested task, resolve the dirty state first:\n1. Review uncommitted changes with \`git status\` and \`git diff\`.\n2. Commit, stash, or discard changes as appropriate.\n3. Then proceed with the original task.`
      : "";
    instructions = launchAppendix.trim().length > 0 ? `${overlay}\n\n${launchAppendix}${dirtyWorktreeGuidance}` : `${overlay}${dirtyWorktreeGuidance}`;
  } catch (error) {
    return { kind: "failure", operation: "overlay", error };
  }
  try {
    await writeSessionModelInstructionsFile(cwd, sessionId, instructions);
  } catch (error) {
    return { kind: "failure", operation: "session-instructions", error };
  }
  try {
    await resetSessionMetrics(cwd, sessionId);
    tagCurrentTmuxSessionWithInstance(sessionId);
  } catch (error) {
    return { kind: "failure", operation: "session-metrics", error };
  }

  try { await startNotifyFallbackWatcher(cwd, { codexHomeOverride, enableAuthority: enableNotifyFallbackAuthority, sessionId }); }
  catch (error) { degraded.push("notify-watcher"); logCliOperationFailure(error); }
  try { await startHookDerivedWatcher(cwd); }
  catch (error) { degraded.push("derived-watcher"); logCliOperationFailure(error); }
  try {
    if (notifyTempContract?.active) {
      process.env[OMX_NOTIFY_TEMP_CONTRACT_ENV] = serializeNotifyTempContract(notifyTempContract);
      const { getNotificationConfig } = await import("../notifications/config.js");
      const startup = buildNotifyTempStartupMessages(notifyTempContract, Boolean(getNotificationConfig()?.enabled));
      for (const info of startup.infoLines) console.log(`[omx] ${info}`);
      for (const warning of startup.warningLines) console.warn(`[omx] ${warning}`);
    } else delete process.env[OMX_NOTIFY_TEMP_CONTRACT_ENV];
    const { notifyLifecycle } = await import("../notifications/index.js");
    await notifyLifecycle("session-start", { sessionId, projectPath: cwd, projectName: basename(cwd) });
  } catch (error) { degraded.push("notification"); logCliOperationFailure(error); }
  try {
    await emitNativeHookEvent(cwd, "session-start", { session_id: sessionId, context: buildNativeHookBaseContext(cwd, sessionId, "started", { project_path: cwd, project_name: basename(cwd), status: "started" }) });
  } catch (error) { degraded.push("native-lifecycle-event"); logCliOperationFailure(error); }
  return degraded.length === 0 ? { kind: "success" } : { kind: "degraded-success", operations: degraded };
}

export async function preLaunch(
  cwd: string,
  sessionId: string,
  notifyTempContract?: NotifyTempContract,
  codexHomeOverride?: string,
  enableNotifyFallbackAuthority: boolean = false,
  worktreeDirty: boolean = false,
): Promise<PreLaunchResult> {
  const established = await establishPreLaunchBinding(cwd, sessionId);
  const completion = {
    ...await completePreLaunchSetup(cwd, sessionId, notifyTempContract, codexHomeOverride, enableNotifyFallbackAuthority, worktreeDirty),
    establishmentCleanup: established.cleanup,
  } satisfies CompletionResult;
  if (completion.kind === "failure") {
    try { await failPreLaunchSetup(established.binding); }
    catch (cleanupError) { throw new AggregateError([completion.error, cleanupError], `preLaunch ${completion.operation} failed`); }
    throw completion.error;
  }
  return { binding: established.binding, completion };
}

/**
 * runCodex: Launch Codex CLI (blocks until exit).
 * All 3 paths (new tmux, existing tmux, no tmux) block via execSync/execFileSync.
 */
async function runCodex(
  cwd: string,
  args: string[],
  sessionId: string,
  workerDefaultModel: string | undefined,
  codexHomeOverride: string | undefined,
  sqliteHomeOverride: string | undefined,
  notifyTempContractRaw: string | null,
  preLaunchOptions: {
    notifyTempContract: NotifyTempContract;
    enableNotifyFallbackAuthority: boolean;
    worktreeDirty: boolean;
  },
  launchPolicy: CodexLaunchPolicy = "direct",
  detachedPreflight?: DetachedPreflightAvailable,
  projectLocalCodexHomeForCleanup?: string,
  runtimeCodexHomeForCleanup?: string,
  runtimeContext?: MadmaxWorktreeRuntimeContext,
): Promise<{ postLaunchHandledExternally: boolean }> {
  void preLaunchOptions;
  const launchArgs = injectModelInstructionsBypassArgs(
    cwd,
    args,
    process.env,
    sessionModelInstructionsPath(cwd, sessionId),
  );
  const nativeWindows = isNativeWindows();
  const omxBin = resolveOmxCliEntryPath({ argv1: process.argv[1], cwd, env: process.env });
  if (!omxBin) {
    throw new Error("Unable to resolve OMX launcher path for tmux HUD bootstrap");
  }
  const runtimeEnvOverlay = buildMadmaxWorktreeRuntimeEnvOverlay(runtimeContext);
  const omxRootOverride = runtimeContext?.omxRoot ?? resolveOmxRootForLaunch(cwd, process.env);
  const currentPaneId = process.env.TMUX_PANE;
  const hudRuntimeRoot: HudRuntimeRootForLaunch = runtimeContext
    ? { omxRoot: runtimeContext.omxRoot, rootSource: 'omx-root-env' }
    : resolveHudRuntimeRootForLaunch(cwd, process.env);
  const hudRuntimeEnv = {
    ...buildHudRuntimeEnv({
      sessionId,
      leaderPaneId: currentPaneId,
      ...hudRuntimeRoot,
    }).env,
    ...runtimeEnvOverlay,
  };
  const hudEnvArgs = Object.entries(hudRuntimeEnv).map(([key, value]) => `${key}=${value}`);
  const hudCmd = nativeWindows
    ? buildWindowsPromptCommand("node", [omxBin, "hud", "--watch"])
    : buildTmuxPaneCommand("env", [...hudEnvArgs, "node", omxBin, "hud", "--watch"]);
  const inheritLeaderFlags = process.env[TEAM_INHERIT_LEADER_FLAGS_ENV] !== "0";
  const inheritedWorkerLaunchArgs = inheritLeaderFlags
    ? collectInheritableTeamWorkerArgsShared(launchArgs)
    : [];
  const inheritedWorkerModel = parseTeamWorkerLaunchArgs(inheritedWorkerLaunchArgs).modelOverride ?? undefined;
  const workerLaunchArgs = resolveTeamWorkerLaunchArgsEnv(
    process.env[TEAM_WORKER_LAUNCH_ARGS_ENV],
    launchArgs,
    inheritLeaderFlags,
    workerDefaultModel,
  );
  const codexBaseEnv = prependOmxRuntimeCommandShimToEnv(
    cwd,
    {
      ...stripHermesMcpBridgeEnv(process.env),
      ...(codexHomeOverride ? { CODEX_HOME: codexHomeOverride } : {}),
      ...(sqliteHomeOverride ? { [CODEX_SQLITE_HOME_ENV]: sqliteHomeOverride } : {}),
      ...(omxRootOverride ? { OMX_ROOT: omxRootOverride } : {}),
      ...runtimeEnvOverlay,
    },
    omxBin,
  );
  const codexEnvWithSession = {
    ...codexBaseEnv,
    OMX_CODEX_LAUNCH_ID: randomUUID(),
    ...buildHudRuntimeEnv({ sessionId }).env,
  };
  const codexEnv = workerLaunchArgs
    ? {
        ...codexEnvWithSession,
        [TEAM_WORKER_LAUNCH_ARGS_ENV]: workerLaunchArgs,
        ...(inheritedWorkerModel ? { [TEAM_WORKER_INHERITED_MODEL_ENV]: inheritedWorkerModel } : {}),
      }
    : codexEnvWithSession;
  const codexEnvWithNotify = notifyTempContractRaw
    ? { ...codexEnv, [OMX_NOTIFY_TEMP_CONTRACT_ENV]: notifyTempContractRaw }
    : codexEnv;
  const runtimeHookEnv = { ...process.env, ...runtimeEnvOverlay };


  if (isCodexVersionRequest(launchArgs)) {
    runCodexBlocking(cwd, launchArgs, codexEnvWithNotify);
    return { postLaunchHandledExternally: false };
  }

  if (launchPolicy === "inside-tmux") {
    // Already in tmux: launch codex in current pane, HUD in bottom split
    const currentWindowPanes = currentPaneId ? listCurrentWindowPanes(undefined, currentPaneId) : [];
    reapDeadHudPanes(currentWindowPanes, {
      killPane: (paneId) => {
        try {
          return killSharedTmuxPane(paneId);
        } catch (err) {
          logCliOperationFailure(err);
          return false;
        }
      },
    });

    const staleHudPaneIds = currentPaneId
      ? listHudWatchPaneIdsInCurrentWindow(currentPaneId, { sessionId, leaderPaneId: currentPaneId })
      : [];

    let hudPaneId: string | null = null;
    const [keeperHudPaneId, ...duplicateHudPaneIds] = staleHudPaneIds;
    for (const paneId of duplicateHudPaneIds) {
      killTmuxPane(paneId);
    }

    if (keeperHudPaneId) {
      hudPaneId = keeperHudPaneId;
      try {
        resizeTmuxPane(hudPaneId, HUD_TMUX_HEIGHT_LINES);
        registerInsideTmuxHudResizeHook({
          hudPaneId,
          currentPaneId,
          cwd,
          sessionId,
          omxRootOverride,
          baseEnv: runtimeHookEnv,
        });
      } catch (err) {
        logCliOperationFailure(err);
      }
    } else if (
      isExistingTmuxWindowTooCrampedForLaunchHud(
        readCurrentWindowSize(undefined, currentPaneId).height,
      )
    ) {
      // Existing tmux window is height-constrained: forcing a launch-time HUD
      // split here would steal rows from the Codex TUI and make the
      // transcript/input area unreadable. Skip the split at launch; the
      // prompt-submit reconcile path can add the HUD later when there is room.
      // (closes #2754)
      hudPaneId = null;
    } else {
      try {
        hudPaneId = createHudWatchPane(cwd, hudCmd, {
          heightLines: HUD_TMUX_HEIGHT_LINES,
          targetPaneId: currentPaneId,
        });
        registerInsideTmuxHudResizeHook({
          hudPaneId,
          currentPaneId,
          cwd,
          sessionId,
          omxRootOverride,
          baseEnv: runtimeHookEnv,
        });
      } catch (err) {
        logCliOperationFailure(err);
        // HUD split failed, continue without it
      }
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
      if (currentPaneId) {
        unregisterHudResizeHook(currentPaneId);
      }
      const cleanupPaneIds = buildHudPaneCleanupTargets(
        listHudWatchPaneIdsInCurrentWindow(currentPaneId, { sessionId, leaderPaneId: currentPaneId }),
        hudPaneId,
        currentPaneId,
      );
      for (const paneId of cleanupPaneIds) {
        killTmuxPane(paneId);
      }
    }
    return { postLaunchHandledExternally: false };
  } else if (launchPolicy === "direct") {
    // Detached HUD sessions require tmux. Skip the bootstrap entirely when the
    // binary is unavailable so direct launches do not emit noisy ENOENT logs.
    runCodexBlocking(cwd, launchArgs, codexEnvWithNotify);
    return { postLaunchHandledExternally: false };
  } else {
    if (!detachedPreflight) {
      throw new DetachedLaunchSafetyError("establishment", new Error("detached launch requires a frozen available preflight"), { transitions: ["D0"], rollback: { attempted: [], failures: [] } });
    }
    const codexCmd = buildTmuxPaneCommand("codex", launchArgs);
    const detachedWindowsCodexCmd = nativeWindows
      ? buildWindowsDetachedChildCommand("codex", launchArgs)
      : null;
    const sessionName = buildDetachedTmuxSessionName(cwd, sessionId);
    const contextKey = runtimeContext?.madmaxDetachedContext ?? process.env[OMX_MADMAX_DETACHED_CONTEXT_ENV]?.trim();
    const runsRoot = resolveMadmaxRunsRoot(process.env);
    const detachedLaunchNonce = randomUUID();
    const releaseMarkerPath = join(
      omxRoot(cwd),
      "runtime",
      "detached-release",
      `${sessionId}.${detachedLaunchNonce}.release`,
    );
    let detachedParentEnvFilePath: string | undefined;
    let detachedLeaderPaneId: string | null = null;
    let detachedLeaderPid: number | null = null;

    let attachStep: DetachedSessionTmuxStep | null = null;

    const launchDetachedSession = async (): Promise<{ postLaunchHandledExternally: boolean }> => {
      let createdSession = false;
      const bootstrapLeader = async (): Promise<void> => {
        if (!nativeWindows) detachedParentEnvFilePath = writeDetachedSessionParentEnvFile(cwd, sessionId, codexEnvWithNotify);
        const bootstrapSteps = buildDetachedSessionBootstrapSteps(
          sessionName, cwd, nativeWindows && detachedWindowsCodexCmd ? detachedWindowsCodexCmd : codexCmd,
          hudCmd, workerLaunchArgs, codexHomeOverride, notifyTempContractRaw, nativeWindows, sessionId,
          projectLocalCodexHomeForCleanup, runtimeCodexHomeForCleanup, omxRootOverride, codexEnvWithNotify,
          sqliteHomeOverride, detachedParentEnvFilePath, inheritedWorkerModel, releaseMarkerPath,
          omxBin,
          {
            ...(preLaunchOptions.notifyTempContract.active ? { notifyTempContract: preLaunchOptions.notifyTempContract } : {}),
            enableNotifyFallbackAuthority: preLaunchOptions.enableNotifyFallbackAuthority,
            worktreeDirty: preLaunchOptions.worktreeDirty,
          },
        );
        for (const step of bootstrapSteps) {
          let output: string;
          try {
            output = execTmuxFileSync(step.args, { stdio: "pipe", encoding: "utf-8" });
          } catch (error) {
            throw new DetachedLaunchSafetyError(step.name === "new-session" ? "inert-session" : "pane-id", error, detachedPreflight.report);
          }
          if (step.name === "new-session") {
            createdSession = true;
            const leaderPaneId = parsePaneIdFromTmuxOutput(output || "");
            if (!leaderPaneId) throw new DetachedLaunchSafetyError("pane-id", new Error("detached session did not report a leader pane id"), detachedPreflight.report);
            detachedLeaderPaneId = leaderPaneId;
            setDetachedTmuxSessionHistoryLimit(sessionName, leaderPaneId);
          }
          if (step.name === "split-and-capture-hud-pane") {
            const hudPaneId = parsePaneIdFromTmuxOutput(output || "");
            const hookWindowIndex = hudPaneId ? detectDetachedSessionWindowIndex(sessionName) : null;
            for (const finalizeStep of buildDetachedSessionFinalizeSteps(sessionName, hudPaneId, hookWindowIndex, process.env.OMX_MOUSE !== "0", nativeWindows, detachedPreflight.shouldAttach, detachedLeaderPaneId)) {
              if (finalizeStep.name === "attach-session") { attachStep = finalizeStep; continue; }
              if (finalizeStep.name === "sanitize-copy-mode-style") { try { mitigateCopyModeUnderlineArtifacts(sessionName); } catch (error) { logCliOperationFailure(error); } continue; }
              try { execTmuxFileSync(finalizeStep.args, { stdio: "ignore" }); } catch (error) { logCliOperationFailure(error); continue; }
              if (finalizeStep.name === "reconcile-hud-resize") registerDetachedHudLayoutReconcileHook({ hudPaneId, detachedLeaderPaneId, cwd, sessionId, omxBin, omxRootOverride, baseEnv: runtimeHookEnv });
            }
          }
        }
        return undefined;
      };
      await executeDetachedLaunchStateMachine(
        { preflight: detachedPreflight },
        {
          establish: bootstrapLeader,
          complete: async () => {
            const readyDeadline = Date.now() + 30_000;
            while (true) {
              const report = readDetachedLeaderReport(releaseMarkerPath);
              if (report?.nonce === detachedLaunchNonce && report.sessionId === sessionId && report.sessionName === sessionName && report.paneId === detachedLeaderPaneId && report.leaderPid && report.kind === "ready") {
                detachedLeaderPid = report.leaderPid;
                return { kind: "success" };
              }
              if (report?.nonce === detachedLaunchNonce && report.sessionId === sessionId && report.sessionName === sessionName && report.leaderPid && report.kind === "failed") {
                detachedLeaderPid = report.leaderPid;
                return { kind: "failure", operation: "session-instructions", error: new Error(report.error || "detached leader setup failed") };
              }
              if (Date.now() >= readyDeadline) return { kind: "failure", operation: "session-instructions", error: new Error("detached leader readiness timed out") };
              blockMs(20);
            }
          },
          createInertSession: async () => {
            const report = readDetachedLeaderReport(releaseMarkerPath);
            if (report?.kind !== "ready" || report.nonce !== detachedLaunchNonce || report.sessionId !== sessionId || report.sessionName !== sessionName || report.leaderPid !== detachedLeaderPid) {
              throw new Error("detached ready report does not bind the inert session");
            }
            return sessionName;
          },
          capturePane: async () => {
            const report = readDetachedLeaderReport(releaseMarkerPath);
            if (!detachedLeaderPaneId || report?.kind !== "ready" || report.paneId !== detachedLeaderPaneId || report.leaderPid !== detachedLeaderPid) {
              throw new Error("detached ready report does not bind the leader pane");
            }
            return detachedLeaderPaneId;
          },
          updateNameMetadata: async () => {
            const state = await readSessionState(cwd);
            if (state?.session_id !== sessionId || state.tmux_session_name !== sessionName) {
              throw new Error("detached session-name metadata was not committed by the leader");
            }
            return "committed-released";
          },
          updatePaneMetadata: async (_binding, pane) => {
            const state = await readSessionState(cwd);
            if (state?.session_id !== sessionId || state.tmux_pane_id !== pane) {
              throw new Error("detached pane metadata was not committed by the leader");
            }
            return "committed-released";
          },
          publishActiveRecord: async () => {
            const activeRecordPath = contextKey ? madmaxDetachedActiveRecordPath(runsRoot, contextKey) : join(omxRoot(cwd), "state", "detached-active-record.json");
            const record = readMadmaxDetachedActiveRecord(activeRecordPath);
            if (!record || record.launch_nonce !== detachedLaunchNonce || record.leader_pid !== detachedLeaderPid || record.session_id !== sessionId || record.tmux_session_name !== sessionName || record.tmux_pane_id !== detachedLeaderPaneId) throw new Error("detached active record does not bind the ready leader");
            const bytes = readFileSync(activeRecordPath, "utf-8");
            return { bytes, digest: createHash("sha256").update(bytes).digest("hex"), nonce: detachedLaunchNonce };
          },
          finalizeSetupFailure: async () => {},
          releaseBarrier: async () => {
            if (!detachedLeaderPid) throw new Error("detached leader PID missing before release");
            publishDetachedReleaseMarker(releaseMarkerPath, detachedLaunchNonce, sessionId, sessionName, detachedLeaderPid);
          },
          abortAndAwaitFinalization: async () => {
            // The leader has the retained binding. Publishing abort is the only
            // outer action permitted after a D9 write failure; a mismatched or
            // missing report leaves every artifact and the tmux session intact.
            if (!detachedLeaderPid) return { acknowledged: false };
            const current = readDetachedLeaderReport(releaseMarkerPath);
            if (current?.nonce === detachedLaunchNonce && current.sessionId === sessionId &&
              current.sessionName === sessionName && current.leaderPid === detachedLeaderPid &&
              current.finalized === true && (current.kind === "failed" || current.kind === "terminal")) return {
                acknowledged: true,
                nonce: current.nonce,
                sessionId: current.sessionId,
                sessionName: current.sessionName,
                leaderPid: current.leaderPid,
                kind: current.kind,
              };
            publishDetachedAbortMarker(releaseMarkerPath, detachedLaunchNonce, sessionId, sessionName, detachedLeaderPid);
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
              const report = readDetachedLeaderReport(releaseMarkerPath);
              if (report?.nonce === detachedLaunchNonce && report.sessionId === sessionId &&
                report.sessionName === sessionName && report.leaderPid === detachedLeaderPid &&
                report.finalized === true && (report.kind === "failed" || report.kind === "terminal")) return {
                  acknowledged: true,
                  nonce: report.nonce,
                  sessionId: report.sessionId,
                  sessionName: report.sessionName,
                  leaderPid: report.leaderPid,
                  kind: report.kind,
                };
              blockMs(20);
            }
            return { acknowledged: false };
          },
          attachOrReturn: async () => { if (attachStep) execTmuxFileSync(attachStep.args, { stdio: "inherit" }); },
          rollback: async (_ownedRecord, report) => {
            const attempt = async (step: DetachedRollbackStep, operation: () => Promise<void> | void): Promise<void> => {
              report.rollback.attempted.push(step);
              try { await operation(); } catch (error) { report.rollback.failures.push({ step, status: "failed", code: detachedFailureCode(error) }); }
            };
            await attempt("parent-env", async () => { if (detachedParentEnvFilePath) await rm(detachedParentEnvFilePath, { force: true }); });
            await attempt("runtime-codex-home", () => cleanupRuntimeCodexHome(runtimeCodexHomeForCleanup, projectLocalCodexHomeForCleanup));
            await attempt("rollback", () => { rmSync(releaseMarkerPath, { force: true }); rmSync(`${releaseMarkerPath}.release`, { force: true }); rmSync(`${releaseMarkerPath}.abort`, { force: true }); });
            if (createdSession) {
              for (const step of buildDetachedSessionRollbackSteps(sessionName, null, null, null)) {
                await attempt(`session:${step.name}`, () => { execTmuxFileSync(step.args, { stdio: "ignore" }); });
              }
            }
          },
        },
      );
      return { postLaunchHandledExternally: true };
    };

    if (isMadmaxDetachedGuardEnabled(process.env) && contextKey) {
      return await withMadmaxDetachedContextLock(runsRoot, contextKey, launchDetachedSession);
    }
    return await launchDetachedSession();
  }
}

function listHudWatchPaneIdsInCurrentWindow(
  currentPaneId?: string,
  owner: { sessionId?: string; leaderPaneId?: string } = {},
): string[] {
  try {
    return listCurrentWindowHudPaneIds(currentPaneId, undefined, owner);
  } catch (err) {
    logCliOperationFailure(err);
    return [];
  }
}

/**
 * Decide whether an existing tmux window is too short to spend rows on a
 * launch-time HUD split. When the window height is unknown (null), we keep the
 * default behavior and create the HUD. (closes #2754)
 */
export function isExistingTmuxWindowTooCrampedForLaunchHud(
  windowHeight: number | null | undefined,
  minWindowHeight: number = HUD_TMUX_MIN_LAUNCH_WINDOW_HEIGHT_LINES,
): boolean {
  return isTmuxWindowTooCrampedForHudSplit(windowHeight, minWindowHeight);
}

function createHudWatchPane(
  cwd: string,
  hudCmd: string,
  options: { heightLines?: number; targetPaneId?: string } = {},
): string | null {
  return createSharedHudWatchPane(cwd, hudCmd, {
    heightLines: options.heightLines ?? HUD_TMUX_HEIGHT_LINES,
    targetPaneId: options.targetPaneId,
  });
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

export function isCodexVersionRequest(args: string[]): boolean {
  const { omxArgs } = splitOmxArgsAtEndOfOptions(args);
  return omxArgs.some((arg) => CODEX_VERSION_FLAGS.has(arg));
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
 * Build a Windows child command for detached ownership. Unlike the interactive
 * prompt wrapper, this process exits as soon as Codex does so the outer barrier
 * can run its post-launch cleanup.
 */
export function buildWindowsDetachedChildCommand(
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
    invocation,
    "exit $LASTEXITCODE",
  ].join("; ");
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(wrappedCommand)}`;
}

/**
 * Wrap a command for tmux pane execution while preserving the tmux pane cwd.
 * tmux already starts the pane at `-c <cwd>`; using a login shell here can
 * reset that cwd back to the shell's startup directory on some setups.
 *
 * Do not source user shell rc files by default. In issue #2282 the surviving
 * OOM signature was thousands of bash processes, not MCP node children;
 * non-interactive tmux panes sourcing ~/.bashrc can recursively trigger user
 * automation and fan out before Codex starts. Users who need legacy PATH setup
 * can opt in with OMX_TMUX_SOURCE_SHELL_RC=1.
 */
export function shouldSourceTmuxPaneShellRc(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return String(env.OMX_TMUX_SOURCE_SHELL_RC ?? "").trim() === "1";
}

export function buildTmuxPaneCommand(
  command: string,
  args: string[],
  shellPath: string | undefined = process.env.SHELL,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const bareCmd = buildTmuxShellCommand(command, args);
  let rcSource = "";
  if (shouldSourceTmuxPaneShellRc(env)) {
    if (shellPath && /\/zsh$/i.test(shellPath)) {
      rcSource = "if [ -f ~/.zshrc ]; then source ~/.zshrc; fi; ";
    } else if (shellPath && /\/bash$/i.test(shellPath)) {
      rcSource = "if [ -f ~/.bashrc ]; then source ~/.bashrc; fi; ";
    }
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



interface DetachedLeaderPayload {
  cwd: string;
  sessionName: string;
  sessionId: string;
  codexCmd: string;
  codexHomeOverride?: string;
  projectLocalCodexHomeForCleanup?: string;
  runtimeCodexHomeForCleanup?: string;
  parentEnv?: Record<string, string>;
  readyPath?: string;
  preLaunchOptions: DetachedLeaderPreLaunchOptions;
}

function decodeDetachedLeaderPayload(encoded: string | undefined): DetachedLeaderPayload {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("invalid detached leader payload");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { throw new Error("invalid detached leader payload"); }
  if (!value || typeof value !== "object") throw new Error("invalid detached leader payload");
  const payload = value as Record<string, unknown>;
  const options = payload.preLaunchOptions;
  if (typeof payload.cwd !== "string" || typeof payload.sessionName !== "string" || typeof payload.sessionId !== "string" ||
    typeof payload.codexCmd !== "string" || !options || typeof options !== "object" ||
    typeof (options as Record<string, unknown>).enableNotifyFallbackAuthority !== "boolean" ||
    typeof (options as Record<string, unknown>).worktreeDirty !== "boolean") throw new Error("invalid detached leader payload");
  const notifyTempContract = (options as Record<string, unknown>).notifyTempContract;
  if (notifyTempContract !== undefined && (!notifyTempContract || typeof notifyTempContract !== "object")) throw new Error("invalid detached leader payload");
  const parentEnv = payload.parentEnv;
  if (parentEnv !== undefined && (!parentEnv || typeof parentEnv !== "object" ||
    Object.entries(parentEnv).some(([key, value]) => !SHELL_ENV_NAME_PATTERN.test(key) || DETACHED_SESSION_PANE_ENV_KEYS.has(key) || typeof value !== "string" || value.includes("\0")))) {
    throw new Error("invalid detached leader parent environment");
  }
  return {
    cwd: payload.cwd, sessionName: payload.sessionName, sessionId: payload.sessionId, codexCmd: payload.codexCmd,
    ...(typeof payload.codexHomeOverride === "string" ? { codexHomeOverride: payload.codexHomeOverride } : {}),
    ...(typeof payload.projectLocalCodexHomeForCleanup === "string" ? { projectLocalCodexHomeForCleanup: payload.projectLocalCodexHomeForCleanup } : {}),
    ...(typeof payload.runtimeCodexHomeForCleanup === "string" ? { runtimeCodexHomeForCleanup: payload.runtimeCodexHomeForCleanup } : {}),
    ...(parentEnv ? { parentEnv: parentEnv as Record<string, string> } : {}),
    ...(typeof payload.readyPath === "string" ? { readyPath: payload.readyPath } : {}),
    preLaunchOptions: {
      ...(notifyTempContract ? { notifyTempContract: notifyTempContract as NotifyTempContract } : {}),
      enableNotifyFallbackAuthority: (options as DetachedLeaderPreLaunchOptions).enableNotifyFallbackAuthority,
      worktreeDirty: (options as DetachedLeaderPreLaunchOptions).worktreeDirty,
    },
  };
}

async function runDetachedSessionLeader(payload: DetachedLeaderPayload): Promise<void> {
  for (const [key, value] of Object.entries(payload.parentEnv ?? {})) process.env[key] = value;
  const established = await establishPreLaunchBinding(payload.cwd, payload.sessionId);
  const binding = established.binding;
  let ownedRecord: DetachedActiveRecordOwnership | undefined;
  const nonce = payload.readyPath?.split(".").at(-2) || payload.sessionId;
  const contextKey = process.env[OMX_MADMAX_DETACHED_CONTEXT_ENV]?.trim();
  const activeRecordPath = contextKey
    ? madmaxDetachedActiveRecordPath(resolveMadmaxRunsRoot(process.env), contextKey)
    : join(omxRoot(payload.cwd), "state", "detached-active-record.json");
  let externalInterrupt: NodeJS.Signals | undefined;

  try {
    const completion = await completePreLaunchSetup(
      payload.cwd,
      payload.sessionId,
      payload.preLaunchOptions.notifyTempContract,
      payload.codexHomeOverride,
      payload.preLaunchOptions.enableNotifyFallbackAuthority,
      payload.preLaunchOptions.worktreeDirty,
    );
    if (completion.kind === "failure") {
      const finalization = await finalizeBoundOnce(binding, "setup-failure", payload.cwd);
      if (!finalization.finalized) throw new Error(`bound setup finalization denied: ${finalization.cleanup.comparison?.reason ?? "unknown reason"}`);
      throw completion.error;
    }
    const pane = process.env.TMUX_PANE;
    if (!pane) throw new Error("detached leader has no tmux pane identity");
    const name = await updateDetachedSessionMetadata(binding, { tmuxSessionName: payload.sessionName });
    const paneUpdate = await updateDetachedSessionMetadata(binding, { tmuxPaneId: pane });
    if (name.kind !== "committed-released" || paneUpdate.kind !== "committed-released") throw new Error("detached leader metadata update denied");
    const record: MadmaxDetachedActiveRecord = {
      version: 1, context_key: contextKey ?? payload.sessionId!, created_at: new Date().toISOString(),
      source_cwd: payload.cwd, argv: [payload.codexCmd], run_dir: process.env.OMX_ROOT ?? payload.cwd,
      tmux_session_name: payload.sessionName, session_id: payload.sessionId, tmux_pane_id: pane,
      launch_nonce: nonce, leader_pid: process.pid, base_state_root: binding.context.baseStateDir,
      lifecycle_phase: "ready",
    };
    const runtimeBinding = queryMadmaxDetachedRuntimeBinding(record);
    ownedRecord = writeMadmaxDetachedActiveRecord(activeRecordPath, {
      ...record,
      ...(runtimeBinding ? {
        tmux_internal_session_id: runtimeBinding.internalSessionId,
        tmux_session_created: runtimeBinding.sessionCreated,
        tmux_pane_pid: runtimeBinding.panePid,
      } : {}),
    });
    if (payload.readyPath) {
      writeDetachedLeaderReport(payload.readyPath, { version: 1, kind: "ready", nonce, sessionId: payload.sessionId, sessionName: payload.sessionName, paneId: pane, leaderPid: process.pid });
      const releasePath = `${payload.readyPath}.release`;
      const abortPath = `${payload.readyPath}.abort`;
      const releaseDeadline = Date.now() + 30_000;
      let interrupted: NodeJS.Signals | undefined;
      const interrupt = (signal: NodeJS.Signals): void => { interrupted = signal; };
      process.once("SIGINT", () => interrupt("SIGINT"));
      process.once("SIGTERM", () => interrupt("SIGTERM"));
      process.once("SIGHUP", () => interrupt("SIGHUP"));
      while (true) {
        if (interrupted) throw new Error(`detached leader interrupted before release: ${interrupted}`);
        const release = readDetachedLeaderReport(releasePath);
        if (release?.kind === "release" && release.nonce === nonce && release.sessionId === payload.sessionId && release.sessionName === payload.sessionName && release.leaderPid === process.pid) break;
        const abort = readDetachedLeaderReport(abortPath);
        if (abort?.kind === "abort" && abort.nonce === nonce && abort.sessionId === payload.sessionId && abort.sessionName === payload.sessionName && abort.leaderPid === process.pid) {
          throw new Error("detached launch aborted before release");
        }
        if (Date.now() >= releaseDeadline) throw new Error("detached leader release timed out");
        blockMs(20);
      }
      rmSync(releasePath, { force: true });
      rmSync(abortPath, { force: true });
    }
    const child = spawn(process.platform === "win32" ? "powershell.exe" : "/bin/sh", process.platform === "win32" ? ["-NoProfile", "-Command", payload.codexCmd] : ["-c", payload.codexCmd], {
      cwd: payload.cwd,
      stdio: "inherit",
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
    let escalation: NodeJS.Timeout | undefined;
    const signalChildTree = (signal: NodeJS.Signals, force = false): void => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore" });
        else process.kill(-child.pid, signal);
      } catch {}
    };
    const forward = (signal: NodeJS.Signals): void => {
      externalInterrupt ??= signal;
      signalChildTree(signal);
      if (!escalation) { escalation = setTimeout(() => signalChildTree("SIGKILL", true), 5_000); escalation.unref(); }
    };
    process.once("SIGINT", () => forward("SIGINT"));
    process.once("SIGTERM", () => forward("SIGTERM"));
    process.once("SIGHUP", () => forward("SIGHUP"));

    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveChild, rejectChild) => {
      child.once("error", rejectChild);
      child.once("exit", (code, signal) => resolveChild({ code, signal }));
    });
    if (escalation) clearTimeout(escalation);
    if (process.platform !== "win32" && child.pid) {
      const waitForGroupExit = async (deadline: number): Promise<boolean> => {
        while (Date.now() < deadline) {
          try {
            process.kill(-child.pid!, 0);
            await new Promise((resolveWait) => setTimeout(resolveWait, 20));
          } catch {
            return true;
          }
        }
        return false;
      };
      let groupGone = await waitForGroupExit(Date.now() + 5_000);
      if (!groupGone) {
        signalChildTree("SIGKILL", true);
        groupGone = await waitForGroupExit(Date.now() + 5_000);
      }
      if (!groupGone) throw new Error("detached child process group did not disappear after forced termination");
    }
    const signalExitCodes: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143, SIGKILL: 137 };
    process.exitCode = externalInterrupt
      ? signalExitCodes[externalInterrupt] ?? 1
      : outcome.code ?? (outcome.signal ? signalExitCodes[outcome.signal] ?? 1 : 1);
    await postLaunch(payload.cwd, payload.sessionId, binding, payload.codexHomeOverride, payload.preLaunchOptions.enableNotifyFallbackAuthority, payload.projectLocalCodexHomeForCleanup);
    if (payload.readyPath) writeDetachedLeaderReport(payload.readyPath, {
      version: 1, kind: "terminal", nonce, sessionId: payload.sessionId, sessionName: payload.sessionName,
      paneId: pane, leaderPid: process.pid, finalized: true,
    });
    await cleanupRuntimeCodexHome(payload.runtimeCodexHomeForCleanup, payload.projectLocalCodexHomeForCleanup);
    if (ownedRecord) {
      const bytes = readFileSync(activeRecordPath, "utf-8");
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (bytes === ownedRecord.bytes && digest === ownedRecord.digest) rmSync(activeRecordPath, { force: true });
    }
  } catch (error) {
    let failure: unknown = error;
    let finalized = false;
    try {
      await postLaunch(payload.cwd, payload.sessionId, binding, payload.codexHomeOverride, payload.preLaunchOptions.enableNotifyFallbackAuthority, payload.projectLocalCodexHomeForCleanup);
      finalized = true;
      await cleanupRuntimeCodexHome(payload.runtimeCodexHomeForCleanup, payload.projectLocalCodexHomeForCleanup);
    } catch (lifecycleError) {
      failure = new AggregateError([error, lifecycleError], "detached leader failure finalization did not complete");
    }
    if (finalized && ownedRecord) {
      try {
        const bytes = readFileSync(activeRecordPath, "utf-8");
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (bytes === ownedRecord.bytes && digest === ownedRecord.digest) rmSync(activeRecordPath, { force: true });
      } catch {}
    }
    if (payload.readyPath) writeDetachedLeaderReport(payload.readyPath, {
      version: 1, kind: "failed", nonce, sessionId: payload.sessionId, sessionName: payload.sessionName,
      leaderPid: process.pid, finalized, error: failure instanceof Error ? failure.message : String(failure),
    });
    throw failure;
  } finally {
    await closeLaunchSessionBindingOnce(binding);
  }
}

/**
 * postLaunch: Clean up after Codex exits.
 * Each step is independently fault-tolerant (try/catch per step).
 */
export async function postLaunch(
  cwd: string,
  sessionId: string,
  binding: LaunchSessionBinding,
  codexHomeOverride?: string,
  enableNotifyFallbackAuthority: boolean = false,
  projectLocalCodexHomeForCleanup?: string,
): Promise<void> {
  const sessionStartedAt: string | undefined = binding.startedAt;
  // Pointer authority is consumed before any terminal cleanup. A denied or
  // unproven binding must leave every cleanup target untouched.
  let terminalError: unknown;
  try {
    const finalization = await finalizeBoundOnce(binding, "post-launch", cwd);
    if (!finalization.finalized) terminalError = new Error(`bound session finalization denied: ${finalization.cleanup.comparison?.reason ?? "unknown reason"}`);
    const closeFailure = finalization.cleanup.capability.find((evidence) => evidence.status === "failed");
    if (closeFailure) terminalError = new Error(`bound session retained close failed: ${closeFailure.error?.message ?? "unknown error"}`);
  } catch (error) {
    terminalError = error;
  }
  if (terminalError) {
    // Denial diagnostics are complete; do not mutate ordinary lifecycle state.
    await closeLaunchSessionBindingOnce(binding);
    throw terminalError;
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

  // 0.5. Remove Codex transient TUI NUX counters from project-local config only.
  try {
    if (projectLocalCodexHomeForCleanup) {
      await cleanCodexModelAvailabilityNuxIfNeeded(
        join(projectLocalCodexHomeForCleanup, "config.toml"),
      );
    }
  } catch (err) {
    console.error(
      `[omx] postLaunch: project config transient NUX cleanup failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  // 1. Remove session-scoped model instructions file
  try {
    await removeSessionModelInstructionsFile(cwd, sessionId);
  } catch (err) {
    console.error(
      `[omx] postLaunch: model instructions cleanup failed: ${err instanceof Error ? err.message : err}`,
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
  const closeEvidence = await closeLaunchSessionBindingOnce(binding);
  if (closeEvidence.status === "failed") {
    throw new Error(`bound session retained close failed: ${closeEvidence.error?.message ?? "unknown error"}`);
  }
}

export async function runDetachedSessionPostLaunch(
  cwd: string,
  sessionId: string,
  projectLocalCodexHomeForCleanup?: string,
  runtimeCodexHomeForCleanup?: string,
  releaseMarkerPath?: string,
): Promise<void> {
  // The detached child is intentionally unbound: it must never perform parent
  // pointer finalization or cleanup after the release barrier. It still owns
  // every non-pointer terminal lifecycle responsibility.
  const failures: unknown[] = [];
  const strict = async (operation: () => Promise<unknown>): Promise<void> => {
    try { await operation(); } catch (error) { failures.push(error); }
  };

  await strict(() => reapPostLaunchOrphanedMcpProcesses());
  await strict(() => flushNotifyFallbackOnce(cwd, { sessionId }));
  await strict(() => stopNotifyFallbackWatcher(cwd));
  await strict(() => flushHookDerivedWatcherOnce(cwd));
  await strict(() => stopHookDerivedWatcher(cwd));
  if (projectLocalCodexHomeForCleanup) {
    await strict(() => cleanCodexModelAvailabilityNuxIfNeeded(join(projectLocalCodexHomeForCleanup, "config.toml")));
  }
  await strict(() => removeSessionModelInstructionsFile(cwd, sessionId));
  await strict(async () => {
    const { onSessionEnd } = await import("../wiki/lifecycle.js");
    onSessionEnd({ cwd, session_id: sessionId });
  });
  await strict(() => cleanupPostLaunchModeStateFiles(cwd, sessionId));
  await strict(async () => {
    const { notifyLifecycle } = await import("../notifications/index.js");
    await notifyLifecycle("session-end", {
      sessionId, projectPath: cwd, projectName: basename(cwd), reason: "session_exit",
    });
  });
  await strict(async () => {
    const { markOwnedTeamsLeaderSessionStopped } = await import("../team/state.js");
    await markOwnedTeamsLeaderSessionStopped(cwd, sessionId);
  });
  await strict(() => emitNativeHookEvent(cwd, "session-end", {
    session_id: sessionId,
    context: buildNativeHookBaseContext(cwd, sessionId, "finished", {
      project_path: cwd, project_name: basename(cwd), reason: "session_exit", status: "finished",
    }),
  }));
  await strict(() => cleanupRuntimeCodexHome(runtimeCodexHomeForCleanup, projectLocalCodexHomeForCleanup));
  if (releaseMarkerPath) await strict(() => rm(releaseMarkerPath, { force: true }));
  if (failures.length > 0) throw new AggregateError(failures, "detached post-launch lifecycle cleanup failed");
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
  return join(omxRoot(cwd), "state", "notify-fallback.pid");
}

function hookDerivedWatcherPidPath(cwd: string): string {
  return join(omxRoot(cwd), "state", "hook-derived-watcher.pid");
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

export type NotifyFallbackReapResult =
  | "missing"
  | "invalid"
  | "identity_mismatch"
  | "recent_active"
  | "reaped"
  | "failed";

const DEFAULT_NOTIFY_FALLBACK_REAP_GRACE_MS = 5000;

function resolveNotifyFallbackReapGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.OMX_NOTIFY_FALLBACK_REAP_GRACE_MS || "", 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return DEFAULT_NOTIFY_FALLBACK_REAP_GRACE_MS;
}

function isWatcherRecordWithinReapGrace(
  record: WatcherPidRecord,
  nowMs = Date.now(),
  graceMs = resolveNotifyFallbackReapGraceMs(),
): boolean {
  if (graceMs <= 0 || !record.startedAt) return false;
  const startedMs = Date.parse(record.startedAt);
  if (!Number.isFinite(startedMs)) return false;
  const ageMs = nowMs - startedMs;
  return ageMs >= 0 && ageMs < graceMs;
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
    nowMs?: () => number;
    reapGraceMs?: number;
  } = {},
): Promise<NotifyFallbackReapResult> {
  const exists = deps.exists ?? existsSync;
  if (!exists(pidPath)) return "missing";

  const { readFile } = await import("fs/promises");
  const readFileImpl = deps.readFile ?? readFile;
  const tryKillPidImpl = deps.tryKillPid ?? tryKillPid;
  const hasErrnoCodeImpl = deps.hasErrnoCode ?? hasErrnoCode;
  const warn = deps.warn ?? console.warn;
  const isWatcherProcessImpl = deps.isWatcherProcess ?? isLikelyOmxWatcherProcess;

  try {
    const record = parseWatcherPidRecord(await readFileImpl(pidPath, "utf-8"));
    if (!record) return "invalid";
    if (!isWatcherProcessImpl(record.pid)) return "identity_mismatch";
    if (isWatcherRecordWithinReapGrace(
      record,
      deps.nowMs?.() ?? Date.now(),
      deps.reapGraceMs ?? resolveNotifyFallbackReapGraceMs(),
    )) {
      return "recent_active";
    }
    tryKillPidImpl(record.pid, "SIGTERM");
    return "reaped";
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
    return "failed";
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
  const reapResult = await reapStaleNotifyFallbackWatcher(pidPath);
  if (reapResult === "recent_active") return;

  if (!shouldEnableNotifyFallbackWatcher(process.env, process.platform)) return;

  const pkgRoot = getPackageRoot();
  const watcherScript = resolveNotifyFallbackWatcherScript(pkgRoot);
  const notifyScript = resolveNotifyHookScript(pkgRoot);
  if (!existsSync(watcherScript) || !existsSync(notifyScript)) return;

  await mkdir(join(omxRoot(cwd), "state"), { recursive: true }).catch(
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
    omxRootOverride: resolveOmxRootForLaunch(cwd, process.env),
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

  await mkdir(join(omxRoot(cwd), "state"), { recursive: true }).catch(
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
      timeout: 45_000,
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

// Canonicalize a path for comparing a registry `source_cwd` against the current
// working directory. `process.cwd()` resolves symlinks (e.g. macOS `/var` ->
// `/private/var`), so registry values must be canonicalized the same way or the
// run-dir fallback never matches. Falls back to `resolve` when the path is
// missing (realpathSync requires an existing target).
function canonicalizePathForRunDirMatch(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}


async function listHookVisibleRunDirStateRefs(cwd: string): Promise<ModeStateFileRef[]> {
  const runsRoot = resolveMadmaxRunsRoot(process.env);
  const registryPath = join(runsRoot, "registry.jsonl");
  const runDirs = new Set<string>();
  const canonicalCwd = canonicalizePathForRunDirMatch(cwd);
  const canonicalRunsRoot = resolve(runsRoot);

  const addRecord = (raw: unknown): void => {
    if (!raw || typeof raw !== "object") return;
    const record = raw as Record<string, unknown>;
    const sourceCwd = typeof record.source_cwd === "string" ? record.source_cwd.trim() : "";
    const worktreeCwd = typeof record.worktree_cwd === "string" ? record.worktree_cwd.trim() : "";
    const runDir = typeof record.run_dir === "string"
      ? record.run_dir.trim()
      : typeof record.cwd === "string"
        ? record.cwd.trim()
        : "";
    if (!sourceCwd || !runDir) return;

    try {
      if (
        canonicalizePathForRunDirMatch(sourceCwd) !== canonicalCwd
        && (!worktreeCwd || canonicalizePathForRunDirMatch(worktreeCwd) !== canonicalCwd)
      ) return;
      const resolvedRunDir = resolve(runDir);
      if (
        resolvedRunDir !== canonicalRunsRoot
        && !resolvedRunDir.startsWith(`${canonicalRunsRoot}/`)
      ) return;
      runDirs.add(resolvedRunDir);
    } catch {
      return;
    }
  };

  try {
    const rawRegistry = await readFile(registryPath, "utf-8");
    for (const line of rawRegistry.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        addRecord(JSON.parse(trimmed));
      } catch {
        continue;
      }
    }
  } catch {}

  try {
    const activeDir = join(runsRoot, MADMAX_DETACHED_ACTIVE_DIR);
    const files = await readdir(activeDir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        addRecord(JSON.parse(await readFile(join(activeDir, file), "utf-8")));
      } catch {
        continue;
      }
    }
  } catch {}

  const refs: ModeStateFileRef[] = [];
  const seenPaths = new Set<string>();
  for (const runDir of runDirs) {
    const stateDir = join(runDir, ".omx", "state");
    let sessionId: string | undefined;
    try {
      const session = JSON.parse(await readFile(join(stateDir, "session.json"), "utf-8")) as Record<string, unknown>;
      if (typeof session.session_id === "string" && session.session_id.trim()) {
        sessionId = session.session_id.trim();
      }
    } catch {}

    const candidateDirs = sessionId ? [join(stateDir, "sessions", sessionId), stateDir] : [stateDir];
    for (const dir of candidateDirs) {
      const files = await readdir(dir).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith("-state.json") || file === "session.json") continue;
        const path = join(dir, file);
        if (seenPaths.has(path)) continue;
        seenPaths.add(path);
        refs.push({
          mode: file.slice(0, -"-state.json".length),
          path,
          scope: dir === stateDir ? "root" : "session",
        });
      }
    }
  }

  return refs.sort((a, b) => a.mode.localeCompare(b.mode));
}

interface AuthorizedRunStateSelection {
  refs: ModeStateFileRef[];
  sessionId: string;
  sessionDir: string;

  record: MadmaxDetachedActiveRecord;
}

function isCanonicalPathWithin(parent: string, child: string, allowEqual = false): boolean {
  const rel = relative(parent, child);
  if (rel === "") return allowEqual;
  return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

async function selectAuthorizedHookVisibleRunDirState(cwd: string): Promise<AuthorizedRunStateSelection | null> {
  const runsRoot = resolveMadmaxRunsRoot(process.env);
  const activeDir = join(runsRoot, MADMAX_DETACHED_ACTIVE_DIR);
  const canonicalCwd = canonicalizePathForRunDirMatch(cwd);
  let canonicalRunsRoot: string;
  try {
    canonicalRunsRoot = realpathSync(resolve(runsRoot));
  } catch {
    return null;
  }

  const candidates: Array<{ sessionDir: string; sessionId: string; record: MadmaxDetachedActiveRecord }> = [];

  const files = await readdir(activeDir).catch(() => [] as string[]);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const record = readMadmaxDetachedActiveRecord(join(activeDir, file));
    if (!record || file !== `${record.context_key}.json`) continue;
    if (!record.session_id || normalizeSessionId(record.session_id) !== record.session_id) continue;
    if (!hasMatchingMadmaxDetachedRuntimeBinding(record)) continue;
    if (
      canonicalizePathForRunDirMatch(record.source_cwd) !== canonicalCwd
      && (!record.worktree_cwd || canonicalizePathForRunDirMatch(record.worktree_cwd) !== canonicalCwd)
    ) continue;

    try {
      const canonicalRunDir = realpathSync(resolve(record.run_dir));
      if (!isCanonicalPathWithin(canonicalRunsRoot, canonicalRunDir)) {
        throw new Error("run directory escapes the authorized runs root");
      }
      const stateDir = realpathSync(join(canonicalRunDir, ".omx", "state"));
      if (!isCanonicalPathWithin(canonicalRunDir, stateDir)) {
        throw new Error("state directory escapes the authorized run directory");
      }
      const session = JSON.parse(await readFile(join(stateDir, "session.json"), "utf-8")) as Record<string, unknown>;
      if (session.session_id !== record.session_id) throw new Error("run session pointer changed");
      const sessionDir = realpathSync(join(stateDir, "sessions", record.session_id));
      if (!isCanonicalPathWithin(stateDir, sessionDir)) {
        throw new Error("session directory escapes the authorized state directory");
      }
      candidates.push({ sessionDir, sessionId: record.session_id, record });
    } catch (err) {
      throw new Error(`Refusing cancellation because detached run authority is invalid: ${record.run_dir}.`, { cause: err });
    }
  }

  if (candidates.length > 1) throw new Error("Refusing cancellation because multiple detached run authorities match.");
  if (candidates.length === 0) return null;
  const [{ sessionDir, sessionId, record }] = candidates;
  const refs: ModeStateFileRef[] = [];
  const stateFiles = await readdir(sessionDir).catch(() => [] as string[]);
  for (const file of stateFiles) {
    if (!file.endsWith("-state.json") || file === "session.json") continue;
    const path = join(sessionDir, file);
    try {
      const fileStat = lstatSync(path);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new Error(`Refusing cancellation through non-regular run state target: ${path}.`);
      }
      const canonicalFile = realpathSync(path);
      if (!isCanonicalPathWithin(sessionDir, canonicalFile)) {
        throw new Error(`Refusing cancellation outside authorized run session: ${path}.`);
      }
      refs.push({
        mode: file.slice(0, -"-state.json".length),
        path: canonicalFile,
        scope: "session",
      });
    } catch (err) {
      throw new Error(`Refusing cancellation because detached run state authority is invalid: ${path}.`, { cause: err });
    }
  }
  return { refs: refs.sort((a, b) => a.mode.localeCompare(b.mode)), sessionId, sessionDir, record };
}

function assertCancellationAuthorityPath(baseStateDir: string, authorityRoot: string): string {
  const resolvedBase = resolve(baseStateDir);
  const resolvedAuthority = resolve(authorityRoot);
  const baseStat = lstatSync(resolvedBase);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink() || realpathSync(resolvedBase) !== resolvedBase) {
    throw new Error(`Refusing cancellation through symlinked state authority root: ${baseStateDir}.`);
  }
  if (!isCanonicalPathWithin(resolvedBase, resolvedAuthority, true)) {
    throw new Error(`Refusing cancellation outside base state authority: ${authorityRoot}.`);
  }
  let current = resolvedBase;
  const rel = relative(resolvedBase, resolvedAuthority);
  for (const component of rel ? rel.split(/[\\/]+/) : []) {
    current = join(current, component);
    const componentStat = lstatSync(current);
    if (!componentStat.isDirectory() || componentStat.isSymbolicLink() || realpathSync(current) !== current) {
      throw new Error(`Refusing cancellation through symlinked authority component: ${current}.`);
    }
  }
  return resolvedAuthority;
}

function collectCancellationOwnerIds(baseStateDir: string, sessionId?: string): Set<string> {
  const ownerIds = new Set<string>();
  if (sessionId) ownerIds.add(sessionId);
  try {
    const pointer = JSON.parse(readFileSync(join(baseStateDir, "session.json"), "utf-8")) as Record<string, unknown>;
    for (const field of [
      "session_id",
      "native_session_id",
      "codex_session_id",
      "owner_omx_session_id",
      "owner_codex_session_id",
    ]) {
      const normalized = normalizeSessionId(pointer[field]);
      if (normalized) ownerIds.add(normalized);
    }
  } catch {}
  return ownerIds;
}

function assertCancellationOwnerMetadata(
  value: Record<string, unknown>,
  ownerIds: Set<string>,
  path: string,
): void {
  for (const ownerField of ["session_id", "owner_omx_session_id", "owner_codex_session_id"] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, ownerField)) continue;
    const owner = normalizeSessionId(value[ownerField]);
    if (!owner || !ownerIds.has(owner)) {
      throw new Error(`Refusing contradictory ${ownerField} in ${path}.`);
    }
  }
}

async function cancelModes(args: string[] = []): Promise<void> {

  const cwd = process.cwd();
  const nowIso = new Date().toISOString();
  if (args.length > 1 || args.some((arg) => arg !== "--force")) {
    const unsupported = args.find((arg) => arg !== "--force") ?? args[1] ?? "";
    throw new Error(unsupported === "--all"
      ? "omx cancel --all is not supported; broad workspace cancellation requires a separate command."
      : `Unknown cancel argument: ${unsupported}`);
  }
  const force = args.length === 1;
  try {
    const writableScope = await resolveWritableStateScope(cwd);
    const baseStateDir = getBaseStateDir(cwd);
    const expectedOwnerIds = collectCancellationOwnerIds(baseStateDir, writableScope.sessionId);
    const loadStates = async (
      refs: ModeStateFileRef[],
      authorityRoot: string,
      ownerIds: Set<string> = expectedOwnerIds,
    ) => {
      const loaded = new Map<
        string,
        {
          path: string;
          scope: "root" | "session";
          state: Record<string, unknown>;
          originalContent: string;
          dev: number;
          ino: number;
        }
      >();
      if (refs.length === 0) return loaded;
      const canonicalAuthorityRoot = assertCancellationAuthorityPath(
        authorityRoot === writableScope.stateDir ? baseStateDir : authorityRoot,
        authorityRoot,
      );
      for (const ref of refs) {
        const fileStat = lstatSync(ref.path);
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
          throw new Error(`Refusing cancellation through non-regular state target ${ref.path}.`);
        }
        const canonicalPath = realpathSync(ref.path);
        const canonicalParent = realpathSync(dirname(ref.path));
        if (!isCanonicalPathWithin(canonicalAuthorityRoot, canonicalParent, true)
          || !isCanonicalPathWithin(canonicalAuthorityRoot, canonicalPath)) {
          throw new Error(`Refusing cancellation outside authorized state root: ${ref.path}.`);
        }
        const content = await readFile(canonicalPath, "utf-8");
        let parsedState: Record<string, unknown>;
        try {
          const parsed = JSON.parse(content) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("state must be a JSON object");
          }
          parsedState = parsed as Record<string, unknown>;
        } catch (err) {
          logCliOperationFailure(err);
          throw new Error(`Refusing partial cancellation because ${ref.path} is malformed.`, { cause: err });
        }
        if (typeof parsedState.mode === "string" && parsedState.mode !== ref.mode) {
          throw new Error(`Refusing contradictory mode state in ${ref.path}.`);
        }
        assertCancellationOwnerMetadata(parsedState, ownerIds, ref.path);
        if (Array.isArray(parsedState.active_skills)) {
          for (const skill of parsedState.active_skills) {
            if (skill && typeof skill === "object" && !Array.isArray(skill)) {
              assertCancellationOwnerMetadata(skill as Record<string, unknown>, ownerIds, `${ref.path} active_skills`);
            }
          }
        }
        loaded.set(ref.mode, {
          path: canonicalPath,
          scope: ref.scope,
          state: parsedState,
          originalContent: content,
          dev: fileStat.dev,
          ino: fileStat.ino,
        });
      }
      return loaded;
    };

    const preferredRefs: ModeStateFileRef[] = writableScope.source === "root"
      ? (await readdir(writableScope.stateDir).catch(() => [] as string[]))
        .filter((file) => file.endsWith("-state.json") && file !== "session.json")
        .map((file) => ({
          mode: file.slice(0, -"-state.json".length),
          path: join(writableScope.stateDir, file),
          scope: "root" as const,
        }))
      : await listModeStateFilesWithScopePreference(cwd, writableScope.sessionId);
    const hasPreferredSessionStateFiles = preferredRefs.some((ref) => ref.scope === "session");
    const targetRefs = writableScope.source === "session"
      ? preferredRefs.filter((ref) => ref.scope === "session")
      : preferredRefs;

    let runSelection: AuthorizedRunStateSelection | null = null;

    let states = await loadStates(targetRefs, writableScope.stateDir, expectedOwnerIds);


    const hasActiveWorkflowMode = (entries: typeof states): boolean =>
      [...entries.entries()].some(
        ([mode, entry]) => mode !== SKILL_ACTIVE_STATE_MODE && entry.state.active === true,
      );
    if (
      writableScope.source === "root"
      && !hasActiveWorkflowMode(states)
      && !hasPreferredSessionStateFiles
    ) {
      runSelection = await selectAuthorizedHookVisibleRunDirState(cwd);
      if (runSelection) {
        const runOwnerIds = new Set([runSelection.sessionId]);
        const runDirStates = await loadStates(runSelection.refs, runSelection.sessionDir, runOwnerIds);
        if (hasActiveWorkflowMode(runDirStates)) states = runDirStates;
        else runSelection = null;
      }
    }


    const currentSessionId = writableScope.sessionId ?? runSelection?.sessionId ?? "";

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
      if (mode === SKILL_ACTIVE_STATE_MODE) {
        entry.state.phase = phase;
        const activeSkills = Array.isArray(entry.state.active_skills)
          ? entry.state.active_skills
          : [];
        entry.state.active_skills = activeSkills.map((skill) => (
          skill && typeof skill === "object"
            ? { ...(skill as Record<string, unknown>), active: false, phase }
            : skill
        ));
      }
      changed.add(mode);
      if (reportIfWasActive && wasActive && mode !== SKILL_ACTIVE_STATE_MODE) reported.add(mode);
    };

    const linkedRalphMode = (state: Record<string, unknown>): "ultrawork" | "ecomode" | undefined => {
      if (state.linked_ultrawork === true || state.linked_mode === "ultrawork") return "ultrawork";
      if (state.linked_ecomode === true || state.linked_mode === "ecomode") return "ecomode";
      return undefined;
    };

    const ralph = states.get("ralph");
    const hadActiveRalph = !!(ralph && ralph.state.active === true);
    if (ralph && ralph.state.active === true) {
      const linkedMode = linkedRalphMode(ralph.state);
      if (linkedMode) cancelMode(linkedMode, "cancelled", true);
      cancelMode("ralph", "cancelled", true);
    }

    if (!hadActiveRalph) {
      for (const [mode, entry] of states.entries()) {
        if (entry.state.active === true) cancelMode(mode, "cancelled", true);
      }
    }

    const assertRunAuthority = (): void => {
      if (runSelection && !hasMatchingMadmaxDetachedRuntimeBinding(runSelection.record)) {
        throw new Error("Refusing cancellation because detached run authority changed.");
      }
    };

    if (force && currentSessionId) {
      const stopStateEntries = [...states.entries()].filter(([mode]) => mode === "native-stop");
      for (const [, entry] of stopStateEntries) {
        const sessions = entry.state.sessions && typeof entry.state.sessions === "object" && !Array.isArray(entry.state.sessions)
          ? { ...(entry.state.sessions as Record<string, unknown>) }
          : null;
        if (!sessions || !Object.prototype.hasOwnProperty.call(sessions, currentSessionId)) continue;
        delete sessions[currentSessionId];
        entry.state.sessions = sessions;
        changed.add("native-stop");
      }
    }

    const orderedChanges = [...changed]
      .sort((left, right) => {
        if (left === "ralph") return 1;
        if (right === "ralph") return -1;
        return left.localeCompare(right);
      })
      .map((mode) => {
        const entry = states.get(mode);
        if (!entry) throw new Error(`Missing frozen cancellation entry for ${mode}.`);
        return { mode, entry, nextContent: JSON.stringify(entry.state, null, 2) };
      });
    const opened: Array<{ mode: string; entry: (typeof states extends Map<string, infer T> ? T : never); nextContent: string; handle: Awaited<ReturnType<typeof open>> }> = [];
    try {
      for (const change of orderedChanges) {
        assertRunAuthority();
        const handle = await open(change.entry.path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
        const currentStat = await handle.stat();
        const currentContent = await handle.readFile({ encoding: "utf-8" });
        if (!currentStat.isFile() || currentStat.dev !== change.entry.dev || currentStat.ino !== change.entry.ino) {
          await handle.close();
          throw new Error(`Refusing cancellation because state identity changed: ${change.entry.path}.`);
        }
        if (currentContent !== change.entry.originalContent) {
          await handle.close();
          throw new Error(`Refusing cancellation because state content changed: ${change.entry.path}.`);
        }
        opened.push({ ...change, handle });
      }

      const committed: typeof opened = [];
      try {
        for (const openedEntry of opened) {
          assertRunAuthority();
          committed.push(openedEntry);
          await openedEntry.handle.truncate(0);
          await openedEntry.handle.write(openedEntry.nextContent, 0, "utf-8");
          await openedEntry.handle.sync();
        }
      } catch (writeError) {
        for (const committedEntry of committed.reverse()) {
          try {
            await committedEntry.handle.truncate(0);
            await committedEntry.handle.write(committedEntry.entry.originalContent, 0, "utf-8");
            await committedEntry.handle.sync();
          } catch {}
        }
        throw writeError;
      }
    } finally {
      await Promise.all(opened.map(({ handle }) => handle.close().catch(() => undefined)));
    }

    for (const mode of reported) {
      console.log(`Cancelled: ${mode}`);
    }

    if (reported.size === 0) {
      console.log("No active modes to cancel.");
    }
  } catch (err) {
    logCliOperationFailure(err);
    process.exitCode = 1;
  }
}
