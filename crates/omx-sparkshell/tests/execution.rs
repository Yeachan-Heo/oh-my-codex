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
    assert!(args.contains("model_reasoning_effort=\"low\""));

    let prompt = fs::read_to_string(prompt_log).expect("prompt log");
    assert!(prompt.contains("Command family: generic-shell"));
    assert!(prompt.contains("<<<STDOUT"));
    assert!(prompt.contains("one\ntwo"));

    let _ = fs::remove_dir_all(temp);
}

#[test]
fn summary_mode_injects_model_instructions_file_override() {
    let temp = unique_temp_dir("codex-instructions-file");
    let codex = temp.join("codex");
    let args_log = temp.join("args.log");
    let instructions_file = temp.join("sparkshell-lightweight-AGENTS.md");
    write_executable(
        &codex,
        &format!(
            "#!/bin/sh\nprintf '%s\n' \"$@\" > '{}'\nprintf '%s\n' '- summary: command produced long output'\n",
            args_log.display()
        ),
    );
    fs::write(&instructions_file, "# sparkshell instructions\n").expect("write instructions file");

    let path = format!(
        "{}:{}",
        temp.display(),
        env::var("PATH").unwrap_or_default()
    );
    let output = Command::new(sparkshell_bin())
        .env("PATH", path)
        .env("OMX_SPARKSHELL_LINES", "1")
        .env(
            "OMX_SPARKSHELL_MODEL_INSTRUCTIONS_FILE",
            instructions_file.display().to_string(),
        )
        .arg("sh")
        .arg("-c")
        .arg("printf 'one\ntwo\n'")
        .output()
        .expect("run sparkshell");

    assert!(output.status.success());
    let args = fs::read_to_string(args_log).expect("args log");
    assert!(args.contains("model_reasoning_effort=\"low\""));
    assert!(args.contains(&format!(
        "model_instructions_file=\"{}\"",
        instructions_file
            .display()
            .to_string()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
    )));

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
        .arg("/bin/sh")
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
fn summary_mode_retries_with_fallback_model_when_spark_is_unavailable() {
    let temp = unique_temp_dir("codex-fallback-model");
    let codex = temp.join("codex");
    let args_log = temp.join("args.log");
    write_executable(
        &codex,
        &format!(
            "#!/bin/sh
printf '%s\n' \"$@\" >> '{}'
model=''
prev=''
for arg in \"$@\"; do
  if [ \"$prev\" = '--model' ]; then model=\"$arg\"; fi
  prev=\"$arg\"
done
if [ \"$model\" = 'spark-test-model' ]; then
  printf '%s\n' 'rate limit exceeded for spark model' >&2
  exit 17
fi
printf '%s\n' '- summary: fallback model recovered summary'
",
            args_log.display()
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
        .env("OMX_SPARKSHELL_FALLBACK_MODEL", "frontier-test-model")
        .arg("sh")
        .arg("-c")
        .arg("printf 'one\ntwo\n'")
        .output()
        .expect("run sparkshell");

    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("fallback model recovered summary"));
    assert!(String::from_utf8_lossy(&output.stderr).is_empty());

    let args = fs::read_to_string(args_log).expect("args log");
    assert!(args.contains("spark-test-model"));
    assert!(args.contains("frontier-test-model"));

    let _ = fs::remove_dir_all(temp);
}

#[test]
fn summary_mode_reports_both_models_when_fallback_also_fails() {
    let temp = unique_temp_dir("codex-fallback-model-fail");
    let codex = temp.join("codex");
    write_executable(
        &codex,
        "#!/bin/sh
model=''
prev=''
for arg in \"$@\"; do
  if [ \"$prev\" = '--model' ]; then model=\"$arg\"; fi
  prev=\"$arg\"
done
if [ \"$model\" = 'spark-test-model' ]; then
  printf '%s\n' 'quota exhausted for spark model' >&2
  exit 17
fi
printf '%s\n' 'fallback backend unavailable' >&2
exit 29
",
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
        .env("OMX_SPARKSHELL_FALLBACK_MODEL", "frontier-test-model")
        .arg("sh")
        .arg("-c")
        .arg("printf 'one\ntwo\n'; printf 'child-err\n' >&2")
        .output()
        .expect("run sparkshell");

    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout), "one\ntwo\n");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("child-err"));
    assert!(stderr.contains("primary model `spark-test-model`"));
    assert!(stderr.contains("fallback model `frontier-test-model`"));

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

#[test]
fn raw_mode_keeps_boundary_output_without_summary() {
    let temp = unique_temp_dir("boundary-raw");
    let codex = temp.join("codex");
    let codex_log = temp.join("codex.log");
    write_executable(
        &codex,
        &format!(
            "#!/bin/sh
printf '%s\n' invoked > '{}'
exit 0
",
            codex_log.display()
        ),
    );

    let path = format!(
        "{}:{}",
        temp.display(),
        env::var("PATH").unwrap_or_default()
    );
    let output = Command::new(sparkshell_bin())
        .env("PATH", path)
        .env("OMX_SPARKSHELL_LINES", "2")
        .arg("sh")
        .arg("-c")
        .arg("printf 'one\ntwo\n'")
        .output()
        .expect("run sparkshell");

    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "one
two
"
    );
    assert!(
        !codex_log.exists(),
        "codex should not run at the raw/summary boundary"
    );

    let _ = fs::remove_dir_all(temp);
}

#[test]
fn summary_mode_uses_combined_stdout_and_stderr_threshold() {
    let temp = unique_temp_dir("combined-threshold");
    let codex = temp.join("codex");
    let prompt_log = temp.join("prompt.log");
    write_executable(
        &codex,
        &format!(
            "#!/bin/sh
cat > '{}'
printf '%s\n' '- summary: combined output exceeded threshold'
",
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
        .env("OMX_SPARKSHELL_LINES", "2")
        .arg("sh")
        .arg("-c")
        .arg("printf 'one\n' && printf 'warn\nextra\n' >&2")
        .output()
        .expect("run sparkshell");

    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("combined output exceeded threshold"));
    let prompt = fs::read_to_string(prompt_log).expect("prompt log");
    assert!(prompt.contains("<<<STDERR"));
    assert!(prompt.contains(
        "warn
extra"
    ));

    let _ = fs::remove_dir_all(temp);
}

#[test]
fn summary_failure_when_codex_is_missing_falls_back_to_raw_output() {
    let empty_path = unique_temp_dir("missing-codex");
    let output = Command::new(sparkshell_bin())
        .env("PATH", empty_path.display().to_string())
        .env("OMX_SPARKSHELL_LINES", "1")
        .arg("/bin/sh")
        .arg("-c")
        .arg("printf 'one\ntwo\n'; printf 'child-err\n' >&2")
        .output()
        .expect("run sparkshell");

    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "one
two
"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("child-err"));
    assert!(stderr.contains("summary unavailable"));

    let _ = fs::remove_dir_all(empty_path);
}

#[test]
fn tmux_pane_mode_uses_default_tail_lines_when_not_overridden() {
    let temp = unique_temp_dir("tmux-default-tail");
    let tmux = temp.join("tmux");
    let codex = temp.join("codex");
    let args_log = temp.join("tmux-args.log");
    write_executable(
        &tmux,
        &format!(
            "#!/bin/sh
printf '%s\n' \"$@\" > '{}'
printf 'line-1\nline-2\nline-3\n'
",
            args_log.display()
        ),
    );
    write_executable(
        &codex,
        "#!/bin/sh
printf '%s\n' '- summary: used default tmux tail'
",
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
        .arg("%21")
        .output()
        .expect("run sparkshell");

    assert!(output.status.success());
    let tmux_args = fs::read_to_string(args_log).expect("tmux args");
    assert!(tmux_args.contains("-200"));
    assert!(String::from_utf8_lossy(&output.stdout).contains("used default tmux tail"));

    let _ = fs::remove_dir_all(temp);
}
