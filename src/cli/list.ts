import { readCatalogManifest, toPublicCatalogContract } from "../catalog/reader.js";
import type { CatalogAgentEntry, CatalogSkillEntry } from "../catalog/schema.js";

const LIST_USAGE = [
  "Usage:",
  "  omx list [--json]",
  "",
  "List OMX skills and native agent prompts from the packaged catalog.",
].join("\n");

function formatEntry(entry: CatalogSkillEntry | CatalogAgentEntry): string {
  const parts = [`${entry.name}`, entry.category, entry.status];
  if (entry.canonical) parts.push(`-> ${entry.canonical}`);
  return `- ${parts.join("  ")}`;
}

function printHumanList(contract: ReturnType<typeof toPublicCatalogContract>): void {
  console.log(`OMX catalog ${contract.version}`);
  console.log(
    `Skills: ${contract.counts.skillCount} (${contract.counts.activeSkillCount} active)`,
  );
  for (const skill of contract.skills) console.log(formatEntry(skill));
  console.log(
    `Agents: ${contract.counts.promptCount} (${contract.counts.activeAgentCount} active)`,
  );
  for (const agent of contract.agents) console.log(formatEntry(agent));
}

export async function listCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(LIST_USAGE);
    return;
  }

  const unknown = args.filter((arg) => arg !== "--json");
  if (unknown.length > 0) {
    throw new Error(`unknown list option: ${unknown[0]}`);
  }

  const manifest = readCatalogManifest();
  const contract = toPublicCatalogContract(manifest);

  if (args.includes("--json")) {
    console.log(JSON.stringify(contract));
    return;
  }

  printHumanList(contract);
}
