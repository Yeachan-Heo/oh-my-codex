import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skill = readFileSync(join(process.cwd(), 'skills/minimax/SKILL.md'), 'utf-8');
const pluginSkill = readFileSync(join(process.cwd(), 'plugins/oh-my-codex/skills/minimax/SKILL.md'), 'utf-8');

describe('minimax skill contract', () => {
  it('defines the core role loop and decisions', () => {
    assert.match(skill, /MAX/);
    assert.match(skill, /LOOKAHEAD/);
    assert.match(skill, /MIN/);
    assert.match(skill, /ARBITER/);
    assert.match(skill, /continue.*revise.*block.*escalate.*complete/s);
  });

  it('keeps council escalation optional, evidence-based, and tool-neutral', () => {
    assert.match(skill, /independent review/);
    assert.match(skill, /durable, scoped artifact/);
    assert.match(skill, /Treat review findings as claims to verify/);
    const bannedSpecificCouncil = new RegExp(['file', 'council'].join('[- ]'));
    const bannedSpecificReviewer = new RegExp(['code', 'review'].join('-'));
    assert.doesNotMatch(skill, bannedSpecificCouncil);
    assert.doesNotMatch(skill, bannedSpecificReviewer);
    assert.doesNotMatch(skill, /--feel-the-agi/);
  });

  it('requires bounded state packets and fresh verification evidence', () => {
    assert.match(skill, /.omx\/state\/\.\.\.\/minimax-state\.json/);
    assert.match(skill, /.omx\/minimax\/step-<n>\.md/);
    assert.match(skill, /expected_evidence/);
    assert.match(skill, /arbiter_decision/);
    assert.match(skill, /verification_evidence/);
    assert.match(skill, /verification_evidence_step/);
    assert.match(skill, /fresh verification evidence/);
    assert.match(skill, /update the same packet with MIN and ARBITER decisions/);
  });

  it('documents continuation and completion gates', () => {
    assert.match(skill, /bare `continue`, `resume`, or `keep going` resumes/);
    assert.match(skill, /Completion is gated/);
    assert.match(skill, /state\.council\.artifact_path/);
  });

  it('keeps branched lookahead bounded and scored', () => {
    assert.match(skill, /Bounded branched lookahead/);
    assert.match(skill, /low risk: 1 branch/);
    assert.match(skill, /medium risk: 2 branches/);
    assert.match(skill, /high risk.*3 branches/);
    assert.match(skill, /depth 2 and max 3 branches/);
    assert.match(skill, /progressive widening/);
    assert.match(skill, /Score branches/);
    assert.match(skill, /"scoring"/);
    assert.match(skill, /"progressive_widening"/);
    assert.match(skill, /0-10 range/);
    assert.match(skill, /fixed workflow defaults/);
    assert.match(skill, /Do not grow a tree, spawn a team, or convert Minimax into `\$ralplan`/);
  });

  it('keeps the plugin mirror in sync with the canonical skill', () => {
    assert.equal(pluginSkill, skill);
  });
});
