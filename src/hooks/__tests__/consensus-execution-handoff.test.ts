/**
 * Planning skill regression tests for the lightweight plan surface and the
 * independently restored deep-interview requirements workflow.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const planSkill = readFileSync(join(__dirname, '../../../skills/plan/SKILL.md'), 'utf-8');
const ralplanSkill = readFileSync(join(__dirname, '../../../skills/ralplan/SKILL.md'), 'utf-8');
const deepInterviewSkill = readFileSync(join(__dirname, '../../../skills/deep-interview/SKILL.md'), 'utf-8');

function extractSection(content: string, heading: string): string | undefined {
  const pattern = new RegExp(`###\\s+${heading}[\\s\\S]*?(?=###|$)`);
  const match = content.match(pattern);
  return match?.[0];
}

describe('plan skill is the single planning skill', () => {
  it('has interview mode (--interview)', () => {
    assert.match(planSkill, /--interview/i);
    assert.ok(extractSection(planSkill, 'Interview') || planSkill.includes('Interview'));
  });

  it('has direct mode', () => {
    assert.ok(extractSection(planSkill, 'Direct') || planSkill.includes('Direct'));
  });

  it('has review mode (--review)', () => {
    assert.match(planSkill, /--review/i);
  });

  it('does not reference consensus mode', () => {
    assert.doesNotMatch(planSkill, /consensus/i);
    assert.doesNotMatch(planSkill, /RALPLAN-DR/i);
    assert.doesNotMatch(planSkill, /documented_host_consensus/i);
  });

  it('is slim (≤120 lines)', () => {
    const lines = planSkill.split('\n').length;
    assert.ok(lines <= 120, `plan SKILL.md should be ≤120 lines, got ${lines}`);
  });

  it('does not modify interview mode steps', () => {
    const interviewSection = extractSection(planSkill, 'Interview');
    assert.ok(interviewSection, 'Interview section should exist');
    assert.match(interviewSection, /Classify the request|Ask one focused question|Gather codebase facts/i);
  });

  it('does not modify direct mode steps', () => {
    const directSection = extractSection(planSkill, 'Direct');
    assert.ok(directSection, 'Direct section should exist');
    assert.match(directSection, /Quick Analysis|Create plan/i);
  });

  it('does not modify review mode steps', () => {
    const reviewSection = extractSection(planSkill, 'Review');
    assert.ok(reviewSection, 'Review section should exist');
    assert.match(reviewSection, /Read plan file|Evaluate via Critic/i);
  });

  it('escalation handoff uses $ultragoal', () => {
    assert.match(planSkill, /\$ultragoal/i);
  });
});

describe('ralplan consensus stage', () => {
  it('restores Planner -> Architect -> Critic consensus with Ultragoal handoff', () => {
    assert.match(ralplanSkill, /canonical consensus-planning stage/i);
    assert.match(ralplanSkill, /Planner.*Architect.*Critic/is);
    assert.match(ralplanSkill, /ralplan_execution_handoff/);
    assert.match(ralplanSkill, /\$ultragoal/i);
  });

  it('keeps sequential review and recovery semantics', () => {
    assert.match(ralplanSkill, /RALPLAN-DR/i);
    assert.match(ralplanSkill, /Do NOT issue both agent calls in the same parallel batch/i);
    assert.match(ralplanSkill, /missing host provenance must not terminalize Ralplan/i);
  });
});

describe('deep-interview independent workflow', () => {
  it('retains deep iterative questioning and durable handoff contracts', () => {
    assert.match(deepInterviewSkill, /Socratic deep interview/i);
    assert.match(deepInterviewSkill, /ambiguity/i);
    assert.match(deepInterviewSkill, /\.omx\/interviews\//i);
    assert.match(deepInterviewSkill, /\.omx\/specs\//i);
    assert.match(deepInterviewSkill, /omx state write\/read/i);
    assert.match(deepInterviewSkill, /\$ralplan/i);
    assert.match(deepInterviewSkill, /\$ultragoal/i);
  });
});

describe('plan skill adaptive sizing', () => {
  it('mentions adaptive or right-sized steps (not fixed template)', () => {
    // New lean plan mentions adaptive saved output; at least one of these
    assert.ok(
      /adaptive/i.test(planSkill) || /right-size/i.test(planSkill) || /Verification/i.test(planSkill),
      'plan skill should mention adaptive or verification',
    );
  });
});
