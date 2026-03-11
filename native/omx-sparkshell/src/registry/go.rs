use super::CommandFamily;

pub const FAMILY: CommandFamily = CommandFamily {
    name: "go",
    pattern: "go",
    executables: &["go"],
    description: "Go toolchain and module commands.",
    what_it_does: "Builds Go packages, manages modules, and runs Go tests.",
};
