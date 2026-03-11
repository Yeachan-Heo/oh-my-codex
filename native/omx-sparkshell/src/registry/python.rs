use super::CommandFamily;

pub const FAMILY: CommandFamily = CommandFamily {
    name: "python",
    pattern: "python|python3|pip|pip3|uv|poetry|pytest",
    executables: &["python", "python3", "pip", "pip3", "uv", "poetry", "pytest"],
    description: "Python interpreters, package managers, and test tooling.",
    what_it_does: "Runs Python code, installs packages, manages environments, and executes Python test suites.",
};
