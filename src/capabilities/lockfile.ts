import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import TOML from "@iarna/toml";

export const CAPABILITIES_LOCKFILE_VERSION = 1;
export const DEFAULT_CAPABILITIES_LOCKFILE = "omx-capabilities.lock.json";

export type CapabilityFailureCode =
  | "lockfile_missing"
  | "lockfile_invalid_json"
  | "lockfile_unsupported_version"
  | "configured_tool_surface_mismatch"
  | "skill_surface_mismatch"
  | "agent_surface_mismatch"
  | "fixture_contract_mismatch"
  | "external_schema_unavailable"
  | "observations_missing"
  | "observations_invalid_json"
  | "required_observation_missing"
  | "unknown_fixture"
  | "duplicate_observation"
  | "hallucinated_tool"
  | "unavailable_tool"
  | "wrong_tool_selected"
  | "missing_required_arg"
  | "arg_schema_invalid"
  | "unexpected_tool_call"
  | "structured_output_invalid";

export interface CapabilityFailure {
  code: CapabilityFailureCode;
  message: string;
  path?: string;
  fixture_id?: string;
  tool?: string;
}

export interface CapabilityWarning {
  code: "external_schema_unavailable";
  message: string;
  server?: string;
}

export interface ToolContract {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
  server: string;
  enabled: boolean;
}

export interface ExternalMcpServerContract {
  name: string;
  config_digest: string;
  schema_status: "unavailable";
}

export interface CapabilitiesLockfile {
  version: 1;
  kind: "omx_capabilities_lock";
  surfaces: {
    configured_tools: {
      digest: string;
      tools: ToolContract[];
      disabled_first_party_servers: string[];
      external_servers: ExternalMcpServerContract[];
    };
    skills: { digest: string; files: DigestEntry[] };
    agents: { digest: string; files: DigestEntry[] };
    fixtures: { digest: string; fixtures: FixtureContract[] };
  };
}

export interface DigestEntry {
  path: string;
  digest: string;
}

export interface FixtureContract {
  id: string;
  prompt_id: string;
  required: boolean;
  allowed_tools: string[];
  expected_tool?: string;
  no_tool_calls?: boolean;
}

export interface CapabilityObservation {
  fixture_id: string;
  prompt_id?: string;
  tool_calls?: Array<{ name?: unknown; arguments?: unknown }>;
  structured_output?: unknown;
}

export interface CapabilityObservationsFile {
  version: 1;
  kind: "omx_capability_observations";
  observations: CapabilityObservation[];
}

export interface CapabilityCheckOptions {
  cwd?: string;
  codexHome?: string;
  lockfilePath?: string;
  observationsPath?: string;
  requireObservations?: boolean;
  strictExternalSchemas?: boolean;
}

export interface CapabilityCheckResult {
  ok: boolean;
  lockfile: string;
  observations_checked: boolean;
  digests: Record<string, string>;
  failures: CapabilityFailure[];
  warnings: CapabilityWarning[];
}

type JsonObject = Record<string, unknown>;

const FIRST_PARTY_SERVERS = ["state", "memory", "code_intel", "trace", "wiki", "hermes"] as const;
const FIRST_PARTY_DISABLE_ENV: Record<string, string> = {
  state: "OMX_STATE_SERVER_DISABLE_AUTO_START",
  memory: "OMX_MEMORY_SERVER_DISABLE_AUTO_START",
  code_intel: "OMX_CODE_INTEL_SERVER_DISABLE_AUTO_START",
  trace: "OMX_TRACE_SERVER_DISABLE_AUTO_START",
  wiki: "OMX_WIKI_SERVER_DISABLE_AUTO_START",
  hermes: "OMX_HERMES_SERVER_DISABLE_AUTO_START",
};

export function canonicalStringify(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

export function defaultCapabilitiesLockfilePath(cwd = process.cwd()): string {
  return join(cwd, DEFAULT_CAPABILITIES_LOCKFILE);
}

export async function buildCapabilitiesLockfile(options: CapabilityCheckOptions = {}): Promise<CapabilitiesLockfile> {
  const cwd = options.cwd ?? process.cwd();
  const [toolSurface, skills, agents] = await Promise.all([
    collectConfiguredToolSurface(cwd, options.codexHome),
    collectDigestEntries(cwd, ["skills"], ["SKILL.md", "catalog.json", "metadata.json"]),
    collectDigestEntries(cwd, ["prompts", join("templates", "model-instructions")], [".md", ".toml", ".json"]),
  ]);
  const fixtures = buildFixtureContracts(toolSurface.tools.filter((tool) => tool.enabled).map((tool) => tool.name));
  return {
    version: CAPABILITIES_LOCKFILE_VERSION,
    kind: "omx_capabilities_lock",
    surfaces: {
      configured_tools: toolSurface,
      skills: { digest: digestEntries(skills), files: skills },
      agents: { digest: digestEntries(agents), files: agents },
      fixtures: { digest: sha256(canonicalStringify(fixtures)), fixtures },
    },
  };
}

export async function writeCapabilitiesLockfile(path: string, lockfile: CapabilitiesLockfile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, canonicalStringify(lockfile), "utf8");
}

export async function checkCapabilitiesPreflight(options: CapabilityCheckOptions = {}): Promise<CapabilityCheckResult> {
  const cwd = options.cwd ?? process.cwd();
  const lockfile = options.lockfilePath ? resolve(cwd, options.lockfilePath) : defaultCapabilitiesLockfilePath(cwd);
  const failures: CapabilityFailure[] = [];
  const warnings: CapabilityWarning[] = [];
  let expected: CapabilitiesLockfile;
  try {
    expected = JSON.parse(await readFile(lockfile, "utf8")) as CapabilitiesLockfile;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "lockfile_missing" : "lockfile_invalid_json";
    return emptyResult(lockfile, code, code === "lockfile_missing" ? "Capabilities lockfile is missing." : "Capabilities lockfile is invalid JSON.");
  }
  if (expected.version !== CAPABILITIES_LOCKFILE_VERSION || expected.kind !== "omx_capabilities_lock") {
    return emptyResult(lockfile, "lockfile_unsupported_version", "Capabilities lockfile version is unsupported.");
  }

  const current = await buildCapabilitiesLockfile({ cwd, codexHome: options.codexHome });
  compareDigest(failures, "configured_tool_surface_mismatch", "Configured tool surface changed.", expected.surfaces.configured_tools.digest, current.surfaces.configured_tools.digest);
  compareDigest(failures, "skill_surface_mismatch", "Skill surface changed.", expected.surfaces.skills.digest, current.surfaces.skills.digest);
  compareDigest(failures, "agent_surface_mismatch", "Agent surface changed.", expected.surfaces.agents.digest, current.surfaces.agents.digest);
  compareDigest(failures, "fixture_contract_mismatch", "Fixture contracts changed.", expected.surfaces.fixtures.digest, current.surfaces.fixtures.digest);

  for (const server of current.surfaces.configured_tools.external_servers) {
    const warning = { code: "external_schema_unavailable" as const, server: server.name, message: `External MCP server '${server.name}' has no schema snapshot.` };
    if (options.strictExternalSchemas) failures.push({ ...warning, code: "external_schema_unavailable" });
    else warnings.push(warning);
  }

  const observationsChecked = Boolean(options.observationsPath);
  if (options.requireObservations && !options.observationsPath) {
    failures.push({ code: "observations_missing", message: "Capability observations are required." });
  }
  if (options.observationsPath) {
    await validateObservations(resolve(cwd, options.observationsPath), expected, failures);
  }

  return {
    ok: failures.length === 0,
    lockfile,
    observations_checked: observationsChecked,
    digests: {
      configured_tools: current.surfaces.configured_tools.digest,
      skills: current.surfaces.skills.digest,
      agents: current.surfaces.agents.digest,
      fixtures: current.surfaces.fixtures.digest,
    },
    failures,
    warnings,
  };
}

function emptyResult(lockfile: string, code: CapabilityFailureCode, message: string): CapabilityCheckResult {
  return { ok: false, lockfile, observations_checked: false, digests: {}, failures: [{ code, message }], warnings: [] };
}

function compareDigest(failures: CapabilityFailure[], code: CapabilityFailureCode, message: string, expected: string, actual: string): void {
  if (expected !== actual) failures.push({ code, message });
}

async function collectConfiguredToolSurface(cwd: string, codexHome?: string): Promise<CapabilitiesLockfile["surfaces"]["configured_tools"]> {
  const priorEnv = new Map<string, string | undefined>();
  const disabledFirstPartyServers = FIRST_PARTY_SERVERS.filter((server) => process.env[FIRST_PARTY_DISABLE_ENV[server]] === "1");
  for (const envName of Object.values(FIRST_PARTY_DISABLE_ENV)) {
    priorEnv.set(envName, process.env[envName]);
    process.env[envName] = "1";
  }
  try {
    const [state, memory, codeIntel, trace, wiki, hermes] = await Promise.all([
      import("../mcp/state-server.js"),
      import("../mcp/memory-server.js"),
      import("../mcp/code-intel-server.js"),
      import("../mcp/trace-server.js"),
      import("../mcp/wiki-server.js"),
      import("../mcp/hermes-server.js"),
    ]);
    const builders: Record<string, () => Array<{ name: string; description?: string; inputSchema?: JsonObject }>> = {
      state: () => state.buildStateServerTools(),
      memory: () => memory.buildMemoryServerTools(),
      code_intel: () => codeIntel.buildCodeIntelServerTools(),
      trace: () => trace.buildTraceServerTools(),
      wiki: () => wiki.buildWikiServerTools(),
      hermes: () => hermes.buildHermesServerTools(),
    };
    const disabled = disabledFirstPartyServers;
    const tools = Object.entries(builders).flatMap(([server, build]) =>
      build().map((tool) => ({ ...normalizeTool(tool), server, enabled: !disabled.includes(server as (typeof FIRST_PARTY_SERVERS)[number]) })),
    ).sort((a, b) => `${a.server}:${a.name}`.localeCompare(`${b.server}:${b.name}`));
    const externalServers = await collectExternalMcpServers(cwd, codexHome);
    const digestInput = { tools, disabled_first_party_servers: disabled, external_servers: externalServers };
    return { ...digestInput, digest: sha256(canonicalStringify(digestInput)) };
  } finally {
    for (const [envName, value] of priorEnv) {
      if (value === undefined) delete process.env[envName];
      else process.env[envName] = value;
    }
  }
}

function normalizeTool(tool: { name: string; description?: string; inputSchema?: JsonObject }): ToolContract {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, server: "", enabled: true };
}

async function collectExternalMcpServers(cwd: string, codexHome?: string): Promise<ExternalMcpServerContract[]> {
  const configPaths = [join(cwd, ".codex", "config.toml")];
  if (codexHome) configPaths.push(join(codexHome, "config.toml"));
  const servers = new Map<string, ExternalMcpServerContract>();
  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;
    try {
      const parsed = TOML.parse(await readFile(configPath, "utf8")) as JsonObject;
      const rawServers = parsed.mcp_servers;
      if (!rawServers || typeof rawServers !== "object") continue;
      for (const [name, config] of Object.entries(rawServers as JsonObject)) {
        if (String(name).startsWith("omx-")) continue;
        servers.set(name, { name, config_digest: sha256(canonicalStringify(config)), schema_status: "unavailable" });
      }
    } catch {
      continue;
    }
  }
  return [...servers.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function collectDigestEntries(cwd: string, roots: string[], suffixes: string[]): Promise<DigestEntry[]> {
  const entries: DigestEntry[] = [];
  for (const root of roots) {
    await walkDigest(join(cwd, root), cwd, suffixes, entries);
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function walkDigest(dir: string, cwd: string, suffixes: string[], entries: DigestEntry[]): Promise<void> {
  let children: import("node:fs").Dirent[];
  try {
    children = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const child of children) {
    const path = join(dir, child.name);
    if (child.isDirectory()) {
      await walkDigest(path, cwd, suffixes, entries);
    } else if (suffixes.some((suffix) => child.name === suffix || child.name.endsWith(suffix))) {
      entries.push({ path: relative(cwd, path).replaceAll("\\", "/"), digest: sha256(await readFile(path, "utf8")) });
    }
  }
}

function digestEntries(entries: DigestEntry[]): string {
  return sha256(canonicalStringify(entries));
}

function buildFixtureContracts(allowedTools: string[]): FixtureContract[] {
  const sortedAllowed = [...allowedTools].sort();
  const choose = (preferred: string, fallback: string) => sortedAllowed.includes(preferred) ? preferred : fallback;
  const writeTool = choose("project_memory_write", sortedAllowed[0] ?? "project_memory_write");
  const readTool = choose("project_memory_read", sortedAllowed[0] ?? "project_memory_read");
  return [
    { id: "project-memory-write-required-arg", prompt_id: "missing-required-arg", required: true, allowed_tools: sortedAllowed, expected_tool: writeTool },
    { id: "project-memory-read-known-tool", prompt_id: "known-tool-success", required: true, allowed_tools: sortedAllowed, expected_tool: readTool },
    { id: "tool-restraint-no-call", prompt_id: "tool-restraint", required: true, allowed_tools: [], no_tool_calls: true },
  ];
}

async function validateObservations(path: string, lockfile: CapabilitiesLockfile, failures: CapabilityFailure[]): Promise<void> {
  let parsed: CapabilityObservationsFile;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as CapabilityObservationsFile;
  } catch {
    failures.push({ code: "observations_invalid_json", message: "Capability observations are invalid JSON.", path });
    return;
  }
  if (parsed.version !== 1 || parsed.kind !== "omx_capability_observations" || !Array.isArray(parsed.observations)) {
    failures.push({ code: "observations_invalid_json", message: "Capability observations have an unsupported shape.", path });
    return;
  }
  const fixtures = new Map(lockfile.surfaces.fixtures.fixtures.map((fixture) => [fixture.id, fixture]));
  const seen = new Set<string>();
  const availableTools = new Map(lockfile.surfaces.configured_tools.tools.filter((tool) => tool.enabled).map((tool) => [tool.name, tool]));
  for (const observation of parsed.observations) {
    const fixture = fixtures.get(observation.fixture_id);
    if (!fixture) {
      failures.push({ code: "unknown_fixture", message: `Unknown fixture '${observation.fixture_id}'.`, fixture_id: observation.fixture_id });
      continue;
    }
    if (seen.has(observation.fixture_id)) {
      failures.push({ code: "duplicate_observation", message: `Duplicate observation for fixture '${observation.fixture_id}'.`, fixture_id: observation.fixture_id });
      continue;
    }
    seen.add(observation.fixture_id);
    validateObservation(fixture, observation, availableTools, failures);
  }
  for (const fixture of fixtures.values()) {
    if (fixture.required && !seen.has(fixture.id)) {
      failures.push({ code: "required_observation_missing", message: `Required observation '${fixture.id}' is missing.`, fixture_id: fixture.id });
    }
  }
}

function validateObservation(fixture: FixtureContract, observation: CapabilityObservation, availableTools: Map<string, ToolContract>, failures: CapabilityFailure[]): void {
  const calls = Array.isArray(observation.tool_calls) ? observation.tool_calls : [];
  if (fixture.no_tool_calls && calls.length > 0) {
    failures.push({ code: "unexpected_tool_call", message: `Fixture '${fixture.id}' requires tool restraint.`, fixture_id: fixture.id });
  }
  for (const call of calls) {
    if (typeof call.name !== "string") {
      failures.push({ code: "arg_schema_invalid", message: "Tool call name must be a string.", fixture_id: fixture.id });
      continue;
    }
    const tool = availableTools.get(call.name);
    if (!tool) {
      failures.push({ code: "hallucinated_tool", message: `Tool '${call.name}' is not in the configured surface.`, fixture_id: fixture.id, tool: call.name });
      continue;
    }
    if (!fixture.allowed_tools.includes(call.name)) {
      failures.push({ code: "unavailable_tool", message: `Tool '${call.name}' is not allowed for fixture '${fixture.id}'.`, fixture_id: fixture.id, tool: call.name });
    }
    if (fixture.expected_tool && call.name !== fixture.expected_tool) {
      failures.push({ code: "wrong_tool_selected", message: `Expected '${fixture.expected_tool}' but observed '${call.name}'.`, fixture_id: fixture.id, tool: call.name });
    }
    validateRequiredArgs(tool, call.arguments, fixture.id, failures);
  }
}

function validateRequiredArgs(tool: ToolContract, args: unknown, fixtureId: string, failures: CapabilityFailure[]): void {
  const schema = tool.inputSchema;
  if (!schema) return;
  const required = Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : [];
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    if (required.length > 0) {
      failures.push({ code: "missing_required_arg", message: `Tool '${tool.name}' is missing required arguments: ${required.join(", ")}.`, fixture_id: fixtureId, tool: tool.name });
    } else if (schema.type === "object") {
      failures.push({ code: "arg_schema_invalid", message: `Tool '${tool.name}' arguments must be an object.`, fixture_id: fixtureId, tool: tool.name });
    }
    return;
  }
  for (const name of required) {
    if (!Object.prototype.hasOwnProperty.call(args, name)) {
      failures.push({ code: "missing_required_arg", message: `Tool '${tool.name}' is missing required argument '${name}'.`, fixture_id: fixtureId, tool: tool.name });
    }
  }
  validatePropertyTypes(tool, args as JsonObject, schema, fixtureId, failures);
}

function validatePropertyTypes(tool: ToolContract, args: JsonObject, schema: JsonObject, fixtureId: string, failures: CapabilityFailure[]): void {
  if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) return;
  for (const [name, rawProperty] of Object.entries(schema.properties as JsonObject)) {
    if (!Object.prototype.hasOwnProperty.call(args, name)) continue;
    if (!rawProperty || typeof rawProperty !== "object" || Array.isArray(rawProperty)) continue;
    const expectedType = (rawProperty as JsonObject).type;
    if (typeof expectedType !== "string" || isJsonSchemaType(args[name], expectedType)) continue;
    failures.push({ code: "arg_schema_invalid", message: `Tool '${tool.name}' argument '${name}' must be ${expectedType}.`, fixture_id: fixtureId, tool: tool.name });
  }
}

function isJsonSchemaType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case "array":
      return Array.isArray(value);
    case "object":
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}
