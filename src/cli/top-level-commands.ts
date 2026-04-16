export interface TopLevelCliCommandDescriptor {
  name: string;
  helpLines?: string[];
  ownsLocalHelp?: boolean;
  visibleInHelp?: boolean;
}

export const TOP_LEVEL_CLI_COMMANDS: readonly TopLevelCliCommandDescriptor[] = [
  {
    name: 'launch',
    visibleInHelp: false,
  },
  {
    name: 'exec',
    helpLines: ['  omx exec      Run codex exec non-interactively with OMX AGENTS/overlay injection'],
    ownsLocalHelp: true,
  },
  {
    name: 'setup',
    helpLines: ['  omx setup     Install skills, prompts, MCP servers, and scope-specific AGENTS.md'],
  },
  {
    name: 'uninstall',
    helpLines: ['  omx uninstall Remove OMX configuration and clean up installed artifacts'],
  },
  {
    name: 'doctor',
    helpLines: [
      '  omx doctor    Check installation health',
      '  omx doctor --team  Check team/swarm runtime health diagnostics',
    ],
  },
  {
    name: 'cleanup',
    helpLines: ['  omx cleanup   Kill orphaned OMX MCP server processes and remove stale OMX /tmp directories'],
    ownsLocalHelp: true,
  },
  {
    name: 'ask',
    helpLines: ['  omx ask       Ask local provider CLI (claude|gemini) and write artifact output'],
    ownsLocalHelp: true,
  },
  {
    name: 'adapt',
    helpLines: ['  omx adapt     Scaffold OMX-owned adapter foundations for persistent external targets'],
    ownsLocalHelp: true,
  },
  {
    name: 'resume',
    helpLines: ['  omx resume    Resume a previous interactive Codex session'],
    ownsLocalHelp: true,
  },
  {
    name: 'explore',
    helpLines: ['  omx explore   Default read-only exploration entrypoint (may adaptively use sparkshell backend)'],
    ownsLocalHelp: true,
  },
  {
    name: 'session',
    helpLines: ['  omx session   Search prior local session transcripts and history artifacts'],
    ownsLocalHelp: true,
  },
  {
    name: 'agents-init',
    helpLines: [
      '  omx agents-init [path]',
      '                Bootstrap lightweight AGENTS.md files for a repo/subtree',
    ],
    ownsLocalHelp: true,
  },
  {
    name: 'agents',
    helpLines: ['  omx agents    Manage Codex native agent TOML files'],
    ownsLocalHelp: true,
  },
  {
    name: 'deepinit',
    helpLines: [
      '  omx deepinit [path]',
      '                Alias for agents-init (lightweight AGENTS bootstrap only)',
    ],
    ownsLocalHelp: true,
  },
  {
    name: 'team',
    helpLines: ['  omx team      Spawn parallel worker panes in tmux and bootstrap inbox/task state'],
    ownsLocalHelp: true,
  },
  {
    name: 'ralph',
    helpLines: ['  omx ralph     Launch Codex with ralph persistence mode active'],
    ownsLocalHelp: true,
  },
  {
    name: 'autoresearch',
    helpLines: ['  omx autoresearch Launch thin-supervisor autoresearch with keep/discard/reset parity'],
    ownsLocalHelp: true,
  },
  {
    name: 'completion',
    helpLines: ['  omx completion Install shell completion for bash, zsh, fish, or powershell'],
    ownsLocalHelp: true,
  },
  {
    name: 'version',
    helpLines: ['  omx version   Show version information'],
  },
  {
    name: 'tmux-hook',
    helpLines: ['  omx tmux-hook Manage tmux prompt injection workaround (init|status|validate|test)'],
    ownsLocalHelp: true,
  },
  {
    name: 'hooks',
    helpLines: ['  omx hooks     Manage hook plugins (init|status|validate|test)'],
    ownsLocalHelp: true,
  },
  {
    name: 'hud',
    helpLines: ['  omx hud       Show HUD statusline (--watch, --json, --preset=NAME)'],
    ownsLocalHelp: true,
  },
  {
    name: 'state',
    helpLines: ['  omx state     Read/write/list OMX mode state via CLI parity surface'],
    ownsLocalHelp: true,
  },
  {
    name: 'notepad',
    helpLines: ['  omx notepad   CLI parity for OMX notepad MCP tools'],
    ownsLocalHelp: true,
  },
  {
    name: 'project-memory',
    helpLines: [
      '  omx project-memory',
      '                CLI parity for OMX project-memory MCP tools',
    ],
    ownsLocalHelp: true,
  },
  {
    name: 'trace',
    helpLines: ['  omx trace     CLI parity for OMX trace MCP tools'],
    ownsLocalHelp: true,
  },
  {
    name: 'code-intel',
    helpLines: ['  omx code-intel                CLI parity for OMX code-intel MCP tools'],
    ownsLocalHelp: true,
  },
  {
    name: 'wiki',
    helpLines: ['  omx wiki      CLI parity for OMX wiki MCP tools'],
    ownsLocalHelp: true,
  },
  {
    name: 'sparkshell',
    helpLines: [
      '  omx sparkshell <command> [args...]',
      '  omx sparkshell --tmux-pane <pane-id> [--tail-lines <100-1000>]',
      '                Run native sparkshell sidecar for direct command execution or explicit tmux-pane summarization',
      '                (also used as an adaptive backend for qualifying read-only explore tasks)',
    ],
    ownsLocalHelp: true,
  },
  {
    name: 'help',
    helpLines: ['  omx help      Show this help message'],
  },
  {
    name: 'status',
    helpLines: ['  omx status    Show active modes and state'],
  },
  {
    name: 'cancel',
    helpLines: ['  omx cancel    Cancel active execution modes'],
  },
  {
    name: 'reasoning',
    helpLines: ['  omx reasoning Show or set model reasoning effort (low|medium|high|xhigh)'],
  },
] as const;

export const TOP_LEVEL_COMMAND_NAMES = TOP_LEVEL_CLI_COMMANDS.map((entry) => entry.name);
export const TOP_LEVEL_LOCAL_HELP_COMMANDS = TOP_LEVEL_CLI_COMMANDS
  .filter((entry) => entry.ownsLocalHelp)
  .map((entry) => entry.name);

const GLOBAL_OPTION_LINES = [
  '  --yolo        Launch Codex in yolo mode (shorthand for: omx launch --yolo)',
  '  --high        Launch Codex with high reasoning effort',
  '                (shorthand for: -c model_reasoning_effort="high")',
  '  --xhigh       Launch Codex with xhigh reasoning effort',
  '                (shorthand for: -c model_reasoning_effort="xhigh")',
  '  --madmax      DANGEROUS: bypass Codex approvals and sandbox',
  '                (alias for --dangerously-bypass-approvals-and-sandbox)',
  '  --spark       Use the Codex spark model (~1.3x faster) for team workers only',
  '                Workers get the configured low-complexity team model; leader model unchanged',
  '  --madmax-spark  spark model for workers + bypass approvals for leader and workers',
  '                (shorthand for: --spark --madmax)',
  '  --notify-temp  Enable temporary notification routing for this run/session only',
  '  --tmux         Launch the interactive leader session in detached tmux',
  '  --discord      Select Discord provider for temporary notification mode',
  '  --slack        Select Slack provider for temporary notification mode',
  '  --telegram     Select Telegram provider for temporary notification mode',
  '  --custom <name>',
  '                Select custom/OpenClaw gateway name for temporary notification mode',
  '  -w, --worktree[=<name>]',
  '                Launch Codex in a git worktree (detached when no name is given)',
  '  --force       Force reinstall (overwrite existing files)',
  '  --dry-run     Show what would be done without doing it',
  '  --keep-config Skip config.toml cleanup during uninstall',
  '  --purge       Remove .omx/ cache directory during uninstall',
  '  --verbose     Show detailed output',
  '  --scope       Setup scope for "omx setup" only:',
  '                user | project',
  '  --skill-target',
  '                User-scope skills target for "omx setup" only:',
  '                codex-home',
] as const;

export function buildTopLevelHelp(): string {
  const commandLines = TOP_LEVEL_CLI_COMMANDS
    .filter((entry) => entry.visibleInHelp !== false)
    .flatMap((entry) => entry.helpLines ?? []);

  return [
    '',
    'oh-my-codex (omx) - Multi-agent orchestration for Codex CLI',
    '',
    'Usage:',
    '  omx           Launch Codex CLI (HUD auto-attaches only when already inside tmux)',
    ...commandLines,
    '',
    'Options:',
    ...GLOBAL_OPTION_LINES,
    '',
  ].join('\n');
}
