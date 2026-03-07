#!/usr/bin/env node

import { readFileSync } from 'fs';
import { spawn } from 'child_process';

const configPath = process.argv[2];

if (!configPath) {
  console.error('[wezterm-worker-launch] missing config path');
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf-8'));

const child = spawn(config.command, config.args || [], {
  cwd: config.cwd || process.cwd(),
  env: { ...process.env, ...(config.env || {}) },
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error(`[wezterm-worker-launch] ${error.message}`);
  process.exit(1);
});
