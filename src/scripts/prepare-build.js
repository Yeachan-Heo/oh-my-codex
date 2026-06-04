#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const requiredDistFiles = [
  join(process.cwd(), 'dist', 'cli', 'omx.js'),
  join(process.cwd(), 'dist', 'scripts', 'postinstall.js'),
];

if (requiredDistFiles.every((file) => existsSync(file))) {
  process.exit(0);
}

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tscBin = process.platform === 'win32'
  ? join(process.cwd(), 'node_modules', '.bin', 'tsc.cmd')
  : join(process.cwd(), 'node_modules', '.bin', 'tsc');
const nodeModulesDir = join(process.cwd(), 'node_modules');

function runNpm(args, env = process.env) {
  return spawnSync(npmBin, args, {
    cwd: process.cwd(),
    stdio: process.env.npm_config_json === 'true' ? ['inherit', 'ignore', 'inherit'] : 'inherit',
    env,
  });
}

function exitOnFailure(result, label) {
  if (result.error) {
    console.error(`omx prepare: failed to launch ${label}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(typeof result.status === 'number' ? result.status : 1);
  }
}

let shouldCleanupBootstrappedDependencies = false;

if (!existsSync(tscBin)) {
  const hadNodeModules = existsSync(nodeModulesDir);
  const installResult = runNpm(
    [
      'install',
      '--global=false',
      '--location=project',
      '--include=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-progress',
    ],
    {
      ...process.env,
      npm_config_global: 'false',
      npm_config_location: 'project',
    },
  );
  exitOnFailure(installResult, 'npm dependency bootstrap');
  shouldCleanupBootstrappedDependencies = !hadNodeModules;
}

const pathWithLocalBins = [
  join(process.cwd(), 'node_modules', '.bin'),
  process.env.PATH ?? '',
].filter(Boolean).join(delimiter);

const buildResult = spawnSync(npmBin, ['run', 'build'], {
  cwd: process.cwd(),
  stdio: process.env.npm_config_json === 'true' ? ['inherit', 'ignore', 'inherit'] : 'inherit',
  env: { ...process.env, PATH: pathWithLocalBins },
});
exitOnFailure(buildResult, 'npm build');

if (shouldCleanupBootstrappedDependencies) {
  try {
    rmSync(nodeModulesDir, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[omx:prepare] Warning: could not remove bootstrapped node_modules: ${message}`);
  }
}
