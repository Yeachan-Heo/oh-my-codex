use super::CommandFamily;

pub const FAMILY: CommandFamily = CommandFamily {
    name: "git",
    pattern: "git",
    executables: &["git"],
    description: "Git source-control porcelain and inspection commands.",
    what_it_does:
        "Shows repository state, diffs, history, branches, and applies or synchronizes changes.",
};
