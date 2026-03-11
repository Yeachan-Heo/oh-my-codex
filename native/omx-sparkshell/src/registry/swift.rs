use super::CommandFamily;

pub const FAMILY: CommandFamily = CommandFamily {
    name: "swift",
    pattern: "swift|xcodebuild",
    executables: &["swift", "xcodebuild"],
    description: "Swift Package Manager and Xcode build commands.",
    what_it_does:
        "Builds, tests, and manages Swift packages or Xcode-driven Apple platform projects.",
};
