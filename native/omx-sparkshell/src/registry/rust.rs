use super::CommandFamily;

pub const FAMILY: CommandFamily = CommandFamily {
    name: "rust",
    pattern: "cargo",
    executables: &["cargo"],
    description: "Rust Cargo workflow commands.",
    what_it_does: "Builds, checks, tests, formats, lints, and runs Rust crates and workspaces.",
};
