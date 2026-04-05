use clap::{Parser, Subcommand};

/// OMX — orchestration layer for LLM CLIs
#[derive(Debug, Parser)]
#[command(name = "omx", version, about)]
struct Cli {
    /// Model override
    #[arg(long)]
    model: Option<String>,

    /// Provider override (codex or claude)
    #[arg(long)]
    provider: Option<String>,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Generate config, agents, prompts, skills, MCP entries
    Setup {
        #[arg(long, default_value = "user")]
        scope: String,
    },

    /// Verify installation and dependencies
    Doctor,

    /// Print version
    Version,

    /// Start team with N workers
    Team {
        #[command(subcommand)]
        action: TeamAction,
    },

    /// Read-only codebase exploration
    Explore {
        /// Prompt for exploration
        #[arg(long)]
        prompt: String,
    },

    /// Shell execution + output summarization
    Sparkshell {
        /// Command to execute
        command: Vec<String>,
    },

    /// ratatui status display
    Hud {
        /// Watch mode — continuously update
        #[arg(long)]
        watch: bool,
    },

    /// Direct provider query
    Ask {
        /// Provider name
        provider: String,
        /// Prompt text
        prompt: String,
    },

    /// Cancel active modes
    Cancel,

    /// Hook management
    Hooks {
        #[command(subcommand)]
        action: HooksAction,
    },

    /// Internal callback API for hook executables
    HookApi {
        #[command(subcommand)]
        action: HookApiAction,
    },
}

#[derive(Debug, Subcommand)]
enum TeamAction {
    /// Start team: omx team start 3:executor "task"
    Start {
        /// Worker spec (e.g., "3:executor")
        spec: String,
        /// Task description
        task: String,
    },
    /// Check team health
    Status { name: String },
    /// Resume interrupted team
    Resume { name: String },
    /// Graceful cleanup
    Shutdown { name: String },
    /// Internal worker APIs
    Api {
        #[command(subcommand)]
        action: TeamApiAction,
    },
}

#[derive(Debug, Subcommand)]
enum TeamApiAction {
    ClaimTask {
        #[arg(long)]
        task_id: String,
    },
    TransitionTaskStatus {
        #[arg(long)]
        task_id: String,
        #[arg(long)]
        status: String,
    },
    ReleaseTaskClaim {
        #[arg(long)]
        task_id: String,
    },
}

#[derive(Debug, Subcommand)]
enum HooksAction {
    /// Show hook status
    Status,
    /// Validate hook configurations
    Validate,
    /// Test hook execution
    Test,
}

#[derive(Debug, Subcommand)]
enum HookApiAction {
    /// Send tmux keys
    TmuxSendKeys {
        #[arg(long)]
        target: String,
        text: String,
    },
    /// Read state
    StateRead {
        #[arg(long)]
        mode: String,
        #[arg(long)]
        key: String,
    },
    /// Write state
    StateWrite {
        #[arg(long)]
        mode: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        value: String,
    },
    /// Read session info
    SessionRead,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let cli = Cli::parse();

    match cli.command {
        None => {
            todo!("Phase 4: default launch flow — load config, resolve policy, inject AGENTS.md, spawn provider CLI")
        }
        Some(Commands::Setup { scope: _ }) => {
            todo!("Phase 4: run setup generator")
        }
        Some(Commands::Doctor) => {
            todo!("Phase 1: verify installation — tmux, providers, MCP servers")
        }
        Some(Commands::Version) => {
            println!("omx {}", env!("CARGO_PKG_VERSION"));
            Ok::<(), Box<dyn std::error::Error>>(())?
        }
        Some(Commands::Team { action }) => match action {
            TeamAction::Start { spec: _, task: _ } => {
                todo!("Phase 3: parse spec, create TeamConfig, start team")
            }
            TeamAction::Status { name: _ } => {
                todo!("Phase 3: read team state, display status")
            }
            TeamAction::Resume { name: _ } => {
                todo!("Phase 3: load persisted state, resume monitor loop")
            }
            TeamAction::Shutdown { name: _ } => {
                todo!("Phase 3: graceful shutdown")
            }
            TeamAction::Api { action } => match action {
                TeamApiAction::ClaimTask { task_id: _ } => {
                    todo!("Phase 3: claim task via omx-team")
                }
                TeamApiAction::TransitionTaskStatus {
                    task_id: _,
                    status: _,
                } => {
                    todo!("Phase 3: transition task status")
                }
                TeamApiAction::ReleaseTaskClaim { task_id: _ } => {
                    todo!("Phase 3: release task claim")
                }
            },
        },
        Some(Commands::Explore { prompt: _ }) => {
            todo!("Phase 4: delegate to omx-explore")
        }
        Some(Commands::Sparkshell { command: _ }) => {
            todo!("Phase 4: delegate to omx-sparkshell")
        }
        Some(Commands::Hud { watch: _ }) => {
            todo!("Phase 4: launch ratatui HUD")
        }
        Some(Commands::Ask {
            provider: _,
            prompt: _,
        }) => {
            todo!("Phase 4: direct provider query")
        }
        Some(Commands::Cancel) => {
            todo!("Phase 4: cancel active modes")
        }
        Some(Commands::Hooks { action }) => match action {
            HooksAction::Status => todo!("Phase 2: show hook status"),
            HooksAction::Validate => todo!("Phase 2: validate hooks"),
            HooksAction::Test => todo!("Phase 2: test hooks"),
        },
        Some(Commands::HookApi { action }) => match action {
            HookApiAction::TmuxSendKeys { target: _, text: _ } => {
                todo!("Phase 2: send tmux keys via omx-mux")
            }
            HookApiAction::StateRead { mode: _, key: _ } => {
                todo!("Phase 2: read state via omx-state")
            }
            HookApiAction::StateWrite {
                mode: _,
                key: _,
                value: _,
            } => {
                todo!("Phase 2: write state via omx-state")
            }
            HookApiAction::SessionRead => {
                todo!("Phase 2: read session info")
            }
        },
    }

    Ok(())
}
