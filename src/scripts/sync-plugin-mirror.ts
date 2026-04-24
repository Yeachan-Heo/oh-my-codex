#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { getSetupInstallableSkillNames } from '../catalog/installable.js';
import { readCatalogManifest } from '../catalog/reader.js';
import { assertSkillMirror, compareSkillMirror } from '../catalog/skill-mirror.js';

export interface SyncPluginMirrorOptions {
  root?: string;
  check?: boolean;
  verbose?: boolean;
}

export interface SyncPluginMirrorResult {
  checked: boolean;
  mirroredSkillNames: string[];
  changed: boolean;
}

export async function syncPluginMirror(
  options: SyncPluginMirrorOptions = {},
): Promise<SyncPluginMirrorResult> {
  const root = options.root ?? process.cwd();
  const manifest = readCatalogManifest(root);
  const skillNames = [...getSetupInstallableSkillNames(manifest)].sort();
  const rootSkillsDir = join(root, 'skills');
  const pluginSkillsDir = join(root, 'plugins', 'oh-my-codex', 'skills');

  for (const skillName of skillNames) {
    const skillMd = join(rootSkillsDir, skillName, 'SKILL.md');
    if (!existsSync(skillMd)) {
      throw new Error(`canonical_skill_missing: skills/${skillName}/SKILL.md`);
    }
  }

  if (options.check) {
    await assertSkillMirror(rootSkillsDir, pluginSkillsDir, skillNames);
    return { checked: true, mirroredSkillNames: skillNames, changed: false };
  }

  const beforeMatches = (await compareSkillMirror(
    rootSkillsDir,
    pluginSkillsDir,
    skillNames,
  )) === null;

  await rm(pluginSkillsDir, { recursive: true, force: true });
  await mkdir(pluginSkillsDir, { recursive: true });

  for (const skillName of skillNames) {
    await cp(join(rootSkillsDir, skillName), join(pluginSkillsDir, skillName), {
      recursive: true,
    });
    if (options.verbose) {
      console.log(`mirrored skills/${skillName} -> plugins/oh-my-codex/skills/${skillName}`);
    }
  }

  await assertSkillMirror(rootSkillsDir, pluginSkillsDir, skillNames);
  return { checked: false, mirroredSkillNames: skillNames, changed: !beforeMatches };
}

function parseArgs(argv: string[]): SyncPluginMirrorOptions {
  return {
    check: argv.includes('--check'),
    verbose: argv.includes('--verbose'),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncPluginMirror(parseArgs(process.argv.slice(2))).then((result) => {
    const action = result.checked ? 'verified' : 'mirrored';
    console.log(
      `[sync-plugin-mirror] ${action} ${result.mirroredSkillNames.length} canonical skill director${result.mirroredSkillNames.length === 1 ? 'y' : 'ies'}`,
    );
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
