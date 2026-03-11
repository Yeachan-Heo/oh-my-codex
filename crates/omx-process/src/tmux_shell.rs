use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};

const FALLBACK_SHELL: &str = "/bin/sh";
const ALLOWED_SHELLS: &[&str] = &[
    "/bin/bash",
    "/bin/sh",
    "/bin/zsh",
    "/usr/bin/bash",
    "/usr/bin/sh",
    "/usr/bin/zsh",
    "/usr/local/bin/bash",
    "/usr/local/bin/zsh",
];

#[must_use]
pub fn build_tmux_shell_command(command: impl AsRef<OsStr>, args: &[OsString]) -> String {
    std::iter::once(shell_quote_single(command.as_ref()))
        .chain(args.iter().map(OsString::as_os_str).map(shell_quote_single))
        .collect::<Vec<_>>()
        .join(" ")
}

#[must_use]
pub fn build_tmux_pane_command(
    command: impl AsRef<OsStr>,
    args: &[OsString],
    shell_path: Option<&OsStr>,
) -> String {
    let bare_command = build_tmux_shell_command(command, args);
    let shell = normalize_shell_path(shell_path);
    let rc_source = rc_source_snippet(&shell);
    let inner = format!("{rc_source}exec {bare_command}");
    format!(
        "{} -lc {}",
        shell_quote_single(OsStr::new(&shell)),
        shell_quote_single(OsStr::new(&inner))
    )
}

#[must_use]
pub fn build_env_command_prefix(env: &BTreeMap<OsString, OsString>) -> String {
    if env.is_empty() {
        return String::new();
    }

    let assignments = env
        .iter()
        .map(|(key, value)| {
            let mut assignment = key.clone();
            assignment.push("=");
            assignment.push(value);
            shell_quote_single(&assignment)
        })
        .collect::<Vec<_>>()
        .join(" ");

    format!("env {assignments}")
}

#[must_use]
pub fn normalize_shell_path(shell_path: Option<&OsStr>) -> String {
    let raw_shell = shell_path
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string_lossy().trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| FALLBACK_SHELL.to_string());

    if ALLOWED_SHELLS
        .iter()
        .any(|candidate| *candidate == raw_shell)
    {
        raw_shell
    } else {
        FALLBACK_SHELL.to_string()
    }
}

#[must_use]
pub fn shell_quote_single(value: &OsStr) -> String {
    let rendered = value.to_string_lossy().replace('\'', "'\"'\"'");
    format!("'{rendered}'")
}

fn rc_source_snippet(shell: &str) -> &'static str {
    if shell.ends_with("/zsh") {
        "if [ -f ~/.zshrc ]; then source ~/.zshrc; fi; "
    } else if shell.ends_with("/bash") {
        "if [ -f ~/.bashrc ]; then source ~/.bashrc; fi; "
    } else {
        ""
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_tmux_pane_command_for_zsh() {
        let command = build_tmux_pane_command(
            "node",
            &[OsString::from("script.js"), OsString::from("--watch")],
            Some(OsStr::new("/bin/zsh")),
        );

        assert!(command.starts_with("'/bin/zsh' -lc '"));
        assert!(command.contains("source ~/.zshrc"));
        assert!(command.contains("node"));
        assert!(command.contains("script.js"));
        assert!(command.contains("--watch"));
    }

    #[test]
    fn falls_back_to_sh_for_unapproved_shells() {
        let command = build_tmux_pane_command(
            "codex",
            &[OsString::from("--version")],
            Some(OsStr::new("/usr/bin/fish")),
        );

        assert!(command.starts_with("'/bin/sh' -lc '"));
        assert!(!command.contains("source ~/.zshrc"));
        assert!(!command.contains("source ~/.bashrc"));
    }

    #[test]
    fn quotes_single_quotes_in_shell_fragments() {
        assert_eq!(shell_quote_single(OsStr::new("it's")), "'it'\"'\"'s'");
    }

    #[test]
    fn builds_env_prefix_in_sorted_order() {
        let env = BTreeMap::from([
            (OsString::from("BETA"), OsString::from("two")),
            (OsString::from("ALPHA"), OsString::from("one two")),
        ]);

        assert_eq!(
            build_env_command_prefix(&env),
            "env 'ALPHA=one two' 'BETA=two'"
        );
    }
}
