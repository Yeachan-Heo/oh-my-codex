#!/usr/bin/env node

// Oh My Goal CLI entry point
// Requires compiled JavaScript output in dist/

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rememberOmxLaunchContext } from '../utils/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..', '..');

rememberOmxLaunchContext();

const distEntry = join(root, 'dist', 'cli', 'omg-main.js');

if (existsSync(distEntry)) {
  const { main } = await import(pathToFileURL(distEntry).href);
  await main(process.argv.slice(2));
  process.exit(process.exitCode ?? 0);
} else {
  console.error('oh-my-goal: run "npm run build" first');
  process.exit(1);
}
