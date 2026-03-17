import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadAutoresearchMissionContract,
  parseEvaluatorResult,
  parseSandboxContract,
  slugifyMissionName,
} from '../contracts.js';

async function initRepo(): Promise<string> {
  const raw = await mkdtemp(join(tmpdir(), 'omx-autoresearch-contracts-'));
  const cwd = realpathSync(raw);
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

describe('autoresearch contracts', () => {
  it('slugifies mission names deterministically', () => {
    assert.equal(slugifyMissionName('Missions/My Demo Mission'), 'missions-my-demo-mission');
  });

  it('parses sandbox contract with evaluator command and json format', () => {
    const parsed = parseSandboxContract(`---\nevaluator:\n  command: node scripts/eval.js\n  format: json\n---\nStay in bounds.\n`);
    assert.equal(parsed.evaluator.command, 'node scripts/eval.js');
    assert.equal(parsed.evaluator.format, 'json');
    assert.equal(parsed.body, 'Stay in bounds.');
  });

  it('rejects sandbox contract without frontmatter', () => {
    assert.throws(
      () => parseSandboxContract('No frontmatter here'),
      /sandbox\.md must start with YAML frontmatter/i,
    );
  });

  it('rejects sandbox contract without evaluator command', () => {
    assert.throws(
      () => parseSandboxContract(`---\nevaluator:\n  format: json\n---\nPolicy\n`),
      /evaluator\.command is required/i,
    );
  });

  it('rejects sandbox contract without evaluator format', () => {
    assert.throws(
      () => parseSandboxContract(`---\nevaluator:\n  command: node eval.js\n---\nPolicy\n`),
      /evaluator\.format is required/i,
    );
  });

  it('rejects sandbox contract with non-json evaluator format', () => {
    assert.throws(
      () => parseSandboxContract(`---\nevaluator:\n  command: node eval.js\n  format: text\n---\nPolicy\n`),
      /evaluator\.format must be json/i,
    );
  });

  it('parses optional evaluator keep_policy', () => {
    const parsed = parseSandboxContract(`---
evaluator:
  command: node scripts/eval.js
  format: json
  keep_policy: pass_only
---
Stay in bounds.
`);
    assert.equal(parsed.evaluator.keep_policy, 'pass_only');
  });

  it('rejects unsupported evaluator keep_policy', () => {
    assert.throws(
      () => parseSandboxContract(`---
evaluator:
  command: node scripts/eval.js
  format: json
  keep_policy: maybe
---
Stay in bounds.
`),
      /keep_policy must be one of/i,
    );
  });

  it('accepts evaluator result with pass only', () => {
    assert.deepEqual(parseEvaluatorResult('{"pass":true}'), { pass: true });
  });

  it('accepts evaluator result with pass and score', () => {
    assert.deepEqual(parseEvaluatorResult('{"pass":false,"score":61}'), { pass: false, score: 61 });
  });

  it('rejects evaluator result without pass', () => {
    assert.throws(
      () => parseEvaluatorResult('{"score":61}'),
      /must include boolean pass/i,
    );
  });

  it('rejects evaluator result with non-numeric score', () => {
    assert.throws(
      () => parseEvaluatorResult('{"pass":true,"score":"high"}'),
      /score must be numeric/i,
    );
  });

  it('loads mission contract from in-repo mission directory', async () => {
    const repo = await initRepo();
    try {
      const missionDir = join(repo, 'missions', 'demo');
      await mkdir(missionDir, { recursive: true });
      await writeFile(join(missionDir, 'mission.md'), '# Mission\nShip it\n', 'utf-8');
      await writeFile(
        join(missionDir, 'sandbox.md'),
        `---\nevaluator:\n  command: node scripts/eval.js\n  format: json\n---\nStay in bounds.\n`,
        'utf-8',
      );

      const contract = await loadAutoresearchMissionContract(missionDir);
      assert.equal(contract.repoRoot, repo);
      assert.equal(contract.missionRelativeDir.replace(/\\/g, '/'), 'missions/demo');
      assert.equal(contract.missionSlug, 'missions-demo');
      assert.equal(contract.sandbox.evaluator.command, 'node scripts/eval.js');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
