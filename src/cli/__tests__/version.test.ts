import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { version } from '../version.js';

describe('version', () => {
  it('prints OMX version from this repository package.json', async () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version: string };
    const logs: string[] = [];
    const originalLog = console.log;
    const originalCodexHome = process.env.CODEX_HOME;
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-version-codex-home-'));
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    process.env.CODEX_HOME = codexHome;

    try {
      version();
    } finally {
      console.log = originalLog;
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
      await rm(codexHome, { recursive: true, force: true });
    }

    assert.equal(logs[0], `oh-my-codex v${pkg.version}`);
  });
});
