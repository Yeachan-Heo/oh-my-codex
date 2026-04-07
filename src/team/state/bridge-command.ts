import { getDefaultBridge, isBridgeEnabled, resolveBridgeStateDir, type RuntimeCommand } from '../../runtime/bridge.js';

export function executeBridgeCommand(cwd: string, command: RuntimeCommand): boolean {
  if (!isBridgeEnabled()) return false;
  try {
    getDefaultBridge(resolveBridgeStateDir(cwd)).execCommand(command);
    return true;
  } catch {
    return false;
  }
}
