use super::CommandFamily;

pub const FAMILY: CommandFamily = CommandFamily {
    name: "java-kotlin",
    pattern: "mvn|gradle|gradlew",
    executables: &["mvn", "gradle", "gradlew"],
    description: "Java and Kotlin build-tool commands.",
    what_it_does: "Resolves dependencies and runs Java or Kotlin compile, test, package, and wrapper-driven tasks.",
};
