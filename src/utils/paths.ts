/**
 * Path utilities for oh-my-codex
 * Resolves Codex CLI config, skills, prompts, and state directories
 */

import { join } from 'path';
import { homedir } from 'os';

/** Codex CLI home directory (~/.codex/) */
export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/** Codex config file path (~/.codex/config.toml) */
export function codexConfigPath(): string {
  return join(codexHome(), 'config.toml');
}

/** Codex prompts directory (~/.codex/prompts/) */
export function codexPromptsDir(): string {
  return join(codexHome(), 'prompts');
}

/** User-level skills directory (~/.agents/skills/) */
export function userSkillsDir(): string {
  return join(homedir(), '.agents', 'skills');
}

/** Project-level skills directory (.agents/skills/) */
export function projectSkillsDir(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), '.agents', 'skills');
}

/** oh-my-codex state directory (.omx/state/) */
export function omxStateDir(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), '.omx', 'state');
}

/** oh-my-codex project memory file (.omx/project-memory.json) */
export function omxProjectMemoryPath(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), '.omx', 'project-memory.json');
}

/** oh-my-codex notepad file (.omx/notepad.md) */
export function omxNotepadPath(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), '.omx', 'notepad.md');
}

/** oh-my-codex plans directory (.omx/plans/) */
export function omxPlansDir(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), '.omx', 'plans');
}

/** oh-my-codex logs directory (.omx/logs/) */
export function omxLogsDir(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), '.omx', 'logs');
}

/** oh-my-codex native agent config directory (~/.omx/agents/) */
export function omxAgentsConfigDir(): string {
  return join(homedir(), '.omx', 'agents');
}

/** Get the package root directory (where agents/, skills/, prompts/ live) */
export function packageRoot(): string {
  // From dist/utils/ or src/utils/, go up two levels
  const { dirname } = require('path');
  const { fileURLToPath } = require('url');
  try {
    const __filename = fileURLToPath(import.meta.url);
    return join(dirname(__filename), '..', '..');
  } catch {
    return join(__dirname, '..', '..');
  }
}
