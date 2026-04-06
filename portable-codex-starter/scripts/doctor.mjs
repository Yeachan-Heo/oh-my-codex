import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const target = resolve(args.target || process.cwd());
const coreOnly = Boolean(args["core-only"]);
const skillsRoot = args["skills-root"] || ".agents";

const expected = {
  agents: 33,
  skills: 13,
  githubAgents: 5,
  githubInstructions: 5,
  githubSkills: 4,
};

const checks = [];

checks.push(checkExists("AGENTS.md", join(target, "AGENTS.md")));
checks.push(checkExists(".codex/agents", join(target, ".codex", "agents")));

const agentsPath = join(target, ".codex", "agents");
const agentsSkillsPath = join(target, ".agents", "skills");
const codexSkillsPath = join(target, ".codex", "skills");
const configPath = join(target, ".codex", "config.toml");
const configExamplePath = join(target, ".codex", "config.toml.example");
const mcpExamplePath = join(target, ".codex", "mcp-servers.example.toml");
const starterDocsReadmePath = join(target, ".codex", "starter-docs", "README.md");
const starterDocsAutomationPath = join(target, ".codex", "starter-docs", "docs", "automation-playbook.md");
const githubAgentsPath = join(target, ".github", "agents");
const githubInstructionsPath = join(target, ".github", "instructions");
const githubSkillsPath = join(target, ".github", "skills");

const agentCount = await countAgentFiles(agentsPath);
const agentsSkillCount = await countSkillDirectories(agentsSkillsPath);
const codexSkillCount = await countSkillDirectories(codexSkillsPath);

if (skillsRoot === ".agents") {
  checks.push(checkExists(".agents/skills", agentsSkillsPath));
  checks.push({
    name: "skill count",
    ok: agentsSkillCount === expected.skills,
    detail: `${agentsSkillCount}/${expected.skills} in .agents/skills`,
  });
} else if (skillsRoot === ".codex") {
  checks.push(checkExists(".codex/skills", codexSkillsPath));
  checks.push({
    name: "skill count",
    ok: codexSkillCount === expected.skills,
    detail: `${codexSkillCount}/${expected.skills} in .codex/skills`,
  });
} else if (skillsRoot === "both") {
  checks.push(checkExists(".agents/skills", agentsSkillsPath));
  checks.push(checkExists(".codex/skills", codexSkillsPath));
  checks.push({
    name: "skill count (.agents)",
    ok: agentsSkillCount === expected.skills,
    detail: `${agentsSkillCount}/${expected.skills}`,
  });
  checks.push({
    name: "skill count (.codex)",
    ok: codexSkillCount === expected.skills,
    detail: `${codexSkillCount}/${expected.skills}`,
  });
} else {
  checks.push({
    name: "skills-root",
    ok: false,
    optional: false,
    detail: `unsupported value: ${skillsRoot}`,
  });
}

checks.push({
  name: "agent count",
  ok: agentCount === expected.agents,
  detail: `${agentCount}/${expected.agents}`,
});
checks.push(checkOptional("config.toml", configPath));
checks.push(checkOptional("config.toml.example", configExamplePath));
checks.push(checkOptional("mcp-servers.example.toml", mcpExamplePath));
checks.push(checkOptional("starter-docs/README.md", starterDocsReadmePath));
checks.push(checkOptional("starter-docs/docs/automation-playbook.md", starterDocsAutomationPath));

if (!coreOnly) {
  checks.push(checkExists(".devcontainer/devcontainer.json", join(target, ".devcontainer", "devcontainer.json")));
  checks.push(
    checkExists(
      ".devcontainer/scripts/post-create.sh",
      join(target, ".devcontainer", "scripts", "post-create.sh"),
    ),
  );
  checks.push(
    checkExists(".github/copilot-instructions.md", join(target, ".github", "copilot-instructions.md")),
  );
  checks.push(checkExists(".github/agents", githubAgentsPath));
  checks.push(checkExists(".github/instructions", githubInstructionsPath));
  checks.push(checkExists(".github/skills", githubSkillsPath));
  checks.push(checkExists(".github/hooks", join(target, ".github", "hooks")));
  checks.push(
    checkExists(
      ".github/workflows/copilot-setup-steps.yml",
      join(target, ".github", "workflows", "copilot-setup-steps.yml"),
    ),
  );
  checks.push(
    checkExists(
      ".github/workflows/portable-quality-gate.yml",
      join(target, ".github", "workflows", "portable-quality-gate.yml"),
    ),
  );

  const githubAgentCount = await countMarkdownFiles(githubAgentsPath, ".agent.md");
  const githubInstructionCount = await countMarkdownFiles(githubInstructionsPath, ".instructions.md");
  const githubSkillCount = await countSkillDirectories(githubSkillsPath);

  checks.push({
    name: "GitHub agent count",
    ok: githubAgentCount === expected.githubAgents,
    detail: `${githubAgentCount}/${expected.githubAgents}`,
  });
  checks.push({
    name: "GitHub instruction count",
    ok: githubInstructionCount === expected.githubInstructions,
    detail: `${githubInstructionCount}/${expected.githubInstructions}`,
  });
  checks.push({
    name: "GitHub skill count",
    ok: githubSkillCount === expected.githubSkills,
    detail: `${githubSkillCount}/${expected.githubSkills}`,
  });
}

const hasFailures = checks.some((check) => !check.ok && !check.optional);
const hasWarnings = checks.some((check) => !check.ok && check.optional);

console.log(`Portable Codex Starter doctor: ${target}`);
for (const check of checks) {
  const icon = check.ok ? "[OK]" : check.optional ? "[!!]" : "[XX]";
  const suffix = check.detail ? ` (${check.detail})` : "";
  console.log(`${icon} ${check.name}${suffix}`);
}

if (hasFailures) {
  console.error("\nDoctor found blocking issues.");
  process.exitCode = 1;
} else if (hasWarnings) {
  console.log("\nDoctor found no blocking issues, but some optional files are missing.");
} else {
  console.log("\nDoctor passed.");
}

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

function checkExists(name, path) {
  return {
    name,
    ok: existsSync(path),
    optional: false,
  };
}

function checkOptional(name, path) {
  return {
    name,
    ok: existsSync(path),
    optional: true,
  };
}

async function countAgentFiles(path) {
  if (!existsSync(path)) return 0;
  const entries = await readdir(path, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".toml")).length;
}

async function countSkillDirectories(path) {
  if (!existsSync(path)) return 0;
  const entries = await readdir(path, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(path, entry.name, "SKILL.md");
    try {
      await stat(skillPath);
      count += 1;
    } catch {
      // Ignore malformed skill directories.
    }
  }
  return count;
}

async function countMarkdownFiles(path, suffix) {
  if (!existsSync(path)) return 0;
  const entries = await readdir(path, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).length;
}
