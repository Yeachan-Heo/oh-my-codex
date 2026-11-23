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

  it('ralplan owns consensus without redirecting to a nonexistent lightweight Plan mode', () => {
    for (const path of ['skills/ralplan/SKILL.md', 'plugins/oh-my-codex/skills/ralplan/SKILL.md']) {
      const content = loadSurface(path);
      assert.match(content, /This skill owns the consensus sequence and handoff contract/);
      assert.match(content, /`\$plan` provides lightweight planning and plan review; it does not expose a consensus mode/);
      assert.doesNotMatch(content, /Follow the Plan skill's full documentation for consensus|also used by `\$plan` consensus mode/);
    }
  });

  it('ralplan re-review loop requires Architect/Critic lane reuse with a new_lane_reason fallback (#4129)', () => {
    for (const path of ['skills/ralplan/SKILL.md', 'plugins/oh-my-codex/skills/ralplan/SKILL.md']) {
      const content = loadSurface(path);
      const loop = content.slice(content.indexOf('**Re-review loop**'));
      assert.match(loop, /continue the prior same-session Architect lane when the host exposes a continuation tool \(`followup_task` \(`collaboration.followup_task`\), `send_input`, or `resume_agent`, whichever the host exposes/);
      assert.match(loop, /apply the same rule to Critic: continue the prior same-session Critic lane/);
      const ops = /`followup_task` \(`collaboration\.followup_task`\), `send_input`, or `resume_agent`, whichever the host exposes/;
      const architectStep = loop.slice(loop.indexOf('c. Return to Architect review'), loop.indexOf('d. Return to Critic evaluation'));
      const criticStep = loop.slice(loop.indexOf('d. Return to Critic evaluation'), loop.indexOf('e. Re-run the configured quality gates'));
      const gateStep = loop.slice(loop.indexOf('e. Re-run the configured quality gates'), loop.indexOf('f. If 5 iterations'));
      assert.match(architectStep, ops);
      assert.match(criticStep, ops);
      assert.match(gateStep, ops);
      assert.match(loop, /never require `resume_agent` \(or any specific one\) where the host does not expose it/);
      assert.match(loop, /spawn a replacement Architect and record `new_lane_reason` in the planning receipt/);
      assert.match(loop, /spawn a replacement Critic and record `new_lane_reason` in the planning receipt/);
      assert.match(loop, /`assertRoleLaneReuse` in `src\/ralplan\/runtime\.ts`/);
      assert.match(loop, /Planner is not a reuse invariant: step 5b may use a fresh Planner/);
      assert.match(loop, /apply the same rule per gate: continue the prior same-session lane for the same gate skill \(keyed by gate skill name; a gate whose configured `model` changed may be replaced\)/);
      assert.match(loop, /spawn a replacement gate subagent and record `new_lane_reason` for that gate in the planning receipt alongside its `qualityGateResults` entry/);
      const gates = content.slice(content.indexOf('**Plan quality gates (after step 4):**'));
      assert.match(gates, /the first iteration spawns each gate fresh/);
      assert.match(gates, ops);
      assert.match(gates, /continue the prior same-session lane for the same gate skill \(keyed by gate skill name/);
      assert.match(gates, /never require `resume_agent` \(or any specific one\) where the host does not expose it/);
      assert.match(gates, /spawn a replacement gate subagent and record `new_lane_reason` for that gate/);
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
      assert.match(content, /omx setup --scope user --plugin --mcp compat --enable-team --merge-agents --dry-run/);
      assert.match(content, /omx setup --scope project --plugin --mcp compat --enable-team --merge-agents --dry-run/);
      assert.match(content, /user scope uses `\$CODEX_DIR\/agents\/`, while project scope uses `<project>\/.codex\/agents\/`/);
      assert.match(content, /a missing persistent AGENTS.md in plugin mode.*`--merge-agents` cannot create it/);
      assert.match(content, /omx setup --scope user --plugin --mcp compat --enable-team --no-merge-agents --dry-run/);
      assert.match(content, /omx setup --scope project --plugin --mcp compat --enable-team --no-merge-agents --dry-run/);
      assert.match(content, /Record Doctor's resolved setup scope, install mode, and MCP mode/);
      assert.match(content, /replace `--plugin` with `--legacy`.*replace `--mcp compat` with `--mcp none`/);
      assert.match(content, /Carry the same explicit install-mode, MCP-mode, and Team-mode selectors through merge, creation, policy restoration, and hook restoration/);
      assert.match(content, /record the prior matching-scope `mergeAgents` policy/);
      assert.match(content, /After successful AGENTS repair, restore the recorded policy/);
      assert.match(content, /`--merge-agents` for `true`, `--no-merge-agents` for `false`, or `--clear-merge-agents-policy` if it was absent/);
      assert.match(content, /Record the prior Team mode/);
      assert.match(content, /replace `--enable-team` with `--disable-team`/);
      assert.match(content, /For a symlink.*setup skips both merge and defaults/);
      assert.match(content, /Update the authorized target through its owning source/);
      assert.match(content, /restore intentionally disabled hooks after the AGENTS write and policy restoration/);
      assert.match(content, /--disable-hooks`.*returns before the AGENTS phase/);
      assert.match(content, /temporary re-enablement/);
      assert.match(content, /omx setup --scope user --plugin --mcp compat --enable-team --disable-hooks --dry-run/);
      assert.match(content, /omx setup --scope project --plugin --mcp compat --enable-team --disable-hooks --dry-run/);
      assert.match(content, /Keep active or uncertain entries/);
      assert.match(content, /`omx doctor --dry-run --force` is an ownership-check preview, not a repair-eligibility preview/);
      assert.match(content, /Doctor may recover a native-hook claim journal before that check, even with `--dry-run`/);
      assert.match(content, /Recovery can restore a canonical file, remove a claim file, and clear the journal/);
      assert.doesNotMatch(content, /--dry-run --force` previews those repairs/);
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

  for (const path of ['docs/reference/omx-config-quality-gates.md', 'src/config/quality-gates.ts']) {
    it(`${path} keeps Ralplan consensus separate from lightweight Plan`, () => {
      const content = loadSurface(path).replace(/`/g, '');
      assert.match(content, /Lightweight \$plan modes do not run this stage|not lightweight \$plan/i);
      assert.doesNotMatch(content, /also (?:used by )?\$plan/i);
    });
  }

  it('ultrawork is a sunset stub pointing to team', () => {
    const rootSkill = loadSurface('skills/ultrawork/SKILL.md');

    assert.match(rootSkill, /was removed/i);
    assert.match(rootSkill, /\$team/i);
  });
});
