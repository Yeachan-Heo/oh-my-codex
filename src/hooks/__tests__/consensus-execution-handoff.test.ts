/**
 * Consensus mode execution handoff regression tests
 *
 * Verifies that the plan skill's consensus mode (ralplan) mandates:
 * 1. Structured AskUserQuestion for approval (not plain text)
 * 2. Explicit $ralph invocation on approval
 * 3. Prohibition of direct implementation from the planning agent
 * 4. User feedback step after Planner but before Architect/Critic
 * 5. RALPLAN-DR short mode and deliberate mode requirements
 *
 * Also verifies non-consensus modes (interview, direct, review) are unaffected,
 * and that architect/critic prompts contain required RALPLAN-DR sections.
 *
 * Note: This file loads SKILL.md and prompt content directly via fs.readFileSync()
 * instead of getBuiltinSkill() (which does not exist in OMX).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const planSkill = readFileSync(
  join(__dirname, '../../../skills/plan/SKILL.md'), 'utf-8'
);
const ralplanSkill = readFileSync(
  join(__dirname, '../../../skills/ralplan/SKILL.md'), 'utf-8'
);
const plannerPrompt = readFileSync(
  join(__dirname, '../../../prompts/planner.md'), 'utf-8'
);
const architectPrompt = readFileSync(
  join(__dirname, '../../../prompts/architect.md'), 'utf-8'
);
const criticPrompt = readFileSync(
  join(__dirname, '../../../prompts/critic.md'), 'utf-8'
);

/**
 * Extract a markdown section by heading using regex.
 */
function extractSection(content: string, heading: string): string | undefined {
  const pattern = new RegExp(`###\\s+${heading}[\\s\\S]*?(?=###|$)`);
  const match = content.match(pattern);
  return match?.[0];
}

describe('Consensus mode execution handoff (plan/SKILL.md)', () => {
  it('should mandate AskUserQuestion for the approval step', () => {
    const consensusSection = extractSection(planSkill, 'Consensus Mode');
    assert.ok(consensusSection, 'Consensus Mode section should exist');
    assert.ok(
      consensusSection.includes('AskUserQuestion'),
      'Consensus mode should mandate AskUserQuestion'
    );
  });

  it('should mandate $ralph invocation for execution on user approval', () => {
    const consensusSection = extractSection(planSkill, 'Consensus Mode');
    assert.ok(consensusSection, 'Consensus Mode section should exist');
    assert.ok(
      consensusSection.includes('$ralph'),
      'Consensus mode should reference $ralph invocation'
    );
  });

  it('should use MUST language for execution handoff', () => {
    const consensusSection = extractSection(planSkill, 'Consensus Mode');
    assert.ok(consensusSection, 'Consensus Mode section should exist');
    assert.ok(
      /MUST.*\$ralph/s.test(consensusSection) || /\$ralph.*MUST/s.test(consensusSection),
      'Consensus mode should use MUST language around $ralph invocation'
    );
  });

  it('should prohibit direct implementation from the planning agent', () => {
    const consensusSection = extractSection(planSkill, 'Consensus Mode');
    assert.ok(consensusSection, 'Consensus Mode section should exist');
    assert.ok(
      /Do NOT implement directly/i.test(consensusSection),
      'Consensus mode should prohibit direct implementation'
    );
  });

  it('should not modify Interview Mode steps', () => {
    const interviewSection = extractSection(planSkill, 'Interview Mode');
    assert.ok(interviewSection, 'Interview Mode section should exist');
    assert.ok(interviewSection.includes('Classify the request'));
    assert.ok(interviewSection.includes('Ask one focused question'));
    assert.ok(interviewSection.includes('Gather codebase facts first'));
  });

  it('should not modify Direct Mode steps', () => {
    const directSection = extractSection(planSkill, 'Direct Mode');
    assert.ok(directSection, 'Direct Mode section should exist');
    assert.ok(directSection.includes('Quick Analysis'));
    assert.ok(directSection.includes('Create plan'));
  });

  it('should not modify Review Mode steps', () => {
    const reviewSection = extractSection(planSkill, 'Review Mode');
    assert.ok(reviewSection, 'Review Mode section should exist');
    assert.ok(reviewSection.includes('Read plan file'));
    assert.ok(reviewSection.includes('Evaluate via Critic'));
  });

  it('should reference $ralph in Escalation section', () => {
    assert.ok(
      planSkill.includes('$ralph'),
      'plan/SKILL.md should reference $ralph for execution handoff'
    );
  });

  it('should require RALPLAN-DR structured deliberation in consensus mode', () => {
    const consensusSection = extractSection(planSkill, 'Consensus Mode');
    assert.ok(consensusSection, 'Consensus Mode section should exist');
    assert.ok(consensusSection.includes('RALPLAN-DR'), 'Should mention RALPLAN-DR');
    assert.ok(consensusSection.includes('**Principles** (3-5)'), 'Should require Principles');
    assert.ok(consensusSection.includes('**Decision Drivers** (top 3)'), 'Should require Decision Drivers');
    assert.ok(consensusSection.includes('**Viable Options** (>=2)'), 'Should require Viable Options');
    assert.ok(consensusSection.includes('**invalidation rationale**'), 'Should require invalidation rationale');
  });

  it('should require ADR fields in final consensus output', () => {
    const consensusSection = extractSection(planSkill, 'Consensus Mode');
    assert.ok(consensusSection, 'Consensus Mode section should exist');
    assert.ok(consensusSection.includes('ADR'), 'Should reference ADR');
    assert.ok(consensusSection.includes('**Decision**'), 'ADR should include Decision');
    assert.ok(consensusSection.includes('**Drivers**'), 'ADR should include Drivers');
    assert.ok(consensusSection.includes('**Alternatives considered**'), 'ADR should include Alternatives considered');
    assert.ok(consensusSection.includes('**Why chosen**'), 'ADR should include Why chosen');
    assert.ok(consensusSection.includes('**Consequences**'), 'ADR should include Consequences');
    assert.ok(consensusSection.includes('**Follow-ups**'), 'ADR should include Follow-ups');
  });

  it('should mention deliberate mode requirements in consensus mode', () => {
    const consensusSection = extractSection(planSkill, 'Consensus Mode');
    assert.ok(consensusSection, 'Consensus Mode section should exist');
    assert.ok(consensusSection.includes('**Deliberate**') || consensusSection.includes('deliberate mode'));
    assert.ok(consensusSection.includes('`--deliberate`') || consensusSection.includes('--deliberate'));
    assert.ok(consensusSection.includes('pre-mortem'));
    assert.ok(consensusSection.includes('expanded test plan'));
    assert.ok(consensusSection.includes('unit / integration / e2e / observability'));
  });
});

describe('User feedback step between Planner and Architect/Critic (plan/SKILL.md)', () => {
  it('should have a user feedback step after Planner and before Architect', () => {
    const consensusSection = extractSection(planSkill, 'Consensus Mode');
    assert.ok(consensusSection, 'Consensus Mode section should exist');

    const plannerIdx = consensusSection.indexOf('**Planner**');
    const feedbackIdx = consensusSection.indexOf('**User feedback**');
    const architectIdx = consensusSection.indexOf('**Architect**');

    assert.ok(plannerIdx > -1, 'Should have Planner step');
    assert.ok(feedbackIdx > -1, 'Should have User feedback step');
    assert.ok(architectIdx > -1, 'Should have Architect step');

    assert.ok(feedbackIdx > plannerIdx, 'User feedback should come after Planner');
    assert.ok(architectIdx > feedbackIdx, 'Architect should come after User feedback');
  });

  it('should mandate AskUserQuestion for the user feedback step', () => {
    const consensusSection = extractSection(planSkill, 'Consensus Mode');
    assert.ok(consensusSection, 'Consensus Mode section should exist');
    assert.ok(
      /User feedback.*MUST.*AskUserQuestion/s.test(consensusSection),
      'User feedback step should mandate AskUserQuestion'
    );
  });

  it('should offer Proceed/Request changes/Skip review options in user feedback step', () => {
    const consensusSection = extractSection(planSkill, 'Consensus Mode');
    assert.ok(consensusSection, 'Consensus Mode section should exist');
    assert.ok(consensusSection.includes('Proceed to review'));
    assert.ok(consensusSection.includes('Request changes'));
    assert.ok(consensusSection.includes('Skip review'));
  });

  it('should place Critic after Architect in the consensus flow', () => {
    const consensusSection = extractSection(planSkill, 'Consensus Mode');
    assert.ok(consensusSection, 'Consensus Mode section should exist');

    const architectIdx = consensusSection.indexOf('**Architect**');
    const criticIdx = consensusSection.indexOf('**Critic**');

    assert.ok(architectIdx > -1, 'Should have Architect step');
    assert.ok(criticIdx > -1, 'Should have Critic step');
    assert.ok(criticIdx > architectIdx, 'Critic should come after Architect');
  });

  it('should require architect antithesis and critic rejection gates in consensus flow', () => {
    const consensusSection = extractSection(planSkill, 'Consensus Mode');
    assert.ok(consensusSection, 'Consensus Mode section should exist');
    assert.ok(
      consensusSection.includes('steelman counterargument (antithesis)') ||
      consensusSection.includes('steelman counterargument'),
      'Architect step should require steelman counterargument'
    );
    assert.ok(consensusSection.includes('tradeoff tension'), 'Should require tradeoff tension');
    assert.ok(
      /Critic.*MUST.*explicitly reject shallow alternatives/s.test(consensusSection) ||
      consensusSection.includes('Critic **MUST** explicitly reject shallow alternatives'),
      'Critic should explicitly reject shallow alternatives'
    );
    assert.ok(
      consensusSection.includes('driver contradictions') ||
      consensusSection.includes('driver contradiction'),
      'Should mention driver contradictions'
    );
    assert.ok(
      consensusSection.includes('weak verification'),
      'Should mention weak verification'
    );
  });
});

describe('RALPLAN-DR in ralplan/SKILL.md', () => {
  it('should contain RALPLAN-DR structured deliberation description', () => {
    assert.ok(
      ralplanSkill.includes('RALPLAN-DR'),
      'ralplan/SKILL.md should mention RALPLAN-DR'
    );
  });

  it('should document the --deliberate flag', () => {
    assert.ok(
      ralplanSkill.includes('--deliberate'),
      'ralplan/SKILL.md should document --deliberate flag'
    );
  });

  it('should contain Pre-Execution Gate section', () => {
    assert.ok(
      ralplanSkill.includes('Pre-Execution Gate'),
      'ralplan/SKILL.md should contain Pre-Execution Gate section'
    );
  });

  it('should document gate bypass prefixes force: and !', () => {
    assert.ok(
      ralplanSkill.includes('force:') && ralplanSkill.includes('! '),
      'ralplan/SKILL.md should document force: and ! bypass prefixes'
    );
  });

  it('should document sequential Architect then Critic execution', () => {
    assert.ok(
      /step[s]? 3 and 4 MUST run sequentially|Do NOT.*parallel/i.test(ralplanSkill) ||
      ralplanSkill.includes('await completion before step 4'),
      'ralplan/SKILL.md should require sequential Architect/Critic execution'
    );
  });

  it('should document ADR requirement', () => {
    assert.ok(
      ralplanSkill.includes('ADR'),
      'ralplan/SKILL.md should reference ADR requirement'
    );
  });
});

describe('Architect prompt RALPLAN-DR sections', () => {
  it('should have steelman antithesis requirement', () => {
    assert.ok(
      architectPrompt.includes('antithesis') || architectPrompt.includes('steelman'),
      'architect.md should require steelman antithesis'
    );
  });

  it('should have tradeoff tension requirement', () => {
    assert.ok(
      architectPrompt.includes('tradeoff tension'),
      'architect.md should require tradeoff tension'
    );
  });

  it('should have synthesis requirement', () => {
    assert.ok(
      architectPrompt.includes('synthesis'),
      'architect.md should mention synthesis'
    );
  });

  it('should reference ralplan consensus reviews', () => {
    assert.ok(
      architectPrompt.includes('ralplan'),
      'architect.md should reference ralplan consensus reviews'
    );
  });
});

describe('Critic prompt RALPLAN-DR sections', () => {
  it('should have gate checks for ralplan reviews', () => {
    assert.ok(
      criticPrompt.includes('ralplan') && criticPrompt.includes('gate'),
      'critic.md should mention ralplan gate checks'
    );
  });

  it('should explicitly REJECT shallow alternatives', () => {
    assert.ok(
      /REJECT.*shallow alternatives/i.test(criticPrompt) ||
      criticPrompt.includes('REJECT shallow alternatives'),
      'critic.md should explicitly REJECT shallow alternatives'
    );
  });

  it('should enforce deliberate mode requirements', () => {
    assert.ok(
      criticPrompt.includes('deliberate') &&
      (criticPrompt.includes('pre-mortem') || criticPrompt.includes('expanded test plan')),
      'critic.md should enforce deliberate mode requirements'
    );
  });
});
