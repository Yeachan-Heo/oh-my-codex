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

export async function doctor(options: DoctorOptions = {}): Promise<void> {
  if (options.team) {
    await doctorTeam();
    return;
  }

  console.log('oh-my-codex doctor');
  console.log('==================\n');

  const checks: Check[] = [];

  // Check 1: Codex CLI installed
  checks.push(checkCodexCli());

  // Check 2: Node.js version
  checks.push(checkNodeVersion());

  // Check 3: Codex home directory
  checks.push(checkDirectory('Codex home', codexHome()));

  // Check 4: Config file
  checks.push(await checkConfig());

  // Check 5: Prompts installed
  checks.push(await checkPrompts());

  // Check 6: Skills installed
  checks.push(await checkSkills());

  // Check 7: AGENTS.md in project
  checks.push(checkAgentsMd());

  // Check 8: State directory
  checks.push(checkDirectory('State dir', omxStateDir()));

  // Check 9: MCP servers configured
  checks.push(await checkMcpServers());

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
  code: 'delayed_status_lag' | 'slow_shutdown' | 'orphan_tmux_session' | 'resume_blocker';
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

async function checkConfig(): Promise<Check> {
  const configPath = codexConfigPath();
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

async function checkPrompts(): Promise<Check> {
  const dir = codexPromptsDir();
  if (!existsSync(dir)) {
    return { name: 'Prompts', status: 'warn', message: 'prompts directory not found' };
  }
  try {
    const files = await readdir(dir);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    if (mdFiles.length >= 25) {
      return { name: 'Prompts', status: 'pass', message: `${mdFiles.length} agent prompts installed` };
    }
    return { name: 'Prompts', status: 'warn', message: `${mdFiles.length} prompts (expected 30+)` };
  } catch {
    return { name: 'Prompts', status: 'fail', message: 'cannot read prompts directory' };
  }
}

async function checkSkills(): Promise<Check> {
  const dir = userSkillsDir();
  if (!existsSync(dir)) {
    return { name: 'Skills', status: 'warn', message: 'skills directory not found' };
  }
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const skillDirs = entries.filter(e => e.isDirectory());
    if (skillDirs.length >= 20) {
      return { name: 'Skills', status: 'pass', message: `${skillDirs.length} skills installed` };
    }
    return { name: 'Skills', status: 'warn', message: `${skillDirs.length} skills (expected 30+)` };
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

async function checkMcpServers(): Promise<Check> {
  const configPath = codexConfigPath();
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
