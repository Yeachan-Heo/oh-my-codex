/**
 * omx setup - Automated installation of oh-my-codex
 * Installs skills, prompts, MCP servers config, and AGENTS.md
 */

import { mkdir, copyFile, readdir, readFile, writeFile, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import {
  codexHome, codexConfigPath, codexPromptsDir,
  userSkillsDir, omxStateDir, omxPlansDir, omxLogsDir,
} from '../utils/paths.js';
import { mergeConfig } from '../config/generator.js';
import { getPackageRoot } from '../utils/package.js';

interface SetupOptions {
  force?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
}

export async function setup(options: SetupOptions = {}): Promise<void> {
  const { force = false, dryRun = false, verbose = false } = options;
  const pkgRoot = getPackageRoot();

  console.log('oh-my-codex setup');
  console.log('=================\n');

  // Step 1: Ensure directories exist
  console.log('[1/6] Creating directories...');
  const dirs = [
    codexHome(),
    codexPromptsDir(),
    userSkillsDir(),
    omxStateDir(),
    omxPlansDir(),
    omxLogsDir(),
  ];
  for (const dir of dirs) {
    if (!dryRun) {
      await mkdir(dir, { recursive: true });
    }
    if (verbose) console.log(`  mkdir ${dir}`);
  }
  console.log('  Done.\n');

  // Step 2: Install agent prompts
  console.log('[2/6] Installing agent prompts...');
  const promptsSrc = join(pkgRoot, 'prompts');
  const promptsDst = codexPromptsDir();
  const promptCount = await installDirectory(promptsSrc, promptsDst, '.md', { force, dryRun, verbose });
  console.log(`  Installed ${promptCount} agent prompts.\n`);

  // Step 3: Install skills
  console.log('[3/6] Installing skills...');
  const skillsSrc = join(pkgRoot, 'skills');
  const skillsDst = userSkillsDir();
  const skillCount = await installSkills(skillsSrc, skillsDst, { force, dryRun, verbose });
  console.log(`  Installed ${skillCount} skills.\n`);

  // Step 4: Update config.toml
  console.log('[4/6] Updating config.toml...');
  if (!dryRun) {
    await mergeConfig(codexConfigPath(), pkgRoot, { verbose });
  }
  console.log('  Done.\n');

  // Step 5: Generate AGENTS.md
  console.log('[5/6] Generating AGENTS.md...');
  const agentsMdSrc = join(pkgRoot, 'templates', 'AGENTS.md');
  const agentsMdDst = join(process.cwd(), 'AGENTS.md');
  if (existsSync(agentsMdSrc)) {
    if (force || !existsSync(agentsMdDst)) {
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

  // Step 6: Set up notify hook
  console.log('[6/6] Configuring notification hook...');
  await setupNotifyHook(pkgRoot, { dryRun, verbose });
  console.log('  Done.\n');

  console.log('Setup complete! Run "omx doctor" to verify installation.');
  console.log('\nNext steps:');
  console.log('  1. Start Codex CLI in your project directory');
  console.log('  2. Use /architect, /executor, /planner as slash commands');
  console.log('  3. Skills are available via /skills or implicit matching');
  console.log('  4. The AGENTS.md orchestration brain is loaded automatically');
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
