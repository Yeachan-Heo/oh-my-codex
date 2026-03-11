use std::ffi::{OsStr, OsString};

use crate::process_bridge::CommandSpec;

const TMUX_PROGRAM: &str = "tmux";
const TMUX_ENTER_KEY: &str = "C-m";

#[must_use]
pub fn build_tmux_command(args: &[OsString]) -> CommandSpec {
    let mut spec = CommandSpec::new(TMUX_PROGRAM);
    spec.args = args.to_vec();
    spec
}

#[must_use]
pub fn build_tmux_version_command() -> CommandSpec {
    build_tmux_command(&[OsString::from("-V")])
}

#[must_use]
pub fn build_tmux_list_sessions_command() -> CommandSpec {
    build_tmux_command(&[
        OsString::from("list-sessions"),
        OsString::from("-F"),
        OsString::from("#{session_name}"),
    ])
}

#[must_use]
pub fn build_tmux_capture_pane_command(target: impl AsRef<OsStr>, lines: usize) -> CommandSpec {
    build_tmux_command(&[
        OsString::from("capture-pane"),
        OsString::from("-t"),
        target.as_ref().to_os_string(),
        OsString::from("-p"),
        OsString::from("-S"),
        OsString::from(format!("-{lines}")),
    ])
}

#[must_use]
pub fn build_tmux_kill_session_command(target: impl AsRef<OsStr>) -> CommandSpec {
    build_tmux_command(&[
        OsString::from("kill-session"),
        OsString::from("-t"),
        target.as_ref().to_os_string(),
    ])
}

#[must_use]
pub fn build_tmux_kill_pane_command(target: impl AsRef<OsStr>) -> CommandSpec {
    build_tmux_command(&[
        OsString::from("kill-pane"),
        OsString::from("-t"),
        target.as_ref().to_os_string(),
    ])
}

#[must_use]
pub fn sanitize_tmux_literal_text(text: &str) -> String {
    text.replace("\r\n", " ").replace(['\n', '\r'], " ")
}

#[must_use]
pub fn build_tmux_send_keys_literal_commands(
    target: impl AsRef<OsStr>,
    text: &str,
    press_enter: bool,
) -> Vec<CommandSpec> {
    let target = target.as_ref().to_os_string();
    let safe_text = sanitize_tmux_literal_text(text);
    let mut commands = vec![build_tmux_command(&[
        OsString::from("send-keys"),
        OsString::from("-t"),
        target.clone(),
        OsString::from("-l"),
        OsString::from("--"),
        OsString::from(safe_text),
    ])];

    if press_enter {
        commands.extend((0..2).map(|_| {
            build_tmux_command(&[
                OsString::from("send-keys"),
                OsString::from("-t"),
                target.clone(),
                OsString::from(TMUX_ENTER_KEY),
            ])
        }));
    }

    commands
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_list_sessions_probe() {
        let spec = build_tmux_list_sessions_command();

        assert_eq!(spec.program, OsString::from("tmux"));
        assert_eq!(
            spec.args,
            vec![
                OsString::from("list-sessions"),
                OsString::from("-F"),
                OsString::from("#{session_name}"),
            ]
        );
    }

    #[test]
    fn builds_capture_pane_with_negative_history_offset() {
        let spec = build_tmux_capture_pane_command("%3", 15);

        assert_eq!(spec.program, OsString::from("tmux"));
        assert_eq!(
            spec.args,
            vec![
                OsString::from("capture-pane"),
                OsString::from("-t"),
                OsString::from("%3"),
                OsString::from("-p"),
                OsString::from("-S"),
                OsString::from("-15"),
            ]
        );
    }

    #[test]
    fn sanitizes_literal_send_keys_text() {
        assert_eq!(
            sanitize_tmux_literal_text("dispatch\r\nping\nnext\rnow"),
            "dispatch ping next now"
        );
    }

    #[test]
    fn builds_literal_send_keys_followed_by_dedicated_enters() {
        let specs = build_tmux_send_keys_literal_commands("%42", "ping\nnow", true);

        assert_eq!(specs.len(), 3);
        assert_eq!(
            specs[0].args,
            vec![
                OsString::from("send-keys"),
                OsString::from("-t"),
                OsString::from("%42"),
                OsString::from("-l"),
                OsString::from("--"),
                OsString::from("ping now"),
            ]
        );
        assert_eq!(
            specs[1].args,
            vec![
                OsString::from("send-keys"),
                OsString::from("-t"),
                OsString::from("%42"),
                OsString::from("C-m"),
            ]
        );
        assert_eq!(specs[1].args, specs[2].args);
    }

    #[test]
    fn omits_submit_keys_when_not_requested() {
        let specs = build_tmux_send_keys_literal_commands("%42", "status", false);

        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].args.last(), Some(&OsString::from("status")));
    }

    #[test]
    fn builds_kill_commands() {
        let session = build_tmux_kill_session_command("omx-team-alpha");
        let pane = build_tmux_kill_pane_command("%9");

        assert_eq!(
            session.args,
            vec![
                OsString::from("kill-session"),
                OsString::from("-t"),
                OsString::from("omx-team-alpha"),
            ]
        );
        assert_eq!(
            pane.args,
            vec![
                OsString::from("kill-pane"),
                OsString::from("-t"),
                OsString::from("%9"),
            ]
        );
    }
}
