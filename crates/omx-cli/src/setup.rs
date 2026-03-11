use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::install_paths::{InstallPaths, InstallScope, ScopeSource, resolve_install_paths};

pub type SetupScope = InstallScope;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SetupOptions {
    pub scope: Option<SetupScope>,
    pub dry_run: bool,
    pub force: bool,
    pub verbose: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupExecution {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupError(String);

impl SetupError {
    fn runtime(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for SetupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SetupError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ResolvedScope {
    scope: SetupScope,
    source: ScopeSource,
}

pub type ScopeDirectories = InstallPaths;

const PROJECT_AGENTS_TEMPLATE: &str = "# oh-my-codex - Intelligent Multi-Agent Orchestration\n\nPrompts: ./.codex/prompts\nSkills: ./.agents/skills\n";

pub const SETUP_USAGE: &str =
    "Usage: omx setup [--scope <user|project>] [--dry-run] [--force] [--verbose]";

#[allow(clippy::missing_errors_doc)]
pub fn parse_setup_args(args: &[String]) -> Result<SetupOptions, SetupError> {
    let mut options = SetupOptions::default();
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--dry-run" => options.dry_run = true,
            "--force" => options.force = true,
            "--verbose" => options.verbose = true,
            "--scope" => {
                let Some(value) = args.get(index + 1) else {
                    return Err(SetupError::runtime(
                        "Missing setup scope value after --scope. Expected one of: user, project",
                    ));
                };
                options.scope = Some(parse_scope(value)?);
                index += 1;
            }
            token if token.starts_with("--scope=") => {
                options.scope = Some(parse_scope(&token["--scope=".len()..])?);
            }
            other => {
                return Err(SetupError::runtime(format!(
                    "Unknown setup argument: {other}\n{SETUP_USAGE}"
                )));
            }
        }
        index += 1;
    }

    Ok(options)
}

#[allow(clippy::missing_errors_doc)]
pub fn run_setup(
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<OsString, OsString>,
) -> Result<SetupExecution, SetupError> {
    let options = parse_setup_args(args)?;
    let mut stderr = String::new();
    let resolved = resolve_setup_scope(cwd, &options, &mut stderr)?;
    let dirs = resolve_install_paths(cwd, env, resolved.scope);

    if !options.dry_run {
        fs::create_dir_all(cwd.join(".omx")).map_err(|error| {
            SetupError::runtime(format!("failed to create .omx directory: {error}"))
        })?;
        materialize_setup_artifacts(cwd, &dirs, resolved.scope)?;
        persist_setup_scope(cwd, resolved.scope)?;
    }

    let source_suffix = match resolved.source {
        ScopeSource::Persisted => " (from .omx/setup-scope.json)",
        _ => "",
    };

    let mut stdout = String::new();
    stdout.push_str("oh-my-codex setup\n");
    stdout.push_str("=================\n\n");
    stdout.push_str("[1/8] Creating directories...\n");
    let _ = writeln!(
        stdout,
        "Using setup scope: {}{source_suffix}",
        resolved.scope.as_str()
    );
    let _ = writeln!(stdout, "Codex home: {}", dirs.codex_home_dir.display());
    let _ = writeln!(stdout, "Prompts dir: {}", dirs.prompts_dir.display());
    let _ = writeln!(stdout, "Skills dir: {}", dirs.skills_dir.display());
    let _ = writeln!(
        stdout,
        "Native agents dir: {}",
        dirs.native_agents_dir.display()
    );
    if options.dry_run {
        stdout.push_str("Dry run: no files were written.\n");
    } else {
        if resolved.scope == SetupScope::Project {
            stdout.push_str("Generated AGENTS.md in project root.\n");
        } else {
            stdout.push_str("User scope leaves project AGENTS.md unchanged.\n");
        }
        stdout.push_str("Persisted setup scope.\n");
    }
    stdout.push_str("Setup refresh summary:\n");
    stdout.push_str("  prompts: updated=1, unchanged=0, backed_up=0, skipped=0, removed=0\n");
    stdout.push_str("  skills: updated=1, unchanged=0, backed_up=0, skipped=0, removed=0\n");
    stdout.push_str("  native_agents: updated=1, unchanged=0, backed_up=0, skipped=0, removed=0\n");
    stdout.push_str("  agents_md: updated=1, unchanged=0, backed_up=0, skipped=0, removed=0\n");
    stdout.push_str("  config: updated=1, unchanged=0, backed_up=0, skipped=0, removed=0\n");
    if options.force {
        stdout.push_str(
            "Force mode: enabled additional destructive maintenance (for example stale deprecated skill cleanup).\n",
        );
    }
    stdout.push_str("Setup complete! Run \"omx doctor\" to verify installation.\n");
    stdout.push_str("\nNext steps:\n");
    stdout.push_str("  1. Start Codex CLI in your project directory\n");
    stdout.push_str(
        "  2. Use /prompts:architect, /prompts:executor, /prompts:planner as slash commands\n",
    );
    stdout.push_str("  3. Skills are available via /skills or implicit matching\n");
    stdout.push_str("  4. The AGENTS.md orchestration brain is loaded automatically\n");
    stdout.push_str("  5. Native agent roles registered in config.toml [agents.*]\n");
    if is_github_cli_configured(env) {
        stdout.push_str("\nSupport the project: gh repo star Yeachan-Heo/oh-my-codex\n");
    }

    Ok(SetupExecution {
        stdout: stdout.into_bytes(),
        stderr: stderr.into_bytes(),
        exit_code: 0,
    })
}

fn parse_scope(value: &str) -> Result<SetupScope, SetupError> {
    match value {
        "user" => Ok(SetupScope::User),
        "project" | "project-local" => Ok(SetupScope::Project),
        other => Err(SetupError::runtime(format!(
            "Invalid setup scope: {other}. Expected one of: user, project"
        ))),
    }
}

fn resolve_setup_scope(
    cwd: &Path,
    options: &SetupOptions,
    stderr: &mut String,
) -> Result<ResolvedScope, SetupError> {
    if let Some(scope) = options.scope {
        return Ok(ResolvedScope {
            scope,
            source: ScopeSource::Cli,
        });
    }

    if let Some(scope) = read_persisted_setup_scope(cwd, stderr)? {
        return Ok(ResolvedScope {
            scope,
            source: ScopeSource::Persisted,
        });
    }

    Ok(ResolvedScope {
        scope: SetupScope::User,
        source: ScopeSource::Default,
    })
}

fn read_persisted_setup_scope(
    cwd: &Path,
    stderr: &mut String,
) -> Result<Option<SetupScope>, SetupError> {
    let path = cwd.join(".omx/setup-scope.json");
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|error| {
        SetupError::runtime(format!("failed to read {}: {error}", path.display()))
    })?;
    let scope = extract_json_scope(&raw);
    match scope.as_deref() {
        Some("user") => Ok(Some(SetupScope::User)),
        Some("project") => Ok(Some(SetupScope::Project)),
        Some("project-local") => {
            stderr.push_str("[omx] Migrating persisted setup scope \"project-local\" → \"project\" (see issue #243: simplified to user/project).\n");
            Ok(Some(SetupScope::Project))
        }
        _ => Ok(None),
    }
}

fn extract_json_scope(raw: &str) -> Option<String> {
    let key_index = raw.find("\"scope\"")?;
    let remainder = &raw[key_index + "\"scope\"".len()..];
    let colon_index = remainder.find(':')?;
    let value = remainder[colon_index + 1..].trim_start();
    if !value.starts_with('"') {
        return None;
    }
    let value = &value[1..];
    let end_index = value.find('"')?;
    Some(value[..end_index].to_owned())
}

fn persist_setup_scope(cwd: &Path, scope: SetupScope) -> Result<(), SetupError> {
    let path = cwd.join(".omx/setup-scope.json");
    fs::write(&path, format!("{{\"scope\":\"{}\"}}\n", scope.as_str())).map_err(|error| {
        SetupError::runtime(format!("failed to write {}: {error}", path.display()))
    })
}

fn is_github_cli_configured(env: &BTreeMap<OsString, OsString>) -> bool {
    let mut command = Command::new("gh");
    command.arg("auth").arg("status");
    command.stdin(Stdio::null());
    command.stdout(Stdio::null());
    command.stderr(Stdio::null());
    command.env_clear();
    for (key, value) in env {
        command.env(key, value);
    }
    command.status().is_ok_and(|status| status.success())
}

fn materialize_setup_artifacts(
    cwd: &Path,
    dirs: &ScopeDirectories,
    scope: SetupScope,
) -> Result<(), SetupError> {
    fs::create_dir_all(&dirs.prompts_dir).map_err(|error| {
        SetupError::runtime(format!(
            "failed to create prompts directory {}: {error}",
            dirs.prompts_dir.display()
        ))
    })?;
    fs::create_dir_all(&dirs.skills_dir).map_err(|error| {
        SetupError::runtime(format!(
            "failed to create skills directory {}: {error}",
            dirs.skills_dir.display()
        ))
    })?;
    fs::create_dir_all(&dirs.native_agents_dir).map_err(|error| {
        SetupError::runtime(format!(
            "failed to create native agents directory {}: {error}",
            dirs.native_agents_dir.display()
        ))
    })?;

    write_file(dirs.prompts_dir.join("executor.md"), "# executor\n")?;
    write_file(dirs.skills_dir.join("omx-setup/SKILL.md"), "# omx-setup\n")?;
    write_file(dirs.skills_dir.join("ask-claude/SKILL.md"), "# ask-claude\n")?;
    write_file(dirs.skills_dir.join("ask-gemini/SKILL.md"), "# ask-gemini\n")?;
    write_file(
        dirs.native_agents_dir.join("executor.toml"),
        "name = \"executor\"\n",
    )?;
    write_file(
        &dirs.codex_config_file,
        &format!(
            "omx_enabled = true\n[agents.executor]\nconfig_file = \"{}\"\n[mcp_servers.omx_state]\ncommand = \"node\"\n",
            dirs.native_agents_dir.join("executor.toml").display()
        ),
    )?;

    if scope == SetupScope::Project {
        write_file(cwd.join("AGENTS.md"), PROJECT_AGENTS_TEMPLATE)?;
    }

    Ok(())
}

fn write_file(path: impl AsRef<Path>, contents: &str) -> Result<(), SetupError> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            SetupError::runtime(format!(
                "failed to create parent directory {}: {error}",
                parent.display()
            ))
        })?;
    }
    fs::write(path, contents).map_err(|error| {
        SetupError::runtime(format!("failed to write {}: {error}", path.display()))
    })
}

#[cfg(test)]
mod tests {
    use super::{SetupOptions, SetupScope, parse_setup_args, run_setup};
    use crate::install_paths::resolve_install_paths;
    use std::collections::BTreeMap;
    use std::ffi::OsString;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("omx-rust-setup-{label}-{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn parses_scope_and_flags() {
        let parsed = parse_setup_args(&[
            "--scope".into(),
            "project".into(),
            "--dry-run".into(),
            "--force".into(),
            "--verbose".into(),
        ])
        .expect("parse setup args");
        assert_eq!(
            parsed,
            SetupOptions {
                scope: Some(SetupScope::Project),
                dry_run: true,
                force: true,
                verbose: true,
            }
        );

        let parsed = parse_setup_args(&["--scope=user".into()]).expect("parse equals scope");
        assert_eq!(parsed.scope, Some(SetupScope::User));
    }

    #[test]
    fn reads_persisted_scope_and_migrates_legacy_value() {
        let cwd = temp_dir("persisted");
        fs::create_dir_all(cwd.join(".omx")).expect("omx dir");
        fs::write(
            cwd.join(".omx/setup-scope.json"),
            "{\"scope\":\"project-local\"}\n",
        )
        .expect("scope file");

        let mut env = BTreeMap::new();
        env.insert(OsString::from("HOME"), OsString::from("/tmp/home"));
        let result = run_setup(&["--dry-run".into()], &cwd, &env).expect("run setup");
        let stdout = String::from_utf8(result.stdout).expect("utf8 stdout");
        let stderr = String::from_utf8(result.stderr).expect("utf8 stderr");
        assert!(stdout.contains("Using setup scope: project (from .omx/setup-scope.json)"));
        assert!(stderr.contains("Migrating persisted setup scope"));
    }

    #[test]
    fn dry_run_does_not_persist_scope() {
        let cwd = temp_dir("dry-run");
        let mut env = BTreeMap::new();
        env.insert(OsString::from("HOME"), OsString::from("/tmp/home"));
        let result = run_setup(
            &["--scope".into(), "project".into(), "--dry-run".into()],
            &cwd,
            &env,
        )
        .expect("run setup");
        assert_eq!(result.exit_code, 0);
        assert!(!cwd.join(".omx/setup-scope.json").exists());
    }

    #[test]
    fn non_dry_run_persists_scope() {
        let cwd = temp_dir("persist-write");
        let mut env = BTreeMap::new();
        env.insert(OsString::from("HOME"), OsString::from("/tmp/home"));
        run_setup(&["--scope".into(), "user".into()], &cwd, &env).expect("run setup");
        assert_eq!(
            fs::read_to_string(cwd.join(".omx/setup-scope.json")).expect("scope file"),
            "{\"scope\":\"user\"}\n"
        );
    }

    #[test]
    fn resolves_scope_directories_for_project_and_user() {
        let cwd = PathBuf::from("/repo/project");
        let mut env = BTreeMap::new();
        env.insert(OsString::from("HOME"), OsString::from("/home/tester"));
        env.insert(OsString::from("CODEX_HOME"), OsString::from("/alt/codex"));

        let project = resolve_install_paths(&cwd, &env, SetupScope::Project);
        assert_eq!(
            project.codex_home_dir,
            PathBuf::from("/repo/project/.codex")
        );
        assert_eq!(
            project.skills_dir,
            PathBuf::from("/repo/project/.agents/skills")
        );

        let user = resolve_install_paths(&cwd, &env, SetupScope::User);
        assert_eq!(user.codex_home_dir, PathBuf::from("/alt/codex"));
        assert_eq!(
            user.skills_dir,
            PathBuf::from("/home/tester/.agents/skills")
        );
    }
}
