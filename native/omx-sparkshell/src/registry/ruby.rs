use super::CommandFamily;

pub const FAMILY: CommandFamily = CommandFamily {
    name: "ruby",
    pattern: "bundle|bundler|rake",
    executables: &["bundle", "bundler", "rake"],
    description: "Ruby dependency-management and task-runner commands.",
    what_it_does: "Installs gems, manages bundle execution, and runs Ruby project tasks.",
};
