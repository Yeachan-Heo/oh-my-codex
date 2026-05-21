import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { AGENT_DEFINITIONS } from '../../agents/definitions.js';
import { readCatalogManifest, toPublicCatalogContract } from '../../catalog/reader.js';
import { KEYWORD_TRIGGER_DEFINITIONS } from '../keyword-registry.js';

const repoRoot = process.cwd();
const activeSkillDir = join(repoRoot, 'skills', 'prometheus-strict');
const pluginSkillDir = join(repoRoot, 'plugins', 'oh-my-codex', 'skills', 'prometheus-strict');
const recipePath = join(repoRoot, 'docs', 'recipes', 'prometheus-inspired-deliberation.md');
const promptNames = [
  'prometheus-strict-metis',
  'prometheus-strict-momus',
  'prometheus-strict-oracle',
];

function readRepoFile(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('prometheus-strict recipe-only contract', () => {
  it('does not add an active prometheus-strict hook runtime or Sisyphus/start-work port', () => {
    for (const forbidden of [
      activeSkillDir,
      pluginSkillDir,
      join(repoRoot, 'src', 'hooks', 'prometheus-strict.ts'),
      join(repoRoot, 'src', 'scripts', 'prometheus-strict-hook.ts'),
    ]) {
      assert.equal(existsSync(forbidden), false, `${forbidden} must not exist`);
    }

    const hookFiles = readRepoFile(join(repoRoot, 'src', 'hooks', 'keyword-registry.ts'));
    assert.doesNotMatch(hookFiles, /Sisyphus|start-work|prometheus-strict/i);
  });

  it('keeps Prometheus material as a non-canonical recipe with clean-room credit', () => {
    assert.ok(existsSync(recipePath), 'experimental recipe should remain available as documentation');
    const recipe = readRepoFile(recipePath);

    assert.match(recipe, /non-canonical recipe, not an active OMX skill, keyword, hook, or native-agent surface/i);
    assert.match(recipe, /\$deep-interview -> \$ralplan -> \$ultragoal/);
    assert.match(
      recipe,
      /Inspired by the high-level OMO Prometheus concept \(`code-yeongyu\/oh-my-openagent`\), reimplemented as concept-only guidance under MIT/i,
    );
    assert.match(recipe, /Do not invoke `\$prometheus-strict`; no such canonical active skill is shipped/i);
    assert.doesNotMatch(recipe, /\.omx\/plans\/prometheus-strict\//i);
  });

  it('does not ship Metis, Momus, or Oracle prompt-backed native agents', () => {
    for (const promptName of promptNames) {
      assert.equal(existsSync(join(repoRoot, 'prompts', `${promptName}.md`)), false);
      assert.equal(AGENT_DEFINITIONS[promptName], undefined);
    }
  });

  it('does not expose prometheus-strict through keyword or catalog surfaces', () => {
    assert.equal(
      KEYWORD_TRIGGER_DEFINITIONS.some((entry) => entry.skill === 'prometheus-strict' || entry.keyword.toLowerCase() === '$prometheus-strict'),
      false,
    );

    const manifest = readCatalogManifest();
    const contract = toPublicCatalogContract(manifest);

    assert.equal(contract.skills.some((skill) => skill.name === 'prometheus-strict'), false);
    assert.equal(contract.agents.some((agent) => promptNames.includes(agent.name)), false);
  });

  it('keeps canonical docs focused on deep-interview to ralplan to ultragoal', () => {
    const readme = readRepoFile(join(repoRoot, 'README.md'));
    const docs = readRepoFile(join(repoRoot, 'docs', 'skills.html'));

    assert.match(readme, /\$deep-interview[\s\S]*\$ralplan[\s\S]*\$ultragoal/);
    assert.doesNotMatch(readme, /\$prometheus-strict|\.omx\/plans\/prometheus-strict\//i);
    assert.doesNotMatch(docs, /\$prometheus-strict|\.omx\/plans\/prometheus-strict\/|Metis clarification|Momus critique|Oracle synthesis/i);
  });
});
