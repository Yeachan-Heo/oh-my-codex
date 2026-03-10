use std::env;
use std::ffi::OsString;
use std::fs::{create_dir_all, read_to_string, remove_dir_all, remove_file, write};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const CODEX_BIN_ENV: &str = "OMX_EXPLORE_CODEX_BIN";
const INTERNAL_DIRECT_WRAPPER_FLAG: &str = "--internal-allowlist-direct";
const INTERNAL_SHELL_WRAPPER_FLAG: &str = "--internal-allowlist-shell";

const ALLOWED_DIRECT_COMMANDS: &[&str] = &[
    "rg", "grep", "ls", "find", "wc", "cat", "sed", "head", "tail", "pwd", "printf",
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct Args {
    cwd: PathBuf,
    prompt: String,
    prompt_file: PathBuf,
    spark_model: String,
    fallback_model: String,
}

#[derive(Debug)]
struct AttemptResult {
    status_code: i32,
    stdout: String,
    stderr: String,
    output_markdown: Option<String>,
}

#[derive(Debug)]
struct AllowlistEnvironment {
    bin_dir: PathBuf,
    shell_path: PathBuf,
    _root: TempDirGuard,
}

#[derive(Debug)]
struct TempDirGuard {
    path: PathBuf,
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = remove_dir_all(&self.path);
    }
}

fn main() {
    if let Err(error) = dispatch_main() {
        eprintln!("[omx explore] {}", error);
        std::process::exit(1);
    }
}

fn dispatch_main() -> Result<(), String> {
    let mut args = env::args_os().skip(1);
    match args.next() {
        Some(flag) if flag == INTERNAL_DIRECT_WRAPPER_FLAG => {
            run_internal_direct_wrapper(args)?;
            Ok(())
        }
        Some(flag) if flag == INTERNAL_SHELL_WRAPPER_FLAG => {
            run_internal_shell_wrapper(args)?;
            Ok(())
        }
        Some(first) => run_with_leading_arg(first, args),
        None => run(),
    }
}

fn run_with_leading_arg<I>(first: OsString, remaining: I) -> Result<(), String>
where
    I: Iterator<Item = OsString>,
{
    let args = std::iter::once(first).chain(remaining);
    run_with_args(args)
}

fn run() -> Result<(), String> {
    run_with_args(env::args_os().skip(1))
}

fn run_with_args<I>(args: I) -> Result<(), String>
where
    I: Iterator<Item = OsString>,
{
    let args = parse_args(args)?;
    let prompt_contract = read_to_string(&args.prompt_file)
        .map_err(|err| format!("failed to read explore prompt contract {}: {err}", args.prompt_file.display()))?;

    let spark_attempt = invoke_codex(&args, &args.spark_model, &prompt_contract)
        .map_err(|err| format!("spark attempt failed to launch: {err}"))?;
    if spark_attempt.status_code == 0 {
        print_attempt_output(spark_attempt)?;
        return Ok(());
    }

    eprintln!(
        "[omx explore] spark model `{}` unavailable or failed (exit {}). Falling back to `{}`.",
        args.spark_model, spark_attempt.status_code, args.fallback_model
    );
    if !spark_attempt.stderr.trim().is_empty() {
        eprintln!("[omx explore] spark stderr: {}", spark_attempt.stderr.trim());
    }

    let fallback_attempt = invoke_codex(&args, &args.fallback_model, &prompt_contract)
        .map_err(|err| format!("fallback attempt failed to launch: {err}"))?;
    if fallback_attempt.status_code == 0 {
        print_attempt_output(fallback_attempt)?;
        return Ok(());
    }

    Err(format!(
        "both spark (`{}`) and fallback (`{}`) attempts failed (codes {} / {}). Last stderr: {}",
        args.spark_model,
        args.fallback_model,
        spark_attempt.status_code,
        fallback_attempt.status_code,
        fallback_attempt.stderr.trim()
    ))
}

fn print_attempt_output(attempt: AttemptResult) -> Result<(), String> {
    if let Some(markdown) = attempt.output_markdown {
        print!("{}", markdown);
        return Ok(());
    }
    if !attempt.stdout.trim().is_empty() {
        print!("{}", attempt.stdout);
        return Ok(());
    }
    Err("codex completed successfully but produced no markdown output".to_string())
}

fn parse_args<I>(mut args: I) -> Result<Args, String>
where
    I: Iterator<Item = OsString>,
{
    let mut cwd: Option<PathBuf> = None;
    let mut prompt: Option<String> = None;
    let mut prompt_file: Option<PathBuf> = None;
    let mut spark_model: Option<String> = None;
    let mut fallback_model: Option<String> = None;

    while let Some(token) = args.next() {
        let token_str = token.to_string_lossy();
        match token_str.as_ref() {
            "--cwd" => cwd = Some(PathBuf::from(next_required(&mut args, "--cwd")?)),
            "--prompt" => prompt = Some(next_required(&mut args, "--prompt")?),
            "--prompt-file" => prompt_file = Some(PathBuf::from(next_required(&mut args, "--prompt-file")?)),
            "--model-spark" => spark_model = Some(next_required(&mut args, "--model-spark")?),
            "--model-fallback" => fallback_model = Some(next_required(&mut args, "--model-fallback")?),
            "--help" | "-h" => return Err(usage().to_string()),
            other => return Err(format!("unknown argument: {other}\n{}", usage())),
        }
    }

    let args = Args {
        cwd: cwd.ok_or_else(|| format!("missing --cwd\n{}", usage()))?,
        prompt: prompt.ok_or_else(|| format!("missing --prompt\n{}", usage()))?,
        prompt_file: prompt_file.ok_or_else(|| format!("missing --prompt-file\n{}", usage()))?,
        spark_model: spark_model.ok_or_else(|| format!("missing --model-spark\n{}", usage()))?,
        fallback_model: fallback_model.ok_or_else(|| format!("missing --model-fallback\n{}", usage()))?,
    };

    Ok(args)
}

fn next_required<I>(args: &mut I, flag: &str) -> Result<String, String>
where
    I: Iterator<Item = OsString>,
{
    args.next()
        .map(|value| value.to_string_lossy().trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("missing value after {flag}\n{}", usage()))
}

fn usage() -> &'static str {
    "Usage: omx-explore --cwd <dir> --prompt <text> --prompt-file <explore-prompt.md> --model-spark <model> --model-fallback <model>"
}

fn invoke_codex(args: &Args, model: &str, prompt_contract: &str) -> io::Result<AttemptResult> {
    let codex_binary = resolve_codex_binary();
    let allowlist = prepare_allowlist_environment().map_err(io::Error::other)?;
    let output_path = temp_output_path();
    let final_prompt = compose_exec_prompt(&args.prompt, prompt_contract);
    let mut command = Command::new(&codex_binary);
    command
        .arg("exec")
        .arg("-C")
        .arg(&args.cwd)
        .arg("-m")
        .arg(model)
        .arg("-s")
        .arg("read-only")
        .arg("-c")
        .arg("model_reasoning_effort=\"low\"")
        .arg("-c")
        .arg("shell_environment_policy.inherit=all")
        .arg("--skip-git-repo-check")
        .arg("-o")
        .arg(&output_path)
        .arg(&final_prompt)
        .env("PATH", &allowlist.bin_dir)
        .env("SHELL", &allowlist.shell_path);
    let output = command.output()?;

    let markdown = read_to_string(&output_path).ok();
    let _ = remove_file(&output_path);
    Ok(AttemptResult {
        status_code: output.status.code().unwrap_or(1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        output_markdown: markdown,
    })
}

fn resolve_codex_binary() -> String {
    if let Some(value) = env::var(CODEX_BIN_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        if value.contains(std::path::MAIN_SEPARATOR) {
            return value;
        }
        if let Some(path) = resolve_host_command(&value) {
            return path.display().to_string();
        }
        return value;
    }

    resolve_host_command("codex")
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "codex".to_string())
}

fn temp_output_path() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    env::temp_dir().join(format!("omx-explore-{}-{}.md", std::process::id(), nanos))
}

fn compose_exec_prompt(user_prompt: &str, prompt_contract: &str) -> String {
    format!(
        concat!(
            "You are OMX Explore, a low-cost read-only repository exploration harness.\\n",
            "Operate strictly in read-only mode. You may use repository-inspection shell commands only.\\n",
            "Preferred commands: rg, grep, and tightly bounded read-only bash wrappers over rg/grep/ls/find/wc/cat/sed/head/tail.\\n",
            "Do not write, delete, rename, or modify files. Do not run git commands that alter working state.\\n",
            "Always return markdown only.\\n\\n",
            "Reference behavior contract:\\n",
            "---------------- BEGIN EXPLORE PROMPT ----------------\\n{}\\n---------------- END EXPLORE PROMPT ----------------\\n\\n",
            "User request:\\n{}\\n"
        ),
        prompt_contract,
        user_prompt
    )
}

fn prepare_allowlist_environment() -> Result<AllowlistEnvironment, String> {
    let root = temp_allowlist_dir()?;
    let bin_dir = root.path.join("bin");
    create_dir_all(&bin_dir)
        .map_err(|err| format!("failed to create allowlist bin dir {}: {err}", bin_dir.display()))?;

    let self_exe = env::current_exe()
        .map_err(|err| format!("failed to resolve current executable for allowlist wrappers: {err}"))?;
    let bash_path = resolve_host_command("bash")
        .ok_or_else(|| "failed to locate host bash for allowlist wrapper".to_string())?;
    let sh_path = resolve_host_command("sh")
        .ok_or_else(|| "failed to locate host sh for allowlist wrapper".to_string())?;

    for command in ALLOWED_DIRECT_COMMANDS {
        let real = resolve_host_command(command)
            .ok_or_else(|| format!("failed to locate host command `{command}` for allowlist wrapper"))?;
        let wrapper_path = bin_dir.join(command);
        let wrapper = format!(
            "#!/bin/sh\nexec {} {} {} \"$@\"\n",
            shell_quote(&self_exe.display().to_string()),
            shell_quote(INTERNAL_DIRECT_WRAPPER_FLAG),
            shell_quote(&format!("{command}:{}", real.display())),
        );
        write_executable(&wrapper_path, &wrapper)?;
    }

    let bash_wrapper = format!(
        "#!/bin/sh\nexec {} {} {} \"$@\"\n",
        shell_quote(&self_exe.display().to_string()),
        shell_quote(INTERNAL_SHELL_WRAPPER_FLAG),
        shell_quote(&bash_path.display().to_string()),
    );
    let sh_wrapper = format!(
        "#!/bin/sh\nexec {} {} {} \"$@\"\n",
        shell_quote(&self_exe.display().to_string()),
        shell_quote(INTERNAL_SHELL_WRAPPER_FLAG),
        shell_quote(&sh_path.display().to_string()),
    );
    let shell_path = bin_dir.join("bash");
    write_executable(&shell_path, &bash_wrapper)?;
    write_executable(&bin_dir.join("sh"), &sh_wrapper)?;

    Ok(AllowlistEnvironment {
        bin_dir,
        shell_path,
        _root: root,
    })
}

fn temp_allowlist_dir() -> Result<TempDirGuard, String> {
    let dir = env::temp_dir().join(format!(
        "omx-explore-allowlist-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    create_dir_all(&dir)
        .map_err(|err| format!("failed to create allowlist dir {}: {err}", dir.display()))?;
    Ok(TempDirGuard { path: dir })
}

fn write_executable(path: &Path, content: &str) -> Result<(), String> {
    write(path, content).map_err(|err| format!("failed to write wrapper {}: {err}", path.display()))?;
    #[cfg(unix)]
    {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path)
            .map_err(|err| format!("failed to stat wrapper {}: {err}", path.display()))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms)
            .map_err(|err| format!("failed to chmod wrapper {}: {err}", path.display()))?;
    }
    Ok(())
}

fn resolve_host_command(command: &str) -> Option<PathBuf> {
    let candidate = Path::new(command);
    if candidate.is_absolute() && candidate.exists() {
        return Some(candidate.to_path_buf());
    }

    let path = env::var_os("PATH")?;
    for entry in env::split_paths(&path) {
        let resolved = entry.join(command);
        if resolved.exists() {
            return Some(resolved);
        }
    }
    None
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn run_internal_direct_wrapper<I>(mut args: I) -> Result<(), String>
where
    I: Iterator<Item = OsString>,
{
    let spec = args
        .next()
        .ok_or_else(|| "missing direct wrapper spec".to_string())?;
    let spec = spec.to_string_lossy();
    let (command_name, real_path) = spec
        .split_once(':')
        .ok_or_else(|| format!("invalid direct wrapper spec: {spec}"))?;
    let forwarded: Vec<String> = args.map(|arg| arg.to_string_lossy().into_owned()).collect();
    validate_direct_command(command_name, &forwarded)?;

    let status = Command::new(real_path)
        .args(&forwarded)
        .status()
        .map_err(|err| format!("failed to execute allowlisted `{command_name}`: {err}"))?;
    std::process::exit(status.code().unwrap_or(1));
}

fn run_internal_shell_wrapper<I>(mut args: I) -> Result<(), String>
where
    I: Iterator<Item = OsString>,
{
    let real_shell = args
        .next()
        .ok_or_else(|| "missing real shell path for internal wrapper".to_string())?;
    let real_shell = real_shell.to_string_lossy().into_owned();
    let forwarded: Vec<String> = args.map(|arg| arg.to_string_lossy().into_owned()).collect();
    let command = validate_shell_invocation(&forwarded)?;

    let mut child = Command::new(&real_shell);
    if real_shell.ends_with("bash") {
        child.arg("--noprofile").arg("--norc");
    }
    let status = child
        .arg("-lc")
        .arg(&command)
        .status()
        .map_err(|err| format!("failed to execute validated shell command: {err}"))?;
    std::process::exit(status.code().unwrap_or(1));
}

fn validate_shell_invocation(args: &[String]) -> Result<String, String> {
    if args.len() != 2 {
        return Err(format!(
            "shell wrapper only accepts a single `-c` or `-lc` command, received {:?}",
            args
        ));
    }
    if args[0] != "-c" && args[0] != "-lc" {
        return Err(format!(
            "shell wrapper only accepts `-c` or `-lc`, received `{}`",
            args[0]
        ));
    }

    let command = args[1].trim();
    if command.is_empty() {
        return Err("shell wrapper received an empty command".to_string());
    }

    for fragment in ["\n", "\r", "&&", "||", ";", "|", ">", "<", "`", "$(", "${"] {
        if command.contains(fragment) {
            return Err(format!(
                "shell wrapper rejected disallowed fragment `{fragment}` in `{command}`"
            ));
        }
    }

    let tokens: Vec<String> = command
        .split_whitespace()
        .map(|token| token.trim_matches(['"', '\'']).to_string())
        .filter(|token| !token.is_empty())
        .collect();
    let first = tokens
        .first()
        .ok_or_else(|| "shell wrapper could not determine the command name".to_string())?;
    if first.contains('/') {
        return Err(format!(
            "shell wrapper rejected path-qualified command `{first}`; use allowlisted bare commands only"
        ));
    }

    validate_direct_command(first, &tokens[1..])?;
    Ok(command.to_string())
}

fn validate_direct_command(command_name: &str, args: &[String]) -> Result<(), String> {
    if !ALLOWED_DIRECT_COMMANDS.contains(&command_name) {
        return Err(format!("command `{command_name}` is not on the omx explore allowlist"));
    }

    match command_name {
        "rg" => {
            if args.iter().any(|arg| arg == "--pre" || arg.starts_with("--pre=")) {
                return Err("ripgrep `--pre` is not allowed in omx explore".to_string());
            }
        }
        "find" => {
            if args.iter().any(|arg| {
                matches!(
                    arg.as_str(),
                    "-exec" | "-execdir" | "-ok" | "-okdir" | "-delete"
                )
            }) {
                return Err("find actions that execute or delete are not allowed in omx explore".to_string());
            }
        }
        "sed" => {
            if args.iter().any(|arg| arg == "-i" || arg.starts_with("-i") || arg == "--in-place")
            {
                return Err("sed in-place editing is not allowed in omx explore".to_string());
            }
            if !args.iter().any(|arg| arg == "-n") {
                return Err("sed is only allowed with `-n` in omx explore".to_string());
            }
        }
        _ => {}
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_requires_all_fields() {
        let result = parse_args(vec![OsString::from("--cwd")].into_iter());
        assert!(result.is_err());
    }

    #[test]
    fn parse_args_accepts_full_contract() {
        let args = parse_args(
            vec![
                "--cwd",
                "/tmp/repo",
                "--prompt",
                "find auth",
                "--prompt-file",
                "/tmp/explore.md",
                "--model-spark",
                "gpt-5.3-codex-spark",
                "--model-fallback",
                "gpt-5.4",
            ]
            .into_iter()
            .map(OsString::from),
        )
        .expect("args");

        assert_eq!(args.cwd, Path::new("/tmp/repo"));
        assert_eq!(args.prompt, "find auth");
        assert_eq!(args.prompt_file, Path::new("/tmp/explore.md"));
        assert_eq!(args.spark_model, "gpt-5.3-codex-spark");
        assert_eq!(args.fallback_model, "gpt-5.4");
    }

    #[test]
    fn compose_exec_prompt_mentions_read_only_constraints() {
        let prompt = compose_exec_prompt("find auth", "contract body");
        assert!(prompt.contains("read-only repository exploration harness"));
        assert!(prompt.contains("Preferred commands: rg, grep"));
        assert!(prompt.contains("Always return markdown only"));
        assert!(prompt.contains("contract body"));
        assert!(prompt.contains("find auth"));
    }

    #[test]
    fn resolve_codex_binary_prefers_env_override() {
        unsafe {
            env::set_var(CODEX_BIN_ENV, "/tmp/codex-stub");
        }
        assert_eq!(resolve_codex_binary(), "/tmp/codex-stub");
        unsafe {
            env::remove_var(CODEX_BIN_ENV);
        }
    }

    #[test]
    fn validate_shell_invocation_rejects_control_operators_and_paths() {
        assert!(validate_shell_invocation(&["-lc".into(), "rg auth src".into()]).is_ok());
        assert!(validate_shell_invocation(&["-lc".into(), "rg auth src | head".into()]).is_err());
        assert!(validate_shell_invocation(&["-lc".into(), "/usr/bin/rg auth src".into()]).is_err());
        assert!(validate_shell_invocation(&["-lc".into(), "find . -exec rm {} +".into()]).is_err());
    }

    #[test]
    fn validate_direct_command_blocks_risky_flags() {
        assert!(validate_direct_command("rg", &["needle".into(), "src".into()]).is_ok());
        assert!(validate_direct_command("rg", &["--pre=python".into(), "needle".into()]).is_err());
        assert!(validate_direct_command("find", &[".".into(), "-type".into(), "f".into()]).is_ok());
        assert!(validate_direct_command("find", &[".".into(), "-delete".into()]).is_err());
        assert!(validate_direct_command("sed", &["-n".into(), "1,20p".into(), "README.md".into()]).is_ok());
        assert!(validate_direct_command("sed", &["-i".into(), "s/x/y/".into(), "README.md".into()]).is_err());
    }
}
