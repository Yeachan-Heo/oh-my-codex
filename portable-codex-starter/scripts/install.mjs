import { cp, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packRoot = resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const target = resolve(args.target || process.cwd());
const skillsRoot = args["skills-root"] || ".agents";
const withConfig = Boolean(args["with-config"]);
const coreOnly = Boolean(args["core-only"]);

await ensureDir(target);
await copyInto(join(packRoot, "AGENTS.md"), join(target, "AGENTS.md"));
await copyTree(join(packRoot, ".codex", "agents"), join(target, ".codex", "agents"));
await copyInto(join(packRoot, "README.md"), join(target, ".codex", "starter-docs", "README.md"));
await copyTree(join(packRoot, "docs"), join(target, ".codex", "starter-docs", "docs"));

if (skillsRoot === ".agents" || skillsRoot === "both") {
  await copyTree(join(packRoot, ".agents", "skills"), join(target, ".agents", "skills"));
}

if (skillsRoot === ".codex" || skillsRoot === "both") {
  await copyTree(join(packRoot, ".agents", "skills"), join(target, ".codex", "skills"));
}

if (withConfig) {
  await copyInto(
    join(packRoot, ".codex", "config.toml.example"),
    join(target, ".codex", "config.toml.example"),
  );
  await copyInto(
    join(packRoot, ".codex", "mcp-servers.example.toml"),
    join(target, ".codex", "mcp-servers.example.toml"),
  );
  try {
    await stat(join(target, ".codex", "config.toml"));
  } catch {
    await copyInto(
      join(packRoot, ".codex", "config.toml"),
      join(target, ".codex", "config.toml"),
    );
  }
}

if (!coreOnly) {
  await copyTree(join(packRoot, ".devcontainer"), join(target, ".devcontainer"));
  await copyInto(
    join(packRoot, ".github", "copilot-instructions.md"),
    join(target, ".github", "copilot-instructions.md"),
  );
  await copyTree(join(packRoot, ".github", "instructions"), join(target, ".github", "instructions"));
  await copyTree(join(packRoot, ".github", "agents"), join(target, ".github", "agents"));
  await copyTree(join(packRoot, ".github", "skills"), join(target, ".github", "skills"));
  await copyTree(join(packRoot, ".github", "hooks"), join(target, ".github", "hooks"));
  await copyTree(join(packRoot, ".github", "workflows"), join(target, ".github", "workflows"));
}

const modeLabel = coreOnly ? "core-only portable starter" : "full portable starter";
console.log(`Installed ${modeLabel} into ${target}`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const inlineEquals = arg.indexOf("=");
    if (inlineEquals !== -1) {
      const key = arg.slice(2, inlineEquals);
      const value = arg.slice(inlineEquals + 1);
      parsed[key] = value === "" ? true : value;
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function copyInto(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { force: true });
}

async function copyTree(source, destination) {
  try {
    const info = await stat(source);
    if (!info.isDirectory()) {
      await copyInto(source, destination);
      return;
    }
  } catch {
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}
