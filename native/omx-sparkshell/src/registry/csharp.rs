use super::CommandFamily;

pub const FAMILY: CommandFamily = CommandFamily {
    name: "csharp",
    pattern: "dotnet",
    executables: &["dotnet"],
    description: ".NET SDK commands.",
    what_it_does:
        "Restores packages and builds, tests, runs, or publishes .NET applications and libraries.",
};
