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

  it('plan uses the available host surface and preserves direct execution', () => {
    for (const path of ['skills/plan/SKILL.md', 'plugins/oh-my-codex/skills/plan/SKILL.md']) {
      const content = loadSurface(path);
      assert.match(content, /In attached OMX tmux, use `omx question` with `OMX_QUESTION_RETURN_PANE`/);
      assert.match(content, /Outside tmux, use native structured input when available; otherwise ask one concise plain-text question and wait/);
      assert.match(content, /Use only the host's exposed native subagent tools/);
      assert.doesNotMatch(content, /ask_codex/);
      assert.match(content, /"skip planning".*direct execution.*preserving any active workflow's gates/);
      assert.doesNotMatch(content, /"skip planning".*→ hand off to `\$ultragoal`/);
    }
  });

  it('doctor recovery preserves owned boundaries rather than deleting mixed roots', () => {
    for (const path of ['skills/doctor/SKILL.md', 'plugins/oh-my-codex/skills/doctor/SKILL.md']) {
      const content = loadSurface(path);
      const commands = [...content.matchAll(/```(?:bash|text)\n([\s\S]*?)```/g)]
        .map((match) => match[1]).join('\n');
      assert.doesNotMatch(commands, /\brm\s+-rf\b|\bfind\b[^\n]*-exec\s+rm|WebFetch\(/);
      assert.match(content, /exact target, ownership evidence, current content\/identity, active consumers, preserved dependencies/);
      assert.match(content, /Current setup-owned native TOMLs.*expected in both plugin and legacy setup modes/);
      assert.match(content, /omx setup --scope user --merge-agents --dry-run/);
      assert.match(content, /omx setup --scope project --merge-agents --dry-run/);
      assert.match(content, /Keep active or uncertain entries/);
    }
  });

  it('ralplan owns consensus without redirecting to a nonexistent lightweight Plan mode', () => {
    for (const path of ['skills/ralplan/SKILL.md', 'plugins/oh-my-codex/skills/ralplan/SKILL.md']) {
      const content = loadSurface(path);
      assert.match(content, /This skill owns the consensus sequence and handoff contract/);
      assert.match(content, /`\$plan` provides lightweight planning and plan review; it does not expose a consensus mode/);
      assert.doesNotMatch(content, /Follow the Plan skill's full documentation for consensus|also used by `\$plan` consensus mode/);
    }
  });

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

  it('ultrawork is a sunset stub pointing to team', () => {
    const rootSkill = loadSurface('skills/ultrawork/SKILL.md');

    assert.match(rootSkill, /was removed/i);
    assert.match(rootSkill, /\$team/i);
  });
});
