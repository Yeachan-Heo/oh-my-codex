/**
 * Code Simplifier Stop Hook
 *
 * Intercepts agent turn completions to automatically delegate recently modified
 * files to the code-simplifier agent for cleanup and simplification.
 *
 * Opt-in via ~/.omx/config.json: { "codeSimplifier": { "enabled": true } }
 * Default: disabled (opt-in only)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir as osHomedir } from 'os';
import { execSync } from 'child_process';

/** Config shape for the code-simplifier feature */
export interface CodeSimplifierConfig {
  enabled: boolean;
  /** File extensions to include (default: common source extensions) */
  extensions?: string[];
  /** Maximum number of files to simplify per trigger (default: 10) */
  maxFiles?: number;
}

/** Global OMX config shape (subset relevant to code-simplifier) */
interface OmxGlobalConfig {
  codeSimplifier?: CodeSimplifierConfig;
}

/** Result returned from processCodeSimplifier */
export interface CodeSimplifierResult {
  triggered: boolean;
  message: string;
}

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'];
const DEFAULT_MAX_FILES = 10;

/** Marker filename used to prevent re-triggering within the same turn cycle */
export const TRIGGER_MARKER_FILENAME = 'code-simplifier-triggered.marker';

/**
 * Read the global OMX config from ~/.omx/config.json.
 * Returns null if the file does not exist or cannot be parsed.
 */
export function readOmxConfig(configDir?: string): OmxGlobalConfig | null {
  const home = configDir ?? (process.env.HOME || process.env.USERPROFILE || osHomedir());
  const configPath = join(home, '.omx', 'config.json');

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as OmxGlobalConfig;
  } catch {
    return null;
  }
}

/**
 * Check whether the code-simplifier feature is enabled in config.
 * Disabled by default — requires explicit opt-in.
 */
export function isCodeSimplifierEnabled(configDir?: string): boolean {
  const config = readOmxConfig(configDir);
  return config?.codeSimplifier?.enabled === true;
}

/**
 * Get list of changed source files via `git status --porcelain`.
 * Includes modified, added, renamed-new-path, and untracked files.
 * Excludes deleted entries and any path that no longer exists.
 * Returns an empty array if git is unavailable or no files are modified.
 */
export function getModifiedFiles(
  cwd: string,
  extensions: string[] = DEFAULT_EXTENSIONS,
  maxFiles: number = DEFAULT_MAX_FILES,
): string[] {
  try {
    const output = execSync('git status --porcelain --untracked-files=all', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const lines = output
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);

    if (lines.length === 0) {
      return [];
    }

    const candidates = lines
      .flatMap((line) => {
        if (line.startsWith('?? ')) {
          return [line.slice(3).trim()];
        }

        const status = line.slice(0, 2);
        const rawPath = line.slice(3).trim();
        if (status.includes('D')) {
          return [];
        }

        const renamedParts = rawPath.split(' -> ');
        const resolvedPath = renamedParts.length > 1 ? renamedParts[renamedParts.length - 1] : rawPath;
        return [resolvedPath.trim()];
      });

    return candidates
      .filter((file) => file.length > 0)
      .filter((file) => extensions.some((ext) => file.endsWith(ext)))
      .filter((file) => existsSync(join(cwd, file)))
      .slice(0, maxFiles);
  } catch {
    return [];
  }
}

/**
 * Check whether the code-simplifier was already triggered this turn
 * (marker file present in the state directory).
 */
export function isAlreadyTriggered(stateDir: string): boolean {
  return existsSync(join(stateDir, TRIGGER_MARKER_FILENAME));
}

/**
 * Write the trigger marker to prevent re-triggering in the same turn cycle.
 */
export function writeTriggerMarker(stateDir: string): void {
  try {
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }
    writeFileSync(join(stateDir, TRIGGER_MARKER_FILENAME), new Date().toISOString(), 'utf-8');
  } catch {
    // Ignore write errors — marker is best-effort
  }
}

/**
 * Clear the trigger marker after a completed simplification round,
 * allowing the hook to trigger again on the next turn.
 */
export function clearTriggerMarker(stateDir: string): void {
  try {
    const markerPath = join(stateDir, TRIGGER_MARKER_FILENAME);
    if (existsSync(markerPath)) {
      unlinkSync(markerPath);
    }
  } catch {
    // Ignore removal errors
  }
}

/**
 * Build the message injected into the agent's context when code-simplifier triggers.
 */
export function buildSimplifierMessage(files: string[]): string {
  const fileList = files.map((f) => `  - ${f}`).join('\n');
  const fileArgs = files.join('\\n');

  return (
    `[CODE SIMPLIFIER] Recently modified files detected. Delegate to the ` +
    `code-simplifier agent to simplify the following files for clarity, ` +
    `consistency, and maintainability (without changing behavior):\n\n` +
    `${fileList}\n\n` +
    `Use: @code-simplifier "Simplify the recently modified files:\\n${fileArgs}"`
  );
}

/**
 * Process the code-simplifier hook logic.
 *
 * Logic:
 * 1. Return early (no trigger) if the feature is disabled
 * 2. If already triggered this turn (marker present), clear marker and skip
 * 3. Get modified files via git diff HEAD
 * 4. Return early if no relevant files are modified
 * 5. Write trigger marker and build the simplifier delegation message
 */
export function processCodeSimplifier(
  cwd: string,
  stateDir: string,
  configDir?: string,
): CodeSimplifierResult {
  if (!isCodeSimplifierEnabled(configDir)) {
    return { triggered: false, message: '' };
  }

  // If already triggered this turn, clear marker and allow normal flow
  if (isAlreadyTriggered(stateDir)) {
    clearTriggerMarker(stateDir);
    return { triggered: false, message: '' };
  }

  const config = readOmxConfig(configDir);
  const extensions = config?.codeSimplifier?.extensions ?? DEFAULT_EXTENSIONS;
  const maxFiles = config?.codeSimplifier?.maxFiles ?? DEFAULT_MAX_FILES;
  const files = getModifiedFiles(cwd, extensions, maxFiles);

  if (files.length === 0) {
    return { triggered: false, message: '' };
  }

  writeTriggerMarker(stateDir);

  return {
    triggered: true,
    message: buildSimplifierMessage(files),
  };
}
