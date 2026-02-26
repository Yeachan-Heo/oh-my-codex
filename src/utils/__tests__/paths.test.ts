import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import {
  codexHome,
  codexConfigPath,
  codexPromptsDir,
  userSkillsDir,
  projectSkillsDir,
  omxStateDir,
  omxProjectMemoryPath,
  omxNotepadPath,
  omxPlansDir,
  omxLogsDir,
  packageRoot,
} from '../paths.js';

describe('codexHome', () => {
  let originalCodexHome: string | undefined;

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
  });

  afterEach(() => {
    if (typeof originalCodexHome === 'string') {
      process.env.CODEX_HOME = originalCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }
  });

  it('returns CODEX_HOME env var when set', () => {
    process.env.CODEX_HOME = '/tmp/custom-codex';
    assert.equal(codexHome(), '/tmp/custom-codex');
  });

  it('defaults to ~/.codex when CODEX_HOME is not set', () => {
    delete process.env.CODEX_HOME;
    assert.equal(codexHome(), join(homedir(), '.codex'));
  });
});

describe('codexConfigPath', () => {
  let originalCodexHome: string | undefined;

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/tmp/test-codex';
  });

  afterEach(() => {
    if (typeof originalCodexHome === 'string') {
      process.env.CODEX_HOME = originalCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }
  });

  it('returns config.toml under codex home', () => {
    assert.equal(codexConfigPath(), '/tmp/test-codex/config.toml');
  });
});

describe('codexPromptsDir', () => {
  let originalCodexHome: string | undefined;

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/tmp/test-codex';
  });

  afterEach(() => {
    if (typeof originalCodexHome === 'string') {
      process.env.CODEX_HOME = originalCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }
  });

  it('returns prompts/ under codex home', () => {
    assert.equal(codexPromptsDir(), '/tmp/test-codex/prompts');
  });
});

describe('userSkillsDir', () => {
  it('returns ~/.agents/skills', () => {
    assert.equal(userSkillsDir(), join(homedir(), '.agents', 'skills'));
  });
});

describe('projectSkillsDir', () => {
  it('uses provided projectRoot', () => {
    assert.equal(projectSkillsDir('/my/project'), '/my/project/.agents/skills');
  });

  it('defaults to cwd when no projectRoot given', () => {
    assert.equal(projectSkillsDir(), join(process.cwd(), '.agents', 'skills'));
  });
});

describe('omxStateDir', () => {
  it('uses provided projectRoot', () => {
    assert.equal(omxStateDir('/my/project'), '/my/project/.omx/state');
  });

  it('defaults to cwd when no projectRoot given', () => {
    assert.equal(omxStateDir(), join(process.cwd(), '.omx', 'state'));
  });
});

describe('omxProjectMemoryPath', () => {
  it('uses provided projectRoot', () => {
    assert.equal(
      omxProjectMemoryPath('/my/project'),
      '/my/project/.omx/project-memory.json',
    );
  });

  it('defaults to cwd when no projectRoot given', () => {
    assert.equal(
      omxProjectMemoryPath(),
      join(process.cwd(), '.omx', 'project-memory.json'),
    );
  });
});

describe('omxNotepadPath', () => {
  it('uses provided projectRoot', () => {
    assert.equal(omxNotepadPath('/my/project'), '/my/project/.omx/notepad.md');
  });

  it('defaults to cwd when no projectRoot given', () => {
    assert.equal(omxNotepadPath(), join(process.cwd(), '.omx', 'notepad.md'));
  });
});

describe('omxPlansDir', () => {
  it('uses provided projectRoot', () => {
    assert.equal(omxPlansDir('/my/project'), '/my/project/.omx/plans');
  });

  it('defaults to cwd when no projectRoot given', () => {
    assert.equal(omxPlansDir(), join(process.cwd(), '.omx', 'plans'));
  });
});

describe('omxLogsDir', () => {
  it('uses provided projectRoot', () => {
    assert.equal(omxLogsDir('/my/project'), '/my/project/.omx/logs');
  });

  it('defaults to cwd when no projectRoot given', () => {
    assert.equal(omxLogsDir(), join(process.cwd(), '.omx', 'logs'));
  });
});

describe('packageRoot', () => {
  it('resolves to a directory containing package.json', () => {
    const root = packageRoot();
    assert.equal(existsSync(join(root, 'package.json')), true);
  });
});
