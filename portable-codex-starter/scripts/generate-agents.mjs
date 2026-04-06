import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";

const ROOT = process.cwd();
const PROMPTS_DIR = join(ROOT, "prompts");
const AGENTS_DIR = join(ROOT, ".codex", "agents");
const EXCLUDED_ROLES = new Set([]);

const LOW_ROLES = new Set([
  "explore",
  "explore-harness",
  "style-reviewer",
  "writer",
  "deepsearch",
]);

const HIGH_ROLES = new Set([
  "architect",
  "executor",
  "debugger",
  "planner",
  "analyst",
  "critic",
  "code-reviewer",
  "security-reviewer",
  "designer",
  "git-master",
  "performance-reviewer",
  "quality-reviewer",
  "build-fixer",
  "team-orchestrator",
  "vision",
]);

const ROLE_OVERRIDES = new Map([
  ["explore-harness", { sandbox_mode: "read-only" }],
]);

function stripFrontmatter(content) {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? content.slice(match[0].length).trim() : content.trim();
}

function parseDescription(content, fallback) {
  const match = content.match(/^---\r?\n[\s\S]*?description:\s*"([^"]+)"[\s\S]*?\r?\n---/m);
  const raw = match?.[1]?.trim() || fallback;
  return raw
    .replace(/\bomx\b/gi, "portable")
    .replace(/\btmux\b/gi, "interactive")
    .replace(/\s+/g, " ")
    .trim();
}

function inferReasoning(role) {
  if (LOW_ROLES.has(role)) return "low";
  if (HIGH_ROLES.has(role)) return "high";
  return "medium";
}

function sanitizeInstructions(content) {
  const lines = stripFrontmatter(content).split(/\r?\n/);
  const filtered = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      /USE_OMX_EXPLORE_CMD/i.test(line) ||
      /\bomx\b/i.test(line) ||
      /\.omx\b/i.test(line) ||
      /\btmux\b/i.test(line) ||
      /OMX_/i.test(line) ||
      /AskUserQuestion/.test(line) ||
      /request_user_input/.test(line) ||
      /state_write/.test(line) ||
      /state_read/.test(line) ||
      /ToolSearch/.test(line) ||
      /mcp__x__ask_codex/.test(line) ||
      /\bralph\b/i.test(line) ||
      /\bultrawork\b/i.test(line) ||
      /\bautopilot\b/i.test(line) ||
      /team verification path/i.test(line) ||
      /launch hints/i.test(line) ||
      /available-agent-types roster/i.test(line) ||
      /staffing \/ role-allocation guidance/i.test(line) ||
      trimmed.startsWith("<!-- OMX:")
    ) {
      continue;
    }
    filtered.push(line);
  }

  return filtered
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeToml(text) {
  return text.replace(/"{3,}/g, (match) => match.split("").join("\\"));
}

function toToml({ name, description, reasoningEffort, developerInstructions, overrides = {} }) {
  const lines = [
    `# portable-codex-starter agent: ${name}`,
    `name = "${name.replaceAll('"', '\\"')}"`,
    `description = "${description.replaceAll('"', '\\"')}"`,
    `model_reasoning_effort = "${reasoningEffort}"`,
  ];

  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string") {
      lines.push(`${key} = "${value.replaceAll('"', '\\"')}"`);
    }
  }

  lines.push(
    'developer_instructions = """',
    escapeToml(developerInstructions),
    '"""',
    "",
  );

  return lines.join("\n");
}

async function main() {
  if (!existsSync(PROMPTS_DIR)) {
    throw new Error(`prompts directory not found: ${PROMPTS_DIR}`);
  }

  await mkdir(AGENTS_DIR, { recursive: true });

  const files = (await readdir(PROMPTS_DIR))
    .filter((file) => file.endsWith(".md"))
    .sort();

  let count = 0;
  for (const file of files) {
    const role = basename(file, ".md");
    if (EXCLUDED_ROLES.has(role)) continue;
    const source = await readFile(join(PROMPTS_DIR, file), "utf8");
    const description = parseDescription(source, `${role} custom agent`);
    const developerInstructions = sanitizeInstructions(source);
    const reasoningEffort = inferReasoning(role);
    const overrides = ROLE_OVERRIDES.get(role) || {};
    const toml = toToml({
      name: role,
      description,
      reasoningEffort,
      developerInstructions,
      overrides,
    });
    await writeFile(join(AGENTS_DIR, `${role}.toml`), toml, "utf8");
    count += 1;
  }

  console.log(`Generated ${count} agent files in ${AGENTS_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
