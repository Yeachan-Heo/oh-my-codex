use super::CommandFamily;

pub const FAMILY: CommandFamily = CommandFamily {
    name: "node-js",
    pattern: "npm|npx|pnpm|yarn|bun",
    executables: &["npm", "npx", "pnpm", "yarn", "bun"],
    description: "Node.js package-manager and task-runner commands.",
    what_it_does: "Installs dependencies and runs JavaScript or TypeScript build, test, and development tasks.",
};
