use crate::exec::CommandOutput;
use std::borrow::Cow;
use std::path::Path;

#[derive(Debug, Clone, Copy)]
pub struct CommandFamily {
    pub key: &'static str,
    pub pattern: &'static str,
    pub description: &'static str,
    pub what_it_does: &'static str,
}

const GENERIC_SHELL: CommandFamily = CommandFamily {
    key: "generic-shell",
    pattern: "ls|cat|find|grep|sed|awk|xargs|env|echo|pwd|which|sh|bash|zsh",
    description: "General shell and filesystem inspection commands.",
    what_it_does: "Inspects files, text, environment state, and shell-visible system output.",
};
const GIT: CommandFamily = CommandFamily {
    key: "git",
    pattern: "git",
    description: "Git porcelain and repository inspection commands.",
    what_it_does: "Reads or changes repository state, history, branches, or working tree diffs.",
};
const NODE_JS: CommandFamily = CommandFamily {
    key: "node-js",
    pattern: "npm|npx|pnpm|yarn|bun|node",
    description: "Node.js package management and build/test tooling.",
    what_it_does:
        "Installs dependencies, runs scripts, builds projects, or executes JavaScript tooling.",
};
const PYTHON: CommandFamily = CommandFamily {
    key: "python",
    pattern: "python|python3|pip|uv|poetry|pytest",
    description: "Python interpreter, packaging, and test commands.",
    what_it_does:
        "Runs Python code, manages packages, or executes Python-focused tests and tooling.",
};
const RUST: CommandFamily = CommandFamily {
    key: "rust",
    pattern: "cargo|rustc",
    description: "Rust package, build, and test commands.",
    what_it_does: "Builds, checks, formats, lints, runs, or tests Rust projects.",
};
const GO: CommandFamily = CommandFamily {
    key: "go",
    pattern: "go",
    description: "Go toolchain commands.",
    what_it_does: "Builds, formats, manages modules, or tests Go projects.",
};
const RUBY: CommandFamily = CommandFamily {
    key: "ruby",
    pattern: "bundle|bundler|rake|ruby",
    description: "Ruby dependency and task runner commands.",
    what_it_does: "Runs Ruby code, dependency workflows, or Ruby project tasks.",
};
const JAVA_KOTLIN: CommandFamily = CommandFamily {
    key: "java-kotlin",
    pattern: "mvn|gradle|gradlew|java|kotlinc",
    description: "Java and Kotlin build commands.",
    what_it_does: "Builds, tests, or runs JVM-based projects and wrappers.",
};
const C_CPP: CommandFamily = CommandFamily {
    key: "c-cpp",
    pattern: "make|cmake|gcc|g++|clang|clang++",
    description: "C and C++ build tooling.",
    what_it_does: "Configures, compiles, or builds native C/C++ projects.",
};
const CSHARP: CommandFamily = CommandFamily {
    key: "csharp",
    pattern: "dotnet",
    description: ".NET SDK commands.",
    what_it_does: "Builds, restores, runs, or tests .NET applications.",
};
const SWIFT: CommandFamily = CommandFamily {
    key: "swift",
    pattern: "swift|xcodebuild",
    description: "Swift Package Manager and Xcode build commands.",
    what_it_does: "Builds, tests, or packages Swift and Apple-platform projects.",
};

pub fn select_command_family(command: &str) -> &'static CommandFamily {
    let base = command_basename(command);
    match base.as_ref() {
        "git" => &GIT,
        "npm" | "npx" | "pnpm" | "yarn" | "bun" | "node" => &NODE_JS,
        "python" | "python3" | "pip" | "uv" | "poetry" | "pytest" => &PYTHON,
        "cargo" | "rustc" => &RUST,
        "go" => &GO,
        "bundle" | "bundler" | "rake" | "ruby" => &RUBY,
        "mvn" | "gradle" | "gradlew" | "java" | "kotlinc" => &JAVA_KOTLIN,
        "make" | "cmake" | "gcc" | "g++" | "clang" | "clang++" => &C_CPP,
        "dotnet" => &CSHARP,
        "swift" | "xcodebuild" => &SWIFT,
        _ => &GENERIC_SHELL,
    }
}

fn command_basename(command: &str) -> Cow<'_, str> {
    Path::new(command)
        .file_name()
        .and_then(|value| value.to_str())
        .map(Cow::from)
        .unwrap_or_else(|| Cow::from(command))
}

pub fn build_summary_prompt(command: &[String], output: &CommandOutput) -> String {
    let executable = command.first().map(String::as_str).unwrap_or("unknown");
    let family = select_command_family(executable);
    format!(
        concat!(
            "You summarize shell command output.\\n",
            "Return markdown bullets only. Allowed top-level sections: summary:, failures:, warnings:.\\n",
            "Do not suggest fixes, next steps, commands, or recommendations.\\n",
            "Keep the summary descriptive and grounded in the provided output.\\n\\n",
            "Command: {command_line}\\n",
            "Command family: {family_key}\\n",
            "Family pattern: {family_pattern}\\n",
            "Family description: {family_description}\\n",
            "Family what_it_does: {family_what_it_does}\\n",
            "Exit code: {exit_code}\\n\\n",
            "STDOUT:\\n<<<STDOUT\\n{stdout}\\n>>>STDOUT\\n\\n",
            "STDERR:\\n<<<STDERR\\n{stderr}\\n>>>STDERR\\n"
        ),
        command_line = shell_join(command),
        family_key = family.key,
        family_pattern = family.pattern,
        family_description = family.description,
        family_what_it_does = family.what_it_does,
        exit_code = output.exit_code(),
        stdout = output.stdout_text(),
        stderr = output.stderr_text(),
    )
}

fn shell_join(command: &[String]) -> String {
    command
        .iter()
        .map(|part| {
            if part
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || "-_/.:".contains(ch))
            {
                part.clone()
            } else {
                format!("{:?}", part)
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::{build_summary_prompt, select_command_family};
    use crate::exec::CommandOutput;
    use std::process::Command;

    fn ok_status() -> std::process::ExitStatus {
        Command::new("sh")
            .arg("-c")
            .arg("exit 0")
            .status()
            .expect("status")
    }

    #[test]
    fn selects_expected_family() {
        assert_eq!(select_command_family("git").key, "git");
        assert_eq!(select_command_family("npm").key, "node-js");
        assert_eq!(select_command_family("pytest").key, "python");
        assert_eq!(select_command_family("cargo").key, "rust");
        assert_eq!(select_command_family("/bin/ls").key, "generic-shell");
    }

    #[test]
    fn prompt_contains_markers_and_context() {
        let output = CommandOutput {
            status: ok_status(),
            stdout: b"alpha\n".to_vec(),
            stderr: b"beta\n".to_vec(),
        };
        let prompt = build_summary_prompt(&["git".into(), "status".into()], &output);
        assert!(prompt.contains("Command family: git"));
        assert!(prompt.contains("<<<STDOUT"));
        assert!(prompt.contains("<<<STDERR"));
    }
}
