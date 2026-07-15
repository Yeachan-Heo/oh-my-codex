import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOURCE_CHECKOUT_SENTINELS = [
  'src/catalog/manifest.json',
  'docs/troubleshooting.md',
  '.github/workflows/ci.yml',
] as const;

export const INSTALLED_PACKAGE_SENTINELS = [
  'package.json',
  'dist/cli/omx.js',
  'dist/scripts/run-test-files.js',
] as const;

export const INSTALLED_PACKAGE_TEST_FILES = [
  'dist/scripts/__tests__/smoke-packed-install.test.js',
  'dist/cli/__tests__/nested-help-routing.test.js',
  'dist/cli/__tests__/mcp-parity.test.js',
] as const;

export const INSTALLED_PACKAGE_CLI_SMOKE_COMMANDS = [
  ['--help'],
  ['version'],
  ['api', '--help'],
  ['sparkshell', '--help'],
  ['notepad', '--help'],
  ['project-memory', '--help'],
  ['trace', '--help'],
  ['code-intel', '--help'],
] as const;

export type CompiledCiRootKind = 'source' | 'installed';

export interface CompiledCiCommand {
  command: string;
  args: readonly string[];
  isolatedTests?: boolean;
}

function npmBin(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function resolveCompiledCiPackageRoot(moduleUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', '..');
}

export function classifyCompiledCiRoot(packageRoot: string): CompiledCiRootKind {
  const root = resolve(packageRoot);
  if (SOURCE_CHECKOUT_SENTINELS.every((sentinel) => existsSync(join(root, sentinel)))) return 'source';
  if (INSTALLED_PACKAGE_SENTINELS.every((sentinel) => existsSync(join(root, sentinel)))) return 'installed';
  throw new Error(`COMPILED_CI_ROOT_INVALID: ${root}`);
}

export function compiledCiCommands(kind: CompiledCiRootKind): readonly CompiledCiCommand[] {
  if (kind === 'source') {
    return [
      { command: npmBin(), args: ['run', 'verify:native-agents'] },
      { command: npmBin(), args: ['run', 'verify:plugin-bundle'] },
      { command: npmBin(), args: ['run', 'test:node'] },
      { command: process.execPath, args: ['dist/scripts/generate-catalog-docs.js', '--check'] },
    ];
  }
  return [
    { command: npmBin(), args: ['run', 'verify:native-agents'] },
    { command: npmBin(), args: ['run', 'verify:plugin-bundle'] },
    {
      command: process.execPath,
      args: ['dist/scripts/run-test-files.js', ...INSTALLED_PACKAGE_TEST_FILES],
      isolatedTests: true,
    },
    ...INSTALLED_PACKAGE_CLI_SMOKE_COMMANDS.map((argv) => ({
      command: process.execPath,
      args: ['dist/cli/omx.js', ...argv],
    })),
  ];
}

export function runCompiledCi(packageRoot: string): void {
  const root = resolve(packageRoot);
  const kind = classifyCompiledCiRoot(root);
  console.error(`[test:ci:compiled] package root classified as ${kind}: ${root}`);
  for (const command of compiledCiCommands(kind)) {
    const result = spawnSync(command.command, [...command.args], {
      cwd: root,
      env: {
        ...process.env,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
        ...(command.isolatedTests ? {
          OMX_NODE_TEST_ISOLATE_CWD: '1',
          OMX_NODE_TEST_PACKAGE_ROOT: root,
        } : {}),
      },
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Command failed: ${command.command} ${command.args.join(' ')}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCompiledCi(resolveCompiledCiPackageRoot());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
