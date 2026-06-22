import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getBaseStateDir,
  getReadScopedStateFilePaths,
  listModeStateFilesWithScopePreference,
  resolveStateScope,
  validateStateFileName,
} from '../mcp/state-paths.js';
import { omxRoot } from '../utils/paths.js';
import type { OmxHudState, OmxModeStateRef, OmxSessionState } from './types.js';

export interface OmxWorkspaceOptions {
  cwd?: string;
  sessionId?: string;
}

export class OmxWorkspace {
  readonly cwd: string;
  readonly sessionId?: string;

  constructor(options: OmxWorkspaceOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.sessionId = options.sessionId;
  }

  get root(): string {
    return omxRoot(this.cwd);
  }

  get stateRoot(): string {
    return getBaseStateDir(this.cwd);
  }

  path(...segments: string[]): string {
    return join(this.root, ...segments);
  }

  async scope(): Promise<{ source: 'explicit' | 'session' | 'root'; sessionId?: string; stateDir: string }> {
    return await resolveStateScope(this.cwd, this.sessionId);
  }

  async readStateFile<T = unknown>(fileName: string, fallback: T | null = null): Promise<T | null> {
    const safeName = validateStateFileName(fileName);
    for (const path of await getReadScopedStateFilePaths(safeName, this.cwd, this.sessionId)) {
      const value = await readJsonIfExists<T>(path);
      if (value !== null) return value;
    }
    return fallback;
  }

  async readSession(): Promise<OmxSessionState | null> {
    return await readJsonIfExists<OmxSessionState>(join(this.stateRoot, 'session.json'));
  }

  async readHud(): Promise<OmxHudState | null> {
    return await this.readStateFile<OmxHudState>('hud-state.json');
  }

  async listModeStates<T = unknown>(): Promise<Array<OmxModeStateRef<T>>> {
    const refs = await listModeStateFilesWithScopePreference(this.cwd, this.sessionId);
    return await Promise.all(refs.map(async (ref) => ({
      ...ref,
      state: await readJsonIfExists<T>(ref.path),
    })));
  }
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}
