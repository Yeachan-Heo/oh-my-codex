use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[path = "../src/ask.rs"]
mod ask;

use ask::{AskProvider, parse_ask_args, resolve_ask_advisor_script_path, run_ask};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("workspace root")
        .to_path_buf()
}

fn env_map(extra: &[(&str, &str)]) -> BTreeMap<OsString, OsString> {
    let mut env = std::env::vars_os().collect::<BTreeMap<_, _>>();
    for (key, value) in extra {
        env.insert(OsString::from(key), OsString::from(value));
    }
    env
}

fn temp_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("omx-rust-ask-{label}-{nanos}"));
    fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

#[test]
fn parses_provider_and_prompt_forms() {
    let parsed = parse_ask_args(["claude", "review", "this"]).expect("parse positional prompt");
    assert_eq!(parsed.provider, AskProvider::Claude);
    assert_eq!(parsed.prompt, "review this");
    assert_eq!(parsed.agent_prompt_role, None);

    let parsed = parse_ask_args([
        "gemini",
        "--agent-prompt=planner",
        "--prompt",
        "brainstorm",
        "ideas",
    ])
    .expect("parse long-flag prompt");
    assert_eq!(parsed.provider, AskProvider::Gemini);
    assert_eq!(parsed.prompt, "brainstorm ideas");
    assert_eq!(parsed.agent_prompt_role.as_deref(), Some("planner"));
}

#[test]
fn resolves_relative_advisor_override_from_package_root() {
    let env = env_map(&[(
        "OMX_ASK_ADVISOR_SCRIPT",
        "scripts/fixtures/ask-advisor-stub.js",
    )]);
    let path = resolve_ask_advisor_script_path(&repo_root(), &env);
    assert_eq!(
        path,
        repo_root().join("scripts/fixtures/ask-advisor-stub.js")
    );
}

#[test]
fn preserves_stdout_stderr_and_exit_code_from_advisor() {
    let cwd = temp_dir("passthrough");
    let env = env_map(&[
        (
            "OMX_ASK_ADVISOR_SCRIPT",
            "scripts/fixtures/ask-advisor-stub.js",
        ),
        ("OMX_ASK_STUB_STDOUT", "artifact-path-from-stub.md\n"),
        ("OMX_ASK_STUB_STDERR", "stub-warning-line\n"),
        ("OMX_ASK_STUB_EXIT_CODE", "7"),
    ]);

    let result = run_ask(
        &["claude".to_owned(), "pass-through".to_owned()],
        &cwd,
        &env,
    )
    .expect("run ask against stub");

    assert_eq!(
        String::from_utf8(result.stdout).expect("utf8 stdout"),
        "artifact-path-from-stub.md\n"
    );
    assert_eq!(
        String::from_utf8(result.stderr).expect("utf8 stderr"),
        "stub-warning-line\n"
    );
    assert_eq!(result.exit_code, 7);
}

#[test]
fn injects_original_task_env_without_rewriting_prompt() {
    let cwd = temp_dir("original-task");
    let script_path = cwd.join("echo-env.js");
    fs::write(
        &script_path,
        concat!(
            "#!/usr/bin/env node\n",
            "const prompt = process.argv.slice(3).join(' ');\n",
            "process.stdout.write(`prompt=${prompt}\\n`);\n",
            "process.stderr.write(`original=${process.env.OMX_ASK_ORIGINAL_TASK || ''}\\n`);\n",
            "process.exit(5);\n",
        ),
    )
    .expect("write stub");

    let env = env_map(&[(
        "OMX_ASK_ADVISOR_SCRIPT",
        script_path.to_string_lossy().as_ref(),
    )]);
    let result = run_ask(
        &["gemini".to_owned(), "ship".to_owned(), "feature".to_owned()],
        &cwd,
        &env,
    )
    .expect("run ask against env stub");

    assert_eq!(
        String::from_utf8(result.stdout).expect("utf8 stdout"),
        "prompt=ship feature\n"
    );
    assert_eq!(
        String::from_utf8(result.stderr).expect("utf8 stderr"),
        "original=ship feature\n"
    );
    assert_eq!(result.exit_code, 5);
}

#[test]
fn uses_leader_node_path_when_provided() {
    let cwd = temp_dir("leader-node");
    let script_path = cwd.join("argv-check.js");
    fs::write(&script_path, "process.stdout.write(process.argv[0]);\n").expect("write argv stub");

    let node_path = String::from_utf8(
        Command::new("node")
            .arg("-p")
            .arg("process.execPath")
            .output()
            .expect("resolve node exec path")
            .stdout,
    )
    .expect("utf8 node path")
    .trim()
    .to_owned();

    let env = env_map(&[
        (
            "OMX_ASK_ADVISOR_SCRIPT",
            script_path.to_string_lossy().as_ref(),
        ),
        ("OMX_LEADER_NODE_PATH", &node_path),
    ]);

    let result = run_ask(&["claude".to_owned(), "check".to_owned()], &cwd, &env)
        .expect("run ask with leader node path");

    assert_eq!(
        String::from_utf8(result.stdout).expect("utf8 stdout"),
        node_path
    );
    assert!(result.stderr.is_empty());
    assert_eq!(result.exit_code, 0);
}
