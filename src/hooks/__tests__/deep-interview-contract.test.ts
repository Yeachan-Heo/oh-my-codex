import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const deepInterviewSkill = readFileSync(
  join(__dirname, '../../../skills/deep-interview/SKILL.md'),
  'utf-8',
);
const autopilotSkill = readFileSync(
  join(__dirname, '../../../skills/autopilot/SKILL.md'),
  'utf-8',
);
const rootAgents = readFileSync(join(__dirname, '../../../AGENTS.md'), 'utf-8');
const templateAgents = readFileSync(join(__dirname, '../../../templates/AGENTS.md'), 'utf-8');

describe('deep-interview Ouroboros contract', () => {
  it('includes Ouroboros framing and ambiguity gate math', () => {
    assert.match(deepInterviewSkill, /Ouroboros/i);
    assert.match(deepInterviewSkill, /ambiguity/i);
    assert.match(deepInterviewSkill, /threshold/i);
    assert.match(deepInterviewSkill, /Greenfield: `ambiguity =/);
    assert.match(deepInterviewSkill, /Brownfield: `ambiguity =/);
  });

  it('includes challenge mode structure', () => {
    assert.match(deepInterviewSkill, /Contrarian/i);
    assert.match(deepInterviewSkill, /Simplifier/i);
    assert.match(deepInterviewSkill, /Ontologist/i);
  });

  it('includes execution bridge and no-direct-implementation guard', () => {
    assert.match(deepInterviewSkill, /Execution Bridge/i);
    assert.match(deepInterviewSkill, /\$ralplan/i);
    assert.match(deepInterviewSkill, /\$autopilot/i);
    assert.match(deepInterviewSkill, /\$ralph/i);
    assert.match(deepInterviewSkill, /\$team/i);
    assert.match(deepInterviewSkill, /Do NOT implement directly/i);
  });

  it('uses OMX-native output paths', () => {
    assert.match(deepInterviewSkill, /\.omx\/interviews\//);
    assert.match(deepInterviewSkill, /\.omx\/specs\//);
  });

  it('requires preflight context intake before interview rounds', () => {
    assert.match(deepInterviewSkill, /Phase 0: Preflight Context Intake/i);
    assert.match(deepInterviewSkill, /preflight context intake before the first interview question/i);
    assert.match(deepInterviewSkill, /\.omx\/context\/\{slug\}-\{timestamp\}\.md/);
    assert.match(deepInterviewSkill, /context_snapshot_path/i);
  });
});

describe('cross-skill and AGENTS coherence for deep-interview', () => {
  it('autopilot references deep-interview handoff', () => {
    assert.match(autopilotSkill, /deep-interview/i);
    assert.match(autopilotSkill, /Socratic/i);
  });

  it('root and template AGENTS include ouroboros keyword and updated description', () => {
    assert.match(rootAgents, /ouroboros/i);
    assert.match(templateAgents, /ouroboros/i);
    assert.match(rootAgents, /Socratic deep interview/i);
    assert.match(templateAgents, /Socratic deep interview/i);
  });
});
