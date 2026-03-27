/**
 * omx doctor - Validate oh-my-codex installation
 */

import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import {
  codexHome,
  codexConfigPath,
  codexPromptsDir,
  userSkillsDir,
  projectSkillsDir,
  omxStateDir,
  detectLegacySkillRootOverlap,
} from '../utils/paths.js';
import { classifySpawnError, spawnPlatformCommandSync } from '../utils/platform-command.js';
import { getCatalogExpectations } from './catalog-contract.js';
import { parse as parseToml } from '@iarna/toml';
import { resolvePackagedExploreHarnessCommand, EXPLORE_BIN_ENV } from './explore.js';
import { getPackageRoot } from '../utils/package.js';
import { getDefaultBridge, isBridgeEnabled } from '../runtime/bridge.js';
import { OMX_EXPLORE_CMD_ENV, isExploreCommandRoutingEnabled } from '../hooks/explore-routing.js';
import { isLeaderRuntimeStale } from '../team/leader-activity.js';

interface DoctorOptions {
  verbose?: boolean;
  force?: boolean;
  dryRun?: boolean;
  team?: boolean;
}

interface Check {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
}

type DoctorSetupScope = 'user' | 'project';

interface DoctorScopeResolution {
  scope: DoctorSetupScope;
  source: 'persisted' | 'default';
}

interface DoctorPaths {
  codexHomeDir: string;
  configPath: string;
  promptsDir: string;
  skillsDir: string;
  stateDir: string;
}

const LEGACY_SCOPE_MIGRATION: Record<string, DoctorSetupScope> = {
  'project-local': 'project',
};

async function resolveDoctorScope(cwd: string): Promise<DoctorScopeResolution> {
  const scopePath = join(cwd, '.omx', 'setup-scope.json');
  if (!existsSync(scopePath)) {
    return { scope: 'user', source: 'default' };
  }

  try {
    const raw = await readFile(scopePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<{ scope: string }>;
    if (typeof parsed.scope === 'string') {
      if (parsed.scope === 'user' || parsed.scope === 'project') {
        return { scope: parsed.scope, source: 'persisted' };
      }
      const migrated = LEGACY_SCOPE_MIGRATION[parsed.scope];
      if (migrated) {
        return { scope: migrated, source: 'persisted' };
      }
    }
  } catch {
    // ignore invalid persisted scope and fall back to default
  }

  return { scope: 'user', source: 'default' };
}

function resolveDoctorPaths(cwd: string, scope: DoctorSetupScope): DoctorPaths {
  if (scope === 'project') {
    const codexHomeDir = join(cwd, '.codex');
    return {
      codexHomeDir,
      configPath: join(codexHomeDir, 'config.toml'),
      promptsDir: join(codexHomeDir, 'prompts'),
      skillsDir: projectSkillsDir(cwd),
      stateDir: omxStateDir(cwd),
    };
  }

  return {
    codexHomeDir: codexHome(),
    configPath: codexConfigPath(),
    promptsDir: codexPromptsDir(),
    skillsDir: userSkillsDir(),
    stateDir: omxStateDir(cwd),
  };
}

export async function doctor(options: DoctorOptions = {}): Promise<void> {
  if (options.team) {
    await doctorTeam();
    return;
  }

  const cwd = process.cwd();
  const scopeResolution = await resolveDoctorScope(cwd);
  const paths = resolveDoctorPaths(cwd, scopeResolution.scope);
  const scopeSourceMessage = scopeResolution.source === 'persisted'
    ? ' (from .omx/setup-scope.json)'
    : '';

  console.log('oh-my-codex doctor');
  console.log('==================\n');
  console.log(`Resolved setup scope: ${scopeResolution.scope}${scopeSourceMessage}\n`);

  const checks: Check[] = [];

  // Check 1: Codex CLI installed
  checks.push(checkCodexCli());

  // Check 2: Node.js version
  checks.push(checkNodeVersion());

  // Check 2.5: Explore harness readiness
  checks.push(checkExploreHarness());

  // Check 3: Codex home directory
  checks.push(checkDirectory('Codex home', paths.codexHomeDir));

  // Check 4: Config file
  checks.push(await checkConfig(paths.configPath));

  // Check 4.5: Explore routing default
  checks.push(await checkExploreRouting(paths.configPath));

  // Check 5: Prompts installed
  checks.push(await checkPrompts(paths.promptsDir));

  // Check 6: Skills installed
  checks.push(await checkSkills(paths.skillsDir));

  // Check 6.5: Legacy/current skill-root overlap
  if (scopeResolution.scope === 'user') {
    checks.push(await checkLegacySkillRootOverlap());
  }

  // Check 7: AGENTS.md in project
  checks.push(checkAgentsMd(scopeResolution.scope, paths.codexHomeDir));

  // Check 8: State directory
  checks.push(checkDirectory('State dir', paths.stateDir));

  // Check 9: MCP servers configured
  checks.push(await checkMcpServers(paths.configPath));

  // Print results
  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;

  for (const check of checks) {
    const icon = check.status === 'pass' ? '[OK]' : check.status === 'warn' ? '[!!]' : '[XX]';
    console.log(`  ${icon} ${check.name}: ${check.message}`);
    if (check.status === 'pass') passCount++;
    else if (check.status === 'warn') warnCount++;
    else failCount++;
  }

  console.log(`\nResults: ${passCount} passed, ${warnCount} warnings, ${failCount} failed`);

  if (failCount > 0) {
    console.log('\nRun "omx setup" to fix installation issues.');
  } else if (warnCount > 0) {
    console.log('\nRun "omx setup --force" to refresh all components.');
  } else {
    console.log('\nAll checks passed! oh-my-codex is ready.');
  }
}

interface TeamDoctorIssue {
  code: 'delayed_status_lag' | 'slow_shutdown' | 'orphan_tmux_session' | 'resume_blocker' | 'stale_leader';
  message: string;
  severity: 'warn' | 'fail';
}

async function doctorTeam(): Promise<void> {
  console.log('oh-my-codex doctor --team');
  console.log('=========================\n');

  const issues = await collectTeamDoctorIssues(process.cwd());
  if (issues.length === 0) {
    console.log('  [OK] team diagnostics: no issues');
    console.log('\nAll team checks passed.');
    return;
  }

  const failureCount = issues.filter(issue => issue.severity === 'fail').length;
  const warningCount = issues.length - failureCount;

  for (const issue of issues) {
    const icon = issue.severity === 'warn' ? '[!!]' : '[XX]';
    console.log(`  ${icon} ${issue.code}: ${issue.message}`);
  }

  console.log(`\nResults: ${warningCount} warnings, ${failureCount} failed`);
  // Ensure non-zero exit for `omx doctor --team` failures.
  if (failureCount > 0) process.exitCode = 1;
}

async function collectTeamDoctorIssues(cwd: string): Promise<TeamDoctorIssue[]> {
  const issues: TeamDoctorIssue[] = [];
  const stateDir = omxStateDir(cwd);
  const teamsRoot = join(stateDir, 'team');
  const nowMs = Date.now();
  const lagThresholdMs = 60_000;
  const shutdownThresholdMs = 30_000;
  const leaderStaleThresholdMs = 180_000;

  // Rust-first: if the runtime bridge is enabled, use Rust-authored readiness
  // and authority as the semantic truth source for runtime health.
  if (isBridgeEnabled()) {
    const bridge = getDefaultBridge(stateDir);
    const readiness = bridge.readReadiness();
    const authority = bridge.readAuthority();
    if (readiness && !readiness.ready) {
      for (const reason of readiness.reasons) {
        issues.push({
          code: 'resume_blocker',
          message: `runtime not ready: ${reason}`,
          severity: 'fail',
        });
      }
    }
    if (authority?.stale) {
      issues.push({
        code: 'stale_leader',
        message: `authority stale (owner: ${authority.owner ?? 'unknown'}): ${authority.stale_reason ?? 'unknown reason'}`,
        severity: 'fail',
      });
    }
  }

  const teamDirs: string[] = [];
  if (existsSync(teamsRoot)) {
    const entries = await readdir(teamsRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) teamDirs.push(e.name);
    }
  }

  const tmuxSessions = listTeamTmuxSessions();
  const tmuxUnavailable = tmuxSessions === null;
  const knownTeamSessions = new Set<string>();

  for (const teamName of teamDirs) {
    const teamDir = join(teamsRoot, teamName);
    const manifestPath = join(teamDir, 'manifest.v2.json');
    const configPath = join(teamDir, 'config.json');

    let tmuxSession = `omx-team-${teamName}`;
    if (existsSync(manifestPath)) {
      try {
        const raw = await readFile(manifestPath, 'utf-8');
        const parsed = JSON.parse(raw) as { tmux_session?: string };
        if (typeof parsed.tmux_session === 'string' && parsed.tmux_session.trim() !== '') {
          tmuxSession = parsed.tmux_session.trim();
        }
      } catch {
        // ignore manifest read/parse failures and fall back to config/default
      }
    } else if (existsSync(configPath)) {
      try {
        const raw = await readFile(configPath, 'utf-8');
        const parsed = JSON.parse(raw) as { tmux_session?: string };
        if (typeof parsed.tmux_session === 'string' && parsed.tmux_session.trim() !== '') {
          tmuxSession = parsed.tmux_session.trim();
        }
      } catch {
        // ignore config read/parse failures and fall back to default
      }
    }
    knownTeamSessions.add(tmuxSession);

    const workersDir = join(teamDir, 'workers');
    const workerDirs = existsSync(workersDir)
      ? (await readdir(workersDir, { withFileTypes: true })).filter(entry => entry.isDirectory())
      : [];

    if (!tmuxUnavailable && !tmuxSessions?.has(tmuxSession) && workerDirs.length > 0) {
      issues.push({
        code: 'resume_blocker',
        message: `team "${teamName}" has ${workerDirs.length} worker state director${workerDirs.length === 1 ? 'y' : 'ies'} but tmux session "${tmuxSession}" is missing`,
        severity: 'fail',
      });
    }

    const shutdownPath = join(teamDir, 'shutdown.json');
    if (existsSync(shutdownPath)) {
      try {
        const raw = await readFile(shutdownPath, 'utf-8');
        const parsed = JSON.parse(raw) as { requested_at?: number; completed_at?: number };
        if (parsed.requested_at && !parsed.completed_at && nowMs - parsed.requested_at > shutdownThresholdMs) {
          issues.push({
            code: 'slow_shutdown',
            message: `team "${teamName}" has been shutting down for > ${shutdownThresholdMs / 1000}s`,
            severity: 'warn',
          });
        }
      } catch {
        // ignore malformed shutdown metadata
      }
    }

    const teamStatusPath = join(teamDir, 'status.json');
    if (existsSync(teamStatusPath)) {
      try {
        const raw = await readFile(teamStatusPath, 'utf-8');
        const parsed = JSON.parse(raw) as { updated_at?: number };
        if (parsed.updated_at && nowMs - parsed.updated_at > lagThresholdMs) {
          issues.push({
            code: 'delayed_status_lag',
            message: `team "${teamName}" status stale for > ${lagThresholdMs / 1000}s`,
            severity: 'warn',
          });
        }
      } catch {
        // ignore malformed status metadata
      }
    }

    const leaderStateRoot = join(teamDir, 'leader');
    const staleLeader = await isLeaderRuntimeStale(leaderStateRoot, leaderStaleThresholdMs, nowMs).catch(() => false);
    if (staleLeader) {
      issues.push({
        code: 'stale_leader',
        message: `team "${teamName}" leader activity stale for > ${leaderStaleThresholdMs / 1000}s`,
        severity: 'fail',
      });
    }
  }

  if (!tmuxUnavailable && tmuxSessions) {
    for (const session of tmuxSessions) {
      if (session.startsWith('omx-team-') && !knownTeamSessions.has(session)) {
        issues.push({
          code: 'orphan_tmux_session',
          message: `tmux session "${session}" exists without matching team state`,
          severity: 'warn',
        });
      }
    }
  }

  return issues;
}

function listTeamTmuxSessions(): Set<string> | null {
  const { result } = spawnPlatformCommandSync('tmux', ['list-sessions', '-F', '#S'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    const classified = classifySpawnError(result.error as NodeJS.ErrnoException | undefined);
    if (classified === 'missing') return null;
    return new Set();
  }
  if (result.status !== 0) {
    return new Set();
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  return new Set(stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
}

function checkCodexCli(): Check {
  const { result } = spawnPlatformCommandSync('codex', ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    const classified = classifySpawnError(result.error as NodeJS.ErrnoException | undefined);
    if (classified === 'missing') {
      return {
        name: 'Codex CLI',
        status: 'fail',
        message: 'not found in PATH',
      };
    }
    return {
      name: 'Codex CLI',
      status: 'warn',
      message: `version probe unavailable (${classified ?? 'error'})`,
    };
  }

  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    return {
      name: 'Codex CLI',
      status: 'warn',
      message: stderr ? `installed but version probe failed: ${stderr}` : 'installed but version probe failed',
    };
  }

  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  return {
    name: 'Codex CLI',
    status: 'pass',
    message: `installed (${stdout || 'version unknown'})`,
  };
}

function checkNodeVersion(): Check {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);
  if (major >= 20) {
    return { name: 'Node.js', status: 'pass', message: version };
  }
  if (major >= 18) {
    return { name: 'Node.js', status: 'warn', message: `${version} (18+ required; 20+ recommended)` };
  }
  return { name: 'Node.js', status: 'fail', message: `${version} (18+ required)` };
}

function checkDirectory(name: string, dir: string): Check {
  if (existsSync(dir)) {
    if (name === 'State dir') {
      return { name, status: 'pass', message: dir };
    }
    return { name, status: 'pass', message: dir };
  }
  if (name === 'State dir') {
    return { name, status: 'warn', message: `${dir} (not created yet)` };
  }
  return { name, status: 'fail', message: `${dir} not found` };
}

async function checkConfig(configPath: string): Promise<Check> {
  if (!existsSync(configPath)) {
    return { name: 'Config', status: 'warn', message: 'config.toml not found' };
  }
  try {
    const content = await readFile(configPath, 'utf-8');
    try {
      parseToml(content);
    } catch (error) {
      const message = String((error as Error)?.message || '');
      if (/already exists|Can't redefine existing key|Duplicate/i.test(message)) {
        return {
          name: 'Config',
          status: 'fail',
          message: 'invalid config.toml (possible duplicate TOML table such as [tui])',
        };
      }
      return {
        name: 'Config',
        status: 'fail',
        message: 'invalid config.toml',
      };
    }
    const hasOmx = content.includes('oh-my-codex') || content.includes('omx_state') || content.includes('omx_memory');
    if (hasOmx) {
      return { name: 'Config', status: 'pass', message: 'config.toml has OMX entries' };
    }
    return {
      name: 'Config',
      status: 'warn',
      message: 'config.toml exists but no OMX entries yet (expected before first setup; run "omx setup --force" once)',
    };
  } catch {
    return { name: 'Config', status: 'fail', message: 'cannot read config.toml' };
  }
}

function checkExploreHarness(): Check {
  const packaged = resolvePackagedExploreHarnessCommand();
  if (packaged) {
    return {
      name: 'Explore Harness',
      status: 'pass',
      message: `ready (packaged native binary: ${packaged.command})`,
    };
  }

  const envOverride = process.env[EXPLORE_BIN_ENV]?.trim();
  if (envOverride) {
    return {
      name: 'Explore Harness',
      status: 'pass',
      message: `ready (${EXPLORE_BIN_ENV}=${envOverride})`,
    };
  }

  const packageRoot = getPackageRoot();
  const harnessSource = join(packageRoot, 'crates', 'omx-explore-harness', 'Cargo.toml');
  const hasSource = existsSync(harnessSource);
  const cargo = spawnPlatformCommandSync('cargo', ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (cargo.result.error || cargo.result.status !== 0) {
    if (hasSource) {
      return {
        name: 'Explore Harness',
        status: 'warn',
        message: 'Rust harness sources are packaged, but no compatible packaged prebuilt or cargo was found (install Rust or set OMX_EXPLORE_BIN for omx explore)',
      };
    }
    return {
      name: 'Explore Harness',
      status: 'warn',
      message: `not ready (no packaged binary, ${EXPLORE_BIN_ENV}, or cargo toolchain)` ,
    };
  }

  const cargoVersion = typeof cargo.result.stdout === 'string' ? cargo.result.stdout.trim() : 'cargo available';
  return {
    name: 'Explore Harness',
    status: 'pass',
    message: `ready (${cargoVersion})`,
  };
}

async function checkExploreRouting(configPath: string): Promise<Check> {
  if (!existsSync(configPath)) {
    return {
      name: 'Explore routing',
      status: 'pass',
      message: 'enabled by default',
    };
  }

  try {
    const content = await readFile(configPath, 'utf-8');
    const parsed = parseToml(content) as { env?: Record<string, unknown> };
    const configuredValue = parsed?.env?.[OMX_EXPLORE_CMD_ENV];

    if (
      typeof configuredValue === 'string' &&
      !isExploreCommandRoutingEnabled({
        USE_OMX_EXPLORE_CMD: configuredValue,
      })
    ) {
      return {
        name: 'Explore routing',
        status: 'warn',
        message:
          'disabled in config.toml [env]; set USE_OMX_EXPLORE_CMD = "1" to restore default explore-first routing',
      };
    }

    return {
      name: 'Explore routing',
      status: 'pass',
      message: 'enabled by default',
    };
  } catch {
    return {
      name: 'Explore routing',
      status: 'fail',
      message: 'cannot read config.toml for explore routing check',
    };
  }
}

async function checkPrompts(dir: string): Promise<Check> {
  const expectations = getCatalogExpectations();
  if (!existsSync(dir)) {
    return { name: 'Prompts', status: 'warn', message: 'prompts directory not found' };
  }
  try {
    const files = await readdir(dir);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    if (mdFiles.length >= expectations.promptMin) {
      return { name: 'Prompts', status: 'pass', message: `${mdFiles.length} agent prompts installed` };
    }
    return { name: 'Prompts', status: 'warn', message: `${mdFiles.length} prompts (expected >= ${expectations.promptMin})` };
  } catch {
    return { name: 'Prompts', status: 'fail', message: 'cannot read prompts directory' };
  }
}

async function checkSkills(dir: string): Promise<Check> {
  const expectations = getCatalogExpectations();
  if (!existsSync(dir)) {
    return { name: 'Skills', status: 'warn', message: 'skills directory not found' };
  }
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const skillDirs = entries.filter(e => e.isDirectory());
    if (skillDirs.length >= expectations.skillMin) {
      return { name: 'Skills', status: 'pass', message: `${skillDirs.length} skills installed` };
    }
    return { name: 'Skills', status: 'warn', message: `${skillDirs.length} skills (expected >= ${expectations.skillMin})` };
  } catch {
    return { name: 'Skills', status: 'fail', message: 'cannot read skills directory' };
  }
}

async function checkLegacySkillRootOverlap(): Promise<Check> {
  const overlap = await detectLegacySkillRootOverlap();
  if (!overlap.legacyExists) {
    return {
      name: 'Legacy skill roots',
      status: 'pass',
      message: 'no ~/.agents/skills overlap detected',
    };
  }

  if (overlap.overlappingSkillNames.length === 0) {
    return {
      name: 'Legacy skill roots',
      status: 'warn',
      message:
        `legacy ~/.agents/skills still exists (${overlap.legacySkillCount} skills) alongside canonical ${overlap.canonicalDir}; remove or archive it if Codex shows duplicate entries`,
    };
  }

  const mismatchMessage = overlap.mismatchedSkillNames.length > 0
    ? `; ${overlap.mismatchedSkillNames.length} differ in SKILL.md content`
    : '';
  return {
    name: 'Legacy skill roots',
    status: 'warn',
    message:
      `${overlap.overlappingSkillNames.length} overlapping skill names between ${overlap.canonicalDir} and ${overlap.legacyDir}${mismatchMessage}; Codex Enable/Disable Skills may show duplicates until ~/.agents/skills is cleaned up`,
  };
}

function checkAgentsMd(scope: DoctorSetupScope, codexHomeDir: string): Check {
  if (scope === 'user') {
    const userAgentsMd = join(codexHomeDir, 'AGENTS.md');
    if (existsSync(userAgentsMd)) {
      return { name: 'AGENTS.md', status: 'pass', message: `found in ${userAgentsMd}` };
    }
    return {
      name: 'AGENTS.md',
      status: 'warn',
      message: `not found in ${userAgentsMd} (run omx setup --scope user)`,
    };
  }

  const projectAgentsMd = join(process.cwd(), 'AGENTS.md');
  if (existsSync(projectAgentsMd)) {
    return { name: 'AGENTS.md', status: 'pass', message: 'found in project root' };
  }
  return {
    name: 'AGENTS.md',
    status: 'warn',
    message: 'not found in project root (run omx agents-init . or omx setup --scope project)',
  };
}

async function checkMcpServers(configPath: string): Promise<Check> {
  if (!existsSync(configPath)) {
    return { name: 'MCP Servers', status: 'warn', message: 'config.toml not found' };
  }
  try {
    const content = await readFile(configPath, 'utf-8');
    const mcpCount = (content.match(/\[mcp_servers\./g) || []).length;
    if (mcpCount > 0) {
      const hasOmx = content.includes('omx_state') || content.includes('omx_memory');
      if (hasOmx) {
        return { name: 'MCP Servers', status: 'pass', message: `${mcpCount} servers configured (OMX present)` };
      }
      return {
        name: 'MCP Servers',
        status: 'warn',
        message: `${mcpCount} servers but no OMX servers yet (expected before first setup; run "omx setup --force" once)`,
      };
    }
    return { name: 'MCP Servers', status: 'warn', message: 'no MCP servers configured' };
  } catch {
    return { name: 'MCP Servers', status: 'fail', message: 'cannot read config.toml' };
  }
}
