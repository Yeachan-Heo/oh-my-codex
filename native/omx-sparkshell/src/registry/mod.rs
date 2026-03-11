pub mod c_cpp;
pub mod csharp;
pub mod generic_shell;
pub mod git;
pub mod go;
pub mod java_kotlin;
pub mod node_js;
pub mod python;
pub mod ruby;
pub mod rust;
pub mod swift;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandFamily {
    pub name: &'static str,
    pub pattern: &'static str,
    pub executables: &'static [&'static str],
    pub description: &'static str,
    pub what_it_does: &'static str,
}

const FAMILIES: [&CommandFamily; 11] = [
    &generic_shell::FAMILY,
    &git::FAMILY,
    &node_js::FAMILY,
    &python::FAMILY,
    &rust::FAMILY,
    &go::FAMILY,
    &ruby::FAMILY,
    &java_kotlin::FAMILY,
    &c_cpp::FAMILY,
    &csharp::FAMILY,
    &swift::FAMILY,
];

pub fn all_families() -> &'static [&'static CommandFamily] {
    &FAMILIES
}

pub fn resolve_family(program: &str, args: &[String]) -> &'static CommandFamily {
    let normalized_program = normalize_program(program);
    let normalized_first_arg = args.first().map(|arg| normalize_program(arg));

    FAMILIES
        .iter()
        .copied()
        .find(|family| matches_family(family, normalized_program, normalized_first_arg))
        .unwrap_or(&generic_shell::FAMILY)
}

pub fn resolve_family_from_argv(argv: &[String]) -> &'static CommandFamily {
    let Some((program, args)) = argv.split_first() else {
        return &generic_shell::FAMILY;
    };

    resolve_family(program, args)
}

fn matches_family(
    family: &CommandFamily,
    normalized_program: &str,
    normalized_first_arg: Option<&str>,
) -> bool {
    family
        .executables
        .iter()
        .copied()
        .any(|candidate| candidate == normalized_program)
        || family
            .executables
            .iter()
            .copied()
            .any(|candidate| normalized_first_arg.is_some_and(|arg| candidate == arg))
}

fn normalize_program(program: &str) -> &str {
    let basename = program.rsplit(['/', '\\']).next().unwrap_or(program);

    basename
        .strip_suffix(".exe")
        .or_else(|| basename.strip_suffix(".cmd"))
        .or_else(|| basename.strip_suffix(".bat"))
        .or_else(|| basename.strip_suffix(".ps1"))
        .unwrap_or(basename)
}
