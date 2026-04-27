#!/usr/bin/env node

// oh-my-codex CLI entry point
// Requires compiled JavaScript output in dist/

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { rememberOmxLaunchContext } from '../utils/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..', '..');

rememberOmxLaunchContext();

// Execute compiled entrypoint
const distEntry = join(root, 'dist', 'cli', 'index.js');

if (existsSync(distEntry)) {
  const { main } = await import(pathToFileURL(distEntry).href);
  await main(process.argv.slice(2));
  if (process.argv[2] !== 'mcp-serve') {
    process.exit(process.exitCode ?? 0);
  }
} else {
  console.error('oh-my-codex: run "npm run build" first');
  process.exit(1);
}
