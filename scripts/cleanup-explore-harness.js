#!/usr/bin/env node
import { rm } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');
const binaryName = process.platform === 'win32' ? 'omx-explore-harness.exe' : 'omx-explore-harness';

for (const path of [
  join(root, 'bin', binaryName),
  join(root, 'bin', 'omx-explore-harness.meta.json'),
]) {
  await rm(path, { force: true });
}
