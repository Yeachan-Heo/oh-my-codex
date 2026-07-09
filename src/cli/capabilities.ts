import { resolve } from "node:path";
import {
  DEFAULT_CAPABILITIES_LOCKFILE,
  buildCapabilitiesLockfile,
  checkCapabilitiesPreflight,
  defaultCapabilitiesLockfilePath,
  writeCapabilitiesLockfile,
  type CapabilityCheckResult,
} from "../capabilities/lockfile.js";

export const CAPABILITIES_HELP = `omx capabilities - deterministic capability lockfile and observation checks

Usage:
  omx capabilities lock [--lockfile <path>] [--json]
  omx capabilities check [--lockfile <path>] [--observations <path>] [--require-observations] [--strict-external-schemas] [--json]

Defaults:
  lockfile: ${DEFAULT_CAPABILITIES_LOCKFILE}
`;

interface ParsedCapabilitiesArgs {
  subcommand?: string;
  lockfile?: string;
  observations?: string;
  requireObservations: boolean;
  strictExternalSchemas: boolean;
  json: boolean;
  help: boolean;
}

export async function capabilitiesCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const parsed = parseCapabilitiesArgs(args);
  if (parsed.help || !parsed.subcommand) {
    console.log(CAPABILITIES_HELP);
    return;
  }
  const lockfile = parsed.lockfile ? resolve(cwd, parsed.lockfile) : defaultCapabilitiesLockfilePath(cwd);
  switch (parsed.subcommand) {
    case "lock": {
      const built = await buildCapabilitiesLockfile({ cwd });
      await writeCapabilitiesLockfile(lockfile, built);
      const result = {
        ok: true,
        lockfile,
        digests: {
          configured_tools: built.surfaces.configured_tools.digest,
          skills: built.surfaces.skills.digest,
          agents: built.surfaces.agents.digest,
          fixtures: built.surfaces.fixtures.digest,
        },
        warnings: built.surfaces.configured_tools.external_servers.map((server) => ({
          code: "external_schema_unavailable",
          server: server.name,
          message: `External MCP server '${server.name}' has no schema snapshot.`,
        })),
      };
      printResult(result, parsed.json);
      return;
    }
    case "check": {
      const result = await checkCapabilitiesPreflight({
        cwd,
        lockfilePath: lockfile,
        observationsPath: parsed.observations,
        requireObservations: parsed.requireObservations,
        strictExternalSchemas: parsed.strictExternalSchemas,
      });
      printResult(result, parsed.json);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    default:
      throw new Error(`Unknown capabilities subcommand: ${parsed.subcommand}`);
  }
}

function parseCapabilitiesArgs(args: string[]): ParsedCapabilitiesArgs {
  const parsed: ParsedCapabilitiesArgs = {
    subcommand: args[0],
    requireObservations: false,
    strictExternalSchemas: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--require-observations":
        parsed.requireObservations = true;
        break;
      case "--strict-external-schemas":
        parsed.strictExternalSchemas = true;
        break;
      case "--lockfile":
        parsed.lockfile = requireValue(args, index, arg);
        index += 1;
        break;
      case "--observations":
        parsed.observations = requireValue(args, index, arg);
        index += 1;
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown capabilities option: ${arg}`);
        break;
    }
  }
  return parsed;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function printResult(result: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const check = result as Partial<CapabilityCheckResult> & { lockfile?: string };
  console.log(`${check.ok ? "OK" : "FAIL"}: capabilities ${check.ok ? "satisfied" : "check failed"}`);
  if (check.lockfile) console.log(`lockfile: ${check.lockfile}`);
  for (const warning of check.warnings ?? []) console.warn(`warning ${warning.code}: ${warning.message}`);
  for (const failure of check.failures ?? []) console.error(`${failure.code}: ${failure.message}`);
}
