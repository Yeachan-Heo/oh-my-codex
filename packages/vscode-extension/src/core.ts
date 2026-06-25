import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';
import type { OmxCore } from './types';

let cachedCore: OmxCore | null = null;

function configuredCoreModulePath(): string | null {
  const configured = vscode.workspace.getConfiguration('omx').get<string>('coreModulePath')?.trim();
  return configured || null;
}

function extensionBundledCoreModulePath(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, '..', '..', 'dist', 'vscode', 'index.js');
}

function workspaceCoreModulePaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) =>
    path.join(folder.uri.fsPath, 'dist', 'vscode', 'index.js'),
  );
}

async function importCoreModule(modulePath: string): Promise<OmxCore> {
  const specifier = path.isAbsolute(modulePath) || modulePath.startsWith('.')
    ? pathToFileURL(path.resolve(modulePath)).href
    : modulePath;
  const imported = await import(specifier) as Partial<OmxCore>;
  if (
    typeof imported.buildDirectSessionArgs !== 'function' ||
    typeof imported.resolveVscodeLaunchEnv !== 'function' ||
    typeof imported.launchDirectSession !== 'function' ||
    typeof imported.launchRequiresDangerousApproval !== 'function' ||
    typeof imported.runOmxCatalogCommand !== 'function'
  ) {
    throw new Error(`OMX core module at ${modulePath} does not expose the VSCode API surface`);
  }
  return imported as OmxCore;
}

export async function loadOmxCore(context: vscode.ExtensionContext): Promise<OmxCore> {
  if (cachedCore) return cachedCore;

  const configured = configuredCoreModulePath();
  const candidates = [
    ...(configured ? [configured] : []),
    ...workspaceCoreModulePaths(),
    extensionBundledCoreModulePath(context),
    'oh-my-codex',
  ];

  const errors: string[] = [];
  for (const candidate of candidates) {
    if (candidate !== 'oh-my-codex' && !existsSync(path.resolve(candidate))) {
      errors.push(`${candidate}: not found`);
      continue;
    }
    try {
      cachedCore = await importCoreModule(candidate);
      return cachedCore;
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    [
      'Unable to load OMX VSCode core API.',
      'Run `npm run build` at the repository root, install the oh-my-codex package, or set `omx.coreModulePath`.',
      ...errors.map((entry) => `- ${entry}`),
    ].join('\n'),
  );
}

export function clearCoreCache(): void {
  cachedCore = null;
}
