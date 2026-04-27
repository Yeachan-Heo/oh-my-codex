import type {
  CatalogAgentEntry,
  CatalogEntryStatus,
  CatalogManifest,
} from "../catalog/schema.js";

export const NON_NATIVE_AGENT_PROMPT_ASSETS = new Set([
  "explore-harness",
  "sisyphus-lite",
  "team-orchestrator",
]);

export function isNativeAgentInstallableStatus(
  status: CatalogEntryStatus | string | undefined,
): boolean {
  return status === "active" || status === "internal";
}

export function getCatalogAgentStatusByName(
  manifest: Pick<CatalogManifest, "agents">,
): Map<string, CatalogEntryStatus> {
  return new Map(manifest.agents.map((agent) => [agent.name, agent.status]));
}

export function getCatalogAgentByName(
  manifest: Pick<CatalogManifest, "agents">,
): Map<string, CatalogAgentEntry> {
  return new Map(manifest.agents.map((agent) => [agent.name, agent]));
}

export function getInstallableNativeAgentNames(
  manifest: Pick<CatalogManifest, "agents">,
): Set<string> {
  return new Set(
    manifest.agents
      .filter((agent) => isNativeAgentInstallableStatus(agent.status))
      .map((agent) => agent.name),
  );
}

export function getNonInstallableNativeAgentNames(
  manifest: Pick<CatalogManifest, "agents">,
): Set<string> {
  return new Set(
    manifest.agents
      .filter((agent) => !isNativeAgentInstallableStatus(agent.status))
      .map((agent) => agent.name),
  );
}

export function assertNativeAgentCanonicalTargets(
  manifest: Pick<CatalogManifest, "agents">,
): void {
  const byName = getCatalogAgentByName(manifest);

  for (const agent of manifest.agents) {
    if (agent.status !== "alias" && agent.status !== "merged") continue;

    if (!agent.canonical) {
      throw new Error(
        [
          "native_agent_canonical_invalid",
          `agent=${agent.name}`,
          "message=alias/merged native agents must declare a canonical target",
        ].join("\n"),
      );
    }

    const canonical = byName.get(agent.canonical);
    if (!canonical) {
      throw new Error(
        [
          "native_agent_canonical_invalid",
          `agent=${agent.name}`,
          `canonical=${agent.canonical}`,
          "message=canonical native agent target is not listed in the catalog",
        ].join("\n"),
      );
    }

    if (!isNativeAgentInstallableStatus(canonical.status)) {
      throw new Error(
        [
          "native_agent_canonical_invalid",
          `agent=${agent.name}`,
          `canonical=${agent.canonical}`,
          `canonical_status=${canonical.status}`,
          "message=canonical native agent target must be directly installable",
        ].join("\n"),
      );
    }
  }
}
