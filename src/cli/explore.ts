import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getPackageRoot } from '../utils/package.js';
import { EXPLORE_BIN_ENV as EXPLORE_BIN_ENV_SHARED } from './native-assets.js';

export const EXPLORE_BIN_ENV = EXPLORE_BIN_ENV_SHARED;

export const EXPLORE_DEPRECATION_MESSAGE = [
  'omx explore is hard-deprecated and the direct command surface has been removed.',
  'Use normal Codex repository inspection tools/subagents for read-only repository lookups.',
  'Use `omx sparkshell -- <command>` only for explicit shell-native read-only evidence or `--tmux-pane` summaries.',
].join(' ');

export const EXPLORE_HELP = `omx explore - Hard-deprecated legacy command surface

Usage:
  omx explore --help

Deprecated legacy forms (all fail intentionally):
  omx explore --prompt "<prompt>"
  omx explore --prompt-file <file>

Migration:
  - Use normal Codex repository inspection tools/subagents for simple read-only repository lookups.
  - Use \`omx sparkshell -- <command>\` for explicit shell-native read-only evidence or \`--tmux-pane\` summaries.
`;

const WINDOWS_BUILTIN_EXPLORE_HARNESS_REASON =
  'the built-in explore harness is not ready on Windows because its allowlist runtime relies on POSIX sh/bash wrappers. Set OMX_EXPLORE_BIN to a compatible custom harness, prefer `omx sparkshell` for shell-native read-only lookups, or run `omx doctor` for readiness details.';

interface ExploreHarnessCommand {
  command: string;
  args: string[];
}

interface ExploreHarnessMetadata {
  binaryName?: string;
  platform?: string;
  arch?: string;
}

export function getBuiltinExploreHarnessUnsupportedReason(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (platform !== 'win32') return undefined;
  if (env[EXPLORE_BIN_ENV]?.trim()) return undefined;
  return WINDOWS_BUILTIN_EXPLORE_HARNESS_REASON;
}

export function assertBuiltinExploreHarnessSupported(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const reason = getBuiltinExploreHarnessUnsupportedReason(platform, env);
  if (reason) throw new Error(`[explore] ${reason}`);
}

export function packagedExploreHarnessBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'omx-explore-harness.exe' : 'omx-explore-harness';
}

export function resolvePackagedExploreHarnessCommand(
  packageRoot = getPackageRoot(),
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): ExploreHarnessCommand | undefined {
  const metadataPath = join(packageRoot, 'bin', 'omx-explore-harness.meta.json');
  if (!existsSync(metadataPath)) return undefined;
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8')) as ExploreHarnessMetadata;
    const expectedPlatform = metadata.platform?.trim();
    const expectedArch = metadata.arch?.trim();
    if (expectedPlatform && expectedPlatform !== platform) return undefined;
    if (expectedArch && expectedArch !== arch) return undefined;
    const binaryName = metadata.binaryName?.trim() || packagedExploreHarnessBinaryName(platform);
    const binaryPath = join(packageRoot, 'bin', binaryName);
    if (!existsSync(binaryPath)) return undefined;
    return { command: binaryPath, args: [] };
  } catch {
    return undefined;
  }
}

function shouldShowHelp(args: readonly string[]): boolean {
  return args.length > 0 && args.every((arg) => arg === '--help' || arg === '-h' || arg === 'help');
}

export async function exploreCommand(args: string[]): Promise<void> {
  if (shouldShowHelp(args)) {
    console.log(EXPLORE_HELP);
    return;
  }

  throw new Error(`${EXPLORE_DEPRECATION_MESSAGE}\n\n${EXPLORE_HELP}`);
}
