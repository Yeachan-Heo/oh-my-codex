import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = process.env.OMX_SPARKSHELL_MANIFEST ?? join(projectRoot, 'native', 'omx-sparkshell', 'Cargo.toml');
const extraArgs = process.argv.slice(2);
const args = ['test', '--manifest-path', manifestPath, ...extraArgs];

if (!existsSync(manifestPath)) {
  console.error(`omx sparkshell test: missing Rust manifest at ${manifestPath}`);
  process.exit(1);
}

const result = spawnSync('cargo', args, {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(`omx sparkshell test: failed to launch cargo: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
