use std::env;

pub const DEFAULT_MAX_VISIBLE_LINES: usize = 12;

pub fn read_line_threshold() -> usize {
    env::var("OMX_SPARKSHELL_LINES")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_VISIBLE_LINES)
}

pub fn count_visible_lines(bytes: &[u8]) -> usize {
    if bytes.is_empty() {
        return 0;
    }
    String::from_utf8_lossy(bytes).lines().count()
}

pub fn combined_visible_lines(stdout: &[u8], stderr: &[u8]) -> usize {
    count_visible_lines(stdout) + count_visible_lines(stderr)
}

#[cfg(test)]
mod tests {
    use super::{combined_visible_lines, count_visible_lines};

    #[test]
    fn counts_trailing_partial_line() {
        assert_eq!(count_visible_lines(b"alpha\nbeta"), 2);
    }

    #[test]
    fn counts_blank_lines() {
        assert_eq!(count_visible_lines(b"\n\n"), 2);
    }

    #[test]
    fn combines_stdout_and_stderr() {
        assert_eq!(combined_visible_lines(b"one\ntwo\n", b"warn\n"), 3);
    }
}
