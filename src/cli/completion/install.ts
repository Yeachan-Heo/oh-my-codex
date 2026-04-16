import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

export type SupportedShell = 'bash' | 'zsh' | 'fish' | 'powershell';

export interface CompletionInstallTargets {
  shell: SupportedShell;
  scriptPath: string;
  profilePath?: string;
  additionalProfilePaths?: string[];
}

export interface CompletionInstallResult extends CompletionInstallTargets {
  changedPaths: string[];
  backupPaths: string[];
}

const OMX_COMPLETION_BLOCK_START = '# >>> omx completion >>>';
const OMX_COMPLETION_BLOCK_END = '# <<< omx completion <<<';
const BASH_BIN_OVERRIDE_ENV = 'OMX_COMPLETION_BASH_BIN';
const POWERSHELL_PROFILE_OVERRIDE_ENV = 'OMX_COMPLETION_POWERSHELL_PROFILE';
const POWERSHELL_BIN_OVERRIDE_ENV = 'OMX_COMPLETION_POWERSHELL_BIN';

type PowerShellBinaryKind = 'pwsh' | 'powershell';

function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

function resolvePowerShellHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.USERPROFILE?.trim() || env.HOME?.trim() || homedir();
}

function completionRoot(home: string): string {
  return join(home, '.omx', 'completions');
}

function backupRoot(home: string): string {
  return join(home, '.omx', 'backups', 'completion', new Date().toISOString().replace(/[:]/g, '-'));
}

function resolveXdgConfigHome(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
}

function resolveBashLoginProfilePath(home: string): string {
  const candidates = [
    join(home, '.bash_profile'),
    join(home, '.bash_login'),
    join(home, '.profile'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

export function upsertManagedBlock(content: string, block: string): { content: string; changed: boolean } {
  const normalized = content.replace(/\r\n/g, '\n');
  const managedBlock = `${OMX_COMPLETION_BLOCK_START}\n${block.trim()}\n${OMX_COMPLETION_BLOCK_END}`;
  const start = normalized.indexOf(OMX_COMPLETION_BLOCK_START);

  if (start >= 0) {
    const end = normalized.indexOf(OMX_COMPLETION_BLOCK_END, start);
    if (end >= 0) {
      const before = normalized.slice(0, start).trimEnd();
      const after = normalized.slice(end + OMX_COMPLETION_BLOCK_END.length).trimStart();
      const nextContent = [before, managedBlock, after].filter(Boolean).join('\n\n');
      return { content: `${nextContent.trimEnd()}\n`, changed: `${normalized.trimEnd()}\n` !== `${nextContent.trimEnd()}\n` };
    }
  }

  const trimmed = normalized.trimEnd();
  const nextContent = trimmed ? `${trimmed}\n\n${managedBlock}\n` : `${managedBlock}\n`;
  return { content: nextContent, changed: `${normalized.trimEnd()}\n` !== nextContent };
}

async function backupFile(path: string, home: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const root = backupRoot(home);
  const relativePath = relative(home, path);
  const safeRelativePath = relativePath.startsWith('..') || relativePath === ''
    ? path.replace(/^[/\\]+/, '').replace(/:/g, '')
    : relativePath;
  const destination = join(root, safeRelativePath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(path, destination);
  return destination;
}

function normalizePowerShellBinaryName(command: string | null): PowerShellBinaryKind | null {
  if (!command) return null;
  const base = basename(command).toLowerCase().replace(/\.exe$/, '');
  if (base === 'pwsh') return 'pwsh';
  if (base === 'powershell') return 'powershell';
  return null;
}

function resolveBashBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env[BASH_BIN_OVERRIDE_ENV]?.trim() || 'bash';
}

function detectBashMajorVersion(env: NodeJS.ProcessEnv = process.env): number | null {
  const command = resolveBashBinary(env);
  const result = spawnSync(
    command,
    ['-c', 'printf %s "${BASH_VERSINFO[0]:-0}"'],
    {
      encoding: 'utf-8',
      stdio: 'pipe',
      env,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) return null;
  const parsed = Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function assertSupportedShellInstall(
  shell: SupportedShell,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (shell !== 'bash') return;

  const bashMajorVersion = detectBashMajorVersion(env);
  if (bashMajorVersion === null) {
    throw new Error(
      `bash completion requires a working Bash 4+ executable. Set ${BASH_BIN_OVERRIDE_ENV} if Bash is installed outside PATH.`,
    );
  }
  if (bashMajorVersion < 4) {
    throw new Error(
      `bash completion requires Bash 4+ because the generated script uses associative arrays and mapfile. Detected Bash ${bashMajorVersion}. Install a newer Bash or use zsh/fish/powershell instead.`,
    );
  }
}

function resolvePowerShellFallbackProfilePath(
  home: string,
  binaryKind: PowerShellBinaryKind | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (process.platform === 'win32') {
    const directory = binaryKind === 'powershell' ? 'WindowsPowerShell' : 'PowerShell';
    return join(home, 'Documents', directory, 'Microsoft.PowerShell_profile.ps1');
  }
  return join(resolveXdgConfigHome(home, env), 'powershell', 'Microsoft.PowerShell_profile.ps1');
}

function detectPowerShellBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env[POWERSHELL_BIN_OVERRIDE_ENV]?.trim();
  if (override) return override;
  for (const command of ['pwsh', 'powershell']) {
    const result = spawnSync(command, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf-8',
      stdio: 'ignore',
      env,
      windowsHide: true,
    });
    if (!result.error && result.status === 0) return command;
  }
  return null;
}

export function resolvePowerShellProfilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[POWERSHELL_PROFILE_OVERRIDE_ENV]?.trim();
  if (override) return override;

  const home = resolvePowerShellHome(env);
  const command = detectPowerShellBinary(env);
  const binaryKind = normalizePowerShellBinaryName(command);
  if (command) {
    const result = spawnSync(
      command,
      ['-NoLogo', '-NoProfile', '-Command', '[Console]::Out.Write($PROFILE.CurrentUserCurrentHost)'],
      {
        encoding: 'utf-8',
        stdio: 'pipe',
        env,
        windowsHide: true,
      },
    );
    if (!result.error && result.status === 0) {
      const value = result.stdout.trim();
      if (value) return value;
    }
  }

  return resolvePowerShellFallbackProfilePath(home, binaryKind, env);
}

export function resolveCompletionInstallTargets(
  shell: SupportedShell,
  env: NodeJS.ProcessEnv = process.env,
): CompletionInstallTargets {
  const home = resolveHome(env);
  const omxCompletionDir = completionRoot(home);

  switch (shell) {
    case 'bash':
      return {
        shell,
        scriptPath: join(omxCompletionDir, 'omx.bash'),
        profilePath: join(home, '.bashrc'),
        additionalProfilePaths: [resolveBashLoginProfilePath(home)],
      };
    case 'zsh':
      return {
        shell,
        scriptPath: join(omxCompletionDir, 'omx.zsh'),
        profilePath: join(home, '.zshrc'),
      };
    case 'fish':
      return {
        shell,
        scriptPath: join(resolveXdgConfigHome(home, env), 'fish', 'completions', 'omx.fish'),
      };
    case 'powershell':
      {
        const powershellHome = resolvePowerShellHome(env);
        const powershellCompletionDir = completionRoot(powershellHome);
      return {
        shell,
        scriptPath: join(powershellCompletionDir, 'omx.ps1'),
        profilePath: resolvePowerShellProfilePath({
          ...env,
          HOME: powershellHome,
          USERPROFILE: powershellHome,
        }),
      };
      }
  }
}

function buildManagedProfileBlock(shell: Exclude<SupportedShell, 'fish'>, scriptPath: string): string {
  const normalizedPath = scriptPath.replace(/\\/g, '/');
  switch (shell) {
    case 'bash':
      return [
        'if [ -z "${_OMX_BASH_COMPLETION_LOADED:-}" ] && [ -f "' + normalizedPath + '" ]; then',
        `  . "${normalizedPath}"`,
        '  _OMX_BASH_COMPLETION_LOADED=1',
        'fi',
      ].join('\n');
    case 'zsh':
      return [
        `if [ -f "${normalizedPath}" ]; then`,
        `  source "${normalizedPath}"`,
        'fi',
      ].join('\n');
    case 'powershell': {
      const escapedPath = scriptPath.replace(/'/g, "''");
      return [
        `$OmxCompletionScript = '${escapedPath}'`,
        'if (Test-Path $OmxCompletionScript) {',
        '  . $OmxCompletionScript',
        '}',
      ].join('\n');
    }
  }
}

async function writeFileIfChanged(
  path: string,
  content: string,
  backups: string[],
  backupBeforeWrite: boolean,
  home: string,
): Promise<boolean> {
  const current = existsSync(path) ? await readFile(path, 'utf-8') : null;
  if (current === content) return false;
  if (backupBeforeWrite) {
    const backupPath = await backupFile(path, home);
    if (backupPath) backups.push(backupPath);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf-8');
  return true;
}

export async function installCompletion(
  shell: SupportedShell,
  scriptContent: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CompletionInstallResult> {
  assertSupportedShellInstall(shell, env);

  const home = resolveHome(env);
  const targets = resolveCompletionInstallTargets(shell, env);
  const changedPaths: string[] = [];
  const backupPaths: string[] = [];

  const scriptChanged = await writeFileIfChanged(
    targets.scriptPath,
    scriptContent.trimEnd() + '\n',
    backupPaths,
    shell === 'fish',
    home,
  );
  if (scriptChanged) changedPaths.push(targets.scriptPath);

  if (targets.profilePath && shell !== 'fish') {
    const block = buildManagedProfileBlock(shell, targets.scriptPath);
    const profilePaths = [
      targets.profilePath,
      ...(targets.additionalProfilePaths ?? []),
    ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

    for (const profilePath of profilePaths) {
      const profileContent = existsSync(profilePath) ? await readFile(profilePath, 'utf-8') : '';
      const updated = upsertManagedBlock(profileContent, block);
      const profileChanged = await writeFileIfChanged(
        profilePath,
        updated.content,
        backupPaths,
        true,
        home,
      );
      if (profileChanged) changedPaths.push(profilePath);
    }
  }

  return {
    ...targets,
    changedPaths,
    backupPaths,
  };
}
