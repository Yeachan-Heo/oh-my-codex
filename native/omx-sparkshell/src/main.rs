mod codex_bridge;
mod error;
mod exec;
mod prompt;
mod threshold;

use crate::codex_bridge::summarize_output;
use crate::error::SparkshellError;
use crate::exec::execute_command;
use crate::threshold::{combined_visible_lines, read_line_threshold};
use std::io::{self, Write};
use std::process;

const DEFAULT_TMUX_TAIL_LINES: usize = 200;
const MIN_TMUX_TAIL_LINES: usize = 100;
const MAX_TMUX_TAIL_LINES: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
enum SparkShellInput {
    Command(Vec<String>),
    TmuxPane {
        pane_id: String,
        tail_lines: usize,
    },
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|arg| arg == "--help" || arg == "-h") {
        println!("{}", usage_text());
        return;
    }
    if let Err(error) = run(args) {
        eprintln!("omx sparkshell: {error}");
        process::exit(error.raw_exit_code());
    }
}

fn run(args: Vec<String>) -> Result<(), SparkshellError> {
    let execution_argv = match parse_input(&args)? {
        SparkShellInput::Command(command) => command,
        SparkShellInput::TmuxPane {
            pane_id,
            tail_lines,
        } => vec![
            "tmux".to_string(),
            "capture-pane".to_string(),
            "-t".to_string(),
            pane_id,
            "-p".to_string(),
            "-S".to_string(),
            format!("-{tail_lines}"),
        ],
    };

    let output = execute_command(&execution_argv)?;
    let threshold = read_line_threshold();
    let line_count = combined_visible_lines(&output.stdout, &output.stderr);

    if line_count <= threshold {
        write_raw_output(&output.stdout, &output.stderr)?;
        process::exit(output.exit_code());
    }

    match summarize_output(&execution_argv, &output) {
        Ok(summary) => {
            let mut stdout = io::stdout().lock();
            stdout.write_all(summary.as_bytes())?;
            if !summary.ends_with('\n') {
                stdout.write_all(b"\n")?;
            }
            stdout.flush()?;
        }
        Err(error) => {
            write_raw_output(&output.stdout, &output.stderr)?;
            eprintln!("omx sparkshell: summary unavailable ({error})");
        }
    }

    process::exit(output.exit_code());
}

fn write_raw_output(stdout_bytes: &[u8], stderr_bytes: &[u8]) -> Result<(), SparkshellError> {
    let mut stdout = io::stdout().lock();
    stdout.write_all(stdout_bytes)?;
    stdout.flush()?;

    let mut stderr = io::stderr().lock();
    stderr.write_all(stderr_bytes)?;
    stderr.flush()?;
    Ok(())
}

fn usage_text() -> String {
    format!(
        concat!(
            "usage: omx-sparkshell <command> [args...]\n",
            "   or: omx-sparkshell --tmux-pane <pane-id> [--tail-lines <{min}-{max}>]\n",
            "\n",
            "Direct command mode executes argv without shell metacharacter parsing.\n",
            "Tmux pane mode captures a larger pane tail and applies the same raw-vs-summary behavior.\n"
        ),
        min = MIN_TMUX_TAIL_LINES,
        max = MAX_TMUX_TAIL_LINES,
    )
}

fn parse_input(args: &[String]) -> Result<SparkShellInput, SparkshellError> {
    if args.is_empty() {
        return Err(SparkshellError::InvalidArgs(usage_text()));
    }

    let mut pane_id: Option<String> = None;
    let mut tail_lines = DEFAULT_TMUX_TAIL_LINES;
    let mut explicit_tail_lines = false;
    let mut positional = Vec::new();

    let mut index = 0;
    while index < args.len() {
        let token = &args[index];
        if token == "--tmux-pane" {
            let Some(next) = args.get(index + 1) else {
                return Err(SparkshellError::InvalidArgs(
                    "--tmux-pane requires a pane id".to_string(),
                ));
            };
            if next.starts_with('-') {
                return Err(SparkshellError::InvalidArgs(
                    "--tmux-pane requires a pane id".to_string(),
                ));
            }
            pane_id = Some(next.clone());
            index += 2;
            continue;
        }
        if let Some(value) = token.strip_prefix("--tmux-pane=") {
            if value.trim().is_empty() {
                return Err(SparkshellError::InvalidArgs(
                    "--tmux-pane requires a pane id".to_string(),
                ));
            }
            pane_id = Some(value.to_string());
            index += 1;
            continue;
        }
        if token == "--tail-lines" {
            let Some(next) = args.get(index + 1) else {
                return Err(SparkshellError::InvalidArgs(
                    "--tail-lines requires a numeric value".to_string(),
                ));
            };
            tail_lines = parse_tail_lines(next)?;
            explicit_tail_lines = true;
            index += 2;
            continue;
        }
        if let Some(value) = token.strip_prefix("--tail-lines=") {
            tail_lines = parse_tail_lines(value)?;
            explicit_tail_lines = true;
            index += 1;
            continue;
        }

        positional.push(token.clone());
        index += 1;
    }

    if let Some(pane_id) = pane_id {
        if !positional.is_empty() {
            return Err(SparkshellError::InvalidArgs(
                "tmux pane mode does not accept an additional command".to_string(),
            ));
        }
        return Ok(SparkShellInput::TmuxPane {
            pane_id,
            tail_lines,
        });
    }

    if explicit_tail_lines {
        return Err(SparkshellError::InvalidArgs(
            "--tail-lines requires --tmux-pane".to_string(),
        ));
    }

    Ok(SparkShellInput::Command(positional))
}

fn parse_tail_lines(raw: &str) -> Result<usize, SparkshellError> {
    let parsed = raw
        .trim()
        .parse::<usize>()
        .ok()
        .filter(|value| (*value >= MIN_TMUX_TAIL_LINES) && (*value <= MAX_TMUX_TAIL_LINES))
        .ok_or_else(|| {
            SparkshellError::InvalidArgs(format!(
                "--tail-lines must be an integer between {MIN_TMUX_TAIL_LINES} and {MAX_TMUX_TAIL_LINES}"
            ))
        })?;
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::{parse_input, SparkShellInput};

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn parses_direct_command_mode() {
        let parsed = parse_input(&strings(&["git", "status"])).expect("parsed");
        assert_eq!(
            parsed,
            SparkShellInput::Command(strings(&["git", "status"]))
        );
    }

    #[test]
    fn parses_tmux_pane_mode_with_default_tail_lines() {
        let parsed = parse_input(&strings(&["--tmux-pane", "%11"])).expect("parsed");
        assert_eq!(
            parsed,
            SparkShellInput::TmuxPane {
                pane_id: "%11".to_string(),
                tail_lines: 200,
            }
        );
    }

    #[test]
    fn parses_tmux_pane_mode_with_explicit_tail_lines() {
        let parsed = parse_input(&strings(&[
            "--tmux-pane=%22",
            "--tail-lines=400",
        ]))
        .expect("parsed");
        assert_eq!(
            parsed,
            SparkShellInput::TmuxPane {
                pane_id: "%22".to_string(),
                tail_lines: 400,
            }
        );
    }

    #[test]
    fn rejects_tail_lines_without_tmux_pane() {
        let error = parse_input(&strings(&["--tail-lines", "300"])).unwrap_err();
        assert_eq!(error.to_string(), "--tail-lines requires --tmux-pane");
    }

    #[test]
    fn rejects_default_tail_lines_without_tmux_pane_when_explicit() {
        let error = parse_input(&strings(&["--tail-lines", "200"])).unwrap_err();
        assert_eq!(error.to_string(), "--tail-lines requires --tmux-pane");
    }

    #[test]
    fn rejects_tmux_pane_mode_with_positional_command() {
        let error =
            parse_input(&strings(&["--tmux-pane", "%11", "git", "status"])).unwrap_err();
        assert_eq!(
            error.to_string(),
            "tmux pane mode does not accept an additional command"
        );
    }

    #[test]
    fn rejects_out_of_range_tail_lines() {
        let error = parse_input(&strings(&["--tmux-pane", "%11", "--tail-lines", "80"]))
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "--tail-lines must be an integer between 100 and 1000"
        );
    }

    #[test]
    fn rejects_tail_lines_above_maximum() {
        let error = parse_input(&strings(&["--tmux-pane", "%11", "--tail-lines", "1001"]))
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "--tail-lines must be an integer between 100 and 1000"
        );
    }

    #[test]
    fn rejects_missing_tail_lines_value() {
        let error = parse_input(&strings(&["--tmux-pane", "%11", "--tail-lines"]))
            .unwrap_err();
        assert_eq!(error.to_string(), "--tail-lines requires a numeric value");
    }
}
