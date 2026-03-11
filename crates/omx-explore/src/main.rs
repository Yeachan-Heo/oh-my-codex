use std::env;
use std::ffi::OsString;
use std::fs::{
    canonicalize, create_dir_all, read_to_string, remove_dir_all, remove_file, write, File,
};
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const CODEX_BIN_ENV: &str = "OMX_EXPLORE_CODEX_BIN";
const HARNESS_ROOT_ENV: &str = "OMX_EXPLORE_ROOT";
const INTERNAL_DIRECT_WRAPPER_FLAG: &str = "--internal-allowlist-direct";
const INTERNAL_SHELL_WRAPPER_FLAG: &str = "--internal-allowlist-shell";

const ALLOWED_DIRECT_COMMANDS: &[&str] = &[
    "rg", "grep", "ls", "find", "wc", "cat", "head", "tail", "pwd", "printf",
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
    let prompt_contract = read_to_string(&args.prompt_file).map_err(|err| {
        format!(
            "failed to read explore prompt contract {}: {err}",
            args.prompt_file.display()
        )
    })?;

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
        eprintln!(
            "[omx explore] spark stderr: {}",
            spark_attempt.stderr.trim()
        );
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
    Err(
        "codex completed successfully but did not produce the expected markdown output artifact"
            .to_string(),
    )
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
            "--prompt-file" => {
                prompt_file = Some(PathBuf::from(next_required(&mut args, "--prompt-file")?))
            }
            "--model-spark" => spark_model = Some(next_required(&mut args, "--model-spark")?),
            "--model-fallback" => {
                fallback_model = Some(next_required(&mut args, "--model-fallback")?)
            }
            "--help" | "-h" => return Err(usage().to_string()),
            other => return Err(format!("unknown argument: {other}\n{}", usage())),
        }
    }

    let args = Args {
        cwd: cwd.ok_or_else(|| format!("missing --cwd\n{}", usage()))?,
        prompt: prompt.ok_or_else(|| format!("missing --prompt\n{}", usage()))?,
        prompt_file: prompt_file.ok_or_else(|| format!("missing --prompt-file\n{}", usage()))?,
        spark_model: spark_model.ok_or_else(|| format!("missing --model-spark\n{}", usage()))?,
        fallback_model: fallback_model
            .ok_or_else(|| format!("missing --model-fallback\n{}", usage()))?,
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
    let codex_launch = resolve_codex_launch();
    let allowlist = prepare_allowlist_environment().map_err(io::Error::other)?;
    let output_path = temp_output_path();
    let final_prompt = compose_exec_prompt(&args.prompt, prompt_contract);
    let mut command = Command::new(&codex_launch.program);
    command.args(&codex_launch.leading_args);
    command
        .arg("exec")
        .arg("-C")
        .arg(&args.cwd)
        .args(codex_support_dir_args())
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
        .env(HARNESS_ROOT_ENV, &args.cwd)
        .env("PATH", &allowlist.bin_dir)
        .env("SHELL", &allowlist.shell_path);
    let output = command.output()?;

    let markdown = read_to_string(&output_path).ok();
    let _ = remove_file(&output_path);
    Ok(AttemptResult {
        status_code: output.status.code().unwrap_or(1),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        output_markdown: markdown,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CodexLaunch {
    program: String,
    leading_args: Vec<String>,
}

fn resolve_codex_launch() -> CodexLaunch {
    let codex_binary = resolve_codex_binary();
    codex_launch_for_binary(&codex_binary).unwrap_or_else(|| CodexLaunch {
        program: codex_binary,
        leading_args: Vec::new(),
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

fn codex_launch_for_binary(codex_binary: &str) -> Option<CodexLaunch> {
    let interpreter = read_shebang_interpreter(Path::new(codex_binary))?;
    let (program, mut leading_args) = resolve_shebang_launch(&interpreter)?;
    leading_args.push(codex_binary.to_string());
    Some(CodexLaunch {
        program,
        leading_args,
    })
}

fn read_shebang_interpreter(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut first_line = String::new();
    if reader.read_line(&mut first_line).ok()? == 0 {
        return None;
    }
    first_line
        .strip_prefix("#!")
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

fn resolve_shebang_launch(shebang: &str) -> Option<(String, Vec<String>)> {
    let parts: Vec<&str> = shebang.split_whitespace().collect();
    let interpreter = *parts.first()?;
    if interpreter.ends_with("/env") {
        let target = parts.get(1).copied()?;
        let resolved = resolve_host_command(target)?;
        return Some((
            resolved.display().to_string(),
            parts
                .iter()
                .skip(2)
                .map(|part| (*part).to_string())
                .collect(),
        ));
    }

    Some((
        interpreter.to_string(),
        parts
            .iter()
            .skip(1)
            .map(|part| (*part).to_string())
            .collect(),
    ))
}

fn codex_support_dir_args() -> Vec<String> {
    discover_codex_support_dirs()
        .into_iter()
        .flat_map(|dir| ["--add-dir".to_string(), dir.display().to_string()])
        .collect()
}

fn discover_codex_support_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = env::var_os("HOME").filter(|value| !value.is_empty()) {
        let home = PathBuf::from(home);
        for relative in [".omx", ".codex"] {
            let dir = home.join(relative);
            if dir.is_dir() {
                dirs.push(dir);
            }
        }
    }
    dirs
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
            "Preferred commands: rg, grep, and tightly bounded read-only bash wrappers over rg/grep/ls/find/wc/cat/head/tail.\\n",
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
    create_dir_all(&bin_dir).map_err(|err| {
        format!(
            "failed to create allowlist bin dir {}: {err}",
            bin_dir.display()
        )
    })?;

    let self_exe = env::current_exe().map_err(|err| {
        format!("failed to resolve current executable for allowlist wrappers: {err}")
    })?;
    let bash_path = resolve_host_command("bash")
        .ok_or_else(|| "failed to locate host bash for allowlist wrapper".to_string())?;
    let sh_path = resolve_host_command("sh")
        .ok_or_else(|| "failed to locate host sh for allowlist wrapper".to_string())?;

    for command in ALLOWED_DIRECT_COMMANDS {
        let real = resolve_host_command(command).ok_or_else(|| {
            format!("failed to locate host command `{command}` for allowlist wrapper")
        })?;
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
    write(path, content)
        .map_err(|err| format!("failed to write wrapper {}: {err}", path.display()))?;
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
        return Err(format!(
            "command `{command_name}` is not on the omx explore allowlist"
        ));
    }

    match command_name {
        "rg" => {
            if args
                .iter()
                .any(|arg| arg == "--pre" || arg.starts_with("--pre="))
            {
                return Err("ripgrep `--pre` is not allowed in omx explore".to_string());
            }
            if args.iter().any(|arg| arg == "-") {
                return Err("ripgrep stdin (`-`) is not allowed in omx explore".to_string());
            }
        }
        "grep" => {
            if args.iter().any(|arg| arg == "-") {
                return Err("grep stdin (`-`) is not allowed in omx explore".to_string());
            }
            if non_option_operands(args).len() < 2 {
                return Err(
                    "grep requires a pattern and at least one file/path in omx explore".to_string(),
                );
            }
        }
        "find" => {
            if args.iter().any(|arg| {
                matches!(
                    arg.as_str(),
                    "-exec"
                        | "-execdir"
                        | "-ok"
                        | "-okdir"
                        | "-delete"
                        | "-fprint"
                        | "-fprint0"
                        | "-fprintf"
                        | "-fls"
                )
            }) {
                return Err(
                    "find actions that execute, delete, or write files are not allowed in omx explore"
                        .to_string(),
                );
            }
        }
        "cat" => {
            let operands = non_option_operands(args);
            if operands.is_empty() {
                return Err("cat requires at least one file/path in omx explore".to_string());
            }
            if operands.iter().any(|arg| *arg == "-") {
                return Err("cat stdin (`-`) is not allowed in omx explore".to_string());
            }
        }
        "head" | "wc" => {
            let operands = non_option_operands(args);
            if operands.is_empty() {
                return Err(format!(
                    "{command_name} requires at least one file/path in omx explore"
                ));
            }
            if operands.iter().any(|arg| *arg == "-") {
                return Err(format!(
                    "{command_name} stdin (`-`) is not allowed in omx explore"
                ));
            }
        }
        "tail" => {
            let operands = non_option_operands(args);
            if operands.is_empty() {
                return Err("tail requires at least one file/path in omx explore".to_string());
            }
            if operands.iter().any(|arg| *arg == "-") {
                return Err("tail stdin (`-`) is not allowed in omx explore".to_string());
            }
            if args.iter().any(|arg| {
                matches!(arg.as_str(), "-f" | "-F" | "--retry") || arg.starts_with("--follow")
            }) {
                return Err("tail follow/retry modes are not allowed in omx explore".to_string());
            }
        }
        _ => {}
    }

    validate_repo_paths(command_name, args)?;
    Ok(())
}

fn non_option_operands(args: &[String]) -> Vec<&str> {
    let mut operands = Vec::new();
    let mut after_double_dash = false;
    for arg in args {
        if after_double_dash {
            operands.push(arg.as_str());
            continue;
        }
        if arg == "--" {
            after_double_dash = true;
            continue;
        }
        if arg.starts_with('-') && arg != "-" {
            continue;
        }
        operands.push(arg.as_str());
    }
    operands
}

fn validate_repo_paths(command_name: &str, args: &[String]) -> Result<(), String> {
    let Some(repo_root) = env::var_os(HARNESS_ROOT_ENV).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let repo_root = normalize_path(PathBuf::from(repo_root));
    let canonical_repo_root = canonicalize_existing_prefix(&repo_root);
    let candidate_paths = command_path_operands(command_name, args);
    for operand in candidate_paths {
        let normalized = normalize_candidate_path(&repo_root, operand);
        if !normalized.starts_with(&repo_root) {
            return Err(format!(
                "path `{operand}` escapes the omx explore repository root {}",
                repo_root.display()
            ));
        }
        if let Some(canonical_candidate) = canonicalize_existing_prefix(&normalized) {
            if let Some(canonical_repo_root) = &canonical_repo_root {
                if !canonical_candidate.starts_with(canonical_repo_root) {
                    return Err(format!(
                        "path `{operand}` resolves outside the omx explore repository root {}",
                        canonical_repo_root.display()
                    ));
                }
            }
        }
    }
    Ok(())
}

fn command_path_operands<'a>(command_name: &str, args: &'a [String]) -> Vec<&'a str> {
    let operands = non_option_operands(args);
    match command_name {
        "rg" => operands.into_iter().skip(1).collect(),
        "grep" => operands.into_iter().skip(1).collect(),
        "find" => {
            let mut paths = Vec::new();
            for arg in args {
                let value = arg.as_str();
                if matches!(value, "!" | "(" | ")") || value.starts_with('-') {
                    break;
                }
                paths.push(value);
            }
            paths
        }
        "ls" | "cat" | "head" | "tail" | "wc" => operands,
        _ => Vec::new(),
    }
}

fn normalize_candidate_path(repo_root: &Path, operand: &str) -> PathBuf {
    let candidate = Path::new(operand);
    if candidate.is_absolute() {
        normalize_path(candidate.to_path_buf())
    } else {
        normalize_path(repo_root.join(candidate))
    }
}

fn normalize_path(path: PathBuf) -> PathBuf {
    use std::path::Component;

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::RootDir | Component::Prefix(_) | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    normalized
}

fn canonicalize_existing_prefix(path: &Path) -> Option<PathBuf> {
    let mut probe = path;
    let mut suffix: Vec<&std::ffi::OsStr> = Vec::new();

    loop {
        if probe.exists() {
            let mut canonical = canonicalize(probe).ok()?;
            for segment in suffix.iter().rev() {
                canonical.push(segment);
            }
            return Some(normalize_path(canonical));
        }
        let name = probe.file_name()?;
        suffix.push(name);
        probe = probe.parent()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .expect("env lock")
    }

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
        let _guard = env_lock();
        unsafe {
            env::set_var(CODEX_BIN_ENV, "/tmp/codex-stub");
        }
        assert_eq!(resolve_codex_binary(), "/tmp/codex-stub");
        unsafe {
            env::remove_var(CODEX_BIN_ENV);
        }
    }

    #[test]
    fn resolve_codex_binary_resolves_bare_env_override_from_path() {
        let _guard = env_lock();
        let root = temp_allowlist_dir().expect("temp root");
        let bin_dir = root.path.join("bin");
        create_dir_all(&bin_dir).expect("create bin");
        let fake_codex = bin_dir.join("codex-custom");
        write(&fake_codex, b"#!/bin/sh\nexit 0\n").expect("write fake codex");
        write_executable(&fake_codex, "#!/bin/sh\nexit 0\n").expect("chmod fake codex");

        let original_path = env::var_os("PATH");
        unsafe {
            env::set_var(CODEX_BIN_ENV, "codex-custom");
            env::set_var("PATH", &bin_dir);
        }

        let resolved = resolve_codex_binary();

        unsafe {
            env::remove_var(CODEX_BIN_ENV);
        }
        match original_path {
            Some(value) => unsafe { env::set_var("PATH", value) },
            None => unsafe { env::remove_var("PATH") },
        }

        assert_eq!(resolved, fake_codex.display().to_string());
    }

    #[test]
    fn codex_launch_for_env_node_shebang_uses_host_node_absolute_path() {
        let root = temp_allowlist_dir().expect("temp root");
        let script_path = root.path.join("codex-script");
        write(&script_path, b"#!/usr/bin/env node\nconsole.log(\"ok\");\n").expect("write script");

        let launch = codex_launch_for_binary(script_path.to_str().expect("script path"))
            .expect("launch config");
        let expected_node = resolve_host_command("node").expect("host node path");
        assert_eq!(launch.program, expected_node.display().to_string());
        assert_eq!(launch.leading_args, vec![script_path.display().to_string()]);
    }

    #[test]
    fn discover_codex_support_dirs_includes_home_omx_and_codex_when_present() {
        let _guard = env_lock();
        let root = temp_allowlist_dir().expect("temp root");
        let home_dir = root.path.join("home");
        create_dir_all(home_dir.join(".omx")).expect("create .omx");
        create_dir_all(home_dir.join(".codex")).expect("create .codex");
        let original_home = env::var_os("HOME");
        unsafe {
            env::set_var("HOME", &home_dir);
        }

        let dirs = discover_codex_support_dirs();

        match original_home {
            Some(value) => unsafe { env::set_var("HOME", value) },
            None => unsafe { env::remove_var("HOME") },
        }
        assert_eq!(dirs, vec![home_dir.join(".omx"), home_dir.join(".codex")]);
    }

    #[test]
    fn validate_shell_invocation_rejects_control_operators_and_paths() {
        assert!(validate_shell_invocation(&["-lc".into(), "rg auth src".into()]).is_ok());
        assert!(validate_shell_invocation(&["-lc".into(), "rg auth src | head".into()]).is_err());
        assert!(validate_shell_invocation(&["-lc".into(), "/usr/bin/rg auth src".into()]).is_err());
        assert!(validate_shell_invocation(&["-lc".into(), "find . -exec rm {} +".into()]).is_err());
        assert!(validate_shell_invocation(&["-lc".into(), "tail -f README.md".into()]).is_err());
        assert!(
            validate_shell_invocation(&["-lc".into(), "sed -n 1,5p README.md".into()]).is_err()
        );
    }

    #[test]
    fn validate_direct_command_blocks_risky_flags() {
        assert!(validate_direct_command("rg", &["needle".into(), "src".into()]).is_ok());
        assert!(validate_direct_command("rg", &["--pre=python".into(), "needle".into()]).is_err());
        assert!(validate_direct_command("rg", &["needle".into(), "-".into()]).is_err());
        assert!(validate_direct_command("grep", &["needle".into(), "src/file.ts".into()]).is_ok());
        assert!(validate_direct_command("grep", &["needle".into()]).is_err());
        assert!(validate_direct_command("grep", &["needle".into(), "-".into()]).is_err());
        assert!(validate_direct_command("find", &[".".into(), "-type".into(), "f".into()]).is_ok());
        assert!(validate_direct_command("find", &[".".into(), "-delete".into()]).is_err());
        assert!(validate_direct_command(
            "find",
            &[".".into(), "-fprint".into(), "/tmp/out".into()]
        )
        .is_err());
        assert!(validate_direct_command("cat", &["README.md".into()]).is_ok());
        assert!(validate_direct_command("cat", &[]).is_err());
        assert!(validate_direct_command("cat", &["-".into()]).is_err());
        assert!(validate_direct_command("head", &["README.md".into()]).is_ok());
        assert!(validate_direct_command("head", &[]).is_err());
        assert!(validate_direct_command("wc", &["README.md".into()]).is_ok());
        assert!(validate_direct_command("wc", &["-".into()]).is_err());
        assert!(validate_direct_command("tail", &["README.md".into()]).is_ok());
        assert!(validate_direct_command("tail", &[]).is_err());
        assert!(validate_direct_command("tail", &["-f".into(), "README.md".into()]).is_err());
        assert!(
            validate_direct_command("sed", &["-n".into(), "1,20p".into(), "README.md".into()])
                .is_err()
        );
    }

    #[test]
    fn validate_direct_command_covers_additional_head_wc_and_tail_rejections() {
        assert!(validate_direct_command("head", &["-".into()]).is_err());
        assert!(validate_direct_command("wc", &[]).is_err());
        assert!(validate_direct_command("tail", &["--retry".into(), "README.md".into()]).is_err());
    }

    #[test]
    fn validate_direct_command_blocks_repo_escape_paths() {
        let _guard = env_lock();
        unsafe {
            env::set_var(HARNESS_ROOT_ENV, "/repo");
        }
        assert!(validate_direct_command("cat", &["README.md".into()]).is_ok());
        assert!(validate_direct_command("ls", &["src".into()]).is_ok());
        assert!(validate_direct_command("rg", &["needle".into(), "src".into()]).is_ok());
        assert!(
            validate_direct_command("grep", &["needle".into(), "../secret.txt".into()]).is_err()
        );
        assert!(validate_direct_command("cat", &["../secret.txt".into()]).is_err());
        assert!(
            validate_direct_command("find", &["../".into(), "-type".into(), "f".into()]).is_err()
        );
        assert!(validate_direct_command("ls", &["/tmp".into()]).is_err());
        unsafe {
            env::remove_var(HARNESS_ROOT_ENV);
        }
    }

    #[cfg(unix)]
    #[test]
    fn validate_direct_command_blocks_symlink_escape_paths() {
        let _guard = env_lock();
        use std::os::unix::fs::symlink;

        let root = temp_allowlist_dir().expect("temp root");
        let repo = root.path.join("repo");
        let outside = root.path.join("outside");
        create_dir_all(&repo).expect("create repo");
        create_dir_all(&outside).expect("create outside");
        write(outside.join("secret.txt"), "secret").expect("write secret");
        symlink(&outside, repo.join("linked-outside")).expect("create symlink");

        unsafe {
            env::set_var(HARNESS_ROOT_ENV, &repo);
        }
        let result = validate_direct_command("cat", &["linked-outside/secret.txt".into()]);
        unsafe {
            env::remove_var(HARNESS_ROOT_ENV);
        }

        assert!(result.is_err());
        assert!(result
            .expect_err("symlink escape should fail")
            .contains("resolves outside"));
    }

    #[test]
    fn resolve_shebang_launch_preserves_env_arguments() {
        let python = resolve_host_command("python3")
            .or_else(|| resolve_host_command("python"))
            .expect("host python path");
        let launch = resolve_shebang_launch("/usr/bin/env python3 -I").expect("launch");
        assert_eq!(launch.0, python.display().to_string());
        assert_eq!(launch.1, vec!["-I"]);
    }

    #[test]
    fn validate_shell_invocation_rejects_empty_and_wrong_flag_forms() {
        assert!(validate_shell_invocation(&["-lc".into(), "   ".into()]).is_err());
        assert!(validate_shell_invocation(&["--command".into(), "rg auth src".into()]).is_err());
        assert!(validate_shell_invocation(&["-c".into()]).is_err());
    }

    #[test]
    fn validate_direct_command_accepts_repo_internal_absolute_paths() {
        let _guard = env_lock();
        let root = temp_allowlist_dir().expect("temp root");
        let repo = root.path.join("repo");
        create_dir_all(repo.join("nested")).expect("create repo");
        write(repo.join("nested").join("file.txt"), "ok").expect("write file");

        unsafe {
            env::set_var(HARNESS_ROOT_ENV, &repo);
        }
        let result = validate_direct_command(
            "cat",
            &[repo.join("nested").join("file.txt").display().to_string()],
        );
        unsafe {
            env::remove_var(HARNESS_ROOT_ENV);
        }

        assert!(result.is_ok());
    }

    #[test]
    fn command_path_operands_handle_double_dash_and_find_roots() {
        let rg_args = vec![
            "needle".to_string(),
            "--".to_string(),
            "src/lib.rs".to_string(),
        ];
        assert_eq!(command_path_operands("rg", &rg_args), vec!["src/lib.rs"]);

        let find_args = vec![
            "src".to_string(),
            "tests".to_string(),
            "-type".to_string(),
            "f".to_string(),
        ];
        assert_eq!(
            command_path_operands("find", &find_args),
            vec!["src", "tests"]
        );
    }

    #[test]
    fn run_with_args_reports_both_failed_attempts_with_codes_and_stderr() {
        let _guard = env_lock();
        let root = temp_allowlist_dir().expect("temp root");
        let repo = root.path.join("repo");
        create_dir_all(&repo).expect("create repo");
        let prompt_file = root.path.join("prompt.md");
        write(&prompt_file, "contract").expect("write prompt");
        let fake_codex = root.path.join("codex-stub");
        write_executable(
            &fake_codex,
            r#"#!/bin/sh
model=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-m" ]; then
    shift
    model="$1"
  fi
  shift
done
printf 'simulated stderr for %s
' "$model" >&2
if [ "$model" = "spark-model" ]; then
  exit 9
fi
exit 17
"#,
        )
        .expect("write fake codex");

        unsafe {
            env::set_var(CODEX_BIN_ENV, &fake_codex);
        }
        let result = run_with_args(
            vec![
                "--cwd",
                repo.to_str().expect("repo path"),
                "--prompt",
                "find tests",
                "--prompt-file",
                prompt_file.to_str().expect("prompt path"),
                "--model-spark",
                "spark-model",
                "--model-fallback",
                "fallback-model",
            ]
            .into_iter()
            .map(OsString::from),
        );
        unsafe {
            env::remove_var(CODEX_BIN_ENV);
        }

        let error = result.expect_err("both attempts should fail");
        assert!(error.contains(
            "both spark (`spark-model`) and fallback (`fallback-model`) attempts failed"
        ));
        assert!(error.contains("codes 9 / 17"));
        assert!(error.contains("simulated stderr for fallback-model"));
    }

    #[test]
    fn print_attempt_output_requires_markdown_artifact() {
        let result = print_attempt_output(AttemptResult {
            status_code: 0,
            stderr: String::new(),
            output_markdown: None,
        });
        assert!(result.is_err());
        assert!(result
            .expect_err("missing markdown should fail")
            .contains("expected markdown output artifact"));
    }
}
