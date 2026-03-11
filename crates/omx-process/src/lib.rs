pub mod platform_command;
pub mod process_bridge;
pub mod process_plan;
pub mod tmux_commands;
pub mod tmux_shell;

pub use platform_command::{
    PlatformCommandSpec, SpawnErrorKind, WindowsCommandKind, build_platform_command_spec,
    classify_spawn_error, resolve_command_path_for_platform,
};
pub use process_bridge::{
    CommandSpec, Platform, PlatformResolution, ProbedCommand, ProcessBridge, ProcessResult,
    StdioMode,
};
pub use process_plan::{PlanExecution, PlannedStep, StepResult, command_spec_for_shell};
pub use tmux_commands::{
    build_tmux_capture_pane_command, build_tmux_command, build_tmux_kill_pane_command,
    build_tmux_kill_session_command, build_tmux_list_sessions_command,
    build_tmux_send_keys_literal_commands, build_tmux_version_command, sanitize_tmux_literal_text,
};
pub use tmux_shell::{
    build_env_command_prefix, build_tmux_pane_command, build_tmux_shell_command,
    normalize_shell_path, shell_quote_single,
};
