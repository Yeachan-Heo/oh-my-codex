import { readFile } from 'fs/promises';
import { isAbsolute, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { getPackageRoot } from '../utils/package.js';
import { spawnPlatformCommandSync } from '../utils/platform-command.js';
import { resolveSparkShellBinaryPathWithHydration, runSparkShellBinary } from './sparkshell.js';
import { getMainDefaultModel, getSparkDefaultModel } from '../config/models.js';
import {
  EXPLORE_BIN_ENV as EXPLORE_BIN_ENV_SHARED,
  hydrateNativeBinary,
  isRepositoryCheckout,
  resolveCachedNativeBinaryPath,
  getPackageVersion,
} from './native-assets.js';

export const EXPLORE_USAGE = [
  'Usage: omx explore --prompt "<prompt>"',
  '   or: omx explore --prompt-file <file>',
].join('\n');

const PROMPT_FLAG = '--prompt';
const PROMPT_FILE_FLAG = '--prompt-file';
export const EXPLORE_BIN_ENV = EXPLORE_BIN_ENV_SHARED;
const EXPLORE_SPARK_MODEL_ENV = 'OMX_EXPLORE_SPARK_MODEL';

export interface ParsedExploreArgs {
  prompt?: string;
  promptFile?: string;
}

interface ExploreHarnessCommand {
  command: string;
  args: string[];
}


interface ExploreHarnessMetadata {
  binaryName?: string;
  platform?: string;
  arch?: string;
}


const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'log',
  'diff',
  'status',
  'show',
  'branch',
  'rev-parse',
]);

const SHELL_ROUTE_DISALLOWED_PATTERN = /[|&;><`$()]/;
const EXPLICIT_SHELL_PREFIX_PATTERN = /^run\s+/i;

export interface ExploreSparkShellRoute {
  argv: string[];
  reason: 'shell-native' | 'long-output';
}

function tokenizeExploreShellCommand(commandText: string): string[] | undefined {
  const trimmed = commandText.trim();
  if (!trimmed || SHELL_ROUTE_DISALLOWED_PATTERN.test(trimmed) || trimmed.includes('\\')) return undefined;

  const tokens = trimmed.match(/"[^"]*"|'[^']*'|\S+/g);
  if (!tokens) return undefined;
  return tokens.map((token) => {
    if ((token.startsWith('\"') && token.endsWith('\"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function isReadOnlyGitArgs(args: readonly string[]): boolean {
  const subcommand = args[1]?.toLowerCase();
  if (!subcommand || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return false;
  if (subcommand === 'diff') {
    return args.some((arg) => /^--(?:stat|name-only|name-status|numstat|shortstat)$/.test(arg));
  }
  if (subcommand === 'show') {
    return args.some((arg) => /^--(?:stat|summary|name-only|name-status)$/.test(arg));
  }
  return true;
}

function classifyLongOutputShellCommand(args: readonly string[]): boolean {
  const [command, subcommand] = args;
  if (command === 'git') {
    return ['log', 'diff', 'status', 'show'].includes((subcommand || '').toLowerCase());
  }
  return ['find', 'ls', 'rg', 'grep'].includes(command);
}

export function resolveExploreSparkShellRoute(prompt: string): ExploreSparkShellRoute | undefined {
  const explicitShellPrefix = EXPLICIT_SHELL_PREFIX_PATTERN.test(prompt.trim());
  const normalized = prompt.trim().replace(EXPLICIT_SHELL_PREFIX_PATTERN, '');
  const argv = tokenizeExploreShellCommand(normalized);
  if (!argv || argv.length === 0) return undefined;

  const command = argv[0]?.toLowerCase();
  if (!command) return undefined;

  if (command === 'git' && isReadOnlyGitArgs(argv)) {
    return {
      argv,
      reason: classifyLongOutputShellCommand(argv) ? 'long-output' : 'shell-native',
    };
  }

  const shellNativeShape = explicitShellPrefix || argv.slice(1).some((arg) => (
    arg.startsWith('-')
    || arg.includes('/')
    || arg === '.'
    || arg.includes('*')
  ));

  if (
    explicitShellPrefix
    && shellNativeShape
    && ['find', 'ls', 'rg', 'grep'].includes(command)
    && argv.slice(1).every((arg) => !arg.startsWith('/') && !arg.startsWith('..'))
  ) {
    return {
      argv,
      reason: classifyLongOutputShellCommand(argv) ? 'long-output' : 'shell-native',
    };
  }

  return undefined;
}

async function runExploreViaSparkShell(route: ExploreSparkShellRoute, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const binaryPath = await resolveSparkShellBinaryPathWithHydration({ cwd: process.cwd(), env });
  const result = runSparkShellBinary(binaryPath, route.argv, { cwd: process.cwd(), env });

  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException;
    throw new Error(`[explore] failed to launch sparkshell backend: ${errno.message}`);
  }

  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
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

export function repoBuiltExploreHarnessCommand(
  packageRoot = getPackageRoot(),
  platform: NodeJS.Platform = process.platform,
): ExploreHarnessCommand | undefined {
  const binaryName = packagedExploreHarnessBinaryName(platform);
  for (const mode of ['release', 'debug'] as const) {
    const binaryPath = join(packageRoot, 'target', mode, binaryName);
    if (existsSync(binaryPath)) {
      return { command: binaryPath, args: [] };
    }
  }
  return undefined;
}

function exploreUsageError(reason: string): Error {
  return new Error(`${reason}\n${EXPLORE_USAGE}`);
}

function appendPromptValue(current: string | undefined, value: string, reason: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw exploreUsageError(reason);
  if (current !== undefined) throw exploreUsageError('Duplicate --prompt provided.');
  return trimmed;
}

function appendPromptFileValue(current: string | undefined, value: string, reason: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw exploreUsageError(reason);
  if (current !== undefined) throw exploreUsageError('Duplicate --prompt-file provided.');
  return trimmed;
}

function hasPromptSource(tokens: readonly string[], flag: string): boolean {
  return tokens.some((token) => token === flag || token.startsWith(`${flag}=`));
}

export function parseExploreArgs(args: readonly string[]): ParsedExploreArgs {
  let prompt: string | undefined;
  let promptFile: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === PROMPT_FLAG) {
      const remaining = args.slice(i + 1);
      if (remaining.length === 0 || remaining[0].startsWith('-')) {
        throw exploreUsageError('Missing text after --prompt.');
      }
      if (hasPromptSource(remaining, PROMPT_FILE_FLAG)) {
        throw exploreUsageError('Choose exactly one of --prompt or --prompt-file.');
      }
      prompt = appendPromptValue(prompt, remaining.join(' '), 'Missing text after --prompt.');
      break;
    }
    if (token.startsWith(`${PROMPT_FLAG}=`)) {
      const remaining = args.slice(i + 1);
      if (hasPromptSource(remaining, PROMPT_FILE_FLAG)) {
        throw exploreUsageError('Choose exactly one of --prompt or --prompt-file.');
      }
      prompt = appendPromptValue(prompt, token.slice(`${PROMPT_FLAG}=`.length), 'Missing text after --prompt=.');
      continue;
    }
    if (token === PROMPT_FILE_FLAG) {
      const value = args[i + 1];
      if (!value || value.startsWith('-')) throw exploreUsageError('Missing path after --prompt-file.');
      promptFile = appendPromptFileValue(promptFile, value, 'Missing path after --prompt-file.');
      i += 1;
      continue;
    }
    if (token.startsWith(`${PROMPT_FILE_FLAG}=`)) {
      promptFile = appendPromptFileValue(promptFile, token.slice(`${PROMPT_FILE_FLAG}=`.length), 'Missing path after --prompt-file=.');
      continue;
    }
    throw exploreUsageError(`Unknown argument: ${token}`);
  }

  if (prompt && promptFile) {
    throw exploreUsageError('Choose exactly one of --prompt or --prompt-file.');
  }
  if (!prompt && !promptFile) {
    throw exploreUsageError('Missing prompt. Provide --prompt or --prompt-file.');
  }

  return {
    ...(prompt ? { prompt } : {}),
    ...(promptFile ? { promptFile } : {}),
  };
}

export function resolveExploreHarnessCommand(
  packageRoot = getPackageRoot(),
  env: NodeJS.ProcessEnv = process.env,
): ExploreHarnessCommand {
  const override = env[EXPLORE_BIN_ENV]?.trim();
  if (override) {
    return { command: isAbsolute(override) ? override : join(packageRoot, override), args: [] };
  }

  const packaged = resolvePackagedExploreHarnessCommand(packageRoot);
  if (packaged) return packaged;

  const repoBuilt = repoBuiltExploreHarnessCommand(packageRoot);
  if (repoBuilt) return repoBuilt;

  const manifestPath = join(packageRoot, 'crates', 'omx-explore', 'Cargo.toml');
  if (!existsSync(manifestPath)) {
    throw new Error(`[explore] neither a compatible packaged harness binary nor Rust manifest was found (${manifestPath})`);
  }

  return {
    command: 'cargo',
    args: ['run', '--quiet', '--manifest-path', manifestPath, '--'],
  };
}

export async function resolveExploreHarnessCommandWithHydration(
  packageRoot = getPackageRoot(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExploreHarnessCommand> {
  const override = env[EXPLORE_BIN_ENV]?.trim();
  if (override) {
    return { command: isAbsolute(override) ? override : join(packageRoot, override), args: [] };
  }

  const version = await getPackageVersion(packageRoot);
  const cached = resolveCachedNativeBinaryPath('omx-explore-harness', version, process.platform, process.arch, env);
  if (existsSync(cached)) {
    return { command: cached, args: [] };
  }

  const packaged = resolvePackagedExploreHarnessCommand(packageRoot);
  if (packaged) return packaged;

  const repoBuilt = repoBuiltExploreHarnessCommand(packageRoot);
  if (repoBuilt) return repoBuilt;

  if (!isRepositoryCheckout(packageRoot)) {
    const hydrated = await hydrateNativeBinary('omx-explore-harness', { packageRoot, env });
    if (hydrated) return { command: hydrated, args: [] };
    throw new Error('[explore] no compatible native harness is available for this install. Reconnect to the network so OMX can fetch the release asset, or set OMX_EXPLORE_BIN to a prebuilt harness binary.');
  }

  return resolveExploreHarnessCommand(packageRoot, env);
}

export function buildExploreHarnessArgs(
  prompt: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  packageRoot = getPackageRoot(),
): string[] {
  const sparkModel = env[EXPLORE_SPARK_MODEL_ENV]?.trim() || getSparkDefaultModel();
  return [
    '--cwd', cwd,
    '--prompt', prompt,
    '--prompt-file', join(packageRoot, 'prompts', 'explore-harness.md'),
    '--model-spark', sparkModel,
    '--model-fallback', getMainDefaultModel(),
  ];
}

export async function loadExplorePrompt(parsed: ParsedExploreArgs): Promise<string> {
  if (parsed.prompt) return parsed.prompt;
  if (!parsed.promptFile) throw exploreUsageError('Missing prompt. Provide --prompt or --prompt-file.');
  const content = await readFile(parsed.promptFile, 'utf-8');
  const trimmed = content.trim();
  if (!trimmed) throw exploreUsageError(`Prompt file is empty: ${parsed.promptFile}`);
  return trimmed;
}

export async function exploreCommand(args: string[]): Promise<void> {
  const parsed = parseExploreArgs(args);
  const prompt = await loadExplorePrompt(parsed);
  const sparkShellRoute = resolveExploreSparkShellRoute(prompt);
  if (sparkShellRoute) {
    try {
      await runExploreViaSparkShell(sparkShellRoute, process.env);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[omx explore] sparkshell backend unavailable (${message}). Falling back to the explore harness.\n`);
    }
  }

  const packageRoot = getPackageRoot();
  const harness = await resolveExploreHarnessCommandWithHydration(packageRoot, process.env);
  const harnessArgs = [...harness.args, ...buildExploreHarnessArgs(prompt, process.cwd(), process.env, packageRoot)];

  const { result } = spawnPlatformCommandSync(harness.command, harnessArgs, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.stdout && result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr && result.stderr.length > 0) process.stderr.write(result.stderr);

  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException;
    if (harness.command === 'cargo' && errno.code === 'ENOENT') {
      throw new Error('[explore] cargo was not found. Install a Rust toolchain, use a compatible packaged omx-explore prebuilt, or set OMX_EXPLORE_BIN to a prebuilt harness binary.');
    }
    throw new Error(`[explore] failed to launch harness: ${result.error.message}`);
  }

  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}
