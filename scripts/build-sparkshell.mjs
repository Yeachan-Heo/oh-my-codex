import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nativeRoot = join(projectRoot, 'native', 'omx-sparkshell');
const manifestPath = process.env.OMX_SPARKSHELL_MANIFEST ?? join(nativeRoot, 'Cargo.toml');
const binaryName = platform() === 'win32' ? 'omx-sparkshell.exe' : 'omx-sparkshell';
const releaseBinaryPath = join(nativeRoot, 'target', 'release', binaryName);
const packagedBinaryDir = join(projectRoot, 'bin', 'native', `${platform()}-${arch()}`);
const packagedBinaryPath = join(packagedBinaryDir, binaryName);
const extraArgs = process.argv.slice(2);
const args = ['build', '--manifest-path', manifestPath, '--release', ...extraArgs];

if (!existsSync(manifestPath)) {
  console.error(`omx sparkshell build: missing Rust manifest at ${manifestPath}`);
  process.exit(1);
}

const result = spawnSync('cargo', args, {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(`omx sparkshell build: failed to launch cargo: ${result.error.message}`);
  process.exit(1);
}

if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

if (!existsSync(releaseBinaryPath)) {
  console.error(`omx sparkshell build: expected release binary at ${releaseBinaryPath}`);
  process.exit(1);
}

mkdirSync(packagedBinaryDir, { recursive: true });
copyFileSync(releaseBinaryPath, packagedBinaryPath);
if (platform() !== 'win32') {
  chmodSync(packagedBinaryPath, 0o755);
}
console.log(`omx sparkshell build: staged native binary at ${packagedBinaryPath}`);
