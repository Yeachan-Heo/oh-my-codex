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

  it('ultrawork guidance stays OMX-native and avoids upstream-only runtime taxonomy', () => {
    const content = loadSurface('skills/ultrawork/SKILL.md');
    assert.doesNotMatch(content, /@opencode-ai\/plugin|bun:sqlite|\.sisyphus/i);
    assert.doesNotMatch(content, /\boracle\b|\blibrarian\b|\bartistry\b|\bPrometheus\b/i);
    assert.match(content, /Ralph owns persistence, architect verification, deslop, and the full verified-completion promise/i);
  });
});
