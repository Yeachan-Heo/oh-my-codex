import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
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
import { withPackagedExploreHarnessHidden, withPackagedExploreHarnessLock } from './packaged-explore-harness-lock.js';

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error?: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'bin', 'omx.js');
  const nodeWrapper = join(cwd, '.omx-test-node.sh');
  if (!existsSync(nodeWrapper)) {
    writeFileSync(nodeWrapper, '#!/bin/sh\nexec node "$@"\n');
    chmodSync(nodeWrapper, 0o755);
  }
  const r = spawnSync(nodeWrapper, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...envOverrides },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message };
}

function shouldSkipForSpawnPermissions(err?: string): boolean {
  return typeof err === 'string' && /(EPERM|EACCES)/i.test(err);
}

async function runExploreCommandForTest(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  const originalExitCode = process.exitCode;
  const previousEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(envOverrides)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;

  const originalCwd = process.cwd();
  process.exitCode = 0;
  try {
    process.chdir(cwd);
    await exploreCommand(argv);
  } finally {
    process.chdir(originalCwd);
    for (const [key, value] of previousEnv.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = originalExitCode;
  return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''), exitCode };
}


async function createExploreTestPath(wd: string): Promise<string> {
  const binDir = join(wd, 'test-bin');
  await mkdir(binDir, { recursive: true });
  const rgPath = join(binDir, process.platform === 'win32' ? 'rg.cmd' : 'rg');
  const lines = process.platform === 'win32'
    ? ['@echo off', 'echo ripgrep 14.0.0', '']
    : ['#!/bin/sh', 'echo "ripgrep 14.0.0"', ''];
  await writeFile(rgPath, lines.join(process.platform === 'win32' ? '\r\n' : '\n'));
  if (process.platform !== 'win32') {
    await chmod(rgPath, 0o755);
  }
  return `${binDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`;
}

async function writeEnvNodeCodexStub(wd: string, capturePath: string): Promise<string> {
  const stub = join(wd, 'codex-stub.sh');
  const argvPath = join(wd, 'codex-argv.txt');
  const allowedStdoutPath = join(wd, 'allowed.stdout.txt');
  const allowedStderrPath = join(wd, 'allowed.stderr.txt');
  const blockedStdoutPath = join(wd, 'blocked.stdout.txt');
  const blockedStderrPath = join(wd, 'blocked.stderr.txt');
  await writeFile(
    stub,
    `#!/bin/sh
set -eu
output_path=''
: > ${JSON.stringify(argvPath)}
while [ "$#" -gt 0 ]; do
  printf '%s\n' "$1" >> ${JSON.stringify(argvPath)}
  if [ "$1" = "-o" ] && [ "$#" -ge 2 ]; then
    output_path="$2"
    shift 2
    continue
  fi
  shift
done

if [ -z "$output_path" ]; then
  printf 'missing -o output path\n' >&2
  exit 1
fi

bash -lc 'rg --version' > ${JSON.stringify(allowedStdoutPath)} 2> ${JSON.stringify(allowedStderrPath)}
allowed_status=$?
set +e
bash -lc 'node --version' > ${JSON.stringify(blockedStdoutPath)} 2> ${JSON.stringify(blockedStderrPath)}
blocked_status=$?
set -e

{
  printf 'PATH=%s\n' "$PATH"
  printf 'SHELL=%s\n' "\${SHELL:-}"
  printf 'ALLOWED_STATUS=%s\n' "$allowed_status"
  printf 'BLOCKED_STATUS=%s\n' "$blocked_status"
  printf -- '--ARGV--\n'
  cat ${JSON.stringify(argvPath)}
  printf -- '--ALLOWED_STDOUT--\n'
  cat ${JSON.stringify(allowedStdoutPath)}
  printf -- '--ALLOWED_STDERR--\n'
  cat ${JSON.stringify(allowedStderrPath)}
  printf -- '--BLOCKED_STDOUT--\n'
  cat ${JSON.stringify(blockedStdoutPath)}
  printf -- '--BLOCKED_STDERR--\n'
  cat ${JSON.stringify(blockedStderrPath)}
} > ${JSON.stringify(capturePath)}

printf '# Answer\nHarness completed\n' > "$output_path"
`,
  );
  await chmod(stub, 0o755);
  return stub;
}

async function writeScenarioCodexStub(wd: string, body: string): Promise<string> {
  const stub = join(wd, 'codex-scenario-stub.sh');
  await writeFile(
    stub,
    `#!/bin/sh
set -eu
output_path=''
model=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      output_path="$2"
      shift 2
      ;;
    -m)
      model="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
if [ -z "$output_path" ]; then
  printf 'missing -o output path\n' >&2
  exit 1
fi
if [ -z "$model" ]; then
  printf 'missing -m model\n' >&2
  exit 1
fi
${body}
`,
  );
  await chmod(stub, 0o755);
  return stub;
}

async function writeExploreHarnessScenarioStub(wd: string, body: string): Promise<string> {
  const stub = join(wd, 'explore-scenario-stub.sh');
  await writeFile(
    stub,
    `#!/bin/sh
set -eu
${body}
`,
  );
  await chmod(stub, 0o755);
  return stub;
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
    await withPackagedExploreHarnessLock(async () => {
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
      '/pkg/prompts/explore-harness.md',
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
      const stub = join(wd, 'explore-stub.sh');
      const capturePath = join(wd, 'capture.txt');
      await writeFile(
        stub,
        `#!/bin/sh\nprintf '%s\n' \"$@\" > ${JSON.stringify(capturePath)}\nprintf '# Files\\n- demo\\n'\n`,
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
      const captured = (await readFile(capturePath, 'utf-8')).trim().split('\n');
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
      const stub = join(wd, 'explore-stub.sh');
      await writeFile(
        stub,
        '#!/bin/sh\nprintf "# Answer\\nReady to proceed\\n"\n',
      );
      await chmod(stub, 0o755);

      const result = runOmx(wd, ['explore', '--prompt', 'find auth'], { OMX_EXPLORE_BIN: stub });
      if (shouldSkipForSpawnPermissions(result.error)) return;
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stdout, '# Answer\nReady to proceed\n');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('launches an env-node codex binary while keeping model shell commands allowlisted', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-harness-e2e-'));
    try {
      await withPackagedExploreHarnessHidden(async () => {
        const capturePath = join(wd, 'capture.json');
        const codexStub = await writeEnvNodeCodexStub(wd, capturePath);
        const testPath = await createExploreTestPath(wd);

        const result = runOmx(wd, ['explore', '--prompt', 'find buildTmuxPaneCommand'], {
          OMX_EXPLORE_CODEX_BIN: codexStub,
          PATH: testPath,
        });
        if (shouldSkipForSpawnPermissions(result.error)) return;

        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(result.stdout, '# Answer\nHarness completed\n');
        const captured = await readFile(capturePath, 'utf-8');
        assert.match(captured, /PATH=.*omx-explore-allowlist-/);
        assert.match(captured, /SHELL=.*omx-explore-allowlist-.*\/bin\/bash$/m);
        assert.match(captured, /ALLOWED_STATUS=0/);
        assert.match(captured, /BLOCKED_STATUS=(?!0)\d+/);
        assert.match(captured, /--ARGV--[\s\S]*\nexec\n/);
        assert.match(captured, /--ALLOWED_STDOUT--[\s\S]*ripgrep/i);
        assert.match(captured, /--BLOCKED_STDERR--[\s\S]*not on the omx explore allowlist/);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('supports --prompt-file end-to-end with the harness', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-harness-prompt-file-'));
    try {
      await withPackagedExploreHarnessHidden(async () => {
        const capturePath = join(wd, 'capture.json');
        const codexStub = await writeEnvNodeCodexStub(wd, capturePath);
        const testPath = await createExploreTestPath(wd);
        const promptPath = join(wd, 'prompt.md');
        await writeFile(promptPath, 'find prompt-file support\n');

        const result = runOmx(wd, ['explore', '--prompt-file', promptPath], {
          OMX_EXPLORE_CODEX_BIN: codexStub,
          PATH: testPath,
        });
        if (shouldSkipForSpawnPermissions(result.error)) return;

        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(result.stdout, '# Answer\nHarness completed\n');
        const captured = await readFile(capturePath, 'utf-8');
        assert.match(captured, /--ARGV--[\s\S]*find prompt-file support/);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves must-preserve facts in a long noisy summary fixture', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-fidelity-'));
    try {
      await withPackagedExploreHarnessHidden(async () => {
        const harnessStub = await writeExploreHarnessScenarioStub(
          wd,
          `
printf '%s\n' '# Answer' '## Critical facts' '- MUST: summary mode stayed read-only' '- MUST: blocked command stayed node --version' '- MUST: next command is omx team status <team-name>' '' '## Noise'
i=0
while [ "$i" -lt 80 ]; do
  printf '%s\n' "- distractor line $i"
  i=$((i + 1))
done
exit 0
`,
        );

        const result = await runExploreCommandForTest(wd, ['--prompt', 'surface the critical facts'], {
          OMX_EXPLORE_BIN: harnessStub,
        });

        assert.equal(result.exitCode, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /MUST: summary mode stayed read-only/);
        assert.match(result.stdout, /MUST: blocked command stayed node --version/);
        assert.match(result.stdout, /MUST: next command is omx team status <team-name>/);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves buried critical facts in adversarial noisy output', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-adversarial-'));
    try {
      await withPackagedExploreHarnessHidden(async () => {
        const harnessStub = await writeExploreHarnessScenarioStub(
          wd,
          `
printf '# Answer\n'
i=0
while [ "$i" -lt 40 ]; do
  printf '%s\n' "- noise before signal $i"
  i=$((i + 1))
done
printf '%s\n' '- MUST: fallback route remained available'
i=0
while [ "$i" -lt 40 ]; do
  printf '%s\n' "- noise after signal $i"
  i=$((i + 1))
done
printf '%s\n' '- MUST: stderr guidance stayed actionable'
printf '%s\n' '- MUST: semantic facts survive compression'
exit 0
`,
        );

        const result = await runExploreCommandForTest(wd, ['--prompt', 'extract buried signals'], {
          OMX_EXPLORE_BIN: harnessStub,
        });

        assert.equal(result.exitCode, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /MUST: fallback route remained available/);
        assert.match(result.stdout, /MUST: stderr guidance stayed actionable/);
        assert.match(result.stdout, /MUST: semantic facts survive compression/);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('falls back after spark failure and preserves actionable stderr guidance', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-fallback-success-'));
    try {
      await withPackagedExploreHarnessHidden(async () => {
        const harnessStub = await writeExploreHarnessScenarioStub(
          wd,
          `
printf '[omx explore] spark model \`%s\` unavailable or failed (exit 17). Falling back to \`gpt-5.4\`.\n' "\${OMX_EXPLORE_SPARK_MODEL:-spark-test-model}" >&2
printf '[omx explore] spark stderr: spark timed out; retry with the frontier fallback\n' >&2
printf '%s\n' '# Answer' '- recovered with fallback model' '- MUST: actionable recovery path remained available'
`,
        );

        const result = await runExploreCommandForTest(wd, ['--prompt', 'validate fallback recovery'], {
          OMX_EXPLORE_BIN: harnessStub,
          OMX_EXPLORE_SPARK_MODEL: 'spark-test-model',
        });

        assert.equal(result.exitCode, 0, result.stderr || result.stdout);
        assert.match(result.stderr, /spark model `spark-test-model` unavailable or failed \(exit 17\)/);
        assert.match(result.stderr, /spark stderr: spark timed out; retry with the frontier fallback/);
        assert.match(result.stdout, /recovered with fallback model/);
        assert.match(result.stdout, /MUST: actionable recovery path remained available/);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('reports both failed attempts with codes and final actionable stderr end-to-end', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-fallback-failure-'));
    try {
      await withPackagedExploreHarnessHidden(async () => {
        const harnessStub = await writeExploreHarnessScenarioStub(
          wd,
          `
printf '[omx explore] spark model \`%s\` unavailable or failed (exit 23). Falling back to \`gpt-5.4\`.\n' "\${OMX_EXPLORE_SPARK_MODEL:-spark-test-model}" >&2
printf '[omx explore] spark stderr: spark backend unavailable; install the fallback runtime\n' >&2
printf '[omx explore] both spark (\`%s\`) and fallback (\`gpt-5.4\`) attempts failed (codes 23 / 29). Last stderr: fallback backend unavailable; set OMX_EXPLORE_BIN to a working harness\n' "\${OMX_EXPLORE_SPARK_MODEL:-spark-test-model}" >&2
exit 1
`,
        );

        const result = await runExploreCommandForTest(wd, ['--prompt', 'validate failure guidance'], {
          OMX_EXPLORE_BIN: harnessStub,
          OMX_EXPLORE_SPARK_MODEL: 'spark-test-model',
        });

        assert.equal(result.exitCode, 1, result.stderr || result.stdout);
        assert.match(result.stderr, /spark model `spark-test-model` unavailable or failed \(exit 23\)/);
        assert.match(result.stderr, /spark stderr: spark backend unavailable; install the fallback runtime/);
        assert.match(
          result.stderr,
          /both spark \(`spark-test-model`\) and fallback \(`gpt-5\.4`\) attempts failed \(codes 23 \/ 29\)\. Last stderr: fallback backend unavailable; set OMX_EXPLORE_BIN to a working harness/,
        );
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
