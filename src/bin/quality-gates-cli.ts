/**
 * Quality Gates CLI Command
 *
 * Provides CLI interface for listing configured quality gates.
 * Usage:
 *   omx quality-gates list --stage deep-interview|ralplan|code-review
 *
 * Returns JSON string: {gates: [...], stage: "..."}
 * or {error: string} for errors.
 * No console output or exit code changes—dispatcher handles all I/O.
 */

import { getGatesForStage } from '../config/quality-gates.js';
import type { QualityGateStage } from '../config/quality-gates.js';

interface QualityGatesCliOptions {
  stage?: QualityGateStage;
  json?: boolean;
  help?: boolean;
  subcommand?: string;
  hasUnknownFlags?: boolean;
}

/**
 * Parse CLI arguments for quality-gates command with strict validation
 */
function parseQualityGatesArgs(args: string[]): QualityGatesCliOptions {
  const options: QualityGatesCliOptions = {};

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      i++;
    } else if (arg === '--json') {
      options.json = true;
      i++;
    } else if (arg === '--stage') {
      const stage = args[i + 1];
      if (stage && ['deep-interview', 'ralplan', 'code-review'].includes(stage)) {
        options.stage = stage as QualityGateStage;
      }
      i += 2;
    } else if (arg.startsWith('--') || arg.startsWith('-')) {
      // Unknown flag
      options.hasUnknownFlags = true;
      i++;
    } else if (arg === 'list') {
      options.subcommand = arg;
      i++;
    } else if (['validate', 'run', 'help', 'init', 'config'].includes(arg)) {
      // Unsupported subcommand
      options.subcommand = arg;
      i++;
    } else {
      // Unknown positional argument
      i++;
    }
  }

  return options;
}

/**
 * Execute the quality-gates CLI command
 * Pure function: returns JSON string, no console I/O or exit code changes
 * Reads quality gates from both project (cwd) and CODEX_HOME config files with project taking precedence
 */
export function qualityGatesCommand(
  args: string[],
  codexHomeOverride?: string,
  cwd?: string,
): string {
  const options = parseQualityGatesArgs(args);

  if (options.help) {
    // Help is shown by dispatcher; return empty success
    return JSON.stringify({
      gates: [],
      stage: 'ralplan' as QualityGateStage,
    });
  }

  // Check for unknown flags
  if (options.hasUnknownFlags) {
    return JSON.stringify({
      error: 'Unknown flag provided',
    });
  }

  // Require explicit 'list' subcommand
  if (!options.subcommand) {
    return JSON.stringify({
      error: 'Missing subcommand; use "list"',
    });
  }

  // Only 'list' is supported
  if (options.subcommand !== 'list') {
    return JSON.stringify({
      error: `Unsupported subcommand: ${options.subcommand}`,
    });
  }

  // --stage is required for 'list'
  if (!options.stage) {
    return JSON.stringify({
      error: 'Missing required --stage argument',
    });
  }

  const gates = getGatesForStage(options.stage, codexHomeOverride, cwd);

  // Output normalized gate objects
  const normalizedGates = gates.map(gate => ({
    skill: gate.skill,
    mode: gate.mode,
    ...(gate.model && { model: gate.model }),
  }));

  return JSON.stringify({
    gates: normalizedGates,
    stage: options.stage,
  });

}
