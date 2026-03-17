import { createServer } from 'node:http';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function usage() {
  return [
    'Usage: node scripts/smoke-packed-install.mjs [--release-assets-dir <dir>] [--require-no-fallback]',
    '',
    'Creates an npm tarball, installs it into an isolated prefix, and smoke tests the installed omx CLI.',
    'When --release-assets-dir is provided, native hydration is also exercised using a local HTTP server.',
  ].join('\n');
}

export function hasSparkShellFallbackBanner(stderr) {
  return /GLIBC-incompatible native sidecar detected/i.test(String(stderr || ''));
}

function parseArgs(argv) {
  let releaseAssetsDir;
  let requireNoFallback = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (token === '--release-assets-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value after --release-assets-dir');
      releaseAssetsDir = resolve(value);
      index += 1;
      continue;
    }
    if (token === '--require-no-fallback') {
      requireNoFallback = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}\n${usage()}`);
  }
  return { releaseAssetsDir, requireNoFallback };
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf-8',
    stdio: 'pipe',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error([
      `Command failed: ${cmd} ${args.join(' ')}`,
      result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : '',
      result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : '',
    ].filter(Boolean).join('\n\n'));
  }
  return result;
}

function npmBinName(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function startStaticServer(root) {
  return new Promise((resolveServer, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const requested = resolve(root, url.pathname.replace(/^\//, ''));
        if (!requested.startsWith(root) || !existsSync(requested)) {
          res.writeHead(404);
          res.end('missing');
          return;
        }
        res.writeHead(200);
        res.end(readFileSync(requested));
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind local asset server'));
        return;
      }
      resolveServer({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
      });
    });
  });
}

function writeCodexStub(binDir) {
  const stubPath = join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  if (process.platform === 'win32') {
    writeFileSync(stubPath, [
      '@echo off',
      'setlocal enabledelayedexpansion',
      'set output_path=',
      ':loop',
      'if "%~1"=="" goto done',
      'if "%~1"=="-o" (',
      '  set output_path=%~2',
      '  shift',
      ')',
      'shift',
      'goto loop',
      ':done',
      'if "%output_path%"=="" exit /b 1',
      '> "%output_path%" echo # Answer',
      '>> "%output_path%" echo - packed install smoke harness',
      'exit /b 0',
      '',
    ].join('\r\n'));
  } else {
    writeFileSync(stubPath, [
      '#!/bin/sh',
      'set -eu',
      "output_path=''",
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-o" ] && [ "$#" -ge 2 ]; then',
      '    output_path="$2"',
      '    shift 2',
      '    continue',
      '  fi',
      '  shift',
      'done',
      'if [ -z "$output_path" ]; then',
      "  printf 'missing -o output path\\n' >&2",
      '  exit 1',
      'fi',
      "printf '# Answer\\n- packed install smoke harness\\n' > \"$output_path\"",
      '',
    ].join('\n'));
    chmodSync(stubPath, 0o755);
  }
  return stubPath;
}

export function prepareLocalHydrationAssetDirectory(sourceDir, tempRoot) {
  const localDir = join(tempRoot, 'hydration-assets');
  cpSync(sourceDir, localDir, { recursive: true });
  return localDir;
}

export function rewriteManifestDownloadUrls(manifestPath, baseUrl) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  manifest.assets = Array.isArray(manifest.assets)
    ? manifest.assets.map((asset) => ({
      ...asset,
      download_url: new URL(asset.archive, `${baseUrl}/`).toString(),
    }))
    : [];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function main() {
  const { releaseAssetsDir, requireNoFallback } = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const tempRoot = mkdtempSync(join(tmpdir(), 'omx-packed-install-'));
  const prefixDir = join(tempRoot, 'prefix');
  const cacheDir = join(tempRoot, 'cache');
  const helperBinDir = join(tempRoot, 'bin');
  mkdirSync(prefixDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(helperBinDir, { recursive: true });

  let server;
  let tarballPath;
  try {
    const pack = run('npm', ['pack', '--json'], { cwd: repoRoot });
    const packOutput = JSON.parse(pack.stdout.slice(pack.stdout.indexOf('[')));
    const tarballName = packOutput[0]?.filename;
    if (!tarballName) throw new Error('npm pack did not return a tarball filename');
    tarballPath = join(repoRoot, tarballName);

    run('npm', ['install', '-g', tarballPath, '--prefix', prefixDir], { cwd: repoRoot });

    const omxPath = join(prefixDir, process.platform === 'win32' ? '' : 'bin', npmBinName('omx'));
    run(omxPath, ['version'], { cwd: repoRoot });
    run(omxPath, ['--help'], { cwd: repoRoot });

    if (releaseAssetsDir) {
      const hydrationAssetsDir = prepareLocalHydrationAssetDirectory(releaseAssetsDir, tempRoot);
      server = await startStaticServer(hydrationAssetsDir);
      rewriteManifestDownloadUrls(join(hydrationAssetsDir, 'native-release-manifest.json'), server.baseUrl);
      const codexStub = writeCodexStub(helperBinDir);
      const env = {
        ...process.env,
        PATH: `${helperBinDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`,
        OMX_NATIVE_MANIFEST_URL: `${server.baseUrl}/native-release-manifest.json`,
        OMX_NATIVE_CACHE_DIR: cacheDir,
        OMX_EXPLORE_CODEX_BIN: codexStub,
      };

      const sparkshell = run(omxPath, ['sparkshell', 'node', '--version'], { cwd: repoRoot, env });
      if (requireNoFallback && hasSparkShellFallbackBanner(sparkshell.stderr)) {
        throw new Error(`Unexpected sparkshell fallback stderr:\n${sparkshell.stderr}`);
      }
      if (!/v\d+\./.test(sparkshell.stdout)) {
        throw new Error(`Unexpected sparkshell stdout:\n${sparkshell.stdout}`);
      }

      const explore = run(omxPath, ['explore', '--prompt', 'where is buildExploreRoutingGuidance defined'], { cwd: repoRoot, env });
      if (!explore.stdout.includes('# Answer') || !explore.stdout.includes('packed install smoke harness')) {
        throw new Error(`Unexpected explore stdout:\n${explore.stdout}`);
      }
    }

    console.log('packed install smoke: PASS');
  } finally {
    if (tarballPath) rmSync(tarballPath, { force: true });
    if (server) await server.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`packed install smoke: FAIL\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
