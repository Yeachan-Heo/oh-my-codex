import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
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
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const output = [result.error?.message, result.stderr, result.stdout]
      .map((value) => value?.trim() ?? '')
      .filter(Boolean)
      .join('\n')
      .trim();
    const suffix = result.signal
      ? `signal ${result.signal}`
      : `status ${result.status ?? 'unknown'}`;
    throw new Error(output ? `hud authority tick failed with ${suffix}: ${output}` : `hud authority tick failed with ${suffix}`);
  }
  if (result.error) {
    throw new Error(`hud authority tick failed: ${result.error.message}`);
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
  const watcherScript = join(packageRoot, 'dist', 'scripts', 'notify-fallback-watcher.js');
  const notifyScript = join(packageRoot, 'dist', 'scripts', 'notify-hook.js');
  const authorityOwnerPath = join(cwd, '.omx', 'state', 'notify-fallback-authority-owner.json');
  const runProcess = deps.runProcess ?? defaultRunProcess;

  await mkdir(join(cwd, '.omx', 'state'), { recursive: true }).catch(() => {});
  await writeFile(authorityOwnerPath, JSON.stringify({
    owner: 'hud',
    pid: process.pid,
    cwd,
    heartbeat_at: new Date().toISOString(),
  }, null, 2)).catch(() => {});

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
