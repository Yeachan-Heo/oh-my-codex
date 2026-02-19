/**
 * omx setup - Automated installation of oh-my-codex
 * Installs skills, prompts, MCP servers config, and AGENTS.md
 */

import { mkdir, copyFile, readdir, readFile, writeFile, stat, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import {
  codexHome, codexConfigPath, codexPromptsDir,
  userSkillsDir, omxStateDir, omxPlansDir, omxLogsDir,
  omxAgentsConfigDir,
} from '../utils/paths.js';
import { mergeConfig } from '../config/generator.js';
import { installNativeAgentConfigs } from '../agents/native-config.js';
import { getPackageRoot } from '../utils/package.js';
import { readSessionState, isSessionStale } from '../hooks/session.js';

interface SetupOptions {
  force?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
}

const REQUIRED_TEAM_COMM_MCP_TOOLS = [
  'team_send_message',
  'team_broadcast',
  'team_mailbox_list',
  'team_mailbox_mark_delivered',
] as const;

export async function setup(options: SetupOptions = {}): Promise<void> {
  const { force = false, dryRun = false, verbose = false } = options;
  const pkgRoot = getPackageRoot();

  console.log('oh-my-codex setup');
  console.log('=================\n');

  // Step 1: Ensure directories exist
  console.log('[1/8] Creating directories...');
  const dirs = [
    codexHome(),
    codexPromptsDir(),
    userSkillsDir(),
    omxStateDir(),
    omxPlansDir(),
    omxLogsDir(),
    omxAgentsConfigDir(),
  ];
  for (const dir of dirs) {
    if (!dryRun) {
      await mkdir(dir, { recursive: true });
    }
    if (verbose) console.log(`  mkdir ${dir}`);
  }
  console.log('  Done.\n');

  // Step 2: Install agent prompts
  console.log('[2/8] Installing agent prompts...');
  const promptsSrc = join(pkgRoot, 'prompts');
  const promptsDst = codexPromptsDir();
  const promptCount = await installDirectory(promptsSrc, promptsDst, '.md', { force, dryRun, verbose });
  const cleanedLegacyPromptShims = await cleanupLegacySkillPromptShims(promptsSrc, promptsDst, {
    dryRun,
    verbose,
  });
  if (cleanedLegacyPromptShims > 0) {
    if (dryRun) {
      console.log(`  Would remove ${cleanedLegacyPromptShims} legacy skill prompt shim file(s).`);
    } else {
      console.log(`  Removed ${cleanedLegacyPromptShims} legacy skill prompt shim file(s).`);
    }
  }
  console.log(`  Installed ${promptCount} agent prompts.\n`);

  // Step 3: Install native agent configs
  console.log('[3/8] Installing native agent configs...');
  const agentConfigCount = await installNativeAgentConfigs(pkgRoot, { force, dryRun, verbose });
  console.log(`  Installed ${agentConfigCount} native agent configs to ~/.omx/agents/.\n`);

  // Step 4: Install skills
  console.log('[4/8] Installing skills...');
  const skillsSrc = join(pkgRoot, 'skills');
  const skillsDst = userSkillsDir();
  const skillCount = await installSkills(skillsSrc, skillsDst, { force, dryRun, verbose });
  console.log(`  Installed ${skillCount} skills.\n`);

  // Step 5: Update config.toml
  console.log('[5/8] Updating config.toml...');
  if (!dryRun) {
    await mergeConfig(codexConfigPath(), pkgRoot, { verbose });
  }
  console.log('  Done.\n');

  // Step 5.5: Verify team comm MCP tools are available via omx_state server.
  console.log('[5.5/8] Verifying Team MCP comm tools...');
  const teamToolsCheck = await verifyTeamCommMcpTools(pkgRoot);
  if (teamToolsCheck.ok) {
    console.log(`  omx_state exports: ${REQUIRED_TEAM_COMM_MCP_TOOLS.join(', ')}`);
  } else {
    console.log(`  WARNING: ${teamToolsCheck.message}`);
    console.log('  Run `npm run build` and then re-run `omx setup`.');
  }
  console.log();

  // Step 6: Generate AGENTS.md
  console.log('[6/8] Generating AGENTS.md...');
  const agentsMdSrc = join(pkgRoot, 'templates', 'AGENTS.md');
  const agentsMdDst = join(process.cwd(), 'AGENTS.md');

  // Guard: refuse to overwrite AGENTS.md during active session
  const activeSession = await readSessionState(process.cwd());
  const sessionIsActive = activeSession && !isSessionStale(activeSession);

  if (existsSync(agentsMdSrc)) {
    if (sessionIsActive && force) {
      console.log('  WARNING: Active omx session detected (pid ' + activeSession!.pid + ').');
      console.log('  Skipping AGENTS.md overwrite to avoid corrupting runtime overlay.');
      console.log('  Stop the active session first, then re-run setup --force.');
    } else if (force || !existsSync(agentsMdDst)) {
      if (!dryRun) {
        const content = await readFile(agentsMdSrc, 'utf-8');
        await writeFile(agentsMdDst, content);
      }
      console.log('  Generated AGENTS.md in project root.');
    } else {
      console.log('  AGENTS.md already exists (use --force to overwrite).');
    }
  } else {
    console.log('  AGENTS.md template not found, skipping.');
  }
  console.log();

  // Step 7: Set up notify hook
  console.log('[7/8] Configuring notification hook...');
  await setupNotifyHook(pkgRoot, { dryRun, verbose });
  console.log('  Done.\n');

  // Step 8: Configure HUD
  console.log('[8/8] Configuring HUD...');
  const hudConfigPath = join(process.cwd(), '.omx', 'hud-config.json');
  if (force || !existsSync(hudConfigPath)) {
    if (!dryRun) {
      const defaultHudConfig = { preset: 'focused' };
      await writeFile(hudConfigPath, JSON.stringify(defaultHudConfig, null, 2));
    }
    if (verbose) console.log('  Wrote .omx/hud-config.json');
    console.log('  HUD config created (preset: focused).');
  } else {
    console.log('  HUD config already exists (use --force to overwrite).');
  }
  console.log('  StatusLine configured in config.toml via [tui] section.');
  console.log();

  console.log('Setup complete! Run "omx doctor" to verify installation.');
  console.log('\nNext steps:');
  console.log('  1. Start Codex CLI in your project directory');
  console.log('  2. Use /prompts:architect, /prompts:executor, /prompts:planner as slash commands');
  console.log('  3. Skills are available via /skills or implicit matching');
  console.log('  4. The AGENTS.md orchestration brain is loaded automatically');
  console.log('  5. Native agent roles registered in config.toml [agents.*]');
  if (isGitHubCliConfigured()) {
    console.log('\nSupport the project: gh repo star Yeachan-Heo/oh-my-codex');
  }
}

function isLegacySkillPromptShim(content: string): boolean {
  const marker = /Read and follow the full skill instructions at\s+~\/\.agents\/skills\/[^/\s]+\/SKILL\.md/i;
  return marker.test(content);
}

async function cleanupLegacySkillPromptShims(
  promptsSrcDir: string,
  promptsDstDir: string,
  options: Pick<SetupOptions, 'dryRun' | 'verbose'>
): Promise<number> {
  if (!existsSync(promptsSrcDir) || !existsSync(promptsDstDir)) return 0;

  const sourceFiles = new Set(
    (await readdir(promptsSrcDir))
      .filter(name => name.endsWith('.md'))
  );

  const installedFiles = await readdir(promptsDstDir);
  let removed = 0;

  for (const file of installedFiles) {
    if (!file.endsWith('.md')) continue;
    if (sourceFiles.has(file)) continue;

    const fullPath = join(promptsDstDir, file);
    let content = '';
    try {
      content = await readFile(fullPath, 'utf-8');
    } catch {
      continue;
    }

    if (!isLegacySkillPromptShim(content)) continue;

    if (!options.dryRun) {
      await rm(fullPath, { force: true });
    }
    if (options.verbose) console.log(`  removed legacy prompt shim ${file}`);
    removed++;
  }

  return removed;
}

function isGitHubCliConfigured(): boolean {
  const result = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' });
  return result.status === 0;
}

async function installDirectory(
  srcDir: string,
  dstDir: string,
  ext: string,
  options: SetupOptions
): Promise<number> {
  if (!existsSync(srcDir)) return 0;
  const files = await readdir(srcDir);
  let count = 0;
  for (const file of files) {
    if (!file.endsWith(ext)) continue;
    const src = join(srcDir, file);
    const dst = join(dstDir, file);
    const srcStat = await stat(src);
    if (!srcStat.isFile()) continue;
    if (options.force || !existsSync(dst)) {
      if (!options.dryRun) {
        await copyFile(src, dst);
      }
      if (options.verbose) console.log(`  ${file}`);
      count++;
    }
  }
  return count;
}

async function installSkills(
  srcDir: string,
  dstDir: string,
  options: SetupOptions
): Promise<number> {
  if (!existsSync(srcDir)) return 0;
  const entries = await readdir(srcDir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillSrc = join(srcDir, entry.name);
    const skillDst = join(dstDir, entry.name);
    const skillMd = join(skillSrc, 'SKILL.md');
    if (!existsSync(skillMd)) continue;

    if (!options.dryRun) {
      await mkdir(skillDst, { recursive: true });
      // Copy all files in the skill directory
      const skillFiles = await readdir(skillSrc);
      for (const sf of skillFiles) {
        const sfPath = join(skillSrc, sf);
        const sfStat = await stat(sfPath);
        if (sfStat.isFile()) {
          await copyFile(sfPath, join(skillDst, sf));
        }
      }
    }
    if (options.verbose) console.log(`  ${entry.name}/`);
    count++;
  }
  return count;
}

async function setupNotifyHook(
  pkgRoot: string,
  options: Pick<SetupOptions, 'dryRun' | 'verbose'>
): Promise<void> {
  const hookScript = join(pkgRoot, 'scripts', 'notify-hook.js');
  if (!existsSync(hookScript)) {
    if (options.verbose) console.log('  Notify hook script not found, skipping.');
    return;
  }
  // The notify hook is configured in config.toml via mergeConfig
  if (options.verbose) console.log(`  Notify hook: ${hookScript}`);
}

async function verifyTeamCommMcpTools(pkgRoot: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const stateServerPath = join(pkgRoot, 'dist', 'mcp', 'state-server.js');
  if (!existsSync(stateServerPath)) {
    return { ok: false, message: `missing ${stateServerPath}` };
  }

  try {
    const content = await readFile(stateServerPath, 'utf-8');
    const missing = REQUIRED_TEAM_COMM_MCP_TOOLS.filter((toolName) => !content.includes(toolName));
    if (missing.length > 0) {
      return { ok: false, message: `state-server missing tool(s): ${missing.join(', ')}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: `cannot read ${stateServerPath}` };
  }
}
