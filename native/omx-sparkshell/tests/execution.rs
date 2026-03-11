use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn sparkshell_bin() -> &'static str {
    env!("CARGO_BIN_EXE_omx-sparkshell")
}

fn unique_temp_dir(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let path = env::temp_dir().join(format!(
        "omx-sparkshell-{name}-{nanos}-{}",
        std::process::id()
    ));
    fs::create_dir_all(&path).expect("temp dir");
    path
}

fn write_executable(path: &Path, body: &str) {
    fs::write(path, body).expect("write script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path).expect("metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms).expect("chmod");
    }
}

#[test]
fn raw_mode_preserves_stdout_and_stderr() {
    let output = Command::new(sparkshell_bin())
        .env("OMX_SPARKSHELL_LINES", "5")
        .arg("sh")
        .arg("-c")
        .arg("printf 'alpha\n'; printf 'warn\n' >&2")
        .output()
        .expect("run sparkshell");

    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout), "alpha\n");
    assert_eq!(String::from_utf8_lossy(&output.stderr), "warn\n");
}

#[test]
fn summary_mode_uses_codex_exec_and_model_override() {
    let temp = unique_temp_dir("codex-success");
    let codex = temp.join("codex");
    let args_log = temp.join("args.log");
    let prompt_log = temp.join("prompt.log");
    write_executable(
        &codex,
        &format!(
            "#!/bin/sh\nprintf '%s\n' \"$@\" > '{}'\ncat > '{}'\nprintf '%s\n' '- summary: command produced long output' '- warnings: stderr was empty'\n",
            args_log.display(),
            prompt_log.display()
        ),
    );

    let path = format!(
        "{}:{}",
        temp.display(),
        env::var("PATH").unwrap_or_default()
    );
    let output = Command::new(sparkshell_bin())
        .env("PATH", path)
        .env("OMX_SPARKSHELL_LINES", "1")
        .env("OMX_SPARKSHELL_MODEL", "spark-test-model")
        .arg("sh")
        .arg("-c")
        .arg("printf 'one\ntwo\n'")
        .output()
        .expect("run sparkshell");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("- summary: command produced long output"));
    assert!(stdout.contains("- warnings: stderr was empty"));
    assert!(String::from_utf8_lossy(&output.stderr).is_empty());

    let args = fs::read_to_string(args_log).expect("args log");
    assert!(args.contains("exec"));
    assert!(args.contains("--model"));
    assert!(args.contains("spark-test-model"));

    let prompt = fs::read_to_string(prompt_log).expect("prompt log");
    assert!(prompt.contains("Command family: generic-shell"));
    assert!(prompt.contains("<<<STDOUT"));
    assert!(prompt.contains("one\ntwo"));

    let _ = fs::remove_dir_all(temp);
}

#[test]
fn summary_failure_falls_back_to_raw_output_with_notice() {
    let temp = unique_temp_dir("codex-fail");
    let codex = temp.join("codex");
    write_executable(
        &codex,
        "#!/bin/sh\nprintf '%s\n' 'bridge failed' >&2\nexit 9\n",
    );

    let path = format!(
        "{}:{}",
        temp.display(),
        env::var("PATH").unwrap_or_default()
    );
    let output = Command::new(sparkshell_bin())
        .env("PATH", path)
        .env("OMX_SPARKSHELL_LINES", "1")
        .arg("sh")
        .arg("-c")
        .arg("printf 'one\ntwo\n'; printf 'child-err\n' >&2")
        .output()
        .expect("run sparkshell");

    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout), "one\ntwo\n");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("child-err"));
    assert!(stderr.contains("summary unavailable"));

    let _ = fs::remove_dir_all(temp);
}

#[test]
fn summary_mode_preserves_child_exit_code() {
    let temp = unique_temp_dir("codex-exit");
    let codex = temp.join("codex");
    write_executable(
        &codex,
        "#!/bin/sh\nprintf '%s\n' '- failures: command exited non-zero'\n",
    );

    let path = format!(
        "{}:{}",
        temp.display(),
        env::var("PATH").unwrap_or_default()
    );
    let output = Command::new(sparkshell_bin())
        .env("PATH", path)
        .env("OMX_SPARKSHELL_LINES", "1")
        .arg("sh")
        .arg("-c")
        .arg("printf 'one\ntwo\n'; exit 7")
        .output()
        .expect("run sparkshell");

    assert_eq!(output.status.code(), Some(7));
    assert!(String::from_utf8_lossy(&output.stdout).contains("- failures: command exited non-zero"));
    assert!(String::from_utf8_lossy(&output.stderr).is_empty());

    let _ = fs::remove_dir_all(temp);
}

#[test]
fn tmux_pane_mode_captures_large_tail_and_summarizes() {
    let temp = unique_temp_dir("tmux-pane-summary");
    let tmux = temp.join("tmux");
    let codex = temp.join("codex");
    let args_log = temp.join("tmux-args.log");
    let prompt_log = temp.join("pane-prompt.log");

    write_executable(
        &tmux,
        &format!(
            "#!/bin/sh\nprintf '%s\n' \"$@\" > '{}'\nprintf 'line-1\nline-2\nline-3\nline-4\n'\n",
            args_log.display()
        ),
    );
    write_executable(
        &codex,
        &format!(
            "#!/bin/sh\ncat > '{}'\nprintf '%s\n' '- summary: tmux pane summarized' '- warnings: tail captured'\n",
            prompt_log.display()
        ),
    );

    let path = format!(
        "{}:{}",
        temp.display(),
        env::var("PATH").unwrap_or_default()
    );
    let output = Command::new(sparkshell_bin())
        .env("PATH", path)
        .env("OMX_SPARKSHELL_LINES", "1")
        .arg("--tmux-pane")
        .arg("%17")
        .arg("--tail-lines")
        .arg("400")
        .output()
        .expect("run sparkshell");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("- summary: tmux pane summarized"));
    assert!(stdout.contains("- warnings: tail captured"));

    let tmux_args = fs::read_to_string(args_log).expect("tmux args");
    assert!(tmux_args.contains("capture-pane"));
    assert!(tmux_args.contains("%17"));
    assert!(tmux_args.contains("-400"));

    let prompt = fs::read_to_string(prompt_log).expect("prompt log");
    assert!(prompt.contains("Command: tmux capture-pane"));
    assert!(prompt.contains("line-1"));

    let _ = fs::remove_dir_all(temp);
}
