import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { version } from '../version.js';

describe('version', () => {
  it('prints OMX version from this repository package.json', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version: string };
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));

    try {
      version();
    } finally {
      console.log = originalLog;
    }

    assert.equal(logs[0], `oh-my-codex v${pkg.version}`);
  });
});
