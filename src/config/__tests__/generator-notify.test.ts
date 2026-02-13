import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeConfig } from '../generator.js';

describe('config generator notify', () => {
  it('writes notify as a TOML string (not an array)', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      assert.match(toml, /^notify = ".*"$/m);
      assert.doesNotMatch(toml, /^notify = \[/m);
      assert.match(toml, /notify = "node /);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('quotes notify hook path so spaces are preserved', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omx config gen space-'));
    // Add a space in the pkgRoot path itself.
    const wd = join(base, 'pkg root');
    try {
      await mkdir(wd, { recursive: true });
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      const m = toml.match(/^notify = "(.*)"$/m);
      assert.ok(m, 'notify string not found');

      const notify = m[1];
      assert.match(notify, /^node /);
      // The path part should be quoted inside the command string.
      assert.ok(notify.startsWith('node \\"'));
      assert.ok(notify.endsWith('notify-hook.js\\"'));
      assert.match(notify, /pkg root/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
