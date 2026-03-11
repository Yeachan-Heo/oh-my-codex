use super::CommandFamily;

pub const FAMILY: CommandFamily = CommandFamily {
    name: "c-cpp",
    pattern: "make|cmake",
    executables: &["make", "cmake"],
    description: "C and C++ build-system commands.",
    what_it_does: "Configures native builds and compiles C or C++ projects through generated or handwritten build rules.",
};
