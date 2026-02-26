/**
 * omx doctor - Validate oh-my-codex installation
 */

import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { execSync, spawnSync } from 'child_process';
import {
  codexHome, codexConfigPath, codexPromptsDir,
  userSkillsDir, omxStateDir,
} from '../utils/paths.js';
import { getCatalogExpectations } from './catalog-contract.js';

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
      skillsDir: join(cwd, '.agents', 'skills'),
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

  // Check 3: Codex home directory
  checks.push(checkDirectory('Codex home', paths.codexHomeDir));

  // Check 4: Config file
  checks.push(await checkConfig(paths.configPath));

  // Check 5: Prompts installed
  checks.push(await checkPrompts(paths.promptsDir));

  // Check 6: Skills installed
  checks.push(await checkSkills(paths.skillsDir));

  // Check 7: AGENTS.md in project
  checks.push(checkAgentsMd());

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

  for (const issue of issues) {
    console.log(`  [XX] ${issue.code}: ${issue.message}`);
  }

  console.log(`\nResults: ${issues.length} failed`);
  // Ensure non-zero exit for `omx doctor --team` failures.
  process.exitCode = 1;
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
          message: `${session} exists without matching team state`,
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
  const res = spawnSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf-8' });
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
  try {
    const version = execSync('codex --version 2>/dev/null', { encoding: 'utf-8' }).trim();
    return { name: 'Codex CLI', status: 'pass', message: `installed (${version})` };
  } catch {
    return { name: 'Codex CLI', status: 'fail', message: 'not found - install from https://github.com/openai/codex' };
  }
}

function checkNodeVersion(): Check {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 20) {
    return { name: 'Node.js', status: 'pass', message: `v${process.versions.node}` };
  }
  return { name: 'Node.js', status: 'fail', message: `v${process.versions.node} (need >= 20)` };
}

function checkDirectory(name: string, path: string): Check {
  if (existsSync(path)) {
    return { name, status: 'pass', message: path };
  }
  return { name, status: 'warn', message: `${path} (not created yet)` };
}

async function checkConfig(configPath: string): Promise<Check> {
  if (!existsSync(configPath)) {
    return { name: 'Config', status: 'warn', message: 'config.toml not found' };
  }
  try {
    const content = await readFile(configPath, 'utf-8');
    const hasOmx = content.includes('omx_') || content.includes('oh-my-codex');
    if (hasOmx) {
      return { name: 'Config', status: 'pass', message: 'config.toml has OMX entries' };
    }
    return { name: 'Config', status: 'warn', message: 'config.toml exists but no OMX entries' };
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

function checkAgentsMd(): Check {
  const agentsMd = join(process.cwd(), 'AGENTS.md');
  if (existsSync(agentsMd)) {
    return { name: 'AGENTS.md', status: 'pass', message: 'found in project root' };
  }
  return { name: 'AGENTS.md', status: 'warn', message: 'not found in project root (run omx setup)' };
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
      return { name: 'MCP Servers', status: 'warn', message: `${mcpCount} servers but no OMX servers` };
    }
    return { name: 'MCP Servers', status: 'warn', message: 'no MCP servers configured' };
  } catch {
    return { name: 'MCP Servers', status: 'fail', message: 'cannot read config.toml' };
  }
}
