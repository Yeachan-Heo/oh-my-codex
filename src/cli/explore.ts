import { readFile } from 'fs/promises';
import { isAbsolute, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { getPackageRoot } from '../utils/package.js';
import { spawnPlatformCommandSync } from '../utils/platform-command.js';
import { DEFAULT_FRONTIER_MODEL, getSparkDefaultModel } from '../config/models.js';

export const EXPLORE_USAGE = [
  'Usage: omx explore --prompt "<prompt>"',
  '   or: omx explore --prompt-file <file>',
].join('\n');

const PROMPT_FLAG = '--prompt';
const PROMPT_FILE_FLAG = '--prompt-file';
export const EXPLORE_BIN_ENV = 'OMX_EXPLORE_BIN';
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

  const manifestPath = join(packageRoot, 'crates', 'omx-explore', 'Cargo.toml');
  if (!existsSync(manifestPath)) {
    throw new Error(`[explore] neither a compatible packaged harness binary nor Rust manifest was found (${manifestPath})`);
  }

  return {
    command: 'cargo',
    args: ['run', '--quiet', '--manifest-path', manifestPath, '--'],
  };
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
    '--prompt-file', join(packageRoot, 'prompts', 'explore.md'),
    '--model-spark', sparkModel,
    '--model-fallback', DEFAULT_FRONTIER_MODEL,
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
  const packageRoot = getPackageRoot();
  const harness = resolveExploreHarnessCommand(packageRoot, process.env);
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
