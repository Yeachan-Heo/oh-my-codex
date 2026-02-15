import { spawnSync } from 'child_process';

export type PlatformOs = 'windows' | 'linux' | 'macos';

export interface PlatformCapabilities {
  os: PlatformOs;
  supportsTmux: boolean;
  supportsSignalTerm: boolean;
  supportsShellSleep: boolean;
  isWindows: boolean;
}

function detectOs(platform: NodeJS.Platform): PlatformOs {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}

let cachedTmuxAvailability: boolean | null = null;

function detectTmuxAvailability(): boolean {
  const force = process.env.OMX_FORCE_TMUX_TRANSPORT;
  if (force === '1') return true;
  if (force === '0') return false;
  if (cachedTmuxAvailability !== null) return cachedTmuxAvailability;
  const result = spawnSync('tmux', ['-V'], { encoding: 'utf-8' });
  if (result.error) {
    cachedTmuxAvailability = false;
    return false;
  }
  cachedTmuxAvailability = result.status === 0;
  return cachedTmuxAvailability;
}

export function getPlatformCapabilities(): PlatformCapabilities {
  const os = detectOs(process.platform);
  const isWindows = os === 'windows';
  return {
    os,
    isWindows,
    supportsTmux: detectTmuxAvailability(),
    supportsSignalTerm: true,
    supportsShellSleep: !isWindows,
  };
}
