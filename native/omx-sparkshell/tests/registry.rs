#[path = "../src/registry/mod.rs"]
mod registry;

use registry::{all_families, resolve_family, resolve_family_from_argv};

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

#[test]
fn registry_contains_exact_v1_families() {
    let family_names: Vec<_> = all_families().iter().map(|family| family.name).collect();

    assert_eq!(
        family_names,
        vec![
            "generic-shell",
            "git",
            "node-js",
            "python",
            "rust",
            "go",
            "ruby",
            "java-kotlin",
            "c-cpp",
            "csharp",
            "swift",
        ]
    );
}

#[test]
fn every_family_has_required_prompt_fields() {
    for family in all_families() {
        assert!(
            !family.pattern.is_empty(),
            "{} missing pattern",
            family.name
        );
        assert!(
            !family.description.is_empty(),
            "{} missing description",
            family.name
        );
        assert!(
            !family.what_it_does.is_empty(),
            "{} missing what_it_does",
            family.name
        );
        assert!(
            !family.executables.is_empty(),
            "{} missing executables",
            family.name
        );
    }
}

#[test]
fn resolves_known_command_families() {
    assert_eq!(resolve_family("git", &args(&["diff"])).name, "git");
    assert_eq!(resolve_family("npm", &args(&["test"])).name, "node-js");
    assert_eq!(resolve_family("pytest", &[]).name, "python");
    assert_eq!(resolve_family("cargo", &args(&["test"])).name, "rust");
    assert_eq!(resolve_family("go", &args(&["test"])).name, "go");
    assert_eq!(
        resolve_family("bundle", &args(&["exec", "rspec"])).name,
        "ruby"
    );
    assert_eq!(
        resolve_family("./gradlew", &args(&["test"])).name,
        "java-kotlin"
    );
    assert_eq!(
        resolve_family("cmake", &args(&["--build", "build"])).name,
        "c-cpp"
    );
    assert_eq!(resolve_family("dotnet", &args(&["test"])).name, "csharp");
    assert_eq!(resolve_family("xcodebuild", &args(&["test"])).name, "swift");
    assert_eq!(resolve_family("ls", &args(&["-la"])).name, "generic-shell");
}

#[test]
fn strips_common_windows_extensions_before_matching() {
    assert_eq!(resolve_family("npm.cmd", &args(&["test"])).name, "node-js");
    assert_eq!(
        resolve_family("dotnet.exe", &args(&["test"])).name,
        "csharp"
    );
    assert_eq!(
        resolve_family("gradlew.bat", &args(&["test"])).name,
        "java-kotlin"
    );
}

#[test]
fn falls_back_to_generic_shell_for_unknown_commands() {
    assert_eq!(resolve_family("unknown-tool", &[]).name, "generic-shell");
    assert_eq!(resolve_family_from_argv(&args(&[])).name, "generic-shell");
}
