import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MULTIPLEXER_BACKENDS,
  DEFAULT_MULTIPLEXER_BACKEND,
  isMultiplexerBackend,
  readMultiplexerConfig,
} from '../multiplexer.js';

describe('multiplexer config', () => {
  let projectDir!: string;
  let homeDir!: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'omx-mux-project-'));
    homeDir = mkdtempSync(join(tmpdir(), 'omx-mux-home-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  function writeSetupScope(value: unknown) {
    mkdirSync(join(projectDir, '.omx'), { recursive: true });
    writeFileSync(join(projectDir, '.omx', 'setup-scope.json'), JSON.stringify(value));
  }

  function writeUserConfig(value: unknown) {
    writeFileSync(join(homeDir, '.omx-config.json'), JSON.stringify(value));
  }

  const base = () => ({ env: {}, cwd: projectDir, codexHomeDir: homeDir });

  describe('constants', () => {
    it('keeps tmux as the default backend', () => {
      assert.strictEqual(DEFAULT_MULTIPLEXER_BACKEND, 'tmux');
    });

    it('exposes exactly tmux and herdr backends', () => {
      assert.deepEqual([...MULTIPLEXER_BACKENDS], ['tmux', 'herdr']);
    });
  });

  describe('isMultiplexerBackend', () => {
    it('accepts known backends', () => {
      assert.equal(isMultiplexerBackend('tmux'), true);
      assert.equal(isMultiplexerBackend('herdr'), true);
    });

    it('rejects unknown or malformed values', () => {
      assert.equal(isMultiplexerBackend('screen'), false);
      assert.equal(isMultiplexerBackend('TMUX'), false);
      assert.equal(isMultiplexerBackend(''), false);
      assert.equal(isMultiplexerBackend(42), false);
      assert.equal(isMultiplexerBackend(null), false);
    });
  });

  describe('precedence', () => {
    it('defaults to tmux when nothing is configured', () => {
      const config = readMultiplexerConfig(base());
      assert.deepEqual(config, {
        backend: 'tmux',
        status: 'defaulted',
        source: 'default',
      });
    });

    it('env overrides project and user config', () => {
      writeSetupScope({ multiplexer: 'tmux' });
      writeUserConfig({ multiplexer: 'tmux' });
      const config = readMultiplexerConfig({ ...base(), env: { OMX_MULTIPLEXER: 'herdr' } });
      assert.equal(config.backend, 'herdr');
      assert.equal(config.source, 'env');
    });

    it('env is case-insensitive and trimmed', () => {
      const config = readMultiplexerConfig({ ...base(), env: { OMX_MULTIPLEXER: ' Herdr ' } });
      assert.equal(config.backend, 'herdr');
      assert.equal(config.source, 'env');
    });

    it('setup-scope beats user config', () => {
      writeSetupScope({ multiplexer: 'tmux' });
      writeUserConfig({ multiplexer: 'herdr' });
      const config = readMultiplexerConfig(base());
      assert.equal(config.backend, 'tmux');
      assert.equal(config.source, 'setup');
      assert.equal(config.path, join(projectDir, '.omx', 'setup-scope.json'));
    });

    it('user config is read when setup-scope is silent', () => {
      writeUserConfig({ multiplexer: 'herdr' });
      const config = readMultiplexerConfig(base());
      assert.equal(config.backend, 'herdr');
      assert.equal(config.source, 'file');
      assert.equal(config.path, join(homeDir, '.omx-config.json'));
    });

    it('reads features.multiplexer nesting', () => {
      writeUserConfig({ features: { multiplexer: 'herdr' } });
      const config = readMultiplexerConfig(base());
      assert.equal(config.backend, 'herdr');
      assert.equal(config.source, 'file');
    });
  });

  describe('invalid values', () => {
    it('falls back to tmux on invalid env value', () => {
      const config = readMultiplexerConfig({ ...base(), env: { OMX_MULTIPLEXER: 'zellij' } });
      assert.equal(config.backend, 'tmux');
      assert.equal(config.status, 'invalid');
      assert.equal(config.source, 'invalid');
    });

    it('ignores an invalid setup-scope value and falls through (team-mode semantics)', () => {
      writeSetupScope({ multiplexer: 'screen' });
      const config = readMultiplexerConfig(base());
      assert.equal(config.backend, 'tmux');
      assert.equal(config.source, 'default');
    });

    it('falls back to tmux on unparsable setup-scope json', () => {
      mkdirSync(join(projectDir, '.omx'), { recursive: true });
      writeFileSync(join(projectDir, '.omx', 'setup-scope.json'), '{not json');
      const config = readMultiplexerConfig(base());
      assert.equal(config.backend, 'tmux');
      assert.equal(config.source, 'invalid');
    });

    it('ignores unrelated config keys without failing', () => {
      writeUserConfig({ notifications: { enabled: true }, multiplexer: 'herdr' });
      const config = readMultiplexerConfig(base());
      assert.equal(config.backend, 'herdr');
      assert.equal(config.source, 'file');
    });
  });
});
