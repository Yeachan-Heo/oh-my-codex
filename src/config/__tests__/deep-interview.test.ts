import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  getDeepInterviewConfigCandidatePaths,
  parseDeepInterviewProfileFromText,
  resolveDeepInterviewRuntimeConfig,
} from '../deep-interview.js';

describe('deep-interview runtime config', () => {
  it('resolves project .omx/config.toml and applies profile-specific values', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-deep-interview-config-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-deep-interview-home-'));
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'config.toml'),
        `[omx.deepInterview]
defaultProfile = "standard"
standardThreshold = 0.05
standardMaxRounds = 15
enableChallengeModes = false
`,
      );

      const config = resolveDeepInterviewRuntimeConfig({ cwd, homeDir, text: '$deep-interview clarify this' });

      assert.deepEqual(config, {
        profile: 'standard',
        threshold: 0.05,
        maxRounds: 15,
        enableChallengeModes: false,
        sourcePath: join(cwd, '.omx', 'config.toml'),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('uses explicit --quick/--standard/--deep flags over configured defaultProfile', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-deep-interview-config-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-deep-interview-home-'));
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'config.toml'),
        `[omx.deepInterview]
defaultProfile = "quick"
quickThreshold = 0.11
quickMaxRounds = 3
deepThreshold = 0.01
deepMaxRounds = 30
`,
      );

      const config = resolveDeepInterviewRuntimeConfig({ cwd, homeDir, text: '$deep-interview --deep clarify this' });

      assert.equal(config?.profile, 'deep');
      assert.equal(config?.threshold, 0.01);
      assert.equal(config?.maxRounds, 30);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('prefers project config over root omx.toml and user config', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-deep-interview-config-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-deep-interview-home-'));
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await mkdir(join(homeDir, '.omx'), { recursive: true });
      await writeFile(join(homeDir, '.omx', 'config.toml'), '[omx.deepInterview]\nstandardThreshold = 0.40\n');
      await writeFile(join(cwd, 'omx.toml'), '[omx.deepInterview]\nstandardThreshold = 0.30\n');
      await writeFile(join(cwd, '.omx', 'config.toml'), '[omx.deepInterview]\nstandardThreshold = 0.10\n');

      const config = resolveDeepInterviewRuntimeConfig({ cwd, homeDir, text: '$deep-interview' });

      assert.equal(config?.threshold, 0.10);
      assert.equal(config?.sourcePath, join(cwd, '.omx', 'config.toml'));
      const candidates = getDeepInterviewConfigCandidatePaths({ cwd, homeDir });
      assert.equal(candidates[0]?.path, join(cwd, '.omx', 'config.toml'));
      assert.equal(candidates[1]?.path, join(cwd, 'omx.toml'));
      assert.equal(candidates.at(-1)?.path, join(homeDir, '.omx', 'config.toml'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('resolves each documented config source when higher-precedence sources are absent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-deep-interview-config-sources-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-deep-interview-home-sources-'));
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await mkdir(join(homeDir, '.omx'), { recursive: true });

      await writeFile(join(cwd, '.omx', 'config.toml'), '[omx.deepInterview]\nstandardThreshold = 0.11\n');
      let config = resolveDeepInterviewRuntimeConfig({ cwd, homeDir, text: '$deep-interview' });
      assert.equal(config?.threshold, 0.11);
      assert.equal(config?.sourcePath, join(cwd, '.omx', 'config.toml'));

      await rm(join(cwd, '.omx', 'config.toml'), { force: true });
      await writeFile(join(cwd, 'omx.toml'), '[omx.deepInterview]\nstandardThreshold = 0.22\n');
      config = resolveDeepInterviewRuntimeConfig({ cwd, homeDir, text: '$deep-interview' });
      assert.equal(config?.threshold, 0.22);
      assert.equal(config?.sourcePath, join(cwd, 'omx.toml'));

      await rm(join(cwd, 'omx.toml'), { force: true });
      await writeFile(join(homeDir, '.omx', 'config.toml'), '[omx.deepInterview]\nstandardThreshold = 0.33\n');
      config = resolveDeepInterviewRuntimeConfig({ cwd, homeDir, text: '$deep-interview' });
      assert.equal(config?.threshold, 0.33);
      assert.equal(config?.sourcePath, join(homeDir, '.omx', 'config.toml'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('resolves repository config from nested working directories', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-deep-interview-config-'));
    const nestedCwd = join(cwd, 'src', 'nested');
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-deep-interview-home-'));
    try {
      await mkdir(join(cwd, '.git'), { recursive: true });
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await mkdir(nestedCwd, { recursive: true });
      await writeFile(join(cwd, '.omx', 'config.toml'), '[omx.deepInterview]\nstandardThreshold = 0.05\n');

      const config = resolveDeepInterviewRuntimeConfig({ cwd: nestedCwd, homeDir, text: '$deep-interview' });

      assert.equal(config?.threshold, 0.05);
      assert.equal(config?.sourcePath, join(cwd, '.omx', 'config.toml'));
      const candidatePaths = getDeepInterviewConfigCandidatePaths({ cwd: nestedCwd, homeDir });
      assert.equal(candidatePaths[0]?.path, join(nestedCwd, '.omx', 'config.toml'));
      assert.equal(candidatePaths[2]?.path, join(cwd, '.omx', 'config.toml'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('falls back to built-in profile defaults when a config omits that profile value', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-deep-interview-config-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-deep-interview-home-'));
    try {
      await writeFile(join(cwd, 'omx.toml'), '[omx.deepInterview]\ndefaultProfile = "deep"\n');

      const config = resolveDeepInterviewRuntimeConfig({ cwd, homeDir, text: '$deep-interview' });

      assert.equal(config?.profile, 'deep');
      assert.equal(config?.threshold, 0.15);
      assert.equal(config?.maxRounds, 20);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('normalizes profile names and ignores invalid numeric overrides', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-deep-interview-config-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-deep-interview-home-'));
    try {
      await writeFile(
        join(cwd, 'omx.toml'),
        `[omx.deepInterview]
defaultProfile = "STANDARD"
standardThreshold = 2
standardMaxRounds = 1.5
`,
      );

      const config = resolveDeepInterviewRuntimeConfig({ cwd, homeDir, text: '$deep-interview' });

      assert.equal(config?.profile, 'standard');
      assert.equal(config?.threshold, 0.20);
      assert.equal(config?.maxRounds, 12);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('ignores malformed TOML without throwing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-deep-interview-config-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-deep-interview-home-'));
    const originalWarn = console.warn;
    const warnings: string[] = [];
    try {
      console.warn = (message?: unknown) => {
        warnings.push(String(message));
      };
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'config.toml'), '[omx.deepInterview\nstandardThreshold = 0.05\n');

      const config = resolveDeepInterviewRuntimeConfig({ cwd, homeDir, text: '$deep-interview' });

      assert.equal(config, null);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? '', /ignoring malformed deep-interview config/);
    } finally {
      console.warn = originalWarn;
      await rm(cwd, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('does not cascade to lower-precedence configs after a parse failure', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-deep-interview-config-malformed-precedence-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-deep-interview-home-malformed-precedence-'));
    const originalWarn = console.warn;
    const warnings: string[] = [];
    try {
      console.warn = (message?: unknown) => {
        warnings.push(String(message));
      };
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await mkdir(join(homeDir, '.omx'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'config.toml'), '[omx.deepInterview\nstandardThreshold = 0.05\n');
      await writeFile(
        join(homeDir, '.omx', 'config.toml'),
        `[omx.deepInterview]
defaultProfile = "deep"
deepThreshold = 0.01
deepMaxRounds = 30
`,
      );

      const config = resolveDeepInterviewRuntimeConfig({ cwd, homeDir, text: '$deep-interview' });

      assert.equal(config, null);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? '', /ignoring malformed deep-interview config/);
    } finally {
      console.warn = originalWarn;
      await rm(cwd, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('does not cascade to lower-precedence configs when an existing higher-precedence file omits deepInterview', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-deep-interview-config-no-table-precedence-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-deep-interview-home-no-table-precedence-'));
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await mkdir(join(homeDir, '.omx'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'config.toml'), '[omx.other]\nenabled = true\n');
      await writeFile(
        join(homeDir, '.omx', 'config.toml'),
        `[omx.deepInterview]
defaultProfile = "deep"
deepThreshold = 0.01
deepMaxRounds = 30
`,
      );

      const config = resolveDeepInterviewRuntimeConfig({ cwd, homeDir, text: '$deep-interview' });

      assert.equal(config, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('parses supported profile flags only', () => {
    assert.equal(parseDeepInterviewProfileFromText('$deep-interview --quick'), 'quick');
    assert.equal(parseDeepInterviewProfileFromText('$deep-interview --standard'), 'standard');
    assert.equal(parseDeepInterviewProfileFromText('$deep-interview --deep'), 'deep');
    assert.equal(parseDeepInterviewProfileFromText('$oh-my-codex:deep-interview --deep'), 'deep');
    assert.equal(parseDeepInterviewProfileFromText('deep interview --quick'), 'quick');
    assert.equal(parseDeepInterviewProfileFromText('$deep-interview --deeper'), undefined);
    assert.equal(parseDeepInterviewProfileFromText('$deep-interview clarify this and run other-tool --deep'), undefined);
    assert.equal(parseDeepInterviewProfileFromText('$deep-interview clarify the plain-text --deep option'), undefined);
    assert.equal(parseDeepInterviewProfileFromText('explain the --deep option'), undefined);
  });
});
