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
#[allow(unused_unsafe)]
mod tests {
    use super::{
        combined_visible_lines, count_visible_lines, read_line_threshold, DEFAULT_MAX_VISIBLE_LINES,
    };
    use crate::test_support::env_lock;
    use std::env;

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

    #[test]
    fn threshold_defaults_for_zero_invalid_and_blank_values() {
        let _guard = env_lock();
        unsafe { env::set_var("OMX_SPARKSHELL_LINES", "0") };
        assert_eq!(read_line_threshold(), DEFAULT_MAX_VISIBLE_LINES);

        unsafe { env::set_var("OMX_SPARKSHELL_LINES", "not-a-number") };
        assert_eq!(read_line_threshold(), DEFAULT_MAX_VISIBLE_LINES);

        unsafe { env::set_var("OMX_SPARKSHELL_LINES", "   ") };
        assert_eq!(read_line_threshold(), DEFAULT_MAX_VISIBLE_LINES);

        unsafe { env::remove_var("OMX_SPARKSHELL_LINES") };
    }

    #[test]
    fn threshold_accepts_trimmed_positive_values() {
        let _guard = env_lock();
        unsafe { env::set_var("OMX_SPARKSHELL_LINES", " 7 ") };
        assert_eq!(read_line_threshold(), 7);
        unsafe { env::remove_var("OMX_SPARKSHELL_LINES") };
    }

    #[test]
    fn empty_output_counts_as_zero_lines() {
        assert_eq!(count_visible_lines(b""), 0);
    }
}
