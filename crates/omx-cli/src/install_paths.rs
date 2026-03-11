use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallScope {
    User,
    Project,
}

impl InstallScope {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Project => "project",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeSource {
    Cli,
    Persisted,
    Default,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScopeResolution {
    pub scope: InstallScope,
    pub source: ScopeSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallPaths {
    pub codex_config_file: PathBuf,
    pub codex_home_dir: PathBuf,
    pub prompts_dir: PathBuf,
    pub skills_dir: PathBuf,
    pub native_agents_dir: PathBuf,
    pub state_dir: PathBuf,
}

#[must_use]
pub fn read_persisted_scope(cwd: &Path) -> Option<InstallScope> {
    let path = cwd.join(".omx/setup-scope.json");
    let raw = fs::read_to_string(path).ok()?;
    match extract_json_string_field(&raw, "scope")?.as_str() {
        "user" => Some(InstallScope::User),
        "project" | "project-local" => Some(InstallScope::Project),
        _ => None,
    }
}

#[must_use]
pub fn resolve_scope_from_persisted(
    cwd: &Path,
    cli_scope: Option<InstallScope>,
) -> ScopeResolution {
    if let Some(scope) = cli_scope {
        return ScopeResolution {
            scope,
            source: ScopeSource::Cli,
        };
    }
    if let Some(scope) = read_persisted_scope(cwd) {
        return ScopeResolution {
            scope,
            source: ScopeSource::Persisted,
        };
    }
    ScopeResolution {
        scope: InstallScope::User,
        source: ScopeSource::Default,
    }
}

#[must_use]
pub fn resolve_install_paths(
    cwd: &Path,
    env: &BTreeMap<OsString, OsString>,
    scope: InstallScope,
) -> InstallPaths {
    if scope == InstallScope::Project {
        let codex_home_dir = cwd.join(".codex");
        return InstallPaths {
            codex_config_file: codex_home_dir.join("config.toml"),
            codex_home_dir: codex_home_dir.clone(),
            prompts_dir: codex_home_dir.join("prompts"),
            skills_dir: cwd.join(".agents/skills"),
            native_agents_dir: cwd.join(".omx/agents"),
            state_dir: cwd.join(".omx/state"),
        };
    }

    let home_dir = env_home_dir(env).unwrap_or_else(|| cwd.to_path_buf());
    let codex_home_dir = env
        .get(&OsString::from("CODEX_HOME"))
        .map_or_else(|| home_dir.join(".codex"), PathBuf::from);

    InstallPaths {
        codex_config_file: codex_home_dir.join("config.toml"),
        codex_home_dir: codex_home_dir.clone(),
        prompts_dir: codex_home_dir.join("prompts"),
        skills_dir: home_dir.join(".agents/skills"),
        native_agents_dir: home_dir.join(".omx/agents"),
        state_dir: cwd.join(".omx/state"),
    }
}

#[must_use]
pub fn env_home_dir(env: &BTreeMap<OsString, OsString>) -> Option<PathBuf> {
    env.get(&OsString::from("HOME"))
        .or_else(|| env.get(&OsString::from("USERPROFILE")))
        .map(PathBuf::from)
}

#[must_use]
pub fn extract_json_string_field(raw: &str, key: &str) -> Option<String> {
    let key = format!("\"{key}\"");
    let key_start = raw.find(&key)? + key.len();
    let after_key = raw.get(key_start..)?;
    let colon_idx = after_key.find(':')?;
    let after_colon = after_key.get(colon_idx + 1..)?.trim_start();
    let stripped = after_colon.strip_prefix('"')?;

    let mut escaped = false;
    let mut out = String::new();
    for ch in stripped.chars() {
        if escaped {
            out.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            return Some(out);
        }
        out.push(ch);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{
        InstallScope, ScopeSource, env_home_dir, extract_json_string_field, read_persisted_scope,
        resolve_install_paths, resolve_scope_from_persisted,
    };
    use std::collections::BTreeMap;
    use std::ffi::OsString;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("omx-install-paths-{label}-{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn reads_persisted_scope_variants() {
        let cwd = temp_dir("persisted");
        fs::create_dir_all(cwd.join(".omx")).expect("create .omx");
        fs::write(
            cwd.join(".omx/setup-scope.json"),
            "{\"scope\":\"project-local\"}\n",
        )
        .expect("write persisted scope");
        assert_eq!(read_persisted_scope(&cwd), Some(InstallScope::Project));
    }

    #[test]
    fn resolves_scope_precedence() {
        let cwd = temp_dir("precedence");
        fs::create_dir_all(cwd.join(".omx")).expect("create .omx");
        fs::write(
            cwd.join(".omx/setup-scope.json"),
            "{\"scope\":\"project\"}\n",
        )
        .expect("write persisted scope");
        assert_eq!(
            resolve_scope_from_persisted(&cwd, Some(InstallScope::User)).source,
            ScopeSource::Cli
        );
        assert_eq!(
            resolve_scope_from_persisted(&cwd, None),
            super::ScopeResolution {
                scope: InstallScope::Project,
                source: ScopeSource::Persisted,
            }
        );
    }

    #[test]
    fn resolves_install_paths_for_project_and_user() {
        let cwd = Path::new("/repo/project");
        let mut env = BTreeMap::new();
        env.insert(OsString::from("HOME"), OsString::from("/home/tester"));
        env.insert(OsString::from("CODEX_HOME"), OsString::from("/alt/codex"));

        let project = resolve_install_paths(cwd, &env, InstallScope::Project);
        assert_eq!(
            project.codex_config_file,
            PathBuf::from("/repo/project/.codex/config.toml")
        );
        assert_eq!(
            project.skills_dir,
            PathBuf::from("/repo/project/.agents/skills")
        );
        assert_eq!(project.state_dir, PathBuf::from("/repo/project/.omx/state"));

        let user = resolve_install_paths(cwd, &env, InstallScope::User);
        assert_eq!(
            user.codex_config_file,
            PathBuf::from("/alt/codex/config.toml")
        );
        assert_eq!(
            user.skills_dir,
            PathBuf::from("/home/tester/.agents/skills")
        );
        assert_eq!(
            user.native_agents_dir,
            PathBuf::from("/home/tester/.omx/agents")
        );
        assert_eq!(user.state_dir, PathBuf::from("/repo/project/.omx/state"));
    }

    #[test]
    fn reads_home_from_home_or_userprofile() {
        let mut env = BTreeMap::new();
        env.insert(
            OsString::from("USERPROFILE"),
            OsString::from("C:/Users/tester"),
        );
        assert_eq!(env_home_dir(&env), Some(PathBuf::from("C:/Users/tester")));
    }

    #[test]
    fn extracts_json_string_fields() {
        assert_eq!(
            extract_json_string_field("{\"scope\":\"user\"}", "scope").as_deref(),
            Some("user")
        );
    }
}
