import { join } from 'path';
import { omxRoot } from '../../../utils/paths.js';

export function sanitizeHookPluginName(name: string): string {
  const cleaned = (name || 'unknown-plugin').replace(/[^a-zA-Z0-9._-]/g, '-');
  return cleaned || 'unknown-plugin';
}

export function hookPluginRootDir(cwd: string, pluginName: string): string {
  return join(omxRoot(cwd), 'state', 'hooks', 'plugins', sanitizeHookPluginName(pluginName));
}

export function hookPluginTmuxStatePath(cwd: string, pluginName: string): string {
  return join(hookPluginRootDir(cwd, pluginName), 'tmux.json');
}

export function hookPluginDataPath(cwd: string, pluginName: string): string {
  return join(hookPluginRootDir(cwd, pluginName), 'data.json');
}

export function hookPluginLogPath(cwd: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return join(omxRoot(cwd), 'logs', `hooks-${day}.jsonl`);
}

export function omxRootStateFilePath(cwd: string, fileName: string): string {
  return join(omxRoot(cwd), 'state', fileName);
}
