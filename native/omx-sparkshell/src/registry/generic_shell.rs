use super::CommandFamily;

pub const FAMILY: CommandFamily = CommandFamily {
    name: "generic-shell",
    pattern: "ls|cat|find|grep|sed|awk|xargs|env|echo|pwd|which",
    executables: &[
        "ls", "cat", "find", "grep", "sed", "awk", "xargs", "env", "echo", "pwd", "which",
    ],
    description: "Common shell inspection and text-processing commands.",
    what_it_does: "Lists files, prints content, searches text, transforms streams, and reveals environment or path information.",
};
