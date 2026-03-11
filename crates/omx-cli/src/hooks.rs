use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

const HELP: &str = concat!(
    "Usage:\n",
    "  omx hooks init       Create .omx/hooks/sample-plugin.mjs scaffold\n",
    "  omx hooks status     Show plugin directory + discovered plugins\n",
    "  omx hooks validate   Validate plugin exports/signatures\n",
    "  omx hooks test       Dispatch synthetic turn-complete event to plugins\n",
    "\n",
    "Notes:\n",
    "  - This command is additive. Existing `omx tmux-hook` behavior is unchanged.\n",
    "  - Plugins are disabled by default. Enable with OMX_HOOK_PLUGINS=1.\n",
);

const SAMPLE_PLUGIN: &str = concat!(
    "export async function onHookEvent(event, sdk) {\n",
    "  if (event.event !== 'turn-complete') return;\n\n",
    "  const current = Number((await sdk.state.read('sample-seen-count')) ?? 0);\n",
    "  const next = Number.isFinite(current) ? current + 1 : 1;\n",
    "  await sdk.state.write('sample-seen-count', next);\n\n",
    "  await sdk.log.info('sample-plugin observed turn-complete', {\n",
    "    turn_id: event.turn_id,\n",
    "    seen_count: next,\n",
    "  });\n",
    "}\n",
);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HooksExecution {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HooksError(String);

impl HooksError {
    fn runtime(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for HooksError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for HooksError {}

#[allow(clippy::missing_errors_doc)]
pub fn run_hooks(
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<OsString, OsString>,
) -> Result<HooksExecution, HooksError> {
    let subcommand = args.first().map_or("status", String::as_str);
    match subcommand {
        "init" => init_hooks(cwd),
        "status" => Ok(status_hooks(cwd, env)),
        "validate" => validate_hooks(cwd),
        "test" => Ok(stdout_only(
            "hooks test dispatch complete\nplugins discovered: 0\nplugins enabled: no\ndispatch reason: native-rust-not-implemented\n",
        )),
        "help" | "--help" | "-h" => Ok(stdout_only(HELP)),
        other => Err(HooksError::runtime(format!(
            "Unknown hooks subcommand: {other}"
        ))),
    }
}

fn stdout_only(text: &str) -> HooksExecution {
    HooksExecution {
        stdout: text.as_bytes().to_vec(),
        stderr: Vec::new(),
        exit_code: 0,
    }
}

fn hooks_dir(cwd: &Path) -> PathBuf {
    cwd.join(".omx").join("hooks")
}

fn sample_plugin_path(cwd: &Path) -> PathBuf {
    hooks_dir(cwd).join("sample-plugin.mjs")
}

fn init_hooks(cwd: &Path) -> Result<HooksExecution, HooksError> {
    let dir = hooks_dir(cwd);
    let sample_path = sample_plugin_path(cwd);
    fs::create_dir_all(&dir).map_err(|error| {
        HooksError::runtime(format!("failed to create {}: {error}", dir.display()))
    })?;

    let mut stdout = String::new();
    if sample_path.exists() {
        let _ = writeln!(
            stdout,
            "hooks scaffold already exists: {}",
            sample_path.display()
        );
        return Ok(stdout_only(&stdout));
    }

    fs::write(&sample_path, SAMPLE_PLUGIN).map_err(|error| {
        HooksError::runtime(format!(
            "failed to write {}: {error}",
            sample_path.display()
        ))
    })?;
    let _ = writeln!(stdout, "Created {}", sample_path.display());
    stdout.push_str("Enable plugins with: OMX_HOOK_PLUGINS=1\n");
    Ok(stdout_only(&stdout))
}

fn status_hooks(cwd: &Path, env: &BTreeMap<OsString, OsString>) -> HooksExecution {
    let dir = hooks_dir(cwd);
    let plugins = discover_hook_plugins(&dir);
    let enabled = env
        .get(&OsString::from("OMX_HOOK_PLUGINS"))
        .is_some_and(|value| value == "1");

    let mut stdout = String::new();
    stdout.push_str("hooks status\n-----------\n");
    let _ = writeln!(stdout, "Directory: {}", dir.display());
    stdout.push_str(if enabled {
        "Plugins enabled: yes\n"
    } else {
        "Plugins enabled: no (set OMX_HOOK_PLUGINS=1)\n"
    });
    let _ = writeln!(stdout, "Discovered plugins: {}", plugins.len());
    for plugin in plugins {
        let _ = writeln!(stdout, "- {}", plugin.display());
    }

    stdout_only(&stdout)
}

fn validate_hooks(cwd: &Path) -> Result<HooksExecution, HooksError> {
    let dir = hooks_dir(cwd);
    let plugins = discover_hook_plugins(&dir);
    if plugins.is_empty() {
        return Ok(stdout_only("No plugins found. Run: omx hooks init\n"));
    }

    let mut stdout = String::new();
    let mut failed = 0usize;
    for plugin in plugins {
        let path = dir.join(&plugin);
        let raw = fs::read_to_string(&path).map_err(|error| {
            HooksError::runtime(format!("failed to read {}: {error}", path.display()))
        })?;
        if raw.contains("onHookEvent") {
            let _ = writeln!(stdout, "✓ {}", plugin.display());
        } else {
            failed += 1;
            let _ = writeln!(
                stdout,
                "✗ {}: missing export `onHookEvent(event, sdk)`",
                plugin.display()
            );
        }
    }

    Ok(HooksExecution {
        stdout: stdout.into_bytes(),
        stderr: Vec::new(),
        exit_code: i32::from(failed != 0),
    })
}

fn discover_hook_plugins(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut files = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if !file_type.is_file() {
                return None;
            }
            let path = entry.path();
            matches!(
                path.extension().and_then(|ext| ext.to_str()),
                Some("mjs" | "js" | "cjs")
            )
            .then(|| PathBuf::from(entry.file_name()))
        })
        .collect::<Vec<_>>();
    files.sort();
    files
}

#[cfg(test)]
mod tests {
    use super::{HELP, SAMPLE_PLUGIN, run_hooks};
    use std::collections::BTreeMap;
    use std::fs;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("omx-hooks-{label}-{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn prints_help() {
        let cwd = temp_dir("help");
        let result = run_hooks(&["--help".into()], &cwd, &BTreeMap::new()).expect("help");
        assert_eq!(String::from_utf8(result.stdout).unwrap(), HELP);
    }

    #[test]
    fn init_creates_sample_plugin() {
        let cwd = temp_dir("init");
        let result = run_hooks(&["init".into()], &cwd, &BTreeMap::new()).expect("init");
        assert_eq!(result.exit_code, 0);
        assert!(cwd.join(".omx/hooks/sample-plugin.mjs").exists());
        assert_eq!(
            fs::read_to_string(cwd.join(".omx/hooks/sample-plugin.mjs")).unwrap(),
            SAMPLE_PLUGIN
        );
    }

    #[test]
    fn status_lists_plugins() {
        let cwd = temp_dir("status");
        fs::create_dir_all(cwd.join(".omx/hooks")).unwrap();
        fs::write(
            cwd.join(".omx/hooks/a.mjs"),
            "export async function onHookEvent() {}\n",
        )
        .unwrap();
        let mut env = BTreeMap::new();
        env.insert("OMX_HOOK_PLUGINS".into(), "1".into());
        let result = run_hooks(&[], &cwd, &env).expect("status");
        let stdout = String::from_utf8(result.stdout).unwrap();
        assert!(stdout.contains("hooks status"));
        assert!(stdout.contains("Plugins enabled: yes"));
        assert!(stdout.contains("Discovered plugins: 1"));
        assert!(stdout.contains("- a.mjs"));
    }

    #[test]
    fn validate_reports_missing_plugins() {
        let cwd = temp_dir("validate-none");
        let result = run_hooks(&["validate".into()], &cwd, &BTreeMap::new()).expect("validate");
        assert_eq!(
            String::from_utf8(result.stdout).unwrap(),
            "No plugins found. Run: omx hooks init\n"
        );
        assert_eq!(result.exit_code, 0);
    }

    #[test]
    fn validate_fails_invalid_plugin() {
        let cwd = temp_dir("validate-invalid");
        fs::create_dir_all(cwd.join(".omx/hooks")).unwrap();
        fs::write(
            cwd.join(".omx/hooks/bad.mjs"),
            "export const noop = true;\n",
        )
        .unwrap();
        let result = run_hooks(&["validate".into()], &cwd, &BTreeMap::new()).expect("validate");
        assert_eq!(result.exit_code, 1);
        assert!(
            String::from_utf8(result.stdout)
                .unwrap()
                .contains("missing export `onHookEvent(event, sdk)`")
        );
    }
}
