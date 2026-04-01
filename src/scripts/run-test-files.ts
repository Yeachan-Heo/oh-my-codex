import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

function collectTests(path: string, out: string[]): void {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return;
  }

  if (stats.isDirectory()) {
    for (const entry of readdirSync(path)) {
      collectTests(join(path, entry), out);
    }
    return;
  }

  if (stats.isFile() && path.endsWith('.test.js')) {
    out.push(path);
  }
}

const roots = process.argv.slice(2);
const targets = roots.length > 0 ? roots : ['dist'];
const files: string[] = [];
for (const target of targets) {
  collectTests(resolve(target), files);
}

files.sort();

if (files.length === 0) {
  console.error(`No test files found under: ${targets.join(', ')}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  env: process.env,
});

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(1);
