#!/usr/bin/env node

// oh-my-codex CLI entry point
// Supports both compiled (dist/) and direct TypeScript execution

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');

// Try compiled first, fall back to source
const distEntry = join(root, 'dist', 'cli', 'index.js');
if (existsSync(distEntry)) {
  const { main } = await import(pathToFileURL(distEntry).href);
  await main(process.argv.slice(2));
} else {
  // Direct TS execution requires tsx or similar
  console.error('oh-my-codex: run "npm run build" first, or use tsx/ts-node');
  process.exit(1);
}
