import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { getPackageRoot } from '../utils/package.js';

export interface RunHudAuthorityTickOptions {
  cwd: string;
  nodePath?: string;
  packageRoot?: string;
  pollMs?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunHudAuthorityTickDeps {
  runProcess?: (
    nodePath: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      timeoutMs: number;
    },
  ) => Promise<void> | void;
}

async function defaultRunProcess(
  nodePath: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<void> {
  const result = spawnSync(nodePath, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf-8',
    stdio: 'ignore',
    timeout: options.timeoutMs,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || '').trim() || `hud authority tick failed with status ${result.status ?? 'unknown'}`);
  }
}

export async function runHudAuthorityTick(
  options: RunHudAuthorityTickOptions,
  deps: RunHudAuthorityTickDeps = {},
): Promise<void> {
  const cwd = options.cwd;
  const nodePath = options.nodePath ?? process.execPath;
  const packageRoot = options.packageRoot ?? getPackageRoot();
  const pollMs = Math.max(1, options.pollMs ?? 75);
  const timeoutMs = Math.max(100, options.timeoutMs ?? 5_000);
  const watcherScript = join(packageRoot, 'scripts', 'notify-fallback-watcher.js');
  const notifyScript = join(packageRoot, 'scripts', 'notify-hook.js');
  const runProcess = deps.runProcess ?? defaultRunProcess;

  await runProcess(
    nodePath,
    [
      watcherScript,
      '--once',
      '--authority-only',
      '--cwd',
      cwd,
      '--notify-script',
      notifyScript,
      '--poll-ms',
      String(pollMs),
    ],
    {
      cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
        OMX_HUD_AUTHORITY: '1',
      },
      timeoutMs,
    },
  );
}
