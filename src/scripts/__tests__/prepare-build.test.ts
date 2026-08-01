import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('prepare-build launches the lifecycle npm CLI through Node', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omx-prepare-build-'));
  const receiptPath = join(cwd, 'npm-receipt.json');
  const npmCliPath = join(cwd, 'npm-cli.js');
  const prepareBuildPath = join(process.cwd(), 'src', 'scripts', 'prepare-build.js');
  const tscShim = join(
    cwd,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
  );

  try {
    mkdirSync(dirname(tscShim), { recursive: true });
    writeFileSync(tscShim, 'fixture');
    writeFileSync(
      npmCliPath,
      "import { writeFileSync } from 'node:fs';\n"
        + "writeFileSync(process.env.OMX_PREPARE_RECEIPT, JSON.stringify({ argv: process.argv.slice(2) }));\n",
    );

    const result = spawnSync(process.execPath, [prepareBuildPath], {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        npm_config_json: 'false',
        npm_execpath: npmCliPath,
        OMX_PREPARE_RECEIPT: receiptPath,
      },
    });

    assert.equal(result.status, 0, `stderr=${result.stderr} stdout=${result.stdout}`);
    assert.deepEqual(JSON.parse(readFileSync(receiptPath, 'utf-8')), {
      argv: ['run', 'build'],
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
