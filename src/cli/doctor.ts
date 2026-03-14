/**
 * omx doctor - Validate oh-my-codex installation
 */

import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import {
  codexHome, codexConfigPath, codexPromptsDir,
  userSkillsDir, legacyUserSkillsDir, omxStateDir,
} from '../utils/paths.js';
import { classifySpawnError, spawnPlatformCommandSync } from '../utils/platform-command.js';
import { getCatalogExpectations } from './catalog-contract.js';
import { parse as parseToml } from '@iarna/toml';
import { resolvePackagedExploreHarnessCommand, EXPLORE_BIN_ENV } from './explore.js';
import { getPackageRoot } from '../utils/package.js';

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
type DoctorSkillTarget = 'codex-home' | 'agents';

interface DoctorScopeResolution {
  scope: DoctorSetupScope;
  skillTarget: DoctorSkillTarget;
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
    return { scope: 'user', skillTarget: 'codex-home', source: 'default' };
  }

  try {
    const raw = await readFile(scopePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<{ scope: string; skillTarget: string }>;
    const skillTarget = parsed.skillTarget === 'agents' ? 'agents' : 'codex-home';
    if (typeof parsed.scope === 'string') {
      if (parsed.scope === 'user' || parsed.scope === 'project') {
        return { scope: parsed.scope, skillTarget, source: 'persisted' };
      }
      const migrated = LEGACY_SCOPE_MIGRATION[parsed.scope];
      if (migrated) {
        return { scope: migrated, skillTarget, source: 'persisted' };
      }
    }
  } catch {
    // ignore invalid persisted scope and fall back to default
  }

  return { scope: 'user', skillTarget: 'codex-home', source: 'default' };
}

function resolveDoctorPaths(cwd: string, scope: DoctorSetupScope, skillTarget: DoctorSkillTarget): DoctorPaths {
  if (scope === 'project') {
    const codexHomeDir = join(cwd, '.codex');
    return {
      codexHomeDir,
      configPath: join(codexHomeDir, 'config.toml'),
      promptsDir: join(codexHomeDir, 'prompts'),
      skillsDir: join(cwd, '.agents', 'skills'),
      stateDir: omxStateDir(cwd),
    };
  }

  return {
    codexHomeDir: codexHome(),
    configPath: codexConfigPath(),
    promptsDir: codexPromptsDir(),
    skillsDir: skillTarget === 'agents' ? legacyUserSkillsDir() : userSkillsDir(),
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
  const paths = resolveDoctorPaths(cwd, scopeResolution.scope, scopeResolution.skillTarget);
  const scopeSourceMessage = scopeResolution.source === 'persisted'
    ? ' (from .omx/setup-scope.json)'
    : '';

  console.log('oh-my-codex doctor');
  console.log('==================\n');
  console.log(`Resolved setup scope: ${scopeResolution.scope}${scopeSourceMessage}\n`);
  if (scopeResolution.scope === 'user') {
    console.log(`Resolved user skill target: ${scopeResolution.skillTarget} (${paths.skillsDir})\n`);
  }

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

  // Check 5: Prompts installed
  checks.push(await checkPrompts(paths.promptsDir));

  // Check 6: Skills installed
  checks.push(await checkSkills(paths.skillsDir));
  if (scopeResolution.scope === 'user' && scopeResolution.skillTarget !== 'agents') {
    checks.push(await checkLegacySkills(legacyUserSkillsDir()));
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
          tmuxSession = parsed.tmux_session;
        }
      } catch {
        // ignore malformed manifest
      }
    } else if (existsSync(configPath)) {
      try {
        const raw = await readFile(configPath, 'utf-8');
        const parsed = JSON.parse(raw) as { tmux_session?: string };
        if (typeof parsed.tmux_session === 'string' && parsed.tmux_session.trim() !== '') {
          tmuxSession = parsed.tmux_session;
        }
      } catch {
        // ignore malformed config
      }
    }

    knownTeamSessions.add(tmuxSession);

    // resume_blocker: only meaningful if tmux is available to query
    if (!tmuxUnavailable && !tmuxSessions.has(tmuxSession)) {
      issues.push({
        code: 'resume_blocker',
        message: `${teamName} references missing tmux session ${tmuxSession}`,
        severity: 'fail',
      });
    }

    // delayed_status_lag + slow_shutdown checks
    const workersRoot = join(teamDir, 'workers');
    if (!existsSync(workersRoot)) continue;
    const workers = await readdir(workersRoot, { withFileTypes: true });
    for (const worker of workers) {
      if (!worker.isDirectory()) continue;
      const workerDir = join(workersRoot, worker.name);
      const statusPath = join(workerDir, 'status.json');
      const heartbeatPath = join(workerDir, 'heartbeat.json');
      const shutdownReqPath = join(workerDir, 'shutdown-request.json');
      const shutdownAckPath = join(workerDir, 'shutdown-ack.json');

      if (existsSync(statusPath) && existsSync(heartbeatPath)) {
        try {
          const [statusRaw, hbRaw] = await Promise.all([
            readFile(statusPath, 'utf-8'),
            readFile(heartbeatPath, 'utf-8'),
          ]);
          const status = JSON.parse(statusRaw) as { state?: string };
          const hb = JSON.parse(hbRaw) as { last_turn_at?: string };
          const lastTurnMs = hb.last_turn_at ? Date.parse(hb.last_turn_at) : NaN;
          if (status.state === 'working' && Number.isFinite(lastTurnMs) && nowMs - lastTurnMs > lagThresholdMs) {
            issues.push({
              code: 'delayed_status_lag',
              message: `${teamName}/${worker.name} working with stale heartbeat`,
              severity: 'fail',
            });
          }
        } catch {
          // ignore malformed files
        }
      }

      if (existsSync(shutdownReqPath) && !existsSync(shutdownAckPath)) {
        try {
          const reqRaw = await readFile(shutdownReqPath, 'utf-8');
          const req = JSON.parse(reqRaw) as { requested_at?: string };
          const reqMs = req.requested_at ? Date.parse(req.requested_at) : NaN;
          if (Number.isFinite(reqMs) && nowMs - reqMs > shutdownThresholdMs) {
            issues.push({
              code: 'slow_shutdown',
              message: `${teamName}/${worker.name} has stale shutdown request without ack`,
              severity: 'fail',
            });
          }
        } catch {
          // ignore malformed files
        }
      }
    }
  }

  // stale_leader: team has active workers but leader has no recent activity
  const hudStatePath = join(stateDir, 'hud-state.json');
  if (existsSync(hudStatePath) && teamDirs.length > 0) {
    try {
      const hudRaw = await readFile(hudStatePath, 'utf-8');
      const hudState = JSON.parse(hudRaw) as { last_turn_at?: string };
      const lastTurnMs = hudState.last_turn_at ? Date.parse(hudState.last_turn_at) : NaN;
      const leaderIsStale = !Number.isFinite(lastTurnMs) || (nowMs - lastTurnMs > leaderStaleThresholdMs);

      if (leaderIsStale && !tmuxUnavailable) {
        // Check if any team tmux session has live worker panes
        for (const teamName of teamDirs) {
          const session = knownTeamSessions.has(`omx-team-${teamName}`)
            ? `omx-team-${teamName}`
            : [...knownTeamSessions].find(s => s.includes(teamName));
          if (!session || !tmuxSessions.has(session)) continue;
          issues.push({
            code: 'stale_leader',
            message: `${teamName} has active tmux session but leader has no recent activity`,
            severity: 'fail',
          });
        }
      }
    } catch {
      // ignore malformed HUD state
    }
  }

  // orphan_tmux_session: session exists but no matching team state
  if (!tmuxUnavailable) {
    for (const session of tmuxSessions) {
      if (!knownTeamSessions.has(session)) {
        issues.push({
          code: 'orphan_tmux_session',
          message: `${session} exists without matching team state (possibly external project)`,
          severity: 'warn',
        });
      }
    }
  }

  return dedupeIssues(issues);
}

function dedupeIssues(issues: TeamDoctorIssue[]): TeamDoctorIssue[] {
  const seen = new Set<string>();
  const out: TeamDoctorIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}:${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

function listTeamTmuxSessions(): Set<string> | null {
  const { result: res } = spawnPlatformCommandSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf-8' });
  if (res.error) {
    // tmux binary unavailable or not executable.
    return null;
  }

  if (res.status !== 0) {
    const stderr = (res.stderr || '').toLowerCase();
    // tmux installed but no server/session is running.
    if (stderr.includes('no server running') || stderr.includes('failed to connect to server')) {
      return new Set();
    }
    return null;
  }

  const sessions = (res.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('omx-team-'));
  return new Set(sessions);
}

function checkCodexCli(): Check {
  const { result } = spawnPlatformCommandSync('codex', ['--version'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const kind = classifySpawnError(result.error as NodeJS.ErrnoException);
    if (kind === 'missing') {
      return { name: 'Codex CLI', status: 'fail', message: 'not found - install from https://github.com/openai/codex' };
    }
    if (kind === 'blocked') {
      return {
        name: 'Codex CLI',
        status: 'fail',
        message: `found but could not be executed in this environment (${code || 'blocked'})`,
      };
    }
    return {
      name: 'Codex CLI',
      status: 'fail',
      message: `probe failed - ${result.error.message}`,
    };
  }
  if (result.status === 0) {
    const version = (result.stdout || '').trim();
    return { name: 'Codex CLI', status: 'pass', message: `installed (${version})` };
  }
  const stderr = (result.stderr || '').trim();
  return {
    name: 'Codex CLI',
    status: 'fail',
    message: stderr !== '' ? `probe failed - ${stderr}` : `probe failed with exit ${result.status}`,
  };
}

function checkNodeVersion(): Check {
  const major = parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (isNaN(major)) {
    return { name: 'Node.js', status: 'fail', message: `v${process.versions.node} (unable to parse major version)` };
  }
  if (major >= 20) {
    return { name: 'Node.js', status: 'pass', message: `v${process.versions.node}` };
  }
  return { name: 'Node.js', status: 'fail', message: `v${process.versions.node} (need >= 20)` };
}

function checkExploreHarness(): Check {
  const packageRoot = getPackageRoot();
  const manifestPath = join(packageRoot, 'crates', 'omx-explore', 'Cargo.toml');
  if (!existsSync(manifestPath)) {
    return {
      name: 'Explore Harness',
      status: 'warn',
      message: 'Rust harness sources not found in this install (omx explore unavailable until packaged or OMX_EXPLORE_BIN is set)',
    };
  }

  const override = process.env[EXPLORE_BIN_ENV]?.trim();
  if (override) {
    const resolved = join(packageRoot, override);
    if (existsSync(override) || existsSync(resolved)) {
      return {
        name: 'Explore Harness',
        status: 'pass',
        message: `${EXPLORE_BIN_ENV} configured (${override})`,
      };
    }
    return {
      name: 'Explore Harness',
      status: 'warn',
      message: `OMX_EXPLORE_BIN is set but path was not found (${override})`,
    };
  }

  const packaged = resolvePackagedExploreHarnessCommand(packageRoot);
  if (packaged) {
    return {
      name: 'Explore Harness',
      status: 'pass',
      message: `ready (packaged native binary: ${packaged.command})`,
    };
  }

  const { result } = spawnPlatformCommandSync('cargo', ['--version'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) {
    const kind = classifySpawnError(result.error as NodeJS.ErrnoException);
    if (kind === 'missing') {
      return {
        name: 'Explore Harness',
        status: 'warn',
        message: `Rust harness sources are packaged, but no compatible packaged prebuilt or cargo was found (install Rust or set ${EXPLORE_BIN_ENV} for omx explore)`,
      };
    }
    return {
      name: 'Explore Harness',
      status: 'warn',
      message: `Rust harness sources are packaged, but cargo probe failed (${result.error.message})`,
    };
  }

  if (result.status === 0) {
    const version = (result.stdout || '').trim();
    return {
      name: 'Explore Harness',
      status: 'pass',
      message: `ready (${version || 'cargo available'})`,
    };
  }

  return {
    name: 'Explore Harness',
    status: 'warn',
    message: `Rust harness sources are packaged, but cargo probe failed with exit ${result.status} (install Rust or set ${EXPLORE_BIN_ENV})`,
  };
}

function checkDirectory(name: string, path: string): Check {
  if (existsSync(path)) {
    return { name, status: 'pass', message: path };
  }
  return { name, status: 'warn', message: `${path} (not created yet)` };
}

function validateToml(content: string): string | null {
  try {
    parseToml(content);
    return null;
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    return 'unknown TOML parse error';
  }
}

async function checkConfig(configPath: string): Promise<Check> {
  if (!existsSync(configPath)) {
    return { name: 'Config', status: 'warn', message: 'config.toml not found' };
  }

  try {
    const content = await readFile(configPath, 'utf-8');
    const tomlError = validateToml(content);

    if (tomlError) {
      const hint =
        tomlError.includes("Can't redefine existing key") ||
        tomlError.includes('duplicate') ||
        tomlError.includes('[tui]')
          ? 'possible duplicate TOML table such as [tui]'
          : 'invalid TOML syntax';

      return {
        name: 'Config',
        status: 'fail',
        message: `invalid config.toml (${hint})`,
      };
    }

    const hasOmx = content.includes('omx_') || content.includes('oh-my-codex');
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

async function checkLegacySkills(dir: string): Promise<Check> {
  if (!existsSync(dir)) {
    return { name: 'Legacy Skills', status: 'pass', message: 'no legacy ~/.agents/skills directory detected' };
  }
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const skillDirs = entries.filter((entry) => entry.isDirectory());
    if (skillDirs.length === 0) {
      return { name: 'Legacy Skills', status: 'pass', message: 'legacy ~/.agents/skills is empty' };
    }
    return {
      name: 'Legacy Skills',
      status: 'warn',
      message:
        `${skillDirs.length} legacy skill directories still live in ${dir} ` +
        '(run "omx setup --scope user --force" to migrate, or keep them with "omx setup --scope user --skill-target agents")',
    };
  } catch {
    return { name: 'Legacy Skills', status: 'fail', message: 'cannot read legacy skills directory' };
  }
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
