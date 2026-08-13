import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../../..');
const autopilotSkill = readFileSync(join(root, 'skills/autopilot/SKILL.md'), 'utf-8');
const pluginAutopilotSkill = readFileSync(join(root, 'plugins/oh-my-codex/skills/autopilot/SKILL.md'), 'utf-8');
const skillsDocs = readFileSync(join(root, 'docs/skills.html'), 'utf-8');
const gettingStartedDocs = readFileSync(join(root, 'docs/getting-started.html'), 'utf-8');
const stateModel = readFileSync(join(root, 'docs/STATE_MODEL.md'), 'utf-8');

const canonicalChain = /\$deep-interview\s*(?:->|-&gt;)\s*\$ralplan\s*(?:->|-&gt;)\s*\$ultragoal/;

describe('autopilot canonical orchestrator contract', () => {
  it('makes deep-interview -> ralplan -> ultragoal the defining default chain', () => {
    assert.match(autopilotSkill, /first-class canonical orchestrator/i);
    assert.match(autopilotSkill, canonicalChain);
    assert.match(autopilotSkill, /not a list of optional hints/i);
    assert.match(autopilotSkill, /MUST preserve the phase order `deep-interview -> ralplan -> ultragoal`/i);
    assert.doesNotMatch(autopilotSkill, /was removed in OMX 0\.21/i);
    assert.doesNotMatch(autopilotSkill, /understand -> execute -> verify -> report/i);
  });

  it('keeps Autopilot as the supervisor over child phases', () => {
    assert.match(autopilotSkill, /Child stages are supervised phases, not peer workflow activations/i);
    assert.match(autopilotSkill, /keep `mode:"autopilot"` active/i);
    assert.match(autopilotSkill, /current_phase/);
    assert.match(autopilotSkill, /phase_cycle/);
    assert.match(autopilotSkill, /handoff_artifacts/);
    assert.match(autopilotSkill, /return_to_ralplan_reason/);
  });

  it('reconciles progression with current state SSOT without restoring the host-receipt lock', () => {
    assert.match(autopilotSkill, /current CLI state SSOT/i);
    assert.match(autopilotSkill, /Do not create a second writer/i);
    assert.match(autopilotSkill, /missing host provenance is not a blocker/i);
    assert.match(autopilotSkill, /Do not reintroduce the retired unrecoverable host-receipt lock/i);
    assert.match(stateModel, /Autopilot is a supervisor over child stages/i);
    assert.match(stateModel, /missing host provenance\s+must not terminalize Autopilot/i);
  });

  it('preserves recoverable cancel, clear, and hook recovery paths', () => {
    assert.match(autopilotSkill, /Authority-decreasing operations are always recoverable/i);
    assert.match(autopilotSkill, /\$cancel/);
    assert.match(autopilotSkill, /exact-session state clear/i);
    assert.match(autopilotSkill, /hook disable\/uninstall recovery/i);
    assert.match(autopilotSkill, /must not keep Stop blocked/i);
    assert.match(autopilotSkill, /never recreate an unconditional hook lock/i);
  });

  it('keeps the plugin mirror byte-identical to the canonical skill', () => {
    assert.equal(pluginAutopilotSkill, autopilotSkill);
  });

  it('advertises the canonical chain in public workflow docs', () => {
    assert.match(skillsDocs, canonicalChain);
    assert.match(gettingStartedDocs, canonicalChain);
    assert.doesNotMatch(skillsDocs, /Removed in OMX 0\.21:<\/em> <code>\$autopilot<\/code>/i);
  });
});
