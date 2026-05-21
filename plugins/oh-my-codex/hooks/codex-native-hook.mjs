#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hookDir = dirname(fileURLToPath(import.meta.url));

function readPinnedLauncher() {
  const launcherPath = join(hookDir, 'omx-command.json');
  try {
    const raw = JSON.parse(readFileSync(launcherPath, 'utf8'));
    if (typeof raw.command !== 'string' || raw.command.trim() === '') {
      throw new Error('missing non-empty command');
    }
    const argsPrefix = Array.isArray(raw.argsPrefix) ? raw.argsPrefix : [];
    if (!argsPrefix.every((arg) => typeof arg === 'string')) {
      throw new Error('argsPrefix must contain only strings');
    }
    return { command: raw.command, argsPrefix };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    console.error(`[oh-my-codex] invalid plugin hook launcher ${launcherPath}: ${error.message}`);
    process.exit(1);
  }
}

function readConfiguredLauncher() {
  if (process.env.OMX_NATIVE_HOOK_COMMAND) {
    return { command: process.env.OMX_NATIVE_HOOK_COMMAND, argsPrefix: [] };
  }
  return readPinnedLauncher() ?? { command: 'omx', argsPrefix: [] };
}

const { command, argsPrefix } = readConfiguredLauncher();
const child = spawn(command, [...argsPrefix, 'codex-native-hook'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
  shell: process.platform === 'win32',
});

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on('error', (error) => {
  console.error(`[oh-my-codex] failed to launch ${command} codex-native-hook: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[oh-my-codex] codex-native-hook terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 0;
});
