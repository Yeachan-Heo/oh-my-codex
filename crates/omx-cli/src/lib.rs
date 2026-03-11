pub mod agents_init;
pub mod ask;
pub mod cancel;
pub mod doctor;
pub mod hooks;
pub mod hud;
pub mod install_paths;
pub mod launch;
pub mod ralph;
pub mod reasoning;
pub mod session;
pub mod session_state;
pub mod setup;
pub mod status;
pub mod team;
pub mod tmux_hook;
pub mod uninstall;

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::Path;

pub const BINARY_NAME: &str = "omx";
pub const HELP_OUTPUT: &str = r#"
oh-my-codex (omx) - Multi-agent orchestration for Codex CLI

Usage:
  omx           Launch Codex CLI (HUD auto-attaches only when already inside tmux)
  omx setup     Install skills, prompts, MCP servers, and AGENTS.md
  omx uninstall Remove OMX configuration and clean up installed artifacts
  omx doctor    Check installation health
  omx doctor --team  Check team/swarm runtime health diagnostics
  omx ask       Ask local provider CLI (claude|gemini) and write artifact output
  omx session   Search prior local session transcripts and history artifacts
  omx agents-init [path]
                Bootstrap lightweight AGENTS.md files for a repo/subtree
  omx deepinit [path]
                Alias for agents-init (lightweight AGENTS bootstrap only)
  omx team      Spawn parallel worker panes in tmux and bootstrap inbox/task state
  omx ralph     Launch Codex with ralph persistence mode active
  omx version   Show version information
  omx tmux-hook Manage tmux prompt injection workaround (init|status|validate|test)
  omx hooks     Manage hook plugins (init|status|validate|test)
  omx hud       Show HUD statusline (--watch, --json, --preset=NAME)
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
  --discord      Select Discord provider for temporary notification mode
  --slack        Select Slack provider for temporary notification mode
  --telegram     Select Telegram provider for temporary notification mode
  --custom <name>
                Select custom/OpenClaw gateway name for temporary notification mode
  -w, --worktree[=<name>]
                Launch Codex in a git worktree (detached when no name is given)
  --force       Force reinstall (overwrite existing files)
  --dry-run     Show what would be done without doing it
  --keep-config Skip config.toml cleanup during uninstall
  --purge       Remove .omx/ cache directory during uninstall
  --verbose     Show detailed output
  --scope       Setup scope for "omx setup" only:
                user | project

"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandTarget {
    Launch,
    Setup,
    AgentsInit,
    DeepInit,
    Uninstall,
    Doctor,
    Ask,
    Session,
    Team,
    Ralph,
    Version,
    TmuxHook,
    Hooks,
    Hud,
    Status,
    Cancel,
    Reasoning,
    Help,
}

impl CommandTarget {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Launch => "launch",
            Self::Setup => "setup",
            Self::AgentsInit => "agents-init",
            Self::DeepInit => "deepinit",
            Self::Uninstall => "uninstall",
            Self::Doctor => "doctor",
            Self::Ask => "ask",
            Self::Session => "session",
            Self::Team => "team",
            Self::Ralph => "ralph",
            Self::Version => "version",
            Self::TmuxHook => "tmux-hook",
            Self::Hooks => "hooks",
            Self::Hud => "hud",
            Self::Status => "status",
            Self::Cancel => "cancel",
            Self::Reasoning => "reasoning",
            Self::Help => "help",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliAction {
    Command {
        target: CommandTarget,
        args: Vec<String>,
    },
    Unknown {
        command: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandMatrixEntry {
    pub command: CommandTarget,
    pub dispatch_target: &'static str,
    pub verification_owner: &'static str,
}

const COMMAND_MATRIX: &[CommandMatrixEntry] = &[
    CommandMatrixEntry {
        command: CommandTarget::Launch,
        dispatch_target: "launch::run_launch",
        verification_owner: "lane D",
    },
    CommandMatrixEntry {
        command: CommandTarget::Setup,
        dispatch_target: "setup::run_setup",
        verification_owner: "lane A",
    },
    CommandMatrixEntry {
        command: CommandTarget::AgentsInit,
        dispatch_target: "agents_init::run_agents_init",
        verification_owner: "lane B",
    },
    CommandMatrixEntry {
        command: CommandTarget::DeepInit,
        dispatch_target: "agents_init::run_agents_init",
        verification_owner: "lane B",
    },
    CommandMatrixEntry {
        command: CommandTarget::Uninstall,
        dispatch_target: "uninstall::run_uninstall",
        verification_owner: "lane B",
    },
    CommandMatrixEntry {
        command: CommandTarget::Doctor,
        dispatch_target: "doctor::run_doctor",
        verification_owner: "lane A",
    },
    CommandMatrixEntry {
        command: CommandTarget::Ask,
        dispatch_target: "ask::run_ask",
        verification_owner: "lane A",
    },
    CommandMatrixEntry {
        command: CommandTarget::Session,
        dispatch_target: "session::run_session",
        verification_owner: "lane B",
    },
    CommandMatrixEntry {
        command: CommandTarget::Team,
        dispatch_target: "team::run_team",
        verification_owner: "lane D",
    },
    CommandMatrixEntry {
        command: CommandTarget::Ralph,
        dispatch_target: "ralph::run_ralph",
        verification_owner: "lane D",
    },
    CommandMatrixEntry {
        command: CommandTarget::Version,
        dispatch_target: "lib::version_output",
        verification_owner: "lane C",
    },
    CommandMatrixEntry {
        command: CommandTarget::TmuxHook,
        dispatch_target: "tmux_hook::run_tmux_hook",
        verification_owner: "lane D",
    },
    CommandMatrixEntry {
        command: CommandTarget::Hooks,
        dispatch_target: "hooks::run_hooks",
        verification_owner: "lane D",
    },
    CommandMatrixEntry {
        command: CommandTarget::Hud,
        dispatch_target: "hud::run_hud",
        verification_owner: "lane D",
    },
    CommandMatrixEntry {
        command: CommandTarget::Help,
        dispatch_target: "lib::help_output",
        verification_owner: "lane C",
    },
    CommandMatrixEntry {
        command: CommandTarget::Status,
        dispatch_target: "status::run_status",
        verification_owner: "lane A",
    },
    CommandMatrixEntry {
        command: CommandTarget::Cancel,
        dispatch_target: "cancel::run_cancel",
        verification_owner: "lane A",
    },
    CommandMatrixEntry {
        command: CommandTarget::Reasoning,
        dispatch_target: "reasoning::run_reasoning_command",
        verification_owner: "lane B",
    },
];

#[must_use]
pub fn command_matrix() -> &'static [CommandMatrixEntry] {
    COMMAND_MATRIX
}

#[must_use]
pub fn parse_args<I, S>(args: I) -> CliAction
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let values = args
        .into_iter()
        .map(|value| value.as_ref().to_owned())
        .collect::<Vec<_>>();

    let first_arg = values.get(1).map(String::as_str);
    match first_arg {
        Some("--help" | "-h" | "help") => command(CommandTarget::Help, &values, 2),
        Some("--version" | "-v" | "version") => command(CommandTarget::Version, &values, 2),
        None => CliAction::Command {
            target: CommandTarget::Launch,
            args: Vec::new(),
        },
        Some(flag) if flag.starts_with("--") => CliAction::Command {
            target: CommandTarget::Launch,
            args: values.into_iter().skip(1).collect(),
        },
        Some("launch") => command(CommandTarget::Launch, &values, 2),
        Some("setup") => command(CommandTarget::Setup, &values, 2),
        Some("agents-init") => command(CommandTarget::AgentsInit, &values, 2),
        Some("deepinit") => command(CommandTarget::DeepInit, &values, 2),
        Some("uninstall") => command(CommandTarget::Uninstall, &values, 2),
        Some("doctor") => command(CommandTarget::Doctor, &values, 2),
        Some("ask") => command(CommandTarget::Ask, &values, 2),
        Some("session") => command(CommandTarget::Session, &values, 2),
        Some("team") => command(CommandTarget::Team, &values, 2),
        Some("ralph") => command(CommandTarget::Ralph, &values, 2),
        Some("tmux-hook") => command(CommandTarget::TmuxHook, &values, 2),
        Some("hooks") => command(CommandTarget::Hooks, &values, 2),
        Some("hud") => command(CommandTarget::Hud, &values, 2),
        Some("status") => command(CommandTarget::Status, &values, 2),
        Some("cancel") => command(CommandTarget::Cancel, &values, 2),
        Some("reasoning") => command(CommandTarget::Reasoning, &values, 2),
        Some(other) => CliAction::Unknown {
            command: other.to_string(),
        },
    }
}

fn command(target: CommandTarget, values: &[String], skip: usize) -> CliAction {
    CliAction::Command {
        target,
        args: values.iter().skip(skip).cloned().collect(),
    }
}

#[must_use]
pub fn help_output() -> &'static str {
    HELP_OUTPUT
}

#[must_use]
pub fn version_output() -> String {
    format!(
        "oh-my-codex v{}\nNode.js {}\nPlatform: {} {}\n",
        env!("CARGO_PKG_VERSION"),
        detect_node_version().unwrap_or_else(|| "v25.1.0".to_string()),
        std::env::consts::OS,
        display_arch(),
    )
}

#[allow(clippy::missing_errors_doc)]
pub fn run_ask_command(args: &[String]) -> Result<ask::AskExecution, ask::AskError> {
    let cwd = std::env::current_dir().map_err(|error| {
        ask::AskError::runtime(format!(
            "[ask] failed to resolve current directory: {error}"
        ))
    })?;
    let env = std::env::vars_os().collect::<BTreeMap<OsString, OsString>>();
    ask::run_ask(args, Path::new(&cwd), &env)
}

fn display_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        other => other,
    }
}

fn detect_node_version() -> Option<String> {
    use std::process::Command;

    let output = Command::new("node").arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }

    let version = String::from_utf8(output.stdout).ok()?;
    let trimmed = version.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        BINARY_NAME, CliAction, CommandTarget, command_matrix, help_output, parse_args,
        version_output,
    };

    fn normalize_version_output(text: &str) -> String {
        text.replace(
            text.lines()
                .find(|line| line.starts_with("Node.js "))
                .unwrap_or("Node.js unknown"),
            "Node.js <NODE_VERSION>",
        )
    }

    #[test]
    fn exposes_expected_binary_name() {
        assert_eq!(BINARY_NAME, "omx");
    }

    #[test]
    fn matches_top_level_help_exactly() {
        assert_eq!(
            help_output(),
            include_str!("../../../src/compat/fixtures/help.stdout.txt")
        );
    }

    #[test]
    fn command_matrix_covers_help_advertised_commands() {
        let advertised = [
            CommandTarget::Launch,
            CommandTarget::Setup,
            CommandTarget::AgentsInit,
            CommandTarget::DeepInit,
            CommandTarget::Uninstall,
            CommandTarget::Doctor,
            CommandTarget::Ask,
            CommandTarget::Session,
            CommandTarget::Team,
            CommandTarget::Ralph,
            CommandTarget::Version,
            CommandTarget::TmuxHook,
            CommandTarget::Hooks,
            CommandTarget::Hud,
            CommandTarget::Help,
            CommandTarget::Status,
            CommandTarget::Cancel,
            CommandTarget::Reasoning,
        ];
        let mapped = command_matrix()
            .iter()
            .map(|entry| entry.command)
            .collect::<Vec<_>>();
        assert_eq!(mapped, advertised);
        assert!(
            command_matrix()
                .iter()
                .all(|entry| !entry.dispatch_target.is_empty())
        );
        assert!(
            command_matrix()
                .iter()
                .all(|entry| !entry.verification_owner.is_empty())
        );
    }

    #[test]
    fn parses_help_variants() {
        assert_eq!(
            parse_args(["omx", "help"]),
            CliAction::Command {
                target: CommandTarget::Help,
                args: vec![]
            }
        );
        assert_eq!(
            parse_args(["omx", "--help"]),
            CliAction::Command {
                target: CommandTarget::Help,
                args: vec![]
            }
        );
        assert_eq!(
            parse_args(["omx", "-h"]),
            CliAction::Command {
                target: CommandTarget::Help,
                args: vec![]
            }
        );
    }

    #[test]
    fn parses_version_variants() {
        assert_eq!(
            parse_args(["omx", "version"]),
            CliAction::Command {
                target: CommandTarget::Version,
                args: vec![]
            }
        );
        assert_eq!(
            parse_args(["omx", "--version"]),
            CliAction::Command {
                target: CommandTarget::Version,
                args: vec![]
            }
        );
        assert_eq!(
            parse_args(["omx", "-v"]),
            CliAction::Command {
                target: CommandTarget::Version,
                args: vec![]
            }
        );
    }

    #[test]
    fn parses_launch_variants() {
        assert_eq!(
            parse_args(["omx"]),
            CliAction::Command {
                target: CommandTarget::Launch,
                args: vec![]
            }
        );
        assert_eq!(
            parse_args(["omx", "launch", "--yolo"]),
            CliAction::Command {
                target: CommandTarget::Launch,
                args: vec!["--yolo".into()]
            }
        );
        assert_eq!(
            parse_args(["omx", "--model", "gpt-5"]),
            CliAction::Command {
                target: CommandTarget::Launch,
                args: vec!["--model".into(), "gpt-5".into()]
            }
        );
    }

    #[test]
    fn parses_known_subcommands_with_passthrough_args() {
        assert_eq!(
            parse_args(["omx", "ask", "claude", "review", "this"]),
            CliAction::Command {
                target: CommandTarget::Ask,
                args: vec!["claude".into(), "review".into(), "this".into()]
            }
        );
        assert_eq!(
            parse_args(["omx", "reasoning", "high"]),
            CliAction::Command {
                target: CommandTarget::Reasoning,
                args: vec!["high".into()]
            }
        );
        assert_eq!(
            parse_args(["omx", "doctor", "--team"]),
            CliAction::Command {
                target: CommandTarget::Doctor,
                args: vec!["--team".into()]
            }
        );
        assert_eq!(
            parse_args(["omx", "setup", "--scope", "project"]),
            CliAction::Command {
                target: CommandTarget::Setup,
                args: vec!["--scope".into(), "project".into()]
            }
        );
        assert_eq!(
            parse_args(["omx", "uninstall", "--dry-run"]),
            CliAction::Command {
                target: CommandTarget::Uninstall,
                args: vec!["--dry-run".into()]
            }
        );
        assert_eq!(
            parse_args(["omx", "agents-init", "src", "--dry-run"]),
            CliAction::Command {
                target: CommandTarget::AgentsInit,
                args: vec!["src".into(), "--dry-run".into()]
            }
        );
        assert_eq!(
            parse_args(["omx", "deepinit", "src"]),
            CliAction::Command {
                target: CommandTarget::DeepInit,
                args: vec!["src".into()]
            }
        );
        assert_eq!(
            parse_args(["omx", "status"]),
            CliAction::Command {
                target: CommandTarget::Status,
                args: vec![]
            }
        );
        assert_eq!(
            parse_args(["omx", "cancel"]),
            CliAction::Command {
                target: CommandTarget::Cancel,
                args: vec![]
            }
        );
    }

    #[test]
    fn preserves_unknown_commands_for_helpful_errors() {
        assert_eq!(
            parse_args(["omx", "bogus"]),
            CliAction::Unknown {
                command: "bogus".into()
            }
        );
    }

    #[test]
    fn matches_version_fixture_in_current_environment() {
        assert_eq!(
            normalize_version_output(&version_output()),
            include_str!("../../../src/compat/fixtures/version.stdout.txt")
        );
    }
}
