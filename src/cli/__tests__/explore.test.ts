import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildExploreHarnessArgs,
  exploreCommand,
  EXPLORE_USAGE,
  loadExplorePrompt,
  packagedExploreHarnessBinaryName,
  parseExploreArgs,
  resolveExploreHarnessCommand,
  resolvePackagedExploreHarnessCommand,
} from '../explore.js';

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error?: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'bin', 'omx.js');
  const r = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...envOverrides },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message };
}

describe('parseExploreArgs', () => {
  it('parses --prompt form', () => {
    assert.deepEqual(parseExploreArgs(['--prompt', 'find', 'auth']), { prompt: 'find auth' });
  });

  it('parses --prompt= form', () => {
    assert.deepEqual(parseExploreArgs(['--prompt=find auth']), { prompt: 'find auth' });
  });

  it('parses --prompt-file form', () => {
    assert.deepEqual(parseExploreArgs(['--prompt-file', 'prompt.md']), { promptFile: 'prompt.md' });
  });

  it('throws on missing prompt', () => {
    assert.throws(() => parseExploreArgs([]), new RegExp(EXPLORE_USAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('throws on unknown flag', () => {
    assert.throws(() => parseExploreArgs(['--bogus']), /Unknown argument/);
  });

  it('rejects duplicate prompt sources', () => {
    assert.throws(() => parseExploreArgs(['--prompt', 'find auth', '--prompt-file', 'prompt.md']), /Choose exactly one/);
  });

  it('rejects missing prompt-file value', () => {
    assert.throws(() => parseExploreArgs(['--prompt-file']), /Missing path after --prompt-file/);
  });

  it('rejects missing prompt value', () => {
    assert.throws(() => parseExploreArgs(['--prompt']), /Missing text after --prompt/);
  });
});

describe('loadExplorePrompt', () => {
  it('reads prompt file content', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-prompt-'));
    try {
      const promptPath = join(wd, 'prompt.md');
      await writeFile(promptPath, '  find symbol refs  \n');
      assert.equal(await loadExplorePrompt({ promptFile: promptPath }), 'find symbol refs');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('resolvePackagedExploreHarnessCommand', () => {
  it('uses a packaged native binary when metadata matches the current platform', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-packaged-'));
    try {
      const binDir = join(wd, 'bin');
      await mkdir(binDir, { recursive: true });
      await writeFile(join(wd, 'package.json'), '{}\n');
      await writeFile(join(binDir, 'omx-explore-harness.meta.json'), JSON.stringify({
        binaryName: packagedExploreHarnessBinaryName(),
        platform: process.platform,
        arch: process.arch,
      }));
      const binaryPath = join(binDir, packagedExploreHarnessBinaryName());
      await writeFile(binaryPath, '#!/bin/sh\nexit 0\n');
      await chmod(binaryPath, 0o755);

      const resolved = resolvePackagedExploreHarnessCommand(wd);
      assert.deepEqual(resolved, { command: binaryPath, args: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('ignores packaged binaries built for a different platform', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-packaged-mismatch-'));
    try {
      const binDir = join(wd, 'bin');
      await mkdir(binDir, { recursive: true });
      await writeFile(join(wd, 'package.json'), '{}\n');
      await writeFile(join(binDir, 'omx-explore-harness.meta.json'), JSON.stringify({
        binaryName: packagedExploreHarnessBinaryName('linux'),
        platform: process.platform === 'win32' ? 'linux' : 'win32',
        arch: process.arch,
      }));
      await writeFile(join(binDir, packagedExploreHarnessBinaryName('linux')), '#!/bin/sh\nexit 0\n');

      assert.equal(resolvePackagedExploreHarnessCommand(wd), undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('resolveExploreHarnessCommand', () => {
  it('uses env override when provided', () => {
    const resolved = resolveExploreHarnessCommand('/repo', { OMX_EXPLORE_BIN: '/tmp/omx-explore-stub' } as NodeJS.ProcessEnv);
    assert.deepEqual(resolved, { command: '/tmp/omx-explore-stub', args: [] });
  });

  it('prefers a packaged native harness binary when present', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-native-'));
    try {
      const binDir = join(wd, 'bin');
      await mkdir(binDir, { recursive: true });
      await writeFile(join(wd, 'package.json'), '{}\n');
      await writeFile(join(binDir, 'omx-explore-harness.meta.json'), JSON.stringify({
        binaryName: packagedExploreHarnessBinaryName(),
        platform: process.platform,
        arch: process.arch,
      }));
      const nativePath = join(binDir, packagedExploreHarnessBinaryName());
      await writeFile(nativePath, '#!/bin/sh\necho native\n');
      await chmod(nativePath, 0o755);

      const resolved = resolveExploreHarnessCommand(wd, {} as NodeJS.ProcessEnv);
      assert.deepEqual(resolved, { command: nativePath, args: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('builds cargo fallback command otherwise', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-fallback-'));
    try {
      const crateDir = join(wd, 'crates', 'omx-explore');
      await mkdir(crateDir, { recursive: true });
      await writeFile(join(wd, 'package.json'), '{}\n');
      await writeFile(join(crateDir, 'Cargo.toml'), '[package]\nname = "omx-explore-harness"\nversion = "0.0.0"\n');

      const resolved = resolveExploreHarnessCommand(wd, {} as NodeJS.ProcessEnv);
      assert.equal(resolved.command, 'cargo');
      assert.ok(resolved.args.includes('--manifest-path'));
      assert.ok(resolved.args.includes(join(wd, 'crates', 'omx-explore', 'Cargo.toml')));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('buildExploreHarnessArgs', () => {
  it('includes cwd, prompt, prompt contract, and constrained model settings', () => {
    const args = buildExploreHarnessArgs('find auth', '/repo', {
      OMX_EXPLORE_SPARK_MODEL: 'spark-model',
    } as NodeJS.ProcessEnv, '/pkg');
    assert.deepEqual(args, [
      '--cwd',
      '/repo',
      '--prompt',
      'find auth',
      '--prompt-file',
      '/pkg/prompts/explore.md',
      '--model-spark',
      'spark-model',
      '--model-fallback',
      'gpt-5.4',
    ]);
  });
});

describe('exploreCommand', () => {
  it('passes prompt to harness and preserves markdown stdout', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-cmd-'));
    try {
      const stub = join(wd, 'explore-stub.js');
      const capturePath = join(wd, 'capture.json');
      await writeFile(
        stub,
        `#!/usr/bin/env node\nconst fs = require('fs');\nfs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write('# Files\\n- demo\\n');\n`,
      );
      await chmod(stub, 0o755);

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const originalStdout = process.stdout.write.bind(process.stdout);
      const originalStderr = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
        return true;
      }) as typeof process.stderr.write;

      const originalEnv = process.env.OMX_EXPLORE_BIN;
      process.env.OMX_EXPLORE_BIN = stub;
      const originalCwd = process.cwd();
      process.chdir(wd);
      try {
        await exploreCommand(['--prompt', 'find', 'auth']);
      } finally {
        process.chdir(originalCwd);
        if (originalEnv === undefined) delete process.env.OMX_EXPLORE_BIN;
        else process.env.OMX_EXPLORE_BIN = originalEnv;
        process.stdout.write = originalStdout;
        process.stderr.write = originalStderr;
      }

      assert.equal(stderrChunks.join(''), '');
      assert.equal(stdoutChunks.join(''), '# Files\n- demo\n');
      const captured = JSON.parse(await readFile(capturePath, 'utf-8')) as string[];
      assert.ok(captured.includes('--prompt'));
      assert.ok(captured.includes('find auth'));
      assert.ok(captured.includes('--model-spark'));
      assert.ok(captured.includes('--model-fallback'));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('works end-to-end through omx explore', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-e2e-'));
    try {
      const stub = join(wd, 'explore-stub.js');
      await writeFile(
        stub,
        '#!/usr/bin/env node\nprocess.stdout.write("# Answer\\nReady to proceed\\n");\n',
      );
      await chmod(stub, 0o755);

      const result = runOmx(wd, ['explore', '--prompt', 'find auth'], { OMX_EXPLORE_BIN: stub });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stdout, '# Answer\nReady to proceed\n');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
