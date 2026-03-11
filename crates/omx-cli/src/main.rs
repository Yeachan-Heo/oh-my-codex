use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

fn exit_code_from_i32(code: i32) -> ExitCode {
    match u8::try_from(code) {
        Ok(value) => ExitCode::from(value),
        Err(_) => ExitCode::from(1),
    }
}

fn current_dir() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn current_env() -> BTreeMap<OsString, OsString> {
    std::env::vars_os().collect()
}

fn write_command_output(stdout: &[u8], stderr: &[u8], exit_code: i32) -> ExitCode {
    io::stdout().write_all(stdout).ok();
    io::stderr().write_all(stderr).ok();
    exit_code_from_i32(exit_code)
}

fn report_error(error: impl std::fmt::Display, prefix: Option<&str>) -> ExitCode {
    match prefix {
        Some(prefix) => eprintln!("{prefix}{error}"),
        None => eprintln!("{error}"),
    }
    ExitCode::from(1)
}

fn dispatch_common_result<T, E>(
    result: Result<T, E>,
    split: impl FnOnce(T) -> (Vec<u8>, Vec<u8>, i32),
    error_prefix: Option<&str>,
) -> ExitCode
where
    E: std::fmt::Display,
{
    match result {
        Ok(result) => {
            let (stdout, stderr, exit_code) = split(result);
            write_command_output(&stdout, &stderr, exit_code)
        }
        Err(error) => report_error(error, error_prefix),
    }
}

fn dispatch_unknown(command: &str) -> ExitCode {
    eprintln!("Unknown command: {command}");
    print!("{}", omx_cli::help_output());
    ExitCode::from(1)
}

#[allow(clippy::too_many_lines)]
fn dispatch_command(
    target: omx_cli::CommandTarget,
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<OsString, OsString>,
) -> ExitCode {
    match target {
        omx_cli::CommandTarget::Help => {
            print!("{}", omx_cli::help_output());
            ExitCode::SUCCESS
        }
        omx_cli::CommandTarget::Version => {
            print!("{}", omx_cli::version_output());
            ExitCode::SUCCESS
        }
        omx_cli::CommandTarget::Ask => dispatch_common_result(
            omx_cli::run_ask_command(args),
            |result| (result.stdout, result.stderr, result.exit_code),
            None,
        ),
        omx_cli::CommandTarget::Reasoning => {
            match omx_cli::reasoning::run_reasoning_command(args, omx_cli::help_output()) {
                Ok(output) => {
                    print!("{output}");
                    ExitCode::SUCCESS
                }
                Err(error) => report_error(error, Some("Error: ")),
            }
        }
        omx_cli::CommandTarget::AgentsInit => dispatch_common_result(
            omx_cli::agents_init::run_agents_init(
                omx_cli::agents_init::AgentsInitMode::AgentsInit,
                args,
                cwd,
            ),
            |result| (result.stdout, result.stderr, result.exit_code),
            None,
        ),
        omx_cli::CommandTarget::DeepInit => dispatch_common_result(
            omx_cli::agents_init::run_agents_init(
                omx_cli::agents_init::AgentsInitMode::DeepInit,
                args,
                cwd,
            ),
            |result| (result.stdout, result.stderr, result.exit_code),
            None,
        ),
        omx_cli::CommandTarget::Uninstall => dispatch_common_result(
            omx_cli::uninstall::run_uninstall(args, cwd, env),
            |result| (result.stdout, result.stderr, result.exit_code),
            None,
        ),
        omx_cli::CommandTarget::Doctor => dispatch_common_result(
            omx_cli::doctor::run_doctor(args, cwd, env),
            |result| (result.stdout, result.stderr, result.exit_code),
            None,
        ),
        omx_cli::CommandTarget::Setup => dispatch_common_result(
            omx_cli::setup::run_setup(args, cwd, env),
            |result| (result.stdout, result.stderr, result.exit_code),
            None,
        ),
        omx_cli::CommandTarget::Status => dispatch_common_result(
            omx_cli::status::run_status(args, cwd, env),
            |result| (result.stdout, result.stderr, result.exit_code),
            Some("Error: "),
        ),
        omx_cli::CommandTarget::Cancel => dispatch_common_result(
            omx_cli::cancel::run_cancel(args, cwd, env),
            |result| (result.stdout, result.stderr, result.exit_code),
            Some("Error: "),
        ),
        omx_cli::CommandTarget::Session => dispatch_common_result(
            omx_cli::session::run_session(args, omx_cli::help_output()),
            |result| (result.stdout, result.stderr, result.exit_code),
            None,
        ),
        omx_cli::CommandTarget::Team => dispatch_common_result(
            omx_cli::team::run_team(args, cwd, env),
            |result| (result.stdout, result.stderr, result.exit_code),
            None,
        ),
        omx_cli::CommandTarget::TmuxHook => dispatch_common_result(
            omx_cli::tmux_hook::run_tmux_hook(args, cwd, env),
            |result| (result.stdout, result.stderr, result.exit_code),
            None,
        ),
        omx_cli::CommandTarget::Hooks => dispatch_common_result(
            omx_cli::hooks::run_hooks(args, cwd, env),
            |result| (result.stdout, result.stderr, result.exit_code),
            None,
        ),
        omx_cli::CommandTarget::Hud => dispatch_common_result(
            omx_cli::hud::run_hud(args, omx_cli::help_output()),
            |result| (result.stdout, result.stderr, result.exit_code),
            None,
        ),
        omx_cli::CommandTarget::Ralph => dispatch_common_result(
            omx_cli::ralph::run_ralph(args, cwd),
            |result| (result.stdout, result.stderr, result.exit_code),
            None,
        ),
        omx_cli::CommandTarget::Launch => dispatch_common_result(
            omx_cli::launch::run_launch(args, omx_cli::help_output()),
            |result| (result.stdout, result.stderr, result.exit_code),
            None,
        ),
    }
}

fn main() -> ExitCode {
    let cwd = current_dir();
    let env = current_env();
    match omx_cli::parse_args(std::env::args()) {
        omx_cli::CliAction::Command { target, args } => dispatch_command(target, &args, &cwd, &env),
        omx_cli::CliAction::Unknown { command } => dispatch_unknown(&command),
    }
}
