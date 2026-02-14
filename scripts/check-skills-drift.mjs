#!/usr/bin/env node
/**
 * CI-friendly drift check:
 * Verifies docs/skills/README.md lists the same skill set as repo skill dirs.
 *
 * This is intentionally lightweight and does not require building TS output.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot() {
  // scripts/ is at repo root
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

function listRepoSkills(rootDir) {
  const skillsDir = join(rootDir, 'skills');
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir)
    .filter((name) => {
      try {
        return statSync(join(skillsDir, name)).isDirectory()
          && existsSync(join(skillsDir, name, 'SKILL.md'));
      } catch {
        return false;
      }
    })
    .sort();
}

function parseDocsSkills(rootDir) {
  const docsPath = join(rootDir, 'docs', 'skills', 'README.md');
  if (!existsSync(docsPath)) {
    return { path: docsPath, skills: null };
  }

  const content = readFileSync(docsPath, 'utf-8');
  const lines = content.split(/\r?\n/);
  const skills = new Set();

  for (const line of lines) {
    // Accept `$name` tokens anywhere in the line.
    for (const m of line.matchAll(/\$[a-z0-9][a-z0-9-]*/gi)) {
      skills.add(m[0].slice(1));
    }
  }

  return { path: docsPath, skills: Array.from(skills).sort() };
}

function diff(a, b) {
  const as = new Set(a);
  const bs = new Set(b);
  const onlyA = [...as].filter((x) => !bs.has(x)).sort();
  const onlyB = [...bs].filter((x) => !as.has(x)).sort();
  return { onlyA, onlyB };
}

function main() {
  const root = repoRoot();

  const repoSkills = listRepoSkills(root);
  const { path: docsPath, skills: docsSkills } = parseDocsSkills(root);

  if (!docsSkills) {
    console.error(`[skills-drift] Missing ${docsPath}`);
    process.exit(2);
  }

  const { onlyA: missingInDocs, onlyB: extraInDocs } = diff(repoSkills, docsSkills);
  if (missingInDocs.length === 0 && extraInDocs.length === 0) {
    console.log(`[skills-drift] OK (${repoSkills.length} skills)`);
    return;
  }

  console.error('[skills-drift] Drift detected between docs and repo skills.');
  if (missingInDocs.length > 0) {
    console.error(`- Missing in docs: ${missingInDocs.map(s => `$${s}`).join(' ')}`);
  }
  if (extraInDocs.length > 0) {
    console.error(`- Extra in docs:   ${extraInDocs.map(s => `$${s}`).join(' ')}`);
  }
  process.exit(1);
}

main();
