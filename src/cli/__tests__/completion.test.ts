import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASK_PROVIDERS } from '../ask.js';
import { ADAPT_SUBCOMMANDS, ADAPT_TARGETS } from '../../adapt/contracts.js';
import { AGENTS_SUBCOMMANDS } from '../agents.js';
import { AUTORESEARCH_SUBCOMMANDS } from '../autoresearch.js';
import { buildCompletionCatalog, type CompletionNode } from '../completion/catalog.js';
import { resolveCompletionInstallTargets, resolvePowerShellProfilePath, upsertManagedBlock } from '../completion/install.js';
import { renderBashCompletion } from '../completion/render.js';
import { HOOKS_SUBCOMMANDS } from '../hooks.js';
import { SESSION_SUBCOMMANDS } from '../session-search.js';
import { STATE_OPERATION_MAP } from '../state.js';
import { TEAM_CLI_SUBCOMMANDS } from '../team.js';
import { TMUX_HOOK_SUBCOMMANDS } from '../tmux-hook.js';

function repoRoot(): string {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return join(testDir, '..', '..', '..');
}

function runOmx(cwd: string, argv: string[], envOverrides: Record<string, string> = {}) {
  const omxBin = join(repoRoot(), 'dist', 'cli', 'omx.js');
  return spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      OMX_AUTO_UPDATE: '0',
      OMX_NOTIFY_FALLBACK: '0',
      OMX_HOOK_DERIVED_SIGNALS: '0',
      ...envOverrides,
    },
  });
}

async function listRelativeFiles(root: string, prefix = ''): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listRelativeFiles(fullPath, relativePath));
    } else {
      files.push(relativePath);
    }
  }
  return files.sort();
}

function findNode(root: CompletionNode, path: string[]): CompletionNode | undefined {
  let current: CompletionNode | undefined = root;
  for (const segment of path) {
    current = current?.subcommands?.find((entry) => entry.name === segment);
    if (!current) return undefined;
  }
  return current;
}

function findOption(root: CompletionNode, path: string[], flag: string) {
  return findNode(root, path)?.options?.find((entry) => entry.flags.includes(flag));
}

describe('omx completion', () => {
  it('prints top-level help with completion listed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-completion-help-'));
    try {
      const result = runOmx(cwd, ['--help']);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /omx completion\s+Install shell completion/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects unsupported shells with local usage', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-completion-invalid-'));
    try {
      const result = runOmx(cwd, ['completion', 'elvish']);
      assert.equal(result.status, 1);
      assert.match(`${result.stderr}\n${result.stdout}`, /Usage: omx completion <bash\|zsh\|fish\|powershell>/i);
      assert.match(`${result.stderr}\n${result.stdout}`, /Unsupported shell/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('installs bash completion, preserves user content, and is idempotent on rerun', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-completion-bash-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });
      await writeFile(join(home, '.bashrc'), 'export TEST_FLAG=1\n');

      const env = { HOME: home, USERPROFILE: home };
      const first = runOmx(wd, ['completion', 'bash'], env);
      assert.equal(first.status, 0, first.stderr || first.stdout);
      assert.match(first.stdout, /Installed omx bash completion/i);

      const bashScriptPath = join(home, '.omx', 'completions', 'omx.bash');
      const bashrcPath = join(home, '.bashrc');
      const bashProfilePath = join(home, '.bash_profile');
      const script = await readFile(bashScriptPath, 'utf-8');
      const bashrc = await readFile(bashrcPath, 'utf-8');
      const bashProfile = await readFile(bashProfilePath, 'utf-8');

      assert.match(script, /complete -F _omx omx/);
      assert.match(script, /team api/);
      assert.match(script, /project-memory/);
      assert.doesNotMatch(script, /\[""\]=/);
      assert.match(bashrc, /# >>> omx completion >>>/);
      assert.match(bashrc, /# <<< omx completion <<</);
      assert.match(bashProfile, /# >>> omx completion >>>/);
      assert.match(bashProfile, /_OMX_BASH_COMPLETION_LOADED=1/);
      assert.match(bashrc, /export TEST_FLAG=1/);
      assert.match(bashrc, /\.omx\/completions\/omx\.bash/);

      const sourceResult = spawnSync('bash', ['-c', `source "${bashScriptPath}"`], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
        },
      });
      assert.equal(sourceResult.status, 0, `${sourceResult.stderr}\n${sourceResult.stdout}`);

      const freeformValueResult = spawnSync(
        'bash',
        ['-c', `source "${bashScriptPath}"; COMP_WORDS=(omx --worktree ""); COMP_CWORD=2; _omx; printf "%s" "\${COMPREPLY[*]}"`],
        {
          encoding: 'utf-8',
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
          },
        },
      );
      assert.equal(freeformValueResult.status, 0, `${freeformValueResult.stderr}\n${freeformValueResult.stdout}`);
      assert.equal(freeformValueResult.stdout.trim(), '');

      const enumeratedValueResult = spawnSync(
        'bash',
        ['-c', `source "${bashScriptPath}"; COMP_WORDS=(omx setup --scope ""); COMP_CWORD=3; _omx; printf "%s\\n" "\${COMPREPLY[@]}"`],
        {
          encoding: 'utf-8',
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
          },
        },
      );
      assert.equal(enumeratedValueResult.status, 0, `${enumeratedValueResult.stderr}\n${enumeratedValueResult.stdout}`);
      assert.deepEqual(
        enumeratedValueResult.stdout.trim().split('\n').filter(Boolean),
        ['user', 'project'],
      );

      const backupFiles = await listRelativeFiles(join(home, '.omx', 'backups', 'completion'));
      assert.ok(backupFiles.some((file) => file.endsWith('.bashrc')), `expected .bashrc backup, got: ${backupFiles.join(', ')}`);

      const second = runOmx(wd, ['completion', 'bash'], env);
      assert.equal(second.status, 0, second.stderr || second.stdout);
      assert.match(second.stdout, /already up to date/i);

      const rerunBashrc = await readFile(bashrcPath, 'utf-8');
      const markerCount = (rerunBashrc.match(/# >>> omx completion >>>/g) || []).length;
      assert.equal(markerCount, 1, rerunBashrc);
      const rerunBashProfile = await readFile(bashProfilePath, 'utf-8');
      const profileMarkerCount = (rerunBashProfile.match(/# >>> omx completion >>>/g) || []).length;
      assert.equal(profileMarkerCount, 1, rerunBashProfile);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('uses the active login startup file instead of shadowing an existing .profile', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-completion-bash-profile-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });
      const profilePath = join(home, '.profile');
      await writeFile(profilePath, 'export PROFILE_ONLY=1\n');

      const env = { HOME: home, USERPROFILE: home };
      const result = runOmx(wd, ['completion', 'bash'], env);
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const profile = await readFile(profilePath, 'utf-8');
      assert.match(profile, /# >>> omx completion >>>/);
      assert.match(profile, /export PROFILE_ONLY=1/);
      assert.equal(existsSync(join(home, '.bash_profile')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails clearly instead of installing on Bash 3.x', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-completion-bash3-'));
    try {
      const home = join(wd, 'home');
      const fakeBin = join(wd, 'fake-bash');
      await mkdir(home, { recursive: true });
      await writeFile(join(home, '.bashrc'), 'export TEST_FLAG=1\n');
      await writeFile(
        fakeBin,
        `#!/bin/sh
if [ "$1" = "-c" ]; then
  printf '3'
  exit 0
fi
exit 1
`,
      );
      await chmod(fakeBin, 0o755);

      const result = runOmx(wd, ['completion', 'bash'], {
        HOME: home,
        USERPROFILE: home,
        OMX_COMPLETION_BASH_BIN: fakeBin,
      });

      assert.equal(result.status, 1);
      assert.match(`${result.stderr}\n${result.stdout}`, /requires Bash 4\+/i);
      assert.equal(existsSync(join(home, '.omx', 'completions', 'omx.bash')), false);
      const bashrc = await readFile(join(home, '.bashrc'), 'utf-8');
      assert.doesNotMatch(bashrc, /# >>> omx completion >>>/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('installs fish completion into the fish-native completions directory', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-completion-fish-'));
    try {
      const home = join(wd, 'home');
      await mkdir(join(home, '.config', 'fish', 'completions'), { recursive: true });
      const env = { HOME: home, USERPROFILE: home };
      const result = runOmx(wd, ['completion', 'fish'], env);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const filePath = join(home, '.config', 'fish', 'completions', 'omx.fish');
      const content = await readFile(filePath, 'utf-8');
      assert.match(content, /complete -f -c omx/);
      assert.match(content, /function __omx_complete/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('installs powershell completion using an overridden profile path', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-completion-powershell-'));
    try {
      const home = join(wd, 'home');
      const profilePath = join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
      await mkdir(dirname(profilePath), { recursive: true });
      await writeFile(profilePath, '$Existing = $true\n');

      const env = {
        HOME: home,
        USERPROFILE: home,
        OMX_COMPLETION_POWERSHELL_PROFILE: profilePath,
      };
      const result = runOmx(wd, ['completion', 'powershell'], env);
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const scriptPath = join(home, '.omx', 'completions', 'omx.ps1');
      const profile = await readFile(profilePath, 'utf-8');
      const script = await readFile(scriptPath, 'utf-8');
      assert.match(profile, /# >>> omx completion >>>/);
      assert.match(profile, /\.omx[\\/]completions[\\/]omx\.ps1/);
      assert.match(profile, /\$Existing = \$true/);
      assert.match(script, /Register-ArgumentCompleter/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('falls back to XDG-based powershell profile paths when shell probing is unavailable', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-completion-pwsh-fallback-'));
    try {
      const home = join(wd, 'home');
      const xdg = join(wd, 'xdg-config');
      const profilePath = resolvePowerShellProfilePath({
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: xdg,
        PATH: '',
      });
      assert.equal(profilePath, join(xdg, 'powershell', 'Microsoft.PowerShell_profile.ps1'));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('uses WindowsPowerShell fallback layout when powershell is the configured binary', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-completion-powershell-fallback-'));
    const previousPlatform = process.platform;
    try {
      const home = join(wd, 'home');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const profilePath = resolvePowerShellProfilePath({
        HOME: home,
        USERPROFILE: home,
        OMX_COMPLETION_POWERSHELL_BIN: 'powershell',
        PATH: '',
      });
      assert.equal(profilePath, join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'));
    } finally {
      Object.defineProperty(process, 'platform', { value: previousPlatform });
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('prefers USERPROFILE over Git-Bash HOME for powershell install targets', () => {
    const targets = resolveCompletionInstallTargets('powershell', {
      HOME: '/c/Users/alice',
      USERPROFILE: 'C:/Users/alice',
      OMX_COMPLETION_POWERSHELL_PROFILE: 'C:/Users/alice/Documents/PowerShell/Microsoft.PowerShell_profile.ps1',
    });

    assert.equal(targets.scriptPath, 'C:/Users/alice/.omx/completions/omx.ps1');
    assert.equal(targets.profilePath, 'C:/Users/alice/Documents/PowerShell/Microsoft.PowerShell_profile.ps1');
  });

  it('reuses exported CLI constants to keep completion structure aligned', async () => {
    const catalog = await buildCompletionCatalog();

    assert.deepEqual(findNode(catalog, ['adapt'])?.subcommands?.map((entry) => entry.name), [...ADAPT_TARGETS]);
    assert.deepEqual(findNode(catalog, ['adapt', ADAPT_TARGETS[0]])?.subcommands?.map((entry) => entry.name), [...ADAPT_SUBCOMMANDS]);
    assert.deepEqual(findNode(catalog, ['agents'])?.subcommands?.map((entry) => entry.name), [...AGENTS_SUBCOMMANDS]);
    assert.deepEqual(findNode(catalog, ['hooks'])?.subcommands?.map((entry) => entry.name), [...HOOKS_SUBCOMMANDS]);
    assert.deepEqual(findNode(catalog, ['tmux-hook'])?.subcommands?.map((entry) => entry.name), [...TMUX_HOOK_SUBCOMMANDS]);
    assert.deepEqual(findNode(catalog, ['session'])?.subcommands?.map((entry) => entry.name), [...SESSION_SUBCOMMANDS]);
    assert.deepEqual(findNode(catalog, ['autoresearch'])?.subcommands?.map((entry) => entry.name), [...AUTORESEARCH_SUBCOMMANDS]);
    assert.deepEqual(findNode(catalog, ['team'])?.subcommands?.map((entry) => entry.name), [...TEAM_CLI_SUBCOMMANDS]);
    assert.deepEqual(findNode(catalog, ['state'])?.subcommands?.map((entry) => entry.name), Object.keys(STATE_OPERATION_MAP));
    assert.deepEqual(findNode(catalog, ['ask'])?.positionalValues, [...ASK_PROVIDERS]);
    assert.equal(findOption(catalog, [], '--worktree')?.expectsValue, true);
    assert.equal(findOption(catalog, [], '--worktree')?.values, undefined);
    assert.equal(findOption(catalog, ['explore'], '--prompt')?.expectsValue, true);
    assert.equal(findOption(catalog, ['explore'], '--prompt')?.values, undefined);
    assert.equal(findOption(catalog, [], '--custom')?.expectsValue, true);
    assert.deepEqual(findOption(catalog, ['adapt', ADAPT_TARGETS[0], 'init'], '--write')?.expectsValue, undefined);
  });

  it('keeps representative static completion coverage in the rendered bash script', async () => {
    const catalog = await buildCompletionCatalog();
    const script = renderBashCompletion(catalog);

    assert.match(script, /\["completion"\]="bash zsh fish powershell"/);
    assert.match(script, /team api/);
    assert.match(script, /adapt/);
    assert.match(script, /openclaw hermes/);
    assert.match(script, /mailbox-list/);
    assert.match(script, /state/);
    assert.match(script, /list-active/);
    assert.match(script, /project-memory/);
    assert.match(script, /add-directive/);
    assert.match(script, /reasoning/);
    assert.match(script, /low medium high xhigh/);
    assert.match(script, /__OMX_EXPECTS_VALUE/);
    assert.match(script, /--worktree/);
    assert.match(script, /--prompt/);
  });

  it('upserts managed profile blocks without duplicating them', () => {
    const initial = 'export TEST=1\n';
    const first = upsertManagedBlock(initial, 'source /tmp/omx.bash');
    const second = upsertManagedBlock(first.content, 'source /tmp/omx.bash');

    assert.equal((second.content.match(/# >>> omx completion >>>/g) || []).length, 1);
    assert.match(second.content, /export TEST=1/);
  });
});
