#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const requiredDistFiles = [
  join(process.cwd(), 'dist', 'cli', 'omx.js'),
  join(process.cwd(), 'dist', 'scripts', 'postinstall.js'),
];

if (requiredDistFiles.every((file) => existsSync(file))) {
  process.exit(0);
}

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmBin, ['run', 'build'], {
  cwd: process.cwd(),
  stdio: process.env.npm_config_json === 'true' ? ['inherit', 'ignore', 'inherit'] : 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(`omx prepare: failed to launch npm build: ${result.error.message}`);
  process.exit(1);
}

process.exit(typeof result.status === 'number' ? result.status : 1);
