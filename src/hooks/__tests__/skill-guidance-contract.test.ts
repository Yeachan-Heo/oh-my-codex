import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SKILL_CONTRACTS } from '../prompt-guidance-contract.js';
import { assertContractSurface, loadSurface } from './prompt-guidance-test-helpers.js';

describe('execution-heavy skill guidance contract', () => {
  for (const contract of SKILL_CONTRACTS) {
    it(`${contract.id} satisfies the execution-heavy skill guidance contract`, () => {
      assertContractSurface(contract);
    });
  }

  it('ultraqa requires adversarial dynamic e2e coverage and structured reporting', () => {
    const rootSkill = loadSurface('skills/ultraqa/SKILL.md');
    const pluginSkill = loadSurface('plugins/oh-my-codex/skills/ultraqa/SKILL.md');

    for (const [label, content] of [
      ['root', rootSkill],
      ['plugin', pluginSkill],
    ] as const) {
      assert.match(content, /adversarial dynamic e2e/i, `${label} skill must require dynamic e2e QA`);
      assert.match(content, /not satisfied by a shallow build\/lint\/typecheck\/test checklist/i, `${label} skill must reject shallow static QA`);
      assert.match(content, /malicious\/hostile user behavior|User\/attacker model/i, `${label} skill must model hostile users`);
      assert.match(content, /temporary tests, scripts, fixtures, or harnesses/i, `${label} skill must allow generated harnesses`);

      for (const requiredEdgeCase of [
        /malformed input/i,
        /repeated interruptions/i,
        /prompt injection/i,
        /cancel\/resume/i,
        /stale state/i,
        /dirty worktree/i,
        /hung or long-running commands|hung-command/i,
        /flaky tests/i,
        /misleading success output/i,
      ]) {
        assert.match(content, requiredEdgeCase, `${label} skill is missing edge case ${requiredEdgeCase}`);
      }

      for (const requiredReportField of [
        /Scenario matrix/i,
        /Commands run/i,
        /Failures found/i,
        /Fixes applied/i,
        /Cleanup and rollback/i,
        /Residual risks/i,
        /Evidence/i,
      ]) {
        assert.match(content, requiredReportField, `${label} skill is missing report field ${requiredReportField}`);
      }

      assert.match(content, /No destructive commands/i, `${label} skill must prohibit destructive commands`);
      assert.match(content, /secret exfiltration/i, `${label} skill must prohibit secret exfiltration`);
      assert.match(content, /bounded runtimes|No unbounded waits/i, `${label} skill must bound runtime`);
      assert.match(content, /clean.*temporary e2e harnesses|cleanup status/i, `${label} skill must require cleanup evidence`);
    }
  });

  it('ultraqa harness guardrail patterns require intended semantics and reject inverted phrasing', () => {
    const ultraqa = SKILL_CONTRACTS.find((contract) => contract.id === 'ultraqa');
    assert.ok(ultraqa, 'ultraqa contract must exist');

    const findPattern = (needle: string): RegExp => {
      const pattern = ultraqa.requiredPatterns.find((candidate) => candidate.source.includes(needle));
      assert.ok(pattern, `missing ultraqa guardrail pattern containing: ${needle}`);
      return pattern;
    };

    const absoluteImports = findPattern('Use absolute repo imports');
    assert.match(
      'Use absolute repo imports and pathToFileURL(join(repoRoot, "dist", ...)).href. Never rely on ./dist from /tmp.',
      absoluteImports,
    );
    assert.doesNotMatch(
      'Absolute repo imports are forbidden. Rely on ./dist paths from /tmp harnesses.',
      absoluteImports,
    );

    const safeWriter = findPattern('Use a safe file writer');
    assert.match(
      'Use a safe file writer with a non-interpolating file-write mechanism and do not use interpolating heredocs.',
      safeWriter,
    );
    assert.doesNotMatch(
      'Use interpolating heredocs for JavaScript assertions instead of a safe writer.',
      safeWriter,
    );

    const sanitizedEnv = findPattern('Sanitize OMX runtime env for isolated probes');
    assert.match(
      'Sanitize OMX runtime env for isolated probes: keep OMX_ROOT and OMX_STATE_ROOT unset and run env -u OMX_ROOT -u OMX_STATE_ROOT.',
      sanitizedEnv,
    );
    assert.doesNotMatch(
      'Keep OMX_ROOT and OMX_STATE_ROOT set for isolated probes; avoid env -u OMX_ROOT -u OMX_STATE_ROOT.',
      sanitizedEnv,
    );

    const harnessDebris = findPattern('Classify harness setup failures separately');
    assert.match(
      'Classify harness setup failures separately: record it as harness debris, fix the harness, and rerun the scenario before declaring a product defect.',
      harnessDebris,
    );
    assert.doesNotMatch('Harness debris noted.', harnessDebris);
  });

  it('ultrawork guidance stays OMX-native and routes durability outside ultrawork', () => {
    const rootSkill = loadSurface('skills/ultrawork/SKILL.md');
    const pluginSkill = loadSurface('plugins/oh-my-codex/skills/ultrawork/SKILL.md');

    for (const [label, content] of [
      ['root', rootSkill],
      ['plugin', pluginSkill],
    ] as const) {
      assert.doesNotMatch(content, /@opencode-ai\/plugin|bun:sqlite|\.sisyphus/i);
      assert.doesNotMatch(content, /\boracle\b|\blibrarian\b|\bartistry\b|\bPrometheus\b/i);
      assert.match(
        content,
        /Ultrawork does not own persistence, durable ledgers, architect verification, deslop, full QA, or the full verified-completion promise/i,
        `${label} skill must keep ultrawork inside lightweight-verification boundaries`,
      );
      assert.match(content, /Escalate to `ultragoal` when the work needs durable goal state/i, `${label} skill must route durable goal state to ultragoal`);
      assert.match(content, /Escalate to `team` when the work needs coordinated tmux workers/i, `${label} skill must route coordinated worker lifecycle to team`);
      assert.match(
        content,
        /Escalate to explicitly requested `ralph` only for the supported legacy single-owner persistence\/verification fallback/i,
        `${label} skill must keep ralph as explicit legacy fallback`,
      );
    }
  });
});
