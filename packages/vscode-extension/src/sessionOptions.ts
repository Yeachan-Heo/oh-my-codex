import { existsSync } from 'node:fs';
import * as path from 'node:path';

export function normalizePrompt(prompt: string | undefined): string | undefined {
  const normalized = prompt?.trim();
  return normalized || undefined;
}

export function buildLaunchPreviewArgs(defaultArgs: readonly string[], prompt: string | undefined): string[] {
  const normalizedPrompt = normalizePrompt(prompt);
  return normalizedPrompt ? [...defaultArgs, normalizedPrompt] : [...defaultArgs];
}

export function resolveOmxCommand(cwd: string, configuredCommand: string | undefined): string {
  const configured = configuredCommand?.trim();
  if (configured) return configured;
  const workspaceCommand = path.join(cwd, 'dist', 'cli', 'omx.js');
  return existsSync(workspaceCommand) ? workspaceCommand : 'omx';
}
