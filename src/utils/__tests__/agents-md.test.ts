import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addGeneratedAgentsMarker,
  hasOmxAgentsContract,
  hasOmxManagedAgentsSections,
  isOmxGeneratedAgentsMd,
  OMX_GENERATED_AGENTS_MARKER,
  OMX_MANAGED_AGENTS_END_MARKER,
  OMX_MANAGED_AGENTS_START_MARKER,
} from '../agents-md.js';

describe('agents-md helpers', () => {
  it('inserts the generated marker after the autonomy directive block', () => {
    const content = [
      '<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->',
      'YOU ARE AN AUTONOMOUS CODING AGENT. EXECUTE TASKS TO COMPLETION WITHOUT ASKING FOR PERMISSION.',
      'DO NOT STOP TO ASK "SHOULD I PROCEED?" — PROCEED. DO NOT WAIT FOR CONFIRMATION ON OBVIOUS NEXT STEPS.',
      'IF BLOCKED, TRY AN ALTERNATIVE APPROACH. ONLY ASK WHEN TRULY AMBIGUOUS OR DESTRUCTIVE.',
      '<!-- END AUTONOMY DIRECTIVE -->',
      '# oh-my-codex - Intelligent Multi-Agent Orchestration',
    ].join('\n');

    const result = addGeneratedAgentsMarker(content);

    assert.match(
      result,
      /<!-- END AUTONOMY DIRECTIVE -->\n<!-- omx:generated:agents-md -->\n# oh-my-codex - Intelligent Multi-Agent Orchestration/,
    );
  });

  it('does not duplicate an existing generated marker', () => {
    const content = `header\n${OMX_GENERATED_AGENTS_MARKER}\nbody\n`;
    assert.equal(addGeneratedAgentsMarker(content), content);
  });

  it('does not treat a standalone generated marker as the full OMX contract', () => {
    const content = `header\n${OMX_GENERATED_AGENTS_MARKER}\nbody\n`;

    assert.equal(isOmxGeneratedAgentsMd(content), true);
    assert.equal(hasOmxAgentsContract(content), false);
  });

  it('treats autonomy-directive generated files as OMX-managed once marked', () => {
    const content = [
      '<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->',
      'directive body',
      '<!-- END AUTONOMY DIRECTIVE -->',
      OMX_GENERATED_AGENTS_MARKER,
      '# oh-my-codex - Intelligent Multi-Agent Orchestration',
      'AGENTS.md is the top-level operating contract for the workspace.',
    ].join('\n');

    assert.equal(isOmxGeneratedAgentsMd(content), true);
    assert.equal(hasOmxAgentsContract(content), true);
  });

  it('does not treat title-only user AGENTS.md content as OMX-generated', () => {
    const content = [
      '# oh-my-codex - Intelligent Multi-Agent Orchestration',
      '',
      'User-authored guidance without any OMX ownership markers.',
    ].join('\n');

    assert.equal(isOmxGeneratedAgentsMd(content), false);
    assert.equal(hasOmxManagedAgentsSections(content), false);
    assert.equal(hasOmxAgentsContract(content), false);
  });

  it('recognizes explicit OMX-owned model table blocks as managed sections', () => {
    const content = [
      '# Shared ownership AGENTS',
      '',
      '<!-- OMX:MODELS:START -->',
      'managed table',
      '<!-- OMX:MODELS:END -->',
    ].join('\n');

    assert.equal(isOmxGeneratedAgentsMd(content), false);
    assert.equal(hasOmxManagedAgentsSections(content), true);
    assert.equal(hasOmxAgentsContract(content), false);
  });

  it('recognizes merged AGENTS blocks as carrying the OMX contract only when the generated marker is inside', () => {
    const content = [
      '# Shared ownership AGENTS',
      '',
      OMX_MANAGED_AGENTS_START_MARKER,
      '<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->',
      '<!-- END AUTONOMY DIRECTIVE -->',
      OMX_GENERATED_AGENTS_MARKER,
      '# oh-my-codex - Intelligent Multi-Agent Orchestration',
      'AGENTS.md is the top-level operating contract for the workspace.',
      OMX_MANAGED_AGENTS_END_MARKER,
    ].join('\n');

    assert.equal(isOmxGeneratedAgentsMd(content), true);
    assert.equal(hasOmxManagedAgentsSections(content), true);
    assert.equal(hasOmxAgentsContract(content), true);
  });

  it('does not accept a generated marker plus heading without the semantic contract text', () => {
    const content = [
      OMX_GENERATED_AGENTS_MARKER,
      '# oh-my-codex - Intelligent Multi-Agent Orchestration',
      'User-authored text that happens to reuse the title.',
    ].join('\n');

    assert.equal(hasOmxAgentsContract(content), false);
  });

  it('does not accept a managed AGENTS block that lacks the generated contract marker', () => {
    const content = [
      '# Shared ownership AGENTS',
      '',
      OMX_MANAGED_AGENTS_START_MARKER,
      '# oh-my-codex - Intelligent Multi-Agent Orchestration',
      'AGENTS.md is the top-level operating contract for the workspace.',
      OMX_MANAGED_AGENTS_END_MARKER,
    ].join('\n');

    assert.equal(hasOmxAgentsContract(content), false);
  });
});
